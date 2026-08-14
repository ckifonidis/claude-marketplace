import { test } from "node:test";
import { validate } from "@cfworker/json-schema";
import assert from "node:assert/strict";
import { z } from "zod";
import { Annotation } from "@langchain/langgraph";

import { defineConfig } from "./define-config.js";
import {
  buildAgentStepTool,
  runSteps,
  type BuildAgentStepToolOptions,
} from "./runner.js";
import type { ExecutorRegistry, VerifierRegistry } from "./types.js";
import type { AwaitingInput, CurrentFlow, HandoffRequest, TrailEntry } from "./state.js";
import { DEFAULT_SYSTEM_MESSAGES } from "./messages.js";

interface S {
  customer?: { code: string } | null;
  card?: { pan: string } | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
}

/** Minimal LangGraph annotation for the test state — replace-on-write for
 *  every field. The library extracts each channel's `operator` (the reducer)
 *  via runtime cast. */
const testStateAnnotation = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  customer: Annotation<S["customer"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  card: Annotation<S["card"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  awaitingInput: Annotation<S["awaitingInput"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  currentFlow: Annotation<S["currentFlow"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
});

type ActionName = "verify_customer" | "verify_card" | "fetch_card_status" | "change_status";
type PrereqName = "customerVerified" | "cardVerified";

function makeConfig() {
  return defineConfig<ActionName, PrereqName>({
    tool: { name: "test_tool", description: "test tool" },
    actions: {
      verify_customer: {
        description: "verify the customer",
        paramsSchema: z.object({ code: z.string() }),
        prereqs: [],
      },
      verify_card: {
        description: "verify the card",
        paramsSchema: z.object({ pan: z.string() }),
        prereqs: ["customerVerified"],
      },
      fetch_card_status: {
        description: "read card status",
        paramsSchema: z.object({}),
        prereqs: ["cardVerified"],
      },
      change_status: {
        description: "change card status",
        paramsSchema: z.object({ newStatus: z.string() }),
        prereqs: ["cardVerified"],
        controller: { soleStep: true },
      },
    },
  });
}

interface Calls {
  verifyCustomer: number;
  verifyCard: number;
  fetchCardStatus: number;
  changeStatus: number;
}

interface MockOpts {
  fetchCardStatusValue?: { state?: string; summary?: string };
  changeOk?: boolean;
  cardOk?: boolean;
  customerOk?: boolean;
  /** Make verify_card THROW (simulates a fetcher/backend hard failure) rather
   *  than return ok:false — exercises the runner's executor-throw boundary. */
  cardThrows?: boolean;
}

// Identity selectors — these unit tests exercise the runner's flow control, not
// state projection, so each action's selector just hands the executor the full
// state. Keyed 1:1 by action name (the runner looks them up by name).
const baseSelectors = {
  verify_customer: (s: S) => s,
  verify_card: (s: S) => s,
  fetch_card_status: (s: S) => s,
  change_status: (s: S) => s,
};

function makeOpts(
  mock: MockOpts = {},
): { opts: BuildAgentStepToolOptions<S, string, string, typeof baseSelectors>; calls: Calls } {
  const calls: Calls = { verifyCustomer: 0, verifyCard: 0, fetchCardStatus: 0, changeStatus: 0 };
  const executors: ExecutorRegistry<S, typeof baseSelectors> = {
    verify_customer: async (params) => {
      calls.verifyCustomer++;
      const ok = mock.customerOk ?? true;
      const code = (params as { code: string }).code;
      return ok
        ? {
            resultBody: { summary: "customer ok", verdict: "ok", code },
            stateUpdate: { customer: { code } },
            ok: true,
          }
        : {
            resultBody: { summary: "no customer", verdict: "customer_not_found" },
            ok: false,
          };
    },
    verify_card: async (params) => {
      calls.verifyCard++;
      if (mock.cardThrows) throw new Error("boom: backend exploded");
      const ok = mock.cardOk ?? true;
      const pan = (params as { pan: string }).pan;
      return ok
        ? {
            resultBody: { summary: "card ok", verdict: "ok", pan },
            stateUpdate: { card: { pan } },
            ok: true,
          }
        : {
            resultBody: { summary: "no card", verdict: "card_not_found" },
            ok: false,
          };
    },
    fetch_card_status: async () => {
      calls.fetchCardStatus++;
      const fv = mock.fetchCardStatusValue ?? { state: "active", summary: "state active" };
      return { resultBody: fv, ok: true };
    },
    change_status: async (params) => {
      calls.changeStatus++;
      const ok = mock.changeOk ?? true;
      return {
        resultBody: {
          summary: ok ? "mutated" : "mutation failed",
          success: ok,
          newStatus: (params as { newStatus: string }).newStatus,
        },
        ok,
      };
    },
  };
  const verifiers: VerifierRegistry<S> = {
    customerVerified: {
      check: (s) => s?.customer != null,
      denial: { summary: "Need verify_customer.", error: "customer_not_verified" },
    },
    cardVerified: {
      check: (s) => s?.card != null,
      denial: { summary: "Need verify_card.", error: "card_not_verified" },
    },
  };
  return {
    opts: {
      config: makeConfig(),
      stateSchema: testStateAnnotation,
      selectors: baseSelectors,
      executors,
      verifiers,
    },
    calls,
  };
}

const EMPTY: S = { customer: null, card: null };

test("construction throws when executor name is missing", () => {
  const { opts } = makeOpts();
  const bad = { ...opts, executors: { ...opts.executors } };
  delete (bad.executors as Record<string, unknown>).verify_customer;
  assert.throws(() => buildAgentStepTool(bad), /executors\["verify_customer"\]/);
});

test("construction throws when prereq verifier is missing", () => {
  const { opts } = makeOpts();
  const bad = { ...opts, verifiers: { ...opts.verifiers } };
  delete (bad.verifiers as Record<string, unknown>).cardVerified;
  assert.throws(() => buildAgentStepTool(bad), /prereq "cardVerified"/);
});

test("construction throws when neither stateSchema nor stateSchema is provided", () => {
  const { opts } = makeOpts();
  const bad = { ...opts };
  delete (bad as Record<string, unknown>).stateSchema;
  assert.throws(() => buildAgentStepTool(bad), /requires `stateSchema`/);
});

test("executor that throws → ok:false step, short-circuit, earlier commits preserved", async () => {
  // The runner must convert an executor throw into an ok:false StepResult (not
  // let it escape), so the LLM still gets the envelope AND the prior step's
  // stateUpdate survives in `committed` (cumulative commit on partial failure).
  const { opts, calls } = makeOpts({ cardThrows: true });
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "verify_customer", params: { code: "C1" } },
      { action: "verify_card", params: { pan: "P1" } },
    ],
    EMPTY,
  );
  assert.equal(calls.verifyCustomer, 1);
  assert.equal(calls.verifyCard, 1);
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, false);
  assert.equal(body.results[1].error, "executor_error");
  // User-facing summary is the neutral default message (no backend internals
  // leak to the spoken response); the raw cause is preserved in `_debug`.
  assert.equal(body.results[1].summary, DEFAULT_SYSTEM_MESSAGES.executor_error);
  assert.match(body.results[1]._debug as string, /boom: backend exploded/);
  assert.equal(body.failed_at, 1);
  // verify_customer's commit is NOT discarded by the later throw.
  assert.deepEqual(committed.customer, { code: "C1" });
});

test("single-action ok", async () => {
  const { opts } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "verify_customer", params: { code: "C1" } }],
    EMPTY,
  );
  assert.equal(body.failed_at, undefined);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].action, "verify_customer");
  assert.equal(body.results[0].ok, true);
  assert.deepEqual(committed.customer, { code: "C1" });
});

test("batched ok — three steps, state threaded between", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "verify_customer", params: { code: "C1" } },
      { action: "verify_card", params: { pan: "P1" } },
      { action: "fetch_card_status", params: {} },
    ],
    EMPTY,
  );
  assert.equal(body.failed_at, undefined);
  assert.equal(body.results.length, 3);
  assert.equal(body.results[2].action, "fetch_card_status");
  assert.equal(body.results[2].ok, true);
  assert.equal(calls.verifyCustomer, 1);
  assert.equal(calls.verifyCard, 1);
  assert.equal(calls.fetchCardStatus, 1);
  assert.deepEqual(committed.customer, { code: "C1" });
  assert.deepEqual(committed.card, { pan: "P1" });
});

test("prereq missing → denial, no execution", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "fetch_card_status", params: {} }],
    EMPTY,
  );
  assert.equal(body.failed_at, 0);
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "card_not_verified");
  assert.equal(calls.fetchCardStatus, 0);
  // No domain writes — the only committed field is the audit trail recording
  // the denial itself.
  assert.deepEqual(committed, {
    actionTrail: [{ action: "fetch_card_status", ok: false, error: "card_not_verified" }],
  });
});

test("prereq satisfied by earlier batch step (in-batch threading)", async () => {
  const { opts } = makeOpts();
  const { body } = await runSteps(
    opts,
    [
      { action: "verify_customer", params: { code: "C1" } },
      { action: "verify_card", params: { pan: "P1" } },
    ],
    EMPTY,
  );
  assert.equal(body.failed_at, undefined);
  assert.equal(body.results[1].ok, true);
});

test("mutation alone → single result, executor handles verification itself", async () => {
  const { opts, calls } = makeOpts();
  const seeded: S = { customer: { code: "C1" }, card: { pan: "P1" } };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    seeded,
  );
  assert.equal(body.failed_at, undefined);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].action, "change_status");
  assert.equal(body.results[0].ok, true);
  assert.equal(calls.changeStatus, 1);
  assert.equal(calls.fetchCardStatus, 0, "library no longer wraps; executor does its own reads");
  // The executor writes no state; the audit trail is the only committed field.
  assert.deepEqual(committed, {
    actionTrail: [{ action: "change_status", ok: true }],
  });
});

test("mutation with extra step → refusal, no execution", async () => {
  const { opts, calls } = makeOpts();
  const seeded: S = { customer: { code: "C1" }, card: { pan: "P1" } };
  const { body } = await runSteps(
    opts,
    [
      { action: "fetch_card_status", params: {} },
      { action: "change_status", params: { newStatus: "lost" } },
    ],
    seeded,
  );
  assert.equal(body.failed_at, 0);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].error, "mutation_must_be_sole_step");
  assert.equal(calls.fetchCardStatus, 0);
  assert.equal(calls.changeStatus, 0);
});

test("short-circuit on non-ok step", async () => {
  const { opts, calls } = makeOpts({ cardOk: false });
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "verify_customer", params: { code: "C1" } },
      { action: "verify_card", params: { pan: "P1" } },
      { action: "fetch_card_status", params: {} },
    ],
    EMPTY,
  );
  assert.equal(body.results.length, 2);
  assert.equal(body.results[1].ok, false);
  assert.equal(body.failed_at, 1);
  assert.equal(calls.fetchCardStatus, 0);
  // Cumulative commit: customer update lands even though later step failed.
  assert.deepEqual(committed.customer, { code: "C1" });
  assert.equal(committed.card, undefined);
});

test("empty batch is schema-valid (no minItems) and runs as a no-op", async () => {
  const { opts } = makeOpts();
  // `minItems` is not permitted under OpenAI strict structured outputs, so the
  // schema intentionally does NOT reject an empty batch. The runner handles it
  // gracefully: the step loops are length-guarded, so an empty batch produces
  // no results rather than an error. The tool is bound with the JSON-schema
  // rendering (shape-only wrapper validation), so assert through the same
  // validator the wrapper uses.
  const t = buildAgentStepTool(opts);
  const parsed = validate({ steps: [] }, t.schema as never);
  assert.equal(parsed.valid, true);

  const { body } = await runSteps(opts, [], EMPTY);
  assert.equal(body.results.length, 0);
  assert.equal(body.failed_at, undefined);
});

