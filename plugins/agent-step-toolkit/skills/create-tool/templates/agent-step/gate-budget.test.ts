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
import { runSteps, type BuildAgentStepToolOptions } from "./runner.js";
import { agentStepStateSpec, type LibraryManagedSlots } from "./state.js";
import { BOUNCE_KEY, escalationContext } from "./interaction/escalation.js";
import { callerDigits } from "./capture.js";

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

type ActionName =
  | "read_back_value"
  | "open_flow"
  | "capture_value"
  | "commit_value"
  | "lookup"
  | "digits";

const selectors = {
  read_back_value: (state: S) => state,
  open_flow: (state: S) => state,
  capture_value: (state: S) => state,
  commit_value: (state: S) => state,
  lookup: (state: S) => state,
  digits: (state: S) => state,
};

function makeOpts(
  handoff = true,
): BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "budget_test_tool", description: "gate budget test tool" },
    actions: {
      read_back_value: {
        description: "a value the caller confirms after a read-back",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 } },
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
      // A row that goes straight on to open the read-back consent itself.
      lookup: {
        description: "a read whose outcome proposes the read-back",
        paramsSchema: z.object({}),
        prereqs: [],
        verdicts: {
          ok: {
            ok: true,
            summary: "found",
            proposes: { action: "read_back_value", params: () => ({ value: "found" }) },
          },
        },
      },
      digits: {
        description: "an ordinary capture",
        paramsSchema: z.object({ value: callerDigits(/^\d{4}$/u, "not usable") }).strict(),
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "captured" } },
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
      lookup: async () => ({ verdict: "ok" }),
      digits: async () => ({ verdict: "ok" }),
    },
    verifiers: {},
    ...(handoff
      ? {
          handoff: {
            offTopic: { mode: "terminate" as const },
            resolveClosingMessage: () => "bye",
          },
        }
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
  assert.deepEqual(c.state.handoff, {
    reason: "abandon",
    context: escalationContext("read_back_value"),
  });
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
  assert.equal(c.state.spentLadders ?? null, null);
  assert.equal((await c.say(propose("c"))).attempts_left, 3);
});

test("progress elsewhere does not refund a spent proposal", async () => {
  const c = conversation(makeOpts());
  await c.say(propose("a"));
  await c.say(abort);
  // A bounce and then a usable capture: the bounce run resets on progress…
  await c.say({ action: "digits", params: { value: "12" } });
  assert.equal(c.state.spentLadders?.[BOUNCE_KEY], 1);
  await c.say({ action: "digits", params: { value: "1234" } });
  assert.equal(c.state.spentLadders?.[BOUNCE_KEY], undefined);
  // …the rejected proposal stays spent.
  assert.equal((await c.say(propose("b"))).attempts_left, 2);
});

test("a proposal opened by a row (`proposes`) spends the same budget", async () => {
  const c = conversation(makeOpts());
  const lookup = { action: "lookup", params: {} };
  for (const left of [3, 2, 1, 0]) {
    assert.equal((await c.say(lookup)).attempts_left, left);
    await c.say(abort);
  }
  const r = await c.say(lookup);
  assert.equal(r.error, "confirmation_attempts_exhausted");
  assert.equal(r.handoff_requested, true);
});

test("without a handoff path nothing is latched and the gate behaves as before", async () => {
  const c = conversation(makeOpts(false));
  for (let i = 0; i < 5; i++) {
    assert.equal((await c.say(propose(`v${i}`))).attempts_left, 3);
    await c.say(abort);
  }
  assert.equal(c.state.spentLadders ?? null, null);
  assert.equal(c.state.handoff ?? null, null);
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
  assert.deepEqual(c.state.handoff, {
    reason: "abandon",
    context: escalationContext("commit_value"),
  });
});

test("match: a successful match refunds the budget", async () => {
  const c = conversation(makeOpts());
  await c.say({ action: "open_flow", params: {} });
  await c.say(capture);
  await c.say(commit("wrong"));
  assert.deepEqual(c.state.spentLadders, { "match:commit_value": 1 });
  assert.equal((await c.say(commit("right"))).ok, true);
  assert.equal(c.state.spentLadders ?? null, null);
});
