/**
 * release-radar engine CLI (spec requirements 10-22; plan decisions D5, D11, D13).
 *
 * `node <plugin root>/engine/dist/cli.js <command> [flags]`
 *
 * Commands in this engine build:
 * - `status --workspace <path> (<component>... | --all) [--stage <name>] [--json]
 *    [--fail-on-drift [<up>:<down>...]] [--no-pipelines] [--verify]`
 * - `verify --workspace <path> <component>... --stage <name> [--target <name>] [--expect <sha|tag>]
 *    [--check <name>[,<name>...]] [--json]`
 * - `discover --workspace <path> --adapter <name> [scope flags] [--json]`
 * - `validate-config --workspace <path> [--json]`
 * - `pipeline-runs --workspace <path> <component> [--stage <name>] [--target <name>] [--json]`
 * - `pipeline-run --workspace <path> <component> <runId> [--stage <name>] [--target <name>]
 *    [--follow] [--json]`
 * - `pipeline-preview --workspace <path> <component> --stage <name> [--target <name>]
 *    [--action <name>] [--select <parameter>=<value>]... [--json]` (read-only)
 * - `run-pipeline --workspace <path> <component> --stage <name> [--target <name>] [--action <name>]
 *    [--select <parameter>=<value>]... --confirm <token> [--follow] [--json]` — the ONLY remote
 *    mutation. Its module (the only importer of the write module) is loaded with a dynamic
 *    `import()` only when this command is dispatched, so no other command even loads it.
 * - `settings-diff --workspace <path> <component> --from <stage|local|sha> --to <stage|sha>
 *    [--stage <name>] [--json]` (read-only; values are never printed)
 * - `handoff-package --workspace <path> <component> --stage <handoff stage> --commit <sha> [--json]`
 *    (writes only its own package directory under the workspace's `.release-radar/handoff/`)
 * - `format [--check] (--workspace <path> [--include-members] [--index <file>] | --index <file>) [--json]`
 *    (`--check` is read-only; without it, the local maintenance of spec section N; `--index` alone
 *    is the index-only mode)
 * - `snapshot-info --workspace <path> <component> [--json]` (read-only change-risk freshness)
 * - `checklist-check --workspace <path> <component> --commit <sha> [--json]` (read-only; the
 *    component checklist at a commit, never rewritten)
 * - `where [--json]`
 * - `workspace-index (list | resolve <cwd> | register <path> | unregister <path>) --index <file> [--json]`
 *
 * Every run ends with the trailer `RELEASE_RADAR_RESULT=<OK|FAIL> PHASE=<phase> EXIT=<code>`:
 * on stdout after a successful human-readable run, otherwise on stderr — and always on stderr
 * with `--json`, so stdout is exactly one JSON document. Exit codes and their precedence are
 * `errors.ts`; `--config` is rejected (64) everywhere in favour of `--workspace`.
 */

import { parseCommandArgs, argumentError, requireValue, type CommandSpec, type FlagKind } from "./args.js";
import { EXIT, EngineError } from "./errors.js";
import { trailerLine } from "./report.js";
import { runDiscover } from "./commands/discover.js";
import { runChecklistCheck } from "./commands/checklist-check.js";
import { runFormat } from "./commands/format.js";
import { runSnapshotInfo } from "./commands/snapshot-info.js";
import { runHandoffPackage } from "./commands/handoff-package.js";
import { runSettingsDiff } from "./commands/settings-diff.js";
import { runPipelinePreview } from "./commands/pipeline-preview.js";
import { parseRunId, runPipelineRun, runPipelineRuns } from "./commands/pipeline-runs.js";
import { DRIFT_PAIR_TOKEN, runStatus } from "./commands/status.js";
import type { CommandContext, CommandOutput } from "./commands/types.js";
import { runValidateConfig } from "./commands/validate-config.js";
import { runVerify } from "./commands/verify.js";
import { parseCheckList } from "./verify.js";
import { runWhere } from "./commands/where.js";
import { runWorkspaceIndex } from "./commands/workspace-index.js";

