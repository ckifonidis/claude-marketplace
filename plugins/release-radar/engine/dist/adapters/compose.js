/**
 * `compose` adapter (spec requirement 27; research §6 — shapes MODELLED).
 *
 * Calls (read-only; never `up`, `pull`, `restart`, never `docker pull` to learn a digest):
 * - preflight: `docker version --format {{.Server.Version}}` (CLI present + daemon reachable),
 *   `docker compose version` (the Compose v2 plugin is installed);
 * - read: `docker compose --project-name <p> ps --all --format json` ONCE per project, then
 *   `docker container inspect <id>...` for the service's containers and
 *   `docker image inspect <imageId>...` for their images.
 *
 * `ps` prints NDJSON (one object per line, Compose v2.21+) or one JSON array (older v2): both
 * are parsed. No container for the service (including an unknown project: empty output,
 * exit 0) → `missing`. The configured reference is `Config.Image`; the local image id is
 * the container's `Image`; the registry digest is the `RepoDigests` entry whose repository
 * matches the reference — a never-pushed image has none (`digestStatus: unavailable`).
 * Last change = the container's `Created` time (when Compose (re)created it; an upper bound).
 * `State.StartedAt` is "running since", not a deploy time, and is only a detail.
 */
import { isComparableDigest, parseImage } from "../image.js";
import { invokeCli, parseCliJson } from "./spawn.js";
import { SourceError, arrayField, isRecord, missingReading, numberField, renderCommand, stringField, toIsoUtc, } from "./types.js";
/** Operator hints for `docker`. */
export const DOCKER_HINTS = {
    install: "install the Docker CLI (`docker`) and make sure it is on PATH",
    auth: () => "start the Docker daemon (or Docker Desktop) and check that the active docker context / DOCKER_HOST points at it",
    capability: "install the Docker Compose v2 plugin (`docker compose`)",
};
/** The environment for docker: the engine's, unchanged, plus `LC_ALL=C`. */
function dockerEnv(env) {
    return { ...env, LC_ALL: "C" };
}
/**
 * Parses `docker compose ps --format json` output in either shape: one JSON array (older
 * Compose v2) or NDJSON (one object per line, v2.21+). Empty output is an empty list.
 * @throws SourceError when the output is neither.
 */
