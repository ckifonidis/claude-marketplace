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
//     re-present those bytes when the host's reply policy needs an exact
//     repeat. Ordinary conversational re-asks remain speech turns. Nothing
//     to re-stamp: a dictation is non-locking, nothing executes off it.
//
// (The bounded-choice repeat branch left with the bounded-choice controls.)

import { z } from "zod";
import type { LibraryManagedSlots } from "../state.js";
import { getAwaitingInput } from "../run/batch-state.js";
import { prepareConfirmationRepeat } from "../interaction/repeat-confirmation.js";
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
  shapes.push("a standing value ask whose stored text is shown in ask_text or awaiting.question");
  return shapes;
}

export const repeatPendingQuestionControl: ControlAction = {
  name: REPEAT_PENDING_QUESTION_ACTION,
  activeWhen: (ctx) => ctx.repeatableConfirmationActions.length > 0,
  schemaVariant: (ctx) => {
    const shapes = repeatableShapes(ctx).join(", or ");
    return z
      .object({
        action: z.literal(REPEAT_PENDING_QUESTION_ACTION),
        params: z.object({}),
      })
      .describe(
        "Repeat the engine-stored exact presentation of the pending question as the ONLY step: " +
          `${shapes}. ` +
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
    const repeated = prepareConfirmationRepeat(ctx);
    if (!repeated.ok) {
      return { entry: { action: REPEAT_PENDING_QUESTION_ACTION, ...repeated }, failed: true };
    }

    // Re-presenting the recap resets the consent boundary. Preserve the exact
    // pending proposal while stamping this caller turn, so neither another
    // repeat nor a matching mutation call in a later ReAct loop can treat the
    // caller's pre-repeat utterance as an answer to the newly spoken question.
    ctx.state.apply(repeated.patch);

    return {
      entry: {
        action: REPEAT_PENDING_QUESTION_ACTION,
        ok: true,
        instruction: formatMessage(ENGINE_TEXT.repeat_done, {
          action: repeated.forAction,
        }),
        confirmation_repeated: true,
        for_action: repeated.forAction,
        needs_confirmation: true,
        read_back: repeated.readBack,
        // Framing for the stored bytes: complete, ends the turn.
        read_back_directive: ENGINE_TEXT.read_back_directive_repeat,
      },
      failed: false,
    };
  },
};
