// FILE: src/agent-step/run/batch-state.ts
//
// The batch's two state accumulators and the ONLY write path into them.
//
// `view` is the in-batch threaded snapshot: each applied patch folds into it so
// the next step sees fresh state. `committed` accumulates the same patches and
// becomes the LangGraph `Command.update` returned to the graph. Splitting them
// means earlier successful updates land even when a later step in the batch
// fails (cumulative commit on partial failure).
//
// Every state transition in the run pipeline goes through `apply(patch)` —
// admission, gates, controls, executor results, lifecycle. The patch builders
// below are the full vocabulary of library-slot writes; nothing else in the
// pipeline constructs a library-slot patch by hand. (The one deliberate
// exception is the finalize phase's error-counter bookkeeping, which writes
// `committed` directly — see run/finalize.ts for why.)

import type {
  AwaitingInput,
  BoundedChoice,
  CurrentFlow,
  HandoffRequest,
  LibraryManagedSlots,
} from "../state.js";
import type { PatchMerger } from "../compile/state-schema.js";

export interface BatchState<T extends LibraryManagedSlots> {
  view: Partial<T>;
  committed: Partial<T>;
  /** Fold a patch into the current view without committing it. Used when a
   *  host renderer must see the exact post-transition state before the runner
   *  can finish constructing that transition's single atomic patch. */
  preview(patch: Partial<T>): Partial<T>;
  /** Fold a patch into BOTH accumulators through the host schema's reducers. */
  apply(patch: Partial<T>): void;
}

export function createBatchState<T extends LibraryManagedSlots>(
  initialState: T,
  merge: PatchMerger<T>,
): BatchState<T> {
  const st: BatchState<T> = {
    view: merge({}, (initialState ?? {}) as Partial<T>),
    committed: {},
    preview(patch: Partial<T>) {
      return merge(st.view, patch);
    },
    apply(patch: Partial<T>) {
      st.view = merge(st.view, patch);
      st.committed = merge(st.committed, patch);
    },
  };
  return st;
}

// ─── Library-slot accessors over the threaded view ──────────────────────── //

export function getAwaitingInput<T>(view: Partial<T>): AwaitingInput | null {
  return ((view as { awaitingInput?: AwaitingInput | null }).awaitingInput) ?? null;
}

export function getCurrentFlow<T>(view: Partial<T>): CurrentFlow | null {
  return ((view as { currentFlow?: CurrentFlow | null }).currentFlow) ?? null;
}

export function getBoundedChoice<T>(view: Partial<T>): BoundedChoice | null {
  return ((view as { boundedChoice?: BoundedChoice | null }).boundedChoice) ?? null;
}

export function getHandoff<T>(view: Partial<T>): HandoffRequest | null {
  return ((view as { handoff?: HandoffRequest | null }).handoff) ?? null;
}

// ─── Patch builders ─────────────────────────────────────────────────────── //
// Each returns `Partial<T>` where `T extends LibraryManagedSlots`. The
// literal-to-Partial<T> conversion uses the up-cast variant `as Partial<T>`
// (the source is structurally a subset of the target; the up-cast is needed
// only because TypeScript can't verify generic variance over `Partial<>`).

/** Set the confirmation gate: a proposed mutation awaiting the caller's YES.
 *  `proposedOnCallerTurnId` stamps the caller turn of the proposal so a
 *  matching re-call on the SAME turn is refused instead of executed.
 *  `readBack` carries the already-rendered exact caller-audible recap only for
 *  actions which opted into repeatable read-back. */
export function setConfirmationPatch<T extends LibraryManagedSlots>(
  forAction: string,
  params: Record<string, unknown>,
  attemptsLeft: number,
  maxAttempts: number,
  proposedOnCallerTurnId: string | undefined,
  readBack?: string,
): Partial<T> {
  const awaitingInput: AwaitingInput = {
    kind: "confirmation",
    for_action: forAction,
    params,
    attempts_left: attemptsLeft,
    max_attempts: maxAttempts,
    ...(proposedOnCallerTurnId !== undefined
      ? { proposed_on_caller_turn_id: proposedOnCallerTurnId }
      : {}),
    ...(readBack !== undefined ? { read_back: readBack } : {}),
  };
  return { awaitingInput } as Partial<T>;
}

/** Open the OTP gate for the named consumer action, bound to its flow. */
export function setAwaitingOtpPatch<T extends LibraryManagedSlots>(
  forAction: string,
  flowRef: string,
): Partial<T> {
  const awaitingInput: AwaitingInput = {
    kind: "otp",
    for_action: forAction,
    flow_ref: flowRef,
  };
  return { awaitingInput } as Partial<T>;
}

