// Pipelines in `status` (spec requirements 16-18, 46-50, 54, 71, 73, 76 "Pipelines"; acceptance
// criteria 6, 7(a), 10, 14, 17). Azure DevOps is a local fake REST server on 127.0.0.1; every
// test that touches it asserts the run issued zero non-GET requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SNAPSHOT_SCHEMA } from "../dist/snapshot.js";
import { classify } from "../dist/format.js";
import { ref, runCliAsync, snapshotFiles, snapshotText } from "./fixtures/cli-harness.mjs";
import { PAT, assertOnlyGets, build } from "./fixtures/fake-azure-devops.mjs";
import { pipelineFleet } from "./fixtures/pipeline-fixtures.mjs";

const isoIn = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

/** Runs a succeeded build run of `commit` with the build action. */
function buildRun(id, commit, { result = "succeeded", status = "completed", tag = commit.slice(0, 7) } = {}) {
  return build({ id, commit, status, result, params: { action: "build", imageTag: tag } });
}

function configRun(id, commit) {
  return build({ id, commit, params: { action: "configure", imageTag: commit.slice(0, 7) } });
}

async function status(fx, args, env = fx.env) {
  return runCliAsync(assert, fx.h, ["status", ...fx.ws, ...args], { env });
}

// ---------------------------------------------------------------------------
// PAT preflight (16, 18)

test("16/18: PAT absent → exit 20 before ANY request, no partial report, no snapshot", async (t) => {
  const fx = await pipelineFleet(t);
  const env = { ...fx.env };
  delete env.AZURE_DEVOPS_EXT_PAT;
  const r = await status(fx, ["acme-api", "--json"], env);
  assert.equal(r.status, 20, r.out);
  assert.equal(r.phase, "preflight");
  assert.equal(r.stdout, "", "no partial report");
  assert.match(r.stderr, /AZURE_DEVOPS_EXT_PAT is not set/);
  assert.match(r.stderr, /--no-pipelines/);
  assert.equal(fx.ado.requests.length, 0, "zero requests");
  assert.deepEqual(snapshotFiles(fx.platform), []);
});

test("16: an empty or whitespace PAT → exit 20 with zero requests", async (t) => {
  const fx = await pipelineFleet(t);
  for (const value of ["", "   "]) {
    const r = await status(fx, ["acme-api"], { ...fx.env, AZURE_DEVOPS_EXT_PAT: value });
    assert.equal(r.status, 20, r.out);
    assert.match(r.stderr, /AZURE_DEVOPS_EXT_PAT is empty/);
  }
  assert.equal(fx.ado.requests.length, 0);
});

test("16: AZURE_DEVOPS_PAT_EXPIRES in the past → 20 with zero requests; unparseable → 20 with zero requests", async (t) => {
  const fx = await pipelineFleet(t);
  const expired = await status(fx, ["acme-api"], { ...fx.env, AZURE_DEVOPS_PAT_EXPIRES: "2020-01-01" });
  assert.equal(expired.status, 20, expired.out);
  assert.match(expired.stderr, /PAT expired on 2020-01-01T00:00:00\.000Z/);
  const garbage = await status(fx, ["acme-api"], { ...fx.env, AZURE_DEVOPS_PAT_EXPIRES: "next tuesday" });
  assert.equal(garbage.status, 20, garbage.out);
  assert.match(garbage.stderr, /not an ISO-8601 date/);
  assert.doesNotMatch(garbage.stderr, /next tuesday/, "the value is not echoed");
  assert.equal(fx.ado.requests.length, 0, "zero requests");
  assert.deepEqual(snapshotFiles(fx.platform), []);
});

test("16: PAT expiry inside patExpiryWarningDays → days remaining + warning (exit 0); outside → no warning", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [] } });
  const soon = await status(fx, ["acme-api", "--json"], { ...fx.env, AZURE_DEVOPS_PAT_EXPIRES: isoIn(5.5) });
  assert.equal(soon.status, 0, soon.out);
  assert.equal(soon.json.pipelines.pat.declared, true);
  assert.equal(soon.json.pipelines.pat.daysRemaining, 5);
  assert.equal(soon.json.pipelines.pat.warning, true);
  assert.match(soon.stderr, /warning — PAT expires .* 5 day\(s\) remaining, within the 14-day warning window/);
  const later = await status(fx, ["acme-api", "--json"], { ...fx.env, AZURE_DEVOPS_PAT_EXPIRES: isoIn(40.5) });
  assert.equal(later.json.pipelines.pat.daysRemaining, 40);
  assert.equal(later.json.pipelines.pat.warning, false);
  assert.doesNotMatch(later.stderr, /warning/);
  const undeclared = await status(fx, ["acme-api", "--json"]);
  assert.deepEqual([undeclared.json.pipelines.pat.declared, undeclared.json.pipelines.pat.daysRemaining], [false, null]);
  const human = await status(fx, ["acme-api"], { ...fx.env, AZURE_DEVOPS_PAT_EXPIRES: isoIn(5.5) });
  assert.match(human.stdout, /⚠ PAT expires .* renew it soon/);
  assertOnlyGets(assert, fx.ado);
});

