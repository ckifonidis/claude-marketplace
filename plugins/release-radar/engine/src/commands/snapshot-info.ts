/**
 * `snapshot-info` (spec requirements 50, 58 step 3) — READ-ONLY change-risk freshness.
 *
 * `snapshot-info --workspace <path> <component> [--json]`
 *
 * Answers "may change-risk use the newest snapshot for this component instead of running
 * `status` again?". It selects the newest valid snapshot whose `components[]` covers the component
 * and judges it on the three conditions of requirement 58 step 3:
 * - its `time` is no older than the workspace's `freshnessMinutes` (and not in the future);
 * - it covers the component (otherwise no snapshot is selected);
 * - its `fingerprint` equals the CURRENT fingerprint: `configFingerprint` over the canonical
 *   workspace plus the working-tree `component.json` (the revision `status` uses) of every
 *   component that run's scope would use now — the snapshot's own scope (`--all`, or the members it
 *   recorded), because a snapshot fingerprints only the components its run used.
 *
 * Order: workspace skeleton (24) → component name (64) → canonical load of the workspace, repos
 * file and the component (24, 29; a requested member that is unavailable → 24) → snapshot
 * selection (a selected snapshot that is non-canonical → 29) → judgement.
 *
 * Nothing is written (no snapshot, no re-formatting) and nothing remote is contacted. Exit 0
 * whether or not the snapshot is fresh: `fresh` and `reasons[]` carry the answer. The snapshot's
 * stage scope and pipeline/verification sections are reported so the skill can check that the
 * snapshot holds the facts it needs (pipeline facts follow the same freshness rule).
 */

import { argumentError } from "../args.js";
import { EXIT, EngineError } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { newestSnapshot, listSnapshots, type Snapshot } from "../snapshot.js";
import { configFingerprint, inspectWorkspace, loadWorkspace, loadWorkspaceSkeleton, requireAvailableMember } from "../workspace.js";
import type { Component } from "../config.js";
import type { CommandContext, CommandOutput } from "./types.js";

/** Parsed `snapshot-info` options. */
export interface SnapshotInfoOptions {
  readonly workspace: string;
  readonly component: string;
  readonly json: boolean;
}

/** Why a snapshot is not fresh. */
export type StaleReasonCode = "no-snapshot" | "component-not-covered" | "too-old" | "time-in-future" | "fingerprint-differs" | "fingerprint-unavailable";

