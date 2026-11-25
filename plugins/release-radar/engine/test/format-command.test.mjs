// `format` / `format --check` end to end (spec requirements 39, 78-86; acceptance criteria 18, 19,
// 21): every file type, the three states with exact locations, lossless rewrites to the exact
// canonical bytes, the member-repo rule, cleanup (dedupe, retention, quarantine), the never-rewrite
// list, the exit-29 gate of the other commands, and the snapshot fingerprint under re-formatting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { WORKSPACE_SCHEMA } from "../dist/config.js";
import { canonicalize } from "../dist/format.js";
import { nextPackageDir, sha256, writeHandoffPackage } from "../dist/handoff.js";
import { renderOwnedReposFile } from "../dist/repo-paths.js";
import { nextSnapshotFile, writeSnapshot } from "../dist/snapshot.js";
import { renderIndex } from "../dist/workspace-index.js";
import { cliHarness, runCli, snapshotFiles } from "./fixtures/cli-harness.mjs";
import { handoffFleet } from "./fixtures/handoff-fixtures.mjs";
import { apiComponentValue, buildFleet, commitAll, git, put, tempDir, text, workspaceValue } from "./fixtures/workspace-fixtures.mjs";

const FLEET_CHECKLIST = `# release-radar checklist

schemaVersion: 1

## db-migrations
- layer: fleet
- severity: blocker
- paths: migrations/**, src/db/schema.ts
- signal: A new or changed migration file.
- prepare: Run the migration against a copy of stage-1 data.
    Confirm the rollback script exists.

## env-vars
- layer: fleet
- severity: high
- paths: .env.example
- signal: A new required environment variable.
- prepare: Add the setting to every stage before promoting.
`;

/** The same content: items out of order, fields out of order, odd indentation, CRLF. */
const FLEET_CHECKLIST_EDITED = [
  "# release-radar checklist",
  "",
  "schemaVersion: 1",
  "",
  "## env-vars",
  "- layer: fleet",
  "- severity: high",
  "- signal: A new required environment variable.",
  "- paths: .env.example",
  "- prepare: Add the setting to every stage before promoting.",
  "",
  "",
  "## db-migrations",
  "  - layer: fleet",
  "- severity: blocker",
  "- paths: migrations/**, src/db/schema.ts",
  "- signal: A new or changed migration file.",
  "- prepare: Run the migration against a copy of stage-1 data.",
  "        Confirm the rollback script exists.",
  "",
].join("\r\n");

const COMPONENT_CHECKLIST = `# release-radar checklist

schemaVersion: 1

## api-contract
- layer: component
- severity: high
- paths: src/api/**
- signal: A changed public route.
- prepare: Tell the consumers.
`;

const COMPONENT_CHECKLIST_EDITED = "# release-radar checklist\n\nschemaVersion: 1\n\n## api-contract\n- layer: component\n- severity: high\n- prepare: Tell the consumers.\n- signal: A changed public route.\n- paths: src/api/**\n\n## api-contract\n- layer: component\n- severity: high\n- paths: src/api/**\n- signal: A changed public route.\n- prepare: Tell the consumers.\n";

/** Reverses every object's key order (a hand edit that changes no content). */
function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)]));
}

/** A hand-edited spelling of `value`: keys reversed, 4-space indent, CRLF, no final newline. */
function handEdited(value) {
  return JSON.stringify(reorder(value), null, 4).replace(/\n/g, "\r\n");
}

