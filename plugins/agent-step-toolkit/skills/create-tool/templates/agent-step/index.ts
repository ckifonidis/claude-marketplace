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
  agentStepStateSpec,
  agentStepZodShape,
} from "./state.js";
export type { AwaitingInput, CurrentFlow, LibraryManagedSlots } from "./state.js";
