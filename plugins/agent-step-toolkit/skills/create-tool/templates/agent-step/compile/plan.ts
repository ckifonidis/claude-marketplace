// FILE: src/agent-step/compile/plan.ts
//
// The compile phase's product: a `CompiledPlan` — everything the run pipeline
// reads, normalized EXACTLY ONCE. Confirmation defaults, pageable resolution,
// the effective params schema (declared schema + injected page params), the
// control activation, the state-schema merger, the composed standing-ask
// contract, and the engine tolerances (measured defaults, or the deployment's
// `AGENT_STEP_*` environment overrides — ../tolerances.ts) are all computed
// here; no run-phase code ever re-derives them.
//
// `compilePlan` does NOT validate — `buildAgentStepTool` validates first
// (compile/validate.ts) and then compiles; the direct `runSteps` seam compiles
// leniently so tests can drive minimal configs.

import { z } from "zod";
import type {
  ActionDef,
  AgentStepConfig,
  AskContractSpec,
  ControllerHooks,
  ExecutorRegistry,
  VerdictDef,
  SatisfiesSpec,
  Selector,
  VerifierRegistry,
} from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import { composeAskContract } from "./ask-contract.js";
import { resolvePageable, type ResolvedPageable } from "../paginate.js";
import {
  type HandoffSpec,
} from "../handoff/contract.js";
import {
  normalizeConfirmation,
  type NormalizedConfirmation,
} from "../interaction/confirmation.js";
import {
  type AbortPolicy,
  type ControlAction,
  type ControlActivation,
} from "../controls/contract.js";
import { activeControls } from "../controls/registry.js";
import { resolveTolerances, type EngineTolerances } from "../tolerances.js";
import { composeActionDescription } from "./action-describe.js";
import { resolveActionAsks, soleCaptureField, type ResolvedAsk } from "./asks.js";
import { buildControlActivation } from "./activation.js";
import {
  buildMergerFromStateSchema,
  type PatchMerger,
  type StateSchemaLike,
} from "./state-schema.js";

// The DEFAULT backend-failure threshold lives with the other tolerances;
// re-exported here, where the option that overrides it is declared.
export { ERROR_HANDOFF_THRESHOLD } from "../tolerances.js";

export interface BuildAgentStepToolOptions<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
> {
  config: AgentStepConfig<ActionName, PrereqName>;
  /** The host's state schema — a LangGraph `Annotation.Root` OR a Zod object
   *  whose fields carry reducer/default metadata via `withLangGraph`. The
   *  library derives the intra-batch merger from each channel's reducer;
   *  `messages` is skipped. */
  stateSchema: StateSchemaLike;
  /** State selectors keyed 1:1 by action name. The runner runs the selector for
   *  the step's action and hands its return to the executor as `state`. */
  selectors: Selectors;
  /** Executors keyed 1:1 by action name. Each entry's `state` param is typed
   *  from its selector's return, so an executor that doesn't match what its
   *  selector produces fails to compile here, at the construction boundary. */
  executors: ExecutorRegistry<T, Selectors>;
  verifiers: VerifierRegistry<T>;
  /** Opt into the library-managed handoff: auto-injects the built-in
   *  `request_handoff` control (sole-step, no prereqs), which atomically clears
   *  transient interaction/flow/page state and writes the `handoff` slot. The
   *  slot is RESOLVED by the host graph's handoff node
   *  (`createHandoffNode(spec)` from handoff/node.ts) — the runner never
   *  performs the terminate/delegate I/O itself. */
  handoff?: HandoffSpec<T>;
  /** Optionally narrow the built-in abort control to an engine-enforced
   * in-domain transition. Omit for the legacy permissive/idempotent behavior. */
  abortPolicy?: AbortPolicy<Extract<keyof Selectors, string>>;
  /** Resolve a stable identity for the latest caller turn. Three protections
   *  key on it: bounded-choice resolution records it (fails closed without
   *  one), the choice's offered-this-turn lock compares against it, and the
   *  confirmation gate stamps proposals with it so a matching re-call on the
   *  SAME turn is refused instead of executed (the caller must actually
   *  answer the read-back). By default the runner uses the latest human/user
   *  message id assigned by LangGraph's MessagesAnnotation. Hosts that
   *  compact or replace messages must provide a stable non-compacted turn
   *  token. */
  getCallerTurnId?: (state: T) => string | null | undefined;
  /** Host extension of the engine's standing-ask contract frame: the measured
   *  domain reply categories spliced into the composed `ask_contract` (see
   *  compile/ask-contract.ts for the frame and the splice position). Omit to
   *  keep the generic frame. There is NO wording override for engine text —
   *  the engine owns its instruction bytes outright (engine-text.ts); hosts
   *  extend contracts through structured seams like this one. */
  askContract?: AskContractSpec;
  /** Called when the consecutive backend-failure counter reaches the threshold
   *  (`errorHandoffThreshold`, default 3). The host uses this to inject its
   *  preferred handoff signal into `update` (e.g. write a custom slot). Runs in
   *  addition to the library-managed `handoff` slot write when `handoff` is also
   *  provided — projects that use only a custom mechanism omit `handoff` and
   *  rely solely on this callback. */
  onErrorThreshold?: (update: Record<string, unknown>, state: T) => void;
  /** Executor-returned verdict `error` codes that count as a backend/network
   *  failure for the auto-handoff counter, IN ADDITION to the runner-raised
   *  `executor_error` (which always counts). List only true backend/network
   *  failures — user mistakes and business-logic refusals must NOT be listed,
   *  or the counter will escalate recoverable situations. */
  backendFailureCodes?: string[];
  /** Consecutive backend-failure batches before the runner auto-triggers a
   *  handoff. Default `ERROR_HANDOFF_THRESHOLD` (3), or the deployment's
   *  `AGENT_STEP_ERROR_HANDOFF_THRESHOLD` when this option is omitted — a
   *  value given HERE wins over the environment. (The other three tolerances
   *  — the bounce tolerance, the free explanations and the malicious limit —
   *  are deployment-level only: `AGENT_STEP_*`, see tolerances.ts.) */
  errorHandoffThreshold?: number;
}

