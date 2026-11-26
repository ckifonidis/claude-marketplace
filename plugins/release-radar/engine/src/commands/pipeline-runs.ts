/**
 * `pipeline-runs` and `pipeline-run` — Azure DevOps run facts, read-only (spec requirements
 * 12-14, 16-18, 48, 66, 69, 71, 73; plan D8, D10, Phase 6).
 *
 * ```
 * pipeline-runs --workspace <path> <component> [--stage <name>] [--target <name>] [--json]
 * pipeline-run  --workspace <path> <component> <runId> [--stage <name>] [--target <name>] [--follow] [--json]
 * ```
 *
 * Order (each step only after every earlier one succeeded):
 * 1. arguments (64); 2. workspace skeleton (24) → component / stage names (64);
 * 3. full load with the canonical gate (24, 29; a requested unavailable member → 24);
 * 4. target name (64) and pipeline mapping selection: none in scope → 26 ("no mapping");
 *    `pipeline-run` needs exactly ONE mapped target (several → 64 naming them, pass --stage/--target);
 * 5. PAT preflight (20 before any request);
 * 6. Pipelines Get (existence: a declared pipeline that does not exist → 23 with the report);
 * 7. `pipeline-runs`: the latest `runHistoryCount` builds per pipeline (Build list) → exit 0, or
 *    23 when a declared pipeline is missing;
 *    `pipeline-run`: `GET build/{runId}` (absent, or a run of another pipeline → 23); with
 *    `--follow` polls read-only every `followPollSeconds`.
 *
 * `pipeline-run` exits (decision recorded in the Phase 6 report):
 * - terminal with result exactly `succeeded` → 0 (phase `complete`);
 * - terminal with any other result (`partiallySucceeded`, `failed`, `canceled`, `none`) → 25
 *   (phase `pipeline`); the Build API result is the result of record (plan D8);
 * - still running without `--follow` → 0 (phase `in-progress`);
 * - waiting at an approval/check → 0 (phase `waiting`): the approver NAMES or the check are
 *   reported and following stops; nothing is ever approved;
 * - `--follow` past `followTimeoutMinutes` → 0 (phase `still-running`): "still running" is a
 *   report, never a failure and never 25.
 *
 * Neither command reads deployment targets (that is `status`, which also computes
 * pipeline/target drift), writes a snapshot, or sends anything but GET.
 */

import { argumentError } from "../args.js";
import type { Stage, Workspace } from "../config.js";
import { EXIT, EngineError } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import type { BuildRecord } from "../pipelines/azure-devops-read.js";
import {
  describeDeclared,
  followRun,
  listRuns,
  mappedTargets,
  openSession,
  pipelineIdentity,
  resolvePipeline,
  resolvePipelines,
  type FollowOutcome,
  type MappedTarget,
  type PipelineIdentity,
  type RunWait,
  type Session,
} from "../pipelines/collect.js";
import { runFact, runOutcomeWord, type RunFact } from "../pipelines/facts.js";
import type { PatExpiry } from "../pipelines/pat.js";
import { missingPipelines, targetRuns } from "../pipelines/section.js";
import { REPORT_SCHEMA_VERSION, colours, renderPipelines, runLine, useColour, type MissingPipeline, type PipelineTargetRuns } from "../report.js";
import { loadWorkspace, loadWorkspaceSkeleton, requireAvailableMember, type AvailableMember } from "../workspace.js";
import { pipelinePreflightError } from "./status.js";
import { sleeper, type CommandContext, type CommandOutput } from "./types.js";

/** Options shared by both commands. */
export interface PipelineScopeOptions {
  readonly workspace: string;
  readonly component: string;
  readonly stage: string | null;
  readonly target: string | null;
  readonly json: boolean;
}

/** `pipeline-run` options. */
export interface PipelineRunOptions extends PipelineScopeOptions {
  readonly runId: number;
  readonly follow: boolean;
}

/** A run id: a positive decimal integer. @throws EngineError 64. */
export function parseRunId(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw argumentError(`run id must be a positive integer, got ${JSON.stringify(value)}`);
  return Number(value);
}

interface Scope {
  readonly ws: Workspace;
  readonly root: string;
  readonly file: string;
  readonly member: AvailableMember;
  readonly mapped: readonly MappedTarget[];
}

