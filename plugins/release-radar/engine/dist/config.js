/**
 * Schemas and strict semantic validation for `.release-radar/workspace.json` and
 * `.release-radar/component.json` (spec requirements 31-37, 40, 40a; plan decision D17).
 *
 * Shape is checked by the Phase 1 DSL (`format.ts`); every rule the DSL cannot express is
 * checked here and fails with EngineError 24 at a JSON pointer naming the key. Nothing is
 * ever defaulted. Where an optional key is absent, the documented semantics are stated at the
 * key (e.g. an absent tag-convention override means "the stage's convention applies") — these
 * are semantics, not fallbacks.
 *
 * This module is pure (no file system); `workspace.ts` loads files and cross-checks paths.
 *
 * ## Canonical key order — `workspace.json` (schemaVersion 1)
 * ```
 * schemaVersion
 * operatorTeam?                  string; required when any stage declares promotion.owner
 * stages[]        ORDERED (lifecycle order), identity name
 *   name                         not "local" (reserved)
 *   tagConvention                { type: "sha" }
 *                                { type: "git-tag", gitTagPrefix }
 *                                { type: "regex", pattern, resolveAs: { type: "sha" } | { type: "git-tag", gitTagPrefix } }
 *                                { type: "none" }
 *   promotion
 *     mode                       pipeline | handoff | manual | none
 *     owner?                     required unless mode is "none"
 * members[]       SORTED by name, identity name
 *   name
 *   repoKey                      string, or null (= no clone by design)
 *   repoSubdir                   string, or null (= the repository root); `./x`, `x/` normalise to `x`
 * reposFile                      { kind: "owned" } (.release-radar/repos.local.json)
 *                                { kind: "external", path } (validated, never rewritten)
 * gitTimeoutSeconds
 * freshnessMinutes
 * checklist                      path to the fleet checks.md, or null (= no fleet layer)
 * beforePromote?                 { <stage>: <pointer> } (keys sorted)
 * snapshotRetention
 * handoffRetention
 * adapters                       each key optional; required when a member uses that adapter
 *   azure-appservice?            timeoutSeconds, stageSubscriptions { <stage>: [ids SORTED] }
 *   azure-containerapp?          timeoutSeconds
 *   kubernetes?                  timeoutSeconds
 *   compose?                     timeoutSeconds
 *   command?                     timeoutSeconds, discoverArgv[]? ORDERED (optional list command for
 *                                `discover`: one candidate per stdout line; absent = the command
 *                                adapter cannot discover)
 * azureDevOps?                   required when any member declares a pipeline mapping
 *   organizationUrl, project, requestTimeoutSeconds, runHistoryCount, followPollSeconds,
 *   followTimeoutMinutes, confirmTokenTtlMinutes, patExpiryWarningDays
 * ```
 * Paths in `workspace.json` are relative to the workspace root (the directory holding
 * `.release-radar/`), `/`-separated; `..` is allowed only in `reposFile.path`.
 *
 * ## Canonical key order — `component.json` (schemaVersion 1)
 * ```
 * schemaVersion
 * name                           must equal the member name
 * tagConventionOverrides?        { <stage>: <tagConvention> } (absent stage = stage convention)
 * stages                         { <stage>: <entry> | null } — EVERY workspace stage, null = not deployed
 *   targets[]     SORTED by name, identity name, at least one
 *     name
 *     adapter                    azure-appservice:   webapp
 *                                azure-containerapp: subscription, resourceGroup, app
 *                                kubernetes:         context, namespace, deployment
 *                                compose:            project, service
 *                                command:            argv[] ORDERED, extract, preflightArgv[]? ORDERED
 *     pipeline?                  only on pipeline stages
 *       provider                 "azure-devops"
 *       project?                 absent = workspace azureDevOps.project
 *       pipelineId?, pipelineName?   at least one
 *       repository?              the Azure Repos Git repository (name or id) holding `ref` — the
 *                                repository of the remote-head check (plan D2). Absent = taken
 *                                from Pipelines Get `configuration.repository` when it is an
 *                                Azure Repos Git repository; neither → run-pipeline refuses (26)
 *       ref                      refs/heads/... | refs/tags/...
 *       parameters               { <name>: literal or {placeholder} } (keys sorted)
 *       userSelectable?          { <name>: [allowed values SORTED] }
 *       imageTagParameter?       a key of "parameters": the run's templateParameters value of
 *                                that parameter IS the pushed image tag (plan D10, source 1)
 *       pushedTagTemplate?       how the pipeline derives the tag it pushes from the run's source
 *                                commit, written with {commit.sha} {commit.shortSha} {component}
 *                                {target} and literals (plan D10, source 2: the tag convention the
 *                                pipeline follows). Absent = no convention stated
 *       actions                  { <name>: { kind: build | configuration, parameters { ... } } }
 *       primaryAction
 *       landedWaitMinutes
 *   handoff?                     only on handoff stages
 *     settingsFiles[] SORTED     paths relative to the component root
 *     beforePromote?
 *   verification?
 *     timeoutSeconds             applies to every check that sets none (documented semantics)
 *     checks[]    SORTED by name, identity name
 *       { name, type: "http", target?, url, method: GET|HEAD, expectStatus[] ORDERED, headers?, timeoutSeconds? }
 *       { name, type: "version", target?, url, extract, compare: commit|tag, headers?, timeoutSeconds? }
 *       { name, type: "smoke", target?, argv[] ORDERED, timeoutSeconds? }
 *       headers: { <Header-Name>: { env: <ENV_VAR_NAME> } } — never an inline value
 *       extract: { type: "json-path", path } | { type: "regex", pattern } (group "version")
 * ```
 * Records (`{ <key>: ... }`) are always rendered with sorted keys.
 */
