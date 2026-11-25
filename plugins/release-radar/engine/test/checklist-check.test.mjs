// `checklist-check` (spec requirements 58 step 8, 80, 82c, 84): the component checklist AT A COMMIT
// classified read-only — canonical / non-canonical (+ changes) / invalid (+ location) / absent —
// under `repoSubdir` when set, with the working-tree copy compared; nothing is ever written.
// All names are synthetic; the clones are throw-away temp repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandFleet, runCli } from "./fixtures/cli-harness.mjs";
import { commitAll, git, put } from "./fixtures/workspace-fixtures.mjs";

const CHECKS = `# release-radar checklist

schemaVersion: 1

## api-contract
- layer: component
- severity: high
- paths: src/api/**
- signal: A changed public route.
- prepare: Tell the consumers.

## db-migrations
- layer: component
- severity: blocker
- paths: migrations/**
- signal: A new migration.
- prepare: Run it against a copy of stage-1 data.
`;

/** The same content, hand-edited: items and fields out of order, odd indentation, CRLF. */
const CHECKS_EDITED = [
  "# release-radar checklist",
  "",
  "schemaVersion: 1",
  "",
  "## db-migrations",
  "  - layer: component",
  "- severity: blocker",
  "- signal: A new migration.",
  "- paths: migrations/**",
  "- prepare: Run it against a copy of stage-1 data.",
  "",
  "## api-contract",
  "- layer: component",
  "- severity: high",
  "- paths: src/api/**",
  "- signal: A changed public route.",
  "- prepare: Tell the consumers.",
  "",
].join("\r\n");

const CHECKS_INVALID = "# release-radar checklist\n\nschemaVersion: 1\n\n## api-contract\n- layer: component\n- severity: high\n- owner: dev-team\n- paths: src/api/**\n- signal: A changed public route.\n- prepare: Tell the consumers.\n";

function check(fx, component, commit, extra = ["--json"]) {
  return runCli(assert, fx.h, ["checklist-check", ...fx.ws, component, "--commit", commit, ...extra]);
}

test("84: no checklist at the commit → absent, exit 0; nothing is written", (t) => {
  const fx = commandFleet(t);
  const r = check(fx, "acme-api", fx.commits.c4);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.command, "checklist-check");
  assert.equal(r.json.state, "absent");
  assert.equal(r.json.path, ".release-radar/checks.md");
  assert.equal(r.json.label, `${fx.commits.c4}:.release-radar/checks.md`);
  assert.deepEqual(r.json.commit, { sha: fx.commits.c4, shortSha: fx.short.c4, subject: "chore: fourth" });
  assert.equal(r.json.items, null);
  assert.equal(r.json.workingTree.comparison, "absent");
  assert.equal(r.json.rewritten, false);
  assert.equal(git(fx.api, "status", "--porcelain"), "");
  assert.deepEqual(fx.h.calls(), [], "no adapter is called");
});

test("80/84: a canonical checklist at the commit → canonical with its parsed items; working tree identical", (t) => {
  const fx = commandFleet(t);
  put(join(fx.api, ".release-radar", "checks.md"), CHECKS);
  const sha = commitAll(fx.api, "docs: component checklist");
  const r = check(fx, "acme-api", sha.slice(0, 7));
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.state, "canonical");
  assert.equal(r.json.commit.sha, sha, "a short sha resolves to the full commit");
  assert.deepEqual(r.json.changes, []);
  assert.equal(r.json.error, null);
  assert.deepEqual(r.json.items.map((item) => [item.id, item.severity, item.paths]), [
    ["api-contract", "high", ["src/api/**"]],
    ["db-migrations", "blocker", ["migrations/**"]],
  ]);
  assert.equal(r.json.workingTree.comparison, "identical");
  const human = check(fx, "acme-api", sha, []);
  assert.equal(human.status, 0, human.out);
  assert.match(human.stdout, /\.release-radar\/checks\.md: canonical/);
  assert.match(human.stdout, /2 item\(s\):/);
  assert.match(human.stdout, /working-tree copy .*: identical to the commit's copy/);
});

