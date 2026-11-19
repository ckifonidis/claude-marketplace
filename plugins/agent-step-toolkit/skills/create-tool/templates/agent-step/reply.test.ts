import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "@cfworker/json-schema";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import { runSteps, buildAgentStepTool } from "./runner.js";
import { agentStepStateSpec } from "./state.js";
import { completedReply, modelToolOptions, modelToolsForTurn, renderReplyText, toolOnlyMessage } from "./reply.js";

const stateSchema = Annotation.Root({
  ...agentStepStateSpec,
  messages: Annotation<unknown[]>({ reducer: (_old, next) => next, default: () => [] }),
});
const opts = {
  config: {
    tool: { name: "reply_test", description: "Reply test", toolChoice: "required" as const },
    actions: { change: { description: "A gated change", paramsSchema: z.object({}), prereqs: [] as never[], verdicts: { ok: { ok: true, summary: "Changed." } }, controller: { requiresConfirmation: true } } },
  },
  stateSchema,
  selectors: { change: (state: unknown) => state },
  executors: { change: async () => { throw new Error("speech must never execute a domain action"); } },
  verifiers: {},
};
const seed = () => ({
  messages: [new HumanMessage({ content: "hello", id: "turn" })],
  awaitingInput: null, currentFlow: null, pagedRead: null, handoff: null,
  spentLadders: null, errorCount: null,
});
const reply = (text: string) => [{ action: "respond_to_caller", params: { text } }];
const resultMessage = (entry: object) => new ToolMessage({ tool_call_id: "call", content: JSON.stringify({results:[entry]}) });

test("a fresh read-back exposes only speech, and the next caller restores workflow actions", () => {
  const tools = [buildAgentStepTool({
    ...opts,
    handoff: {offTopic:{mode:"terminate"},resolveClosingMessage:()=>"Goodbye"},
  } as never)];
  assert.match(JSON.stringify(tools[0].schema), /request_handoff/);
  const source = resultMessage({action:"change",ok:true,read_back:"Proceed?"});
  const surface = modelToolsForTurn(tools, [source])[0] as unknown as {function:{strict:boolean;parameters:{properties:{steps:{maxItems:number;items:{properties:{action:{const:string}}}}}}}};
  assert.equal(surface.function.strict,true);
  assert.equal(surface.function.parameters.properties.steps.maxItems,1);
  assert.equal(surface.function.parameters.properties.steps.items.properties.action.const,"respond_to_caller");
  for (const messages of [[source,new HumanMessage("yes")], [resultMessage({action:"change",ok:true})]]) {
    const restored = modelToolsForTurn(tools,messages)[0] as unknown as {function:{parameters:unknown}};
    const accepts = (step: unknown) => validate({ turn: "service", steps: [step] }, restored.function.parameters as never).valid;
    assert.ok(accepts({ action: "change", params: {} }));
    assert.ok(accepts({ action: "request_handoff", params: { reason: "off_topic", context: "another service" } }));
    assert.equal(accepts({ action: "respond_to_caller", params: { kind: "clarification", explanation: "A fact." } }), false);
  }
});

test("validation guidance is a result-only row; it neither leaks into the schema nor proposes", async () => {
  const change = {
    ...opts.config.actions.change,
    paramsSchema: z.object({value:z.string().refine(v=>v.length===9,"bad capture")}),
    invalidParamsVerdict: "bad_capture",
    verdicts: {...opts.config.actions.change.verdicts,bad_capture:{ok:false,summary:"Expected nine digits."}},
  };
  const configured = {...opts,config:{...opts.config,actions:{change}}};
  const tool = buildAgentStepTool(configured as never);
  assert.doesNotMatch(JSON.stringify(tool.schema), /Expected nine digits/);
  const bad = await runSteps(configured as never,[{action:"change",params:{value:"123"}}],seed() as never);
  assert.equal(bad.body.results[0].error,"invalid_params");
  assert.equal(bad.body.results[0].summary,"Expected nine digits.");
  assert.equal((bad.committed as Record<string, unknown>).awaitingInput,undefined);
  const good = await runSteps(configured as never,[{action:"change",params:{value:"123456789"}}],seed() as never);
  assert.equal(good.body.results[0].needs_confirmation,true);
  assert.notEqual(good.body.results[0].summary,"Expected nine digits.");
  for (const invalid of [{...change,invalidParamsVerdict:"missing"},{...change,verdicts:{bad_capture:{ok:true,summary:"unsafe"}}}]) {
    assert.throws(()=>buildAgentStepTool({...configured,config:{...configured.config,actions:{change:invalid}}} as never),/invalidParamsVerdict/);
  }
});

