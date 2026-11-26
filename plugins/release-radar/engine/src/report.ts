/**
 * The `status` report: its `--json` contract, the human rendering, the fleet table and the
 * trailer line (spec requirements 22, 46, 51-55; plan decision D13).
 *
 * ## `--json` contract — `schemaVersion: 1` (additive)
 *
 * Within schemaVersion 1 fields are only ever ADDED; none is renamed, retyped or removed, and
 * enumerations only gain values. A consumer must ignore fields and enum values it does not know.
 * A breaking change bumps `schemaVersion`. The document is printed as ONE JSON value on stdout
 * (the trailer then goes to stderr so stdout stays parseable). Top level, in order:
 *
 * ```
 * schemaVersion   1
 * engineVersion   engine/VERSION
 * command         "status"
 * generatedAt     ISO-8601 UTC
 * workspace       { root, file, operatorTeam|null }
 * scope           { all, components[], stages[] }          the selection, lifecycle order
 * stages[]        { name, tagConvention, promotion }       promotion = Triggerability (lifecycle.ts)
 * components[]    ComponentReport (below), members sorted by name
 * unavailable[]   { name, reason: "no-local-clone"|"no-component-config", detail }
 * fleet           FleetRow[] with --all, else null
 * preflight[]     { adapter, commands[], identity|null }   every read-only preflight call issued
 * pipelines       PipelinesSection (below)
 * verification    VerificationSection (below; added fields since the first build are additive)
 * drift           { gate: { enabled, pairs[] "up:down" }, findings[] DriftFinding, tripped }
 * missing[]       { component, stage, target, detail }    declared targets the source lacks (23)
 * outcome         { exitCode, result: "OK"|"FAIL", phase }
 * snapshot        { file, fingerprint } when a snapshot was written, else null
 * ```
 *
 * ComponentReport: `{ name, repoKey, repoSubdir, clone, componentFile, configRevision
 * ("working-tree"), local: CommitHead, stages[] ComponentStage, crossStage[]
 * CrossStageComparison, deltas[] StageDelta }`.
 * ComponentStage: `{ name, status: "deployed"|"not-deployed", tagConvention: { type, source:
 * "stage"|"override" }, promotion, targets[] TargetReport, consistency: StageConsistency|null }`.
 * TargetReport: `{ name, adapter, status: "found"|"missing", state, image: ImageReport|null,
 * digest: { value, status }, lastModified: { value, source, bound: "upper" }|null, commit:
 * CommitReport, mixed, rollout, pipelineMapped, details, notes[] }`.
 * CommitReport: `{ status: "resolved", sha, shortSha, date, subject, headRelation: { relation:
 * "at-head"|"behind"|"not-ancestor", commits? } }` or `{ status: "no-clone"|"tag-not-found"|
 * "digest-pinned"|"no-convention"|"git-error"|"not-applicable", detail }`.
 * The shapes of StageConsistency, CrossStageComparison, StageDelta, DriftFinding and
 * Triggerability are the exported interfaces of `lifecycle.ts`.
 *
 * VerificationSection (spec requirements 40-45; the same shape in the `verify` report):
 * `{ status, requested, detail, outcome, exitCode, summary, blocks[], results[] }`.
 * - `status`: "not-requested" (no `--verify`) | "ran". (Engine builds before Phase 5 emitted
 *   "not-implemented"; consumers must still accept it.)
 * - `outcome`: "PASS" | "FAIL" | "INCONCLUSIVE" | "NO-CHECKS" (nothing ran: no block, or only
 *   smoke checks on stages not owned) | null (not requested). `exitCode`: 0 | 28 | 30 | null.
 * - `summary`: `{ pass, fail, unreachable, inconclusive, notRun }` | null.
 * - `blocks[]`: `{ component, stage, status: "configured"|"not-configured"|"not-deployed",
 *   detail, smoke: "run"|"not-run-stage-not-owned"|null, selected }` — one per component/stage in
 *   scope; "not-configured" carries the detail "no real-world verification configured".
 * - `results[]`: CheckResult `{ component, stage, name, type: "http"|"version"|"smoke",
 *   target|null, outcome: "PASS"|"FAIL"|"UNREACHABLE"|"INCONCLUSIVE"|"NOT-RUN", httpStatus|null,
 *   exitCode|null, latencyMs|null, extracted|null, expected: { value, source: "expect"|"status" }
 *   |null, reason }`. Never a response body, a header value, a URL or command output.
 * FleetRow.verification: "PASS" | "FAIL" | "INCONCLUSIVE" | "NO-CHECKS" | "not configured" when
 * verification ran, else null.
 *
 * PipelinesSection (spec requirements 16-18, 48, 49; plan Phase 6):
 * `{ status, detail, pat, runs[], drift[], missing[], requests }`.
 * - `status`: "read" (pipeline-mapped targets in scope; facts read) | "not-configured" (no mapping
 *   in scope) | "omitted" (`--no-pipelines`). (Engine builds before Phase 6 emitted
 *   "not-implemented"; consumers must still accept it.)
 * - `pat`: `{ declared, expires|null, daysRemaining|null, warning, detail }` when the PAT was
 *   read, else null. Never the token.
 * - `runs[]`: one entry per pipeline-mapped target: `{ component, stage, target, pipeline:
 *   { project, id|null, name|null, folder|null, link|null, status: "found"|"missing", detail },
 *   runHistoryCount, runs[] RunFact }` (newest first; at most `runHistoryCount`).
 * - RunFact: `{ id, buildNumber|null, status, result|null, terminal, succeeded, queueTime|null,
 *   startTime|null, finishTime|null, sourceRef|null, sourceCommit: { status: "determined", sha,
 *   shortSha } | { status: "undetermined", detail }, action: { status: "determined"|"undetermined",
 *   name|null, kind: "build"|"configuration"|null, detail }, pushedTag: { status: "parameter"|
 *   "convention"|"not-applicable"|"undetermined", value|null, detail }, parameters|null (the
 *   mapping's declared parameter names only), reason|null, link|null }` — `pipelines/facts.ts`.
 * - `drift[]`: one PipelineDriftEntry per mapped target: `{ component, stage, target, status:
 *   "drift"|"in-sync"|"no-succeeded-build"|"unknown"|"pipeline-missing", build: { runId,
 *   commit|null }|null, targetCommit|null, relation: "behind"|"ahead"|"diverged"|"unknown"|null,
 *   count|null, detail }`. Every `drift` entry is also a DriftFinding of kind "pipeline-target"
 *   (where = "<stage>/<target>"), so it feeds the drift gate (exit 22).
 * - `missing[]`: `{ component, stage, target, project, pipeline, detail }` — declared pipelines
 *   that do not exist (exit 23; the report is still complete).
 * - `requests`: `{ method: "GET", count }` — every Azure DevOps request of the run (all GET).
 * FleetRow.latestPipelineResult: "<stage>/<target> #<id> <result>" per mapped target (`; `-joined),
 * "no runs", or null when pipelines were not read. FleetRow.pipelineDrift: "none" or
 * "<stage>/<target>: <relation>" entries, or null when pipelines were not read.
 *
 * Colour: ANSI only in human output, only when stdout is a TTY and `NO_COLOR` is unset; never in
 * `--json`.
 */

