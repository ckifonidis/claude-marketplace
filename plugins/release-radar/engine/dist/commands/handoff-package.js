/**
 * `handoff-package` (spec requirements 12, 15, 35, 39, 64, 73; plan Phase 8). Writes ONLY the
 * engine's own package directory in the workspace repository; nothing remote is touched, nothing
 * is triggered, and no file content is ever printed.
 *
 * `handoff-package --workspace <path> <component> --stage <handoff stage> --commit <sha> [--json]`
 *
 * - `--commit` (the promoted commit) is REQUIRED — it is never defaulted to the upstream stage's
 *   deployed commit. It must be 7–40 hex characters naming a commit in the member's clone (64).
 *   The skill passes the commit the user confirmed (normally what the upstream stage runs, from
 *   `status`); the engine then proves it with a live read and records any mismatch as blocking.
 * - `--stage` must be a `handoff` stage (exit 26 otherwise), decided from configuration before any
 *   adapter call (like the run gate's refusals, plan D27).
 *
 * Order: arguments (64) → names (64) → canonical load (24, 29) → handoff-mode refusal (26) →
 * commit in the clone (64) → `component.json` at the commit (missing / invalid → 24, "invalid at
 * <sha>"; git failure → 21) → the component declaring the stage `null` at the commit (26) → ONE
 * live read of the upstream stage and the handoff stage (adapter preflight 20/21, fail-whole-run)
 * → package written → retention for this (component, stage) pair.
 *
 * Package contents (handoff.ts has the manifest key order):
 * - the image reference, repository, tag and digest (or "digest unknown") of what the UPSTREAM
 *   stage (the one before the handoff stage) runs, read live — recorded only when that stage
 *   resolves to exactly the promoted commit and its targets agree on the image;
 * - each declared settings file of the stage (from `component.json` at the promoted commit) copied
 *   VERBATIM from `git cat-file blob <commit>:<path>`, with its sha256, byte length and source
 *   commit in the manifest;
 * - the settings diff between the commit the handoff stage runs now and the promoted commit
 *   ("not-compared", with the reason, when the handoff stage's commit cannot be resolved);
 * - both `beforePromote` pointers (workspace and component) and the receiving owner;
 * - literal-secret warnings by KEY POINTER only (settings-diff.ts heuristic).
 *
 * ## Blocking findings
 * A settings path missing at the promoted commit is a BLOCKING FINDING, not a config error (35):
 * the package is still written — with `complete: false` and the finding in `blocking[]` — so the
 * evidence is on disk, and the run exits **23** (a declared artefact does not exist; the full report
 * is printed). The same applies when no image can be determined for the promoted commit (no
 * upstream stage, upstream not deployed / missing / inconsistent / unresolved, upstream running a
 * different commit, or upstream targets disagreeing on the image). The skill must not hand over
 * an incomplete package. No blocking finding → exit 0.
 */
import { argumentError } from "../args.js";
import { EXIT, EngineError } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { DIGEST_UNKNOWN, MANIFEST_FILE, nextPackageDir, pruneHandoffPackages, sha256, writeHandoffPackage, } from "../handoff.js";
import { effectiveDigest } from "../lifecycle.js";
import { analyzeSettings, diffSettingsFile } from "../settings-diff.js";
import { observeStages, resolveLocalEndpoint, settingsBytesAt, stageCommit } from "../stage-commit.js";
import { loadWorkspace, loadWorkspaceSkeleton, readComponentAtCommit, requireAvailableMember } from "../workspace.js";
/** The reference without its `@digest` and `:tag` suffixes, exactly as written. */
export function repositoryOf(reference) {
    const withoutDigest = reference.split("@")[0];
    const slash = withoutDigest.lastIndexOf("/");
    const colon = withoutDigest.lastIndexOf(":");
    return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}