// ─── Confirmation-required mutation tests ────────────────────────────────── //

function makeConfirmOpts(
  mock: MockOpts = {},
  confirm: { maxAttempts?: number; lockdown?: boolean } = {},
): { opts: BuildAgentStepToolOptions<S, string, string, typeof baseSelectors>; calls: Calls } {
  const base = makeOpts(mock);
  const cfg = makeConfig();
  cfg.actions.change_status.controller!.requiresConfirmation = {
    maxAttempts: confirm.maxAttempts ?? 3,
    ...(confirm.lockdown !== undefined && { lockdown: confirm.lockdown }),
  };
  return { ...base, opts: { ...base.opts, config: cfg } };
}

const SEEDED: S = { customer: { code: "C1" }, card: { pan: "P1" } };

test("confirm-required: first call proposes; no executor, awaiting set, needs_confirmation", async () => {
  const { opts, calls } = makeConfirmOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    SEEDED,
  );
  // No executors run — not change, not fetch
  assert.equal(calls.changeStatus, 0);
  assert.equal(calls.fetchCardStatus, 0);
  // awaitingInput set in committed update
  const awaiting = (committed as { awaitingInput?: AwaitingInput }).awaitingInput;
  assert.ok(awaiting && awaiting.kind === "confirmation");
  if (awaiting && awaiting.kind === "confirmation") {
    assert.equal(awaiting.for_action, "change_status");
    assert.deepEqual(awaiting.params, { newStatus: "lost" });
    assert.equal(awaiting.attempts_left, 3);
  }
  // Result body shape
  assert.equal(body.results.length, 1);
  const r = body.results[0];
  assert.equal(r.action, "change_status");
  assert.equal(r.ok, true);
  assert.equal(r.needs_confirmation, true);
  assert.deepEqual(r.proposed_params, { newStatus: "lost" });
  assert.equal(r.attempts_left, 3);
});

test("confirm-required: same-params re-call executes; pending cleared atomically", async () => {
  const { opts, calls } = makeConfirmOpts();
  const seeded: S = {
    ...SEEDED,
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_status",
      params: { newStatus: "lost" },
      attempts_left: 3,
      max_attempts: 3,
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    seeded,
  );
  // Execute mode: the mutation runs as a single step; the executor handles
  // any internal verification on its own.
  assert.equal(calls.changeStatus, 1);
  assert.equal(calls.fetchCardStatus, 0, "no library-driven wrap reads");
  // Pending explicitly cleared in committed
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    null,
  );
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].action, "change_status");
  assert.equal(body.results[0].ok, true);
});

test("confirm-required: drifted-params re-call re-proposes and decrements", async () => {
  const { opts, calls } = makeConfirmOpts();
  const seeded: S = {
    ...SEEDED,
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_status",
      params: { newStatus: "lost" },
      attempts_left: 3,
      max_attempts: 3,
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "stolen" } }],
    seeded,
  );
  assert.equal(calls.changeStatus, 0);
  assert.equal(calls.fetchCardStatus, 0);
  const awaiting = (committed as { awaitingInput?: AwaitingInput }).awaitingInput;
  assert.ok(awaiting && awaiting.kind === "confirmation");
  if (awaiting && awaiting.kind === "confirmation") {
    assert.deepEqual(awaiting.params, { newStatus: "stolen" });
    assert.equal(awaiting.attempts_left, 2);
  }
  assert.equal(body.results[0].needs_confirmation, true);
  assert.equal(body.results[0].attempts_left, 2);
});

test("confirm-required: attempts exhausted clears pending and returns error", async () => {
  const { opts, calls } = makeConfirmOpts();
  const seeded: S = {
    ...SEEDED,
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_status",
      params: { newStatus: "lost" },
      attempts_left: 0,
      max_attempts: 3,
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "stolen" } }],
    seeded,
  );
  assert.equal(calls.changeStatus, 0);
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    null,
  );
  assert.equal(body.failed_at, 0);
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "confirmation_attempts_exhausted");
});

/* Phase 2 dropped library-side TTL on confirmation — the conversation
 * drives lifecycle. The former "TTL-expired pending cleared at batch start"
 * test is no longer applicable. */

test("confirm-required: lockdown refuses unrelated actions", async () => {
  const { opts, calls } = makeConfirmOpts();
  const seeded: S = {
    ...SEEDED,
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_status",
      params: { newStatus: "lost" },
      attempts_left: 3,
      max_attempts: 3,
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "fetch_card_status", params: {} }],
    seeded,
  );
  assert.equal(calls.fetchCardStatus, 0);
  // No state changes (committed should not touch pendingConfirmation).
  assert.equal(
    (committed as { pendingConfirmation?: unknown }).pendingConfirmation,
    undefined,
  );
  assert.equal(body.failed_at, 0);
  assert.equal(body.results[0].error, "pending_confirmation_locked");
  assert.deepEqual(body.results[0].awaiting, {
    kind: "confirmation",
    for_action: "change_status",
  });
});

test("abort_pending_input clears pending and reports the aborted action", async () => {
  const { opts } = makeConfirmOpts();
  const seeded: S = {
    ...SEEDED,
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_status",
      params: { newStatus: "lost" },
      attempts_left: 3,
      max_attempts: 3,
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "abort_pending_input", params: {} }],
    seeded,
  );
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    null,
  );
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    null,
  );
  assert.equal(body.results[0].action, "abort_pending_input");
  assert.equal(body.results[0].ok, true);
  assert.deepEqual(body.results[0].aborted_awaiting, {
    kind: "confirmation",
    for_action: "change_status",
  });
});

test("abort_pending_input is idempotent — returns nothing-to-abort when no input or flow", async () => {
  const { opts } = makeConfirmOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "abort_pending_input", params: {} }],
    SEEDED,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].summary, DEFAULT_SYSTEM_MESSAGES.abort_nothing);
  // Idempotent: no slot mutations.
  assert.equal(
    (committed as { pendingConfirmation?: unknown }).pendingConfirmation,
    undefined,
  );
  assert.equal(
    (committed as { awaitingInput?: unknown }).awaitingInput,
    undefined,
  );
});

test("system messages: host `messages` overrides are used in place of the defaults", async () => {
  // The library ships neutral English defaults but lets a host inject its own
  // wording via `opts.messages` (shallow-merged). Verify both an error path and
  // an abort path pick up the override; un-overridden keys keep their defaults.
  const thrown = makeOpts({ cardThrows: true });
  const errRun = await runSteps(
    { ...thrown.opts, messages: { executor_error: "CUSTOM-ERR" } },
    [
      { action: "verify_customer", params: { code: "C1" } },
      { action: "verify_card", params: { pan: "P1" } },
    ],
    EMPTY,
  );
  assert.equal(errRun.body.results[1].summary, "CUSTOM-ERR", "executor_error override used");
  assert.match(errRun.body.results[1]._debug as string, /boom: backend exploded/, "raw cause still in _debug");

  const aborts = makeConfirmOpts();
  const abortRun = await runSteps(
    { ...aborts.opts, messages: { abort_nothing: "CUSTOM-NOTHING" } },
    [{ action: "abort_pending_input", params: {} }],
    SEEDED,
  );
  assert.equal(abortRun.body.results[0].summary, "CUSTOM-NOTHING", "abort_nothing override used");
});

test("library refuses user action named abort_pending_input", () => {
  const { opts } = makeConfirmOpts();
  const cfg = makeConfig();
  (cfg.actions as Record<string, unknown>).abort_pending_input = {
    paramsSchema: z.object({}),
    prereqs: [],
    executor: "verifyCustomer",
  };
  cfg.actions.change_status.controller!.requiresConfirmation = { maxAttempts: 3 };
  assert.throws(
    () => buildAgentStepTool({ ...opts, config: cfg }),
    /reserved action name/,
  );
});

test("same-batch bypass blocked: propose-then-execute in one batch never satisfies pending", async () => {
  // Build a config WITHOUT soleStep so the runner allows two same-action steps
  // in a single batch — this exercises the snapshot-from-getCurrentTaskInput
  // safety net (pending created in step 0 must NOT satisfy step 1 in the same
  // batch).
  const cfg = makeConfig();
  cfg.actions.change_status.controller!.soleStep = false;
  cfg.actions.change_status.controller!.requiresConfirmation = { maxAttempts: 3 };
  const base = makeOpts();
  const opts = { ...base.opts, config: cfg };
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "change_status", params: { newStatus: "lost" } },
      { action: "change_status", params: { newStatus: "lost" } },
    ],
    SEEDED,
  );
  // Both calls should be propose mode (the second can't see the first's
  // pending via the snapshot — getPending in plan-expansion reads the view,
  // but view is initialized from initialState and plan expansion happens
  // BEFORE any step executes). The first propose writes pending to view in
  // the execution loop, so the second step's plan-expansion has already
  // committed to propose mode at plan-time, before execution.
  // Verify: changeStatus executor never ran.
  assert.equal(base.calls.changeStatus, 0);
  // Both results are needs_confirmation
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].needs_confirmation, true);
  assert.equal(body.results[1].needs_confirmation, true);
  // Final committed awaiting matches the last write
  const awaiting = (committed as { awaitingInput?: AwaitingInput }).awaitingInput;
  assert.ok(awaiting && awaiting.kind === "confirmation");
  if (awaiting && awaiting.kind === "confirmation") {
    assert.deepEqual(awaiting.params, { newStatus: "lost" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 2 of the global-flow redesign: OTP + multi-turn flow lifecycle.
// `request_x` opens a flow and issues an OTP; `validate_otp` consumes the
// OTP; `finish_x` closes the flow. The library coordinates lockdown, mutex,
// auto-clear; executors only emit lifecycle signals.
// ────────────────────────────────────────────────────────────────────────────

type FlowActionName =
  | "open_flow_a"
  | "validate_a_otp"
  | "finish_flow_a"
  | "open_flow_b";

interface FlowCalls {
  openA: number;
  validateA: number;
  finishA: number;
  openB: number;
}

const flowSelectors = {
  open_flow_a: (s: S) => s,
  validate_a_otp: (s: S) => s,
  finish_flow_a: (s: S) => s,
  open_flow_b: (s: S) => s,
};

function makeFlowOpts(mock?: {
  validateOutcome?: "ok" | "wrong" | "timeout" | "lock";
}): {
  opts: BuildAgentStepToolOptions<S, FlowActionName, string, typeof flowSelectors>;
  calls: FlowCalls;
} {
  const calls: FlowCalls = { openA: 0, validateA: 0, finishA: 0, openB: 0 };
  const executors: ExecutorRegistry<S, typeof flowSelectors> = {
    open_flow_a: async () => {
      calls.openA++;
      return {
        ok: true,
        resultBody: { summary: "flow A opened", otp_sent: true },
        effects: [
          { type: "merge_flow_data", data: { challengeId: `ch-${calls.openA}`, mobile_masked: "***1234" } },
          { type: "otp_issued" },
        ],
      };
    },
    validate_a_otp: async () => {
      calls.validateA++;
      switch (mock?.validateOutcome) {
        case "wrong":
          return { ok: false, resultBody: { summary: "wrong code", error: "otp_invalid" } };
        case "timeout":
          return {
            ok: false,
            resultBody: { summary: "code expired", error: "otp_timeout" },
            effects: [{ type: "clear_awaiting_input" }],
          };
        case "lock":
          return {
            ok: false,
            resultBody: { summary: "locked", error: "otp_locked" },
            effects: [{ type: "abort_flow" }],
          };
        case "ok":
        default:
          return {
            ok: true,
            resultBody: { summary: "otp validated", otp_valid: true },
            effects: [{ type: "merge_flow_data", data: { otpValidated: true } }],
          };
      }
    },
    finish_flow_a: async () => {
      calls.finishA++;
      return {
        ok: true,
        resultBody: { summary: "flow A finished", success: true },
      };
    },
    open_flow_b: async () => {
      calls.openB++;
      return {
        ok: true,
        resultBody: { summary: "flow B opened" },
        effects: [
          { type: "merge_flow_data", data: { challengeId: "ch-b" } },
          { type: "otp_issued" },
        ],
      };
    },
  };
  const verifiers: VerifierRegistry<S> = {};
  const cfg = defineConfig<FlowActionName, string>({
    tool: { name: "flow_tool", description: "flow test tool" },
    actions: {
      open_flow_a: {
        description: "open flow A",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: {
          startsFlow: { name: "flow_a" },
          issuesOtp: { consumer_action: "validate_a_otp" },
        },
      },
      validate_a_otp: {
        description: "validate OTP for flow A",
        paramsSchema: z.object({ otp: z.string() }),
        prereqs: [],
        controller: {
          requiresOtp: true,
          requiresFlow: "flow_a",
        },
      },
      finish_flow_a: {
        description: "finish flow A",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: {
          requiresFlow: "flow_a",
          endsFlow: true,
        },
      },
      open_flow_b: {
        description: "open flow B",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: {
          startsFlow: { name: "flow_b" },
          issuesOtp: { consumer_action: "validate_a_otp" },
        },
      },
    },
  });
  return {
    opts: { config: cfg, stateSchema: testStateAnnotation, selectors: flowSelectors, executors, verifiers },
    calls,
  };
}

test("phase-2: startsFlow opens currentFlow + issuesOtp sets awaitingInput=otp", async () => {
  const { opts, calls } = makeFlowOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "open_flow_a", params: {} }],
    {} as S,
  );
  assert.equal(calls.openA, 1);
  assert.equal(body.results[0].ok, true);
  const flow = (committed as { currentFlow?: CurrentFlow | null }).currentFlow;
  assert.ok(flow);
  assert.equal(flow!.name, "flow_a");
  assert.equal(flow!.data.challengeId, "ch-1");
  const awaiting = (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput;
  assert.ok(awaiting);
  assert.equal(awaiting!.kind, "otp");
  if (awaiting!.kind === "otp") {
    assert.equal(awaiting.for_action, "validate_a_otp");
    assert.equal(awaiting.flow_ref, "flow_a");
  }
});

test("phase-2: requiresOtp success auto-clears awaitingInput, keeps flow", async () => {
  const { opts } = makeFlowOpts({ validateOutcome: "ok" });
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: { kind: "otp", for_action: "validate_a_otp", flow_ref: "flow_a" },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "validate_a_otp", params: { otp: "123456" } }],
    seeded,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    null,
    "awaitingInput auto-cleared on requiresOtp success",
  );
  const flow = (committed as { currentFlow?: CurrentFlow | null }).currentFlow;
  assert.ok(flow);
  assert.equal(flow!.data.otpValidated, true, "flowData merged");
});

