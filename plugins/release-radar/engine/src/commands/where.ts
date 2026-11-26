/**
 * `where` (spec requirement 12; plan decision D11): prints the plugin root and the engine root,
 * derived only from the engine's own location (`import.meta.url`). The skills use it to confirm
 * that `${CLAUDE_PLUGIN_ROOT}` was substituted. Reads nothing else.
 */

import { EXIT } from "../errors.js";
import { engineRoot, engineVersion, pluginRoot } from "../engine-info.js";
import type { CommandContext, CommandOutput } from "./types.js";

/** Runs `where`. */
export function runWhere(options: { readonly json: boolean }, _context: CommandContext): CommandOutput {
  const document = { schemaVersion: 1, pluginRoot: pluginRoot(), engineRoot: engineRoot(), engineVersion: engineVersion() };
  const stdout = options.json
    ? `${JSON.stringify(document, null, 2)}\n`
    : `plugin-root: ${document.pluginRoot}\nengine-root: ${document.engineRoot}\nengine-version: ${document.engineVersion}\n`;
  return { exitCode: EXIT.OK, phase: "complete", stdout, stderr: [], json: options.json };
}
