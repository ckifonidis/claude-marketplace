// FILE: src/observability/run-filter.ts
//
// Opt-in run filtering. By default the tracer emits a request/response event
// pair for EVERY traced run (full LangSmith parity). Real traces show that
// many of those runs are pure wrappers whose payloads are byte-identical to a
// nested run's (a LangGraph `agent` node rewrapping its LLM call, a `tools`
// node rewrapping its tool run, the `__start__` pseudo-node echoing the root
// inputs) — an app team that has VERIFIED this against its own payloads can
// opt into dropping them here and cut event volume with no information loss.
//
// Two env vars, read fail-fast at startup (no-config-fallback rule):
//
//   KAFKA_RUN_FILTER_MODE      off (default) | allow | deny
//   KAFKA_RUN_FILTER_PATTERNS  comma-separated `run_type:name` globs
//
// A pattern matches a run when its run_type glob matches `run.run_type` AND
// its name glob matches `run.name` OR `metadata.langgraph_node` (LLM/tool
// children inherit the wrapping node's langgraph_node, so the run_type side
// is what keeps `chain:agent` from also dropping the nested llm run).
// `deny` drops matching runs; `allow` drops everything that does NOT match.
//
// THE ROOT RUN ALWAYS SURVIVES, in both modes: it is the sole carrier of the
// full invocation input/final state, and the only event without
// `metadata.langgraph_node` — downstream timeline consumers key their
// turn-boundary detection on exactly that absence.
//
// Filtering never re-parents surviving events: `parent_run_id`/`dotted_order`
// are emitted verbatim and may reference runs that were filtered out.

import type { Run } from "@langchain/core/tracers/base";
import { optionalEnv } from "./env.js";

export type RunFilterMode = "allow" | "deny";

interface CompiledRule {
  runType: RegExp;
  name: RegExp;
}

/** `*`-only glob → anchored RegExp. Everything except `*` is literal. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

function compileRule(raw: string): CompiledRule {
  const sep = raw.indexOf(":");
  const runType = sep === -1 ? "" : raw.slice(0, sep).trim();
  const name = sep === -1 ? "" : raw.slice(sep + 1).trim();
  if (runType.length === 0 || name.length === 0) {
    throw new Error(
      `KAFKA_RUN_FILTER_PATTERNS entry must be "<run_type>:<name>" (globs, "*" allowed). Got: "${raw}"`,
    );
  }
  return { runType: globToRegExp(runType), name: globToRegExp(name) };
}

export class RunFilter {
  private readonly rules: CompiledRule[];

  constructor(
    readonly mode: RunFilterMode,
    private readonly patterns: string[],
  ) {
    if (patterns.length === 0) {
      throw new Error(`KAFKA_RUN_FILTER_MODE=${mode} requires a non-empty KAFKA_RUN_FILTER_PATTERNS.`);
    }
    this.rules = patterns.map(compileRule);
  }

  /** True when this run's events should be emitted. Pure function of fields
   *  that are stable across a run's lifetime, so a run's request and response
   *  events always share the same fate. */
  shouldEmit(run: Run): boolean {
    if (!run.parent_run_id) return true; // root run: unconditional, both modes
    const metadata = (run.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    const node = metadata?.langgraph_node;
    const matched = this.rules.some(
      (rule) =>
        rule.runType.test(run.run_type) &&
        (rule.name.test(run.name) || (typeof node === "string" && rule.name.test(node))),
    );
    return this.mode === "deny" ? !matched : matched;
  }

  /** One-line summary for the startup log. */
  describe(): string {
    return `mode=${this.mode} patterns=${this.patterns.join(",")}`;
  }
}

/** Read + validate the filter config. Returns null when filtering is off (the
 *  default — full LangSmith parity). Throws on any inconsistent combination,
 *  including patterns supplied while the mode is off: silently ignoring them
 *  would let a typo'd mode re-enable full volume without anyone noticing. */
export function readRunFilterFromEnv(): RunFilter | null {
  const mode = optionalEnv("KAFKA_RUN_FILTER_MODE") ?? "off";
  const rawPatterns = optionalEnv("KAFKA_RUN_FILTER_PATTERNS");
  if (mode === "off") {
    if (rawPatterns !== undefined) {
      throw new Error(
        'KAFKA_RUN_FILTER_PATTERNS is set but KAFKA_RUN_FILTER_MODE is off/unset — set the mode to "allow" or "deny", or remove the patterns.',
      );
    }
    return null;
  }
  if (mode !== "allow" && mode !== "deny") {
    throw new Error(`KAFKA_RUN_FILTER_MODE must be one of "off" | "allow" | "deny". Got: "${mode}"`);
  }
  const patterns = (rawPatterns ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return new RunFilter(mode, patterns);
}
