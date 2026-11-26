/**
 * `discover` (spec requirements 12, 74; Assumption 6): lists the targets one adapter's source can
 * see, raw and ungrouped. No name is inferred, paired, shortened or invented — every name is
 * printed exactly as the source listed it. Read-only: the adapter's preflight, then its listing.
 *
 * Scope flags per adapter (nothing defaulted; an absent optional scope has the stated meaning):
 * - `azure-appservice`: `--stage <name>` (absent = every stage that has subscriptions configured);
 * - `azure-containerapp`: `--subscription <id>` (required), `--resource-group <rg>` (optional);
 * - `kubernetes`: `--context <ctx>` and `--namespace <ns>` (both required);
 * - `compose`: `--project <name>` (absent = every project `docker compose ls --all` lists);
 * - `command`: none; lists through `adapters.command.discoverArgv`, or says it cannot discover.
 * A scope flag that does not apply to the chosen adapter is an argument error (64).
 */

import type { AdapterName, Workspace } from "../config.js";
import {
  createAdapter,
  discoverAzureAppService,
  discoverAzureContainerApps,
  discoverCommand,
  discoverCompose,
  discoverKubernetes,
} from "../adapters/index.js";
import type { Adapter, DiscoverCandidate, PreflightResult, TargetRequest } from "../adapters/types.js";
import { argumentError } from "../args.js";
import { EXIT, EngineError } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { loadWorkspaceSkeleton } from "../workspace.js";
import type { CommandContext, CommandOutput } from "./types.js";

/** Every adapter name, in documentation order. */
export const ADAPTER_NAMES: readonly AdapterName[] = ["azure-appservice", "azure-containerapp", "kubernetes", "compose", "command"];

const SCOPE_FLAGS: Readonly<Record<AdapterName, readonly string[]>> = {
  "azure-appservice": ["stage"],
  "azure-containerapp": ["subscription", "resource-group"],
  kubernetes: ["context", "namespace"],
  compose: ["project"],
  command: [],
};

/** Parsed `discover` options. */
export interface DiscoverOptions {
  readonly workspace: string;
  readonly adapter: string;
  /** Scope flag → value (`stage`, `subscription`, `resource-group`, `context`, `namespace`, `project`). */
  readonly scope: ReadonlyMap<string, string>;
  readonly json: boolean;
}

function requireScope(options: DiscoverOptions, flag: string): string {
  const value = options.scope.get(flag);
  if (value === undefined) throw argumentError(`discover --adapter ${options.adapter} requires --${flag} <value>`);
  return value;
}

/** Validates names and scope flags against the workspace (64), before any adapter call. */
function checkScope(options: DiscoverOptions, workspace: Workspace): AdapterName {
  if (!(ADAPTER_NAMES as readonly string[]).includes(options.adapter)) {
    throw argumentError(`unknown adapter "${options.adapter}" (adapters: ${ADAPTER_NAMES.join(", ")})`);
  }
  const adapter = options.adapter as AdapterName;
  const configured = ADAPTER_NAMES.filter((name) => workspace.adapters[name] !== undefined);
  if (workspace.adapters[adapter] === undefined) {
    throw argumentError(`adapter "${adapter}" is not configured in the workspace (configured: ${configured.join(", ") || "none"}); add "adapters.${adapter}" first`);
  }
  for (const flag of options.scope.keys()) {
    if (!SCOPE_FLAGS[adapter].includes(flag)) {
      throw argumentError(`--${flag} does not apply to --adapter ${adapter} (scope flags: ${SCOPE_FLAGS[adapter].map((f) => `--${f}`).join(", ") || "none"})`);
    }
  }
  if (adapter === "azure-appservice") {
    const stage = options.scope.get("stage");
    const subscriptions = workspace.adapters["azure-appservice"]?.stageSubscriptions ?? {};
    if (stage !== undefined) {
      if (!workspace.stages.some((candidate) => candidate.name === stage)) {
        throw argumentError(`unknown stage "${stage}" (stages: ${workspace.stages.map((s) => s.name).join(", ")})`);
      }
      if (!Object.hasOwn(subscriptions, stage)) throw argumentError(`stage "${stage}" has no adapters.azure-appservice.stageSubscriptions entry`);
    }
  }
  if (adapter === "azure-containerapp") requireScope(options, "subscription");
  if (adapter === "kubernetes") {
    requireScope(options, "context");
    requireScope(options, "namespace");
  }
  return adapter;
}