import { EXIT, EngineError } from "./errors.js";
import { childPointer } from "./pointer.js";
import { t } from "./schema.js";
// ---------------------------------------------------------------------------
// File-layout constants
/** Directory holding every release-radar file in a repository. */
export const RELEASE_RADAR_DIR = ".release-radar";
/** Workspace file name inside {@link RELEASE_RADAR_DIR}. */
export const WORKSPACE_FILE = "workspace.json";
/** Component file name inside a member's {@link RELEASE_RADAR_DIR}. */
export const COMPONENT_FILE = "component.json";
/** The owned repos file name inside the workspace's {@link RELEASE_RADAR_DIR}. */
export const OWNED_REPOS_FILE = "repos.local.json";
/** The component checklist name inside a member's {@link RELEASE_RADAR_DIR}. */
export const COMPONENT_CHECKLIST_FILE = "checks.md";
/** The reserved stage name for the clone's HEAD (spec requirement 7). */
export const RESERVED_STAGE = "local";
/** `schemaVersion` values this engine reads and writes. */
export const CONFIG_SCHEMA_VERSIONS = [1];
/** The closed placeholder set of pipeline parameter templates (spec requirement 33). */
export const PLACEHOLDERS = [
    "{commit.sha}",
    "{commit.shortSha}",
    "{image.repository}",
    "{image.tag}",
    "{component}",
    "{target}",
];
/**
 * The placeholders a `pushedTagTemplate` may use: only what a finished run determines by itself
 * (its source commit) plus the static names. `{image.*}` would be circular (the pushed tag IS the
 * image tag), so it is refused (exit 24).
 */