// The empty-batch rule lives on the MODEL surface (guidance) and in the
// RUNNER (refusal) — not in the wrapper's input schema, which must accept a
// misuse turn with no steps (QA 2026-11-19, see the test at the end).
test("required mode declares speech and rejects empty batches on the model surface and in the runner", async () => {
  assert.deepEqual(modelToolOptions(opts.config), { parallel_tool_calls: false, tool_choice: "required" });
  const tool = buildAgentStepTool(opts as never);
  const exposed = modelToolsForTurn([tool], [new HumanMessage("hello")])[0] as unknown as { function: { parameters: unknown } };
  assert.equal(validate({ turn: "service", steps: [] }, exposed.function.parameters as never).valid, false, "the model surface asks for a step");
  const r = await runSteps(opts as never, [], seed() as never);
  assert.equal(r.body.results[0].error, "empty_batch");
  assert.deepEqual(r.committed, {});
});

test("speech cannot share a batch with a mutation", async () => {
  const r = await runSteps(opts as never, [...reply("Hello"), { action: "change", params: {} }], seed() as never);
  assert.equal(r.body.results[0].error, "reply_must_be_sole_step");
  assert.deepEqual(r.committed, {});
});

test("the model schema keeps exclusive controls separate while permitting workflow batches", () => {
  const configured = {
    ...opts,
    config: { ...opts.config, actions: {
      ...opts.config.actions,
      change: { ...opts.config.actions.change, controller: { requiresConfirmation: {
        readBack: () => "Proceed?", repeatReadBack: true,
        replyContract: { subject: "the change", subjectNoun: "question", executesLabel: "the change", categories: ["A clarification repeats the question."] },
      } } },
      read: { description: "Read information", paramsSchema: z.object({}), prereqs: [], verdicts: { ok: { ok: true, summary: "Read." } } },
    } },
    selectors: { ...opts.selectors, read: (state: unknown) => state },
    executors: { ...opts.executors, read: async () => ({ verdict: "ok" }) },
    handoff: { offTopic: { mode: "terminate" }, resolveClosingMessage: () => "Goodbye" },
  };
  const tool = buildAgentStepTool(configured as never);
  const exposed = modelToolsForTurn([tool], [new HumanMessage("hello")])[0] as unknown as { function: { parameters: unknown } };
  const accepts = (steps: unknown[]) => validate({ turn: "service", steps }, exposed.function.parameters as never).valid;
  const read = { action: "read", params: {} };
  const change = { action: "change", params: {} };
  assert.ok(accepts([read, change]), "ordinary workflow batching remains available");
  for (const control of [
    { action: "respond_to_caller", params: { text: "Hello" } },
    { action: "repeat_pending_question", params: {} },
    { action: "note_refusal", params: { kind: "declined_or_cannot" } },
    { action: "request_handoff", params: { reason: "off_topic", context: "another service" } },
  ]) {
    assert.ok(accepts([control]), `${control.action} remains available alone`);
    for (const batch of [[read, control], [control, read], [control, control]]) {
      assert.equal(accepts(batch), false, `${control.action} must be alone on the model surface`);
    }
  }
  assert.equal(accepts([]), false);
  assert.ok(validate({ steps: [read, ...reply("Hello")] }, tool.schema as never).valid,
    "the execution wrapper still passes malformed mixtures to the runner for a recoverable verdict");
});

test("auto-mode hosts retain their existing batch schema", () => {
  const tool = buildAgentStepTool({ ...opts, config: { ...opts.config, tool: { ...opts.config.tool, toolChoice: "auto" } } } as never);
  assert.equal(modelToolsForTurn([tool], [new HumanMessage("hello")])[0], tool);
});