test("17/18: 401, 403, 203 HTML, 200 HTML, 302 to login and 404 HTML → exit 20, never \"no runs\"/23, no report, no snapshot", async (t) => {
  for (const mode of ["401", "403", "203-html", "200-html", "302", "404-html"]) {
    const fx = await pipelineFleet(t, { ado: { builds: [buildRun(105, "0".repeat(40))] } });
    fx.ado.fail(/\/_apis\/pipelines\/101$/, mode);
    const r = await status(fx, ["acme-api", "--json"]);
    assert.equal(r.status, 20, `${mode}: ${r.out}`);
    assert.equal(r.stdout, "", `${mode}: no partial report`);
    assert.match(r.stderr, /Azure DevOps preflight failed — an authentication problem, NOT "no runs"/);
    assert.doesNotMatch(r.out, /does not exist|MISSING|^ *no runs$/m);
    assert.deepEqual(snapshotFiles(fx.platform), [], mode);
    assert.equal(fx.ado.hits("/login").length, 0, `${mode}: the redirect is never followed`);
    assertOnlyGets(assert, fx.ado);
  }
});

test("17: a wrong PAT (the fake answers its 203 sign-in page) → exit 20", async (t) => {
  const fx = await pipelineFleet(t);
  const r = await status(fx, ["acme-api"], { ...fx.env, AZURE_DEVOPS_EXT_PAT: "rr-wrong-synthetic-token" });
  assert.equal(r.status, 20, r.out);
  assert.match(r.stderr, /HTTP 203/);
  assert.equal(fx.ado.requests.length, 1);
  assert.equal(fx.ado.requests[0].authOk, false);
});