export const PUSHED_TAG_PLACEHOLDERS = ["{commit.sha}", "{commit.shortSha}", "{component}", "{target}"];
/** Names of stages, members, targets, actions and checks. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** Keys of the repos file. */
export const REPO_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Environment-variable names that verification headers may reference. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** HTTP header names (RFC 9110 token). */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Pipeline parameter names. */
export const PARAMETER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** The JSON path subset used by `extract`: `$`, then `.key` and `[index]` steps. */
export const JSON_PATH_PATTERN = /^\$(?:\.[A-Za-z_$][A-Za-z0-9_$-]*|\[(?:0|[1-9][0-9]*)\])*$/;
const NAME = t.string({ pattern: NAME_PATTERN });
const TEXT = t.string({ minLength: 1 });
const POSITIVE = t.integer({ positive: true });
const ORDERED_ARGV = t.array(TEXT, { order: "ordered", minItems: 1 });
// ---------------------------------------------------------------------------
// Shared pieces
const SHA_RESOLVER = t.object([t.required("type", t.literal("sha"))]);
const GIT_TAG_RESOLVER = t.object([
    t.required("type", t.literal("git-tag")),
    t.required("gitTagPrefix", t.string({ pattern: /^[A-Za-z0-9._/-]*$/ })),
]);
/** How a regex convention's `ref` capture is resolved. */
export const COMMIT_RESOLVER_SCHEMA = t.oneOf("type", { sha: SHA_RESOLVER, "git-tag": GIT_TAG_RESOLVER });
/** A tag convention: how an image tag maps to a commit (spec requirement 31). */
export const TAG_CONVENTION_SCHEMA = t.oneOf("type", {
    sha: SHA_RESOLVER,
    "git-tag": GIT_TAG_RESOLVER,
    regex: t.object([
        t.required("type", t.literal("regex")),
        t.required("pattern", TEXT),
        t.required("resolveAs", COMMIT_RESOLVER_SCHEMA),
    ]),
    none: t.object([t.required("type", t.literal("none"))]),
});
const EXTRACT = t.oneOf("type", {
    "json-path": t.object([t.required("type", t.literal("json-path")), t.required("path", TEXT)]),
    regex: t.object([t.required("type", t.literal("regex")), t.required("pattern", TEXT)]),
});
const TIMEOUT_ONLY = t.object([t.required("timeoutSeconds", POSITIVE)]);
// ---------------------------------------------------------------------------
// workspace.json
const STAGE = t.object([
    t.required("name", NAME),
    t.required("tagConvention", TAG_CONVENTION_SCHEMA),
    t.required("promotion", t.object([t.required("mode", t.enum(["pipeline", "handoff", "manual", "none"])), t.optional("owner", TEXT)])),
]);
const MEMBER = t.object([
    t.required("name", NAME),
    t.required("repoKey", t.nullable(t.string({ minLength: 1 }))),
    t.required("repoSubdir", t.nullable(t.string({ minLength: 1 }))),
]);
const ADAPTER_SETTINGS = t.object([
    t.optional("azure-appservice", t.object([
        t.required("timeoutSeconds", POSITIVE),
        t.required("stageSubscriptions", t.record(t.array(TEXT, { order: { sorted: "$value" }, minItems: 1 }), { keyPattern: NAME_PATTERN })),
    ])),
    t.optional("azure-containerapp", TIMEOUT_ONLY),
    t.optional("kubernetes", TIMEOUT_ONLY),
    t.optional("compose", TIMEOUT_ONLY),
    t.optional("command", t.object([t.required("timeoutSeconds", POSITIVE), t.optional("discoverArgv", ORDERED_ARGV)])),
]);
const AZURE_DEVOPS = t.object([
    t.required("organizationUrl", TEXT),
    t.required("project", TEXT),
    t.required("requestTimeoutSeconds", POSITIVE),
    t.required("runHistoryCount", POSITIVE),
    t.required("followPollSeconds", POSITIVE),
    t.required("followTimeoutMinutes", POSITIVE),
    t.required("confirmTokenTtlMinutes", POSITIVE),
    t.required("patExpiryWarningDays", POSITIVE),
]);
/** Schema of `.release-radar/workspace.json`. */
export const WORKSPACE_SCHEMA = t.object([
    t.required("schemaVersion", t.schemaVersion(CONFIG_SCHEMA_VERSIONS)),
    t.optional("operatorTeam", TEXT),
    t.required("stages", t.array(STAGE, { order: "ordered", identity: "name", minItems: 1 })),
    t.required("members", t.array(MEMBER, { order: { sorted: "name" }, identity: "name", minItems: 1 })),
    t.required("reposFile", t.oneOf("kind", {
        owned: t.object([t.required("kind", t.literal("owned"))]),
        external: t.object([t.required("kind", t.literal("external")), t.required("path", TEXT)]),
    })),
    t.required("gitTimeoutSeconds", POSITIVE),
    t.required("freshnessMinutes", POSITIVE),
    t.required("checklist", t.nullable(TEXT)),
    t.optional("beforePromote", t.record(TEXT, { keyPattern: NAME_PATTERN })),
    t.required("snapshotRetention", POSITIVE),
    t.required("handoffRetention", POSITIVE),
    t.required("adapters", ADAPTER_SETTINGS),
    t.optional("azureDevOps", AZURE_DEVOPS),
]);
// ---------------------------------------------------------------------------
// component.json
const PARAMETERS = t.record(t.string(), { keyPattern: PARAMETER_PATTERN });
const PIPELINE_MAPPING = t.object([
    t.required("provider", t.literal("azure-devops")),
    t.optional("project", TEXT),
    t.optional("pipelineId", POSITIVE),
    t.optional("pipelineName", TEXT),
    t.optional("repository", TEXT),
    t.required("ref", t.string({ pattern: /^refs\/(?:heads|tags)\/[^\s]+$/ })),
    t.required("parameters", PARAMETERS),
    t.optional("userSelectable", t.record(t.array(t.string(), { order: { sorted: "$value" }, minItems: 1 }), { keyPattern: PARAMETER_PATTERN })),
    t.optional("imageTagParameter", t.string({ pattern: PARAMETER_PATTERN })),
    t.optional("pushedTagTemplate", TEXT),
    t.required("actions", t.record(t.object([t.required("kind", t.enum(["build", "configuration"])), t.required("parameters", PARAMETERS)]), {
        keyPattern: NAME_PATTERN,
    })),
    t.required("primaryAction", NAME),
    t.required("landedWaitMinutes", POSITIVE),
]);
const TARGET = t.oneOf("adapter", {
    "azure-appservice": t.object([
        t.required("name", NAME),
        t.required("adapter", t.literal("azure-appservice")),
        t.required("webapp", TEXT),
        t.optional("pipeline", PIPELINE_MAPPING),
    ]),
    "azure-containerapp": t.object([
        t.required("name", NAME),
        t.required("adapter", t.literal("azure-containerapp")),
        t.required("subscription", TEXT),
        t.required("resourceGroup", TEXT),
        t.required("app", TEXT),
        t.optional("pipeline", PIPELINE_MAPPING),
    ]),
    kubernetes: t.object([
        t.required("name", NAME),
        t.required("adapter", t.literal("kubernetes")),
        t.required("context", TEXT),
        t.required("namespace", TEXT),
        t.required("deployment", TEXT),
        t.optional("pipeline", PIPELINE_MAPPING),
    ]),
    compose: t.object([
        t.required("name", NAME),
        t.required("adapter", t.literal("compose")),
        t.required("project", TEXT),
        t.required("service", TEXT),
        t.optional("pipeline", PIPELINE_MAPPING),
    ]),
    command: t.object([
        t.required("name", NAME),
        t.required("adapter", t.literal("command")),
        t.required("argv", ORDERED_ARGV),
        t.required("extract", EXTRACT),
        t.optional("preflightArgv", ORDERED_ARGV),
        t.optional("pipeline", PIPELINE_MAPPING),
    ]),
});
const HEADERS = t.record(t.object([t.required("env", t.string({ pattern: ENV_NAME_PATTERN }))]), {
    keyPattern: HEADER_NAME_PATTERN,
});
const CHECK = t.oneOf("type", {
    http: t.object([
        t.required("name", NAME),
        t.required("type", t.literal("http")),
        t.optional("target", NAME),
        t.required("url", TEXT),
        t.required("method", t.enum(["GET", "HEAD"])),
        t.required("expectStatus", t.array(t.integer({ min: 100 }), { order: "ordered", minItems: 1 })),
        t.optional("headers", HEADERS),
        t.optional("timeoutSeconds", POSITIVE),
    ]),
    version: t.object([
        t.required("name", NAME),
        t.required("type", t.literal("version")),
        t.optional("target", NAME),
        t.required("url", TEXT),
        t.required("extract", EXTRACT),
        t.required("compare", t.enum(["commit", "tag"])),
        t.optional("headers", HEADERS),
        t.optional("timeoutSeconds", POSITIVE),
    ]),
    smoke: t.object([
        t.required("name", NAME),
        t.required("type", t.literal("smoke")),
        t.optional("target", NAME),
        t.required("argv", ORDERED_ARGV),
        t.optional("timeoutSeconds", POSITIVE),
    ]),
});
const STAGE_ENTRY = t.object([
    t.required("targets", t.array(TARGET, { order: { sorted: "name" }, identity: "name", minItems: 1 })),
    t.optional("handoff", t.object([
        t.required("settingsFiles", t.array(TEXT, { order: { sorted: "$value" }, minItems: 1 })),
        t.optional("beforePromote", TEXT),
    ])),
    t.optional("verification", t.object([
        t.required("timeoutSeconds", POSITIVE),
        t.required("checks", t.array(CHECK, { order: { sorted: "name" }, identity: "name", minItems: 1 })),
    ])),
]);
/** Schema of a member's `.release-radar/component.json`. */
export const COMPONENT_SCHEMA = t.object([
    t.required("schemaVersion", t.schemaVersion(CONFIG_SCHEMA_VERSIONS)),
    t.required("name", NAME),
    t.optional("tagConventionOverrides", t.record(TAG_CONVENTION_SCHEMA, { keyPattern: NAME_PATTERN })),
    t.required("stages", t.record(t.nullable(STAGE_ENTRY), { keyPattern: NAME_PATTERN })),
]);
// ---------------------------------------------------------------------------
// Semantic validation helpers
function fail(file, pointer, message) {
    throw new EngineError(EXIT.INVALID, "validate", message, { file, pointer });
}
function pointerOf(...tokens) {
    return tokens.reduce((pointer, token) => childPointer(pointer, token), "");
}
/**
 * Problem with a relative, `/`-separated path, or `null` when it is acceptable.
 * Absolute paths, backslashes, empty / `.` segments are rejected; `..` only when allowed.
 */
