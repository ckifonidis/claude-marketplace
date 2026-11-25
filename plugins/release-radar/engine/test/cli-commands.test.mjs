// CLI surface (spec requirements 11-14, 19, 22, 28, 31f, 31g, 76, 76a): strict argument parsing,
// `--config` rejection, `where`, `validate-config`, `discover` and `workspace-index`, end to end
// through `node dist/cli.js` with fake CLIs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { READ_ONLY, SUB, assertReadOnly } from "./fixtures/cli-shims.mjs";
import { appServiceFleet, cliHarness, commandFleet, installAz, runCli, webapp } from "./fixtures/cli-harness.mjs";
import { buildFleet, tempDir, text } from "./fixtures/workspace-fixtures.mjs";

// ---------------------------------------------------------------------------
// Arguments

test("13: --config is rejected with 64 pointing at --workspace, for every command", (t) => {
  const h = cliHarness(t);
  for (const args of [["status", "--config", "x", "acme-api"], ["discover", "--config", "x"], ["validate-config", "--config", "x"], ["nope", "--config", "x"], ["--config", "x"]]) {
    const r = runCli(assert, h, args);
    assert.equal(r.status, 64, args.join(" "));
    assert.match(r.stderr, /--config is not supported: pass the workspace explicitly with --workspace <path>/);
  }
});

