/**
 * Reading pipeline facts for pipeline-mapped targets (spec requirements 16-18, 48, 66, 69; plan
 * Phase 6). Shared by `status`, `pipeline-runs` and `pipeline-run`. Every call here is a GET
 * through `azure-devops-read.ts`; nothing in this module can write.
 *
 * - {@link openSession}: the LOCAL half of the Azure DevOps preflight — PAT and expiry from the
 *   environment (20 before any request), then the read client.
 * - {@link resolvePipelines}: Pipelines Get by id (or List by name) for every distinct declared
 *   pipeline — the authenticated half of the preflight: 20/21 end the run, a pipeline that does
 *   not exist is recorded as missing (exit 23 for the caller, which still reports).
 * - {@link listRuns}: the latest `runHistoryCount` builds of every found pipeline.
 * - {@link readWaits} / {@link followRun}: checkpoint waits (timeline + approver names) and the
 *   read-only follow loop of `pipeline-run --follow`.
 */

import { mappingProject, type PipelineMapping, type Stage, type Target, type Workspace } from "../config.js";
import { EXIT, EngineError } from "../errors.js";
import type { AvailableMember } from "../workspace.js";
import { AzureDevOpsReader, type BuildRecord, type PipelineInfo, type TimelineRecord } from "./azure-devops-read.js";
import { readPat, type PatCredential, type PatExpiry } from "./pat.js";
import { isTerminalStatus } from "./facts.js";

/** One pipeline-mapped target. */
export interface MappedTarget {
  readonly member: AvailableMember;
  readonly stage: Stage;
  readonly target: Target;
  readonly mapping: PipelineMapping;
  /** The mapping's project (its own, or the workspace's `azureDevOps.project`). */
  readonly project: string;
  /** Identity of the declared pipeline (several targets may share one). */
  readonly key: string;
}

/** An open read session. */
export interface Session {
  readonly reader: AzureDevOpsReader;
  readonly expiry: PatExpiry;
  /** The opaque credential (only `run-pipeline` hands it to the write module). */
  readonly credential: PatCredential;
}

/** A declared pipeline after resolution. */
export type ResolvedPipeline =
  | { readonly status: "found"; readonly project: string; readonly pipeline: PipelineInfo; readonly declaredId: number | null; readonly declaredName: string | null }
  | { readonly status: "missing"; readonly project: string; readonly declaredId: number | null; readonly declaredName: string | null; readonly detail: string };

/** The identity of a declared pipeline. */
export function pipelineKey(project: string, mapping: PipelineMapping): string {
  return `${project}\u0000${mapping.pipelineId ?? ""}\u0000${mapping.pipelineName ?? ""}`;
}

/** `pipeline 101 "acme-api-ci"` / `pipeline 101` / `pipeline "acme-api-ci"`. */
export function describeDeclared(mapping: PipelineMapping): string {
  if (mapping.pipelineId !== undefined && mapping.pipelineName !== undefined) return `pipeline ${mapping.pipelineId} "${mapping.pipelineName}"`;
  if (mapping.pipelineId !== undefined) return `pipeline ${mapping.pipelineId}`;
  return `pipeline "${mapping.pipelineName ?? ""}"`;
}

/** The pipeline-mapped targets of `members` on `stages`, filtered by an optional target name. */
export function mappedTargets(workspace: Workspace, members: readonly AvailableMember[], stages: readonly Stage[], targetName: string | null = null): MappedTarget[] {
  const out: MappedTarget[] = [];
  for (const member of members) {
    for (const stage of stages) {
      const entry = member.component.stages[stage.name];
      if (entry === null || entry === undefined) continue;
      for (const target of entry.targets) {
        if (targetName !== null && target.name !== targetName) continue;
        const mapping = target.pipeline;
        if (mapping === undefined) continue;
        const project = mappingProject(workspace, mapping);
        out.push({ member, stage, target, mapping, project, key: pipelineKey(project, mapping) });
      }
    }
  }
  return out;
}

/**
 * Reads the PAT (20 before any request when absent, empty, expired or unparseable) and opens the
 * read client.
 */
export function openSession(
  workspace: Workspace,
  env: NodeJS.ProcessEnv,
  options: { readonly now: () => Date; readonly sleep: (ms: number) => Promise<void>; readonly patNeed?: string },
): Session {
  const settings = workspace.azureDevOps;
  if (settings === undefined) throw new EngineError(EXIT.INVALID, "validate", `a pipeline mapping requires the "azureDevOps" block in workspace.json`);
  const { credential, expiry } = readPat(env, settings.patExpiryWarningDays, options.now(), options.patNeed);
  const reader = new AzureDevOpsReader({
    organizationUrl: settings.organizationUrl,
    timeoutMs: settings.requestTimeoutSeconds * 1000,
    credential,
    sleep: options.sleep,
    clock: () => options.now().getTime(),
  });
  return { reader, expiry, credential };
}