export function relativePathProblem(path, allowParent) {
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
        return "must be a relative path";
    if (path.includes("\\"))
        return "must use / as the separator";
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".")
            return "must not contain empty or '.' segments";
        if (segment === ".." && !allowParent)
            return "must not contain '..'";
    }
    return null;
}
/**
 * Normalises a member's `repoSubdir` (spec requirement 31c): the location is relative to the
 * clone root, with no `.` segments, no repeated separators and no trailing separator. The
 * equivalent spellings `jobs`, `./jobs`, `jobs/` and `./jobs/` all normalise to `jobs`, so two
 * members spelling the same location differently are detected as duplicates.
 *
 * Still rejected (spelling cannot fix them): absolute paths, backslashes, any `..` segment, and a
 * value that normalises to the repository root (`.`, `./`) — the root is written `null`.
 */
export function normalizeRepoSubdir(path) {
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
        return { problem: "must be a relative path" };
    if (path.includes("\\"))
        return { problem: "must use / as the separator" };
    const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (segments.includes(".."))
        return { problem: "must not contain '..'" };
    if (segments.length === 0)
        return { problem: "denotes the repository root; write null for the root" };
    return { path: segments.join("/") };
}
/**
 * The normalised `repoSubdir` of a member that already passed {@link checkWorkspace}, or `null`
 * for the repository root.
 */
