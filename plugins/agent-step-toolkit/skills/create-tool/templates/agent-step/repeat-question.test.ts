import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "@cfworker/json-schema";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import {
  buildAgentStepTool,
  REPEAT_PENDING_QUESTION_ACTION,
  runSteps,
  type BuildAgentStepToolOptions,
} from "./runner.js";
import {
  agentStepStateSpec,
  AwaitingInputSchema,
  type AwaitingInput,
  type LibraryManagedSlots,
} from "./state.js";
import type { ExecutorRegistry } from "./types.js";
import { callerTextParam } from "./capture.js";

interface S extends LibraryManagedSlots {
  messages?: unknown[];
  changed?: string | null;
}

const stateSchema = Annotation.Root({
  messages: Annotation<unknown[]>({
    reducer: (_old, next) => next,
    default: () => [],
  }),
  ...agentStepStateSpec,
  changed: Annotation<string | null>({
    reducer: (_old, next) => next,
    default: () => null,
  }),
});

type ActionName = "repeatable_change" | "plain_change";

const selectors = {
  repeatable_change: (state: S) => state,
  plain_change: (state: S) => state,
};

const EXACT_READ_BACK =
  "Κλείσιμο κάρτας • 4 4 1 0;\nDo you confirm — yes or no?";

function human(id: string): { role: "user"; id: string; content: string } {
  return { role: "user", id, content: "…" };
}


function makeOpts(repeatEnabled = true): {
  opts: BuildAgentStepToolOptions<S, ActionName, never, typeof selectors>;
  calls: { repeatable: number; plain: number; render: number };
} {
  const calls = { repeatable: 0, plain: 0, render: 0 };
  const config = defineConfig<ActionName, never>({
    tool: {
      name: "repeat_confirmation_test_tool",
      description: "repeat-confirmation test tool",
    },
    actions: {
      repeatable_change: {
        description: "propose a repeatable confirm-gated change",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        controller: {
          requiresConfirmation: {
            maxAttempts: 3,
            repeatReadBack: repeatEnabled,
            readBack: () => {
              calls.render++;
              return EXACT_READ_BACK;
            },
            // A repeatable gate must declare its own taxonomy — construction
            // fails otherwise (the generic contract forbids the repeat call).
            ...(repeatEnabled
              ? {
                  replyContract: {
                    subject: "this test question",
                    subjectNoun: "test question",
                    executesLabel: "the test change",
                    categories: ["TEST CATEGORY: route re-asks through the repeat control."],
                  },
                }
              : {}),
          },
        },
        verdicts: { ok: { ok: true, summary: "repeatable changed" } },
      },
      plain_change: {
        description: "propose a normal confirm-gated change",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        controller: {
          requiresConfirmation: {
            maxAttempts: 3,
            readBack: (params) => `plain:${String(params.value)}`,
          },
        },
        verdicts: { ok: { ok: true, summary: "plain changed" } },
      },
    },
  });
  const executors: ExecutorRegistry<S, typeof selectors> = {
    repeatable_change: async (params) => {
      calls.repeatable++;
      return {
        verdict: "ok",
        stateUpdate: { changed: String((params as { value: string }).value) },
      };
    },
    plain_change: async (params) => {
      calls.plain++;
      return {
        verdict: "ok",
        stateUpdate: { changed: String((params as { value: string }).value) },
      };
    },
  };
  return {
    opts: {
      config,
      stateSchema,
      selectors,
      executors,
      verifiers: {},
      handoff: {
        offTopic: { mode: "terminate" },
        resolveClosingMessage: (_s: unknown, r: { context: string }) => r.context,
      },
    },
    calls,
  };
}

const repeatStep = {
  action: REPEAT_PENDING_QUESTION_ACTION,
  params: {},
};

function eligibleGate(
  proposedTurn = "turn-propose",
  readBack = EXACT_READ_BACK,
): AwaitingInput {
  return {
    kind: "confirmation",
    for_action: "repeatable_change",
    params: { value: "lost" },
    attempts_left: 3,
    max_attempts: 3,
    proposed_on_caller_turn_id: proposedTurn,
    read_back: readBack,
  };
}

test("repeatReadBack without a replyContract fails construction — the generic contract cannot govern a repeatable gate", () => {
  const { opts } = makeOpts(true);
  const cfg = opts.config as unknown as {
    actions: Record<string, { controller?: { requiresConfirmation?: { replyContract?: string } } }>;
  };
  delete cfg.actions.repeatable_change.controller!.requiresConfirmation!.replyContract;
  assert.throws(
    () => buildAgentStepTool(opts),
    /replyContract/,
    "a repeatable gate silently inheriting the generic taxonomy is the measured incident class",
  );
});

