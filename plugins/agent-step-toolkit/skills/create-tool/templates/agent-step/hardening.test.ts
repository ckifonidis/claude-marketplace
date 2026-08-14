// FILE: src/agent-step/hardening.test.ts
//
// Pins the hardening round layered onto v2 (2026-08-05 review):
//   - confirmation turn-provenance: a matching re-call on the SAME caller
//     turn as the proposal is refused (`confirmation_same_turn_locked`) —
//     legitimate confirmation always arrives after the caller answered.
//   - handoff monotonicity: once the handoff slot is set, the step's
//     interaction lifecycle is suppressed and the batch ends.
//   - bounded-choice consume-on-acceptance: refused/malformed steps never
//     burn the one-shot choice; and the choice can be neither resolved nor
//     consumed on the turn it was offered.
//   - abort-aware planning: a batch that aborts the pending gate plans later
//     confirm steps as FRESH proposals, never as executes.
//   - construction-time channel-completeness validation.
//   - canonical value equality treats own `__proto__` keys as data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import { defineConfig } from "./define-config.js";
import {
  buildAgentStepTool,
  runSteps,
  REQUEST_BOUNDED_CHOICE_ACTION,
  RESOLVE_BOUNDED_CHOICE_ACTION,
  type BuildAgentStepToolOptions,
} from "./runner.js";
import type {
  AwaitingInput,
  BoundedChoice,
  CurrentFlow,
  HandoffRequest,
  TrailEntry,
} from "./state.js";
import type { PagedCache } from "./paginate.js";
import type { VerifierRegistry } from "./types.js";
import { valueEqual } from "./run/value-equal.js";

interface S {
  data?: string | null;
  ready?: boolean | null;
  messages?: unknown[];
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
  boundedChoice?: BoundedChoice | null;
  pagedRead?: PagedCache<unknown> | null;
  handoff?: HandoffRequest | null;
  errorCount?: number | null;
}

const replace = <T>() => ({
  reducer: (_o: T | null, n: T | null) => n ?? null,
  default: () => null as T | null,
});

const stateSchema = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>(replace<TrailEntry[]>()),
  data: Annotation<string | null>(replace<string>()),
  ready: Annotation<boolean | null>(replace<boolean>()),
  awaitingInput: Annotation<AwaitingInput | null>(replace<AwaitingInput>()),
  currentFlow: Annotation<CurrentFlow | null>(replace<CurrentFlow>()),
  boundedChoice: Annotation<BoundedChoice | null>(replace<BoundedChoice>()),
  pagedRead: Annotation<PagedCache<unknown> | null>(replace<PagedCache<unknown>>()),
  handoff: Annotation<HandoffRequest | null>(replace<HandoffRequest>()),
  errorCount: Annotation<number | null>(replace<number>()),
});

type ActionName =
  | "read_thing"
  | "mutate"
  | "mutate_sole"
  | "terminal_step"
  | "otp_consume"
  | "gated_input";

function human(id: string): { type: string; id: string; content: string } {
  return { type: "human", id, content: "…" };
}

interface Calls {
  read: number;
  mutate: number;
  mutateSole: number;
  terminal: number;
  gated: number;
}

