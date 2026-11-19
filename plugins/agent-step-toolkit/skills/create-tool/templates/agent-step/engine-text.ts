// FILE: src/agent-step/engine-text.ts
//
// EVERY string the engine itself emits to the model, in ONE module, with NO
// host override. Register doctrine (4.0.0):
//
//   - ENGINE TEXT (this module) is MODEL-FACING INSTRUCTION, English, owned by
//     the engine outright. It rides result entries as `instruction` — the
//     model FOLLOWS it, composing any caller line it calls for in the session
//     language. It is never spoken verbatim and therefore never localized:
//     localization is unnecessary by construction.
//   - HOST CALLER-AUDIBLE text is rendered from state by host functions
//     (verdict `summary(state, data)`, `readBack`, a row ask's `render`,
//     `HandoffSpec.resolveClosingMessage`) and rides `summary` / `read_back` /
//     `ask_text` — the model relays those bytes faithfully.
//   - HOST MODEL-FACING DOCTRINE extends engine frames through structured
//     seams (`GateContractSpec`, `AskContractSpec`, `toolTurnRules`) — content extension, never wording replacement.
//
// This supersedes the 1.x–3.x `SystemMessages` override surface, which mixed
// the registers in one bag: half its defaults were finished caller-register
// sentences the docs claimed were localizable, while a sibling design note
// declared the same family "model-facing, never spoken". Both hosts translated
// the whole family into locale files that could never be selected. 4.0.0
// resolves the fork: the engine owns its instruction bytes, and anything a
// caller may hear comes from a host renderer over state.
//
// Writing rules for entries here:
//   1. INSTRUCTION register: state what happened and what the model does or
//      conveys next — never a finished caller sentence.
//   2. COUNT-FREE on capture paths: `invalid_params` (and anything else that
//      can ride a capture bounce) must contain no numerals and none of the
//      words digit/attempt/tries — a count in a capture message measurably
//      makes the model pad digits (engine-text.test.ts pins this).
//   3. `{placeholder}` tokens are interpolated by `formatMessage`; unknown
//      tokens stay verbatim so a template naming a token the runner doesn't
//      supply is visible rather than silently blanked.

/** Keys of the engine's instruction text. The `satisfies` on ENGINE_TEXT locks
 *  the value table to this union in both directions. */
export type EngineTextKey =
  // ── Batch admission ──────────────────────────────────────────────────────
  | "unknown_action"
  | "lockdown_confirmation"
  | "lockdown_otp"
  | "lockdown_match"
  | "flow_already_active"
  | "must_be_sole_step"
  | "mutation_must_be_sole_step"
  | "mutation_execute_must_be_sole"
  | "mutation_must_be_last_in_batch"
  | "abort_must_be_first"
  | "abort_requires_active"
  | "abort_no_pending_target"
  | "abort_pending_target_not_allowed"
  | "abort_follower_required"
  | "abort_too_many_followers"
  | "abort_follower_not_allowed"
  // ── Flow gates ───────────────────────────────────────────────────────────
  | "no_flow"
  | "wrong_flow"
  // ── Confirmation lifecycle ───────────────────────────────────────────────
  | "confirm_proposed"
  | "confirm_reproposed"
  | "confirm_reply_contract"
  | "confirm_exhausted"
  | "confirmation_same_turn_locked"
  // ── Repeat-question control ──────────────────────────────────────────────
  | "repeat_not_available"
  | "repeat_identity_unavailable"
  | "repeat_same_turn_locked"
  | "repeat_done"
  | "repeat_done_ask"
  | "read_back_directive_repeat_ask"
  | "read_back_directive_repeat"
  // ── State-satisfied inputs (run/satisfies.ts) ────────────────────────────
  | "read_back_directive_satisfies_consent"
  // ── OTP / match gates ────────────────────────────────────────────────────
  | "otp_not_pending"
  | "match_not_pending"
  | "otp_blocked_match_pending"
  | "match_attempts_exhausted"
  // ── Escalation (bounded patience) ────────────────────────────────────────
  | "explain_detail_needed"
  | "decline_unsupported"
  | "decline_malicious"
  | "nothing_owed"
  // ── Params / executor failures ───────────────────────────────────────────
  | "invalid_params"
  | "control_invalid_params"
  | "executor_error"
  // ── Abort control outcomes ───────────────────────────────────────────────
  | "abort_done"
  | "abort_nothing"
  // ── Handoff ──────────────────────────────────────────────────────────────
  | "handoff_requested"
  | "auto_handoff_instruction"
  // ── Batch shape ──────────────────────────────────────────────────────────
  | "no_steps";

