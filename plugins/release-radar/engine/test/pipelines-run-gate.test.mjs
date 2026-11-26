// The run gate: `pipeline-preview`, the confirmation token and `run-pipeline` — the engine's ONE
// remote mutation (spec requirements 14, 20, 59-62, 66-70, 72, 73, 76 "Run gate"; Assumption 13;
// plan D2, D7-D9, D12; acceptance criteria 6, 7(a)-(f), 12).
//
// Azure DevOps is ONLY the local fake (`fixtures/fake-azure-devops.mjs`, 127.0.0.1); it counts
// requests by method and records every POST body. No real organisation is contacted and no real
// pipeline is queued. Every name is synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_SCHEMA } from "../dist/config.js";
import { canonicalize, render } from "../dist/format.js";
import { runPipelinePreview } from "../dist/commands/pipeline-preview.js";
import { runRunPipeline } from "../dist/commands/run-pipeline.js";
import { AzureDevOpsReader } from "../dist/pipelines/azure-devops-read.js";
import { PatCredential } from "../dist/pipelines/pat.js";
import { TOKEN_PREFIX, bindingDigest, decodeToken, issueToken, verifyToken } from "../dist/pipelines/preview.js";
import { runCliAsync } from "./fixtures/cli-harness.mjs";
import { PAT, PROJECT, assertOnlyGets, build, startAzureDevOps } from "./fixtures/fake-azure-devops.mjs";
import { apiMapping, pipelineFleet, writeComponent } from "./fixtures/pipeline-fixtures.mjs";
import { commandTarget } from "./fixtures/cli-harness.mjs";
import { commitAll, git, put } from "./fixtures/workspace-fixtures.mjs";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const STAGE = ["--stage", "stage-1"];

function cli(fx, args, env = fx.env) {
  return runCliAsync(assert, fx.h, args, { env });
}

function noPat(...runs) {
  for (const r of runs) assert.ok(!r.out.includes(PAT), "the PAT never appears in any output");
}

function posts(fx) {
  return fx.ado.posts();
}

/**
 * The pipeline fleet with the acme-api mapping on stage-1/api COMMITTED (so the component.json at
 * the remote head carries the same mapping) and the fake's `refs/heads/main` at that commit.
 */
async function runFleet(t, { mapping, extra, ado, settings, repository = "acme-api" } = {}) {
  const fx = await pipelineFleet(t, {
    mapping: (m) => {
      if (repository !== null) m.repository = repository;
      return typeof mapping === "function" ? (mapping(m) ?? m) : m;
    },
    extra,
    ado,
    settings,
  });
  const head = commitAll(fx.api, "chore: pipeline mapping");
  fx.ado.state.refs.set("acme-api", [{ name: "refs/heads/main", objectId: head }]);
  return { ...fx, head, short: { ...fx.short, head: head.slice(0, 7) } };
}

async function preview(fx, extra = [], env = fx.env) {
  return cli(fx, ["pipeline-preview", ...fx.ws, "acme-api", ...STAGE, ...extra, "--json"], env);
}

async function run(fx, token, extra = [], env = fx.env) {
  return cli(fx, ["run-pipeline", ...fx.ws, "acme-api", ...STAGE, ...extra, ...(token === null ? [] : ["--confirm", token]), "--json"], env);
}

/** A valid preview token (asserts the preview succeeded). */
async function tokenOf(fx, extra = []) {
  const r = await preview(fx, extra);
  assert.equal(r.status, 0, r.out);
  return { token: r.json.token.value, json: r.json };
}

