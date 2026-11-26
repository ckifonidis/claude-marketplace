/**
 * Per-user workspace index (spec requirements 31f, 31g; plan decision D19).
 *
 * The index file path is ALWAYS passed in explicitly (the skill supplies
 * `${CLAUDE_PLUGIN_DATA}/workspace-index.json`); this module never derives it.
 * The file is canonical and schema-versioned. An index file that does not exist yet is the
 * documented empty initial state (it is created by the first `register`). A hand-edited (valid,
 * non-canonical) index is re-formatted by `format --index <file>`, with or without a workspace.
 *
 * Canonical key order: `schemaVersion`, `workspaces[]` (SORTED by `path`, identity `path`),
 * each `{ path }` — an absolute workspace root.
 *
 * Stale entries (the path is gone, or no longer holds a valid workspace) are reported by
 * `list` and `resolve` and are never removed except by an explicit `unregister`.
 *
 * {@link resolveWorkspaces} applies the fixed starting-location order of requirement 31f
 * (step (a), an explicit `--workspace`, is handled by the caller before it gets here):
 * - (b) `.release-radar/workspace.json` found searching upward from `cwd` to the git root
 *   (outside a git repository: `cwd` only);
 * - (c) `cwd` inside a member's mapped clone of a registered workspace → that workspace with the
 *   component pre-selected;
 * - (d) `cwd` inside a registered workspace's root.
 * The first step with a match wins; several matches are all returned (the skill asks); no
 * match returns none (the skill offers `init-workspace` or registration — it never guesses).
 */
import { existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_SCHEMA_VERSIONS, RELEASE_RADAR_DIR, WORKSPACE_FILE } from "./config.js";
import { EXIT, EngineError } from "./errors.js";
import { canonicalize, classify, render, t, validate } from "./format.js";
import { readTextFile } from "./files.js";
import { repoPathFor } from "./repo-paths.js";
import { isInside, loadWorkspaceSkeleton } from "./workspace.js";
/** Schema of the workspace index file. */
export const WORKSPACE_INDEX_SCHEMA = t.object([
    t.required("schemaVersion", t.schemaVersion(CONFIG_SCHEMA_VERSIONS)),
    t.required("workspaces", t.array(t.object([t.required("path", t.string({ pattern: /^(?:\/|[A-Za-z]:[\\/])/ }))]), { order: { sorted: "path" }, identity: "path" })),
]);
function realpathOrResolve(path) {
    const absolute = resolve(path);
    try {
        return realpathSync(absolute);
    }
    catch {
        return absolute;
    }
}
/**
 * Reads the index at `indexPath` (absent file = empty index).
 * @throws EngineError 24 when invalid; 29 when non-canonical and `canonical: "require"`.
 */
export function readIndex(indexPath, options) {
    const file = resolve(indexPath);
    if (!existsSync(file))
        return { file, exists: false, state: "canonical", changes: [], paths: [] };
    const result = classify(readTextFile(file, options.observer), WORKSPACE_INDEX_SCHEMA, file);
    if (result.state === "invalid" || result.value === undefined)
        throw result.error;
    if (result.state === "non-canonical" && options.canonical === "require") {
        throw new EngineError(EXIT.NON_CANONICAL, "canonical", `non-canonical input (run format first — \`format --index ${file}\` re-formats the index alone, no workspace needed): ${file}`, { file });
    }
    return { file, exists: true, state: result.state, changes: result.changes, paths: result.value.workspaces.map((entry) => entry.path) };
}
/** Canonical text of an index holding `paths`. */
export function renderIndex(paths) {
    const value = validate({ schemaVersion: 1, workspaces: paths.map((path) => ({ path })) }, WORKSPACE_INDEX_SCHEMA, "workspace-index");
    return render(canonicalize(value, WORKSPACE_INDEX_SCHEMA));
}
function writeIndex(file, paths) {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, renderIndex(paths), "utf8");
    renameSync(temporary, file);
}
/** Checks that `root` holds a valid workspace; returns the reason when it does not. */
function staleReason(root, observer) {
    let isDir = false;
    try {
        isDir = statSync(root).isDirectory();
    }
    catch {
        return "path no longer exists";
    }
    if (!isDir)
        return "path is not a directory";
    if (!existsSync(join(root, RELEASE_RADAR_DIR, WORKSPACE_FILE)))
        return `no ${RELEASE_RADAR_DIR}/${WORKSPACE_FILE}`;
    try {
        loadWorkspaceSkeleton(root, observer);
    }
    catch (error) {
        if (error instanceof EngineError)
            return `invalid workspace: ${error.describe()}`;
        throw error;
    }
    return null;
}
/** Every registered entry with its status; stale entries are reported, never dropped. */
export function listIndex(indexPath, options) {
    return readIndex(indexPath, options).paths.map((path) => {
        const reason = staleReason(path, options.observer);
        return reason === null ? { path, status: "ok" } : { path, status: "stale", reason };
    });
}
/**
 * Registers the workspace at `workspacePath` (stored as its absolute real path). Call only
 * after the user confirmed (spec requirement 31g).
 * @throws EngineError 24 when the path does not hold a valid workspace.
 */
