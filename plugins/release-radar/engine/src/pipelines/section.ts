/**
 * Assembles the pipelines section of a report from what `collect.ts` read (spec requirements
 * 47-49, 54). Pure apart from the read-only git ancestry inside {@link pipelineDrift}.
 */

import type { DriftFinding, ObservedTarget } from "../lifecycle.js";
import type { MissingPipeline, PipelineTargetRuns, PipelinesSection } from "../report.js";
import type { BuildRecord } from "./azure-devops-read.js";
import { describeDeclared, pipelineIdentity, type MappedTarget, type ResolvedPipeline, type Session } from "./collect.js";
import { pipelineDrift, runFact, type PipelineDriftEntry } from "./facts.js";

/** The run facts of every mapped target. */
export function targetRuns(mapped: readonly MappedTarget[], resolved: ReadonlyMap<string, ResolvedPipeline>, builds: ReadonlyMap<string, readonly BuildRecord[]>, runHistoryCount: number): PipelineTargetRuns[] {
  return mapped.map((entry) => {
    const pipeline = resolved.get(entry.key);
    if (pipeline === undefined) throw new Error(`internal: pipeline of ${entry.member.member.name}/${entry.stage.name}/${entry.target.name} was not resolved`);
    const context = { component: entry.member.member.name, target: entry.target.name };
    return {
      component: entry.member.member.name,
      stage: entry.stage.name,
      target: entry.target.name,
      pipeline: pipelineIdentity(pipeline),
      runHistoryCount,
      runs: (builds.get(entry.key) ?? []).map((build) => runFact(entry.mapping, build, context)),
    };
  });
}

/** Declared pipelines that do not exist, one entry per mapped target using them. */
export function missingPipelines(mapped: readonly MappedTarget[], resolved: ReadonlyMap<string, ResolvedPipeline>): MissingPipeline[] {
  return mapped.flatMap((entry) => {
    const pipeline = resolved.get(entry.key);
    if (pipeline === undefined || pipeline.status !== "missing") return [];
    return [{ component: entry.member.member.name, stage: entry.stage.name, target: entry.target.name, project: entry.project, pipeline: describeDeclared(entry.mapping), detail: pipeline.detail }];
  });
}

/** Inputs of {@link readSection}. */
export interface SectionInput {
  readonly mapped: readonly MappedTarget[];
  readonly resolved: ReadonlyMap<string, ResolvedPipeline>;
  readonly builds: ReadonlyMap<string, readonly BuildRecord[]>;
  readonly session: Session;
  readonly runHistoryCount: number;
  /** The observed target of `<component>/<stage>/<target>` (drift needs what it runs). */
  readonly observed: (component: string, stage: string, target: string) => ObservedTarget | undefined;
  /** `gitTimeoutSeconds` × 1000. */
  readonly gitTimeoutMs: number;
}

/** The "read" section plus the drift findings of kind `pipeline-target`. */
export function readSection(input: SectionInput): { readonly section: PipelinesSection; readonly findings: DriftFinding[] } {
  const runs = targetRuns(input.mapped, input.resolved, input.builds, input.runHistoryCount);
  const missing = missingPipelines(input.mapped, input.resolved);
  const drift: PipelineDriftEntry[] = runs.map((entry, index) => {
    const mapped = input.mapped[index] as MappedTarget;
    if (entry.pipeline.status === "missing") {
      return { component: entry.component, stage: entry.stage, target: entry.target, status: "pipeline-missing", build: null, targetCommit: null, relation: null, count: null, detail: entry.pipeline.detail };
    }
    const observed = input.observed(entry.component, entry.stage, entry.target);
    return pipelineDrift({
      component: entry.component,
      stage: entry.stage,
      target: entry.target,
      runs: entry.runs,
      targetFound: observed !== undefined && observed.reading.status === "found",
      targetCommit: observed?.commit ?? null,
      clone: mapped.member.clone,
      timeoutMs: input.gitTimeoutMs,
    });
  });
  const findings: DriftFinding[] = drift
    .filter((entry) => entry.status === "drift")
    .map((entry) => ({ kind: "pipeline-target" as const, component: entry.component, where: `${entry.stage}/${entry.target}`, detail: entry.detail }));
  const pipelines = new Set(input.mapped.map((entry) => entry.key)).size;
  const runCount = runs.reduce((sum, entry) => sum + entry.runs.length, 0);
  const missingText = missing.length === 0 ? "" : ` · ${new Set(missing.map((entry) => entry.pipeline)).size} declared pipeline(s) MISSING`;
  const driftText = findings.length === 0 ? "no pipeline/target drift" : `${findings.length} pipeline/target drift finding(s)`;
  const detail = `${input.mapped.length} pipeline-mapped target(s), ${pipelines} pipeline(s): ${runCount} run(s) read (latest ${input.runHistoryCount} per pipeline) · ${driftText}${missingText}`;
  return {
    section: { status: "read", detail, pat: input.session.expiry, runs, drift, missing, requests: { method: "GET", count: input.session.reader.requestCount } },
    findings,
  };
}
