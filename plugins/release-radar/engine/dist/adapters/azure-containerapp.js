/**
 * `azure-containerapp` adapter (spec requirement 25; research §4 — field paths MODELLED).
 *
 * Calls (read-only):
 * - preflight: `az account show --output json`, then `az containerapp --help` (proves the
 *   command group / extension exists; az's dynamic extension install is disabled, so a
 *   missing extension is reported with the `az extension add` hint, never installed);
 * - read, per target: `az containerapp show --name <app> --resource-group <rg> --subscription <id> --output json`
 *   and, when found, `az containerapp revision list --name <app> --resource-group <rg> --subscription <id> --output json`.
 *
 * What runs = the ACTIVE revisions, restricted to those with `trafficWeight > 0` in Multiple
 * revision mode (and when several are active in Single mode, which happens mid-switch). The
 * app's `template` describes the LATEST revision, which may not serve yet: when
 * `latestRevisionName !== latestReadyRevisionName`, the latest revision is excluded and noted.
 * Several serving revisions with different images → `mixed`. Container Apps exposes tags
 * only: `digestStatus` is `not-exposed` (a digest written in the reference stays in `image`).
 */
import { parseImage } from "../image.js";
import { AZ_HINTS, azAccountShow, azEnv, azJson } from "./az.js";
import { invokeCli } from "./spawn.js";
import { SourceError, arrayField, field, isRecord, missingReading, numberField, renderCommand, stringField, toIsoUtc, } from "./types.js";
function revisionsFrom(value) {
    if (!Array.isArray(value))
        throw new SourceError("az", "`az containerapp revision list` did not return a JSON array");
    const revisions = [];
    for (const item of value) {
        if (!isRecord(item))
            continue;
        const name = stringField(item, "name");
        if (name === null)
            continue;
        revisions.push({
            name,
            active: field(item, "properties", "active") === true,
            trafficWeight: numberField(item, "properties", "trafficWeight") ?? 0,
            runningState: stringField(item, "properties", "runningState"),
            healthState: stringField(item, "properties", "healthState"),
            images: containerImages(field(item, "properties", "template")),
        });
    }
    return revisions;
}
function containerImages(template) {
    const images = [];
    for (const container of arrayField(template, "containers")) {
        const image = stringField(container, "image");
        if (image !== null)
            images.push({ name: stringField(container, "name"), image });
    }
    return images;
}
function runningStateOf(app) {
    const status = field(app, "properties", "runningStatus");
    if (typeof status === "string")
        return status;
    return stringField(status, "runningState");
}
/** Builds the reading from `containerapp show` + `revision list` output (exported for unit tests). */
export function containerAppReading(request, app, revisionList) {
    const notes = [];
    const mode = stringField(app, "properties", "configuration", "activeRevisionsMode");
    const latest = stringField(app, "properties", "latestRevisionName");
    const latestReady = stringField(app, "properties", "latestReadyRevisionName");
    const provisioningState = stringField(app, "properties", "provisioningState");
    const revisions = revisionsFrom(revisionList);
    let serving = revisions.filter((r) => r.active);
    if (mode?.toLowerCase() === "multiple" || serving.length > 1)
        serving = serving.filter((r) => r.trafficWeight > 0);
    if (latest !== null && latestReady !== null && latest !== latestReady) {
        if (serving.some((r) => r.name === latest))
            serving = serving.filter((r) => r.name !== latest);
        notes.push(`latest revision ${latest} is not ready (latest ready: ${latestReady}) — it is not reported as running`);
    }
    serving.sort((a, b) => b.trafficWeight - a.trafficWeight || a.name.localeCompare(b.name));
    const containers = [];
    for (const revision of serving) {
        for (const entry of revision.images) {
            containers.push({
                name: entry.name,
                image: parseImage(entry.image),
                source: `revision ${revision.name}`,
                digest: null,
                imageId: null,
                trafficWeight: revision.trafficWeight,
            });
        }
    }
    // The primary image is the first container of the highest-weighted serving revision.
    let image = null;
    const primary = serving[0];
    const first = primary?.images[0];
    if (first !== undefined)
        image = parseImage(first.image);
    if (serving.length === 0)
        notes.push("no active revision is serving traffic — no running image");
    if (primary !== undefined && primary.images.length > 1)
        notes.push(`revision ${primary.name} runs ${primary.images.length} containers; the image shown is the first (${first?.name ?? "unnamed"})`);
    const mainImages = new Set(serving.map((r) => r.images[0]?.image).filter((x) => x !== undefined));
    const mixed = mainImages.size > 1;
    if (mixed) {
        notes.push(`traffic is split across revisions with different images: ${serving
            .map((r) => `${r.name} ${r.trafficWeight}% ${r.images[0]?.image ?? "?"}`)
            .join(", ")}`);
    }
    const state = runningStateOf(app) ?? primary?.runningState ?? provisioningState;
    if (state !== null && !/^(running|runningatmaxscale|succeeded)$/i.test(state))
        notes.push(`state ${state}`);
    const lastModified = toIsoUtc(stringField(app, "systemData", "lastModifiedAt"), "reject");
    return {
        key: request.key,
        stage: request.stage,
        target: request.target.name,
        adapter: "azure-containerapp",
        status: "found",
        image,
        containers,
        state,
        lastModified,
        lastModifiedSource: lastModified === null ? null : "systemData.lastModifiedAt",
        digest: null,
        imageId: null,
        digestStatus: "not-exposed",
        mixed,
        rollout: null,
        details: {
            subscription: request.target.subscription,
            resourceGroup: request.target.resourceGroup,
            revisionMode: mode,
            latestRevision: latest,
            latestReadyRevision: latestReady,
            provisioningState,
            servingRevisions: serving.map((r) => r.name).join(","),
        },
        notes,
    };
}
function targetArgs(target) {
    return ["--name", target.app, "--resource-group", target.resourceGroup, "--subscription", target.subscription];
}
/** Creates the `azure-containerapp` adapter. */
export function createAzureContainerAppAdapter(settings, runtime) {
    const timeoutMs = settings.timeoutSeconds * 1000;
    return {
        name: "azure-containerapp",
        async preflight() {
            const account = await azAccountShow(timeoutMs, runtime.env);
            const helpArgs = ["containerapp", "--help"];
            const help = await invokeCli({ bin: "az", args: helpArgs, timeoutMs, env: azEnv(runtime.env) }, "az", AZ_HINTS);
            if (help.kind === "not-found")
                throw new SourceError("az", "`az containerapp --help` failed unexpectedly");
            return { adapter: "azure-containerapp", commands: [account.command, renderCommand("az", helpArgs)], identity: account.identity };
        },
        async read(requests) {
            const readings = [];
            for (const request of requests) {
                const showArgs = ["containerapp", "show", ...targetArgs(request.target)];
                const shown = await azJson(showArgs, timeoutMs, runtime.env);
                if (shown.kind === "not-found") {
                    readings.push(missingReading(request, `container app "${request.target.app}" not found in resource group "${request.target.resourceGroup}"`, {
                        subscription: request.target.subscription,
                        resourceGroup: request.target.resourceGroup,
                    }));
                    continue;
                }
                if (!isRecord(shown.value))
                    throw new SourceError("az", "`az containerapp show` did not return a JSON object");
                const listArgs = ["containerapp", "revision", "list", ...targetArgs(request.target)];
                const listed = await azJson(listArgs, timeoutMs, runtime.env);
                if (listed.kind === "not-found")
                    throw new SourceError("az", `\`az containerapp revision list\` reported "${request.target.app}" as not found right after showing it`);
                readings.push(containerAppReading(request, shown.value, listed.value));
            }
            return readings;
        },
    };
}
/**
 * Lists the container apps one subscription (optionally one resource group) can see:
 * `az containerapp list --subscription <id> [--resource-group <rg>] --output json`.
 * The scope is supplied by the caller (there is no workspace-level subscription list for this adapter).
 */
