/**
 * `workspace-index list | resolve <cwd> | register <path> | unregister <path>` (spec
 * requirements 31f, 31g; plan decision D19). The index file is always explicit (`--index`).
 *
 * - `list` / `resolve` are read-only and refuse a non-canonical index (29, D6); the message points
 *   at `format --index <file>`, which re-formats the index alone (no workspace needed).
 * - `register` / `unregister` write only the index file (always canonically), and are run by the
 *   skill only after the user confirmed. Stale entries are reported, never removed implicitly.
 */

import { argumentError } from "../args.js";
import { EXIT } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { listIndex, registerWorkspace, resolveWorkspaces, unregisterWorkspace } from "../workspace-index.js";
import type { CommandContext, CommandOutput } from "./types.js";

/** The `workspace-index` actions. */
export const INDEX_ACTIONS = ["list", "resolve", "register", "unregister"] as const;

/** Parsed `workspace-index` options. */
export interface IndexCommandOptions {
  readonly action: string;
  /** The `<cwd>` / `<path>` operand. */
  readonly operand: string | null;
  readonly index: string;
  readonly json: boolean;
}

function output(json: boolean, document: Record<string, unknown>, lines: string[]): CommandOutput {
  return {
    exitCode: EXIT.OK,
    phase: "complete",
    stdout: json ? `${JSON.stringify({ schemaVersion: 1, engineVersion: engineVersion(), command: "workspace-index", ...document }, null, 2)}\n` : `${lines.join("\n")}\n`,
    stderr: [],
    json,
  };
}

/** Runs one `workspace-index` action. @throws EngineError 64/24/29. */
export function runWorkspaceIndex(options: IndexCommandOptions, _context: CommandContext): CommandOutput {
  const { action, operand } = options;
  if (!(INDEX_ACTIONS as readonly string[]).includes(action)) {
    throw argumentError(`unknown workspace-index action "${action}" (actions: ${INDEX_ACTIONS.join(", ")})`);
  }
  if (action === "list") {
    if (operand !== null) throw argumentError(`workspace-index list takes no operand`);
    const entries = listIndex(options.index, { canonical: "require" });
    const lines = [`release-radar workspace index ${options.index}`];
    if (entries.length === 0) lines.push("  no registered workspace");
    for (const entry of entries) lines.push(`  ${entry.status === "ok" ? "ok   " : "STALE"}  ${entry.path}${entry.reason === undefined ? "" : `  (${entry.reason}; remove with unregister after confirming)`}`);
    return output(options.json, { action, index: options.index, entries }, lines);
  }
  if (operand === null) throw argumentError(`workspace-index ${action} needs ${action === "resolve" ? "<cwd>" : "<path>"}`);
  if (action === "resolve") {
    const result = resolveWorkspaces(options.index, operand, { canonical: "require" });
    const lines = [`release-radar workspace resolve ${result.cwd} — step ${result.step}`];
    if (result.candidates.length === 0) lines.push("  no workspace matches (offer init-workspace or registration; nothing is guessed)");
    if (result.candidates.length > 1) lines.push(`  ${result.candidates.length} candidates — the user must choose`);
    for (const candidate of result.candidates) {
      lines.push(`  (${candidate.step}) ${candidate.root}${candidate.component === undefined ? "" : `  component ${candidate.component}`}${candidate.registered ? "" : "  (not registered)"}`);
    }
    for (const entry of result.stale) lines.push(`  stale index entry: ${entry.path} (${entry.reason ?? ""})`);
    for (const entry of result.skipped) lines.push(`  skipped: ${entry.path} (${entry.reason})`);
    return output(options.json, { action, index: options.index, ...result }, lines);
  }
  if (action === "register") {
    const result = registerWorkspace(options.index, operand, { canonical: "report" });
    return output(options.json, { action, index: options.index, ...result }, [`release-radar workspace-index: ${result.result} ${result.path}`]);
  }
  const result = unregisterWorkspace(options.index, operand, { canonical: "report" });
  return output(options.json, { action, index: options.index, ...result }, [`release-radar workspace-index: ${result.result} ${result.path}`]);
}
