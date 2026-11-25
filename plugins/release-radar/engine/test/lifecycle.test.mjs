// lifecycle.ts units (spec requirements 32, 47, 51-53): triggerability, consistency bases
// (runtime digest vs reference), cross-stage summaries, chain links and drift findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareStages,
  computeDeltas,
  describeVerdict,
  driftFindings,
  effectiveDigest,
  judgeConsistency,
  localLink,
  stageLink,
  stageTriggerability,
  summariseComparisons,
} from "../dist/lifecycle.js";
import { parseImage } from "../dist/image.js";
import { digestOf } from "./fixtures/cli-shims.mjs";
import { workspaceValue } from "./fixtures/workspace-fixtures.mjs";

function observed(name, reference, { status = "found", digest = null, digestStatus = "not-exposed", commit = null } = {}) {
  const image = reference === null ? null : parseImage(reference);
  return {
    name,
    reading: { key: name, stage: "stage-1", target: name, adapter: "command", status, image, containers: [], state: null, lastModified: null, lastModifiedSource: null, digest, imageId: null, digestStatus, mixed: false, rollout: null, details: {}, notes: [] },
    commit,
  };
}

const resolved = (sha) => ({ status: "resolved", sha, date: "2026-11-25T08:00:00Z", subject: "s", headRelation: { relation: "at-head" } });

test("32: triggerability needs mode pipeline AND owner == operatorTeam, with a reason either way", () => {
  const ws = workspaceValue();
  const [stage1, stage2] = ws.stages;
  assert.deepEqual(stageTriggerability(ws, stage1), { mode: "pipeline", owner: "dev-team", owned: true, triggerable: true, reason: 'pipeline stage owned by the operator\'s team "dev-team"' });
  const handoff = stageTriggerability(ws, stage2);
  assert.equal(handoff.triggerable, false);
  assert.match(handoff.reason, /promotion mode is "handoff"/);
  const foreign = stageTriggerability(ws, { ...stage1, promotion: { mode: "pipeline", owner: "ops-team" } });
  assert.equal(foreign.triggerable, false);
  assert.equal(foreign.owned, false);
  assert.match(foreign.reason, /owned by "ops-team", not by the operator's team "dev-team"/);
  assert.equal(stageTriggerability(ws, { ...stage1, promotion: { mode: "none" } }).owner, null);
});

test("51: a runtime registry digest counts for consistency; tags alone fall back to the reference", () => {
  const a = digestOf("a");
  const k8s = observed("api-internal", "registry.example.com/acme/api:1.0", { digest: a, digestStatus: "available" });
  const pinned = observed("api", `registry.example.com/acme/api:other@${a}`);
  assert.equal(effectiveDigest(k8s.reading), a);
  const byDigest = judgeConsistency([pinned, k8s]);
  assert.equal(byDigest.status, "consistent");
  assert.equal(byDigest.basis, "digest");
  const mixedBasis = judgeConsistency([pinned, observed("api-mobile", "registry.example.com/acme/api:other")]);
  assert.equal(mixedBasis.basis, "reference", "one target without a digest → compared by reference");
  assert.equal(mixedBasis.status, "consistent");
});

test("51: missing and non-container targets are excluded and named; one target is single-target", () => {
  const result = judgeConsistency([observed("api", "registry.example.com/acme/api:1"), observed("gone", null, { status: "missing" }), observed("legacy", "NODE|20-lts")]);
  assert.equal(result.status, "not-comparable");
  assert.deepEqual(result.excluded, [{ target: "gone", reason: "missing" }, { target: "legacy", reason: "no single container image (non-container)" }]);
  assert.equal(judgeConsistency([observed("api", "registry.example.com/acme/api:1")]).status, "single-target");
});

test("52: cross-stage — only digests prove; tags never do; summaries are conservative", () => {
  const up = { stage: "stage-1", targets: [observed("api", `registry.example.com/acme/api:abc@${digestOf("a")}`)] };
  const sameDigest = { stage: "stage-2", targets: [observed("api", `registry.example.com/acme/api:1.0.0@${digestOf("a")}`)] };
  const sameTag = { stage: "stage-2", targets: [observed("api", "registry.example.com/acme/api:abc")] };
  assert.equal(compareStages(up, sameDigest).result, "same-build");
  assert.equal(compareStages(up, sameTag).result, "same-reference");
  assert.equal(compareStages(up, sameTag).proven, false);
  assert.equal(summariseComparisons(["same-build", "same-reference"]), "same-reference");
  assert.equal(summariseComparisons(["same-build", "different-build"]), "different-build");
  assert.equal(summariseComparisons([]), "not-comparable");
});

test("53: chain links — unresolved sides give unknown with the reason; distinct commits flag the stage", () => {
  const consistent = { status: "single-target", basis: null, groups: [], excluded: [], detail: "" };
  const head = localLink({ error: "not a git repository" });
  const link = stageLink("stage-1", [observed("api", "registry.example.com/acme/api:x", { commit: { status: "tag-not-found", detail: "refs/tags/vx missing" } })], consistent);
  const [delta] = computeDeltas(null, [head, link], 1000);
  assert.equal(delta.verdict, "unknown");
  assert.match(delta.entries[0].reason, /local HEAD unavailable: not a git repository; stage-1: api tag-not-found: refs\/tags\/vx missing/);
  const two = stageLink("stage-2", [observed("a", "r.example.com/x:1", { commit: resolved("1".repeat(40)) }), observed("b", "r.example.com/x:1", { commit: resolved("2".repeat(40)) })], consistent);
  assert.equal(two.inconsistent, true, "same image reference but two commits is still an inconsistent stage");
  const findings = driftFindings("acme-api", [{ stage: "stage-2", consistency: consistent, link: two }], [], []);
  assert.deepEqual(findings.map((f) => [f.kind, f.where]), [["within-stage", "stage-2"]]);
  assert.match(findings[0].detail, /targets run different commits: a \(1111111\) vs b \(2222222\)/);
});

test("47: drift findings for named pairs only; equal never trips", () => {
  const entry = (verdict, extra = {}) => ({ upstreamCommit: "a", downstreamCommit: "b", upstreamTargets: [], downstreamTargets: [], verdict, count: null, pending: [], extra: [], reason: null, ...extra });
  const deltas = [
    { upstream: "local", downstream: "stage-1", inconsistentStage: false, inconsistentSides: [], verdict: "equal", entries: [entry("equal")] },
    { upstream: "stage-1", downstream: "stage-2", inconsistentStage: false, inconsistentSides: [], verdict: "behind", entries: [entry("behind", { count: 3 })] },
  ];
  const pairs = [{ upstream: "local", downstream: "stage-1" }, { upstream: "stage-1", downstream: "stage-2" }];
  assert.deepEqual(driftFindings("c", [], deltas, pairs).map((f) => [f.where, f.detail]), [["stage-1:stage-2", "behind 3"]]);
  assert.deepEqual(driftFindings("c", [], deltas, []), []);
  assert.equal(describeVerdict(entry("diverged", { pending: [1, 2], extra: [3] })), "diverged (2 pending, 1 extra)");
});
