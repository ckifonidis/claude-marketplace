// The Azure DevOps read client, the PAT and the run-fact rules, in-process (spec requirements
// 16, 17, 29, 48, 49, 66, 73; plan D2, D7-D10; research §3.4-§3.10). The REST server is the local
// fake; every test that touches it asserts zero non-GET requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { AzureDevOpsReader, MAX_PAGES, parseBuild, retryAfterMs } from "../dist/pipelines/azure-devops-read.js";
import { determineAction, determinePushedTag, pipelineDrift, runFact, sourceCommitOf } from "../dist/pipelines/facts.js";
import { PatCredential, parseIsoInstant, patExpiry, readPat } from "../dist/pipelines/pat.js";
import { PAT, PROJECT, assertOnlyGets, build, startAzureDevOps } from "./fixtures/fake-azure-devops.mjs";
import { refusedPort } from "./fixtures/fake-app-server.mjs";
import { apiMapping } from "./fixtures/pipeline-fixtures.mjs";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const C = "c".repeat(40);

function reader(ado, { timeoutMs = 1000, pat = PAT } = {}) {
  const sleeps = [];
  let clock = 1_000_000;
  const client = new AzureDevOpsReader({
    organizationUrl: `${ado.base}/`,
    timeoutMs,
    credential: new PatCredential(pat),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    clock: () => clock,
  });
  return { client, sleeps };
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
// The mutation boundary (acceptance criterion 7(a))

test("7a/66: the read module can only send GET, and no engine module but the write module sends any other method", () => {
  const source = readFileSync(join(DIST, "pipelines", "azure-devops-read.js"), "utf8");
  const methods = [...source.matchAll(/method:\s*([^,\s}]+)/g)].map((match) => match[1]);
  assert.deepEqual(methods, ['"GET"'], "exactly one fetch, with the literal GET");
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1);
  assert.doesNotMatch(source, /"(?:POST|PUT|PATCH|DELETE)"/);
  for (const file of jsFiles(DIST)) {
    const text = readFileSync(file, "utf8");
    const name = file.split("/").pop();
    if (name !== "azure-devops-write.js") assert.doesNotMatch(text, /method:\s*"(?!GET"|HEAD")[A-Za-z]+"/, `${file}: a literal non-GET/HEAD method`);
    if (/\bfetch\(/.test(text)) assert.ok(["azure-devops-read.js", "azure-devops-write.js", "verify.js"].includes(name), `${file}: unexpected network call site`);
  }
});

// ---------------------------------------------------------------------------
// Classification (research §3.9) — in this order, before JSON is parsed

test("17/3.9: 401 / 403 / 203 HTML / 200 HTML / 302 / 404 HTML are auth (20); 404 JSON is not-found (23); redirects are never followed", async (t) => {
  const ado = await startAzureDevOps(t);
  const { client } = reader(ado);
  for (const mode of ["401", "403", "203-html", "200-html", "302", "404-html"]) {
    ado.state.failures = [];
    ado.fail(/pipelines\/101$/, mode);
    await rejectsWith(client.getPipeline(PROJECT, 101), 20, /Azure DevOps authentication failed .*This is NOT "no runs" or "not found"/);
  }
  ado.state.failures = [];
  ado.fail(/pipelines\/101$/, "404-json");
  await rejectsWith(client.getPipeline(PROJECT, 101), 23, /pipeline 101 does not exist in project "acme-project" \(Azure DevOps: TF400898: not found\)/);
  await rejectsWith(client.getBuild(PROJECT, 4242), 23, /run 4242 does not exist/);
  assert.equal(ado.hits("/login").length, 0, "the 302 Location was never requested");
  const wrong = reader(ado, { pat: "rr-wrong-synthetic" }).client;
  await rejectsWith(wrong.getPipeline(PROJECT, 101), 20, /HTTP 203/);
  assertOnlyGets(assert, ado);
});

test("29/3.9: 500, a timeout, DNS-like refusals and invalid JSON are source errors (21), never \"no runs\"", async (t) => {
  const ado = await startAzureDevOps(t, { slowMs: 1500 });
  const { client } = reader(ado, { timeoutMs: 300 });
  ado.fail(/pipelines\/101$/, "500", { times: 1 });
  await rejectsWith(client.getPipeline(PROJECT, 101), 21, /HTTP 500/);
  ado.fail(/pipelines\/101$/, "slow", { times: 1 });
  await rejectsWith(client.getPipeline(PROJECT, 101), 21, /no answer within 0\.3s \(timeout\)/);
  ado.fail(/build\/builds$/, "invalid-json", { times: 1 });
  await rejectsWith(client.listBuilds(PROJECT, 101, 5), 21, /not valid JSON/);
  const closed = new AzureDevOpsReader({ organizationUrl: `http://127.0.0.1:${await refusedPort()}/acme-org`, timeoutMs: 500, credential: new PatCredential(PAT), sleep: async () => {}, clock: () => 0 });
  await rejectsWith(closed.getPipeline(PROJECT, 101), 21, /connection refused|no answer/);
  assertOnlyGets(assert, ado);
});