/** The `snapshot-info --json` document (schemaVersion 1, additive). */
export interface SnapshotInfoReport {
  readonly schemaVersion: 1;
  readonly engineVersion: string;
  readonly command: "snapshot-info";
  readonly generatedAt: string;
  readonly workspace: { readonly root: string; readonly file: string };
  readonly component: string;
  readonly freshnessMinutes: number;
  /** The newest valid snapshot covering the component, or `null`. */
  readonly snapshot: {
    readonly file: string;
    readonly time: string;
    /** Rounded to two decimals. */
    readonly ageMinutes: number;
    readonly exitCode: number;
    readonly components: readonly string[];
    /** The run's scope: `--all`, and the stages it covered (`null` when the report does not say). */
    readonly scope: { readonly all: boolean | null; readonly stages: readonly string[] | null };
    /** `pipelines.status` / `verification.status` of the snapshot's report (`null` when absent). */
    readonly pipelines: string | null;
    readonly verification: string | null;
    readonly fingerprint: string;
  } | null;
  readonly currentFingerprint: string | null;
  readonly fingerprintMatches: boolean | null;
  readonly fresh: boolean;
  readonly reasons: readonly { readonly code: StaleReasonCode; readonly detail: string }[];
  /** Engine-named snapshot files skipped because they are invalid (format reports them). */
  readonly invalidSnapshots: readonly { readonly file: string; readonly problem: string }[];
  readonly outcome: { readonly exitCode: 0; readonly result: "OK"; readonly phase: "complete" };
}

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Runs `snapshot-info`. @throws EngineError 64 / 24 / 29 (no report). */
export function runSnapshotInfo(options: SnapshotInfoOptions, context: CommandContext): CommandOutput {
  const skeleton = loadWorkspaceSkeleton(options.workspace);
  const ws = skeleton.workspace;
  const memberNames = ws.members.map((member) => member.name);
  if (!memberNames.includes(options.component)) {
    throw argumentError(`unknown component "${options.component}" (members: ${memberNames.join(", ")})`);
  }
  const loaded = loadWorkspace(options.workspace, { members: [options.component], canonical: "require" });
  requireAvailableMember(loaded, options.component);

  const now = context.now();
  let unavailableDetail: string | null = null;
  /** The fingerprint `status` would record now for the snapshot's scope (working-tree revisions). */
  const currentFor = (snapshot: Snapshot): string | null => {
    const all = at(snapshot.report, "scope", "all") === true;
    const names = snapshot.members.map((member) => member.name);
    if (!all) {
      const gone = names.filter((name) => !memberNames.includes(name));
      if (gone.length > 0) {
        unavailableDetail = `the snapshot's scope names component(s) no longer in the workspace: ${gone.join(", ")}`;
        return null;
      }
    }
    try {
      const scope = inspectWorkspace(options.workspace, { members: all ? "all" : names });
      const used: Record<string, Component> = {};
      for (const resolution of scope.members) if (resolution.status === "available") used[resolution.member.name] = resolution.component;
      return configFingerprint(scope.workspace, used);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      unavailableDetail = `the configuration that run's scope would use now cannot be loaded: ${error.describe()}`;
      return null;
    }
  };

  const newest = newestSnapshot(loaded.root, { now, freshnessMinutes: ws.freshnessMinutes, fingerprint: currentFor, component: options.component });
  const all = listSnapshots(loaded.root);
  const invalidSnapshots = all.filter((entry) => entry.state === "invalid").map((entry) => ({ file: entry.file, problem: entry.problem ?? "invalid" }));

  const reasons: { code: StaleReasonCode; detail: string }[] = [];
  let snapshot: SnapshotInfoReport["snapshot"] = null;
  if (newest === null) {
    const valid = all.filter((entry) => entry.state !== "invalid").length;
    if (valid === 0) reasons.push({ code: "no-snapshot", detail: "no valid snapshot in the workspace" });
    else reasons.push({ code: "component-not-covered", detail: `none of the ${valid} valid snapshot(s) covers ${options.component}` });
  } else {
    if (newest.state === "non-canonical") {
      throw new EngineError(EXIT.NON_CANONICAL, "canonical", `non-canonical input (run format first): ${newest.file}`, { file: newest.file });
    }
    const report = newest.snapshot.report;
    const stages = at(report, "scope", "stages");
    const scopeAll = at(report, "scope", "all");
    snapshot = {
      file: newest.file,
      time: newest.time,
      ageMinutes: Math.round(newest.ageMinutes * 100) / 100,
      exitCode: newest.exitCode,
      components: newest.snapshot.components,
      scope: {
        all: typeof scopeAll === "boolean" ? scopeAll : null,
        stages: Array.isArray(stages) && stages.every((stage) => typeof stage === "string") ? (stages as string[]) : null,
      },
      pipelines: stringOrNull(at(report, "pipelines", "status")),
      verification: stringOrNull(at(report, "verification", "status")),
      fingerprint: newest.fingerprint,
    };
    if (newest.ageMinutes < 0) reasons.push({ code: "time-in-future", detail: `the snapshot's time ${newest.time} is after now` });
    else if (newest.ageMinutes > ws.freshnessMinutes) {
      reasons.push({ code: "too-old", detail: `${snapshot.ageMinutes} minutes old; freshnessMinutes is ${ws.freshnessMinutes}` });
    }
    if (newest.currentFingerprint === null) reasons.push({ code: "fingerprint-unavailable", detail: unavailableDetail ?? "the current fingerprint cannot be computed" });
    else if (!newest.fingerprintMatches) {
      reasons.push({ code: "fingerprint-differs", detail: "the workspace or a component.json in that run's scope changed since the snapshot" });
    }
  }

  const document: SnapshotInfoReport = {
    schemaVersion: 1,
    engineVersion: engineVersion(),
    command: "snapshot-info",
    generatedAt: now.toISOString(),
    workspace: { root: loaded.root, file: loaded.file },
    component: options.component,
    freshnessMinutes: ws.freshnessMinutes,
    snapshot,
    currentFingerprint: newest?.currentFingerprint ?? null,
    fingerprintMatches: newest === null ? null : newest.fingerprintMatches,
    fresh: newest?.fresh ?? false,
    reasons,
    invalidSnapshots,
    outcome: { exitCode: EXIT.OK, result: "OK", phase: "complete" },
  };
  return { exitCode: EXIT.OK, phase: "complete", stdout: options.json ? `${JSON.stringify(document, null, 2)}\n` : renderHuman(document), stderr: [], json: options.json };
}

function renderHuman(report: SnapshotInfoReport): string {
  const lines = [`release-radar snapshot-info ${report.component} — workspace ${report.workspace.root} (read-only)`, ""];
  const s = report.snapshot;
  if (s === null) lines.push(`  no snapshot covers ${report.component}`);
  else {
    lines.push(`  newest snapshot covering ${report.component}: ${s.file}`);
    lines.push(`    time ${s.time} (${s.ageMinutes} min old; freshnessMinutes ${report.freshnessMinutes}); exit ${s.exitCode}`);
    lines.push(`    scope: ${s.scope.all === true ? "--all" : s.components.join(", ")}; stages ${s.scope.stages === null ? "unknown" : s.scope.stages.join(", ")}; pipelines ${s.pipelines ?? "unknown"}; verification ${s.verification ?? "unknown"}`);
    lines.push(`    fingerprint recorded ${s.fingerprint}`);
    lines.push(`    fingerprint now      ${report.currentFingerprint ?? "(cannot be computed)"}${report.fingerprintMatches === true ? " (matches)" : ""}`);
  }
  for (const entry of report.invalidSnapshots) lines.push(`  skipped invalid snapshot ${entry.file}: ${entry.problem}`);
  lines.push("", report.fresh ? "fresh: yes — the snapshot may be used" : `fresh: no — ${report.reasons.map((reason) => `${reason.code} (${reason.detail})`).join("; ")}`);
  return `${lines.join("\n")}\n`;
}
