// Real-world verification (spec requirements 15, 16, 20, 40-45, 50, 71, 73, 76 "Verification";
// acceptance criteria 6, 9, 10, 11, 17). Applications are a local fake HTTP server on 127.0.0.1;
// smoke commands are fake shims; nothing real is ever contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickExitCode } from "../dist/errors.js";
import { classify } from "../dist/format.js";
import { SNAPSHOT_SCHEMA } from "../dist/snapshot.js";
import {
  assertReadOnlyMethod,
  commitsMatch,
  extractVersion,
  httpProbe,
  isValidHeaderValue,
  overallOutcome,
  parseCheckList,
  verificationExitCode,
  versionsMatch,
} from "../dist/verify.js";
import { ref, runCliAsync, snapshotFiles, snapshotText } from "./fixtures/cli-harness.mjs";
import { assertOnlyReadMethods, refusedPort, startApp } from "./fixtures/fake-app-server.mjs";
import { block, byName, httpCheck, installSmoke, smokeCheck, verifyFleet, versionCheck } from "./fixtures/verify-fixtures.mjs";

const SECRET = "rr-header-value-7f3c9a1e";

// ---------------------------------------------------------------------------
// Units: comparison, extraction, method rule, exit mapping

test("42: commit comparison — one a hex prefix of the other, shorter ≥ 7 characters, both directions", () => {
  const full = "3f2a9c1d4e5b6a7980c1d2e3f4a5b6c7d8e9f001";
  assert.equal(commitsMatch(full, "3f2a9c1"), true, "short extracted vs full expected");
  assert.equal(commitsMatch("3f2a9c1", full), true, "full extracted vs short expected");
  assert.equal(commitsMatch(full, full), true);
  assert.equal(commitsMatch(full.toUpperCase(), "3f2a9c1"), true, "hex is case-insensitive");
  assert.equal(commitsMatch(full, "3f2a9c"), false, "6 characters is too short");
  assert.equal(commitsMatch("3f2a9c", full), false, "too short in the other direction too");
  assert.equal(commitsMatch(full, "3f2a9c2"), false, "not a prefix");
  assert.equal(commitsMatch("3f2a9c1-dirty", full), false, "non-hex never matches");
  assert.equal(commitsMatch("3f2a9c1", "3f2a9c1"), true);
});

test("42: tag comparison is exact string equality", () => {
  assert.equal(versionsMatch("tag", "1.0.0", "1.0.0"), true);
  assert.equal(versionsMatch("tag", "v1.0.0", "1.0.0"), false);
  assert.equal(versionsMatch("tag", "1.0.0 ", "1.0.0"), false);
  assert.equal(versionsMatch("tag", "RC1", "rc1"), false);
  assert.equal(versionsMatch("commit", "3f2a9c1", "3f2a9c1d4e"), true);
});

test("40: version extraction by JSON path and by the named regex group; misses are reported, never guessed", () => {
  assert.deepEqual(extractVersion({ type: "json-path", path: "$.build.commit" }, '{"build":{"commit":"3f2a9c1"}}'), { value: "3f2a9c1" });
  assert.deepEqual(extractVersion({ type: "json-path", path: "$.items[1]" }, '{"items":[1, 42]}'), { value: "42" });
  assert.match(extractVersion({ type: "json-path", path: "$.build.commit" }, "not json").problem, /not JSON/);
  assert.match(extractVersion({ type: "json-path", path: "$.build.commit" }, '{"build":{}}').problem, /nothing at \$\.build\.commit/);
  assert.match(extractVersion({ type: "json-path", path: "$.build" }, '{"build":{"x":1}}').problem, /not a string or a number/);
  assert.deepEqual(extractVersion({ type: "regex", pattern: "version=(?<version>[0-9.]+)" }, "app ok\nversion=1.2.3\n"), { value: "1.2.3" });
  assert.match(extractVersion({ type: "regex", pattern: "version=(?<version>[0-9.]+)" }, "nothing here").problem, /matched nothing/);
  assert.match(extractVersion({ type: "json-path", path: "$.v" }, JSON.stringify({ v: "x".repeat(201) })).problem, /longer than 200/);
});

