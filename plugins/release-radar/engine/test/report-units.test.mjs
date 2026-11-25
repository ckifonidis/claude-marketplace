// report.ts, args.ts and the opaque `json` schema kind (spec requirements 16, 22, 55, 79, 85),
// plus the repoSubdir normalisation rule of requirement 31c.
import { test } from "node:test";
import assert from "node:assert/strict";
import { argumentError, parseCommandArgs } from "../dist/args.js";
import { checkWorkspace, normalizeRepoSubdir } from "../dist/config.js";
import { classify, t, validate } from "../dist/format.js";
import { parseImage } from "../dist/image.js";
import { colours, imageReport, isMutableTag, trailerLine, useColour } from "../dist/report.js";
import { expectEngineError, workspaceValue } from "./fixtures/workspace-fixtures.mjs";

test("22: the trailer names the result, phase and exit code", () => {
  assert.equal(trailerLine(0, "complete"), "RELEASE_RADAR_RESULT=OK PHASE=complete EXIT=0");
  assert.equal(trailerLine(23, "missing"), "RELEASE_RADAR_RESULT=FAIL PHASE=missing EXIT=23");
});

test("16: colour only at a TTY, never with NO_COLOR, never in --json", () => {
  assert.equal(useColour(false, { isTTY: true }, {}), true);
  assert.equal(useColour(false, { isTTY: true }, { NO_COLOR: "" }), false, "NO_COLOR set (even empty) disables colour");
  assert.equal(useColour(false, { isTTY: false }, {}), false);
  assert.equal(useColour(true, { isTTY: true }, {}), false);
  assert.equal(colours(false).red("x"), "x");
  assert.equal(colours(true).red("x"), "\u001b[31mx\u001b[0m");
});

test("46: mutable tags (explicit or implicit latest without digest) are flagged; raw is kept", () => {
  assert.equal(isMutableTag(parseImage("registry.example.com/acme/api")), true);
  assert.equal(isMutableTag(parseImage("registry.example.com/acme/api:latest")), true);
  assert.equal(isMutableTag(parseImage(`registry.example.com/acme/api:latest@sha256:${"a".repeat(64)}`)), false);
  assert.equal(isMutableTag(parseImage("registry.example.com/acme/api:1.0")), false);
  assert.equal(imageReport(parseImage("nginx")).raw, "nginx", "display keeps raw, never library/nginx");
  assert.deepEqual(imageReport(parseImage("NODE|20-lts")), { kind: "non-container", raw: "NODE|20-lts" });
});

test("19: the argument parser — values, optional-value lists, duplicates, unknowns, --config", () => {
  const spec = { flags: { workspace: { kind: "value" }, json: { kind: "boolean" }, "fail-on-drift": { kind: "optional-values", accepts: (x) => x.includes(":") } }, maxPositionals: 2 };
  const parsed = parseCommandArgs("status", ["a", "--fail-on-drift", "s1:s2", "local:s1", "b", "--workspace", "w"], spec);
  assert.deepEqual(parsed.positionals, ["a", "b"]);
  assert.deepEqual(parsed.lists.get("fail-on-drift"), ["s1:s2", "local:s1"]);
  assert.equal(parsed.values.get("workspace"), "w");
  assert.deepEqual(parseCommandArgs("status", ["--fail-on-drift"], spec).lists.get("fail-on-drift"), []);
  const fails = (argv, message) => assert.throws(() => parseCommandArgs("status", argv, spec), (e) => e.exitCode === 64 && message.test(e.message));
  fails(["--json", "--json"], /duplicate flag --json/);
  fails(["--nope"], /unknown flag "--nope"/);
  fails(["--workspace"], /--workspace needs a value/);
  fails(["--workspace", "--json"], /--workspace needs a value/);
  fails(["--config", "x"], /--config is not supported/);
  fails(["a", "b", "c"], /at most 2 positional/);
  assert.equal(argumentError("x").phase, "arguments");
});

test("79/85: the opaque json kind sorts keys recursively, keeps array order, rejects index-like keys", () => {
  const schema = t.object([t.required("schemaVersion", t.schemaVersion([1])), t.required("data", t.json())]);
  const canonical = '{\n  "schemaVersion": 1,\n  "data": {\n    "a": [\n      {\n        "x": 1,\n        "y": 2\n      },\n      3\n    ],\n    "b": null\n  }\n}\n';
  assert.equal(classify(canonical, schema, "f").state, "canonical");
  const edited = classify('{"schemaVersion":1,"data":{"b":null,"a":[{"y":2,"x":1},3]}}', schema, "f");
  assert.equal(edited.state, "non-canonical");
  assert.equal(edited.rendered, canonical);
  assert.ok(edited.changes.includes("keys sorted at /data"));
  assert.ok(edited.changes.includes("keys sorted at /data/a/0"));
  const invalid = classify('{"schemaVersion":1,"data":{"0":true}}', schema, "f");
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.error.location.pointer, "/data/0");
  assert.throws(() => validate({ schemaVersion: 1, data: { n: Number.NaN } }, schema, "f"), (e) => e.exitCode === 24);
});

test("31c: repoSubdir spellings normalise (./x, x/, x//y); root, '..', absolute and backslash are rejected", () => {
  assert.deepEqual(normalizeRepoSubdir("jobs"), { path: "jobs" });
  assert.deepEqual(normalizeRepoSubdir("./jobs"), { path: "jobs" });
  assert.deepEqual(normalizeRepoSubdir("jobs/"), { path: "jobs" });
  assert.deepEqual(normalizeRepoSubdir("./svc//jobs/./"), { path: "svc/jobs" });
  assert.match(normalizeRepoSubdir(".").problem, /write null for the root/);
  assert.match(normalizeRepoSubdir("./").problem, /write null for the root/);
  assert.match(normalizeRepoSubdir("jobs/../x").problem, /'\.\.'/);
  assert.match(normalizeRepoSubdir("/abs").problem, /relative/);
  assert.match(normalizeRepoSubdir("a\\b").problem, /separator/);
});

test("31c/76a: the later member is named when two spellings meet, with the normalised location", () => {
  const ws = workspaceValue();
  ws.members = [
    { name: "acme-a", repoKey: "acme-mono", repoSubdir: "jobs" },
    { name: "acme-b", repoKey: "acme-mono", repoSubdir: "./jobs/" },
  ];
  expectEngineError(assert, () => checkWorkspace(ws, "workspace.json"), {
    exitCode: 24,
    pointer: "/members/1/repoSubdir",
    message: /repoKey "acme-mono" with repoSubdir "\.\/jobs\/" \(normalised "jobs"\) is already used by \/members\/0/,
  });
  ws.members[1].repoSubdir = "./";
  expectEngineError(assert, () => checkWorkspace(ws, "workspace.json"), { exitCode: 24, pointer: "/members/1/repoSubdir", message: /write null for the root/ });
  ws.members[1].repoSubdir = "jobs-2/";
  checkWorkspace(ws, "workspace.json");
});
