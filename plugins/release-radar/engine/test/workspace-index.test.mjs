// Per-user workspace index and starting-location resolution (spec requirements 31f, 31g, 76a).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WORKSPACE_INDEX_SCHEMA,
  listIndex,
  readIndex,
  registerWorkspace,
  renderIndex,
  resolveWorkspaces,
  unregisterWorkspace,
} from "../dist/workspace-index.js";
import { classify } from "../dist/format.js";
import { apiComponentValue, buildFleet, expectEngineError, initRepo, put, tempDir, workspaceValue } from "./fixtures/workspace-fixtures.mjs";

const OPTS = { canonical: "require" };

function indexIn(t) {
  // The skill supplies `${CLAUDE_PLUGIN_DATA}/workspace-index.json`; tests pass a temp path.
  return join(tempDir(t, "release-radar-data-"), "plugin-data", "workspace-index.json");
}

test("31g: register writes a canonical, schema-versioned index at exactly the given path", (t) => {
  const fx = buildFleet(t);
  const index = indexIn(t);
  assert.deepEqual(registerWorkspace(index, fx.platform, OPTS), { result: "registered", path: fx.platform });
  const written = readFileSync(index, "utf8");
  assert.equal(classify(written, WORKSPACE_INDEX_SCHEMA, index).state, "canonical");
  assert.equal(written, renderIndex([fx.platform]));
  assert.deepEqual(JSON.parse(written), { schemaVersion: 1, workspaces: [{ path: fx.platform }] });
  assert.deepEqual(registerWorkspace(index, join(fx.platform, ".release-radar", "workspace.json"), OPTS), { result: "already-registered", path: fx.platform });
});

test("31g: an absent index is the empty initial state; list reports registered entries", (t) => {
  const index = indexIn(t);
  assert.deepEqual(readIndex(index, OPTS).paths, []);
  assert.deepEqual(listIndex(index, OPTS), []);
  const a = buildFleet(t);
  const b = buildFleet(t);
  registerWorkspace(index, b.platform, OPTS);
  registerWorkspace(index, a.platform, OPTS);
  assert.deepEqual(listIndex(index, OPTS).map((e) => e.status), ["ok", "ok"]);
  assert.deepEqual(readIndex(index, OPTS).paths, [a.platform, b.platform].sort());
});

test("31g: registering a path without a valid workspace is refused (24)", (t) => {
  const index = indexIn(t);
  expectEngineError(assert, () => registerWorkspace(index, tempDir(t), OPTS), { exitCode: 24, message: /workspace file not found/ });
  assert.equal(existsSync(index), false);
});

test("31g: unregister removes only the named entry", (t) => {
  const index = indexIn(t);
  const a = buildFleet(t);
  const b = buildFleet(t);
  registerWorkspace(index, a.platform, OPTS);
  registerWorkspace(index, b.platform, OPTS);
  assert.deepEqual(unregisterWorkspace(index, a.platform, OPTS), { result: "unregistered", path: a.platform });
  assert.deepEqual(readIndex(index, OPTS).paths, [b.platform]);
  assert.equal(unregisterWorkspace(index, a.platform, OPTS).result, "not-registered");
  assert.ok(existsSync(join(a.platform, ".release-radar", "workspace.json")), "the workspace itself is untouched");
});

test("31g: stale entries are reported by list and resolve, never removed silently", (t) => {
  const index = indexIn(t);
  const gone = buildFleet(t);
  const broken = buildFleet(t);
  registerWorkspace(index, gone.platform, OPTS);
  registerWorkspace(index, broken.platform, OPTS);
  rmSync(gone.platform, { recursive: true, force: true });
  writeFileSync(broken.workspaceFile, '{"schemaVersion": 1}\n');
  const listed = listIndex(index, OPTS);
  assert.deepEqual(listed.map((e) => e.status), ["stale", "stale"]);
  assert.ok(listed.some((e) => e.reason === "path no longer exists"));
  assert.ok(listed.some((e) => /invalid workspace/.test(e.reason ?? "")));
  const resolved = resolveWorkspaces(index, tempDir(t), OPTS);
  assert.equal(resolved.stale.length, 2);
  assert.equal(readIndex(index, OPTS).paths.length, 2, "still registered until an explicit unregister");
  assert.equal(unregisterWorkspace(index, gone.platform, OPTS).result, "unregistered", "a stale path can be unregistered");
});

test("31f(b): a workspace.json found upward from cwd within the git root", (t) => {
  const fx = buildFleet(t);
  const deep = join(fx.platform, "docs", "notes");
  mkdirSync(deep, { recursive: true });
  const result = resolveWorkspaces(indexIn(t), deep, OPTS);
  assert.equal(result.step, "b");
  assert.deepEqual(result.candidates, [{ root: fx.platform, step: "b", registered: false }]);
});

test("31f(b): the upward search stops at the git root", (t) => {
  const fx = buildFleet(t);
  const nested = initRepo(join(fx.platform, "tools"));
  const result = resolveWorkspaces(indexIn(t), nested, OPTS);
  assert.equal(result.step, "none", "the nested repository's root is the boundary");
});