function makeOpts(mock: { terminalIssuesOtp?: boolean } = {}): {
  opts: BuildAgentStepToolOptions<S, ActionName, string, Record<ActionName, (s: S) => S>>;
  calls: Calls;
} {
  const calls: Calls = { read: 0, mutate: 0, mutateSole: 0, terminal: 0, gated: 0 };
  const config = defineConfig<ActionName, string>({
    tool: { name: "hardening_tool", description: "hardening test tool" },
    actions: {
      read_thing: {
        description: "read something",
        paramsSchema: z.object({}),
        prereqs: [],
      },
      mutate: {
        description: "confirm-gated mutation",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 } },
      },
      mutate_sole: {
        description: "confirm-gated soleOnExecute mutation",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 }, soleOnExecute: true },
      },
      terminal_step: {
        description: "ok step that requests a terminal handoff",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: {
          startsFlow: { name: "tflow" },
          issuesOtp: { consumer_action: "otp_consume" },
        },
      },
      otp_consume: {
        description: "consume the OTP",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: { requiresOtp: true, requiresFlow: "tflow" },
      },
      gated_input: {
        description: "prereq- and shape-gated direct input",
        paramsSchema: z.object({ v: z.string().min(2) }),
        prereqs: ["ready"],
      },
    },
  });
  const selectors = {
    read_thing: (s: S) => s,
    mutate: (s: S) => s,
    mutate_sole: (s: S) => s,
    terminal_step: (s: S) => s,
    otp_consume: (s: S) => s,
    gated_input: (s: S) => s,
  };
  const executors = {
    read_thing: async () => {
      calls.read++;
      return { resultBody: { summary: "read ok" }, ok: true };
    },
    mutate: async (params: unknown) => {
      calls.mutate++;
      return {
        resultBody: { summary: "mutated", verdict: "ok" },
        stateUpdate: { data: (params as { v: string }).v } as Partial<S>,
        ok: true,
      };
    },
    mutate_sole: async () => {
      calls.mutateSole++;
      return { resultBody: { summary: "sole mutated", verdict: "ok" }, ok: true };
    },
    terminal_step: async () => {
      calls.terminal++;
      return {
        resultBody: { summary: "terminal outcome", verdict: "already_closed" },
        effects: [
          {
            type: "request_handoff" as const,
            request: { reason: "completed" as const, context: "t:done" },
          },
          ...(mock.terminalIssuesOtp ? [{ type: "otp_issued" as const }] : []),
        ],
        ok: true,
      };
    },
    otp_consume: async () => ({ resultBody: { summary: "otp ok" }, ok: true }),
    gated_input: async () => {
      calls.gated++;
      return { resultBody: { summary: "gated ok" }, ok: true };
    },
  };
  const verifiers: VerifierRegistry<S> = {
    ready: {
      check: (s) => s.ready === true,
      denial: { summary: "not ready", error: "not_ready" },
    },
  };
  const opts: BuildAgentStepToolOptions<
    S,
    ActionName,
    string,
    Record<ActionName, (s: S) => S>
  > = {
    config,
    stateSchema,
    selectors,
    executors: executors as never,
    verifiers,
    handoff: { offTopic: { mode: "terminate" }, terminateMessage: "bye" },
    boundedChoices: {
      my_choice: {
        description: "one-shot test choice",
        selections: ["continue"],
        directInputActions: ["gated_input", "mutate"],
      },
    },
  };
  return { opts, calls };
}

const PENDING_MUTATE = (turnId?: string): AwaitingInput => ({
  kind: "confirmation",
  for_action: "mutate",
  params: { v: "x" },
  attempts_left: 3,
  max_attempts: 3,
  ...(turnId ? { proposed_on_caller_turn_id: turnId } : {}),
});

// ─── Confirmation turn-provenance ────────────────────────────────────────── //

test("propose stamps the proposal's caller turn id on the gate", async () => {
  const { opts } = makeOpts();
  const { committed } = await runSteps(
    opts,
    [{ action: "mutate", params: { v: "x" } }],
    { messages: [human("t1")] } as S,
  );
  const gate = committed.awaitingInput as AwaitingInput & { kind: "confirmation" };
  assert.equal(gate.kind, "confirmation");
  assert.equal(gate.proposed_on_caller_turn_id, "t1");
});

test("matching re-call on the SAME caller turn is refused; gate intact, no attempt spent", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "mutate", params: { v: "x" } }],
    { messages: [human("t1")], awaitingInput: PENDING_MUTATE("t1") } as S,
  );
  assert.equal(body.results[0].error, "confirmation_same_turn_locked");
  assert.equal(body.results[0].ok, false);
  assert.equal(body.failed_at, 0);
  assert.equal(calls.mutate, 0, "executor must not run");
  assert.equal(committed.awaitingInput, undefined, "gate untouched — no write at all");
});

test("matching re-call on a LATER caller turn executes and clears the gate", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "mutate", params: { v: "x" } }],
    { messages: [human("t1"), human("t2")], awaitingInput: PENDING_MUTATE("t1") } as S,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].verdict, "ok");
  assert.equal(calls.mutate, 1);
  assert.equal(committed.awaitingInput, null);
});

