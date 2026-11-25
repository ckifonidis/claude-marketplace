/**
 * The run preview and its confirmation token (spec requirements 14, 59-62, 66-68, 72, 74;
 * Assumption 13; plan D2, D7, D8, Phase 7; research §3.1-§3.3, §4).
 *
 * Shared by `pipeline-preview` (which shows it) and `run-pipeline` (which recomputes it from
 * scratch and compares). Everything here is READ-ONLY: workspace files, read-only git, and
 * Azure DevOps GETs through `azure-devops-read.ts` (Pipelines Get, Git Refs). This module never
 * imports the write module.
 *
 * ## Static scope ({@link resolvePreviewScope}, no network)
 * In order: names (64: component, stage, target, action syntax, `--select` syntax) → canonical
 * load (24/29) → triggerability (26: mode `pipeline` AND owner = `operatorTeam`) → mapping (26)
 * → action declared (26; omitted = the mapping's `primaryAction`, reported as such) →
 * `userSelectable` choices (64: every one chosen once, from its closed list) → every parameter
 * renderable (26: `{image.repository}` has no source in v1, `{image.tag}` needs a
 * `pushedTagTemplate`; nothing is guessed).
 *
 * ## The commit to build (decision recorded in the Phase 7 report)
 * The commit is the **remote head of the mapping's `ref`**, read through Git Refs (D2) — the
 * commit the pipeline would build anyway, pinned explicitly through the Runs API
 * `resources.repositories.self.version` (D8). The local clone is used only as evidence: it must
 * CONTAIN that commit (otherwise the change-risk review could not have looked at it → 26, fetch
 * first; release-radar never fetches), the member's `component.json` AT that commit must carry
 * the same pipeline mapping for the target as the working tree (otherwise → 26), and the
 * clone's HEAD is reported next to it with its relation: a local HEAD with commits that are not
 * on the remote ref is reported "not buildable (unpushed)".
 *
 * ## Pinning and the ref check (Assumption 13)
 * The Runs API pin is always sent, but its semantics are unconfirmed [M], so v1 never relies on
 * it alone: the Git Refs check is MANDATORY. The repository is the mapping's `repository`, else
 * the pipeline's `configuration.repository` when it is Azure Repos Git; with neither, the run is
 * refused (26) — "neither pinning nor the ref check is possible".
 *
 * ## The token
 * `rr1.<base64url(canonical JSON {commit, digest, expiresAt, v: 1})>`, where `digest` =
 * sha256 over the recursive canonical form ({@link canonicalHash}) of the {@link TokenBinding}
 * plus `expiresAt`. It is a COMMITMENT, not an authenticator: there is no secret, so anyone could
 * compute one. Its purpose is (1) binding — `run-pipeline` recomputes the request from scratch and
 * refuses (27) unless every bound field is identical — and (2) expiry after
 * `confirmTokenTtlMinutes`. The authenticator is the human confirmation of the verbatim preview
 * plus the permission prompt (`run-pipeline` is never pre-allowed, D12). `commit` travels in clear
 * (it is also inside the digest) so the final ref re-read can name the previewed commit.
 */

import { COMPONENT_SCHEMA, NAME_PATTERN, PARAMETER_PATTERN, isTriggerable, mappingProject, templatePlaceholders, type PipelineMapping, type Stage, type Target, type Workspace } from "../config.js";
import { EXIT, EngineError } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { argumentError } from "../args.js";
import { canonicalHash, canonicalStringify, canonicalize } from "../format.js";
import { commitSummary, compareCommits, headCommit } from "../git.js";
import { loadWorkspace, loadWorkspaceSkeleton, readComponentAtCommit, requireAvailableMember, type AvailableMember, type LoadedWorkspace } from "../workspace.js";
import { API_VERSION, type AzureDevOpsReader, type PipelineInfo } from "./azure-devops-read.js";
import { describeDeclared, resolvePipeline } from "./collect.js";

/** Token prefix (format version 1). */
export const TOKEN_PREFIX = "rr1.";
/** Longest token accepted (a real one is ~200 characters). */
export const MAX_TOKEN_LENGTH = 1024;
/** Clock skew tolerated when a token claims an expiry beyond now + TTL. */
export const TOKEN_SKEW_MS = 60_000;
/** Pipelines Get `configuration.repository.type` values that are Azure Repos Git. */
export const AZURE_REPOS_TYPES: readonly string[] = ["azurereposgit", "tfsgit"];

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Request and static scope