export async function discoverAzureContainerApps(settings, runtime, scope) {
    const args = ["containerapp", "list", "--subscription", scope.subscription];
    if (scope.resourceGroup !== undefined)
        args.push("--resource-group", scope.resourceGroup);
    const result = await azJson(args, settings.timeoutSeconds * 1000, runtime.env);
    if (result.kind === "not-found")
        return [];
    if (!Array.isArray(result.value))
        throw new SourceError("az", "`az containerapp list` did not return a JSON array");
    const candidates = [];
    for (const item of result.value) {
        const name = stringField(item, "name");
        const resourceGroup = stringField(item, "resourceGroup");
        if (name === null || resourceGroup === null)
            continue;
        candidates.push({
            adapter: "azure-containerapp",
            stage: null,
            fields: { subscription: scope.subscription, resourceGroup, app: name },
            image: containerImages(field(item, "properties", "template"))[0]?.image ?? null,
            state: runningStateOf(item) ?? stringField(item, "properties", "provisioningState"),
            details: { revisionMode: stringField(item, "properties", "configuration", "activeRevisionsMode") },
        });
    }
    return candidates.sort((a, b) => `${a.fields["resourceGroup"]}/${a.fields["app"]}`.localeCompare(`${b.fields["resourceGroup"]}/${b.fields["app"]}`));
}
