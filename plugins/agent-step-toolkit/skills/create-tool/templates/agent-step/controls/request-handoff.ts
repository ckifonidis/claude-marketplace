// FILE: src/agent-step/controls/request-handoff.ts
//
// The built-in handoff control: the LLM's actuator for "this turn must end in
// a handoff instead of an answer". Pure state transition — it validates
// params, atomically abandons every transient runner slot, and writes the
// `handoff` slot; the graph-side resolver node (handoff/node.ts) performs the
// event emission and terminate/delegate I/O AFTER the batch commits, so the
// runner stays side-effect-free. No prereqs by design: "transfer me" must
// work before any data is loaded, and while any gate is pending.

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { HandoffRequest, LibraryManagedSlots } from "../state.js";
import {
  HANDOFF_ACTION,
  HANDOFF_ACTION_DESCRIPTION,
  handoffParamsSchema,
} from "../handoff/contract.js";
import type { ControlAction, ControlOutcome, ControlRunContext } from "./contract.js";
import { requestHandoffPatch } from "../run/batch-state.js";
import { ENGINE_TEXT, formatMessage } from "../engine-text.js";

export const requestHandoffControl: ControlAction = {
  name: HANDOFF_ACTION,
  activeWhen: (ctx) => ctx.handoffEnabled,
  schemaVariant: (ctx) =>
    z
      .object({
        action: z.literal(HANDOFF_ACTION),
        params: ctx.handoffModelRequestSchema,
      })
      .describe(ctx.handoffActionDescription ?? HANDOFF_ACTION_DESCRIPTION),
  descriptionLine: () =>
    `- \`${HANDOFF_ACTION}\`: hand the conversation off instead of answering (sole step, no prereqs).`,
  allowedDuringGateLockdown: true,
  sameTurnEscape: "first",
  exclusivityGroup: "handoff",
  execute<T extends LibraryManagedSlots>(
    params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const { state } = ctx;
    let request: HandoffRequest;
    try {
      // The host's narrower model schema is the authority for this actuator.
      // Canonicalize its output through the base slot/effect schema before it
      // reaches state, preserving the trusted internal handoff contract.
      request = handoffParamsSchema.parse(
        ctx.activation.handoffModelRequestSchema.parse(params),
      );
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((iss) => iss.message).join("; ")
          : String(err);
      const entry: StepResult = {
        action: HANDOFF_ACTION,
        ok: false,
        instruction: formatMessage(ENGINE_TEXT.control_invalid_params, {
          action: HANDOFF_ACTION,
        }),
        error: "invalid_params",
        _debug: `Invalid params for "${HANDOFF_ACTION}": ${message}`,
      };
      return { entry, failed: true };
    }
    state.apply(
      requestHandoffPatch<T>(request),
    );
    const entry: StepResult = {
      action: HANDOFF_ACTION,
      ok: true,
      instruction: formatMessage(ENGINE_TEXT.handoff_requested, {
        reason: request.reason,
      }),
      handoff_requested: true,
      reason: request.reason,
    };
    return { entry, failed: false };
  },
};