/** What the operator asked to preview (or run). */
export interface PreviewRequest {
  readonly workspace: string;
  readonly component: string;
  readonly stage: string;
  readonly target: string | null;
  readonly action: string | null;
  /** Raw `--select name=value` values, in the order given. */
  readonly selections: readonly string[];
}

/** The action that will run. */
export interface ResolvedAction {
  readonly name: string;
  readonly kind: "build" | "configuration";
  /** `requested` (`--action`) or `primaryAction` (omitted → the mapping's primary action). */
  readonly source: "requested" | "primaryAction";
}

/** The statically resolved scope (no network was used). */
export interface PreviewScope {
  readonly loaded: LoadedWorkspace;
  readonly ws: Workspace;
  readonly settings: NonNullable<Workspace["azureDevOps"]>;
  readonly member: AvailableMember;
  readonly stage: Stage;
  readonly target: Target;
  readonly mapping: PipelineMapping;
  readonly project: string;
  readonly action: ResolvedAction;
  /** `userSelectable` name → chosen value (keys sorted). */
  readonly selections: Readonly<Record<string, string>>;
}

function refused(message: string): EngineError {
  return new EngineError(EXIT.REFUSED, "refused", `${message}; nothing was sent`);
}

/** Parses `--select` values. @throws EngineError 64. */
function parseSelections(raw: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw) {
    const at = entry.indexOf("=");
    if (at <= 0) throw argumentError(`--select ${JSON.stringify(entry)}: expected <parameter>=<value>`);
    const name = entry.slice(0, at);
    const value = entry.slice(at + 1);
    if (!PARAMETER_PATTERN.test(name)) throw argumentError(`--select ${JSON.stringify(entry)}: "${name}" is not a parameter name`);
    if (out.has(name)) throw argumentError(`--select ${name} given twice`);
    out.set(name, value);
  }
  return out;
}

/** True when `template` uses `placeholder`. */
function uses(template: string, placeholder: string): boolean {
  const found = templatePlaceholders(template);
  return "placeholders" in found && (found.placeholders as readonly string[]).includes(placeholder);
}

/** The template of every parameter the run will send (the action's value overrides the mapping's). */
function parameterTemplates(mapping: PipelineMapping, action: string): { readonly name: string; readonly template: string; readonly source: "action" | "template" }[] {
  const declared = mapping.actions[action]?.parameters ?? {};
  return Object.keys(mapping.parameters)
    .sort()
    .map((name) => {
      const own = declared[name];
      return own !== undefined ? { name, template: own, source: "action" as const } : { name, template: mapping.parameters[name] as string, source: "template" as const };
    });
}

/**
 * Resolves component, stage, target, action and selections with no network call (see the
 * module comment for the order). @throws EngineError 64, 24, 29, 26.
 */
