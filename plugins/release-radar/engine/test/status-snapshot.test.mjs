// Snapshots (spec requirements 39, 50, 78, 85, 86): written canonically by `status` on exits
// 0/22/23/28/30 (28/30: see verify.test.mjs) and never on 20/21/24/29/64; the fingerprint covers
// the canonical workspace plus each component.json used, so re-formatting changes nothing and a
// real change does; retention keeps exactly the configured count of OWN, supported files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { COMPONENT_SCHEMA, WORKSPACE_SCHEMA } from "../dist/config.js";
import { canonicalStringify, classify } from "../dist/format.js";
import {
  SNAPSHOT_EXIT_CODES,
  SNAPSHOT_SCHEMA,
  listSnapshots,
  newestSnapshot,
  nextSnapshotFile,
  pruneSnapshots,
  renderSnapshot,
  snapshotOrderKey,
  snapshotsDir,
  writeSnapshot,
} from "../dist/snapshot.js";
import { configFingerprint } from "../dist/workspace.js";
import { commandFleet, installDeploy, ref, runCli, snapshotFiles, snapshotText } from "./fixtures/cli-harness.mjs";
import { tempDir, text } from "./fixtures/workspace-fixtures.mjs";

function fleet(t) {
  const fx = commandFleet(t);
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-2/api": ref("api", fx.short.c2), "stage-3/api": ref("api", "1.0.0"), "stage-1/worker": ref("worker", fx.short.w1) });
  return fx;
}

/** Reverses every object's key order (a hand edit that changes no content). */
function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)]));
}

test("50/86: a status run writes one canonical snapshot holding the full JSON report", (t) => {
  const fx = fleet(t);
  const r = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  assert.equal(r.status, 0, r.out);
  const names = snapshotFiles(fx.platform);
  assert.equal(names.length, 1);
  assert.match(names[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
  assert.equal(r.json.snapshot.file, join(fx.platform, ".release-radar", "snapshots", names[0]));
  const raw = snapshotText(fx.platform, names[0]);
  const classified = classify(raw, SNAPSHOT_SCHEMA, names[0]);
  assert.equal(classified.state, "canonical", "an engine-written snapshot passes format --check straight away");
  const snapshot = JSON.parse(raw);
  assert.deepEqual(Object.keys(snapshot), ["schemaVersion", "engineVersion", "time", "exitCode", "fingerprint", "components", "members", "report"]);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.engineVersion, "0.1.0");
  assert.equal(snapshot.time, r.json.generatedAt);
  assert.equal(snapshot.exitCode, 0);
  assert.deepEqual(snapshot.components, ["acme-api", "acme-worker"]);
  assert.deepEqual(snapshot.members, [
    { name: "acme-api", availability: "available", reason: null, revision: "working-tree" },
    { name: "acme-worker", availability: "available", reason: null, revision: "working-tree" },
  ]);
  assert.equal(canonicalStringify(snapshot.report), canonicalStringify(r.json), "the snapshot holds exactly the --json report");
  assert.equal(snapshot.fingerprint, r.json.snapshot.fingerprint);
  // A second run never overwrites the first.
  runCli(assert, fx.h, ["status", ...fx.ws, "--all"]);
  assert.equal(snapshotFiles(fx.platform).length, 2);
});

test("50: snapshots are written on exits 0, 22 and 23 and on none of 20, 21, 24, 29, 64", (t) => {
  assert.deepEqual([...SNAPSHOT_EXIT_CODES].sort((a, b) => a - b), [0, 22, 23, 28, 30]);
  const fx = commandFleet(t, { api: { "stage-1": ["api", "api-internal"], "stage-2": ["api"], "stage-3": null } });
  const count = () => snapshotFiles(fx.platform).length;
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-1/api-internal": ref("api", fx.short.c3), "stage-2/api": ref("api", fx.short.c2) });
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]).status, 0);
  assert.equal(count(), 1);
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--fail-on-drift"]).status, 22);
  assert.equal(count(), 2);
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-1/api-internal": ref("api", fx.short.c3), "stage-2/api": null });
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]).status, 23);
  assert.equal(count(), 3);
  const last = JSON.parse(snapshotText(fx.platform, snapshotFiles(fx.platform).at(-1)));
  assert.equal(last.exitCode, 23);

  fx.h.install("acme-deploy", [{ match: ["show"], stderr: "backend exploded\n", exit: 2 }]);
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]).status, 21, "21: source error");
  const component = JSON.parse(readFileSync(fx.apiComponent, "utf8"));
  component.stages["stage-1"].targets[0].preflightArgv = ["acme-deploy", "whoami"];
  writeFileSync(fx.apiComponent, text(component));
  fx.h.install("acme-deploy", [{ match: ["whoami"], exit: 1 }]);
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]).status, 20, "20: preflight");
  writeFileSync(fx.apiComponent, JSON.stringify(component));
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]).status, 29, "29: non-canonical component.json");
  writeFileSync(fx.apiComponent, text({ ...component, stray: true }));
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-api"]).status, 24, "24: invalid component.json");
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "acme-nope"]).status, 64, "64: unknown component");
  assert.equal(count(), 3, "no snapshot for 20/21/24/29/64");
});

