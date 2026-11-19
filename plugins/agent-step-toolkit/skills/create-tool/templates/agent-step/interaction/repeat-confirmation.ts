import type { AwaitingInput, LibraryManagedSlots } from "../state.js";
import type { ControlRunContext } from "../controls/contract.js";
import { getAwaitingInput, setConfirmationPatch } from "../run/batch-state.js";
import { ENGINE_TEXT } from "../engine-text.js";

/** One eligibility check for explicit repetition and engine-composed
 * clarification replies. Only stored, opted-in consent text is reusable. */
export function repeatableConfirmation<T extends LibraryManagedSlots>(ctx: ControlRunContext<T>) {
  const pending = getAwaitingInput(ctx.state.view);
  return pending?.kind === "confirmation" &&
    ctx.activation.repeatableConfirmationActions.includes(pending.for_action) &&
    typeof pending.read_back === "string" && pending.read_back.length > 0
    ? pending as Extract<AwaitingInput, { kind: "confirmation" }> & { read_back: string }
    : null;
}

/** Prepare, but do not commit, re-presentation of the exact pending consent.
 * Callers validate their entire reply before applying the patch, so rejected
 * speech cannot advance the consent boundary. */
export function prepareConfirmationRepeat<T extends LibraryManagedSlots>(ctx: ControlRunContext<T>):
  | { ok: true; forAction: string; readBack: string; patch: Partial<T> }
  | { ok: false; error: string; instruction: string } {
  const pending = repeatableConfirmation(ctx);
  if (!pending) {
    return { ok: false, error: "repeat_confirmation_not_available", instruction: ENGINE_TEXT.repeat_not_available };
  }
  const proposedTurnId = pending.proposed_on_caller_turn_id;
  if (!proposedTurnId || !ctx.currentCallerTurnId) {
    return { ok: false, error: "repeat_confirmation_turn_identity_unavailable", instruction: ENGINE_TEXT.repeat_identity_unavailable };
  }
  if (proposedTurnId === ctx.currentCallerTurnId) {
    return { ok: false, error: "repeat_confirmation_same_turn_locked", instruction: ENGINE_TEXT.repeat_same_turn_locked };
  }
  return {
    ok: true, forAction: pending.for_action, readBack: pending.read_back,
    patch: setConfirmationPatch<T>(
      pending.for_action, pending.params, pending.attempts_left, pending.max_attempts,
      ctx.currentCallerTurnId, pending.read_back,
    ),
  };
}
