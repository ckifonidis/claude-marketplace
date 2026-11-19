// FILE: src/agent-step/interaction/otp.ts
//
// The OTP gate: an `issuesOtp` action mints an SCA challenge (reported via the
// `otp_issued` effect); the named consumer action is then the only thing that
// may run until the gate clears. Policy summary:
//
//   - Lockdown: ALWAYS on while pending — no opt-out (unlike confirmation).
//   - Attempts: the library NEVER counts OTP attempts. The backend is
//     authoritative for lock/timeout/wrong-code; the executor surfaces those
//     as `clear_awaiting_input` (gate dead, flow continues) or `abort_flow`
//     (terminal) effects.
//   - Freshness: the consumer check reads the LIVE in-batch view, so the
//     legitimate same-batch `[consumer, issuer]` chain works (the consumer
//     clears the match gate, then the issuer opens the OTP gate). Contrast
//     with the match gate, which freezes at batch start (interaction/match.ts).
//   - Ordering invariant: at most one input gate at a time, match THEN otp —
//     see `refuseOtpIssueWhileMatchPending`.

import type { ControllerHooks, StepResult } from "../types.js";
import type { AwaitingInput } from "../state.js";
import { ENGINE_TEXT, formatMessage } from "../engine-text.js";

/** Refusal for a `requiresOtp` action running with no OTP gate pending for it
 *  in the LIVE view, or `null` when the gate is satisfied. */
export function refuseOtpNotPending(
  actionName: string,
  controller: ControllerHooks | undefined,
  liveAwaiting: AwaitingInput | null,
): StepResult | null {
  if (!controller?.requiresOtp) return null;
  const gated =
    !!liveAwaiting &&
    liveAwaiting.kind === "otp" &&
    liveAwaiting.for_action === actionName;
  if (gated) return null;
  return {
    action: actionName,
    ok: false,
    instruction: formatMessage(ENGINE_TEXT.otp_not_pending, { action: actionName }),
    error: "otp_not_pending",
  };
}

/** Refusal for an `issuesOtp` action while a double-entry match is still
 *  pending in the LIVE view AND that match belongs to a DIFFERENT action, or
 *  `null` when issuing is allowed.
 *
 *  Enforces the ordering invariant "at most one input gate at a time, match
 *  THEN otp": the match consumer must clear the match before any OTP is
 *  issued. Without this, a single batch like `[capturer, issuer]` would
 *  open+send the OTP and OVERWRITE the still-pending match gate, skipping the
 *  consumer (the second entry) entirely. Uses the LIVE view (not batch-start)
 *  so the legitimate `[consumer, issuer]` batch still works — the consumer
 *  clears the match earlier in the same batch, so by the time the issuer runs
 *  no match is pending. Checked PRE-execution so the executor's side effect
 *  (e.g. sending a code) never fires on refusal. */
export function refuseOtpIssueWhileMatchPending(
  actionName: string,
  controller: ControllerHooks | undefined,
  liveAwaiting: AwaitingInput | null,
): StepResult | null {
  if (!controller?.issuesOtp) return null;
  if (!liveAwaiting || liveAwaiting.kind !== "match") return null;
  // The match CONSUMER may issue. A match gate names its consumer in
  // `for_action`, so when the issuer IS that consumer the hazard this guard
  // exists for cannot arise: the consumer is running right now and clears the
  // gate as it does, so no OTP overwrites a match whose consumer never ran.
  // Refusing it would forbid the legitimate "confirming the value sends the
  // code" shape — one action that consumes the repeat AND issues.
  if (liveAwaiting.for_action === actionName) return null;
  return {
    action: actionName,
    ok: false,
    instruction: formatMessage(ENGINE_TEXT.otp_blocked_match_pending, {
      action: actionName,
      match_action: liveAwaiting.for_action,
    }),
    error: "otp_blocked_match_pending",
  };
}
