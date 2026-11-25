// `status` lifecycle behaviour end to end with the `command` adapter (spec requirements 18, 20,
// 31c, 47, 51-54, 76, 76a): deltas, within-stage consistency, cross-stage digests, the fleet
// table, --no-pipelines / --verify stubs, the canonical gate and exit precedence. `acme-deploy`
// is a logged shim; acme-api's clone has `c1 (v1.0.0) → c2 → c3 → c4 (HEAD)` plus `side: c2 → d1`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { commandFleet, installDeploy, ref, runCli, snapshotFiles } from "./fixtures/cli-harness.mjs";
import { digestOf } from "./fixtures/cli-shims.mjs";
import { text } from "./fixtures/workspace-fixtures.mjs";

const deltaOf = (json, pair) => json.components[0].deltas.find((d) => `${d.upstream}:${d.downstream}` === pair);

test("53: deltas equal, behind N (with the pending list) and unknown (with a reason)", (t) => {
  const fx = commandFleet(t);
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-2/api": ref("api", fx.short.c2), "stage-3/api": ref("api", "9.9.9"), "stage-1/worker": ref("worker", fx.short.w1) });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(deltaOf(r.json, "local:stage-1").verdict, "equal");
  const behind = deltaOf(r.json, "stage-1:stage-2");
  assert.equal(behind.verdict, "behind");
  assert.equal(behind.entries[0].count, 2);
  assert.deepEqual(behind.entries[0].pending.map((c) => c.sha), [fx.commits.c4, fx.commits.c3]);
  const unknown = deltaOf(r.json, "stage-2:stage-3");
  assert.equal(unknown.verdict, "unknown");
  assert.match(unknown.entries[0].reason, /stage-3: api tag-not-found: refs\/tags\/v9\.9\.9 is not in the local clone/);
  assert.equal(r.json.components[0].stages[2].targets[0].commit.status, "tag-not-found");
});

test("53: deltas ahead N and diverged (both ranges listed)", (t) => {
  const fx = commandFleet(t);
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.d1), "stage-2/api": ref("api", fx.short.c2), "stage-3/api": ref("api", "1.0.0") });
  const diverged = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(diverged.status, 0, diverged.out);
  const d = deltaOf(diverged.json, "local:stage-1");
  assert.equal(d.verdict, "diverged");
  assert.deepEqual(d.entries[0].pending.map((c) => c.sha), [fx.commits.c4, fx.commits.c3]);
  assert.deepEqual(d.entries[0].extra.map((c) => c.sha), [fx.commits.d1]);
  assert.equal(diverged.json.components[0].stages[0].targets[0].commit.headRelation.relation, "not-ancestor");
  assert.equal(deltaOf(diverged.json, "stage-1:stage-2").verdict, "behind", "stage-2 (c2) is an ancestor of stage-1 (d1)");
});

test("53: a downstream stage ahead of its upstream is `ahead N`", (t) => {
  const fx = commandFleet(t);
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c2), "stage-2/api": ref("api", fx.short.c4), "stage-3/api": ref("api", "1.0.0") });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  const ahead = deltaOf(r.json, "stage-1:stage-2");
  assert.equal(ahead.verdict, "ahead");
  assert.equal(ahead.entries[0].count, 2);
  assert.deepEqual(ahead.entries[0].extra.map((c) => c.sha), [fx.commits.c4, fx.commits.c3]);
  assert.equal(deltaOf(r.json, "stage-2:stage-3").verdict, "behind", "v1.0.0 resolves through the git-tag convention");
});

test("51/53: an inconsistent stage names every differing target and gets one delta per distinct commit, flagged", (t) => {
  const fx = commandFleet(t, { api: { "stage-1": ["api", "api-internal", "api-mobile"], "stage-2": ["api"], "stage-3": null } });
  installDeploy(fx.h, {
    "stage-1/api": ref("api", fx.short.c4),
    "stage-1/api-internal": ref("api", fx.short.c3),
    "stage-1/api-mobile": ref("api", fx.short.c4),
    "stage-2/api": ref("api", fx.short.c2),
  });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, "inconsistency is reported, not gated, without --fail-on-drift");
  const consistency = r.json.components[0].stages[0].consistency;
  assert.equal(consistency.status, "inconsistent");
  assert.equal(consistency.basis, "reference");
  assert.deepEqual(consistency.groups.map((g) => g.targets), [["api", "api-mobile"], ["api-internal"]]);
  assert.match(consistency.detail, /api, api-mobile \(.*\) vs api-internal \(/);
  const local = deltaOf(r.json, "local:stage-1");
  assert.equal(local.inconsistentStage, true);
  assert.deepEqual(local.inconsistentSides, ["downstream"]);
  assert.equal(local.verdict, null, "no single verdict for an inconsistent stage");
  assert.deepEqual(local.entries.map((e) => [e.downstreamTargets, e.verdict]), [[["api", "api-mobile"], "equal"], [["api-internal"], "behind"]]);
  const next = deltaOf(r.json, "stage-1:stage-2");
  assert.deepEqual(next.inconsistentSides, ["upstream"]);
  assert.deepEqual(next.entries.map((e) => [e.upstreamTargets, e.verdict, e.count]), [[["api", "api-mobile"], "behind", 2], [["api-internal"], "behind", 1]]);
  assert.deepEqual(r.json.drift.findings.map((f) => [f.kind, f.where]), [["within-stage", "stage-1"]]);
  const gated = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--fail-on-drift"]);
  assert.equal(gated.status, 22, "--fail-on-drift trips on within-stage inconsistency");
  assert.match(gated.stdout, /\[inconsistent stage: downstream — one delta per distinct commit, no single verdict\]/);
});

