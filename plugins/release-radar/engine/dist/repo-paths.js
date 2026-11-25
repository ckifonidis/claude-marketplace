/**
 * Per-machine repository locations (spec requirements 36, 31b, 82b).
 *
 * Committed configuration names repositories by a stable `repoKey`; each machine maps keys to
 * clone paths in a repos file. Values are resolved against the repos file's directory.
 *
 * Two ownerships:
 * - `owned`: `.release-radar/repos.local.json`, release-radar's own canonical,
 *   schema-versioned file (gitignored). `format` may re-format it.
 * - `external`: a file of the same mapping shape owned by other tooling. It is validated but
 *   never rewritten and never refused as non-canonical ("externally owned — not re-formatted").
 *
 * No path is ever guessed: a missing or invalid file is fatal (24) and names the file; an
 * unmapped key is reported to the caller, which decides (member resolution reports it as
 * "unavailable (no local clone)").
 *
 * Canonical key order (owned): `schemaVersion`, `repos` (keys sorted).
 * External shape: `schemaVersion?`, `_comment?`, `repos` (the comment key is tolerated because
 * other tools share such files; nothing else is).
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONFIG_SCHEMA_VERSIONS, OWNED_REPOS_FILE, REPO_KEY_PATTERN } from "./config.js";
import { EXIT, EngineError } from "./errors.js";
import { canonicalize, classify, render, t, validate } from "./format.js";
import { readTextFile } from "./files.js";
const REPOS = t.record(t.string({ minLength: 1 }), { keyPattern: REPO_KEY_PATTERN });
/** Schema of the owned `.release-radar/repos.local.json`. */
export const REPOS_FILE_SCHEMA = t.object([
    t.required("schemaVersion", t.schemaVersion(CONFIG_SCHEMA_VERSIONS)),
    t.required("repos", REPOS),
]);
/** Schema of an externally owned repos file (validated, never rewritten). */
export const EXTERNAL_REPOS_FILE_SCHEMA = t.object([
    t.optional("schemaVersion", t.schemaVersion(CONFIG_SCHEMA_VERSIONS)),
    t.optional("_comment", t.string()),
    t.required("repos", REPOS),
]);
/**
 * Loads and validates a repos file.
 * @throws EngineError 24 when the file is missing, unparseable or fails its schema
 *   (with file, pointer and line/column).
 */
export function loadRepoPaths(path, ownership, observer) {
    const file = resolve(path);
    if (!existsSync(file)) {
        throw new EngineError(EXIT.INVALID, "load", `repos file not found: ${file}`, { file });
    }
    const text = readTextFile(file, observer);
    const schema = ownership === "owned" ? REPOS_FILE_SCHEMA : EXTERNAL_REPOS_FILE_SCHEMA;
    const result = classify(text, schema, file);
    if (result.state === "invalid" || result.value === undefined)
        throw result.error;
    const base = dirname(file);
    const repos = {};
    for (const [key, value] of Object.entries(result.value.repos))
        repos[key] = resolve(base, value);
    return { file, ownership, repos, state: result.state, changes: ownership === "owned" ? result.changes : [] };
}
/** The absolute clone path mapped to `key`, or `undefined` when the file does not map it. */
export function repoPathFor(paths, key) {
    return Object.hasOwn(paths.repos, key) ? paths.repos[key] : undefined;
}
/**
 * The absolute clone path mapped to `key`.
 * @throws EngineError 24 naming the file and the key when it is unmapped.
 */
export function requireRepoPath(paths, key) {
    const path = repoPathFor(paths, key);
    if (path === undefined) {
        throw new EngineError(EXIT.INVALID, "load", `repoKey "${key}" is not mapped in ${paths.file}`, { file: paths.file, pointer: `/repos` });
    }
    return path;
}
/** Canonical text of an owned repos file mapping `repos` (values as written, e.g. relative paths). */
export function renderOwnedReposFile(repos) {
    const value = validate({ schemaVersion: 1, repos: { ...repos } }, REPOS_FILE_SCHEMA, OWNED_REPOS_FILE);
    return render(canonicalize(value, REPOS_FILE_SCHEMA));
}
