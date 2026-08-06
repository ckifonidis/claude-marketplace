// Unit tests for KafkaRunTracer (src/observability/run-tracer.ts): drives the
// REAL BaseTracer handler entrypoints (handleChainStart/End, handleChatModelStart,
// handleToolStart, …) — the same calls LangChain/LangGraph make during a run —
// and asserts on the events an injected fake-producer emitter captures.
// Run after build: node --test dist/observability/run-tracer.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { KafkaRunTracer } from "./run-tracer.js";
import { RunEventEmitter } from "./event-emitter.js";
import { RunFilter } from "./run-filter.js";
import type { EventProducer } from "./event-producer.js";
import type { ObservabilityEvent } from "./schemas.js";

class FakeProducer implements EventProducer {
  readonly produced: Array<{ topic: string; key: string; value: Buffer }> = [];
  produce(topic: string, key: string, value: Buffer): void {
    this.produced.push({ topic, key, value });
  }
}

function harness(filter?: RunFilter): { tracer: KafkaRunTracer; events: () => ObservabilityEvent[] } {
  const producer = new FakeProducer();
  const emitter = new RunEventEmitter(producer, "test_app", "t");
  const tracer = new KafkaRunTracer({ emitter, filter });
  return {
    tracer,
    events: () => producer.produced.map((p) => JSON.parse(p.value.toString("utf-8")) as ObservabilityEvent),
  };
}

const SERIALIZED = { lc: 1, type: "not_implemented" as const, id: ["test"] };
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";

describe("KafkaRunTracer — start/end event pairs", () => {
  test("a chain run emits request at start and response at end, same run_id", async () => {
    const { tracer, events } = harness();
    await tracer.handleChainStart(SERIALIZED, { question: "hi" }, RUN_ID, undefined, [], { thread_id: "t-1" });
    await tracer.handleChainEnd({ answer: "ok" }, RUN_ID);

    const all = events();
    assert.equal(all.length, 2);
    const [start, end] = all;
    assert.equal(start.data.direction, "request");
    assert.equal(end.data.direction, "response");
    assert.equal(start.data.run_id, end.data.run_id);
    assert.equal(start.data.run_type, "chain");
    assert.deepEqual(start.data.inputs, { question: "hi" });
    assert.deepEqual(end.data.outputs, { answer: "ok" });
    assert.equal(end.data.status, "success");
    assert.equal(typeof end.data.latency_ms, "number");
  });

  test("thread_id is taken from run metadata (LangGraph's configurable.thread_id)", async () => {
    const { tracer, events } = harness();
    await tracer.handleChainStart(SERIALIZED, {}, RUN_ID, undefined, [], { thread_id: "thread-42" });
    await tracer.handleChainEnd({}, RUN_ID);
    for (const event of events()) assert.equal(event.thread_id, "thread-42");
  });

  test("a child run WITHOUT its own metadata inherits the trace's thread_id (edge case)", async () => {
    const { tracer, events } = harness();
    await tracer.handleChainStart(SERIALIZED, {}, RUN_ID, undefined, [], { thread_id: "thread-42" });
    await tracer.handleToolStart(SERIALIZED, "tool input", CHILD_ID, RUN_ID);
    await tracer.handleToolEnd({ ok: true }, CHILD_ID);
    await tracer.handleChainEnd({}, RUN_ID);

    const childEvents = events().filter((e) => e.data.run_id === CHILD_ID);
    assert.equal(childEvents.length, 2);
    for (const event of childEvents) assert.equal(event.thread_id, "thread-42");
    assert.equal(childEvents[0].data.parent_run_id, RUN_ID);
    assert.equal(childEvents[0].data.run_type, "tool");
  });

  test("a run with no thread anywhere falls back to \"no-thread\" (edge case — direct invoke)", async () => {
    const { tracer, events } = harness();
    await tracer.handleChainStart(SERIALIZED, {}, RUN_ID);
    await tracer.handleChainEnd({}, RUN_ID);
    for (const event of events()) assert.equal(event.thread_id, "no-thread");
  });

  test("a chat model run captures the full rendered messages", async () => {
    const { tracer, events } = harness();
    await tracer.handleChatModelStart(SERIALIZED, [[new HumanMessage("γεια σας")]], RUN_ID, undefined, undefined, [], {
      thread_id: "t-1",
    });
    const [start] = events();
    assert.equal(start.data.run_type, "llm");
    const json = JSON.stringify(start.data.inputs);
    assert.ok(json.includes("γεια σας"), "prompt content must be captured");
  });

  test("an errored run emits a response event with status=error and the message", async () => {
    const { tracer, events } = harness();
    await tracer.handleChainStart(SERIALIZED, {}, RUN_ID, undefined, [], { thread_id: "t-1" });
    await tracer.handleChainError(new Error("backend down"), RUN_ID);

    const response = events().find((e) => e.data.direction === "response");
    assert.ok(response);
    assert.equal(response.data.status, "error");
    assert.ok(response.data.error?.includes("backend down"));
  });
});

