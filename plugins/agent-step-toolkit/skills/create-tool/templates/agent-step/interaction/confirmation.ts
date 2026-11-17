// FILE: src/agent-step/interaction/confirmation.ts
//
// The confirmation gate: a confirm-required mutation runs as a two-call
// handshake. The FIRST matching call proposes (stores params, returns
// `needs_confirmation`, does NOT execute); a later call with the SAME params
// executes; a call with DIFFERENT params re-proposes and spends one attempt.
//
// SAFETY PROPERTY — same-batch bypass. Confirm modes are assigned during plan
// expansion against the state AT BATCH START and frozen before any step runs
// (run/planning.ts). A propose written by step N therefore cannot satisfy an
// execute requested at step N+1 of the same batch: both resolve to `propose`.
// The confirming call must arrive in a NEW tool call — i.e. after the caller
// actually answered. Nothing in the execution loop re-reads pending state to
// re-derive a mode.

import type { ConfirmationOpts } from "../types.js";
import type { AwaitingInput } from "../state.js";
import type { CompiledAction } from "../compile/plan.js";
import type { GateContractContext } from "../compile/gate-contract.js";
import { composeGateContract } from "../compile/gate-contract.js";
import { valueEqual } from "../run/value-equal.js";

/** The compiled confirmation opts: every field filled, and `replyContract`
 *  always the wire STRING — a declared {@link GateContractSpec} is composed
 *  at construction, so the run pipeline never sees the spec form. */
export type NormalizedConfirmation = Omit<
  Required<ConfirmationOpts>,
  "replyContract" | "onExhaust"
> & {
  replyContract: string;
  onExhaust?: ConfirmationOpts["onExhaust"];
};

/** The task-scoped `spentLadders` key carrying an action's SPENT proposals.
 *  The gate's own `attempts_left` lives on the transient `awaitingInput` slot,
 *  which `abort_pending_input` clears — so on its own it refunded the whole
 *  budget on every bare rejection ("no" → new value → "no" … without bound).
 *  The latch survives the abort; only an execute clears it. */
export const confirmLatchKey = (action: string): string => `confirm:${action}`;

/** Applied when `requiresConfirmation: true` is set bare (no opts object) and
 *  as the fill-in for any field omitted from an explicit opts object. */
export const CONFIRMATION_DEFAULTS: NormalizedConfirmation = {
  maxAttempts: 3,
  lockdown: true,
  repeatReadBack: false,
  // No read-back by default: a host that does not render one keeps handing the
  // model raw `proposed_params`, exactly as before this option existed.
  readBack: () => undefined,
  // No framing directive by default: the read-back is spoken byte-for-byte
  // under the host prompt's single authority sentence.
  readBackDirective: () => undefined,
  // No propose-time refusal by default: every schema-valid proposal stores.
  refuseProposal: () => null,
  // Empty = the runner's generic reply-contract template governs the gate.
  replyContract: "",
};

export function normalizeConfirmation(
  v: boolean | ConfirmationOpts | undefined,
  ctx: GateContractContext,
): NormalizedConfirmation | null {
  if (!v) return null;
  if (v === true) return { ...CONFIRMATION_DEFAULTS };
  const spec = v.replyContract;
  return {
    maxAttempts: v.maxAttempts ?? CONFIRMATION_DEFAULTS.maxAttempts,
    lockdown: v.lockdown ?? CONFIRMATION_DEFAULTS.lockdown,
    repeatReadBack: v.repeatReadBack ?? CONFIRMATION_DEFAULTS.repeatReadBack,
    readBack: v.readBack ?? CONFIRMATION_DEFAULTS.readBack,
    readBackDirective: v.readBackDirective ?? CONFIRMATION_DEFAULTS.readBackDirective,
    refuseProposal: v.refuseProposal ?? CONFIRMATION_DEFAULTS.refuseProposal,
    ...(v.onExhaust ? { onExhaust: v.onExhaust } : {}),
    replyContract: spec ? composeGateContract(spec, ctx) : CONFIRMATION_DEFAULTS.replyContract,
  };
}

/** Does this raw controller declaration opt into the repeat-read-back
 *  control? Kept here with normalization so compile and construction-time
 *  validation derive activation from one interpretation. */
export function repeatReadBackEnabled(
  v: boolean | ConfirmationOpts | undefined,
): boolean {
  return typeof v === "object" && v.repeatReadBack === true;
}

/** The pending confirmation as plan expansion needs it, or null when the
 *  awaiting gate is absent or of another kind. */
