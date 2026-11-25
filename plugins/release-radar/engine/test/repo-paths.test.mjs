// Repos file (spec requirements 36, 82b; scan §6.3 repo-path group re-expressed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { REPOS_FILE_SCHEMA, loadRepoPaths, renderOwnedReposFile, repoPathFor, requireRepoPath } from "../dist/repo-paths.js";
import { classify } from "../dist/format.js";
import { expectEngineError, put, tempDir, text } from "./fixtures/workspace-fixtures.mjs";

test("owned: keys resolve relative to the repos file's directory", (t) => {
  const dir = tempDir(t);
  const file = put(join(dir, ".release-radar", "repos.local.json"), { schemaVersion: 1, repos: { "acme-api": "../../acme-api", single: ".." } });
  const paths = loadRepoPaths(file, "owned");
  assert.equal(paths.ownership, "owned");
  assert.equal(paths.state, "canonical");
  assert.equal(repoPathFor(paths, "acme-api"), join(dir, "..", "acme-api"));
  assert.equal(repoPathFor(paths, "single"), dir);
});

test("owned: schemaVersion is required", (t) => {
  const file = put(join(tempDir(t), "repos.local.json"), { repos: {} });
  expectEngineError(assert, () => loadRepoPaths(file, "owned"), { exitCode: 24, file, pointer: "/schemaVersion" });
});

test("owned: an unknown top-level key is fatal and named", (t) => {
  const file = put(join(tempDir(t), "repos.local.json"), { schemaVersion: 1, repos: {}, _comment: "x" });
  expectEngineError(assert, () => loadRepoPaths(file, "owned"), { exitCode: 24, file, pointer: "/_comment", message: /unknown key/ });
});

test("a non-string or empty path value is fatal and named", (t) => {
  const dir = tempDir(t);
  const a = put(join(dir, "a.json"), { schemaVersion: 1, repos: { "acme-api": 42 } });
  expectEngineError(assert, () => loadRepoPaths(a, "owned"), { exitCode: 24, pointer: "/repos/acme-api", message: /expected string/ });
  const b = put(join(dir, "b.json"), { schemaVersion: 1, repos: { "acme-api": "" } });
  expectEngineError(assert, () => loadRepoPaths(b, "owned"), { exitCode: 24, pointer: "/repos/acme-api" });
});

test("a missing file and an unparseable file are distinct 24s, both naming the file", (t) => {
  const dir = tempDir(t);
  const missing = join(dir, "absent.json");
  expectEngineError(assert, () => loadRepoPaths(missing, "owned"), { exitCode: 24, file: missing, message: /not found/ });
  const broken = put(join(dir, "broken.json"), '{ "schemaVersion": 1, "repos": { "acme-api": "../x", } }\n');
  assert.throws(
    () => loadRepoPaths(broken, "owned"),
    (error) => error.exitCode === 24 && error.location.file === broken && error.location.line === 1 && !/not found/.test(error.message),
  );
});

test("an unmapped key is reported to the caller; requireRepoPath makes it fatal", (t) => {
  const file = put(join(tempDir(t), "repos.local.json"), { schemaVersion: 1, repos: {} });
  const paths = loadRepoPaths(file, "owned");
  assert.equal(repoPathFor(paths, "acme-api"), undefined);
  expectEngineError(assert, () => requireRepoPath(paths, "acme-api"), { exitCode: 24, file, message: /repoKey "acme-api" is not mapped/ });
});

test("external: validated, may omit schemaVersion and carry _comment, never reported as needing format", (t) => {
  const dir = tempDir(t);
  const file = put(join(dir, "repos.local.json"), '{"repos":{"acme-api":"./acme-api"},"_comment":"shared with other tooling"}');
  const paths = loadRepoPaths(file, "external");
  assert.equal(paths.ownership, "external");
  assert.equal(paths.state, "non-canonical");
  assert.deepEqual(paths.changes, [], "external files are never re-formatted");
  assert.equal(repoPathFor(paths, "acme-api"), join(dir, "acme-api"));
});

test("external: still strictly validated", (t) => {
  const file = put(join(tempDir(t), "repos.json"), { repos: { "acme-api": "x" }, extra: true });
  expectEngineError(assert, () => loadRepoPaths(file, "external"), { exitCode: 24, pointer: "/extra" });
});

test("a non-canonical owned file is reported with what format would change", (t) => {
  const file = put(join(tempDir(t), "repos.local.json"), '{"repos":{"b":"../b","a":"../a"},"schemaVersion":1}');
  const paths = loadRepoPaths(file, "owned");
  assert.equal(paths.state, "non-canonical");
  assert.ok(paths.changes.includes("keys reordered at (root)"));
  assert.ok(paths.changes.includes("keys sorted at /repos"));
});

test("renderOwnedReposFile writes the canonical form", () => {
  const rendered = renderOwnedReposFile({ "acme-worker": "../../acme-worker", "acme-api": "../../acme-api" });
  assert.equal(rendered, text({ schemaVersion: 1, repos: { "acme-api": "../../acme-api", "acme-worker": "../../acme-worker" } }));
  assert.equal(classify(rendered, REPOS_FILE_SCHEMA, "repos.local.json").state, "canonical");
});