test("repeat control is injected only when a confirmation action opts in", () => {
  const enabledTool = buildAgentStepTool(makeOpts(true).opts);
  assert.equal(
    validate({ steps: [repeatStep] }, enabledTool.schema as never).valid,
    true,
  );
  assert.match(JSON.stringify(enabledTool.schema), /repeat_pending_question/);
  assert.match(enabledTool.description, /repeat_pending_question/);

  const disabledTool = buildAgentStepTool(makeOpts(false).opts);
  assert.equal(
    validate({ steps: [repeatStep] }, disabledTool.schema as never).valid,
    false,
  );
  assert.doesNotMatch(JSON.stringify(disabledTool.schema), /repeat_pending_question/);
  assert.doesNotMatch(disabledTool.description, /repeat_pending_question/);
});

test("opted-in proposal persists the exact rendered read_back; default-off does not", async () => {
  const { opts, calls } = makeOpts();
  const repeatable = await runSteps(
    opts,
    [{ action: "repeatable_change", params: { value: "lost" } }],
    { messages: [human("turn-propose")] },
  );
  assert.equal(repeatable.body.results[0].read_back, EXACT_READ_BACK);
  assert.equal(calls.render, 1);
  assert.deepEqual(repeatable.committed.awaitingInput, eligibleGate());
  assert.equal(calls.repeatable, 0, "proposal never invokes the executor");

  const plain = await runSteps(
    opts,
    [{ action: "plain_change", params: { value: "lost" } }],
    { messages: [human("turn-plain")] },
  );
  assert.equal(plain.body.results[0].read_back, "plain:lost");
  assert.equal(
    plain.committed.awaitingInput?.kind === "confirmation"
      ? plain.committed.awaitingInput.read_back
      : undefined,
    undefined,
    "repeatReadBack defaults false and must not enlarge the stored gate",
  );
  assert.equal(calls.plain, 0);
});

test("corrected re-proposal atomically replaces params, attempts, provenance, and read_back", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "repeatable_change", params: { value: "stolen" } }],
    {
      messages: [human("turn-propose"), human("turn-correction")],
      awaitingInput: eligibleGate("turn-propose", "obsolete rendering"),
    },
  );
  assert.equal(body.results[0].needs_confirmation, true);
  assert.equal(body.results[0].read_back, EXACT_READ_BACK);
  assert.deepEqual(committed.awaitingInput, {
    kind: "confirmation",
    for_action: "repeatable_change",
    params: { value: "stolen" },
    attempts_left: 2,
    max_attempts: 3,
    proposed_on_caller_turn_id: "turn-correction",
    read_back: EXACT_READ_BACK,
  });
  assert.equal(calls.render, 1);
  assert.equal(calls.repeatable, 0);
});

test("same-turn repeat is refused without touching the gate or executor", async () => {
  const { opts, calls } = makeOpts();
  const gate = eligibleGate();
  const { body, committed } = await runSteps(opts, [repeatStep], {
    messages: [human("turn-propose")],
    awaitingInput: gate,
  });
  assert.equal(body.results[0].error, "repeat_confirmation_same_turn_locked");
  assert.equal(body.failed_at, 0);
  assert.deepEqual(committed, {});
  assert.deepEqual(calls, { repeatable: 0, plain: 0, render: 0 });
});

test("later-turn repeat returns byte-identical text and refreshes only gate provenance", async () => {
  const { opts, calls } = makeOpts();
  const gate = eligibleGate();
  const before = structuredClone(gate);
  const state: S = {
    messages: [human("turn-propose"), human("turn-repeat")],
    awaitingInput: gate,
  };
  const { body, committed } = await runSteps(opts, [repeatStep], state);
  assert.equal(body.failed_at, undefined);
  assert.equal(body.results[0].confirmation_repeated, true);
  assert.equal(body.results[0].needs_confirmation, true);
  assert.equal(body.results[0].read_back, EXACT_READ_BACK);
  assert.deepEqual(
    committed.awaitingInput,
    eligibleGate("turn-repeat"),
    "repeat becomes the consent question the caller must answer later",
  );
  assert.deepEqual(
    state.awaitingInput,
    before,
    "the caller-owned input object is not mutated",
  );
  assert.deepEqual(calls, { repeatable: 0, plain: 0, render: 0 });
});

