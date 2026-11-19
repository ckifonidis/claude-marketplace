// FILE: src/agent-step/compile/ask-contract.ts
//
// Composes the STANDING-ASK contract that rides every result entry recording a
// dictation ask (`ask_contract`), from the engine frame plus the host's
// declared reply categories (`BuildAgentStepToolOptions.askContract`). The
// same frame/content split as compile/gate-contract.ts:
//
//   - The ENGINE owns the clauses that protect its own mechanisms: the
//     owes-value lead with the `ask_text` exactness rule, the supply clause
//     ({action}/{param} routing), the repeat-is-still-the-value clause (the
//     capture-bounce bound counts TOOL CALLS — a no-call re-ask breaks the
//     count, measured live 2026-08-19), and the closing re-ask-style clause.
//   - The HOST owns the measured domain categories in between (e.g. the
//     reference host's freeze-fork triage and channel-check clauses, both
//     measured re-tipping under unrelated edits while they lived in the
//     prompt), joined verbatim in declaration order.
//
// The frame clauses were extracted byte-for-byte from the reference host's
// measured standing-ask contract: composed with NO categories they reproduce
// the 3.x generic default exactly, and with the reference host's two
// categories they reproduce its 3.x override exactly — the composer never
// forces a wording change.
//
// `{action}` / `{param}` stay as placeholders in the composed string; the
// batch finalizer interpolates them per recorded ask (run/finalize.ts).

import type { AskContractSpec } from "../types.js";

const LEAD =
  "The caller now owes this value. When `ask_text` is present, ask with exactly those words.";
const SUPPLY =
  'When their reply supplies it, call "{action}" with it in "{param}"; if they instead decline, pivot, or ask something else, handle that per your instructions — the ask keeps standing until answered.';
const REPEAT_IS_THE_VALUE =
  "A reply that repeats a value this ask already refused is STILL the value: call again with exactly what they said, even when you expect the same refusal — the system counts these turns and escalates by itself; answering without the call breaks that count.";
// Measured wording ("its length, or its digits") kept byte-identical: this
// clause instructs the model NOT to speak such things — it never rides a
// capture-bounce summary, so the count-free invariant does not cover it, and
// rewording measured text demands a live re-measurement for zero defect.
const RE_ASK_STYLE =
  "When re-asking, use ONE short question and never describe how to dictate the value, its length, or its digits.";

/** Compose the full standing-ask contract: engine frame around the host's
 *  categories (none → the generic frame alone). Every clause is one or more
 *  complete sentences; clauses join with single spaces. */
export function composeAskContract(spec: AskContractSpec | undefined): string {
  if (spec) {
    if (!Array.isArray(spec.categories) || spec.categories.length === 0) {
      throw new Error(
        "agent-step: askContract requires at least one reply category — " +
          "omit the option to keep the generic frame instead.",
      );
    }
    for (const category of spec.categories) {
      if (typeof category !== "string" || category.length === 0) {
        throw new Error("agent-step: askContract categories must be non-empty strings.");
      }
    }
  }
  const clauses = [
    LEAD,
    SUPPLY,
    REPEAT_IS_THE_VALUE,
    ...(spec?.categories ?? []),
    RE_ASK_STYLE,
  ];
  return clauses.join(" ");
}