export function memberSubdir(member) {
    if (member.repoSubdir === null)
        return null;
    const normalised = normalizeRepoSubdir(member.repoSubdir);
    if ("problem" in normalised)
        throw new EngineError(EXIT.INVALID, "validate", `"repoSubdir" ${normalised.problem}`);
    return normalised.path;
}
function checkRegex(file, pointer, pattern, group) {
    let compiled;
    try {
        compiled = new RegExp(pattern, "u");
    }
    catch (error) {
        fail(file, pointer, `invalid regular expression: ${error.message}`);
    }
    if (!compiled.source.includes(`(?<${group}>`))
        fail(file, pointer, `regular expression must contain a named group "${group}"`);
}
function checkUrl(file, pointer, value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        fail(file, pointer, `${JSON.stringify(value)} is not an absolute URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        fail(file, pointer, `URL must use http or https`);
    if (url.username !== "" || url.password !== "")
        fail(file, pointer, `URL must not carry credentials`);
}
function checkTagConvention(file, pointer, convention) {
    if (convention.type === "regex")
        checkRegex(file, childPointer(pointer, "pattern"), convention.pattern, "ref");
}
function checkExtract(file, pointer, extract, group) {
    if (extract.type === "regex")
        checkRegex(file, childPointer(pointer, "pattern"), extract.pattern, group);
    else if (!JSON_PATH_PATTERN.test(extract.path)) {
        fail(file, childPointer(pointer, "path"), `${JSON.stringify(extract.path)} is not a supported JSON path ($, .key, [index])`);
    }
}
/** Placeholders used in a template value; a message for the first unknown or malformed one. */
export function templatePlaceholders(value) {
    const found = [];
    let index = 0;
    while (index < value.length) {
        const open = value.indexOf("{", index);
        const close = value.indexOf("}", index);
        if (open < 0) {
            if (close >= 0)
                return { problem: `unmatched "}" in ${JSON.stringify(value)}` };
            break;
        }
        if (close >= 0 && close < open)
            return { problem: `unmatched "}" in ${JSON.stringify(value)}` };
        const end = value.indexOf("}", open);
        if (end < 0)
            return { problem: `unmatched "{" in ${JSON.stringify(value)}` };
        const token = value.slice(open, end + 1);
        if (!PLACEHOLDERS.includes(token)) {
            return { problem: `unknown placeholder ${token} (allowed: ${PLACEHOLDERS.join(", ")})` };
        }
        found.push(token);
        index = end + 1;
    }
    return { placeholders: found };
}
// ---------------------------------------------------------------------------
// Workspace rules
/**
 * Semantic rules of `workspace.json` that the schema cannot express (spec requirement 37):
 * reserved `local`, owner/operatorTeam, repoKey/repoSubdir rules, duplicate repoKey+repoSubdir location (monorepos allowed),
 * stage-keyed maps naming declared stages, regex conventions, paths and the organization URL.
 * @throws EngineError 24 at the offending key.
 */
export function checkWorkspace(workspace, file) {
    const stages = new Set();
    workspace.stages.forEach((stage, index) => {
        const at = pointerOf("stages", index);
        if (stage.name === RESERVED_STAGE)
            fail(file, childPointer(at, "name"), `"${RESERVED_STAGE}" is a reserved stage name (the clone's HEAD)`);
        stages.add(stage.name);
        checkTagConvention(file, childPointer(at, "tagConvention"), stage.tagConvention);
        const { mode, owner } = stage.promotion;
        if (owner === undefined && mode !== "none") {
            fail(file, pointerOf("stages", index, "promotion", "owner"), `missing required key "owner" (required when mode is "${mode}")`);
        }
        if (owner !== undefined && workspace.operatorTeam === undefined) {
            fail(file, "/operatorTeam", `missing required key "operatorTeam" (stage "${stage.name}" declares promotion.owner)`);
        }
    });
    // Monorepos are allowed (user decision 2026-11-25): several members may share a repoKey as long as
    // each points at a different repoSubdir. The same repoKey + normalised repoSubdir location twice is
    // fatal. Equivalent spellings (`jobs`, `./jobs`, `jobs/`) are NORMALISED, not rejected
    // (requirement 31c compares locations after normalisation; 76a lists them as duplicates of each
    // other), so {@link normalizeRepoSubdir} is the single rule used here, by the loader
    // (`componentRoot`, `componentRepoPath`) and by the workspace index.
    const locations = new Map();
    workspace.members.forEach((member, index) => {
        if (member.repoKey === null && member.repoSubdir !== null) {
            fail(file, pointerOf("members", index, "repoSubdir"), `"repoSubdir" must be null when "repoKey" is null`);
        }
        if (member.repoKey !== null && !REPO_KEY_PATTERN.test(member.repoKey)) {
            fail(file, pointerOf("members", index, "repoKey"), `${JSON.stringify(member.repoKey)} does not match ${String(REPO_KEY_PATTERN)}`);
        }
        let subdir = "";
        if (member.repoSubdir !== null) {
            const normalised = normalizeRepoSubdir(member.repoSubdir);
            if ("problem" in normalised)
                fail(file, pointerOf("members", index, "repoSubdir"), `"repoSubdir" ${normalised.problem}`);
            subdir = normalised.path;
        }
        if (member.repoKey !== null) {
            const location = `${member.repoKey}\u0000${subdir}`;
            const first = locations.get(location);
            if (first !== undefined) {
                const spelled = member.repoSubdir === subdir ? "" : ` (normalised "${subdir}")`;
                const where = subdir === "" ? "the repository root" : `repoSubdir "${member.repoSubdir}"${spelled}`;
                fail(file, pointerOf("members", index, "repoSubdir"), `repoKey "${member.repoKey}" with ${where} is already used by /members/${first}`);
            }
            locations.set(location, index);
        }
    });
    if (workspace.reposFile.kind === "external") {
        const problem = relativePathProblem(workspace.reposFile.path, true);
        if (problem !== null)
            fail(file, "/reposFile/path", `"path" ${problem}`);
    }
    if (workspace.checklist !== null) {
        const problem = relativePathProblem(workspace.checklist, false);
        if (problem !== null)
            fail(file, "/checklist", `"checklist" ${problem}`);
    }
    for (const key of Object.keys(workspace.beforePromote ?? {})) {
        if (!stages.has(key))
            fail(file, pointerOf("beforePromote", key), `"${key}" is not a declared stage`);
    }
    const appService = workspace.adapters["azure-appservice"];
    for (const key of Object.keys(appService?.stageSubscriptions ?? {})) {
        if (!stages.has(key))
            fail(file, pointerOf("adapters", "azure-appservice", "stageSubscriptions", key), `"${key}" is not a declared stage`);
    }
    if (workspace.azureDevOps !== undefined) {
        checkUrl(file, "/azureDevOps/organizationUrl", workspace.azureDevOps.organizationUrl);
    }
}
// ---------------------------------------------------------------------------
// Component rules
function checkPipeline(file, at, mapping, workspace, workspaceFile) {
    if (workspace.azureDevOps === undefined) {
        fail(file, at, `a pipeline mapping requires the "azureDevOps" block in ${workspaceFile}`);
    }
    if (mapping.pipelineId === undefined && mapping.pipelineName === undefined) {
        fail(file, childPointer(at, "pipelineId"), `missing required key "pipelineId" or "pipelineName" (at least one)`);
    }
    const declared = new Set(Object.keys(mapping.parameters));
    for (const [name, value] of Object.entries(mapping.parameters)) {
        const result = templatePlaceholders(value);
        if ("problem" in result)
            fail(file, childPointer(childPointer(at, "parameters"), name), result.problem);
    }
    const selectable = mapping.userSelectable ?? {};
    for (const name of Object.keys(selectable)) {
        const where = childPointer(childPointer(at, "userSelectable"), name);
        if (declared.has(name))
            fail(file, where, `parameter "${name}" is both templated and userSelectable`);
    }
    if (mapping.imageTagParameter !== undefined && !declared.has(mapping.imageTagParameter)) {
        fail(file, childPointer(at, "imageTagParameter"), `undeclared parameter "${mapping.imageTagParameter}" (imageTagParameter must name a key of "parameters")`);
    }
    if (mapping.pushedTagTemplate !== undefined) {
        const where = childPointer(at, "pushedTagTemplate");
        const result = templatePlaceholders(mapping.pushedTagTemplate);
        if ("problem" in result)
            fail(file, where, result.problem);
        for (const placeholder of result.placeholders) {
            if (!PUSHED_TAG_PLACEHOLDERS.includes(placeholder)) {
                fail(file, where, `placeholder ${placeholder} cannot describe the pushed tag (allowed: ${PUSHED_TAG_PLACEHOLDERS.join(", ")})`);
            }
        }
    }
    const actionNames = Object.keys(mapping.actions);
    if (actionNames.length === 0)
        fail(file, childPointer(at, "actions"), `at least one action must be declared`);
    for (const [actionName, action] of Object.entries(mapping.actions)) {
        const actionAt = childPointer(childPointer(at, "actions"), actionName);
        for (const [name, value] of Object.entries(action.parameters)) {
            const where = childPointer(childPointer(actionAt, "parameters"), name);
            if (Object.hasOwn(selectable, name))
                fail(file, where, `parameter "${name}" is userSelectable and cannot be set by an action`);
            if (!declared.has(name))
                fail(file, where, `undeclared parameter "${name}" (declare it in "parameters")`);
            const result = templatePlaceholders(value);
            if ("problem" in result)
                fail(file, where, result.problem);
        }
    }
    if (!Object.hasOwn(mapping.actions, mapping.primaryAction)) {
        fail(file, childPointer(at, "primaryAction"), `primaryAction "${mapping.primaryAction}" is not a declared action (${actionNames.join(", ")})`);
    }
}
function checkVerification(file, at, block, targetNames) {
    block.checks.forEach((check, index) => {
        const checkAt = childPointer(childPointer(at, "checks"), index);
        if (check.target !== undefined && !targetNames.has(check.target)) {
            fail(file, childPointer(checkAt, "target"), `"${check.target}" is not a target of this stage`);
        }
        if (check.type === "smoke")
            return;
        checkUrl(file, childPointer(checkAt, "url"), check.url);
        if (check.type === "http") {
            check.expectStatus.forEach((status, position) => {
                if (status > 599)
                    fail(file, childPointer(childPointer(checkAt, "expectStatus"), position), `expected an HTTP status 100-599, got ${status}`);
            });
        }
        else {
            checkExtract(file, childPointer(checkAt, "extract"), check.extract, "version");
        }
    });
}
function checkTarget(file, at, target, stage, workspace, workspaceFile) {
    const settings = workspace.adapters[target.adapter];
    if (settings === undefined) {
        fail(file, childPointer(at, "adapter"), `adapter "${target.adapter}" requires "adapters.${target.adapter}" in ${workspaceFile}`);
    }
    if (target.adapter === "azure-appservice") {
        const subscriptions = workspace.adapters["azure-appservice"]?.stageSubscriptions ?? {};
        if (!Object.hasOwn(subscriptions, stage.name)) {
            fail(file, childPointer(at, "adapter"), `stage "${stage.name}" has no "adapters.azure-appservice.stageSubscriptions.${stage.name}" in ${workspaceFile}`);
        }
    }
    if (target.adapter === "command")
        checkExtract(file, childPointer(at, "extract"), target.extract, "image");
    if (target.pipeline !== undefined) {
        if (stage.promotion.mode !== "pipeline") {
            fail(file, childPointer(at, "pipeline"), `a pipeline mapping is only allowed on a "pipeline" stage; "${stage.name}" is "${stage.promotion.mode}"`);
        }
        checkPipeline(file, childPointer(at, "pipeline"), target.pipeline, workspace, workspaceFile);
    }
}
/**
 * Cross-checks a validated `component.json` against its workspace (spec requirements 31a,
 * 31c, 33-35, 37, 40): name equals the member, every workspace stage present (explicit null
 * allowed) and no undeclared stage, override keys, adapter settings, pipeline mappings only on
 * `pipeline` stages, handoff artefacts only on `handoff` stages, placeholders, actions,
 * `primaryAction`, verification targets, URLs and extract expressions.
 * @throws EngineError 24 at the offending key of `file`.
 */