test("50/86: the fingerprint is the canonical workspace + components; re-formatting changes nothing, a real change does", (t) => {
  const fx = fleet(t);
  const first = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  const workspace = JSON.parse(readFileSync(fx.workspaceFile, "utf8"));
  const api = JSON.parse(readFileSync(fx.apiComponent, "utf8"));
  const worker = JSON.parse(readFileSync(fx.workerComponent, "utf8"));
  // The same content in a hand-edited key order fingerprints identically (canonical form).
  assert.equal(configFingerprint(reorder(workspace), { "acme-worker": reorder(worker), "acme-api": reorder(api) }), first.json.snapshot.fingerprint);
  // A re-formatted file is refused (29), and once `format` restores canonical bytes the fingerprint is unchanged.
  writeFileSync(fx.workspaceFile, `${JSON.stringify(reorder(workspace), null, 4)}\n`);
  assert.equal(classify(readFileSync(fx.workspaceFile, "utf8"), WORKSPACE_SCHEMA, "ws").state, "non-canonical");
  assert.equal(runCli(assert, fx.h, ["status", ...fx.ws, "--all"]).status, 29);
  writeFileSync(fx.workspaceFile, classify(readFileSync(fx.workspaceFile, "utf8"), WORKSPACE_SCHEMA, "ws").rendered);
  const again = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  assert.equal(again.json.snapshot.fingerprint, first.json.snapshot.fingerprint);
  // A real configuration change moves it.
  workspace.freshnessMinutes = 45;
  writeFileSync(fx.workspaceFile, text(workspace));
  const changed = runCli(assert, fx.h, ["status", ...fx.ws, "--all", "--json"]);
  assert.notEqual(changed.json.snapshot.fingerprint, first.json.snapshot.fingerprint);
  // A single-component run fingerprints only the component it used.
  const one = runCli(assert, fx.h, ["status", ...fx.ws, "acme-api", "--json"]);
  assert.equal(one.json.snapshot.fingerprint, configFingerprint(workspace, { "acme-api": classify(text(api), COMPONENT_SCHEMA, "c").value }));
});

test("50: unavailable members are recorded in the snapshot with their reason", (t) => {
  const fx = commandFleet(t, { worker: null });
  installDeploy(fx.h, { "stage-1/api": ref("api", fx.short.c4), "stage-2/api": ref("api", fx.short.c2), "stage-3/api": ref("api", "1.0.0") });
  runCli(assert, fx.h, ["status", ...fx.ws, "--all"]);
  const snapshot = JSON.parse(snapshotText(fx.platform, snapshotFiles(fx.platform)[0]));
  assert.deepEqual(snapshot.members[1], { name: "acme-worker", availability: "unavailable", reason: "no-component-config", revision: null });
  assert.deepEqual(snapshot.components, ["acme-api"]);
});

// ---------------------------------------------------------------------------
// Module-level: naming, retention, freshness

function value(time, { fingerprint = "a".repeat(64), exitCode = 0 } = {}) {
  return { schemaVersion: 1, engineVersion: "0.1.0", time, exitCode, fingerprint, components: ["acme-api"], members: [{ name: "acme-api", availability: "available", reason: null, revision: "working-tree" }], report: { b: 1, a: [3, 1] } };
}