export interface PendingConfirmation {
  action: string;
  params: Record<string, unknown>;
  attemptsLeft: number;
  /** Caller turn on which the proposal was stored, when an identity existed. */
  proposedOnCallerTurnId?: string;
}

export function pendingConfirmationOf(
  awaiting: AwaitingInput | null,
): PendingConfirmation | null {
  if (!awaiting || awaiting.kind !== "confirmation") return null;
  return {
    action: awaiting.for_action,
    params: awaiting.params,
    attemptsLeft: awaiting.attempts_left,
    proposedOnCallerTurnId: awaiting.proposed_on_caller_turn_id,
  };
}

/** Drives the "did the customer re-call with the SAME params?" decision —
 *  matching params means propose → execute; drifted params means re-propose
 *  (decrement attemptsLeft). The pending side was stored PARSED (schema
 *  preprocess applied), so the incoming RAW params are parsed with the same
 *  schema before comparing — value normalization (e.g. a `z.preprocess`
 *  stripping STT separators: "70,76" ≡ "7076") must never read as drift.
 *  A failed parse counts as drift; the re-propose branch then surfaces
 *  `invalid_params`. */
export function paramsMatchPending(
  action: CompiledAction,
  pendingParams: unknown,
  rawIncoming: unknown,
): boolean {
  const parsed = action.effectiveSchema.safeParse(rawIncoming);
  if (!parsed.success) return false;
  return valueEqual(pendingParams, parsed.data);
}

/** Confirm-mode state machine assigned during plan expansion:
 *  - `propose`: no pending exists for this action → store params, return
 *    needs_confirmation, do NOT call executor. The attempts counter starts
 *    from what the task has already SPENT on this action (`proposalsSpent`),
 *    not from the full budget — an aborted proposal stays spent.
 *  - `rePropose`: pending exists with different params → overwrite params,
 *    decrement attemptsLeft, return needs_confirmation.
 *  - `execute`: pending exists with matching params, stored on an EARLIER
 *    caller turn → clear pending, run the executor.
 *  - `sameTurnLocked`: pending exists with matching params, but the proposal
 *    was stored on the CURRENT caller turn — the caller has not yet answered
 *    the read-back, so executing would be the model confirming itself.
 *    Refused without spending an attempt; the gate stays untouched. Enforced
 *    only when BOTH the stored and the current turn identity exist (production
 *    always has message ids; identity-less direct consumers keep the
 *    params-only behavior rather than being locked out of confirmation).
 *  - `exhausted`: the budget is spent — a drifted call over a pending with
 *    `attemptsLeft <= 0`, or a fresh proposal after more than `maxAttempts`
 *    spent ones → clear pending and escalate (run/execution.ts).
 *
 *  Actions without `requiresConfirmation` skip this machine entirely — they
 *  run as a normal single step (subject to `soleStep`). */
export type ConfirmMode =
  | "propose"
  | "rePropose"
  | "execute"
  | "sameTurnLocked"
  | "exhausted";

export interface ConfirmDecision {
  mode: ConfirmMode;
  /** For propose / rePropose: the attempts counter to store on the gate. */
  attemptsLeft?: number;
}

/** Resolve one step's confirm mode against the batch-start pending gate. */
export function decideConfirmMode(
  action: CompiledAction,
  pending: PendingConfirmation | null,
  rawParams: unknown,
  currentCallerTurnId: string | undefined,
  /** Proposals this task already stored for the action without executing
   *  (the `confirmLatchKey` latch at batch start). */
  proposalsSpent = 0,
): ConfirmDecision {
  const confirm = action.confirmation;
  if (!confirm) {
    throw new Error(
      `agent-step: decideConfirmMode called for "${action.name}" which is not confirm-gated.`,
    );
  }
  if (!pending || pending.action !== action.name) {
    return proposalsSpent > confirm.maxAttempts
      ? { mode: "exhausted" }
      : { mode: "propose", attemptsLeft: confirm.maxAttempts - proposalsSpent };
  }
  if (paramsMatchPending(action, pending.params, rawParams)) {
    const sameTurn =
      pending.proposedOnCallerTurnId !== undefined &&
      currentCallerTurnId !== undefined &&
      pending.proposedOnCallerTurnId === currentCallerTurnId;
    return sameTurn ? { mode: "sameTurnLocked" } : { mode: "execute" };
  }
  if (pending.attemptsLeft > 0) {
    return { mode: "rePropose", attemptsLeft: pending.attemptsLeft - 1 };
  }
  return { mode: "exhausted" };
}
