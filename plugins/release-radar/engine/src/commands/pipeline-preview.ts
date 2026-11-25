/**
 * `pipeline-preview` — the exact run request and its confirmation token, READ-ONLY (spec
 * requirements 14, 59-62, 66-68, 73; plan D2, D7, Phase 7).
 *
 * ```
 * pipeline-preview --workspace <path> <component> --stage <name> [--target <name>]
 *                  [--action <name>] [--select <parameter>=<value>]... [--json]
 * ```
 *
 * Order (each step only after every earlier one succeeded; see `pipelines/preview.ts`):
 * 1. arguments, names (64); canonical load (24/29); triggerability, mapping, declared action and
 *    renderable parameters (26); userSelectable choices (64) — no request yet;
 * 2. PAT preflight (20 before any request);
 * 3. GETs only: Pipelines Get (existence, D7), Git Refs (the remote head = the commit to build).
 *    Never a POST — not even `previewRun`.
 *
 * Exit 0 with a token when nothing blocks; otherwise the full preview WITHOUT a token and exit 26
 * (a refusal: no ref check possible, commit not in the local clone, the mapping at the commit
 * differs) or 23 (the pipeline, repository or ref does not exist) — 26 wins by precedence.
 */

import { argumentError } from "../args.js";
import { EXIT, EngineError } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { openSession } from "../pipelines/collect.js";
import type { PatExpiry } from "../pipelines/pat.js";
import { blockerExit, computePreview, issueToken, resolvePreviewScope, type Preview, type PreviewRequest } from "../pipelines/preview.js";
import { REPORT_SCHEMA_VERSION, colours, useColour, type Colours } from "../report.js";
import { sleeper, type CommandContext, type CommandOutput } from "./types.js";

/** The PAT-absent message of `pipeline-preview` (spec requirement 70). */
export const PREVIEW_PAT_NEED = "pipeline-preview needs an Azure DevOps PAT with Build (Read) and Code (Read; the Git Refs remote-head check); no request was sent";

/** `pipeline-preview` options. */
export interface PipelinePreviewOptions extends PreviewRequest {
  readonly json: boolean;
}

/** The `pipeline-preview --json` document (schemaVersion 1, additive). */
export interface PipelinePreviewReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly engineVersion: string;
  readonly command: "pipeline-preview";
  readonly generatedAt: string;
  readonly workspace: { readonly root: string; readonly file: string };
  /** What was asked (the resolved values are in `preview`). */
  readonly scope: { readonly component: string; readonly stage: string; readonly target: string | null; readonly action: string | null; readonly selections: readonly string[] };
  readonly pat: PatExpiry;
  readonly preview: Preview;
  /** `null` when a blocker prevents the run. */
  readonly token: { readonly value: string; readonly expiresAt: string; readonly ttlMinutes: number } | null;
  readonly requests: { readonly method: "GET"; readonly count: number };
  readonly outcome: { readonly exitCode: number; readonly result: "OK" | "FAIL"; readonly phase: string };
}

/**
 * Rewraps a REST failure during a preview or a run's recomputation (20 / 21) so that it says
 * nothing was sent.
 */
export function remoteReadError(error: unknown): unknown {
  if (!(error instanceof EngineError) || (error.exitCode !== EXIT.AUTH && error.exitCode !== EXIT.SOURCE && error.exitCode !== EXIT.MISSING)) return error;
  const lead = error.exitCode === EXIT.AUTH ? "Azure DevOps authentication failed during the preview reads — NOT a missing pipeline; nothing was sent:" : "Azure DevOps read failed during the preview reads — nothing was sent:";
  return new EngineError(error.exitCode, "preflight", `${lead}\n  - ${error.describe()}`);
}

/** Runs `work`, rewrapping REST failures with {@link remoteReadError}. */
export async function previewReads<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw remoteReadError(error);
  }
}

