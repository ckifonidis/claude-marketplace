// FILE: src/agent-step/escalation.test.ts
//
// BOUNDED PATIENCE — one universal latch, reached from two entry points.
//
// This file replaces capture-bounce.test.ts + note-refusal.test.ts, which
// tested the same mechanism twice because it used to be configured twice (a
// named ladder registry plus a per-action `captureBounces` policy naming one of
// them). There is nothing to declare now — the bounds are process-wide
// tolerances (tolerances.ts; their environment overrides are pinned in
// tolerances.test.ts) — so there is one set of pins, at the DEFAULTS:
//
//   * the bounce is FREE and model-invisible until the tolerance is passed —
//     the property that keeps caller-capture shape rules out of the JSON
//     Schema (no gate stored, no attempt spent, no executor run, no count in
//     any model-facing byte);
//   * past the tolerance the engine explains itself ONCE and then escalates
//     ATOMICALLY, so an unusable-capture loop always has an exit (live
//     incident 2026-08-19: seven identical bounces in 105 seconds);
//   * PROGRESS RESETS the run — friction is consecutive, never cumulative, so
//     a caller who stumbles, is helped, and then delivers starts fresh;
//   * `note_refusal` reaches the same latch, and its two kinds differ only in
//     the instruction and in admissibility — a refusal of NOTHING is refused
//     instructively and counts nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import { runSteps, buildAgentStepTool, type BuildAgentStepToolOptions } from "./runner.js";
import { agentStepStateSpec, type AwaitingInput, type LibraryManagedSlots } from "./state.js";
import { callerDigits } from "./capture.js";
import {
  BOUNCE_TOLERANCE,
  ESCALATION_CONTEXT_PREFIX,
  MALICIOUS_CONTEXT,
  MALICIOUS_KEY,
  MALICIOUS_LIMIT,
  escalationContext,
} from "./interaction/escalation.js";
import { ENGINE_TEXT } from "./engine-text.js";

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

type ActionName = "capture_value" | "gated_capture" | "other_capture" | "no_capture";

const selectors = {
  capture_value: (state: S) => state,
  gated_capture: (state: S) => state,
  other_capture: (state: S) => state,
  no_capture: (state: S) => state,
};

/** A caller capture whose shape rule is a REFINEMENT — invisible to the JSON
 *  Schema, so the model sees a plain string and a bad capture reaches the
 *  runner as `invalid_params`. */
const digitsParams = z
  .object({ value: callerDigits(/^\d{9}$/u, "not a usable capture") })
  .strict();

const BAD = { action: "capture_value", params: { value: "0354081" } };
const GOOD = { action: "capture_value", params: { value: "354081234" } };
const BAD_OTHER = { action: "other_capture", params: { value: "12" } };

function makeOpts(): BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "escalation_tool", description: "escalation tool" },
    actions: {
      capture_value: {
        description: "receives a dictated value",
        paramsSchema: digitsParams,
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
      gated_capture: {
        description: "a confirm-gated capture",
        paramsSchema: digitsParams,
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 } },
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
      other_capture: {
        description: "a DIFFERENT action's capture",
        paramsSchema: digitsParams,
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
      no_capture: {
        description: "a read that collects nothing",
        paramsSchema: z.object({}),
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "read" } },
      },
    },
  });
  return {
    config,
    stateSchema,
    selectors,
    executors: {
      capture_value: async () => ({ verdict: "ok" }),
      gated_capture: async () => ({ verdict: "ok" }),
      other_capture: async () => ({ verdict: "ok" }),
      no_capture: async () => ({ verdict: "ok" }),
    },
    verifiers: {},
    handoff: {
      offTopic: { mode: "terminate" },
      resolveClosingMessage: (_s: unknown, r: { context: string }) => r.context,
    },
  } as unknown as BuildAgentStepToolOptions<S, ActionName, never, typeof selectors>;
}

const BASE: S = { messages: [{ role: "user", id: "t1", content: "…" }] };
type Latch = Record<string, number> | null | undefined;
const latchOf = (s: unknown): Latch => (s as { spentLadders?: Latch }).spentLadders;

/** Drive one step and thread the committed state forward. */
async function step(
  opts: ReturnType<typeof makeOpts>,
  s: S,
  call: { action: string; params: unknown },
) {
  const { body, committed } = await runSteps(opts, [call], s);
  // `committed` is the batch's cumulative patch; threading it forward is what
  // makes the run CONSECUTIVE across turns.
  return { entry: body.results[0], committed, next: { ...s, ...committed } as S };
}

// ─── The bounce, under the tolerance ────────────────────────────────────────

