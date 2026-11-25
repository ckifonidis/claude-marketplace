/**
 * Release-lifecycle judgements over what the adapters and git observed (spec requirements 32,
 * 47, 51-53). Pure apart from {@link computeDeltas}, which runs read-only git through `git.ts`.
 *
 * - {@link stageTriggerability}: `mode === "pipeline"` AND `owner === operatorTeam` (32).
 * - {@link judgeConsistency}: within-stage consistency across a component's targets, by registry
 *   digest when EVERY comparable target has one, otherwise by registry + repository + tag; every
 *   target is named in the group it belongs to (51).
 * - {@link compareStages}: cross-stage image comparison through `sameBuild`; only equal digests
 *   prove the same build, references (tags) prove nothing either way (52).
 * - {@link computeDeltas}: ancestry deltas along `local HEAD → stage 1 → …` over the stages on
 *   which the component is deployed; an internally inconsistent stage yields one entry per
 *   distinct commit and the pair is flagged, with no single verdict (53).
 * - {@link driftFindings}: what the drift gate (`--fail-on-drift`, exit 22) trips on (47).
 */
import { isOwnedByOperator, isTriggerable } from "./config.js";
import { compareCommits } from "./git.js";
import { isComparableDigest, sameBuild } from "./image.js";
/** The name of the chain link that stands for the clone's HEAD (spec requirement 53). */
export const LOCAL_LINK = "local";
/** Triggerability of `stage` under the workspace's `operatorTeam`. */
export function stageTriggerability(workspace, stage) {
    const { mode, owner } = stage.promotion;
    const owned = isOwnedByOperator(workspace, stage);
    const triggerable = isTriggerable(workspace, stage);
    let reason;
    if (triggerable)
        reason = `pipeline stage owned by the operator's team "${workspace.operatorTeam ?? ""}"`;
    else if (mode !== "pipeline")
        reason = `promotion mode is "${mode}" (only "pipeline" stages are triggerable)`;
    else
        reason = `owned by "${owner ?? "(none)"}", not by the operator's team "${workspace.operatorTeam ?? "(none)"}"`;
    return { mode, owner: owner ?? null, owned, triggerable, reason };
}
/**
 * The `sha256` digest that identifies what a target runs: the runtime registry digest when the
 * source exposes one, otherwise a digest written in the configured reference; `null` when neither.
 */
export function effectiveDigest(reading) {
    if (reading.digestStatus === "available" && isComparableDigest(reading.digest))
        return reading.digest.toLowerCase();
    const image = reading.image;
    if (image !== null && image.kind === "image" && isComparableDigest(image.digest))
        return image.digest.toLowerCase();
    return null;
}
/** The image of a found target with its effective digest folded in (for `sameBuild`). */
function comparableImage(target) {
    const image = target.reading.image;
    if (target.reading.status !== "found" || image === null || image.kind !== "image")
        return null;
    const digest = effectiveDigest(target.reading);
    return digest === null ? image : { ...image, digest };
}
function referenceKey(image) {
    return image.tag === null ? `${image.registry}/${image.repository}@${image.digest ?? ""}` : `${image.registry}/${image.repository}:${image.tag}`;
}
/** Judges whether a component's targets in one stage run the same image (spec requirement 51). */
export function judgeConsistency(targets) {
    const excluded = [];
    const comparable = [];
    for (const target of targets) {
        const image = comparableImage(target);
        if (image !== null)
            comparable.push({ name: target.name, image });
        else if (target.reading.status === "missing")
            excluded.push({ target: target.name, reason: "missing" });
        else
            excluded.push({ target: target.name, reason: `no single container image (${target.reading.image?.kind ?? "none"})` });
    }
    if (targets.length <= 1) {
        const only = comparable[0];
        return {
            status: "single-target",
            basis: null,
            groups: only === undefined ? [] : [{ key: referenceKey(only.image), targets: [only.name] }],
            excluded,
            detail: "one target in this stage",
        };
    }
    if (comparable.length < 2) {
        return { status: "not-comparable", basis: null, groups: [], excluded, detail: "fewer than two targets carry a comparable image" };
    }
    const basis = comparable.every((entry) => entry.image.digest !== null && isComparableDigest(entry.image.digest)) ? "digest" : "reference";
    const groups = new Map();
    for (const entry of comparable) {
        const key = basis === "digest" ? entry.image.digest : referenceKey(entry.image);
        groups.set(key, [...(groups.get(key) ?? []), entry.name]);
    }
    const list = [...groups.entries()].map(([key, names]) => ({ key, targets: names }));
    if (list.length === 1) {
        return { status: "consistent", basis, groups: list, excluded, detail: `all ${comparable.length} targets run the same ${basis === "digest" ? "digest" : "reference"}` };
    }
    const named = list.map((group) => `${group.targets.join(", ")} (${group.key})`).join(" vs ");
    return { status: "inconsistent", basis, groups: list, excluded, detail: `targets differ by ${basis}: ${named}` };
}
function comparisonOf(a, b) {
    const verdict = sameBuild(a, b);
    const byDigest = isComparableDigest(a.digest) && isComparableDigest(b.digest);
    if (byDigest)
        return verdict === "proven" ? "same-build" : "different-build";
    return verdict === "different" ? "different-reference" : "same-reference";
}
/** Groups a stage's comparable targets by what they run (digest, else reference). */
function imageGroups(targets) {
    const groups = new Map();
    for (const target of targets) {
        const image = comparableImage(target);
        if (image === null)
            continue;
        const key = image.digest !== null && isComparableDigest(image.digest) ? image.digest : referenceKey(image);
        const group = groups.get(key);
        if (group === undefined)
            groups.set(key, { image, names: [target.name] });
        else
            group.names.push(target.name);
    }
    return [...groups.values()];
}
/**
 * The pair summary: `different-build` if any comparison proves a different build; `same-build`
 * only when every comparison proves the same build; otherwise `different-reference` if any
 * reference differs, `same-reference` if all references match, `not-comparable` when nothing
 * could be compared.
 */
