// FILE: src/agent-step/controls/repeat-question.ts
//
// Repeat the engine-stored exact presentation of the pending question — the
// one control for the whole cursor (renamed from repeat_pending_confirmation
// when it generalized to choices, 2026-08-15):
//
//   - a pending CONFIRMATION on an eligible (repeatable) action: re-present
//     its stored `read_back` bytes. No executor runs, no re-render from
//     mutable state, no params/attempts change, and the gate is not consumed.
//     Advances the gate's presentation-turn provenance: the repeated question
//     is now the question the caller must answer on a LATER turn, so a second
//     ReAct call cannot answer it on the caller's behalf.
//   - a standing DICTATION whose record stores host-rendered `ask_text`:
//     re-present those bytes. This branch is a SAFETY NET, not an invitation —
//     the control's describe still says "at a standing value ask, do NOT call
//     this" (that instruction and the ask-contract category are the measured
//     authorities, and the describe's static bytes are measured-brittle:
//     2026-08-15, two guards re-tipped under describe edits alone). When the
//     model strays anyway — the exact 2026-08-15 failure, which then hit an
//     ineligibility ERROR — it now gets the standing question's bytes back
//     instead. Nothing to re-stamp: a dictation is non-locking, nothing
//     executes off it.
//
// (The bounded-choice repeat branch left with the bounded-choice controls.)

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import {
  getAwaitingInput,
  setConfirmationPatch,
} from "../run/batch-state.js";
import { ENGINE_TEXT, formatMessage } from "../engine-text.js";
import type {
  ControlAction,
  ControlOutcome,
  ControlRunContext,
} from "./contract.js";

export const REPEAT_PENDING_QUESTION_ACTION = "repeat_pending_question";

/** The repeatable shapes for this activation, in model-facing words. */
function repeatableShapes(ctx: {
  repeatableConfirmationActions: readonly string[];
}): string[] {
  const shapes: string[] = [];
  if (ctx.repeatableConfirmationActions.length > 0) {
    const repeatable = ctx.repeatableConfirmationActions
      .map((name) => `\`${name}\``)
      .join(", ");
    shapes.push(`a pending ${repeatable} confirmation's read-back`);
  }
  return shapes;
}

export const repeatPendingQuestionControl: ControlAction = {
  name: REPEAT_PENDING_QUESTION_ACTION,
  activeWhen: (ctx) => repeatableShapes(ctx).length > 0,
  schemaVariant: (ctx) => {
    const shapes = repeatableShapes(ctx).join(", or ");
    return z
      .object({
        action: z.literal(REPEAT_PENDING_QUESTION_ACTION),
        params: z.object({}),
      })
      .describe(
        "Repeat the engine-stored exact presentation of the pending question as the ONLY step: " +
          `${shapes}. Nothing else has stored bytes — at a standing value ask or any other pending ` +
          "question, do NOT call this: re-ask in your own words with no call. " +
          "Use when the caller has not answered the pending question and needs it repeated. " +
          "This never confirms, resolves, or executes anything, changes params, or spends an attempt. " +
          "After success, speak the returned `read_back` verbatim.",
      );
  },
  descriptionLine: (ctx) => {
    const shapes = repeatableShapes(ctx).join(", or ");
    return `- \`${REPEAT_PENDING_QUESTION_ACTION}\`: repeat the exact stored presentation of ${shapes}, without resolving it (sole step).`;
  },
  allowedDuringGateLockdown: true,
  sameTurnEscape: "none",
  exclusivityGroup: "repeat-confirmation",
  execute<T extends LibraryManagedSlots>(
    _params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const awaiting = getAwaitingInput(ctx.state.view);

    // ── Standing dictation with stored ask bytes: re-present them. ──────────
    if (awaiting?.kind === "dictation") {
      const askText = (awaiting as { ask_text?: unknown }).ask_text;
      if (typeof askText === "string" && askText.length > 0) {
        return {
          entry: {
            action: REPEAT_PENDING_QUESTION_ACTION,
            ok: true,
            instruction: formatMessage(ENGINE_TEXT.repeat_done_ask, {
              action: awaiting.for_action,
            }),
            ask_repeated: true,
            for_action: awaiting.for_action,
            read_back: askText,
            read_back_directive: ENGINE_TEXT.read_back_directive_repeat_ask,
          },
          failed: false,
        };
      }
      // No stored bytes (a model-composed ask): fall through to ineligible.
    }

    // ── Pending confirmation on a repeatable action: re-present read_back. ──
    const eligible =
      awaiting?.kind === "confirmation" &&
      ctx.activation.repeatableConfirmationActions.includes(
        awaiting.for_action,
      ) &&
      typeof awaiting.read_back === "string" &&
      awaiting.read_back.length > 0;
    if (!eligible) {
      const entry: StepResult = {
        action: REPEAT_PENDING_QUESTION_ACTION,
        ok: false,
        instruction: ENGINE_TEXT.repeat_not_available,
        error: "repeat_confirmation_not_available",
      };
      return { entry, failed: true };
    }

    // A repeat is meaningful only after the caller has heard the proposal and
    // replied. Fail closed when provenance is unavailable: otherwise a second
    // ReAct loop could cause the model to answer its own just-proposed gate.
    const proposedTurnId = awaiting.proposed_on_caller_turn_id;
    if (!proposedTurnId || !ctx.currentCallerTurnId) {
      const entry: StepResult = {
        action: REPEAT_PENDING_QUESTION_ACTION,
        ok: false,
        instruction: ENGINE_TEXT.repeat_identity_unavailable,
        error: "repeat_confirmation_turn_identity_unavailable",
      };
      return { entry, failed: true };
    }
    if (proposedTurnId === ctx.currentCallerTurnId) {
      const entry: StepResult = {
        action: REPEAT_PENDING_QUESTION_ACTION,
        ok: false,
        instruction: ENGINE_TEXT.repeat_same_turn_locked,
        error: "repeat_confirmation_same_turn_locked",
      };
      return { entry, failed: true };
    }

    // Re-presenting the recap resets the consent boundary. Preserve the exact
    // pending proposal while stamping this caller turn, so neither another
    // repeat nor a matching mutation call in a later ReAct loop can treat the
    // caller's pre-repeat utterance as an answer to the newly spoken question.
    ctx.state.apply(
      setConfirmationPatch<T>(
        awaiting.for_action,
        awaiting.params,
        awaiting.attempts_left,
        awaiting.max_attempts,
        ctx.currentCallerTurnId,
        awaiting.read_back,
      ),
    );

    return {
      entry: {
        action: REPEAT_PENDING_QUESTION_ACTION,
        ok: true,
        instruction: formatMessage(ENGINE_TEXT.repeat_done, {
          action: awaiting.for_action,
        }),
        confirmation_repeated: true,
        for_action: awaiting.for_action,
        needs_confirmation: true,
        read_back: awaiting.read_back,
        // Framing for the stored bytes: complete, ends the turn.
        read_back_directive: ENGINE_TEXT.read_back_directive_repeat,
      },
      failed: false,
    };
  },
};