import type { AdapterName } from "./config.js";
import type { DigestStatus, ReadingDetails, RolloutState, TargetReading } from "./adapters/types.js";
import type { CommitResolution } from "./git.js";
import type { ImageInfo } from "./image.js";
import type { PipelineIdentity } from "./pipelines/collect.js";
import { runOutcomeWord, type PipelineDriftEntry, type RunFact } from "./pipelines/facts.js";
import type { PatExpiry } from "./pipelines/pat.js";
import { overallOutcome, summarize, summaryText, verificationExitCode, type CheckResult, type VerificationBlockReport, type VerificationSummary } from "./verify.js";
import {
  describeVerdict,
  type CrossStageComparison,
  type DriftFinding,
  type StageConsistency,
  type StageDelta,
  type Triggerability,
} from "./lifecycle.js";

/** The `schemaVersion` of the `--json` report. */
export const REPORT_SCHEMA_VERSION = 1;

/** The trailer variable name (plan decision D13). */
export const TRAILER_NAME = "RELEASE_RADAR_RESULT";

// ---------------------------------------------------------------------------
// Contract types

/** An image as reported (`raw` is printed, never the normalised form). */
export type ImageReport =
  | {
      readonly kind: "image";
      readonly raw: string;
      readonly registry: string;
      readonly repository: string;
      readonly tag: string | null;
      readonly implicitTag: boolean;
      readonly digest: string | null;
      /** True for an explicit or implicit `latest` without a digest: it can change silently. */
      readonly mutableTag: boolean;
    }
  | { readonly kind: "multi-container" | "sidecar" | "non-container"; readonly raw: string }
  | { readonly kind: "invalid"; readonly raw: string; readonly reason: string };

/** A deployed commit as reported (spec requirement 46). */
export type CommitReport =
  | {
      readonly status: "resolved";
      readonly sha: string;
      readonly shortSha: string;
      readonly date: string;
      readonly subject: string;
      readonly headRelation: { readonly relation: "at-head" | "behind" | "not-ancestor"; readonly commits?: number };
    }
  | {
      readonly status: "no-clone" | "tag-not-found" | "digest-pinned" | "no-convention" | "git-error" | "not-applicable";
      readonly detail: string;
    };

/** The clone's HEAD. */
export type CommitHead =
  | { readonly status: "resolved"; readonly sha: string; readonly shortSha: string; readonly date: string; readonly subject: string }
  | { readonly status: "error"; readonly detail: string };

/** One target in one stage. */
export interface TargetReport {
  readonly name: string;
  readonly adapter: AdapterName;
  readonly status: "found" | "missing";
  readonly state: string | null;
  readonly image: ImageReport | null;
  readonly digest: { readonly value: string | null; readonly status: DigestStatus };
  /** The source's last-change field: an UPPER BOUND on the deploy time, never the deploy time. */
  readonly lastModified: { readonly value: string; readonly source: string | null; readonly bound: "upper" } | null;
  readonly commit: CommitReport;
  readonly mixed: boolean;
  readonly rollout: RolloutState | null;
  /** True when the target declares a pipeline mapping. */
  readonly pipelineMapped: boolean;
  readonly details: ReadingDetails;
  readonly notes: readonly string[];
}

