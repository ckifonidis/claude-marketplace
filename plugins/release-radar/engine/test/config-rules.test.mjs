// Strict configuration rules (spec requirements 31, 31a, 31c, 33-35, 37, 40, 40a).
// Every rule fails with EngineError 24 at a JSON pointer naming the key; nothing is defaulted.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENT_SCHEMA,
  PLACEHOLDERS,
  WORKSPACE_SCHEMA,
  checkComponent,
  checkWorkspace,
  effectiveTagConvention,
  findStage,
  isTriggerable,
  smokeDisposition,
  templatePlaceholders,
} from "../dist/config.js";
import { classify, validate } from "../dist/format.js";
import { parseChecklist } from "../dist/checklist.js";
import { apiComponentValue, expectEngineError, text, workerComponentValue, workspaceValue } from "./fixtures/workspace-fixtures.mjs";

const WS = "acme-platform/.release-radar/workspace.json";
const COMP = "acme-api/.release-radar/component.json";

function checkWs(value) {
  const workspace = validate(value, WORKSPACE_SCHEMA, WS);
  checkWorkspace(workspace, WS);
  return workspace;
}

function checkComp(value, workspace = workspaceValue(), member = "acme-api") {
  const ws = checkWs(workspace);
  const component = validate(value, COMPONENT_SCHEMA, COMP);
  checkComponent(component, ws, member, COMP, WS);
  return component;
}

function wsInvalid(edit, pointer, message) {
  const value = workspaceValue();
  edit(value);
  expectEngineError(assert, () => checkWs(value), { exitCode: 24, file: WS, pointer, message });
}

function compInvalid(edit, pointer, message, workspaceEdit) {
  const value = apiComponentValue();
  edit(value);
  const workspace = workspaceValue();
  workspaceEdit?.(workspace);
  expectEngineError(assert, () => checkComp(value, workspace), { exitCode: 24, file: COMP, pointer, message });
}

const api1 = (v) => v.stages["stage-1"];
const mapping = (v) => v.stages["stage-1"].targets[0].pipeline;
const checks = (v) => v.stages["stage-1"].verification.checks;

// --- the valid fixtures ------------------------------------------------------------------------

test("the synthetic workspace and both components pass every rule", () => {
  const ws = checkWs(workspaceValue());
  checkComp(apiComponentValue());
  checkComp(workerComponentValue(), workspaceValue(), "acme-worker");
  assert.equal(ws.stages.length, 2);
});

test("round trip: the canonical workspace and component fixtures classify as canonical", () => {
  for (const [value, schema] of [
    [workspaceValue(), WORKSPACE_SCHEMA],
    [apiComponentValue(), COMPONENT_SCHEMA],
    [workerComponentValue(), COMPONENT_SCHEMA],
  ]) {
    const result = classify(text(value), schema, "fixture.json");
    assert.equal(result.state, "canonical", JSON.stringify(result.changes));
    assert.equal(result.rendered, text(value));
  }
});

// --- missing / unknown keys, schemaVersion --------------------------------------------------

test("37: a missing workspace key is fatal and named", () => {
  wsInvalid((v) => delete v.freshnessMinutes, "/freshnessMinutes", /missing required key "freshnessMinutes"/);
});

test("37: a missing component key is fatal and named", () => {
  compInvalid((v) => delete v.name, "/name", /missing required key "name"/);
});

test("37: an unknown workspace key is fatal and named", () => {
  wsInvalid((v) => (v.stages[0].colour = "blue"), "/stages/0/colour", /unknown key "colour"/);
});

test("28/31: a workspace carrying component definitions is invalid", () => {
  wsInvalid((v) => (v.components = [{ name: "acme-api" }]), "/components", /unknown key "components"/);
  wsInvalid((v) => (v.members[0].targets = []), "/members/0/targets", /unknown key "targets"/);
});

test("37: an unknown component key is fatal and named", () => {
  compInvalid((v) => (api1(v).targets[0].region = "x"), "/stages/stage-1/targets/0/region", /unknown key "region"/);
});