test("phase-2: requiresOtp wrong-code (no lifecycle) leaves awaitingInput intact", async () => {
  const { opts } = makeFlowOpts({ validateOutcome: "wrong" });
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: { kind: "otp", for_action: "validate_a_otp", flow_ref: "flow_a" },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "validate_a_otp", params: { otp: "000000" } }],
    seeded,
  );
  assert.equal(body.results[0].ok, false);
  // Library leaves awaitingInput untouched (executor reported ok:false with no
  // lifecycle signal — customer can re-read the same code).
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    undefined,
    "no awaitingInput write on retry-allowed wrong code",
  );
});

test("phase-2: requiresOtp timeout clears awaitingInput, keeps flow", async () => {
  const { opts } = makeFlowOpts({ validateOutcome: "timeout" });
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: { kind: "otp", for_action: "validate_a_otp", flow_ref: "flow_a" },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "validate_a_otp", params: { otp: "000000" } }],
    seeded,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    null,
    "awaitingInput cleared on timeout",
  );
  // currentFlow MUST remain so the LLM can re-issue via the same flow.
  const finalCommitted = committed as { currentFlow?: CurrentFlow | null };
  // The flow wasn't re-set in this turn, but it should still be carried over
  // (no committed write means the prior state value persists in the view).
  // The test asserts the runner didn't actively clear currentFlow.
  assert.notEqual(finalCommitted.currentFlow, null);
});

test("phase-2: requiresOtp lockout (abortFlow) clears both slots", async () => {
  const { opts } = makeFlowOpts({ validateOutcome: "lock" });
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: { kind: "otp", for_action: "validate_a_otp", flow_ref: "flow_a" },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "validate_a_otp", params: { otp: "000000" } }],
    seeded,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    null,
  );
  assert.equal(
    (committed as { currentFlow?: CurrentFlow | null }).currentFlow,
    null,
  );
});

test("phase-2: flow mutex refuses opening a different flow", async () => {
  const { opts } = makeFlowOpts();
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
  };
  const { body } = await runSteps(
    opts,
    [{ action: "open_flow_b", params: {} }],
    seeded,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "flow_already_active");
  assert.equal(body.results[0].active_flow, "flow_a");
});

test("phase-2: startsFlow idempotent within same flow — merges new flowData", async () => {
  const { opts, calls } = makeFlowOpts();
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-old", psdAccepted: true } },
  };
  const { committed } = await runSteps(
    opts,
    [{ action: "open_flow_a", params: {} }],
    seeded,
  );
  assert.equal(calls.openA, 1);
  const flow = (committed as { currentFlow?: CurrentFlow | null }).currentFlow;
  assert.ok(flow);
  assert.equal(flow!.name, "flow_a");
  assert.equal(flow!.data.challengeId, "ch-1", "new challenge merged");
  assert.equal(flow!.data.psdAccepted, true, "existing flow data preserved on re-issue");
});

test("phase-2: input lockdown — OTP pending refuses unrelated action", async () => {
  const { opts } = makeFlowOpts();
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: { kind: "otp", for_action: "validate_a_otp", flow_ref: "flow_a" },
  };
  const { body } = await runSteps(
    opts,
    [{ action: "open_flow_b", params: {} }],
    seeded,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "otp_pending_locked");
});

test("phase-2: requiresOtp without OTP pending refuses with otp_not_pending", async () => {
  const { opts } = makeFlowOpts();
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    // no awaitingInput
  };
  const { body } = await runSteps(
    opts,
    [{ action: "validate_a_otp", params: { otp: "123456" } }],
    seeded,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "otp_not_pending");
});

test("phase-2: requiresFlow refuses when no flow active", async () => {
  const { opts } = makeFlowOpts();
  const { body } = await runSteps(
    opts,
    [{ action: "finish_flow_a", params: {} }],
    {} as S,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "no_flow_active");
});

test("phase-2: endsFlow drops currentFlow + awaitingInput together", async () => {
  const { opts } = makeFlowOpts();
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { otpValidated: true } },
    awaitingInput: null,
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "finish_flow_a", params: {} }],
    seeded,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(
    (committed as { currentFlow?: CurrentFlow | null }).currentFlow,
    null,
  );
});

test("phase-2: abort_pending_input in a multi-step batch clears + allows next step", async () => {
  const { opts } = makeFlowOpts();
  const seeded: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: { kind: "otp", for_action: "validate_a_otp", flow_ref: "flow_a" },
  };
  // [abort, open_flow_b] — abort clears the gate, then open_flow_b runs.
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "open_flow_b", params: {} },
    ],
    seeded,
  );
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, true);
  const flow = (committed as { currentFlow?: CurrentFlow | null }).currentFlow;
  assert.ok(flow);
  assert.equal(flow!.name, "flow_b");
});

test("abortPolicy requires active state and one allow-listed follower", async () => {
  const { opts, calls } = makeFlowOpts();
  const policyOpts = {
    ...opts,
    abortPolicy: {
      requireActive: true,
      allowStandalone: false,
      allowedFollowers: ["open_flow_b"] as const,
    },
  };

  const inactive = await runSteps(
    policyOpts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "open_flow_b", params: {} },
    ],
    {} as S,
  );
  assert.equal(inactive.body.results[0].error, "abort_requires_active_input");
  assert.equal(calls.openB, 0);

  const active: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: {
      kind: "otp",
      for_action: "validate_a_otp",
      flow_ref: "flow_a",
    },
  };
  const standalone = await runSteps(
    policyOpts,
    [{ action: "abort_pending_input", params: {} }],
    active,
  );
  assert.equal(standalone.body.results[0].error, "abort_follower_required");

  const forbidden = await runSteps(
    policyOpts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "open_flow_a", params: {} },
    ],
    active,
  );
  assert.equal(forbidden.body.results[0].error, "abort_follower_not_allowed");
  assert.equal(calls.openA, 0);

  const allowed = await runSteps(
    policyOpts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "open_flow_b", params: {} },
    ],
    active,
  );
  assert.equal(allowed.body.failed_at, undefined);
  assert.equal(allowed.body.results[0].ok, true);
  assert.equal(allowed.body.results[1].ok, true);
  assert.equal(calls.openB, 1);
  assert.equal(allowed.committed.currentFlow?.name, "flow_b");
});

test("abortPolicy pending-target allow-list refuses the whole batch before abort commits", async () => {
  const { opts, calls } = makeFlowOpts();
  const policyOpts = {
    ...opts,
    abortPolicy: {
      requireActive: true,
      allowStandalone: false,
      allowedPendingTargets: ["validate_a_otp"] as const,
      allowedFollowers: ["open_flow_b"] as const,
    },
  };
  const wrongTarget: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: {
      kind: "otp",
      for_action: "open_flow_a",
      flow_ref: "flow_a",
    },
  };

  const refused = await runSteps(
    policyOpts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "open_flow_b", params: {} },
    ],
    wrongTarget,
  );
  assert.equal(
    refused.body.results[0].error,
    "abort_pending_target_not_allowed",
  );
  assert.deepEqual(refused.body.results[0].awaiting, {
    kind: "otp",
    for_action: "open_flow_a",
  });
  assert.deepEqual(refused.committed, {});
  assert.equal(calls.openB, 0);

  const flowOnly = await runSteps(
    policyOpts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "open_flow_b", params: {} },
    ],
    { currentFlow: { name: "flow_a", data: {} } } as S,
  );
  assert.equal(
    flowOnly.body.results[0].error,
    "abort_pending_target_not_allowed",
  );
  assert.deepEqual(flowOnly.committed, {});
  assert.equal(calls.openB, 0);

  const allowedTarget: S = {
    currentFlow: { name: "flow_a", data: { challengeId: "ch-1" } },
    awaitingInput: {
      kind: "otp",
      for_action: "validate_a_otp",
      flow_ref: "flow_a",
    },
  };
  const allowed = await runSteps(
    policyOpts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "open_flow_b", params: {} },
    ],
    allowedTarget,
  );
  assert.equal(allowed.body.failed_at, undefined);
  assert.equal(allowed.body.results[0].ok, true);
  assert.deepEqual(allowed.body.results[0].aborted_awaiting, {
    kind: "otp",
    for_action: "validate_a_otp",
  });
  assert.equal(allowed.body.results[1].ok, true);
  assert.equal(calls.openB, 1);
});