test("under the tolerance a bounce is unchanged, and only the run is counted", async () => {
  const opts = makeOpts();
  let s = BASE;
  for (let i = 1; i <= BOUNCE_TOLERANCE; i += 1) {
    const r = await step(opts, s, BAD);
    s = r.next;
    assert.equal(r.entry.error, "invalid_params");
    assert.equal(r.entry.instruction, ENGINE_TEXT.invalid_params, "still the plain bounce");
    assert.equal(r.entry.escalated, undefined);
    assert.equal(latchOf(r.committed)?.bounce, i);
    assert.equal(latchOf(r.committed)?.escalation, undefined, "no explanation spent yet");
  }
});

test("a bounce stores no gate and spends no confirmation attempt", async () => {
  const opts = makeOpts();
  const r = await step(opts, BASE, { action: "gated_capture", params: { value: "1" } });
  assert.equal(r.entry.error, "invalid_params");
  const awaiting = (r.committed as { awaitingInput?: AwaitingInput | null }).awaitingInput;
  assert.notEqual(awaiting?.kind, "confirmation", "the propose path bounced before any gate");
});

// ─── Past the tolerance: explain once, then escalate ────────────────────────

test("past the tolerance the engine explains itself once — no handoff yet", async () => {
  const opts = makeOpts();
  let s = BASE;
  for (let i = 0; i < BOUNCE_TOLERANCE; i += 1) s = (await step(opts, s, BAD)).next;
  const r = await step(opts, s, BAD);
  assert.equal(r.entry.instruction, ENGINE_TEXT.explain_detail_needed);
  assert.equal(r.entry.error, "invalid_params", "the value is still owed");
  assert.equal(r.entry.handoff_requested, undefined);
  assert.equal(latchOf(r.committed)?.escalation, 1, "one explanation spent");
});

test("the next friction escalates ATOMICALLY, naming the owed action in the context", async () => {
  const opts = makeOpts();
  let s = BASE;
  for (let i = 0; i < BOUNCE_TOLERANCE + 1; i += 1) s = (await step(opts, s, BAD)).next;
  const r = await step(opts, s, BAD);
  assert.equal(r.entry.escalated, true);
  assert.equal(r.entry.handoff_requested, true);
  const handoff = (r.committed as { handoff?: { reason: string; context: string } }).handoff;
  assert.equal(handoff?.reason, "abandon");
  assert.equal(
    handoff?.context,
    escalationContext("capture_value"),
    "the STRUCTURAL context names what was owed, so the host's closing table can be specific",
  );
  assert.match(handoff?.context ?? "", new RegExp(`^${ESCALATION_CONTEXT_PREFIX}:`));
});

// ─── Progress resets the run ────────────────────────────────────────────────

test("a capture that PARSES clears both counters — friction is consecutive", async () => {
  const opts = makeOpts();
  let s = BASE;
  for (let i = 0; i < BOUNCE_TOLERANCE + 1; i += 1) s = (await step(opts, s, BAD)).next;
  assert.equal(latchOf(s)?.escalation, 1, "an explanation was spent");

  const good = await step(opts, s, GOOD);
  assert.equal(good.entry.ok, true);
  assert.equal(latchOf(good.committed)?.bounce, undefined, "the run is over");
  assert.equal(latchOf(good.committed)?.escalation, undefined, "and the allowance is back");

  // Proof it is a real reset, not cosmetics: the tolerance applies again.
  let after = good.next;
  const r = await step(opts, after, BAD);
  assert.equal(r.entry.instruction, ENGINE_TEXT.invalid_params, "a plain bounce once more");
  assert.equal(latchOf(r.committed)?.bounce, 1);
});

test("the run is universal: consecutive bounces on DIFFERENT actions share it", async () => {
  // Two unusable captures in a row are two failures to deliver, whichever
  // action they were aimed at — that is what "one latch" means, and it is why
  // no budget can be silently drained by a name collision any more.
  const opts = makeOpts();
  let s = BASE;
  const first = await step(opts, s, BAD);
  assert.equal(latchOf(first.committed)?.bounce, 1);
  const second = await step(opts, first.next, BAD_OTHER);
  assert.equal(latchOf(second.committed)?.bounce, 2, "the same run, not a second one");
});

// ─── note_refusal: the other entry point ───────────────────────────────────

const REFUSE = (kind: string) => ({ action: "note_refusal", params: { kind } });
const OWED: AwaitingInput = {
  kind: "dictation",
  for_action: "capture_value",
  param: "value",
  expects: "digits",
};