/** One stage of one component. */
export interface ComponentStage {
  readonly name: string;
  /** `not-deployed`: the component declares `null` for this stage (by design). */
  readonly status: "deployed" | "not-deployed";
  readonly tagConvention: { readonly type: string; readonly source: "stage" | "override" };
  readonly promotion: Triggerability;
  readonly targets: readonly TargetReport[];
  readonly consistency: StageConsistency | null;
}

/** One available component. */
export interface ComponentReport {
  readonly name: string;
  readonly repoKey: string | null;
  readonly repoSubdir: string | null;
  readonly clone: string;
  readonly componentFile: string;
  readonly configRevision: "working-tree";
  readonly local: CommitHead;
  readonly stages: readonly ComponentStage[];
  readonly crossStage: readonly CrossStageComparison[];
  readonly deltas: readonly StageDelta[];
}

/** A member that could not be loaded (spec requirements 31c, 54). */
export interface UnavailableEntry {
  readonly name: string;
  readonly reason: "no-local-clone" | "no-component-config";
  readonly detail: string;
}

/** One stage cell of a fleet row. */
export interface FleetCell {
  readonly stage: string;
  /** Short commit, else tag, else a word (`not deployed`, `missing`, `mixed`, `n/a`). */
  readonly summary: string;
  readonly consistent: boolean | null;
}

/** One fleet-table row (spec requirement 54). */
export interface FleetRow {
  readonly component: string;
  readonly status: "available" | "unavailable";
  readonly unavailableReason: UnavailableEntry["reason"] | null;
  readonly cells: readonly FleetCell[];
  /** False when any stage is internally inconsistent; `null` when nothing was compared. */
  readonly consistent: boolean | null;
  /** Per neighbouring pair: `count` commits pending (`null` when not a single `behind`/`equal` verdict). */
  readonly pending: readonly { readonly pair: string; readonly verdict: string; readonly count: number | null }[];
  /** `stage/target: missing` or `stage/target: <state>` for every non-running or missing target. */
  readonly attention: readonly string[];
  /** The newest run per mapped target (`<stage>/<target> #<id> <result>`), "no runs", or `null` when pipelines were not read. */
  readonly latestPipelineResult: string | null;
  /** "none", or the pipeline/target drift entries; `null` when pipelines were not read. */
  readonly pipelineDrift: string | null;
  /** Filled by the verification phase; `null` when verification did not run. */
  readonly verification: string | null;
}

/** The run facts of one pipeline-mapped target. */
export interface PipelineTargetRuns {
  readonly component: string;
  readonly stage: string;
  readonly target: string;
  readonly pipeline: PipelineIdentity;
  readonly runHistoryCount: number;
  /** Newest first. */
  readonly runs: readonly RunFact[];
}

/** A declared pipeline that does not exist (exit 23). */
export interface MissingPipeline {
  readonly component: string;
  readonly stage: string;
  readonly target: string;
  readonly project: string;
  readonly pipeline: string;
  readonly detail: string;
}

/** The pipelines section (see the module comment for the contract). */
export interface PipelinesSection {
  readonly status: "read" | "not-configured" | "omitted" | "not-implemented";
  readonly detail: string;
  readonly pat: PatExpiry | null;
  readonly runs: readonly PipelineTargetRuns[];
  readonly drift: readonly PipelineDriftEntry[];
  readonly missing: readonly MissingPipeline[];
  readonly requests: { readonly method: "GET"; readonly count: number };
}

/** A section for a run that read no pipeline (`omitted` / `not-configured`). */
export function pipelinesNotRead(status: "omitted" | "not-configured", detail: string): PipelinesSection {
  return { status, detail, pat: null, runs: [], drift: [], missing: [], requests: { method: "GET", count: 0 } };
}

function pipelineCells(section: PipelinesSection | null, component: string): { latest: string | null; drift: string | null } {
  if (section === null || section.status !== "read") return { latest: null, drift: null };
  const entries = section.runs.filter((entry) => entry.component === component);
  if (entries.length === 0) return { latest: null, drift: null };
  const latest = entries
    .map((entry) => {
      const where = `${entry.stage}/${entry.target}`;
      if (entry.pipeline.status === "missing") return `${where} pipeline missing`;
      const newest = entry.runs[0];
      return newest === undefined ? `${where} no runs` : `${where} #${newest.id} ${runOutcomeWord(newest)}`;
    })
    .join("; ");
  const drifting = section.drift.filter((entry) => entry.component === component && entry.status === "drift");
  const drift = drifting.length === 0 ? "none" : drifting.map((entry) => `${entry.stage}/${entry.target}: ${entry.relation === "behind" ? `not landed (behind ${entry.count ?? "?"})` : entry.relation === "ahead" ? `target ahead ${entry.count ?? "?"}` : (entry.relation ?? "drift")}`).join("; ");
  return { latest, drift };
}

/** The verification section (see the module comment for the contract). */
export interface VerificationSection {
  readonly status: "not-requested" | "ran";
  readonly requested: boolean;
  readonly detail: string;
  readonly outcome: "PASS" | "FAIL" | "INCONCLUSIVE" | "NO-CHECKS" | null;
  readonly exitCode: number | null;
  readonly summary: VerificationSummary | null;
  readonly blocks: readonly VerificationBlockReport[];
  readonly results: readonly CheckResult[];
}

