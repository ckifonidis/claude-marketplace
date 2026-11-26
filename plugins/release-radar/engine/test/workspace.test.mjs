// Workspace loading and member resolution (spec requirements 31-31e, 37, 76a, 83, 84, 86).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  componentDifferences,
  configFingerprint,
  inspectWorkspace,
  loadWorkspace,
  readComponentAtCommit,
  requireAvailableMember,
  workspaceRootOf,
} from "../dist/workspace.js";
import { COMPONENT_SCHEMA, WORKSPACE_SCHEMA } from "../dist/config.js";
import { formatText } from "../dist/format.js";
import {
  apiComponentValue,
  buildFleet,
  commitAll,
  expectEngineError,
  git,
  initRepo,
  put,
  reposValue,
  tempDir,
  text,
  workerComponentValue,
  workspaceValue,
} from "./fixtures/workspace-fixtures.mjs";

const REQUIRE = { members: "all", canonical: "require" };

function statusOf(loaded, name) {
  return loaded.members.find((resolution) => resolution.member.name === name);
}

// --- member resolution ------------------------------------------------------------------------

test("76a: mapped and available — both members load from their own clones", (t) => {
  const fx = buildFleet(t);
  const loaded = loadWorkspace(fx.platform, REQUIRE);
  assert.equal(loaded.root, fx.platform);
  assert.deepEqual(loaded.members.map((m) => [m.member.name, m.status]), [
    ["acme-api", "available"],
    ["acme-worker", "available"],
  ]);
  const worker = statusOf(loaded, "acme-worker");
  assert.equal(worker.clone, fx.worker);
  assert.equal(worker.componentRoot, join(fx.worker, "worker"));
  assert.equal(worker.componentRepoPath, "worker/.release-radar/component.json");
  assert.equal(worker.report.owner, "member-repo");
  assert.equal(loaded.checklistFile, fx.checklist);
  assert.deepEqual(loaded.nonCanonical, []);
});

test("13: --workspace accepts the workspace root or its workspace.json; nothing is searched", (t) => {
  const fx = buildFleet(t);
  assert.equal(workspaceRootOf(fx.workspaceFile), fx.platform);
  assert.equal(loadWorkspace(fx.workspaceFile, REQUIRE).root, fx.platform);
  // A subdirectory of the workspace is not a workspace: no upward search here.
  const sub = join(fx.platform, "docs");
  mkdirSync(sub);
  expectEngineError(assert, () => loadWorkspace(sub, REQUIRE), { exitCode: 24, message: /workspace file not found/ });
});

test("76a: repoKey unmapped → unavailable (no local clone); non-fatal in a fleet run, 24 when requested", (t) => {
  const fx = buildFleet(t, { repos: reposValue({ "acme-api": "../../acme-api" }) });
  const loaded = loadWorkspace(fx.platform, REQUIRE);
  const worker = statusOf(loaded, "acme-worker");
  assert.equal(worker.status, "unavailable");
  assert.equal(worker.reason, "no-local-clone");
  assert.match(worker.detail, /repoKey "acme-worker" is not mapped/);
  expectEngineError(assert, () => loadWorkspace(fx.platform, { members: ["acme-worker"], canonical: "require" }), {
    exitCode: 24,
    file: fx.workspaceFile,
    message: /requested member "acme-worker" is unavailable \(no local clone\).*not mapped/,
  });
});

test("76a: clone path absent → unavailable (no local clone); 24 when requested", (t) => {
  const fx = buildFleet(t);
  rmSync(fx.worker, { recursive: true, force: true });
  const worker = statusOf(loadWorkspace(fx.platform, REQUIRE), "acme-worker");
  assert.equal(worker.reason, "no-local-clone");
  assert.match(worker.detail, /does not exist/);
  expectEngineError(assert, () => loadWorkspace(fx.platform, { members: ["acme-worker"], canonical: "require" }), { exitCode: 24, message: /no local clone/ });
});

