// Synthetic settings / handoff fixtures (spec requirements 56, 64, 77). Every name and value is
// synthetic. The SENTINEL values below must never appear in any engine output: tests grep
// stdout, stderr and --json for each of them.

import { join } from "node:path";
import { WORKSPACE_SCHEMA } from "../../dist/config.js";
import { canonicalize } from "../../dist/format.js";
import { cliHarness, commandComponent, installDeploy, ref, threeStageWorkspace } from "./cli-harness.mjs";
import { buildFleet, commitAll, git, put, text } from "./workspace-fixtures.mjs";

/** Values that must never be printed by any command. */
export const SENTINELS = [
  "level-information-aa1",
  "level-verbose-bb2",
  "db-host-value-cc3",
  "flag-value-dd4",
  "removed-value-ee5",
  "s3cr3t-literal-VALUE-ff6",
  "env-secret-value-gg7",
  "env-secret-value-hh8",
  "brand-name-value-ii9",
  "legacy-value-jj0",
  "512512",
];

/** appsettings.json as deployed (at c1). */
export const SETTINGS_V1 = {
  Logging: { Level: "level-information-aa1" },
  Database: { Host: "db-host-value-cc3", Password: "@Microsoft.KeyVault(VaultName=acme-kv;SecretName=db-password)" },
  Old: { FeatureFlag: "flag-value-dd4" },
  Api: { Key: "${{ secrets.API_KEY }}" },
  Cache: { TtlSeconds: 30 },
  Queue: { Conn: "@Microsoft.KeyVault(VaultName=acme-kv;SecretName=queue-conn)" },
  Removed: "removed-value-ee5",
};

/** appsettings.json as promoted (at c2 and c3). */
export const SETTINGS_V2 = {
  Logging: { Level: "level-verbose-bb2" },
  Database: { Host: "db-host-value-cc3", Password: "@Microsoft.KeyVault(SecretUri=https://acme-kv.vault.azure.net/secrets/db-password-v2/)" },
  New: { FeatureFlag: "flag-value-dd4" },
  Api: { Key: "${{ secrets.API_KEY }}" },
  Cache: { TtlSeconds: 30, Size: 512512 },
  Payments: { ClientSecret: "s3cr3t-literal-VALUE-ff6" },
  Storage: "@Microsoft.KeyVault(VaultName=acme-kv;SecretName=storage-key)",
};

const ENV_V1 = "FEATURE_X=on\nENV_SECRET=env-secret-value-gg7\n";
const ENV_V2 = "FEATURE_X=on\nENV_SECRET=env-secret-value-hh8\nFEATURE_Y=off\n";

/** acme-api's component.json declaring `settingsFiles` (and a beforePromote pointer) on stage-3. */
export function apiComponent(settingsFiles) {
  const value = commandComponent("acme-api", { "stage-1": ["api"], "stage-2": ["api"], "stage-3": ["api"] });
  value.stages["stage-3"].handoff = { settingsFiles: [...settingsFiles].sort(), beforePromote: "acme-api-ops-notes" };
  return value;
}

/**
 * The handoff fleet: three stages (stage-3 = handoff owned by ops-team), acme-api with history
 *   c1 (tag v1.0.0): appsettings v1, extra.env v1, legacy.json; declares [appsettings, extra.env]
 *   c2: appsettings v2, extra.env v2, new.json, legacy.json removed; declares all four files
 *   c3: declares [appsettings, extra.env, new.json]   (HEAD; the working tree equals c3)
 * Deployed: stage-1 and stage-2 run c3, stage-3 runs v1.0.0 (= c1).
 */
export function handoffFleet(t, { workspace, images } = {}) {
  const ws = threeStageWorkspace();
  ws.beforePromote = { "stage-3": "acme-release-review" };
  if (typeof workspace === "function") workspace(ws);
  const fleet = buildFleet(t, { workspace: canonicalize(ws, WORKSPACE_SCHEMA), api: apiComponent(["config/appsettings.json", "config/extra.env"]), worker: commandComponent("acme-worker", { "stage-1": ["worker"], "stage-2": null, "stage-3": null }) });
  const api = fleet.api;
  put(join(api, "config", "appsettings.json"), SETTINGS_V1);
  put(join(api, "config", "extra.env"), ENV_V1);
  put(join(api, "config", "legacy.json"), { LegacyOnly: "legacy-value-jj0" });
  const commits = {};
  commits.c1 = commitAll(api, "feat: first release");
  git(api, "tag", "v1.0.0");
  put(join(api, "config", "appsettings.json"), SETTINGS_V2);
  put(join(api, "config", "extra.env"), ENV_V2);
  put(join(api, "config", "new.json"), { Brand: { Name: "brand-name-value-ii9" } });
  git(api, "rm", "-q", join("config", "legacy.json"));
  put(fleet.apiComponent, apiComponent(["config/appsettings.json", "config/extra.env", "config/legacy.json", "config/new.json"]));
  commits.c2 = commitAll(api, "feat: new settings");
  put(fleet.apiComponent, apiComponent(["config/appsettings.json", "config/extra.env", "config/new.json"]));
  commits.c3 = commitAll(api, "chore: drop legacy settings from the handoff");
  commits.w1 = commitAll(fleet.worker, "feat: worker");
  const short = Object.fromEntries(Object.entries(commits).map(([key, sha]) => [key, sha.slice(0, 7)]));
  const h = cliHarness(t);
  installDeploy(h, images ?? { "stage-1/api": ref("api", short.c3), "stage-2/api": ref("api", short.c3), "stage-3/api": ref("api", "1.0.0"), "stage-1/worker": ref("worker", short.w1) });
  return { ...fleet, h, commits, short, ws: ["--workspace", fleet.platform] };
}

/** Asserts no sentinel value appears in `output`. */
export function assertNoValues(assert, output, label) {
  for (const value of SENTINELS) assert.ok(!output.includes(value), `${label}: the value ${JSON.stringify(value)} leaked`);
}

export { text };