/** Selectors and executors are registered 1:1 under their action name — no name
 *  transformation. The registry key IS the action name.
 *
 *  Loosely-typed *supertypes* of the public, per-action-typed shapes, used by
 *  the run pipeline — which indexes actions/selectors/executors by a runtime
 *  string. They are deliberate supertypes (not casts-through-unknown): any
 *  precise `SelectorRegistry` / `ExecutorRegistry` assigns to them directly.
 *  The executor `state` param and selector return are contravariant /
 *  covariant respectively, so `any` is the only param type to which every
 *  concrete slice is assignable — a real `unknown`/`{}` would reject the
 *  assignment and force an `as unknown as` double-cast. The `any` is confined
 *  to these dispatch-boundary aliases; per-action safety is enforced at the
 *  `BuildAgentStepToolOptions` construction boundary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySelector = (state: any) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExecutor = (
  params: unknown,
  state: any,
  source?: import("../types.js").SatisfiedSource,
) => Promise<import("../types.js").DeclaredExecutorResult<any>>;

/** One action with every per-action derivation resolved. */
export interface CompiledAction {
  name: string;
  description: string;
  summary?: string;
  prereqs: string[];
  controller: ControllerHooks | undefined;
  /** Normalized confirmation opts, or null when not confirm-gated. */
  confirmation: NormalizedConfirmation | null;
  /** Normalized pagination spec, or null when not pageable. */
  pageable: ResolvedPageable | null;
  /** The params schema actually validated — the declared schema, plus
   *  `page`/`pageSize` when the action is pageable. */
  effectiveSchema: z.ZodTypeAny;
  /** Row-site standing asks, keyed by ROW key (not wire code) and fully
   *  resolved (param defaulted, expects derived) — `{}` when none declared. */
  rowAsks: Record<string, ResolvedAsk>;
  /** The action's sole caller-capture field, or null. Drives the DERIVED
   *  bounce re-ask and the escalation checks. */
  captureField: { name: string; kind: "digits" | "text" } | null;
  /** Declared verdict rows for the declarative executor return shape —
   *  `{}` when none declared. */
  verdicts: Record<string, VerdictDef>;
  /** State-satisfied inputs declaration, or null. */
  satisfies: SatisfiesSpec | null;
}

export interface CompiledPlan<T extends LibraryManagedSlots> {
  toolName: string;
  toolLeadDescription: string;
  /** Compiled actions, plus the config's declaration order (the model-facing
   *  variant order). */
  actions: Record<string, CompiledAction>;
  actionOrder: string[];
  selectors: Record<string, AnySelector>;
  executors: Record<string, AnyExecutor>;
  verifiers: VerifierRegistry<T>;
  /** Which library features are on — drives control injection everywhere. */
  activation: ControlActivation;
  /** The injected controls, in registry order. */
  controls: ControlAction[];
  /** Names the run pipeline dispatches to a control instead of an executor.
   *  Always includes `abort_pending_input` (it executes even when inactive). */
  controlNames: Set<string>;
  /** Whether any feature needs the caller-turn identity (bounded choices, or
   *  a confirm-gated action's same-turn protection). When false, the host's
   *  `getCallerTurnId` hook is never consulted. */
  needsCallerTurnId: boolean;
  /** The composed standing-ask contract (engine frame + host categories),
   *  with `{action}`/`{param}` placeholders interpolated per recorded ask by
   *  the finalizer. */
  askContract: string;
  /** The config-level downstream-invalidation table (AgentStepConfig
   *  `invalidations`) — applied by the run pipeline whenever any executor's
   *  stateUpdate changes a watched slot. */
  invalidations: Record<string, string[]>;
  merge: PatchMerger<T>;
  getCallerTurnId?: (state: T) => string | null | undefined;
  backendFailureCodes: Set<string>;
  /** The engine's four bounds, resolved once at compile: the explicit
   *  `errorHandoffThreshold` option, then the `AGENT_STEP_*` environment, then
   *  the measured defaults (../tolerances.ts). */
  tolerances: EngineTolerances;
  onErrorThreshold?: (update: Record<string, unknown>, state: T) => void;
}