export function summariseComparisons(results) {
    if (results.length === 0)
        return "not-comparable";
    if (results.includes("different-build"))
        return "different-build";
    if (results.every((result) => result === "same-build"))
        return "same-build";
    if (results.includes("different-reference"))
        return "different-reference";
    if (results.every((result) => result === "same-build" || result === "same-reference"))
        return "same-reference";
    return "not-comparable";
}
/** Compares what two stages run (spec requirement 52). */
export function compareStages(upstream, downstream) {
    const comparisons = [];
    const ups = imageGroups(upstream.targets);
    const downs = imageGroups(downstream.targets);
    for (const up of ups) {
        for (const down of downs) {
            comparisons.push({ upstreamTargets: up.names, downstreamTargets: down.names, result: comparisonOf(up.image, down.image) });
        }
    }
    const result = summariseComparisons(comparisons.map((comparison) => comparison.result));
    return { upstream: upstream.stage, downstream: downstream.stage, result, proven: result === "same-build", comparisons };
}
/** The link for the clone's HEAD. */
export function localLink(head) {
    if ("error" in head)
        return { name: LOCAL_LINK, commits: [], unresolved: [{ targets: [], reason: `local HEAD unavailable: ${head.error}` }], inconsistent: false };
    return { name: LOCAL_LINK, commits: [{ sha: head.sha, targets: [] }], unresolved: [], inconsistent: false };
}
/** The link for one deployed stage, from its observed targets and their consistency. */
export function stageLink(stage, targets, consistency) {
    const bySha = new Map();
    const unresolved = [];
    for (const target of targets) {
        const commit = target.commit;
        if (commit !== null && commit.status === "resolved")
            bySha.set(commit.sha, [...(bySha.get(commit.sha) ?? []), target.name]);
        else if (target.reading.status === "missing")
            unresolved.push({ targets: [target.name], reason: "target missing" });
        else if (commit === null)
            unresolved.push({ targets: [target.name], reason: "no image tag to resolve" });
        else
            unresolved.push({ targets: [target.name], reason: `${commit.status}: ${commit.detail}` });
    }
    const commits = [...bySha.entries()].map(([sha, names]) => ({ sha, targets: names }));
    return { name: stage, commits, unresolved, inconsistent: consistency.status === "inconsistent" || commits.length > 1 };
}
function unknownEntry(up, down, reason) {
    return {
        upstreamCommit: up?.sha ?? null,
        downstreamCommit: down?.sha ?? null,
        upstreamTargets: up?.targets ?? [],
        downstreamTargets: down?.targets ?? [],
        verdict: "unknown",
        count: null,
        pending: [],
        extra: [],
        reason,
    };
}
function firstReason(link) {
    const first = link.unresolved[0];
    if (first === undefined)
        return `${link.name}: no resolved commit`;
    return link.name === LOCAL_LINK ? first.reason : `${link.name}: ${first.targets.join(", ")} ${first.reason}`;
}
/**
 * Deltas for each neighbouring pair of `links` (already in lifecycle order, local first).
 * Read-only git through {@link compareCommits}; never fetches ("local" = HEAD as of the last fetch).
 */
