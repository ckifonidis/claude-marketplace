// FILE: src/agent-step/compile/asks.ts
//
// Resolving a ROW-SITE ask into the record the runner writes.
//
// An ask is declared ON the verdict row whose outcome asks the question
// (`VerdictDef.ask`), never in a parallel map keyed by wire code. That single
// move closes three defects the map made possible:
//
//   1. DEAD KEYS. A map key had to shadow a code the action emits, and nothing
//      checked that it still did — `verify_card` carried an ask for
//      `dual_credit_side` months after that verdict was deleted. A row-site
//      ask cannot outlive its row: deleting the row deletes the ask.
//   2. AMBIGUITY. The map was keyed by the WIRE verdict, so two rows sharing
//      one wire code necessarily shared one ask (`kind_not_found` and
//      `category_not_found` both emit `category_not_found`). Rows can now ask
//      differently even when they answer with the same code.
//   3. HAND-COPIED DERIVABLES. `expects` and `param` were written out per ask,
//      per row — three facts to keep in agreement where one would do. Both are
//      now DERIVED from the target's declared capture field (capture.ts field
//      kinds), so they cannot disagree with the field they describe.
//
// The runner-raised `invalid_params` bounce has no row — it happens before any
// executor — so its re-ask is DERIVED here too, from the bouncing action's own
// capture field. That is what removed the hand-written `invalid_params` ask
// every capture action had to remember: `collect_full_name` forgot it, and the
// omission silently CLEARED the standing name ask on every unusable capture.

import type { ActionDef, RowAsk, VerdictDef } from "../types.js";
import { captureFieldsOf, objectShapeOf } from "../capture.js";

/** An ask with everything the runner needs, resolved once at construction. */
export interface ResolvedAsk {
  action: string;
  param: string;
  expects: "digits" | "text";
  render?: (state: unknown) => string | undefined;
}

/** Resolve one row's ask. Throws with an authoring-level message: every failure
 *  here is a config mistake, and construction is where it must surface. */
export function resolveRowAsk(
  ask: RowAsk,
  ownActionName: string,
  actions: Record<string, ActionDef<string> | ActionDef<never, never>>,
  where: string,
): ResolvedAsk {
  const targetName = ask === "self" ? ownActionName : ask.action;
  const target = actions[targetName] as ActionDef<string> | undefined;
  if (!target) {
    throw new Error(`agent-step: ${where} targets unknown action "${targetName}".`);
  }

  const captures = captureFieldsOf(target.paramsSchema);
  if (captures.length === 0) {
    throw new Error(
      `agent-step: ${where} targets "${targetName}", which declares no caller-capture field — ` +
        "an ask asks the caller to DICTATE a value, so the target must have one " +
        "(judged and relayed params are not dictatable).",
    );
  }

  const explicitParam = ask === "self" ? undefined : ask.param;
  if (explicitParam === undefined && captures.length > 1) {
    throw new Error(
      `agent-step: ${where} omits \`param\` but "${targetName}" declares ${captures.length} capture fields ` +
        `(${captures.map((c) => c.name).join(", ")}) — name the one the caller owes.`,
    );
  }

  const param = explicitParam ?? captures[0].name;
  const capture = captures.find((c) => c.name === param);
  if (!capture) {
    // Two different mistakes, two different messages: a typo'd param name, or
    // a real param that is not dictatable.
    const shape = objectShapeOf(target.paramsSchema);
    if (!shape || !(param in shape)) {
      throw new Error(
        `agent-step: ${where} names param "${param}" which is not declared on "${targetName}".`,
      );
    }
    throw new Error(
      `agent-step: ${where} names param "${param}" on "${targetName}", which is not a caller-capture ` +
        "field — you cannot dictate a judged or relayed value.",
    );
  }

  return {
    action: targetName,
    param: capture.name,
    // DERIVED, never declared: the field kind is the authority on what the
    // caller is about to speak.
    expects: capture.kind,
    ...(ask !== "self" && ask.render ? { render: ask.render } : {}),
  };
}

/** Every row-site ask of one action, keyed by ROW key (not wire code). */
export function resolveActionAsks(
  actionName: string,
  def: ActionDef<string> | ActionDef<never, never>,
  actions: Record<string, ActionDef<string> | ActionDef<never, never>>,
): Record<string, ResolvedAsk> {
  const out: Record<string, ResolvedAsk> = {};
  for (const [rowKey, row] of Object.entries(
    (def.verdicts ?? {}) as Record<string, VerdictDef>,
  )) {
    if (!row.ask) continue;
    // A terminal row hands the conversation back; the finalizer skips the whole
    // standing-ask lifecycle once a handoff is set, so an ask here could never
    // be applied. Declaring one is a contradiction, not a harmless extra.
    if ((row.effects ?? []).some((e) => e.type === "request_handoff")) {
      throw new Error(
        `agent-step: action "${actionName}" verdicts["${rowKey}"] declares an ask AND a terminal ` +
          "handoff — a handed-back conversation owes nothing.",
      );
    }
    out[rowKey] = resolveRowAsk(
      row.ask,
      actionName,
      actions,
      `action "${actionName}" verdicts["${rowKey}"].ask`,
    );
  }
  return out;
}

/** The single capture field an action collects, or null. Drives the derived
 *  bounce re-ask: a malformed capture leaves the caller owing THAT value. Null
 *  when the action collects nothing (nothing to re-ask) or collects several
 *  without declaring `bounceCapture` (the engine will not guess which one
 *  bounced). */
export function soleCaptureField(
  def: ActionDef<string> | ActionDef<never, never> | undefined,
): { name: string; kind: "digits" | "text" } | null {
  if (!def) return null;
  const captures = captureFieldsOf(def.paramsSchema);
  if (def.bounceCapture !== undefined) {
    return captures.find((c) => c.name === def.bounceCapture) ?? null;
  }
  return captures.length === 1 ? captures[0] : null;
}