test("29/21: 500, a timeout and an invalid JSON body → exit 21 with no report; 429 + Retry-After is retried once", async (t) => {
  for (const [mode, pattern, why] of [
    ["500", /\/pipelines\/101$/, /HTTP 500/],
    ["slow", /\/pipelines\/101$/, /no answer within 1s \(timeout\)/],
    ["invalid-json", /\/build\/builds$/, /not valid JSON \(never read as "no runs"\)/],
  ]) {
    const fx = await pipelineFleet(t, { ado: { builds: [buildRun(105, "0".repeat(40))] } });
    fx.ado.fail(pattern, mode);
    const r = await status(fx, ["acme-api", "--json"]);
    assert.equal(r.status, 21, `${mode}: ${r.out}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, why);
    assert.deepEqual(snapshotFiles(fx.platform), []);
    assertOnlyGets(assert, fx.ado);
  }
  const fx = await pipelineFleet(t, { ado: { builds: [buildRun(105, "0".repeat(40))] } });
  fx.ado.fail(/\/pipelines\/101$/, "429", { times: 1, retryAfter: 1 });
  const started = Date.now();
  const ok = await status(fx, ["acme-api", "--json"]);
  assert.equal(ok.status, 0, ok.out);
  assert.ok(Date.now() - started >= 900, "Retry-After was honoured");
  assert.equal(fx.ado.hits("/pipelines/101").length, 2, "exactly one retry");
  const blocked = await pipelineFleet(t);
  blocked.ado.fail(/\/pipelines\/101$/, "429", { retryAfter: 0 });
  const r = await status(blocked, ["acme-api"]);
  assert.equal(r.status, 21, r.out);
  assert.match(r.stderr, /rate-blocked .*TF400733.* after one retry/);
  assert.equal(blocked.ado.hits("/pipelines/101").length, 2, "a read gets at most one retry");
});

test("23: a declared pipeline that does not exist (404 JSON) → exit 23 WITH the full report and a snapshot", async (t) => {
  const fx = await pipelineFleet(t, { ado: { pipelines: [] } });
  const r = await status(fx, ["acme-api", "--json"]);
  assert.equal(r.status, 23, r.out);
  assert.equal(r.phase, "missing");
  assert.equal(r.json.pipelines.status, "read");
  assert.deepEqual(r.json.pipelines.missing.map((m) => [m.stage, m.target, m.pipeline]), [["stage-1", "api", "pipeline 101"]]);
  assert.equal(r.json.pipelines.runs[0].pipeline.status, "missing");
  assert.equal(r.json.pipelines.drift[0].status, "pipeline-missing");
  assert.equal(r.json.components[0].stages[0].targets[0].status, "found", "the rest of the report is complete");
  assert.equal(snapshotFiles(fx.platform).length, 1);
  assert.match(r.stderr, /name a pipeline that does not exist \(exit 23/);
  assert.equal(fx.ado.hits("/build/builds").length, 0, "no build list for a missing pipeline");
  assertOnlyGets(assert, fx.ado);
});

// ---------------------------------------------------------------------------
// Run facts and pushed tags (48)

test("48: run facts — id, state/result, times, ref + commit, action, pushed tag from the parameter / undetermined, link", async (t) => {
  let fx;
  fx = await pipelineFleet(t, {
    ado: {
      builds: [
        build({ id: 106, status: "inProgress", commit: "a".repeat(40), params: { action: "build", imageTag: "aaaaaaa" } }),
        build({ id: 105, commit: "b".repeat(40), params: { action: "build", imageTag: "bbbbbbb", secretish: "not-declared" } }),
        build({ id: 104, commit: "c".repeat(40) }),
        build({ id: 103, commit: "not-a-commit", params: { action: "configure", imageTag: "x" } }),
        build({ id: 102, commit: "d".repeat(40), result: "partiallySucceeded", params: { action: "unknown-action" } }),
      ],
    },
  });
  const r = await status(fx, ["acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  const entry = r.json.pipelines.runs[0];
  assert.deepEqual([entry.component, entry.stage, entry.target, entry.runHistoryCount], ["acme-api", "stage-1", "api", 5]);
  assert.deepEqual([entry.pipeline.id, entry.pipeline.name, entry.pipeline.status, entry.pipeline.project], [101, "acme-api-ci", "found", "acme-project"]);
  const [r106, r105, r104, r103, r102] = entry.runs;
  assert.deepEqual(entry.runs.map((run) => run.id), [106, 105, 104, 103, 102], "newest first");
  assert.deepEqual([r106.status, r106.result, r106.terminal, r106.succeeded], ["inProgress", null, false, false]);
  assert.deepEqual([r105.status, r105.result, r105.terminal, r105.succeeded], ["completed", "succeeded", true, true]);
  assert.equal(r105.queueTime, "2026-11-20T11:45:00.000Z");
  assert.equal(r105.startTime, "2026-11-20T11:45:05.000Z");
  assert.equal(r105.finishTime, "2026-11-20T11:45:50.000Z");
  assert.equal(r105.sourceRef, "refs/heads/main");
  assert.deepEqual(r105.sourceCommit, { status: "determined", sha: "b".repeat(40), shortSha: "bbbbbbb" });
  assert.deepEqual([r105.action.status, r105.action.name, r105.action.kind], ["determined", "build", "build"]);
  assert.deepEqual(r105.pushedTag, { status: "parameter", value: "bbbbbbb", detail: "templateParameters.imageTag" });
  assert.deepEqual(r105.parameters, { action: "build", imageTag: "bbbbbbb" }, "declared parameter names only");
  assert.equal(r105.link, "https://dev.azure.example/acme-org/acme-project/_build/results?buildId=105");
  assert.equal(r104.action.status, "undetermined", "a CI-triggered run carries no templateParameters");
  assert.match(r104.action.detail, /no templateParameters/);
  assert.equal(r104.pushedTag.status, "undetermined");
  assert.equal(r104.pushedTag.value, null, "never guessed");
  assert.equal(r104.parameters, null);
  assert.equal(r103.sourceCommit.status, "undetermined", "sourceVersion must be 40/64 hex");
  assert.deepEqual([r103.action.name, r103.action.kind, r103.pushedTag.status], ["configure", "configuration", "not-applicable"]);
  assert.deepEqual([r102.result, r102.succeeded, r102.action.status], ["partiallySucceeded", false, "undetermined"]);
  const human = await status(fx, ["acme-api"]);
  assert.match(human.stdout, /acme-api \/ stage-1 \/ api → pipeline 101 "acme-api-ci"/);
  assert.match(human.stdout, /#105 succeeded · build \(build\) · main @ bbbbbbb · tag bbbbbbb \(parameter\)/);
  assert.match(human.stdout, /#104 succeeded · action undetermined · main @ ccccccc · tag undetermined/);
  assert.match(human.stdout, /#106 in progress/);
  assert.match(human.stdout, /Azure DevOps request\(s\), all GET/);
  const builds = fx.ado.hits("/build/builds")[0];
  assert.deepEqual([builds.query.definitions, builds.query.$top, builds.query.queryOrder, builds.query["api-version"]], ["101", "5", "queueTimeDescending", "7.1"]);
  assert.equal(builds.accept, "application/json;api-version=7.1");
  assert.equal(builds.fedAuth, "Suppress");
  assertOnlyGets(assert, fx.ado);
});

test("48/D10: pushed tag from pushedTagTemplate (the convention the pipeline follows); neither key → undetermined", async (t) => {
  const convention = await pipelineFleet(t, {
    mapping: (m) => {
      delete m.imageTagParameter;
      m.pushedTagTemplate = "{component}-{commit.shortSha}";
    },
    ado: { builds: [build({ id: 105, commit: "e".repeat(40) }), build({ id: 104, commit: "bad" })] },
  });
  const r = await status(convention, ["acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  const [first, second] = r.json.pipelines.runs[0].runs;
  assert.deepEqual([first.pushedTag.status, first.pushedTag.value], ["convention", "acme-api-eeeeeee"]);
  assert.deepEqual([second.pushedTag.status, second.pushedTag.value], ["undetermined", null], "the template needs a determined commit");
  const neither = await pipelineFleet(t, { mapping: (m) => void delete m.imageTagParameter, ado: { builds: [build({ id: 105, commit: "e".repeat(40), params: { action: "build", imageTag: "eeeeeee" } })] } });
  const n = await status(neither, ["acme-api", "--json"]);
  assert.equal(n.json.pipelines.runs[0].runs[0].pushedTag.status, "undetermined", "a parameter value is not the pushed tag unless the mapping says so");
  assert.match(n.json.pipelines.runs[0].runs[0].pushedTag.detail, /neither imageTagParameter nor pushedTagTemplate/);
  assertOnlyGets(assert, convention.ado);
  assertOnlyGets(assert, neither.ado);
});

// ---------------------------------------------------------------------------
// Pipeline/target drift (47, 49) and the drift gate

test("49: the latest succeeded build-kind run built X, the target runs Y → drift (by ancestry: not landed); gate 22", async (t) => {
  let fx;
  fx = await pipelineFleet(t, { ado: { builds: [] } });
  fx.ado.state.builds.push(buildRun(105, fx.commits.c4));
  const r = await status(fx, ["acme-api", "--json"]);
  assert.equal(r.status, 0, "without --fail-on-drift the finding is informational");
  const drift = r.json.pipelines.drift[0];
  assert.deepEqual([drift.status, drift.relation, drift.count, drift.build.runId, drift.build.commit, drift.targetCommit], ["drift", "behind", 1, 105, fx.commits.c4, fx.commits.c3]);
  assert.match(drift.detail, new RegExp(`run #105 built ${fx.short.c4}, but the target runs ${fx.short.c3} — the build is newer: the target is 1 commit\\(s\\) behind it \\(not landed\\)`));
  const finding = r.json.drift.findings.find((f) => f.kind === "pipeline-target");
  assert.deepEqual([finding.component, finding.where], ["acme-api", "stage-1/api"]);
  const gated = await status(fx, ["acme-api", "--json", "--fail-on-drift"]);
  assert.equal(gated.status, 22, gated.out);
  assert.equal(gated.json.drift.tripped, true);
  assert.equal(snapshotFiles(fx.platform).length, 2, "22 still writes a snapshot");
  const human = await status(fx, ["acme-api"]);
  assert.match(human.stdout, /pipeline\/target drift acme-api stage-1\/api/);
  assertOnlyGets(assert, fx.ado);
});

test("49: the target runs a NEWER commit than the latest succeeded build → drift (target ahead); a diverged pair is drift too", async (t) => {
  const ahead = await pipelineFleet(t, { ado: { builds: [] }, images: (fx) => ({ "stage-1/api": ref("api", fx.short.c4) }) });
  ahead.ado.state.builds.push(buildRun(105, ahead.commits.c2));
  const r = await status(ahead, ["acme-api", "--json", "--fail-on-drift"]);
  assert.equal(r.status, 22, r.out);
  assert.deepEqual([r.json.pipelines.drift[0].relation, r.json.pipelines.drift[0].count], ["ahead", 2]);
  const diverged = await pipelineFleet(t, { ado: { builds: [] } });
  diverged.ado.state.builds.push(buildRun(105, diverged.commits.d1));
  const d = await status(diverged, ["acme-api", "--json"]);
  assert.equal(d.json.pipelines.drift[0].relation, "diverged");
  const unknown = await pipelineFleet(t, { ado: { builds: [buildRun(105, "f".repeat(40))] } });
  const u = await status(unknown, ["acme-api", "--json", "--fail-on-drift"]);
  assert.equal(u.status, 22, "X ≠ Y is drift even when the clone cannot say which is newer");
  assert.equal(u.json.pipelines.drift[0].relation, "unknown");
  assert.match(u.json.pipelines.drift[0].detail, /not in the local clone/);
  for (const fx of [ahead, diverged, unknown]) assertOnlyGets(assert, fx.ado);
});

test("49: an in-progress run is not drift; a configuration-kind run never counts; in sync → gate stays 0", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [] } });
  fx.ado.state.builds.push(
    build({ id: 107, status: "inProgress", commit: fx.commits.c4, params: { action: "build", imageTag: fx.short.c4 } }),
    configRun(106, fx.commits.c4),
    buildRun(105, fx.commits.c3),
  );
  const r = await status(fx, ["acme-api", "--json", "--fail-on-drift"]);
  assert.equal(r.status, 0, r.out);
  const drift = r.json.pipelines.drift[0];
  assert.deepEqual([drift.status, drift.build.runId], ["in-sync", 105]);
  assert.match(drift.detail, /1 in-progress run\(s\) are not drift; 1 configuration-kind run\(s\) never count/);
  assert.equal(r.json.drift.findings.length, 0);
  const only = await pipelineFleet(t, { ado: { builds: [] } });
  only.ado.state.builds.push(build({ id: 107, status: "inProgress", commit: only.commits.c4, params: { action: "build", imageTag: "x" } }), configRun(106, only.commits.c4));
  const o = await status(only, ["acme-api", "--json", "--fail-on-drift"]);
  assert.equal(o.status, 0, o.out);
  assert.equal(o.json.pipelines.drift[0].status, "no-succeeded-build");
  const failed = await pipelineFleet(t, { ado: { builds: [] } });
  failed.ado.state.builds.push(buildRun(106, failed.commits.c4, { result: "failed" }), buildRun(105, failed.commits.c3, { result: "partiallySucceeded" }));
  const f = await status(failed, ["acme-api", "--json", "--fail-on-drift"]);
  assert.equal(f.status, 0, "failed / partiallySucceeded runs are never \"the latest succeeded build\"");
  assert.equal(f.json.pipelines.drift[0].status, "no-succeeded-build");
  for (const entry of [fx, only, failed]) assertOnlyGets(assert, entry.ado);
});