test("37: a missing schemaVersion is fatal", () => {
  wsInvalid((v) => delete v.schemaVersion, "/schemaVersion", /missing required key "schemaVersion"/);
  compInvalid((v) => delete v.schemaVersion, "/schemaVersion", /missing required key "schemaVersion"/);
});

test("37: an unsupported schemaVersion is fatal", () => {
  wsInvalid((v) => (v.schemaVersion = 2), "/schemaVersion", /unsupported schemaVersion 2/);
  compInvalid((v) => (v.schemaVersion = 9), "/schemaVersion", /unsupported schemaVersion 9/);
});

// --- duplicates -------------------------------------------------------------------------------

test("37: two stages with the same name and different content are fatal", () => {
  wsInvalid((v) => v.stages.push({ ...v.stages[0], tagConvention: { type: "none" } }), "/stages/2/name", /duplicate name "stage-1" with different content/);
});

test("37: two members with the same name and different content are fatal", () => {
  wsInvalid((v) => v.members.push({ name: "acme-api", repoKey: "acme-other", repoSubdir: null }), "/members/2/name", /duplicate name "acme-api"/);
});

test("37: two targets with the same name and different content are fatal", () => {
  compInvalid((v) => api1(v).targets.push({ ...api1(v).targets[1], deployment: "other" }), "/stages/stage-1/targets/2/name", /duplicate name "api-internal"/);
});

test("37: two checks with the same name and different content are fatal", () => {
  compInvalid((v) => checks(v).push({ name: "health", type: "smoke", argv: ["x"] }), "/stages/stage-1/verification/checks/3/name", /duplicate name "health"/);
});

test("37/81: byte-identical duplicates are not fatal — the file is non-canonical and format de-duplicates", () => {
  const ws = workspaceValue();
  ws.members.push({ ...ws.members[0] });
  const result = classify(text(ws), WORKSPACE_SCHEMA, WS);
  assert.equal(result.state, "non-canonical");
  assert.equal(result.value.members.length, 2);
  assert.ok(result.changes.some((change) => change.startsWith("duplicate entry removed at /members/2")));
});

// --- stages -----------------------------------------------------------------------------------

test("37: the reserved stage name local is fatal", () => {
  wsInvalid((v) => (v.stages[0].name = "local"), "/stages/0/name", /"local" is a reserved stage name/);
});

test("37/31c: targets on a stage the workspace does not declare are fatal", () => {
  compInvalid((v) => (v.stages["stage-9"] = null), "/stages/stage-9", /"stage-9" is not a stage declared by/);
});

test("37: a workspace stage omitted from component.json (no explicit null) is fatal", () => {
  compInvalid((v) => delete v.stages["stage-2"], "/stages/stage-2", /missing required key "stage-2".*null = not deployed/);
});

test("31a: an explicit null stage means not deployed by design and is valid", () => {
  const component = checkComp(workerComponentValue(), workspaceValue(), "acme-worker");
  assert.equal(component.stages["stage-2"], null);
});

test("31a: a tag-convention override for an undeclared stage is fatal", () => {
  compInvalid((v) => (v.tagConventionOverrides["stage-9"] = { type: "none" }), "/tagConventionOverrides/stage-9", /not a stage declared/);
});

// --- members ----------------------------------------------------------------------------------

test("31c/37: the same repoKey and the same repoSubdir for two members is fatal", () => {
  wsInvalid((v) => ((v.members[1].repoKey = "acme-api"), (v.members[1].repoSubdir = null)), "/members/1/repoSubdir",
    /repoKey "acme-api" with the repository root is already used by \/members\/0/);
  wsInvalid((v) => (v.members[0].repoSubdir = "worker", v.members[0].repoKey = "acme-worker"), "/members/1/repoSubdir",
    /repoKey "acme-worker" with repoSubdir "worker" is already used by \/members\/0/);
});

