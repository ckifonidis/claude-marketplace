// Runner unit tests for the two 2026-11-20 additions that let a confirmed
// capture run straight on to the next consent in ONE tool call:
//   - `VerdictDef.proposes` — an ok row opens another action's proposal inside
//     the same run (read-back, gate, attempts) and drops the rest of the batch;
//   - `ConfirmationOpts.consentExempt` — a judged param is not part of the
//     execute match, and an omitted one keeps the proposal's value on execute.
// No backend, no LLM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildAgentStepTool, runSteps } from "./runner.js";
import { agentStepStateSpec, type LibraryManagedSlots } from "./state.js";
import { judgedFlag } from "./capture.js";
import type { VerdictDef } from "./types.js";

interface S extends LibraryManagedSlots { messages: unknown[]; bound?: string | null }

function fixture(opts: { proposes?: VerdictDef<S>["proposes"]; exempt?: readonly string[] } = {}) {
  const executed: Array<{ action: string; params: unknown }> = [];
  const config = {
    tool: { name: "flow", description: "Flow", toolChoice: "required" as const },
    actions: {
      bind: {
        description: "Bind the item",
        paramsSchema: z.object({ flagged: judgedFlag("Set true only when volunteered.") }),
        prereqs: [],
        verdicts: {
          ok: {
            ok: true as const,
            summary: "Bound.",
            ...(opts.proposes !== undefined ? { proposes: opts.proposes } : {}),
          },
        },
      },
      close: {
        description: "Close the bound item",
        paramsSchema: z.object({ flagged: judgedFlag("Set true only when volunteered.") }),
        prereqs: [],
        controller: {
          requiresConfirmation: {
            readBack: () => "Close it for good?",
            ...(opts.exempt !== undefined ? { consentExempt: opts.exempt } : {}),
          },
        },
        verdicts: { ok: { ok: true as const, summary: "Closed." } },
      },
      other: { description: "Other", paramsSchema: z.object({}), prereqs: [], verdicts: { ok: { ok: true as const, summary: "Other." } } },
    },
  };
  const toolOpts = {
    config,
    stateSchema: Annotation.Root({ ...agentStepStateSpec, bound: Annotation<string | null>(), messages: Annotation<unknown[]>() }),
    selectors: { bind: (s: S) => s, close: (s: S) => s, other: (s: S) => s },
    executors: {
      bind: async (params: unknown) => { executed.push({ action: "bind", params }); return { verdict: "ok", stateUpdate: { bound: "item-1" } }; },
      close: async (params: unknown) => { executed.push({ action: "close", params }); return { verdict: "ok" }; },
      other: async (params: unknown) => { executed.push({ action: "other", params }); return { verdict: "ok" }; },
    },
    verifiers: {},
  };
  const state: S = { messages: [new HumanMessage({ content: "Bind it", id: "caller-1" })], awaitingInput: null };
  return { toolOpts, state, executed };
}
const step = (action: string, params: Record<string, unknown> = {}) => ({ action, params });
/** Thread a run's commit and its result, then the caller's next turn. */
function answered(state: S, run: { body: unknown; committed: Partial<S> }, id: string): S {
  return {
    ...state,
    ...run.committed,
    messages: [...state.messages, new ToolMessage({ tool_call_id: "r", content: JSON.stringify(run.body) }), new HumanMessage({ content: "Yes", id })],
  } as S;
}

test("proposes: the ok row opens the target's proposal in the SAME result, and drops the rest of the batch", async () => {
  const { toolOpts, state, executed } = fixture({
    proposes: { action: "close", params: (_s, _d, p) => (p.flagged === true ? { flagged: true } : {}) },
  });
  const run = await runSteps(toolOpts, [step("bind", { flagged: true }), step("other")], state);
  assert.deepEqual(executed.map(e => e.action), ["bind"], "nothing after the proposal runs");
  assert.equal(run.body.results.length, 2);
  const [bound, proposal] = run.body.results as Array<Record<string, unknown>>;
  assert.equal(bound.action, "bind");
  assert.equal(bound.ok, true);
  assert.equal(proposal.action, "close");
  assert.equal(proposal.needs_confirmation, true);
  assert.deepEqual(proposal.proposed_params, { flagged: true }, "params built from the step's own params");
  assert.equal(proposal.read_back, "Close it for good?");
  assert.equal(proposal.continuation, "await_caller", "the proposal is the turn's caller boundary");
  assert.equal(run.committed.awaitingInput?.for_action, "close");
  assert.equal(run.committed.bound, "item-1");
});

test("proposes: the proposal is stored on the caller turn of the bind — a same-turn re-call is refused, the next turn executes", async () => {
  const { toolOpts, state, executed } = fixture({ proposes: { action: "close" } });
  const run = await runSteps(toolOpts, [step("bind")], state);
  const pending = { ...state, ...run.committed } as S;
  const same = await runSteps(toolOpts, [step("close")], pending);
  assert.equal(same.body.results[0].error, "confirmation_same_turn_locked");
  const yes = await runSteps(toolOpts, [step("close")], answered(state, run, "caller-2"));
  assert.equal(yes.body.results[0].ok, true);
  assert.deepEqual(executed.map(e => e.action), ["bind", "close"]);
});

test("proposes: validation — the target must be confirm-gated and the row a plain ok row", () => {
  const notGated = fixture({ proposes: { action: "other" } });
  assert.throws(() => buildAgentStepTool(notGated.toolOpts as never), /proposes must name a confirm-gated action/);
  const withContinuation = fixture({ proposes: { action: "close" } });
  (withContinuation.toolOpts.config.actions.bind.verdicts.ok as Record<string, unknown>).continuation = "await_caller";
  assert.throws(() => buildAgentStepTool(withContinuation.toolOpts as never), /plain ok row/);
});

test("consentExempt: an omitted exempt param keeps the PROPOSAL's value on execute", async () => {
  const { toolOpts, state, executed } = fixture({ exempt: ["flagged"] });
  const propose = await runSteps(toolOpts, [step("close", { flagged: true })], state);
  assert.equal(propose.body.results[0].needs_confirmation, true);
  const run = await runSteps(toolOpts, [step("close", {})], answered(state, propose, "caller-2"));
  assert.equal(run.body.results[0].ok, true, "the omission matches — no re-proposal");
  assert.deepEqual(executed.at(-1), { action: "close", params: { flagged: true } }, "the proposed judgement executes");
});

test("consentExempt: a value the executing call supplies wins", async () => {
  const { toolOpts, state, executed } = fixture({ exempt: ["flagged"] });
  const propose = await runSteps(toolOpts, [step("close", {})], state);
  const run = await runSteps(toolOpts, [step("close", { flagged: true })], answered(state, propose, "caller-2"));
  assert.equal(run.body.results[0].ok, true);
  assert.deepEqual(executed.at(-1), { action: "close", params: { flagged: true } });
});

test("without consentExempt a changed judged param still re-proposes", async () => {
  const { toolOpts, state, executed } = fixture();
  const propose = await runSteps(toolOpts, [step("close", { flagged: true })], state);
  const run = await runSteps(toolOpts, [step("close", {})], answered(state, propose, "caller-2"));
  assert.equal(run.body.results[0].needs_confirmation, true);
  assert.deepEqual(executed, []);
});

test("consentExempt: validation — only judged params may be exempt", () => {
  const bad = fixture({ exempt: ["missing"] });
  assert.throws(() => buildAgentStepTool(bad.toolOpts as never), /consentExempt names "missing"/);
});