test("47: drift gate variants — pipeline drift and within-stage inconsistency both trip it; only named pairs gate cross-stage deltas", async (t) => {
  const fx = await pipelineFleet(t, {
    targets: ["api", "api-internal"],
    ado: { builds: [] },
    images: (f) => ({ "stage-1/api": ref("api", f.short.c3), "stage-1/api-internal": ref("api", f.short.c4) }),
  });
  fx.ado.state.builds.push(buildRun(105, fx.commits.c3));
  const r = await status(fx, ["acme-api", "--json", "--fail-on-drift"]);
  assert.equal(r.status, 22, r.out);
  assert.deepEqual(r.json.drift.findings.map((f) => f.kind), ["within-stage"], "the mapped target is in sync; the inconsistency alone trips");
  fx.ado.state.builds.unshift(buildRun(106, fx.commits.c4));
  const both = await status(fx, ["acme-api", "--json", "--fail-on-drift", "local:stage-1"]);
  assert.equal(both.status, 22);
  assert.deepEqual(both.json.drift.findings.map((f) => f.kind).sort(), ["cross-stage-delta", "pipeline-target", "within-stage"]);
  const omitted = await status(fx, ["acme-api", "--json", "--fail-on-drift", "--no-pipelines"]);
  assert.deepEqual(omitted.json.drift.findings.map((f) => f.kind), ["within-stage"], "--no-pipelines computes no pipeline drift");
  assertOnlyGets(assert, fx.ado);
});