test("repeat locks same-turn mutation execution and permits it only after a later caller reply", async () => {
  const { opts, calls } = makeOpts();
  const messages = [human("turn-propose"), human("turn-repeat")];
  const repeated = await runSteps(opts, [repeatStep], {
    messages,
    awaitingInput: eligibleGate(),
  });
  assert.equal(repeated.body.results[0].confirmation_repeated, true);
  assert.deepEqual(
    repeated.committed.awaitingInput,
    eligibleGate("turn-repeat"),
  );

  const sameTurn = await runSteps(
    opts,
    [{ action: "repeatable_change", params: { value: "lost" } }],
    {
      messages,
      awaitingInput: repeated.committed.awaitingInput,
    },
  );
  assert.equal(
    sameTurn.body.results[0].error,
    "confirmation_same_turn_locked",
  );
  assert.equal(sameTurn.body.failed_at, 0);
  assert.deepEqual(sameTurn.committed, {});
  assert.equal(calls.repeatable, 0, "same-turn ReAct call must not execute");

  const laterTurn = await runSteps(
    opts,
    [{ action: "repeatable_change", params: { value: "lost" } }],
    {
      messages: [...messages, human("turn-confirm")],
      awaitingInput: repeated.committed.awaitingInput,
    },
  );
  assert.equal(laterTurn.body.results[0].ok, true);
  assert.equal(laterTurn.committed.awaitingInput, null);
  assert.equal(laterTurn.committed.changed, "lost");
  assert.equal(calls.repeatable, 1);
});

test("repeat refuses absent, ineligible, or unrendered pending input", async () => {
  const { opts } = makeOpts();
  const cases: S[] = [
    { messages: [human("turn-repeat")] },
    {
      messages: [human("turn-repeat")],
      awaitingInput: {
        kind: "otp",
        for_action: "plain_change",
        flow_ref: "flow",
      },
    },
    {
      messages: [human("turn-propose"), human("turn-repeat")],
      awaitingInput: {
        kind: "confirmation",
        for_action: "plain_change",
        params: { value: "lost" },
        attempts_left: 3,
        max_attempts: 3,
        proposed_on_caller_turn_id: "turn-propose",
        read_back: "handcrafted but action did not opt in",
      },
    },
    {
      messages: [human("turn-propose"), human("turn-repeat")],
      awaitingInput: {
        kind: "confirmation",
        for_action: "repeatable_change",
        params: { value: "lost" },
        attempts_left: 3,
        max_attempts: 3,
        proposed_on_caller_turn_id: "turn-propose",
      },
    },
  ];
  for (const state of cases) {
    const { body, committed } = await runSteps(opts, [repeatStep], state);
    assert.equal(body.results[0].error, "repeat_confirmation_not_available");
    assert.deepEqual(committed, {});
  }
});

test("repeat fails closed when a later caller turn cannot be proven", async () => {
  const { opts } = makeOpts();
  const gate = eligibleGate();
  delete (gate as { proposed_on_caller_turn_id?: string })
    .proposed_on_caller_turn_id;
  const { body, committed } = await runSteps(opts, [repeatStep], {
    messages: [human("turn-repeat")],
    awaitingInput: gate,
  });
  assert.equal(
    body.results[0].error,
    "repeat_confirmation_turn_identity_unavailable",
  );
  assert.deepEqual(committed, {});
});

test("repeat control is mechanically incompatible with mixed batches", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [repeatStep, { action: "plain_change", params: { value: "x" } }],
    {
      messages: [human("turn-propose"), human("turn-repeat")],
      awaitingInput: eligibleGate(),
    },
  );
  assert.equal(body.results[0].error, "repeat_confirmation_must_be_sole_step");
  assert.deepEqual(committed, {});
  assert.deepEqual(calls, { repeatable: 0, plain: 0, render: 0 });
});

test("request_handoff remains available while repeatable confirmation is pending", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [
      {
        action: "request_handoff",
        params: { reason: "abandon", context: "test:human_requested" },
      },
    ],
    {
      messages: [human("turn-propose")],
      awaitingInput: eligibleGate(),
    },
  );
  assert.equal(body.results[0].handoff_requested, true);
  assert.equal(committed.awaitingInput, null);
  assert.deepEqual(committed.handoff, {
    reason: "abandon",
    context: "test:human_requested",
  });
  assert.deepEqual(calls, { repeatable: 0, plain: 0, render: 0 });
});

test("AwaitingInputSchema accepts only a nonempty persisted confirmation read_back", () => {
  assert.equal(AwaitingInputSchema.safeParse(eligibleGate()).success, true);
  assert.equal(AwaitingInputSchema.safeParse(eligibleGate("turn", "")).success, false);
});

