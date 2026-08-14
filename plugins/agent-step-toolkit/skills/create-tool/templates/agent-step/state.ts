import { Annotation } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { z } from "zod";
import type { PagedCache } from "./paginate.js";

/** Schema for the library-managed `awaitingInput` slot. This is the single
 *  source of truth: the `AwaitingInput` TS type is inferred from it, and the
 *  LangGraph annotation + Zod shape consumers spread in (`agentStepStateSpec`,
 *  `agentStepZodShape`) are built from it. Hosts must NOT re-declare this —
 *  spread the exported fragments so the slot the runner mutates can never
 *  drift from the storage the host provides.
 *
 *  Discriminated union over the three kinds of input the controller
 *  coordinates:
 *
 *  - `confirmation`: a confirm-required mutation has been proposed; the same
 *    action with matching params re-fired will execute. The library counts
 *    attempts on re-propose-with-drifted-params and exhausts the slot when the
 *    counter hits zero. Semantically: "customer must say YES."
 *  - `otp`: an action has issued an SCA challenge; the named consumer action
 *    is the only thing that may run next (besides `abort_pending_input`). The
 *    library NEVER counts OTP attempts — the backend is authoritative for
 *    lock/timeout/wrong-code. Semantically: "customer must provide OTP digits."
 *  - `match`: a capturer stored a value (PIN, password, …); the consumer must
 *    receive the same value to verify match. The library decrements
 *    `attempts_left` on each `match_mismatch` and aborts the flow on
 *    exhaustion. Semantically: "customer must provide the value AGAIN."
 *
 *  `flow_ref` ties the input to its owning flow; clearing the owning
 *  `currentFlow` clears `awaitingInput` too. No timestamps / `expires_at` —
 *  the library is a lockdown mechanism, not a state-decay manager. Stale state
 *  is cleared via `abort_pending_input` or a backend-reported error. */
export const AwaitingInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("confirmation"),
    for_action: z.string(),
    /** Params snapshot — compared (after canonicalisation) against the
     *  re-fired call to decide propose-vs-execute-vs-re-propose. */
    params: z.record(z.string(), z.unknown()),
    attempts_left: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    flow_ref: z.string().optional(),
    /** Stable identity of the caller turn on which this proposal was stored
     *  (the latest LangGraph HumanMessage id by default). A matching re-call
     *  on the SAME caller turn is refused (`confirmation_same_turn_locked`)
     *  instead of executed: legitimate confirmation always arrives on a LATER
     *  turn — after the caller actually answered the read-back. Absent when
     *  no stable identity existed at propose time (e.g. direct `runSteps`
     *  consumers without message ids), in which case the same-turn guard is
     *  deliberately unavailable rather than guessing. */
    proposed_on_caller_turn_id: z.string().min(1).optional(),
    /** Exact caller-audible rendering persisted only when the owning action
     *  opts into repeatable read-back. The repeat control returns these stored
     *  bytes; it never reconstructs the recap from params or current state. */
    read_back: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("otp"),
    /** The OTP-validating action (e.g. `confirm_otp`). */
    for_action: z.string(),
    flow_ref: z.string(),
  }),
  z.object({
    kind: z.literal("match"),
    /** The consumer action that will receive the repeated value (e.g.
     *  `commit_pin`). The capturer may also re-run to re-capture; everything
     *  else is locked. */
    for_action: z.string(),
    attempts_left: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    flow_ref: z.string().optional(),
  }),
]);

/** Schema for the library-managed `currentFlow` slot — the active multi-turn
 *  flow (PIN setup, card activation, …). One at a time, mutex by design.
 *  `data` is a flow-specific scratch bag; executors merge into it via
 *  `ExecutorResult.flowData`. */