export function resolvePreviewScope(request: PreviewRequest): PreviewScope {
  const skeleton = loadWorkspaceSkeleton(request.workspace);
  const names = skeleton.workspace.members.map((member) => member.name);
  if (!names.includes(request.component)) throw argumentError(`unknown component "${request.component}" (members: ${names.join(", ")})`);
  const stage = skeleton.workspace.stages.find((candidate) => candidate.name === request.stage);
  if (stage === undefined) throw argumentError(`unknown stage "${request.stage}" (stages: ${skeleton.workspace.stages.map((s) => s.name).join(", ")})`);
  if (request.action !== null && !NAME_PATTERN.test(request.action)) throw argumentError(`"${request.action}" is not an action name`);
  const chosen = parseSelections(request.selections);

  const loaded = loadWorkspace(request.workspace, { members: [request.component], canonical: "require" });
  const ws = loaded.workspace;
  const member = requireAvailableMember(loaded, request.component);
  const entry = member.component.stages[stage.name] ?? null;
  const targets = entry === null ? [] : entry.targets;
  if (request.target !== null && !targets.some((target) => target.name === request.target)) {
    throw argumentError(`unknown target "${request.target}" for ${request.component} on stage "${stage.name}" (targets: ${targets.map((t) => t.name).join(", ") || "none — the component is not deployed there"})`);
  }

  if (!isTriggerable(ws, stage)) {
    const owner = stage.promotion.owner ?? "nobody";
    const why =
      stage.promotion.mode !== "pipeline"
        ? `its promotion mode is "${stage.promotion.mode}" (owner "${owner}")`
        : `its pipeline is owned by "${owner}", not by operatorTeam "${ws.operatorTeam ?? "(not declared)"}"`;
    const offer = stage.promotion.mode === "handoff" ? " — prepare a handoff package for the owner instead" : "";
    throw refused(`stage "${stage.name}" is not triggerable: ${why}; release-radar triggers only "pipeline" stages owned by operatorTeam${offer}`);
  }

  let target: Target;
  if (request.target !== null) {
    target = targets.find((candidate) => candidate.name === request.target) as Target;
    if (target.pipeline === undefined) throw refused(`target "${target.name}" of ${request.component} on stage "${stage.name}" has no pipeline mapping`);
  } else {
    const mapped = targets.filter((candidate) => candidate.pipeline !== undefined);
    if (mapped.length === 0) throw refused(`${request.component} has no pipeline mapping on stage "${stage.name}"`);
    if (mapped.length > 1) throw argumentError(`${request.component} has ${mapped.length} pipeline-mapped targets on stage "${stage.name}" (${mapped.map((t) => t.name).join(", ")}); pick one with --target`);
    target = mapped[0] as Target;
  }
  const mapping = target.pipeline as PipelineMapping;

  const actionName = request.action ?? mapping.primaryAction;
  const declared = mapping.actions[actionName];
  if (declared === undefined) throw refused(`action "${actionName}" is not declared for ${request.component}/${stage.name}/${target.name} (declared: ${Object.keys(mapping.actions).sort().join(", ")})`);
  const action: ResolvedAction = { name: actionName, kind: declared.kind, source: request.action === null ? "primaryAction" : "requested" };

  const selectable = mapping.userSelectable ?? {};
  const selectableNames = Object.keys(selectable).sort();
  const selections: Record<string, string> = {};
  for (const [name, value] of chosen) {
    const allowed = selectable[name];
    if (allowed === undefined) {
      throw argumentError(`--select ${name}: not a userSelectable parameter of this mapping (userSelectable: ${selectableNames.join(", ") || "none"})`);
    }
    if (!allowed.includes(value)) throw argumentError(`--select ${name}=${value}: not an allowed value (allowed: ${allowed.join(", ")})`);
  }
  const missing = selectableNames.filter((name) => !chosen.has(name));
  if (missing.length > 0) {
    throw argumentError(`choose every userSelectable parameter: ${missing.map((name) => `--select ${name}=<${(selectable[name] ?? []).join("|")}>`).join(" ")}`);
  }
  for (const name of selectableNames) selections[name] = chosen.get(name) as string;

  for (const { name, template } of parameterTemplates(mapping, action.name)) {
    if (uses(template, "{image.repository}")) {
      throw refused(`parameter "${name}" uses {image.repository}, which pipeline-preview cannot determine in v1 (no configuration declares the repository the pipeline pushes to, and nothing is guessed)`);
    }
    if (uses(template, "{image.tag}") && mapping.pushedTagTemplate === undefined) {
      throw refused(`parameter "${name}" uses {image.tag}, but the mapping declares no pushedTagTemplate to derive it from (nothing is guessed)`);
    }
  }

  if (ws.azureDevOps === undefined) throw new EngineError(EXIT.INTERNAL, "internal", "internal: a pipeline mapping without an azureDevOps block");
  return { loaded, ws, settings: ws.azureDevOps, member, stage, target, mapping, project: mappingProject(ws, mapping), action, selections };
}

// ---------------------------------------------------------------------------
// Rendering

/** Values of the closed placeholder set for one run. */
interface PlaceholderValues {
  readonly sha: string;
  readonly shortSha: string;
  readonly component: string;
  readonly target: string;
  readonly imageTag: string | null;
}

function render(template: string, values: PlaceholderValues): string {
  let out = template
    .replaceAll("{commit.sha}", values.sha)
    .replaceAll("{commit.shortSha}", values.shortSha)
    .replaceAll("{component}", values.component)
    .replaceAll("{target}", values.target);
  if (values.imageTag !== null) out = out.replaceAll("{image.tag}", values.imageTag);
  return out;
}