test("31c: monorepo — one repoKey with different repoSubdirs is valid", () => {
  const ws = workspaceValue();
  ws.members[0].repoKey = "acme-worker";
  ws.members[0].repoSubdir = "api";
  assert.doesNotThrow(() => checkWs(ws));
});

test("37: an empty-string repoKey is fatal", () => {
  wsInvalid((v) => (v.members[0].repoKey = ""), "/members/0/repoKey", /shorter than 1/);
});

test("37: a repoSubdir without a repoKey is fatal", () => {
  wsInvalid((v) => (v.members[1].repoKey = null), "/members/1/repoSubdir", /"repoSubdir" must be null when "repoKey" is null/);
});

test("37: a repoSubdir escaping the repository is fatal", () => {
  wsInvalid((v) => (v.members[1].repoSubdir = "../elsewhere"), "/members/1/repoSubdir", /must not contain '\.\.'/);
});

test("31a: a component name that differs from its member is fatal", () => {
  compInvalid((v) => (v.name = "acme-api-v2"), "/name", /component name "acme-api-v2" differs from its member name "acme-api"/);
});

// --- non-positive values ------------------------------------------------------------------------

const NON_POSITIVE = [
  ["gitTimeoutSeconds", (v) => (v.gitTimeoutSeconds = 0), "/gitTimeoutSeconds"],
  ["adapter timeoutSeconds", (v) => (v.adapters.kubernetes.timeoutSeconds = -5), "/adapters/kubernetes/timeoutSeconds"],
  ["azureDevOps.requestTimeoutSeconds", (v) => (v.azureDevOps.requestTimeoutSeconds = 0), "/azureDevOps/requestTimeoutSeconds"],
  ["azureDevOps.runHistoryCount", (v) => (v.azureDevOps.runHistoryCount = 0), "/azureDevOps/runHistoryCount"],
  ["azureDevOps.followPollSeconds", (v) => (v.azureDevOps.followPollSeconds = 0), "/azureDevOps/followPollSeconds"],
  ["snapshotRetention", (v) => (v.snapshotRetention = 0), "/snapshotRetention"],
  ["handoffRetention", (v) => (v.handoffRetention = -1), "/handoffRetention"],
  ["freshnessMinutes", (v) => (v.freshnessMinutes = 0), "/freshnessMinutes"],
];
for (const [label, edit, pointer] of NON_POSITIVE) {
  test(`37: a non-positive ${label} is fatal`, () => wsInvalid(edit, pointer, /expected a positive integer/));
}

test("37: a non-positive landedWaitMinutes is fatal", () => {
  compInvalid((v) => (mapping(v).landedWaitMinutes = 0), "/stages/stage-1/targets/0/pipeline/landedWaitMinutes", /expected a positive integer/);
});

test("37: a non-positive verification timeout is fatal", () => {
  compInvalid((v) => (api1(v).verification.timeoutSeconds = 0), "/stages/stage-1/verification/timeoutSeconds", /expected a positive integer/);
  compInvalid((v) => (checks(v)[2].timeoutSeconds = -1), "/stages/stage-1/verification/checks/2/timeoutSeconds", /expected a positive integer/);
});

// --- closed sets --------------------------------------------------------------------------------

test("37: an unknown adapter is fatal", () => {
  compInvalid((v) => (api1(v).targets[1].adapter = "nomad"), "/stages/stage-1/targets/1/adapter", /"nomad" is not one of/);
});

test("37: an unknown promotion mode is fatal", () => {
  wsInvalid((v) => (v.stages[0].promotion.mode = "auto"), "/stages/0/promotion/mode", /"auto" is not one of/);
});

test("37: an unknown pipeline provider is fatal", () => {
  compInvalid((v) => (mapping(v).provider = "other-ci"), "/stages/stage-1/targets/0/pipeline/provider", /expected "azure-devops"/);
});

test("37: an unknown action kind is fatal", () => {
  compInvalid((v) => (mapping(v).actions.build.kind = "deploy"), "/stages/stage-1/targets/0/pipeline/actions/build/kind", /"deploy" is not one of/);
});