describe("KafkaRunTracer — opt-in run filtering", () => {
  const GRANDCHILD_ID = "33333333-3333-4333-8333-333333333333";

  test("no filter → every run still emits its pair (default behavior unchanged)", async () => {
    const { tracer, events } = harness();
    await tracer.handleChainStart(SERIALIZED, {}, RUN_ID, undefined, [], { thread_id: "t-1" });
    await tracer.handleChainStart(SERIALIZED, {}, CHILD_ID, RUN_ID, [], {}, undefined, "__start__");
    await tracer.handleChainEnd({}, CHILD_ID);
    await tracer.handleChainEnd({}, RUN_ID);
    assert.equal(events().length, 4);
  });

  test("deny mode drops BOTH events of a matching child run, keeps non-matching siblings", async () => {
    const { tracer, events } = harness(new RunFilter("deny", ["chain:__*", "chain:agent"]));
    await tracer.handleChainStart(SERIALIZED, { q: "hi" }, RUN_ID, undefined, [], { thread_id: "t-1" });
    await tracer.handleChainStart(SERIALIZED, {}, CHILD_ID, RUN_ID, [], {}, undefined, "__start__");
    await tracer.handleChainEnd({}, CHILD_ID);
    await tracer.handleToolStart(SERIALIZED, "input", GRANDCHILD_ID, RUN_ID, [], {}, "password_reset_agent_step");
    await tracer.handleToolEnd({ ok: true }, GRANDCHILD_ID);
    await tracer.handleChainEnd({}, RUN_ID);

    const all = events();
    assert.equal(all.filter((e) => e.data.run_id === CHILD_ID).length, 0, "__start__ pair dropped");
    assert.equal(all.filter((e) => e.data.run_id === GRANDCHILD_ID).length, 2, "tool pair kept");
    assert.equal(all.filter((e) => e.data.run_id === RUN_ID).length, 2, "root pair kept");
  });

  test("allow mode keeps only matching children — and always the root (root guarantee)", async () => {
    const { tracer, events } = harness(new RunFilter("allow", ["llm:*", "tool:*"]));
    await tracer.handleChainStart(SERIALIZED, {}, RUN_ID, undefined, [], { thread_id: "t-1" });
    await tracer.handleChainStart(SERIALIZED, {}, CHILD_ID, RUN_ID, [], {}, undefined, "agent");
    await tracer.handleChatModelStart(SERIALIZED, [[new HumanMessage("hi")]], GRANDCHILD_ID, CHILD_ID);
    await tracer.handleLLMEnd({ generations: [[]] }, GRANDCHILD_ID);
    await tracer.handleChainEnd({}, CHILD_ID);
    await tracer.handleChainEnd({}, RUN_ID);

    const all = events();
    assert.equal(all.filter((e) => e.data.run_id === RUN_ID).length, 2, "root kept despite matching no rule");
    assert.equal(all.filter((e) => e.data.run_id === CHILD_ID).length, 0, "agent wrapper dropped");
    assert.equal(all.filter((e) => e.data.run_id === GRANDCHILD_ID).length, 2, "nested llm kept");
  });

  test("children of a filtered run keep their thread_id (thread map is learned from the always-kept root)", async () => {
    const { tracer, events } = harness(new RunFilter("deny", ["chain:agent"]));
    await tracer.handleChainStart(SERIALIZED, {}, RUN_ID, undefined, [], { thread_id: "thread-42" });
    await tracer.handleChainStart(SERIALIZED, {}, CHILD_ID, RUN_ID, [], {}, undefined, "agent");
    await tracer.handleToolStart(SERIALIZED, "x", GRANDCHILD_ID, CHILD_ID);
    await tracer.handleToolEnd({}, GRANDCHILD_ID);
    await tracer.handleChainEnd({}, CHILD_ID);
    await tracer.handleChainEnd({}, RUN_ID);

    const toolEvents = events().filter((e) => e.data.run_id === GRANDCHILD_ID);
    assert.equal(toolEvents.length, 2);
    for (const event of toolEvents) assert.equal(event.thread_id, "thread-42");
  });
});

describe("KafkaRunTracer — fire-and-forget safety", () => {
  test("with no emitter configured (startup never ran) handlers are silent no-ops", async () => {
    const tracer = new KafkaRunTracer(); // no explicit emitter, registry empty
    await assert.doesNotReject(async () => {
      await tracer.handleChainStart(SERIALIZED, {}, RUN_ID);
      await tracer.handleChainEnd({}, RUN_ID);
    });
  });

  test("an emitter that throws never propagates into the run (edge case)", async () => {
    const broken = {
      emitRun() {
        throw new Error("kafka exploded");
      },
    } as unknown as RunEventEmitter;
    const tracer = new KafkaRunTracer({ emitter: broken });
    await assert.doesNotReject(async () => {
      await tracer.handleChainStart(SERIALIZED, {}, RUN_ID);
      await tracer.handleChainEnd({}, RUN_ID);
    });
  });
});
