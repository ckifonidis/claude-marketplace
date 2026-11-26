// `pipeline-runs` and `pipeline-run [--follow]` (spec requirements 12-14, 16-17, 48, 66, 69, 71;
// plan D8; acceptance criteria 6, 7(a)). Azure DevOps is the local fake; every test that touches
// it asserts zero non-GET requests. Follow timeouts run in-process with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipelineRun } from "../dist/commands/pipeline-runs.js";
import { runCliAsync, snapshotFiles } from "./fixtures/cli-harness.mjs";
import { PAT, assertOnlyGets, build } from "./fixtures/fake-azure-devops.mjs";
import { pipelineFleet } from "./fixtures/pipeline-fixtures.mjs";

const C = "c".repeat(40);

function cli(fx, args, env = fx.env) {
  return runCliAsync(assert, fx.h, args, { env });
}

/** An in-process context whose sleep advances a fake clock. */
function fakeClock(env) {
  let clock = Date.parse("2026-11-25T10:00:00.000Z");
  const sleeps = [];
  return {
    sleeps,
    context: {
      env,
      stdout: { isTTY: false },
      now: () => new Date(clock),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// pipeline-runs

test("12/48: pipeline-runs lists the latest runHistoryCount runs of each mapped target (read-only, exit 0, no snapshot)", async (t) => {
  const builds = [106, 105, 104, 103, 102, 101, 100].map((id) => build({ id, commit: C, params: { action: "build", imageTag: `t${id}` } }));
  const fx = await pipelineFleet(t, { ado: { builds } });
  const r = await cli(fx, ["pipeline-runs", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.command, "pipeline-runs");
  assert.deepEqual(r.json.scope, { component: "acme-api", stage: null, target: null });
  assert.equal(r.json.targets.length, 1);
  assert.deepEqual(r.json.targets[0].runs.map((run) => run.id), [106, 105, 104, 103, 102], "runHistoryCount = 5");
  assert.deepEqual(r.json.targets[0].runs.map((run) => run.pushedTag.value), ["t106", "t105", "t104", "t103", "t102"]);
  assert.deepEqual(r.json.requests, { method: "GET", count: 2 });
  assert.equal(r.json.pat.declared, false);
  const human = await cli(fx, ["pipeline-runs", ...fx.ws, "acme-api", "--stage", "stage-1", "--target", "api"]);
  assert.equal(human.status, 0, human.out);
  assert.match(human.stdout, /release-radar pipeline-runs — acme-api \(read-only\)/);
  assert.match(human.stdout, /#106 succeeded · build \(build\) · main @ ccccccc · tag t106 \(parameter\)/);
  assert.deepEqual(snapshotFiles(fx.platform), [], "only status writes snapshots");
  assert.ok(!human.out.includes(PAT) && !r.out.includes(PAT));
  assertOnlyGets(assert, fx.ado);
});

test("research §3.5: continuation-token paging collects runs across pages, stopping at runHistoryCount", async (t) => {
  const builds = [107, 106, 105, 104, 103, 102, 101].map((id) => build({ id, commit: C }));
  const fx = await pipelineFleet(t, { ado: { builds, pageSize: 2 } });
  const r = await cli(fx, ["pipeline-runs", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.targets[0].runs.map((run) => run.id), [107, 106, 105, 104, 103]);
  const pages = fx.ado.hits("/build/builds");
  assert.deepEqual(pages.map((p) => p.query.continuationToken ?? null), [null, "2", "4"], "three pages, then stop: 5 runs held");
  assertOnlyGets(assert, fx.ado);
});

test("66/23: a pipeline declared by NAME is resolved through Pipelines List; absent → 23 with the report; ambiguous → 21", async (t) => {
  const named = await pipelineFleet(t, {
    mapping: (m) => {
      delete m.pipelineId;
      m.pipelineName = "acme-api-ci";
    },
    ado: { pipelines: [{ id: 100, name: "other" }, { id: 101, name: "acme-api-ci" }], builds: [build({ id: 105, commit: C })], pageSize: 1 },
  });
  const r = await cli(named, ["pipeline-runs", ...named.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual([r.json.targets[0].pipeline.id, r.json.targets[0].pipeline.name], [101, "acme-api-ci"]);
  assert.equal(named.ado.hits("/_apis/pipelines").length, 2, "Pipelines List paged to the end");
  named.ado.state.pipelines = [{ id: 100, name: "other" }];
  const missing = await cli(named, ["pipeline-runs", ...named.ws, "acme-api", "--json"]);
  assert.equal(missing.status, 23, missing.out);
  assert.equal(missing.json.targets[0].pipeline.status, "missing");
  assert.match(missing.json.missing[0].detail, /pipeline "acme-api-ci" does not exist in project "acme-project"/);
  named.ado.state.pipelines = [{ id: 101, name: "acme-api-ci", folder: "\\a" }, { id: 102, name: "acme-api-ci", folder: "\\b" }];
  const ambiguous = await cli(named, ["pipeline-runs", ...named.ws, "acme-api"]);
  assert.equal(ambiguous.status, 21, ambiguous.out);
  assert.match(ambiguous.stderr, /matches 2 pipelines .*declare "pipelineId"/);
  const both = await pipelineFleet(t, { mapping: (m) => void (m.pipelineName = "renamed-ci") });
  const mismatch = await cli(both, ["pipeline-runs", ...both.ws, "acme-api", "--json"]);
  assert.equal(mismatch.status, 23, "id and name must both match");
  assert.match(mismatch.json.missing[0].detail, /pipeline 101 is named "acme-api-ci"/);
  assertOnlyGets(assert, named.ado);
  assertOnlyGets(assert, both.ado);
});

test("14/26/16: names (64) and the mapping (26) are checked before the PAT (20), and none of them sends a request", async (t) => {
  const fx = await pipelineFleet(t);
  const cases = [
    [["pipeline-runs", ...fx.ws, "acme-nope"], 64, /unknown component "acme-nope"/],
    [["pipeline-runs", ...fx.ws, "acme-api", "--stage", "stage-9"], 64, /unknown stage "stage-9"/],
    [["pipeline-runs", ...fx.ws, "acme-api", "--target", "nope"], 64, /unknown target "nope" for acme-api in any stage \(targets: api\)/],
    [["pipeline-runs", ...fx.ws, "acme-worker"], 26, /no pipeline mapping for acme-worker/],
    [["pipeline-runs", ...fx.ws, "acme-api", "--stage", "stage-2"], 26, /no pipeline mapping/],
    [["pipeline-run", ...fx.ws, "acme-api", "12x"], 64, /run id must be a positive integer/],
    [["pipeline-run", ...fx.ws, "acme-api"], 64, /needs a component name and a run id/],
  ];
  for (const [args, code, message] of cases) {
    const r = await cli(fx, args);
    assert.equal(r.status, code, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, message);
  }
  const env = { ...fx.env };
  delete env.AZURE_DEVOPS_EXT_PAT;
  for (const args of [["pipeline-runs", ...fx.ws, "acme-api"], ["pipeline-run", ...fx.ws, "acme-api", "105"]]) {
    const r = await cli(fx, args, env);
    assert.equal(r.status, 20, r.out);
    assert.match(r.stderr, /AZURE_DEVOPS_EXT_PAT is not set/);
  }
  const expired = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "105"], { ...fx.env, AZURE_DEVOPS_PAT_EXPIRES: "2026-01-01T00:00:00Z" });
  assert.equal(expired.status, 20, expired.out);
  assert.equal(fx.ado.requests.length, 0, "zero requests in every case");
});

test("17: pipeline-runs maps an auth failure on the build list to 20 (never \"no runs\")", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [build({ id: 105, commit: C })] } });
  fx.ado.fail(/\/build\/builds$/, "203-html");
  const r = await cli(fx, ["pipeline-runs", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 20, r.out);
  assert.equal(r.stdout, "");
  assertOnlyGets(assert, fx.ado);
});

// ---------------------------------------------------------------------------
// pipeline-run

test("69/D8: pipeline-run of a finished run — succeeded → 0; failed, canceled, partiallySucceeded → 25 (the Build result of record)", async (t) => {
  const fx = await pipelineFleet(t, {
    ado: {
      builds: [
        build({ id: 108, commit: C, result: "succeeded", params: { action: "build", imageTag: "ccccccc" } }),
        build({ id: 107, commit: C, result: "failed" }),
        build({ id: 106, commit: C, result: "canceled" }),
        build({ id: 105, commit: C, result: "partiallySucceeded" }),
      ],
    },
  });
  const ok = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "108", "--json"]);
  assert.equal(ok.status, 0, ok.out);
  assert.equal(ok.phase, "complete");
  assert.deepEqual([ok.json.run.id, ok.json.run.result, ok.json.run.succeeded, ok.json.follow.outcome], [108, "succeeded", true, "terminal"]);
  assert.deepEqual([ok.json.scope.stage, ok.json.scope.target], ["stage-1", "api"], "the single mapped target is selected");
  for (const [id, result] of [[107, "failed"], [106, "canceled"], [105, "partiallySucceeded"]]) {
    const r = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", String(id), "--json"]);
    assert.equal(r.status, 25, `${result}: ${r.out}`);
    assert.equal(r.phase, "pipeline");
    assert.equal(r.json.run.result, result);
    assert.match(r.stderr, new RegExp(`run #${id} finished "${result}" — not "succeeded" \\(exit 25\\)`));
  }
  const human = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "108"]);
  assert.match(human.stdout, /pipeline 101 "acme-api-ci"/);
  assert.match(human.stdout, /#108 succeeded/);
  assertOnlyGets(assert, fx.ado);
});