export function computeDeltas(clone, links, timeoutMs) {
    const deltas = [];
    for (let index = 1; index < links.length; index++) {
        const up = links[index - 1];
        const down = links[index];
        const entries = [];
        if (up.commits.length === 0 && down.commits.length === 0)
            entries.push(unknownEntry(null, null, `${firstReason(up)}; ${firstReason(down)}`));
        else if (up.commits.length === 0)
            for (const d of down.commits)
                entries.push(unknownEntry(null, d, firstReason(up)));
        else if (down.commits.length === 0)
            for (const u of up.commits)
                entries.push(unknownEntry(u, null, firstReason(down)));
        else {
            for (const u of up.commits) {
                for (const d of down.commits) {
                    const delta = compareCommits(clone, d.sha, u.sha, timeoutMs);
                    entries.push({
                        upstreamCommit: u.sha,
                        downstreamCommit: d.sha,
                        upstreamTargets: u.targets,
                        downstreamTargets: d.targets,
                        verdict: delta.verdict,
                        count: delta.count ?? null,
                        pending: delta.pending,
                        extra: delta.extra,
                        reason: delta.reason ?? null,
                    });
                }
            }
        }
        const sides = [];
        if (up.inconsistent)
            sides.push("upstream");
        if (down.inconsistent)
            sides.push("downstream");
        const inconsistentStage = sides.length > 0;
        const only = entries.length === 1 ? entries[0] : undefined;
        deltas.push({
            upstream: up.name,
            downstream: down.name,
            inconsistentStage,
            inconsistentSides: sides,
            verdict: inconsistentStage || only === undefined ? null : only.verdict,
            entries,
        });
    }
    return deltas;
}
/**
 * Drift findings for one component: every internally inconsistent stage (always), and every
 * named pair whose delta is not `equal` (only pairs named on `--fail-on-drift`; an inconsistent
 * pair has no single verdict and counts as not equal).
 */
export function driftFindings(component, consistency, deltas, pairs) {
    const findings = [];
    for (const entry of consistency) {
        if (entry.consistency.status === "inconsistent") {
            findings.push({ kind: "within-stage", component, where: entry.stage, detail: entry.consistency.detail });
        }
        else if (entry.link.commits.length > 1) {
            const named = entry.link.commits.map((commit) => `${commit.targets.join(", ")} (${commit.sha.slice(0, 7)})`).join(" vs ");
            findings.push({ kind: "within-stage", component, where: entry.stage, detail: `targets run different commits: ${named}` });
        }
    }
    for (const pair of pairs) {
        const delta = deltas.find((candidate) => candidate.upstream === pair.upstream && candidate.downstream === pair.downstream);
        if (delta === undefined)
            continue;
        if (delta.verdict === "equal")
            continue;
        const verdict = delta.verdict === null ? "inconsistent stage (no single verdict)" : describeVerdict(delta.entries[0]);
        findings.push({ kind: "cross-stage-delta", component, where: `${pair.upstream}:${pair.downstream}`, detail: verdict });
    }
    return findings;
}
/** `equal`, `behind 3`, `ahead 1`, `diverged (2 pending, 1 extra)`, `unknown (<reason>)`. */
export function describeVerdict(entry) {
    switch (entry.verdict) {
        case "equal":
            return "equal";
        case "behind":
            return `behind ${entry.count ?? entry.pending.length}`;
        case "ahead":
            return `ahead ${entry.count ?? entry.extra.length}`;
        case "diverged":
            return `diverged (${entry.pending.length} pending, ${entry.extra.length} extra)`;
        case "unknown":
            return `unknown (${entry.reason ?? "no reason given"})`;
    }
}
