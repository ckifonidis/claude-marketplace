// `snapshot-info` (spec requirements 50, 58 step 3): the read-only change-risk freshness answer —
// the newest snapshot covering the component, its age against freshnessMinutes, and its recorded
// fingerprint against the CURRENT fingerprint of that run's scope. Never writes a snapshot; exit 0
// whether fresh or not; 64 / 24 / 29 as for every command. All names are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPONENT_SCHEMA } from "../dist/config.js";
import { classify } from "../dist/format.js";
import { nextSnapshotFile, renderSnapshot } from "../dist/snapshot.js";
import { configFingerprint } from "../dist/workspace.js";
import { commandFleet, installDeploy, ref, runCli, snapshotFiles, snapshotText } from "./fixtures/cli-harness.mjs";
import { text } from "./fixtures/workspace-fixtures.mjs";

function fleet(t) {
  const fx = commandFleet(t);
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-2/api": ref("api", fx.short.c2), "stage-3/api": ref("api", "1.0.0"), "stage-1/worker": ref("worker", fx.short.w1) });
  return fx;
}

function info(fx, component, extra = []) {
  return runCli(assert, fx.h, ["snapshot-info", ...fx.ws, component, "--json", ...extra]);
}

/** Moves the single newest snapshot `minutes` into the past (re-rendered canonically, renamed to match). */
function age(fx, minutes) {
  const names = snapshotFiles(fx.platform);
  const name = names.at(-1);
  const value = JSON.parse(snapshotText(fx.platform, name));
  value.time = new Date(Date.parse(value.time) - minutes * 60_000).toISOString();
  rmSync(join(fx.platform, ".release-radar", "snapshots", name));
  const file = nextSnapshotFile(fx.platform, value.time);
  writeFileSync(file, renderSnapshot(value));
  return file;
}

test("58.3: no snapshot → not fresh (no-snapshot), exit 0, and snapshot-info itself writes no snapshot", (t) => {
  const fx = fleet(t);
  const r = info(fx, "acme-api");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.command, "snapshot-info");
  assert.equal(r.json.snapshot, null);
  assert.equal(r.json.fresh, false);
  assert.equal(r.json.fingerprintMatches, null);
  assert.deepEqual(r.json.reasons.map((reason) => reason.code), ["no-snapshot"]);
  assert.equal(r.json.freshnessMinutes, 30);
  assert.deepEqual(snapshotFiles(fx.platform), [], "read-only: nothing written");
  assert.deepEqual(fx.h.calls(), [], "no adapter is called");
});

test("58.3/50: a status snapshot just taken is fresh: covers the component, young, fingerprint matches the current configuration", (t) => {
  const fx = fleet(t);
  const status = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(status.status, 0, status.out);
  const calls = fx.h.calls().length;
  const r = info(fx, "acme-api");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.fresh, true);
  assert.deepEqual(r.json.reasons, []);
  assert.equal(r.json.snapshot.file, status.json.snapshot.file);
  assert.equal(r.json.snapshot.time, status.json.generatedAt);
  assert.equal(r.json.snapshot.fingerprint, status.json.snapshot.fingerprint);
  assert.equal(r.json.currentFingerprint, status.json.snapshot.fingerprint);
  assert.equal(r.json.fingerprintMatches, true);
  assert.ok(r.json.snapshot.ageMinutes >= 0 && r.json.snapshot.ageMinutes < 30);
  assert.deepEqual(r.json.snapshot.components, ["acme-api"]);
  assert.deepEqual(r.json.snapshot.scope, { all: false, stages: ["stage-1", "stage-2", "stage-3"] });
  assert.equal(r.json.snapshot.pipelines, "not-configured");
  assert.equal(r.json.snapshot.verification, "not-requested");
  assert.equal(snapshotFiles(fx.platform).length, 1, "snapshot-info writes no snapshot");
  assert.equal(fx.h.calls().length, calls, "no adapter is called");
  const human = runCli(assert, fx.h, ["snapshot-info", ...fx.ws, "acme-api"]);
  assert.equal(human.status, 0, human.out);
  assert.match(human.stdout, /newest snapshot covering acme-api: .*\.json/);
  assert.match(human.stdout, /\(matches\)/);
  assert.match(human.stdout, /^fresh: yes/m);
});

test("58.3: the newest snapshot that COVERS the component is chosen; none covering → component-not-covered", (t) => {
  const fx = fleet(t);
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-worker"]).status, 0);
  const none = info(fx, "acme-api");
  assert.equal(none.status, 0, none.out);
  assert.equal(none.json.snapshot, null);
  assert.deepEqual(none.json.reasons.map((reason) => reason.code), ["component-not-covered"]);
  assert.match(none.json.reasons[0].detail, /none of the 1 valid snapshot\(s\) covers acme-api/);
  const api = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-worker"]).status, 0, "a newer snapshot that does not cover acme-api");
  const r = info(fx, "acme-api");
  assert.equal(r.json.snapshot.file, api.json.snapshot.file, "the newer worker-only snapshot is skipped");
  assert.equal(r.json.fresh, true);
});

