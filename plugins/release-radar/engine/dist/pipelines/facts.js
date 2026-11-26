/**
 * Pipeline-run facts and pipeline/target drift (spec requirements 46-49, 74; plan D8, D10;
 * research §3.4-§3.7). Pure apart from {@link pipelineDrift}, which runs read-only git through
 * `compareCommits` to decide which commit is newer.
 *
 * - {@link runFact}: one Build-API build as reported — id, state/result, queue/start/finish
 *   times, source ref and commit, the declared ACTION it ran, the pushed image tag and the link.
 * - Source commit (§3.6): `sourceVersion` only when it is 40 or 64 hex characters, else
 *   `undetermined` (never a guess).
 * - Action: the declared action whose own placeholder-free parameter values ALL equal the run's
 *   `templateParameters` — exactly one candidate determines it; none or several → `undetermined`.
 *   Placeholder-bearing action parameters are not compared (their value depends on the run). An
 *   action that sets no literal parameter matches any run, so a single-action mapping determines
 *   every run (the mapping itself declares that the pipeline does one thing).
 * - Pushed tag (D10), in order: (1) the `imageTagParameter`'s value in the run's
 *   `templateParameters`; (2) the mapping's `pushedTagTemplate` rendered with the run's source
 *   commit; otherwise `undetermined`. A configuration-kind run pushes no image →
 *   `not-applicable`. Logs are never parsed.
 * - Terminal = Build `status === "completed"`; success = `result === "succeeded"` exactly (a
 *   `partiallySucceeded` run is NOT a success — research §3.4). Unknown status strings are
 *   non-terminal.
 */
import { compareCommits } from "../git.js";
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** Build status meaning the run finished. */
export function isTerminalStatus(status) {
    return status === "completed";
}
/** `completed` with exactly `succeeded`. */
export function isSucceeded(status, result) {
    return isTerminalStatus(status) && result === "succeeded";
}
/** The run's source commit (40/64 hex only). */
export function sourceCommitOf(build) {
    const value = build.sourceVersion;
    if (value === null || value.trim() === "")
        return { status: "undetermined", detail: "the run carries no sourceVersion" };
    if (!COMMIT.test(value.trim()))
        return { status: "undetermined", detail: `sourceVersion ${JSON.stringify(value)} is not a 40- or 64-character commit id` };
    const sha = value.trim().toLowerCase();
    return { status: "determined", sha, shortSha: sha.slice(0, 7) };
}
function hasPlaceholder(value) {
    return value.includes("{");
}
/** The declared action a run ran, from its templateParameters (see the module comment). */
export function determineAction(mapping, templateParameters) {
    const candidates = [];
    for (const [name, action] of Object.entries(mapping.actions)) {
        const literals = Object.entries(action.parameters).filter(([, value]) => !hasPlaceholder(value));
        if (literals.every(([parameter, value]) => templateParameters !== null && templateParameters[parameter] === value))
            candidates.push(name);
    }
    if (candidates.length === 1) {
        const name = candidates[0];
        const action = mapping.actions[name];
        if (action === undefined)
            return { status: "undetermined", name: null, kind: null, detail: "internal: candidate action vanished" };
        const literals = Object.entries(action.parameters).filter(([, value]) => !hasPlaceholder(value));
        const detail = literals.length === 0
            ? `the only declared action matching this run sets no literal parameter`
            : `templateParameters ${literals.map(([parameter, value]) => `${parameter}=${value}`).join(", ")}`;
        return { status: "determined", name, kind: action.kind, detail };
    }
    if (candidates.length === 0) {
        const why = templateParameters === null ? "the run carries no templateParameters (e.g. a CI-triggered run)" : "no declared action's parameter values match the run's templateParameters";
        return { status: "undetermined", name: null, kind: null, detail: why };
    }
    return { status: "undetermined", name: null, kind: null, detail: `ambiguous: declared actions ${candidates.join(", ")} all match this run` };
}
/** Renders a `pushedTagTemplate` with a determined commit and the static names. */
export function renderPushedTag(template, commit, context) {
    return template
        .replaceAll("{commit.sha}", commit.sha)
        .replaceAll("{commit.shortSha}", commit.shortSha)
        .replaceAll("{component}", context.component)
        .replaceAll("{target}", context.target);
}
/** The image tag a run pushed, per plan D10 (see the module comment). */
export function determinePushedTag(mapping, build, commit, action, context) {
    if (action.status === "determined" && action.kind === "configuration") {
        return { status: "not-applicable", value: null, detail: `configuration-kind action "${action.name}": no image is pushed` };
    }
    const parameter = mapping.imageTagParameter;
    if (parameter !== undefined) {
        const value = build.templateParameters?.[parameter];
        if (value !== undefined && value.trim() !== "")
            return { status: "parameter", value, detail: `templateParameters.${parameter}` };
    }
    const template = mapping.pushedTagTemplate;
    if (template !== undefined) {
        if (commit.status === "determined")
            return { status: "convention", value: renderPushedTag(template, commit, context), detail: `pushedTagTemplate ${template} with source commit ${commit.shortSha}` };
        return { status: "undetermined", value: null, detail: `pushedTagTemplate needs the source commit, which is undetermined (${commit.detail})` };
    }
    if (parameter !== undefined)
        return { status: "undetermined", value: null, detail: `the run carries no templateParameters.${parameter} and the mapping states no pushedTagTemplate` };
    return { status: "undetermined", value: null, detail: "the mapping declares neither imageTagParameter nor pushedTagTemplate (logs are never parsed)" };
}
/** The mapping's declared parameter names' values in the run (names-only rule: nothing else is reported). */
function declaredParameters(mapping, templateParameters) {
    if (templateParameters === null)
        return null;
    const names = [...Object.keys(mapping.parameters), ...Object.keys(mapping.userSelectable ?? {})].sort();
    const out = {};
    for (const name of names) {
        const value = templateParameters[name];
        if (value !== undefined)
            out[name] = value;
    }
    return out;
}
/** One build as a reported run fact. */
export function runFact(mapping, build, context) {
    const sourceCommit = sourceCommitOf(build);
    const action = determineAction(mapping, build.templateParameters);
    return {
        id: build.id,
        buildNumber: build.buildNumber,
        status: build.status,
        result: build.result,
        terminal: isTerminalStatus(build.status),
        succeeded: isSucceeded(build.status, build.result),
        queueTime: build.queueTime,
        startTime: build.startTime,
        finishTime: build.finishTime,
        sourceRef: build.sourceBranch,
        sourceCommit,
        action,
        pushedTag: determinePushedTag(mapping, build, sourceCommit, action, context),
        parameters: declaredParameters(mapping, build.templateParameters),
        reason: build.reason,
        link: build.link,
    };
}
/** `succeeded`, `failed`, `in progress`, … — one word for a run. */
export function runOutcomeWord(run) {
    if (run.terminal)
        return run.result ?? "completed (no result)";
    return run.status === "inProgress" ? "in progress" : run.status;
}
/**
 * Pipeline/target drift of one mapped target. Only a COMPLETED, exactly-`succeeded` run whose
 * action is determined and of kind `build` can be "the latest succeeded build run"; in-progress
 * runs, configuration-kind runs and runs whose action is undetermined are passed over (an
 * in-progress run is not drift). Which commit is newer is decided by ancestry.
 */
