import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Annotation } from "@langchain/langgraph";
import type { AIMessage } from "@langchain/core/messages";

import { defineConfig } from "./define-config.js";
import { buildAgentStepTool, runSteps, type BuildAgentStepToolOptions } from "./runner.js";
import { createHandoffNode, HANDOFF_ACTION, handoffRequested, type HandoffSpec } from "./handoff.js";
import type { ExecutorRegistry, VerifierRegistry } from "./types.js";
import type { AwaitingInput, CurrentFlow, HandoffRequest } from "./state.js";

interface S {
  thing?: string | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
  handoff?: HandoffRequest | null;
}

const replaceNull = <T>() => ({
  reducer: (_o: T | null, n: T | null) => n ?? null,
  default: () => null as T | null,
});

const testStateAnnotation = Annotation.Root({
  thing: Annotation<string | null>(replaceNull<string>()),
  awaitingInput: Annotation<AwaitingInput | null>(replaceNull<AwaitingInput>()),
  currentFlow: Annotation<CurrentFlow | null>(replaceNull<CurrentFlow>()),
  handoff: Annotation<HandoffRequest | null>(replaceNull<HandoffRequest>()),
});

type ActionName = "read_thing" | "change_thing";

function makeConfig() {
  return defineConfig<ActionName, never>({
    tool: { name: "test_tool", description: "test tool" },
    actions: {
      read_thing: {
        description: "read the thing",
        paramsSchema: z.object({}),
        prereqs: [],
      },
      change_thing: {
        description: "change the thing",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: true },
      },
    },
  });
}

const selectors = {
  read_thing: (s: S) => s,
  change_thing: (s: S) => s,
};

function makeOpts(withHandoff: boolean): {
  opts: BuildAgentStepToolOptions<S, string, string, typeof selectors>;
  calls: { read: number; change: number };
} {
  const calls = { read: 0, change: 0 };
  const executors: ExecutorRegistry<S, typeof selectors> = {
    read_thing: async () => {
      calls.read++;
      return { resultBody: { summary: "thing read", value: "x" }, ok: true };
    },
    change_thing: async () => {
      calls.change++;
      return { resultBody: { summary: "thing changed" }, stateUpdate: { thing: "y" }, ok: true };
    },
  };
  const verifiers: VerifierRegistry<S> = {};
  const handoff: HandoffSpec<S> = {
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
  };
  return {
    opts: {
      config: makeConfig(),
      stateAnnotation: testStateAnnotation,
      selectors,
      executors,
      verifiers,
      ...(withHandoff ? { handoff } : {}),
    },
    calls,
  };
}

const HANDOFF_STEP = {
  action: HANDOFF_ACTION,
  params: { reason: "off_topic", context: "wants a transfer" },
};

// ─── runner: built-in request_handoff action ──────────────────────────────── //

test("request_handoff (sole step) writes the handoff slot and succeeds", async () => {
  const { opts } = makeOpts(true);
  const { body, committed } = await runSteps(opts, [HANDOFF_STEP], {} as S);
  assert.equal(body.failed_at, undefined);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].handoff_requested, true);
  assert.deepEqual(committed.handoff, { reason: "off_topic", context: "wants a transfer" });
  assert.equal(handoffRequested(committed), true);
});

test("request_handoff mixed with another step is refused, nothing executes", async () => {
  const { opts, calls } = makeOpts(true);
  const { body, committed } = await runSteps(
    opts,
    [{ action: "read_thing", params: {} }, HANDOFF_STEP],
    {} as S,
  );
  assert.equal(body.failed_at, 0);
  assert.equal(body.results[0].error, "handoff_must_be_sole_step");
  assert.equal(calls.read, 0);
  assert.equal(committed.handoff, undefined);
});

test("request_handoff with an invalid reason fails param validation", async () => {
  const { opts } = makeOpts(true);
  const { body, committed } = await runSteps(
    opts,
    [{ action: HANDOFF_ACTION, params: { reason: "bored", context: "x" } }],
    {} as S,
  );
  assert.equal(body.results[0].error, "invalid_params");
  assert.equal(committed.handoff, undefined);
});

test("request_handoff is allowed while a confirmation is pending (lockdown bypass)", async () => {
  const { opts } = makeOpts(true);
  const initial: S = {
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_thing",
      params: { v: "y" },
      attempts_left: 2,
      max_attempts: 3,
    },
  };
  const { body, committed } = await runSteps(opts, [HANDOFF_STEP], initial);
  assert.equal(body.results[0].ok, true);
  assert.deepEqual(committed.handoff, { reason: "off_topic", context: "wants a transfer" });
});

