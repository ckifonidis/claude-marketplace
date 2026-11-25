// Synthetic workspace fixtures (spec requirement 77): an orchestration repo `acme-platform`
// with two members, `acme-api` and `acme-worker`, each in its own throw-away git clone.
// Every name is synthetic. Nothing here touches a real repository or network.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Canonical rendering used by the engine: 2-space indent, LF, trailing newline. */
export function text(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A fresh canonical workspace.json value (object key order = schema order). */
export function workspaceValue() {
  return {
    schemaVersion: 1,
    operatorTeam: "dev-team",
    stages: [
      { name: "stage-1", tagConvention: { type: "sha" }, promotion: { mode: "pipeline", owner: "dev-team" } },
      { name: "stage-2", tagConvention: { type: "git-tag", gitTagPrefix: "v" }, promotion: { mode: "handoff", owner: "ops-team" } },
    ],
    members: [
      { name: "acme-api", repoKey: "acme-api", repoSubdir: null },
      { name: "acme-worker", repoKey: "acme-worker", repoSubdir: "worker" },
    ],
    reposFile: { kind: "owned" },
    gitTimeoutSeconds: 15,
    freshnessMinutes: 30,
    checklist: ".release-radar/checks.md",
    beforePromote: { "stage-2": "acme-release-review" },
    snapshotRetention: 20,
    handoffRetention: 5,
    adapters: {
      "azure-appservice": {
        timeoutSeconds: 60,
        stageSubscriptions: {
          "stage-1": ["00000000-0000-0000-0000-000000000001"],
          "stage-2": ["00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003"],
        },
      },
      kubernetes: { timeoutSeconds: 30 },
      compose: { timeoutSeconds: 20 },
    },
    azureDevOps: {
      organizationUrl: "https://dev.azure.example/acme",
      project: "acme",
      requestTimeoutSeconds: 30,
      runHistoryCount: 5,
      followPollSeconds: 15,
      followTimeoutMinutes: 60,
      confirmTokenTtlMinutes: 10,
      patExpiryWarningDays: 14,
    },
  };
}

/** A fresh canonical component.json for acme-api. */
export function apiComponentValue() {
  return {
    schemaVersion: 1,
    name: "acme-api",
    tagConventionOverrides: {
      "stage-2": { type: "regex", pattern: "^v?(?<ref>\\d+\\.\\d+\\.\\d+)$", resolveAs: { type: "git-tag", gitTagPrefix: "" } },
    },
    stages: {
      "stage-1": {
        targets: [
          {
            name: "api",
            adapter: "azure-appservice",
            webapp: "acme-api-stage1",
            pipeline: {
              provider: "azure-devops",
              pipelineId: 12,
              ref: "refs/heads/main",
              parameters: { action: "build-and-push", imageTag: "{commit.shortSha}", target: "{target}" },
              userSelectable: { region: ["region-a", "region-b"] },
              actions: {
                build: { kind: "build", parameters: { action: "build-and-push" } },
                config: { kind: "configuration", parameters: { action: "config-only" } },
              },
              primaryAction: "build",
              landedWaitMinutes: 20,
            },
          },
          { name: "api-internal", adapter: "kubernetes", context: "stage-1", namespace: "acme", deployment: "acme-api" },
        ],
        verification: {
          timeoutSeconds: 10,
          checks: [
            {
              name: "health",
              type: "http",
              target: "api",
              url: "https://acme-api.stage-1.example.com/health",
              method: "GET",
              expectStatus: [200, 204],
              headers: { "X-Api-Key": { env: "ACME_HEALTH_KEY" } },
            },
            { name: "smoke-login", type: "smoke", argv: ["acme-cli", "login", "--dry-run"] },
            {
              name: "version",
              type: "version",
              url: "https://acme-api.stage-1.example.com/version",
              extract: { type: "json-path", path: "$.build.commit" },
              compare: "commit",
              timeoutSeconds: 5,
            },
          ],
        },
      },
      "stage-2": {
        targets: [{ name: "api", adapter: "azure-appservice", webapp: "acme-api-stage2" }],
        handoff: { settingsFiles: ["config/settings.stage-2.json"], beforePromote: "acme-api-release-notes" },
        verification: {
          timeoutSeconds: 10,
          checks: [{ name: "smoke-ping", type: "smoke", argv: ["acme-cli", "ping"] }],
        },
      },
    },
  };
}

/** A fresh canonical component.json for acme-worker (not deployed on stage-2). */
export function workerComponentValue() {
  return {
    schemaVersion: 1,
    name: "acme-worker",
    stages: {
      "stage-1": { targets: [{ name: "worker", adapter: "compose", project: "acme", service: "worker" }] },
      "stage-2": null,
    },
  };
}

/** Owned repos file value mapping the two members (relative to `.release-radar/`). */
export function reposValue(repos = { "acme-api": "../../acme-api", "acme-worker": "../../acme-worker" }) {
  return { schemaVersion: 1, repos };
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Runs git in `cwd` for fixture setup (never against a real repository). */
export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `git init` + optional first empty commit. */
export function initRepo(dir, { commit = true } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  if (commit) git(dir, "commit", "-q", "--allow-empty", "-m", "chore: initial commit");
  return dir;
}

/** Commits every working-tree change with `message`; returns the new HEAD sha. */
export function commitAll(dir, message) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** A temp directory (real path) removed after the test. */
export function tempDir(t, prefix = "release-radar-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes `content` (a string, or a value rendered canonically) at `path`, creating parents. */
export function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : text(content), "utf8");
  return path;
}

/**
 * Builds the full synthetic fleet under a temp dir:
 *   <base>/acme-platform/.release-radar/{workspace.json, repos.local.json, checks.md}
 *   <base>/acme-api/.release-radar/component.json            (git repo)
 *   <base>/acme-worker/worker/.release-radar/component.json  (git repo, repoSubdir "worker")
 * `options.workspace`, `.api`, `.worker`, `.repos` override the values (a function receives
 * the default value and may mutate it; `null` skips writing that file).
 */
export function buildFleet(t, options = {}) {
  const base = tempDir(t);
  const platform = join(base, "acme-platform");
  const api = join(base, "acme-api");
  const worker = join(base, "acme-worker");
  const apply = (option, value) => (typeof option === "function" ? (option(value) ?? value) : option === undefined ? value : option);
  initRepo(platform);
  initRepo(api);
  initRepo(worker);
  const workspace = apply(options.workspace, workspaceValue());
  const paths = {
    base,
    platform,
    api,
    worker,
    workspaceFile: join(platform, ".release-radar", "workspace.json"),
    reposFile: join(platform, ".release-radar", "repos.local.json"),
    checklist: join(platform, ".release-radar", "checks.md"),
    apiComponent: join(api, ".release-radar", "component.json"),
    workerComponent: join(worker, "worker", ".release-radar", "component.json"),
  };
  if (workspace !== null) put(paths.workspaceFile, workspace);
  const repos = apply(options.repos, reposValue());
  if (repos !== null) put(paths.reposFile, repos);
  put(paths.checklist, "# release-radar checklist\n\nschemaVersion: 1\n");
  const apiValue = apply(options.api, apiComponentValue());
  if (apiValue !== null) put(paths.apiComponent, apiValue);
  const workerValue = apply(options.worker, workerComponentValue());
  if (workerValue !== null) put(paths.workerComponent, workerValue);
  return paths;
}

/** Asserts `fn` throws an EngineError with the given exit code (and optional location parts). */
export function expectEngineError(assert, fn, { exitCode, file, pointer, message }) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, "EngineError", `expected EngineError, got ${error}`);
    assert.equal(error.exitCode, exitCode, `exit code (${error.message})`);
    if (file !== undefined) assert.equal(error.location?.file, file);
    if (pointer !== undefined) assert.equal(error.location?.pointer, pointer, `pointer (${error.message})`);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}