test("76a: component.json absent → unavailable (no component config); 24 when requested", (t) => {
  const fx = buildFleet(t, { worker: null });
  const worker = statusOf(loadWorkspace(fx.platform, REQUIRE), "acme-worker");
  assert.equal(worker.reason, "no-component-config");
  assert.equal(worker.clone, fx.worker);
  assert.match(worker.detail, /worker\/\.release-radar\/component\.json does not exist/);
  expectEngineError(assert, () => loadWorkspace(fx.platform, { members: ["acme-worker"], canonical: "require" }), { exitCode: 24, message: /no component config/ });
});

test("76a: a member with repoKey null is unavailable (no clone by design)", (t) => {
  const fx = buildFleet(t, { workspace: (ws) => ((ws.members[1].repoKey = null), (ws.members[1].repoSubdir = null)) });
  const worker = statusOf(loadWorkspace(fx.platform, REQUIRE), "acme-worker");
  assert.equal(worker.reason, "no-local-clone");
  assert.match(worker.detail, /repoKey null/);
});

test("76a: a component.json name mismatch is fatal (24) even in a fleet run", (t) => {
  const fx = buildFleet(t, { api: (v) => void (v.name = "acme-gateway") });
  expectEngineError(assert, () => loadWorkspace(fx.platform, REQUIRE), { exitCode: 24, file: fx.apiComponent, pointer: "/name" });
});

test("76a: an undeclared stage in component.json is fatal (24)", (t) => {
  const fx = buildFleet(t, { worker: (v) => void (v.stages["stage-3"] = null) });
  expectEngineError(assert, () => loadWorkspace(fx.platform, REQUIRE), { exitCode: 24, file: fx.workerComponent, pointer: "/stages/stage-3" });
});

test("76a: the same repoKey AND repoSubdir for two members is fatal (24)", (t) => {
  const fx = buildFleet(t, {
    workspace: (ws) => void ((ws.members[1].repoKey = "acme-api"), (ws.members[1].repoSubdir = null)),
  });
  expectEngineError(assert, () => loadWorkspace(fx.platform, REQUIRE), {
    exitCode: 24,
    file: fx.workspaceFile,
    pointer: "/members/1/repoSubdir",
    message: /repoKey "acme-api" with the repository root is already used by \/members\/0/,
  });
});

test("76a: monorepo — two members share a repoKey with different repoSubdirs and both load", (t) => {
  const fx = buildFleet(t, {
    workspace: (ws) => void ws.members.splice(1, 0, { name: "acme-jobs", repoKey: "acme-worker", repoSubdir: "jobs" }),
  });
  const jobs = workerComponentValue();
  jobs.name = "acme-jobs";
  put(join(fx.worker, "jobs", ".release-radar", "component.json"), jobs);
  const loaded = loadWorkspace(fx.platform, REQUIRE);
  assert.deepEqual(loaded.members.map((m) => [m.member.name, m.status]), [
    ["acme-api", "available"],
    ["acme-jobs", "available"],
    ["acme-worker", "available"],
  ]);
  const jobsStatus = statusOf(loaded, "acme-jobs");
  const workerStatus = statusOf(loaded, "acme-worker");
  assert.equal(jobsStatus.clone, fx.worker);
  assert.equal(workerStatus.clone, fx.worker);
  assert.equal(jobsStatus.componentRoot, join(fx.worker, "jobs"));
  assert.equal(workerStatus.componentRoot, join(fx.worker, "worker"));
});

test("14: an unknown component name → 64 listing members, before any component file is read", (t) => {
  const fx = buildFleet(t);
  const reads = [];
  expectEngineError(assert, () => loadWorkspace(fx.platform, { members: ["acme-gateway"], canonical: "require", observer: (p) => reads.push(p) }), {
    exitCode: 64,
    message: /unknown component "acme-gateway" \(members: acme-api, acme-worker\)/,
  });
  assert.ok(!reads.some((path) => path.endsWith("component.json")), JSON.stringify(reads));
});

