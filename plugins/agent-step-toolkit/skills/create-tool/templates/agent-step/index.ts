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
  AskContractSpec,
  ControllerHooks,
  ConfirmationOpts,
  DeclaredExecutorResult,
  RowAsk,
  GateContractSpec,
  VerdictDef,
  SatisfiesSpec,
  SatisfiedSource,
  AgentStepConfig,
  StepResult,
  RunnerResultBody,
} from "./types.js";
export { composeGateContract } from "./compile/gate-contract.js";
export type { GateContractContext } from "./compile/gate-contract.js";
export { composeAskContract } from "./compile/ask-contract.js";
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
// Required-call mode (`config.tool.toolChoice: "required"`): the host binds
// `modelToolsForTurn(tools, messages)` with `modelToolOptions(config)`, wraps
// the response in `toolOnlyMessage`, and delivers `completedReply` from its
// agent node. reply.ts states the wiring and what the mode assumes of the host.
export { completedReply, modelToolOptions, modelToolsForSpeech, modelToolsForTurn, renderReplyText, speechOwed, speechToolOptions, spokenMessage, toolOnlyMessage, RESPOND_TO_CALLER_ACTION } from "./reply.js";
// The required-mode turn classification as it appears in the tool call's
// arguments — exported so a host harness that scripts or records calls reads
// the wire names from the library instead of mirroring the literals.
export { TURN_FIELD, TURN_MISUSE, TURN_SERVICE } from "./compile/schema.js";

// Engine instruction text (4.0.0): every runner-emitted string is a
// MODEL-FACING instruction the engine owns outright — there is no wording
// override. Caller-audible text is host-rendered from state (verdict
// summaries, read-backs, ask renders, handoff closings); host doctrine
// extends engine frames through structured seams (GateContractSpec,
// AskContractSpec, toolTurnRules). Exported for goldens and tests,
// never for overriding. See engine-text.ts for the register doctrine.
export { ENGINE_TEXT, formatMessage } from "./engine-text.js";
export type { EngineTextKey } from "./engine-text.js";

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
  AUTO_HANDOFF_CONTEXT,
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

// Bounded patience, universal and undeclared: one task-scoped latch counting
// unusable captures and free explanations, RESET ON PROGRESS, behind the
// `note_refusal` control. Exhaustion escalates atomically into a structural
// abandon context naming the action whose value was owed, which the host's own
// context→closing table maps to caller words. See interaction/escalation.ts.
export { NOTE_REFUSAL_ACTION } from "./controls/note-refusal.js";
export {
  ESCALATION_CONTEXT_PREFIX,
  escalationContext,
  // The `malicious_intent` note that reaches the limit ends the call through
  // this structural context (cumulative, never reset by progress).
  MALICIOUS_CONTEXT,
} from "./interaction/escalation.js";

// The engine TOLERANCES — the four numbers behind bounded patience and the
// backend-failure auto-handoff. The constants are the MEASURED DEFAULTS; a
// deployment may move them through `AGENT_STEP_*` environment variables
// (`TOLERANCE_ENV`), read once at construction and validated loudly. There is
// no per-action or per-tool setting. `resolveTolerances` is exported so a host
// can log the effective values at boot. See tolerances.ts.
export {
  BOUNCE_TOLERANCE,
  FREE_EXPLANATIONS,
  MALICIOUS_LIMIT,
  ERROR_HANDOFF_THRESHOLD,
  DEFAULT_TOLERANCES,
  TOLERANCE_ENV,
  resolveTolerances,
} from "./tolerances.js";
export type { EngineTolerances, ToleranceEnv } from "./tolerances.js";

// The engine-composed protocol prompt fragment: the machinery text hosts
// splice into their system prompt instead of hand-rolling it. See
// compile/protocol.ts for the ownership boundary.
export { composeProtocolPrompt } from "./compile/protocol.js";
export type { ProtocolSurface } from "./compile/protocol.js";
export type { RefusalKind } from "./controls/note-refusal.js";
export { REFUSAL_KINDS } from "./controls/note-refusal.js";

// Caller-turn identity + the turn-scoped guard latch. `resolveCallerTurnId` is
// the library's own definition of "the current caller turn" (host hook, else
// the latest human message id) — the same identity the confirmation gate and
// the bounded-choice control use. Exported so hosts stop re-deriving it.
export { resolveCallerTurnId } from "./interaction/turn-identity.js";

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
  judgedEnum,
  judgedFlag,
  exactlyOneOf,
  digitGroupsParam,
  digitCandidatesParam,
  fieldKindOf,
  fieldMetaOf,
  objectShapeOf,
  captureFieldsOf,
} from "./capture.js";
export type {
  CallerTextParamOpts,
  DigitGroupsParamOpts,
  DigitCandidatesParamOpts,
  FieldKind,
  FieldMeta,
} from "./capture.js";