/** Forges a token for `binding` with an arbitrary expiry (the token is a commitment, not an authenticator). */
function forge(binding, expiresAt, commit = binding.commit) {
  const payload = JSON.stringify({ commit, digest: bindingDigest(binding, expiresAt), expiresAt, v: 1 });
  return `${TOKEN_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

/** Rewrites workspace.json canonically after `mutate`. */
function rewriteWorkspace(fx, mutate) {
  const value = JSON.parse(readFileSync(fx.workspaceFile, "utf8"));
  mutate(value);
  writeFileSync(fx.workspaceFile, render(canonicalize(value, WORKSPACE_SCHEMA)), "utf8");
}

/** An in-process context with a fake clock whose sleep advances it. */
function fakeClock(env, start = "2026-11-25T10:00:00.000Z") {
  let clock = Date.parse(start);
  return {
    advance: (ms) => (clock += ms),
    context: {
      env,
      stdout: { isTTY: false },
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
    },
  };
}

function request(fx, overrides = {}) {
  return { workspace: fx.platform, component: "acme-api", stage: "stage-1", target: null, action: null, selections: [], ...overrides };
}

async function rejectsWith(promise, exitCode, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "EngineError", String(error));
    assert.equal(error.exitCode, exitCode, error.message);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? jsFiles(path) : name.endsWith(".js") ? [path] : [];
  });
}

// ---------------------------------------------------------------------------
// The happy path: preview → one POST with exactly the previewed request

test("7e/60/67: preview (GETs only) → run with its token sends EXACTLY ONE POST whose body is exactly the previewed request; omitted action = primaryAction", async (t) => {
  const fx = await runFleet(t);
  const p = await preview(fx);
  assert.equal(p.status, 0, p.out);
  assertOnlyGets(assert, fx.ado);
  const pv = p.json.preview;
  assert.equal(p.json.command, "pipeline-preview");
  assert.deepEqual(pv.action, { name: "build", kind: "build", source: "primaryAction" });
  assert.equal(pv.organizationUrl, fx.ado.base);
  assert.equal(pv.project, PROJECT);
  assert.deepEqual([pv.pipeline.status, pv.pipeline.id, pv.pipeline.name], ["found", 101, "acme-api-ci"]);
  assert.match(pv.pipeline.detail, /existence only/);
  assert.equal(pv.ref, "refs/heads/main");
  assert.deepEqual(pv.repository, { value: "acme-api", source: "mapping" });
  assert.deepEqual(pv.stage, { name: "stage-1", mode: "pipeline", owner: "dev-team", operatorTeam: "dev-team", triggerable: true });
  assert.deepEqual(
    pv.parameters.map((x) => [x.name, x.value, x.source]),
    [
      ["action", "build", "action"],
      ["imageTag", fx.short.head, "template"],
    ],
  );
  assert.deepEqual([pv.commit.sha, pv.commit.source, pv.commit.onRemoteRef, pv.commit.inLocalClone, pv.commit.subject], [fx.head, "remote-ref-head", true, true, "chore: pipeline mapping"]);
  assert.deepEqual([pv.localHead.relation, pv.localHead.buildable], ["same", true]);
  assert.equal(pv.componentAtCommit.mappingMatches, true);
  assert.deepEqual([pv.image.status, pv.image.tag], ["determined", fx.short.head]);
  assert.equal(pv.verification.detail, "no real-world verification configured");
  assert.deepEqual(pv.blockers, []);
  const expectedBody = { resources: { repositories: { self: { refName: "refs/heads/main", version: fx.head } } }, templateParameters: { action: "build", imageTag: fx.short.head } };
  assert.deepEqual(pv.request, { path: `/${PROJECT}/_apis/pipelines/101/runs?api-version=7.1`, body: expectedBody });
  assert.match(p.json.token.value, /^rr1\.[A-Za-z0-9_-]+$/);
  assert.equal(p.json.token.ttlMinutes, 10);
  assert.deepEqual(p.json.requests, { method: "GET", count: 2 }, "Pipelines Get + Git Refs");

  const r = await run(fx, p.json.token.value);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.phase, "queued");
  const sent = posts(fx);
  assert.equal(sent.length, 1, "exactly one POST");
  assert.equal(sent[0].path, `/acme-org/${PROJECT}/_apis/pipelines/101/runs`);
  assert.equal(sent[0].query["api-version"], "7.1");
  assert.deepEqual(sent[0].body, expectedBody, "the POST body equals the previewed request exactly");
  assert.deepEqual(r.json.preview.request.body, pv.request.body);
  assert.deepEqual([r.json.queue.status, r.json.queue.runId, r.json.queue.count, r.json.queue.retried], ["queued", 900, 1, false]);
  assert.equal(r.json.queue.pin.status, "matched");
  assert.equal(r.json.queue.method, "POST");
  assert.equal(r.json.requests.queue, 1);
  assert.equal(r.json.run, null, "no --follow: nothing followed");
  noPat(p, r);
  // Nothing but that one POST was ever a non-GET.
  assert.deepEqual(Object.keys(fx.ado.counts()).sort(), ["GET", "POST"]);
  assert.equal(fx.ado.counts().POST, 1);
});

test("60/3: the human preview shows every item of requirement 60 step 3 and the token; nothing is queued", async (t) => {
  const fx = await runFleet(t, {
    extra: (component) => {
      component.stages["stage-1"].verification = { timeoutSeconds: 5, checks: [{ name: "health", type: "http", url: "https://acme-api.stage-1.example.com/health", method: "GET", expectStatus: [200] }] };
    },
  });
  // The verification block must be at the commit too.
  const head = commitAll(fx.api, "chore: verification");
  fx.ado.state.refs.set("acme-api", [{ name: "refs/heads/main", objectId: head }]);
  const r = await cli(fx, ["pipeline-preview", ...fx.ws, "acme-api", ...STAGE]);
  assert.equal(r.status, 0, r.out);
  for (const pattern of [
    /organization {2}http:\/\/127\.0\.0\.1:\d+\/acme-org/,
    /project {7}acme-project/,
    /pipeline {6}101 "acme-api-ci"/,
    /stage {9}stage-1 \(mode pipeline, owner dev-team = operatorTeam: triggerable\)/,
    /target {8}api/,
    /ref {11}refs\/heads\/main in repository acme-api \(from the mapping\)/,
    /action {8}build \(kind build; no action given — the mapping's primaryAction\)/,
    /action = "build"/,
    new RegExp(`imageTag = "${head.slice(0, 7)}"`),
    new RegExp(`commit {8}${head} — the remote head of refs/heads/main \\(exists on the remote ref: yes\\)`),
    new RegExp(`image {9}tag ${head.slice(0, 7)}`),
    /verification {2}1 check\(s\) run once after landing: health \(http\)/,
    /exactly one queue request to \/acme-project\/_apis\/pipelines\/101\/runs/,
    /confirmation token \(expires .*, 10 minute\(s\)\):\n {4}rr1\./,
    /all GET; nothing was queued or changed/,
  ]) assert.match(r.stdout, pattern);
  assertOnlyGets(assert, fx.ado);
  noPat(r);
});

// ---------------------------------------------------------------------------
// Actions and userSelectable choices

test("62/AC12: a configuration-kind action is previewed with its kind, gated identically, and a build token does not authorise it", async (t) => {
  const fx = await runFleet(t);
  const build1 = await tokenOf(fx);
  const p = await preview(fx, ["--action", "configure"]);
  assert.equal(p.status, 0, p.out);
  assert.deepEqual(p.json.preview.action, { name: "configure", kind: "configuration", source: "requested" });
  assert.equal(p.json.preview.image.status, "not-applicable");
  assert.match(p.json.preview.image.detail, /configuration applied; image unchanged/);
  const human = await cli(fx, ["pipeline-preview", ...fx.ws, "acme-api", ...STAGE, "--action", "configure"]);
  assert.match(human.stdout, /action {8}configure \(kind configuration\)/);
  const wrong = await run(fx, build1.token, ["--action", "configure"]);
  assert.equal(wrong.status, 27, wrong.out);
  assert.match(wrong.stderr, /does not match the recomputed request/);
  assert.equal(posts(fx).length, 0, "a token for another action sends nothing");
  const noToken = await run(fx, null, ["--action", "configure"]);
  assert.equal(noToken.status, 27, "configuration-kind runs need a token too");
  assert.equal(posts(fx).length, 0);
  const ok = await run(fx, p.json.token.value, ["--action", "configure"]);
  assert.equal(ok.status, 0, ok.out);
  assert.equal(posts(fx).length, 1);
  assert.deepEqual(posts(fx)[0].body.templateParameters, { action: "configure", imageTag: fx.short.head });
});

test("60/67: userSelectable choices come from the closed list, every one must be chosen, and the token binds them", async (t) => {
  const fx = await runFleet(t, { mapping: (m) => void (m.userSelectable = { region: ["east", "west"] }) });
  for (const [extra, message] of [
    [[], /choose every userSelectable parameter: --select region=<east\|west>/],
    [["--select", "region=north"], /--select region=north: not an allowed value \(allowed: east, west\)/],
    [["--select", "zone=a", "--select", "region=east"], /--select zone: not a userSelectable parameter of this mapping \(userSelectable: region\)/],
    [["--select", "region=east", "--select", "region=west"], /--select region given twice/],
    [["--select", "region"], /expected <parameter>=<value>/],
  ]) {
    const r = await preview(fx, extra);
    assert.equal(r.status, 64, `${extra.join(" ")}: ${r.out}`);
    assert.match(r.stderr, message);
  }
  assert.equal(fx.ado.requests.length, 0, "choices are validated before any request");
  const east = await tokenOf(fx, ["--select", "region=east"]);
  const region = east.json.preview.parameters.find((x) => x.name === "region");
  assert.deepEqual([region.value, region.source, region.allowed], ["east", "userSelectable", ["east", "west"]]);
  assert.deepEqual(east.json.preview.selections, { region: "east" });
  const changed = await run(fx, east.token, ["--select", "region=west"]);
  assert.equal(changed.status, 27, changed.out);
  assert.equal(posts(fx).length, 0, "a changed selection sends nothing");
  const ok = await run(fx, east.token, ["--select", "region=east"]);
  assert.equal(ok.status, 0, ok.out);
  assert.equal(posts(fx).length, 1);
  assert.equal(posts(fx)[0].body.templateParameters.region, "east");
});

// ---------------------------------------------------------------------------
// Token refusals (27): zero writes

test("7c/67: a missing, malformed or tampered token → 27 with zero POSTs (a missing/malformed one with zero requests at all)", async (t) => {
  const fx = await runFleet(t);
  const { token } = await tokenOf(fx);
  const before = fx.ado.requests.length;
  const missing = await run(fx, null);
  assert.equal(missing.status, 27, missing.out);
  assert.match(missing.stderr, /no confirmation token \(--confirm <token> from pipeline-preview\); nothing was sent/);
  for (const bad of ["nonsense", "rr1.", "rr1.!!!", `rr1.${Buffer.from("[1,2]").toString("base64url")}`, `rr1.${Buffer.from('{"v":2}').toString("base64url")}`, `rr1.${"A".repeat(2000)}`]) {
    const r = await run(fx, bad);
    assert.equal(r.status, 27, `${bad.slice(0, 20)}: ${r.out}`);
    assert.match(r.stderr, /malformed/);
  }
  assert.equal(fx.ado.requests.length, before, "token shape is checked before any request");
  // Tamper: flip the digest inside an otherwise well-formed payload.
  const payload = JSON.parse(Buffer.from(token.slice(4), "base64url").toString("utf8"));
  const digest = payload.digest.startsWith("0") ? `1${payload.digest.slice(1)}` : `0${payload.digest.slice(1)}`;
  const tampered = `rr1.${Buffer.from(JSON.stringify({ ...payload, digest })).toString("base64url")}`;
  const r = await run(fx, tampered);
  assert.equal(r.status, 27, r.out);
  assert.match(r.stderr, /does not match the recomputed request/);
  // Tamper the expiry (still within the TTL): the digest covers it.
  const later = new Date(Date.parse(payload.expiresAt) - 1000).toISOString();
  const shifted = `rr1.${Buffer.from(JSON.stringify({ ...payload, expiresAt: later })).toString("base64url")}`;
  const s = await run(fx, shifted);
  assert.equal(s.status, 27, s.out);
  assert.equal(posts(fx).length, 0, "zero POSTs");
  noPat(missing, r, s);
});

test("7c/67: an expired token → 27 with zero POSTs (CLI with a token past its expiry; in-process with the clock moved past the TTL); an expiry beyond the TTL → 27", async (t) => {
  const fx = await runFleet(t);
  const { json } = await tokenOf(fx);
  const binding = json.preview.binding;
  assert.equal(binding.commit, fx.head);
  const expired = forge(binding, new Date(Date.now() - 60_000).toISOString());
  const r = await run(fx, expired);
  assert.equal(r.status, 27, r.out);
  assert.match(r.stderr, /the confirmation token expired at .*confirmTokenTtlMinutes 10/);
  const tooLong = forge(binding, new Date(Date.now() + 3 * 60 * 60_000).toISOString());
  const l = await run(fx, tooLong);
  assert.equal(l.status, 27, l.out);
  assert.match(l.stderr, /beyond the configured confirmTokenTtlMinutes \(10\)/);
  // In-process: preview at T, run at T + TTL → expired.
  const clock = fakeClock(fx.env);
  const out = await runPipelinePreview({ ...request(fx), json: true }, clock.context);
  const token = JSON.parse(out.stdout).token.value;
  clock.advance(10 * 60_000);
  await rejectsWith(runRunPipeline({ ...request(fx), confirm: token, follow: false, json: true }, clock.context), 27, /expired/);
  assert.equal(posts(fx).length, 0, "zero POSTs");
  // One millisecond before the expiry the same token is accepted.
  clock.advance(-1);
  const ok = await runRunPipeline({ ...request(fx), confirm: token, follow: false, json: true }, clock.context);
  assert.equal(ok.exitCode, 0);
  assert.equal(posts(fx).length, 1);
});

test("7c/61: the remote head moved between preview and run → 27 with zero POSTs; moved between the recompute and the queue → 27 with zero POSTs", async (t) => {
  const fx = await runFleet(t);
  const { token } = await tokenOf(fx);
  put(join(fx.api, "five.txt"), "five\n");
  const moved = commitAll(fx.api, "feat: fifth");
  fx.ado.state.refs.set("acme-api", [{ name: "refs/heads/main", objectId: moved }]);
  const r = await run(fx, token);
  assert.equal(r.status, 27, r.out);
  assert.match(r.stderr, new RegExp(`the remote head of refs/heads/main moved since the preview: previewed ${fx.short.head}, now ${moved.slice(0, 7)}; nothing was sent`));
  assert.equal(posts(fx).length, 0);

  // A fresh token, then the ref moves exactly between the recompute and the final re-read.
  const fresh = await tokenOf(fx);
  let refReads = 0;
  fx.ado.state.onRequest = (record) => {
    if (!record.path.endsWith("/refs")) return;
    refReads++;
    if (refReads === 2) fx.ado.state.refs.set("acme-api", [{ name: "refs/heads/main", objectId: "e".repeat(40) }]);
  };
  const late = await run(fx, fresh.token);
  assert.equal(late.status, 27, late.out);
  assert.match(late.stderr, new RegExp(`moved immediately before queueing: previewed ${moved.slice(0, 7)}, now eeeeeee; nothing was sent`));
  assert.equal(refReads, 2, "recompute read + the final re-read");
  assert.equal(posts(fx).length, 0, "zero POSTs");
});

// ---------------------------------------------------------------------------
// Refusals (26) and names (64): zero writes, before any request

test("7d/68: handoff / manual / none stages and another team's pipeline stage → 26 with zero requests; the owner and mode are named", async (t) => {
  const fx = await runFleet(t, {
    extra: (component) => {
      component.stages["stage-2"] = { targets: [{ ...commandTarget("stage-2", "api"), pipeline: apiMapping() }] };
    },
  });
  const cases = [
    ["stage-2", /stage "stage-2" is not triggerable: its pipeline is owned by "qa-team", not by operatorTeam "dev-team"/],
    ["stage-3", /stage "stage-3" is not triggerable: its promotion mode is "handoff" \(owner "ops-team"\).*prepare a handoff package for the owner instead; nothing was sent/],
  ];
  for (const [stage, message] of cases) {
    for (const command of ["pipeline-preview", "run-pipeline"]) {
      const r = await cli(fx, [command, ...fx.ws, "acme-api", "--stage", stage, ...(command === "run-pipeline" ? ["--confirm", "rr1.x"] : [])]);
      assert.equal(r.status, 26, `${command} ${stage}: ${r.out}`);
      assert.match(r.stderr, message);
    }
  }
  for (const [mode, owner] of [["manual", "ops-team"], ["none", undefined]]) {
    rewriteWorkspace(fx, (ws) => {
      ws.stages[2].promotion = owner === undefined ? { mode } : { mode, owner };
    });
    const refused = await cli(fx, ["run-pipeline", ...fx.ws, "acme-api", "--stage", "stage-3", "--confirm", "rr1.x"]);
    assert.equal(refused.status, 26, `${mode}: ${refused.out}`);
    assert.match(refused.stderr, new RegExp(`its promotion mode is "${mode}"`));
  }
  assert.equal(fx.ado.requests.length, 0, "every refusal before any request");
  assert.equal(posts(fx).length, 0);
});

test("68/14: no mapping and an undeclared action → 26; a malformed action name, an unknown target and several mapped targets → 64; all with zero requests", async (t) => {
  const fx = await runFleet(t, {
    extra: (component) => {
      component.stages["stage-1"].targets.push({ ...commandTarget("stage-1", "api-internal") });
    },
  });
  const cases = [
    [["--target", "api-internal"], 26, /target "api-internal" of acme-api on stage "stage-1" has no pipeline mapping; nothing was sent/],
    [["--action", "deploy"], 26, /action "deploy" is not declared for acme-api\/stage-1\/api \(declared: build, configure\); nothing was sent/],
    [["--action", "Bad!"], 64, /"Bad!" is not an action name/],
    [["--target", "nope"], 64, /unknown target "nope" for acme-api on stage "stage-1" \(targets: api, api-internal\)/],
  ];
  for (const [extra, code, message] of cases) {
    for (const command of ["pipeline-preview", "run-pipeline"]) {
      const r = await cli(fx, [command, ...fx.ws, "acme-api", ...STAGE, ...extra, ...(command === "run-pipeline" ? ["--confirm", "rr1.x"] : [])]);
      assert.equal(r.status, code, `${command} ${extra.join(" ")}: ${r.out}`);
      assert.match(r.stderr, message);
    }
  }
  const worker = await cli(fx, ["run-pipeline", ...fx.ws, "acme-worker", ...STAGE, "--confirm", "rr1.x"]);
  assert.equal(worker.status, 26, worker.out);
  assert.match(worker.stderr, /acme-worker has no pipeline mapping on stage "stage-1"/);
  const names = [
    [["pipeline-preview", ...fx.ws, "acme-nope", ...STAGE], /unknown component "acme-nope"/],
    [["pipeline-preview", ...fx.ws, "acme-api", "--stage", "stage-9"], /unknown stage "stage-9"/],
    [["pipeline-preview", ...fx.ws, "acme-api"], /"pipeline-preview" requires --stage <name>/],
    [["run-pipeline", ...fx.ws, "acme-api", ...STAGE, "--confirm"], /--confirm needs a value/],
    [["run-pipeline", "--config", "x", "acme-api"], /--config is not supported/],
  ];
  for (const [args, message] of names) {
    const r = await cli(fx, args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, message);
  }
  const both = await runFleet(t, {
    extra: (component) => {
      component.stages["stage-1"].targets.push({ ...commandTarget("stage-1", "api-mobile"), pipeline: apiMapping() });
    },
  });
  const several = await cli(both, ["pipeline-preview", ...both.ws, "acme-api", ...STAGE]);
  assert.equal(several.status, 64, several.out);
  assert.match(several.stderr, /2 pipeline-mapped targets on stage "stage-1" \(api, api-mobile\); pick one with --target/);
  assert.equal(fx.ado.requests.length + both.ado.requests.length, 0);
});

test("A13/26: neither pinning nor the ref check possible → 26 without a token; the repository may come from Pipelines Get (Azure Repos Git only); a GitHub repository → 26", async (t) => {
  const none = await runFleet(t, { repository: null });
  const p = await preview(none);
  assert.equal(p.status, 26, p.out);
  assert.equal(p.json.token, null);
  assert.equal(p.json.preview.blockers[0].code, "no-ref-check");
  assert.match(p.json.preview.blockers[0].detail, /neither pinning nor the ref check is possible: the mapping declares no "repository"/);
  const r = await run(none, "rr1.x");
  assert.equal(r.status, 27, "a malformed token is refused before the recompute");
  const forged = await run(none, forge({ commit: none.head }, new Date(Date.now() + 60_000).toISOString()));
  assert.equal(forged.status, 26, forged.out);
  assert.match(forged.stderr, /the run is blocked; nothing was sent: neither pinning nor the ref check/);
  assert.equal(posts(none).length, 0);

  const derived = await runFleet(t, { repository: null, ado: { pipelines: [{ id: 101, name: "acme-api-ci", repository: { id: "acme-api", type: "azureReposGit" } }] } });
  const ok = await preview(derived);
  assert.equal(ok.status, 0, ok.out);
  assert.deepEqual(ok.json.preview.repository, { value: "acme-api", source: "pipeline-configuration" });
  const queued = await run(derived, ok.json.token.value);
  assert.equal(queued.status, 0, queued.out);
  assert.equal(posts(derived).length, 1);

  const github = await runFleet(t, { ado: { pipelines: [{ id: 101, name: "acme-api-ci", repository: { id: "acme/api", type: "gitHub" } }] } });
  const g = await preview(github);
  assert.equal(g.status, 26, g.out);
  assert.match(g.json.preview.blockers[0].detail, /of type "gitHub", not Azure Repos Git: the Git Refs remote-head check is impossible/);
  assertOnlyGets(assert, github.ado);
});

test("61: the commit is the remote ref head — not in the local clone → 26; an unpushed local HEAD is shown not buildable; a missing ref or repository → 23; a mapping that differs at the commit → 26", async (t) => {
  const fx = await runFleet(t);
  // Unpushed local work: HEAD is ahead of the remote head; the run still builds the remote head.
  put(join(fx.api, "local.txt"), "local\n");
  const local = commitAll(fx.api, "wip: not pushed");
  const p = await preview(fx);
  assert.equal(p.status, 0, p.out);
  assert.equal(p.json.preview.commit.sha, fx.head);
  assert.deepEqual([p.json.preview.localHead.sha, p.json.preview.localHead.relation, p.json.preview.localHead.buildable], [local, "unpushed", false]);
  assert.match(p.json.preview.localHead.detail, /1 commit\(s\) that are not on the remote ref: not buildable/);
  // The local HEAD older than the remote head.
  git(fx.api, "reset", "-q", "--hard", fx.commits.c4);
  fx.ado.state.refs.set("acme-api", [{ name: "refs/heads/main", objectId: local }]);
  git(fx.api, "reset", "-q", "--hard", fx.head);
  const older = await preview(fx);
  assert.equal(older.status, 0, older.out);
  assert.deepEqual([older.json.preview.localHead.relation, older.json.preview.localHead.buildable], ["older", true]);
  // A remote head the clone does not contain.
  fx.ado.state.refs.set("acme-api", [{ name: "refs/heads/main", objectId: "f".repeat(40) }]);
  const absent = await preview(fx);
  assert.equal(absent.status, 26, absent.out);
  assert.equal(absent.json.token, null);
  assert.equal(absent.json.preview.commit.inLocalClone, false);
  assert.match(absent.json.preview.blockers[0].detail, /the local clone does not contain fffffff, the remote head of refs\/heads\/main: fetch the clone \(release-radar never fetches\)/);
  // The ref does not exist / the repository does not exist → 23.
  fx.ado.state.refs.set("acme-api", [{ name: "refs/heads/other", objectId: fx.head }]);
  const noRef = await preview(fx);
  assert.equal(noRef.status, 23, noRef.out);
  assert.equal(noRef.json.preview.blockers[0].code, "ref-missing");
  fx.ado.state.refs.delete("acme-api");
  const noRepo = await preview(fx);
  assert.equal(noRepo.status, 23, noRepo.out);
  assert.equal(noRepo.json.preview.blockers[0].code, "repository-missing");
  // The working-tree mapping differs from the one at the commit.
  fx.ado.state.refs.set("acme-api", [{ name: "refs/heads/main", objectId: fx.head }]);
  const value = JSON.parse(readFileSync(fx.apiComponent, "utf8"));
  value.stages["stage-1"].targets[0].pipeline.landedWaitMinutes = 20;
  writeComponent(fx.apiComponent, value);
  const differs = await preview(fx);
  assert.equal(differs.status, 26, differs.out);
  assert.equal(differs.json.preview.blockers[0].code, "config-at-commit");
  assert.match(differs.json.preview.blockers[0].detail, /differs from the working tree's/);
  const r = await run(fx, forge({ commit: fx.head }, new Date(Date.now() + 60_000).toISOString()));
  assert.equal(r.status, 26, r.out);
  assert.equal(posts(fx).length, 0);
  assertOnlyGets(assert, fx.ado);
});

test("16/20: PAT absent → 20 with zero requests for preview and run; a PAT with no execute scope (403 on the POST) → 20 after the single POST", async (t) => {
  const fx = await runFleet(t);
  const env = { ...fx.env };
  delete env.AZURE_DEVOPS_EXT_PAT;
  for (const r of [await preview(fx, [], env), await run(fx, null, [], env), await run(fx, "rr1.x", [], env)]) {
    assert.equal(r.status, 20, r.out);
    assert.match(r.stderr, /AZURE_DEVOPS_EXT_PAT is not set — (pipeline-preview needs .*Code \(Read; the Git Refs|run-pipeline needs .*Build \(Read & execute\))/);
    assert.doesNotMatch(r.stderr, /--no-pipelines/);
  }
  assert.equal(fx.ado.requests.length, 0, "zero requests");
  const { token } = await tokenOf(fx);
  fx.ado.fail(/\/runs$/, "403");
  fx.ado.state.post.create = false;
  const r = await run(fx, token);
  assert.equal(r.status, 20, r.out);
  assert.equal(r.json.queue.status, "rejected");
  assert.match(r.stderr, /needs Build \(Read & execute\).*no run was created.*never retried/);
  assert.equal(posts(fx).length, 1, "exactly one POST, not retried");
  noPat(r);
});

test("20/83: run-pipeline refuses a non-canonical workspace (29) and an invalid one (24) before anything, with zero requests", async (t) => {
  const fx = await runFleet(t);
  const canonical = readFileSync(fx.workspaceFile, "utf8");
  writeFileSync(fx.workspaceFile, JSON.stringify(JSON.parse(canonical)), "utf8");
  const nonCanonical = await run(fx, null);
  assert.equal(nonCanonical.status, 29, nonCanonical.out);
  writeFileSync(fx.workspaceFile, canonical.replace('"schemaVersion": 1', '"schemaVersion": "one"'), "utf8");
  const invalid = await run(fx, null);
  assert.equal(invalid.status, 24, invalid.out);
  assert.equal(fx.ado.requests.length, 0);
});

// ---------------------------------------------------------------------------
// After the POST: follow, failure, waits, unknown outcome, pin

test("7f/69/25: --follow on failed / canceled / partiallySucceeded → 25 and no second POST; succeeded → 0", async (t) => {
  for (const result of ["failed", "canceled", "partiallySucceeded", "succeeded"]) {
    const fx = await runFleet(t);
    const { token } = await tokenOf(fx);
    const params = { action: "build", imageTag: fx.short.head };
    fx.ado.sequence(900, [build({ id: 900, status: "inProgress", commit: fx.head, params }), build({ id: 900, status: "completed", result, commit: fx.head, params })]);
    const r = await run(fx, token, ["--follow"]);
    const expected = result === "succeeded" ? 0 : 25;
    assert.equal(r.status, expected, `${result}: ${r.out}`);
    assert.equal(r.json.run.result, result);
    assert.equal(r.json.follow.outcome, "terminal");
    assert.equal(r.json.follow.polls, 2);
    if (expected === 25) assert.match(r.stderr, new RegExp(`run #900 finished "${result}" — not "succeeded" \\(exit 25\\); it is NOT retried`));
    assert.equal(posts(fx).length, 1, `${result}: exactly one POST`);
    noPat(r);
  }
});