/** The section of a run without `--verify`. */
export function verificationNotRequested(): VerificationSection {
  return { status: "not-requested", requested: false, detail: "not requested (pass --verify)", outcome: null, exitCode: null, summary: null, blocks: [], results: [] };
}

/** The section of a run whose verification ran (`blocks` from the plan, `results` from the checks). */
export function verificationRan(blocks: readonly VerificationBlockReport[], results: readonly CheckResult[]): VerificationSection {
  const summary = summarize(results);
  const outcome = overallOutcome(results);
  const configured = blocks.filter((block) => block.status === "configured").length;
  const detail =
    configured === 0
      ? `${outcome} — no real-world verification configured for anything in scope`
      : `${outcome} — ${summaryText(summary)} (${configured} of ${blocks.length} component/stage pair(s) configured)`;
  return { status: "ran", requested: true, detail, outcome, exitCode: verificationExitCode(results), summary, blocks, results };
}

/** A component's fleet-table verification word, or null when verification did not run. */
export function componentVerification(section: VerificationSection | null, component: string): string | null {
  if (section === null || section.status !== "ran") return null;
  const blocks = section.blocks.filter((block) => block.component === component);
  if (!blocks.some((block) => block.status === "configured")) return "not configured";
  return overallOutcome(section.results.filter((entry) => entry.component === component));
}

/** The full `status` report (see the module comment for the contract). */
export interface StatusReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly engineVersion: string;
  readonly command: "status";
  readonly generatedAt: string;
  readonly workspace: { readonly root: string; readonly file: string; readonly operatorTeam: string | null };
  readonly scope: { readonly all: boolean; readonly components: readonly string[]; readonly stages: readonly string[] };
  readonly stages: readonly { readonly name: string; readonly tagConvention: string; readonly promotion: Triggerability }[];
  readonly components: readonly ComponentReport[];
  readonly unavailable: readonly UnavailableEntry[];
  readonly fleet: readonly FleetRow[] | null;
  readonly preflight: readonly { readonly adapter: AdapterName; readonly commands: readonly string[]; readonly identity: string | null }[];
  readonly pipelines: PipelinesSection;
  readonly verification: VerificationSection;
  readonly drift: { readonly gate: { readonly enabled: boolean; readonly pairs: readonly string[] }; readonly findings: readonly DriftFinding[]; readonly tripped: boolean };
  readonly missing: readonly { readonly component: string; readonly stage: string; readonly target: string; readonly detail: string }[];
  readonly outcome: { readonly exitCode: number; readonly result: "OK" | "FAIL"; readonly phase: string };
  readonly snapshot: { readonly file: string; readonly fingerprint: string } | null;
}

// ---------------------------------------------------------------------------
// Builders

/** True for an explicit or implicit `latest` without a digest. */
export function isMutableTag(image: ImageInfo): boolean {
  if (image.kind !== "image" || image.digest !== null) return false;
  return image.implicitTag || (image.tag ?? "").toLowerCase() === "latest";
}

/** The reported form of a parsed image. */
export function imageReport(image: ImageInfo): ImageReport {
  if (image.kind === "image") {
    return {
      kind: "image",
      raw: image.raw,
      registry: image.registry,
      repository: image.repository,
      tag: image.tag,
      implicitTag: image.implicitTag,
      digest: image.digest,
      mutableTag: isMutableTag(image),
    };
  }
  if (image.kind === "invalid") return { kind: "invalid", raw: image.raw, reason: image.reason };
  return { kind: image.kind, raw: image.raw };
}

/** The reported form of a commit resolution (`null` = nothing to resolve). */
export function commitReport(resolution: CommitResolution | null, why: string): CommitReport {
  if (resolution === null) return { status: "not-applicable", detail: why };
  if (resolution.status === "resolved") {
    const relation =
      resolution.headRelation.relation === "behind"
        ? { relation: "behind" as const, commits: resolution.headRelation.commits }
        : { relation: resolution.headRelation.relation };
    return { status: "resolved", sha: resolution.sha, shortSha: resolution.sha.slice(0, 7), date: resolution.date, subject: resolution.subject, headRelation: relation };
  }
  return { status: resolution.status, detail: resolution.detail };
}

/** The reported form of one reading plus its commit. */
export function targetReport(reading: TargetReading, commit: CommitResolution | null, pipelineMapped: boolean): TargetReport {
  const why = reading.status === "missing" ? "target missing" : "no single container image to resolve";
  return {
    name: reading.target,
    adapter: reading.adapter,
    status: reading.status,
    state: reading.state,
    image: reading.image === null ? null : imageReport(reading.image),
    digest: { value: reading.digest, status: reading.digestStatus },
    lastModified: reading.lastModified === null ? null : { value: reading.lastModified, source: reading.lastModifiedSource, bound: "upper" },
    commit: commitReport(commit, why),
    mixed: reading.mixed,
    rollout: reading.rollout,
    pipelineMapped,
    details: reading.details,
    notes: reading.notes,
  };
}

const RUNNING_STATES = new Set(["running", "available", "complete"]);