function short(sha) {
    return sha.slice(0, 7);
}
/** The image the upstream stage runs for the promoted commit, or the blocking reason. */
function upstreamImage(upstream, observation, promotedSha) {
    if (upstream === null || observation === undefined)
        return { image: null, blocking: "no upstream stage before the handoff stage: there is no built image to hand off" };
    const commit = stageCommit(upstream.name, observation);
    if (commit.status !== "resolved")
        return { image: null, blocking: `image unknown: upstream stage "${upstream.name}" — ${commit.detail}` };
    if (commit.sha !== promotedSha) {
        return { image: null, blocking: `image unknown: upstream stage "${upstream.name}" runs ${short(commit.sha)}, not the promoted commit ${short(promotedSha)}` };
    }
    const running = (observation.targets ?? []).filter((target) => target.reading.image?.kind === "image");
    const references = new Set(running.map((target) => `${repositoryOf(target.reading.image.raw)}\u0000${target.reading.image.tag ?? ""}`));
    if (running.length === 0 || references.size !== 1) {
        return { image: null, blocking: `image unknown: the targets of upstream stage "${upstream.name}" do not agree on one image reference` };
    }
    const digests = new Set(running.map((target) => effectiveDigest(target.reading)).filter((digest) => digest !== null));
    if (digests.size > 1)
        return { image: null, blocking: `image unknown: the targets of upstream stage "${upstream.name}" run different digests` };
    const first = [...running].sort((a, b) => (a.name < b.name ? -1 : 1))[0];
    const image = first.reading.image;
    return {
        image: {
            sourceStage: upstream.name,
            reference: image.raw.trim(),
            repository: repositoryOf(image.raw.trim()),
            tag: image.tag,
            digest: [...digests][0] ?? DIGEST_UNKNOWN,
            targets: running.map((target) => target.name).sort(),
        },
        blocking: null,
    };
}
/** Runs `handoff-package`. @throws EngineError for exits without a report (64, 24, 29, 26, 20, 21, 1). */
export async function runHandoffPackage(options, context) {
    const skeleton = loadWorkspaceSkeleton(options.workspace);
    const ws = skeleton.workspace;
    if (!ws.members.some((member) => member.name === options.component)) {
        throw argumentError(`unknown component "${options.component}" (members: ${ws.members.map((m) => m.name).join(", ")})`);
    }
    const stageIndex = ws.stages.findIndex((candidate) => candidate.name === options.stage);
    if (stageIndex < 0)
        throw argumentError(`unknown stage "${options.stage}" (stages: ${ws.stages.map((s) => s.name).join(", ")})`);
    if (!/^[0-9a-f]{7,40}$/i.test(options.commit))
        throw argumentError(`--commit ${options.commit}: not a commit sha (7-40 hex characters); the promoted commit is never defaulted`);
    const commitSpec = { kind: "commit", token: options.commit };
    const stage = ws.stages[stageIndex];
    const upstream = stageIndex > 0 ? ws.stages[stageIndex - 1] : null;
    const loaded = loadWorkspace(options.workspace, { members: [options.component], canonical: "require" });
    if (stage.promotion.mode !== "handoff") {
        throw new EngineError(EXIT.REFUSED, "refused", `stage "${stage.name}" is a "${stage.promotion.mode}" stage: handoff packages are assembled only for "handoff" stages (another team deploys them)`);
    }
    const receivingOwner = stage.promotion.owner;
    if (receivingOwner === undefined)
        throw new EngineError(EXIT.INTERNAL, "load", `handoff stage "${stage.name}" has no owner (validation should have refused it)`);
    const member = requireAvailableMember(loaded, options.component);
    const timeoutMs = ws.gitTimeoutSeconds * 1000;
    const promoted = resolveLocalEndpoint(member, commitSpec, "commit", timeoutMs);
    if (promoted.status !== "resolved")
        throw new EngineError(EXIT.INTERNAL, "resolve", "a local endpoint did not resolve");
    const promotedSha = promoted.sha;
    const atCommit = readComponentAtCommit(loaded, options.component, promotedSha);
    if (atCommit.status === "git-error")
        throw new EngineError(EXIT.SOURCE, "git", `${atCommit.label}: ${atCommit.detail}`);
    if (atCommit.status === "missing")
        throw new EngineError(EXIT.INVALID, "load", `no component config at ${promotedSha}: ${atCommit.detail}`, { file: atCommit.label });
    if (atCommit.status === "invalid")
        throw new EngineError(EXIT.INVALID, "load", `${atCommit.label} invalid at ${promotedSha}: ${atCommit.error.describe()}`, atCommit.error.location);
    const entry = atCommit.component.stages[stage.name];
    if (entry === null || entry === undefined) {
        throw new EngineError(EXIT.REFUSED, "refused", `component.json at ${short(promotedSha)} declares stage "${stage.name}" as not deployed (null): there is nothing to hand off`);
    }
    // One live read: the upstream stage (image) and the handoff stage (its deployed commit).
    const { preflight, observations } = await observeStages(ws, member, upstream === null ? [stage] : [upstream, stage], context.env);
    const blocking = [];
    const imageResult = upstreamImage(upstream, observations.find((o) => o.stage.name === upstream?.name), promotedSha);
    if (imageResult.blocking !== null)
        blocking.push(imageResult.blocking);
    // Verbatim copies at the promoted commit.
    const declared = entry.handoff?.settingsFiles ?? [];
    const copies = [];
    const literalSecretWarnings = [];
    const promotedSides = new Map();
    for (const path of declared) {
        const bytes = settingsBytesAt(member, promotedSha, path, timeoutMs);
        const side = analyzeSettings(bytes);
        promotedSides.set(path, side);
        if (bytes === null) {
            blocking.push(`settings file ${path} does not exist at ${promotedSha}`);
            continue;
        }
        copies.push({ path, bytes });
        for (const key of side.literalSecrets)
            literalSecretWarnings.push({ file: path, key });
    }
    // Settings diff against what the handoff stage runs now.
    const stageObservation = observations.find((o) => o.stage.name === stage.name);
    const deployed = stageObservation === undefined ? null : stageCommit(stage.name, stageObservation);
    let settingsDiff;
    if (deployed === null || deployed.status !== "resolved") {
        settingsDiff = { status: "not-compared", deployedCommit: null, reason: deployed === null ? `stage "${stage.name}" was not read` : deployed.detail, files: [] };
    }
    else {
        settingsDiff = {
            status: "compared",
            deployedCommit: deployed.sha,
            reason: null,
            files: declared.map((path) => diffSettingsFile(path, analyzeSettings(settingsBytesAt(member, deployed.sha, path, timeoutMs)), promotedSides.get(path) ?? analyzeSettings(null))),
        };
    }
    const createdAt = context.now().toISOString();
    const manifest = {
        schemaVersion: 1,
        engineVersion: engineVersion(),
        createdAt,
        component: options.component,
        stage: stage.name,
        receivingOwner,
        promotedCommit: promotedSha,
        complete: blocking.length === 0,
        blocking,
        image: imageResult.image,
        files: copies.map((copy) => ({ path: copy.path, sourceCommit: promotedSha, sha256: sha256(copy.bytes), bytes: copy.bytes.length })),
        settingsDiff,
        beforePromote: { workspace: ws.beforePromote?.[stage.name] ?? null, component: entry.handoff?.beforePromote ?? null },
        literalSecretWarnings,
    };
    const dir = nextPackageDir(loaded.root, options.component, stage.name, createdAt);
    const manifestFile = writeHandoffPackage(dir, manifest, copies);
    const retention = pruneHandoffPackages(loaded.root, ws.handoffRetention, { dryRun: false, only: { component: options.component, stage: stage.name } });
    const exitCode = blocking.length > 0 ? EXIT.MISSING : EXIT.OK;
    const phase = exitCode === EXIT.OK ? "complete" : "blocking";
    const report = {
        schemaVersion: 1,
        engineVersion: manifest.engineVersion,
        command: "handoff-package",
        generatedAt: createdAt,
        workspace: { root: loaded.root, file: loaded.file },
        component: options.component,
        stage: stage.name,
        receivingOwner,
        promotedCommit: promotedSha,
        package: { dir, manifest: manifestFile },
        complete: manifest.complete,
        blocking: [...blocking].sort(),
        image: manifest.image,
        files: manifest.files.map((file) => ({ path: file.path, bytes: file.bytes, sourceCommit: file.sourceCommit })),
        settingsDiff,
        beforePromote: manifest.beforePromote,
        literalSecretWarnings: [...literalSecretWarnings].sort((a, b) => (a.file + a.key < b.file + b.key ? -1 : 1)),
        preflight,
        retention: { keep: ws.handoffRetention, kept: retention.kept, deleted: retention.deleted },
        outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
    };
    const stderr = blocking.length > 0 ? [`release-radar: the package is INCOMPLETE — ${blocking.length} blocking finding(s); do not hand it over (exit 23; the report above is complete)`] : [];
    for (const warning of report.literalSecretWarnings)
        stderr.push(`release-radar: warning — ${warning.file} ${warning.key === "" ? "(root)" : warning.key} looks like a literal secret, not a secret reference (value not shown)`);
    return { exitCode, phase, stdout: renderHuman(report, options.json), stderr, json: options.json };
}
function renderHuman(report, json) {
    if (json)
        return `${JSON.stringify(report, null, 2)}\n`;
    const lines = [
        `release-radar handoff-package — ${report.component} → stage ${report.stage} (receiving owner: ${report.receivingOwner}; nothing was sent or triggered)`,
        `  promoted commit: ${report.promotedCommit}`,
        `  package: ${report.package.dir}`,
        `  manifest: ${report.package.manifest} (${MANIFEST_FILE}, canonical)`,
        `  complete: ${report.complete ? "yes" : "NO"}`,
    ];
    for (const finding of report.blocking)
        lines.push(`  BLOCKING: ${finding}`);
    if (report.image === null)
        lines.push("  image: unknown (see blocking findings)");
    else
        lines.push(`  image: ${report.image.reference}  digest: ${report.image.digest}  (from stage ${report.image.sourceStage}: ${report.image.targets.join(", ")})`);
    lines.push(`  settings files copied verbatim (contents not shown): ${report.files.length === 0 ? "none" : report.files.map((file) => `${file.path} (${file.bytes} bytes)`).join(", ")}`);
    if (report.settingsDiff.status === "compared") {
        lines.push(`  settings diff vs ${(report.settingsDiff.deployedCommit ?? "").slice(0, 7)} (deployed on ${report.stage}): ${report.settingsDiff.files.map((file) => `${file.path} ${file.status}`).join(", ") || "no files"}`);
    }
    else
        lines.push(`  settings diff: not compared — ${report.settingsDiff.reason ?? ""}`);
    lines.push(`  beforePromote: workspace ${report.beforePromote.workspace ?? "none"}; component ${report.beforePromote.component ?? "none"}`);
    for (const warning of report.literalSecretWarnings)
        lines.push(`  literal-secret warning: ${warning.file} ${warning.key === "" ? "(root)" : warning.key} (value not shown)`);
    lines.push(`  retention: keeping ${report.retention.keep} per component and stage; pruned ${report.retention.deleted.length}`);
    return `${lines.join("\n")}\n`;
}