export function checkComponent(component, workspace, memberName, file, workspaceFile) {
    if (component.name !== memberName) {
        fail(file, "/name", `component name "${component.name}" differs from its member name "${memberName}"`);
    }
    const declared = new Map(workspace.stages.map((stage) => [stage.name, stage]));
    for (const key of Object.keys(component.stages)) {
        if (!declared.has(key))
            fail(file, pointerOf("stages", key), `"${key}" is not a stage declared by ${workspaceFile}`);
    }
    for (const stage of workspace.stages) {
        if (!Object.hasOwn(component.stages, stage.name)) {
            fail(file, pointerOf("stages", stage.name), `missing required key "${stage.name}" (every workspace stage must be listed; null = not deployed)`);
        }
    }
    for (const [key, convention] of Object.entries(component.tagConventionOverrides ?? {})) {
        if (!declared.has(key))
            fail(file, pointerOf("tagConventionOverrides", key), `"${key}" is not a stage declared by ${workspaceFile}`);
        checkTagConvention(file, pointerOf("tagConventionOverrides", key), convention);
    }
    for (const stage of workspace.stages) {
        const entry = component.stages[stage.name];
        if (entry === null || entry === undefined)
            continue;
        const at = pointerOf("stages", stage.name);
        entry.targets.forEach((target, index) => checkTarget(file, pointerOf("stages", stage.name, "targets", index), target, stage, workspace, workspaceFile));
        if (entry.handoff !== undefined) {
            if (stage.promotion.mode !== "handoff") {
                fail(file, childPointer(at, "handoff"), `handoff artefacts are only allowed on a "handoff" stage; "${stage.name}" is "${stage.promotion.mode}"`);
            }
            entry.handoff.settingsFiles.forEach((path, index) => {
                const problem = relativePathProblem(path, false);
                if (problem !== null)
                    fail(file, pointerOf("stages", stage.name, "handoff", "settingsFiles", index), `settings file path ${problem}`);
            });
        }
        if (entry.verification !== undefined) {
            checkVerification(file, childPointer(at, "verification"), entry.verification, new Set(entry.targets.map((target) => target.name)));
        }
    }
}
// ---------------------------------------------------------------------------
// Lifecycle helpers
/** The stage named `name`, or `undefined`. */
export function findStage(workspace, name) {
    return workspace.stages.find((stage) => stage.name === name);
}
/** True when the operator's team owns the stage (`promotion.owner === operatorTeam`). */
export function isOwnedByOperator(workspace, stage) {
    return workspace.operatorTeam !== undefined && stage.promotion.owner === workspace.operatorTeam;
}
/**
 * A stage is triggerable only when `promotion.mode === "pipeline"` AND
 * `promotion.owner === operatorTeam` (spec requirement 32).
 */
