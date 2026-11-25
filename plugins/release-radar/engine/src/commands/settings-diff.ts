/**
 * `settings-diff` (spec requirements 12, 14, 31d, 56, 73; plan Phase 8). Read-only and
 * informational.
 *
 * `settings-diff --workspace <path> <component> --from <stage|local|sha> --to <stage|sha>
 *                [--stage <name>] [--json]`
 *
 * Direction is the promotion's: `--from` is where the PROMOTED commit comes from, `--to` is the
 * destination whose currently DEPLOYED commit is the baseline. "Added" means present in the
 * promoted commit and absent from the deployed one.
 *
 * - `--from` and `--to` are both REQUIRED (no endpoint is defaulted). Each token resolves in the
 *   fixed order of `stage-commit.ts`: a declared stage (the commit its targets run, from a LIVE
 *   status read), `local` (`--from` only: the clone's HEAD commit), or a 7–40 hex commit sha that
 *   must exist in the clone.
 * - The DESTINATION stage — whose handoff artefacts declare the settings files — is `--to` when it
 *   names a stage. When `--to` is a sha, `--stage <name>` is required; when both are given they
 *   must agree.
 * - The settings-file list comes from `component.json` AT THE PROMOTED COMMIT (31d); differences
 *   from the working-tree `component.json` are reported as pointers. A destination stage without
 *   handoff artefacts at that commit is reported as "no settings files declared" (exit 0).
 * - Values are never printed: keys are JSON pointers, secret references are names, an
 *   unparseable file is a line count (settings-diff.ts).
 *
 * Exit codes: 64 (arguments, unknown names, a commit not in the clone), 24 (invalid input,
 * including `component.json` missing or invalid at the promoted commit), 29 (non-canonical
 * input), 20/21 (live-read preflight or source failure, no report), then — with the full report —
 * 23 when a stage endpoint has a declared target that does not exist, 21 when a stage endpoint is
 * not deployed, inconsistent or unresolved (name the commit as a sha), else 0. A difference is
 * never a failure.
 */

import { argumentError } from "../args.js";
import type { Stage } from "../config.js";
import { EXIT, EngineError, pickExitCode } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import type { PreflightReport } from "../observe.js";
import { analyzeSettings, diffSettingsFile, renderSettingsFileDiff, type SettingsFileDiff } from "../settings-diff.js";
import {
  observeStages,
  parseEndpoint,
  resolveLocalEndpoint,
  settingsBytesAt,
  stageCommit,
  type EndpointResolution,
  type EndpointSpec,
} from "../stage-commit.js";
import { componentDifferences, loadWorkspace, loadWorkspaceSkeleton, readComponentAtCommit, requireAvailableMember } from "../workspace.js";
import type { CommandContext, CommandOutput } from "./types.js";

/** Parsed `settings-diff` options. */
export interface SettingsDiffOptions {
  readonly workspace: string;
  readonly component: string;
  readonly from: string;
  readonly to: string;
  readonly stage: string | null;
  readonly json: boolean;
}

/** The component.json revision the settings-file list came from. */
export interface ComponentConfigUsed {
  readonly revision: string;
  readonly label: string;
  /** `non-canonical` at a commit is used and reported, never refused (84). */
  readonly state: "canonical" | "non-canonical";
  /** JSON pointers where the working-tree component.json differs from this revision (31d). */
  readonly differencesFromWorkingTree: readonly string[];
}

/** The `settings-diff --json` document (schemaVersion 1, additive). */
export interface SettingsDiffReport {
  readonly schemaVersion: 1;
  readonly engineVersion: string;
  readonly command: "settings-diff";
  readonly generatedAt: string;
  readonly workspace: { readonly root: string; readonly file: string };
  readonly component: string;
  /** The destination stage whose handoff artefacts were diffed. */
  readonly stage: string;
  readonly promoted: EndpointResolution;
  readonly deployed: EndpointResolution;
  readonly componentConfig: ComponentConfigUsed | null;
  /** Declared settings files (null when the endpoints did not resolve). */
  readonly declared: readonly string[] | null;
  readonly note: string | null;
  readonly files: readonly SettingsFileDiff[];
  readonly preflight: readonly PreflightReport[];
  readonly outcome: { readonly exitCode: number; readonly result: "OK" | "FAIL"; readonly phase: string };
}