test("abortPolicy enforces abort-first and a maximum of one follower", async () => {
  const { opts, calls } = makeFlowOpts();
  const policyOpts = {
    ...opts,
    abortPolicy: {
      allowStandalone: true,
      allowedFollowers: ["open_flow_a", "open_flow_b"] as const,
    },
  };

  const notFirst = await runSteps(
    policyOpts,
    [
      { action: "finish_flow_a", params: {} },
      { action: "abort_pending_input", params: {} },
    ],
    {} as S,
  );
  assert.equal(notFirst.body.results[0].error, "abort_must_be_first");

  const tooMany = await runSteps(
    policyOpts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "open_flow_a", params: {} },
      { action: "open_flow_b", params: {} },
    ],
    {} as S,
  );
  assert.equal(tooMany.body.results[0].error, "abort_too_many_followers");
  assert.deepEqual(calls, { openA: 0, validateA: 0, finishA: 0, openB: 0 });
});

test("abortPolicy is construction-validated and reflected in the model surface", () => {
  const { opts } = makeFlowOpts();
  assert.throws(
    () =>
      buildAgentStepTool({
        ...opts,
        abortPolicy: {
          allowStandalone: false,
          allowedFollowers: [] as const,
        },
      }),
    /requires at least one allowedFollower/,
  );
  assert.throws(
    () =>
      buildAgentStepTool({
        ...opts,
        abortPolicy: {
          // Runtime defense for untyped JavaScript/config input.
          allowedFollowers: ["missing_action"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    /unknown allowedFollower "missing_action"/,
  );
  assert.throws(
    () =>
      buildAgentStepTool({
        ...opts,
        abortPolicy: {
          allowedPendingTargets: [] as const,
        },
      }),
    /allowedPendingTargets must not be empty/,
  );
  assert.throws(
    () =>
      buildAgentStepTool({
        ...opts,
        abortPolicy: {
          // Runtime defense for untyped JavaScript/config input.
          allowedPendingTargets: ["missing_action"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    /unknown allowedPendingTarget "missing_action"/,
  );
  assert.throws(
    () =>
      buildAgentStepTool({
        ...opts,
        abortPolicy: {
          // Runtime defense for untyped JavaScript/config input.
          allowedPendingTargets: ["validate_a_otp", "validate_a_otp"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    /allowedPendingTargets contains duplicate actions/,
  );

  const tool = buildAgentStepTool({
    ...opts,
    abortPolicy: {
      requireActive: true,
      allowStandalone: false,
      allowedPendingTargets: ["validate_a_otp"] as const,
      allowedFollowers: ["open_flow_b"] as const,
    },
  });
  assert.match(tool.description, /first, followed by exactly one allowed domain action/);
  const wire = JSON.stringify(tool.schema);
  assert.match(wire, /must be the first step/);
  assert.match(wire, /open_flow_b/);
  assert.match(wire, /must currently target/);
  assert.match(wire, /validate_a_otp/);
  assert.match(wire, /active flow or pending bounded choice alone does not qualify/);
});

test("phase-2: in-batch threading — open_flow_a + validate_a_otp in one batch", async () => {
  const { opts, calls } = makeFlowOpts({ validateOutcome: "ok" });
  // Step 0 opens the flow and seeds awaitingInput. Step 1 then sees it via
  // the in-batch threaded view and validates successfully.
  const { body } = await runSteps(
    opts,
    [
      { action: "open_flow_a", params: {} },
      { action: "validate_a_otp", params: { otp: "123456" } },
    ],
    {} as S,
  );
  assert.equal(calls.openA, 1);
  assert.equal(calls.validateA, 1);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, true);
});

// ─── F2: unknown_action defense ────────────────────────────────────────── //

test("f2: unknown action returns structured unknown_action error (no crash)", async () => {
  const { opts } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "delete_account_permanently", params: {} }],
    EMPTY,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "unknown_action");
  assert.equal(body.failed_at, 0);
  assert.deepEqual(committed, {});
});

test("f2: unknown action sandwiched in batch short-circuits without crash", async () => {
  const { opts, calls } = makeOpts();
  const { body } = await runSteps(
    opts,
    [
      { action: "verify_customer", params: { code: "C1" } },
      { action: "made_up_action", params: {} },
      { action: "verify_card", params: { pan: "P1" } },
    ],
    EMPTY,
  );
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].error, "unknown_action");
  assert.equal(calls.verifyCustomer, 0, "no step runs when batch has unknown action");
});

// ─── F1: soleOnExecute semantics ───────────────────────────────────────── //

interface SoeS {
  customer?: { code: string } | null;
  card?: { pan: string } | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
}

const soeAnnotation = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  customer: Annotation<SoeS["customer"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  card: Annotation<SoeS["card"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  awaitingInput: Annotation<SoeS["awaitingInput"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  currentFlow: Annotation<SoeS["currentFlow"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
});

const soeSelectors = {
  read_thing: (s: SoeS) => s,
  mutate_thing: (s: SoeS) => s,
};

function makeSoeOpts(): {
  opts: BuildAgentStepToolOptions<SoeS, string, string, typeof soeSelectors>;
  calls: { read: number; mutate: number };
} {
  const calls = { read: 0, mutate: 0 };
  const config = defineConfig<"read_thing" | "mutate_thing", never>({
    tool: { name: "soe_tool", description: "soleOnExecute tool" },
    actions: {
      read_thing: {
        description: "read",
        paramsSchema: z.object({}),
        prereqs: [],
      },
      mutate_thing: {
        description: "mutate",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: {
          soleOnExecute: true,
          requiresConfirmation: { maxAttempts: 3 },
        },
      },
    },
  });
  const executors: ExecutorRegistry<SoeS, typeof soeSelectors> = {
    read_thing: async () => {
      calls.read++;
      return { resultBody: { summary: "read" }, ok: true };
    },
    mutate_thing: async (params) => {
      calls.mutate++;
      return {
        resultBody: {
          summary: "mutated",
          success: true,
          v: (params as { v: string }).v,
        },
        ok: true,
      };
    },
  };
  const verifiers: VerifierRegistry<SoeS> = {};
  return {
    opts: { config, stateSchema: soeAnnotation, selectors: soeSelectors, executors, verifiers },
    calls,
  };
}

test("f1: soleOnExecute permits propose at tail of multi-step batch", async () => {
  const { opts, calls } = makeSoeOpts();
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "read_thing", params: {} },
      { action: "mutate_thing", params: { v: "x" } },
    ],
    {} as SoeS,
  );
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, true);
  assert.equal(
    (body.results[1] as { needs_confirmation?: boolean }).needs_confirmation,
    true,
  );
  assert.equal(calls.read, 1);
  assert.equal(calls.mutate, 0, "propose does NOT call the executor");
  assert.equal(committed.awaitingInput?.kind, "confirmation");
});

test("f1: soleOnExecute refuses mutation not at tail (mutation_must_be_last_in_batch)", async () => {
  const { opts, calls } = makeSoeOpts();
  const { body } = await runSteps(
    opts,
    [
      { action: "mutate_thing", params: { v: "x" } },
      { action: "read_thing", params: {} },
    ],
    {} as SoeS,
  );
  assert.equal(body.failed_at, 0);
  assert.equal(body.results[0].error, "mutation_must_be_last_in_batch");
  assert.equal(calls.read, 0);
  assert.equal(calls.mutate, 0);
});

test("f1: soleOnExecute in execute mode (pending matches) must be alone", async () => {
  const { opts, calls } = makeSoeOpts();
  const seeded: SoeS = {
    awaitingInput: {
      kind: "confirmation",
      for_action: "mutate_thing",
      params: { v: "x" },
      attempts_left: 3,
      max_attempts: 3,
    },
  };
  // execute-mode batch with anything trailing → refused with sole-step error.
  const { body } = await runSteps(
    opts,
    [
      { action: "mutate_thing", params: { v: "x" } },
      { action: "read_thing", params: {} },
    ],
    seeded,
  );
  assert.equal(body.results[0].error, "mutation_must_be_sole_step");
  assert.equal(calls.mutate, 0, "execute aborted; mutation not invoked");
});

test("f1: soleOnExecute in execute mode alone → executes and clears pending", async () => {
  const { opts, calls } = makeSoeOpts();
  const seeded: SoeS = {
    awaitingInput: {
      kind: "confirmation",
      for_action: "mutate_thing",
      params: { v: "x" },
      attempts_left: 3,
      max_attempts: 3,
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "mutate_thing", params: { v: "x" } }],
    seeded,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(calls.mutate, 1);
  assert.equal(committed.awaitingInput ?? null, null);
});

test("f1: soleOnExecute solo propose still works (single-step batch)", async () => {
  const { opts, calls } = makeSoeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "mutate_thing", params: { v: "x" } }],
    {} as SoeS,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(
    (body.results[0] as { needs_confirmation?: boolean }).needs_confirmation,
    true,
  );
  assert.equal(calls.mutate, 0);
  assert.equal(committed.awaitingInput?.kind, "confirmation");
});

// ─── requiresMatch / startsMatchFor double-entry pattern ─────────────────── //

interface MatchS {
  customer?: { code: string } | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
}

const matchAnnotation = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  customer: Annotation<MatchS["customer"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  awaitingInput: Annotation<MatchS["awaitingInput"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  currentFlow: Annotation<MatchS["currentFlow"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
});

interface MatchCalls {
  open: number;
  capture: number;
  commit: number;
  issue: number;
}

interface MatchMockOpts {
  /** Stub returned by the commit step. Defaults to a "match" outcome when
   *  params.v === captured.v in the flow data; "mismatch" otherwise. */
  forceCommit?: "match" | "mismatch" | "backend_failed";
}

const matchSelectors = {
  open_flow: (s: MatchS) => s,
  capture_value: (s: MatchS) => s,
  commit_value: (s: MatchS) => s,
  issue_otp: (s: MatchS) => s,
};

function makeMatchOpts(mock: MatchMockOpts = {}): {
  opts: BuildAgentStepToolOptions<MatchS, string, string, typeof matchSelectors>;
  calls: MatchCalls;
} {
  const calls: MatchCalls = { open: 0, capture: 0, commit: 0, issue: 0 };
  const config = defineConfig<"open_flow" | "capture_value" | "commit_value" | "issue_otp", never>({
    tool: { name: "match_tool", description: "match-pattern test tool" },
    actions: {
      open_flow: {
        description: "open the flow",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: { startsFlow: { name: "myflow" } },
      },
      capture_value: {
        description: "capture the first entry",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: {
          requiresFlow: "myflow",
          startsMatchFor: { consumer_action: "commit_value" },
        },
      },
      commit_value: {
        description: "verify match + commit",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: {
          requiresFlow: "myflow",
          requiresMatch: { capturer: "capture_value", maxAttempts: 3 },
          endsFlow: true,
        },
      },
      issue_otp: {
        description: "issue an OTP for the flow",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: {
          requiresFlow: "myflow",
          issuesOtp: { consumer_action: "commit_value" },
        },
      },
    },
  });
  const executors: ExecutorRegistry<MatchS, typeof matchSelectors> = {
    open_flow: async () => {
      calls.open++;
      return { resultBody: { summary: "flow opened" }, ok: true };
    },
    capture_value: async (params) => {
      calls.capture++;
      const v = (params as { v: string }).v;
      // store the captured value in flow data — the consumer will compare
      return {
        resultBody: { summary: "captured" },
        effects: [{ type: "merge_flow_data", data: { captured: v } }],
        ok: true,
      };
    },
    commit_value: async (params, state) => {
      calls.commit++;
      const v = (params as { v: string }).v;
      const stored = (state.currentFlow?.data as { captured?: string } | undefined)
        ?.captured;
      const outcome = mock.forceCommit ?? (v === stored ? "match" : "mismatch");
      if (outcome === "mismatch") {
        return {
          resultBody: {
            summary: "did not match",
            verdict: "match_mismatch",
          },
          ok: false,
        };
      }
      if (outcome === "backend_failed") {
        return {
          resultBody: { summary: "backend refused", error: "backend_failed" },
          effects: [{ type: "abort_flow" }],
          ok: false,
        };
      }
      return {
        resultBody: { summary: "committed", success: true },
        ok: true,
      };
    },
    issue_otp: async () => {
      calls.issue++;
      return {
        resultBody: { summary: "otp issued", otp_sent: true },
        effects: [
          { type: "merge_flow_data", data: { challengeId: "ch-1" } },
          { type: "otp_issued" },
        ],
        ok: true,
      };
    },
  };
  return {
    opts: {
      config,
      stateSchema: matchAnnotation,
      selectors: matchSelectors,
      executors,
      verifiers: {},
    },
    calls,
  };
}

/** Thread state across runSteps calls — committed contains only the patches
 *  from the latest batch, so we layer it onto the previous state. Replicates
 *  what LangGraph would do between turns. */
function threadMatch(prev: MatchS, committed: Partial<MatchS>): MatchS {
  const next: MatchS = { ...prev };
  for (const [k, v] of Object.entries(committed)) {
    (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

async function seedFlowAndCapture(): Promise<{
  opts: BuildAgentStepToolOptions<MatchS, string, string, typeof matchSelectors>;
  calls: MatchCalls;
  state: MatchS;
}> {
  const { opts, calls } = makeMatchOpts();
  const r1 = await runSteps(opts, [{ action: "open_flow", params: {} }], {} as MatchS);
  const s1 = threadMatch({} as MatchS, r1.committed as Partial<MatchS>);
  const r2 = await runSteps(
    opts,
    [{ action: "capture_value", params: { v: "secret" } }],
    s1,
  );
  return { opts, calls, state: threadMatch(s1, r2.committed as Partial<MatchS>) };
}

test("requiresMatch: capturer sets awaitingInput=match with attempts_left=maxAttempts", async () => {
  const { state } = await seedFlowAndCapture();
  assert.equal(state.awaitingInput?.kind, "match");
  if (state.awaitingInput?.kind === "match") {
    assert.equal(state.awaitingInput.for_action, "commit_value");
    assert.equal(state.awaitingInput.attempts_left, 3);
    assert.equal(state.awaitingInput.max_attempts, 3);
    assert.equal(state.awaitingInput.flow_ref, "myflow");
  }
});

test("requiresMatch: consumer match → ok:true, awaitingInput cleared, flow ended", async () => {
  const { opts, calls, state } = await seedFlowAndCapture();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "commit_value", params: { v: "secret" } }],
    state,
  );
  assert.equal(calls.commit, 1);
  assert.equal(body.results[0].ok, true);
  assert.equal(committed.awaitingInput ?? null, null);
  assert.equal(committed.currentFlow ?? null, null, "endsFlow closed the flow");
});

test("requiresMatch: consumer mismatch → ok:false + verdict + attempts_left=2", async () => {
  const { opts, state } = await seedFlowAndCapture();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "commit_value", params: { v: "wrong" } }],
    state,
  );
  const next = threadMatch(state, committed as Partial<MatchS>);
  assert.equal(body.results[0].ok, false);
  assert.equal((body.results[0] as { verdict?: string }).verdict, "match_mismatch");
  assert.equal((body.results[0] as { attempts_left?: number }).attempts_left, 2);
  assert.equal(next.awaitingInput?.kind, "match");
  if (next.awaitingInput?.kind === "match") {
    assert.equal(next.awaitingInput.attempts_left, 2);
  }
  assert.ok(next.currentFlow, "flow stays alive on mismatch within budget");
});

