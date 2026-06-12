import { Annotation } from "@langchain/langgraph";
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
  handoff?: HandoffRequest | null;
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
  handoff: Annotation<HandoffRequest | null>(replaceNull<HandoffRequest>()),
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
export const agentStepZodShape = {
  awaitingInput: AwaitingInputSchema.nullable().optional().default(null),
  currentFlow: CurrentFlowSchema.nullable().optional().default(null),
  pagedRead: PagedCacheSchema.nullable().optional().default(null),
  handoff: HandoffRequestSchema.nullable().optional().default(null),
};
