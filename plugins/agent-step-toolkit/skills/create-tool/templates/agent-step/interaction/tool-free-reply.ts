// FILE: src/agent-step/interaction/tool-free-reply.ts
//
// The counter for the path no other counter can see: a caller turn the model
// answers in plain text, with no tool call at all.
//
// Every bound the runner owns — bounded patience, a gate's budget,
// `errorCount` — advances inside a tool batch. A model that stops calling the
// tool therefore stops being counted. Live incident 2026-11-16: one
// `verify_card` bounce, then 26 caller turns answered with the same "I didn't
// catch those digits" sentence and no call — including a turn that carried
// the complete value — until the caller asked for a human.
//
// Required tool calling (`tool.toolChoice: "required"`) closes this path
// structurally: every caller turn starts with a call. This helper is for AUTO
// mode, where the model may still answer without one. The runner cannot count
// the path (it does not run), so the HOST's model node calls
// `countToolFreeReply` with each model reply and returns the patch:
//
//   - a reply that carries tool calls ends the run (the tool paths own their
//     own bounds from there);
//   - a reply that closes a tool turn (the message before it is a tool
//     result) is neutral — the turn did reach the engine;
//   - any other reply is a caller turn the engine never saw: counted, and
//     past `max` in a row the patch is the same atomic `abandon` handoff, on
//     the same structural context, as every other spent patience.
//
// It counts EVERY tool-free caller turn, not only failed captures: with no
// call there is nothing to tell an unheard number from a legitimate "one
// moment, please" — and guessing from the wording is exactly what the engine
// must not do. `max` is therefore the host's patience for a caller turn that
// advances nothing, and should sit well above the bounce tolerance.
//
// The count lives in the task-scoped `spentLadders` latch under a reserved
// key, so a task-ending handback clears it with the rest.

import type { LibraryManagedSlots } from "../state.js";
import { requestHandoffPatch } from "../run/batch-state.js";
import { escalationContext } from "./escalation.js";

/** The `spentLadders` key the count lives under. */
export const TOOL_FREE_REPLIES_KEY = "turn:tool_free";

export interface ToolFreeReplyPolicy {
  /** Consecutive tool-free caller turns tolerated. Integer ≥ 1; the turn
   *  after that escalates. */
  max: number;
}

function messageKind(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as {
    getType?: () => string;
    _getType?: () => string;
    type?: string;
    role?: string;
  };
  return value.getType?.() ?? value._getType?.() ?? value.type ?? value.role ?? "";
}

/** Count one model reply. Call it in the host's model node with the state the
 *  node received (the reply NOT yet appended) and the model's reply; merge the
 *  returned `patch` into the node's state update.
 *
 *  When `exhausted` is true the patch requests the handoff (`abandon`,
 *  `escalationContext(null)`): return it WITHOUT the model's reply and route
 *  `handoffRequested(state)` to `HANDOFF_NODE` on the edge after the model
 *  node — the resolver speaks the closing. */
export function countToolFreeReply<T extends LibraryManagedSlots>(
  state: T,
  reply: { tool_calls?: readonly unknown[] | null },
  policy: ToolFreeReplyPolicy,
): { exhausted: boolean; patch: Partial<T> } {
  if (!Number.isInteger(policy.max) || policy.max < 1) {
    throw new Error("agent-step: countToolFreeReply needs an integer max ≥ 1.");
  }
  const { [TOOL_FREE_REPLIES_KEY]: run = 0, ...rest } = state.spentLadders ?? {};
  // Same convention as the runner's own latch writes: an empty latch is null.
  const latch = (next: Record<string, number>): Partial<T> =>
    ({ spentLadders: Object.keys(next).length > 0 ? next : null }) as unknown as Partial<T>;

  if ((reply.tool_calls ?? []).length > 0) {
    return { exhausted: false, patch: run === 0 ? {} : latch(rest) };
  }
  const messages = (state as { messages?: unknown }).messages;
  const previous = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  if (messageKind(previous) === "tool") return { exhausted: false, patch: {} };

  if (run >= policy.max) {
    return {
      exhausted: true,
      patch: {
        ...requestHandoffPatch<T>({ reason: "abandon", context: escalationContext(null) }),
        ...latch(rest),
      },
    };
  }
  return { exhausted: false, patch: latch({ ...rest, [TOOL_FREE_REPLIES_KEY]: run + 1 }) };
}
