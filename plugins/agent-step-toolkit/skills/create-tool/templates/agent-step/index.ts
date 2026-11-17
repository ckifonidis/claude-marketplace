// FILE: src/agent-step/index.ts
//
// The library's public surface. Hosts import ONLY from here; the phase
// modules (compile/, run/, interaction/, controls/, handoff/) are internal
// layout, free to move without breaking consumers.

export type {
  ExecutorEffect,
  Executor,
  ExecutorRegistry,
  Selector,
  SelectorRegistry,
  Verifier,
  VerifierRegistry,
  ActionDef,
  ControllerHooks,
  ConfirmationOpts,
  DeclaredExecutorResult,
  DictationAsk,
  GateContractSpec,
  VerdictDef,
  AgentStepConfig,
  StepResult,
  RunnerResultBody,
} from "./types.js";
export { composeGateContract } from "./compile/gate-contract.js";
export type { GateContractContext } from "./compile/gate-contract.js";
export { defineConfig } from "./define-config.js";
export {
  buildAgentStepTool,
  runSteps,
  REPEAT_PENDING_QUESTION_ACTION,
} from "./runner.js";
export type {
  BuildAgentStepToolOptions,
  RunResult,
  StateSchemaLike,
} from "./runner.js";
export type { AbortPolicy } from "./controls/contract.js";

// Runner-emitted system `summary` strings. Neutral English defaults live in the
// library; a host overrides them via `BuildAgentStepToolOptions.messages` (e.g.
// localized / voice-safe wording). The library never imports host strings.
export { DEFAULT_SYSTEM_MESSAGES, resolveSystemMessages } from "./messages.js";
export type { SystemMessages } from "./messages.js";

// Library-managed state slots. Consumers spread `agentStepStateSpec` into their
// `Annotation.Root` and `agentStepZodShape` into their Zod state schema rather
// than hand-rolling storage for the slots the runner mutates.
export {
  AwaitingInputSchema,
  CurrentFlowSchema,
  PagedCacheSchema,
  HandoffRequestSchema,
  agentStepStateSpec,
  agentStepZodShape,
  agentStepInternalSlotMask,
  AGENT_STEP_SLOT_META,
  agentStepTaskScopedSlots,
  agentStepRunnerOwnedSlots,
} from "./state.js";
export type {
  AwaitingInput,
  CurrentFlow,
  HandoffRequest,
  LibraryManagedSlots,
} from "./state.js";

// Handoff: the built-in `request_handoff` control is auto-injected by the
// runner when `BuildAgentStepToolOptions.handoff` is provided. It abandons
// transient runner state and writes the `handoff` slot atomically. The host
// graph resolves the slot with a node built by `createHandoffNode(spec)`, wired
// after the tool node behind the `handoffRequested` edge predicate, with a
// direct edge to END.
export {
  HANDOFF_ACTION,
  HANDOFF_NODE,
  HANDOFF_ACTION_DESCRIPTION,
  HANDBACK_SIGNALS,
  handoffParamsSchema,
  handoffRequested,
} from "./handoff/contract.js";
export type {
  HandoffSpec,
  HandoffOffTopicSpec,
  HandoffDelegateTarget,
} from "./handoff/contract.js";
export { createHandoffNode } from "./handoff/node.js";

// Engine-owned escalation ladders (journey-engine G7): configured "once"
// counters (`BuildAgentStepToolOptions.ladders`) behind the `note_refusal`
// control; exhaustion escalates atomically into each ladder's configured
// handoff. See controls/note-refusal.ts.
export { NOTE_REFUSAL_ACTION } from "./controls/note-refusal.js";

// The engine-composed protocol prompt fragment: the machinery text hosts
// splice into their system prompt instead of hand-rolling it. See
// compile/protocol.ts for the ownership boundary.
export { composeProtocolPrompt } from "./compile/protocol.js";
export type { ProtocolSurface } from "./compile/protocol.js";
export type {
  EscalationLadder,
  LadderRegistry,
  SpentLadders,
} from "./controls/note-refusal.js";

// Caller-turn identity + the turn-scoped guard latch. `resolveCallerTurnId` is
// the library's own definition of "the current caller turn" (host hook, else
// the latest human message id) — the same identity the confirmation gate and
// the bounded-choice control use. Exported so hosts stop re-deriving it.
export { resolveCallerTurnId } from "./interaction/turn-identity.js";

// The tool-free-reply counter: the bound on caller turns the model answers
// with NO tool call — the one path the runner cannot count, because it does
// not run. The host's model node calls it with each model reply; past the
// configured run it returns the same atomic handoff patch a spent ladder
// applies. See interaction/tool-free-reply.ts.
export {
  countToolFreeReply,
  TOOL_FREE_REPLIES_KEY,
} from "./interaction/tool-free-reply.js";
export type { ToolFreeReplyPolicy } from "./interaction/tool-free-reply.js";

// Read-pagination primitives. Pure, domain-agnostic helpers for tool read
// executors — the runner does not use them. A tool's list reads use these to
// present one uniform paginated envelope (delegate to a paging backend, or
// self-paginate via a consumer-declared cache slot of shape `PagedCache`).
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampPageSize,
  querySignature,
  pageRows,
  buildPageEnvelope,
} from "./paginate.js";
export type { PageEnvelope, PagedCache, PageableSpec } from "./paginate.js";

// Caller-digit capture primitives. Pure schema helpers for tool param
// authoring — the runner does not call them, but they encode invariants the
// runner imposes: shape rules as refinements (never `.regex()` — a JSON-Schema
// `pattern` makes the model count digits and withhold or pad the call),
// count-free refinement messages (issue text rides `_debug` back to the
// model), and separator-strip + singleton-collapse in the preprocess so the
// confirmation gate's parsed-params compare never reads a representation flip
// as drift. The model-facing `describe` is a REQUIRED option with no default —
// field wording is live prompt surface, owned and QA-gated per host. See
// agent-step-api.md <caller_digit_capture> for the authoring doctrine.
export {
  digitsOnly,
  digitsOnlyDeep,
  callerDigits,
  callerTextParam,
  relayParam,
  exactlyOneOf,
  digitGroupsParam,
  digitCandidatesParam,
} from "./capture.js";
export type {
  CallerTextParamOpts,
  DigitGroupsParamOpts,
  DigitCandidatesParamOpts,
} from "./capture.js";