export function registerWorkspace(indexPath, workspacePath, options) {
    const index = readIndex(indexPath, options);
    const skeleton = loadWorkspaceSkeleton(workspacePath, options.observer);
    const path = skeleton.root;
    if (index.paths.includes(path)) {
        if (index.state === "non-canonical")
            writeIndex(index.file, index.paths);
        return { result: "already-registered", path };
    }
    writeIndex(index.file, [...index.paths, path]);
    return { result: "registered", path };
}
/**
 * Removes `workspacePath` from the index (also when it is stale). Call only after the user
 * confirmed. The workspace itself is never touched.
 */
export function unregisterWorkspace(indexPath, workspacePath, options) {
    const index = readIndex(indexPath, options);
    const forms = new Set([resolve(workspacePath), realpathOrResolve(workspacePath)]);
    const kept = index.paths.filter((path) => !forms.has(path));
    const path = index.paths.find((candidate) => forms.has(candidate)) ?? realpathOrResolve(workspacePath);
    if (kept.length === index.paths.length)
        return { result: "not-registered", path };
    writeIndex(index.file, kept);
    return { result: "unregistered", path };
}
/** The nearest ancestor of `start` (inclusive) containing `.git`, or `null`. No git process is run. */
export function findGitRoot(start) {
    let dir = start;
    for (;;) {
        if (existsSync(join(dir, ".git")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/** Members whose mapped clone contains `cwd` (deepest clone only), through the repos file only. */
function membersContaining(skeleton, cwd) {
    let best = { depth: -1, names: [] };
    for (const member of skeleton.workspace.members) {
        if (member.repoKey === null)
            continue;
        const mapped = repoPathFor(skeleton.repoPaths, member.repoKey);
        if (mapped === undefined || !existsSync(mapped))
            continue;
        const clone = realpathOrResolve(mapped);
        if (!isInside(cwd, clone))
            continue;
        const depth = clone.length;
        if (depth > best.depth)
            best = { depth, names: [member.name] };
        else if (depth === best.depth)
            best.names.push(member.name);
    }
    return best.names;
}
function candidatesFor(root, step, components, registered) {
    if (components.length === 0)
        return [{ root, step, registered }];
    return components.map((component) => ({ root, step, component, registered }));
}
/**
 * Resolves the starting location for `cwd` in the fixed order (b), (c), (d) of requirement
 * 31f. Read-only: nothing is registered or removed.
 * @throws EngineError 64 when `cwd` does not exist; 24/29 for an invalid/non-canonical index.
 */
export function resolveWorkspaces(indexPath, cwd, options) {
    const start = realpathOrResolve(cwd);
    if (!existsSync(start))
        throw new EngineError(EXIT.ARGS, "arguments", `cwd does not exist: ${start}`);
    const index = readIndex(indexPath, options);
    const registered = new Set(index.paths);
    const statuses = index.paths.map((path) => ({ path, reason: staleReason(path, options.observer) }));
    const stale = statuses
        .filter((entry) => entry.reason !== null)
        .map((entry) => ({ path: entry.path, status: "stale", reason: entry.reason }));
    const valid = statuses.filter((entry) => entry.reason === null).map((entry) => entry.path);
    const skipped = [];
    // (b) upward search to the git root (outside a repository: cwd only).
    const gitRoot = findGitRoot(start);
    for (let dir = start;; dir = dirname(dir)) {
        if (existsSync(join(dir, RELEASE_RADAR_DIR, WORKSPACE_FILE))) {
            let components = [];
            try {
                components = membersContaining(loadWorkspaceSkeleton(dir, options.observer), start);
            }
            catch (error) {
                if (!(error instanceof EngineError))
                    throw error;
                skipped.push({ path: dir, reason: `component pre-selection skipped: ${error.describe()}` });
            }
            return { cwd: start, step: "b", candidates: candidatesFor(dir, "b", components, registered.has(dir)), stale, skipped };
        }
        if (gitRoot === null || dir === gitRoot || dirname(dir) === dir)
            break;
    }
    // (c) inside a member's mapped clone of a registered workspace.
    const viaClone = [];
    for (const root of valid) {
        let skeleton;
        try {
            skeleton = loadWorkspaceSkeleton(root, options.observer);
        }
        catch (error) {
            if (!(error instanceof EngineError))
                throw error;
            skipped.push({ path: root, reason: error.describe() });
            continue;
        }
        const components = membersContaining(skeleton, start);
        if (components.length > 0)
            viaClone.push(...candidatesFor(root, "c", components, true));
    }
    if (viaClone.length > 0)
        return { cwd: start, step: "c", candidates: viaClone, stale, skipped };
    // (d) inside a registered workspace root.
    const viaIndex = valid.filter((root) => isInside(start, root)).flatMap((root) => candidatesFor(root, "d", [], true));
    if (viaIndex.length > 0)
        return { cwd: start, step: "d", candidates: viaIndex, stale, skipped };
    return { cwd: start, step: "none", candidates: [], stale, skipped };
}
