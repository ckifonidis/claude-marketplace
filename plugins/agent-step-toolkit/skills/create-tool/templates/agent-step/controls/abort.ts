// FILE: src/agent-step/controls/abort.ts
//
// The unified abort control: drop whatever the customer is currently being
// asked for (confirmation, OTP, match, or bounded choice) AND the active
// multi-turn flow, in one idempotent transition. Injected whenever any action
// opts into a library-managed lifecycle (or bounded choices are configured) —
// every gate needs an escape hatch the model can always reach.
//
// Unlike every other control, abort also EXECUTES when inactive (a no-op
// entry): the run loop dispatches on its name unconditionally, so a stray
// abort from the model degrades gracefully instead of crashing an executor
// lookup.

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import { ENGINE_TEXT } from "../engine-text.js";
import type { ControlAction, ControlOutcome, ControlRunContext } from "./contract.js";
import {
  clearInteractionPatch,
  getAwaitingInput,
  getCurrentFlow,
} from "../run/batch-state.js";

/** Reserved control name — always reserved, whatever the activation. */
export const ABORT_ACTION = "abort_pending_input";

function followerText(followers: readonly string[] | null): string {
  if (followers === null) return "one declared domain action";
  if (followers.length === 0) return "no domain action";
  return followers.map((name) => `\`${name}\``).join(", ");
}

function pendingTargetText(targets: readonly string[]): string {
  return targets.map((name) => `\`${name}\``).join(", ");
}

function policyDescription(ctx: Parameters<ControlAction["schemaVariant"]>[0]): string {
  const policy = ctx.abortPolicy;
  if (!policy) {
    return (
      "Abort whatever the customer is currently being asked for (confirmation, OTP, match, or pending bounded choice) and drop any active multi-turn flow. " +
      "Idempotent — no-op when nothing is pending. Use when the customer pivots away from or explicitly cancels the in-progress flow."
    );
  }

  const activeRule =
    policy.allowedPendingTargets !== null
      ? `Pending input must currently target ${pendingTargetText(policy.allowedPendingTargets)}; an active flow or pending bounded choice alone does not qualify.`
      : policy.requireActive
        ? "A confirmation/OTP/match, pending bounded choice, or multi-turn flow must currently be active."
        : "It is idempotent when nothing is active.";
  const allowed = followerText(policy.allowedFollowers);
  let batchRule: string;
  if (policy.allowStandalone) {
    batchRule =
      policy.allowedFollowers?.length === 0
        ? "It must be the only step."
        : `It may be the only step, or be followed by exactly ${allowed}.`;
  } else {
    batchRule = `It cannot stand alone and must be followed by exactly ${allowed}.`;
  }
  return (
    "Abort the currently pending confirmation/OTP/match or bounded choice and drop any active multi-turn flow. " +
    `It must be the first step. ${activeRule} ${batchRule}`
  );
}

function policyDescriptionLine(
  ctx: Parameters<ControlAction["descriptionLine"]>[0],
): string {
  const policy = ctx.abortPolicy;
  if (!policy) {
    return `- \`${ABORT_ACTION}\`: abort pending confirmation/OTP/match/choice input and drop the active flow (idempotent).`;
  }
  const active =
    policy.allowedPendingTargets !== null
      ? `; requires pending target ${pendingTargetText(policy.allowedPendingTargets)}`
      : policy.requireActive
        ? "; requires active input/flow"
        : "";
  const batch = policy.allowStandalone
    ? policy.allowedFollowers?.length === 0
      ? "sole step"
      : "sole step or first before exactly one allowed domain action"
    : "first, followed by exactly one allowed domain action";
  return `- \`${ABORT_ACTION}\`: abort pending input/flow (${batch}${active}).`;
}

export const abortControl: ControlAction = {
  name: ABORT_ACTION,
  activeWhen: (ctx) => ctx.hasLifecycleOpts,
  schemaVariant: (ctx) =>
    z
      .object({ action: z.literal(ABORT_ACTION), params: z.object({}) })
      .describe(policyDescription(ctx)),
  descriptionLine: policyDescriptionLine,
  allowedDuringGateLockdown: true,
  sameTurnEscape: "sole",
  exclusivityGroup: null,
  execute<T extends LibraryManagedSlots>(
    _params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const { state } = ctx;
    const priorAwaiting = getAwaitingInput(state.view);
    const priorFlow = getCurrentFlow(state.view);
    const hadSomething = priorAwaiting != null || priorFlow != null;
    if (hadSomething) {
      state.apply(clearInteractionPatch<T>());
    }
    const entry: StepResult = {
      action: ABORT_ACTION,
      ok: true,
      instruction: hadSomething ? ENGINE_TEXT.abort_done : ENGINE_TEXT.abort_nothing,
    };
    // Report the gate the caller was actually answering.
    const abortedGate = priorAwaiting;
    if (abortedGate) {
      entry.aborted_awaiting = {
        kind: abortedGate.kind,
        for_action: abortedGate.for_action,
      };
    }
    if (priorFlow) {
      entry.aborted_flow = priorFlow.name;
    }
    return { entry, failed: false };
  },
};