/** True when a found target's state reads as running (or states no state at all). */
export function isRunningState(state: string | null): boolean {
  return state === null || RUNNING_STATES.has(state.toLowerCase());
}

function cellFor(stage: ComponentStage): FleetCell {
  if (stage.status === "not-deployed") return { stage: stage.name, summary: "not deployed", consistent: null };
  const found = stage.targets.filter((target) => target.status === "found");
  if (found.length === 0) return { stage: stage.name, summary: "missing", consistent: null };
  const consistent = stage.consistency === null || stage.consistency.status !== "inconsistent";
  const commits = [...new Set(found.flatMap((target) => (target.commit.status === "resolved" ? [target.commit.shortSha] : [])))];
  const tags = [...new Set(found.flatMap((target) => (target.image?.kind === "image" && target.image.tag !== null ? [target.image.tag] : [])))];
  let summary: string;
  if (commits.length > 1 || (!consistent && commits.length !== 1)) summary = "mixed";
  else if (commits.length === 1) summary = commits[0] as string;
  else if (tags.length === 1) summary = tags[0] as string;
  else if (tags.length > 1) summary = "mixed";
  else summary = "n/a";
  return { stage: stage.name, summary, consistent: commits.length > 1 ? false : consistent };
}

/**
 * The fleet table (spec requirement 54): one row per member, unavailable members included.
 * `verification` (when it ran) fills each available row's verification word.
 */