/** path (relative to `dir`) → sha256 of every file below `dir`, `.git` excluded. */
function tree(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (name === ".git") continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(dir, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

function entry(report, file) {
  const found = report.files.find((candidate) => candidate.file === file);
  assert.ok(found, `no entry for ${file} in ${report.files.map((f) => f.file).join(", ")}`);
  return found;
}

function snapshotValue(time) {
  return { schemaVersion: 1, engineVersion: "0.1.0", time, exitCode: 0, fingerprint: "0".repeat(64), components: ["acme-api"], members: [], report: { note: "synthetic" } };
}

function manifestValue(component, stage, createdAt, copies) {
  return {
    schemaVersion: 1,
    engineVersion: "0.1.0",
    createdAt,
    component,
    stage,
    receivingOwner: "ops-team",
    promotedCommit: "a".repeat(40),
    complete: true,
    blocking: [],
    image: null,
    files: copies.map((copy) => ({ path: copy.path, sourceCommit: "a".repeat(40), sha256: sha256(copy.bytes), bytes: copy.bytes.length })),
    settingsDiff: { status: "not-compared", deployedCommit: null, reason: "synthetic", files: [] },
    beforePromote: { workspace: null, component: null },
    literalSecretWarnings: [],
  };
}

/** A handoff fleet with a fleet checklist, a component checklist in acme-api, a snapshot, a package and an index. */
function fullFleet(t) {
  const fx = handoffFleet(t, { workspace: (ws) => void (ws.checklist = ".release-radar/checks.md") });
  put(fx.checklist, FLEET_CHECKLIST);
  const componentChecklist = put(join(fx.api, ".release-radar", "checks.md"), COMPONENT_CHECKLIST);
  const index = join(tempDir(t, "release-radar-index-"), "workspace-index.json");
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "--all"]).status, 0);
  const handoff = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", "--stage", "stage-3", "--commit", fx.commits.c3, "--json"]);
  assert.equal(handoff.status, 0, handoff.out);
  assert.equal(runCli(assert, fx.h, ["workspace-index", "register", fx.platform, "--index", index]).status, 0);
  writeFileSync(fx.reposFile, renderOwnedReposFile({ "acme-api": "../../acme-api", "acme-worker": "../../acme-worker" }));
  const snapshot = join(fx.platform, ".release-radar", "snapshots", snapshotFiles(fx.platform)[0]);
  return { ...fx, componentChecklist, index, snapshot, manifest: handoff.json.package.manifest, packageDir: handoff.json.package.dir };
}

