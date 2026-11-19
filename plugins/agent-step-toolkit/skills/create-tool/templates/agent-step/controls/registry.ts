// FILE: src/agent-step/controls/registry.ts
//
// The ordered control registry. ORDER IS MODEL-FACING SURFACE: it fixes the
// sequence of injected schema variants and description lines (abort → handoff
// → repeat question → bounded-choice request → bounded-choice resolve).
// Do not reorder without re-verifying the model-facing golden.
//
// Exclusivity groups are likewise evaluated in their declared order at
// admission: a batch mixing a handoff with a choice control is attributed to
// the handoff group.

import { ENGINE_TEXT, formatMessage } from "../engine-text.js";
import type { ControlAction, ControlActivation, ExclusivityGroup } from "./contract.js";
import { abortControl, ABORT_ACTION } from "./abort.js";
import { requestHandoffControl } from "./request-handoff.js";
import {
  repeatPendingQuestionControl,
  REPEAT_PENDING_QUESTION_ACTION,
} from "./repeat-question.js";
import { noteRefusalControl, NOTE_REFUSAL_ACTION } from "./note-refusal.js";
import { HANDOFF_ACTION } from "../handoff/contract.js";

export const CONTROL_REGISTRY: readonly ControlAction[] = [
  abortControl,
  requestHandoffControl,
  repeatPendingQuestionControl,
  // Appended LAST deliberately: injection order is model-facing surface, and
  // the damper must not shift the four established variants.
  // Same rule: each later addition appends after the established variants.
  noteRefusalControl,
];

// All three groups share ENGINE_TEXT.must_be_sole_step (their 3.x summaries
// were byte-identical; only the error codes stay per-group).
const soleStepInstruction = (foundAction: string): string =>
  formatMessage(ENGINE_TEXT.must_be_sole_step, { action: foundAction });

export const EXCLUSIVITY_GROUPS: readonly ExclusivityGroup[] = [
  {
    name: "handoff",
    memberNames: [HANDOFF_ACTION],
    errorCode: "handoff_must_be_sole_step",
    // A handoff abandons the turn, so a batch mixing it with anything else is
    // incoherent ([list_x, request_handoff] would half-execute work whose
    // result nobody will see).
    instruction: soleStepInstruction,
  },
  {
    // Group name and error code keep the historical "confirmation" vocabulary
    // deliberately (byte-pinned engine codes); the control repeats whatever
    // the cursor holds — see repeat-question.ts.
    name: "repeat-confirmation",
    memberNames: [REPEAT_PENDING_QUESTION_ACTION],
    errorCode: "repeat_confirmation_must_be_sole_step",
    // A recap is a read-only turn boundary. Mixing domain work into the same
    // batch could turn the caller's clarification into confirmation.
    instruction: soleStepInstruction,
  },
  {
    name: "ladder",
    memberNames: [NOTE_REFUSAL_ACTION],
    errorCode: "note_refusal_must_be_sole_step",
    // The turn answers a refusal, not a value — a same-batch domain step
    // would mean the model both recorded the refusal and kept working, and on
    // the exhausted path the step escalates into a handoff, which abandons
    // the turn (same incoherence as the deflect group).
    instruction: soleStepInstruction,
  },
];

/** The controls injected for this activation, in registry order. */
export function activeControls(ctx: ControlActivation): ControlAction[] {
  return CONTROL_REGISTRY.filter((c) => c.activeWhen(ctx));
}

/** Names reserved against user-defined actions for this activation. The abort
 *  control's name is ALWAYS reserved (it executes even when inactive). */
export function reservedControlNames(ctx: ControlActivation): string[] {
  const names = activeControls(ctx).map((c) => c.name);
  return names.includes(ABORT_ACTION) ? names : [ABORT_ACTION, ...names];
}

export {
  ABORT_ACTION,
  REPEAT_PENDING_QUESTION_ACTION,
};