export function pipelineDrift(input) {
    const base = { component: input.component, stage: input.stage, target: input.target };
    const inProgress = input.runs.filter((run) => !run.terminal).length;
    const configuration = input.runs.filter((run) => run.action.status === "determined" && run.action.kind === "configuration").length;
    const undetermined = input.runs.filter((run) => run.succeeded && run.action.status === "undetermined").length;
    const passed = [];
    if (inProgress > 0)
        passed.push(`${inProgress} in-progress run(s) are not drift`);
    if (configuration > 0)
        passed.push(`${configuration} configuration-kind run(s) never count`);
    if (undetermined > 0)
        passed.push(`${undetermined} succeeded run(s) with an undetermined action were passed over`);
    const note = passed.length === 0 ? "" : ` (${passed.join("; ")})`;
    const latest = input.runs.find((run) => run.succeeded && run.action.status === "determined" && run.action.kind === "build");
    if (latest === undefined) {
        return { ...base, status: "no-succeeded-build", build: null, targetCommit: null, relation: null, count: null, detail: `no succeeded build-kind run among the latest ${input.runs.length} run(s)${note}` };
    }
    const built = latest.sourceCommit;
    const deployed = input.targetCommit !== null && input.targetCommit.status === "resolved" ? input.targetCommit.sha.toLowerCase() : null;
    const buildRef = { runId: latest.id, commit: built.status === "determined" ? built.sha : null };
    if (built.status !== "determined") {
        return { ...base, status: "unknown", build: buildRef, targetCommit: deployed, relation: null, count: null, detail: `run #${latest.id} succeeded but its source commit is undetermined (${built.detail})${note}` };
    }
    if (deployed === null) {
        const why = !input.targetFound ? "the target is missing" : input.targetCommit === null ? "the target runs no single container image" : `the target's commit is not resolved (${input.targetCommit.status})`;
        return { ...base, status: "unknown", build: buildRef, targetCommit: null, relation: null, count: null, detail: `run #${latest.id} built ${built.shortSha}, but ${why}${note}` };
    }
    if (deployed === built.sha) {
        return { ...base, status: "in-sync", build: buildRef, targetCommit: deployed, relation: null, count: null, detail: `the target runs ${built.shortSha}, built by the latest succeeded build run #${latest.id}${note}` };
    }
    // downstream = the target, upstream = the build: "behind" means the build is newer than what runs.
    const delta = compareCommits(input.clone, deployed, built.sha, input.timeoutMs);
    const short = deployed.slice(0, 7);
    let relation;
    let count = null;
    let newer;
    switch (delta.verdict) {
        case "behind":
            relation = "behind";
            count = delta.count ?? delta.pending.length;
            newer = `the build is newer: the target is ${count} commit(s) behind it (not landed)`;
            break;
        case "ahead":
            relation = "ahead";
            count = delta.count ?? delta.extra.length;
            newer = `the target is newer: it runs ${count} commit(s) beyond the latest succeeded build run`;
            break;
        case "diverged":
            relation = "diverged";
            newer = `the two have diverged (${delta.pending.length} commit(s) only in the build, ${delta.extra.length} only in the target)`;
            break;
        default:
            relation = "unknown";
            newer = `which is newer is unknown (${delta.reason ?? "no reason given"})`;
    }
    return {
        ...base,
        status: "drift",
        build: buildRef,
        targetCommit: deployed,
        relation,
        count,
        detail: `the latest succeeded build run #${latest.id} built ${built.shortSha}, but the target runs ${short} — ${newer}${note}`,
    };
}
