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
import { parseImage } from "../image.js";
import { evaluateJsonPath } from "../json-path.js";
import { runCli, mapOutcome } from "./spawn.js";
import { AuthError, SourceError, missingReading, renderCommand, } from "./types.js";
function hintsFor(bin) {
    return {
        install: `install \`${bin}\` or correct argv[0] of the configured command`,
        auth: () => `authenticate or configure \`${bin}\` as its own documentation describes`,
        capability: `install what \`${bin}\` needs`,
    };
}
function specFor(argv, settings, runtime) {
    const [bin, ...args] = argv;
    if (bin === undefined)
        throw new SourceError("command", "a configured argv is empty");
    return { bin, args, timeoutMs: settings.timeoutSeconds * 1000, env: runtime.env };
}
/** Runs an argv; returns stdout on exit 0, throws AuthError (missing binary) or SourceError (everything else). */
async function runArgv(argv, settings, runtime) {
    const spec = specFor(argv, settings, runtime);
    const result = mapOutcome(spec, await runCli(spec), "command", hintsFor(spec.bin));
    // The "command" family has no stderr patterns, so "not-found" cannot occur; keep the type honest.
    if (result.kind !== "ok")
        throw new SourceError(spec.bin, `\`${renderCommand(spec.bin, spec.args)}\` failed`);
    return result.stdout;
}
/**
 * Applies a target's `extract` to a command's stdout (see the module comment for the rules).
 * @throws SourceError (21) when the output cannot be interpreted.
 */
export function extractImageReference(stdout, extract, shown) {
    if (stdout.trim() === "")
        return { kind: "missing", why: `\`${shown}\` printed nothing` };
    if (extract.type === "json-path") {
        let document;
        try {
            document = JSON.parse(stdout);
        }
        catch {
            throw new SourceError("command", `\`${shown}\` did not print JSON (extract ${extract.path})`);
        }
        const selected = evaluateJsonPath(document, extract.path);
        if (!selected.found)
            throw new SourceError("command", `\`${shown}\` output has no value at ${extract.path}: ${selected.reason}`);
        if (selected.value === null)
            return { kind: "missing", why: `\`${shown}\` reported null at ${extract.path}` };
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
function commandReading(request, reference, shown) {
    const image = parseImage(reference);
    const notes = [];
    if (image.kind === "invalid")
        notes.push(`the command printed an invalid image reference ${JSON.stringify(reference)}: ${image.reason}`);
    else if (image.kind !== "image")
        notes.push(`the command printed ${JSON.stringify(reference)}, which is ${image.kind}`);
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
export function createCommandAdapter(settings, runtime) {
    return {
        name: "command",
        async preflight(requests) {
            const seen = new Set();
            const commands = [];
            for (const request of requests) {
                const argv = request.target.preflightArgv;
                if (argv === undefined)
                    continue;
                const spec = specFor(argv, settings, runtime);
                const shown = renderCommand(spec.bin, spec.args);
                if (seen.has(shown))
                    continue;
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
        async read(requests) {
            const outputs = new Map();
            const readings = [];
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
export async function discoverCommand(settings, runtime) {
    if (settings.discoverArgv === undefined)
        return null;
    const stdout = await runArgv(settings.discoverArgv, settings, runtime);
    return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => ({ adapter: "command", stage: null, fields: { candidate: line }, image: null, state: null, details: {} }));
}
