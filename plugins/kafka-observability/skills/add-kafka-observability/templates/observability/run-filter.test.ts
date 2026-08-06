// Unit tests for the opt-in run filter (src/observability/run-filter.ts):
// env parsing (fail-fast on every inconsistent combination), glob matching
// over run_type + name/langgraph_node, and the unconditional root-run
// guarantee in both modes.
// Run after build: node --test dist/observability/run-filter.test.js

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@langchain/core/tracers/base";
import { RunFilter, readRunFilterFromEnv } from "./run-filter.js";

function clearFilterEnv(): void {
  delete process.env.KAFKA_RUN_FILTER_MODE;
  delete process.env.KAFKA_RUN_FILTER_PATTERNS;
}

afterEach(clearFilterEnv);

/** Minimal Run shape — the filter only reads run_type, name, parent_run_id,
 *  and extra.metadata.langgraph_node. */
function makeRun(fields: {
  run_type: string;
  name: string;
  parent_run_id?: string;
  langgraph_node?: string;
}): Run {
  return {
    run_type: fields.run_type,
    name: fields.name,
    parent_run_id: fields.parent_run_id,
    extra: fields.langgraph_node !== undefined ? { metadata: { langgraph_node: fields.langgraph_node } } : {},
  } as unknown as Run;
}

const PARENT = "11111111-1111-4111-8111-111111111111";

describe("readRunFilterFromEnv — parsing and fail-fast validation", () => {
  test("both vars unset → null (default: emit everything)", () => {
    clearFilterEnv();
    assert.equal(readRunFilterFromEnv(), null);
  });

  test('explicit KAFKA_RUN_FILTER_MODE=off → null', () => {
    clearFilterEnv();
    process.env.KAFKA_RUN_FILTER_MODE = "off";
    assert.equal(readRunFilterFromEnv(), null);
  });

  test("invalid mode fails fast (no-config-fallback rule)", () => {
    clearFilterEnv();
    process.env.KAFKA_RUN_FILTER_MODE = "denylist";
    process.env.KAFKA_RUN_FILTER_PATTERNS = "chain:__*";
    assert.throws(() => readRunFilterFromEnv(), /KAFKA_RUN_FILTER_MODE/);
  });

  test("patterns set while mode is off/unset fails fast (edge case — typo'd opt-in must not silently emit full volume)", () => {
    clearFilterEnv();
    process.env.KAFKA_RUN_FILTER_PATTERNS = "chain:__*";
    assert.throws(() => readRunFilterFromEnv(), /KAFKA_RUN_FILTER_PATTERNS is set but/);
  });

  test("mode allow/deny without patterns fails fast", () => {
    for (const mode of ["allow", "deny"]) {
      clearFilterEnv();
      process.env.KAFKA_RUN_FILTER_MODE = mode;
      assert.throws(() => readRunFilterFromEnv(), /non-empty KAFKA_RUN_FILTER_PATTERNS/, `mode=${mode}`);
    }
  });

  test('a pattern without ":" or with an empty side fails fast', () => {
    for (const bad of ["__start__", ":agent", "chain:", " : "]) {
      clearFilterEnv();
      process.env.KAFKA_RUN_FILTER_MODE = "deny";
      process.env.KAFKA_RUN_FILTER_PATTERNS = bad;
      assert.throws(() => readRunFilterFromEnv(), /KAFKA_RUN_FILTER_PATTERNS entry/, `pattern=${JSON.stringify(bad)}`);
    }
  });

  test("whitespace around commas and entries is tolerated", () => {
    clearFilterEnv();
    process.env.KAFKA_RUN_FILTER_MODE = "deny";
    process.env.KAFKA_RUN_FILTER_PATTERNS = " chain:__* , chain:agent ";
    const filter = readRunFilterFromEnv();
    assert.ok(filter);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "agent", parent_run_id: PARENT })), false);
  });
});

describe("RunFilter — deny mode", () => {
  const filter = new RunFilter("deny", ["chain:__*", "chain:agent"]);

  test("a matching child run is dropped", () => {
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "__start__", parent_run_id: PARENT })), false);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "agent", parent_run_id: PARENT })), false);
  });

  test("a non-matching child run is kept", () => {
    assert.equal(filter.shouldEmit(makeRun({ run_type: "llm", name: "ChatOpenAI", parent_run_id: PARENT })), true);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "resolve_handoff", parent_run_id: PARENT })), true);
  });

  test("run_type must match too — llm child sharing the wrapper's langgraph_node survives `chain:agent` (edge case)", () => {
    // LLM/tool children inherit the wrapping node's langgraph_node value.
    const llmChild = makeRun({ run_type: "llm", name: "ChatOpenAI", parent_run_id: PARENT, langgraph_node: "agent" });
    assert.equal(filter.shouldEmit(llmChild), true);
  });

  test("langgraph_node matches even when the run name differs (auto-generated RunnableLambda wrappers)", () => {
    const byNode = new RunFilter("deny", ["chain:route_after_agent"]);
    const wrapper = makeRun({
      run_type: "chain",
      name: "RunnableLambda",
      parent_run_id: PARENT,
      langgraph_node: "route_after_agent",
    });
    assert.equal(byNode.shouldEmit(wrapper), false);
  });

  test("the root run survives even when a rule matches it (edge case — root guarantee)", () => {
    const denyAll = new RunFilter("deny", ["*:*"]);
    assert.equal(denyAll.shouldEmit(makeRun({ run_type: "chain", name: "LangGraph" })), true);
  });
});

describe("RunFilter — allow mode", () => {
  const filter = new RunFilter("allow", ["llm:*", "tool:*", "chain:resolve_handoff"]);

  test("only matching child runs are kept", () => {
    assert.equal(filter.shouldEmit(makeRun({ run_type: "llm", name: "ChatOpenAI", parent_run_id: PARENT })), true);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "tool", name: "password_reset_agent_step", parent_run_id: PARENT })), true);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "resolve_handoff", parent_run_id: PARENT })), true);
  });

  test("non-matching child runs are dropped", () => {
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "agent", parent_run_id: PARENT })), false);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "__start__", parent_run_id: PARENT })), false);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "RunnableLambda", parent_run_id: PARENT })), false);
  });

  test("the root run survives without matching any rule (edge case — root guarantee)", () => {
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "LangGraph" })), true);
  });
});

describe("RunFilter — glob semantics", () => {
  test('"*" spans any characters; everything else is literal (regex metacharacters do not leak)', () => {
    const filter = new RunFilter("deny", ["chain:node.v1*"]);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "node.v1-beta", parent_run_id: PARENT })), false);
    // "." must not act as a regex wildcard:
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "nodeXv1-beta", parent_run_id: PARENT })), true);
  });

  test("matching is anchored — a pattern must cover the whole name (edge case)", () => {
    const filter = new RunFilter("deny", ["chain:agent"]);
    assert.equal(filter.shouldEmit(makeRun({ run_type: "chain", name: "agent_v2", parent_run_id: PARENT })), true);
  });
});