/** One parameter as previewed. */
export interface PreviewParameter {
  readonly name: string;
  readonly value: string;
  /** `action` (the action sets it), `template` (the mapping's parameter template), `userSelectable`. */
  readonly source: "action" | "template" | "userSelectable";
  /** The template it was rendered from (`null` for a userSelectable choice). */
  readonly template: string | null;
  /** The closed list (userSelectable only). */
  readonly allowed: readonly string[] | null;
}

/** The exact Runs API request `run-pipeline` will send (D8). */
export interface QueueBody {
  readonly resources: { readonly repositories: { readonly self: { readonly refName: string; readonly version: string } } };
  readonly templateParameters: Readonly<Record<string, string>>;
}

/** Every field the token binds (spec requirement 67), plus the engine version. */
export interface TokenBinding {
  readonly organizationUrl: string;
  readonly project: string;
  readonly pipelineId: number;
  readonly pipelineName: string;
  readonly repository: string;
  readonly ref: string;
  readonly commit: string;
  readonly component: string;
  readonly stage: string;
  readonly target: string;
  readonly action: string;
  readonly actionKind: "build" | "configuration";
  /** Every templateParameters value that will be sent (userSelectable choices included). */
  readonly parameters: Readonly<Record<string, string>>;
  /** The chosen userSelectable values. */
  readonly selections: Readonly<Record<string, string>>;
  readonly engineVersion: string;
}

/** Something that prevents a run; no token is issued. */
export interface PreviewBlocker {
  /** 26 (refused) or 23 (a declared pipeline / ref / repository does not exist). */
  readonly exitCode: number;
  readonly code: "pipeline-missing" | "no-ref-check" | "repository-missing" | "ref-missing" | "commit-not-local" | "config-at-commit";
  readonly detail: string;
}

/** The full preview (spec requirement 60 step 3). Fields after a blocker may be `null`. */
export interface Preview {
  readonly organizationUrl: string;
  readonly project: string;
  readonly component: string;
  readonly stage: { readonly name: string; readonly mode: string; readonly owner: string | null; readonly operatorTeam: string | null; readonly triggerable: true };
  readonly target: string;
  readonly pipeline: {
    readonly declared: string;
    readonly status: "found" | "missing";
    readonly id: number | null;
    readonly name: string | null;
    readonly folder: string | null;
    readonly link: string | null;
    readonly detail: string;
  };
  readonly ref: string;
  readonly repository: { readonly value: string; readonly source: "mapping" | "pipeline-configuration" } | null;
  readonly action: ResolvedAction;
  readonly parameters: readonly PreviewParameter[];
  readonly selections: Readonly<Record<string, string>>;
  /** The commit that will be built: the remote ref head (see the module comment). */
  readonly commit: {
    readonly sha: string;
    readonly shortSha: string;
    readonly source: "remote-ref-head";
    readonly onRemoteRef: true;
    readonly inLocalClone: boolean;
    readonly subject: string | null;
    readonly date: string | null;
  } | null;
  /** The clone's HEAD and its relation to the commit that will be built. */
  readonly localHead: {
    readonly sha: string | null;
    readonly shortSha: string | null;
    /** `same`, `older` (HEAD lacks remote commits), `unpushed` (HEAD has commits not on the ref), `diverged`, `unknown`. */
    readonly relation: "same" | "older" | "unpushed" | "diverged" | "unknown";
    readonly buildable: boolean;
    readonly detail: string;
  } | null;
  /** The member's component.json at the commit (spec 31d). */
  readonly componentAtCommit: { readonly status: string; readonly label: string; readonly mappingMatches: boolean; readonly detail: string } | null;
  /** The image the run will push (build kind) — D10 rules; `not-applicable` for configuration kind. */
  readonly image: {
    readonly status: "determined" | "undetermined" | "not-applicable";
    readonly repository: string | null;
    readonly tag: string | null;
    readonly detail: string;
  };
  /** The verification that runs after landing (names and types only). */
  readonly verification: { readonly configured: boolean; readonly checks: readonly { readonly name: string; readonly type: string }[]; readonly detail: string };
  /**
   * The request `run-pipeline` would send — exactly one Runs API queue request (the method is
   * named only in the write module) — or `null` while blocked.
   */
  readonly request: { readonly path: string; readonly body: QueueBody } | null;
  readonly binding: TokenBinding | null;
  readonly blockers: readonly PreviewBlocker[];
}

function shortOf(sha: string): string {
  return sha.slice(0, 7);
}