/** Steps 2-4: names (64), load (24/29), target name (64), mapping selection (26). */
function resolveScope(options: PipelineScopeOptions): Scope {
  const skeleton = loadWorkspaceSkeleton(options.workspace);
  const ws = skeleton.workspace;
  const members = ws.members.map((member) => member.name);
  if (!members.includes(options.component)) throw argumentError(`unknown component "${options.component}" (members: ${members.join(", ")})`);
  let stages: Stage[] = [...ws.stages];
  if (options.stage !== null) {
    const stage = ws.stages.find((candidate) => candidate.name === options.stage);
    if (stage === undefined) throw argumentError(`unknown stage "${options.stage}" (stages: ${ws.stages.map((s) => s.name).join(", ")})`);
    stages = [stage];
  }
  const loaded = loadWorkspace(options.workspace, { members: [options.component], canonical: "require" });
  const member = requireAvailableMember(loaded, options.component);
  if (options.target !== null) {
    const known = stages.flatMap((stage) => member.component.stages[stage.name]?.targets.map((target) => target.name) ?? []);
    if (!known.includes(options.target)) {
      const where = options.stage === null ? "any stage" : `stage "${options.stage}"`;
      throw argumentError(`unknown target "${options.target}" for ${options.component} in ${where} (targets: ${[...new Set(known)].join(", ") || "none"})`);
    }
  }
  const mapped = mappedTargets(ws, [member], stages, options.target);
  if (mapped.length === 0) {
    const where = [options.stage === null ? null : `stage "${options.stage}"`, options.target === null ? null : `target "${options.target}"`].filter((part) => part !== null).join(", ");
    throw new EngineError(EXIT.REFUSED, "pipelines", `no pipeline mapping for ${options.component}${where === "" ? "" : ` (${where})`}: nothing to read (mappings are declared per target in component.json)`);
  }
  return { ws, root: loaded.root, file: loaded.file, member, mapped };
}

function settingsOf(ws: Workspace): NonNullable<Workspace["azureDevOps"]> {
  if (ws.azureDevOps === undefined) throw new EngineError(EXIT.INTERNAL, "pipelines", "internal: pipeline mappings without an azureDevOps block");
  return ws.azureDevOps;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw pipelinePreflightError(error);
  }
}

// ---------------------------------------------------------------------------
// pipeline-runs

/** The `pipeline-runs --json` document (schemaVersion 1, additive). */
export interface PipelineRunsReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly engineVersion: string;
  readonly command: "pipeline-runs";
  readonly generatedAt: string;
  readonly workspace: { readonly root: string; readonly file: string };
  readonly scope: { readonly component: string; readonly stage: string | null; readonly target: string | null };
  readonly pat: PatExpiry;
  /** Same shape as the status report's `pipelines.runs[]`. */
  readonly targets: readonly PipelineTargetRuns[];
  readonly missing: readonly MissingPipeline[];
  readonly requests: { readonly method: "GET"; readonly count: number };
  readonly outcome: { readonly exitCode: number; readonly result: "OK" | "FAIL"; readonly phase: string };
}

/** Runs `pipeline-runs`. @throws EngineError for every exit that produces no report (64, 24, 29, 26, 20, 21, 1). */
export async function runPipelineRuns(options: PipelineScopeOptions, context: CommandContext): Promise<CommandOutput> {
  const scope = resolveScope(options);
  const settings = settingsOf(scope.ws);
  const session: Session = openSession(scope.ws, context.env, { now: context.now, sleep: sleeper(context) });
  const resolved = await guarded(() => resolvePipelines(session.reader, scope.mapped));
  const builds = await guarded(() => listRuns(session.reader, resolved, settings.runHistoryCount));
  const targets = targetRuns(scope.mapped, resolved, builds, settings.runHistoryCount);
  const missing = missingPipelines(scope.mapped, resolved);
  const exitCode = missing.length > 0 ? EXIT.MISSING : EXIT.OK;
  const phase = exitCode === EXIT.OK ? "complete" : "missing";
  const report: PipelineRunsReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    engineVersion: engineVersion(),
    command: "pipeline-runs",
    generatedAt: context.now().toISOString(),
    workspace: { root: scope.root, file: scope.file },
    scope: { component: options.component, stage: options.stage, target: options.target },
    pat: session.expiry,
    targets,
    missing,
    requests: { method: "GET", count: session.reader.requestCount },
    outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
  };
  const stderr: string[] = [];
  if (missing.length > 0) stderr.push(`release-radar: ${missing.map((entry) => `${entry.stage}/${entry.target}: ${entry.detail}`).join("; ")} (exit 23)`);
  if (session.expiry.warning) stderr.push(`release-radar: warning — ${session.expiry.detail}`);
  let stdout: string;
  if (options.json) stdout = `${JSON.stringify(report, null, 2)}\n`;
  else {
    const c = colours(useColour(false, context.stdout, context.env));
    const section = renderPipelines(
      { status: "read", detail: `${targets.length} pipeline-mapped target(s); latest ${settings.runHistoryCount} run(s) per pipeline`, pat: session.expiry, runs: targets, drift: [], missing, requests: report.requests },
      c,
    );
    stdout = `${[`release-radar pipeline-runs — ${options.component} (read-only)`, "", ...section].join("\n")}\n`;
  }
  return { exitCode, phase, stdout, stderr, json: options.json };
}

