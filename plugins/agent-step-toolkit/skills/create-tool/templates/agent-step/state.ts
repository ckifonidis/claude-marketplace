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
 *  Discriminated union over the four kinds of input the controller
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
 *  - `dictation`: a step's verdict asked the customer for a fresh value (the
 *    plainest input kind — declared ON the verdict row via `VerdictDef.ask`
 *    (or DERIVED from the bouncing action's capture field), applied
 *    by the batch finalizer from the batch's FINAL entry, and made visible to
 *    the model on that entry as `standing_ask` + `ask_contract`). Unlike the
 *    three gates it does NOT lock the surface: it is the record of the
 *    standing question — capturing the answer remains the MODEL's job.
 *    Semantically: "customer owes the value the first time."
 *
 *  `flow_ref` ties the input to its owning flow; clearing the owning
 *  `currentFlow` clears `awaitingInput` too. No timestamps / `expires_at` —
 *  the library is a lockdown mechanism, not a state-decay manager. Stale state
 *  is cleared via `abort_pending_input` or a backend-reported error. */
/** The four GATE/ASK members — every kind a `choice` may SUSPEND. Kept as a
 *  named subunion so the choice member cannot nest another choice: the stack
 *  is depth-2 by construction, enforced by the schema itself. */
const GATE_AWAITING_MEMBERS = [
  z.object({
    kind: z.literal("dictation"),
    /** The action the asked-for value feeds when the customer supplies it. */
    for_action: z.string(),
    /** The param on that action that carries the capture. */
    param: z.string(),
    /** What was asked for — `digits` (a dictated number) or `text` (a free
     *  value like a person's name). Descriptive: kind-specific behavior (e.g.
     *  per-kind contracts) keys on it. */
    expects: z.enum(["digits", "text"]),
    /** The HOST-RENDERED ask bytes, stored at record time when the row's ask
     *  declares a `render` — so `repeat_pending_question` can re-present the
     *  standing question byte-exact instead of failing as ineligible (the
     *  measured 2026-08-15 stray call). Absent for model-composed asks. */
    ask_text: z.string().optional(),
    flow_ref: z.string().optional(),
  }),
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
] as const;

/** The gate/ask members ARE the whole cursor since the bounded-choice
 *  overlay's removal (3.0.0) — no kind may suspend another. */
export const AwaitingInputSchema = z.discriminatedUnion("kind", [
  ...GATE_AWAITING_MEMBERS,
]);


/** Schema for the library-managed `currentFlow` slot — the active multi-turn
 *  flow (PIN setup, card activation, …). One at a time, mutex by design.
 *  `data` is a flow-specific scratch bag; executors merge into it via
 *  `ExecutorResult.flowData`. */