function verificationOf(scope: PreviewScope): Preview["verification"] {
  const block = scope.member.component.stages[scope.stage.name]?.verification;
  if (block === undefined) return { configured: false, checks: [], detail: "no real-world verification configured" };
  const checks = block.checks.filter((check) => check.target === undefined || check.target === scope.target.name).map((check) => ({ name: check.name, type: check.type }));
  if (checks.length === 0) return { configured: false, checks, detail: `no real-world verification configured for target "${scope.target.name}"` };
  return { configured: true, checks, detail: `${checks.length} check(s) run once after landing: ${checks.map((check) => `${check.name} (${check.type})`).join(", ")}` };
}

function imageOf(scope: PreviewScope, parameters: Readonly<Record<string, string>>, imageTag: string | null): Preview["image"] {
  if (scope.action.kind === "configuration") return { status: "not-applicable", repository: null, tag: null, detail: `configuration-kind action "${scope.action.name}": no image is pushed (expected result: configuration applied; image unchanged)` };
  const repository = "undetermined: no configuration declares the repository the pipeline pushes to (nothing is guessed)";
  const parameter = scope.mapping.imageTagParameter;
  if (parameter !== undefined && parameters[parameter] !== undefined) {
    return { status: "determined", repository: null, tag: parameters[parameter] as string, detail: `tag from parameter "${parameter}"; repository ${repository}` };
  }
  if (imageTag !== null) return { status: "determined", repository: null, tag: imageTag, detail: `tag from pushedTagTemplate ${scope.mapping.pushedTagTemplate ?? ""}; repository ${repository}` };
  return { status: "undetermined", repository: null, tag: null, detail: "the mapping declares neither imageTagParameter nor pushedTagTemplate: the pushed tag is undetermined" };
}

function stageOf(scope: PreviewScope): Preview["stage"] {
  return { name: scope.stage.name, mode: scope.stage.promotion.mode, owner: scope.stage.promotion.owner ?? null, operatorTeam: scope.ws.operatorTeam ?? null, triggerable: true };
}

function pipelineOf(scope: PreviewScope, found: PipelineInfo | null, detail: string): Preview["pipeline"] {
  return {
    declared: describeDeclared(scope.mapping),
    status: found === null ? "missing" : "found",
    id: found?.id ?? scope.mapping.pipelineId ?? null,
    name: found?.name ?? scope.mapping.pipelineName ?? null,
    folder: found?.folder ?? null,
    link: found?.link ?? null,
    detail,
  };
}

/** Where the Git Refs check reads the ref (see the module comment). */
function repositoryOf(mapping: PipelineMapping, pipeline: PipelineInfo): { value: string; source: "mapping" | "pipeline-configuration" } | { blocker: string } {
  const reported = pipeline.repository;
  if (reported !== null && !AZURE_REPOS_TYPES.includes(reported.type.toLowerCase())) {
    return { blocker: `the pipeline's repository is of type "${reported.type}", not Azure Repos Git: the Git Refs remote-head check is impossible, and the Runs API pin alone is not relied on` };
  }
  if (mapping.repository !== undefined) return { value: mapping.repository, source: "mapping" };
  if (reported !== null) return { value: reported.id, source: "pipeline-configuration" };
  return { blocker: `neither pinning nor the ref check is possible: the mapping declares no "repository" and Pipelines Get names no Azure Repos Git repository for pipeline ${pipeline.id}; declare "repository" in the mapping` };
}

/** The local HEAD relation to the commit that will be built. */
function localHeadOf(clone: string, commit: string, timeoutMs: number): NonNullable<Preview["localHead"]> {
  const head = headCommit(clone, timeoutMs);
  if ("error" in head) return { sha: null, shortSha: null, relation: "unknown", buildable: false, detail: `the clone's HEAD could not be read (${head.error})` };
  const base = { sha: head.sha, shortSha: shortOf(head.sha) };
  if (head.sha === commit) return { ...base, relation: "same", buildable: true, detail: `local HEAD is the commit that will be built` };
  // downstream = the remote head, upstream = local HEAD: "behind" = HEAD has commits beyond the remote head.
  const delta = compareCommits(clone, commit, head.sha, timeoutMs);
  switch (delta.verdict) {
    case "behind":
      return { ...base, relation: "unpushed", buildable: false, detail: `local HEAD ${base.shortSha} has ${delta.count ?? delta.pending.length} commit(s) that are not on the remote ref: not buildable (push them, then preview again); the run builds ${shortOf(commit)}` };
    case "ahead":
      return { ...base, relation: "older", buildable: true, detail: `local HEAD ${base.shortSha} is ${delta.count ?? delta.extra.length} commit(s) behind the remote ref; the run builds ${shortOf(commit)}` };
    case "diverged":
      return { ...base, relation: "diverged", buildable: false, detail: `local HEAD ${base.shortSha} has diverged from the remote ref: its own commits are not buildable; the run builds ${shortOf(commit)}` };
    default:
      return { ...base, relation: "unknown", buildable: false, detail: `the relation of local HEAD ${base.shortSha} to the remote ref is unknown (${delta.reason ?? "no reason"})` };
  }
}

