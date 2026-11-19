// FILE: src/agent-step/interaction/dictation.ts
//
// The `dictation` awaiting-input kind: the engine's record of the STANDING
// QUESTION — "the customer owes a fresh value". Set declaratively per verdict
// ROW (`VerdictDef.ask`), applied by the batch finalizer, and made visible to
// the model on the final entry (`standing_ask` + `ask_contract`,
// run/finalize.ts). Non-locking by design: it is a record, not a gate — the
// caller may pivot.
//
// WHY the final entry decides: `ok:false` short-circuits a batch, so the last
// entry is exactly what the model relays to the caller — the conversational
// standing question. Mid-batch asks are transient by construction.
//
// WHAT DECIDES, and why it is the ROW and not the wire code (3.x → 4.0.0):
// the lookup used to key `asks` by the entry's `verdict`-or-`error` string,
// which conflated three different things —
//
//   * two ROWS sharing one wire verdict could not ask differently;
//   * a map key could name a code no row emits (a dead ask, silently inert);
//   * and, worst, a RUNNER-RAISED code was indistinguishable from an outcome.
//     That last one was a live defect: an `invalid_params` bounce carries no
//     row, so an action that had not hand-written an `invalid_params` ask (i.e.
//     `collect_full_name`) took the "no ask matched" branch and CLEARED the
//     standing question — the engine forgot what the caller owed precisely
//     because their capture had not parsed.
//
// So the runner now hands over the ROW KEY per entry (undefined for anything it
// raised itself), and the two cases are answered separately:
//
//   * an entry FROM A ROW: the row's ask, or — when the row declares none —
//     "serviced", which clears a dictation standing for this same action;
//   * an entry the RUNNER raised: never a servicing, so the record stands. The
//     one that implies an ask is the capture bounce, and it is DERIVED from the
//     bouncing action's own capture field rather than hand-declared.
//
// NOTE (owner decision 2026-08-14): deterministic caller-turn INTERCEPTION —
// a graph node synthesizing the capture tool-call when the utterance is
// purely digit content — was built here, measured live, and REMOVED: the
// engine must never fabricate assistant turns, and real dictation arrives in
// too many part-utterance shapes (multi-breath, framed) for a syntactic
// answer test to own the turn. Captures remain the model's job; this state
// exists so results can tell the model what is owed (and so engine-owned
// repeats have an authoritative anchor).

import type { StepResult } from "../types.js";
import type { AwaitingInput, LibraryManagedSlots } from "../state.js";
import type { CompiledPlan } from "../compile/plan.js";
import type { ResolvedAsk } from "../compile/asks.js";
import { setDictationPatch } from "../run/batch-state.js";

/** Row keys parallel to the batch's result entries; `undefined` where the
 *  runner raised the entry itself (a bounce, a denial, a lockdown refusal, a
 *  cached page) rather than composing it from a declared row. */
export type RowKeys = readonly (string | undefined)[];

/** The ask implied by the batch's FINAL entry, or undefined. Shared by the
 *  transition below and the finalizer's `ask_text` stamping so the two can
 *  never key differently. */
export function askOfFinalEntry<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  results: StepResult[],
  rowKeys: RowKeys,
): ResolvedAsk | undefined {
  const index = results.length - 1;
  const last = results[index];
  if (!last) return undefined;
  const action = plan.actions[last.action];
  if (!action) return undefined;

  const rowKey = rowKeys[index];
  if (rowKey !== undefined) return action.rowAsks[rowKey];

  // Runner-raised. Only the capture bounce implies a standing ask, and what it
  // implies is derivable: the caller still owes THIS action's capture. The
  // derived ask deliberately carries no `render` — the bounce re-ask is
  // measured to work better in the model's own short, count-free words than as
  // a re-spoken catalog line.
  if (last.error === "invalid_params" && action.captureField) {
    return {
      action: last.action,
      param: action.captureField.name,
      expects: action.captureField.kind,
    };
  }
  return undefined;
}

/** Compute the awaiting-input transition the batch's FINAL entry implies, or
 *  `undefined` for "leave the slot as it stands". Returns `null` to clear a
 *  serviced dictation. Never returns a transition over a live gate — a
 *  confirmation/OTP/match set or left standing by the batch IS the standing
 *  question; asks never stomp it. */
export function dictationAfterBatch<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  results: StepResult[],
  rowKeys: RowKeys,
  awaiting: AwaitingInput | null,
): Partial<T> | null | undefined {
  if (awaiting && awaiting.kind !== "dictation") return undefined;
  const index = results.length - 1;
  const last = results[index];
  if (!last) return undefined;

  const ask = askOfFinalEntry(plan, results, rowKeys);
  if (ask) {
    return setDictationPatch<T>(ask.action, ask.param, ask.expects);
  }

  // No ask. Whether that means "serviced" depends on WHO produced the entry.
  // A runner-raised entry serviced nothing — the value never reached an
  // executor — so the record stands untouched.
  if (rowKeys[index] === undefined) return undefined;

  // An outcome ROW that declares no ask: a dictation standing FOR the acting
  // action was serviced by this very entry — clear it. A dictation for a
  // DIFFERENT action (an unrelated read ran) still stands: the caller still
  // owes that value.
  if (awaiting?.kind === "dictation" && awaiting.for_action === last.action) {
    return null;
  }
  return undefined;
}