test("3.10: 429 honours Retry-After (capped at 30 s) with ONE retry; a second 429 is 21; no header waits 1 s", async (t) => {
  const ado = await startAzureDevOps(t);
  const a = reader(ado);
  ado.fail(/pipelines\/101$/, "429", { times: 1, retryAfter: 2 });
  assert.equal((await a.client.getPipeline(PROJECT, 101)).name, "acme-api-ci");
  assert.deepEqual(a.sleeps, [2000]);
  const b = reader(ado);
  ado.fail(/pipelines\/101$/, "429", { times: 1, retryAfter: 120 });
  await b.client.getPipeline(PROJECT, 101);
  assert.deepEqual(b.sleeps, [30_000], "capped at 30 s");
  const c = reader(ado);
  ado.fail(/pipelines\/101$/, "429", { times: 2 });
  await rejectsWith(c.client.getPipeline(PROJECT, 101), 21, /rate-blocked .*TF400733.*after one retry/);
  assert.deepEqual(c.sleeps, [1000], "one retry, after the documented 1 s when no Retry-After is sent");
  assert.equal(retryAfterMs("1.5", 0), 1500);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(retryAfterMs("soon", 0), null);
  assert.equal(retryAfterMs(null, 0), null);
  assertOnlyGets(assert, ado);
});

