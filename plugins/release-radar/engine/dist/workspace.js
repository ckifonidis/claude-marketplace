/**
 * Workspace loading and member resolution (spec requirements 31-31e, 37, 83, 84; D6, D17, D18).
 *
 * - The workspace is always given explicitly (`--workspace <path>`); nothing here searches.
 * - Members are located ONLY through the repos file (`repoKey` → clone). No directory is
 *   scanned or globbed, so worktree copies and look-alike siblings are never read.
 * - A member is `unavailable (no local clone)` when its `repoKey` is null/unmapped or the clone
 *   path does not exist, and `unavailable (no component config)` when the clone has no
 *   `component.json` at `<clone>[/<repoSubdir>]/.release-radar/component.json`. Unavailable is a
 *   reported state in a fleet run; it is fatal (24) only when that member was requested.
 * - Invalid files, a name mismatch, an undeclared stage and a duplicate repoKey+repoSubdir location are fatal (24);
 *   several members may share one repoKey with different repoSubdirs (monorepo).
 * - Non-canonical owned files make {@link loadWorkspace} fail with 29 when `canonical:
 *   "require"`; {@link inspectWorkspace} only reports them (for `format`).
 * - `component.json` at a commit ({@link readComponentAtCommit}) is used even when
 *   non-canonical (reported) and is a blocking finding — not a thrown error — when invalid.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { COMPONENT_FILE, COMPONENT_SCHEMA, OWNED_REPOS_FILE, RELEASE_RADAR_DIR, WORKSPACE_FILE, WORKSPACE_SCHEMA, checkComponent, checkWorkspace, memberSubdir, } from "./config.js";
import { EXIT, EngineError } from "./errors.js";
import { canonicalHash, canonicalStringify, canonicalize, classify } from "./format.js";
import { readTextFile } from "./files.js";
import { showFileAtCommit } from "./git.js";
import { loadRepoPaths, repoPathFor } from "./repo-paths.js";
function invalidError(file, message, pointer) {
    return new EngineError(EXIT.INVALID, "load", message, pointer === undefined ? { file } : { file, pointer });
}
function realpathOrResolve(path) {
    const absolute = resolve(path);
    try {
        return realpathSync(absolute);
    }
    catch {
        return absolute;
    }
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** True when `child` equals `parent` or lies below it (both absolute, normalised). */
export function isInside(child, parent) {
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
/**
 * The workspace root for an explicit `--workspace` value: the directory holding
 * `.release-radar/workspace.json`, or that file itself. Nothing is searched.
 */
export function workspaceRootOf(path) {
    const absolute = realpathOrResolve(path);
    if (absolute.endsWith(`${sep}${RELEASE_RADAR_DIR}${sep}${WORKSPACE_FILE}`))
        return dirname(dirname(absolute));
    return absolute;
}
/** Absolute `workspace.json` path of a workspace root. */
export function workspaceFileOf(root) {
    return join(root, RELEASE_RADAR_DIR, WORKSPACE_FILE);
}
/** Classifies a file; invalid → throws the located EngineError 24. */
function classifyOrThrow(text, schemaClassify) {
    const result = schemaClassify(text);
    if (result.state === "invalid" || result.value === undefined)
        throw result.error;
    return { value: result.value, state: result.state, changes: result.changes };
}
/**
 * Loads and validates `workspace.json` and its repos file only (no members).
 * @throws EngineError 24 for a missing/invalid workspace or repos file.
 */
export function loadWorkspaceSkeleton(path, observer) {
    const root = workspaceRootOf(path);
    const file = workspaceFileOf(root);
    if (!existsSync(file))
        throw invalidError(file, `workspace file not found: ${file}`);
    const parsed = classifyOrThrow(readTextFile(file, observer), (text) => classify(text, WORKSPACE_SCHEMA, file));
    checkWorkspace(parsed.value, file);
    const workspace = parsed.value;
    const reposPath = workspace.reposFile.kind === "owned" ? join(root, RELEASE_RADAR_DIR, OWNED_REPOS_FILE) : resolve(root, workspace.reposFile.path);
    const repoPaths = loadRepoPaths(reposPath, workspace.reposFile.kind, observer);
    return { root, file, workspace, report: { file, owner: "workspace-repo", state: parsed.state, changes: parsed.changes }, repoPaths };
}
function selectMembers(workspace, requested) {
    if (requested === "all")
        return [...workspace.members];
    const known = new Map(workspace.members.map((member) => [member.name, member]));
    const unknown = requested.filter((name) => !known.has(name));
    if (unknown.length > 0) {
        throw new EngineError(EXIT.ARGS, "arguments", `unknown component${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `"${name}"`).join(", ")} (members: ${workspace.members.map((member) => member.name).join(", ")})`);
    }
    return workspace.members.filter((member) => requested.includes(member.name));
}
/** `component.json` path relative to the repository root, `/`-separated. */
export function componentRepoPath(member) {
    const local = `${RELEASE_RADAR_DIR}/${COMPONENT_FILE}`;
    const subdir = memberSubdir(member);
    return subdir === null ? local : `${subdir}/${local}`;
}
/** Locates a member's clone through the repos file only. */
function locateClone(member, repoPaths) {
    if (member.repoKey === null)
        return { detail: `member "${member.name}" declares repoKey null (no clone by design)` };
    const mapped = repoPathFor(repoPaths, member.repoKey);
    if (mapped === undefined)
        return { detail: `repoKey "${member.repoKey}" is not mapped in ${repoPaths.file}` };
    if (!isDirectory(mapped))
        return { detail: `clone path ${mapped} (repoKey "${member.repoKey}") does not exist` };
    return { clone: realpathOrResolve(mapped) };
}
/**
 * Locates a member's clone and `component.json` through the repos file only — no directory is
 * scanned and no file is read. `unavailable` with the reason when the clone or the file is absent.
 */
export function locateMember(skeleton, member) {
    const located = locateClone(member, skeleton.repoPaths);
    if ("detail" in located)
        return { status: "unavailable", member, reason: "no-local-clone", detail: located.detail };
    const { clone } = located;
    const subdir = memberSubdir(member);
    const componentRoot = subdir === null ? clone : join(clone, ...subdir.split("/"));
    const componentFile = join(componentRoot, RELEASE_RADAR_DIR, COMPONENT_FILE);
    if (!existsSync(componentFile)) {
        return { status: "unavailable", member, reason: "no-component-config", detail: `${componentFile} does not exist`, clone };
    }
    // Single-repo projects (31e): the member's clone IS the workspace repository.
    return { status: "located", member, clone, componentRoot, componentFile, owner: clone === skeleton.root ? "workspace-repo" : "member-repo" };
}
function resolveMember(skeleton, member, observer) {
    const located = locateMember(skeleton, member);
    if (located.status === "unavailable")
        return located;
    const { clone, componentRoot, componentFile, owner } = located;
    const parsed = classifyOrThrow(readTextFile(componentFile, observer), (text) => classify(text, COMPONENT_SCHEMA, componentFile));
    checkComponent(parsed.value, skeleton.workspace, member.name, componentFile, skeleton.file);
    return {
        status: "available",
        member,
        clone,
        componentRoot,
        componentFile,
        componentRepoPath: componentRepoPath(member),
        component: parsed.value,
        report: { file: componentFile, owner, state: parsed.state, changes: parsed.changes },
    };
}
/**
 * Loads the workspace, its repos file and the selected members' working-tree
 * `component.json` files, reporting (never refusing) non-canonical files.
 * @throws EngineError 64 for an unknown requested member; 24 for any invalid file, a
 *   cross-check failure, a missing fleet checklist, or an unavailable requested member.
 */
export function inspectWorkspace(path, options) {
    const skeleton = loadWorkspaceSkeleton(path, options.observer);
    const { workspace, root, file } = skeleton;
    const selected = selectMembers(workspace, options.members);
    let checklistFile = null;
    if (workspace.checklist !== null) {
        checklistFile = join(root, ...workspace.checklist.split("/"));
        if (!existsSync(checklistFile)) {
            throw new EngineError(EXIT.INVALID, "load", `configured checklist ${checklistFile} does not exist`, { file, pointer: "/checklist" });
        }
    }
    const members = selected.map((member) => resolveMember(skeleton, member, options.observer));
    if (options.members !== "all") {
        for (const resolution of members) {
            if (resolution.status === "unavailable") {
                throw new EngineError(EXIT.INVALID, "load", `requested member "${resolution.member.name}" is unavailable (${resolution.reason === "no-local-clone" ? "no local clone" : "no component config"}): ${resolution.detail}`, { file, pointer: `/members/${workspace.members.indexOf(resolution.member)}/repoKey` });
            }
        }
    }
    const reposReport = {
        file: skeleton.repoPaths.file,
        owner: skeleton.repoPaths.ownership === "external" ? "external" : "workspace-repo",
        state: skeleton.repoPaths.state,
        changes: skeleton.repoPaths.changes,
    };
    const owned = [skeleton.report];
    if (reposReport.owner !== "external")
        owned.push(reposReport);
    for (const resolution of members)
        if (resolution.status === "available")
            owned.push(resolution.report);
    const nonCanonical = owned.filter((report) => report.state === "non-canonical");
    return { ...skeleton, checklistFile, reposReport, members, nonCanonical };
}
/**
 * {@link inspectWorkspace}, then — with `canonical: "require"` — refuses non-canonical owned
 * input with exit 29 naming every such file (D6, spec requirement 83).
 */
export function loadWorkspace(path, options) {
    const loaded = inspectWorkspace(path, options);
    const first = loaded.nonCanonical[0];
    if (options.canonical === "require" && first !== undefined) {
        const files = loaded.nonCanonical.map((report) => report.file).join(", ");
        throw new EngineError(EXIT.NON_CANONICAL, "canonical", `non-canonical input (run format first): ${files}`, { file: first.file });
    }
    return loaded;
}
/**
 * The loaded member `name`.
 * @throws EngineError 64 when `name` is not a member (valid names listed), 24 when the member
 *   was not selected or is unavailable.
 */
export function requireAvailableMember(loaded, name) {
    if (!loaded.workspace.members.some((member) => member.name === name)) {
        throw new EngineError(EXIT.ARGS, "arguments", `unknown component "${name}" (members: ${loaded.workspace.members.map((m) => m.name).join(", ")})`);
    }
    const resolution = loaded.members.find((candidate) => candidate.member.name === name);
    if (resolution === undefined)
        throw new EngineError(EXIT.INTERNAL, "load", `member "${name}" was not loaded`);
    if (resolution.status === "unavailable") {
        throw new EngineError(EXIT.INVALID, "load", `member "${name}" is unavailable: ${resolution.detail}`, { file: loaded.file });
    }
    return resolution;
}
/**
 * Reads a member's `component.json` at commit `sha` via `git show` (never rewritten). An
 * invalid file — including a failed cross-check — is returned as a blocking finding.
 * @throws EngineError 24 when the member has no local clone.
 */
export function readComponentAtCommit(loaded, memberName, sha) {
    const member = loaded.workspace.members.find((candidate) => candidate.name === memberName);
    if (member === undefined)
        throw new EngineError(EXIT.ARGS, "arguments", `unknown component "${memberName}"`);
    const located = locateClone(member, loaded.repoPaths);
    if ("detail" in located)
        throw new EngineError(EXIT.INVALID, "load", `member "${memberName}" is unavailable: ${located.detail}`, { file: loaded.file });
    const repoPath = componentRepoPath(member);
    const label = `${sha}:${repoPath}`;
    const timeoutMs = loaded.workspace.gitTimeoutSeconds * 1000;
    const shown = showFileAtCommit(located.clone, sha, repoPath, timeoutMs);
    if (shown.status !== "ok")
        return { status: shown.status, label, detail: shown.detail };
    const result = classify(shown.text, COMPONENT_SCHEMA, label);
    if (result.state === "invalid" || result.value === undefined)
        return { status: "invalid", label, error: result.error };
    try {
        checkComponent(result.value, loaded.workspace, member.name, label, loaded.file);
    }
    catch (error) {
        if (error instanceof EngineError)
            return { status: "invalid", label, error };
        throw error;
    }
    return { status: "ok", label, component: result.value, state: result.state, changes: result.changes };
}
function diffInto(a, b, pointer, out) {
    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    if (isObject(a) && isObject(b)) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        for (const key of keys) {
            const child = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
            if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key))
                out.push(child);
            else
                diffInto(a[key], b[key], child, out);
        }
        return;
    }
    if (canonicalStringify(a) !== canonicalStringify(b))
        out.push(pointer === "" ? "(root)" : pointer);
}
/**
 * JSON pointers of the keys that differ between two `component.json` revisions (e.g. working
 * tree vs promoted commit, spec requirement 31d). Both sides are compared in canonical form, so
 * pure re-formatting yields no difference. Arrays are compared whole.
 */
export function componentDifferences(a, b) {
    const out = [];
    diffInto(canonicalize(a, COMPONENT_SCHEMA), canonicalize(b, COMPONENT_SCHEMA), "", out);
    return out;
}
/**
 * Fingerprint of the configuration a report used (spec requirement 50): sha256 over the
 * canonical form of the workspace plus each `component.json` (keyed by member name), so
 * re-formatting changes nothing and a real configuration change does.
 */
export function configFingerprint(workspace, components) {
    const canonicalComponents = {};
    for (const name of Object.keys(components).sort()) {
        canonicalComponents[name] = canonicalize(components[name], COMPONENT_SCHEMA);
    }
    return canonicalHash({ components: canonicalComponents, workspace: canonicalize(workspace, WORKSPACE_SCHEMA) });
}
