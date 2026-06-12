export type {
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
export { buildAgentStepTool, runSteps } from "./runner.js";
export type { BuildAgentStepToolOptions, RunResult } from "./runner.js";

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
} from "./state.js";
export type { AwaitingInput, CurrentFlow, HandoffRequest, LibraryManagedSlots } from "./state.js";

// Handoff: the built-in `request_handoff` action is auto-injected by the
// runner when `BuildAgentStepToolOptions.handoff` is provided (it only writes
// the `handoff` slot). The host graph resolves the slot with a node built by
// `createHandoffNode(spec)`, wired after the tool node behind the
// `handoffRequested` edge predicate, with a direct edge to END.
export {
  HANDOFF_ACTION,
  HANDOFF_NODE,
  HANDOFF_ACTION_DESCRIPTION,
  HANDBACK_SIGNALS,
  handoffParamsSchema,
  handoffRequested,
  createHandoffNode,
} from "./handoff.js";
export type {
  HandoffSpec,
  HandoffOffTopicSpec,
  HandoffDelegateTarget,
} from "./handoff.js";

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