test("15: only GET and HEAD can ever be sent — any other method is an internal error before a request", async (t) => {
  const app = await startApp(t, { "/x": { status: 200 } });
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "get"]) {
    assert.throws(() => assertReadOnlyMethod(method), (error) => error.exitCode === 1 && /only GET and HEAD/.test(error.message));
    await assert.rejects(httpProbe({ url: app.url("/x"), method, headers: {}, timeoutMs: 1000, readBody: false, maxBodyBytes: 0 }), (error) => error.exitCode === 1);
  }
  assert.equal(app.requests.length, 0, "no request reached the server");
  assert.doesNotThrow(() => assertReadOnlyMethod("GET"));
  assert.doesNotThrow(() => assertReadOnlyMethod("HEAD"));
});

test("41/D5: outcome → exit mapping: FAIL 28, UNREACHABLE/INCONCLUSIVE without FAIL 30, NOT-RUN never counts", () => {
  const r = (outcome) => ({ outcome });
  assert.equal(verificationExitCode([r("PASS"), r("PASS")]), 0);
  assert.equal(verificationExitCode([r("PASS"), r("FAIL")]), 28);
  assert.equal(verificationExitCode([r("UNREACHABLE")]), 30, "UNREACHABLE-only is inconclusive, never 28");
  assert.equal(verificationExitCode([r("UNREACHABLE"), r("UNREACHABLE"), r("PASS")]), 30);
  assert.equal(verificationExitCode([r("INCONCLUSIVE"), r("PASS")]), 30);
  assert.equal(verificationExitCode([r("UNREACHABLE"), r("FAIL")]), 28);
  assert.equal(verificationExitCode([r("NOT-RUN")]), 0);
  assert.equal(verificationExitCode([]), 0);
  assert.equal(overallOutcome([r("NOT-RUN")]), "NO-CHECKS");
  assert.equal(overallOutcome([r("UNREACHABLE")]), "INCONCLUSIVE");
});

test("20: precedence — 23 + 28 → 23, 28 + 30 → 28, 30 + 22 → 30, 20 + 26 → 20, 26 + 28 → 26", () => {
  assert.equal(pickExitCode([23, 28]), 23);
  assert.equal(pickExitCode([28, 30]), 28);
  assert.equal(pickExitCode([30, 22]), 30);
  assert.equal(pickExitCode([22, 30, 28, 23]), 23);
  assert.equal(pickExitCode([26, 20]), 20);
  assert.equal(pickExitCode([28, 26]), 26);
});

test("16: header values must be non-empty and free of control characters; --check lists are strict", () => {
  assert.equal(isValidHeaderValue("abc-123 =+/"), true);
  assert.equal(isValidHeaderValue("a\r\nInjected: x"), false);
  assert.equal(isValidHeaderValue("a\u0000b"), false);
  assert.deepEqual(parseCheckList("health,version"), ["health", "version"]);
  assert.throws(() => parseCheckList("health,,version"), (error) => error.exitCode === 64);
  assert.throws(() => parseCheckList("health,health"), (error) => error.exitCode === 64 && /more than once/.test(error.message));
  assert.throws(() => parseCheckList("Health"), (error) => error.exitCode === 64);
});

// ---------------------------------------------------------------------------
// verify: PASS / FAIL / UNREACHABLE end to end

test("41: verify PASS — GET and HEAD status checks plus a commit version check against the live status read (exit 0)", async (t) => {
  const app = await startApp(t);
  const fx = verifyFleet(t, {
    blocks: {
      "stage-1": block([
        httpCheck("health", app.url("/health")),
        httpCheck("ready", app.url("/ready"), { method: "HEAD", expectStatus: [200, 204] }),
        versionCheck("version", app.url("/version"), { target: "api" }),
      ]),
    },
  });
  app.route("/health", { status: 200, json: { ok: true, detail: "BODY-MUST-NOT-SURFACE" } });
  app.route("/ready", { status: 204 });
  app.route("/version", { status: 200, json: { build: { commit: fx.short.c4 }, note: "BODY-MUST-NOT-SURFACE" } });
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.command, "verify");
  assert.equal(r.json.expectedVersionSource, "status");
  assert.equal(r.json.verification.outcome, "PASS");
  const results = byName(r.json);
  assert.deepEqual(Object.keys(results), ["health", "ready", "version"], "checks run in canonical (name) order");
  assert.equal(results.health.outcome, "PASS");
  assert.equal(results.health.httpStatus, 200);
  assert.equal(typeof results.health.latencyMs, "number");
  assert.equal(results.health.extracted, null);
  assert.equal(results.ready.outcome, "PASS");
  assert.equal(results.ready.httpStatus, 204);
  assert.equal(results.version.outcome, "PASS");
  assert.equal(results.version.extracted, fx.short.c4, "the 7-character value the application reports");
  assert.deepEqual(results.version.expected, { value: fx.commits.c4, source: "status" }, "the full commit the target is reported to run");
  assert.deepEqual(Object.keys(results.version), ["component", "stage", "name", "type", "target", "outcome", "httpStatus", "exitCode", "latencyMs", "extracted", "expected", "reason"]);
  assert.deepEqual(app.requests.map((request) => `${request.method} ${request.path}`), ["GET /health", "HEAD /ready", "GET /version"]);
  assertOnlyReadMethods(assert, app);
  assert.doesNotMatch(r.out, /BODY-MUST-NOT-SURFACE/, "response bodies are never printed");
  assert.equal(fx.h.calls("acme-deploy").length, 1, "one read-only status read of the one stage-1 target");
  assert.equal(snapshotFiles(fx.platform).length, 0, "verify writes no snapshot (status does)");
  const human = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1"]);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /PASS +version +\[version, target api · HTTP 200 · \d+ ms · reports [0-9a-f]{7} · expected [0-9a-f]{40} \(status\)\]/);
});