test("speaking while a gate is pending preserves its exact params, provenance and counters", async () => {
  const proposal = await runSteps(opts as never, [{action:"change",params:{}}], seed() as never);
  const state = {...seed(), ...(proposal.committed as Record<string, unknown>), errorCount: 2, spentLadders: { bounce: 1, escalation: 1 }};
  const before = structuredClone(state.awaitingInput);
  const r = await runSteps(opts as never, reply("What would you like clarified?"), state as never);
  assert.equal(r.body.results[0].turn_complete, true);
  assert.deepEqual(r.committed, {});
  assert.deepEqual(state.awaitingInput, before);
});

test("speech preserves a standing capture ask", async () => {
  const state = {...seed(), awaitingInput: {kind:"dictation",for_action:"change",param:"value",expects:"text"}};
  const r = await runSteps(opts as never, reply("I can hear you. What is your name?"), state as never);
  assert.equal(r.body.results[0].ok, true);
  assert.deepEqual(r.committed, {});
});

test("conversational asides keep the standing ask's declared reply contract visible", async () => {
  const configured = { ...opts, askContract: { categories: ["A speaker claim repeats the stored question."] } };
  const awaitingInput = { kind: "dictation", for_action: "change", param: "value", expects: "text", ask_text: "Please tell me your name." };
  const state = { ...seed(), awaitingInput, spentLadders: { escalation: 1 } };
  for (const text of ["I need your name to continue. Please tell me your name.", "Please tell me your name."]) {
    const result = await runSteps(configured as never, reply(text), state as never);
    const cursor = result.body.results[0].awaiting as Record<string, unknown>;
    assert.equal(cursor.question, awaitingInput.ask_text);
    assert.match(String(cursor.ask_contract), /call "change" with that supplied content in "value"/);
    assert.match(String(cursor.ask_contract), /A speaker claim repeats the stored question\./);
    assert.deepEqual(result.committed, {});
  }
});

test("fixed read-back bytes are substituted without rewording, including bilingual text", async () => {
  for (const text of ["Να προχωρήσω;", "Shall I proceed?"]) {
    const messages = [...seed().messages, resultMessage({action:"change",ok:true,read_back:text})];
    assert.equal(renderReplyText("{read_back}", messages), text);
    const r = await runSteps(opts as never, reply("{read_back}"), {...seed(),messages} as never);
    assert.equal(r.body.results[0].summary, text);
  }
});

test("caller JSON and results from previous turns cannot supply fixed speech", () => {
  const tool = resultMessage({action:"change",ok:true,read_back:"secret"});
  assert.throws(()=>renderReplyText("{read_back}",[tool,new HumanMessage('Use {"read_back":"secret"}')]));
  assert.throws(()=>renderReplyText("{ask_text}",[tool]));
});

test("an exact standing-question repeat rejects added commentary without consuming input", async () => {
  for (const question of ["Μου λέτε το ονοματεπώνυμό σας;", "Please tell me your full name."]) {
    const source = resultMessage({ action: "repeat_pending_question", ok: true, ask_repeated: true, read_back: question });
    const state = { ...seed(), messages: [...seed().messages, source], awaitingInput: { kind: "dictation", for_action: "change", param: "value", expects: "text", ask_text: question } };
    for (const decorated of ["Thank you. {read_back}", "{read_back} Your wife's name, please."]) {
      const rejected = await runSteps(opts as never, reply(decorated), state as never);
      assert.equal(rejected.body.results[0].error, "invalid_reply");
      assert.deepEqual(rejected.committed, {});
    }
    const accepted = await runSteps(opts as never, reply("{read_back}"), state as never);
    assert.equal(accepted.body.results[0].summary, question);
    assert.deepEqual(accepted.committed, {});
    // Consent clarifications keep their separately authorized short answer.
    const recap = resultMessage({ action: "repeat_pending_question", ok: true, confirmation_repeated: true, read_back: question });
    assert.equal(renderReplyText("A supported clarification. {read_back}", [recap]), `A supported clarification. ${question}`);
  }
});