/** Resolves one declared pipeline. @throws EngineError 20 / 21 (23 becomes `missing`). */
export async function resolvePipeline(reader: AzureDevOpsReader, project: string, mapping: PipelineMapping): Promise<ResolvedPipeline> {
  const declaredId = mapping.pipelineId ?? null;
  const declaredName = mapping.pipelineName ?? null;
  const declared = describeDeclared(mapping);
  if (declaredId !== null) {
    let pipeline: PipelineInfo;
    try {
      pipeline = await reader.getPipeline(project, declaredId);
    } catch (error) {
      if (error instanceof EngineError && error.exitCode === EXIT.MISSING) return { status: "missing", project, declaredId, declaredName, detail: `${declared} does not exist in project "${project}"` };
      throw error;
    }
    if (declaredName !== null && pipeline.name !== declaredName) {
      return { status: "missing", project, declaredId, declaredName, detail: `${declared} does not exist in project "${project}": pipeline ${declaredId} is named "${pipeline.name}"` };
    }
    return { status: "found", project, pipeline, declaredId, declaredName };
  }
  let matches: PipelineInfo[];
  try {
    matches = await reader.findPipelinesByName(project, declaredName ?? "");
  } catch (error) {
    if (error instanceof EngineError && error.exitCode === EXIT.MISSING) return { status: "missing", project, declaredId, declaredName, detail: `project "${project}" does not exist` };
    throw error;
  }
  if (matches.length === 0) return { status: "missing", project, declaredId, declaredName, detail: `${declared} does not exist in project "${project}"` };
  if (matches.length > 1) {
    const where = matches.map((match) => `${match.id}${match.folder === null ? "" : ` in ${match.folder}`}`).join(", ");
    throw new EngineError(EXIT.SOURCE, "pipelines", `${declared} matches ${matches.length} pipelines in project "${project}" (ids ${where}); declare "pipelineId" in the mapping`);
  }
  return { status: "found", project, pipeline: matches[0] as PipelineInfo, declaredId, declaredName };
}

/** Resolves every distinct declared pipeline of `mapped` (keyed by {@link MappedTarget.key}). */
export async function resolvePipelines(reader: AzureDevOpsReader, mapped: readonly MappedTarget[]): Promise<Map<string, ResolvedPipeline>> {
  const resolved = new Map<string, ResolvedPipeline>();
  for (const entry of mapped) {
    if (resolved.has(entry.key)) continue;
    resolved.set(entry.key, await resolvePipeline(reader, entry.project, entry.mapping));
  }
  return resolved;
}

/** The latest `count` builds of every FOUND pipeline (keyed like {@link resolvePipelines}). */
export async function listRuns(reader: AzureDevOpsReader, resolved: ReadonlyMap<string, ResolvedPipeline>, count: number): Promise<Map<string, BuildRecord[]>> {
  const runs = new Map<string, BuildRecord[]>();
  for (const [key, pipeline] of resolved) {
    if (pipeline.status !== "found") continue;
    runs.set(key, await reader.listBuilds(pipeline.project, pipeline.pipeline.id, count));
  }
  return runs;
}

/** The reported identity of a resolved pipeline. */
export interface PipelineIdentity {
  readonly project: string;
  readonly id: number | null;
  readonly name: string | null;
  readonly folder: string | null;
  readonly link: string | null;
  readonly status: "found" | "missing";
  readonly detail: string;
}

/** {@link ResolvedPipeline} as reported. */
export function pipelineIdentity(resolved: ResolvedPipeline): PipelineIdentity {
  if (resolved.status === "missing") {
    return { project: resolved.project, id: resolved.declaredId, name: resolved.declaredName, folder: null, link: null, status: "missing", detail: resolved.detail };
  }
  const { pipeline } = resolved;
  return { project: resolved.project, id: pipeline.id, name: pipeline.name, folder: pipeline.folder, link: pipeline.link, status: "found", detail: `pipeline ${pipeline.id} "${pipeline.name}" exists (Pipelines Get proves existence only)` };
}

// ---------------------------------------------------------------------------
// Waits and following