test("51/52: consistency by digest when every target has one; equal digests across stages prove the same build", (t) => {
  const fx = commandFleet(t, { api: { "stage-1": ["api", "api-internal"], "stage-2": ["api"], "stage-3": ["api"] } });
  const a = digestOf("a");
  installDeploy(fx.h, {
    "stage-1/api": `${ref("api", fx.short.c4)}@${a}`,
    "stage-1/api-internal": `${ref("api", "retagged")}@${a}`,
    "stage-2/api": `${ref("api", fx.short.c4)}@${a}`,
    "stage-3/api": `${ref("api", "1.0.0")}@${digestOf("b")}`,
  });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  const [s1] = r.json.components[0].stages;
  assert.equal(s1.consistency.status, "consistent", "different tags, same digest: consistent by digest");
  assert.equal(s1.consistency.basis, "digest");
  const [one, two] = r.json.components[0].crossStage;
  assert.equal(one.result, "same-build");
  assert.equal(one.proven, true);
  assert.equal(two.result, "different-build");
  const human = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.match(human.stdout, /stage-1 → stage-2: same build \(equal digests — proof\)/);
  assert.match(human.stdout, /stage-2 → stage-3: different builds \(digests differ — proof\)/);
});

test("51: the same tag with different digests is inconsistent by digest", (t) => {
  const fx = commandFleet(t, { api: { "stage-1": ["api", "api-internal"], "stage-2": null, "stage-3": null } });
  installDeploy(fx.h, { "stage-1/api": `${ref("api", fx.short.c4)}@${digestOf("a")}`, "stage-1/api-internal": `${ref("api", fx.short.c4)}@${digestOf("c")}` });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json", "--fail-on-drift"]);
  assert.equal(r.status, 22, r.out);
  assert.equal(r.json.components[0].stages[0].consistency.basis, "digest");
  assert.deepEqual(r.json.components[0].stages[0].consistency.groups.map((g) => g.targets), [["api"], ["api-internal"]]);
});

test("54/31c: --all prints the fleet table with unavailable members and their reasons (exit 0)", (t) => {
  const fx = commandFleet(t, { worker: null, workspace: (ws) => ws.members.splice(1, 0, { name: "acme-legacy", repoKey: "acme-legacy", repoSubdir: null }) });
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-2/api": ref("api", fx.short.c2), "stage-3/api": ref("api", "1.0.0") });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.unavailable.map((u) => [u.name, u.reason]), [["acme-legacy", "no-local-clone"], ["acme-worker", "no-component-config"]]);
  assert.deepEqual(r.json.fleet.map((row) => [row.component, row.status]), [["acme-api", "available"], ["acme-legacy", "unavailable"], ["acme-worker", "unavailable"]]);
  const api = r.json.fleet[0];
  assert.deepEqual(api.cells.map((c) => c.summary), [fx.short.c4, fx.short.c2, fx.short.c1]);
  assert.deepEqual(api.pending.map((p) => [p.pair, p.count]), [["local:stage-1", 0], ["stage-1:stage-2", 2], ["stage-2:stage-3", 1]]);
  assert.equal(api.latestPipelineResult, null);
  const human = runCli(assert, fx.h, ["status", ...fx.ws, "--all"]);
  assert.match(human.stdout, /^fleet$/m);
  assert.match(human.stdout, /acme-legacy\s+—\s+—\s+—\s+—\s+—\s+unavailable \(no local clone\)/);
  assert.match(human.stdout, /acme-worker\s+.*unavailable \(no component config\)/);
  assert.match(human.stdout, new RegExp(`acme-api\\s+${fx.short.c4}\\s+${fx.short.c2}\\s+${fx.short.c1}\\s+yes\\s+local:stage-1 0 · stage-1:stage-2 2 · stage-2:stage-3 1`));
});