test("12/19: unknown, duplicate and incomplete arguments exit 64 with usage, before any I/O", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, {});
  const cases = [
    [[], /missing command/],
    [["deploy"], /unknown command "deploy" \(commands in this engine build: status, verify, discover, validate-config, pipeline-runs, pipeline-run, pipeline-preview, run-pipeline, settings-diff, handoff-package, format, snapshot-info, checklist-check, where, workspace-index\)/],
    [["status", "acme-api"], /"status" requires --workspace <path>/],
    [["status", ...fx.ws], /status needs component names or --all/],
    [["status", ...fx.ws, "--all", "acme-api"], /name components OR pass --all, not both/],
    [["status", ...fx.ws, "--all", "--json", "--json"], /duplicate flag --json/],
    [["status", ...fx.ws, "--all", "--colour"], /unknown flag "--colour" for "status"/],
    [["status", ...fx.ws, "--all", "--stage"], /--stage needs a value/],
    [["status", ...fx.ws, "--all", "--workspace=x"], /unknown flag "--workspace=x"/],
    [["status", ...fx.ws, "acme-api", "acme-api"], /component named twice: acme-api/],
    [["where", "extra"], /"where" takes at most 0 positional/],
    [["workspace-index", "list"], /"workspace-index" requires --index <file>/],
  ];
  for (const [args, message] of cases) {
    const r = runCli(assert, fx.h, args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.out}`);
    assert.equal(r.phase, "arguments");
    assert.match(r.stderr, message);
    assert.match(r.stderr, /^usage: node <plugin root>\/engine\/dist\/cli\.js <command>/m);
  }
  assert.deepEqual(fx.h.calls(), []);
});

// ---------------------------------------------------------------------------
// where

test("11/12: `where` prints the plugin root derived from the engine's own location", (t) => {
  const h = cliHarness(t);
  const r = runCli(assert, h, ["where"], { cwd: tempDir(t) });
  assert.equal(r.status, 0);
  const root = /^plugin-root: (.+)$/m.exec(r.stdout)[1];
  assert.ok(existsSync(join(root, ".claude-plugin", "plugin.json")), "the printed root holds .claude-plugin/plugin.json");
  assert.match(r.stdout, /^engine-root: .+\/engine$/m);
  assert.match(r.stdout, /^engine-version: 0\.1\.0$/m);
  const json = runCli(assert, h, ["where", "--json"]);
  assert.deepEqual(Object.keys(json.json), ["schemaVersion", "pluginRoot", "engineRoot", "engineVersion"]);
  assert.equal(json.json.pluginRoot, root);
});

// ---------------------------------------------------------------------------
// validate-config

function commandWorkspace(ws) {
  ws.adapters = { ...ws.adapters, command: { timeoutSeconds: 10, discoverArgv: ["acme-deploy", "list", "--all"] } };
}

test("12/28: validate-config validates every member and prints every configured command (argv, preflight, discover)", (t) => {
  const fx = commandFleet(t, { workspace: commandWorkspace });
  const component = JSON.parse(readFileSync(fx.apiComponent, "utf8"));
  component.stages["stage-1"].targets[0].preflightArgv = ["acme-deploy", "whoami", "--profile", "read only"];
  writeFileSync(fx.apiComponent, text(component));
  const r = runCli(assert, fx.h, ["validate-config", ...fx.ws]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /acme-api: available/);
  assert.match(r.stdout, /target-read\s+acme-api\/stage-1\/api: acme-deploy show stage-1 api/);
  assert.match(r.stdout, /target-preflight\s+acme-api\/stage-1\/api: acme-deploy whoami --profile "read only"/);
  assert.match(r.stdout, /discover\s+workspace: acme-deploy list --all/);
  assert.match(r.stdout, /the engine cannot verify they are read-only/);
  const json = runCli(assert, fx.h, ["validate-config", ...fx.ws, "--json"]);
  assert.equal(json.json.valid, true);
  assert.deepEqual(json.json.commands.map((c) => [c.role, c.where]), [
    ["target-read", "acme-api/stage-1/api"],
    ["target-preflight", "acme-api/stage-1/api"],
    ["target-read", "acme-api/stage-2/api"],
    ["target-read", "acme-api/stage-3/api"],
    ["target-read", "acme-worker/stage-1/worker"],
    ["discover", "workspace"],
  ]);
  assert.deepEqual(fx.h.calls(), [], "validate-config runs no command");
});

test("31c/12: validate-config reports unavailable members, 29 after the report for a non-canonical file, 24 for an invalid one", (t) => {
  const fx = commandFleet(t, { worker: null });
  const ok = runCli(assert, fx.h, ["validate-config", ...fx.ws]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.stdout, /acme-worker: unavailable \(no component config\)/);
  const component = JSON.parse(readFileSync(fx.apiComponent, "utf8"));
  writeFileSync(fx.apiComponent, JSON.stringify(component));
  const non = runCli(assert, fx.h, ["validate-config", ...fx.ws]);
  assert.equal(non.status, 29, non.out);
  assert.match(non.stdout, /non-canonical\s+.*acme-api\/\.release-radar\/component\.json/);
  assert.match(non.stderr, /non-canonical input \(run format first\)/);
  writeFileSync(fx.apiComponent, text({ ...component, stages: { ...component.stages, "stage-9": null } }));
  const bad = runCli(assert, fx.h, ["validate-config", ...fx.ws]);
  assert.equal(bad.status, 24, bad.out);
  assert.match(bad.stderr, /component\.json.*\(at \/stages\/stage-9\): "stage-9" is not a stage declared by/);
  assert.equal(bad.stdout, "");
});

test("76a/31c: equivalent repoSubdir spellings of one repoKey are the same location (24 at the later member)", (t) => {
  for (const spelling of ["./worker", "worker/", "./worker/"]) {
    const fx = buildFleet(t, { workspace: (ws) => void ws.members.splice(1, 0, { name: "acme-jobs", repoKey: "acme-worker", repoSubdir: spelling }) });
    const h = cliHarness(t);
    const r = runCli(assert, h, ["validate-config", "--workspace", fx.platform]);
    assert.equal(r.status, 24, `${spelling}: ${r.out}`);
    assert.match(r.stderr, /\(at \/members\/2\/repoSubdir\): repoKey "acme-worker" with repoSubdir "worker" is already used by \/members\/1/, spelling);
  }
});

// ---------------------------------------------------------------------------
// discover

test("12/74: discover lists App Service targets per stage raw (names intact), flags ambiguity, read-only", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, {
    [SUB.one]: [webapp("acme-api-weu-stage1-01"), webapp("zz-Odd_Name.v2")],
    [SUB.two]: [webapp("acme-api-stage2")],
    [SUB.three]: [webapp("acme-api-stage2", { rg: "rg-other" })],
  });
  const r = runCli(assert, fx.h, ["discover", ...fx.ws, "--adapter", "azure-appservice"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /\[stage-1\]\s+webapp=acme-api-weu-stage1-01\s+image=DOCKER\|registry\.example\.com\/acme\/api:3f2a9c1\s+state=Running/);
  assert.match(r.stdout, /webapp=zz-Odd_Name\.v2/, "an unrecognised name is printed exactly as listed");
  assert.equal((r.stdout.match(/\[stage-2\]\s+webapp=acme-api-stage2/g) ?? []).length, 2);
  assert.match(r.stdout, /ambiguous=true/);
  const json = runCli(assert, fx.h, ["discover", ...fx.ws, "--adapter", "azure-appservice", "--stage", "stage-1", "--json"]);
  assert.equal(json.json.canDiscover, true);
  assert.deepEqual(json.json.candidates.map((c) => c.fields.webapp), ["acme-api-weu-stage1-01", "zz-Odd_Name.v2"]);
  assertReadOnly(assert, fx.h.calls(), READ_ONLY.az);
});

test("12: discover through the command adapter's discoverArgv, and says so when there is none", (t) => {
  const fx = commandFleet(t, { workspace: commandWorkspace });
  fx.h.install("acme-deploy", [{ match: ["list", "--all"], stdout: "acme-api-stage1\n\n  acme-api-STAGE2 \n" }]);
  const r = runCli(assert, fx.h, ["discover", ...fx.ws, "--adapter", "command", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.candidates.map((c) => c.fields.candidate), ["acme-api-stage1", "acme-api-STAGE2"]);
  const none = commandFleet(t);
  const n = runCli(assert, none.h, ["discover", ...none.ws, "--adapter", "command"]);
  assert.equal(n.status, 0);
  assert.match(n.stdout, /cannot discover: the workspace declares no adapters\.command\.discoverArgv/);
});

test("14/20: discover validates the adapter and scope (64) before any call, and maps auth failures to 20", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, {}, { accountFails: true });
  const cases = [
    [["--adapter", "helm"], /unknown adapter "helm"/],
    [["--adapter", "azure-containerapp", "--subscription", SUB.one], /adapter "azure-containerapp" is not configured in the workspace/],
    [["--adapter", "kubernetes", "--context", "stage-1"], /requires --namespace <value>/],
    [["--adapter", "compose", "--stage", "stage-1"], /--stage does not apply to --adapter compose/],
    [["--adapter", "azure-appservice", "--stage", "stage-9"], /unknown stage "stage-9"/],
  ];
  for (const [args, message] of cases) {
    const r = runCli(assert, fx.h, ["discover", ...fx.ws, ...args]);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, message);
  }
  assert.deepEqual(fx.h.calls(), []);
  const auth = runCli(assert, fx.h, ["discover", ...fx.ws, "--adapter", "azure-appservice"]);
  assert.equal(auth.status, 20, auth.out);
  assert.match(auth.stderr, /az login/);
});

// ---------------------------------------------------------------------------
// workspace-index

test("31f/31g: workspace-index register / list / resolve / unregister through the CLI", (t) => {
  const fx = buildFleet(t);
  const h = cliHarness(t);
  const index = join(tempDir(t), "data", "workspace-index.json");
  const reg = runCli(assert, h, ["workspace-index", "register", fx.platform, "--index", index]);
  assert.equal(reg.status, 0, reg.out);
  assert.match(reg.stdout, /registered /);
  assert.equal(readFileSync(index, "utf8"), text({ schemaVersion: 1, workspaces: [{ path: fx.platform }] }), "the index is written canonically");
  const list = runCli(assert, h, ["workspace-index", "list", "--index", index, "--json"]);
  assert.deepEqual(list.json.entries, [{ path: fx.platform, status: "ok" }]);
  const resolved = runCli(assert, h, ["workspace-index", "resolve", join(fx.worker, "worker"), "--index", index, "--json"]);
  assert.equal(resolved.json.step, "c");
  assert.deepEqual(resolved.json.candidates, [{ root: fx.platform, step: "c", component: "acme-worker", registered: true }]);
  const none = runCli(assert, h, ["workspace-index", "resolve", tempDir(t), "--index", index]);
  assert.match(none.stdout, /no workspace matches/);
  writeFileSync(index, JSON.stringify({ schemaVersion: 1, workspaces: [{ path: fx.platform }] }));
  const refused = runCli(assert, h, ["workspace-index", "list", "--index", index]);
  assert.equal(refused.status, 29, "a non-canonical index is refused by read-only commands");
  const unreg = runCli(assert, h, ["workspace-index", "unregister", fx.platform, "--index", index]);
  assert.equal(unreg.status, 0, unreg.out);
  assert.equal(readFileSync(index, "utf8"), text({ schemaVersion: 1, workspaces: [] }));
  const bad = runCli(assert, h, ["workspace-index", "prune", "--index", index]);
  assert.equal(bad.status, 64);
  assert.match(bad.stderr, /unknown workspace-index action "prune"/);
});