test("58.3/50: the current fingerprint follows the snapshot's own scope (--all vs one component)", (t) => {
  const fx = fleet(t);
  const all = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  assert.equal(all.status, 0, all.out);
  assert.equal(info(fx, "acme-api").json.fresh, true);
  // A real change to acme-worker's component.json invalidates the --all snapshot for acme-api too.
  const worker = JSON.parse(readFileSync(fx.workerComponent, "utf8"));
  worker.stages["stage-1"].targets[0].argv = ["acme-deploy", "show", "stage-1", "worker", "--fresh"];
  writeFileSync(fx.workerComponent, text(worker));
  const changed = info(fx, "acme-api");
  assert.equal(changed.status, 0, changed.out);
  assert.equal(changed.json.fresh, false);
  assert.equal(changed.json.fingerprintMatches, false);
  assert.deepEqual(changed.json.snapshot.scope.all, true);
  assert.deepEqual(changed.json.reasons.map((reason) => reason.code), ["fingerprint-differs"]);
  assert.notEqual(changed.json.currentFingerprint, all.json.snapshot.fingerprint);
  // A snapshot of acme-api alone is unaffected by acme-worker's change.
  const one = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  const r = info(fx, "acme-api");
  assert.equal(r.json.fresh, true);
  assert.equal(r.json.snapshot.file, one.json.snapshot.file);
  const api = classify(readFileSync(fx.apiComponent, "utf8"), COMPONENT_SCHEMA, "c").value;
  assert.equal(r.json.currentFingerprint, configFingerprint(JSON.parse(readFileSync(fx.workspaceFile, "utf8")), { "acme-api": api }));
  // A real change to the workspace invalidates it.
  const ws = JSON.parse(readFileSync(fx.workspaceFile, "utf8"));
  ws.gitTimeoutSeconds = 20;
  writeFileSync(fx.workspaceFile, text(ws));
  assert.deepEqual(info(fx, "acme-api").json.reasons.map((reason) => reason.code), ["fingerprint-differs"]);
});

test("58.3: a snapshot older than freshnessMinutes is too-old (fingerprint still reported); a member gone from the scope is fingerprint-unavailable", (t) => {
  const fx = fleet(t);
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "--all"]).status, 0);
  const file = age(fx, 45);
  const r = info(fx, "acme-api");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.snapshot.file, file);
  assert.ok(r.json.snapshot.ageMinutes >= 45);
  assert.equal(r.json.fingerprintMatches, true);
  assert.equal(r.json.fresh, false);
  assert.deepEqual(r.json.reasons.map((reason) => reason.code), ["too-old"]);
  assert.match(r.json.reasons[0].detail, /freshnessMinutes is 30/);
  const human = runCli(assert, fx.h, ["snapshot-info", ...fx.ws, "acme-api"]);
  assert.match(human.stdout, /^fresh: no — too-old/m);

  // A named-scope snapshot whose other member is now unavailable cannot be re-fingerprinted.
  const fx2 = fleet(t);
  assert.equal(runCli(assert, fx2.h, ["status", ...fx2.ws, "acme-api", "acme-worker"]).status, 0);
  rmSync(fx2.workerComponent);
  const gone = info(fx2, "acme-api");
  assert.equal(gone.status, 0, gone.out);
  assert.equal(gone.json.fresh, false);
  assert.equal(gone.json.currentFingerprint, null);
  assert.deepEqual(gone.json.reasons.map((reason) => reason.code), ["fingerprint-unavailable"]);
  assert.match(gone.json.reasons[0].detail, /acme-worker/);
});

test("83/64/24/29: snapshot-info refuses bad names (64), a missing workspace (24), non-canonical input (29), including the selected snapshot", (t) => {
  const fx = fleet(t);
  for (const args of [["snapshot-info", ...fx.ws], ["snapshot-info", ...fx.ws, "acme-nope"], ["snapshot-info", "acme-api"], ["snapshot-info", ...fx.ws, "acme-api", "acme-worker"]]) {
    assert.equal(runCli(assert, fx.h, args).status, 64, args.join(" "));
  }
  assert.equal(runCli(assert, fx.h, ["snapshot-info", "--workspace", fx.api, "acme-api"]).status, 24, "no workspace.json there");
  const api = readFileSync(fx.apiComponent, "utf8");
  writeFileSync(fx.apiComponent, JSON.stringify(JSON.parse(api)));
  const non = runCli(assert, fx.h, ["snapshot-info", ...fx.ws, "acme-api"]);
  assert.equal(non.status, 29, non.out);
  assert.match(non.stderr, /non-canonical input \(run format first\)/);
  writeFileSync(fx.apiComponent, api);
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]).status, 0);
  const name = snapshotFiles(fx.platform)[0];
  const path = join(fx.platform, ".release-radar", "snapshots", name);
  writeFileSync(path, `${JSON.stringify(JSON.parse(readFileSync(path, "utf8")), null, 4)}\n`);
  const hand = runCli(assert, fx.h, ["snapshot-info", ...fx.ws, "acme-api"]);
  assert.equal(hand.status, 29, hand.out);
  assert.match(hand.stderr, new RegExp(name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  writeFileSync(path, "{ not json");
  const invalid = info(fx, "acme-api");
  assert.equal(invalid.status, 0, "an invalid snapshot is skipped and reported, never selected");
  assert.deepEqual(invalid.json.reasons.map((reason) => reason.code), ["no-snapshot"]);
  assert.equal(invalid.json.invalidSnapshots.length, 1);
  assert.equal(invalid.json.invalidSnapshots[0].file, path);
});