test("31c: naming an unavailable member explicitly is fatal (24) before any source call", (t) => {
  const fx = commandFleet(t, { worker: null });
  installDeploy(fx.h, {});
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-worker"]);
  assert.equal(r.status, 24, r.out);
  assert.match(r.stderr, /requested member "acme-worker" is unavailable \(no component config\)/);
  assert.deepEqual(fx.h.calls(), []);
});

test("54: a missing target shows in the fleet attention column", (t) => {
  const fx = commandFleet(t);
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-2/api": null, "stage-3/api": ref("api", "1.0.0"), "stage-1/worker": ref("worker", fx.short.w1) });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  assert.equal(r.status, 23, r.out);
  assert.deepEqual(r.json.fleet[0].attention, ["stage-2/api: missing"]);
  assert.equal(r.json.fleet[0].cells[1].summary, "missing");
});

test("20: exit precedence — missing target + drift → 23 (full report, gate still recorded)", (t) => {
  const fx = commandFleet(t, { api: { "stage-1": ["api", "api-internal"], "stage-2": ["api"], "stage-3": null } });
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-1/api-internal": ref("api", fx.short.c3), "stage-2/api": null });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json", "--fail-on-drift", "local:stage-1"]);
  assert.equal(r.status, 23, r.out);
  assert.equal(r.phase, "missing");
  assert.equal(r.json.drift.tripped, true);
  assert.equal(r.json.missing.length, 1);
  assert.equal(r.json.outcome.exitCode, 23);
  assert.equal(snapshotFiles(fx.platform).length, 1, "exit 23 writes a snapshot");
});

test("20: exit precedence — 64 beats 29 (unknown name with a non-canonical workspace), 29 beats 20", (t) => {
  const fx = commandFleet(t);
  installDeploy(fx.h, {});
  const workspace = JSON.parse(readFileSync(fx.workspaceFile, "utf8"));
  writeFileSync(fx.workspaceFile, JSON.stringify(workspace));
  const bad = runCli(assert, fx.h, ["status", ...fx.ws, "acme-nope"]);
  assert.equal(bad.status, 64);
  const nonCanonical = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.equal(nonCanonical.status, 29, nonCanonical.out);
  assert.equal(nonCanonical.phase, "canonical");
  assert.match(nonCanonical.stderr, /non-canonical input \(run format first\): .*workspace\.json/);
  assert.deepEqual(fx.h.calls(), [], "29 is decided before any source call");
  assert.deepEqual(snapshotFiles(fx.platform), []);
});

test("18/20: a failing command preflight ends the whole run with 20 — no partial report, no snapshot", (t) => {
  const fx = commandFleet(t, { api: { "stage-1": ["api"], "stage-2": null, "stage-3": null } });
  const component = JSON.parse(readFileSync(fx.apiComponent, "utf8"));
  component.stages["stage-1"].targets[0].preflightArgv = ["acme-deploy", "whoami"];
  writeFileSync(fx.apiComponent, text(component));
  fx.h.install("acme-deploy", [
    { match: ["whoami"], stderr: "not signed in\n", exit: 1 },
    { match: ["show", "stage-1", "api"], stdout: { image: ref("api", fx.short.c4) } },
    { match: ["show", "stage-1", "worker"], stdout: { image: ref("worker", fx.short.w1) } },
  ]);
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "--all"]);
  assert.equal(r.status, 20, r.out);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /preflight `acme-deploy whoami` exited 1/);
  assert.deepEqual(fx.h.calls().map((c) => c.args), [["whoami"]], "nothing is read after a failed preflight");
  assert.deepEqual(snapshotFiles(fx.platform), []);
});

test("29/20: a source CLI missing from PATH exits 20 naming the binary, never 23", (t) => {
  const fx = commandFleet(t, { api: { "stage-1": ["api"], "stage-2": null, "stage-3": null } });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.equal(r.status, 20, r.out);
  assert.match(r.stderr, /acme-deploy/);
  assert.doesNotMatch(r.out, /MISSING/);
});