test("requiresMatch: consumer mismatch exhaustion → abort flow + clear awaiting", async () => {
  let s = (await seedFlowAndCapture()).state;
  const { opts } = await seedFlowAndCapture();
  // first mismatch
  let r = await runSteps(opts, [{ action: "commit_value", params: { v: "w1" } }], s);
  s = threadMatch(s, r.committed as Partial<MatchS>);
  assert.equal(
    (r.body.results[0] as { attempts_left?: number }).attempts_left,
    2,
  );
  // second mismatch
  r = await runSteps(opts, [{ action: "commit_value", params: { v: "w2" } }], s);
  s = threadMatch(s, r.committed as Partial<MatchS>);
  assert.equal(
    (r.body.results[0] as { attempts_left?: number }).attempts_left,
    1,
  );
  // third mismatch — exhausted
  r = await runSteps(opts, [{ action: "commit_value", params: { v: "w3" } }], s);
  s = threadMatch(s, r.committed as Partial<MatchS>);
  assert.equal(r.body.results[0].ok, false);
  assert.equal(
    (r.body.results[0] as { verdict?: string }).verdict,
    "match_attempts_exhausted",
  );
  assert.equal(
    (r.body.results[0] as { attempts_left?: number }).attempts_left,
    0,
  );
  assert.equal(s.awaitingInput ?? null, null);
  assert.equal(s.currentFlow ?? null, null, "flow aborted on exhaustion");
});

test("requiresMatch: re-capture while match-awaiting resets attempts and replaces token", async () => {
  const { opts, state } = await seedFlowAndCapture();
  // burn one attempt
  const r1 = await runSteps(
    opts,
    [{ action: "commit_value", params: { v: "wrong" } }],
    state,
  );
  let s = threadMatch(state, r1.committed as Partial<MatchS>);
  assert.equal(
    (s.awaitingInput as { attempts_left?: number } | null)?.attempts_left,
    2,
  );
  // customer changes their first entry — re-capture
  const r2 = await runSteps(
    opts,
    [{ action: "capture_value", params: { v: "new_secret" } }],
    s,
  );
  s = threadMatch(s, r2.committed as Partial<MatchS>);
  // attempts reset to 3, stored token replaced
  assert.equal(
    (s.awaitingInput as { attempts_left?: number; max_attempts?: number } | null)
      ?.attempts_left,
    3,
  );
  assert.equal(
    (s.currentFlow?.data as { captured?: string } | undefined)?.captured,
    "new_secret",
  );
  // matching against the NEW secret now works
  const r3 = await runSteps(
    opts,
    [{ action: "commit_value", params: { v: "new_secret" } }],
    s,
  );
  assert.equal(r3.body.results[0].ok, true);
  assert.equal(r3.committed.awaitingInput ?? null, null);
});

test("requiresMatch: lockdown refuses unrelated actions while awaiting", async () => {
  const { opts, state } = await seedFlowAndCapture();
  // try to call open_flow (or anything other than the consumer / capturer / abort)
  const { body } = await runSteps(
    opts,
    [{ action: "open_flow", params: {} }],
    state,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "match_pending_locked");
});

test("requiresMatch: consumer without match-awaiting refuses with match_not_pending", async () => {
  const { opts } = makeMatchOpts();
  // open the flow but DON'T capture — awaitingInput stays null
  const r1 = await runSteps(opts, [{ action: "open_flow", params: {} }], {} as MatchS);
  const { body } = await runSteps(
    opts,
    [{ action: "commit_value", params: { v: "x" } }],
    r1.committed as MatchS,
  );
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error, "match_not_pending");
});

test("requiresMatch: abort_pending_input clears match-awaiting + flow", async () => {
  const { opts, state } = await seedFlowAndCapture();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "abort_pending_input", params: {} }],
    state,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(committed.awaitingInput ?? null, null);
  assert.equal(committed.currentFlow ?? null, null);
});

// ─── Same-batch double-entry & OTP-ordering guards ──────────────────────── //

test("requiresMatch: capturer + consumer in ONE batch is refused (double-entry must span turns)", async () => {
  const { opts, calls } = makeMatchOpts();
  // Flow opened in a prior turn; then a single batch tries to BOTH capture the
  // first entry AND consume the match. The match gate is opened in-batch, so it
  // is absent at BATCH START — the consumer must be refused (frozen check).
  const r1 = await runSteps(opts, [{ action: "open_flow", params: {} }], {} as MatchS);
  const { body } = await runSteps(
    opts,
    [
      { action: "capture_value", params: { v: "secret" } },
      { action: "commit_value", params: { v: "secret" } },
    ],
    r1.committed as MatchS,
  );
  assert.equal(body.results[0].ok, true, "capture ran");
  assert.equal(body.results[1].ok, false, "consumer refused in same batch");
  assert.equal(body.results[1].error, "match_not_pending");
  assert.equal(body.failed_at, 1);
  assert.equal(calls.commit, 0, "commit executor never ran");
});

test("issuesOtp: refused while a match gate is still pending (otp_blocked_match_pending)", async () => {
  const { opts, calls } = makeMatchOpts();
  // Flow opened in a prior turn; then [capture_value, issue_otp] in one batch.
  // capture_value opens the match gate (live); issue_otp must NOT open an OTP
  // gate while the match is unconsumed — the issuer's side effect must not fire.
  const r1 = await runSteps(opts, [{ action: "open_flow", params: {} }], {} as MatchS);
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "capture_value", params: { v: "secret" } },
      { action: "issue_otp", params: {} },
    ],
    r1.committed as MatchS,
  );
  assert.equal(body.results[0].ok, true, "capture ran, match gate opened");
  assert.equal(body.results[1].ok, false, "OTP issuance refused");
  assert.equal(body.results[1].error, "otp_blocked_match_pending");
  assert.equal(body.failed_at, 1);
  assert.equal(calls.issue, 0, "issuer executor never ran");
  // The match gate the capturer opened survives — the consumer can still run next turn.
  assert.equal(committed.awaitingInput?.kind, "match", "match gate intact");
  assert.equal(committed.awaitingInput?.for_action, "commit_value");
});

test("issuesOtp: allowed when no match is pending (guard is not over-broad)", async () => {
  // Positive control: flow open, no match pending → the issuer runs and the OTP
  // gate opens. Proves guard #1 fires ONLY on a pending match.
  const { opts, calls } = makeMatchOpts();
  const r1 = await runSteps(opts, [{ action: "open_flow", params: {} }], {} as MatchS);
  const { body, committed } = await runSteps(
    opts,
    [{ action: "issue_otp", params: {} }],
    r1.committed as MatchS,
  );
  assert.equal(body.results[0].ok, true, "OTP issued");
  assert.equal(calls.issue, 1, "issuer executor ran");
  assert.equal(committed.awaitingInput?.kind, "otp", "OTP gate opened");
  assert.equal(committed.awaitingInput?.for_action, "commit_value");
});

// ─── invalidatesOnChange ────────────────────────────────────────────────── //

interface InvalidateS {
  pan?: string | null;
  amount?: number | null;
  amountCollected?: boolean | null;
  matchedTx?: string | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
}

const invalidateStateAnnotation = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  pan: Annotation<string | null>({ reducer: (_, n) => n, default: () => null }),
  amount: Annotation<number | null>({ reducer: (_, n) => n, default: () => null }),
  amountCollected: Annotation<boolean | null>({
    reducer: (_, n) => n,
    default: () => null,
  }),
  matchedTx: Annotation<string | null>({ reducer: (_, n) => n, default: () => null }),
  awaitingInput: Annotation<AwaitingInput | null>({
    reducer: (_, n) => n,
    default: () => null,
  }),
  currentFlow: Annotation<CurrentFlow | null>({
    reducer: (_, n) => n,
    default: () => null,
  }),
});

type InvActionName = "set_card" | "set_amount";