test("31b/76a: non-member repos and worktree-like siblings with identical component.json are never read", (t) => {
  const fx = buildFleet(t);
  // A worktree-like sibling holding an identical copy, and a non-member repo with its own config.
  const worktree = join(fx.base, "acme-api-worktree");
  cpSync(fx.api, worktree, { recursive: true });
  const outsider = initRepo(join(fx.base, "acme-outsider"));
  put(join(outsider, ".release-radar", "component.json"), { ...apiComponentValue(), name: "acme-outsider" });
  const reads = [];
  const loaded = loadWorkspace(fx.platform, { ...REQUIRE, observer: (path) => reads.push(path) });
  assert.equal(loaded.members.length, 2);
  assert.deepEqual(reads.sort(), [fx.apiComponent, fx.reposFile, fx.workerComponent, fx.workspaceFile].sort());
  assert.ok(!reads.some((path) => path.startsWith(worktree) || path.startsWith(outsider)));
});

test("37: a configured fleet checklist that does not exist is fatal", (t) => {
  const fx = buildFleet(t);
  rmSync(fx.checklist);
  expectEngineError(assert, () => loadWorkspace(fx.platform, REQUIRE), { exitCode: 24, file: fx.workspaceFile, pointer: "/checklist", message: /does not exist/ });
});

test("36: a missing owned repos file is fatal (24), naming it", (t) => {
  const fx = buildFleet(t, { repos: null });
  expectEngineError(assert, () => loadWorkspace(fx.platform, REQUIRE), { exitCode: 24, file: fx.reposFile, message: /repos file not found/ });
});

test("36/82b: an external repos file is validated and used, never refused as non-canonical", (t) => {
  const fx = buildFleet(t, { repos: null, workspace: (ws) => void (ws.reposFile = { kind: "external", path: "../shared-repos.json" }) });
  const external = put(join(fx.base, "shared-repos.json"), '{"_comment":"shared","repos":{"acme-worker":"acme-worker","acme-api":"acme-api"}}');
  const loaded = loadWorkspace(fx.platform, REQUIRE);
  assert.equal(loaded.reposReport.owner, "external");
  assert.equal(loaded.reposReport.file, external);
  assert.equal(statusOf(loaded, "acme-api").status, "available");
  assert.deepEqual(loaded.nonCanonical, []);
  assert.equal(readFileSync(external, "utf8"), '{"_comment":"shared","repos":{"acme-worker":"acme-worker","acme-api":"acme-api"}}');
});

// --- canonical gate (D6) ------------------------------------------------------------------------

test("D6: non-canonical owned input → 29 naming the file; report mode exposes the classification", (t) => {
  const fx = buildFleet(t);
  writeFileSync(fx.workspaceFile, JSON.stringify(workspaceValue()));
  expectEngineError(assert, () => loadWorkspace(fx.platform, REQUIRE), { exitCode: 29, file: fx.workspaceFile, message: /run format first/ });
  const inspected = inspectWorkspace(fx.platform, { members: "all" });
  assert.deepEqual(inspected.nonCanonical.map((r) => [r.file, r.owner]), [[fx.workspaceFile, "workspace-repo"]]);
  assert.ok(inspected.nonCanonical[0].changes.includes("whitespace normalised"));
});

test("D6/83a: a non-canonical member component.json is flagged as a member-repo file", (t) => {
  const fx = buildFleet(t);
  writeFileSync(fx.apiComponent, JSON.stringify(apiComponentValue(), null, 4));
  const loaded = loadWorkspace(fx.platform, { members: "all", canonical: "report" });
  assert.deepEqual(loaded.nonCanonical.map((r) => [r.file, r.owner]), [[fx.apiComponent, "member-repo"]]);
  expectEngineError(assert, () => loadWorkspace(fx.platform, REQUIRE), { exitCode: 29, file: fx.apiComponent });
});

test("20: an invalid file outranks a non-canonical one (24 before 29)", (t) => {
  const fx = buildFleet(t, { worker: (v) => void (v.name = "acme-other") });
  writeFileSync(fx.workspaceFile, JSON.stringify(workspaceValue()));
  expectEngineError(assert, () => loadWorkspace(fx.platform, REQUIRE), { exitCode: 24, file: fx.workerComponent });
});