test("37: an unknown check type is fatal", () => {
  compInvalid((v) => (checks(v)[1].type = "ping"), "/stages/stage-1/verification/checks/1/type", /"ping" is not one of/);
});

test("37: an unknown tag convention is fatal", () => {
  wsInvalid((v) => (v.stages[0].tagConvention = { type: "semver" }), "/stages/0/tagConvention/type", /"semver" is not one of/);
});

test("37: an unknown checklist severity is fatal (exit 24 with the line)", () => {
  const checklist = "# release-radar checklist\n\nschemaVersion: 1\n\n## env-vars\n- layer: fleet\n- severity: urgent\n- paths: src/**\n- signal: a\n- prepare: b\n";
  expectEngineError(assert, () => parseChecklist(checklist, "checks.md", "fleet"), { exitCode: 24, message: /urgent/ });
});

// --- promotion / ownership ---------------------------------------------------------------------

test("37: a promotion.owner without an operatorTeam is fatal", () => {
  wsInvalid((v) => delete v.operatorTeam, "/operatorTeam", /missing required key "operatorTeam"/);
});

test("32: a pipeline or handoff stage without an owner is fatal", () => {
  wsInvalid((v) => delete v.stages[1].promotion.owner, "/stages/1/promotion/owner", /required when mode is "handoff"/);
});

test("32: triggerable = mode pipeline AND owner == operatorTeam", () => {
  const ws = checkWs(workspaceValue());
  assert.equal(isTriggerable(ws, findStage(ws, "stage-1")), true);
  assert.equal(isTriggerable(ws, findStage(ws, "stage-2")), false, "handoff stage");
  const other = workspaceValue();
  other.stages[0].promotion.owner = "ops-team";
  const otherWs = checkWs(other);
  assert.equal(isTriggerable(otherWs, findStage(otherWs, "stage-1")), false, "another team's pipeline stage");
});

test("40a: a smoke check on a stage not owned by operatorTeam is valid config, reported as not run", () => {
  const ws = checkWs(workspaceValue());
  const component = checkComp(apiComponentValue());
  assert.equal(component.stages["stage-2"].verification.checks[0].type, "smoke");
  assert.equal(smokeDisposition(ws, findStage(ws, "stage-2")), "not-run-stage-not-owned");
  assert.equal(smokeDisposition(ws, findStage(ws, "stage-1")), "run");
});

// --- pipeline mappings --------------------------------------------------------------------------

test("33/37: a pipeline mapping on a stage that is not pipeline is fatal", () => {
  compInvalid(
    (v) => (v.stages["stage-2"].targets[0].pipeline = structuredClone(mapping(apiComponentValue()))),
    "/stages/stage-2/targets/0/pipeline",
    /only allowed on a "pipeline" stage; "stage-2" is "handoff"/,
  );
});

test("33: a pipeline mapping without the workspace azureDevOps block is fatal", () => {
  compInvalid(() => {}, "/stages/stage-1/targets/0/pipeline", /requires the "azureDevOps" block/, (ws) => delete ws.azureDevOps);
});

test("37: a missing primaryAction is fatal", () => {
  compInvalid((v) => delete mapping(v).primaryAction, "/stages/stage-1/targets/0/pipeline/primaryAction", /missing required key "primaryAction"/);
});

test("37: an undeclared primaryAction is fatal", () => {
  compInvalid((v) => (mapping(v).primaryAction = "deploy"), "/stages/stage-1/targets/0/pipeline/primaryAction", /"deploy" is not a declared action/);
});

test("33: an unknown placeholder is fatal", () => {
  compInvalid((v) => (mapping(v).parameters.imageTag = "{commit.message}"), "/stages/stage-1/targets/0/pipeline/parameters/imageTag", /unknown placeholder \{commit\.message\}/);
  compInvalid((v) => (mapping(v).actions.config.parameters.action = "{secret}"), "/stages/stage-1/targets/0/pipeline/actions/config/parameters/action", /unknown placeholder/);
});