const invSelectors = {
  set_card: (s: InvalidateS) => s,
  set_amount: (s: InvalidateS) => s,
};

function makeInvalidateOpts(): BuildAgentStepToolOptions<
  InvalidateS,
  InvActionName,
  never,
  typeof invSelectors
> {
  return {
    config: defineConfig<InvActionName, never>({
      tool: { name: "test_tool", description: "test tool" },
      actions: {
        set_card: {
          description: "set the card; changes here clear amount slots",
          paramsSchema: z.object({ pan: z.string() }),
          prereqs: [],
          invalidatesOnChange: {
            pan: ["amount", "amountCollected", "matchedTx"],
          },
        },
        set_amount: {
          description: "set the amount",
          paramsSchema: z.object({ amount: z.number() }),
          prereqs: [],
        },
      },
    }),
    stateSchema: invalidateStateAnnotation,
    selectors: invSelectors,
    executors: {
      set_card: async (params) => ({
        resultBody: { summary: "card set", verdict: "ok" },
        stateUpdate: { pan: (params as { pan: string }).pan },
        ok: true,
      }),
      set_amount: async (params) => ({
        resultBody: { summary: "amount set", verdict: "ok" },
        stateUpdate: {
          amount: (params as { amount: number }).amount,
          amountCollected: true,
          matchedTx: "TX-" + (params as { amount: number }).amount,
        },
        ok: true,
      }),
    },
    verifiers: {},
  };
}

test("invalidatesOnChange: changing watched slot clears declared downstream slots", async () => {
  const opts = makeInvalidateOpts();
  const seeded: InvalidateS = {
    pan: "P1",
    amount: 5,
    amountCollected: true,
    matchedTx: "TX-5",
  };
  const { committed } = await runSteps(
    opts,
    [{ action: "set_card", params: { pan: "P2" } }],
    seeded,
  );
  assert.equal(committed.pan, "P2");
  assert.equal(committed.amount, null);
  assert.equal(committed.amountCollected, null);
  assert.equal(committed.matchedTx, null);
});

test("invalidatesOnChange: first-time set (null → value) does NOT clear downstream", async () => {
  const opts = makeInvalidateOpts();
  const { committed } = await runSteps(
    opts,
    [
      { action: "set_amount", params: { amount: 7 } },
      { action: "set_card", params: { pan: "P1" } },
    ],
    {},
  );
  assert.equal(committed.pan, "P1");
  // amount/amountCollected/matchedTx must survive because pan went from null → P1
  assert.equal(committed.amount, 7);
  assert.equal(committed.amountCollected, true);
  assert.equal(committed.matchedTx, "TX-7");
});

test("invalidatesOnChange: same-value re-write does NOT clear downstream", async () => {
  const opts = makeInvalidateOpts();
  const seeded: InvalidateS = {
    pan: "P1",
    amount: 5,
    amountCollected: true,
    matchedTx: "TX-5",
  };
  const { committed } = await runSteps(
    opts,
    [{ action: "set_card", params: { pan: "P1" } }],
    seeded,
  );
  assert.equal(committed.amount, undefined, "amount must not appear in committed patch");
  assert.equal(committed.amountCollected, undefined);
  assert.equal(committed.matchedTx, undefined);
});

test("invalidatesOnChange: downstream slots set later in same batch are NOT cleared", async () => {
  // The cascade fires immediately after each step's stateUpdate. A subsequent
  // step in the same batch that writes to a previously-invalidated slot must
  // see the write land — the invalidation belongs to the upstream step alone.
  const opts = makeInvalidateOpts();
  const seeded: InvalidateS = {
    pan: "P1",
    amount: 5,
    amountCollected: true,
    matchedTx: "TX-5",
  };
  const { committed } = await runSteps(
    opts,
    [
      { action: "set_card", params: { pan: "P2" } },
      { action: "set_amount", params: { amount: 9 } },
    ],
    seeded,
  );
  assert.equal(committed.pan, "P2");
  assert.equal(committed.amount, 9);
  assert.equal(committed.amountCollected, true);
  assert.equal(committed.matchedTx, "TX-9");
});

test("invalidatesOnChange: executor's own writes to downstream slots win over the cascade", async () => {
  // When the executor's stateUpdate writes BOTH a changed watched slot AND a
  // downstream slot (e.g. collect_amount changes amount AND writes a new
  // match), the executor's downstream write must be visible — the cascade
  // applies BEFORE stateUpdate so executor writes overwrite the null clears.
  interface SelfS {
    amount?: number | null;
    matchedTx?: string | null;
    awaitingInput?: AwaitingInput | null;
    currentFlow?: CurrentFlow | null;
  }
  const annotation = Annotation.Root({
    actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
    amount: Annotation<number | null>({ reducer: (_, n) => n, default: () => null }),
    matchedTx: Annotation<string | null>({ reducer: (_, n) => n, default: () => null }),
    awaitingInput: Annotation<AwaitingInput | null>({
      reducer: (_, n) => n,
      default: () => null,
    }),
    currentFlow: Annotation<CurrentFlow | null>({
      reducer: (_, n) => n,
      default: () => null,
    }),
  });
  const selfSelectors = { set_amount: (s: SelfS) => s };
  const opts: BuildAgentStepToolOptions<SelfS, "set_amount", never, typeof selfSelectors> = {
    config: defineConfig<"set_amount", never>({
      tool: { name: "test_tool", description: "test tool" },
      actions: {
        set_amount: {
          description: "set amount + rewrite match",
          paramsSchema: z.object({ amount: z.number(), tx: z.string() }),
          prereqs: [],
          invalidatesOnChange: {
            amount: ["matchedTx"],
          },
        },
      },
    }),
    stateSchema: annotation,
    selectors: selfSelectors,
    executors: {
      set_amount: async (params) => {
        const p = params as { amount: number; tx: string };
        return {
          resultBody: { summary: "ok", verdict: "ok" },
          stateUpdate: { amount: p.amount, matchedTx: p.tx },
          ok: true,
        };
      },
    },
    verifiers: {},
  };
  const seeded: SelfS = { amount: 5, matchedTx: "TX-5" };
  const { committed } = await runSteps(
    opts,
    [{ action: "set_amount", params: { amount: 9, tx: "TX-9" } }],
    seeded,
  );
  assert.equal(committed.amount, 9);
  assert.equal(
    committed.matchedTx,
    "TX-9",
    "executor's downstream write must win over the cascade null",
  );
});

test("composed tool description indexes actions by summary, not full description", () => {
  const { opts } = makeOpts();
  const SENTINEL = "FULL_MECHANICS_TEXT_THAT_MUST_NOT_BE_DUPLICATED_IN_THE_BLOB";
  const cfg = defineConfig<ActionName, PrereqName>({
    tool: { name: "test_tool", description: "lead paragraph" },
    actions: {
      verify_customer: {
        summary: "one-line summary",
        description: `verify the customer — ${SENTINEL}`,
        paramsSchema: z.object({ code: z.string() }),
        prereqs: [],
      },
      verify_card: {
        description: "verify the card",
        paramsSchema: z.object({ pan: z.string() }),
        prereqs: ["customerVerified"],
      },
      fetch_card_status: {
        description: "read card status",
        paramsSchema: z.object({}),
        prereqs: ["cardVerified"],
      },
      change_status: {
        description: "change card status",
        paramsSchema: z.object({ newStatus: z.string() }),
        prereqs: ["cardVerified"],
        controller: { soleStep: true },
      },
    },
  });
  const t = buildAgentStepTool({ ...opts, config: cfg });
  const desc = t.description;
  // The composed tool description carries the lead + a per-action index using
  // `summary` (or the bare name) — never the full `description`.
  assert.match(desc, /one-line summary/, "summary should appear in the action index");
  assert.ok(
    !desc.includes(SENTINEL),
    "full action description must NOT be duplicated in the composed tool description",
  );
  assert.match(desc, /- `verify_card`/, "an action without a summary is listed by name");
});

// ─── Auto-handoff on repeated backend failures ──────────────────────────── //

interface AHState {
  errorCount?: number | null;
  handoff?: HandoffRequest | null;
}

const ahAnnotation = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  errorCount: Annotation<number | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  handoff: Annotation<HandoffRequest | null>({ reducer: (_, n) => n ?? null, default: () => null }),
});

const ahSelectors = { call_backend: (s: AHState) => s };

/** One action whose executor fails controllably:
 *  - mode "throw"   → throws → the runner records `executor_error`
 *  - mode "verdict" → returns ok:false with `error: code`
 *  - mode "ok"      → succeeds */
function makeAhOpts(
  extra: Partial<
    BuildAgentStepToolOptions<AHState, "call_backend", never, typeof ahSelectors>
  > = {},
): BuildAgentStepToolOptions<AHState, "call_backend", never, typeof ahSelectors> {
  const config = defineConfig<"call_backend", never>({
    tool: { name: "ah_tool", description: "auto-handoff test tool" },
    actions: {
      call_backend: {
        description: "call a backend that may fail",
        paramsSchema: z.object({ mode: z.string(), code: z.string().optional() }),
        prereqs: [],
      },
    },
  });
  const executors: ExecutorRegistry<AHState, typeof ahSelectors> = {
    call_backend: async (raw) => {
      const p = raw as { mode: string; code?: string };
      if (p.mode === "throw") throw new Error("backend exploded");
      if (p.mode === "verdict") return { resultBody: { summary: "failed", error: p.code }, ok: false };
      return { resultBody: { summary: "ok" }, ok: true };
    },
  };
  return {
    config,
    stateSchema: ahAnnotation,
    selectors: ahSelectors,
    executors,
    verifiers: {} as VerifierRegistry<AHState>,
    ...extra,
  };
}

test("auto-handoff: 3 consecutive executor_error batches hit the threshold and escalate", async () => {
  let fired = 0;
  const opts = makeAhOpts({
    onErrorThreshold: (update) => {
      fired++;
      (update as Record<string, unknown>).customHandoff = true;
    },
  });
  let state: AHState = {};
  let res = await runSteps(opts, [{ action: "call_backend", params: { mode: "throw" } }], state);
  state = { ...state, ...res.committed };
  assert.equal(state.errorCount, 1, "first failure increments");
  res = await runSteps(opts, [{ action: "call_backend", params: { mode: "throw" } }], state);
  state = { ...state, ...res.committed };
  assert.equal(state.errorCount, 2, "second failure increments");
  res = await runSteps(opts, [{ action: "call_backend", params: { mode: "throw" } }], state);
  state = { ...state, ...res.committed };
  assert.equal(fired, 1, "callback fires exactly once, at the threshold");
  assert.equal(state.errorCount, 0, "counter resets after escalation");
  const synthetic = res.body.results[res.body.results.length - 1];
  assert.equal(synthetic.action, "auto_handoff");
  assert.equal(synthetic.isHandoff, true);
  assert.equal(synthetic.successMessage, DEFAULT_SYSTEM_MESSAGES.auto_handoff);
  assert.equal(res.body.failed_at, undefined, "failure cleared once escalated");
});

test("auto-handoff: a host-declared backendFailureCode counts toward the threshold", async () => {
  let fired = 0;
  const opts = makeAhOpts({
    backendFailureCodes: ["service_error"],
    errorHandoffThreshold: 2,
    onErrorThreshold: () => {
      fired++;
    },
  });
  let state: AHState = {};
  let res = await runSteps(
    opts,
    [{ action: "call_backend", params: { mode: "verdict", code: "service_error" } }],
    state,
  );
  state = { ...state, ...res.committed };
  assert.equal(state.errorCount, 1, "a listed verdict increments");
  res = await runSteps(
    opts,
    [{ action: "call_backend", params: { mode: "verdict", code: "service_error" } }],
    state,
  );
  state = { ...state, ...res.committed };
  assert.equal(fired, 1, "custom threshold (2) reached → escalate");
  assert.equal(state.errorCount, 0);
});

