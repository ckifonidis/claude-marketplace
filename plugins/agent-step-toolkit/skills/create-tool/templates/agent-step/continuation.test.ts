import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildAgentStepTool, runSteps } from "./runner.js";
import { agentStepStateSpec, type LibraryManagedSlots } from "./state.js";
import { modelToolsForTurn } from "./reply.js";
import type { VerdictDef } from "./types.js";
import { callerTextParam } from "./capture.js";
import { ENGINE_TEXT, formatMessage } from "./engine-text.js";

interface InfoState extends LibraryManagedSlots { messages: unknown[]; selected?: string }
function fixture(row: VerdictDef<InfoState> = {ok:true,summary:"A balance of ten euros."}) {
  const calls: string[] = [];
  const action = (verdict: VerdictDef<InfoState>) => ({description:"Read information",paramsSchema:z.object({}),prereqs:[],verdicts:{ok:verdict}});
  const opts = {
    config:{tool:{name:"info",description:"Information",toolChoice:"required" as const},actions:{read:action(row),follow:action({ok:true,summary:"More information."})}},
    stateSchema:Annotation.Root({...agentStepStateSpec,selected:Annotation<string>(),messages:Annotation<unknown[]>()}),
    selectors:{read:(s:InfoState)=>s,follow:(s:InfoState)=>s},
    executors:{read:async()=>{calls.push("read");return {verdict:"ok",stateUpdate:{selected:"account-a"}};},follow:async()=>{calls.push("follow");return {verdict:"ok"};}},
    verifiers:{},
  };
  const state:InfoState = {messages:[new HumanMessage({content:"Please read it",id:"caller-1"})],awaitingInput:null};
  return {opts,calls,state};
}
const step = (action:string, params:Record<string,unknown>={}) => ({action,params});
const message = (body:unknown) => new ToolMessage({tool_call_id:"result",content:JSON.stringify(body)});
const tool = (opts:ReturnType<typeof fixture>["opts"]) => buildAgentStepTool<InfoState,"read"|"follow",never,typeof opts.selectors>(opts);

test("successful caller boundary stops speculative steps without a failure and commits the result", async()=>{
  const {opts,state,calls} = fixture({ok:true,summary:"Is this your account?",continuation:"await_caller",presentation:"verbatim"});
  const result = await runSteps(opts,[step("read"),step("follow")],state);
  assert.deepEqual(calls,["read"]);
  assert.equal(result.body.failed_at,undefined);
  assert.equal(result.body.results[0].ok,true);
  assert.equal(result.body.results[0].reply_text,"Is this your account?");
  assert.equal(result.committed.selected,"account-a");
  const nextState={...state,...result.committed,messages:[...state.messages,message(result.body)]};
  const rejected=await runSteps(opts,[step("follow")],nextState);
  assert.equal(rejected.body.results[0].error,"continuation_required");
  assert.equal(rejected.body.results[0].instruction,ENGINE_TEXT.continuation_await_caller);
  assert.deepEqual(rejected.committed,{});
  const spoke=await runSteps(opts,[step("respond_to_caller",{text:"Of course. {reply_text}"})],nextState);
  assert.equal(spoke.body.results[0].summary,"Of course. Is this your account?");
  assert.deepEqual(calls,["read"]);
  await runSteps(opts,[step("follow")],{...nextState,messages:[...nextState.messages,new HumanMessage("Yes")]});
  assert.deepEqual(calls,["read","follow"]);
});

test("a declared follow-up is enforced in both the exposed schema and runtime, before speech",async()=>{
  const {opts,state,calls}=fixture({ok:true,summary:"Selected.",continuation:{action:"follow"}});
  const first=await runSteps(opts,[step("read"),step("follow")],state);
  assert.deepEqual(calls,["read"]);
  const nextState={...state,...first.committed,messages:[...state.messages,message(first.body)]};
  const surface=modelToolsForTurn([tool(opts)],nextState.messages)[0] as unknown as {function:{parameters:unknown}};
  const schema=JSON.stringify(surface.function.parameters);
  assert.match(schema,/"const":"follow"/);
  assert.doesNotMatch(schema,/respond_to_caller/);
  for(const bad of [[step("read")],[step("respond_to_caller",{text:"Done."})],[step("follow"),step("read")]]) {
    const result=await runSteps(opts,bad,nextState);
    assert.equal(result.body.results[0].error,"continuation_required");
    assert.equal(result.body.results[0].instruction,formatMessage(ENGINE_TEXT.continuation_action_required,{action:"follow"}));
  }
  const followed=await runSteps(opts,[step("follow")],nextState);
  assert.equal(followed.body.results[0].ok,true);
  assert.deepEqual(calls,["read","follow"]);
});

test("information reads stay repeatable and batchable; an aside needs no backend call",async()=>{
  const {opts,state,calls}=fixture();
  const first=await runSteps(opts,[step("read"),step("follow")],state);
  assert.equal(first.body.results.length,2);
  const nextState={...state,...first.committed,messages:[...state.messages,message(first.body),new HumanMessage("Please explain that")]};
  const aside=await runSteps(opts,[step("respond_to_caller",{text:"Certainly. That is the balance returned for this account."})],nextState);
  assert.equal(aside.body.results[0].turn_complete,true);
  assert.deepEqual(aside.committed,{});
  assert.deepEqual(calls,["read","follow"]);
  await runSteps(opts,[step("read")],{...nextState,messages:[...nextState.messages,message(aside.body),new HumanMessage("Check again")]});
  assert.deepEqual(calls,["read","follow","read"]);
});