test("50: snapshot names sort by parsed time and sequence; a same-millisecond run gets a -N suffix", (t) => {
  const root = tempDir(t);
  const time = "2026-11-25T10:15:30.123Z";
  const first = nextSnapshotFile(root, time);
  assert.ok(first.endsWith("2026-11-25T10-15-30-123Z.json"));
  writeSnapshot(first, value(time));
  const second = nextSnapshotFile(root, time);
  assert.ok(second.endsWith("2026-11-25T10-15-30-123Z-1.json"));
  writeSnapshot(second, value(time));
  assert.deepEqual(listSnapshots(root).map((s) => s.name), ["2026-11-25T10-15-30-123Z-1.json", "2026-11-25T10-15-30-123Z.json"]);
  assert.equal(snapshotOrderKey("notes.json"), null);
  assert.throws(() => writeSnapshot(first, value(time)), (e) => e.exitCode === 1, "never overwrites");
  assert.equal(renderSnapshot(value(time)).includes('"report": {\n    "a": [\n      3,\n      1\n    ],\n    "b": 1\n  }'), true, "opaque report: keys sorted, array order kept");
});

test("39/86: retention keeps exactly the newest N own snapshots and never touches invalid or foreign files", (t) => {
  const root = tempDir(t);
  const dir = snapshotsDir(root);
  const times = ["2026-11-20T08:00:00.000Z", "2026-11-21T08:00:00.000Z", "2026-11-22T08:00:00.000Z", "2026-11-23T08:00:00.000Z", "2026-11-24T08:00:00.000Z"];
  for (const time of times) writeSnapshot(nextSnapshotFile(root, time), value(time));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-11-01T08-00-00-000Z.json"), text({ ...value("2026-11-01T08:00:00.000Z"), schemaVersion: 2 }));
  writeFileSync(join(dir, "README.txt"), "not ours\n");
  const dry = pruneSnapshots(root, 2, { dryRun: true });
  assert.equal(dry.deleted.length, 3);
  assert.equal(listSnapshots(root).length, 6, "a dry run deletes nothing");
  const result = pruneSnapshots(root, 2, { dryRun: false });
  assert.deepEqual(result.kept.map((f) => f.slice(-29)), ["2026-11-24T08-00-00-000Z.json", "2026-11-23T08-00-00-000Z.json"]);
  assert.equal(result.deleted.length, 3);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].problem, /unsupported schemaVersion 2/);
  assert.ok(existsSync(join(dir, "2026-11-01T08-00-00-000Z.json")), "an unsupported schemaVersion is never deleted");
  assert.ok(existsSync(join(dir, "README.txt")), "a file outside the naming pattern is never deleted");
  assert.throws(() => pruneSnapshots(root, 0, { dryRun: true }));
});

test("50: newest-snapshot lookup reports age and fingerprint freshness (for change-risk)", (t) => {
  const root = tempDir(t);
  assert.equal(newestSnapshot(root, { now: new Date("2026-11-25T10:00:00.000Z"), freshnessMinutes: 30, fingerprint: "a".repeat(64) }), null);
  writeSnapshot(nextSnapshotFile(root, "2026-11-25T09:00:00.000Z"), value("2026-11-25T09:00:00.000Z"));
  writeSnapshot(nextSnapshotFile(root, "2026-11-25T09:45:00.000Z"), value("2026-11-25T09:45:00.000Z", { exitCode: 23 }));
  mkdirSync(snapshotsDir(root), { recursive: true });
  writeFileSync(join(snapshotsDir(root), "2026-11-25T09-59-00-000Z.json"), "{ broken");
  const fresh = newestSnapshot(root, { now: new Date("2026-11-25T10:00:00.000Z"), freshnessMinutes: 30, fingerprint: "a".repeat(64) });
  assert.equal(fresh.time, "2026-11-25T09:45:00.000Z", "the invalid newer file is skipped");
  assert.equal(fresh.ageMinutes, 15);
  assert.equal(fresh.exitCode, 23);
  assert.equal(fresh.fresh, true);
  const old = newestSnapshot(root, { now: new Date("2026-11-25T11:00:00.000Z"), freshnessMinutes: 30, fingerprint: "a".repeat(64) });
  assert.equal(old.fresh, false);
  const changed = newestSnapshot(root, { now: new Date("2026-11-25T10:00:00.000Z"), freshnessMinutes: 30, fingerprint: "b".repeat(64) });
  assert.equal(changed.fingerprintMatches, false);
  assert.equal(changed.fresh, false);
});
