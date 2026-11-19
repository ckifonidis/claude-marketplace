// FILE: src/agent-step/compile/activation.ts
//
// THE single ControlActivation construction. Until 3.0.0 the activation was
// built twice — once in plan.ts (the real one) and once in validate.ts (for
// reserved-name checks) — and every feature addition or removal had to edit
// both, with a missed copy type-checking fine in whichever object still
// carried the field (the bounded-choice removal hit exactly that). One
// builder, one derivation of every `xEnabled` flag; the only legitimate
// per-caller difference is `conservativeLifecycle` (validate runs before the
// lifecycle analysis and passes `true` so reserved names stay reserved).

import type { z } from "zod";
import type { ActionDef } from "../types.js";
import type { HandoffRequest } from "../state.js";
import type { ControlActivation, AbortPolicy } from "../controls/contract.js";
import { resolveAbortPolicy } from "../controls/contract.js";
import { handoffParamsSchema } from "../handoff/contract.js";
import { repeatReadBackEnabled } from "../interaction/confirmation.js";

/** Any action opted into a library-managed gate or flow lifecycle. */
export function hasAnyLifecycleOpt(
  actions: Record<string, ActionDef<string>>,
): boolean {
  return Object.values(actions).some((action) => {
    const c = action.controller;
    return !!(
      c &&
      (c.requiresConfirmation ||
        c.issuesOtp ||
        c.requiresOtp ||
        c.requiresMatch ||
        c.startsMatchFor ||
        c.startsFlow ||
        c.endsFlow ||
        c.requiresFlow)
    );
  });
}

/** The confirm-gated actions that opted into exact stored read-back
 *  repetition, in config order — the ONE derivation behind the
 *  `repeat_pending_question` control and the reply kinds. The protocol
 *  fragment (compile/protocol.ts) reads the same roster, so the prompt cannot
 *  name a control or a reply kind the tool surface does not carry. */
export function repeatableConfirmationActionsOf(
  actions: Record<string, { controller?: { requiresConfirmation?: unknown } }>,
): string[] {
  return Object.entries(actions)
    .filter(([, action]) =>
      repeatReadBackEnabled(action.controller?.requiresConfirmation),
    )
    .map(([name]) => name);
}

export interface ActivationInputs<ActionName extends string> {
  toolChoice?: "auto" | "required";
  actions: Record<string, ActionDef<string>>;
  handoff:
    | {
        actionDescription?: string;
        modelRequestSchema?: z.ZodType<HandoffRequest>;
      }
    | null
    | undefined;
  abortPolicy: AbortPolicy<ActionName> | undefined;
  /** validate.ts runs before the lifecycle analysis and passes `true` so the
   *  reserved-name set is computed conservatively; plan.ts omits it and gets
   *  the real derivation. */
  conservativeLifecycle?: boolean;
}

export function buildControlActivation<ActionName extends string>(
  inputs: ActivationInputs<ActionName>,
): ControlActivation {
  return {
    toolRepliesEnabled: inputs.toolChoice === "required",
    hasLifecycleOpts:
      inputs.conservativeLifecycle === true || hasAnyLifecycleOpt(inputs.actions),
    handoffEnabled: inputs.handoff != null,
    handoffActionDescription: inputs.handoff?.actionDescription,
    handoffModelRequestSchema:
      inputs.handoff?.modelRequestSchema ?? handoffParamsSchema,
    abortPolicy: resolveAbortPolicy(inputs.abortPolicy),
    repeatableConfirmationActions: repeatableConfirmationActionsOf(inputs.actions),
  };
}