/** Compares the target's mapping in the working tree with the one at `sha`. */
function componentAtCommitOf(scope: PreviewScope, sha: string): NonNullable<Preview["componentAtCommit"]> {
  const read = readComponentAtCommit(scope.loaded, scope.member.member.name, sha);
  if (read.status === "missing" || read.status === "git-error") return { status: read.status, label: read.label, mappingMatches: false, detail: `component.json at ${shortOf(sha)} could not be read: ${read.detail}` };
  if (read.status === "invalid") return { status: "invalid", label: read.label, mappingMatches: false, detail: `component.json at ${shortOf(sha)} is invalid (a blocking finding): ${read.error.describe()}` };
  const atCommit = canonicalize(read.component, COMPONENT_SCHEMA);
  const working = canonicalize(scope.member.component, COMPONENT_SCHEMA);
  const find = (component: typeof atCommit) => component.stages[scope.stage.name]?.targets.find((target) => target.name === scope.target.name)?.pipeline;
  const there = find(atCommit);
  const here = find(working);
  const nonCanonical = read.state === "non-canonical" ? " (non-canonical at that commit; used as is)" : "";
  if (there === undefined) return { status: "ok", label: read.label, mappingMatches: false, detail: `component.json at ${shortOf(sha)} has no pipeline mapping for ${scope.stage.name}/${scope.target.name}${nonCanonical}` };
  if (here === undefined || canonicalStringify(there) !== canonicalStringify(here)) {
    return { status: "ok", label: read.label, mappingMatches: false, detail: `the pipeline mapping of ${scope.stage.name}/${scope.target.name} at ${shortOf(sha)} differs from the working tree's${nonCanonical}` };
  }
  return { status: "ok", label: read.label, mappingMatches: true, detail: `the pipeline mapping at ${shortOf(sha)} equals the working tree's${nonCanonical}` };
}

/** The Runs API path of a pipeline (relative to the organization URL). */
export function queuePath(project: string, pipelineId: number): string {
  return `/${encodeURIComponent(project)}/_apis/pipelines/${pipelineId}/runs?api-version=${API_VERSION}`;
}

/**
 * Computes the preview with GETs only (Pipelines Get, Git Refs) plus read-only git. A condition
 * that prevents the run is returned as a blocker (no token), never thrown.
 * @throws EngineError 20 / 21 from the REST client.
 */
