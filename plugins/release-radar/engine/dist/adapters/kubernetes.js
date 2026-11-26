/**
 * `kubernetes` adapter (spec requirement 26; research §5 — shapes MODELLED).
 *
 * Every call pins `--context <ctx> --namespace <ns>` (except the client-only version check);
 * the ambient context is never used and never changed (no `config use-context`).
 *
 * Calls (read-only):
 * - preflight: `kubectl version --client -o json` (once), `kubectl config get-contexts <ctx> -o name`
 *   (per context), `kubectl --context <ctx> --namespace <ns> auth can-i get deployments.apps`
 *   (per context+namespace; `no` → exit 20);
 * - read, per target: `kubectl --context <ctx> --namespace <ns> get deployment <name> -o json`,
 *   then `kubectl --context <ctx> --namespace <ns> get pods -l <matchLabels> -o json`.
 *
 * Desired image = the Deployment template's first container. Actual digests come from the
 * pods' `containerStatuses[].imageID` for that container, on pods that are not terminating
 * (`metadata.deletionTimestamp` unset). `imageID` forms: `<repo>@sha256:<hex>` (containerd),
 * `docker-pullable://<repo>@sha256:<hex>` (older docker shim; prefix stripped), and a bare
 * `sha256:<hex>` / empty value — an image config id or unknown, NEVER used as a registry
 * digest (`digestStatus: unavailable`). Pods disagreeing on image or digest → `mixed`, named.
 * Rollout completeness is computed from the Deployment JSON (no blocking `rollout status`):
 * `observedGeneration >= generation && updatedReplicas == replicas && availableReplicas == replicas`.
 * Last change: the `Progressing` condition's `lastUpdateTime` (an upper bound), when present.
 */
import { isComparableDigest, parseImage } from "../image.js";
import { invokeCli, mapOutcome, parseCliJson, runCli } from "./spawn.js";
import { AuthError, SourceError, arrayField, field, isRecord, missingReading, numberField, renderCommand, stringField, toIsoUtc, } from "./types.js";
/** Operator hints for `kubectl`. */
export const KUBECTL_HINTS = {
    install: "install `kubectl` and make sure it is on PATH",
    auth: () => "check that the configured context exists in your kubeconfig and that its credentials are current " +
        "(re-run your cluster's login / get-credentials command); release-radar never switches or edits contexts",
    capability: "install the kubeconfig credential plugin your cluster requires",
};
/** The environment for kubectl: the engine's, unchanged, plus `LC_ALL=C` (stable messages). */
function kubectlEnv(env) {
    return { ...env, LC_ALL: "C" };
}
function pinned(context, namespace, args) {
    return ["--context", context, "--namespace", namespace, ...args];
}
/**
 * Interprets a pod container's `imageID` (the three documented forms):
 * `repo@sha256:<hex>` and `docker-pullable://repo@sha256:<hex>` carry a registry digest;
 * a bare `sha256:<hex>` is an image config id (not a registry digest); empty is unknown.
 */