test("41: FAIL on a status mismatch and on a version mismatch → exit 28", async (t) => {
  const app = await startApp(t);
  const fx = verifyFleet(t, { blocks: { "stage-1": block([httpCheck("health", app.url("/health"), { expectStatus: [200, 204] }), versionCheck("version", app.url("/version"))]) } });
  app.route("/health", { status: 503 });
  app.route("/version", { status: 200, json: { build: { commit: fx.short.c4 } } });
  const status = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(status.status, 28, status.out);
  assert.equal(status.phase, "verification");
  assert.equal(byName(status.json).health.outcome, "FAIL");
  assert.equal(byName(status.json).health.httpStatus, 503);
  assert.match(byName(status.json).health.reason, /answered HTTP 503, expected 200 or 204/);
  assert.equal(byName(status.json).version.outcome, "PASS");

  app.route("/health", { status: 200 });
  app.route("/version", { status: 200, json: { build: { commit: fx.short.c3 } } });
  const version = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(version.status, 28);
  const v = byName(version.json).version;
  assert.equal(v.outcome, "FAIL");
  assert.equal(v.extracted, fx.short.c3);
  assert.match(v.reason, /version mismatch/);
  assert.match(version.stderr, /verification FAILED/);
  assertOnlyReadMethods(assert, app);
});

test("41/42: a version endpoint that answers non-2xx or without a version is FAIL, not UNREACHABLE", async (t) => {
  const app = await startApp(t);
  const fx = verifyFleet(t, { blocks: { "stage-1": block([versionCheck("version", app.url("/version"))]) } });
  for (const [route, pattern] of [
    [{ status: 500, json: { build: { commit: "x" } } }, /answered HTTP 500/],
    [{ status: 200, text: "<html>maintenance</html>" }, /not JSON/],
    [{ status: 200, json: { build: {} } }, /nothing at \$\.build\.commit/],
  ]) {
    app.route("/version", route);
    const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
    assert.equal(r.status, 28, r.out);
    assert.equal(byName(r.json).version.outcome, "FAIL");
    assert.match(byName(r.json).version.reason, pattern);
    assert.doesNotMatch(r.out, /maintenance/, "the body is never echoed");
  }
});

