/**
 * `command` adapter (spec requirement 28): a configured argv, executed WITHOUT a shell.
 *
 * The engine cannot verify that a configured command is read-only — that responsibility lies
 * with the config author; `validate-config` prints every configured command and the skill
 * shows them to the user the first time it uses a config.
 *
 * - preflight: each distinct `preflightArgv` runs once; exit 0 = ready, any other exit → exit 20
 *   (the tool is not ready / not authenticated); a missing binary → exit 20 naming it. Without
 *   `preflightArgv` nothing runs at preflight.
 * - read: `argv` runs once per target (identical argv are run once per read). The child gets
 *   the engine's environment unchanged. Outcomes:
 *   - non-zero exit, timeout, over-sized output → exit 21 (stderr is never interpreted);
 *   - exit 0 with empty (whitespace-only) stdout → target `missing`;
 *   - `extract.type = "json-path"`: stdout must be JSON (else 21); the path ({@link evaluateJsonPath})
 *     must select a string (→ found) or JSON `null` (→ `missing`); absent or another type → 21;
 *   - `extract.type = "regex"`: the pattern (Unicode flag) must match with a non-empty named
 *     group `image` (→ found); no match → 21.
 *   The extracted reference goes through the shared parser (`parseImage`); an invalid
 *   reference is reported as found with an `invalid` image and a note.
 * - The command reports only an image: `state` and `lastModified` are `null`; runtime digests
 *   are `not-exposed` (a digest written in the reference stays in `image`).
 */

import type { Workspace } from "../config.js";
import { parseImage } from "../image.js";
import { evaluateJsonPath } from "../json-path.js";
import { runCli, mapOutcome, type CliHints, type SpawnSpec } from "./spawn.js";
import {
  AuthError,
  SourceError,
  missingReading,
  renderCommand,
  type Adapter,
  type AdapterRuntime,
  type DiscoverCandidate,
  type PreflightResult,
  type TargetOf,
  type TargetReading,
  type TargetRequest,
} from "./types.js";

/** The workspace's `adapters.command` block. */
export type CommandSettings = NonNullable<Workspace["adapters"]["command"]>;

type Request = TargetRequest<TargetOf<"command">>;
type ExtractSpec = TargetOf<"command">["extract"];

function hintsFor(bin: string): CliHints {
  return {
    install: `install \`${bin}\` or correct argv[0] of the configured command`,
    auth: () => `authenticate or configure \`${bin}\` as its own documentation describes`,
    capability: `install what \`${bin}\` needs`,
  };
}

function specFor(argv: readonly string[], settings: CommandSettings, runtime: AdapterRuntime): SpawnSpec {
  const [bin, ...args] = argv;
  if (bin === undefined) throw new SourceError("command", "a configured argv is empty");
  return { bin, args, timeoutMs: settings.timeoutSeconds * 1000, env: runtime.env };
}

/** Runs an argv; returns stdout on exit 0, throws AuthError (missing binary) or SourceError (everything else). */
async function runArgv(argv: readonly string[], settings: CommandSettings, runtime: AdapterRuntime): Promise<string> {
  const spec = specFor(argv, settings, runtime);
  const result = mapOutcome(spec, await runCli(spec), "command", hintsFor(spec.bin));
  // The "command" family has no stderr patterns, so "not-found" cannot occur; keep the type honest.
  if (result.kind !== "ok") throw new SourceError(spec.bin, `\`${renderCommand(spec.bin, spec.args)}\` failed`);
  return result.stdout;
}

/** Result of {@link extractImageReference}. */
export type ExtractResult = { readonly kind: "reference"; readonly value: string } | { readonly kind: "missing"; readonly why: string };

/**
 * Applies a target's `extract` to a command's stdout (see the module comment for the rules).
 * @throws SourceError (21) when the output cannot be interpreted.
 */
