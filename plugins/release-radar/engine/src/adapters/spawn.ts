/**
 * The one way adapters start a CLI (spec requirement 29; research §2).
 *
 * - argv only, never a shell; `stdin` closed; `windowsHide`;
 * - an explicit timeout (no default exists — callers pass the configured value) after which
 *   the child is killed with SIGKILL;
 * - a capped output buffer (the child is killed when stdout or stderr exceeds it);
 * - `ENOENT` / `EACCES` → `cli-missing` naming the binary.
 *
 * {@link invokeCli} maps an outcome onto the error contract: missing CLI → AuthError (20);
 * stderr classified by the shared table ({@link classifyStderr}) → AuthError (20) for auth or
 * a missing capability, `not-found` returned to the caller (who decides "missing"), anything
 * else → SourceError (21). A timeout is 21 unless the stderr captured so far identifies auth.
 */

import { spawn } from "node:child_process";
import { AuthError, SourceError, renderCommand } from "./types.js";
import { classifyStderr, type CliFamily } from "./stderr-patterns.js";

/** Default output cap per stream: 64 MiB (research §2). */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** What to run. */
export interface SpawnSpec {
  readonly bin: string;
  readonly args: readonly string[];
  /** Required; callers pass the configured `timeoutSeconds * 1000`. */
  readonly timeoutMs: number;
  /** Passed to the child unchanged (the PATH in it decides which binary runs). */
  readonly env: NodeJS.ProcessEnv;
  /** Per-stream cap; {@link MAX_OUTPUT_BYTES} when absent (documented semantics). */
  readonly maxOutputBytes?: number;
}

/** How a spawn ended. */
export type SpawnOutcome =
  | { readonly kind: "ok"; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "cli-missing"; readonly bin: string; readonly reason: string }
  | { readonly kind: "timeout"; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "overflow"; readonly stream: "stdout" | "stderr"; readonly limit: number }
  | { readonly kind: "spawn-error"; readonly message: string };

/**
 * Runs `bin args...` without a shell and resolves with the outcome. Never rejects.
 * @throws TypeError synchronously-in-promise only for a non-positive timeout (a programming error).
 */
export function runCli(spec: SpawnSpec): Promise<SpawnOutcome> {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
    return Promise.reject(new TypeError(`runCli: timeout must be a positive number of milliseconds, got ${spec.timeoutMs}`));
  }
  const limit = spec.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let settled = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.bin, [...spec.args], {
        env: spec.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ kind: "spawn-error", message: (error as Error).message });
      return;
    }

    const finish = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish({ kind: "timeout", stdout: text(out), stderr: text(err) });
    }, spec.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > limit) {
        kill();
        finish({ kind: "overflow", stream: "stdout", limit });
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > limit) {
        kill();
        finish({ kind: "overflow", stream: "stderr", limit });
        return;
      }
      err.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish({ kind: "cli-missing", bin: spec.bin, reason: "not found on PATH" });
      else if (error.code === "EACCES") finish({ kind: "cli-missing", bin: spec.bin, reason: "found but not executable" });
      else finish({ kind: "spawn-error", message: error.message });
    });
    child.on("close", (code, signal) => {
      const stdout = text(out);
      const stderr = text(err);
      finish(code === 0 ? { kind: "ok", stdout, stderr } : { kind: "exit", code, signal, stdout, stderr });
    });
  });
}

/** Operator hints an adapter supplies for its CLI. */
export interface CliHints {
  /** How to install the binary. */
  readonly install: string;
  /** How to (re-)authenticate; receives the classified error text (e.g. to echo a tenant). */
  readonly auth: (errorText: string) => string;
  /** How to add a missing capability (extension / plugin). */
  readonly capability: string;
}

/** A successful call, or the source's own "not found" answer. */
export type InvokeResult =
  | { readonly kind: "ok"; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "not-found"; readonly stderr: string };

/** First `lines` non-empty lines of `text`, each cut to 300 characters, joined by ` | `. */
export function excerpt(text: string, lines = 3): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, lines)
    .map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line))
    .join(" | ");
}

/**
 * Runs a CLI and maps the outcome onto the error contract (see the module comment).
 * `not-found` is returned only for the families whose table rows say so; the caller decides
 * whether that means `missing` (it never does for preflight).
 */
export async function invokeCli(spec: SpawnSpec, family: CliFamily, hints: CliHints): Promise<InvokeResult> {
  return mapOutcome(spec, await runCli(spec), family, hints);
}

/**
 * Maps a finished spawn onto the error contract (the second half of {@link invokeCli}), for
 * callers that must inspect an outcome first (e.g. `kubectl auth can-i` answers "no" with exit 1).
 */
export function mapOutcome(spec: SpawnSpec, outcome: SpawnOutcome, family: CliFamily, hints: CliHints): InvokeResult {
  const shown = renderCommand(spec.bin, spec.args);
  switch (outcome.kind) {
    case "ok":
      return { kind: "ok", stdout: outcome.stdout, stderr: outcome.stderr };
    case "cli-missing":
      throw new AuthError("cli-missing", spec.bin, `\`${spec.bin}\` is ${outcome.reason}`, hints.install);
    case "spawn-error":
      throw new SourceError(spec.bin, `could not start \`${spec.bin}\`: ${outcome.message}`);
    case "overflow":
      throw new SourceError(spec.bin, `\`${shown}\` wrote more than ${outcome.limit} bytes to ${outcome.stream}`);
    case "timeout": {
      const verdict = classifyStderr(family, `${outcome.stderr}\n${outcome.stdout}`);
      if (verdict.kind === "auth") {
        throw new AuthError("not-authenticated", spec.bin, `\`${shown}\` timed out waiting on authentication (${verdict.match?.meaning ?? "auth"})`, hints.auth(outcome.stderr));
      }
      throw new SourceError(spec.bin, `\`${shown}\` timed out after ${Math.round(spec.timeoutMs / 1000)}s`);
    }
    case "exit": {
      const combined = `${outcome.stderr}\n${outcome.stdout}`;
      const verdict = classifyStderr(family, combined);
      const detail = excerpt(outcome.stderr) || excerpt(outcome.stdout) || `exit ${outcome.code ?? outcome.signal ?? "?"}`;
      if (verdict.kind === "auth") {
        throw new AuthError("not-authenticated", spec.bin, `\`${shown}\` failed: ${verdict.match?.meaning ?? "authentication"} (${detail})`, hints.auth(combined));
      }
      if (verdict.kind === "capability-missing") {
        throw new AuthError("capability-missing", spec.bin, `\`${shown}\` failed: ${verdict.match?.meaning ?? "capability missing"} (${detail})`, hints.capability);
      }
      if (verdict.kind === "not-found") return { kind: "not-found", stderr: outcome.stderr };
      throw new SourceError(spec.bin, `\`${shown}\` exited ${outcome.code ?? `by signal ${outcome.signal ?? "?"}`}: ${detail}`);
    }
  }
}

/** Parses CLI JSON output or throws SourceError (21) naming the command. */
export function parseCliJson(stdout: string, bin: string, args: readonly string[]): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new SourceError(bin, `\`${renderCommand(bin, args)}\` returned output that is not JSON`);
  }
}