test("82c/84: a non-canonical checklist at the commit is reported with its changes, exit 0, and never rewritten", (t) => {
  const fx = commandFleet(t);
  const file = join(fx.api, ".release-radar", "checks.md");
  writeFileSync(file, CHECKS_EDITED);
  const sha = commitAll(fx.api, "docs: hand-edited checklist");
  // The working-tree copy is re-formatted (as `format --include-members` would) but not committed.
  writeFileSync(file, CHECKS);
  const r = check(fx, "acme-api", sha);
  assert.equal(r.status, 0, "non-canonical at a commit is information, not a refusal");
  assert.equal(r.json.state, "non-canonical");
  assert.ok(r.json.changes.length > 0, "the change summary is given");
  assert.equal(r.json.items.length, 2, "the items are still usable");
  assert.equal(r.json.workingTree.comparison, "same-content");
  assert.equal(git(fx.api, "show", `${sha}:.release-radar/checks.md`), CHECKS_EDITED.replace(/\r?\n$/, ""), "history is untouched");
  assert.equal(readFileSync(file, "utf8"), CHECKS, "the working-tree copy is untouched");
  assert.equal(git(fx.api, "rev-parse", "HEAD"), sha);
  // A working tree with different content is reported as differing.
  writeFileSync(file, CHECKS.replace("A new migration.", "A new or changed migration."));
  assert.equal(check(fx, "acme-api", sha).json.workingTree.comparison, "differs");
  const human = check(fx, "acme-api", sha, []);
  assert.match(human.stdout, /non-canonical at the commit \(used as is; never rewritten\)/);
  assert.match(human.stdout, /DIFFERS from the commit's copy/);
});

test("80/84: an invalid checklist at the commit exits 24 with the exact line, the report still printed", (t) => {
  const fx = commandFleet(t);
  put(join(fx.api, ".release-radar", "checks.md"), CHECKS_INVALID);
  const sha = commitAll(fx.api, "docs: bad checklist");
  const r = check(fx, "acme-api", sha);
  assert.equal(r.status, 24, r.out);
  assert.equal(r.phase, "validate");
  assert.ok(r.json, "the JSON report is printed with exit 24");
  assert.equal(r.json.state, "invalid");
  assert.equal(r.json.items, null);
  assert.equal(r.json.error.location.file, `${sha}:.release-radar/checks.md`);
  assert.equal(r.json.error.location.line, 8);
  assert.match(r.json.error.message, /owner/);
  assert.equal(r.json.outcome.exitCode, 24);
  assert.match(r.stderr, new RegExp(`\\.release-radar/checks\\.md invalid at ${sha.slice(0, 7)}: .*:8`));
  assert.equal(r.json.workingTree.comparison, "identical");
  assert.equal(git(fx.api, "status", "--porcelain"), "");
});

test("31c/84: in a monorepo member the checklist is read under repoSubdir", (t) => {
  const fx = commandFleet(t);
  put(join(fx.worker, "worker", ".release-radar", "checks.md"), CHECKS);
  put(join(fx.worker, ".release-radar", "checks.md"), CHECKS_INVALID);
  const sha = commitAll(fx.worker, "docs: worker checklist");
  const r = check(fx, "acme-worker", sha);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.path, "worker/.release-radar/checks.md");
  assert.equal(r.json.state, "canonical", "the repository-root file is not the member's checklist");
  assert.equal(r.json.workingTree.file, join(fx.worker, "worker", ".release-radar", "checks.md"));
});

test("64/24/29/21: bad names and shas are 64; an unknown commit is 64; non-canonical workspace input is 29", (t) => {
  const fx = commandFleet(t);
  for (const args of [
    ["checklist-check", ...fx.ws, "acme-api"],
    ["checklist-check", ...fx.ws, "--commit", fx.commits.c4],
    ["checklist-check", ...fx.ws, "acme-nope", "--commit", fx.commits.c4],
    ["checklist-check", ...fx.ws, "acme-api", "--commit", "main"],
    ["checklist-check", ...fx.ws, "acme-api", "--commit", "abc"],
    ["checklist-check", ...fx.ws, "acme-api", "--commit", "0123456789abcdef0123456789abcdef01234567"],
    ["checklist-check", ...fx.ws, "acme-api", "acme-worker", "--commit", fx.commits.c4],
  ]) {
    assert.equal(runCli(assert, fx.h, args).status, 64, args.join(" "));
  }
  assert.equal(runCli(assert, fx.h, ["checklist-check", "--workspace", fx.api, "acme-api", "--commit", fx.commits.c4]).status, 24, "no workspace.json there");
  const repos = readFileSync(fx.reposFile, "utf8");
  writeFileSync(fx.reposFile, JSON.stringify(JSON.parse(repos)));
  const non = check(fx, "acme-api", fx.commits.c4);
  assert.equal(non.status, 29, non.out);
  assert.match(non.stderr, /non-canonical input \(run format first\)/);
});
