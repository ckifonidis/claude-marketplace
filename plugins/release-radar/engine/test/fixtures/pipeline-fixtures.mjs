// Pipeline fleet fixture (spec requirements 75-77): the command-adapter fleet of
// `cli-harness.mjs` (acme-api with c1 → c2 → c3 → c4 on main and d1 on `side`) plus an
// `azureDevOps` block pointing at the local fake REST server, and a pipeline mapping on
// stage-1/api (pipeline 101). Every name and value is synthetic.

import { writeFileSync } from "node:fs";
import { COMPONENT_SCHEMA } from "../../dist/config.js";
import { canonicalize, render } from "../../dist/format.js";
import { commandFleet, commandTarget, installDeploy, ref } from "./cli-harness.mjs";
import { PAT, PROJECT, startAzureDevOps } from "./fake-azure-devops.mjs";

/** The default mapping on stage-1/api. */
export function apiMapping() {
  return {
    provider: "azure-devops",
    pipelineId: 101,
    ref: "refs/heads/main",
    parameters: { action: "build", imageTag: "{commit.shortSha}" },
    imageTagParameter: "imageTag",
    actions: {
      build: { kind: "build", parameters: { action: "build" } },
      configure: { kind: "configuration", parameters: { action: "configure" } },
    },
    primaryAction: "build",
    landedWaitMinutes: 10,
  };
}

/** Writes a component value canonically (whatever key order the test built it in). */
export function writeComponent(path, value) {
  writeFileSync(path, render(canonicalize(value, COMPONENT_SCHEMA)), "utf8");
}

/**
 * Builds the fleet and starts the fake.
 * @param options.mapping   function(mapping) → mapping (may mutate), or a full mapping
 * @param options.targets   stage-1 targets of acme-api (default ["api"]; only "api" is mapped unless `extra` maps more)
 * @param options.extra     function(component) to mutate the component further
 * @param options.ado       options for startAzureDevOps (pipelines, builds, pageSize, slowMs)
 * @param options.settings  overrides of the azureDevOps block
 * @param options.images    acme-deploy answers ("stage-1/api" → image ref); default api at c3
 */
export async function pipelineFleet(t, { mapping, targets = ["api"], extra, ado: adoOptions = {}, settings = {}, images } = {}) {
  const ado = await startAzureDevOps(t, adoOptions);
  const fx = commandFleet(t, {
    api: { "stage-1": targets, "stage-2": null, "stage-3": null },
    worker: { "stage-1": ["worker"], "stage-2": null, "stage-3": null },
    workspace: (ws) => {
      ws.azureDevOps = {
        organizationUrl: ado.base,
        project: PROJECT,
        requestTimeoutSeconds: 1,
        runHistoryCount: 5,
        followPollSeconds: 1,
        followTimeoutMinutes: 1,
        confirmTokenTtlMinutes: 10,
        patExpiryWarningDays: 14,
        ...settings,
      };
    },
  });
  const base = apiMapping();
  const resolved = typeof mapping === "function" ? (mapping(base) ?? base) : (mapping ?? base);
  const component = {
    schemaVersion: 1,
    name: "acme-api",
    stages: {
      "stage-1": { targets: targets.map((name) => ({ ...commandTarget("stage-1", name), ...(name === "api" ? { pipeline: resolved } : {}) })) },
      "stage-2": null,
      "stage-3": null,
    },
  };
  if (typeof extra === "function") extra(component);
  writeComponent(fx.apiComponent, component);
  installDeploy(fx.h, images?.(fx) ?? { "stage-1/api": ref("api", fx.short.c3), "stage-1/worker": ref("worker", fx.short.w1) });
  const env = { ...fx.h.env, AZURE_DEVOPS_EXT_PAT: PAT };
  return { ...fx, ado, env };
}