export function parseComposePs(stdout) {
    const text = stdout.trim();
    if (text === "")
        return [];
    let items;
    try {
        const whole = JSON.parse(text);
        items = Array.isArray(whole) ? whole : [whole];
    }
    catch {
        items = [];
        for (const line of text.split(/\r?\n/)) {
            if (line.trim() === "")
                continue;
            try {
                items.push(JSON.parse(line));
            }
            catch {
                throw new SourceError("docker", "`docker compose ps --format json` printed a line that is not JSON");
            }
        }
    }
    const rows = [];
    for (const item of items) {
        if (!isRecord(item))
            throw new SourceError("docker", "`docker compose ps --format json` printed a value that is not an object");
        const id = stringField(item, "ID");
        const service = stringField(item, "Service");
        if (id === null || service === null)
            continue;
        const health = stringField(item, "Health");
        rows.push({
            id,
            name: stringField(item, "Name"),
            service,
            image: stringField(item, "Image"),
            state: stringField(item, "State"),
            health: health === "" ? null : health,
            exitCode: numberField(item, "ExitCode"),
        });
    }
    return rows;
}
/** The `RepoDigests` entry for the reference's repository, as `sha256:<hex>`; `null` when none. */
export function matchRepoDigest(repoDigests, reference) {
    if (reference === null || reference.kind !== "image")
        return null;
    for (const entry of repoDigests) {
        const parsed = parseImage(entry);
        if (parsed.kind !== "image" || parsed.digest === null)
            continue;
        if (parsed.registry === reference.registry && parsed.repository === reference.repository && isComparableDigest(parsed.digest)) {
            return parsed.digest.toLowerCase();
        }
    }
    return null;
}
/** Builds the reading from the service's ps rows, container inspections and image RepoDigests. */
export function composeReading(request, inspected, repoDigests) {
    const notes = [];
    const containers = [];
    for (const c of inspected) {
        const ref = c.configImage ?? c.row.image;
        if (ref === null)
            continue;
        const image = parseImage(ref);
        const digest = c.imageId === null ? null : matchRepoDigest(repoDigests.get(c.imageId) ?? [], image);
        containers.push({ name: c.row.name, image, source: `container ${c.row.name ?? c.row.id}`, digest, imageId: c.imageId, trafficWeight: null });
    }
    const first = containers[0];
    const image = first?.image ?? null;
    if (image === null)
        notes.push("the container exposes no image reference");
    const imageIds = new Set(containers.map((c) => c.imageId ?? "(none)"));
    const refs = new Set(containers.map((c) => c.image.raw));
    const mixed = imageIds.size > 1 || refs.size > 1;
    if (mixed)
        notes.push(`service containers run different images: ${containers.map((c) => `${c.name ?? "?"} ${c.image.raw} ${c.imageId?.slice(7, 19) ?? "?"}`).join(", ")}`);
    let digest = null;
    let digestStatus = "unavailable";
    if (!mixed && first !== undefined) {
        if (first.digest !== null) {
            digest = first.digest;
            digestStatus = "available";
        }
        else {
            notes.push("the local image has no matching RepoDigests entry (never pushed or pulled by digest) — digest unavailable; image id only");
        }
    }
    const states = [...new Set(inspected.map((c) => c.status ?? c.row.state ?? "unknown"))];
    const state = states.length === 1 ? (states[0] ?? null) : "mixed";
    if (state !== "running")
        notes.push(`state ${state}${states.length > 1 ? ` (${states.join(", ")})` : ""}`);
    if (inspected.length > 1)
        notes.push(`${inspected.length} containers for service "${request.target.service}"`);
    const created = inspected.map((c) => toIsoUtc(c.created, "reject")).filter((x) => x !== null).sort();
    const lastModified = created.at(-1) ?? null;
    const healths = [...new Set(inspected.map((c) => c.health).filter((h) => h !== null))];
    return {
        key: request.key,
        stage: request.stage,
        target: request.target.name,
        adapter: "compose",
        status: "found",
        image,
        containers,
        state,
        lastModified,
        lastModifiedSource: lastModified === null ? null : "container Created",
        digest,
        imageId: mixed ? null : (first?.imageId ?? null),
        digestStatus,
        mixed,
        rollout: null,
        details: {
            project: request.target.project,
            service: request.target.service,
            containers: inspected.length,
            health: healths.length === 0 ? null : healths.join(","),
            startedAt: inspected[0]?.startedAt ?? null,
        },
        notes,
    };
}
/** Creates the `compose` adapter. */
export function createComposeAdapter(settings, runtime) {
    const timeoutMs = settings.timeoutSeconds * 1000;
    const env = dockerEnv(runtime.env);
    const docker = (args) => invokeCli({ bin: "docker", args, timeoutMs, env }, "docker", DOCKER_HINTS);
    return {
        name: "compose",
        async preflight() {
            const versionArgs = ["version", "--format", "{{.Server.Version}}"];
            const version = await docker(versionArgs);
            if (version.kind === "not-found")
                throw new SourceError("docker", "`docker version` failed unexpectedly");
            const composeArgs = ["compose", "version"];
            const compose = await docker(composeArgs);
            if (compose.kind === "not-found")
                throw new SourceError("docker", "`docker compose version` failed unexpectedly");
            return { adapter: "compose", commands: [renderCommand("docker", versionArgs), renderCommand("docker", composeArgs)], identity: null };
        },
        async read(requests) {
            const psByProject = new Map();
            const readings = [];
            for (const request of requests) {
                const { project, service } = request.target;
                let rows = psByProject.get(project);
                if (rows === undefined) {
                    const psArgs = ["compose", "--project-name", project, "ps", "--all", "--format", "json"];
                    const ps = await docker(psArgs);
                    rows = ps.kind === "not-found" ? [] : parseComposePs(ps.stdout);
                    psByProject.set(project, rows);
                }
                const mine = rows.filter((row) => row.service === service);
                if (mine.length === 0) {
                    readings.push(missingReading(request, `no container for service "${service}" in compose project "${project}"`, { project, service }));
                    continue;
                }
                const inspectArgs = ["container", "inspect", ...mine.map((row) => row.id)];
                const inspectedRaw = await docker(inspectArgs);
                if (inspectedRaw.kind === "not-found")
                    throw new SourceError("docker", `containers of "${project}/${service}" vanished between ps and inspect`);
                const list = parseCliJson(inspectedRaw.stdout, "docker", inspectArgs);
                if (!Array.isArray(list))
                    throw new SourceError("docker", `\`${renderCommand("docker", inspectArgs)}\` did not return a JSON array`);
                const inspected = mine.map((row) => {
                    const item = list.find((entry) => {
                        const id = stringField(entry, "Id") ?? "";
                        return id === row.id || id.startsWith(row.id);
                    });
                    return {
                        row,
                        configImage: stringField(item, "Config", "Image"),
                        imageId: stringField(item, "Image"),
                        status: stringField(item, "State", "Status"),
                        created: stringField(item, "Created"),
                        startedAt: stringField(item, "State", "StartedAt"),
                        health: stringField(item, "State", "Health", "Status") ?? row.health,
                    };
                });
                const imageIds = [...new Set(inspected.map((c) => c.imageId).filter((id) => id !== null))];
                const repoDigests = new Map();
                if (imageIds.length > 0) {
                    const imageArgs = ["image", "inspect", ...imageIds];
                    const images = await docker(imageArgs);
                    if (images.kind === "ok") {
                        const parsed = parseCliJson(images.stdout, "docker", imageArgs);
                        for (const entry of Array.isArray(parsed) ? parsed : []) {
                            const id = stringField(entry, "Id");
                            if (id !== null)
                                repoDigests.set(id, arrayField(entry, "RepoDigests").filter((d) => typeof d === "string"));
                        }
                    }
                    // not-found: the image was removed locally after the container started → no RepoDigests (digest unavailable).
                }
                readings.push(composeReading(request, inspected, repoDigests));
            }
            return readings;
        },
    };
}
/**
 * Lists services with containers. With a `project`: that project's `ps`; without: the
 * projects from `docker compose ls --all --format json`, then each project's `ps`.
 */