function candidateLine(candidate: DiscoverCandidate): string {
  const fields = Object.entries(candidate.fields).map(([key, value]) => `${key}=${value}`).join(" ");
  const details = Object.entries(candidate.details)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const parts = [candidate.stage === null ? "" : `[${candidate.stage}]`, fields, candidate.image === null ? "" : `image=${candidate.image}`, candidate.state === null ? "" : `state=${candidate.state}`, details];
  return `  ${parts.filter((part) => part !== "").join("  ")}`;
}

/** Runs `discover`. @throws EngineError 64/24/29 before any call; 20/21 from the source. */
export async function runDiscover(options: DiscoverOptions, context: CommandContext): Promise<CommandOutput> {
  const skeleton = loadWorkspaceSkeleton(options.workspace);
  const adapterName = checkScope(options, skeleton.workspace);
  const nonCanonical = [skeleton.report, ...(skeleton.repoPaths.ownership === "owned" ? [{ file: skeleton.repoPaths.file, state: skeleton.repoPaths.state }] : [])].filter(
    (report) => report.state === "non-canonical",
  );
  if (nonCanonical.length > 0) {
    throw new EngineError(EXIT.NON_CANONICAL, "canonical", `non-canonical input (run format first): ${nonCanonical.map((r) => r.file).join(", ")}`, { file: (nonCanonical[0] as { file: string }).file });
  }
  const ws = skeleton.workspace;
  const runtime = { env: context.env };
  const adapter = createAdapter(adapterName, ws.adapters, runtime) as Adapter;
  const preflightRequests: TargetRequest[] =
    adapterName === "kubernetes"
      ? [{ key: "discover", stage: "", target: { name: "discover", adapter: "kubernetes", context: requireScope(options, "context"), namespace: requireScope(options, "namespace"), deployment: "*" } }]
      : [];
  const preflight: PreflightResult = await adapter.preflight(preflightRequests);

  let candidates: DiscoverCandidate[] | null;
  switch (adapterName) {
    case "azure-appservice": {
      const settings = ws.adapters["azure-appservice"];
      const stage = options.scope.get("stage");
      const stages = stage !== undefined ? [stage] : ws.stages.map((s) => s.name).filter((name) => Object.hasOwn(settings?.stageSubscriptions ?? {}, name));
      candidates = settings === undefined ? [] : await discoverAzureAppService(settings, runtime, stages);
      break;
    }
    case "azure-containerapp": {
      const settings = ws.adapters["azure-containerapp"];
      const group = options.scope.get("resource-group");
      const scope = group === undefined ? { subscription: requireScope(options, "subscription") } : { subscription: requireScope(options, "subscription"), resourceGroup: group };
      candidates = settings === undefined ? [] : await discoverAzureContainerApps(settings, runtime, scope);
      break;
    }
    case "kubernetes": {
      const settings = ws.adapters.kubernetes;
      candidates = settings === undefined ? [] : await discoverKubernetes(settings, runtime, { context: requireScope(options, "context"), namespace: requireScope(options, "namespace") });
      break;
    }
    case "compose": {
      const settings = ws.adapters.compose;
      const project = options.scope.get("project");
      candidates = settings === undefined ? [] : await discoverCompose(settings, runtime, project === undefined ? {} : { project });
      break;
    }
    case "command": {
      const settings = ws.adapters.command;
      candidates = settings === undefined ? null : await discoverCommand(settings, runtime);
      break;
    }
  }

  const scope = Object.fromEntries([...options.scope.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  if (options.json) {
    const document = {
      schemaVersion: 1,
      engineVersion: engineVersion(),
      command: "discover",
      adapter: adapterName,
      scope,
      preflight: { commands: preflight.commands, identity: preflight.identity },
      canDiscover: candidates !== null,
      candidates: candidates ?? [],
    };
    return { exitCode: EXIT.OK, phase: "complete", stdout: `${JSON.stringify(document, null, 2)}\n`, stderr: [], json: true };
  }
  const lines = [`release-radar discover — adapter ${adapterName} (read-only; names are printed exactly as listed, nothing is inferred)`];
  if (preflight.commands.length > 0) lines.push(`  preflight: ${preflight.commands.join("; ")}${preflight.identity === null ? "" : ` — signed in as ${preflight.identity}`}`);
  if (candidates === null) {
    lines.push("  the command adapter cannot discover: the workspace declares no adapters.command.discoverArgv");
  } else if (candidates.length === 0) {
    lines.push("  no candidates listed");
  } else {
    lines.push(`  ${candidates.length} candidate(s):`);
    for (const candidate of candidates) lines.push(candidateLine(candidate));
  }
  return { exitCode: EXIT.OK, phase: "complete", stdout: `${lines.join("\n")}\n`, stderr: [], json: false };
}
