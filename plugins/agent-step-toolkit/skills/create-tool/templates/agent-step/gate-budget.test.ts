// FILE: src/agent-step/gate-budget.test.ts
//
// Gate budgets are TASK-scoped. The confirmation gate's `attempts_left` and
// the match gate's `attempts_left` live on the transient `awaitingInput` slot,
// which `abort_pending_input` clears and a capturer re-run rewrites — so on
// their own they refunded the whole budget every time. Reported 2026-11-17:
// a read-back answered with a bare "no" aborts the gate, the next dictation
// proposes with the full budget again, nothing ever executes, and the
// identification loop has no cap.
//
// Every test drives the real entry point (`runSteps`) across turns, threading
// the committed state like the graph does — the bug lives in what survives
// between batches, which a hand-built gate object cannot show.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import { runSteps, buildAgentStepTool, type BuildAgentStepToolOptions } from "./runner.js";
import { agentStepStateSpec, type LibraryManagedSlots } from "./state.js";

interface S extends LibraryManagedSlots {
  messages?: unknown[];
}

const stateSchema = Annotation.Root({
  messages: Annotation<unknown[]>({
    reducer: (_old, next) => next,
    default: () => [],
  }),
  ...agentStepStateSpec,
});

type ActionName = "read_back_value" | "open_flow" | "capture_value" | "commit_value";

const selectors = {
  read_back_value: (state: S) => state,
  open_flow: (state: S) => state,
  capture_value: (state: S) => state,
  commit_value: (state: S) => state,
};

const DEAD_END = { reason: "abandon" as const, context: "test:identification_dead_end" };

function makeOpts(
  handoff = true,
  onExhaust: unknown = DEAD_END,
): BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "budget_test_tool", description: "gate budget test tool" },
    actions: {
      read_back_value: {
        description: "a value the caller confirms after a read-back",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        controller: {
          requiresConfirmation: {
            maxAttempts: 3,
            ...(onExhaust ? { onExhaust: onExhaust as typeof DEAD_END } : {}),
          },
        },
        verdicts: { ok: { ok: true, summary: "looked up" } },
      },
      open_flow: {
        description: "open the flow",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: { startsFlow: { name: "myflow" } },
        verdicts: { ok: { ok: true, summary: "opened" } },
      },
      capture_value: {
        description: "the first entry",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: {
          requiresFlow: "myflow",
          startsMatchFor: { consumer_action: "commit_value" },
        },
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
      commit_value: {
        description: "the repeated entry",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: {
          requiresFlow: "myflow",
          requiresMatch: { capturer: "capture_value", maxAttempts: 3 },
          endsFlow: true,
        },
        verdicts: {
          ok: { ok: true, summary: "committed" },
          match_mismatch: {
            ok: false,
            summary: "did not match",
            body: { verdict: "match_mismatch" },
          },
        },
      },
    },
  });
  return {
    config,
    stateSchema,
    selectors,
    executors: {
      read_back_value: async () => ({ verdict: "ok" }),
      open_flow: async () => ({ verdict: "ok" }),
      capture_value: async () => ({ verdict: "ok" }),
      commit_value: async (params) =>
        (params as { v: string }).v === "right"
          ? { verdict: "ok" }
          : { verdict: "match_mismatch" },
    },
    verifiers: {},
    ...(handoff
      ? { handoff: { offTopic: { mode: "terminate" as const }, terminateMessage: "bye" } }
      : {}),
  };
}

/** One caller turn: a fresh human message id, the batch, the committed state
 *  folded back in — what the graph does between tool calls. */
function conversation(opts: ReturnType<typeof makeOpts>) {
  let state: S = {};
  let turn = 0;
  return {
    get state() {
      return state;
    },
    async say(...steps: { action: string; params: unknown }[]) {
      turn += 1;
      state = { ...state, messages: [{ role: "user", id: `t${turn}`, content: "…" }] };
      const { body, committed } = await runSteps(opts, steps, state);
      state = { ...state, ...committed };
      return body.results[body.results.length - 1] as Record<string, unknown>;
    },
  };
}

const propose = (value: string) => ({ action: "read_back_value", params: { value } });
const abort = { action: "abort_pending_input", params: {} };
const capture = { action: "capture_value", params: { v: "right" } };
const commit = (v: string) => ({ action: "commit_value", params: { v } });