test("declined_or_cannot spends one explanation, then escalates", async () => {
  const opts = makeOpts();
  const seeded: S = { ...BASE, awaitingInput: OWED };
  const free = await step(opts, seeded, REFUSE("declined_or_cannot"));
  assert.equal(free.entry.instruction, ENGINE_TEXT.explain_detail_needed);
  assert.equal(free.entry.refusal_noted, true);
  assert.equal(latchOf(free.committed)?.escalation, 1);

  const gone = await step(opts, { ...free.next, awaitingInput: OWED }, REFUSE("declined_or_cannot"));
  assert.equal(gone.entry.escalated, true);
  const handoff = (gone.committed as { handoff?: { context: string } }).handoff;
  assert.equal(handoff?.context, escalationContext("capture_value"));
});

test("unsupported_question carries its OWN instruction — decline, answer nothing", async () => {
  const opts = makeOpts();
  const r = await step(opts, BASE, REFUSE("unsupported_question"));
  assert.equal(r.entry.instruction, ENGINE_TEXT.decline_unsupported);
  assert.match(String(r.entry.instruction), /answer NONE of the question's content/);
  assert.equal(latchOf(r.committed)?.escalation, 1, "it shares the one latch");
});

test("unsupported_question is location-free; declined_or_cannot needs something owed", async () => {
  const opts = makeOpts();
  // Nothing owed: a question is still answerable-in-place…
  const q = await step(opts, BASE, REFUSE("unsupported_question"));
  assert.equal(q.entry.error, undefined);
  // …but a refusal of nothing is refused instructively, and counts NOTHING:
  // pre-flow the caller may say anything, and that turn is the model's.
  const d = await step(opts, BASE, REFUSE("declined_or_cannot"));
  assert.equal(d.entry.error, "nothing_owed");
  assert.equal(d.entry.instruction, ENGINE_TEXT.nothing_owed);
  assert.equal(latchOf(d.committed)?.escalation, undefined, "nothing was counted");
  assert.equal((d.committed as { handoff?: unknown }).handoff ?? null, null);
});

test("an unknown kind bounces as invalid_params, latching nothing", async () => {
  const opts = makeOpts();
  const r = await step(opts, { ...BASE, awaitingInput: OWED }, REFUSE("nope"));
  assert.equal(r.entry.error, "invalid_params");
  assert.equal(latchOf(r.committed)?.escalation, undefined);
});

test("a standing dictation survives a free use untouched", async () => {
  const opts = makeOpts();
  const r = await step(
    opts,
    { ...BASE, awaitingInput: OWED },
    REFUSE("declined_or_cannot"),
  );
  assert.deepEqual(
    (r.committed as { awaitingInput?: AwaitingInput | null }).awaitingInput ?? OWED,
    OWED,
    "the caller still owes exactly what they owed",
  );
});

test("refused while a confirmation gate is locked — the gate's contract owns replies", async () => {
  const opts = makeOpts();
  const proposed = await step(opts, BASE, { action: "gated_capture", params: { value: "354081234" } });
  assert.equal(proposed.entry.needs_confirmation, true);
  const r = await step(opts, proposed.next, REFUSE("declined_or_cannot"));
  assert.equal(r.entry.ok, false, "the control never runs behind a live gate");
  assert.equal(latchOf(r.committed)?.escalation, undefined);
});

test("note_refusal must be the sole step in its batch", async () => {
  const opts = makeOpts();
  const { body } = await runSteps(
    opts,
    [REFUSE("unsupported_question"), { action: "no_capture", params: {} }],
    BASE,
  );
  assert.equal(body.results[0].ok, false);
});

// ─── note_refusal: malicious_intent ─────────────────────────
//
// Owner decision 2026-11-18: the third misuse attempt (the default
// `MALICIOUS_LIMIT`) ENDS the call. The pins:
// its own instruction; a CUMULATIVE count that progress never resets (an
// attacker cannot launder it with an ordinary turn); the escalation run and a
// pending question left exactly as they were; the termination atomic, on a
// structural context, with reason `completed`.

const MALICIOUS = REFUSE("malicious_intent");

test("malicious_intent below the limit: its own decline instruction, no handoff", async () => {
  const opts = makeOpts();
  let s = BASE;
  for (let i = 1; i < MALICIOUS_LIMIT; i += 1) {
    const r = await step(opts, s, MALICIOUS);
    s = r.next;
    assert.equal(r.entry.instruction, ENGINE_TEXT.decline_malicious);
    assert.equal(r.entry.refusal_noted, true);
    assert.equal(r.entry.kind, "malicious_intent");
    assert.equal(r.entry.handoff_requested, undefined, `attempt ${i} stays in place`);
    assert.equal((r.committed as { handoff?: unknown }).handoff ?? null, null);
    assert.equal(latchOf(r.committed)?.[MALICIOUS_KEY], i);
  }
});

test("the LIMIT-th malicious attempt terminates atomically on the structural context", async () => {
  const opts = makeOpts();
  let s = BASE;
  for (let i = 1; i < MALICIOUS_LIMIT; i += 1) s = (await step(opts, s, MALICIOUS)).next;
  const r = await step(opts, s, MALICIOUS);
  assert.equal(r.entry.handoff_requested, true);
  assert.equal(r.entry.reason, "completed");
  assert.equal(r.entry.instruction, ENGINE_TEXT.handoff_requested.replace("{reason}", "completed"));
  const handoff = (r.committed as { handoff?: { reason: string; context: string } }).handoff;
  assert.deepEqual(handoff, { reason: "completed", context: MALICIOUS_CONTEXT });
});

test("the malicious count is CUMULATIVE: progress between attempts never resets it", async () => {
  const opts = makeOpts();
  let s = (await step(opts, BASE, MALICIOUS)).next;
  s = (await step(opts, s, GOOD)).next; // an ordinary delivered turn in between
  assert.equal(latchOf(s)?.[MALICIOUS_KEY], 1, "progress cleared the patience run, not this");
  s = (await step(opts, s, MALICIOUS)).next;
  s = (await step(opts, s, GOOD)).next;
  const third = await step(opts, s, MALICIOUS);
  assert.equal(third.entry.handoff_requested, true, "attempts 1 + 2 + 3 end the call despite progress");
});

test("malicious_intent leaves the escalation run and a pending question untouched", async () => {
  const opts = makeOpts();
  const seeded: S = { ...BASE, awaitingInput: OWED, spentLadders: { escalation: 1 } };
  const r = await step(opts, seeded, MALICIOUS);
  assert.equal(latchOf(r.committed)?.escalation, 1, "no patience was spent or reset");
  assert.equal(latchOf(r.committed)?.bounce, undefined);
  assert.deepEqual(
    (r.committed as { awaitingInput?: AwaitingInput | null }).awaitingInput ?? OWED,
    OWED,
    "the caller still owes exactly what they owed",
  );
  assert.equal(r.entry.handoff_requested, undefined, "a spent explanation does not make misuse escalate");
});

test("malicious_intent is location-free and refused behind a live gate like its siblings", async () => {
  const opts = makeOpts();
  const pre = await step(opts, BASE, MALICIOUS);
  assert.equal(pre.entry.error, undefined, "nothing owed is fine — misuse is not a refusal OF something");
  const proposed = await step(opts, BASE, { action: "gated_capture", params: { value: "354081234" } });
  const r = await step(opts, proposed.next, MALICIOUS);
  assert.equal(r.entry.ok, false);
  assert.equal(latchOf(r.committed)?.[MALICIOUS_KEY], undefined, "the gate's contract owns replies; nothing counted");
});

test("the misuse instruction is count-free and names nothing of the request", () => {
  const text = ENGINE_TEXT.decline_malicious;
  assert.doesNotMatch(text, /\d/, "no numeral: the remaining budget is the engine's business");
  // «an attempt to misuse» names the TURN; what must never appear is a budget.
  assert.doesNotMatch(text, /\b(attempts|tries|left|remaining|last|final|warning)\b/i, text);
  assert.match(text, /Make NO handoff/);
});

// ─── Model-facing invariants ───────────────────────────────────────────────

test("every model-facing byte on the capture path stays COUNT-FREE", async () => {
  const opts = makeOpts();
  let s = BASE;
  const seen: string[] = [];
  for (let i = 0; i <= BOUNCE_TOLERANCE + 2; i += 1) {
    const r = await step(opts, s, BAD);
    s = r.next;
    seen.push(String(r.entry.instruction ?? ""));
  }
  for (const text of seen) {
    assert.doesNotMatch(text, /\d/, `a numeral leaked into a capture-path byte: ${text}`);
    assert.doesNotMatch(text, /\b(digit|digits|attempt|attempts|tries|try)\b/i, text);
  }
});

test("the control is injected only when the handoff is opted into", () => {
  const opts = makeOpts();
  assert.match(buildAgentStepTool(opts).description, /note_refusal/);
  const { handoff: _dropped, ...noHandoff } = opts as unknown as Record<string, unknown>;
  assert.doesNotMatch(
    buildAgentStepTool(noHandoff as never).description,
    /note_refusal/,
    "escalation ends in a handoff, so without one the control is meaningless",
  );
});