// ---------------------------------------------------------------------------
// pipeline-run

/** The `pipeline-run --json` document (schemaVersion 1, additive). */
export interface PipelineRunReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly engineVersion: string;
  readonly command: "pipeline-run";
  readonly generatedAt: string;
  readonly workspace: { readonly root: string; readonly file: string };
  readonly scope: { readonly component: string; readonly stage: string; readonly target: string; readonly runId: number; readonly follow: boolean };
  readonly pat: PatExpiry;
  readonly pipeline: PipelineIdentity;
  /** `null` only when the pipeline itself is missing (exit 23). */
  readonly run: RunFact | null;
  /** What the run waits for (approver names / checks), when it waits. */
  readonly waits: readonly RunWait[];
  readonly follow: {
    readonly requested: boolean;
    /** `terminal` | `in-progress` | `waiting` | `still-running`; `null` when no run was read. */
    readonly outcome: FollowOutcome | null;
    readonly polls: number;
    readonly elapsedSeconds: number;
    readonly pollSeconds: number;
    readonly timeoutMinutes: number;
  };
  readonly requests: { readonly method: "GET"; readonly count: number };
  readonly outcome: { readonly exitCode: number; readonly result: "OK" | "FAIL"; readonly phase: string };
}

/** Exit and phase of a `pipeline-run` outcome (see the module comment). */
export function pipelineRunExit(outcome: FollowOutcome, build: Pick<BuildRecord, "status" | "result">): { readonly exitCode: number; readonly phase: string } {
  if (outcome === "terminal") return build.result === "succeeded" ? { exitCode: EXIT.OK, phase: "complete" } : { exitCode: EXIT.PIPELINE_FAILED, phase: "pipeline" };
  return { exitCode: EXIT.OK, phase: outcome };
}

