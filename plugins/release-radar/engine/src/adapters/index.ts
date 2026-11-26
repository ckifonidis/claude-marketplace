/**
 * Adapter registry: builds the adapter for a target's `adapter` name from the workspace's
 * `adapters` settings block (spec requirements 23-28).
 */

import type { AdapterName, Workspace } from "../config.js";
import { EXIT, EngineError } from "../errors.js";
import { createAzureAppServiceAdapter } from "./azure-appservice.js";
import { createAzureContainerAppAdapter } from "./azure-containerapp.js";
import { createCommandAdapter } from "./command.js";
import { createComposeAdapter } from "./compose.js";
import { createKubernetesAdapter } from "./kubernetes.js";
import type { Adapter, AdapterRuntime } from "./types.js";

export * from "./types.js";
export { classifyStderr, STDERR_PATTERNS, type CliFamily, type StderrClass, type StderrPattern } from "./stderr-patterns.js";
export { runCli, invokeCli, mapOutcome, MAX_OUTPUT_BYTES, type SpawnSpec, type SpawnOutcome, type CliHints } from "./spawn.js";
export { createAzureAppServiceAdapter, discoverAzureAppService, listWebapps, WEBAPP_LIST_QUERY, type AppServiceSettings } from "./azure-appservice.js";
export { createAzureContainerAppAdapter, discoverAzureContainerApps, type ContainerAppSettings } from "./azure-containerapp.js";
export { createKubernetesAdapter, discoverKubernetes, parseImageId, labelSelector, type KubernetesSettings } from "./kubernetes.js";
export { createComposeAdapter, discoverCompose, parseComposePs, matchRepoDigest, type ComposeSettings } from "./compose.js";
export { createCommandAdapter, discoverCommand, extractImageReference, type CommandSettings } from "./command.js";

/** The CLI binary each adapter drives (`null` for `command`, whose binary is its configured argv[0]). */
export const ADAPTER_BINARIES: Readonly<Record<AdapterName, string | null>> = {
  "azure-appservice": "az",
  "azure-containerapp": "az",
  kubernetes: "kubectl",
  compose: "docker",
  command: null,
};

/**
 * Creates the adapter `name` from `workspace.adapters[name]`.
 * @throws EngineError 24 when the workspace has no settings block for it (config validation
 *   normally prevents this; nothing is defaulted).
 */
export function createAdapter<N extends AdapterName>(name: N, adapters: Workspace["adapters"], runtime: AdapterRuntime): Adapter<N> {
  const missing = (): never => {
    throw new EngineError(EXIT.INVALID, "validate", `workspace has no "adapters.${name}" settings`, { file: "workspace.json", pointer: `/adapters/${name}` });
  };
  switch (name) {
    case "azure-appservice":
      return createAzureAppServiceAdapter(adapters["azure-appservice"] ?? missing(), runtime) as unknown as Adapter<N>;
    case "azure-containerapp":
      return createAzureContainerAppAdapter(adapters["azure-containerapp"] ?? missing(), runtime) as unknown as Adapter<N>;
    case "kubernetes":
      return createKubernetesAdapter(adapters.kubernetes ?? missing(), runtime) as unknown as Adapter<N>;
    case "compose":
      return createComposeAdapter(adapters.compose ?? missing(), runtime) as unknown as Adapter<N>;
    case "command":
      return createCommandAdapter(adapters.command ?? missing(), runtime) as unknown as Adapter<N>;
  }
  return missing();
}
