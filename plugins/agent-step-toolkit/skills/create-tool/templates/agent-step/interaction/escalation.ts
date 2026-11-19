// FILE: src/agent-step/interaction/escalation.ts
//
// BOUNDED PATIENCE, universally. One latch, two counters, nothing to declare:
//
//   `bounce`      — consecutive captures the tool could not use.
//   `escalation`  — free in-place explanations already spent.
//
// Both are TASK-SCOPED and both RESET ON PROGRESS: the moment the caller
// actually delivers something the tool accepts (params parsed, executor ran),
// the run is over and the counters go back to zero. So friction is measured
// CONSECUTIVELY, never cumulatively over a call — a caller who stumbles, gets
// helped, and then succeeds starts fresh, while a caller who keeps not
// delivering reaches the escalation in a bounded number of turns.
//
// WHY UNIVERSAL rather than per action (owner decision): a "budget per action"
// buys nothing a reset-on-progress counter does not, and it cost a whole
// configuration surface — a named ladder registry, a `captureBounces` policy
// per action, and prompt prose naming the registry keys. Worse, the per-name
// budget was a live defect wherever two entry points shared a name: in a
// sibling host one `capture_incomplete` allowance was shared by five actions,
// so a caller who stumbled over the tax number silently lost the guided
// re-ask for the one-time code. Nothing is shared here because nothing is
// named.
//
// WHAT THE MODEL DECIDES, and all it decides: the SEMANTIC CLASS of the
// caller's turn (`note_refusal`'s two kinds). First-versus-repeat is the
// engine's, and it stays model-invisible: a count in a capture-path message
// measurably makes the model pad digits to satisfy it.
//
// THE NUMBERS themselves — how many plain bounces, how many free explanations,
// which malicious attempt ends the task — are process-wide TOLERANCES resolved
// once at construction (../tolerances.ts): measured defaults, movable per
// deployment through `AGENT_STEP_*` environment variables. That is a property
// of the deployment, not of an action: still no registry, no per-action
// budget, and no count the model can read. The functions below take the
// resolved number from their caller (the compiled plan); they read no
// environment themselves.

import type { LibraryManagedSlots } from "../state.js";
import type { StepResult } from "../types.js";
import { ENGINE_TEXT, formatMessage } from "../engine-text.js";
import type { BatchState } from "../run/batch-state.js";
import { requestHandoffPatch } from "../run/batch-state.js";

// The DEFAULT tolerances live with their resolver; re-exported here so the
// bounded-patience surface stays importable from one module.
export { BOUNCE_TOLERANCE, FREE_EXPLANATIONS, MALICIOUS_LIMIT } from "../tolerances.js";

/** The two latch keys. Fixed strings — there is nothing to name and nothing
 *  to collide with. */
export const BOUNCE_KEY = "bounce";
export const ESCALATION_KEY = "escalation";

type Latch = Record<string, number>;

const latchOf = <T extends LibraryManagedSlots>(st: BatchState<T>): Latch =>
  (st.view as { spentLadders?: Latch | null }).spentLadders ?? {};

const writeLatch = <T extends LibraryManagedSlots>(st: BatchState<T>, next: Latch): void => {
  st.apply({ spentLadders: Object.keys(next).length > 0 ? next : null } as unknown as Partial<T>);
};

/** PROGRESS: the caller delivered something the tool accepted, so the run is
 *  over. Called once per step that reaches its executor — the same event the
 *  per-action bounce run used to key on, now clearing both counters. */
export function clearOnProgress<T extends LibraryManagedSlots>(st: BatchState<T>): void {
  const latch = latchOf(st);
  if (latch[BOUNCE_KEY] === undefined && latch[ESCALATION_KEY] === undefined) return;
  const { [BOUNCE_KEY]: _b, [ESCALATION_KEY]: _e, ...rest } = latch;
  writeLatch(st, rest);
}

/** Count one unusable capture and report whether the engine should now explain
 *  itself rather than bounce plainly. `bounceTolerance` is the resolved
 *  tolerance (`plan.tolerances.bounceTolerance`): that many consecutive
 *  unusable captures get the plain rejection; the next one explains. */
export function countBounce<T extends LibraryManagedSlots>(
  st: BatchState<T>,
  bounceTolerance: number,
): { explain: boolean } {
  const latch = latchOf(st);
  const bounces = (latch[BOUNCE_KEY] ?? 0) + 1;
  writeLatch(st, { ...latch, [BOUNCE_KEY]: bounces });
  return { explain: bounces > bounceTolerance };
}