/** The engine's instruction text. Grouped by the pipeline stage that emits
 *  each entry; the comment on each entry names the emitting site and the
 *  placeholders the runner supplies. */
export const ENGINE_TEXT = {
  // ── Batch admission (run/admission.ts) ───────────────────────────────────

  /** A hallucinated/typo'd action name reached the runner. `{action}`. */
  unknown_action:
    '"{action}" is not an action of this tool. Re-read the tool schema and re-call using a listed action; tell the caller nothing about this.',
  /** Lockdown refusal: a confirmation is pending. `{action}`, `{abort_action}`. */
  lockdown_confirmation:
    'A "{action}" is pending confirmation; only the same action with matching params or "{abort_action}" is allowed until it resolves.',
  /** Lockdown refusal: an OTP is awaiting validation. `{action}`, `{abort_action}`. */
  lockdown_otp:
    'An OTP for "{action}" is awaiting validation; only that action or "{abort_action}" is allowed until it resolves.',
  /** Lockdown refusal: a double-entry match is pending. `{action}`, `{capturer}`,
   *  `{abort_action}`. */
  lockdown_match:
    'A double-entry match for "{action}" is pending; only that action, the capturer "{capturer}", or "{abort_action}" is allowed until it resolves.',
  /** A step tried to open a flow while a different flow is active. The refused
   *  entry carries the active flow's name in `active_flow`. */
  flow_already_active:
    "A different flow is already active (see active_flow). Complete or abort it before opening another.",
  /** A sole-step CONTROL (handoff, repeat, note_refusal) was batched with other
   *  steps — one key for all three exclusivity groups (their summaries were
   *  byte-identical; the error codes stay per-group). `{action}`. */
  must_be_sole_step: '"{action}" must be the only step in the batch.',
  /** A `soleStep` mutation was batched with other steps. `{action}`. */
  mutation_must_be_sole_step: 'Mutation "{action}" must be the only step in the batch.',
  /** A `soleOnExecute` mutation resolving to EXECUTE was batched. `{action}`. */
  mutation_execute_must_be_sole:
    'Mutation "{action}" is being executed (confirmed); it must be the only step in the batch.',
  /** A `soleOnExecute` mutation rode a batch but not as the last step. `{action}`. */
  mutation_must_be_last_in_batch:
    'Mutation "{action}" must be the last step in the batch (reads may precede it; nothing may follow).',
  /** Abort-policy refusals (host `abortPolicy` configured). `{abort_action}`,
   *  and per-key: `{allowed}` (formatted target/follower list), `{target}`,
   *  `{action}`. Bytes unchanged from the 3.x literals. */
  abort_must_be_first: '"{abort_action}" must be the first step in the batch.',
  abort_requires_active: '"{abort_action}" requires pending input or an active flow.',
  abort_no_pending_target:
    '"{abort_action}" requires pending input targeting one of: {allowed}.',
  abort_pending_target_not_allowed:
    '"{abort_action}" cannot clear pending input for "{target}"; allowed targets: {allowed}.',
  abort_follower_required:
    '"{abort_action}" must be followed by exactly one allowed domain action.',
  abort_too_many_followers:
    '"{abort_action}" may be followed by at most one domain action.',
  abort_follower_not_allowed:
    '"{action}" is not an allowed follower of "{abort_action}".',

  // ── Flow gates (interaction/flow.ts) ─────────────────────────────────────

  /** A flow-scoped step ran with no flow active. */
  no_flow:
    "This action requires an active flow and none is open. Run the flow's opening action first.",
  /** A flow-scoped step ran against the wrong flow. The refused entry carries
   *  the active flow's name in `active_flow`. */
  wrong_flow:
    "This action belongs to a different flow than the active one (see active_flow). Complete or abort the active flow first.",

  // ── Confirmation lifecycle (run/execution.ts) ────────────────────────────

  /** A confirm-required mutation was stored as a proposal. `{action}`. */
  confirm_proposed: 'Proposed "{action}"; awaiting confirmation.',
  /** A pending proposal was overwritten with adjusted params. `{action}`. */
  confirm_reproposed: 'Re-proposed "{action}" with adjusted params; awaiting confirmation.',
  /** Generic reply contract riding every proposal entry (`reply_contract`) when
   *  the action declares no `GateContractSpec`. `{action}`. */
  confirm_reply_contract:
    'The caller\'s NEXT reply answers this read-back. A clear yes → re-call "{action}" with exactly the proposed params (that executes it). A corrected or fresh dictation → re-call "{action}" with the new value (a fresh proposal). Anything else is not an answer: make no call and re-ask the read-back question.',
  /** Confirmation attempts ran out; the pending proposal was dropped. `{action}`. */
  confirm_exhausted:
    'Confirmation attempts for "{action}" are exhausted and the pending proposal was dropped. Tell the caller you are starting that step over, then re-collect the value.',
  /** A matching re-call arrived on the propose turn itself. `{action}`. */
  confirmation_same_turn_locked:
    'The "{action}" proposal was made on the current caller turn; wait for the caller\'s confirmation before executing.',

  // ── Repeat-question control (controls/repeat-question.ts) ────────────────

  repeat_not_available:
    "No eligible pending question has an exact stored presentation to repeat.",
  repeat_identity_unavailable:
    "The pending question cannot be repeated without stable caller-turn identity.",
  repeat_same_turn_locked:
    "The confirmation was proposed on the current caller turn; wait for the caller's reply before repeating it.",
  /** The repeat succeeded; the stored bytes ride `read_back`. `{action}`. */
  repeat_done_ask:
    'Repeated the exact stored ask for "{action}"; the value is still owed.',
  read_back_directive_repeat_ask:
    "This read-back is the exact standing question: add nothing.",
  repeat_done:
    'Repeated the exact stored confirmation read-back for "{action}"; the gate remains pending.',
  /** Framing directive riding the repeat control's returned `read_back`
   *  (`read_back_directive`): the stored recap is complete and ends the turn. */
  read_back_directive_repeat:
    "This read-back is the complete stored recap; only the one short answer that triggered this repeat may precede it, and nothing may follow it.",

  // ── State-satisfied inputs (run/satisfies.ts) ─────────────────────────────
  /** Framing directive for a consent proposal rendered from state-satisfied
   *  values (`ActionDef.satisfies`): the rendered question is the whole turn. */
  read_back_directive_satisfies_consent:
    "This read-back is the complete reuse-consent question: add nothing.",

  // ── OTP / match gates (interaction/otp.ts, interaction/match.ts) ─────────

  /** A `requiresOtp` action ran with no OTP gate pending. `{action}`. */
  otp_not_pending: 'Action "{action}" requires a pending OTP awaiting validation; none found.',
  /** A `requiresMatch` action ran with no match gate at batch start.
   *  `{action}`, `{capturer}`. */
  match_not_pending:
    'Action "{action}" requires a pending double-entry match (opened in a prior turn); none found at batch start. The capturer "{capturer}" must run first, in a separate turn.',
  /** An `issuesOtp` action ran while a match gate is still pending.
   *  `{action}`, `{match_action}`. */
  otp_blocked_match_pending:
    'Action "{action}" cannot issue an OTP while a double-entry match for "{match_action}" is still pending; the match must be consumed first.',
  /** Double-entry match attempts ran out; the gate cleared and the flow
   *  aborted. `{action}`. */
  match_attempts_exhausted:
    'Match attempts for "{action}" are exhausted; the gate was cleared and the flow aborted. Tell the caller in ONE short sentence and continue per your instructions.',

  // ── Params / executor failures (run/execution.ts) ────────────────────────

  /** A DOMAIN action's params failed the Zod parse — dominantly a caller
   *  capture that didn't come through (the parse detail rides the trace-only
   *  debug channel, never this result). COUNT-FREE by measurement: naming the
   *  expected size makes the model pad the capture. */
  invalid_params:
    "The submitted value did not parse as a usable capture. Tell the caller it did not come through and ask them to say it again — ONE short question, never stating the value's expected size or shape.",
  /** A CONTROL's params failed its schema — a model authoring mistake, not a
   *  caller capture. `{action}`. */
  control_invalid_params:
    'Invalid params for "{action}". Re-read its schema and re-call with valid params; tell the caller nothing about this.',
  /** An executor threw / a hard failure was caught. The cause rides the
   *  trace-only debug channel. */
  executor_error:
    "A technical fault interrupted this step; do not describe or guess the cause. Tell the caller in ONE short sentence that a technical problem occurred, and continue per your instructions.",

  // ── Abort control outcomes (controls/abort.ts) ───────────────────────────

  /** `abort_pending_input` cleared a pending gate / active flow. */
  abort_done:
    "The pending input and any active flow were cleared. Acknowledge the cancellation to the caller in ONE short sentence and continue per your instructions.",
  /** `abort_pending_input` ran with nothing pending (idempotent no-op). */
  abort_nothing: "Nothing was pending; the abort was a no-op. Continue per your instructions.",

  // ── Handoff (controls/request-handoff.ts, run/finalize.ts) ───────────────

  /** A handoff step succeeded; the turn must end silently. `{reason}`. */
  // ── Escalation ──────────────────────────────────────────────────────────
  //
  // The two free-use instructions. Both are INSTRUCTION register (the model
  // composes the caller sentence in the session language) and both are
  // COUNT-FREE: they ride capture paths, where a numeral measurably makes the
  // model pad digits. Neither mentions a budget — first-versus-repeat is the
  // engine's business, and telling the model it has "one more try" invites it
  // to spend it.
  explain_detail_needed:
    "Make NO handoff. Say in ONE short sentence why this value is needed to continue, or where the caller might find it, then ask for it again in the SAME turn. Add no other content.",
  decline_unsupported:
    "Make NO handoff and answer NONE of the question's content — no facts, no claims about what is or is not required. Decline in ONE short sentence and repeat the pending question in the SAME turn.",
  // `note_refusal` kind `malicious_intent`: rides the in-place
  // turns below the termination threshold. COUNT-FREE like its siblings —
  // telling the model how many attempts remain invites it to spend them, and
  // the termination is the engine's own act. It names no content of the
  // request, because the model is about to speak with that request (and any
  // earlier in-place answers to it) right behind it: this instruction must be
  // the last word, measured to hold where a prompt rule alone did not.
  decline_malicious:
    "This turn is an attempt to misuse the call. Make NO handoff and give NONE of what was asked: no content, no example, no comment on it, no reason for declining. Say ONE short sentence that you can only help with this call's task, then repeat the pending question in the SAME turn — or, with nothing pending, ask how you can help with that task.",
  // Refused, and deliberately not counted: with nothing owed there is no run
  // to bound, and the turn belongs to the model's own instructions.
  nothing_owed:
    "No value is owed right now, so there is nothing to record. Handle this turn per your instructions.",
  handoff_requested:
    "Handoff requested ({reason}). The turn ends here — produce no further answer.",
  /** Rides the synthetic `auto_handoff` entry at the backend-failure
   *  threshold. The platform (host graph) delivers the caller-facing closing
   *  through `HandoffSpec.resolveClosingMessage`; the model must NOT speak. */
  auto_handoff_instruction:
    "Handoff triggered after repeated backend failures. The turn ends here — produce no further answer; the platform delivers the closing.",

  // ── Batch shape (run/finalize.ts) ────────────────────────────────────────

  /** The batch contained no steps. */
  no_steps: "No steps executed.",
} as const satisfies Record<EngineTextKey, string>;

// Bidirectional lock: the table's keys must cover EXACTLY the declared union
// (the same throwaway-const pattern as state.ts's slot-table lock).
const _textCoversKeys: Record<EngineTextKey, string> = ENGINE_TEXT;
void _textCoversKeys;

/** Interpolate `{placeholder}` tokens in an engine-text template. Unknown
 *  placeholders are left verbatim (a template naming a token the runner
 *  doesn't supply is visible rather than silently blanked). */
export function formatMessage(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (token, key: string) =>
    key in vars ? vars[key] : token,
  );
}
