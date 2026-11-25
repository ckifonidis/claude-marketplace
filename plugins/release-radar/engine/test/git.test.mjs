// Read-only git inspection (spec requirements 46, 53, 31d; scan §6.3 git group re-expressed).
// Every repository is a throw-away git repo created in a temp dir by the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareCommits, headCommit, resolveDeployedCommit, runGit, showFileAtCommit } from "../dist/git.js";
import { effectiveTagConvention } from "../dist/config.js";
import { apiComponentValue, commitAll, git, initRepo, tempDir, workspaceValue } from "./fixtures/workspace-fixtures.mjs";

const TIMEOUT = 15_000;
const SHA = { type: "sha" };
const TAG = (gitTagPrefix) => ({ type: "git-tag", gitTagPrefix });

/** main: first (tagged 1.4.0 and v2.0.0) → second (HEAD); side branch: side (not an ancestor of HEAD). */
function makeRepo(t) {
  const dir = initRepo(join(tempDir(t), "acme-api"), { commit: false });
  git(dir, "commit", "-q", "--allow-empty", "-m", "feat: first release commit");
  git(dir, "tag", "1.4.0");
  git(dir, "tag", "v2.0.0");
  const first = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "side");
  git(dir, "commit", "-q", "--allow-empty", "-m", "fix: side commit");
  const side = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "feat: second commit");
  const head = git(dir, "rev-parse", "HEAD");
  return { dir, first, side, head };
}

const resolve = (clone, tag, convention) => resolveDeployedCommit({ clone, tag, convention, timeoutMs: TIMEOUT });