test("41: UNREACHABLE — connection refused, timeout and connection reset; UNREACHABLE-only exits 30, never 28", async (t) => {
  const app = await startApp(t);
  const refused = await refusedPort();
  const fx = verifyFleet(t, {
    blocks: {
      "stage-1": block(
        [
          httpCheck("refused", `http://127.0.0.1:${refused}/health`),
          httpCheck("reset", app.url("/reset")),
          httpCheck("slow", app.url("/slow"), { timeoutSeconds: 1 }),
        ],
        5,
      ),
    },
  });
  app.route("/slow", { status: 200, delayMs: 2500 });
  app.route("/reset", { reset: true });
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(r.status, 30, r.out);
  assert.equal(r.phase, "verification");
  const results = byName(r.json);
  for (const name of ["refused", "reset", "slow"]) {
    assert.equal(results[name].outcome, "UNREACHABLE", name);
    assert.equal(results[name].httpStatus, null, `${name}: no answer, no status`);
  }
  assert.match(results.refused.reason, /connection refused/);
  assert.match(results.slow.reason, /no answer within 1s \(timeout\)/, "the check's own timeoutSeconds overrides the block's");
  assert.ok(results.slow.latencyMs >= 900 && results.slow.latencyMs < 2400, `timed out near 1s, got ${results.slow.latencyMs}`);
  assert.match(results.reset.reason, /connection closed before an answer|no answer/);
  assert.equal(r.json.verification.outcome, "INCONCLUSIVE");
  assert.match(r.stderr, /inconclusive — no check FAILED/);
  assert.doesNotMatch(r.out, /FAILED \(/);
  assertOnlyReadMethods(assert, app);
});

test("41: UNREACHABLE plus FAIL → 28 (FAIL decides); the UNREACHABLE check is still reported as UNREACHABLE", async (t) => {
  const app = await startApp(t, { "/health": { status: 500 } });
  const refused = await refusedPort();
  const fx = verifyFleet(t, { blocks: { "stage-1": block([httpCheck("down", `http://127.0.0.1:${refused}/x`), httpCheck("health", app.url("/health"))]) } });
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(r.status, 28);
  assert.equal(byName(r.json).down.outcome, "UNREACHABLE");
  assert.equal(byName(r.json).health.outcome, "FAIL");
});

test("40: redirects are not followed — a 3xx is just a status (FAIL unless expected, PASS when listed)", async (t) => {
  const app = await startApp(t, { "/old": { status: 302, headers: { location: "/new" } }, "/new": { status: 200 } });
  const fx = verifyFleet(t, { blocks: { "stage-1": block([httpCheck("moved", app.url("/old")), httpCheck("moved-ok", app.url("/old"), { expectStatus: [301, 302] })]) } });
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(r.status, 28);
  assert.equal(byName(r.json).moved.outcome, "FAIL");
  assert.equal(byName(r.json).moved.httpStatus, 302);
  assert.match(byName(r.json).moved.reason, /redirects are not followed/);
  assert.equal(byName(r.json)["moved-ok"].outcome, "PASS");
  assert.deepEqual(app.requests.map((request) => request.path), ["/old", "/old"], "the Location was never requested");
});

// ---------------------------------------------------------------------------
// Expected version: --expect, tag comparison, unknown → INCONCLUSIVE

test("42: --expect supplies the expected version (no status read, no adapter call); a mismatch FAILs; a non-sha for a commit check → 64 before any request", async (t) => {
  const app = await startApp(t);
  const fx = verifyFleet(t, { blocks: { "stage-1": block([versionCheck("version", app.url("/version"))]) } });
  app.route("/version", { status: 200, json: { build: { commit: fx.commits.c3 } } });
  const ok = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--expect", fx.short.c3, "--json"]);
  assert.equal(ok.status, 0, ok.out);
  assert.equal(ok.json.expectedVersionSource, "expect");
  assert.deepEqual(byName(ok.json).version.expected, { value: fx.short.c3, source: "expect" });
  assert.equal(fx.h.calls("acme-deploy").length, 0, "with --expect no deployment source is read");
  const bad = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--expect", fx.short.c4, "--json"]);
  assert.equal(bad.status, 28);
  assert.equal(byName(bad.json).version.outcome, "FAIL");
  const before = app.requests.length;
  const tag = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--expect", "v1.0.0"]);
  assert.equal(tag.status, 64);
  assert.match(tag.stderr, /--expect "v1\.0\.0" is not a commit sha .* check "version" compares commits/);
  assert.equal(app.requests.length, before, "zero requests on 64");
});

test("42: compare tag — the image tag the target is reported to run, exact equality; HTTP/version checks run on stages not owned", async (t) => {
  const app = await startApp(t);
  const fx = verifyFleet(t, { blocks: { "stage-3": block([versionCheck("version", app.url("/version"), { extract: { type: "regex", pattern: "release (?<version>\\S+)" }, compare: "tag" })]) } });
  app.route("/version", { status: 200, text: "acme-api release 1.0.0 built today\n" });
  const pass = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-3", "--json"]);
  assert.equal(pass.status, 0, pass.out);
  assert.deepEqual(byName(pass.json).version.expected, { value: "1.0.0", source: "status" });
  assert.equal(byName(pass.json).version.extracted, "1.0.0");
  app.route("/version", { status: 200, text: "acme-api release v1.0.0\n" });
  const fail = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-3", "--json"]);
  assert.equal(fail.status, 28, "v1.0.0 ≠ 1.0.0: tags compare exactly");
  assert.match(byName(fail.json).version.reason, /exact equality/);
});

test("42 (decision): an expected version that cannot be determined → INCONCLUSIVE (exit 30) with the extracted value recorded, never PASS or FAIL", async (t) => {
  const app = await startApp(t);
  const fx = verifyFleet(t, {
    targets: { "stage-1": ["api", "api-internal"], "stage-2": null, "stage-3": null },
    blocks: { "stage-1": block([versionCheck("version", app.url("/version")), versionCheck("version-internal", app.url("/version"), { target: "api-internal" })]) },
    images: (defaults, fixture) => ({ ...defaults, "stage-1/api-internal": ref("api", fixture.short.c3) }),
  });
  app.route("/version", { status: 200, json: { build: { commit: fx.short.c3 } } });
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(r.status, 30, r.out);
  const stageWide = byName(r.json).version;
  assert.equal(stageWide.outcome, "INCONCLUSIVE");
  assert.match(stageWide.reason, /^expected version unknown: the stage's targets run different versions \(api → [0-9a-f]{7}; api-internal → [0-9a-f]{7}\)/);
  assert.equal(stageWide.extracted, fx.short.c3, "what the application reports is still recorded");
  assert.equal(stageWide.expected, null);
  assert.equal(byName(r.json)["version-internal"].outcome, "PASS", "a check narrowed to one target has a known expected version");
  assert.equal(r.json.verification.summary.inconclusive, 1);
});

// ---------------------------------------------------------------------------
// Headers from env vars

test("16/43/73: a header from a named env var is sent with that value, yet the value never appears in stdout, stderr or the snapshot", async (t) => {
  const app = await startApp(t, { "/health": { status: 200 } });
  const fx = verifyFleet(t, { blocks: { "stage-1": block([httpCheck("health", app.url("/health"), { headers: { "X-Acme-Key": { env: "ACME_VERIFY_KEY" } } })]) } });
  const env = { ...fx.h.env, ACME_VERIFY_KEY: SECRET };
  const verify = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"], { env });
  assert.equal(verify.status, 0, verify.out);
  assert.ok(app.requests[0].headerNames.includes("x-acme-key"), "the server saw the header name");
  assert.equal(app.requests[0].headers["x-acme-key"], SECRET, "…carrying exactly the env var's value");
  const human = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1"], { env });
  const status = await runCliAsync(assert, fx.h, ["status", ...fx.ws, "acme-api", "--verify", "--json"], { env });
  assert.equal(status.status, 0, status.out);
  const [snapshot] = snapshotFiles(fx.platform);
  for (const text of [verify.out, human.out, status.out, snapshotText(fx.platform, snapshot)]) {
    assert.ok(!text.includes(SECRET), "the header value never surfaces");
  }
  assert.equal(app.requests.length, 3);
  assertOnlyReadMethods(assert, app);
});

test("16/18: a missing (or empty) header env var → exit 20 before ANY check or source call — zero requests, no report, no snapshot", async (t) => {
  const app = await startApp(t, { "/health": { status: 200 }, "/version": { status: 200, json: { build: { commit: "0000000" } } } });
  const fx = verifyFleet(t, {
    blocks: {
      "stage-1": block([
        httpCheck("health", app.url("/health")),
        versionCheck("version", app.url("/version"), { headers: { "X-Acme-Key": { env: "ACME_VERIFY_KEY" } } }),
      ]),
    },
  });
  for (const env of [fx.h.env, { ...fx.h.env, ACME_VERIFY_KEY: "" }]) {
    for (const args of [["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"], ["status", ...fx.ws, "acme-api", "--verify", "--json"]]) {
      const r = await runCliAsync(assert, fx.h, args, { env });
      assert.equal(r.status, 20, r.out);
      assert.equal(r.phase, "preflight");
      assert.match(r.stderr, /ACME_VERIFY_KEY is (not set|empty) \(needed by acme-api\/stage-1\/version header X-Acme-Key\)/);
      assert.match(r.stderr, /NOT a verification failure/);
      assert.equal(r.stdout, "", "no partial report");
    }
  }
  assert.equal(app.requests.length, 0, "not even the header-free check ran");
  assert.equal(fx.h.calls().length, 0, "no adapter was preflighted or read");
  assert.equal(snapshotFiles(fx.platform).length, 0);
});

// ---------------------------------------------------------------------------
// Smoke commands and stage ownership (D3, requirement 40a)

test("40/41: smoke on an owned stage — exit 0 PASS, non-zero FAIL, not found / timeout UNREACHABLE; output never surfaces", async (t) => {
  const fx = verifyFleet(t, {
    blocks: {
      "stage-1": block([
        smokeCheck("smoke-bad", ["acme-smoke", "bad"]),
        smokeCheck("smoke-missing", ["acme-smoke-absent", "ok"]),
        smokeCheck("smoke-ok", ["acme-smoke", "ok"]),
        smokeCheck("smoke-slow", ["acme-smoke", "slow"], { timeoutSeconds: 1 }),
      ]),
    },
  });
  installSmoke(fx.h);
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(r.status, 28, r.out);
  const results = byName(r.json);
  assert.equal(results["smoke-ok"].outcome, "PASS");
  assert.equal(results["smoke-ok"].exitCode, 0);
  assert.equal(results["smoke-bad"].outcome, "FAIL");
  assert.equal(results["smoke-bad"].exitCode, 3);
  assert.equal(results["smoke-missing"].outcome, "UNREACHABLE");
  assert.match(results["smoke-missing"].reason, /command not found: `acme-smoke-absent`/);
  assert.equal(results["smoke-slow"].outcome, "UNREACHABLE");
  assert.match(results["smoke-slow"].reason, /timeout/);
  assert.doesNotMatch(r.out, /MUST-NOT-SURFACE/, "command output beyond the exit code is never printed");
  assert.deepEqual(fx.h.calls("acme-smoke").map((call) => call.args), [["bad"], ["ok"], ["slow"]], "argv passed verbatim, no shell");
  assert.equal(fx.h.calls("acme-deploy").length, 0, "no version check → no status read");
  // Without the failing command: UNREACHABLE-only smoke results → 30.
  const unreachable = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--check", "smoke-missing,smoke-ok", "--json"]);
  assert.equal(unreachable.status, 30);
});

test("40a/D3: on a stage not owned by operatorTeam a smoke check is \"not run (stage not owned)\" and never started; an explicit request → 26 with nothing run", async (t) => {
  const app = await startApp(t, { "/health": { status: 200 } });
  const fx = verifyFleet(t, { blocks: { "stage-2": block([httpCheck("health", app.url("/health")), smokeCheck("smoke-ok", ["acme-smoke", "ok"])]) } });
  installSmoke(fx.h);
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-2", "--json"]);
  assert.equal(r.status, 0, "NOT-RUN never affects the exit code");
  assert.equal(byName(r.json).health.outcome, "PASS", "HTTP checks do run on a stage not owned");
  assert.equal(byName(r.json)["smoke-ok"].outcome, "NOT-RUN");
  assert.equal(byName(r.json)["smoke-ok"].reason, "not run (stage not owned)");
  assert.equal(byName(r.json)["smoke-ok"].exitCode, null);
  assert.equal(r.json.verification.blocks[0].smoke, "not-run-stage-not-owned");
  assert.equal(fx.h.calls("acme-smoke").length, 0, "the smoke command was never started");
  const human = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-2"]);
  assert.match(human.stdout, /NOT-RUN +smoke-ok .*not run \(stage not owned\)/);

  const requests = app.requests.length;
  const refused = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-2", "--check", "health,smoke-ok"]);
  assert.equal(refused.status, 26, refused.out);
  assert.equal(refused.phase, "refused");
  assert.match(refused.stderr, /smoke commands run only on stages owned by the operator's team/);
  assert.match(refused.stderr, /stage "stage-2" is owned by "qa-team"/);
  assert.equal(app.requests.length, requests, "26 is decided before any check: not even the HTTP check ran");
  assert.equal(fx.h.calls("acme-smoke").length, 0);
  // status --verify never requests a smoke explicitly: it reports NOT-RUN (exit 0) and writes a snapshot.
  const status = await runCliAsync(assert, fx.h, ["status", ...fx.ws, "acme-api", "--stage", "stage-2", "--verify", "--json"]);
  assert.equal(status.status, 0, status.out);
  assert.equal(byName(status.json)["smoke-ok"].outcome, "NOT-RUN");
  assert.equal(fx.h.calls("acme-smoke").length, 0);
});

// ---------------------------------------------------------------------------
// Selection, arguments, nothing configured

test("12/14: verify arguments — --stage required, one component for --target/--expect/--check, unknown names → 64 with zero requests", async (t) => {
  const app = await startApp(t, { "/health": { status: 200 } });
  const fx = verifyFleet(t, { blocks: { "stage-1": block([httpCheck("health", app.url("/health"))]) } });
  const cases = [
    [["verify", ...fx.ws, "acme-api"], /"verify" requires --stage <name>/],
    [["verify", ...fx.ws, "--stage", "stage-1"], /verify needs a component name/],
    [["verify", ...fx.ws, "acme-api", "acme-worker", "--stage", "stage-1", "--expect", "abcdef1"], /--expect needs exactly one component/],
    [["verify", ...fx.ws, "acme-api", "acme-worker", "--stage", "stage-1", "--target", "api"], /--target needs exactly one component/],
    [["verify", ...fx.ws, "acme-nope", "--stage", "stage-1"], /unknown component "acme-nope"/],
    [["verify", ...fx.ws, "acme-api", "--stage", "stage-9"], /unknown stage "stage-9"/],
    [["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--target", "nope"], /unknown target "nope" for acme-api \/ stage-1 \(targets: api\)/],
    [["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--check", "nope"], /unknown check "nope" for acme-api \/ stage-1 \(checks: health\)/],
    [["verify", ...fx.ws, "acme-api", "--stage", "stage-2", "--check", "health"], /unknown check "health" .*no real-world verification configured/],
    [["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--verify"], /unknown flag "--verify" for "verify"/],
  ];
  for (const [args, message] of cases) {
    const r = await runCliAsync(assert, fx.h, args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, message);
  }
  assert.equal(app.requests.length, 0);
  assert.equal(fx.h.calls().length, 0);
});

test("40: --target selects that target's checks plus the stage-wide ones", async (t) => {
  const app = await startApp(t, { "/a": { status: 200 }, "/b": { status: 200 }, "/all": { status: 200 } });
  const fx = verifyFleet(t, {
    targets: { "stage-1": ["api", "api-internal"], "stage-2": null, "stage-3": null },
    blocks: { "stage-1": block([httpCheck("all", app.url("/all")), httpCheck("only-api", app.url("/a"), { target: "api" }), httpCheck("only-internal", app.url("/b"), { target: "api-internal" })]) },
  });
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-1", "--target", "api-internal", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(Object.keys(byName(r.json)), ["all", "only-internal"]);
  assert.equal(r.json.scope.target, "api-internal");
  assert.match(r.json.verification.blocks[0].detail, /2 of 3 selected/);
  assert.deepEqual(app.requests.map((request) => request.path), ["/all", "/b"]);
});

test("44: verify on a stage without a block says \"no real-world verification configured\" — exit 0, no request, nothing invented", async (t) => {
  const app = await startApp(t);
  const fx = verifyFleet(t, { blocks: { "stage-1": block([httpCheck("health", app.url("/health"))]) } });
  const r = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-2", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.verification.outcome, "NO-CHECKS");
  assert.deepEqual(r.json.verification.blocks, [{ component: "acme-api", stage: "stage-2", status: "not-configured", detail: "no real-world verification configured", smoke: null, selected: 0 }]);
  assert.deepEqual(r.json.verification.results, []);
  const human = await runCliAsync(assert, fx.h, ["verify", ...fx.ws, "acme-api", "--stage", "stage-2"]);
  assert.match(human.stdout, /acme-api \/ stage-2: no real-world verification configured/);
  assert.equal(app.requests.length, 0);
  assert.equal(fx.h.calls().length, 0);
});

// ---------------------------------------------------------------------------
// status --verify: report, snapshot, precedence

test("43/50: status --verify carries the results in --json and in the snapshot (canonical), written on 28 and on 30", async (t) => {
  const app = await startApp(t);
  const fx = verifyFleet(t, { blocks: { "stage-1": block([httpCheck("health", app.url("/health")), versionCheck("version", app.url("/version"))], 1) } });
  app.route("/health", { status: 200 });
  app.route("/version", { status: 200, json: { build: { commit: fx.short.c3 } } });
  const failed = await runCliAsync(assert, fx.h, ["status", ...fx.ws, "--all", "--verify", "--json"]);
  assert.equal(failed.status, 28, failed.out);
  assert.equal(failed.json.outcome.exitCode, 28);
  assert.equal(failed.json.outcome.phase, "verification");
  assert.equal(failed.json.verification.exitCode, 28);
  assert.equal(byName(failed.json).version.outcome, "FAIL");
  assert.deepEqual(byName(failed.json).version.expected, { value: fx.commits.c4, source: "status" }, "expected = the commit this very status run resolved");
  assert.deepEqual(
    failed.json.fleet.map((row) => [row.component, row.verification]),
    [
      ["acme-api", "FAIL"],
      ["acme-worker", "not configured"],
    ],
  );
  let names = snapshotFiles(fx.platform);
  assert.equal(names.length, 1, "a snapshot is written on 28");
  let raw = snapshotText(fx.platform, names[0]);
  assert.equal(classify(raw, SNAPSHOT_SCHEMA, names[0]).state, "canonical");
  let snapshot = JSON.parse(raw);
  assert.equal(snapshot.exitCode, 28);
  assert.deepEqual(snapshot.report.verification.results.map((entry) => [entry.name, entry.outcome, entry.httpStatus, entry.extracted]), [
    ["health", "PASS", 200, null],
    ["version", "FAIL", 200, fx.short.c3],
  ]);

  app.route("/health", { status: 200, delayMs: 2500 });
  app.route("/version", { status: 200, json: { build: { commit: fx.short.c4 } } });
  const inconclusive = await runCliAsync(assert, fx.h, ["status", ...fx.ws, "acme-api", "--verify", "--json"]);
  assert.equal(inconclusive.status, 30);
  names = snapshotFiles(fx.platform);
  assert.equal(names.length, 2, "a snapshot is written on 30");
  raw = snapshotText(fx.platform, names[1]);
  assert.equal(classify(raw, SNAPSHOT_SCHEMA, names[1]).state, "canonical");
  snapshot = JSON.parse(raw);
  assert.equal(snapshot.exitCode, 30);
  assert.deepEqual(snapshot.report.verification.results.map((entry) => entry.outcome), ["UNREACHABLE", "PASS"]);

  const human = await runCliAsync(assert, fx.h, ["status", ...fx.ws, "--all", "--verify"]);
  assert.equal(human.status, 30);
  assert.match(human.stdout, /fleet[\s\S]*verification[\s\S]*acme-api .*INCONCLUSIVE/);
  assert.match(human.stdout, /UNREACHABLE +health/);
  assertOnlyReadMethods(assert, app);
});

test("20: status --verify precedence end to end — 23 + 28 → 23; 30 + 22 → 30; the report still carries every result", async (t) => {
  const app = await startApp(t, { "/health": { status: 500 }, "/version": { status: 200, json: { build: { commit: "abcdef1" } } } });
  const fx = verifyFleet(t, {
    blocks: { "stage-1": block([httpCheck("health", app.url("/health")), versionCheck("version", app.url("/version"), { target: "api" })]) },
    images: (defaults) => ({ ...defaults, "stage-1/api": null }),
  });
  const missing = await runCliAsync(assert, fx.h, ["status", ...fx.ws, "acme-api", "--verify", "--json"]);
  assert.equal(missing.status, 23, missing.out);
  assert.equal(missing.json.verification.exitCode, 28);
  assert.equal(byName(missing.json).health.outcome, "FAIL");
  assert.equal(byName(missing.json).version.outcome, "INCONCLUSIVE");
  assert.match(byName(missing.json).version.reason, /expected version unknown: target api is missing at the source/);
  assert.equal(JSON.parse(snapshotText(fx.platform, snapshotFiles(fx.platform)[0])).exitCode, 23);

  // stage-1 runs c3 while local HEAD is c4 → the named pair local:stage-1 trips the drift gate (22);
  // an unanswered check makes verification inconclusive (30); 30 outranks 22.
  const fx2 = verifyFleet(t, {
    blocks: { "stage-1": block([httpCheck("health", `http://127.0.0.1:${await refusedPort()}/health`)]) },
    images: (defaults, fixture) => ({ ...defaults, "stage-1/api": ref("api", fixture.short.c3) }),
  });
  const drift = await runCliAsync(assert, fx2.h, ["status", ...fx2.ws, "acme-api", "--verify", "--fail-on-drift", "local:stage-1", "--json"]);
  assert.equal(drift.status, 30, drift.out);
  assert.equal(drift.json.drift.tripped, true);
  assert.equal(drift.json.verification.exitCode, 30);
});
