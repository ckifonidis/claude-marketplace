// FILE: src/agent-step/interaction/match.ts
//
// The double-entry match gate: a CAPTURER action stores the customer's first
// entry (PIN, password, …); the CONSUMER action receives the repeated value
// and the host compares them. Policy summary:
//
//   - Lockdown: ALWAYS on while pending. Besides the consumer itself, the
//     CAPTURER is also allowed as first step so the customer can re-capture
//     (enter a different first value) without aborting the flow.
//   - Attempts: the library counts MISMATCHES. The executor signals one via
//     `resultBody.verdict === "match_mismatch"` on `ok:false`; the gate's
//     `attempts_left` decrements, and exhaustion clears the gate AND aborts
//     the flow. Any other `ok:false` verdict leaves the gate alone (an
//     unrelated failure, e.g. a backend error, must not spend an attempt).
//   - Freshness: the consumer check is FROZEN AT BATCH START. A match gate is
//     a human re-affirmation (double-entry), so — like the confirmation gate's
//     same-batch-bypass protection — the repeat must arrive in a SEPARATE
//     turn. A gate the capturer opens earlier in THIS batch must NOT be
//     consumable by the consumer in the same batch. The legitimate
//     `[consumer, issuer]` batch is unaffected: the consumer's gate was opened
//     in a PRIOR turn, so it IS present at batch start.

import type { ControllerHooks, StepResult } from "../types.js";
import type { AwaitingInput, LibraryManagedSlots } from "../state.js";
import type { SystemMessages } from "../messages.js";
import { formatMessage } from "../messages.js";
import {
  clearInteractionPatch,
  setAwaitingMatchPatch,
} from "../run/batch-state.js";

/** The task-scoped `spentLadders` key carrying a consumer's SPENT mismatches —
 *  the record `abort_pending_input` and a capturer re-run cannot refund. */
export const matchLatchKey = (consumer: string): string => `match:${consumer}`;

/** Default match-attempts budget when `requiresMatch.maxAttempts` is omitted. */
export const MATCH_DEFAULT_MAX_ATTEMPTS = 3;

/** Refusal for a `requiresMatch` consumer running without a match gate for it
 *  at BATCH START, or `null` when the gate is satisfied. */
export function refuseMatchNotPending(
  actionName: string,
  controller: ControllerHooks | undefined,
  batchStartAwaiting: AwaitingInput | null,
  msgs: SystemMessages,
): StepResult | null {
  if (!controller?.requiresMatch) return null;
  const gated =
    !!batchStartAwaiting &&
    batchStartAwaiting.kind === "match" &&
    batchStartAwaiting.for_action === actionName;
  if (gated) return null;
  const summary = formatMessage(msgs.match_not_pending, {
    action: actionName,
    capturer: controller.requiresMatch.capturer,
  });
  return { action: actionName, ok: false, summary, error: "match_not_pending" };
}

/** Outcome of the mismatch lifecycle on an `ok:false` consumer step. */
export interface MatchMismatchOutcome<T> {
  patch: Partial<T>;
  /** Fields merged over the already-pushed step entry (decremented counter,
   *  or the exhaustion re-shape). */
  entryPatch: Record<string, unknown>;
  /** True when attempts ran out — the entry's summary changed and the caller
   *  must refresh `lastSummary`. */
  exhausted: boolean;
}

/** Handle a consumer's `ok:false` return. Only a `match_mismatch` verdict
 *  spends an attempt; anything else returns `null` (state untouched, the
 *  customer may retry). On exhaustion the gate clears and the flow aborts. */
export function matchMismatchLifecycle<T extends LibraryManagedSlots>(
  actionName: string,
  controller: ControllerHooks | undefined,
  resultBody: object,
  liveAwaiting: AwaitingInput | null,
  msgs: SystemMessages
): MatchMismatchOutcome<T> | null {
  if (!controller?.requiresMatch) return null;
  if ((resultBody as { verdict?: string }).verdict !== "match_mismatch") return null;
  // The requiresMatch prereq ensures the gate is set, but defend defensively
  // in case of unusual call paths.
  if (!liveAwaiting || liveAwaiting.kind !== "match" || liveAwaiting.for_action !== actionName) {
    return null;
  }
  const remaining = liveAwaiting.attempts_left - 1;
  if (remaining <= 0) {
    return {
      patch: clearInteractionPatch<T>(),
      entryPatch: {
        summary: formatMessage(msgs.match_attempts_exhausted, { action: actionName }),
        error: "match_attempts_exhausted",
        verdict: "match_attempts_exhausted",
        attempts_left: 0,
      },
      exhausted: true,
    };
  }
  return {
    patch: setAwaitingMatchPatch<T>(
      liveAwaiting.for_action,
      remaining,
      liveAwaiting.max_attempts,
      liveAwaiting.flow_ref,
    ),
    // Enrich the entry with the decremented counter so the LLM can quote
    // attempts_left to the customer.
    entryPatch: { attempts_left: remaining },
    exhausted: false,
  };
}