test("23: pipeline-run of a run that does not exist, or of another pipeline's run → 23 with the report", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [build({ id: 205, definition: 202, commit: C })] } });
  const absent = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "999", "--json"]);
  assert.equal(absent.status, 23, absent.out);
  assert.equal(absent.json.run, null);
  assert.match(absent.stderr, /run 999 does not exist in project "acme-project"/);
  const other = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "205", "--json"]);
  assert.equal(other.status, 23, other.out);
  assert.match(other.stderr, /run 205 is not a run of pipeline 101 "acme-api-ci" \(it belongs to pipeline 202\)/);
  fx.ado.state.pipelines = [];
  const noPipeline = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "205", "--json"]);
  assert.equal(noPipeline.status, 23);
  assert.equal(noPipeline.json.pipeline.status, "missing");
  assertOnlyGets(assert, fx.ado);
});

test("69: pipeline-run of a running run without --follow → 0 (phase in-progress), one read, no polling", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [build({ id: 110, status: "inProgress", commit: C })] } });
  const r = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "110", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.phase, "in-progress");
  assert.deepEqual([r.json.follow.requested, r.json.follow.outcome, r.json.follow.polls], [false, "in-progress", 1]);
  assert.equal(fx.ado.hits("/build/builds/110").length, 1);
  assert.equal(fx.ado.hits("/build/builds/110/timeline").length, 1, "the timeline is read to report any wait");
  assertOnlyGets(assert, fx.ado);
});

