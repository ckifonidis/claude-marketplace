import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "@cfworker/json-schema";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import {
  buildAgentStepTool,
  REPEAT_PENDING_CONFIRMATION_ACTION,
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
          },
        },
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
      },
    },
  });
  const executors: ExecutorRegistry<S, typeof selectors> = {
    repeatable_change: async (params) => {
      calls.repeatable++;
      return {
        resultBody: { summary: "repeatable changed" },
        stateUpdate: { changed: String((params as { value: string }).value) },
        ok: true,
      };
    },
    plain_change: async (params) => {
      calls.plain++;
      return {
        resultBody: { summary: "plain changed" },
        stateUpdate: { changed: String((params as { value: string }).value) },
        ok: true,
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
        terminateMessage: "bye",
      },
    },
    calls,
  };
}

const repeatStep = {
  action: REPEAT_PENDING_CONFIRMATION_ACTION,
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

test("repeat control is injected only when a confirmation action opts in", () => {
  const enabledTool = buildAgentStepTool(makeOpts(true).opts);
  assert.equal(
    validate({ steps: [repeatStep] }, enabledTool.schema as never).valid,
    true,
  );
  assert.match(JSON.stringify(enabledTool.schema), /repeat_pending_confirmation/);
  assert.match(enabledTool.description, /repeat_pending_confirmation/);

  const disabledTool = buildAgentStepTool(makeOpts(false).opts);
  assert.equal(
    validate({ steps: [repeatStep] }, disabledTool.schema as never).valid,
    false,
  );
  assert.doesNotMatch(JSON.stringify(disabledTool.schema), /repeat_pending_confirmation/);
  assert.doesNotMatch(disabledTool.description, /repeat_pending_confirmation/);
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
  // Gate untouched, executor unrun — the audit trail records the refusal.
  assert.deepEqual(committed, {
    actionTrail: [
      {
        action: REPEAT_PENDING_CONFIRMATION_ACTION,
        ok: false,
        error: "repeat_confirmation_same_turn_locked",
      },
    ],
  });
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
  assert.deepEqual(sameTurn.committed, {
    actionTrail: [
      {
        action: "repeatable_change",
        ok: false,
        error: "confirmation_same_turn_locked",
      },
    ],
  });
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
    assert.deepEqual(committed, {
      actionTrail: [
        {
          action: REPEAT_PENDING_CONFIRMATION_ACTION,
          ok: false,
          error: "repeat_confirmation_not_available",
        },
      ],
    });
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
  assert.deepEqual(committed, {
    actionTrail: [
      {
        action: REPEAT_PENDING_CONFIRMATION_ACTION,
        ok: false,
        error: "repeat_confirmation_turn_identity_unavailable",
      },
    ],
  });
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