// ---------------------------------------------------------------------------
// --no-pipelines, fleet, secrets, snapshots

test("18/48: --no-pipelines omits the section, needs no PAT and sends no request", async (t) => {
  const fx = await pipelineFleet(t);
  const env = { ...fx.env };
  delete env.AZURE_DEVOPS_EXT_PAT;
  const r = await status(fx, ["acme-api", "--json", "--no-pipelines"], env);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.pipelines, { status: "omitted", detail: "pipelines omitted (--no-pipelines)", pat: null, runs: [], drift: [], missing: [], requests: { method: "GET", count: 0 } });
  const human = await status(fx, ["acme-api", "--no-pipelines"], env);
  assert.match(human.stdout, /pipelines: pipelines omitted \(--no-pipelines\)/);
  assert.equal(fx.ado.requests.length, 0);
});

test("16: no pipeline mapping in scope → not-configured, the PAT is never read and nothing is requested", async (t) => {
  const fx = await pipelineFleet(t);
  const env = { ...fx.env };
  delete env.AZURE_DEVOPS_EXT_PAT;
  const r = await status(fx, ["acme-worker", "--json"], env);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.pipelines.status, "not-configured");
  assert.equal(fx.ado.requests.length, 0);
});

test("54: the fleet table carries the latest pipeline result and pipeline/target drift", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [] } });
  fx.ado.state.builds.push(buildRun(105, fx.commits.c4));
  const r = await status(fx, ["--all", "--json"]);
  assert.equal(r.status, 0, r.out);
  const api = r.json.fleet.find((row) => row.component === "acme-api");
  const worker = r.json.fleet.find((row) => row.component === "acme-worker");
  assert.equal(api.latestPipelineResult, "stage-1/api #105 succeeded");
  assert.equal(api.pipelineDrift, "stage-1/api: not landed (behind 1)");
  assert.deepEqual([worker.latestPipelineResult, worker.pipelineDrift], [null, null], "no mapping → no pipeline cells");
  const human = await status(fx, ["--all"]);
  assert.match(human.stdout, /pipeline\s+pipeline drift/);
  assert.match(human.stdout, /stage-1\/api #105 succeeded\s+stage-1\/api: not landed \(behind 1\)/);
  assertOnlyGets(assert, fx.ado);
});