function destinationStage(to: EndpointSpec, stageFlag: string | null, stages: readonly Stage[]): Stage {
  if (to.kind === "stage") {
    if (stageFlag !== null && stageFlag !== to.stage.name) throw argumentError(`--stage ${stageFlag} disagrees with --to ${to.token} (the destination stage)`);
    return to.stage;
  }
  if (stageFlag === null) throw argumentError("--to is a commit sha: name the destination stage whose settings files are diffed with --stage <name>");
  const stage = stages.find((candidate) => candidate.name === stageFlag);
  if (stage === undefined) throw argumentError(`unknown stage "${stageFlag}" (stages: ${stages.map((s) => s.name).join(", ")})`);
  return stage;
}

/** Runs `settings-diff`. @throws EngineError for exits without a report (64, 24, 29, 20, 21, 1). */
export async function runSettingsDiff(options: SettingsDiffOptions, context: CommandContext): Promise<CommandOutput> {
  // Names before any call.
  const skeleton = loadWorkspaceSkeleton(options.workspace);
  const ws = skeleton.workspace;
  if (!ws.members.some((member) => member.name === options.component)) {
    throw argumentError(`unknown component "${options.component}" (members: ${ws.members.map((m) => m.name).join(", ")})`);
  }
  const from = parseEndpoint("from", options.from, ws.stages, true);
  const to = parseEndpoint("to", options.to, ws.stages, false);
  const stage = destinationStage(to, options.stage, ws.stages);
  if (from.kind === "stage" && to.kind === "stage" && from.stage.name === to.stage.name) throw argumentError(`--from and --to name the same stage "${from.stage.name}"`);

  // Canonical load (24, 29); the member must be available (24).
  const loaded = loadWorkspace(options.workspace, { members: [options.component], canonical: "require" });
  const member = requireAvailableMember(loaded, options.component);
  const timeoutMs = ws.gitTimeoutSeconds * 1000;

  // Local endpoints first (64 / 21 before any adapter call), then ONE live read for stage endpoints.
  const local = new Map<string, EndpointResolution>();
  for (const [flag, spec] of [["from", from], ["to", to]] as const) {
    if (spec.kind !== "stage") local.set(flag, resolveLocalEndpoint(member, spec, flag, timeoutMs));
  }
  const stageSpecs = [from, to].filter((spec): spec is Extract<EndpointSpec, { kind: "stage" }> => spec.kind === "stage");
  const { preflight, observations } = await observeStages(ws, member, stageSpecs.map((spec) => spec.stage), context.env);
  const resolve = (flag: "from" | "to", spec: EndpointSpec): EndpointResolution => {
    if (spec.kind !== "stage") return local.get(flag) as EndpointResolution;
    const observation = observations.find((entry) => entry.stage.name === spec.stage.name);
    if (observation === undefined) throw new EngineError(EXIT.INTERNAL, "resolve", `stage ${spec.stage.name} was not observed`);
    return stageCommit(spec.token, observation);
  };
  const promoted = resolve("from", from);
  const deployed = resolve("to", to);

  const generatedAt = context.now().toISOString();
  const base = {
    schemaVersion: 1 as const,
    engineVersion: engineVersion(),
    command: "settings-diff" as const,
    generatedAt,
    workspace: { root: loaded.root, file: loaded.file },
    component: options.component,
    stage: stage.name,
    promoted,
    deployed,
    preflight,
  };

  // Unresolved endpoints: the report says why; nothing is substituted.
  if (promoted.status !== "resolved" || deployed.status !== "resolved") {
    const codes = [promoted, deployed].map((endpoint) => (endpoint.status === "resolved" ? EXIT.OK : endpoint.status === "missing" ? EXIT.MISSING : EXIT.SOURCE));
    const exitCode = pickExitCode(codes);
    const phase = exitCode === EXIT.MISSING ? "missing" : "resolve";
    const report: SettingsDiffReport = { ...base, componentConfig: null, declared: null, note: "not compared: an endpoint did not resolve to one commit", files: [], outcome: { exitCode, result: "FAIL", phase } };
    const reasons = [promoted, deployed].flatMap((endpoint) => (endpoint.status === "resolved" ? [] : [`release-radar: ${endpoint.token}: ${endpoint.detail}`]));
    return { exitCode, phase, stdout: render(report, options.json), stderr: reasons, json: options.json };
  }

  // component.json at the promoted commit declares the settings files (31d, 84).
  const atCommit = readComponentAtCommit(loaded, options.component, promoted.sha);
  if (atCommit.status === "git-error") throw new EngineError(EXIT.SOURCE, "git", `${atCommit.label}: ${atCommit.detail}`);
  if (atCommit.status === "missing") throw new EngineError(EXIT.INVALID, "load", `no component config at ${promoted.sha}: ${atCommit.detail}`, { file: atCommit.label });
  if (atCommit.status === "invalid") throw new EngineError(EXIT.INVALID, "load", `${atCommit.label} invalid at ${promoted.sha}: ${atCommit.error.describe()}`, atCommit.error.location);
  const componentConfig: ComponentConfigUsed = {
    revision: promoted.sha,
    label: atCommit.label,
    state: atCommit.state,
    differencesFromWorkingTree: componentDifferences(member.component, atCommit.component),
  };
  const entry = atCommit.component.stages[stage.name];
  const declared = entry?.handoff?.settingsFiles ?? [];
  let note: string | null = null;
  if (declared.length === 0) {
    note =
      stage.promotion.mode === "handoff"
        ? `no settings files declared for stage "${stage.name}" in component.json at ${promoted.sha.slice(0, 7)}`
        : `no settings files declared: stage "${stage.name}" is a "${stage.promotion.mode}" stage (handoff artefacts are declared only on handoff stages)`;
  }
  const files = declared.map((path) =>
    diffSettingsFile(path, analyzeSettings(settingsBytesAt(member, deployed.sha, path, timeoutMs)), analyzeSettings(settingsBytesAt(member, promoted.sha, path, timeoutMs))),
  );
  const report: SettingsDiffReport = { ...base, componentConfig, declared: [...declared], note, files, outcome: { exitCode: EXIT.OK, result: "OK", phase: "complete" } };
  return { exitCode: EXIT.OK, phase: "complete", stdout: render(report, options.json), stderr: [], json: options.json };
}