test("69: pipeline-run --follow polls read-only every followPollSeconds until the run completes (succeeded → 0)", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [] } });
  fx.ado.sequence(111, [
    build({ id: 111, status: "notStarted", commit: C }),
    build({ id: 111, status: "inProgress", commit: C }),
    build({ id: 111, status: "completed", result: "succeeded", commit: C, params: { action: "build", imageTag: "ccccccc" } }),
  ]);
  const started = Date.now();
  const r = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "111", "--follow", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.phase, "complete");
  assert.deepEqual([r.json.follow.outcome, r.json.follow.polls, r.json.follow.pollSeconds], ["terminal", 3, 1]);
  assert.ok(Date.now() - started >= 1800, "two poll intervals of 1 s");
  assert.equal(r.json.run.pushedTag.value, "ccccccc");
  assertOnlyGets(assert, fx.ado);
});

test("69/D8: --follow to failed, canceled and partiallySucceeded → 25; a follow timeout is \"still running\" (exit 0, never 25)", async (t) => {
  for (const result of ["failed", "canceled", "partiallySucceeded"]) {
    const fx = await pipelineFleet(t, { ado: { builds: [] } });
    fx.ado.sequence(112, [build({ id: 112, status: "inProgress", commit: C }), build({ id: 112, status: "completed", result, commit: C })]);
    const { context, sleeps } = fakeClock(fx.env);
    const out = await runPipelineRun({ workspace: fx.platform, component: "acme-api", runId: 112, stage: null, target: null, follow: true, json: true }, context);
    assert.equal(out.exitCode, 25, result);
    assert.equal(JSON.parse(out.stdout).run.result, result);
    assert.deepEqual(sleeps, [1000], "one poll interval");
    assertOnlyGets(assert, fx.ado);
  }
  const fx = await pipelineFleet(t, { ado: { builds: [build({ id: 113, status: "inProgress", commit: C })] } });
  const { context, sleeps } = fakeClock(fx.env);
  const out = await runPipelineRun({ workspace: fx.platform, component: "acme-api", runId: 113, stage: null, target: null, follow: true, json: false }, context);
  assert.equal(out.exitCode, 0, "a timeout is not a failure");
  assert.equal(out.phase, "still-running");
  assert.match(out.stdout, /still running after 1 minute\(s\) \(\d+ poll\(s\)\) — not a failure/);
  assert.match(out.stderr.join("\n"), /still running after 1 minute\(s\) of following — this is not a failure/);
  assert.ok(sleeps.length >= 59 && sleeps.every((ms) => ms === 1000), "polled every followPollSeconds up to followTimeoutMinutes");
  assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) <= 60_000, "never past the timeout");
  assertOnlyGets(assert, fx.ado);
});