// ─── Repeat at a STANDING ASK — the safety net for a stray call ────────────
// The 2026-08-15 finding: the model called repeat_pending_question at the AFM
// standing ask, hit the ineligibility ERROR, and the guards around that turn
// re-tipped. The record now stores the host-rendered ask bytes, so a stray
// call is SERVED byte-exact instead of erroring. The describe still tells the
// model not to call here — this is disobedience handling, not a route.

const ASK_TEXT = "Πείτε μου τον αριθμό του φορολογικού σας μητρώου.";

function makeAskOpts(withRender: boolean) {
  const config = defineConfig<"gated" | "ask_source" | "capture_value", never>({
    tool: { name: "repeat_ask_test_tool", description: "repeat-at-ask test tool" },
    actions: {
      // A repeatable gate exists ONLY to activate the control.
      gated: {
        description: "confirm-gated change",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        controller: {
          requiresConfirmation: {
            maxAttempts: 3,
            repeatReadBack: true,
            readBack: () => "gated read back?",
            replyContract: {
              subject: "this question",
              subjectNoun: "question",
              executesLabel: "the change",
              categories: ["Anything unclear → make no call and re-ask."],
            },
          },
        },
        verdicts: { ok: { ok: true, summary: "changed", body: { verdict: "ok" } } },
      },
      ask_source: {
        description: "asks for the value",
        paramsSchema: z.object({}),
        prereqs: [],
        verdicts: {
          need_value: {
            ok: false,
            summary: "need it",
            body: { verdict: "need_value" },
            ask: withRender
              ? { action: "capture_value", render: () => ASK_TEXT }
              : { action: "capture_value" },
          },
        },
      },
      capture_value: {
        description: "receives the value",
        paramsSchema: z.object({
          value: callerTextParam({
            min: 1,
            max: 100,
            shortMessage: "too short",
            longMessage: "too long",
            describe: "the value, as spoken",
          }),
        }),
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "captured", body: { verdict: "ok" } } },
      },
    },
  });
  return {
    config,
    stateSchema,
    selectors: {
      gated: (s: S) => s,
      ask_source: (s: S) => s,
      capture_value: (s: S) => s,
    },
    executors: {
      gated: async () => ({ verdict: "ok" }),
      ask_source: async () => ({ verdict: "need_value" }),
      capture_value: async () => ({ verdict: "ok" }),
    },
    verifiers: {},
  } as unknown as BuildAgentStepToolOptions<
    S,
    "gated" | "ask_source" | "capture_value",
    never,
    Record<string, (s: S) => unknown>
  >;
}

test("a standing ask with stored ask_text is served by repeat — byte-exact, record untouched", async () => {
  const opts = makeAskOpts(true);
  const s0: S = { messages: [human("turn-1")] } as S;
  const r1 = await runSteps(opts as never, [{ action: "ask_source", params: {} }], s0);
  const record = (r1.committed as { awaitingInput?: AwaitingInput | null }).awaitingInput;
  assert.equal(record?.kind, "dictation");
  assert.equal((record as { ask_text?: string }).ask_text, ASK_TEXT);

  const s1: S = { ...s0, ...(r1.committed as Partial<S>), messages: [human("turn-2")] } as S;
  const r2 = await runSteps(
    opts as never,
    [{ action: REPEAT_PENDING_QUESTION_ACTION, params: {} }],
    s1,
  );
  const entry = r2.body.results[0] as Record<string, unknown>;
  assert.equal(entry.ok, true);
  assert.equal(entry.read_back, ASK_TEXT);
  assert.equal(typeof entry.read_back_directive, "string");
  assert.equal(entry.ask_repeated, true);
  // Non-locking record: the repeat neither clears nor rewrites it.
  assert.ok(!("awaitingInput" in (r2.committed as Record<string, unknown>)));
});

test("a standing ask WITHOUT stored bytes stays ineligible for repeat", async () => {
  const opts = makeAskOpts(false);
  const s0: S = { messages: [human("turn-1")] } as S;
  const r1 = await runSteps(opts as never, [{ action: "ask_source", params: {} }], s0);
  const record = (r1.committed as { awaitingInput?: AwaitingInput | null }).awaitingInput;
  assert.equal(record?.kind, "dictation");
  assert.equal((record as { ask_text?: string }).ask_text, undefined);

  const s1: S = { ...s0, ...(r1.committed as Partial<S>), messages: [human("turn-2")] } as S;
  const r2 = await runSteps(
    opts as never,
    [{ action: REPEAT_PENDING_QUESTION_ACTION, params: {} }],
    s1,
  );
  const entry = r2.body.results[0] as Record<string, unknown>;
  assert.equal(entry.ok, false);
  assert.equal(entry.error, "repeat_confirmation_not_available");
});