test("auto-handoff: an unlisted verdict (recoverable user error) never escalates", async () => {
  let fired = 0;
  const opts = makeAhOpts({ errorHandoffThreshold: 2, onErrorThreshold: () => { fired++; } });
  let state: AHState = {};
  for (let i = 0; i < 3; i++) {
    const res = await runSteps(
      opts,
      [{ action: "call_backend", params: { mode: "verdict", code: "user_mistake" } }],
      state,
    );
    state = { ...state, ...res.committed };
  }
  assert.equal(fired, 0, "recoverable failures never trigger auto-handoff");
  assert.ok(!state.errorCount, "counter not incremented by recoverable failures");
});

test("auto-handoff: a successful batch resets the error counter", async () => {
  const opts = makeAhOpts({ onErrorThreshold: () => {} });
  let state: AHState = {};
  let res = await runSteps(opts, [{ action: "call_backend", params: { mode: "throw" } }], state);
  state = { ...state, ...res.committed };
  assert.equal(state.errorCount, 1);
  res = await runSteps(opts, [{ action: "call_backend", params: { mode: "ok" } }], state);
  state = { ...state, ...res.committed };
  assert.equal(state.errorCount, 0, "success resets the counter");
});

test("auto-handoff: inert when neither handoff nor onErrorThreshold is configured", async () => {
  const opts = makeAhOpts({});
  let state: AHState = {};
  for (let i = 0; i < 4; i++) {
    const res = await runSteps(opts, [{ action: "call_backend", params: { mode: "throw" } }], state);
    state = { ...state, ...res.committed };
    assert.equal(res.body.failed_at, 0, "failure stands; no synthetic handoff");
  }
  assert.equal(state.errorCount ?? null, null, "counter untouched without a mechanism");
});

test("auto-handoff: writes the library `handoff` slot at threshold when handoff is enabled", async () => {
  const opts = makeAhOpts({
    handoff: { offTopic: { mode: "terminate" }, terminateMessage: "bye" },
    errorHandoffThreshold: 1,
  });
  const res = await runSteps(opts, [{ action: "call_backend", params: { mode: "throw" } }], {});
  const committed = res.committed as AHState;
  assert.equal(committed.handoff?.reason, "abandon");
  assert.equal(committed.handoff?.context, DEFAULT_SYSTEM_MESSAGES.auto_handoff);
  const synthetic = res.body.results[res.body.results.length - 1];
  assert.equal(synthetic.isHandoff, true);
});

test("auto-handoff: instruction says the platform delivers the closing (no speak-this)", async () => {
  // The synthetic result must not tell the model to voice the closing — hosts
  // that resolve the handoff in the graph would double-speak. Hosts whose
  // graph does NOT deliver it can opt back in via the {message} placeholder.
  const opts = makeAhOpts({ errorHandoffThreshold: 1, onErrorThreshold: () => {} });
  const res = await runSteps(opts, [{ action: "call_backend", params: { mode: "throw" } }], {});
  const synthetic = res.body.results[res.body.results.length - 1];
  assert.equal(synthetic.action, "auto_handoff");
  assert.equal(synthetic.summary, DEFAULT_SYSTEM_MESSAGES.auto_handoff_instruction);
  assert.doesNotMatch(synthetic.summary as string, /Speak this exact message/);

  const spoken = makeAhOpts({
    errorHandoffThreshold: 1,
    onErrorThreshold: () => {},
    messages: { auto_handoff_instruction: "SAY: {message}" },
  });
  const res2 = await runSteps(spoken, [{ action: "call_backend", params: { mode: "throw" } }], {});
  const synthetic2 = res2.body.results[res2.body.results.length - 1];
  assert.equal(synthetic2.summary, `SAY: ${DEFAULT_SYSTEM_MESSAGES.auto_handoff}`);
});

// ─── Error counter neutrality: no-executor batches neither increment nor reset ─ //
//
// A confirm-gated action retried during a backend outage necessarily
// interleaves a proposal between every two failing executes (the failed
// execute consumed the pending confirmation). Were the proposal — a
// successful batch in which NO executor ran — allowed to reset the counter,
// the streak would oscillate 1 → 0 → 1 → 0 … and the auto-handoff threshold
// would be unreachable for every gated action.

interface GatedAHState {
  errorCount?: number | null;
  handoff?: HandoffRequest | null;
  awaitingInput?: AwaitingInput | null;
}

const gatedAhAnnotation = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  errorCount: Annotation<number | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  handoff: Annotation<HandoffRequest | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  awaitingInput: Annotation<AwaitingInput | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
});

const gatedAhSelectors = { call_backend: (s: GatedAHState) => s };

/** The auto-handoff action, confirm-gated: the first call with given params
 *  proposes (no executor runs), the same-params re-call executes. */
function makeGatedAhOpts(
  extra: Partial<
    BuildAgentStepToolOptions<GatedAHState, "call_backend", never, typeof gatedAhSelectors>
  > = {},
): BuildAgentStepToolOptions<GatedAHState, "call_backend", never, typeof gatedAhSelectors> {
  const config = defineConfig<"call_backend", never>({
    tool: { name: "gated_ah_tool", description: "gated auto-handoff test tool" },
    actions: {
      call_backend: {
        description: "confirm-gated call to a backend that may fail",
        paramsSchema: z.object({ mode: z.string(), code: z.string().optional() }),
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 } },
      },
    },
  });
  const executors: ExecutorRegistry<GatedAHState, typeof gatedAhSelectors> = {
    call_backend: async (raw) => {
      const p = raw as { mode: string; code?: string };
      if (p.mode === "verdict")
        return { resultBody: { summary: "failed", error: p.code }, ok: false };
      return { resultBody: { summary: "ok" }, ok: true };
    },
  };
  return {
    config,
    stateSchema: gatedAhAnnotation,
    selectors: gatedAhSelectors,
    executors,
    verifiers: {} as VerifierRegistry<GatedAHState>,
    backendFailureCodes: ["backend_down"],
    ...extra,
  };
}

test("error counter: confirm-gate proposals are NEUTRAL — the failure streak survives re-proposes", async () => {
  let fired = 0;
  const opts = makeGatedAhOpts({ onErrorThreshold: () => void fired++ });
  const FAIL = { mode: "verdict", code: "backend_down" };
  let state: GatedAHState = {};
  const turn = async () => {
    const res = await runSteps(opts, [{ action: "call_backend", params: FAIL }], state);
    state = { ...state, ...res.committed };
    return res;
  };

  // First call proposes — no executor ran, the counter is untouched.
  let res = await turn();
  assert.equal((res.body.results[0] as { needs_confirmation?: boolean }).needs_confirmation, true);
  assert.equal(state.errorCount ?? null, null, "a proposal never increments");
  // Same-params re-call executes → backend failure → 1.
  await turn();
  assert.equal(state.errorCount, 1);
  // The failed execute consumed the pending → the retry PROPOSES again.
  res = await turn();
  assert.equal((res.body.results[0] as { needs_confirmation?: boolean }).needs_confirmation, true);
  assert.equal(state.errorCount, 1, "a proposal must not wipe the failure streak");
  // Execute → 2; propose (neutral); execute → threshold.
  await turn();
  assert.equal(state.errorCount, 2);
  await turn();
  assert.equal(state.errorCount, 2, "still neutral on the second re-propose");
  res = await turn();
  assert.equal(fired, 1, "threshold reached across interleaved proposals");
  assert.equal(state.errorCount, 0, "reset after escalation");
  const synthetic = res.body.results[res.body.results.length - 1];
  assert.equal(synthetic.action, "auto_handoff");
});

test("error counter: an EXECUTED success resets the streak (its proposal alone does not)", async () => {
  const opts = makeGatedAhOpts({ onErrorThreshold: () => {} });
  const FAIL = { mode: "verdict", code: "backend_down" };
  const OK = { mode: "ok" };
  let state: GatedAHState = {};
  const turn = async (params: Record<string, unknown>) => {
    const res = await runSteps(opts, [{ action: "call_backend", params }], state);
    state = { ...state, ...res.committed };
    return res;
  };

  await turn(FAIL); // propose
  await turn(FAIL); // execute → fail
  assert.equal(state.errorCount, 1);
  // New params → fresh proposal: neutral even though the batch is ok.
  await turn(OK);
  assert.equal(state.errorCount, 1, "the OK proposal is still neutral");
  // The executed success is what proves the backend recovered.
  await turn(OK);
  assert.equal(state.errorCount, 0, "executed success resets the counter");
});

// ─── Templated system messages ──────────────────────────────────────────── //

test("system messages: templated summaries interpolate placeholders and honor overrides", async () => {
  // Propose summary ({action}).
  const proposed = makeConfirmOpts();
  const proposeRun = await runSteps(
    { ...proposed.opts, messages: { confirm_proposed: "PROPOSE<{action}>" } },
    [{ action: "change_status", params: { newStatus: "lost" } }],
    SEEDED,
  );
  assert.equal(proposeRun.body.results[0].summary, "PROPOSE<change_status>");

  // Lockdown summary ({action} + {abort_action}).
  const locked = makeConfirmOpts();
  const lockedSeed: S = {
    ...SEEDED,
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_status",
      params: { newStatus: "lost" },
      attempts_left: 3,
      max_attempts: 3,
    },
  };
  const lockedRun = await runSteps(
    { ...locked.opts, messages: { lockdown_confirmation: "LOCKED {action} via {abort_action}" } },
    [{ action: "fetch_card_status", params: {} }],
    lockedSeed,
  );
  assert.equal(lockedRun.body.results[0].summary, "LOCKED change_status via abort_pending_input");

  // Unknown placeholders stay verbatim (visible, never silently blanked).
  const exhausted = makeConfirmOpts();
  const exhaustedSeed: S = {
    ...SEEDED,
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_status",
      params: { newStatus: "lost" },
      attempts_left: 0,
      max_attempts: 3,
    },
  };
  const exhaustedRun = await runSteps(
    { ...exhausted.opts, messages: { confirm_exhausted: "EXHAUSTED {nope}" } },
    [{ action: "change_status", params: { newStatus: "stolen" } }],
    exhaustedSeed,
  );
  assert.equal(exhaustedRun.body.results[0].summary, "EXHAUSTED {nope}");
});

// ─── Confirmation gate: params normalization (parsed-vs-parsed compare) ──── //

interface NormS {
  digits?: string | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
}

const normAnnotation = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  digits: Annotation<string | null>({ reducer: (_, n) => n ?? null, default: () => null }),
  awaitingInput: Annotation<AwaitingInput | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  currentFlow: Annotation<CurrentFlow | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
});

const normSelectors = {
  set_digits: (s: NormS) => s,
  read_digits: (s: NormS) => s,
};

/** STT separator stripping, as a voice host's params schema would do. */
const stripNonDigits = (v: unknown): unknown =>
  typeof v === "string" ? v.replace(/\D/g, "") : v;

