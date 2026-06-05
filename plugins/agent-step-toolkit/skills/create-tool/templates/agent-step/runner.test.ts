import { test } from "node:test";
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
import type { AwaitingInput, CurrentFlow } from "./state.js";

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
      stateAnnotation: testStateAnnotation,
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
  assert.match(body.results[1].summary as string, /boom: backend exploded/);
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
  assert.deepEqual(committed, {});
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
  assert.deepEqual(committed, {});
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
  // no results rather than an error.
  const t = buildAgentStepTool(opts);
  const parsed = t.schema.safeParse({ steps: [] });
  assert.equal(parsed.success, true);

  const { body } = await runSteps(opts, [], EMPTY);
  assert.equal(body.results.length, 0);
  assert.equal(body.failed_at, undefined);
});

// ─── Confirmation-required mutation tests ────────────────────────────────── //

function makeConfirmOpts(
  mock: MockOpts = {},
  confirm: { maxAttempts?: number; ttlMs?: number; lockdown?: boolean } = {},
): { opts: BuildAgentStepToolOptions<S, string, string, typeof baseSelectors>; calls: Calls } {
  const base = makeOpts(mock);
  const cfg = makeConfig();
  cfg.actions.change_status.controller!.requiresConfirmation = {
    maxAttempts: confirm.maxAttempts ?? 3,
    ttlMs: confirm.ttlMs ?? 300_000,
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
  assert.match(body.results[0].summary as string, /nothing to abort/i);
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

test("library refuses user action named abort_pending_input", () => {
  const { opts } = makeConfirmOpts();
  const cfg = makeConfig();
  (cfg.actions as Record<string, unknown>).abort_pending_input = {
    paramsSchema: z.object({}),
    prereqs: [],
    executor: "verifyCustomer",
  };
  cfg.actions.change_status.controller!.requiresConfirmation = { maxAttempts: 3, ttlMs: 300_000 };
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
  cfg.actions.change_status.controller!.requiresConfirmation = { maxAttempts: 3, ttlMs: 300_000 };
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
        flowData: { challengeId: `ch-${calls.openA}`, mobile_masked: "***1234" },
        lifecycle: { issuesOtp: { challengeId: `ch-${calls.openA}`, mobile_masked: "***1234" } },
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
            lifecycle: { clearAwaitingInput: true },
          };
        case "lock":
          return {
            ok: false,
            resultBody: { summary: "locked", error: "otp_locked" },
            lifecycle: { abortFlow: true },
          };
        case "ok":
        default:
          return {
            ok: true,
            resultBody: { summary: "otp validated", otp_valid: true },
            flowData: { otpValidated: true },
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
        flowData: { challengeId: "ch-b" },
        lifecycle: { issuesOtp: { challengeId: "ch-b", mobile_masked: "***5678" } },
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
    opts: { config: cfg, stateAnnotation: testStateAnnotation, selectors: flowSelectors, executors, verifiers },
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
    opts: { config, stateAnnotation: soeAnnotation, selectors: soeSelectors, executors, verifiers },
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
};

function makeMatchOpts(mock: MatchMockOpts = {}): {
  opts: BuildAgentStepToolOptions<MatchS, string, string, typeof matchSelectors>;
  calls: MatchCalls;
} {
  const calls: MatchCalls = { open: 0, capture: 0, commit: 0 };
  const config = defineConfig<"open_flow" | "capture_value" | "commit_value", never>({
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
        flowData: { captured: v },
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
          lifecycle: { abortFlow: true },
          ok: false,
        };
      }
      return {
        resultBody: { summary: "committed", success: true },
        ok: true,
      };
    },
  };
  return {
    opts: {
      config,
      stateAnnotation: matchAnnotation,
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
    stateAnnotation: invalidateStateAnnotation,
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
    stateAnnotation: annotation,
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