const USAGE = [
  "usage: node <plugin root>/engine/dist/cli.js <command> ...",
  "  status --workspace <path> (<component>... | --all) [--stage <name>] [--json] [--fail-on-drift [<up>:<down>...]] [--no-pipelines] [--verify]",
  "  verify --workspace <path> <component>... --stage <name> [--target <name>] [--expect <sha|tag>] [--check <name>[,<name>...]] [--json]",
  "  discover --workspace <path> --adapter <name> [--stage <s>] [--subscription <id>] [--resource-group <rg>] [--context <c>] [--namespace <n>] [--project <p>] [--json]",
  "  validate-config --workspace <path> [--json]",
  "  pipeline-runs --workspace <path> <component> [--stage <name>] [--target <name>] [--json]",
  "  pipeline-run --workspace <path> <component> <runId> [--stage <name>] [--target <name>] [--follow] [--json]",
  "  pipeline-preview --workspace <path> <component> --stage <name> [--target <name>] [--action <name>] [--select <parameter>=<value>]... [--json]",
  "  run-pipeline --workspace <path> <component> --stage <name> [--target <name>] [--action <name>] [--select <parameter>=<value>]... --confirm <token> [--follow] [--json]",
  "  settings-diff --workspace <path> <component> --from <stage|local|sha> --to <stage|sha> [--stage <name>] [--json]",
  "  handoff-package --workspace <path> <component> --stage <handoff stage> --commit <sha> [--json]",
  "  format [--check] --workspace <path> [--include-members] [--index <file>] [--json]",
  "  format [--check] --index <file> [--json]",
  "  snapshot-info --workspace <path> <component> [--json]",
  "  checklist-check --workspace <path> <component> --commit <sha> [--json]",
  "  where [--json]",
  "  workspace-index (list | resolve <cwd> | register <path> | unregister <path>) --index <file> [--json]",
].join("\n");

const BOOL: FlagKind = { kind: "boolean" };
const VALUE: FlagKind = { kind: "value" };
const REPEATABLE: FlagKind = { kind: "repeatable" };

const SPECS: Readonly<Record<string, CommandSpec>> = {
  status: {
    flags: {
      workspace: VALUE,
      all: BOOL,
      stage: VALUE,
      json: BOOL,
      "fail-on-drift": { kind: "optional-values", accepts: (token) => DRIFT_PAIR_TOKEN.test(token) },
      "no-pipelines": BOOL,
      verify: BOOL,
    },
    maxPositionals: Number.POSITIVE_INFINITY,
  },
  verify: {
    flags: { workspace: VALUE, stage: VALUE, target: VALUE, expect: VALUE, check: VALUE, json: BOOL },
    maxPositionals: Number.POSITIVE_INFINITY,
  },
  discover: {
    flags: {
      workspace: VALUE,
      adapter: VALUE,
      stage: VALUE,
      subscription: VALUE,
      "resource-group": VALUE,
      context: VALUE,
      namespace: VALUE,
      project: VALUE,
      json: BOOL,
    },
    maxPositionals: 0,
  },
  "validate-config": { flags: { workspace: VALUE, json: BOOL }, maxPositionals: 0 },
  "pipeline-runs": { flags: { workspace: VALUE, stage: VALUE, target: VALUE, json: BOOL }, maxPositionals: 1 },
  "pipeline-run": { flags: { workspace: VALUE, stage: VALUE, target: VALUE, follow: BOOL, json: BOOL }, maxPositionals: 2 },
  "pipeline-preview": { flags: { workspace: VALUE, stage: VALUE, target: VALUE, action: VALUE, select: REPEATABLE, json: BOOL }, maxPositionals: 1 },
  "run-pipeline": { flags: { workspace: VALUE, stage: VALUE, target: VALUE, action: VALUE, select: REPEATABLE, confirm: VALUE, follow: BOOL, json: BOOL }, maxPositionals: 1 },
  "settings-diff": { flags: { workspace: VALUE, from: VALUE, to: VALUE, stage: VALUE, json: BOOL }, maxPositionals: 1 },
  "handoff-package": { flags: { workspace: VALUE, stage: VALUE, commit: VALUE, json: BOOL }, maxPositionals: 1 },
  format: { flags: { workspace: VALUE, check: BOOL, "include-members": BOOL, index: VALUE, json: BOOL }, maxPositionals: 0 },
  "snapshot-info": { flags: { workspace: VALUE, json: BOOL }, maxPositionals: 1 },
  "checklist-check": { flags: { workspace: VALUE, commit: VALUE, json: BOOL }, maxPositionals: 1 },
  where: { flags: { json: BOOL }, maxPositionals: 0 },
  "workspace-index": { flags: { index: VALUE, json: BOOL }, maxPositionals: 2 },
};

