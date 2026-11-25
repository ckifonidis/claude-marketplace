// End-to-end CLI harness (spec requirements 75, 77; scan §6.3 technique): spawns the compiled
// `node dist/cli.js` with fake source CLIs (`cli-shims.mjs`) as the ONLY programs on PATH, plus a
// symlink to the real `git` (fixture clones are throw-away temp repositories). No real `az`,
// `kubectl` or `docker` can ever be reached, and every shim call is logged.
//
// All names are synthetic.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUB, shimHarness } from "./cli-shims.mjs";
import { buildFleet, commitAll, git, put } from "./workspace-fixtures.mjs";

/** The compiled CLI under test. */
export const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/** The trailer every run must print (plan decision D13). */
export const TRAILER = /^RELEASE_RADAR_RESULT=(OK|FAIL) PHASE=([a-z-]+) EXIT=(\d+)$/;

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/**
 * A shim harness whose PATH also resolves `git` (symlinked into the shim directory) and whose
 * git runs without the user's global configuration.
 */
export function cliHarness(t) {
  const h = shimHarness(t);
  symlinkSync(REAL_GIT, join(h.bin, "git"));
  const env = { ...h.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  delete env.NO_COLOR;
  return { ...h, env };
}

function lastLine(text) {
  const lines = text.split("\n").filter((line) => line !== "");
  return lines[lines.length - 1] ?? "";
}

/**
 * Runs the CLI and asserts the trailer contract on EVERY run: exactly one trailer, last line of
 * stdout on a human success, last line of stderr otherwise (always stderr with --json), and its
 * EXIT equal to the process status.
 */
export function runCli(assert, h, args, { env = h.env, cwd } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
  return checkRun(assert, args, result);
}

/**
 * {@link runCli} without blocking the test process's event loop — required whenever the test
 * process itself serves the CLI (the fake application server in `fake-app-server.mjs`).
 */
export function runCliAsync(assert, h, args, { env = h.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      try {
        resolve(checkRun(assert, args, { status, stdout, stderr }));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function checkRun(assert, args, result) {
  const json = args.includes("--json");
  const onStdout = result.status === 0 && !json;
  const stream = onStdout ? result.stdout : result.stderr;
  const trailer = lastLine(stream);
  const match = TRAILER.exec(trailer);
  assert.ok(match, `no trailer as the last ${onStdout ? "stdout" : "stderr"} line (status ${result.status}):\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.equal(Number(match[3]), result.status, "trailer EXIT equals the process exit code");
  assert.equal(match[1], result.status === 0 ? "OK" : "FAIL");
  const all = `${result.stdout}\n${result.stderr}`;
  assert.equal(all.split("\n").filter((line) => TRAILER.test(line)).length, 1, "exactly one trailer");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: all, phase: match[2], json: json && result.status !== 64 ? safeJson(result.stdout) : null };
}

function safeJson(text) {
  try {
    return text.trim() === "" ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** Snapshot files of a workspace (names only), sorted. */
export function snapshotFiles(platform) {
  const dir = join(platform, ".release-radar", "snapshots");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Reads one snapshot file's text. */
export function snapshotText(platform, name) {
  return readFileSync(join(platform, ".release-radar", "snapshots", name), "utf8");
}

// ---------------------------------------------------------------------------
// App Service fleet (parity with the original engine's report-integration group)

/** The az account answered by `az account show`. */
export const ACCOUNT = { id: SUB.one, name: "acme-subscription", tenantId: "00000000-0000-0000-0000-00000000000a", user: { name: "operator@example.com", type: "user" } };

/** A web app in the `az webapp list` shape; the shim applies the --query projection. */
export function webapp(name, { rg = "rg-acme", state = "Running", fx = "DOCKER|registry.example.com/acme/api:3f2a9c1", modified = "2026-11-10T09:12:44Z" } = {}) {
  return { name, resourceGroup: rg, state, kind: "app,linux,container", lastModifiedTimeUtc: modified, siteConfig: { linuxFxVersion: fx } };
}

/**
 * Installs a fake `az`: `account show` (or a not-logged-in failure), one `webapp list` answer
 * per subscription, plus `extra` rules checked first.
 */
export function installAz(h, lists, { accountFails = false, extra = [] } = {}) {
  h.install("az", [
    ...extra,
    accountFails
      ? { match: ["account", "show"], stderr: "ERROR: Please run 'az login' to setup account.\n", exit: 1 }
      : { match: ["account", "show"], stdout: ACCOUNT },
    ...Object.entries(lists).map(([sub, apps]) => ({ match: ["webapp", "list"], flags: { "--subscription": sub }, stdout: apps, query: true })),
  ]);
}

/** acme-api deployed on App Service in both stages (one target each), no pipeline mapping. */
export function appServiceApi({ stage2 = { targets: [{ name: "api", adapter: "azure-appservice", webapp: "acme-api-stage2" }] } } = {}) {
  return {
    schemaVersion: 1,
    name: "acme-api",
    stages: {
      "stage-1": { targets: [{ name: "api", adapter: "azure-appservice", webapp: "acme-api-stage1" }] },
      "stage-2": stage2,
    },
  };
}

/**
 * The App Service fleet: workspace stage-1 (sha convention) and stage-2 (git-tag `v`), acme-api
 * as above. Returns the fleet paths, the harness and helpers to create commits in acme-api.
 */
export function appServiceFleet(t, { api = appServiceApi(), worker, workspace } = {}) {
  const fleet = buildFleet(t, { api, ...(worker === undefined ? {} : { worker }), ...(workspace === undefined ? {} : { workspace }) });
  const h = cliHarness(t);
  return { ...fleet, h, ws: ["--workspace", fleet.platform] };
}

// ---------------------------------------------------------------------------
// Command-adapter fleet (multi-target, multi-stage lifecycle tests)

/** Three stages: stage-1 and stage-2 on the `sha` convention, stage-3 on `git-tag` with prefix `v`. */
export function threeStageWorkspace() {
  return {
    schemaVersion: 1,
    operatorTeam: "dev-team",
    stages: [
      { name: "stage-1", tagConvention: { type: "sha" }, promotion: { mode: "pipeline", owner: "dev-team" } },
      { name: "stage-2", tagConvention: { type: "sha" }, promotion: { mode: "pipeline", owner: "qa-team" } },
      { name: "stage-3", tagConvention: { type: "git-tag", gitTagPrefix: "v" }, promotion: { mode: "handoff", owner: "ops-team" } },
    ],
    members: [
      { name: "acme-api", repoKey: "acme-api", repoSubdir: null },
      { name: "acme-worker", repoKey: "acme-worker", repoSubdir: "worker" },
    ],
    reposFile: { kind: "owned" },
    gitTimeoutSeconds: 15,
    freshnessMinutes: 30,
    checklist: null,
    snapshotRetention: 3,
    handoffRetention: 2,
    adapters: { command: { timeoutSeconds: 10 } },
  };
}

/** A `command` target reading `acme-deploy show <stage> <name>` and extracting `$.image`. */
export function commandTarget(stage, name) {
  return { name, adapter: "command", argv: ["acme-deploy", "show", stage, name], extract: { type: "json-path", path: "$.image" } };
}

/** A component.json for `name` with the given targets per stage (`null` = not deployed). */
export function commandComponent(name, stages) {
  const out = {};
  for (const [stage, targets] of Object.entries(stages)) out[stage] = targets === null ? null : { targets: targets.map((target) => commandTarget(stage, target)) };
  return { schemaVersion: 1, name, stages: out };
}

/**
 * Installs `acme-deploy`: `images` maps `"<stage>/<target>"` → an image reference, or `null`
 * (the target does not exist: the command prints `{"image": null}` → missing).
 */
export function installDeploy(h, images) {
  h.install(
    "acme-deploy",
    Object.entries(images).map(([key, image]) => {
      const [stage, target] = key.split("/");
      return { match: ["show", stage, target], stdout: { image } };
    }),
  );
}

/**
 * The command fleet: three stages, acme-api and acme-worker with the given stage → targets maps.
 * acme-api's clone gets a linear history `c1 (tag v1.0.0) → c2 → c3 → c4 (HEAD, main)` and a
 * side branch `side` with `d1` off `c2`. Returns the commits' full and short shas.
 */
export function commandFleet(t, { api = { "stage-1": ["api"], "stage-2": ["api"], "stage-3": ["api"] }, worker = { "stage-1": ["worker"], "stage-2": null, "stage-3": null }, workspace } = {}) {
  const ws = threeStageWorkspace();
  if (typeof workspace === "function") workspace(ws);
  const fleet = buildFleet(t, {
    workspace: ws,
    api: api === null ? null : commandComponent("acme-api", api),
    worker: worker === null ? null : commandComponent("acme-worker", worker),
  });
  const commits = {};
  commits.c1 = commitAll(fleet.api, "feat: first release");
  git(fleet.api, "tag", "v1.0.0");
  commits.c2 = commitAll(fleet.api, "fix: second");
  git(fleet.api, "checkout", "-q", "-b", "side");
  put(join(fleet.api, "side.txt"), "side\n");
  commits.d1 = commitAll(fleet.api, "feat: side work");
  git(fleet.api, "checkout", "-q", "main");
  put(join(fleet.api, "three.txt"), "three\n");
  commits.c3 = commitAll(fleet.api, "feat: third");
  put(join(fleet.api, "four.txt"), "four\n");
  commits.c4 = commitAll(fleet.api, "chore: fourth");
  commits.w1 = commitAll(fleet.worker, "feat: worker");
  const short = Object.fromEntries(Object.entries(commits).map(([key, sha]) => [key, sha.slice(0, 7)]));
  const h = cliHarness(t);
  return { ...fleet, h, commits, short, ws: ["--workspace", fleet.platform] };
}

/** `registry.example.com/acme/<repo>:<tag>`. */
export function ref(repo, tag) {
  return `registry.example.com/acme/${repo}:${tag}`;
}