test("78/86/AC19: every file type, engine-written ones straight after writing, is canonical; --check writes nothing", (t) => {
  const fx = fullFleet(t);
  const before = tree(fx.base);
  const indexBefore = readFileSync(fx.index, "utf8");
  const r = runCli(assert, fx.h, ["format", "--check", ...fx.ws, "--index", fx.index, "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.mode, "check");
  assert.deepEqual([...new Set(r.json.files.map((file) => file.kind))].sort(), [
    "component", "component-checklist", "fleet-checklist", "handoff-copy", "handoff-manifest", "repos-file", "snapshot", "workspace", "workspace-index",
  ]);
  for (const file of r.json.files) assert.equal(file.state, "canonical", `${file.kind} ${file.file}`);
  assert.equal(entry(r.json, fx.apiComponent).owner, "member-repo");
  assert.equal(entry(r.json, fx.snapshot).owner, "engine");
  assert.equal(entry(r.json, fx.manifest).kind, "handoff-manifest");
  assert.equal(r.json.summary.invalid + r.json.summary.nonCanonical, 0);
  assert.deepEqual(tree(fx.base), before, "--check writes nothing");
  assert.equal(readFileSync(fx.index, "utf8"), indexBefore);
  const write = runCli(assert, fx.h, ["format", ...fx.ws, "--index", fx.index, "--include-members", "--json"]);
  assert.equal(write.status, 0, write.out);
  assert.equal(write.json.summary.rewritten, 0);
  assert.deepEqual(tree(fx.base), before, "a canonical tree is left byte-identical");
});

test("81/83a/86: hand-edited valid files normalise to the exact canonical bytes; member files need --include-members", (t) => {
  const fx = fullFleet(t);
  const canonical = new Map([fx.workspaceFile, fx.reposFile, fx.checklist, fx.apiComponent, fx.componentChecklist, fx.snapshot, fx.manifest, fx.index].map((file) => [file, readFileSync(file, "utf8")]));
  // Hand edits: reordered keys, odd whitespace, CRLF, unsorted unordered arrays, identical duplicates.
  const ws = JSON.parse(canonical.get(fx.workspaceFile));
  ws.members = [...ws.members].reverse();
  ws.members.push({ ...ws.members[0] });
  writeFileSync(fx.workspaceFile, handEdited(ws));
  writeFileSync(fx.reposFile, handEdited(JSON.parse(canonical.get(fx.reposFile))).replace(/    /g, "\t"));
  writeFileSync(fx.checklist, FLEET_CHECKLIST_EDITED);
  const api = JSON.parse(canonical.get(fx.apiComponent));
  api.stages["stage-1"].targets.push({ ...api.stages["stage-1"].targets[0] });
  writeFileSync(fx.apiComponent, handEdited(api));
  writeFileSync(fx.componentChecklist, COMPONENT_CHECKLIST_EDITED);
  writeFileSync(fx.snapshot, handEdited(JSON.parse(canonical.get(fx.snapshot))));
  writeFileSync(fx.manifest, handEdited(JSON.parse(canonical.get(fx.manifest))));
  writeFileSync(fx.index, `${JSON.stringify(JSON.parse(canonical.get(fx.index)), null, 3)}`);
  const copies = tree(join(fx.packageDir, "files"));
  const edited = new Map([...canonical.keys()].map((file) => [file, readFileSync(file, "utf8")]));

  const check = runCli(assert, fx.h, ["format", "--check", ...fx.ws, "--index", fx.index, "--json"]);
  assert.equal(check.status, 29, check.out);
  for (const file of canonical.keys()) {
    const found = entry(check.json, file);
    assert.equal(found.state, "non-canonical", file);
    assert.ok(found.changes.length > 0, `${file} has a change summary`);
    assert.equal(readFileSync(file, "utf8"), edited.get(file), "--check writes nothing");
  }
  assert.equal(entry(check.json, fx.apiComponent).action, "needs-include-members");
  assert.equal(entry(check.json, fx.apiComponent).note, "re-format requires --include-members (member repository)");
  assert.equal(entry(check.json, fx.workspaceFile).action, "would-rewrite");
  assert.ok(entry(check.json, fx.workspaceFile).changes.includes("line endings normalised (CRLF to LF)"));
  assert.ok(entry(check.json, fx.checklist).changes.includes("items sorted by id"));
  assert.deepEqual(
    check.json.cleanup.deduplicated.map((item) => [item.file, item.change]),
    [
      [fx.workspaceFile, "duplicate entry removed at /members/2 (identical to /members/0)"],
      [fx.apiComponent, "duplicate entry removed at /stages/stage-1/targets/1 (identical to /stages/stage-1/targets/0)"],
      [fx.componentChecklist, 'duplicate item "api-contract" removed (line 12, identical to line 5)'],
    ],
  );
  assert.match(check.stderr, /non-canonical \(run format\)/);

  const write = runCli(assert, fx.h, ["format", ...fx.ws, "--index", fx.index, "--json"]);
  assert.equal(write.status, 29, "member-repo files are left non-canonical without --include-members");
  for (const file of [fx.workspaceFile, fx.reposFile, fx.checklist, fx.snapshot, fx.manifest, fx.index]) {
    assert.equal(readFileSync(file, "utf8"), canonical.get(file), `${file} → exact canonical bytes`);
    assert.equal(entry(write.json, file).action, "rewritten");
  }
  for (const file of [fx.apiComponent, fx.componentChecklist]) {
    assert.equal(readFileSync(file, "utf8"), edited.get(file), `${file} untouched without --include-members`);
    assert.equal(entry(write.json, file).action, "needs-include-members");
  }
  assert.match(write.stderr, /left non-canonical \(member repositories; re-run with --include-members/);

  const members = runCli(assert, fx.h, ["format", ...fx.ws, "--index", fx.index, "--include-members", "--json"]);
  assert.equal(members.status, 0, members.out);
  for (const file of canonical.keys()) assert.equal(readFileSync(file, "utf8"), canonical.get(file), `${file} → exact canonical bytes`);
  assert.deepEqual(tree(join(fx.packageDir, "files")), copies, "verbatim copies are never touched");
  const again = runCli(assert, fx.h, ["format", ...fx.ws, "--index", fx.index, "--include-members", "--json"]);
  assert.equal(again.status, 0);
  assert.equal(again.json.summary.rewritten, 0, "format(format(x)) == format(x)");
});

test("81/86: invalid files exit 24 with the exact location, are left untouched, and the rest is still formatted", (t) => {
  const h = cliHarness(t);
  const lineOf = (content, needle) => content.split("\n").findIndex((line) => line.includes(needle)) + 1;
  const cases = [
    {
      name: "unknown key",
      setup: (fx) => {
        const content = text({ ...workspaceValue(), surplus: true });
        writeFileSync(fx.workspaceFile, content);
        return { file: fx.workspaceFile, pointer: "/surplus", line: lineOf(content, '"surplus"'), column: 3, message: /unknown key "surplus"/ };
      },
    },
    {
      name: "same id with different content",
      setup: (fx) => {
        const api = apiComponentValue();
        api.stages["stage-1"].targets.push({ ...api.stages["stage-1"].targets[1], deployment: "acme-api-other" });
        const content = text(api);
        writeFileSync(fx.apiComponent, content);
        const line = lineOf(content, '"deployment": "acme-api-other"') - 4;
        return { file: fx.apiComponent, pointer: "/stages/stage-1/targets/2/name", line, column: content.split("\n")[line - 1].indexOf('"name"') + 1, message: /duplicate name "api-internal" with different content/, alsoFormatted: true };
      },
    },
    {
      name: "malformed checklist item",
      setup: (fx) => {
        writeFileSync(fx.checklist, FLEET_CHECKLIST.replace("- signal: A new required", "- owner: someone\n- signal: A new required"));
        return { file: fx.checklist, line: lineOf(FLEET_CHECKLIST, "- signal: A new required"), column: 3, message: /unknown field "owner"/, alsoFormatted: true };
      },
    },
    {
      name: "comments in JSON",
      setup: (fx) => {
        writeFileSync(fx.reposFile, '{\n  "schemaVersion": 1,\n  // a comment\n  "repos": {}\n}\n');
        return { file: fx.reposFile, line: 3, column: 3, message: /comment/ };
      },
    },
    {
      name: "unsupported schemaVersion",
      setup: (fx) => {
        const content = text({ ...workspaceValue(), schemaVersion: 99 });
        writeFileSync(fx.workspaceFile, content);
        return { file: fx.workspaceFile, pointer: "/schemaVersion", line: 2, column: 3, message: /unsupported schemaVersion 99/ };
      },
    },
  ];
  for (const testCase of cases) {
    const fx = buildFleet(t);
    put(fx.checklist, FLEET_CHECKLIST);
    const expected = testCase.setup(fx);
    const invalidBytes = readFileSync(expected.file, "utf8");
    // Another, valid but non-canonical member file: still formatted when the members can be checked.
    const workerText = readFileSync(fx.workerComponent, "utf8");
    writeFileSync(fx.workerComponent, handEdited(JSON.parse(workerText)));
    for (const args of [["format", "--check"], ["format", "--include-members"]]) {
      const r = runCli(assert, h, [...args, "--workspace", fx.platform, "--json"]);
      assert.equal(r.status, 24, `${testCase.name}: ${r.out}`);
      const found = entry(r.json, expected.file);
      assert.equal(found.state, "invalid", testCase.name);
      assert.equal(found.action, "left-invalid");
      assert.match(found.error.message, expected.message, testCase.name);
      assert.equal(found.error.location.file, expected.file);
      if (expected.pointer !== undefined) assert.equal(found.error.location.pointer, expected.pointer, testCase.name);
      assert.equal(found.error.location.line, expected.line, `${testCase.name}: line`);
      assert.equal(found.error.location.column, expected.column, `${testCase.name}: column`);
      assert.equal(readFileSync(expected.file, "utf8"), invalidBytes, `${testCase.name}: the invalid file is untouched`);
      assert.match(r.stderr, /release-radar: invalid: /);
    }
    if (expected.alsoFormatted === true) assert.equal(readFileSync(fx.workerComponent, "utf8"), workerText, `${testCase.name}: the valid member file was still formatted`);
  }
});

test("39/81/86/AC21: retention keeps exactly the configured counts; orphans move to quarantine with a report; nothing else is deleted", (t) => {
  const fx = buildFleet(t, { workspace: (ws) => ({ ...ws, snapshotRetention: 3, handoffRetention: 2 }) });
  put(fx.checklist, FLEET_CHECKLIST);
  const h = cliHarness(t);
  const rr = join(fx.platform, ".release-radar");
  // Five valid snapshots, one minute apart.
  const snapshots = [];
  for (let minute = 0; minute < 5; minute++) {
    const time = new Date(Date.UTC(2026, 10, 25, 10, minute, 0, 0)).toISOString();
    const file = nextSnapshotFile(fx.platform, time);
    writeSnapshot(file, snapshotValue(time));
    snapshots.push(file);
  }
  // Three packages for acme-api/stage-2 and one for acme-worker/stage-2.
  const pkg = (component, minute) => {
    const createdAt = new Date(Date.UTC(2026, 10, 25, 11, minute, 0, 0)).toISOString();
    const copies = [{ path: "config/settings.stage-2.json", bytes: Buffer.from('{ "keep": "as-is" }') }];
    const dir = nextPackageDir(fx.platform, component, "stage-2", createdAt);
    writeHandoffPackage(dir, manifestValue(component, "stage-2", createdAt, copies), copies);
    return dir;
  };
  const apiPackages = [pkg("acme-api", 0), pkg("acme-api", 1), pkg("acme-api", 2)];
  const workerPackage = pkg("acme-worker", 0);
  // Orphans.
  const orphans = [
    put(join(rr, "snapshots", "notes.txt"), "not a snapshot\n"),
    put(join(rr, "snapshots", "2026-11-25T09-00-00-000Z.json"), text({ ...snapshotValue("2026-11-25T09:00:00.000Z"), schemaVersion: 99 })),
    put(join(rr, "snapshots", "nested", "file.json"), "{}\n"),
    put(join(rr, "handoff", "loose.txt"), "loose\n"),
    put(join(rr, "handoff", "not-a-package", "x.txt"), "x\n"),
    put(join(rr, "handoff", "acme-api-stage-2-2026-11-25T08-00-00-000Z", "files", "half.json"), "{}\n"),
    put(join(apiPackages[2], "stray.txt"), "stray\n"),
    put(join(rr, "handoff", "acme-api-stage-2-2026-11-25T07-00-00-000Z", "manifest.json"), text({ schemaVersion: 2, future: true })),
  ];
  const orphanRoots = [orphans[0], orphans[1], join(rr, "snapshots", "nested"), orphans[3], join(rr, "handoff", "not-a-package"), join(rr, "handoff", "acme-api-stage-2-2026-11-25T08-00-00-000Z"), orphans[6], join(rr, "handoff", "acme-api-stage-2-2026-11-25T07-00-00-000Z")];
  const before = tree(rr);

  const check = runCli(assert, h, ["format", "--check", "--workspace", fx.platform, "--json"]);
  assert.equal(check.status, 0, check.out);
  assert.deepEqual(tree(rr), before, "--check moves and deletes nothing");
  assert.equal(check.json.cleanup.retention.status, "planned");
  assert.deepEqual(check.json.cleanup.retention.snapshots.deleted, snapshots.slice(0, 2).reverse());
  assert.deepEqual(check.json.cleanup.retention.handoff.deleted, [apiPackages[0]]);
  assert.deepEqual(check.json.cleanup.quarantine.moved.map((move) => move.from).sort(), [...orphanRoots].sort());

  const r = runCli(assert, h, ["format", "--workspace", fx.platform, "--json"]);
  assert.equal(r.status, 0, r.out);
  // Retention: exactly the configured counts remain.
  assert.deepEqual(readdirSync(join(rr, "snapshots")).sort(), snapshots.slice(2).map((file) => file.split("/").pop()).sort());
  assert.deepEqual(readdirSync(join(rr, "handoff")).sort(), [apiPackages[1], apiPackages[2], workerPackage].map((dir) => dir.split("/").pop()).sort());
  assert.equal(r.json.cleanup.retention.snapshots.keep, 3);
  assert.equal(r.json.cleanup.retention.handoff.keep, 2);
  // Quarantine: every orphan moved, byte-identical, with its reason.
  const quarantine = r.json.cleanup.quarantine.dir;
  assert.match(quarantine, /\.release-radar\/quarantine\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.equal(r.json.cleanup.quarantine.moved.length, orphanRoots.length);
  for (const move of r.json.cleanup.quarantine.moved) {
    assert.ok(!existsSync(move.from), `${move.from} moved away`);
    assert.ok(existsSync(move.to), `${move.to} exists`);
    assert.equal(move.to, join(quarantine, relative(rr, move.from)));
    assert.ok(move.reason.length > 0);
  }
  // Nothing else was deleted: after = before − pruned − orphans + quarantined, byte for byte.
  const after = tree(rr);
  const prunedPrefixes = [...snapshots.slice(0, 2), apiPackages[0]].map((path) => relative(rr, path));
  const orphanPrefixes = orphanRoots.map((path) => relative(rr, path));
  const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
  for (const [path, hash] of before) {
    if (prunedPrefixes.some((prefix) => under(path, prefix))) {
      assert.ok(!after.has(path), `${path} pruned`);
    } else if (orphanPrefixes.some((prefix) => under(path, prefix))) {
      assert.equal(after.get(relative(rr, join(quarantine, path))), hash, `${path} quarantined intact`);
    } else assert.equal(after.get(path), hash, `${path} kept intact`);
  }
  assert.equal(after.size, before.size - [...before.keys()].filter((path) => prunedPrefixes.some((prefix) => under(path, prefix))).length);
  // The verbatim copies (non-canonical-looking JSON) were never re-formatted.
  assert.equal(readFileSync(join(apiPackages[2], "files", "config", "settings.stage-2.json"), "utf8"), '{ "keep": "as-is" }');
});

test("82b/86: an externally owned repos file is validated but never rewritten", (t) => {
  const external = { _comment: "shared with other tools", repos: { "acme-worker": "../acme-worker", "acme-api": "../acme-api" } };
  const fx = buildFleet(t, { workspace: (ws) => ({ ...ws, reposFile: { kind: "external", path: "../shared/repos.json" } }) });
  put(fx.checklist, FLEET_CHECKLIST);
  const file = put(join(fx.base, "shared", "repos.json"), JSON.stringify(external, null, 4));
  const bytes = readFileSync(file, "utf8");
  const h = cliHarness(t);
  for (const args of [["format", "--check"], ["format", "--include-members"]]) {
    const r = runCli(assert, h, [...args, "--workspace", fx.platform, "--json"]);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.out}`);
    const found = entry(r.json, file);
    assert.equal(found.kind, "external-repos-file");
    assert.equal(found.owner, "external");
    assert.equal(found.state, "non-canonical");
    assert.equal(found.action, "never-rewritten");
    assert.equal(found.note, "externally owned — not re-formatted");
    assert.equal(readFileSync(file, "utf8"), bytes);
  }
  const human = runCli(assert, h, ["format", "--workspace", fx.platform]);
  assert.match(human.stdout, /external-repos-file .*externally owned — not re-formatted/);
});

test("82c/84/86: component.json and checklists read at a commit are never rewritten", (t) => {
  const fx = handoffFleet(t);
  const checks = join(fx.api, ".release-radar", "checks.md");
  const componentText = readFileSync(fx.apiComponent, "utf8");
  writeFileSync(fx.apiComponent, handEdited(JSON.parse(componentText)));
  writeFileSync(checks, COMPONENT_CHECKLIST_EDITED);
  const old = commitAll(fx.api, "chore: hand-edited files");
  const oldComponent = git(fx.api, "show", `${old}:.release-radar/component.json`);
  const oldChecks = git(fx.api, "show", `${old}:.release-radar/checks.md`);
  writeFileSync(fx.apiComponent, componentText);
  writeFileSync(checks, COMPONENT_CHECKLIST);
  const head = commitAll(fx.api, "chore: canonical files");
  const diff = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", old, "--to", "stage-3", "--json"]);
  assert.equal(diff.status, 0, diff.out);
  assert.equal(diff.json.componentConfig.state, "non-canonical", "used and reported (84)");
  const r = runCli(assert, fx.h, ["format", ...fx.ws, "--include-members"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(git(fx.api, "rev-parse", "HEAD"), head);
  assert.equal(git(fx.api, "show", `${old}:.release-radar/component.json`), oldComponent);
  assert.equal(git(fx.api, "show", `${old}:.release-radar/checks.md`), oldChecks);
  assert.equal(git(fx.api, "status", "--porcelain"), "", "nothing in the member repository changed");
});

test("83/D6/86: non-format commands refuse non-canonical input with 29 (status, pipeline-preview, settings-diff, handoff-package)", (t) => {
  const fx = buildFleet(t);
  const h = cliHarness(t);
  writeFileSync(fx.reposFile, handEdited(JSON.parse(readFileSync(fx.reposFile, "utf8"))));
  const ws = ["--workspace", fx.platform];
  for (const args of [
    ["status", ...ws, "--all"],
    ["status", ...ws, "acme-api", "--json"],
    ["pipeline-preview", ...ws, "acme-api", "--stage", "stage-1"],
    ["settings-diff", ...ws, "acme-api", "--from", "local", "--to", "stage-2"],
    ["handoff-package", ...ws, "acme-api", "--stage", "stage-2", "--commit", "0123456"],
  ]) {
    const r = runCli(assert, h, args);
    assert.equal(r.status, 29, `${args[0]}: ${r.out}`);
    assert.match(r.stderr, new RegExp(`non-canonical input \\(run format first\\): .*${fx.reposFile.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  }
  assert.deepEqual(h.calls(), [], "29 is decided before any adapter call");
  assert.equal(runCli(assert, h, ["format", ...ws]).status, 0);
  assert.equal(runCli(assert, h, ["validate-config", ...ws]).status, 0, "after format the input is canonical");
});

test("50/86: re-formatting the workspace and a component.json through format leaves the snapshot fingerprint unchanged", (t) => {
  const fx = handoffFleet(t);
  const first = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  assert.equal(first.status, 0, first.out);
  writeFileSync(fx.workspaceFile, handEdited(JSON.parse(readFileSync(fx.workspaceFile, "utf8"))));
  writeFileSync(fx.apiComponent, handEdited(JSON.parse(readFileSync(fx.apiComponent, "utf8"))));
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "--all"]).status, 29);
  assert.equal(runCli(assert, fx.h, ["format", ...fx.ws, "--include-members"]).status, 0);
  const second = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  assert.equal(second.status, 0, second.out);
  assert.equal(second.json.snapshot.fingerprint, first.json.snapshot.fingerprint);
  const check = runCli(assert, fx.h, ["format", "--check", ...fx.ws, "--json"]);
  assert.equal(check.status, 0, check.out);
  assert.equal(check.json.files.filter((file) => file.kind === "snapshot").length, 2, "both snapshots are engine-written and canonical");
});

test("83a/31e: in a single-repo project the component.json is a workspace-repo file, re-formatted without --include-members", (t) => {
  const base = tempDir(t);
  const repo = join(base, "acme-api");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const ws = workspaceValue();
  ws.members = [{ name: "acme-api", repoKey: "acme-api", repoSubdir: null }];
  ws.checklist = null;
  put(join(repo, ".release-radar", "workspace.json"), canonicalize(ws, WORKSPACE_SCHEMA));
  put(join(repo, ".release-radar", "repos.local.json"), { schemaVersion: 1, repos: { "acme-api": ".." } });
  const component = join(repo, ".release-radar", "component.json");
  writeFileSync(component, handEdited(apiComponentValue()));
  const h = cliHarness(t);
  const r = runCli(assert, h, ["format", "--workspace", repo, "--json"]);
  assert.equal(r.status, 0, r.out);
  const found = entry(r.json, component);
  assert.equal(found.owner, "workspace-repo");
  assert.equal(found.action, "rewritten");
  assert.equal(readFileSync(component, "utf8"), text(apiComponentValue()));
});

test("31g/81: stale workspace-index entries are reported, never removed; an absent index is the empty initial state", (t) => {
  const fx = buildFleet(t);
  put(fx.checklist, FLEET_CHECKLIST);
  const h = cliHarness(t);
  const dir = tempDir(t, "release-radar-index-");
  const index = join(dir, "workspace-index.json");
  const gone = join(dir, "gone-workspace");
  writeFileSync(index, text({ schemaVersion: 1, workspaces: [{ path: fx.platform }, { path: gone }].sort((a, b) => (a.path < b.path ? -1 : 1)) }));
  const bytes = readFileSync(index, "utf8");
  const r = runCli(assert, h, ["format", "--workspace", fx.platform, "--index", index, "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.cleanup.staleIndexEntries, [{ path: gone, reason: "path no longer exists" }]);
  assert.equal(readFileSync(index, "utf8"), bytes, "stale entries are only reported");
  const absent = runCli(assert, h, ["format", "--check", "--workspace", fx.platform, "--index", join(dir, "none.json"), "--json"]);
  assert.equal(absent.status, 0, absent.out);
  assert.deepEqual(absent.json.index, { file: join(dir, "none.json"), exists: false });
});

test("12/64: format takes no positionals, requires --workspace, rejects --config", (t) => {
  const h = cliHarness(t);
  for (const args of [["format"], ["format", "--workspace", "/nowhere", "extra"], ["format", "--config", "x"]]) {
    assert.equal(runCli(assert, h, args).status, 64, args.join(" "));
  }
  const missing = runCli(assert, h, ["format", "--check", "--workspace", tempDir(t)]);
  assert.equal(missing.status, 24, "no workspace.json at the path");
});

// ---------------------------------------------------------------------------
// Index-only mode: `format [--check] --index <file>` without --workspace.

/** A registered index holding `paths`, written canonically by the engine's own renderer. */
function indexWith(t, paths) {
  const index = join(tempDir(t, "release-radar-index-"), "workspace-index.json");
  writeFileSync(index, renderIndex(paths));
  return index;
}

test("31g/81 index-only: format --check --index <file> classifies only the index; workspace null; cleanup skipped", (t) => {
  const fx = buildFleet(t);
  const h = cliHarness(t);
  const index = indexWith(t, [fx.platform]);
  const bytes = readFileSync(index, "utf8");
  for (const mode of [["--check"], []]) {
    const r = runCli(assert, h, ["format", ...mode, "--index", index, "--json"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.json.workspace, null, "no workspace in an index-only run");
    assert.equal(r.json.mode, mode.length === 0 ? "write" : "check");
    assert.deepEqual(r.json.files.map((file) => [file.kind, file.file, file.state, file.action]), [["workspace-index", index, "canonical", "none"]]);
    assert.deepEqual(r.json.members, []);
    assert.deepEqual(r.json.cleanup.retention, { status: "skipped", reason: "index-only run", snapshots: null, handoff: null });
    assert.deepEqual(r.json.cleanup.quarantine, { status: "skipped", reason: "index-only run", dir: null, moved: [] });
    assert.deepEqual(r.json.index, { file: index, exists: true });
  }
  assert.equal(readFileSync(index, "utf8"), bytes);
  const human = runCli(assert, h, ["format", "--check", "--index", index]);
  assert.equal(human.status, 0, human.out);
  assert.match(human.stdout, /index .*workspace-index\.json \(index-only run\)/);
  assert.match(human.stdout, /retention: skipped — index-only run/);
  assert.match(human.stdout, /quarantine: skipped — index-only run/);
  assert.ok(!existsSync(join(fx.platform, ".release-radar", "quarantine")), "nothing in the workspace is touched");
});

test("31g/83 index-only: a hand-edited index is 29 under --check, rewritten canonically by format --index, then list/resolve accept it", (t) => {
  const fx = buildFleet(t);
  const h = cliHarness(t);
  const index = indexWith(t, [fx.platform]);
  const canonical = readFileSync(index, "utf8");
  writeFileSync(index, handEdited(JSON.parse(canonical)));
  const refused = runCli(assert, h, ["workspace-index", "list", "--index", index]);
  assert.equal(refused.status, 29, refused.out);
  assert.match(refused.stderr, /format --index .*workspace-index\.json` re-formats the index alone, no workspace needed/, "the hint points at the index-only mode");
  const edited = readFileSync(index, "utf8");
  const check = runCli(assert, h, ["format", "--check", "--index", index, "--json"]);
  assert.equal(check.status, 29, check.out);
  assert.equal(check.json.files[0].state, "non-canonical");
  assert.equal(check.json.files[0].action, "would-rewrite");
  assert.ok(check.json.files[0].changes.length > 0);
  assert.equal(readFileSync(index, "utf8"), edited, "--check writes nothing");
  const write = runCli(assert, h, ["format", "--index", index, "--json"]);
  assert.equal(write.status, 0, write.out);
  assert.equal(write.json.files[0].action, "rewritten");
  assert.equal(write.json.summary.rewritten, 1);
  assert.equal(readFileSync(index, "utf8"), canonical, "the exact canonical bytes");
  assert.equal(runCli(assert, h, ["workspace-index", "list", "--index", index]).status, 0);
  assert.equal(runCli(assert, h, ["workspace-index", "resolve", fx.platform, "--index", index]).status, 0);
});

test("31g/81 index-only: an invalid index exits 24 with the location and is left untouched; stale entries are only reported", (t) => {
  const h = cliHarness(t);
  const dir = tempDir(t, "release-radar-index-");
  const index = join(dir, "workspace-index.json");
  const invalid = '{"schemaVersion": 1, "workspaces": [{"path": "relative/path"}]}\n';
  writeFileSync(index, invalid);
  for (const mode of [["--check"], []]) {
    const r = runCli(assert, h, ["format", ...mode, "--index", index, "--json"]);
    assert.equal(r.status, 24, r.out);
    assert.equal(r.json.files[0].state, "invalid");
    assert.equal(r.json.files[0].action, "left-invalid");
    assert.equal(r.json.files[0].error.location.pointer, "/workspaces/0/path");
    assert.equal(readFileSync(index, "utf8"), invalid);
  }
  const gone = join(dir, "gone-workspace");
  writeFileSync(index, renderIndex([gone]));
  const stale = runCli(assert, h, ["format", "--index", index, "--json"]);
  assert.equal(stale.status, 0, stale.out);
  assert.deepEqual(stale.json.cleanup.staleIndexEntries, [{ path: gone, reason: "path no longer exists" }]);
  assert.equal(readFileSync(index, "utf8"), renderIndex([gone]), "stale entries are never removed by format");
  const absent = runCli(assert, h, ["format", "--check", "--index", join(dir, "none.json"), "--json"]);
  assert.equal(absent.status, 0, absent.out);
  assert.deepEqual(absent.json.index, { file: join(dir, "none.json"), exists: false });
  assert.deepEqual(absent.json.files, []);
});

test("12/64 index-only: neither --workspace nor --index is 64; --include-members without --workspace is 64; combined mode is unchanged", (t) => {
  const fx = buildFleet(t);
  const h = cliHarness(t);
  const index = indexWith(t, [fx.platform]);
  for (const [args, message] of [
    [["format"], /requires --workspace <path>, --index <file> \(index-only\), or both/],
    [["format", "--check", "--json"], /requires --workspace <path>, --index <file>/],
    [["format", "--index", index, "--include-members"], /--include-members needs --workspace <path>/],
  ]) {
    const r = runCli(assert, h, args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, message);
  }
  const combined = runCli(assert, h, ["format", "--check", "--workspace", fx.platform, "--index", index, "--json"]);
  assert.equal(combined.status, 0, combined.out);
  assert.deepEqual(combined.json.workspace, { root: fx.platform, file: fx.workspaceFile });
  assert.equal(combined.json.cleanup.retention.status, "planned");
  assert.equal(combined.json.cleanup.quarantine.status, "planned");
  assert.ok(combined.json.files.some((file) => file.kind === "workspace"));
  assert.ok(combined.json.files.some((file) => file.kind === "workspace-index" && file.file === index));
  const written = runCli(assert, h, ["format", "--workspace", fx.platform, "--json"]);
  assert.equal(written.json.cleanup.quarantine.status, "applied");
  assert.equal(written.json.index, null);
});