test("33: a malformed placeholder is fatal", () => {
  compInvalid((v) => (mapping(v).parameters.imageTag = "{commit.sha"), "/stages/stage-1/targets/0/pipeline/parameters/imageTag", /unmatched "\{"/);
});

test("33: the placeholder set is closed and recognised", () => {
  assert.deepEqual(templatePlaceholders(`${PLACEHOLDERS.join("-")}`), { placeholders: [...PLACEHOLDERS] });
  assert.deepEqual(templatePlaceholders("literal"), { placeholders: [] });
});

test("33: an action setting an undeclared parameter is fatal", () => {
  compInvalid((v) => (mapping(v).actions.build.parameters.skipTests = "true"), "/stages/stage-1/targets/0/pipeline/actions/build/parameters/skipTests", /undeclared parameter "skipTests"/);
});

test("33: an empty action set is fatal", () => {
  compInvalid(
    (v) => {
      mapping(v).actions = {};
    },
    "/stages/stage-1/targets/0/pipeline/actions",
    /at least one action/,
  );
});

test("34: a userSelectable parameter that is also templated is fatal", () => {
  compInvalid((v) => (mapping(v).userSelectable.imageTag = ["a"]), "/stages/stage-1/targets/0/pipeline/userSelectable/imageTag", /both templated and userSelectable/);
});

test("34: an action cannot set a userSelectable parameter", () => {
  compInvalid((v) => (mapping(v).actions.build.parameters.region = "region-a"), "/stages/stage-1/targets/0/pipeline/actions/build/parameters/region", /userSelectable/);
});

test("34: a userSelectable parameter needs a non-empty closed list", () => {
  compInvalid((v) => (mapping(v).userSelectable.region = []), "/stages/stage-1/targets/0/pipeline/userSelectable/region", /at least 1 item/);
});

test("33: a mapping needs a pipeline id or name", () => {
  compInvalid((v) => delete mapping(v).pipelineId, "/stages/stage-1/targets/0/pipeline/pipelineId", /"pipelineId" or "pipelineName"/);
});

test("33: a mapping ref must be a full ref", () => {
  compInvalid((v) => (mapping(v).ref = "main"), "/stages/stage-1/targets/0/pipeline/ref", /does not match/);
});

// --- handoff artefacts --------------------------------------------------------------------------

test("35/37: handoff artefacts on a stage that is not handoff are fatal", () => {
  compInvalid((v) => (api1(v).handoff = { settingsFiles: ["config/settings.json"] }), "/stages/stage-1/handoff", /only allowed on a "handoff" stage; "stage-1" is "pipeline"/);
});

test("35: a handoff settings path escaping the component root is fatal", () => {
  compInvalid((v) => (v.stages["stage-2"].handoff.settingsFiles = ["../secrets.json"]), "/stages/stage-2/handoff/settingsFiles/0", /must not contain '\.\.'/);
});

// --- verification -------------------------------------------------------------------------------

test("37/40: a verification method other than GET or HEAD is fatal", () => {
  compInvalid((v) => (checks(v)[0].method = "POST"), "/stages/stage-1/verification/checks/0/method", /"POST" is not one of: "GET", "HEAD"/);
});

test("37/40: an inline header value is fatal (headers only via {env})", () => {
  compInvalid((v) => (checks(v)[0].headers["X-Api-Key"] = "s3cr3t-value"), "/stages/stage-1/verification/checks/0/headers/X-Api-Key", /expected object, got string/);
  compInvalid((v) => (checks(v)[0].headers["X-Api-Key"] = { value: "inline" }), "/stages/stage-1/verification/checks/0/headers/X-Api-Key/value", /unknown key "value"/);
});

test("40: a header env var name must be a valid variable name", () => {
  compInvalid((v) => (checks(v)[0].headers["X-Api-Key"] = { env: "1-BAD" }), "/stages/stage-1/verification/checks/0/headers/X-Api-Key/env", /does not match/);
});

test("40: a check narrowed to a target the stage does not have is fatal", () => {
  compInvalid((v) => (checks(v)[0].target = "api-public"), "/stages/stage-1/verification/checks/0/target", /not a target of this stage/);
});