/** Open (or reset) the double-entry match gate for the named consumer. */
export function setAwaitingMatchPatch<T extends LibraryManagedSlots>(
  forAction: string,
  attemptsLeft: number,
  maxAttempts: number,
  flowRef?: string,
): Partial<T> {
  const awaitingInput: AwaitingInput = {
    kind: "match",
    for_action: forAction,
    attempts_left: attemptsLeft,
    max_attempts: maxAttempts,
    ...(flowRef ? { flow_ref: flowRef } : {}),
  };
  return { awaitingInput } as Partial<T>;
}

/** Drop the pending input gate only — the flow (if any) survives. */
export function clearAwaitingInputPatch<T extends LibraryManagedSlots>(): Partial<T> {
  return { awaitingInput: null } as Partial<T>;
}

/** Drop the transient interaction slots together: the pending gate, the
 *  active flow, and (when the host opted into bounded choices) the choice
 *  overlay. Used by the unified abort control, terminal handoffs, flow end,
 *  and the `abort_flow` effect. */
export function clearInteractionPatch<T extends LibraryManagedSlots>(
  clearBoundedChoice: boolean,
): Partial<T> {
  return {
    awaitingInput: null,
    currentFlow: null,
    ...(clearBoundedChoice ? { boundedChoice: null } : {}),
  } as Partial<T>;
}

/** Set `currentFlow` to `{ name, data }` (caller passes the merged data map). */
export function setCurrentFlowPatch<T extends LibraryManagedSlots>(
  name: string,
  data: Record<string, unknown>,
): Partial<T> {
  const flow: CurrentFlow = { name, data };
  return { currentFlow: flow } as Partial<T>;
}

/** Write the bounded-choice overlay (pending or resolved). */
export function setBoundedChoicePatch<T extends LibraryManagedSlots>(
  choice: BoundedChoice,
): Partial<T> {
  return { boundedChoice: choice } as Partial<T>;
}

/** The terminal-handoff transition, shared by the built-in `request_handoff`
 *  control, the executor-level `request_handoff` effect, and the bounded
 *  choice's repeat fallback: abandon EVERY transient runner slot that could
 *  otherwise resume stale work if this graph thread is routed back to later —
 *  the pending interaction + owning flow + choice overlay, and the independent
 *  pageable-read cache — and set the `handoff` slot for the resolver node. */
export function requestHandoffPatch<T extends LibraryManagedSlots>(
  request: HandoffRequest,
  clearBoundedChoice: boolean,
): Partial<T> {
  return {
    ...clearInteractionPatch<T>(clearBoundedChoice),
    pagedRead: null,
    handoff: { reason: request.reason, context: request.context },
  } as Partial<T>;
}

// ─── stateUpdate ownership guard ────────────────────────────────────────── //

/** The slots the runner owns. An executor's `stateUpdate` may not write them —
 *  library transitions go through typed `ExecutorEffect`s so the runner can
 *  coordinate them (cleanup, ordering, overlay clearing).
 *
 *  This is deliberately NOT the whole of `agentStepInternalSlotMask`: that mask
 *  lists every library slot, while this list is only the RUNNER-owned subset.
 *  `guardTurn` is the difference — it is a library slot but it is written by the
 *  HOST's model-input guards through `markGuardFired`, never by the runner, so
 *  guarding executors against it would ban nothing the runner coordinates. Add
 *  a slot here only when the runner itself transitions it. */
const LIBRARY_MANAGED_KEYS = [
  "awaitingInput",
  "currentFlow",
  "boundedChoice",
  "pagedRead",
  "deflectedAside",
  "handoff",
  "errorCount",
  "actionTrail",
] as const;

/** Throws on a `stateUpdate` that touches a library-managed slot. A loud
 *  programmer error, not a runtime refusal: the executor code is wrong, and
 *  silently dropping (or silently honouring) the write would hide it. */
export function assertDomainOnlyStateUpdate(
  actionName: string,
  stateUpdate: Record<string, unknown>,
): void {
  const offending = LIBRARY_MANAGED_KEYS.filter((k) => k in stateUpdate);
  if (offending.length > 0) {
    throw new Error(
      `agent-step: action "${actionName}" wrote library-managed slot(s) ` +
        `${offending.map((k) => `"${k}"`).join(", ")} through stateUpdate. ` +
        `Library state transitions must be requested as typed effects ` +
        `(e.g. { type: "request_handoff", request }) so the runner can apply ` +
        `them with the required cleanup.`,
    );
  }
}