export const CurrentFlowSchema = z.object({
  name: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/** What input the customer owes right now, or `null`. Inferred from
 *  {@link AwaitingInputSchema} so the runtime schema and the compile-time type
 *  cannot diverge. */
export type AwaitingInput = z.infer<typeof AwaitingInputSchema>;

/** The active multi-turn flow, or `null`. Inferred from
 *  {@link CurrentFlowSchema}. */
export type CurrentFlow = z.infer<typeof CurrentFlowSchema>;



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

/** The library-managed slots, as a plain shape. Any host state type the runner
 *  operates over must structurally include these (the runner constrains its
 *  generic against this so an omission is a compile error, not a runtime one). */
export interface LibraryManagedSlots {
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
  pagedRead?: PagedCache<unknown> | null;
  /** The UNIVERSAL bounded-patience latch (interaction/escalation.ts): two
   *  fixed keys, `bounce` (consecutive unusable captures) and `escalation`
   *  (free in-place explanations spent). Nothing is named or configured, so
   *  nothing can be shared by accident. Both keys RESET ON PROGRESS — any step
   *  that reaches its executor clears them, so friction is measured
   *  consecutively rather than cumulatively. Task-scoped on top of that: a
   *  task-ending handback clears it; an `off_topic` roundtrip does not. The
   *  name is historical (it held a per-ladder free-use map through 3.x). */
  spentLadders?: Record<string, number> | null;
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
  pagedRead: Annotation<PagedCache<unknown> | null>(replaceNull<PagedCache<unknown>>()),
  spentLadders: Annotation<Record<string, number> | null>(
    replaceNull<Record<string, number>>(),
  ),
  handoff: Annotation<HandoffRequest | null>(replaceNull<HandoffRequest>()),
  errorCount: Annotation<number | null>(replaceNull<number>()),
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
  pagedRead: withLangGraph(PagedCacheSchema.nullable(), {
    default: (): PagedCache<unknown> | null => null,
  }),
  spentLadders: withLangGraph(
    z.record(z.string(), z.number().int().nonnegative()).nullable(),
    { default: (): Record<string, number> | null => null },
  ),
  handoff: withLangGraph(HandoffRequestSchema.nullable(), {
    default: (): HandoffRequest | null => null,
  }),
  errorCount: withLangGraph(z.number().int().nonnegative().nullable(), {
    default: (): number | null => null,
  }),
};

/** ONE metadata row per library slot — the single authority every key-set
 *  artifact below derives from. Until 3.0.0 each slot lived in FIVE hand-kept
 *  mirrors (the {@link LibraryManagedSlots} interface, the annotation spec,
 *  the zod shape, the internal-slot mask, the task-scoped list) plus a sixth
 *  in run/batch-state.ts; adding or removing a slot meant editing all of them,
 *  and a missed copy type-checked fine in whichever mirror still carried it.
 *  Now: the interface, the spec and the zod shape stay hand-written (they
 *  carry per-slot TYPES and reference docs the value level cannot), but their
 *  KEY SETS are compile-locked to this table (the assignments at the bottom of
 *  this file), and every pure key-set artifact is derived.
 *
 *  - `taskScoped`: work in progress (a pending gate, an open flow, a reslice
 *    cache, a once-latch, the error counter) — a task-ENDING handback makes it
 *    stale by definition, so `createHandoffNode` nulls it on every resolved
 *    `completed`/`abandon`. `handoff` is NOT task-scoped on purpose (the node
 *    always returns it null, resolved or not).
 *  - `runnerOwned`: the runner is the slot's only writer — an executor
 *    `stateUpdate` touching it throws (run/batch-state.ts). Every current
 *    slot is runner-owned; the flag exists because history proved the
 *    exception class (the retired `guardTurn` was host-written). */
export const AGENT_STEP_SLOT_META = {
  awaitingInput: { taskScoped: true, runnerOwned: true },
  currentFlow: { taskScoped: true, runnerOwned: true },
  pagedRead: { taskScoped: true, runnerOwned: true },
  spentLadders: { taskScoped: true, runnerOwned: true },
  handoff: { taskScoped: false, runnerOwned: true },
  errorCount: { taskScoped: true, runnerOwned: true },
} as const satisfies Record<
  keyof LibraryManagedSlots,
  { taskScoped: boolean; runnerOwned: boolean }
>;

type AgentStepSlotName = keyof typeof AGENT_STEP_SLOT_META;

const agentStepSlotNames = Object.keys(AGENT_STEP_SLOT_META) as AgentStepSlotName[];

/** The library-managed slot keys as a Zod `.omit()` mask. A host that derives a
 *  graph INPUT schema from its full state schema omits these so the internal
 *  slots can never be injected at the invoke boundary (the runner is their only
 *  writer). Derived from {@link AGENT_STEP_SLOT_META}. */
export const agentStepInternalSlotMask = Object.fromEntries(
  agentStepSlotNames.map((name) => [name, true]),
) as { readonly [K in AgentStepSlotName]: true };

/** The task-scoped library slots — see {@link AGENT_STEP_SLOT_META} for what
 *  task-scoped means and which slots are deliberately excluded. Domain slots
 *  are the host's own; it declares them via `HandoffSpec.clearsOnHandback`. */
export const agentStepTaskScopedSlots: readonly AgentStepSlotName[] =
  agentStepSlotNames.filter((name) => AGENT_STEP_SLOT_META[name].taskScoped);

/** The runner-owned slots — an executor `stateUpdate` may not write them (the
 *  guard in run/batch-state.ts throws). Derived from the same table. */
export const agentStepRunnerOwnedSlots: readonly AgentStepSlotName[] =
  agentStepSlotNames.filter((name) => AGENT_STEP_SLOT_META[name].runnerOwned);

// ─── Compile-time key-locks ─────────────────────────────────────────────────
// The three hand-written per-slot artifacts must cover EXACTLY the table's
// keys, in both directions — an added or removed slot fails the build until
// every mirror follows (the same key-lock pattern the i18n catalogs use).
const _specCoversTable: Record<AgentStepSlotName, unknown> = agentStepStateSpec;
const _tableCoversSpec: Record<keyof typeof agentStepStateSpec, unknown> =
  AGENT_STEP_SLOT_META;
const _zodCoversTable: Record<AgentStepSlotName, unknown> = agentStepZodShape;
const _tableCoversZod: Record<keyof typeof agentStepZodShape, unknown> =
  AGENT_STEP_SLOT_META;
void _specCoversTable;
void _tableCoversSpec;
void _zodCoversTable;
void _tableCoversZod;
