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

import { isOwnedByOperator, isTriggerable, type Stage, type Workspace } from "./config.js";
import type { TargetReading } from "./adapters/types.js";
import { compareCommits, type CommitResolution, type CommitSummary, type DeltaVerdict } from "./git.js";
import { isComparableDigest, sameBuild, type ImageInfo, type ParsedImageRef } from "./image.js";

/** The name of the chain link that stands for the clone's HEAD (spec requirement 53). */
export const LOCAL_LINK = "local";

// ---------------------------------------------------------------------------
// Triggerability

/** Promotion facts of one stage as reported (spec requirements 32, 46). */
export interface Triggerability {
  readonly mode: Stage["promotion"]["mode"];
  /** `null` only for mode `none`, which declares no owner. */
  readonly owner: string | null;
  /** True when `owner === operatorTeam`. */
  readonly owned: boolean;
  readonly triggerable: boolean;
  /** One line saying why the stage is or is not triggerable. */
  readonly reason: string;
}

/** Triggerability of `stage` under the workspace's `operatorTeam`. */
export function stageTriggerability(workspace: Workspace, stage: Stage): Triggerability {
  const { mode, owner } = stage.promotion;
  const owned = isOwnedByOperator(workspace, stage);
  const triggerable = isTriggerable(workspace, stage);
  let reason: string;
  if (triggerable) reason = `pipeline stage owned by the operator's team "${workspace.operatorTeam ?? ""}"`;
  else if (mode !== "pipeline") reason = `promotion mode is "${mode}" (only "pipeline" stages are triggerable)`;
  else reason = `owned by "${owner ?? "(none)"}", not by the operator's team "${workspace.operatorTeam ?? "(none)"}"`;
  return { mode, owner: owner ?? null, owned, triggerable, reason };
}

// ---------------------------------------------------------------------------
// Observed targets

/** One target as read, with its resolved commit (`null` when there was nothing to resolve). */
export interface ObservedTarget {
  readonly name: string;
  readonly reading: TargetReading;
  readonly commit: CommitResolution | null;
}

/**
 * The `sha256` digest that identifies what a target runs: the runtime registry digest when the
 * source exposes one, otherwise a digest written in the configured reference; `null` when neither.
 */
export function effectiveDigest(reading: TargetReading): string | null {
  if (reading.digestStatus === "available" && isComparableDigest(reading.digest)) return reading.digest.toLowerCase();
  const image = reading.image;
  if (image !== null && image.kind === "image" && isComparableDigest(image.digest)) return image.digest.toLowerCase();
  return null;
}

/** The image of a found target with its effective digest folded in (for `sameBuild`). */
function comparableImage(target: ObservedTarget): ParsedImageRef | null {
  const image = target.reading.image;
  if (target.reading.status !== "found" || image === null || image.kind !== "image") return null;
  const digest = effectiveDigest(target.reading);
  return digest === null ? image : { ...image, digest };
}

function referenceKey(image: ParsedImageRef): string {
  return image.tag === null ? `${image.registry}/${image.repository}@${image.digest ?? ""}` : `${image.registry}/${image.repository}:${image.tag}`;
}

// ---------------------------------------------------------------------------
// Within-stage consistency (spec requirement 51)

/** Outcome of {@link judgeConsistency}. */
export type ConsistencyStatus = "consistent" | "inconsistent" | "single-target" | "not-comparable";

/** Targets that run the same thing under the judged basis. */
export interface ConsistencyGroup {
  /** The digest (`basis: "digest"`) or `registry/repository:tag` (`basis: "reference"`). */
  readonly key: string;
  readonly targets: readonly string[];
}

/** Within-stage consistency of one component's targets. */
export interface StageConsistency {
  readonly status: ConsistencyStatus;
  /** `digest` when every comparable target has a digest; `reference` otherwise; `null` when nothing was compared. */
  readonly basis: "digest" | "reference" | null;
  /** One group per distinct key (two or more groups = inconsistent), every comparable target named. */
  readonly groups: readonly ConsistencyGroup[];
  /** Targets left out of the comparison and why (missing, not a single container image). */
  readonly excluded: readonly { readonly target: string; readonly reason: string }[];
  /** One human line. */
  readonly detail: string;
}

