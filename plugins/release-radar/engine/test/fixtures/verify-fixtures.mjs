// Verification fixtures (spec requirements 40-45, 75-77): the three-stage command fleet of
// `cli-harness.mjs` with `verification` blocks written into acme-api's working-tree
// component.json. stage-1 is owned by the operator's team ("dev-team"); stage-2 ("qa-team") and
// stage-3 ("ops-team", handoff) are not — so smoke checks run only on stage-1 (D3).
//
// Check builders emit the canonical key order of the schema (config.ts), so every fixture passes
// the canonical gate. All names, URLs and values are synthetic; URLs point at the local fake
// application server only.

import { commandFleet, commandTarget, installDeploy, ref } from "./cli-harness.mjs";
import { put } from "./workspace-fixtures.mjs";

/** An http check (schema key order). */
export function httpCheck(name, url, { target, method = "GET", expectStatus = [200], headers, timeoutSeconds } = {}) {
  return {
    name,
    type: "http",
    ...(target === undefined ? {} : { target }),
    url,
    method,
    expectStatus,
    ...(headers === undefined ? {} : { headers }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

/** A version check (schema key order); `extract` defaults to the JSON path `$.build.commit`. */
export function versionCheck(name, url, { target, extract = { type: "json-path", path: "$.build.commit" }, compare = "commit", headers, timeoutSeconds } = {}) {
  return {
    name,
    type: "version",
    ...(target === undefined ? {} : { target }),
    url,
    extract,
    compare,
    ...(headers === undefined ? {} : { headers }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

/** A smoke check (schema key order). */
export function smokeCheck(name, argv, { target, timeoutSeconds } = {}) {
  return { name, type: "smoke", ...(target === undefined ? {} : { target }), argv, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) };
}

/** A verification block; checks are sorted by name as the canonical form requires. */
export function block(checks, timeoutSeconds = 5) {
  return { timeoutSeconds, checks: [...checks].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

/**
 * The command fleet with acme-api's component.json rewritten to carry `blocks` (stage → block).
 * `targets` maps stage → target names (`null` = not deployed). `images` (key "stage/target")
 * defaults to stage-1 = c4, stage-2 = c2 (sha convention), stage-3 = tag 1.0.0 (git tag v1.0.0 = c1).
 */
export function verifyFleet(t, { blocks = {}, targets = { "stage-1": ["api"], "stage-2": ["api"], "stage-3": ["api"] }, images } = {}) {
  const fx = commandFleet(t, { api: targets });
  const stages = {};
  for (const [stage, names] of Object.entries(targets)) {
    if (names === null) {
      stages[stage] = null;
      continue;
    }
    const entry = { targets: names.map((name) => commandTarget(stage, name)) };
    if (blocks[stage] !== undefined) entry.verification = blocks[stage];
    stages[stage] = entry;
  }
  put(fx.apiComponent, { schemaVersion: 1, name: "acme-api", stages });
  const defaults = { "stage-1/api": ref("api", fx.short.c4), "stage-2/api": ref("api", fx.short.c2), "stage-3/api": ref("api", "1.0.0"), "stage-1/worker": ref("worker", fx.short.w1) };
  installDeploy(fx.h, images === undefined ? defaults : typeof images === "function" ? images(defaults, fx) : images);
  return fx;
}

/** Installs the fake smoke command `acme-smoke` (`ok` exits 0, `bad` exits 3, `slow` sleeps 3 s); each prints marker output that must never surface. */
export function installSmoke(h) {
  h.install("acme-smoke", [
    { match: ["ok"], stdout: "SMOKE-STDOUT-MUST-NOT-SURFACE\n", stderr: "SMOKE-STDERR-MUST-NOT-SURFACE\n", exit: 0 },
    { match: ["bad"], stdout: "SMOKE-STDOUT-MUST-NOT-SURFACE\n", stderr: "SMOKE-STDERR-MUST-NOT-SURFACE\n", exit: 3 },
    { match: ["slow"], sleepMs: 3000, exit: 0 },
  ]);
}

/** Results of a --json report keyed by check name. */
export function byName(report) {
  return Object.fromEntries(report.verification.results.map((entry) => [entry.name, entry]));
}