/** Page params the runner injects into a `pageable` action's schema, so the
 *  consumer never declares them. */
const PAGE_PARAMS = {
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
};

function effectiveParamsSchema(action: ActionDef<string>): z.ZodTypeAny {
  if (!resolvePageable(action.pageable)) return action.paramsSchema;
  const schema = action.paramsSchema;
  if (!(schema instanceof z.ZodObject)) {
    // A REFINED schema lands here too (`z.object({...}).superRefine(...)` is a
    // ZodEffects), and it cannot be page-extended: the runner injects
    // `page`/`pageSize` via `.extend()`, which only a plain object offers.
    // Keep a pageable action's params plain and move any cross-field rule into
    // the executor — hence the explicit mention rather than a bare type name.
    throw new Error(
      `agent-step: pageable action's paramsSchema must be a plain z.object so the runner can extend it with page/pageSize ` +
        `(got ${schema?.constructor?.name ?? typeof schema} — a refined schema, e.g. one carrying superRefine/exactlyOneOf, cannot be extended).`,
    );
  }
  return (schema as z.ZodObject<z.ZodRawShape>).extend(PAGE_PARAMS);
}


export function compilePlan<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
>(opts: BuildAgentStepToolOptions<T, ActionName, PrereqName, Selectors>): CompiledPlan<T> {
  if (!opts.stateSchema) {
    throw new Error("agent-step: buildAgentStepTool requires `stateSchema`.");
  }
  const rawActions = opts.config.actions as Record<string, ActionDef<string>>;
  // ONE construction site for the activation (compile/activation.ts): every
  // `xEnabled` flag is derived there, so plan and validate cannot fork.
  const activation = buildControlActivation({
    actions: rawActions,
    handoff: opts.handoff,
    abortPolicy: opts.abortPolicy,
  });
  const controls = activeControls(activation);
  const controlNames = new Set(controls.map((c) => c.name));
  // The abort control executes as a graceful no-op even when inactive.
  controlNames.add("abort_pending_input");

  const actionOrder = Object.keys(rawActions);
  const actions: Record<string, CompiledAction> = {};
  for (const name of actionOrder) {
    const def = rawActions[name];
    actions[name] = {
      name,
      // The schema variant's `.describe()` bytes: the engine-derived gate
      // marker leading, then the host semantic lead (no verdict index — see
      // compile/action-describe.ts).
      description: composeActionDescription(def),
      summary: def.summary,
      prereqs: def.prereqs,
      controller: def.controller,
      // The gate-contract context comes from the action itself, never the
      // host spec — the composed contract cannot fork from the gate it rides.
      confirmation: normalizeConfirmation(def.controller?.requiresConfirmation, {
        action: name,
        soleOnExecute: def.controller?.soleOnExecute === true,
      }),
      pageable: resolvePageable(def.pageable),
      effectiveSchema: effectiveParamsSchema(def),
      rowAsks: resolveActionAsks(name, def, opts.config.actions),
      captureField: soleCaptureField(def),
      verdicts: def.verdicts ?? {},
      satisfies: def.satisfies ?? null,
    };
  }

  return {
    toolName: opts.config.tool.name,
    toolLeadDescription: opts.config.tool.description,
    actions,
    actionOrder,
    needsCallerTurnId: actionOrder.some((name) => actions[name].confirmation !== null),
    selectors: opts.selectors as Record<string, AnySelector>,
    executors: opts.executors as Record<string, AnyExecutor>,
    verifiers: opts.verifiers,
    activation,
    controls,
    controlNames,
    askContract: composeAskContract(opts.askContract),
    invalidations: opts.config.invalidations ?? {},
    merge: buildMergerFromStateSchema<T>(opts.stateSchema),
    getCallerTurnId: opts.getCallerTurnId,
    backendFailureCodes: new Set<string>([
      "executor_error",
      ...(opts.backendFailureCodes ?? []),
      // Derived from declared verdict rows: `backendFailure: true` marks the
      // row's static `body.error` code (shape validated at construction).
      ...actionOrder.flatMap((name) =>
        Object.values(actions[name].verdicts)
          .filter((row) => row.backendFailure)
          .map((row) => row.body?.error as string),
      ),
    ]),
    tolerances: resolveTolerances(undefined, {
      errorHandoffThreshold: opts.errorHandoffThreshold,
    }),
    onErrorThreshold: opts.onErrorThreshold,
  };
}