/** Runs `pipeline-run`. @throws EngineError for every exit that produces no report (64, 24, 29, 26, 20, 21, 1). */
export async function runPipelineRun(options: PipelineRunOptions, context: CommandContext): Promise<CommandOutput> {
  const scope = resolveScope(options);
  if (scope.mapped.length > 1) {
    const names = scope.mapped.map((entry) => `${entry.stage.name}/${entry.target.name} (${describeDeclared(entry.mapping)})`).join(", ");
    throw argumentError(`${options.component} has ${scope.mapped.length} pipeline-mapped targets in scope (${names}); pick one with --stage and --target`);
  }
  const mapped = scope.mapped[0] as MappedTarget;
  const settings = settingsOf(scope.ws);
  const sleep = sleeper(context);
  const session = openSession(scope.ws, context.env, { now: context.now, sleep });
  const resolved = await guarded(() => resolvePipeline(session.reader, mapped.project, mapped.mapping));
  const pipeline = pipelineIdentity(resolved);
  const followSettings = { requested: options.follow, pollSeconds: settings.followPollSeconds, timeoutMinutes: settings.followTimeoutMinutes };

  let run: RunFact | null = null;
  let waits: readonly RunWait[] = [];
  let followOutcome: FollowOutcome | null = null;
  let polls = 0;
  let elapsedMs = 0;
  let exitCode: number;
  let phase: string;
  let missingDetail: string | null = null;
  if (resolved.status === "missing") {
    exitCode = EXIT.MISSING;
    phase = "missing";
    missingDetail = resolved.detail;
  } else {
    const first = await guarded(() => session.reader.getBuild(mapped.project, options.runId)).catch((error: unknown) => {
      if (error instanceof EngineError && error.exitCode === EXIT.MISSING) return null;
      throw error;
    });
    if (first === null || (first.definitionId !== null && first.definitionId !== resolved.pipeline.id)) {
      exitCode = EXIT.MISSING;
      phase = "missing";
      missingDetail =
        first === null
          ? `run ${options.runId} does not exist in project "${mapped.project}"`
          : `run ${options.runId} is not a run of pipeline ${resolved.pipeline.id} "${resolved.pipeline.name}" (it belongs to pipeline ${first.definitionId ?? "?"})`;
    } else {
      const followed = await guarded(() =>
        followRun(session.reader, mapped.project, options.runId, {
          follow: options.follow,
          pollMs: settings.followPollSeconds * 1000,
          timeoutMs: settings.followTimeoutMinutes * 60_000,
          now: () => context.now().getTime(),
          sleep,
          first,
        }),
      );
      run = runFact(mapped.mapping, followed.build, { component: options.component, target: mapped.target.name });
      waits = followed.waits;
      followOutcome = followed.outcome;
      polls = followed.polls;
      elapsedMs = followed.elapsedMs;
      ({ exitCode, phase } = pipelineRunExit(followed.outcome, followed.build));
    }
  }

  const report: PipelineRunReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    engineVersion: engineVersion(),
    command: "pipeline-run",
    generatedAt: context.now().toISOString(),
    workspace: { root: scope.root, file: scope.file },
    scope: { component: options.component, stage: mapped.stage.name, target: mapped.target.name, runId: options.runId, follow: options.follow },
    pat: session.expiry,
    pipeline,
    run,
    waits,
    follow: { ...followSettings, outcome: followOutcome, polls, elapsedSeconds: Math.round(elapsedMs / 1000) },
    requests: { method: "GET", count: session.reader.requestCount },
    outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
  };

  const stderr: string[] = [];
  if (missingDetail !== null) stderr.push(`release-radar: ${missingDetail} (exit 23)`);
  if (exitCode === EXIT.PIPELINE_FAILED && run !== null) stderr.push(`release-radar: run #${run.id} finished "${run.result ?? "no result"}" — not "succeeded" (exit 25)`);
  if (followOutcome === "still-running") stderr.push(`release-radar: run #${options.runId} is still running after ${settings.followTimeoutMinutes} minute(s) of following — this is not a failure; run pipeline-run again to keep watching`);
  if (session.expiry.warning) stderr.push(`release-radar: warning — ${session.expiry.detail}`);
  let stdout: string;
  if (options.json) stdout = `${JSON.stringify(report, null, 2)}\n`;
  else {
    const c = colours(useColour(false, context.stdout, context.env));
    const lines = [`release-radar pipeline-run — ${options.component} / ${mapped.stage.name} / ${mapped.target.name} (read-only)`, ""];
    lines.push(`  ${pipeline.status === "found" ? `pipeline ${pipeline.id ?? ""} "${pipeline.name ?? ""}"` : c.red(`MISSING — ${pipeline.detail}`)} ${c.dim(`(project ${pipeline.project})`)}`);
    if (missingDetail !== null && pipeline.status === "found") lines.push(`  ${c.red(`MISSING — ${missingDetail}`)}`);
    if (run !== null) lines.push(`  ${runLine(run, c)}`);
    for (const wait of waits) lines.push(`  ${c.yellow(`⏸ ${wait.detail}`)}`);
    if (followOutcome === "still-running") lines.push(`  ${c.yellow(`still running after ${settings.followTimeoutMinutes} minute(s) (${polls} poll(s)) — not a failure`)}`);
    if (followOutcome === "in-progress" && run !== null) lines.push(`  ${c.dim(`${runOutcomeWord(run)}; pass --follow to poll every ${settings.followPollSeconds}s up to ${settings.followTimeoutMinutes} minute(s)`)}`);
    lines.push(c.dim(`  ${session.expiry.detail}`));
    lines.push(c.dim(`  ${report.requests.count} Azure DevOps request(s), all GET; nothing was queued, approved or changed.`));
    stdout = `${lines.join("\n")}\n`;
  }
  return { exitCode, phase, stdout, stderr, json: options.json };
}
