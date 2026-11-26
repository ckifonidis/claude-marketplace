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
import { classifyStderr } from "./stderr-patterns.js";
/** Default output cap per stream: 64 MiB (research §2). */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/**
 * Runs `bin args...` without a shell and resolves with the outcome. Never rejects.
 * @throws TypeError synchronously-in-promise only for a non-positive timeout (a programming error).
 */
export function runCli(spec) {
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
        return Promise.reject(new TypeError(`runCli: timeout must be a positive number of milliseconds, got ${spec.timeoutMs}`));
    }
    const limit = spec.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    return new Promise((resolve) => {
        let settled = false;
        const out = [];
        const err = [];
        let outBytes = 0;
        let errBytes = 0;
        const text = (chunks) => Buffer.concat(chunks).toString("utf8");
        let child;
        try {
            child = spawn(spec.bin, [...spec.args], {
                env: spec.env,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        }
        catch (error) {
            resolve({ kind: "spawn-error", message: error.message });
            return;
        }
        const finish = (outcome) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
        };
        const kill = () => {
            try {
                child.kill("SIGKILL");
            }
            catch {
                // already gone
            }
        };
        const timer = setTimeout(() => {
            kill();
            finish({ kind: "timeout", stdout: text(out), stderr: text(err) });
        }, spec.timeoutMs);
        child.stdout?.on("data", (chunk) => {
            outBytes += chunk.length;
            if (outBytes > limit) {
                kill();
                finish({ kind: "overflow", stream: "stdout", limit });
                return;
            }
            out.push(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            errBytes += chunk.length;
            if (errBytes > limit) {
                kill();
                finish({ kind: "overflow", stream: "stderr", limit });
                return;
            }
            err.push(chunk);
        });
        child.on("error", (error) => {
            if (error.code === "ENOENT")
                finish({ kind: "cli-missing", bin: spec.bin, reason: "not found on PATH" });
            else if (error.code === "EACCES")
                finish({ kind: "cli-missing", bin: spec.bin, reason: "found but not executable" });
            else
                finish({ kind: "spawn-error", message: error.message });
        });
        child.on("close", (code, signal) => {
            const stdout = text(out);
            const stderr = text(err);
            finish(code === 0 ? { kind: "ok", stdout, stderr } : { kind: "exit", code, signal, stdout, stderr });
        });
    });
}
/** First `lines` non-empty lines of `text`, each cut to 300 characters, joined by ` | `. */
export function excerpt(text, lines = 3) {
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
export async function invokeCli(spec, family, hints) {
    return mapOutcome(spec, await runCli(spec), family, hints);
}
/**
 * Maps a finished spawn onto the error contract (the second half of {@link invokeCli}), for
 * callers that must inspect an outcome first (e.g. `kubectl auth can-i` answers "no" with exit 1).
 */
export function mapOutcome(spec, outcome, family, hints) {
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
            if (verdict.kind === "not-found")
                return { kind: "not-found", stderr: outcome.stderr };
            throw new SourceError(spec.bin, `\`${shown}\` exited ${outcome.code ?? `by signal ${outcome.signal ?? "?"}`}: ${detail}`);
        }
    }
}
/** Parses CLI JSON output or throws SourceError (21) naming the command. */
export function parseCliJson(stdout, bin, args) {
    try {
        return JSON.parse(stdout);
    }
    catch {
        throw new SourceError(bin, `\`${renderCommand(bin, args)}\` returned output that is not JSON`);
    }
}