test("69/65: an approval wait is reported with the approvers' NAMES and following stops; nothing is approved", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [build({ id: 114, status: "inProgress", commit: C })] } });
  fx.ado.state.timelines.set(114, [
    { id: "stage-rec", parentId: null, type: "Stage", name: "Deploy", state: "pending", result: null },
    { id: "cp-1", parentId: "stage-rec", type: "Checkpoint", name: "Checkpoint", state: "inProgress", result: null },
    { id: "appr-1", parentId: "cp-1", type: "Checkpoint.Approval", name: "Checkpoint.Approval", state: "inProgress", result: null },
  ]);
  fx.ado.state.approvals = [
    { id: "appr-1", status: "pending", minRequiredApprovers: 1, steps: [{ status: "pending", assignedApprover: { displayName: "Release Approver A", uniqueName: "approver-a@example.com", id: "11111111-1111-1111-1111-111111111111" } }, { status: "pending", assignedApprover: { displayName: "Release Approver B", uniqueName: "approver-b@example.com" } }] },
    { id: "appr-other", status: "pending", steps: [{ assignedApprover: { displayName: "Someone Else" } }] },
  ];
  const r = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "114", "--follow", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.phase, "waiting");
  assert.deepEqual([r.json.follow.outcome, r.json.follow.polls], ["waiting", 1], "following stopped at the first wait");
  assert.equal(r.json.waits.length, 1);
  assert.deepEqual([r.json.waits[0].kind, r.json.waits[0].approvers, r.json.waits[0].minRequiredApprovers], ["approval", ["Release Approver A", "Release Approver B"], 1]);
  assert.doesNotMatch(r.out, /example\.com|Someone Else|11111111/, "names only, and only this run's approval");
  assert.equal(fx.ado.hits("/pipelines/approvals")[0].query.approvalIds, "appr-1");
  const human = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "114", "--follow"]);
  assert.match(human.stdout, /⏸ waiting for an approval — approvers: Release Approver A, Release Approver B \(at least 1 required\); release-radar never approves/);
  assertOnlyGets(assert, fx.ado);
});

test("69: a check wait names the check; an approval that cannot be linked is still reported as a wait", async (t) => {
  const fx = await pipelineFleet(t, { ado: { builds: [build({ id: 115, status: "inProgress", commit: C })] } });
  fx.ado.state.timelines.set(115, [
    { id: "chk-1", parentId: null, type: "Checkpoint.TaskCheck", name: "Business hours", state: "inProgress", result: null },
    { id: "appr-9", parentId: null, type: "Checkpoint.Approval", name: "Checkpoint.Approval", state: "pending", result: null },
  ]);
  const r = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "115", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.phase, "waiting");
  assert.deepEqual(r.json.waits.map((w) => [w.kind, w.name]), [["check", "Business hours"], ["approval", "Checkpoint.Approval"]]);
  assert.match(r.json.waits[0].detail, /waiting for the check "Business hours"/);
  assert.deepEqual(r.json.waits[1].approvers, []);
  assert.match(r.json.waits[1].detail, /could not be linked/);
  assertOnlyGets(assert, fx.ado);
});

test("pipeline-run with several mapped targets in scope → 64 naming them (before any request)", async (t) => {
  const fx = await pipelineFleet(t, {
    targets: ["api", "api-internal"],
    extra: (component) => {
      component.stages["stage-1"].targets[1].pipeline = { ...component.stages["stage-1"].targets[0].pipeline, pipelineId: 102 };
    },
  });
  const r = await cli(fx, ["pipeline-run", ...fx.ws, "acme-api", "105"]);
  assert.equal(r.status, 64, r.out);
  assert.match(r.stderr, /2 pipeline-mapped targets in scope \(stage-1\/api \(pipeline 101\), stage-1\/api-internal \(pipeline 102\)\); pick one with --stage and --target/);
  assert.equal(fx.ado.requests.length, 0);
  const picked = await cli(fx, ["pipeline-runs", ...fx.ws, "acme-api", "--target", "api-internal", "--json"]);
  assert.equal(picked.status, 23, "pipeline 102 does not exist in the fake");
  assert.deepEqual(picked.json.targets.map((entry) => entry.target), ["api-internal"]);
  assertOnlyGets(assert, fx.ado);
});
