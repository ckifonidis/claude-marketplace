/**
 * Shared Azure CLI plumbing for the `azure-appservice` and `azure-containerapp` adapters.
 *
 * Only read commands are ever built (`account show`, `webapp list`, `webapp config show`,
 * `containerapp show|list|revision list|--help`). The child environment is the engine's,
 * plus two fixed, non-credential variables:
 * - `AZURE_CORE_ONLY_SHOW_ERRORS=true` keeps warnings out of the parsed output;
 * - `AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no` forbids az from installing an extension on its
 *   own (an install is a write; release-radar only ever reports the missing extension).
 *
 * Stale auth is the failure that matters: `az account show` answers from the local cache, so
 * the first real ARM call is what fails. Every call's stderr is classified by the shared table,
 * so an expired grant is exit 20, never "missing".
 */

import { AuthError, renderCommand } from "./types.js";
import { invokeCli, parseCliJson, type CliHints, type InvokeResult } from "./spawn.js";
import { classifyStderr, tenantHintFrom } from "./stderr-patterns.js";

/** Operator hints for `az`. */
export const AZ_HINTS: CliHints = {
  install: "install the Azure CLI (`az`) and make sure it is on PATH",
  auth: (text) => {
    const tenant = tenantHintFrom(text);
    return tenant === null
      ? "run `az login` with an account that can read the configured subscriptions"
      : `run \`az login --tenant "${tenant}"\``;
  },
  capability: "run `az extension add --name containerapp` (release-radar never installs it)",
};

/** The environment for an az child: the engine's, unchanged, plus the two fixed variables above. */
export function azEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no" };
}

/** Runs `az <args> --output json`; returns parsed JSON, or `not-found` when ARM says so. */
export async function azJson(
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ kind: "ok"; value: unknown } | { kind: "not-found"; stderr: string }> {
  const full = [...args, "--output", "json"];
  const result: InvokeResult = await invokeCli({ bin: "az", args: full, timeoutMs, env: azEnv(env) }, "az", AZ_HINTS);
  if (result.kind === "not-found") return result;
  // az can exit 0 while printing a login problem instead of JSON (parity with the original engine).
  const trimmed = result.stdout.trim();
  if (trimmed === "" || !/^[[{"\dntf-]/.test(trimmed)) {
    const verdict = classifyStderr("az", `${result.stdout}\n${result.stderr}`);
    if (verdict.kind === "auth") {
      throw new AuthError("not-authenticated", "az", `\`${renderCommand("az", full)}\` reported: ${verdict.match?.meaning ?? "authentication"}`, AZ_HINTS.auth(result.stdout + result.stderr));
    }
  }
  return { kind: "ok", value: parseCliJson(result.stdout, "az", full) };
}

/**
 * `az account show`: proves a cached sign-in exists (NOT that it is still valid — the first
 * real read proves that). Returns the account name for display (never a secret).
 * @throws AuthError when there is no sign-in or az is missing.
 */
export async function azAccountShow(timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ command: string; identity: string | null }> {
  const args = ["account", "show"];
  const result = await azJson(args, timeoutMs, env);
  const command = renderCommand("az", [...args, "--output", "json"]);
  if (result.kind === "not-found") {
    throw new AuthError("not-authenticated", "az", `\`${command}\` found no signed-in account`, AZ_HINTS.auth(result.stderr));
  }
  const value = result.value as { name?: unknown; user?: { name?: unknown } } | null;
  const user = typeof value?.user?.name === "string" ? value.user.name : null;
  const name = typeof value?.name === "string" ? value.name : null;
  const identity = user !== null && name !== null ? `${user} (${name})` : user ?? name;
  return { command, identity };
}