export const CurrentFlowSchema = z.object({
  name: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/** Schema for the library-managed `boundedChoice` overlay. Unlike
 *  `awaitingInput`, this does NOT replace or unlock a confirmation/OTP/match
 *  gate: a caller-facing meta-choice may temporarily suspend the spoken
 *  question while the original gate remains authoritative underneath.
 *
 *  `pending` means the caller still owes one of the configured selections.
 *  `resolved` deliberately remains in state until the surrounding flow ends
 *  or hands off, so the same one-shot choice cannot be offered again later in
 *  the conversation. The runner is the only writer. */
export const BoundedChoiceSchema = z.object({
  name: z.string(),
  status: z.enum(["pending", "resolved"]),
  selection: z.string().optional(),
  /** Stable identity of the caller turn on which the choice was OFFERED.
   *  While that turn is current, the choice cannot be resolved and no
   *  direct-input action may consume it — the caller must actually hear the
   *  fork and reply before anything counts as their selection. */
  requested_on_caller_turn_id: z.string().min(1).optional(),
  /** Stable identity of the caller turn on which a nonterminal selection
   *  resolved (the latest LangGraph HumanMessage id by default). Domain
   *  actions remain locked while that turn is current; a later caller turn
   *  has a different id and unlocks normal processing. */
  resolved_on_caller_turn_id: z.string().min(1).optional(),
});

/** What input the customer owes right now, or `null`. Inferred from
 *  {@link AwaitingInputSchema} so the runtime schema and the compile-time type
 *  cannot diverge. */
export type AwaitingInput = z.infer<typeof AwaitingInputSchema>;

/** The active multi-turn flow, or `null`. Inferred from
 *  {@link CurrentFlowSchema}. */
export type CurrentFlow = z.infer<typeof CurrentFlowSchema>;

/** One engine-owned, one-shot conversational choice layered over any pending
 *  domain input, or `null` when no such choice has been used. */
export type BoundedChoice = z.infer<typeof BoundedChoiceSchema>;

/** Schema for the library-managed `handoff` slot — set by the built-in
 *  `request_handoff` action (enabled via `BuildAgentStepToolOptions.handoff`)
 *  and consumed by the graph-level handoff node (`createHandoffNode`), which
 *  resolves it (terminate envelope or delegate run), appends the final
 *  AIMessage, and clears the slot. Non-null means "this turn must end in a
 *  handoff instead of a model answer" — the host graph's conditional edge
 *  after the tool node checks it (see `handoffRequested`). */
export const HandoffRequestSchema = z.object({
  /** Why the conversation is being handed off: `off_topic` (the utterance is
   *  outside this agent's specialty), `completed` (the delegated task is
   *  wrapped up), or `abandon` (the user gave up / declined to continue). */
  reason: z.enum(["off_topic", "completed", "abandon"]),
  /** Per-reason payload, always in the customer's language, never empty.
   *  off_topic → the customer's request, verbatim or tightly summarized
   *  (what the receiving agent sees). completed / abandon → the closing line
   *  the agent speaks (LLM-composed — it may reference what was done); the
   *  resolver node delivers it as the final reply. */
  context: z.string().min(1),
});

/** A pending handoff request, or `null`. Inferred from
 *  {@link HandoffRequestSchema}. */
export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;

/** Schema for the library-managed `pagedRead` slot — the reslice cache for
 *  `pageable: true` reads. The runner writes it (full set + query signature +
 *  the executor's non-`items` fields) on a cache miss and re-pages from it on a
 *  same-query hit, skipping the executor. One active set at a time. */
export const PagedCacheSchema = z.object({
  key: z.string(),
  signature: z.string(),
  rows: z.array(z.unknown()),
  extras: z.record(z.string(), z.unknown()),
});

/** Schema for one entry of the library-managed `actionTrail` slot — the
 *  runner's per-task audit record of what each admitted batch actually did.
 *  One entry per step RESULT (domain steps, controls, and the synthetic
 *  `auto_handoff`), appended in order by run/finalize.ts. Deliberately a
 *  PROJECTION of the step result, never its payload: `action` + `ok` + the
 *  result's `error` code + a `proposed` marker for confirmation
 *  proposals/re-proposals (no executor ran). Params and result bodies are
 *  intentionally NOT recorded — the trail must stay PII-free by construction.
 *
 *  Two deliberate gaps, both consistent with what the runner committed:
 *  - admission-refused batches leave no trail (refusal commits NOTHING, and
 *    the trail is state like everything else);
 *  - forced handoffs (`HandoffSpec.forcedHandoff`) never reach the runner, so
 *    they never appear — the resolver node handles them without state writes. */
export const TrailEntrySchema = z.object({
  action: z.string(),
  ok: z.boolean(),
  /** The step result's `error` code, when the step failed or was refused. */
  error: z.string().optional(),
  /** True for a confirmation propose/re-propose entry: the step stored a gate
   *  and returned `needs_confirmation` — no executor ran. Distinguishes the
   *  proposal from the later execute entry of the same action name. */
  proposed: z.boolean().optional(),
});

/** One runner-recorded trail entry. Inferred from {@link TrailEntrySchema}. */
export type TrailEntry = z.infer<typeof TrailEntrySchema>;

/** The library-managed slots, as a plain shape. Any host state type the runner
 *  operates over must structurally include these (the runner constrains its
 *  generic against this so an omission is a compile error, not a runtime one). */
export interface LibraryManagedSlots {
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
  boundedChoice?: BoundedChoice | null;
  pagedRead?: PagedCache<unknown> | null;
  /** Per-guard latch: guard id → the caller-turn id it last fired on. Lets a
   *  host fire a model-input guard at most ONCE per caller turn even though the
   *  ReAct loop re-enters the model several times within that turn. Written via
   *  {@link markGuardFired}, read via {@link guardFiredOnTurn}. Entries expire
   *  by themselves when the turn id changes, so it is deliberately NOT
   *  task-scoped. */
  guardTurn?: Record<string, string> | null;
  /** One-shot social-aside deflection latch (the `deflect_aside` control):
   *  true once the free in-place deflection of THIS task has been spent, so
   *  the next `deflect_aside` escalates to a real `off_topic` handback instead
   *  of deflecting again. Task-scoped — a task-ending handback clears it. */
  deflectedAside?: boolean | null;
  handoff?: HandoffRequest | null;
  /** Consecutive backend-failure counter. The runner increments it on each
   *  batch whose failing step is a backend failure (the runner-raised
   *  `executor_error`, or an executor verdict listed in the host's
   *  `backendFailureCodes`) and resets it to 0 when a batch in which an
   *  executor ACTUALLY RAN ends without one — including a batch that fails
   *  with a recoverable user error. Batches where no executor ran (confirm-
   *  gate proposals/re-proposals, prereq or param refusals, aborts, handoff
   *  signals) are NEUTRAL — they neither increment nor reset, so a proposal
   *  interleaved between failing executes cannot wipe the streak. When the
   *  counter reaches the configured threshold (default 3) the runner
   *  auto-triggers a handoff (if a handoff path is configured) so the
   *  customer is not left in an unrecoverable error loop. */
  errorCount?: number | null;
  /** Per-task audit trail: one {@link TrailEntry} per step result of every
   *  admitted batch, in execution order, appended by run/finalize.ts. The
   *  runner is the only writer. Task-scoped — a task-ending handback clears
   *  it, so each task on a reused thread starts a fresh trail. Consumed by
   *  observability (it rides the graph state into the audit stream), never by
   *  the runner itself: no gate, control, or prompt input reads it. */
  actionTrail?: TrailEntry[] | null;
}

const replaceNull = <T>() => ({
  reducer: (_old: T | null, next: T | null) => next,
  default: () => null as T | null,
});

/** LangGraph annotation fragment for the library-managed slots. Spread into
 *  your `Annotation.Root({ … })` so the runner's `awaitingInput` / `currentFlow`
 *  writes land in slots with the correct last-writer-wins reducers:
 *
 *  ```ts
 *  export const AgentState = Annotation.Root({
 *    ...MessagesAnnotation.spec,
 *    ...agentStepStateSpec,
 *    // … your domain slots …
 *  });
 *  ```
 */
export const agentStepStateSpec = {
  awaitingInput: Annotation<AwaitingInput | null>(replaceNull<AwaitingInput>()),
  currentFlow: Annotation<CurrentFlow | null>(replaceNull<CurrentFlow>()),
  boundedChoice: Annotation<BoundedChoice | null>(replaceNull<BoundedChoice>()),
  pagedRead: Annotation<PagedCache<unknown> | null>(replaceNull<PagedCache<unknown>>()),
  guardTurn: Annotation<Record<string, string> | null>(replaceNull<Record<string, string>>()),
  deflectedAside: Annotation<boolean | null>(replaceNull<boolean>()),
  handoff: Annotation<HandoffRequest | null>(replaceNull<HandoffRequest>()),
  errorCount: Annotation<number | null>(replaceNull<number>()),
  actionTrail: Annotation<TrailEntry[] | null>(replaceNull<TrailEntry[]>()),
};

/** Zod shape fragment for the library-managed slots. Spread into the
 *  `z.object({ … })` that mirrors your state schema (e.g. for LangGraph's
 *  `stateSchema`) so the validated shape matches the annotation:
 *
 *  ```ts
 *  export const AgentStateSchema = MessagesZodState.extend({
 *    ...agentStepZodShape,
 *    // … your domain slots …
 *  });
 *  ```
 */
// NOTE: each slot is wrapped with `withLangGraph` carrying ONLY a `default` (no
// reducer → last-write-wins, identical to `agentStepStateSpec`'s replaceNull).
// The channel default is supplied via the meta `default`, NOT a zod `.default()`:
// `withLangGraph` requires the field's zod input type to equal its value type, so
// `.optional()`/`.default()` (which widen the input type with `undefined`) cannot
// be used here. `.nullable()` alone yields `T | null` in/out — matching the meta.
export const agentStepZodShape = {
  awaitingInput: withLangGraph(AwaitingInputSchema.nullable(), {
    default: (): AwaitingInput | null => null,
  }),
  currentFlow: withLangGraph(CurrentFlowSchema.nullable(), {
    default: (): CurrentFlow | null => null,
  }),
  boundedChoice: withLangGraph(BoundedChoiceSchema.nullable(), {
    default: (): BoundedChoice | null => null,
  }),
  pagedRead: withLangGraph(PagedCacheSchema.nullable(), {
    default: (): PagedCache<unknown> | null => null,
  }),
  guardTurn: withLangGraph(z.record(z.string(), z.string()).nullable(), {
    default: (): Record<string, string> | null => null,
  }),
  deflectedAside: withLangGraph(z.boolean().nullable(), {
    default: (): boolean | null => null,
  }),
  handoff: withLangGraph(HandoffRequestSchema.nullable(), {
    default: (): HandoffRequest | null => null,
  }),
  errorCount: withLangGraph(z.number().int().nonnegative().nullable(), {
    default: (): number | null => null,
  }),
  // NOTE: replace-on-write like every other library slot — the runner writes
  // the FULL accumulated array each batch (run/finalize.ts), so an append-style
  // reducer here would double entries AND make the slot unclearable by `null`.
  actionTrail: withLangGraph(z.array(TrailEntrySchema).nullable(), {
    default: (): TrailEntry[] | null => null,
  }),
};

/** The library-managed slot keys as a Zod `.omit()` mask. A host that derives a
 *  graph INPUT schema from its full state schema omits these so the internal
 *  slots can never be injected at the invoke boundary (the runner is their only
 *  writer). Single source of truth for "which slots are library-internal" —
 *  mirrors {@link agentStepZodShape} / {@link agentStepStateSpec}. */
export const agentStepInternalSlotMask = {
  awaitingInput: true,
  currentFlow: true,
  boundedChoice: true,
  pagedRead: true,
  guardTurn: true,
  deflectedAside: true,
  handoff: true,
  errorCount: true,
  actionTrail: true,
} as const;

/** The library-managed slots that are TASK-SCOPED: every one of them describes
 *  work in progress (a pending gate, an open flow, a reslice cache, the
 *  auto-handoff error counter), so a task-ENDING handback makes all of them
 *  stale by definition. `createHandoffNode` nulls these whenever it resolves a
 *  `completed`/`abandon` handback, because channel middlewares reuse ONE thread
 *  per call and never reset it — the next task on that thread would otherwise
 *  inherit the finished one's pending gates. `handoff` is absent on purpose:
 *  the node always returns it as null, resolved or not.
 *
 *  Domain slots are the host's own; it declares them via
 *  `HandoffSpec.clearsOnHandback`. */
export const agentStepTaskScopedSlots = [
  "awaitingInput",
  "currentFlow",
  "boundedChoice",
  "pagedRead",
  "deflectedAside",
  "errorCount",
  "actionTrail",
] as const satisfies readonly (keyof typeof agentStepInternalSlotMask)[];