test("31f(b): outside a git repository only cwd itself is checked", (t) => {
  const base = tempDir(t);
  put(join(base, ".release-radar", "workspace.json"), workspaceValue());
  const child = join(base, "child");
  mkdirSync(child);
  assert.equal(resolveWorkspaces(indexIn(t), child, OPTS).step, "none");
  assert.equal(resolveWorkspaces(indexIn(t), base, OPTS).step, "b");
});

test("31f(c): cwd inside a member's mapped clone → that workspace with the component pre-selected", (t) => {
  const fx = buildFleet(t);
  const index = indexIn(t);
  registerWorkspace(index, fx.platform, OPTS);
  const inside = join(fx.api, "src");
  mkdirSync(inside);
  const result = resolveWorkspaces(index, inside, OPTS);
  assert.equal(result.step, "c");
  assert.deepEqual(result.candidates, [{ root: fx.platform, step: "c", component: "acme-api", registered: true }]);
});

test("31f(c): an unregistered workspace is not found from a member clone (nothing is guessed)", (t) => {
  const fx = buildFleet(t);
  assert.deepEqual(resolveWorkspaces(indexIn(t), fx.api, OPTS).candidates, []);
});

test("31f(d): cwd inside a registered workspace root that the git-bounded search cannot reach", (t) => {
  const fx = buildFleet(t);
  const index = indexIn(t);
  registerWorkspace(index, fx.platform, OPTS);
  const nested = initRepo(join(fx.platform, "tools"));
  const result = resolveWorkspaces(index, nested, OPTS);
  assert.equal(result.step, "d");
  assert.deepEqual(result.candidates, [{ root: fx.platform, step: "d", registered: true }]);
});

test("31f: several matches are all returned, nothing is chosen", (t) => {
  const a = buildFleet(t);
  const b = buildFleet(t);
  const index = indexIn(t);
  // Both workspaces map acme-api to the same clone (a's).
  put(b.reposFile, { schemaVersion: 1, repos: { "acme-api": a.api, "acme-worker": "../../acme-worker" } });
  registerWorkspace(index, a.platform, OPTS);
  registerWorkspace(index, b.platform, OPTS);
  const result = resolveWorkspaces(index, a.api, OPTS);
  assert.equal(result.step, "c");
  assert.deepEqual(result.candidates.map((c) => [c.root, c.component]).sort(), [
    [a.platform, "acme-api"],
    [b.platform, "acme-api"],
  ].sort());
});

test("31f: no match returns no candidate", (t) => {
  const fx = buildFleet(t);
  const index = indexIn(t);
  registerWorkspace(index, fx.platform, OPTS);
  const result = resolveWorkspaces(index, tempDir(t), OPTS);
  assert.deepEqual([result.step, result.candidates], ["none", []]);
});

test("31e/31f(b): in a single-repo project the component is pre-selected", (t) => {
  const repo = initRepo(join(tempDir(t), "acme-api"));
  const ws = workspaceValue();
  ws.members = [{ name: "acme-api", repoKey: "acme-api", repoSubdir: null }];
  ws.checklist = null;
  put(join(repo, ".release-radar", "workspace.json"), ws);
  put(join(repo, ".release-radar", "repos.local.json"), { schemaVersion: 1, repos: { "acme-api": ".." } });
  put(join(repo, ".release-radar", "component.json"), apiComponentValue());
  const src = join(repo, "src");
  mkdirSync(src);
  const result = resolveWorkspaces(indexIn(t), src, OPTS);
  assert.equal(result.step, "b");
  assert.deepEqual(result.candidates, [{ root: repo, step: "b", component: "acme-api", registered: false }]);
});

test("83: a hand-edited index is non-canonical (29 when required); an invalid index is 24", (t) => {
  const fx = buildFleet(t);
  const index = indexIn(t);
  mkdirSync(join(index, ".."), { recursive: true });
  writeFileSync(index, JSON.stringify({ workspaces: [{ path: fx.platform }], schemaVersion: 1 }));
  expectEngineError(assert, () => listIndex(index, OPTS), { exitCode: 29, file: index });
  assert.equal(readIndex(index, { canonical: "report" }).state, "non-canonical");
  registerWorkspace(index, fx.platform, { canonical: "report" });
  assert.equal(readFileSync(index, "utf8"), renderIndex([fx.platform]), "the engine always writes the canonical form");
  writeFileSync(index, '{"schemaVersion": 1, "workspaces": [{"path": "relative/path"}]}\n');
  expectEngineError(assert, () => readIndex(index, OPTS), { exitCode: 24, pointer: "/workspaces/0/path" });
});

test("31f: resolve refuses a cwd that does not exist (64)", (t) => {
  expectEngineError(assert, () => resolveWorkspaces(indexIn(t), "/nonexistent/acme", OPTS), { exitCode: 64 });
});