test("a bare rejection (abort, then a new value) spends the proposal budget", async () => {
  const c = conversation(makeOpts());
  // «όχι» → abort → new value, four times: the budget only ever goes down.
  for (const left of [3, 2, 1, 0]) {
    const r = await c.say(propose(`value-${left}`));
    assert.equal(r.needs_confirmation, true);
    assert.equal(r.attempts_left, left, "an aborted proposal is not refunded");
    await c.say(abort);
    assert.equal(c.state.awaitingInput, null);
  }
  // The fifth proposal finds the budget spent and ends the task.
  const r = await c.say(propose("value-5"));
  assert.equal(r.ok, false);
  assert.equal(r.error, "confirmation_attempts_exhausted");
  assert.equal(r.handoff_requested, true);
  assert.deepEqual(c.state.handoff, DEAD_END);
  assert.equal(c.state.awaitingInput, null);
});

test("abort + new value in ONE batch spends the budget too", async () => {
  const c = conversation(makeOpts());
  assert.equal((await c.say(propose("a"))).attempts_left, 3);
  assert.equal((await c.say(abort, propose("b"))).attempts_left, 2);
  assert.equal((await c.say(abort, propose("c"))).attempts_left, 1);
});

test("an executed confirmation refunds the budget", async () => {
  const c = conversation(makeOpts());
  await c.say(propose("a"));
  await c.say(abort);
  assert.equal((await c.say(propose("b"))).attempts_left, 2);
  const executed = await c.say(propose("b")); // the caller's yes, on a later turn
  assert.equal(executed.ok, true);
  assert.equal(executed.summary, "looked up");
  assert.deepEqual(c.state.spentLadders, {});
  assert.equal((await c.say(propose("c"))).attempts_left, 3);
});

test("the default exhaustion route is abandon with the auto-handoff closing", async () => {
  const c = conversation(makeOpts(true, null));
  for (let i = 0; i < 4; i++) {
    await c.say(propose(`v${i}`));
    await c.say(abort);
  }
  const r = await c.say(propose("v5"));
  assert.equal(r.handoff_requested, true);
  assert.equal(c.state.handoff?.reason, "abandon");
});

test("without a handoff path the spent gate errors once and starts over", async () => {
  const c = conversation(makeOpts(false, null));
  for (let i = 0; i < 4; i++) {
    await c.say(propose(`v${i}`));
    await c.say(abort);
  }
  const r = await c.say(propose("v5"));
  assert.equal(r.error, "confirmation_attempts_exhausted");
  assert.ok(!("handoff_requested" in r));
  assert.equal(c.state.handoff ?? null, null);
  // Nowhere to escalate to — a permanent refusal would deadlock the action.
  assert.equal((await c.say(propose("v6"))).attempts_left, 3);
});

test("match: neither an abort nor a re-capture refunds a spent mismatch", async () => {
  const c = conversation(makeOpts());
  await c.say({ action: "open_flow", params: {} });
  await c.say(capture);
  assert.equal((await c.say(commit("wrong"))).attempts_left, 2);

  // Re-capture: the first entry changes, the budget does not.
  await c.say(capture);
  assert.equal((c.state.awaitingInput as { attempts_left: number }).attempts_left, 2);

  // Abort drops the gate and the flow; reopening finds the same budget.
  await c.say(abort);
  await c.say({ action: "open_flow", params: {} });
  await c.say(capture);
  assert.equal((c.state.awaitingInput as { attempts_left: number }).attempts_left, 2);

  assert.equal((await c.say(commit("wrong"))).attempts_left, 1);
  const r = await c.say(commit("wrong"));
  assert.equal(r.error, "match_attempts_exhausted");
  assert.equal(r.handoff_requested, true);
  assert.equal(c.state.handoff?.reason, "abandon");
});

test("match: a successful match refunds the budget", async () => {
  const c = conversation(makeOpts());
  await c.say({ action: "open_flow", params: {} });
  await c.say(capture);
  await c.say(commit("wrong"));
  assert.deepEqual(c.state.spentLadders, { "match:commit_value": 1 });
  assert.equal((await c.say(commit("right"))).ok, true);
  assert.deepEqual(c.state.spentLadders, {});
});

test("construction: onExhaust needs the handoff, and the budgets need their channel", () => {
  assert.throws(() => buildAgentStepTool(makeOpts(false)), /onExhaust but handoff is not configured/);
  assert.throws(
    () => buildAgentStepTool(makeOpts(true, { reason: "nope", context: "" })),
    /invalid onExhaust/,
  );
  const { spentLadders: _omitted, ...withoutLatch } = agentStepStateSpec;
  const bare = Annotation.Root({ ...withoutLatch });
  assert.throws(
    () => buildAgentStepTool({ ...makeOpts(), stateSchema: bare as never }),
    /missing channel\(s\) "spentLadders"/,
  );
});