test("18/48: --no-pipelines is recorded; without it, a pipeline mapping needs the PAT (absent → 20 before any request)", (t) => {
  const fx = commandFleet(t, {
    api: { "stage-1": ["api"], "stage-2": null, "stage-3": null },
    workspace: (ws) => {
      ws.azureDevOps = {
        organizationUrl: "https://dev.azure.example/acme",
        project: "acme",
        requestTimeoutSeconds: 30,
        runHistoryCount: 5,
        followPollSeconds: 15,
        followTimeoutMinutes: 60,
        confirmTokenTtlMinutes: 10,
        patExpiryWarningDays: 14,
      };
    },
  });
  const component = JSON.parse(readFileSync(fx.apiComponent, "utf8"));
  component.stages["stage-1"].targets[0].pipeline = {
    provider: "azure-devops",
    pipelineId: 7,
    ref: "refs/heads/main",
    parameters: { action: "build" },
    actions: { build: { kind: "build", parameters: { action: "build" } } },
    primaryAction: "build",
    landedWaitMinutes: 15,
  };
  writeFileSync(fx.apiComponent, text(component));
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4) });
  const env = { ...fx.h.env };
  delete env.AZURE_DEVOPS_EXT_PAT;
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"], { env });
  assert.equal(r.status, 20, r.out);
  assert.equal(r.stdout, "", "no partial report");
  assert.match(r.stderr, /AZURE_DEVOPS_EXT_PAT is not set/);
  const omitted = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json", "--no-pipelines"], { env });
  assert.equal(omitted.status, 0, omitted.out);
  assert.equal(omitted.json.components[0].stages[0].targets[0].pipelineMapped, true);
  assert.equal(omitted.json.pipelines.status, "omitted");
  assert.equal(omitted.json.pipelines.detail, "pipelines omitted (--no-pipelines)");
});

test("44: without --verify the section is not-requested; with --verify and no block it says \"no real-world verification configured\" (exit 0, nothing invented)", (t) => {
  const fx = commandFleet(t, { api: { "stage-1": ["api"], "stage-2": null, "stage-3": null } });
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4) });
  const plain = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.deepEqual(plain.json.verification, {
    status: "not-requested",
    requested: false,
    detail: "not requested (pass --verify)",
    outcome: null,
    exitCode: null,
    summary: null,
    blocks: [],
    results: [],
  });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json", "--verify"]);
  assert.equal(r.status, 0);
  assert.equal(r.json.verification.status, "ran");
  assert.equal(r.json.verification.requested, true);
  assert.equal(r.json.verification.outcome, "NO-CHECKS");
  assert.equal(r.json.verification.exitCode, 0);
  assert.deepEqual(r.json.verification.results, []);
  assert.deepEqual(
    r.json.verification.blocks.map((block) => [block.stage, block.status, block.detail]),
    [
      ["stage-1", "not-configured", "no real-world verification configured"],
      ["stage-2", "not-deployed", "not deployed on this stage; no real-world verification configured"],
      ["stage-3", "not-deployed", "not deployed on this stage; no real-world verification configured"],
    ],
  );
  const human = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--verify"]);
  assert.match(human.stdout, /acme-api \/ stage-1: no real-world verification configured/);
});

test("47: --fail-on-drift pairs are validated (unknown stage, wrong order, not neighbours, outside --stage) with 64 before any call", (t) => {
  const fx = commandFleet(t);
  installDeploy(fx.h, {});
  const unknown = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--fail-on-drift", "stage-1:stage-9"]);
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /unknown stage "stage-9"/);
  const order = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--fail-on-drift", "stage-2:stage-1"]);
  assert.equal(order.status, 64);
  assert.match(order.stderr, /"stage-2" must come before "stage-1"/);
  const skip = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--fail-on-drift", "stage-1:stage-3"]);
  assert.equal(skip.status, 64, "a pair that skips a stage could never trip, so it is refused");
  assert.match(skip.stderr, /are not neighbouring stages \(local → stage-1 → stage-2 → stage-3\)/);
  const outside = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--stage", "stage-1", "--fail-on-drift", "stage-1:stage-2"]);
  assert.equal(outside.status, 64);
  assert.match(outside.stderr, /outside the selected --stage/);
  assert.deepEqual(fx.h.calls(), []);
});

test("76a: monorepo members report independently from their own component.json", (t) => {
  const fx = commandFleet(t, {
    workspace: (ws) => ws.members.splice(1, 0, { name: "acme-jobs", repoKey: "acme-worker", repoSubdir: "./jobs/" }),
  });
  mkdirSync(`${fx.worker}/jobs/.release-radar`, { recursive: true });
  writeFileSync(`${fx.worker}/jobs/.release-radar/component.json`, text({ schemaVersion: 1, name: "acme-jobs", stages: { "stage-1": { targets: [{ name: "jobs", adapter: "command", argv: ["acme-deploy", "show", "stage-1", "jobs"], extract: { type: "json-path", path: "$.image" } }] }, "stage-2": null, "stage-3": null } }));
  installDeploy(fx.h, { "stage-1/jobs": ref("jobs", fx.short.w1), "stage-1/worker": ref("worker", fx.short.w1) });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-jobs", "acme-worker", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.components.map((c) => [c.name, c.repoKey, c.componentFile.endsWith("/jobs/.release-radar/component.json") || c.componentFile.endsWith("/worker/.release-radar/component.json")]), [["acme-jobs", "acme-worker", true], ["acme-worker", "acme-worker", true]]);
  assert.equal(r.json.components[0].stages[0].targets[0].commit.status, "resolved");
});