async function dispatch(command: string, argv: readonly string[], context: CommandContext): Promise<CommandOutput> {
  const spec = SPECS[command];
  if (spec === undefined) {
    if (argv.includes("--config")) throw argumentError("--config is not supported: pass the workspace explicitly with --workspace <path>");
    throw argumentError(`unknown command "${command}" (commands in this engine build: ${Object.keys(SPECS).join(", ")})`);
  }
  const args = parseCommandArgs(command, argv, spec);
  const json = args.booleans.has("json");
  switch (command) {
    case "status": {
      const workspace = requireValue(args, command, "workspace", "path");
      const all = args.booleans.has("all");
      if (all && args.positionals.length > 0) throw argumentError("name components OR pass --all, not both");
      if (!all && args.positionals.length === 0) throw argumentError("status needs component names or --all");
      const pairs = args.lists.get("fail-on-drift");
      return runStatus(
        {
          workspace,
          components: all ? "all" : args.positionals,
          stage: args.values.get("stage") ?? null,
          json,
          failOnDrift: { enabled: pairs !== undefined, pairs: pairs ?? [] },
          noPipelines: args.booleans.has("no-pipelines"),
          verify: args.booleans.has("verify"),
        },
        context,
      );
    }
    case "verify": {
      const workspace = requireValue(args, command, "workspace", "path");
      const stage = requireValue(args, command, "stage", "name");
      const check = args.values.get("check");
      return runVerify(
        {
          workspace,
          components: args.positionals,
          stage,
          target: args.values.get("target") ?? null,
          expect: args.values.get("expect") ?? null,
          checks: check === undefined ? null : parseCheckList(check),
          json,
        },
        context,
      );
    }
    case "discover": {
      const workspace = requireValue(args, command, "workspace", "path");
      const adapter = requireValue(args, command, "adapter", "name");
      const scope = new Map([...args.values.entries()].filter(([flag]) => flag !== "workspace" && flag !== "adapter"));
      return runDiscover({ workspace, adapter, scope, json }, context);
    }
    case "validate-config":
      return runValidateConfig({ workspace: requireValue(args, command, "workspace", "path"), json }, context);
    case "pipeline-runs": {
      const workspace = requireValue(args, command, "workspace", "path");
      const [component] = args.positionals;
      if (component === undefined) throw argumentError("pipeline-runs needs a component name");
      return runPipelineRuns({ workspace, component, stage: args.values.get("stage") ?? null, target: args.values.get("target") ?? null, json }, context);
    }
    case "pipeline-run": {
      const workspace = requireValue(args, command, "workspace", "path");
      const [component, runId] = args.positionals;
      if (component === undefined || runId === undefined) throw argumentError("pipeline-run needs a component name and a run id");
      return runPipelineRun(
        { workspace, component, runId: parseRunId(runId), stage: args.values.get("stage") ?? null, target: args.values.get("target") ?? null, follow: args.booleans.has("follow"), json },
        context,
      );
    }
    case "pipeline-preview":
    case "run-pipeline": {
      const workspace = requireValue(args, command, "workspace", "path");
      const stage = requireValue(args, command, "stage", "name");
      const [component] = args.positionals;
      if (component === undefined) throw argumentError(`${command} needs a component name`);
      const request = { workspace, component, stage, target: args.values.get("target") ?? null, action: args.values.get("action") ?? null, selections: args.lists.get("select") ?? [] };
      if (command === "pipeline-preview") return runPipelinePreview({ ...request, json }, context);
      // Loaded only here: no other command loads the module that can send the one write.
      const { runRunPipeline } = await import("./commands/run-pipeline.js");
      return runRunPipeline({ ...request, confirm: args.values.get("confirm") ?? null, follow: args.booleans.has("follow"), json }, context);
    }
    case "settings-diff": {
      const workspace = requireValue(args, command, "workspace", "path");
      const [component] = args.positionals;
      if (component === undefined) throw argumentError("settings-diff needs a component name");
      const from = requireValue(args, command, "from", "stage|local|sha");
      const to = requireValue(args, command, "to", "stage|sha");
      return runSettingsDiff({ workspace, component, from, to, stage: args.values.get("stage") ?? null, json }, context);
    }
    case "handoff-package": {
      const workspace = requireValue(args, command, "workspace", "path");
      const [component] = args.positionals;
      if (component === undefined) throw argumentError("handoff-package needs a component name");
      const stage = requireValue(args, command, "stage", "handoff stage");
      const commit = requireValue(args, command, "commit", "sha");
      return runHandoffPackage({ workspace, component, stage, commit, json }, context);
    }
    case "format": {
      const workspace = args.values.get("workspace") ?? null;
      const index = args.values.get("index") ?? null;
      if (workspace === null && index === null) throw argumentError(`"format" requires --workspace <path>, --index <file> (index-only), or both`);
      const includeMembers = args.booleans.has("include-members");
      if (workspace === null && includeMembers) throw argumentError("--include-members needs --workspace <path> (an index-only run has no members)");
      return runFormat({ workspace, check: args.booleans.has("check"), includeMembers, index, json }, context);
    }
    case "snapshot-info": {
      const workspace = requireValue(args, command, "workspace", "path");
      const [component] = args.positionals;
      if (component === undefined) throw argumentError("snapshot-info needs a component name");
      return runSnapshotInfo({ workspace, component, json }, context);
    }
    case "checklist-check": {
      const workspace = requireValue(args, command, "workspace", "path");
      const [component] = args.positionals;
      if (component === undefined) throw argumentError("checklist-check needs a component name");
      const commit = requireValue(args, command, "commit", "sha");
      return runChecklistCheck({ workspace, component, commit, json }, context);
    }
    case "where":
      return runWhere({ json }, context);
    default: {
      const [action, operand] = args.positionals;
      if (action === undefined) throw argumentError("workspace-index needs an action: list | resolve <cwd> | register <path> | unregister <path>");
      return runWorkspaceIndex({ action, operand: operand ?? null, index: requireValue(args, command, "index", "file"), json }, context);
    }
  }
}