/** Something a running run waits for (research §3.8 [M]). */
export interface RunWait {
  /** `approval` (Checkpoint.Approval), `check` (any other Checkpoint.*), `checkpoint` (only the parent record pending). */
  readonly kind: "approval" | "check" | "checkpoint";
  /** The timeline record name (a check's name, or the record type). */
  readonly name: string;
  readonly state: string | null;
  /** Approver DISPLAY NAMES (approvals only; empty when they could not be linked). */
  readonly approvers: readonly string[];
  readonly minRequiredApprovers: number | null;
  readonly detail: string;
}

function isCheckpoint(record: TimelineRecord): boolean {
  return record.type === "Checkpoint" || record.type.startsWith("Checkpoint.");
}

/**
 * The checkpoint waits of a running build: pending/in-progress `Checkpoint*` timeline records,
 * with approver names from the Approvals API for `Checkpoint.Approval` records (linked by the
 * record id = approval id [M]). Never approves anything.
 */
export async function readWaits(reader: AzureDevOpsReader, project: string, runId: number): Promise<RunWait[]> {
  const records = (await reader.getBuildTimeline(project, runId)).filter((record) => isCheckpoint(record) && record.state !== "completed");
  if (records.length === 0) return [];
  const specific = records.filter((record) => record.type !== "Checkpoint");
  const approvalRecords = specific.filter((record) => record.type === "Checkpoint.Approval");
  const approvals = approvalRecords.length === 0 ? [] : await reader.listPendingApprovals(project, approvalRecords.map((record) => record.id));
  if (specific.length === 0) {
    return records.map((record) => ({ kind: "checkpoint" as const, name: record.name, state: record.state, approvers: [], minRequiredApprovers: null, detail: `waiting at a checkpoint (${record.name}); the timeline names no approval or check` }));
  }
  return specific.map((record): RunWait => {
    if (record.type === "Checkpoint.Approval") {
      const approval = approvals.find((candidate) => candidate.id === record.id);
      if (approval === undefined) {
        return { kind: "approval", name: record.name, state: record.state, approvers: [], minRequiredApprovers: null, detail: "waiting for an approval; the approvers could not be linked to this run (the Approvals API names no run)" };
      }
      const who = approval.approvers.length === 0 ? "no approver is named" : `approvers: ${approval.approvers.join(", ")}`;
      const minimum = approval.minRequiredApprovers === null ? "" : ` (at least ${approval.minRequiredApprovers} required)`;
      return { kind: "approval", name: record.name, state: record.state, approvers: approval.approvers, minRequiredApprovers: approval.minRequiredApprovers, detail: `waiting for an approval — ${who}${minimum}; release-radar never approves` };
    }
    return { kind: "check", name: record.name, state: record.state, approvers: [], minRequiredApprovers: null, detail: `waiting for the check "${record.name}" (${record.type})` };
  });
}

/** How a `pipeline-run` read ended. */
export type FollowOutcome = "terminal" | "in-progress" | "waiting" | "still-running";

/** Result of {@link followRun}. */
export interface FollowResult {
  readonly build: BuildRecord;
  readonly waits: readonly RunWait[];
  readonly outcome: FollowOutcome;
  /** Build reads performed (1 without --follow). */
  readonly polls: number;
  readonly elapsedMs: number;
}

/**
 * Reads one run; with `follow`, polls it read-only every `pollMs` until it is terminal, waits at
 * a checkpoint (reported, following stops), or `timeoutMs` passes ("still running" — never a
 * failure). Without `follow` the first read decides (`in-progress` when it is still running).
 */
export async function followRun(
  reader: AzureDevOpsReader,
  project: string,
  runId: number,
  options: { readonly follow: boolean; readonly pollMs: number; readonly timeoutMs: number; readonly now: () => number; readonly sleep: (ms: number) => Promise<void>; readonly first?: BuildRecord },
): Promise<FollowResult> {
  const started = options.now();
  let build = options.first ?? (await reader.getBuild(project, runId));
  let polls = 1;
  for (;;) {
    if (isTerminalStatus(build.status)) return { build, waits: [], outcome: "terminal", polls, elapsedMs: options.now() - started };
    const waits = await readWaits(reader, project, runId);
    if (waits.length > 0) return { build, waits, outcome: "waiting", polls, elapsedMs: options.now() - started };
    if (!options.follow) return { build, waits, outcome: "in-progress", polls, elapsedMs: options.now() - started };
    if (options.now() - started + options.pollMs > options.timeoutMs) return { build, waits, outcome: "still-running", polls, elapsedMs: options.now() - started };
    await options.sleep(options.pollMs);
    build = await reader.getBuild(project, runId);
    polls++;
  }
}