function describeEndpoint(endpoint: EndpointResolution): string {
  if (endpoint.status !== "resolved") return `${endpoint.token}: ${endpoint.status.toUpperCase()} — ${endpoint.detail}`;
  const where = endpoint.kind === "stage" ? `stage ${endpoint.stage ?? ""} (${endpoint.targets.join(", ")})` : endpoint.kind === "local" ? "local HEAD" : "commit";
  return `${endpoint.sha.slice(0, 7)}  ${where}${endpoint.subject === "" ? "" : ` — ${endpoint.subject}`}`;
}

function render(report: SettingsDiffReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [
    `release-radar settings-diff — ${report.component} → stage ${report.stage} (read-only; values are never shown)`,
    `  promoted: ${describeEndpoint(report.promoted)}`,
    `  deployed: ${describeEndpoint(report.deployed)}`,
  ];
  if (report.componentConfig !== null) {
    const config = report.componentConfig;
    lines.push(`  settings files from ${config.label}${config.state === "non-canonical" ? ` (non-canonical at ${config.revision.slice(0, 7)})` : ""}`);
    if (config.differencesFromWorkingTree.length > 0) lines.push(`  the working-tree component.json differs at: ${config.differencesFromWorkingTree.join(", ")}`);
  }
  for (const entry of report.preflight) lines.push(`  preflight ${entry.adapter}: ${entry.commands.join("; ") || "(no command)"}`);
  lines.push("");
  if (report.note !== null) lines.push(`  ${report.note}`);
  for (const file of report.files) lines.push(...renderSettingsFileDiff(file, "  "));
  return `${lines.join("\n")}\n`;
}
