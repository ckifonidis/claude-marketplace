// `status` end to end against a fake `az` (spec requirements 18-22, 46, 50-55; parity with the
// original engine's report-integration group, re-expressed synthetically — scan §6.3). The CLI is
// spawned as `node dist/cli.js`; `az` is a logged shim and the only source CLI on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { READ_ONLY, SUB, assertReadOnly } from "./fixtures/cli-shims.mjs";
import { appServiceApi, appServiceFleet, installAz, runCli, snapshotFiles, webapp } from "./fixtures/cli-harness.mjs";
import { git } from "./fixtures/workspace-fixtures.mjs";

const FX = (tag) => `DOCKER|registry.example.com/acme/api:${tag}`;

function lists({ stage1 = [webapp("acme-api-stage1", { fx: FX("3f2a9c1") })], stage2 = [webapp("acme-api-stage2", { fx: FX("3f2a9c1") })], three = [] } = {}) {
  return { [SUB.one]: stage1, [SUB.two]: stage2, [SUB.three]: three };
}

test("46/52: matching images in both stages report exit 0, same reference flagged as not proof", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists());
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /stage-1 → stage-2: same reference \(no digest on both sides — not proof of the same build\)/);
  assert.match(r.stdout, /registry\.example\.com\/acme\/api:3f2a9c1/);
  assert.match(r.stdout, /last modified ≤ 2026-11-10 \(upper bound, not the deploy time\)/);
  assertReadOnly(assert, fx.h.calls(), READ_ONLY.az);
});

test("52: differing tags across stages are reported but exit 0 (tags prove nothing)", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists({ stage2: [webapp("acme-api-stage2", { fx: FX("1.4.0") })] }));
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  const component = r.json.components[0];
  assert.equal(component.crossStage[0].result, "different-reference");
  assert.equal(component.crossStage[0].proven, false);
  assert.deepEqual(r.json.drift.findings, [], "a cross-stage difference is not drift unless a pair is named");
});

test("47: --fail-on-drift without pairs does not trip on a cross-stage difference; a named pair does (22)", (t) => {
  const fx = appServiceFleet(t);
  const head = git(fx.api, "rev-parse", "--short=7", "HEAD");
  installAz(fx.h, lists({ stage1: [webapp("acme-api-stage1", { fx: FX(head) })], stage2: [webapp("acme-api-stage2", { fx: FX("1.4.0") })] }));
  const plain = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--fail-on-drift"]);
  assert.equal(plain.status, 0, plain.out);
  const named = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--fail-on-drift", "stage-1:stage-2", "--json"]);
  assert.equal(named.status, 22, named.out);
  assert.equal(named.phase, "drift");
  assert.equal(named.json.drift.tripped, true);
  assert.deepEqual(named.json.drift.findings.map((f) => [f.kind, f.where]), [["cross-stage-delta", "stage-1:stage-2"]]);
  assert.match(named.json.drift.findings[0].detail, /^unknown \(/, "stage-2's tag does not resolve, so the delta is unknown — not equal");
  const local = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--fail-on-drift", "local:stage-1"]);
  assert.equal(local.status, 0, "local HEAD equals stage-1, so the named pair is equal");
});

test("23: a declared target that does not exist exits 23 with the full report (human and JSON)", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists({ stage2: [] }));
  const human = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.equal(human.status, 23, human.out);
  assert.equal(human.phase, "missing");
  assert.match(human.stdout, /MISSING — webapp "acme-api-stage2" not found/);
  assert.match(human.stdout, /registry\.example\.com\/acme\/api:3f2a9c1/, "what was found is still reported");
  assert.match(human.stderr, /1 declared target\(s\) do not exist/);
  const json = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(json.status, 23);
  assert.deepEqual(json.json.missing.map((m) => [m.component, m.stage, m.target]), [["acme-api", "stage-2", "api"]]);
  assert.equal(json.json.components[0].stages[1].targets[0].status, "missing");
  assert.equal(json.json.outcome.exitCode, 23);
});

test("46: an explicit null stage is not-deployed and exits 0", (t) => {
  const fx = appServiceFleet(t, { api: appServiceApi({ stage2: null }) });
  installAz(fx.h, lists({ stage2: [] }));
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.components[0].stages[1].status, "not-deployed");
  assert.deepEqual(r.json.missing, []);
  assert.equal(fx.h.calls("az").filter((c) => c.args.includes(SUB.two)).length, 0, "no stage-2 subscription is listed for a not-deployed stage");
  const human = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.match(human.stdout, /— not deployed \(by design\)/);
});

test("20/21: expired credentials mid-read exit 20 — never 23 — with no report and no snapshot", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists(), {
    extra: [
      {
        match: ["webapp", "list"],
        stderr: 'ERROR: AADSTS50173: The provided grant has expired due to it being revoked.\nRun az login --tenant "00000000-0000-0000-0000-00000000000a"\n',
        exit: 1,
      },
    ],
  });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.equal(r.status, 20, r.out);
  assert.doesNotMatch(r.out, /MISSING|not found/i);
  assert.equal(r.stdout, "", "no partial report");
  assert.match(r.stderr, /az login --tenant "00000000-0000-0000-0000-00000000000a"/);
  assert.deepEqual(snapshotFiles(fx.platform), []);
});

test("20/18: no cached sign-in fails the whole run at preflight (20), no report, no snapshot", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists(), { accountFails: true });
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 20, r.out);
  assert.equal(r.phase, "preflight");
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /NOT a missing target/);
  assert.match(r.stderr, /az login/);
  assert.deepEqual(fx.h.calls("az").map((c) => c.args.slice(0, 2)), [["account", "show"]], "nothing is read after a failed preflight");
  assert.deepEqual(snapshotFiles(fx.platform), []);
});

