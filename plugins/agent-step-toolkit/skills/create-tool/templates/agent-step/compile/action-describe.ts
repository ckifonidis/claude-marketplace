// FILE: src/agent-step/compile/action-describe.ts
//
// Compose one action's model-facing description: the host's SEMANTIC lead
// (ActionDef.description — what the action means for the business process)
// followed by the mechanics the engine itself enforces and can therefore
// state authoritatively — the confirmation-gate marker (derived from the
// controller, including read_back presence and the sole-on-execute rule)
// and the verdict index (derived from the declared rows' glosses, classified
// mechanically). Before this composer, every host restated the handshake and
// hand-enumerated its verdicts per action — ~70% of the description bytes —
// and the copies forked from the declared config.
//
// Model-facing surface — same caution as compile/schema.ts: the composed
// bytes are empirically tuned; changes here re-measure every host.

import type { ActionDef } from "../types.js";

function gateMarker(def: ActionDef<string>): string {
  const confirm = def.controller?.requiresConfirmation;
  if (!confirm) {
    return "No confirmation gate: executes on its first call.";
  }
  const hasReadBack = typeof confirm === "object" && confirm.readBack !== undefined;
  const sole = def.controller?.soleOnExecute === true;
  return (
    `Confirmation-gated: the first call proposes${hasReadBack ? " with `read_back`" : ""}; ` +
    `a later identical re-call executes${sole ? " as the batch's ONLY step" : ""}; ` +
    "`invalid_params` is a recoverable proposal rejection with no confirmation attempt spent."
  );
}

/** The full model-facing description for one action's schema variant: the
 *  gate marker the engine enforces, then the host's semantic lead.
 *
 *  The marker goes FIRST because every hand-written description this composer
 *  replaced opened with its gate status ("Confirmation-gated customer
 *  lookup.", "No confirmation gate: executes on its first call."). Treat that
 *  as conservatism, not as a measured result — see CLAUDE.md.
 *
 *  NO VERDICT INDEX (removed 2026-08-15). It used to append
 *  `Recoverable: … Terminal: …` from a per-row `gloss`, which measured as
 *  1,478 chars — 34% of everything the model read about the domain actions —
 *  while 21 of its 22 entries duplicated a `reason` the SAME verdict already
 *  carries on the result body, at the exact turn it occurs. One gloss was
 *  measured actively harmful (0/4). A result that explains itself does not
 *  need a preview in the schema. */
// NOTE deliberately NO satisfies marker (owner pushback 2026-08-24): the
// state-satisfied mechanic (ActionDef.satisfies) is internal — values ride
// state → executor and never reach the model. The one model-facing byte the
// mechanic needs, the LICENCE to make the empty call at all, already has an
// authority in each host's prompt (the reference host's probe rules, measured); a
// composed copy here would be a second authority for the same behaviour.
// Moving that licence from prompt to wire is a separate, measured decision.

export function composeActionDescription(def: ActionDef<string>): string {
  return `${gateMarker(def)} ${def.description}`;
}