test("3.10: a Retry-After on a 200 delays the NEXT request", async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.method);
    res.writeHead(200, { "content-type": "application/json", "retry-after": "3" });
    res.end(JSON.stringify({ id: 101, name: "acme-api-ci" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const sleeps = [];
  let clock = 0;
  const client = new AzureDevOpsReader({ organizationUrl: `http://127.0.0.1:${server.address().port}/acme-org`, timeoutMs: 1000, credential: new PatCredential(PAT), sleep: async (ms) => { sleeps.push(ms); clock += ms; }, clock: () => clock });
  await client.getPipeline(PROJECT, 101);
  assert.deepEqual(sleeps, [], "the first request is not delayed");
  await client.getPipeline(PROJECT, 101);
  assert.deepEqual(sleeps, [3000]);
  assert.deepEqual(seen, ["GET", "GET"]);
  assert.equal(client.requestCount, 2);
});

test("3.5: paging follows x-ms-continuationtoken; a list still paging after MAX_PAGES is 21 (never a \"not found\")", async (t) => {
  const pipelines = Array.from({ length: MAX_PAGES + 5 }, (_, i) => ({ id: 300 + i, name: `p-${i}` }));
  const ado = await startAzureDevOps(t, { pipelines, pageSize: 1 });
  const { client } = reader(ado);
  await rejectsWith(client.findPipelinesByName(PROJECT, "p-24"), 21, new RegExp(`more than ${MAX_PAGES} pages`));
  assert.equal(ado.hits("/_apis/pipelines").length, MAX_PAGES);
  ado.state.pageSize = 10;
  const found = await client.findPipelinesByName(PROJECT, "p-24");
  assert.deepEqual(found.map((p) => p.id), [324]);
  assertOnlyGets(assert, ado);
});

test("D2/3.8: Git Refs head, timeline records and pending approvals (display names only)", async (t) => {
  const ado = await startAzureDevOps(t, { builds: [build({ id: 105, commit: C })] });
  ado.state.refs.set("acme-api", [{ name: "refs/heads/main", objectId: "A".repeat(40) }, { name: "refs/heads/main-old", objectId: "b".repeat(40) }]);
  const { client } = reader(ado);
  assert.deepEqual(await client.getRefHead(PROJECT, "acme-api", "refs/heads/main"), { name: "refs/heads/main", objectId: "a".repeat(40) });
  assert.equal(ado.hits("/refs")[0].query.filter, "heads/main");
  assert.equal(await client.getRefHead(PROJECT, "acme-api", "refs/heads/release"), null);
  await rejectsWith(client.getRefHead(PROJECT, "acme-nope", "refs/heads/main"), 23, /repository "acme-nope" does not exist/);
  assert.deepEqual(await client.getBuildTimeline(PROJECT, 105), [], "no timeline yet");
  ado.state.timelines.set(105, [{ id: "x", type: "Checkpoint.Approval", name: "Checkpoint.Approval", state: "pending" }, { bogus: true }]);
  assert.deepEqual((await client.getBuildTimeline(PROJECT, 105)).map((r) => r.id), ["x"]);
  ado.state.approvals = [{ id: "x", status: "pending", minRequiredApprovers: 2, steps: [{ assignedApprover: { displayName: "Approver One", uniqueName: "one@example.com" } }, { assignedApprover: { displayName: "Approver One" } }] }];
  const approvals = await client.listPendingApprovals(PROJECT, ["x"]);
  assert.deepEqual(approvals, [{ id: "x", status: "pending", approvers: ["Approver One"], minRequiredApprovers: 2 }]);
  assert.doesNotMatch(JSON.stringify(approvals), /example\.com/);
  assertOnlyGets(assert, ado);
});

test("3.6: sourceVersion is accepted only as 40 or 64 hex characters (lower-cased); a shape error in a build is 21", () => {
  const b = (sourceVersion) => parseBuild(build({ id: 1, commit: sourceVersion }), "t");
  assert.deepEqual(sourceCommitOf(b("AB".repeat(20))), { status: "determined", sha: "ab".repeat(20), shortSha: "abababa" });
  assert.equal(sourceCommitOf(b("a".repeat(64))).status, "determined", "SHA-256 repositories");
  for (const value of ["abc1234", "z".repeat(40), "a".repeat(41), undefined]) assert.equal(sourceCommitOf(b(value)).status, "undetermined", String(value));
  assert.throws(() => parseBuild({ status: "completed" }, "GET run"), (error) => error.exitCode === 21 && /unexpected response shape/.test(error.message));
  const scalars = parseBuild({ id: 2, status: "completed", templateParameters: { a: "x", b: 3, c: true, d: { nested: 1 } } }, "t");
  assert.deepEqual(scalars.templateParameters, { a: "x", b: "3", c: "true" });
});

// ---------------------------------------------------------------------------
// Action and pushed tag (48, D10)

test("48: the action is determined only by an exact match of an action's literal parameters; otherwise undetermined", () => {
  const mapping = apiMapping();
  assert.equal(determineAction(mapping, { action: "build", imageTag: "x" }).name, "build");
  assert.equal(determineAction(mapping, { action: "configure" }).kind, "configuration");
  assert.equal(determineAction(mapping, { action: "deploy" }).status, "undetermined");
  assert.equal(determineAction(mapping, null).status, "undetermined");
  const single = { ...mapping, actions: { build: { kind: "build", parameters: {} } }, primaryAction: "build" };
  assert.deepEqual([determineAction(single, null).status, determineAction(single, null).name], ["determined", "build"], "a single action with no literal parameter determines every run");
  const ambiguous = { ...mapping, actions: { a: { kind: "build", parameters: {} }, b: { kind: "configuration", parameters: {} } } };
  assert.match(determineAction(ambiguous, {}).detail, /ambiguous: declared actions a, b/);
  const templated = { ...mapping, actions: { build: { kind: "build", parameters: { action: "build", imageTag: "{commit.shortSha}" } } } };
  assert.equal(determineAction(templated, { action: "build", imageTag: "anything" }).name, "build", "placeholder-bearing parameters are not compared");
});

test("D10: pushed tag — parameter first, then pushedTagTemplate, else undetermined; a configuration run pushes none", () => {
  const ctx = { component: "acme-api", target: "api" };
  const both = { ...apiMapping(), pushedTagTemplate: "{commit.sha}" };
  const fact = (mapping, params, commit = C) => runFact(mapping, parseBuild(build({ id: 9, commit, params }), "t"), ctx).pushedTag;
  assert.deepEqual(fact(both, { action: "build", imageTag: "tag-1" }), { status: "parameter", value: "tag-1", detail: "templateParameters.imageTag" });
  assert.deepEqual([fact(both, { action: "build", imageTag: " " }).status, fact(both, { action: "build", imageTag: " " }).value], ["convention", C], "an empty parameter value falls to the template");
  assert.deepEqual([fact(both, undefined).status, fact(both, undefined).value], ["convention", C]);
  assert.equal(fact(apiMapping(), undefined).status, "undetermined");
  assert.equal(fact(both, { action: "configure", imageTag: "tag-1" }).status, "not-applicable");
  const commit = sourceCommitOf(parseBuild(build({ id: 9, commit: C }), "t"));
  const action = determineAction(apiMapping(), null);
  assert.equal(determinePushedTag({ ...apiMapping(), imageTagParameter: undefined, pushedTagTemplate: "{target}-{commit.shortSha}" }, parseBuild(build({ id: 9, commit: C }), "t"), commit, action, ctx).value, "api-ccccccc");
});

test("49: drift with no clone still reports X ≠ Y (relation unknown); nothing resolved → unknown, never a finding", () => {
  const mapping = apiMapping();
  const runs = [runFact(mapping, parseBuild(build({ id: 5, commit: C, params: { action: "build", imageTag: "x" } }), "t"), { component: "c", target: "t" })];
  const base = { component: "c", stage: "s", target: "t", runs, targetFound: true, clone: null, timeoutMs: 1000 };
  const resolved = (sha) => ({ status: "resolved", sha, date: "2026-11-20T00:00:00Z", subject: "x", headRelation: { relation: "at-head" } });
  const drift = pipelineDrift({ ...base, targetCommit: resolved("d".repeat(40)) });
  assert.deepEqual([drift.status, drift.relation], ["drift", "unknown"]);
  assert.match(drift.detail, /no local clone/);
  assert.equal(pipelineDrift({ ...base, targetCommit: resolved(C.toUpperCase()) }).status, "in-sync", "commit comparison ignores case");
  assert.equal(pipelineDrift({ ...base, targetCommit: { status: "tag-not-found", detail: "x" } }).status, "unknown");
  assert.equal(pipelineDrift({ ...base, targetFound: false, targetCommit: null }).status, "unknown");
  assert.equal(pipelineDrift({ ...base, runs: [], targetCommit: resolved(C) }).status, "no-succeeded-build");
});

// ---------------------------------------------------------------------------
// PAT (16, 73)

test("16/73: the credential never serialises the token; readPat refuses absent, empty and non-header-safe values without echoing", () => {
  const credential = new PatCredential(PAT);
  const basic = Buffer.from(`:${PAT}`).toString("base64");
  assert.equal(credential.authorization(), `Basic ${basic}`);
  for (const text of [JSON.stringify({ credential }), String(credential), `${credential}`, inspect(credential, { showHidden: true, depth: 5 })]) {
    assert.ok(!text.includes(PAT) && !text.includes(basic), text);
  }
  const now = new Date("2026-11-25T00:00:00Z");
  for (const [env, message] of [[{}, /is not set/], [{ AZURE_DEVOPS_EXT_PAT: "" }, /is empty/], [{ AZURE_DEVOPS_EXT_PAT: "two words" }, /characters a PAT cannot contain/], [{ AZURE_DEVOPS_EXT_PAT: "tokén" }, /characters a PAT cannot contain/]]) {
    assert.throws(() => readPat(env, 14, now), (error) => error.exitCode === 20 && message.test(error.message) && !error.message.includes("two words") && !error.message.includes("tokén"));
  }
  const ok = readPat({ AZURE_DEVOPS_EXT_PAT: ` ${PAT} ` }, 14, now);
  assert.equal(ok.credential.authorization(), `Basic ${basic}`, "surrounding whitespace is trimmed");
  assert.equal(ok.expiry.declared, false);
});

test("16: AZURE_DEVOPS_PAT_EXPIRES — ISO-8601 dates and date-times, days floored, warning at ≤ patExpiryWarningDays, past/unparseable → 20", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  assert.equal(parseIsoInstant("2026-12-01")?.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(parseIsoInstant("2026-12-01T10:00:00+02:00")?.toISOString(), "2026-12-01T08:00:00.000Z");
  for (const bad of ["2026-02-31", "2026-13-01", "01/12/2026", "2026-12-01T10:00", "tomorrow", ""]) assert.equal(parseIsoInstant(bad), null, bad);
  const at = (value, warn = 14) => patExpiry({ AZURE_DEVOPS_PAT_EXPIRES: value }, warn, now);
  assert.deepEqual([at("2026-12-09T12:00:00Z").daysRemaining, at("2026-12-09T12:00:00Z").warning], [14, true], "exactly the window → warning");
  assert.deepEqual([at("2026-12-10T12:00:01Z").daysRemaining, at("2026-12-10T12:00:01Z").warning], [15, false]);
  assert.equal(at("2026-11-26").daysRemaining, 0);
  assert.throws(() => at("2026-11-25T12:00:00Z"), (error) => error.exitCode === 20 && /expired/.test(error.message));
  assert.throws(() => at("2025-01-01"), (error) => error.exitCode === 20);
  assert.throws(() => at("in a week"), (error) => error.exitCode === 20 && !error.message.includes("in a week"));
});