test("24/21: a webapp name present in two subscriptions of one stage is refused (21), no snapshot", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists({ stage2: [webapp("acme-api-stage2")], three: [webapp("acme-api-stage2", { rg: "rg-other" })] }));
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.equal(r.status, 21, r.out);
  assert.match(r.stderr, /exists in BOTH/);
  assert.equal(r.stdout, "");
  assert.deepEqual(snapshotFiles(fx.platform), []);
});

test("46: a stopped webapp still shows its image with its state (exit 0)", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists({ stage2: [webapp("acme-api-stage2", { state: "Stopped" })] }));
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /api\s+registry\.example\.com\/acme\/api:3f2a9c1\s+STOPPED/);
  assert.match(r.stdout, /1 not running/);
});

test("24/46: a non-container webapp is flagged, not missing (exit 0)", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists({ stage2: [webapp("acme-api-stage2", { fx: "NODE|20-lts" })] }));
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  const target = r.json.components[0].stages[1].targets[0];
  assert.equal(target.status, "found");
  assert.equal(target.image.kind, "non-container");
  assert.equal(target.commit.status, "not-applicable");
  assert.equal(r.json.components[0].crossStage[0].result, "not-comparable");
});

test("55: --json is one parseable document with schemaVersion and the documented top-level keys", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists());
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0);
  assert.ok(r.json, "stdout parses as JSON on its own (the trailer is on stderr)");
  assert.equal(r.json.schemaVersion, 1);
  assert.deepEqual(Object.keys(r.json), [
    "schemaVersion", "engineVersion", "command", "generatedAt", "workspace", "scope", "stages", "components", "unavailable",
    "fleet", "preflight", "pipelines", "verification", "drift", "missing", "outcome", "snapshot",
  ]);
  assert.equal(r.json.engineVersion, "0.1.0");
  assert.equal(r.json.fleet, null, "the fleet table is --all only");
  const target = r.json.components[0].stages[0].targets[0];
  assert.deepEqual(Object.keys(target), ["name", "adapter", "status", "state", "image", "digest", "lastModified", "commit", "mixed", "rollout", "pipelineMapped", "details", "notes"]);
  assert.deepEqual(target.lastModified, { value: "2026-11-10T09:12:44.000Z", source: "lastModifiedTimeUtc", bound: "upper" });
  assert.equal(target.commit.status, "tag-not-found");
  assert.deepEqual(r.json.stages.map((s) => [s.name, s.promotion.triggerable]), [["stage-1", true], ["stage-2", false]]);
  assert.doesNotMatch(r.stdout, /\u001b\[/, "never colour in --json");
});

test("46: deployed commits resolve from the mapped clone end to end (date, subject, HEAD relation)", (t) => {
  const fx = appServiceFleet(t);
  const first = git(fx.api, "rev-parse", "HEAD");
  git(fx.api, "commit", "-q", "--allow-empty", "-m", "feat: newer work");
  git(fx.api, "tag", "v1.2.0", first);
  installAz(fx.h, lists({ stage1: [webapp("acme-api-stage1", { fx: FX(first.slice(0, 7)) })], stage2: [webapp("acme-api-stage2", { fx: FX("1.2.0") })] }));
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(r.status, 0, r.out);
  const [s1, s2] = r.json.components[0].stages.map((s) => s.targets[0].commit);
  assert.equal(s1.status, "resolved");
  assert.equal(s1.sha, first);
  assert.equal(s1.subject, "chore: initial commit");
  assert.deepEqual(s1.headRelation, { relation: "behind", commits: 1 });
  assert.equal(s2.status, "resolved", "stage-2 resolves v1.2.0 through the git-tag convention");
  assert.equal(s2.sha, first);
  const delta = r.json.components[0].deltas;
  assert.deepEqual(delta.map((d) => [d.upstream, d.downstream, d.verdict]), [["local", "stage-1", "behind"], ["stage-1", "stage-2", "equal"]]);
  assert.equal(delta[0].entries[0].pending[0].subject, "feat: newer work");
  const human = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]);
  assert.match(human.stdout, /└ commit [0-9a-f]{7} \d{4}-\d{2}-\d{2} "chore: initial commit"\s+1 commit behind local HEAD/);
});

test("14: an unknown component fails with 64 listing the members BEFORE any source call", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists());
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-apii"]);
  assert.equal(r.status, 64, r.out);
  assert.match(r.stderr, /unknown component "acme-apii" \(members: acme-api, acme-worker\)/);
  assert.deepEqual(fx.h.calls(), [], "no shim was invoked");
  assert.deepEqual(snapshotFiles(fx.platform), []);
});

test("14: an unknown --stage fails with 64 listing the stages before any source call", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists());
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--stage", "stage-9"]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown stage "stage-9" \(stages: stage-1, stage-2\)/);
  assert.deepEqual(fx.h.calls(), []);
});

test("--stage restricts the report and the source calls to one stage", (t) => {
  const fx = appServiceFleet(t);
  installAz(fx.h, lists({ stage2: [] }));
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--stage", "stage-1", "--json"]);
  assert.equal(r.status, 0, "stage-2's missing target is outside the scope");
  assert.deepEqual(r.json.scope.stages, ["stage-1"]);
  assert.deepEqual(r.json.components[0].stages.map((s) => s.name), ["stage-1"]);
  assert.deepEqual(r.json.components[0].deltas.map((d) => `${d.upstream}:${d.downstream}`), ["local:stage-1"]);
  const subscriptions = fx.h.calls("az").filter((c) => c.args[0] === "webapp").map((c) => c.args[c.args.indexOf("--subscription") + 1]);
  assert.deepEqual(subscriptions, [SUB.one]);
});
