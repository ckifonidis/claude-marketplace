// FILE: src/agent-step/index.ts
//
// The library's public surface. Hosts import ONLY from here; the phase
// modules (compile/, run/, interaction/, controls/, handoff/) are internal
// layout, free to move without breaking consumers.

export type {
  ExecutorEffect,
  ExecutorResult,
  Executor,
  ExecutorRegistry,
  Selector,
  SelectorRegistry,
  Verifier,
  VerifierRegistry,
  ActionDef,
  ControllerHooks,
  ConfirmationOpts,
  AgentStepConfig,
  StepResult,
  RunnerResultBody,
} from "./types.js";
export { defineConfig } from "./define-config.js";
export {
  buildAgentStepTool,
  runSteps,
  REPEAT_PENDING_CONFIRMATION_ACTION,
  REQUEST_BOUNDED_CHOICE_ACTION,
  RESOLVE_BOUNDED_CHOICE_ACTION,
} from "./runner.js";
export type {
  BuildAgentStepToolOptions,
  RunResult,
  StateSchemaLike,
} from "./runner.js";
export type { AbortPolicy } from "./controls/contract.js";

// The one-shot conversational-choice overlay: authoring types live with the
// policy (interaction/bounded-choice.ts); the two controls are auto-injected
// when `BuildAgentStepToolOptions.boundedChoices` is provided.
export type {
  BoundedChoiceDef,
  BoundedChoiceRegistry,
} from "./interaction/bounded-choice.js";

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
  BoundedChoiceSchema,
  PagedCacheSchema,
  HandoffRequestSchema,
  TrailEntrySchema,
  agentStepStateSpec,
  agentStepZodShape,
  agentStepInternalSlotMask,
  agentStepTaskScopedSlots,
} from "./state.js";
export type {
  AwaitingInput,
  CurrentFlow,
  BoundedChoice,
  HandoffRequest,
  TrailEntry,
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
  forcedHandoffRequested,
} from "./handoff/contract.js";
export type {
  HandoffSpec,
  HandoffOffTopicSpec,
  HandoffDelegateTarget,
} from "./handoff/contract.js";
export { createHandoffNode } from "./handoff/node.js";

// The trigger-happy-handoff damper (`HandoffSpec.deflectAside`): one free
// in-place deflection of an out-of-scope aside per task; a repeat escalates
// atomically into the `off_topic` handback. See controls/deflect-aside.ts.
export {
  DEFLECT_ASIDE_ACTION,
  DEFLECT_ASIDE_ACTION_DESCRIPTION,
} from "./controls/deflect-aside.js";

// Caller-turn identity + the turn-scoped guard latch. `resolveCallerTurnId` is
// the library's own definition of "the current caller turn" (host hook, else
// the latest human message id) — the same identity the confirmation gate and
// the bounded-choice control use. Exported so hosts stop re-deriving it.
export { resolveCallerTurnId } from "./interaction/bounded-choice.js";
export { guardFiredOnTurn, markGuardFired } from "./interaction/guard-latch.js";

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
  digitGroupsParam,
  digitCandidatesParam,
} from "./capture.js";
export type { DigitGroupsParamOpts, DigitCandidatesParamOpts } from "./capture.js";