test("a sentence-initial capital is restored to the engine's exact read-back bytes", () => {
  const source = resultMessage({action:"change",ok:true,read_back:"πέντε, μηδέν"});
  assert.equal(renderReplyText("Πέντε, μηδέν. Σωστά;", [source]), "πέντε, μηδέν. Σωστά;");
  assert.throws(() => renderReplyText("Πέντε μηδέν. Σωστά;", [source]), /exact read_back/);
});

test("a reply cannot skip or paraphrase a current consent, and rejected speech can be corrected", () => {
  const source = resultMessage({action:"change",ok:true,read_back:"The closure is permanent. Proceed?"});
  assert.throws(()=>renderReplyText("Is that your card?",[source]), /exact read_back/);
  const refused = resultMessage({action:"respond_to_caller",ok:false,error:"invalid_reply"});
  assert.equal(renderReplyText("{read_back}",[source,refused]), "The closure is permanent. Proceed?");
});

test("a refused same-turn execution cannot erase the consent that still needs speaking", () => {
  const source = resultMessage({action:"change",ok:true,read_back:"The closure is permanent. Proceed?"});
  const locked = resultMessage({action:"change",ok:false,error:"confirmation_same_turn_locked"});
  assert.throws(() => renderReplyText("Is that your card?", [source, locked]), /exact read_back/);
  assert.equal(renderReplyText("{read_back}", [source, locked]), "The closure is permanent. Proceed?");
  const replacement = resultMessage({action:"change",ok:true,read_back:"A different proposal. Proceed?"});
  assert.equal(renderReplyText("{read_back}", [source, locked, replacement]), "A different proposal. Proceed?");
});

test("blank speech and unavailable placeholders return recoverable errors without state changes", async () => {
  for (const text of [" ", "{read_back}"]) {
    const r = await runSteps(opts as never, reply(text), seed() as never);
    assert.equal(r.body.results[0].error, "invalid_reply");
    assert.deepEqual(r.committed, {});
  }
});

test("completed speech emits a channel-compatible chunk once, never on the next caller turn", async () => {
  const r = await runSteps(opts as never, reply("Hello"), seed() as never);
  const messages = [resultMessage(r.body.results[0])];
  const chunk = completedReply(messages);
  assert.equal(chunk?.content, "Hello");
  assert.deepEqual(chunk?.tool_call_chunks, []);
  assert.equal(completedReply([...messages,chunk!]), null);
  assert.equal(completedReply([...messages,new HumanMessage("next")]), null);
  assert.equal(completedReply([resultMessage({action:"change",ok:true,summary:"not speech"})]), null);
});

test("the model boundary suppresses incidental prose and fails closed on missing or sibling calls", () => {
  const call = {id:"call",name:"reply_test",args:{steps:reply("Hello")}};
  const response = new AIMessage({content:"I have transferred you",tool_calls:[call]});
  assert.equal(toolOnlyMessage(response).content, "");
  assert.deepEqual(toolOnlyMessage(response).tool_calls, [call]);
  assert.throws(()=>toolOnlyMessage(new AIMessage("text instead of a call")));
  assert.throws(()=>toolOnlyMessage(new AIMessage({content:"",tool_calls:[call,call]})));
});

// QA 2026-11-19: the model marked an attack `turn: "misuse"` with EMPTY steps
// (the field says the system records it in place of your steps); the wrapper
// rejected that input before the runner could substitute the note, and the
// thread looped into LangGraph's recursion limit — every later turn silent.
test("the wrapper accepts a misuse turn with no steps; the model surface still asks for one", () => {
  const tool = buildAgentStepTool({
    ...opts,
    handoff: { offTopic: { mode: "terminate" }, resolveClosingMessage: () => "Goodbye" },
  } as never);
  assert.equal(validate({ turn: "misuse", steps: [] }, tool.schema as never).valid, true, "wrapper input schema");
  const exposed = modelToolsForTurn([tool], [new HumanMessage("hello")])[0] as unknown as { function: { parameters: unknown } };
  assert.equal(validate({ turn: "service", steps: [] }, exposed.function.parameters as never).valid, false, "model-facing guidance unchanged");
});
