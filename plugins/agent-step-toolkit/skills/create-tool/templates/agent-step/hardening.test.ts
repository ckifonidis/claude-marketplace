// FILE: src/agent-step/hardening.test.ts
//
// Pins the hardening round layered onto v2 (2026-08-05 review):
//   - confirmation turn-provenance: a matching re-call on the SAME caller
//     turn as the proposal is refused (`confirmation_same_turn_locked`) —
//     legitimate confirmation always arrives after the caller answered.
//   - handoff monotonicity: once the handoff slot is set, the step's
//     interaction lifecycle is suppressed and the batch ends.
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
  type BuildAgentStepToolOptions,
} from "./runner.js";
import type {
  AwaitingInput,
  CurrentFlow,
  HandoffRequest,
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
  pagedRead?: PagedCache<unknown> | null;
  handoff?: HandoffRequest | null;
  errorCount?: number | null;
}

const replace = <T>() => ({
  reducer: (_o: T | null, n: T | null) => n ?? null,
  default: () => null as T | null,
});

const stateSchema = Annotation.Root({
  data: Annotation<string | null>(replace<string>()),
  ready: Annotation<boolean | null>(replace<boolean>()),
  awaitingInput: Annotation<AwaitingInput | null>(replace<AwaitingInput>()),
  currentFlow: Annotation<CurrentFlow | null>(replace<CurrentFlow>()),
  pagedRead: Annotation<PagedCache<unknown> | null>(replace<PagedCache<unknown>>()),
  handoff: Annotation<HandoffRequest | null>(replace<HandoffRequest>()),
  // The escalation latch: a configured handoff opts into `note_refusal`, which
  // writes it — a missing channel would discard that write silently.
  spentLadders: Annotation<Record<string, number> | null>(
    replace<Record<string, number>>(),
  ),
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
        verdicts: {
          read: { ok: true, summary: "read ok" },
        },
      },
      mutate: {
        description: "confirm-gated mutation",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 } },
        verdicts: {
          ok: { ok: true, summary: "mutated", body: { verdict: "ok" } },
        },
      },
      mutate_sole: {
        description: "confirm-gated soleOnExecute mutation",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 }, soleOnExecute: true },
        verdicts: {
          ok: { ok: true, summary: "sole mutated", body: { verdict: "ok" } },
        },
      },
      terminal_step: {
        description: "ok step that requests a terminal handoff",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: {
          startsFlow: { name: "tflow" },
          issuesOtp: { consumer_action: "otp_consume" },
        },
        verdicts: {
          already_closed: {
            ok: true,
            summary: "terminal outcome",
            body: { verdict: "already_closed" },
          },
        },
      },
      otp_consume: {
        description: "consume the OTP",
        paramsSchema: z.object({}),
        prereqs: [],
        controller: { requiresOtp: true, requiresFlow: "tflow" },
        verdicts: {
          ok: { ok: true, summary: "otp ok" },
        },
      },
      gated_input: {
        description: "prereq- and shape-gated direct input",
        paramsSchema: z.object({
          v: z.string().superRefine((val, ctx) => {
            if (val.length < 2) ctx.addIssue({ code: "custom", message: "too short" });
          }),
        }),
        prereqs: ["ready"],
        verdicts: {
          ok: { ok: true, summary: "gated ok" },
        },
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
      return { verdict: "read" };
    },
    mutate: async (params: unknown) => {
      calls.mutate++;
      return {
        verdict: "ok",
        stateUpdate: { data: (params as { v: string }).v } as Partial<S>,
      };
    },
    mutate_sole: async () => {
      calls.mutateSole++;
      return { verdict: "ok" };
    },
    terminal_step: async () => {
      calls.terminal++;
      // The handoff effect is mock-conditional, so it stays on the return.
      return {
        verdict: "already_closed",
        effects: [
          {
            type: "request_handoff" as const,
            request: { reason: "completed" as const, context: "t:done" },
          },
          ...(mock.terminalIssuesOtp ? [{ type: "otp_issued" as const }] : []),
        ],
      };
    },
    otp_consume: async () => ({ verdict: "ok" }),
    gated_input: async () => {
      calls.gated++;
      return { verdict: "ok" };
    },
  };
  const verifiers: VerifierRegistry<S> = {
    ready: {
      check: (s) => s.ready === true,
      denial: { instruction: "not ready", error: "not_ready" },
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
    handoff: { offTopic: { mode: "terminate" }, resolveClosingMessage: (_s: unknown, r: { context: string }) => r.context },
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
    data: Annotation<string | null>(replace<string>()),
    // awaitingInput deliberately missing while confirm gates are configured.
    currentFlow: Annotation<CurrentFlow | null>(replace<CurrentFlow>()),
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
