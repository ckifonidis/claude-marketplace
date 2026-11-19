import { z } from "zod";
import type { ControlAction } from "./contract.js";
import { hasCurrentReadBack, pendingReplyContext, renderReplyText, RESPOND_TO_CALLER_ACTION } from "../reply.js";
import { ENGINE_TEXT } from "../engine-text.js";
import { prepareConfirmationRepeat, repeatableConfirmation } from "../interaction/repeat-confirmation.js";

export const respondToCallerControl: ControlAction = {
  name: RESPOND_TO_CALLER_ACTION,
  activeWhen: (ctx) => ctx.toolRepliesEnabled === true,
  schemaVariant: (ctx) => {
    // Reply kinds apply only at a repeatable confirmation. With no such gate
    // configured they can never be legal and reply.ts keeps them off the
    // model's surface, so the wording the model DOES see (the text variant and
    // this control's own description) must not advertise them.
    const repeatable = ctx.repeatableConfirmationActions.length > 0;
    const confirmations = repeatable
      ? ctx.repeatableConfirmationActions.map(name => `\`${name}\``).join(", ")
      : "repeatable";
    return z.object({
    action: z.literal(RESPOND_TO_CALLER_ACTION),
    params: z.union([
      z.object({
        kind: z.literal("clarification"),
        explanation: z.string().describe("Factual statements addressing the caller's concern, in the session language. This is the explanatory prefix; READ-BACK owns the question."),
      }).describe(`Answer a question or condition about a pending ${confirmations} confirmation, as its reply_contract directs.`),
      z.object({
        kind: z.literal("choice"),
        text: z.string().describe("The explanation of permitted alternative paths and the question asking which the caller prefers, in the session language."),
      }).describe(`Ask which permitted path the caller prefers during a pending ${confirmations} confirmation.`),
      z.object({
        text: z.string().describe("Ordinary speech or presentation of the current tool result in the session language. READ-BACK governs presentation."),
      }).strict().describe(repeatable
        ? `Present a current result or speak at any other question, including confirmations for actions other than ${confirmations}.`
        : "Present a current result or speak at any other point in the conversation."),
    ]),
  }).describe("Deliver a spoken reply and end this turn, as the ONLY step. Preserves proposed values and counters; never confirms, executes, or hands off. " +
      (repeatable ? `A fresh reply during ${confirmations} confirmation requires kind; other questions use text. ` : "") +
      "Supplied captures and consent belong to their workflow action.");
  },
  descriptionLine: (ctx) => ctx.repeatableConfirmationActions.length > 0
    ? "- `respond_to_caller`: deliver a spoken reply and end the turn; the reply kind governs a pending repeatable confirmation (sole step)."
    : "- `respond_to_caller`: deliver a spoken reply and end the turn (sole step).",
  allowedDuringGateLockdown: true,
  sameTurnEscape: "sole",
  exclusivityGroup: "reply",
  execute(params, ctx) {
    const replyKind = (params as { kind?: unknown } | null)?.kind;
    const text = replyKind === "clarification"
      ? (params as { explanation?: unknown } | null)?.explanation
      : (params as { text?: unknown } | null)?.text;
    try {
      if (replyKind === "clarification" && (params as { text?: unknown }).text !== undefined) {
        throw new Error(ENGINE_TEXT.reply_explanation_only);
      }
      if (typeof text !== "string" || !text.trim()) throw new Error(ENGINE_TEXT.reply_text_required);
      if (replyKind !== undefined && replyKind !== "clarification" && replyKind !== "choice") {
        throw new Error(ENGINE_TEXT.reply_kind_required);
      }
      const messages = ctx.messages ?? [];
      const consent = repeatableConfirmation(ctx);
      const presenting = consent && hasCurrentReadBack(messages, consent.read_back);
      if (presenting && replyKind !== undefined) throw new Error(ENGINE_TEXT.reply_present_result);
      if (consent && !presenting && replyKind === undefined) throw new Error(ENGINE_TEXT.reply_kind_required);

      // Validate all model-authored text BEFORE committing the new consent
      // boundary. The explicit repeat control uses the same preparation.
      let summary = renderReplyText(text, messages);
      if (replyKind === "clarification") {
        const repeated = prepareConfirmationRepeat(ctx);
        if (!repeated.ok) throw new Error(repeated.instruction);
        if (summary.includes(repeated.readBack)) throw new Error(ENGINE_TEXT.reply_explanation_only);
        summary = `${summary.trim()} ${repeated.readBack}`;
        ctx.state.apply(repeated.patch);
      }
      const pending = pendingReplyContext(messages, ctx.state.view.awaitingInput);
      return {
        entry: {
          action: RESPOND_TO_CALLER_ACTION, ok: true,
          summary, turn_complete: true,
          // Refresh the authoritative cursor after a conversational aside.
          // Never expose raw proposal params, identity data, or counters.
          ...(pending ? { awaiting: pending } : {}),
        },
        failed: false,
      };
    } catch (error) {
      return {
        entry: { action: RESPOND_TO_CALLER_ACTION, ok: false, error: "invalid_reply", instruction: (error as Error).message },
        failed: true,
      };
    }
  },
};
