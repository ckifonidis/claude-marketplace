/**
 * Adapter registry: builds the adapter for a target's `adapter` name from the workspace's
 * `adapters` settings block (spec requirements 23-28).
 */
import { EXIT, EngineError } from "../errors.js";
import { createAzureAppServiceAdapter } from "./azure-appservice.js";
import { createAzureContainerAppAdapter } from "./azure-containerapp.js";
import { createCommandAdapter } from "./command.js";
import { createComposeAdapter } from "./compose.js";
import { createKubernetesAdapter } from "./kubernetes.js";
export * from "./types.js";
export { classifyStderr, STDERR_PATTERNS } from "./stderr-patterns.js";
export { runCli, invokeCli, mapOutcome, MAX_OUTPUT_BYTES } from "./spawn.js";
export { createAzureAppServiceAdapter, discoverAzureAppService, listWebapps, WEBAPP_LIST_QUERY } from "./azure-appservice.js";
export { createAzureContainerAppAdapter, discoverAzureContainerApps } from "./azure-containerapp.js";
export { createKubernetesAdapter, discoverKubernetes, parseImageId, labelSelector } from "./kubernetes.js";
export { createComposeAdapter, discoverCompose, parseComposePs, matchRepoDigest } from "./compose.js";
export { createCommandAdapter, discoverCommand, extractImageReference } from "./command.js";
/** The CLI binary each adapter drives (`null` for `command`, whose binary is its configured argv[0]). */
export const ADAPTER_BINARIES = {
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
export function createAdapter(name, adapters, runtime) {
    const missing = () => {
        throw new EngineError(EXIT.INVALID, "validate", `workspace has no "adapters.${name}" settings`, { file: "workspace.json", pointer: `/adapters/${name}` });
    };
    switch (name) {
        case "azure-appservice":
            return createAzureAppServiceAdapter(adapters["azure-appservice"] ?? missing(), runtime);
        case "azure-containerapp":
            return createAzureContainerAppAdapter(adapters["azure-containerapp"] ?? missing(), runtime);
        case "kubernetes":
            return createKubernetesAdapter(adapters.kubernetes ?? missing(), runtime);
        case "compose":
            return createComposeAdapter(adapters.compose ?? missing(), runtime);
        case "command":
            return createCommandAdapter(adapters.command ?? missing(), runtime);
    }
    return missing();
}