test("request_handoff without the handoff opt is an unknown action", async () => {
  const { opts } = makeOpts(false);
  const { body } = await runSteps(opts, [HANDOFF_STEP], {} as S);
  assert.equal(body.results[0].error, "unknown_action");
});

test("config may define its own request_handoff when the handoff opt is absent", () => {
  // The orchestrator/scaffold mechanism predates the built-in and names its
  // own tool action `request_handoff`. The name is reserved ONLY for tools
  // that opt into the library handoff.
  const { opts } = makeOpts(false);
  const own = {
    ...opts,
    config: {
      tool: opts.config.tool,
      actions: {
        ...opts.config.actions,
        [HANDOFF_ACTION]: {
          description: "scaffold-mechanism outbound handoff (own action)",
          paramsSchema: z.object({}),
          prereqs: [],
        },
      },
    },
    selectors: { ...selectors, [HANDOFF_ACTION]: (s: S) => s },
    executors: {
      ...opts.executors,
      [HANDOFF_ACTION]: async () => ({ resultBody: {}, ok: true }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.doesNotThrow(() => buildAgentStepTool(own as any));
});

test("config defining request_handoff is rejected at construction", () => {
  const { opts } = makeOpts(true);
  const bad = {
    ...opts,
    config: {
      tool: opts.config.tool,
      actions: {
        ...opts.config.actions,
        [HANDOFF_ACTION]: {
          description: "imposter",
          paramsSchema: z.object({}),
          prereqs: [],
        },
      },
    },
    selectors: { ...selectors, [HANDOFF_ACTION]: (s: S) => s },
    executors: {
      ...opts.executors,
      [HANDOFF_ACTION]: async () => ({ resultBody: {}, ok: true }),
    },
  };
  assert.throws(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => buildAgentStepTool(bad as any),
    /reserved action name/,
  );
});

test("tool description advertises request_handoff only when enabled", () => {
  const withIt = buildAgentStepTool(makeOpts(true).opts);
  const withoutIt = buildAgentStepTool(makeOpts(false).opts);
  assert.match(withIt.description, /request_handoff/);
  assert.doesNotMatch(withoutIt.description, /request_handoff/);
});

// ─── handoff node ─────────────────────────────────────────────────────────── //

function nodeConfig(events: unknown[], threadId = "t-1") {
  return {
    configurable: { thread_id: threadId },
    writer: (chunk: unknown) => events.push(chunk),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("handoff node (terminate) emits events, clears the slot, appends the envelope", async () => {
  const node = createHandoffNode<S>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
  });
  const events: unknown[] = [];
  const update = await node(
    { handoff: { reason: "off_topic", context: "wants a transfer" } },
    nodeConfig(events),
  );
  assert.equal(update.handoff, null);
  const [message] = update.messages as AIMessage[];
  assert.equal(message.content, "Transferring you now.");
  assert.deepEqual(message.additional_kwargs, {
    is_handoff: true,
    handoff_type: "OFF_TOPIC",
    handoff_reason: "wants a transfer",
    handoff_metadata: {
      service_type: "OFF_TOPIC",
      success_message: "Transferring you now.",
    },
  });
  const types = (events as { type: string }[]).map((e) => e.type);
  assert.deepEqual(types, ["handoff", "handoff_complete"]);
  assert.equal((events[1] as { content: string }).content, "Transferring you now.");
});

test("handoff node is a no-op when no handoff is pending", async () => {
  const node = createHandoffNode<S>({
    offTopic: { mode: "terminate" },
    terminateMessage: "x",
  });
  const update = await node({ handoff: null }, nodeConfig([]));
  assert.deepEqual(update, {});
});

test("handoff node (delegate) falls back to terminate when the delegate is unreachable", async () => {
  const node = createHandoffNode<S>({
    offTopic: {
      mode: "delegate",
      url: "http://127.0.0.1:9",
      assistantId: "general",
      timeoutMs: 2_000,
    },
    terminateMessage: "Transferring you now.",
  });
  const events: unknown[] = [];
  const update = await node(
    { handoff: { reason: "off_topic", context: "wants a transfer" } },
    nodeConfig(events),
  );
  const [message] = update.messages as AIMessage[];
  assert.equal(message.content, "Transferring you now.");
  assert.equal(message.additional_kwargs.is_handoff, true);
  assert.equal(message.additional_kwargs.handoff_type, "OFF_TOPIC");
  assert.equal(typeof message.additional_kwargs.delegate_error, "string");
  const types = (events as { type: string }[]).map((e) => e.type);
  assert.deepEqual(types, ["handoff", "handoff_delegate_failed", "handoff_complete"]);
  // The control-plane event still reported the *intended* mode.
  assert.equal((events[0] as { mode: string }).mode, "delegate");
});