test("40: a check URL must be an absolute http(s) URL without credentials", () => {
  compInvalid((v) => (checks(v)[0].url = "/health"), "/stages/stage-1/verification/checks/0/url", /not an absolute URL/);
  compInvalid((v) => (checks(v)[0].url = "ftp://acme.example.com/x"), "/stages/stage-1/verification/checks/0/url", /http or https/);
  compInvalid((v) => (checks(v)[0].url = "https://user:pw@acme.example.com/"), "/stages/stage-1/verification/checks/0/url", /credentials/);
});

test("40: an expected status outside 100-599 is fatal", () => {
  compInvalid((v) => (checks(v)[0].expectStatus = [200, 700]), "/stages/stage-1/verification/checks/0/expectStatus/1", /100-599/);
});

test("40: a version extract must be a supported JSON path or a regex with a version group", () => {
  compInvalid((v) => (checks(v)[2].extract.path = "build.commit"), "/stages/stage-1/verification/checks/2/extract/path", /not a supported JSON path/);
  compInvalid((v) => (checks(v)[2].extract = { type: "regex", pattern: "commit=(\\w+)" }), "/stages/stage-1/verification/checks/2/extract/pattern", /named group "version"/);
});

test("40: smoke argv must be a non-empty array of non-empty strings", () => {
  compInvalid((v) => (checks(v)[1].argv = []), "/stages/stage-1/verification/checks/1/argv", /at least 1 item/);
  compInvalid((v) => (checks(v)[1].argv = ["acme-cli", ""]), "/stages/stage-1/verification/checks/1/argv/1", /shorter than 1/);
});

// --- tag conventions, adapters, misc --------------------------------------------------------------

test("31: a regex tag convention must compile and capture a ref group", () => {
  wsInvalid((v) => (v.stages[1].tagConvention = { type: "regex", pattern: "^v(\\d+)$", resolveAs: { type: "sha" } }), "/stages/1/tagConvention/pattern", /named group "ref"/);
  wsInvalid((v) => (v.stages[1].tagConvention = { type: "regex", pattern: "^(?<ref>[", resolveAs: { type: "sha" } }), "/stages/1/tagConvention/pattern", /invalid regular expression/);
});

test("31a: the effective tag convention is the override when present, else the stage convention", () => {
  const ws = checkWs(workspaceValue());
  const component = checkComp(apiComponentValue());
  assert.deepEqual(effectiveTagConvention(ws, component, "stage-1"), { convention: { type: "sha" }, source: "stage" });
  assert.equal(effectiveTagConvention(ws, component, "stage-2").source, "override");
  assert.equal(effectiveTagConvention(ws, component, "stage-2").convention.type, "regex");
});

test("31: a target whose adapter has no workspace settings is fatal", () => {
  compInvalid(() => {}, "/stages/stage-1/targets/1/adapter", /requires "adapters.kubernetes"/, (ws) => delete ws.adapters.kubernetes);
});

test("24: an App Service target on a stage without subscriptions is fatal", () => {
  compInvalid(() => {}, "/stages/stage-2/targets/0/adapter", /stageSubscriptions\.stage-2/, (ws) => delete ws.adapters["azure-appservice"].stageSubscriptions["stage-2"]);
});

test("31: stage-keyed workspace maps must name declared stages", () => {
  wsInvalid((v) => (v.beforePromote["stage-7"] = "x"), "/beforePromote/stage-7", /not a declared stage/);
  wsInvalid((v) => (v.adapters["azure-appservice"].stageSubscriptions["stage-7"] = ["s"]), "/adapters/azure-appservice/stageSubscriptions/stage-7", /not a declared stage/);
});

test("31: the Azure DevOps organizationUrl must be a full base URL", () => {
  wsInvalid((v) => (v.azureDevOps.organizationUrl = "acme"), "/azureDevOps/organizationUrl", /not an absolute URL/);
});