export function fleetRows(
  components: readonly ComponentReport[],
  unavailable: readonly UnavailableEntry[],
  stages: readonly string[],
  verification: VerificationSection | null = null,
  pipelines: PipelinesSection | null = null,
): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const component of components) {
    const cells = component.stages.map(cellFor);
    const judged = cells.filter((cell) => cell.consistent !== null);
    const attention: string[] = [];
    for (const stage of component.stages) {
      for (const target of stage.targets) {
        if (target.status === "missing") attention.push(`${stage.name}/${target.name}: missing`);
        else if (!isRunningState(target.state)) attention.push(`${stage.name}/${target.name}: ${target.state ?? "unknown"}`);
      }
    }
    rows.push({
      component: component.name,
      status: "available",
      unavailableReason: null,
      cells,
      consistent: judged.length === 0 ? null : judged.every((cell) => cell.consistent === true),
      pending: component.deltas.map((delta) => {
        const only = delta.entries.length === 1 ? delta.entries[0] : undefined;
        const verdict = delta.verdict === null || only === undefined ? "inconsistent stage" : describeVerdict(only);
        const count = delta.verdict === "equal" ? 0 : delta.verdict === "behind" && only !== undefined ? only.count : null;
        return { pair: `${delta.upstream}:${delta.downstream}`, verdict, count };
      }),
      attention,
      latestPipelineResult: pipelineCells(pipelines, component.name).latest,
      pipelineDrift: pipelineCells(pipelines, component.name).drift,
      verification: componentVerification(verification, component.name),
    });
  }
  for (const entry of unavailable) {
    rows.push({
      component: entry.name,
      status: "unavailable",
      unavailableReason: entry.reason,
      cells: stages.map((stage) => ({ stage, summary: "n/a", consistent: null })),
      consistent: null,
      pending: [],
      attention: [],
      latestPipelineResult: null,
      pipelineDrift: null,
      verification: null,
    });
  }
  return rows.sort((a, b) => (a.component < b.component ? -1 : a.component > b.component ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Colour and layout helpers

/** ANSI styling; identity functions when colour is off. */
export interface Colours {
  readonly green: (text: string) => string;
  readonly red: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly bold: (text: string) => string;
}

/** Colour only for a human reader at a terminal: never in `--json`, never piped, never with `NO_COLOR`. */
export function useColour(json: boolean, stream: { readonly isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  return !json && stream.isTTY === true && env["NO_COLOR"] === undefined;
}

/** Builds the styling functions. */
export function colours(enabled: boolean): Colours {
  const wrap = (code: string) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return { green: wrap("32"), red: wrap("31"), yellow: wrap("33"), dim: wrap("2"), bold: wrap("1") };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function dateOnly(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toISOString().slice(0, 10);
}

function imageLabel(image: ImageReport | null): string {
  if (image === null) return "(no image)";
  switch (image.kind) {
    case "image": {
      const repo = image.raw.trim().replace(/^DOCKER\|/i, "");
      return image.mutableTag ? `${repo} ⚠ mutable tag` : repo;
    }
    case "invalid":
      return `(invalid reference ${JSON.stringify(image.raw)}: ${image.reason})`;
    case "non-container":
      return image.raw.trim() === "" ? "(not container-configured)" : `(not a container: ${image.raw})`;
    default:
      return `(${image.kind}: ${image.raw})`;
  }
}

function relationText(commit: Extract<CommitReport, { status: "resolved" }>): string {
  const relation = commit.headRelation;
  if (relation.relation === "at-head") return "= local HEAD";
  if (relation.relation === "behind") return `${relation.commits ?? 0} commit${relation.commits === 1 ? "" : "s"} behind local HEAD`;
  return "not an ancestor of local HEAD (diverged or not fetched)";
}

function commitLine(commit: CommitReport, c: Colours): string {
  switch (commit.status) {
    case "resolved": {
      const relation = relationText(commit);
      const coloured = commit.headRelation.relation === "at-head" ? c.green(relation) : c.yellow(relation);
      return `${c.dim(`└ commit ${commit.shortSha} ${dateOnly(commit.date)} "${truncate(commit.subject, 60)}"`)}  ${coloured}`;
    }
    case "tag-not-found":
      return c.dim(`└ tag not found in the local clone: ${commit.detail} (a \`git fetch --tags\` may help; release-radar never fetches)`);
    case "not-applicable":
      return c.dim(`└ ${commit.detail}`);
    default:
      return c.dim(`└ ${commit.status}: ${commit.detail}`);
  }
}

const DELTA_LIST_LIMIT = 10;

function comparisonText(result: CrossStageComparison["result"]): string {
  switch (result) {
    case "same-build":
      return "same build (equal digests — proof)";
    case "different-build":
      return "different builds (digests differ — proof)";
    case "same-reference":
      return "same reference (no digest on both sides — not proof of the same build)";
    case "different-reference":
      return "references differ (tags prove nothing either way; only equal digests prove the same build)";
    case "not-comparable":
      return "not comparable (no single container image on one side)";
  }
}

// ---------------------------------------------------------------------------
// Human rendering

/** Renders the human report as lines (no trailing trailer). */
export function renderHuman(report: StatusReport, c: Colours): string[] {
  const out: string[] = [];
  out.push(`release-radar status — workspace ${report.workspace.root} (read-only)`);
  out.push("");
  if (report.fleet !== null) out.push(...renderFleet(report.fleet, report.scope.stages, c), "");

  const nameWidth = Math.max(4, ...report.components.flatMap((component) => component.stages.flatMap((stage) => stage.targets.map((target) => target.name.length))));
  for (const component of report.components) {
    const head = component.local.status === "resolved" ? `local HEAD ${component.local.shortSha} ${dateOnly(component.local.date)} "${truncate(component.local.subject, 50)}"` : `local HEAD unavailable: ${component.local.detail}`;
    out.push(`── ${c.bold(component.name)}  ${c.dim(`(clone ${component.clone}; ${head})`)}`);
    for (const stage of component.stages) {
      const p = stage.promotion;
      const trig = p.triggerable ? c.green("triggerable") : c.dim(`not triggerable — ${p.reason}`);
      out.push(`   ${c.bold(stage.name)}  ${c.dim(`${p.mode} · owner ${p.owner ?? "(none)"} · tag convention ${stage.tagConvention.type}${stage.tagConvention.source === "override" ? " (component override)" : ""}`)} · ${trig}`);
      if (stage.status === "not-deployed") {
        out.push(`     ${c.dim("— not deployed (by design)")}`);
        continue;
      }
      for (const target of stage.targets) {
        const label = pad(target.name, nameWidth);
        if (target.status === "missing") {
          out.push(`     ${label}  ${c.red(`MISSING — ${target.notes[0] ?? "the source does not have this target"}`)}`);
          continue;
        }
        const state = target.state === null ? "" : isRunningState(target.state) ? c.green(target.state) : c.red(target.state.toUpperCase());
        const modified = target.lastModified === null ? c.dim("last modified: not exposed") : `last modified ≤ ${dateOnly(target.lastModified.value)} ${c.dim("(upper bound, not the deploy time)")}`;
        const digest = target.digest.status === "available" && target.digest.value !== null ? c.dim(` digest ${target.digest.value.slice(0, 19)}…`) : "";
        out.push(`     ${label}  ${imageLabel(target.image)}${digest}  ${state}  ${modified}`.replace(/ {3,}$/, ""));
        out.push(`     ${" ".repeat(nameWidth)}  ${commitLine(target.commit, c)}`);
        for (const note of target.notes) out.push(`     ${" ".repeat(nameWidth)}  ${c.yellow(`! ${note}`)}`);
      }
      const consistency = stage.consistency;
      if (consistency !== null && consistency.status !== "single-target") {
        const text = `consistency: ${consistency.status}${consistency.basis === null ? "" : ` (by ${consistency.basis})`} — ${consistency.detail}`;
        out.push(`     ${consistency.status === "inconsistent" ? c.red(text) : c.dim(text)}`);
      }
    }
    for (const comparison of component.crossStage) {
      out.push(`   ${comparison.upstream} → ${comparison.downstream}: ${comparisonText(comparison.result)}`);
    }
    if (component.deltas.length > 0) out.push(`   deltas ${c.dim("(local = clone HEAD as of its last fetch; nothing is fetched)")}`);
    for (const delta of component.deltas) {
      const flag = delta.inconsistentStage ? c.red(` [inconsistent stage: ${delta.inconsistentSides.join(" and ")} — one delta per distinct commit, no single verdict]`) : "";
      out.push(`     ${delta.upstream} → ${delta.downstream}${flag}`);
      for (const entry of delta.entries) {
        const side = (sha: string | null, targets: readonly string[]) => `${sha?.slice(0, 7) ?? "?"}${targets.length > 0 ? c.dim(` (${targets.join(", ")})`) : ""}`;
        const verdict = describeVerdict(entry);
        out.push(`       ${side(entry.upstreamCommit, entry.upstreamTargets)} → ${side(entry.downstreamCommit, entry.downstreamTargets)}: ${entry.verdict === "equal" ? c.green(verdict) : c.yellow(verdict)}`);
        const shown = entry.pending.slice(0, DELTA_LIST_LIMIT);
        for (const commit of shown) out.push(`         + ${commit.sha.slice(0, 7)} ${truncate(commit.subject, 70)}`);
        if (entry.pending.length > shown.length) out.push(c.dim(`         … ${entry.pending.length - shown.length} more pending`));
        const extra = entry.extra.slice(0, DELTA_LIST_LIMIT);
        for (const commit of extra) out.push(`         - ${commit.sha.slice(0, 7)} ${truncate(commit.subject, 70)} ${c.dim("(only downstream)")}`);
        if (entry.extra.length > extra.length) out.push(c.dim(`         … ${entry.extra.length - extra.length} more only downstream`));
      }
    }
    out.push("");
  }

  for (const entry of report.unavailable) {
    out.push(`── ${c.bold(entry.name)}  ${c.yellow(`unavailable (${entry.reason === "no-local-clone" ? "no local clone" : "no component config"})`)} ${c.dim(entry.detail)}`);
  }
  if (report.unavailable.length > 0) out.push("");

  out.push(...renderPipelines(report.pipelines, c));
  out.push(...renderVerification(report.verification, c));
  if (report.drift.findings.length > 0) {
    out.push(`  drift${report.drift.gate.enabled ? "" : " (informational; --fail-on-drift gates on it)"}:`);
    for (const finding of report.drift.findings) out.push(`    ${finding.component} ${finding.where}: ${finding.detail}`);
  }
  if (report.missing.length > 0) {
    out.push("  declared but NOT FOUND at the source:");
    for (const entry of report.missing) out.push(`    ${entry.component} / ${entry.stage} / ${entry.target}: ${entry.detail}`);
    out.push("    Run `discover` to list the targets that actually exist.");
  }
  for (const preflight of report.preflight) {
    out.push(c.dim(`  preflight ${preflight.adapter}: ${preflight.commands.join("; ") || "(no command)"}${preflight.identity === null ? "" : ` — signed in as ${preflight.identity} (cached; the first read proves validity)`}`));
  }
  out.push(c.dim("  read-only: deployment sources were only listed/shown and the local clones only inspected; nothing was changed."));

  const targets = report.components.flatMap((component) => component.stages.flatMap((stage) => stage.targets));
  const notDeployed = report.components.reduce((sum, component) => sum + component.stages.filter((stage) => stage.status === "not-deployed").length, 0);
  const stopped = targets.filter((target) => target.status === "found" && !isRunningState(target.state)).length;
  out.push(
    `  summary: ${report.components.length} component(s) · ${targets.filter((target) => target.status === "found").length} target(s) found · ${stopped} not running · ${report.missing.length} missing · ${notDeployed} stage(s) not deployed · ${report.unavailable.length} unavailable · ${report.drift.findings.length} drift finding(s)`,
  );
  if (report.snapshot !== null) out.push(c.dim(`  snapshot: ${report.snapshot.file}`));
  return out;
}

function runColour(run: RunFact, c: Colours): string {
  const word = runOutcomeWord(run);
  if (!run.terminal) return c.yellow(word);
  return run.succeeded ? c.green(word) : c.red(word);
}

/** One human line for a run (id, outcome, action, ref @ commit, pushed tag, queue time, link). */
export function runLine(run: RunFact, c: Colours): string {
  const action = run.action.status === "determined" ? `${run.action.name} (${run.action.kind})` : "action undetermined";
  const commit = run.sourceCommit.status === "determined" ? run.sourceCommit.shortSha : "commit undetermined";
  const ref = run.sourceRef === null ? "" : `${run.sourceRef.replace(/^refs\/heads\//, "")} @ `;
  const tag =
    run.pushedTag.status === "parameter" || run.pushedTag.status === "convention"
      ? `tag ${run.pushedTag.value ?? ""} (${run.pushedTag.status})`
      : run.pushedTag.status === "not-applicable"
        ? "no image pushed"
        : "tag undetermined";
  const queued = run.queueTime === null ? "" : ` · queued ${run.queueTime}`;
  return `#${run.id} ${runColour(run, c)} · ${action} · ${ref}${commit} · ${tag}${c.dim(`${queued}${run.link === null ? "" : ` · ${run.link}`}`)}`;
}

/**
 * Renders the pipelines section: the summary, the PAT expiry line, per mapped target the
 * pipeline and its runs, missing pipelines and the pipeline/target drift entries.
 */
export function renderPipelines(section: PipelinesSection, c: Colours): string[] {
  const out = [`  pipelines: ${section.detail}`];
  if (section.pat !== null) out.push(`    ${section.pat.warning ? c.yellow(`⚠ ${section.pat.detail}`) : c.dim(section.pat.detail)}`);
  for (const entry of section.runs) {
    const head = `${entry.component} / ${entry.stage} / ${entry.target} → ${entry.pipeline.status === "found" ? `pipeline ${entry.pipeline.id ?? ""} "${entry.pipeline.name ?? ""}"` : c.red(`MISSING — ${entry.pipeline.detail}`)} ${c.dim(`(project ${entry.pipeline.project})`)}`;
    out.push(`    ${head}`);
    if (entry.pipeline.status === "found" && entry.runs.length === 0) out.push(`      ${c.dim("no runs")}`);
    for (const run of entry.runs) out.push(`      ${runLine(run, c)}`);
  }
  for (const entry of section.drift) {
    if (entry.status === "drift") out.push(`    ${c.red(`pipeline/target drift ${entry.component} ${entry.stage}/${entry.target}`)}: ${entry.detail}`);
    else if (entry.status !== "pipeline-missing") out.push(c.dim(`    ${entry.component} ${entry.stage}/${entry.target}: ${entry.status} — ${entry.detail}`));
  }
  if (section.status === "read") out.push(c.dim(`    ${section.requests.count} Azure DevOps request(s), all GET; nothing was queued, approved or changed.`));
  return out;
}

function outcomeColour(outcome: string, c: Colours): string {
  if (outcome === "PASS") return c.green(outcome);
  if (outcome === "FAIL") return c.red(outcome);
  if (outcome === "NOT-RUN" || outcome === "NO-CHECKS") return c.dim(outcome);
  return c.yellow(outcome);
}

/**
 * Renders the verification section: the summary line, then per component/stage either
 * "no real-world verification configured" or one line per check (outcome, name, type, target,
 * status/exit code, latency, extracted/expected version, reason). Never a body, header value or
 * command output — the section holds none.
 */
export function renderVerification(section: VerificationSection, c: Colours): string[] {
  const out = [`  verification: ${section.detail}`];
  if (section.status !== "ran") return out;
  const width = Math.max(4, ...section.results.map((entry) => entry.outcome.length));
  for (const block of section.blocks) {
    const smoke = block.smoke === "not-run-stage-not-owned" ? c.dim(" (smoke checks not run: stage not owned)") : "";
    out.push(`    ${c.bold(block.component)} / ${block.stage}: ${c.dim(block.detail)}${smoke}`);
    for (const entry of section.results.filter((r) => r.component === block.component && r.stage === block.stage)) {
      const facts: string[] = [`${entry.type}${entry.target === null ? "" : `, target ${entry.target}`}`];
      if (entry.httpStatus !== null) facts.push(`HTTP ${entry.httpStatus}`);
      if (entry.exitCode !== null) facts.push(`exit ${entry.exitCode}`);
      if (entry.latencyMs !== null) facts.push(`${entry.latencyMs} ms`);
      if (entry.extracted !== null) facts.push(`reports ${entry.extracted}`);
      if (entry.expected !== null) facts.push(`expected ${entry.expected.value} (${entry.expected.source === "expect" ? "--expect" : "status"})`);
      out.push(`      ${outcomeColour(pad(entry.outcome, width), c)}  ${entry.name}  ${c.dim(`[${facts.join(" · ")}]`)} ${entry.reason}`);
    }
  }
  out.push(c.dim("    only GET/HEAD requests were sent; bodies, header values and command output are never recorded."));
  return out;
}

/** Renders the fleet table (spec requirement 54); a verification column appears when verification ran. */
export function renderFleet(rows: readonly FleetRow[], stages: readonly string[], c: Colours): string[] {
  const withVerification = rows.some((row) => row.verification !== null);
  const withPipelines = rows.some((row) => row.latestPipelineResult !== null);
  const header = ["component", ...stages, "consistent", "pending", "attention", ...(withPipelines ? ["pipeline", "pipeline drift"] : []), ...(withVerification ? ["verification"] : [])];
  const body = rows.map((row) => {
    if (row.status === "unavailable") {
      return [row.component, ...stages.map(() => "—"), "—", "—", `unavailable (${row.unavailableReason === "no-local-clone" ? "no local clone" : "no component config"})`, ...(withPipelines ? ["—", "—"] : []), ...(withVerification ? ["—"] : [])];
    }
    const pending = row.pending.map((entry) => `${entry.pair} ${entry.count === null ? entry.verdict : entry.count}`).join(" · ");
    return [
      row.component,
      ...row.cells.map((cell) => cell.summary),
      row.consistent === null ? "—" : row.consistent ? "yes" : "NO",
      pending === "" ? "—" : pending,
      row.attention.length === 0 ? "—" : row.attention.join(", "),
      ...(withPipelines ? [row.latestPipelineResult ?? "—", row.pipelineDrift ?? "—"] : []),
      ...(withVerification ? [row.verification ?? "—"] : []),
    ];
  });
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((cells) => (cells[column] ?? "").length)));
  const line = (cells: readonly string[]) => cells.map((cell, column) => pad(cell, widths[column] ?? 0)).join("  ").trimEnd();
  return [c.bold("fleet"), c.dim(line(header)), ...body.map((cells) => line(cells))];
}

// ---------------------------------------------------------------------------
// Trailer

/**
 * The trailer line printed on EVERY run (spec requirement 22, plan decision D13):
 * `RELEASE_RADAR_RESULT=<OK|FAIL> PHASE=<phase> EXIT=<code>`.
 */
export function trailerLine(exitCode: number, phase: string): string {
  return `${TRAILER_NAME}=${exitCode === 0 ? "OK" : "FAIL"} PHASE=${phase} EXIT=${exitCode}`;
}