test("73: the PAT never appears in stdout, stderr or the snapshot (human, --json, failures)", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [] } });
  fx.ado.state.builds.push(buildRun(105, fx.commits.c4));
  const basic = Buffer.from(`:${PAT}`).toString("base64");
  const runs = [await status(fx, ["acme-api", "--json"]), await status(fx, ["acme-api"]), await status(fx, ["--all"])];
  fx.ado.fail(/\/pipelines\/101$/, "401");
  runs.push(await status(fx, ["acme-api"]));
  for (const r of runs) {
    assert.ok(!r.out.includes(PAT), "PAT not in output");
    assert.ok(!r.out.includes(basic), "Basic credential not in output");
  }
  const names = snapshotFiles(fx.platform);
  assert.equal(names.length, 3);
  for (const name of names) {
    const raw = snapshotText(fx.platform, name);
    assert.ok(!raw.includes(PAT) && !raw.includes(basic), "PAT not in the snapshot");
  }
  assert.ok(fx.ado.requests.every((request) => request.auth && request.authOk), "the PAT did travel, in the Authorization header only");
  assertOnlyGets(assert, fx.ado);
});

test("50/86: a snapshot holding pipeline facts classifies canonical and carries runs, drift and the PAT expiry", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [] } });
  fx.ado.state.builds.push(buildRun(105, fx.commits.c4), configRun(104, fx.commits.c3));
  const r = await status(fx, ["acme-api", "--json"], { ...fx.env, AZURE_DEVOPS_PAT_EXPIRES: isoIn(30.5) });
  assert.equal(r.status, 0, r.out);
  const [name] = snapshotFiles(fx.platform);
  const raw = snapshotText(fx.platform, name);
  assert.equal(classify(raw, SNAPSHOT_SCHEMA, name).state, "canonical");
  const snapshot = JSON.parse(raw);
  assert.deepEqual(snapshot.report.pipelines.runs[0].runs.map((run) => run.id), [105, 104]);
  assert.equal(snapshot.report.pipelines.drift[0].status, "drift");
  assert.equal(snapshot.report.pipelines.pat.daysRemaining, 30);
  assert.deepEqual(snapshot.report.pipelines.requests, { count: 2, method: "GET" });
  assertOnlyGets(assert, fx.ado);
});