test("identity-less consumers keep the params-only behavior (fail-open)", async () => {
  const { opts, calls } = makeOpts();
  const { body } = await runSteps(
    opts,
    [{ action: "mutate", params: { v: "x" } }],
    { awaitingInput: PENDING_MUTATE() } as S, // no messages, no stored turn id
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(calls.mutate, 1);
});

test("host getCallerTurnId hook drives the same-turn lock", async () => {
  const { opts } = makeOpts();
  const hooked = { ...opts, getCallerTurnId: () => "hook-turn" };
  const propose = await runSteps(hooked, [{ action: "mutate", params: { v: "x" } }], {} as S);
  const first = propose.body.results[0] as { needs_confirmation?: boolean };
  assert.equal(first.needs_confirmation, true);
  const mid = { awaitingInput: propose.committed.awaitingInput } as S;
  const execute = await runSteps(hooked, [{ action: "mutate", params: { v: "x" } }], mid);
  assert.equal(execute.body.results[0].error, "confirmation_same_turn_locked");
});

// ─── Handoff monotonicity ───────────────────────────────────────────────── //

test("an ok step with a request_handoff effect ends the batch — later steps never run", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "terminal_step", params: {} },
      { action: "read_thing", params: {} },
    ],
    {} as S,
  );
  assert.equal(body.results.length, 1, "batch ended after the handoff step");
  assert.equal(body.results[0].ok, true);
  assert.equal(body.failed_at, undefined);
  assert.equal(calls.read, 0, "later step must not execute");
  assert.deepEqual(committed.handoff, { reason: "completed", context: "t:done" });
});

test("a handoff suppresses the same step's interaction reopening (startsFlow / otp_issued)", async () => {
  const { opts } = makeOpts({ terminalIssuesOtp: true });
  const { committed } = await runSteps(
    opts,
    [{ action: "terminal_step", params: {} }],
    {} as S,
  );
  assert.deepEqual(committed.handoff, { reason: "completed", context: "t:done" });
  assert.equal(committed.currentFlow, null, "startsFlow must not reopen the flow");
  assert.equal(committed.awaitingInput, null, "otp_issued must not reopen a gate");
});

// ─── Bounded choice: consume on acceptance + offered-this-turn lock ─────── //

const PENDING_CHOICE = (requestedOn?: string): BoundedChoice => ({
  name: "my_choice",
  status: "pending",
  ...(requestedOn ? { requested_on_caller_turn_id: requestedOn } : {}),
});

test("invalid params do not burn the pending choice", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "gated_input", params: { v: "x" } }], // fails min(2)
    { ready: true, boundedChoice: PENDING_CHOICE() } as S,
  );
  assert.equal(body.results[0].error, "invalid_params");
  assert.equal(calls.gated, 0);
  assert.equal(committed.boundedChoice, undefined, "one-shot choice not consumed");
});

test("a prereq denial does not burn the pending choice", async () => {
  const { opts } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "gated_input", params: { v: "ok" } }],
    { ready: false, boundedChoice: PENDING_CHOICE() } as S,
  );
  assert.equal(body.results[0].error, "not_ready");
  assert.equal(committed.boundedChoice, undefined, "one-shot choice not consumed");
});

test("an ACCEPTED direct input consumes the choice as domain_input", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "gated_input", params: { v: "ok" } }],
    { ready: true, boundedChoice: PENDING_CHOICE() } as S,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(calls.gated, 1);
  const choice = committed.boundedChoice as BoundedChoice;
  assert.equal(choice.status, "resolved");
  assert.equal(choice.selection, "domain_input");
});

test("a confirm-gated direct input consumes the choice on PROPOSE (params accepted)", async () => {
  const { opts } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "mutate", params: { v: "x" } }],
    { boundedChoice: PENDING_CHOICE() } as S,
  );
  assert.equal((body.results[0] as { needs_confirmation?: boolean }).needs_confirmation, true);
  const choice = committed.boundedChoice as BoundedChoice;
  assert.equal(choice.status, "resolved");
  assert.equal(choice.selection, "domain_input");
  const gate = committed.awaitingInput as AwaitingInput;
  assert.equal(gate.kind, "confirmation");
});

test("the choice cannot be resolved on the turn it was offered", async () => {
  const { opts } = makeOpts();
  const state = { messages: [human("t1")] } as S;
  const request = await runSteps(
    opts,
    [{ action: REQUEST_BOUNDED_CHOICE_ACTION, params: { choice: "my_choice" } }],
    state,
  );
  const stored = request.committed.boundedChoice as BoundedChoice;
  assert.equal(stored.status, "pending");
  assert.equal(stored.requested_on_caller_turn_id, "t1");

  const sameTurn = { ...state, ...request.committed } as S;
  const resolve = await runSteps(
    opts,
    [
      {
        action: RESOLVE_BOUNDED_CHOICE_ACTION,
        params: { choice: "my_choice", selection: "continue" },
      },
    ],
    sameTurn,
  );
  assert.equal(resolve.body.results[0].error, "bounded_choice_same_turn_locked");
  assert.equal(resolve.committed.boundedChoice, undefined, "still pending, untouched");
});