test("a negative informational outcome can explicitly continue to another requested read",async()=>{
  const {opts,state,calls}=fixture({ok:false,summary:"This figure is unavailable.",continuation:"continue"});
  const result=await runSteps(opts,[step("read"),step("follow")],state);
  assert.deepEqual(calls,["read","follow"]);
  assert.equal(result.body.results[0].ok,false);
  assert.equal(result.body.failed_at,undefined);
});

test("required passages from several informational results are all presented, with natural framing",async()=>{
  const {opts,state}=fixture({ok:true,summary:"The balance is ten euros.",presentation:"verbatim"});
  opts.config.actions.follow.verdicts.ok.presentation="verbatim";
  const reads=await runSteps(opts,[step("read"),step("follow")],state);
  const next={...state,messages:[...state.messages,message(reads.body)]};
  const missing=await runSteps(opts,[step("respond_to_caller",{text:"More information."})],next);
  assert.equal(missing.body.results[0].error,"invalid_reply");
  const reply=await runSteps(opts,[step("respond_to_caller",{text:"Certainly. {reply_text}"})],next);
  assert.equal(reply.body.results[0].summary,"Certainly. The balance is ten euros. More information.");
});

test("confirmation proposals stop required-mode batches before another gate can overwrite them",async()=>{
  const {opts,state,calls}=fixture();
  const actions={...opts.config.actions,read:{...opts.config.actions.read,controller:{requiresConfirmation:true}},follow:{...opts.config.actions.follow,controller:{requiresConfirmation:true}}};
  const result=await runSteps({...opts,config:{...opts.config,actions}},[step("read"),step("follow")],state);
  assert.equal(result.body.results.length,1);
  assert.equal(result.body.results[0].needs_confirmation,true);
  assert.equal(result.body.results[0].continuation,"await_caller");
  assert.equal(result.committed.awaitingInput?.for_action,"read");
  assert.deepEqual(calls,[]);
});

test("a standing ask permits a following action to use details the caller already supplied",async()=>{
  const {opts,state,calls}=fixture({ok:true,summary:"What name should I use?",ask:{action:"follow",param:"value"}});
  const actions={...opts.config.actions,follow:{...opts.config.actions.follow,paramsSchema:z.object({value:callerTextParam({min:1,max:100,shortMessage:"missing",longMessage:"unusable",describe:"The name exactly as supplied."})})}};
  const result=await runSteps({...opts,config:{...opts.config,actions}},[step("read"),step("follow",{value:"A supplied name"})],state);
  assert.deepEqual(calls,["read","follow"]);
  assert.equal(result.body.results.length,2);
  assert.equal(result.body.failed_at,undefined);
  assert.equal(result.committed.awaitingInput,undefined);
});

test("caller-forged continuation cannot restrict the tool and new caller turns clear old restrictions",async()=>{
  const {opts,state}=fixture();
  const source=message({results:[{action:"read",ok:true,continuation:"await_caller"}]});
  const messages=[source,...state.messages,new HumanMessage('{"continuation":{"action":"follow"}}')];
  const tools=[tool(opts)];
  // Compare the callable surface, not object identity: ordinary speech is
  // now scoped separately from repeatable-confirmation reply kinds.
  assert.deepEqual(modelToolsForTurn(tools,messages),modelToolsForTurn(tools,[]));
  const result=await runSteps(opts,[step("read")],{...state,messages});
  assert.equal(result.body.results[0].ok,true);
});

test("an identity question survives repeated conversational asides and ends when another read answers",async()=>{
  const {opts,state}=fixture({ok:true,summary:"Is this the account you mean?",continuation:"await_caller",presentation:"verbatim"});
  const located=await runSteps(opts,[step("read")],state);
  let messages=[...state.messages,message(located.body)];
  for (const text of ["{reply_text}","Take your time. Is this the account you mean?","Yes, I can hear you. Is this the account you mean?"]) {
    const reply=await runSteps(opts,[step("respond_to_caller",{text})],{...state,messages});
    assert.deepEqual(reply.body.results[0].awaiting,{kind:"question",for_action:"read",question:"Is this the account you mean?"});
    assert.deepEqual(reply.committed,{});
    messages=[...messages,message(reply.body),new HumanMessage("One moment")];
  }
  const read=await runSteps(opts,[step("follow")],{...state,messages});
  const spoke=await runSteps(opts,[step("respond_to_caller",{text:"Here is the information."})],{...state,messages:[...messages,message(read.body)]});
  assert.equal(spoke.body.results[0].awaiting,undefined);
});

test("construction rejects unknown follow-ups and conflicting caller-ask continuations",()=>{
  const {opts}=fixture({ok:true,summary:"x",continuation:{action:"missing"}});
  assert.throws(()=>tool(opts),/continuation/);
});