/** The human rendering of a preview, shown VERBATIM by the promote skill (spec 60 step 3). */
export function renderPreview(preview: Preview, c: Colours): string[] {
  const lines: string[] = [];
  lines.push(`  organization  ${preview.organizationUrl}`);
  lines.push(`  project       ${preview.project}`);
  const pipeline = preview.pipeline.status === "found" ? `${preview.pipeline.id ?? ""} "${preview.pipeline.name ?? ""}"${preview.pipeline.link === null ? "" : c.dim(` ${preview.pipeline.link}`)}` : c.red(`MISSING — ${preview.pipeline.detail}`);
  lines.push(`  pipeline      ${pipeline}`);
  lines.push(`  stage         ${preview.stage.name} (mode ${preview.stage.mode}, owner ${preview.stage.owner ?? "none"} = operatorTeam: triggerable)`);
  lines.push(`  target        ${preview.target}`);
  lines.push(`  ref           ${preview.ref}${preview.repository === null ? "" : ` in repository ${preview.repository.value} (${preview.repository.source === "mapping" ? "from the mapping" : "from the pipeline's configuration"})`}`);
  lines.push(`  action        ${preview.action.name} (kind ${preview.action.kind}${preview.action.source === "primaryAction" ? "; no action given — the mapping's primaryAction" : ""})`);
  lines.push("  parameters    (every value sent as templateParameters)");
  for (const parameter of preview.parameters) {
    const from = parameter.source === "userSelectable" ? `userSelectable, chosen from ${(parameter.allowed ?? []).join(" | ")}` : `${parameter.source} ${JSON.stringify(parameter.template)}`;
    lines.push(`    ${parameter.name} = ${JSON.stringify(parameter.value)}${c.dim(`  (${from})`)}`);
  }
  if (preview.commit === null) lines.push(`  commit        ${c.red("not determined (see the blockers)")}`);
  else {
    lines.push(`  commit        ${c.bold(preview.commit.sha)} — the remote head of ${preview.ref} (exists on the remote ref: yes)`);
    lines.push(`                ${preview.commit.inLocalClone ? `${preview.commit.subject ?? ""}${c.dim(` (${preview.commit.date ?? ""})`)}` : c.red("NOT in the local clone")}`);
  }
  if (preview.localHead !== null) lines.push(`  local HEAD    ${preview.localHead.buildable ? preview.localHead.detail : c.yellow(preview.localHead.detail)}`);
  if (preview.componentAtCommit !== null) lines.push(`  config        ${preview.componentAtCommit.mappingMatches ? preview.componentAtCommit.detail : c.red(preview.componentAtCommit.detail)}`);
  const image = preview.image.status === "determined" ? `tag ${preview.image.tag ?? ""} — ${preview.image.detail}` : preview.image.detail;
  lines.push(`  image         ${image}`);
  lines.push(`  verification  ${preview.verification.detail}`);
  if (preview.request !== null) lines.push(`  request       exactly one queue request to ${preview.request.path} (Runs API, pinned to the commit; never retried)`);
  for (const blocker of preview.blockers) lines.push(`  ${c.red(`BLOCKED (exit ${blocker.exitCode}) — ${blocker.detail}`)}`);
  return lines;
}

/** Runs `pipeline-preview`. @throws EngineError for every exit that produces no report (64, 24, 29, 26, 20, 21, 1). */
export async function runPipelinePreview(options: PipelinePreviewOptions, context: CommandContext): Promise<CommandOutput> {
  if (options.stage === "") throw argumentError("--stage needs a value");
  const scope = resolvePreviewScope(options);
  const session = openSession(scope.ws, context.env, { now: context.now, sleep: sleeper(context), patNeed: PREVIEW_PAT_NEED });
  const preview = await previewReads(() => computePreview(scope, session.reader));
  const blocked = preview.blockers.length > 0;
  const token = !blocked && preview.binding !== null ? { ...issueToken(preview.binding, context.now(), scope.settings.confirmTokenTtlMinutes), ttlMinutes: scope.settings.confirmTokenTtlMinutes } : null;
  const exitCode = blocked ? blockerExit(preview.blockers) : EXIT.OK;
  const phase = blocked ? (exitCode === EXIT.REFUSED ? "refused" : "missing") : "preview";
  const report: PipelinePreviewReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    engineVersion: engineVersion(),
    command: "pipeline-preview",
    generatedAt: context.now().toISOString(),
    workspace: { root: scope.loaded.root, file: scope.loaded.file },
    scope: { component: options.component, stage: options.stage, target: options.target, action: options.action, selections: options.selections },
    pat: session.expiry,
    preview,
    token,
    requests: { method: "GET", count: session.reader.requestCount },
    outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
  };
  const stderr: string[] = [];
  if (blocked) stderr.push(`release-radar: the run is blocked (exit ${exitCode}); no confirmation token was issued: ${preview.blockers.map((blocker) => blocker.detail).join("; ")}`);
  if (session.expiry.warning) stderr.push(`release-radar: warning — ${session.expiry.detail}`);
  let stdout: string;
  if (options.json) stdout = `${JSON.stringify(report, null, 2)}\n`;
  else {
    const c = colours(useColour(false, context.stdout, context.env));
    const lines = [`release-radar pipeline-preview — ${preview.component} / ${preview.stage.name} / ${preview.target} (read-only: nothing is queued)`, "", ...renderPreview(preview, c), ""];
    if (token !== null) {
      lines.push(`  confirmation token (expires ${token.expiresAt}, ${token.ttlMinutes} minute(s)):`);
      lines.push(`    ${token.value}`);
      lines.push(c.dim("  The token binds every value above; run-pipeline refuses (27) if anything differs, the remote head moved, or it expired."));
    } else lines.push(c.red("  no confirmation token: the run is blocked"));
    lines.push(c.dim(`  ${session.expiry.detail}`));
    lines.push(c.dim(`  ${report.requests.count} Azure DevOps request(s), all GET; nothing was queued or changed.`));
    stdout = `${lines.join("\n")}\n`;
  }
  return { exitCode, phase, stdout, stderr, json: options.json };
}