/** Judges whether a component's targets in one stage run the same image (spec requirement 51). */
export function judgeConsistency(targets: readonly ObservedTarget[]): StageConsistency {
  const excluded: { target: string; reason: string }[] = [];
  const comparable: { name: string; image: ParsedImageRef }[] = [];
  for (const target of targets) {
    const image = comparableImage(target);
    if (image !== null) comparable.push({ name: target.name, image });
    else if (target.reading.status === "missing") excluded.push({ target: target.name, reason: "missing" });
    else excluded.push({ target: target.name, reason: `no single container image (${target.reading.image?.kind ?? "none"})` });
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
  const groups = new Map<string, string[]>();
  for (const entry of comparable) {
    const key = basis === "digest" ? (entry.image.digest as string) : referenceKey(entry.image);
    groups.set(key, [...(groups.get(key) ?? []), entry.name]);
  }
  const list = [...groups.entries()].map(([key, names]) => ({ key, targets: names }));
  if (list.length === 1) {
    return { status: "consistent", basis, groups: list, excluded, detail: `all ${comparable.length} targets run the same ${basis === "digest" ? "digest" : "reference"}` };
  }
  const named = list.map((group) => `${group.targets.join(", ")} (${group.key})`).join(" vs ");
  return { status: "inconsistent", basis, groups: list, excluded, detail: `targets differ by ${basis}: ${named}` };
}

// ---------------------------------------------------------------------------
// Cross-stage comparison (spec requirement 52)

/**
 * - `same-build` / `different-build`: both sides carry a `sha256` digest (proof either way);
 * - `same-reference` / `different-reference`: compared by registry + repository + tag only,
 *   which proves NOTHING about the build (a retag keeps the build, a reused tag may not);
 * - `not-comparable`: a side has no single container image.
 */
export type ImageComparisonResult = "same-build" | "different-build" | "same-reference" | "different-reference" | "not-comparable";

/** One comparison between an upstream and a downstream group of targets. */
export interface ImageComparison {
  readonly upstreamTargets: readonly string[];
  readonly downstreamTargets: readonly string[];
  readonly result: ImageComparisonResult;
}

/** Cross-stage comparison of one neighbouring pair. */
export interface CrossStageComparison {
  readonly upstream: string;
  readonly downstream: string;
  /** Summary over every comparison (see {@link summariseComparisons}). */
  readonly result: ImageComparisonResult;
  /** True only when equal digests prove the same build on every comparison. */
  readonly proven: boolean;
  readonly comparisons: readonly ImageComparison[];
}

/** Input side of {@link compareStages}. */
export interface StageTargets {
  readonly stage: string;
  readonly targets: readonly ObservedTarget[];
}

function comparisonOf(a: ParsedImageRef, b: ParsedImageRef): ImageComparisonResult {
  const verdict = sameBuild(a as ImageInfo, b as ImageInfo);
  const byDigest = isComparableDigest(a.digest) && isComparableDigest(b.digest);
  if (byDigest) return verdict === "proven" ? "same-build" : "different-build";
  return verdict === "different" ? "different-reference" : "same-reference";
}

/** Groups a stage's comparable targets by what they run (digest, else reference). */
function imageGroups(targets: readonly ObservedTarget[]): { image: ParsedImageRef; names: string[] }[] {
  const groups = new Map<string, { image: ParsedImageRef; names: string[] }>();
  for (const target of targets) {
    const image = comparableImage(target);
    if (image === null) continue;
    const key = image.digest !== null && isComparableDigest(image.digest) ? image.digest : referenceKey(image);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { image, names: [target.name] });
    else group.names.push(target.name);
  }
  return [...groups.values()];
}

/**
 * The pair summary: `different-build` if any comparison proves a different build; `same-build`
 * only when every comparison proves the same build; otherwise `different-reference` if any
 * reference differs, `same-reference` if all references match, `not-comparable` when nothing
 * could be compared.
 */
