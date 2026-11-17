// FILE: src/agent-step/tool-free-reply.test.ts
//
// `countToolFreeReply`: the bound on caller turns the model answers without a
// tool call — the one path the runner's own counters cannot see. The pins
// replay the 2026-11-16 incident's shape: a tool bounce, then an unbroken run
// of plain-text apologies.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countToolFreeReply,
  TOOL_FREE_REPLIES_KEY,
} from "./interaction/tool-free-reply.js";
import { handoffRequested } from "./handoff/contract.js";
import type { LibraryManagedSlots } from "./state.js";

interface S extends LibraryManagedSlots {
  messages?: unknown[];
}

const POLICY = {
  max: 3,
  onExhaust: { reason: "abandon" as const, context: "test:no_progress" },
};

const human = { type: "human", content: "4." };
const toolResult = { type: "tool", content: "{}" };
const text = { tool_calls: [] };
const call = { tool_calls: [{ name: "agent_step" }] };

/** Drive one model reply and fold the patch into state, as a host node would. */
function step(state: S, reply: { tool_calls?: unknown[] }, last: unknown = human) {
  const seen: S = { ...state, messages: [last] };
  const { exhausted, patch } = countToolFreeReply(seen, reply, POLICY);
  return { exhausted, state: { ...state, ...patch } as S };
}

test("a run of tool-free caller turns escalates on the turn after max", () => {
  let state: S = { spentLadders: { "capture:verify_card": 1 } };
  for (let turn = 1; turn <= POLICY.max; turn++) {
    const out = step(state, text);
    assert.equal(out.exhausted, false, `turn ${turn} is tolerated`);
    assert.equal(out.state.spentLadders?.[TOOL_FREE_REPLIES_KEY], turn);
    state = out.state;
  }
  const out = step(state, text);
  assert.equal(out.exhausted, true);
  assert.equal(handoffRequested(out.state), true);
  assert.deepEqual(out.state.handoff, POLICY.onExhaust);
  // The run is spent, the other latches are untouched, the interaction is abandoned.
  assert.deepEqual(out.state.spentLadders, { "capture:verify_card": 1 });
  assert.equal(out.state.awaitingInput, null);
  assert.equal(out.state.currentFlow, null);
});

test("a reply that calls the tool ends the run", () => {
  let state: S = {};
  state = step(state, text).state;
  state = step(state, text).state;
  assert.equal(state.spentLadders?.[TOOL_FREE_REPLIES_KEY], 2);
  state = step(state, call).state;
  assert.deepEqual(state.spentLadders, {});
  // …and the next tool-free turn starts from one, not from where it left off.
  state = step(state, text).state;
  assert.equal(state.spentLadders?.[TOOL_FREE_REPLIES_KEY], 1);
});

test("the text that closes a tool turn is neutral", () => {
  let state: S = {};
  state = step(state, text).state;
  const out = step(state, text, toolResult);
  assert.equal(out.exhausted, false);
  assert.equal(out.state.spentLadders?.[TOOL_FREE_REPLIES_KEY], 1);
});

test("an untouched state gets no patch from a tool-calling reply", () => {
  const { exhausted, patch } = countToolFreeReply({ messages: [human] } as S, call, POLICY);
  assert.equal(exhausted, false);
  assert.deepEqual(patch, {});
});

test("a non-positive or fractional max is a programmer error", () => {
  for (const max of [0, -1, 1.5]) {
    assert.throws(() => countToolFreeReply({} as S, text, { ...POLICY, max }), /max ≥ 1/);
  }
});