export function parseImageId(value) {
    if (value === null || value.trim() === "")
        return { digest: null, imageId: null };
    const text = value.trim().replace(/^[a-z-]+:\/\//i, "");
    const at = text.lastIndexOf("@");
    if (at >= 0) {
        const digest = text.slice(at + 1);
        return isComparableDigest(digest) ? { digest: digest.toLowerCase(), imageId: null } : { digest: null, imageId: null };
    }
    return /^sha256:[0-9a-f]{64}$/i.test(text) ? { digest: null, imageId: text.toLowerCase() } : { digest: null, imageId: null };
}
/** `-l` selector from `spec.selector.matchLabels`, or `null` when it cannot be expressed that way. */
export function labelSelector(deployment) {
    const labels = field(deployment, "spec", "selector", "matchLabels");
    if (!isRecord(labels))
        return null;
    const parts = Object.entries(labels)
        .filter((entry) => typeof entry[1] === "string")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`);
    return parts.length === 0 ? null : parts.join(",");
}
/** Builds the reading from the Deployment and its pod list (`pods` = `null` when they were not read). */
export function kubernetesReading(request, deployment, pods) {
    const notes = [];
    const specContainers = arrayField(deployment, "spec", "template", "spec", "containers");
    const mainName = stringField(specContainers[0], "name");
    const desiredRaw = stringField(specContainers[0], "image");
    const image = desiredRaw === null ? null : parseImage(desiredRaw);
    if (desiredRaw === null)
        notes.push("the Deployment template declares no container image");
    if (specContainers.length > 1)
        notes.push(`the pod template runs ${specContainers.length} containers; the image shown is the first (${mainName ?? "unnamed"})`);
    // Rollout state from JSON only.
    const generation = numberField(deployment, "metadata", "generation");
    const observed = numberField(deployment, "status", "observedGeneration");
    const replicas = numberField(deployment, "spec", "replicas");
    const updated = numberField(deployment, "status", "updatedReplicas") ?? 0;
    const available = numberField(deployment, "status", "availableReplicas") ?? 0;
    const ready = numberField(deployment, "status", "readyReplicas") ?? 0;
    const conditions = arrayField(deployment, "status", "conditions");
    const condition = (type) => conditions.find((c) => stringField(c, "type") === type);
    const progressing = condition("Progressing");
    const availableCondition = condition("Available");
    let rollout = null;
    if (generation !== null && observed !== null && replicas !== null) {
        rollout = observed >= generation && updated === replicas && available === replicas ? "complete" : "in-progress";
    }
    let state;
    if (stringField(progressing, "reason") === "ProgressDeadlineExceeded")
        state = "ProgressDeadlineExceeded";
    else if (replicas === 0)
        state = "ScaledToZero";
    else if (stringField(availableCondition, "status") === "True")
        state = "Available";
    else
        state = "Unavailable";
    if (rollout === "in-progress")
        notes.push(`rollout in progress (${updated}/${replicas ?? "?"} updated, ${available}/${replicas ?? "?"} available)`);
    if (state !== "Available")
        notes.push(`state ${state}`);
    // Actual images and digests from non-terminating pods.
    const containers = [];
    let digest = null;
    let imageId = null;
    let digestStatus = "unavailable";
    let mixed = false;
    if (pods === null) {
        notes.push("pods not read (the selector has no matchLabels) — digest unavailable");
    }
    else {
        const items = arrayField(pods, "items");
        const live = items.filter((pod) => field(pod, "metadata", "deletionTimestamp") === undefined || field(pod, "metadata", "deletionTimestamp") === null);
        const terminating = items.length - live.length;
        if (terminating > 0)
            notes.push(`${terminating} terminating pod(s) excluded`);
        const perPod = [];
        for (const pod of live) {
            const podName = stringField(pod, "metadata", "name") ?? "unnamed";
            const statuses = arrayField(pod, "status", "containerStatuses");
            const main = statuses.find((s) => mainName !== null && stringField(s, "name") === mainName) ?? (mainName === null ? statuses[0] : undefined);
            for (const status of statuses) {
                const raw = stringField(status, "image");
                if (raw === null)
                    continue;
                const id = parseImageId(stringField(status, "imageID"));
                containers.push({ name: stringField(status, "name"), image: parseImage(raw), source: `pod ${podName}`, digest: id.digest, imageId: id.imageId, trafficWeight: null });
            }
            if (main === undefined) {
                perPod.push({ pod: podName, image: null, digest: null, imageId: null });
                continue;
            }
            const id = parseImageId(stringField(main, "imageID"));
            perPod.push({ pod: podName, image: stringField(main, "image"), digest: id.digest, imageId: id.imageId });
        }
        if (perPod.length === 0)
            notes.push("no running pods matched the selector — digest unavailable");
        const images = new Set(perPod.map((p) => p.image ?? "(none)"));
        const digests = new Set(perPod.map((p) => p.digest ?? "(none)"));
        if (images.size > 1 || digests.size > 1) {
            mixed = true;
            notes.push(`pods run different images (rollout in progress or inconsistent): ${perPod
                .map((p) => `${p.pod} ${p.image ?? "?"}${p.digest === null ? "" : `@${p.digest.slice(7, 19)}`}`)
                .join(", ")}`);
        }
        else if (perPod.length > 0) {
            const only = perPod[0];
            if (only !== undefined && only.digest !== null) {
                digest = only.digest;
                digestStatus = "available";
            }
            else {
                imageId = only?.imageId ?? null;
                notes.push("pod imageID carries no registry digest — digest unavailable");
            }
            if (only !== undefined && desiredRaw !== null && only.image !== null && only.image !== desiredRaw) {
                notes.push(`pods report image ${only.image} while the Deployment declares ${desiredRaw}`);
            }
        }
    }
    const lastModified = toIsoUtc(stringField(progressing, "lastUpdateTime"), "reject");
    return {
        key: request.key,
        stage: request.stage,
        target: request.target.name,
        adapter: "kubernetes",
        status: "found",
        image,
        containers,
        state,
        lastModified,
        lastModifiedSource: lastModified === null ? null : "status.conditions[Progressing].lastUpdateTime",
        digest,
        imageId,
        digestStatus,
        mixed,
        rollout,
        details: {
            context: request.target.context,
            namespace: request.target.namespace,
            replicas,
            readyReplicas: ready,
            updatedReplicas: updated,
            availableReplicas: available,
        },
        notes,
    };
}
/** Creates the `kubernetes` adapter. */
export function createKubernetesAdapter(settings, runtime) {
    const timeoutMs = settings.timeoutSeconds * 1000;
    const env = kubectlEnv(runtime.env);
    const kubectl = (args) => invokeCli({ bin: "kubectl", args, timeoutMs, env }, "kubectl", KUBECTL_HINTS);
    return {
        name: "kubernetes",
        async preflight(requests) {
            const commands = [];
            const versionArgs = ["version", "--client", "-o", "json"];
            commands.push(renderCommand("kubectl", versionArgs));
            const version = await kubectl(versionArgs);
            if (version.kind === "not-found")
                throw new SourceError("kubectl", "`kubectl version --client` failed unexpectedly");
            const contexts = [...new Set(requests.map((r) => r.target.context))].sort();
            for (const context of contexts) {
                const args = ["config", "get-contexts", context, "-o", "name"];
                commands.push(renderCommand("kubectl", args));
                const result = await kubectl(args);
                if (result.kind === "not-found" || result.stdout.trim() !== context) {
                    throw new AuthError("not-authenticated", "kubectl", `context "${context}" is not in the kubeconfig`, KUBECTL_HINTS.auth(""));
                }
            }
            const scopes = [...new Map(requests.map((r) => [`${r.target.context}\u0000${r.target.namespace}`, r.target])).values()];
            for (const scope of scopes) {
                const args = pinned(scope.context, scope.namespace, ["auth", "can-i", "get", "deployments.apps"]);
                commands.push(renderCommand("kubectl", args));
                // `can-i` answers "no" on stdout with exit 1; every other outcome goes through the shared mapping.
                const spec = { bin: "kubectl", args, timeoutMs, env };
                const outcome = await runCli(spec);
                let answer;
                if (outcome.kind === "exit" && outcome.code === 1 && /^no\b/i.test(outcome.stdout.trim()))
                    answer = "no";
                else {
                    const result = mapOutcome(spec, outcome, "kubectl", KUBECTL_HINTS);
                    answer = result.kind === "ok" ? result.stdout.trim().toLowerCase() : "no";
                }
                if (!answer.startsWith("yes")) {
                    throw new AuthError("not-authenticated", "kubectl", `context "${scope.context}" may not get deployments in namespace "${scope.namespace}" (auth can-i: ${answer || "no"})`, KUBECTL_HINTS.auth(""));
                }
            }
            return { adapter: "kubernetes", commands, identity: null };
        },
        async read(requests) {
            const readings = [];
            for (const request of requests) {
                const { context, namespace, deployment } = request.target;
                const getArgs = pinned(context, namespace, ["get", "deployment", deployment, "-o", "json"]);
                const got = await kubectl(getArgs);
                if (got.kind === "not-found") {
                    readings.push(missingReading(request, `deployment "${deployment}" not found in namespace "${namespace}" (context "${context}")`, { context, namespace }));
                    continue;
                }
                const value = parseCliJson(got.stdout, "kubectl", getArgs);
                if (!isRecord(value))
                    throw new SourceError("kubectl", `\`${renderCommand("kubectl", getArgs)}\` did not return a JSON object`);
                const selector = labelSelector(value);
                let pods = null;
                if (selector !== null) {
                    const podArgs = pinned(context, namespace, ["get", "pods", "-l", selector, "-o", "json"]);
                    const listed = await kubectl(podArgs);
                    pods = listed.kind === "not-found" ? { items: [] } : parseCliJson(listed.stdout, "kubectl", podArgs);
                }
                readings.push(kubernetesReading(request, value, pods));
            }
            return readings;
        },
    };
}
/**
 * Lists the Deployments one context + namespace can see:
 * `kubectl --context <ctx> --namespace <ns> get deployments -o json`. The scope is supplied by the caller.
 */
export async function discoverKubernetes(settings, runtime, scope) {
    const args = pinned(scope.context, scope.namespace, ["get", "deployments", "-o", "json"]);
    const result = await invokeCli({ bin: "kubectl", args, timeoutMs: settings.timeoutSeconds * 1000, env: kubectlEnv(runtime.env) }, "kubectl", KUBECTL_HINTS);
    if (result.kind === "not-found")
        return [];
    const value = parseCliJson(result.stdout, "kubectl", args);
    const candidates = [];
    for (const item of arrayField(value, "items")) {
        const name = stringField(item, "metadata", "name");
        if (name === null)
            continue;
        candidates.push({
            adapter: "kubernetes",
            stage: null,
            fields: { context: scope.context, namespace: scope.namespace, deployment: name },
            image: stringField(arrayField(item, "spec", "template", "spec", "containers")[0], "image"),
            state: null,
            details: { replicas: numberField(item, "spec", "replicas"), availableReplicas: numberField(item, "status", "availableReplicas") },
        });
    }
    return candidates.sort((a, b) => (a.fields["deployment"] ?? "").localeCompare(b.fields["deployment"] ?? ""));
}