test("24: an invalid workspace reports file, pointer, line and column", (t) => {
  const fx = buildFleet(t, { workspace: (ws) => void (ws.stages[0].promotion.mode = "auto") });
  assert.throws(
    () => loadWorkspace(fx.platform, REQUIRE),
    (error) => error.exitCode === 24 && error.location.pointer === "/stages/0/promotion/mode" && error.location.line > 1 && error.location.column > 0,
  );
});

test("requireAvailableMember: 64 for a non-member, 24 for an unavailable member", (t) => {
  const fx = buildFleet(t, { worker: null });
  const loaded = loadWorkspace(fx.platform, REQUIRE);
  assert.equal(requireAvailableMember(loaded, "acme-api").component.name, "acme-api");
  expectEngineError(assert, () => requireAvailableMember(loaded, "acme-gateway"), { exitCode: 64, message: /members: acme-api, acme-worker/ });
  expectEngineError(assert, () => requireAvailableMember(loaded, "acme-worker"), { exitCode: 24, message: /unavailable/ });
});

// --- revisions (31d, 84) --------------------------------------------------------------------------

test("31d: working tree vs promoted commit — the commit revision is read with git show and differences named", (t) => {
  const fx = buildFleet(t);
  const promoted = commitAll(fx.api, "feat: component config");
  const edited = apiComponentValue();
  edited.stages["stage-1"].targets[0].pipeline.landedWaitMinutes = 45;
  edited.stages["stage-2"].handoff.settingsFiles = ["config/extra.json", "config/settings.stage-2.json"];
  put(fx.apiComponent, edited);

  const loaded = loadWorkspace(fx.platform, REQUIRE);
  const workingTree = statusOf(loaded, "acme-api").component;
  assert.equal(workingTree.stages["stage-1"].targets[0].pipeline.landedWaitMinutes, 45, "status reads the working tree");
  const atCommit = readComponentAtCommit(loaded, "acme-api", promoted);
  assert.equal(atCommit.status, "ok");
  assert.equal(atCommit.state, "canonical");
  assert.equal(atCommit.label, `${promoted}:.release-radar/component.json`);
  assert.equal(atCommit.component.stages["stage-1"].targets[0].pipeline.landedWaitMinutes, 20);
  assert.deepEqual(componentDifferences(atCommit.component, workingTree), [
    "/stages/stage-1/targets",
    "/stages/stage-2/handoff/settingsFiles",
  ]);
  assert.deepEqual(componentDifferences(atCommit.component, atCommit.component), []);
});

test("84: a non-canonical component.json at a commit is used and reported", (t) => {
  const fx = buildFleet(t, { api: JSON.stringify(apiComponentValue()) });
  const sha = commitAll(fx.api, "chore: compact config");
  const result = readComponentAtCommit(loadWorkspace(fx.platform, { members: "all", canonical: "report" }), "acme-api", sha);
  assert.equal(result.status, "ok");
  assert.equal(result.state, "non-canonical");
  assert.ok(result.changes.length > 0);
});

test("84: an invalid component.json at a commit is a blocking finding, not a thrown error", (t) => {
  const fx = buildFleet(t);
  const good = apiComponentValue();
  put(fx.apiComponent, { ...good, stages: { ...good.stages, "stage-9": null } });
  const sha = commitAll(fx.api, "chore: broken config");
  put(fx.apiComponent, good);
  const result = readComponentAtCommit(loadWorkspace(fx.platform, REQUIRE), "acme-api", sha);
  assert.equal(result.status, "invalid");
  assert.equal(result.error.exitCode, 24);
  assert.equal(result.error.location.pointer, "/stages/stage-9");
  assert.equal(result.error.location.file, `${sha}:.release-radar/component.json`);
});

test("84: component.json missing at the commit is reported as missing", (t) => {
  const fx = buildFleet(t);
  // The worker's config exists in the working tree but was never committed.
  git(fx.worker, "commit", "-q", "--allow-empty", "-m", "chore: nothing yet");
  const before = git(fx.worker, "rev-parse", "HEAD");
  const result = readComponentAtCommit(loadWorkspace(fx.platform, REQUIRE), "acme-worker", before);
  assert.equal(result.status, "missing");
  assert.equal(result.label, `${before}:worker/.release-radar/component.json`);
});