test("69: --follow past followTimeoutMinutes → still running, exit 0, one POST (in-process fake clock); an approval wait is reported and following stops", async (t) => {
  const fx = await runFleet(t);
  const clock = fakeClock(fx.env);
  const token = JSON.parse((await runPipelinePreview({ ...request(fx), json: true }, clock.context)).stdout).token.value;
  const out = await runRunPipeline({ ...request(fx), confirm: token, follow: true, json: true }, clock.context);
  assert.equal(out.exitCode, 0);
  assert.equal(out.phase, "still-running");
  const report = JSON.parse(out.stdout);
  assert.equal(report.follow.outcome, "still-running");
  assert.ok(report.follow.polls > 10, "polled read-only every followPollSeconds");
  assert.match(out.stderr.join("\n"), /still running after 1 minute\(s\) of following — not a failure/);
  assert.equal(posts(fx).length, 1, "exactly one POST");

  const waiting = await runFleet(t);
  const { token: second } = await tokenOf(waiting);
  waiting.ado.state.timelines.set(900, [{ id: "approval-1", type: "Checkpoint.Approval", name: "Checkpoint.Approval", state: "inProgress" }]);
  waiting.ado.state.approvals = [{ id: "approval-1", status: "pending", minRequiredApprovers: 1, steps: [{ assignedApprover: { displayName: "Release Approver" } }] }];
  const r = await run(waiting, second, ["--follow"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.phase, "waiting");
  assert.deepEqual(r.json.waits.map((w) => [w.kind, w.approvers]), [["approval", ["Release Approver"]]]);
  assert.match(r.stderr, /waiting for an approval — approvers: Release Approver.*release-radar never approves/);
  assert.equal(posts(waiting).length, 1, "no POST beyond the one");
  assert.deepEqual(Object.keys(waiting.ado.counts()).sort(), ["GET", "POST"], "nothing approved (no PATCH)");
});

test("D9: a POST timeout or network error is an UNKNOWN OUTCOME — exactly one POST, the run detected read-only, exit 21, never re-POSTed", async (t) => {
  // Timeout: the fake creates the run at once and answers after the request timeout.
  const slow = await runFleet(t, { ado: { slowMs: 2500 } });
  const { token } = await tokenOf(slow);
  slow.ado.fail(/\/runs$/, "slow");
  const r = await run(slow, token, ["--follow"]);
  assert.equal(r.status, 21, r.out);
  assert.equal(r.phase, "unknown-outcome");
  assert.equal(r.json.queue.status, "unknown");
  assert.match(r.json.queue.detail, /no answer within 1s \(timeout\)/);
  assert.equal(r.json.queue.detection.status, "found");
  assert.deepEqual(r.json.queue.detection.runs.map((x) => [x.id, x.matchesRequest]), [[900, true]]);
  assert.match(r.stderr, /UNKNOWN OUTCOME .*#900 \(same ref and commit\).*do NOT queue again.*never retried \(exit 21\)/);
  assert.equal(r.json.run, null, "an unknown outcome is not followed as if queued");
  assert.equal(posts(slow).length, 1, "exactly one POST");
  // Reset without creating: nothing detected, still exit 21.
  const reset = await runFleet(t);
  const second = await tokenOf(reset);
  reset.ado.state.post.create = false;
  reset.ado.fail(/\/runs$/, "reset");
  const n = await run(reset, second.token);
  assert.equal(n.status, 21, n.out);
  assert.equal(n.json.queue.detection.status, "not-found");
  assert.match(n.json.queue.detection.detail, /cannot be proven .*never re-run blindly/);
  assert.equal(posts(reset).length, 1);
  // A 5xx after the run was created.
  const err = await runFleet(t);
  const third = await tokenOf(err);
  err.ado.fail(/\/runs$/, "500");
  const e = await run(err, third.token);
  assert.equal(e.status, 21, e.out);
  assert.equal(e.json.queue.detection.status, "found");
  assert.equal(posts(err).length, 1);
  noPat(r, n, e);
});

test("D8: the pin check — a different echoed version is a loud PIN MISMATCH (exit 21); an absent echo is a warning (exit 0)", async (t) => {
  const fx = await runFleet(t);
  const { token } = await tokenOf(fx);
  fx.ado.state.post.echo = "d".repeat(40);
  const r = await run(fx, token);
  assert.equal(r.status, 21, r.out);
  assert.equal(r.phase, "pin-mismatch");
  assert.equal(r.json.queue.pin.status, "mismatch");
  assert.match(r.stderr, new RegExp(`PIN MISMATCH: the pipeline built ${"d".repeat(40)} instead of ${fx.head}`));
  assert.equal(posts(fx).length, 1);
  const quiet = await runFleet(t);
  const second = await tokenOf(quiet);
  quiet.ado.state.post.echo = null;
  const q = await run(quiet, second.token);
  assert.equal(q.status, 0, q.out);
  assert.equal(q.json.queue.pin.status, "unconfirmed");
  assert.match(q.stderr, /warning — the answer did not echo resources\.repositories\.self\.version/);
});

test("D9/3.10: a 429 or a 400 on the POST is rejected and never retried (exit 21, one POST)", async (t) => {
  for (const mode of ["429", "400"]) {
    const fx = await runFleet(t);
    const { token } = await tokenOf(fx);
    fx.ado.state.post.create = false;
    if (mode === "429") fx.ado.fail(/\/runs$/, "429", { retryAfter: 1 });
    const r = await run(fx, token);
    assert.equal(r.status, 21, `${mode}: ${r.out}`);
    assert.equal(r.json.queue.status, "rejected");
    assert.match(r.json.queue.detail, mode === "429" ? /HTTP 429 .*NEVER retried/ : /HTTP 400 — Azure DevOps refused the request: VS402881/);
    assert.equal(posts(fx).length, 1, `${mode}: one POST, not retried`);
  }
});

// ---------------------------------------------------------------------------
// The mutation boundary

test("7a/76: pipeline-preview and every other command issue ZERO non-GET requests", async (t) => {
  const fx = await runFleet(t, { ado: { builds: [build({ id: 105, commit: "c".repeat(40), params: { action: "build", imageTag: "ccccccc" } })] } });
  const commands = [
    ["pipeline-preview", ...fx.ws, "acme-api", ...STAGE],
    ["pipeline-preview", ...fx.ws, "acme-api", ...STAGE, "--action", "configure", "--json"],
    ["pipeline-runs", ...fx.ws, "acme-api"],
    ["pipeline-run", ...fx.ws, "acme-api", "105"],
    ["status", ...fx.ws, "acme-api"],
    ["validate-config", ...fx.ws],
  ];
  for (const args of commands) {
    const r = await cli(fx, args);
    assert.ok([0, 22].includes(r.status), `${args.join(" ")}: ${r.out}`);
    noPat(r);
  }
  assert.ok(fx.ado.requests.length > 0, "the reads did reach the fake");
  assertOnlyGets(assert, fx.ado);
});

test("7a/66: statically, non-GET method literals exist only in the compiled write module, only run-pipeline imports it, and only the CLI loads run-pipeline (dynamically)", () => {
  const files = jsFiles(DIST);
  const rel = (file) => file.slice(DIST.length).split("\\").join("/");
  const nonGet = /(["'`])(?:POST|PUT|PATCH|DELETE)\1/;
  const withMethod = files.filter((file) => nonGet.test(readFileSync(file, "utf8"))).map(rel);
  assert.deepEqual(withMethod, ["pipelines/azure-devops-write.js"], "non-GET method literals only in the write module");
  const write = readFileSync(join(DIST, "pipelines", "azure-devops-write.js"), "utf8");
  assert.equal((write.match(/\bfetch\(/g) ?? []).length, 1, "one network call site");
  assert.match(write, /method: QUEUE_METHOD/);
  assert.doesNotMatch(write, /for \(|while \(|retry\(/, "no loop around the POST");
  assert.deepEqual(
    [...write.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]).sort(),
    ["MAX_QUEUE_BODY_BYTES", "QUEUE_METHOD", "queueRun"],
    "the module's only callable export is queueRun",
  );
  const importers = files.filter((file) => /azure-devops-write\.js/.test(readFileSync(file, "utf8"))).map(rel);
  assert.deepEqual(importers, ["commands/run-pipeline.js"], "only the run-pipeline command module imports the write module");
  const loaders = files.filter((file) => /run-pipeline\.js/.test(readFileSync(file, "utf8"))).map(rel);
  assert.deepEqual(loaders, ["cli.js"], "only the CLI references run-pipeline");
  const cliText = readFileSync(join(DIST, "cli.js"), "utf8");
  assert.match(cliText, /await import\("\.\/commands\/run-pipeline\.js"\)/);
  assert.doesNotMatch(cliText, /^import .*run-pipeline\.js/m, "never a static import");
  assert.doesNotMatch(readFileSync(join(DIST, "pipelines", "preview.js"), "utf8"), /azure-devops-write/);
});

// ---------------------------------------------------------------------------
// Units: the token and the Git Refs peel

test("67: the token binds every field recursively (any nested parameter change → mismatch) and round-trips", () => {
  const binding = {
    organizationUrl: "http://127.0.0.1:1/acme-org",
    project: "acme-project",
    pipelineId: 101,
    pipelineName: "acme-api-ci",
    repository: "acme-api",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    component: "acme-api",
    stage: "stage-1",
    target: "api",
    action: "build",
    actionKind: "build",
    parameters: { action: "build", imageTag: "aaaaaaa", region: "east" },
    selections: { region: "east" },
    engineVersion: "0.1.0",
  };
  const now = new Date("2026-11-25T10:00:00.000Z");
  const issued = issueToken(binding, now, 10);
  assert.equal(issued.expiresAt, "2026-11-25T10:10:00.000Z");
  const decoded = decodeToken(issued.value, now.getTime(), 10);
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(issued.value.slice(4), "base64url").toString())).sort(), ["commit", "digest", "expiresAt", "v"]);
  verifyToken(decoded, binding);
  verifyToken(decoded, { ...binding, parameters: { region: "east", imageTag: "aaaaaaa", action: "build" } });
  for (const change of [
    { organizationUrl: "http://127.0.0.1:2/acme-org" },
    { project: "other" },
    { pipelineId: 102 },
    { pipelineName: "x" },
    { repository: "other" },
    { ref: "refs/heads/release" },
    { component: "acme-worker" },
    { stage: "stage-2" },
    { target: "api-internal" },
    { action: "configure" },
    { actionKind: "configuration" },
    { parameters: { ...binding.parameters, imageTag: "bbbbbbb" } },
    { parameters: { ...binding.parameters, extra: "1" } },
    { selections: { region: "west" } },
    { engineVersion: "0.1.1" },
  ]) {
    assert.throws(() => verifyToken(decoded, { ...binding, ...change }), (error) => error.exitCode === 27 && /does not match/.test(error.message), JSON.stringify(change));
  }
  assert.throws(() => verifyToken(decoded, { ...binding, commit: "b".repeat(40) }), /moved since the preview: previewed aaaaaaa, now bbbbbbb/);
  assert.throws(() => decodeToken(issued.value, Date.parse(issued.expiresAt), 10), /expired/);
  assert.throws(() => decodeToken(issued.value, now.getTime(), 5), /beyond the configured confirmTokenTtlMinutes \(5\)/);
});

test("D2: a tag ref is read with peelTags and resolves an annotated tag to its commit", async (t) => {
  const ado = await startAzureDevOps(t);
  ado.state.refs.set("acme-api", [{ name: "refs/tags/v1.0.0", objectId: "1".repeat(40), peeledObjectId: "2".repeat(40) }, { name: "refs/tags/v1.0.1", objectId: "3".repeat(40) }]);
  const reader = new AzureDevOpsReader({ organizationUrl: ado.base, timeoutMs: 1000, credential: new PatCredential(PAT), sleep: async () => {}, clock: () => 0 });
  assert.deepEqual(await reader.getRefHead(PROJECT, "acme-api", "refs/tags/v1.0.0"), { name: "refs/tags/v1.0.0", objectId: "2".repeat(40) });
  assert.deepEqual(await reader.getRefHead(PROJECT, "acme-api", "refs/tags/v1.0.1"), { name: "refs/tags/v1.0.1", objectId: "3".repeat(40) }, "a lightweight tag points at the commit");
  assert.equal(ado.hits("/refs")[0].query.peelTags, "true");
  assertOnlyGets(assert, ado);
});