test("31: the azureDevOps block requires every key", () => {
  wsInvalid((v) => delete v.azureDevOps.confirmTokenTtlMinutes, "/azureDevOps/confirmTokenTtlMinutes", /missing required key/);
  wsInvalid((v) => delete v.azureDevOps.patExpiryWarningDays, "/azureDevOps/patExpiryWarningDays", /missing required key/);
});

test("28: the command adapter's extract regex must capture an image group", () => {
  compInvalid(
    (v) => (api1(v).targets[1] = { name: "api-internal", adapter: "command", argv: ["acme-ctl", "show"], extract: { type: "regex", pattern: "image=(\\S+)" } }),
    "/stages/stage-1/targets/1/extract/pattern",
    /named group "image"/,
    (ws) => (ws.adapters.command = { timeoutSeconds: 5 }),
  );
});

test("36: an external repos file path must be relative (parents allowed)", () => {
  wsInvalid((v) => (v.reposFile = { kind: "external", path: "/abs/repos.json" }), "/reposFile/path", /relative path/);
  checkWs({ ...workspaceValue(), reposFile: { kind: "external", path: "../shared/repos.local.json" } });
});

test("37: the fleet checklist path must be relative without parents", () => {
  wsInvalid((v) => (v.checklist = "../checks.md"), "/checklist", /must not contain '\.\.'/);
});

// --- pushed-tag keys (plan D10; Phase 6) --------------------------------------------------------

test("D10/37: imageTagParameter must name a declared parameter", () => {
  compInvalid((v) => (mapping(v).imageTagParameter = "tag"), "/stages/stage-1/targets/0/pipeline/imageTagParameter", /undeclared parameter "tag" \(imageTagParameter must name a key of "parameters"\)/);
  compInvalid((v) => (mapping(v).imageTagParameter = "not a name"), "/stages/stage-1/targets/0/pipeline/imageTagParameter", /does not match/);
  const value = apiComponentValue();
  mapping(value).imageTagParameter = "imageTag";
  assert.equal(checkComp(value).stages["stage-1"].targets[0].pipeline.imageTagParameter, "imageTag");
});

test("D10/37: pushedTagTemplate uses only {commit.sha} {commit.shortSha} {component} {target} and literals", () => {
  compInvalid((v) => (mapping(v).pushedTagTemplate = "{image.tag}"), "/stages/stage-1/targets/0/pipeline/pushedTagTemplate", /placeholder \{image\.tag\} cannot describe the pushed tag/);
  compInvalid((v) => (mapping(v).pushedTagTemplate = "v{commit.when}"), "/stages/stage-1/targets/0/pipeline/pushedTagTemplate", /unknown placeholder \{commit\.when\}/);
  compInvalid((v) => (mapping(v).pushedTagTemplate = "{commit.sha"), "/stages/stage-1/targets/0/pipeline/pushedTagTemplate", /unmatched "\{"/);
  compInvalid((v) => (mapping(v).pushedTagTemplate = ""), "/stages/stage-1/targets/0/pipeline/pushedTagTemplate", /shorter than 1 character/);
  const value = apiComponentValue();
  mapping(value).pushedTagTemplate = "{component}-{commit.shortSha}";
  assert.equal(checkComp(value).stages["stage-1"].targets[0].pipeline.pushedTagTemplate, "{component}-{commit.shortSha}");
  const canonical = apiComponentValue();
  const m = mapping(canonical);
  const ordered = {};
  for (const key of ["provider", "pipelineId", "ref", "parameters", "userSelectable"]) ordered[key] = m[key];
  Object.assign(ordered, { imageTagParameter: "imageTag", pushedTagTemplate: "{commit.shortSha}" });
  for (const key of ["actions", "primaryAction", "landedWaitMinutes"]) ordered[key] = m[key];
  canonical.stages["stage-1"].targets[0].pipeline = ordered;
  assert.equal(classify(text(canonical), COMPONENT_SCHEMA, COMP).state, "canonical", "the keys sit after userSelectable in canonical order");
});