/** The exhaust route: a STRUCTURAL context carrying the action whose value the
 *  caller owed, so the host's existing context→closing table can speak the
 *  specific reassurance ("the representative can find your card without the
 *  digits") without the engine knowing any domain wording — the same shape as
 *  `AUTO_HANDOFF_CONTEXT`. `null` when nothing was owed (an off-task question
 *  with no standing value): the generic escalation closing covers that. */
export const ESCALATION_CONTEXT_PREFIX = "agent-step:escalated";

export const escalationContext = (owedAction: string | null): string =>
  owedAction ? `${ESCALATION_CONTEXT_PREFIX}:${owedAction}` : ESCALATION_CONTEXT_PREFIX;

/** MALICIOUS ATTEMPTS (owner decision 2026-11-18): the `note_refusal`
 *  `malicious_intent` attempt that reaches the limit — by default the third
 *  (`MALICIOUS_LIMIT`) — ends the call. Unlike the two counters
 *  above this one is CUMULATIVE — `clearOnProgress` never touches it — so an
 *  attacker cannot reset it by slipping an ordinary turn between attempts. It
 *  is still task-scoped (it rides the same latch slot), so the resolver's
 *  handback sweep clears it with the rest of the task. */
export const MALICIOUS_KEY = "malicious";

/** The structural context of the malicious-attempt termination — matched by
 *  the host's context→closing table like `AUTO_HANDOFF_CONTEXT`, so the engine
 *  authors no caller words. Reason `completed`: nothing for a human queue to
 *  finish; the channel ends the call. */
export const MALICIOUS_CONTEXT = "agent-step:malicious";

/** Count one malicious attempt; at the limit, request the terminating handoff
 *  atomically. `maliciousLimit` is the resolved tolerance
 *  (`plan.tolerances.maliciousLimit`). The caller owns the entry's naming;
 *  this owns every state write. */
export function countMalicious<T extends LibraryManagedSlots>(
  st: BatchState<T>,
  maliciousLimit: number,
): { terminated: true; instruction: string; reason: string } | { terminated: false } {
  const latch = latchOf(st);
  const attempts = (latch[MALICIOUS_KEY] ?? 0) + 1;
  writeLatch(st, { ...latch, [MALICIOUS_KEY]: attempts });
  if (attempts < maliciousLimit) return { terminated: false };
  const request = { reason: "completed" as const, context: MALICIOUS_CONTEXT };
  st.apply(requestHandoffPatch<T>(request));
  return {
    terminated: true,
    instruction: formatMessage(ENGINE_TEXT.handoff_requested, { reason: request.reason }),
    reason: request.reason,
  };
}

/** Spend one free explanation, or escalate when they are gone.
 *  `freeExplanations` is the resolved tolerance
 *  (`plan.tolerances.freeExplanations`). The caller owns the entry's naming;
 *  this owns every state write. */
export function climb<T extends LibraryManagedSlots>(
  st: BatchState<T>,
  owedAction: string | null,
  freeExplanations: number,
): { exhausted: true; instruction: string; reason: string } | { exhausted: false } {
  const latch = latchOf(st);
  const spent = latch[ESCALATION_KEY] ?? 0;
  if (spent >= freeExplanations) {
    const request = { reason: "abandon" as const, context: escalationContext(owedAction) };
    st.apply(requestHandoffPatch<T>(request));
    return {
      exhausted: true,
      instruction: formatMessage(ENGINE_TEXT.handoff_requested, { reason: request.reason }),
      reason: request.reason,
    };
  }
  writeLatch(st, { ...latch, [ESCALATION_KEY]: spent + 1 });
  return { exhausted: false };
}

/** The entry a spent-or-free climb produces, shared by the capture-bounce path
 *  and the `note_refusal` control so one escalation reads identically wherever
 *  it was reached from. */
export function climbEntry(
  action: string,
  outcome: { exhausted: true; instruction: string; reason: string } | { exhausted: false },
  freeInstruction: string,
  extra: Record<string, unknown> = {},
): StepResult {
  if (outcome.exhausted) {
    return {
      action,
      ok: false,
      instruction: outcome.instruction,
      escalated: true,
      handoff_requested: true,
      reason: outcome.reason,
      ...extra,
    };
  }
  // The free explanation is owed before the caller can answer again. Reuse
  // the presentation boundary so required mode cannot skip it by repeating
  // only the ask, or spend another refusal in the same caller turn.
  return { action, ok: false, instruction: freeInstruction, ...extra, continuation: "await_caller" };
}