export function summariseComparisons(results: readonly ImageComparisonResult[]): ImageComparisonResult {
  if (results.length === 0) return "not-comparable";
  if (results.includes("different-build")) return "different-build";
  if (results.every((result) => result === "same-build")) return "same-build";
  if (results.includes("different-reference")) return "different-reference";
  if (results.every((result) => result === "same-build" || result === "same-reference")) return "same-reference";
  return "not-comparable";
}

/** Compares what two stages run (spec requirement 52). */
export function compareStages(upstream: StageTargets, downstream: StageTargets): CrossStageComparison {
  const comparisons: ImageComparison[] = [];
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

// ---------------------------------------------------------------------------
// Promotion deltas (spec requirement 53)

/** One link of the chain `local HEAD → stage 1 → …`. */
export interface ChainLink {
  /** {@link LOCAL_LINK} or a stage name. */
  readonly name: string;
  /** Distinct resolved commits, each with the targets running it (empty targets for local). */
  readonly commits: readonly { readonly sha: string; readonly targets: readonly string[] }[];
  /** Targets whose commit did not resolve (or local HEAD that could not be read), with why. */
  readonly unresolved: readonly { readonly targets: readonly string[]; readonly reason: string }[];
  /** True when the stage is internally inconsistent (by image or by commit). */
  readonly inconsistent: boolean;
}

/** The link for the clone's HEAD. */
export function localLink(head: CommitSummary | { error: string }): ChainLink {
  if ("error" in head) return { name: LOCAL_LINK, commits: [], unresolved: [{ targets: [], reason: `local HEAD unavailable: ${head.error}` }], inconsistent: false };
  return { name: LOCAL_LINK, commits: [{ sha: head.sha, targets: [] }], unresolved: [], inconsistent: false };
}

/** The link for one deployed stage, from its observed targets and their consistency. */
export function stageLink(stage: string, targets: readonly ObservedTarget[], consistency: StageConsistency): ChainLink {
  const bySha = new Map<string, string[]>();
  const unresolved: { targets: string[]; reason: string }[] = [];
  for (const target of targets) {
    const commit = target.commit;
    if (commit !== null && commit.status === "resolved") bySha.set(commit.sha, [...(bySha.get(commit.sha) ?? []), target.name]);
    else if (target.reading.status === "missing") unresolved.push({ targets: [target.name], reason: "target missing" });
    else if (commit === null) unresolved.push({ targets: [target.name], reason: "no image tag to resolve" });
    else unresolved.push({ targets: [target.name], reason: `${commit.status}: ${commit.detail}` });
  }
  const commits = [...bySha.entries()].map(([sha, names]) => ({ sha, targets: names }));
  return { name: stage, commits, unresolved, inconsistent: consistency.status === "inconsistent" || commits.length > 1 };
}

/** One computed delta between one upstream commit and one downstream commit. */
export interface DeltaEntry {
  readonly upstreamCommit: string | null;
  readonly downstreamCommit: string | null;
  readonly upstreamTargets: readonly string[];
  readonly downstreamTargets: readonly string[];
  readonly verdict: DeltaVerdict;
  /** `behind`: commits the downstream lacks; `ahead`: commits it has beyond upstream. */
  readonly count: number | null;
  /** `downstream..upstream`, newest first: what a promotion would bring. */
  readonly pending: readonly CommitSummary[];
  /** `upstream..downstream`, newest first: what the downstream has that upstream lacks. */
  readonly extra: readonly CommitSummary[];
  /** Why the verdict is `unknown`. */
  readonly reason: string | null;
}

/** The delta of one neighbouring pair. */
export interface StageDelta {
  readonly upstream: string;
  readonly downstream: string;
  /** True when either side is internally inconsistent: one entry per distinct commit, no single verdict. */
  readonly inconsistentStage: boolean;
  /** Which side(s) are inconsistent. */
  readonly inconsistentSides: readonly ("upstream" | "downstream")[];
  /** The single verdict, or `null` when the pair is an inconsistent stage. */
  readonly verdict: DeltaVerdict | null;
  readonly entries: readonly DeltaEntry[];
}

function unknownEntry(up: ChainLink["commits"][number] | null, down: ChainLink["commits"][number] | null, reason: string): DeltaEntry {
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

function firstReason(link: ChainLink): string {
  const first = link.unresolved[0];
  if (first === undefined) return `${link.name}: no resolved commit`;
  return link.name === LOCAL_LINK ? first.reason : `${link.name}: ${first.targets.join(", ")} ${first.reason}`;
}

/**
 * Deltas for each neighbouring pair of `links` (already in lifecycle order, local first).
 * Read-only git through {@link compareCommits}; never fetches ("local" = HEAD as of the last fetch).
 */
export function computeDeltas(clone: string | null, links: readonly ChainLink[], timeoutMs: number): StageDelta[] {
  const deltas: StageDelta[] = [];
  for (let index = 1; index < links.length; index++) {
    const up = links[index - 1] as ChainLink;
    const down = links[index] as ChainLink;
    const entries: DeltaEntry[] = [];
    if (up.commits.length === 0 && down.commits.length === 0) entries.push(unknownEntry(null, null, `${firstReason(up)}; ${firstReason(down)}`));
    else if (up.commits.length === 0) for (const d of down.commits) entries.push(unknownEntry(null, d, firstReason(up)));
    else if (down.commits.length === 0) for (const u of up.commits) entries.push(unknownEntry(u, null, firstReason(down)));
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
    const sides: ("upstream" | "downstream")[] = [];
    if (up.inconsistent) sides.push("upstream");
    if (down.inconsistent) sides.push("downstream");
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

// ---------------------------------------------------------------------------
// Drift (spec requirement 47)

/** One condition the drift gate trips on. */
export interface DriftFinding {
  /** `pipeline-target` is filled by the pipeline phase (not produced in this engine build). */
  readonly kind: "within-stage" | "cross-stage-delta" | "pipeline-target";
  readonly component: string;
  /** The stage (within-stage) or `upstream:downstream` (cross-stage). */
  readonly where: string;
  readonly detail: string;
}

/** A `--fail-on-drift` stage pair (`upstream:downstream`; `local` names the clone's HEAD). */
export interface DriftPair {
  readonly upstream: string;
  readonly downstream: string;
}

/**
 * Drift findings for one component: every internally inconsistent stage (always), and every
 * named pair whose delta is not `equal` (only pairs named on `--fail-on-drift`; an inconsistent
 * pair has no single verdict and counts as not equal).
 */
export function driftFindings(
  component: string,
  consistency: readonly { readonly stage: string; readonly consistency: StageConsistency; readonly link: ChainLink }[],
  deltas: readonly StageDelta[],
  pairs: readonly DriftPair[],
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const entry of consistency) {
    if (entry.consistency.status === "inconsistent") {
      findings.push({ kind: "within-stage", component, where: entry.stage, detail: entry.consistency.detail });
    } else if (entry.link.commits.length > 1) {
      const named = entry.link.commits.map((commit) => `${commit.targets.join(", ")} (${commit.sha.slice(0, 7)})`).join(" vs ");
      findings.push({ kind: "within-stage", component, where: entry.stage, detail: `targets run different commits: ${named}` });
    }
  }
  for (const pair of pairs) {
    const delta = deltas.find((candidate) => candidate.upstream === pair.upstream && candidate.downstream === pair.downstream);
    if (delta === undefined) continue;
    if (delta.verdict === "equal") continue;
    const verdict = delta.verdict === null ? "inconsistent stage (no single verdict)" : describeVerdict(delta.entries[0] as DeltaEntry);
    findings.push({ kind: "cross-stage-delta", component, where: `${pair.upstream}:${pair.downstream}`, detail: verdict });
  }
  return findings;
}

/** `equal`, `behind 3`, `ahead 1`, `diverged (2 pending, 1 extra)`, `unknown (<reason>)`. */
export function describeVerdict(entry: DeltaEntry): string {
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