export function extractImageReference(stdout: string, extract: ExtractSpec, shown: string): ExtractResult {
  if (stdout.trim() === "") return { kind: "missing", why: `\`${shown}\` printed nothing` };
  if (extract.type === "json-path") {
    let document: unknown;
    try {
      document = JSON.parse(stdout);
    } catch {
      throw new SourceError("command", `\`${shown}\` did not print JSON (extract ${extract.path})`);
    }
    const selected = evaluateJsonPath(document, extract.path);
    if (!selected.found) throw new SourceError("command", `\`${shown}\` output has no value at ${extract.path}: ${selected.reason}`);
    if (selected.value === null) return { kind: "missing", why: `\`${shown}\` reported null at ${extract.path}` };
    if (typeof selected.value !== "string" || selected.value.trim() === "") {
      throw new SourceError("command", `\`${shown}\` output at ${extract.path} is not a non-empty string`);
    }
    return { kind: "reference", value: selected.value };
  }
  const match = new RegExp(extract.pattern, "u").exec(stdout);
  const value = match?.groups?.["image"];
  if (value === undefined || value.trim() === "") {
    throw new SourceError("command", `\`${shown}\` output does not match the extract pattern (named group "image")`);
  }
  return { kind: "reference", value };
}

/** Builds the reading for a found reference. */
function commandReading(request: Request, reference: string, shown: string): TargetReading {
  const image = parseImage(reference);
  const notes: string[] = [];
  if (image.kind === "invalid") notes.push(`the command printed an invalid image reference ${JSON.stringify(reference)}: ${image.reason}`);
  else if (image.kind !== "image") notes.push(`the command printed ${JSON.stringify(reference)}, which is ${image.kind}`);
  return {
    key: request.key,
    stage: request.stage,
    target: request.target.name,
    adapter: "command",
    status: "found",
    image,
    containers: image.kind === "image" ? [{ name: null, image, source: `command ${shown}`, digest: null, imageId: null, trafficWeight: null }] : [],
    state: null,
    lastModified: null,
    lastModifiedSource: null,
    digest: null,
    imageId: null,
    digestStatus: "not-exposed",
    mixed: false,
    rollout: null,
    details: { command: shown },
    notes,
  };
}

/** Creates the `command` adapter. */
export function createCommandAdapter(settings: CommandSettings, runtime: AdapterRuntime): Adapter<"command"> {
  return {
    name: "command",
    async preflight(requests): Promise<PreflightResult> {
      const seen = new Set<string>();
      const commands: string[] = [];
      for (const request of requests) {
        const argv = request.target.preflightArgv;
        if (argv === undefined) continue;
        const spec = specFor(argv, settings, runtime);
        const shown = renderCommand(spec.bin, spec.args);
        if (seen.has(shown)) continue;
        seen.add(shown);
        commands.push(shown);
        const outcome = await runCli(spec);
        if (outcome.kind === "exit") {
          throw new AuthError("not-authenticated", spec.bin, `preflight \`${shown}\` exited ${outcome.code ?? `by signal ${outcome.signal ?? "?"}`}`, hintsFor(spec.bin).auth(""));
        }
        mapOutcome(spec, outcome, "command", hintsFor(spec.bin));
      }
      return { adapter: "command", commands, identity: null };
    },
    async read(requests): Promise<TargetReading[]> {
      const outputs = new Map<string, string>();
      const readings: TargetReading[] = [];
      for (const request of requests) {
        const spec = specFor(request.target.argv, settings, runtime);
        const shown = renderCommand(spec.bin, spec.args);
        let stdout = outputs.get(shown);
        if (stdout === undefined) {
          stdout = await runArgv(request.target.argv, settings, runtime);
          outputs.set(shown, stdout);
        }
        const extracted = extractImageReference(stdout, request.target.extract, shown);
        readings.push(extracted.kind === "missing" ? missingReading(request, extracted.why, { command: shown }) : commandReading(request, extracted.value, shown));
      }
      return readings;
    },
  };
}

/**
 * Lists candidates through the workspace's optional `adapters.command.discoverArgv`: one
 * candidate per non-empty stdout line (trimmed), in output order. Without `discoverArgv`
 * the command adapter cannot discover (spec Assumption 6) and this returns `null`.
 */
export async function discoverCommand(settings: CommandSettings, runtime: AdapterRuntime): Promise<DiscoverCandidate[] | null> {
  if (settings.discoverArgv === undefined) return null;
  const stdout = await runArgv(settings.discoverArgv, settings, runtime);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => ({ adapter: "command" as const, stage: null, fields: { candidate: line }, image: null, state: null, details: {} }));
}