export async function discoverCompose(settings, runtime, scope) {
    const timeoutMs = settings.timeoutSeconds * 1000;
    const env = dockerEnv(runtime.env);
    const docker = (args) => invokeCli({ bin: "docker", args, timeoutMs, env }, "docker", DOCKER_HINTS);
    let projects;
    if (scope.project !== undefined)
        projects = [scope.project];
    else {
        const lsArgs = ["compose", "ls", "--all", "--format", "json"];
        const ls = await docker(lsArgs);
        const value = ls.kind === "ok" && ls.stdout.trim() !== "" ? parseCliJson(ls.stdout, "docker", lsArgs) : [];
        projects = (Array.isArray(value) ? value : []).map((p) => stringField(p, "Name")).filter((n) => n !== null).sort();
    }
    const candidates = [];
    for (const project of projects) {
        const ps = await docker(["compose", "--project-name", project, "ps", "--all", "--format", "json"]);
        const rows = ps.kind === "ok" ? parseComposePs(ps.stdout) : [];
        const byService = new Map();
        for (const row of rows)
            byService.set(row.service, [...(byService.get(row.service) ?? []), row]);
        for (const [service, serviceRows] of [...byService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            candidates.push({
                adapter: "compose",
                stage: null,
                fields: { project, service },
                image: serviceRows[0]?.image ?? null,
                state: serviceRows[0]?.state ?? null,
                details: { containers: serviceRows.length },
            });
        }
    }
    return candidates;
}
