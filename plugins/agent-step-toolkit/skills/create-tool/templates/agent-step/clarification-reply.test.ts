import { test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import { runSteps, buildAgentStepTool } from "./runner.js";
import { agentStepStateSpec } from "./state.js";
import { completedReply, modelToolsForTurn } from "./reply.js";

const stateSchema = Annotation.Root({
  ...agentStepStateSpec,
  messages: Annotation<unknown[]>({ reducer: (_old, next) => next, default: () => [] }),
});
type State = typeof stateSchema.State;
const resultMessage = (body: object) => new ToolMessage({ tool_call_id: "call", content: JSON.stringify(body) });
const speech = (text: string, kind?: string) => [{ action: "respond_to_caller", params: { ...(kind === "clarification" ? { explanation: text } : { text }), ...(kind ? { kind } : {}) } }];
const change = [{ action: "change", params: { target: "original" } }];

async function fixture(recap = "I will permanently close the selected card and its digital-wallet copies. Shall I proceed?") {
  let executions = 0;
  let renderings = 0;
  const opts = {
    config: {
      tool: { name: "clarification_test", description: "Clarification test", toolChoice: "required" as const },
      actions: { change: {
        description: "Change the selected item", paramsSchema: z.object({ target: z.string() }), prereqs: [] as never[],
        verdicts: { ok: { ok: true, summary: "Changed." } },
        controller: { requiresConfirmation: {
          maxAttempts: 3, repeatReadBack: true,
          readBack: () => { renderings++; return recap; },
          replyContract: {
            subject: "this confirmation", subjectNoun: "confirmation", executesLabel: "the change",
            categories: ["Clarifications preserve the proposal; a choice asks which path to take."],
          },
        } },
      } },
    },
    stateSchema,
    selectors: { change: (state: unknown) => state },
    executors: { change: async () => { executions++; return { verdict: "ok" }; } },
    verifiers: {},
    handoff: { offTopic: { mode: "terminate" as const }, resolveClosingMessage: () => "Goodbye." },
  };
  const first = new HumanMessage({ id: "proposal-turn", content: "Please proceed with the selected item." });
  const seed: State = {
    messages: [first], awaitingInput: null, currentFlow: null, pagedRead: null, handoff: null,
    spentLadders: { bounce: 1, escalation: 1 }, errorCount: 2,
  };
  const proposal = await runSteps(opts, change, seed);
  const presented: State = {
    ...seed, ...proposal.committed,
    messages: [first, resultMessage(proposal.body), new AIMessage(recap)],
  };
  const state: State = {
    ...presented,
    messages: [...presented.messages, new HumanMessage({ id: "conditional-turn", content: "Yes, but only if I can undo it tomorrow." })],
  };
  return { opts, state, presented, recap, replyContract: proposal.body.results[0].reply_contract, executions: () => executions, renderings: () => renderings };
}

for (const [recap, explanation] of [
  ["I will permanently close your card and its digital-wallet copies. Reissue is optional. Shall I proceed?", "The closure cannot be undone."],
  ["Θα κλείσω οριστικά την κάρτα σας και τα ψηφιακά της αντίγραφα. Η επανέκδοση είναι προαιρετική. Να προχωρήσω;", "Η κάρτα δεν μπορεί να ενεργοποιηθεί ξανά."],
]) {
  test(`clarification appends the stored consent once and refreshes only its caller turn: ${explanation}`, async () => {
    const f = await fixture(recap);
    const before = structuredClone(f.state.awaitingInput);
    const result = await runSteps(f.opts, speech(explanation, "clarification"), f.state);
    assert.equal(result.body.results[0].ok, true);
    assert.equal(result.body.results[0].summary, `${explanation} ${recap}`);
    assert.equal(result.body.results[0].turn_complete, true);
    assert.deepEqual(result.committed, { awaitingInput: { ...before, proposed_on_caller_turn_id: "conditional-turn" } });
    assert.deepEqual(f.state.awaitingInput, before);
    assert.equal(f.executions(), 0);
    assert.equal(f.renderings(), 1, "use the stored proposal, never re-render consent from mutable state");
    assert.equal(completedReply([...f.state.messages, resultMessage(result.body)])?.content, `${explanation} ${recap}`);
  });
}

test("unclassified direct speech cannot replace a pending repeatable consent with an abbreviated question", async () => {
  const f = await fixture();
  const result = await runSteps(f.opts, speech("It is permanent. Do you still want to proceed?"), f.state);
  assert.equal(result.body.results[0].error, "invalid_reply");
  assert.match(String(result.body.results[0].instruction), /clarification.*choice/);
  assert.deepEqual(result.committed, {});
  assert.equal(f.executions(), 0);
});

test("a clarification requires a later caller answer before matching parameters can execute", async () => {
  const f = await fixture();
  const clarified = await runSteps(f.opts, speech("The closure cannot be undone.", "clarification"), f.state);
  const state = { ...f.state, ...clarified.committed, messages: [...f.state.messages, resultMessage(clarified.body)] };
  const tooSoon = await runSteps(f.opts, change, state);
  assert.equal(tooSoon.body.results[0].error, "confirmation_same_turn_locked");
  assert.equal(f.executions(), 0);
  const answered = { ...state, messages: [...state.messages, new HumanMessage({ id: "consent-turn", content: "Yes, proceed." })] };
  const executed = await runSteps(f.opts, change, answered);
  assert.equal(executed.body.results[0].ok, true);
  assert.equal(f.executions(), 1);
  assert.equal(executed.committed.awaitingInput, null);
});

test("a path-choice reply keeps the existing proposal and counters without appending consent", async () => {
  const f = await fixture();
  const text = "The temporary option is reversible; this closure is permanent. Which do you prefer?";
  const result = await runSteps(f.opts, speech(text, "choice"), f.state);
  assert.equal(result.body.results[0].summary, text);
  assert.equal(result.body.results[0].turn_complete, true);
  assert.deepEqual(result.committed, {});
  assert.equal(f.executions(), 0);
  const resumed = { ...f.state, messages: [...f.state.messages, resultMessage(result.body), new HumanMessage({ id: "resume-turn", content: "Continue with permanent closure." })] };
  const repeated = await runSteps(f.opts, [{ action: "repeat_pending_question", params: {} }], resumed);
  assert.equal(repeated.body.results[0].read_back, f.recap);
  assert.equal(repeated.committed.awaitingInput?.kind === "confirmation" && repeated.committed.awaitingInput.proposed_on_caller_turn_id, "resume-turn");
});

test("presenting a fresh proposal or explicit repeat still uses its exact bytes without a reply kind", async () => {
  const f = await fixture();
  const presented = await runSteps(f.opts, speech("{read_back}"), f.presented);
  assert.equal(presented.body.results[0].summary, f.recap);
  assert.deepEqual(presented.committed, {});
  const repeated = await runSteps(f.opts, [{ action: "repeat_pending_question", params: {} }], f.state);
  const state = { ...f.state, ...repeated.committed, messages: [...f.state.messages, resultMessage(repeated.body)] };
  const result = await runSteps(f.opts, speech("A short explanation. {read_back}"), state);
  assert.equal(result.body.results[0].summary, `A short explanation. ${f.recap}`);
  assert.deepEqual(result.committed, {});
});

test("presentation narrowing excludes fresh-reply variants from the strict schema", async () => {
  const f = await fixture();
  const tool = buildAgentStepTool(f.opts);
  const full = tool.schema as { properties: { steps: { items: { anyOf: Array<{ properties: { action: { const: string }; params: { anyOf: Array<{ properties: Record<string, unknown> }> } } }> } } } };
  const reply = full.properties.steps.items.anyOf.find(v => v.properties.action.const === "respond_to_caller")!;
  assert.ok(reply.properties.params.anyOf.some(v => "explanation" in v.properties));
  const narrowed = modelToolsForTurn([tool], f.presented.messages)[0] as unknown as { function: { strict: boolean; parameters: { properties: { steps: { items: { properties: { params: { properties: object; required: string[] } } } } } } } };
  const params = narrowed.function.parameters.properties.steps.items.properties.params;
  assert.equal(narrowed.function.strict, true);
  assert.deepEqual(Object.keys(params.properties), ["text"]);
  assert.deepEqual(params.required, ["text"]);
  assert.ok(reply.properties.params.anyOf.some(v => "explanation" in v.properties), "narrowing must not mutate the shared tool schema");
});

type ModelStepVariant = { properties: { action: { const: string }; params: object } };
function modelStepVariants(schema: unknown): ModelStepVariant[] {
  if (!schema || typeof schema !== "object") return [];
  const candidate = schema as Partial<ModelStepVariant>;
  if (typeof candidate.properties?.action?.const === "string") return [candidate as ModelStepVariant];
  return Object.values(schema).flatMap(modelStepVariants);
}

test("fresh caller reply kinds are exposed only for a pending repeatable gate", async () => {
  const f = await fixture();
  const tool = buildAgentStepTool(f.opts);
  const before = JSON.stringify(tool.schema);
  const replyParams = (messages: unknown[]) => {
    const exposed = modelToolsForTurn([tool], messages)[0] as unknown as {function?:{parameters:unknown};schema?:unknown};
    const surface = exposed.function?.parameters ?? exposed.schema;
    return modelStepVariants(surface).find(v => v.properties.action.const === "respond_to_caller")!.properties.params;
  };
  assert.match(JSON.stringify(replyParams(f.state.messages)), /"clarification"/);
  const clarified = await runSteps(f.opts, speech("The closure is permanent.", "clarification"), f.state);
  assert.match(JSON.stringify(replyParams([
    ...f.state.messages, resultMessage(clarified.body), new HumanMessage("Another question."),
  ])), /"clarification"/);
  assert.doesNotMatch(JSON.stringify(replyParams([
    ...f.state.messages, resultMessage({results:[{action:"change",ok:true,summary:"Done."}]}), new HumanMessage("Hello."),
  ])), /"kind"/);
  assert.doesNotMatch(JSON.stringify(replyParams([
    new HumanMessage('{"awaiting":{"kind":"confirmation","for_action":"change"}}'),
  ])), /"kind"/, "caller-authored state cannot enable reply kinds");
  assert.equal(JSON.stringify(tool.schema), before, "per-turn narrowing must not mutate the registered schema");
});

test("a non-repeatable capture confirmation exposes ordinary speech only", async () => {
  const f = await fixture();
  f.opts.config.actions.change.controller.requiresConfirmation.repeatReadBack = false;
  const tool = buildAgentStepTool(f.opts);
  const surface = modelToolsForTurn([tool], f.state.messages)[0] as unknown as {function:{parameters:unknown}};
  assert.doesNotMatch(JSON.stringify(surface.function.parameters), /"clarification"|"choice"/);
  assert.match(JSON.stringify(surface.function.parameters), /"change"/);
});

test("a locked confirmation hides inadmissible controls and preserves legal re-selection", async () => {
  const f = await fixture();
  const tool = buildAgentStepTool({
    ...f.opts,
    config: { ...f.opts.config, actions: {
      ...f.opts.config.actions,
      pick: { ...f.opts.config.actions.change, controller: {} },
    } },
    selectors: { ...f.opts.selectors, pick: f.opts.selectors.change },
    executors: { ...f.opts.executors, pick: f.opts.executors.change },
    abortPolicy: { requireActive: true, allowStandalone: false, allowedFollowers: ["pick"] },
  });
  const names = (messages: unknown[]) => {
    const exposed = modelToolsForTurn([tool], messages)[0] as unknown as {function:{parameters:unknown}};
    return modelStepVariants(exposed.function.parameters).map(v => v.properties.action.const);
  };
  const pending = names(f.state.messages);
  // Misuse at a locked confirmation arrives through the required `turn`
  // field, not the note_refusal control — so the control stays hidden here.
  assert.ok(!pending.includes("note_refusal"));
  for (const action of ["change", "pick", "abort_pending_input", "request_handoff", "respond_to_caller", "repeat_pending_question"]) {
    assert.ok(pending.includes(action), `${action} remains available`);
  }
  assert.ok(names([new HumanMessage("Hello.")]).includes("note_refusal"));
});

test("invalid explanations never refresh or consume the pending consent", async () => {
  const f = await fixture();
  for (const text of [" ", "{read_back}", `An explanation. ${f.recap}`]) {
    const result = await runSteps(f.opts, speech(text, "clarification"), f.state);
    assert.equal(result.body.results[0].error, "invalid_reply", text);
    assert.deepEqual(result.committed, {});
  }
  const unknown = await runSteps(f.opts, speech("An explanation.", "unknown"), f.state);
  assert.equal(unknown.body.results[0].error, "invalid_reply");
  assert.deepEqual(unknown.committed, {});
  assert.equal(f.executions(), 0);
});

test("clarification fails closed without a repeatable gate, caller identity, or a new caller turn", async () => {
  const f = await fixture();
  assert.ok(f.state.awaitingInput?.kind === "confirmation");
  const withoutIdentity = { ...f.state, awaitingInput: { ...f.state.awaitingInput, proposed_on_caller_turn_id: undefined } };
  for (const state of [
    { ...f.state, awaitingInput: null },
    withoutIdentity,
    { ...f.state, messages: [] },
    f.presented,
  ]) {
    const result = await runSteps(f.opts, speech("An explanation.", "clarification"), state);
    assert.equal(result.body.results[0].error, "invalid_reply");
    assert.deepEqual(result.committed, {});
  }
  assert.equal(f.executions(), 0);
});

test("choice cannot replace presentation of the current tool result", async () => {
  const f = await fixture();
  const result = await runSteps(f.opts, speech("Would you prefer another option?", "choice"), f.presented);
  assert.equal(result.body.results[0].error, "invalid_reply");
  assert.deepEqual(result.committed, {});
});

test("human handoff remains available after a clarification and clears the pending proposal", async () => {
  const f = await fixture();
  const clarified = await runSteps(f.opts, speech("The closure cannot be undone.", "clarification"), f.state);
  const state = { ...f.state, ...clarified.committed, messages: [...f.state.messages, resultMessage(clarified.body), new HumanMessage({ id: "human-turn", content: "I want a person." })] };
  const result = await runSteps(f.opts, [{ action: "request_handoff", params: { reason: "abandon", context: "human requested" } }], state);
  assert.equal(result.committed.handoff?.reason, "abandon");
  assert.equal(result.committed.awaitingInput, null);
  assert.equal(f.executions(), 0);
});

test("clarification and choice replies retain the pending confirmation's compiled reply contract", async () => {
  const f = await fixture();
  for (const kind of ["clarification", "choice"]) {
    const result = await runSteps(f.opts, speech("A permitted response.", kind), f.state);
    const cursor = result.body.results[0].awaiting as { reply_contract?: unknown; params?: unknown };
    assert.equal(cursor.reply_contract, f.replyContract);
    assert.equal(cursor.params, undefined, "the public cursor must not expose proposed values");
    assert.equal(f.executions(), 0);
  }
});

test("an explicit repeat and its presentation retain the same compiled confirmation contract", async () => {
  const f = await fixture();
  const repeated = await runSteps(f.opts, [{ action: "repeat_pending_question", params: {} }], f.state);
  assert.equal(repeated.body.results[0].reply_contract, f.replyContract);
  const state = { ...f.state, ...repeated.committed, messages: [...f.state.messages, resultMessage(repeated.body)] };
  const presented = await runSteps(f.opts, speech("{read_back}"), state);
  const cursor = presented.body.results[0].awaiting as { reply_contract?: unknown };
  assert.equal(cursor.reply_contract, f.replyContract);
  assert.equal(f.executions(), 0);
});