export function isTriggerable(workspace, stage) {
    return stage.promotion.mode === "pipeline" && isOwnedByOperator(workspace, stage);
}
/**
 * Whether smoke checks run on a stage (spec requirement 40a): only on stages owned by
 * `operatorTeam`. Otherwise they are reported "not run (stage not owned)"; an explicit
 * request to run one is refused with exit 26 by the verification runner. Declaring one is
 * not a configuration error.
 */
export function smokeDisposition(workspace, stage) {
    return isOwnedByOperator(workspace, stage) ? "run" : "not-run-stage-not-owned";
}
/**
 * The tag convention in force for a component on a stage, and where it comes from. An absent
 * override means the stage's convention applies (documented semantics, not a fallback).
 */
export function effectiveTagConvention(workspace, component, stageName) {
    const override = component.tagConventionOverrides?.[stageName];
    if (override !== undefined)
        return { convention: override, source: "override" };
    const stage = findStage(workspace, stageName);
    if (stage === undefined)
        throw new EngineError(EXIT.ARGS, "arguments", `unknown stage "${stageName}" (stages: ${workspace.stages.map((s) => s.name).join(", ")})`);
    return { convention: stage.tagConvention, source: "stage" };
}
/** The Azure DevOps project of a mapping: its own `project`, or (when absent) the workspace's `azureDevOps.project`. */
export function mappingProject(workspace, mapping) {
    if (mapping.project !== undefined)
        return mapping.project;
    if (workspace.azureDevOps === undefined)
        throw new EngineError(EXIT.INVALID, "validate", `no "azureDevOps" block`);
    return workspace.azureDevOps.project;
}
