/**
 * Commit endpoints of `settings-diff` and `handoff-package` (spec requirements 35, 56, 64).
 *
 * An endpoint token is resolved in this fixed order — nothing is guessed:
 * 1. a declared stage name → the commit that stage's targets of the component run, from a LIVE
 *    status read (adapter preflight + read, then read-only git under the stage's effective tag
 *    convention). It resolves only when every declared target of the stage is found and resolves
 *    to one and the same commit;
 * 2. `local` → the clone's HEAD commit (never the working tree);
 * 3. 7–40 hex characters → that commit, which must exist in the local clone;
 * anything else is a bad argument (64, the valid stage names listed).
 *
 * A stage that cannot be resolved is an explicit result (`missing` / `not-deployed` /
 * `unresolved`), never a substitute commit. Reading is read-only: adapters, `git rev-parse`,
 * `git show`, `git cat-file`.
 */
import { argumentError } from "./args.js";
import { RESERVED_STAGE, memberSubdir } from "./config.js";
import { EXIT, EngineError } from "./errors.js";
import { resolveCommit, showFileBytesAtCommit } from "./git.js";
import { judgeConsistency, stageLink } from "./lifecycle.js";
import { observeStage, planTargets, preflightAndRead } from "./observe.js";
const SHA_TOKEN = /^[0-9a-f]{7,40}$/i;
/**
 * Parses an endpoint token (stage name, `local` when allowed, or a commit sha).
 * @throws EngineError 64 naming the valid forms.
 */
export function parseEndpoint(flag, token, stages, allowLocal) {
    const stage = stages.find((candidate) => candidate.name === token);
    if (stage !== undefined)
        return { kind: "stage", token, stage };
    if (token === RESERVED_STAGE) {
        if (allowLocal)
            return { kind: "local", token };
        throw argumentError(`--${flag} ${token}: "local" is not accepted here (use a stage name or a commit sha)`);
    }
    if (SHA_TOKEN.test(token))
        return { kind: "commit", token };
    const forms = [`a stage (${stages.map((s) => s.name).join(", ")})`, ...(allowLocal ? ["local"] : []), "a commit sha (7-40 hex characters)"];
    throw argumentError(`--${flag} ${token}: not ${forms.join(", ")}`);
}
/**
 * Reads the given stages of `member` live in ONE adapter round: preflight every adapter needed
 * (any failure ends the run with 20/21 and no partial result), then read and resolve commits.
 */
export async function observeStages(workspace, member, stages, env) {
    const unique = stages.filter((stage, index) => stages.findIndex((other) => other.name === stage.name) === index);
    const planned = planTargets([member], unique);
    if (planned.length === 0)
        return { preflight: [], observations: unique.map((stage) => ({ stage, targets: null })) };
    const { preflight, readings } = await preflightAndRead(workspace, planned, env);
    const timeoutMs = workspace.gitTimeoutSeconds * 1000;
    const observations = unique.map((stage) => {
        const entry = member.component.stages[stage.name];
        if (entry === null || entry === undefined)
            return { stage, targets: null };
        return { stage, targets: observeStage(workspace, member, stage, entry.targets, readings, timeoutMs) };
    });
    return { preflight, observations };
}
/** The single commit a stage runs, or why there is none. */
export function stageCommit(token, observation) {
    const stage = observation.stage.name;
    if (observation.targets === null)
        return { status: "not-deployed", kind: "stage", token, stage, detail: `the component declares stage "${stage}" as not deployed (null)` };
    const missing = observation.targets.filter((target) => target.reading.status === "missing").map((target) => target.name);
    if (missing.length > 0)
        return { status: "missing", kind: "stage", token, stage, detail: `declared target(s) ${missing.join(", ")} of stage "${stage}" do not exist at the source` };
    const link = stageLink(stage, observation.targets, judgeConsistency(observation.targets));
    if (link.unresolved.length > 0) {
        const reasons = link.unresolved.map((entry) => `${entry.targets.join(", ")}: ${entry.reason}`).join("; ");
        return { status: "unresolved", kind: "stage", token, stage, detail: `the deployed commit of stage "${stage}" is not resolved (${reasons}); name the commit explicitly as a sha` };
    }
    if (link.commits.length !== 1) {
        const shas = link.commits.map((entry) => `${entry.sha.slice(0, 7)} (${entry.targets.join(", ")})`).join(", ");
        return { status: "unresolved", kind: "stage", token, stage, detail: `stage "${stage}" is inconsistent — its targets run different commits: ${shas}; name the commit explicitly as a sha` };
    }
    const only = link.commits[0];
    const summary = observation.targets.find((target) => target.commit?.status === "resolved" && target.commit.sha === only.sha)?.commit;
    return { status: "resolved", kind: "stage", token, stage, sha: only.sha, subject: summary?.status === "resolved" ? summary.subject : "", targets: only.targets };
}
/**
 * Resolves `local` or a sha in the member's clone.
 * @throws EngineError 64 when the commit is not in the local clone; 21 when git fails.
 */
export function resolveLocalEndpoint(member, spec, flag, timeoutMs) {
    const revision = spec.kind === "local" ? "HEAD" : spec.token;
    const found = resolveCommit(member.clone, revision, timeoutMs);
    if (found.status === "git-error")
        throw new EngineError(EXIT.SOURCE, "git", `--${flag} ${spec.token}: ${found.detail}`);
    if (found.status === "not-found")
        throw argumentError(`--${flag} ${spec.token}: ${found.detail}`);
    return { status: "resolved", kind: spec.kind, token: spec.token, stage: null, sha: found.sha, subject: found.subject, targets: [] };
}
/** A settings file's path relative to the repository root (`<repoSubdir>/<path>`). */
export function repoPathOf(member, path) {
    const subdir = memberSubdir(member.member);
    return subdir === null ? path : `${subdir}/${path}`;
}
/**
 * The exact bytes of the component-relative `path` at `sha`, or `null` when it does not exist
 * there. @throws EngineError 21 when git fails.
 */
export function settingsBytesAt(member, sha, path, timeoutMs) {
    const shown = showFileBytesAtCommit(member.clone, sha, repoPathOf(member, path), timeoutMs);
    if (shown.status === "git-error")
        throw new EngineError(EXIT.SOURCE, "git", shown.detail);
    return shown.status === "ok" ? shown.bytes : null;
}
