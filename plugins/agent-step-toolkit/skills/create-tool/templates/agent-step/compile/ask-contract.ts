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
// The frame originated in the reference host's measured standing-ask
// contract. The required-tool capture-pause fix clarifies that SUPPLY means
// all or part of the latest reply's value: completeness is the action's
// verdict, and a pause without new content does not replay a rejected value.
//
// `{action}` / `{param}` stay as placeholders in the composed string; the
// batch finalizer interpolates them per recorded ask (run/finalize.ts).

import type { AskContractSpec } from "../types.js";

const LEAD =
  "The caller now owes this value. When `ask_text` is present, ask with exactly those words.";
const SUPPLY =
  'When their latest reply supplies all or part of this value, call "{action}" with that supplied content in "{param}"; the action validates it. If they supply no new value and instead pause, decline, pivot, or ask something else, handle that per your instructions — the ask keeps standing until answered.';
const REPEAT_IS_THE_VALUE =
  "A reply that repeats a value this ask already refused is STILL the value: call again with exactly what they said, even when you expect the same refusal — the system counts these turns and escalates by itself; answering without the call breaks that count.";
// Style applies to questions the model composes. Stored questions retain
// their exact engine-owned wording under READ-BACK.
const RE_ASK_STYLE =
  "For a model-composed re-ask, ask ONE short question for the value again. Accept the caller's dictation style; do not prescribe a pace or grouping. READ-BACK governs engine-stored questions.";

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