test("sha convention: a short sha resolves with date, subject and behind-count", (t) => {
  const repo = makeRepo(t);
  const lookup = resolve(repo.dir, repo.first.slice(0, 7), SHA);
  assert.equal(lookup.status, "resolved");
  assert.equal(lookup.sha, repo.first);
  assert.equal(lookup.subject, "feat: first release commit");
  assert.match(lookup.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(lookup.headRelation, { relation: "behind", commits: 1 });
});

test("HEAD relation: the commit at HEAD is at-head", (t) => {
  const repo = makeRepo(t);
  assert.deepEqual(resolve(repo.dir, repo.head, SHA).headRelation, { relation: "at-head" });
});

test("HEAD relation: a commit off the HEAD line is not-ancestor", (t) => {
  const repo = makeRepo(t);
  assert.deepEqual(resolve(repo.dir, repo.side.slice(0, 10), SHA).headRelation, { relation: "not-ancestor" });
});

test("git-tag convention: the tag is resolved exactly as prefix + image tag", (t) => {
  const repo = makeRepo(t);
  assert.equal(resolve(repo.dir, "1.4.0", TAG("")).sha, repo.first);
  assert.equal(resolve(repo.dir, "2.0.0", TAG("v")).sha, repo.first);
});

test("git-tag convention: nothing is guessed (no v-prefix fallback)", (t) => {
  const repo = makeRepo(t);
  assert.equal(resolve(repo.dir, "v1.4.0", TAG("")).status, "tag-not-found");
  assert.equal(resolve(repo.dir, "1.4.0", TAG("v")).status, "tag-not-found");
});

test("regex convention: an explicit pattern covers tags written with and without v", (t) => {
  const repo = makeRepo(t);
  const convention = { type: "regex", pattern: "^v?(?<ref>\\d+\\.\\d+\\.\\d+)$", resolveAs: TAG("") };
  for (const tag of ["1.4.0", "v1.4.0"]) assert.equal(resolve(repo.dir, tag, convention).sha, repo.first, tag);
  assert.equal(resolve(repo.dir, "release-1.4.0", convention).status, "tag-not-found");
});

test("regex convention: the ref group can be a commit sha", (t) => {
  const repo = makeRepo(t);
  const convention = { type: "regex", pattern: "^build-\\d+-(?<ref>[0-9a-f]{7})$", resolveAs: SHA };
  const lookup = resolve(repo.dir, `build-42-${repo.first.slice(0, 7)}`, convention);
  assert.equal(lookup.status, "resolved");
  assert.equal(lookup.sha, repo.first);
});

test("none convention → no-convention; a digest-only reference → digest-pinned", (t) => {
  const repo = makeRepo(t);
  assert.equal(resolve(repo.dir, "1.4.0", { type: "none" }).status, "no-convention");
  assert.equal(resolve(repo.dir, null, SHA).status, "digest-pinned");
});

test("per-component override: the override convention is the one applied", (t) => {
  const repo = makeRepo(t);
  const workspace = workspaceValue(); // stage-2: git-tag with prefix "v"
  const component = apiComponentValue(); // override for stage-2: regex ^v?(…)$ resolved as plain git tag
  const stageOnly = { ...component, tagConventionOverrides: undefined };
  delete stageOnly.tagConventionOverrides;
  const withOverride = effectiveTagConvention(workspace, component, "stage-2").convention;
  const withoutOverride = effectiveTagConvention(workspace, stageOnly, "stage-2").convention;
  assert.equal(resolve(repo.dir, "1.4.0", withOverride).status, "resolved");
  assert.equal(resolve(repo.dir, "1.4.0", withoutOverride).status, "tag-not-found", "stage convention looks for v1.4.0");
});

test("an unknown tag is tag-not-found, never a guess", (t) => {
  const repo = makeRepo(t);
  assert.equal(resolve(repo.dir, "9.9.9", TAG("")).status, "tag-not-found");
  assert.equal(resolve(repo.dir, "deadbeef", SHA).status, "tag-not-found");
  assert.equal(resolve(repo.dir, "", SHA).status, "tag-not-found");
  assert.match(resolve(repo.dir, "latest", SHA).detail, /not a commit sha/);
});

test("a null or absent clone is no-clone", () => {
  assert.equal(resolve(null, "1.0.0", SHA).status, "no-clone");
  assert.equal(resolve("/nonexistent/acme-api", "1.0.0", SHA).status, "no-clone");
});

test("a directory that is not a repository is git-error, even inside another checkout", (t) => {
  const outer = initRepo(join(tempDir(t), "acme-platform"));
  const plain = join(outer, "not-a-clone");
  mkdirSync(plain);
  const lookup = resolve(plain, "1.0.0", SHA);
  assert.equal(lookup.status, "git-error");
  assert.match(lookup.detail, /not a git repository/);
});

test("the git timeout is required and must be positive (no default)", () => {
  assert.throws(() => runGit(".", ["status"], 0), /timeout must be a positive/);
  assert.throws(() => resolveDeployedCommit({ clone: null, tag: "x", convention: SHA }), /timeout must be a positive/);
});

test("headCommit reads the clone's HEAD", (t) => {
  const repo = makeRepo(t);
  const head = headCommit(repo.dir, TIMEOUT);
  assert.equal(head.sha, repo.head);
  assert.equal(head.subject, "feat: second commit");
});

// --- deltas -------------------------------------------------------------------------------------

test("delta: equal", (t) => {
  const repo = makeRepo(t);
  assert.deepEqual(compareCommits(repo.dir, repo.head, repo.head.slice(0, 8), TIMEOUT), { verdict: "equal", pending: [], extra: [] });
});

test("delta: behind N with the pending commit list", (t) => {
  const repo = makeRepo(t);
  const delta = compareCommits(repo.dir, repo.first, repo.head, TIMEOUT);
  assert.equal(delta.verdict, "behind");
  assert.equal(delta.count, 1);
  assert.deepEqual(delta.pending.map((c) => c.subject), ["feat: second commit"]);
  assert.deepEqual(delta.extra, []);
});

test("delta: ahead (downstream already has commits upstream lacks)", (t) => {
  const repo = makeRepo(t);
  const delta = compareCommits(repo.dir, repo.head, repo.first, TIMEOUT);
  assert.equal(delta.verdict, "ahead");
  assert.equal(delta.count, 1);
  assert.deepEqual(delta.pending, []);
});

test("delta: diverged lists both sides", (t) => {
  const repo = makeRepo(t);
  const delta = compareCommits(repo.dir, repo.side, repo.head, TIMEOUT);
  assert.equal(delta.verdict, "diverged");
  assert.deepEqual(delta.pending.map((c) => c.subject), ["feat: second commit"]);
  assert.deepEqual(delta.extra.map((c) => c.subject), ["fix: side commit"]);
});

test("delta: unknown with a reason (no clone, unresolved side, commit absent locally)", (t) => {
  const repo = makeRepo(t);
  assert.match(compareCommits(null, repo.first, repo.head, TIMEOUT).reason, /no local clone/);
  assert.match(compareCommits(repo.dir, null, repo.head, TIMEOUT).reason, /downstream commit is not resolved/);
  const missing = compareCommits(repo.dir, "0123456789abcdef0123456789abcdef01234567", repo.head, TIMEOUT);
  assert.equal(missing.verdict, "unknown");
  assert.match(missing.reason, /not in the local clone/);
});

// --- files at a commit --------------------------------------------------------------------------

test("showFileAtCommit reads a file as it was at the commit, never the working tree", (t) => {
  const dir = initRepo(join(tempDir(t), "acme-api"), { commit: false });
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "settings.json"), '{"a":1}\n');
  const first = commitAll(dir, "feat: settings v1");
  writeFileSync(join(dir, "config", "settings.json"), '{"a":2}\n');
  const shown = showFileAtCommit(dir, first, "config/settings.json", TIMEOUT);
  assert.deepEqual(shown, { status: "ok", text: '{"a":1}\n' });
  assert.equal(showFileAtCommit(dir, first, "config/absent.json", TIMEOUT).status, "missing");
  assert.equal(showFileAtCommit(dir, "0123456789abcdef0123456789abcdef01234567", "config/settings.json", TIMEOUT).status, "git-error");
});