/** Runs the CLI; returns the exit code. Never throws. */
export async function main(argv: readonly string[], context: CommandContext): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command.startsWith("--")) {
      if (argv.includes("--config")) throw argumentError("--config is not supported: pass the workspace explicitly with --workspace <path>");
      throw argumentError("missing command");
    }
    const result = await dispatch(command, rest, context);
    if (result.stdout !== "") process.stdout.write(result.stdout);
    for (const line of result.stderr) process.stderr.write(`${line}\n`);
    const trailer = `${trailerLine(result.exitCode, result.phase)}\n`;
    if (result.exitCode === EXIT.OK && !result.json) process.stdout.write(trailer);
    else process.stderr.write(trailer);
    return result.exitCode;
  } catch (error) {
    if (error instanceof EngineError) {
      process.stderr.write(`release-radar: ${error.describe()}\n`);
      if (error.exitCode === EXIT.ARGS) process.stderr.write(`${USAGE}\n`);
      process.stderr.write(`${trailerLine(error.exitCode, error.phase)}\n`);
      return error.exitCode;
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`release-radar: internal error (exit 1): ${detail}\n`);
    process.stderr.write(`${trailerLine(EXIT.INTERNAL, "internal")}\n`);
    return EXIT.INTERNAL;
  }
}

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  now: () => new Date(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});
