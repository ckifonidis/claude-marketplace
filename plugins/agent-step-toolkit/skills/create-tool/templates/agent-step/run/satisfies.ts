// FILE: src/agent-step/run/satisfies.ts
//
// Resolution of state-satisfied inputs (`ActionDef.satisfies`): given an
// action and the current state view, decide whether an EMPTY call can be
// answered from state, and with which values. Pure functions — the propose
// path (consent gate / elseVerdict refusal) and the execute path (bundle to
// the executor) both call the SAME resolver, so what a proposal offered and
// what the execution consumes can never disagree (the divergence the host
// probe pattern kept in check by hand across three sites).

import { objectShapeOf, fieldKindOf } from "../capture.js";
import type { CompiledAction } from "../compile/plan.js";
import type { SatisfiedSource } from "../types.js";

/** Walk a dotted path through a state view. Returns undefined the moment a
 *  segment is missing — a partial path is "nothing carried", never a throw. */
function walkPath(state: unknown, path: string): unknown {
  let cur: unknown = state;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** True when the parsed params supply NONE of the action's caller-capture
 *  fields — the empty call that may consult `satisfies`. A call carrying any
 *  capture value is dictated: the caller's own words always win. */
export function isEmptyCaptureCall(
  action: CompiledAction,
  params: Record<string, unknown>,
): boolean {
  const shape = objectShapeOf(action.effectiveSchema);
  if (!shape) return false;
  for (const [name, field] of Object.entries(shape)) {
    const kind = fieldKindOf(field);
    if (kind !== "digits" && kind !== "text") continue;
    if (params[name] !== undefined) return false;
  }
  return true;
}

/** Resolve the action's satisfied bundle from state, or undefined when the
 *  source is unavailable. Availability is MODE-DEPENDENT:
 *
 *  - CONSENT resolves PARTIALLY: a `values` key naming one of the action's
 *    own capture fields is REQUIRED (it is the action's point — offering a
 *    consent question that cannot be acted on would burn the question), and
 *    every other key is an optional RIDER, simply skipped when absent or
 *    unusable. A person hears exactly what the rendered question offers (the
 *    host `ask` reads state), answers it, and the ordinary standing-ask flow
 *    collects whatever did not carry — no second source declaration needed
 *    for a partial carry.
 *  - SILENT is ALL-OR-NOTHING: the bundle's completeness IS the predicate
 *    (e.g. customer_code + user_id together meaning "authenticated session"),
 *    and there is no human in the loop to absorb a partial offer. Any value
 *    absent or unusable makes the whole source unavailable.
 *
 *  A capture-field key is validated (and normalized) through that field's
 *  schema — the same refinement a dictated value passes — so a malformed
 *  carried value degrades to "nothing carried" instead of opening a consent
 *  gate over a value the executor would reject anyway. */
export function resolveSatisfies(
  action: CompiledAction,
  state: unknown,
): SatisfiedSource | undefined {
  const spec = action.satisfies;
  if (!spec) return undefined;
  const shape = objectShapeOf(action.effectiveSchema) ?? {};
  const values: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(spec.values)) {
    const raw = walkPath(state, path);
    const field = shape[name];
    const kind = field ? fieldKindOf(field) : undefined;
    if (kind === "digits" || kind === "text") {
      // Capture-field keys are required in BOTH modes.
      if (raw == null) return undefined;
      const parsed = field.safeParse(String(raw));
      if (!parsed.success || parsed.data == null) return undefined;
      values[name] = parsed.data;
      continue;
    }
    // Presence-only value (a channel-asserted code, a rider like a carried
    // card number, or a pure witness the executor ignores): primitives pass
    // through as-is; an object is a mis-declared path, treated as unusable
    // rather than thrown — the resulting behaviour ("nothing carried" /
    // rider skipped) is right either way.
    const unusable =
      raw == null || typeof raw === "object" || String(raw).trim().length === 0;
    if (unusable) {
      if (spec.mode === "consent") continue; // optional rider — skip it
      return undefined; // silent: the bundle is the predicate
    }
    values[name] = raw;
  }
  return { values };
}