export async function computePreview(scope: PreviewScope, reader: AzureDevOpsReader): Promise<Preview> {
  const organizationUrl = reader.organizationUrl;
  const component = scope.member.member.name;
  const timeoutMs = scope.ws.gitTimeoutSeconds * 1000;
  const blockers: PreviewBlocker[] = [];
  const base = {
    organizationUrl,
    project: scope.project,
    component,
    stage: stageOf(scope),
    target: scope.target.name,
    ref: scope.mapping.ref,
    action: scope.action,
    selections: scope.selections,
    verification: verificationOf(scope),
  };
  const templates = parameterTemplates(scope.mapping, scope.action.name);
  const selectable = scope.mapping.userSelectable ?? {};
  const unrendered = (): PreviewParameter[] => [
    ...templates.map(({ name, template, source }) => ({ name, value: template, source, template, allowed: null })),
    ...Object.entries(scope.selections).map(([name, value]) => ({ name, value, source: "userSelectable" as const, template: null, allowed: selectable[name] ?? [] })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blocked = (pipeline: Preview["pipeline"], repository: Preview["repository"], extra: Partial<Preview> = {}): Preview => ({
    ...base,
    pipeline,
    repository,
    parameters: unrendered(),
    commit: null,
    localHead: null,
    componentAtCommit: null,
    image: scope.action.kind === "configuration" ? imageOf(scope, {}, null) : { status: "undetermined", repository: null, tag: null, detail: "not determined: the preview is blocked" },
    request: null,
    binding: null,
    blockers,
    ...extra,
  });

  const resolved = await resolvePipeline(reader, scope.project, scope.mapping);
  if (resolved.status === "missing") {
    blockers.push({ exitCode: EXIT.MISSING, code: "pipeline-missing", detail: resolved.detail });
    return blocked(pipelineOf(scope, null, resolved.detail), null);
  }
  const pipeline = resolved.pipeline;
  const pipelineReport = pipelineOf(scope, pipeline, `pipeline ${pipeline.id} "${pipeline.name}" exists (Pipelines Get proves existence only; parameters are validated locally against the mapping, D7)`);
  const repo = repositoryOf(scope.mapping, pipeline);
  if ("blocker" in repo) {
    blockers.push({ exitCode: EXIT.REFUSED, code: "no-ref-check", detail: repo.blocker });
    return blocked(pipelineReport, null);
  }
  let head;
  try {
    head = await reader.getRefHead(scope.project, repo.value, scope.mapping.ref);
  } catch (error) {
    if (error instanceof EngineError && error.exitCode === EXIT.MISSING) {
      blockers.push({ exitCode: EXIT.MISSING, code: "repository-missing", detail: `${error.message}: the remote head of ${scope.mapping.ref} cannot be read` });
      return blocked(pipelineReport, repo);
    }
    throw error;
  }
  if (head === null) {
    blockers.push({ exitCode: EXIT.MISSING, code: "ref-missing", detail: `${scope.mapping.ref} does not exist in repository "${repo.value}": there is nothing to build` });
    return blocked(pipelineReport, repo);
  }
  const sha = head.objectId;
  const shortSha = shortOf(sha);

  const local = commitSummary(scope.member.clone, sha, timeoutMs);
  const inLocalClone = !("error" in local);
  const commit = { sha, shortSha, source: "remote-ref-head" as const, onRemoteRef: true as const, inLocalClone, subject: inLocalClone ? local.subject : null, date: inLocalClone ? local.date : null };
  let localHead: Preview["localHead"] = null;
  let componentAtCommit: Preview["componentAtCommit"] = null;
  if (!inLocalClone) {
    blockers.push({ exitCode: EXIT.REFUSED, code: "commit-not-local", detail: `the local clone does not contain ${shortSha}, the remote head of ${scope.mapping.ref}: fetch the clone (release-radar never fetches), re-run change-risk, then preview again` });
  } else {
    localHead = localHeadOf(scope.member.clone, sha, timeoutMs);
    componentAtCommit = componentAtCommitOf(scope, sha);
    if (!componentAtCommit.mappingMatches) blockers.push({ exitCode: EXIT.REFUSED, code: "config-at-commit", detail: `${componentAtCommit.detail}: the run would use a mapping the promoted commit does not carry` });
  }

  const imageTag = scope.mapping.pushedTagTemplate === undefined ? null : render(scope.mapping.pushedTagTemplate, { sha, shortSha, component, target: scope.target.name, imageTag: null });
  const values: PlaceholderValues = { sha, shortSha, component, target: scope.target.name, imageTag };
  const parameters: PreviewParameter[] = [
    ...templates.map(({ name, template, source }) => ({ name, value: render(template, values), source, template, allowed: null })),
    ...Object.entries(scope.selections).map(([name, value]) => ({ name, value, source: "userSelectable" as const, template: null, allowed: selectable[name] ?? [] })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const templateParameters: Record<string, string> = {};
  for (const parameter of parameters) templateParameters[parameter.name] = parameter.value;

  const body: QueueBody = { resources: { repositories: { self: { refName: scope.mapping.ref, version: sha } } }, templateParameters };
  const binding: TokenBinding = {
    organizationUrl,
    project: scope.project,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    repository: repo.value,
    ref: scope.mapping.ref,
    commit: sha,
    component,
    stage: scope.stage.name,
    target: scope.target.name,
    action: scope.action.name,
    actionKind: scope.action.kind,
    parameters: templateParameters,
    selections: scope.selections,
    engineVersion: engineVersion(),
  };
  const ok = blockers.length === 0;
  return {
    ...base,
    pipeline: pipelineReport,
    repository: repo,
    parameters,
    commit,
    localHead,
    componentAtCommit,
    image: imageOf(scope, templateParameters, imageTag),
    request: ok ? { path: queuePath(scope.project, pipeline.id), body } : null,
    binding: ok ? binding : null,
    blockers,
  };
}

/** The exit code of a blocked preview (precedence: 26 before 23). */
export function blockerExit(blockers: readonly PreviewBlocker[]): number {
  return blockers.some((blocker) => blocker.exitCode === EXIT.REFUSED) ? EXIT.REFUSED : EXIT.MISSING;
}

// ---------------------------------------------------------------------------
// Token

/** A decoded token (shape-checked; not yet compared with anything). */
export interface DecodedToken {
  readonly commit: string;
  readonly digest: string;
  readonly expiresAt: string;
}

/** sha256 over the recursive canonical form of the binding plus `expiresAt`. */
export function bindingDigest(binding: TokenBinding, expiresAt: string): string {
  return canonicalHash({ binding, expiresAt });
}

/** Issues a token for `binding`, valid for `ttlMinutes` from `now`. */
export function issueToken(binding: TokenBinding, now: Date, ttlMinutes: number): { readonly value: string; readonly expiresAt: string } {
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const payload = canonicalStringify({ commit: binding.commit, digest: bindingDigest(binding, expiresAt), expiresAt, v: 1 });
  return { value: `${TOKEN_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`, expiresAt };
}

function tokenError(message: string): EngineError {
  return new EngineError(EXIT.TOKEN, "token", `${message}; nothing was sent — run pipeline-preview again, show it, confirm, and pass its new token`);
}

/**
 * Decodes a token and checks its expiry against `nowMs` (no network). A token claiming an expiry
 * beyond now + `ttlMinutes` (+ {@link TOKEN_SKEW_MS}) was not issued under this TTL and is refused.
 * @throws EngineError 27 for a missing, malformed or expired token.
 */
export function decodeToken(value: string | null, nowMs: number, ttlMinutes: number): DecodedToken {
  if (value === null || value.trim() === "") throw tokenError("no confirmation token (--confirm <token> from pipeline-preview)");
  if (value.length > MAX_TOKEN_LENGTH || !value.startsWith(TOKEN_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(value.slice(TOKEN_PREFIX.length))) {
    throw tokenError("the confirmation token is malformed (not a pipeline-preview token)");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(value.slice(TOKEN_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw tokenError("the confirmation token is malformed (its payload does not decode)");
  }
  const object = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const keys = object === null ? [] : Object.keys(object).sort();
  if (object === null || canonicalStringify(keys) !== canonicalStringify(["commit", "digest", "expiresAt", "v"]) || object["v"] !== 1) {
    throw tokenError("the confirmation token is malformed (unexpected payload)");
  }
  const { commit, digest, expiresAt } = object;
  if (typeof commit !== "string" || !COMMIT.test(commit) || typeof digest !== "string" || !DIGEST.test(digest) || typeof expiresAt !== "string") {
    throw tokenError("the confirmation token is malformed (unexpected payload)");
  }
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires) || new Date(expires).toISOString() !== expiresAt) throw tokenError("the confirmation token is malformed (bad expiry)");
  if (nowMs >= expires) throw tokenError(`the confirmation token expired at ${expiresAt} (confirmTokenTtlMinutes ${ttlMinutes})`);
  if (expires - nowMs > ttlMinutes * 60_000 + TOKEN_SKEW_MS) throw tokenError(`the confirmation token claims an expiry (${expiresAt}) beyond the configured confirmTokenTtlMinutes (${ttlMinutes})`);
  return { commit, digest, expiresAt };
}

/**
 * Compares a decoded token with the recomputed binding.
 * @throws EngineError 27 when the remote head moved or any bound field differs.
 */
export function verifyToken(token: DecodedToken, binding: TokenBinding): void {
  if (token.commit !== binding.commit) {
    throw tokenError(`the remote head of ${binding.ref} moved since the preview: previewed ${shortOf(token.commit)}, now ${shortOf(binding.commit)}`);
  }
  if (bindingDigest(binding, token.expiresAt) !== token.digest) {
    throw tokenError(
      "the confirmation token does not match the recomputed request: something it binds (organization, project, pipeline, repository, ref, commit, component, stage, target, action, a parameter value, a userSelectable choice or the engine version) differs from the preview",
    );
  }
}