test("82c: reading at a commit never rewrites anything", (t) => {
  const fx = buildFleet(t, { api: JSON.stringify(apiComponentValue()) });
  const sha = commitAll(fx.api, "chore: compact config");
  const before = readFileSync(fx.apiComponent, "utf8");
  readComponentAtCommit(loadWorkspace(fx.platform, { members: "all", canonical: "report" }), "acme-api", sha);
  assert.equal(readFileSync(fx.apiComponent, "utf8"), before);
});

// --- single-repo project (31e) ------------------------------------------------------------------

test("31e: a single-repo project keeps workspace.json, component.json and the repos file in one .release-radar/", (t) => {
  const repo = initRepo(join(tempDir(t), "acme-api"));
  const ws = workspaceValue();
  ws.members = [{ name: "acme-api", repoKey: "acme-api", repoSubdir: null }];
  ws.checklist = ".release-radar/fleet-checks.md";
  put(join(repo, ".release-radar", "workspace.json"), ws);
  put(join(repo, ".release-radar", "repos.local.json"), { schemaVersion: 1, repos: { "acme-api": ".." } });
  put(join(repo, ".release-radar", "component.json"), apiComponentValue());
  put(join(repo, ".release-radar", "fleet-checks.md"), "# release-radar checklist\n");
  const loaded = loadWorkspace(repo, { members: ["acme-api"], canonical: "require" });
  const api = statusOf(loaded, "acme-api");
  assert.equal(api.status, "available");
  assert.equal(api.clone, repo);
  assert.equal(api.componentFile, join(repo, ".release-radar", "component.json"));
  assert.equal(api.report.owner, "workspace-repo");
  const sha = commitAll(repo, "feat: release-radar config");
  assert.equal(readComponentAtCommit(loaded, "acme-api", sha).status, "ok");
});

// --- canonical round trip and fingerprints (86) ---------------------------------------------------

/** The fixture files hand-edited: keys reordered, whitespace changed, unordered arrays shuffled. */
function handEdit(value) {
  const reversed = (object) =>
    Array.isArray(object)
      ? object.map(reversed)
      : object !== null && typeof object === "object"
        ? Object.fromEntries(Object.entries(object).reverse().map(([k, v]) => [k, reversed(v)]))
        : object;
  return JSON.stringify(reversed(value), null, 3).replace(/\n/g, "\r\n");
}

test("86: format(format(x)) == format(x) and hand edits normalise to the exact canonical bytes", () => {
  for (const [value, schema] of [
    [workspaceValue(), WORKSPACE_SCHEMA],
    [apiComponentValue(), COMPONENT_SCHEMA],
  ]) {
    const once = formatText(handEdit(value), schema, "file.json");
    assert.equal(formatText(once, schema, "file.json"), once);
    // Only the unordered arrays may differ from the fixture's own order; ordered ones (stages) are kept.
    assert.equal(once, formatText(text(value), schema, "file.json"));
  }
});

test("50/86: re-formatting the workspace and components leaves the fingerprint unchanged; a real change does not", (t) => {
  const fx = buildFleet(t);
  const fingerprint = (loaded) =>
    configFingerprint(
      loaded.workspace,
      Object.fromEntries(loaded.members.filter((m) => m.status === "available").map((m) => [m.member.name, m.component])),
    );
  const original = fingerprint(loadWorkspace(fx.platform, REQUIRE));
  writeFileSync(fx.workspaceFile, handEdit(workspaceValue()));
  const shuffled = apiComponentValue();
  shuffled.stages["stage-1"].targets.reverse();
  shuffled.stages["stage-1"].verification.checks.reverse();
  writeFileSync(fx.apiComponent, handEdit(shuffled));
  const reformatted = loadWorkspace(fx.platform, { members: "all", canonical: "report" });
  assert.equal(reformatted.nonCanonical.length, 2);
  assert.equal(fingerprint(reformatted), original);
  const changed = apiComponentValue();
  changed.stages["stage-1"].targets[0].pipeline.landedWaitMinutes = 21;
  put(fx.apiComponent, changed);
  assert.notEqual(fingerprint(loadWorkspace(fx.platform, { members: "all", canonical: "report" })), original);
});