test("the choice resolves normally on the NEXT caller turn", async () => {
  const { opts } = makeOpts();
  const nextTurn = {
    messages: [human("t1"), human("t2")],
    boundedChoice: PENDING_CHOICE("t1"),
  } as S;
  const resolve = await runSteps(
    opts,
    [
      {
        action: RESOLVE_BOUNDED_CHOICE_ACTION,
        params: { choice: "my_choice", selection: "continue" },
      },
    ],
    nextTurn,
  );
  assert.equal(resolve.body.results[0].ok, true);
  const choice = resolve.committed.boundedChoice as BoundedChoice;
  assert.equal(choice.status, "resolved");
  assert.equal(choice.resolved_on_caller_turn_id, "t2");
});

test("direct input is also locked on the offering turn", async () => {
  const { opts, calls } = makeOpts();
  const { body } = await runSteps(
    opts,
    [{ action: "gated_input", params: { v: "ok" } }],
    { ready: true, messages: [human("t1")], boundedChoice: PENDING_CHOICE("t1") } as S,
  );
  assert.equal(body.results[0].error, "bounded_choice_same_turn_locked");
  assert.equal(calls.gated, 0);
});

// ─── Abort-aware planning ───────────────────────────────────────────────── //

test("[abort, matching mutation] proposes FRESH instead of executing", async () => {
  const { opts, calls } = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "mutate", params: { v: "x" } },
    ],
    { awaitingInput: PENDING_MUTATE() } as S,
  );
  assert.equal(body.results[0].ok, true); // abort
  const second = body.results[1] as { needs_confirmation?: boolean; attempts_left?: number };
  assert.equal(second.needs_confirmation, true, "must re-propose, never execute");
  assert.equal(second.attempts_left, 3, "fresh attempts — the old gate is gone");
  assert.equal(calls.mutate, 0);
  const gate = committed.awaitingInput as AwaitingInput & { kind: "confirmation" };
  assert.equal(gate.kind, "confirmation");
});

test("[abort, soleOnExecute mutation at tail] is admitted as a fresh propose", async () => {
  const { opts, calls } = makeOpts();
  const { body } = await runSteps(
    opts,
    [
      { action: "abort_pending_input", params: {} },
      { action: "mutate_sole", params: { v: "x" } },
    ],
    {
      awaitingInput: {
        kind: "confirmation",
        for_action: "mutate_sole",
        params: { v: "x" },
        attempts_left: 2,
        max_attempts: 3,
      },
    } as S,
  );
  assert.equal(body.failed_at, undefined, "no execute-must-be-sole refusal");
  const second = body.results[1] as { needs_confirmation?: boolean };
  assert.equal(second.needs_confirmation, true);
  assert.equal(calls.mutateSole, 0);
});

// ─── Construction-time channel completeness ─────────────────────────────── //

test("construction rejects a state schema missing a required managed channel", () => {
  const { opts } = makeOpts();
  const incomplete = Annotation.Root({
    // actionTrail present so the assertion below stays pinned to the ONE slot
    // this test deliberately omits.
    actionTrail: Annotation<TrailEntry[] | null>(replace<TrailEntry[]>()),
    data: Annotation<string | null>(replace<string>()),
    // awaitingInput deliberately missing while confirm gates are configured.
    currentFlow: Annotation<CurrentFlow | null>(replace<CurrentFlow>()),
    boundedChoice: Annotation<BoundedChoice | null>(replace<BoundedChoice>()),
    pagedRead: Annotation<PagedCache<unknown> | null>(replace<PagedCache<unknown>>()),
    handoff: Annotation<HandoffRequest | null>(replace<HandoffRequest>()),
    errorCount: Annotation<number | null>(replace<number>()),
  });
  assert.throws(
    () => buildAgentStepTool({ ...opts, stateSchema: incomplete }),
    /missing channel\(s\) "awaitingInput"/,
  );
});

// ─── Canonical value equality ───────────────────────────────────────────── //

test("own __proto__ keys are DATA for the params match, never prototype writes", () => {
  const a = JSON.parse('{"a":1,"__proto__":{"x":1}}');
  const b = JSON.parse('{"a":1,"__proto__":{"x":2}}');
  const c = JSON.parse('{"a":1,"__proto__":{"x":1}}');
  assert.equal(valueEqual(a, b), false, "differing __proto__ payloads must not match");
  assert.equal(valueEqual(a, c), true);
  assert.deepEqual({}.constructor === Object, true, "global Object.prototype unpolluted");
});