function makeNormOpts(): {
  opts: BuildAgentStepToolOptions<NormS, "set_digits" | "read_digits", never, typeof normSelectors>;
  calls: { set: number };
} {
  const calls = { set: 0 };
  return {
    opts: {
      config: defineConfig<"set_digits" | "read_digits", never>({
        tool: { name: "norm_tool", description: "normalization test tool" },
        actions: {
          set_digits: {
            description: "confirm-required digit write",
            paramsSchema: z.object({
              digits: z.preprocess(stripNonDigits, z.string().regex(/^\d+$/, "digits only")),
            }),
            prereqs: [],
            controller: { requiresConfirmation: { maxAttempts: 3 }, soleOnExecute: true },
          },
          read_digits: {
            description: "plain read",
            paramsSchema: z.object({}),
            prereqs: [],
          },
        },
      }),
      stateSchema: normAnnotation,
      selectors: normSelectors,
      executors: {
        set_digits: async (params) => {
          calls.set++;
          return {
            resultBody: { summary: "digits set" },
            stateUpdate: { digits: (params as { digits: string }).digits },
            ok: true,
          };
        },
        read_digits: async () => ({ resultBody: { summary: "read" }, ok: true }),
      },
      verifiers: {},
    },
    calls,
  };
}

const NORM_PENDING: NormS = {
  awaitingInput: {
    kind: "confirmation",
    for_action: "set_digits",
    params: { digits: "7076" },
    attempts_left: 3,
    max_attempts: 3,
  },
};

test("confirm gate: propose stores PARSED params (schema preprocess applied)", async () => {
  const { opts, calls } = makeNormOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "set_digits", params: { digits: "70,76" } }],
    {},
  );
  assert.equal(calls.set, 0);
  const awaiting = (committed as { awaitingInput?: AwaitingInput }).awaitingInput;
  assert.ok(awaiting && awaiting.kind === "confirmation");
  if (awaiting && awaiting.kind === "confirmation") {
    assert.deepEqual(awaiting.params, { digits: "7076" });
  }
  assert.deepEqual(body.results[0].proposed_params, { digits: "7076" });
});

test("confirm gate: separator-artifact re-call still EXECUTES (raw parsed before compare)", async () => {
  // The caller confirmed "7076"; the model re-emits with an STT artifact.
  // Value normalization must never read as drift — this is what makes the
  // gate usable on digit-string params at all.
  const { opts, calls } = makeNormOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "set_digits", params: { digits: "70 76" } }],
    NORM_PENDING,
  );
  assert.equal(calls.set, 1, "executor ran — normalized params match the stored proposal");
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].needs_confirmation, undefined);
  assert.equal(
    (committed as { awaitingInput?: AwaitingInput | null }).awaitingInput,
    null,
  );
  assert.equal((committed as { digits?: string }).digits, "7076");
});

test("confirm gate: genuine value drift still re-proposes", async () => {
  const { opts, calls } = makeNormOpts();
  const { body } = await runSteps(
    opts,
    [{ action: "set_digits", params: { digits: "70,77" } }],
    NORM_PENDING,
  );
  assert.equal(calls.set, 0);
  assert.equal(body.results[0].needs_confirmation, true);
  assert.equal(body.results[0].attempts_left, 2);
});

test("confirm gate: invalid params on propose → voice-safe summary, detail in _debug", async () => {
  const { opts, calls } = makeNormOpts();
  const { body } = await runSteps(
    opts,
    [{ action: "set_digits", params: { digits: "abc" } }],
    {},
  );
  assert.equal(calls.set, 0);
  assert.equal(body.results[0].error, "invalid_params");
  assert.equal(body.results[0].summary, DEFAULT_SYSTEM_MESSAGES.invalid_params);
  assert.match(body.results[0]._debug as string, /Invalid params for "set_digits"/);
});

test("confirm gate: soleOnExecute execute-prediction normalizes raw params too", async () => {
  const { opts, calls } = makeNormOpts();
  const { body } = await runSteps(
    opts,
    [
      { action: "set_digits", params: { digits: "70,76" } },
      { action: "read_digits", params: {} },
    ],
    NORM_PENDING,
  );
  assert.equal(calls.set, 0, "refused before execution");
  assert.equal(body.failed_at, 0);
  assert.equal(body.results[0].error, "mutation_must_be_sole_step");
});

// ─── invalidatesOnChange: value equality on object slots ───────────────────── //

test("invalidatesOnChange: fresh-but-value-equal OBJECT re-write does NOT clear downstream", async () => {
  // Executors write fresh objects each run. Reference identity (Object.is)
  // would read a same-value re-write as a change and spuriously cascade.
  interface ObjS {
    holder?: { code: string } | null;
    derived?: string | null;
    awaitingInput?: AwaitingInput | null;
    currentFlow?: CurrentFlow | null;
  }
  const annotation = Annotation.Root({
    actionTrail: Annotation<TrailEntry[] | null>({ reducer: (_, n) => n ?? null, default: () => null }),
    holder: Annotation<{ code: string } | null>({
      reducer: (_, n) => n ?? null,
      default: () => null,
    }),
    derived: Annotation<string | null>({ reducer: (_, n) => n, default: () => null }),
    awaitingInput: Annotation<AwaitingInput | null>({
      reducer: (_, n) => n,
      default: () => null,
    }),
    currentFlow: Annotation<CurrentFlow | null>({
      reducer: (_, n) => n,
      default: () => null,
    }),
  });
  const objSelectors = { set_holder: (s: ObjS) => s };
  const opts: BuildAgentStepToolOptions<ObjS, "set_holder", never, typeof objSelectors> = {
    config: defineConfig<"set_holder", never>({
      tool: { name: "obj_tool", description: "object invalidation test" },
      actions: {
        set_holder: {
          description: "sets holder; changes clear derived",
          paramsSchema: z.object({ code: z.string() }),
          prereqs: [],
          invalidatesOnChange: { holder: ["derived"] },
        },
      },
    }),
    stateSchema: annotation,
    selectors: objSelectors,
    executors: {
      set_holder: async (params) => ({
        resultBody: { summary: "holder set" },
        stateUpdate: { holder: { code: (params as { code: string }).code } },
        ok: true,
      }),
    },
    verifiers: {},
  };
  const seeded: ObjS = { holder: { code: "C1" }, derived: "X" };
  const same = await runSteps(opts, [{ action: "set_holder", params: { code: "C1" } }], seeded);
  assert.equal(same.committed.derived, undefined, "same-value fresh object must not cascade");
  const changed = await runSteps(opts, [{ action: "set_holder", params: { code: "C2" } }], seeded);
  assert.equal(changed.committed.derived, null, "a real value change still clears downstream");
});

// ─── ConfirmationOpts.readBack ────────────────────────────────────────────── //
// The engine owns the capture (it parsed, normalized and stored these params),
// so it owns reporting it back; the host supplies only the rendering. Shipped in
// 2.3.0 untested at this layer even though it is the mechanism a host relies on
// to stop the MODEL re-deriving what the caller must confirm.

function makeReadBackOpts(
  readBack: (params: Record<string, unknown>, state: unknown) => string | undefined,
): BuildAgentStepToolOptions<S, string, string, typeof baseSelectors> {
  const base = makeOpts();
  const cfg = makeConfig();
  cfg.actions.change_status.controller!.requiresConfirmation = { maxAttempts: 3, readBack };
  return { ...base.opts, config: cfg };
}

test("readBack: a non-empty rendering rides the proposal as `read_back`", async () => {
  const opts = makeReadBackOpts((params) => `heard ${String(params.newStatus)}`);
  const { body } = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    SEEDED,
  );
  const r = body.results[0] as { needs_confirmation?: boolean; read_back?: string };
  assert.equal(r.needs_confirmation, true);
  assert.equal(r.read_back, "heard lost");
});

test("readBack: it receives the PARSED params and the state view", async () => {
  // Rendering from the stored params is the whole safety property: what is read
  // back cannot drift from what will execute.
  let seenParams: unknown;
  let seenState: unknown;
  const opts = makeReadBackOpts((params, state) => {
    seenParams = params;
    seenState = state;
    return "x";
  });
  await runSteps(opts, [{ action: "change_status", params: { newStatus: "lost" } }], SEEDED);
  assert.deepEqual(seenParams, { newStatus: "lost" });
  assert.deepEqual((seenState as S).customer, { code: "C1" });
});

test("readBack: undefined or empty adds NO field — hosts without one are unaffected", async () => {
  for (const render of [() => undefined, () => ""]) {
    const { body } = await runSteps(
      makeReadBackOpts(render),
      [{ action: "change_status", params: { newStatus: "lost" } }],
      SEEDED,
    );
    const r = body.results[0] as { needs_confirmation?: boolean };
    assert.equal(r.needs_confirmation, true);
    assert.ok(!("read_back" in r), "absent, not an empty string");
  }
});

test("readBack: rendered on a RE-proposal too, from the corrected params", async () => {
  // A correction re-proposes; the read-back must follow the new value, not the
  // one the caller just rejected.
  const opts = makeReadBackOpts((params) => `heard ${String(params.newStatus)}`);
  const first = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    SEEDED,
  );
  const pending = { ...SEEDED, ...(first.committed as Partial<S>) } as S;
  const second = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "stolen" } }],
    pending,
  );
  const r = second.body.results[0] as { needs_confirmation?: boolean; read_back?: string };
  assert.equal(r.needs_confirmation, true);
  assert.equal(r.read_back, "heard stolen");
});

test("readBack: NOT rendered on the executing re-call — it is a proposal-only field", async () => {
  const opts = makeReadBackOpts((params) => `heard ${String(params.newStatus)}`);
  const first = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    SEEDED,
  );
  const pending = { ...SEEDED, ...(first.committed as Partial<S>) } as S;
  const executed = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    pending,
  );
  const r = executed.body.results[0] as { needs_confirmation?: boolean; read_back?: string };
  assert.notEqual(r.needs_confirmation, true, "the same params execute on a later call");
  assert.equal(r.read_back, undefined);
});

// ─── ConfirmationOpts.refuseProposal ─────────────────────────────────────── //
// Propose-time, state-aware refusal: a schema-valid proposal may still be
// impossible given state (the canonical case: an empty capture probing for
// carried identity that does not exist). The refusal answers on the FIRST
// call — no gate is stored, no attempt is spent.

function makeRefuseOpts(
  refuseProposal: (
    params: Record<string, unknown>,
    state: unknown,
  ) => ({ summary: string; error: string } & Record<string, unknown>) | null,
): BuildAgentStepToolOptions<S, string, string, typeof baseSelectors> {
  const base = makeOpts();
  const cfg = makeConfig();
  cfg.actions.change_status.controller!.requiresConfirmation = {
    maxAttempts: 3,
    refuseProposal,
  };
  return { ...base.opts, config: cfg };
}

test("refuseProposal: a returned body refuses on the FIRST call — no gate, no attempt spent", async () => {
  const opts = makeRefuseOpts(() => ({
    summary: "nothing to confirm",
    error: "no_afm_source",
  }));
  const { body, committed } = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    SEEDED,
  );
  const r = body.results[0] as {
    ok: boolean;
    error?: string;
    needs_confirmation?: boolean;
  };
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_afm_source");
  assert.ok(!("needs_confirmation" in r), "a refused probe must not propose");
  assert.equal(committed.awaitingInput ?? null, null, "no gate may be stored");
});

test("refuseProposal: null proceeds to a normal proposal; it sees parsed params and the state view", async () => {
  let seenParams: unknown;
  let seenState: unknown;
  const opts = makeRefuseOpts((params, state) => {
    seenParams = params;
    seenState = state;
    return null;
  });
  const { body } = await runSteps(
    opts,
    [{ action: "change_status", params: { newStatus: "lost" } }],
    SEEDED,
  );
  const r = body.results[0] as { needs_confirmation?: boolean };
  assert.equal(r.needs_confirmation, true, "a null refusal proposes normally");
  assert.deepEqual(seenParams, { newStatus: "lost" });
  assert.deepEqual((seenState as S).customer, { code: "C1" });
});
