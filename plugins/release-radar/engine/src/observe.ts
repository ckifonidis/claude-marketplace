/**
 * Shared "live status read" steps used by `status` and `verify` (spec requirements 18, 23, 42,
 * 46; plan Phases 4-5):
 *
 * - {@link planTargets}: every declared target of the selected members on the selected stages;
 * - {@link preflightAndRead}: preflight EVERY adapter the plan needs — any failure ends the whole
 *   run (20, or 21 for a non-auth source failure) with no partial report — then read each target;
 * - {@link observeStage}: per stage, pair each reading with its deployed commit, resolved
 *   read-only through git under the effective tag convention.
 *
 * Nothing here writes anything; every call is a read-only adapter call or a read-only git call.
 */

import type { AdapterName, Stage, Target, Workspace } from "./config.js";
import { effectiveTagConvention } from "./config.js";
import { createAdapter } from "./adapters/index.js";
import type { Adapter, TargetReading, TargetRequest } from "./adapters/types.js";
import { EXIT, EngineError, pickExitCode } from "./errors.js";
import { resolveDeployedCommit, type CommitResolution } from "./git.js";
import type { ObservedTarget } from "./lifecycle.js";
import type { AvailableMember } from "./workspace.js";

/** One declared target to read. */
export interface PlannedTarget {
  readonly member: AvailableMember;
  readonly stage: Stage;
  readonly target: Target;
  readonly request: TargetRequest;
}

/** One adapter preflight as reported. */
export interface PreflightReport {
  readonly adapter: AdapterName;
  readonly commands: readonly string[];
  readonly identity: string | null;
}

/** The key of a reading: `<component>/<stage>/<target>`. */
export function readingKey(component: string, stage: string, target: string): string {
  return `${component}/${stage}/${target}`;
}

/** Every declared target of `members` on `stages` (stages declared `null` contribute none). */
export function planTargets(members: readonly AvailableMember[], stages: readonly Stage[]): PlannedTarget[] {
  const planned: PlannedTarget[] = [];
  for (const member of members) {
    for (const stage of stages) {
      const entry = member.component.stages[stage.name];
      if (entry === null || entry === undefined) continue;
      for (const target of entry.targets) {
        planned.push({ member, stage, target, request: { key: readingKey(member.member.name, stage.name, target.name), stage: stage.name, target } });
      }
    }
  }
  return planned;
}

/**
 * Preflights every adapter `planned` needs, then reads every target.
 * @throws EngineError 20 (auth/tooling, wins by precedence) or 21 when any preflight fails —
 *   no target is read in that case; 20/21 from a read that fails mid-way.
 */
export async function preflightAndRead(
  workspace: Workspace,
  planned: readonly PlannedTarget[],
  env: NodeJS.ProcessEnv,
): Promise<{ preflight: PreflightReport[]; readings: Map<string, TargetReading> }> {
  const byAdapter = new Map<AdapterName, TargetRequest[]>();
  for (const entry of planned) byAdapter.set(entry.target.adapter, [...(byAdapter.get(entry.target.adapter) ?? []), entry.request]);
  const adapterNames = [...byAdapter.keys()].sort();
  const adapters = new Map<AdapterName, Adapter>();
  const preflight: PreflightReport[] = [];
  const failures: EngineError[] = [];
  for (const name of adapterNames) {
    const adapter = createAdapter(name, workspace.adapters, { env }) as Adapter;
    adapters.set(name, adapter);
    try {
      const result = await adapter.preflight(byAdapter.get(name) ?? []);
      preflight.push({ adapter: result.adapter, commands: result.commands, identity: result.identity });
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const code = pickExitCode(failures.map((failure) => failure.exitCode));
    const lead =
      code === EXIT.AUTH
        ? "preflight failed — an authentication/tooling problem, NOT a missing target; no report was produced. Re-authenticate (or install the CLI) and run again:"
        : "preflight failed — no report was produced:";
    throw new EngineError(code, "preflight", [lead, ...failures.map((failure) => `  - ${failure.describe()}`)].join("\n"));
  }
  const readings = new Map<string, TargetReading>();
  for (const name of adapterNames) {
    const adapter = adapters.get(name) as Adapter;
    for (const reading of await adapter.read(byAdapter.get(name) ?? [])) readings.set(reading.key, reading);
  }
  return { preflight, readings };
}

/**
 * Pairs each declared target of `member` on `stage` with its reading and its deployed commit
 * (resolved only for a found single-container image; `null` otherwise).
 * @throws EngineError 1 when a reading is absent (an engine bug: every planned target is read).
 */
export function observeStage(
  workspace: Workspace,
  member: AvailableMember,
  stage: Stage,
  targets: readonly Target[],
  readings: ReadonlyMap<string, TargetReading>,
  timeoutMs: number,
): ObservedTarget[] {
  const name = member.member.name;
  const convention = effectiveTagConvention(workspace, member.component, stage.name);
  return targets.map((target) => {
    const reading = readings.get(readingKey(name, stage.name, target.name));
    if (reading === undefined) throw new EngineError(EXIT.INTERNAL, "source", `no reading for ${readingKey(name, stage.name, target.name)}`);
    let commit: CommitResolution | null = null;
    const image = reading.image;
    if (reading.status === "found" && image !== null && image.kind === "image") {
      commit = resolveDeployedCommit({ clone: member.clone, tag: image.tag, convention: convention.convention, timeoutMs });
    }
    return { name: target.name, reading, commit };
  });
}
