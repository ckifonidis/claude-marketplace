// FILE: src/agent-step/interaction/flow.ts
//
// The multi-turn flow lifecycle: `startsFlow` opens (or idempotently
// re-enters) `currentFlow`, `merge_flow_data` effects accumulate into its
// scratch bag, `requiresFlow` gates flow-scoped steps, `endsFlow` (or an
// `abort_flow` effect) clears it. One flow at a time — mutex by design. A flow
// persists across turns and is never cleared implicitly.

import type { ControllerHooks, ExecutorEffect, StepResult } from "../types.js";
import type { CurrentFlow } from "../state.js";
import { ENGINE_TEXT } from "../engine-text.js";

/** Refusal for a `requiresFlow` step running with no flow / the wrong flow,
 *  or `null` when satisfied. Runs BEFORE confirm-mode resolution and user
 *  prereqs, so a doomed confirm-required mutation never proposes. */
export function refuseWrongFlow(
  actionName: string,
  controller: ControllerHooks | undefined,
  flow: CurrentFlow | null,
): StepResult | null {
  if (!controller?.requiresFlow) return null;
  if (!flow) {
    return {
      action: actionName,
      ok: false,
      instruction: ENGINE_TEXT.no_flow,
      error: "no_flow_active",
    };
  }
  if (flow.name !== controller.requiresFlow) {
    return {
      action: actionName,
      ok: false,
      instruction: ENGINE_TEXT.wrong_flow,
      error: "wrong_flow",
      active_flow: flow.name,
    };
  }
  return null;
}

/** Compute the flow value after an `ok:true` step: `startsFlow` creation /
 *  idempotent re-entry, then any `merge_flow_data` effects shallow-merged in.
 *  Returns the flow to write, or `null` when nothing changed. Requesting
 *  `merge_flow_data` with no target flow is a programmer mistake — loud throw,
 *  never a silent drop. (The flow-mutex admission check already refused a
 *  `startsFlow` against a DIFFERENT active flow.) */
export function flowAfterOkStep(
  actionName: string,
  controller: ControllerHooks | undefined,
  effects: ExecutorEffect[],
  existingFlow: CurrentFlow | null,
): CurrentFlow | null {
  let targetFlow: CurrentFlow | null = existingFlow;
  if (controller?.startsFlow) {
    const flowName = controller.startsFlow.name;
    if (!existingFlow) {
      targetFlow = { name: flowName, data: {} };
    } else if (existingFlow.name === flowName) {
      // Idempotent within the same flow — keep existing data.
      targetFlow = existingFlow;
    }
    // else: the flow-mutex admission check already refused the batch.
  }

  for (const effect of effects) {
    if (effect.type !== "merge_flow_data") continue;
    if (!targetFlow) {
      throw new Error(
        `agent-step: action "${actionName}" requested merge_flow_data but no flow is ` +
          `active and the action doesn't declare startsFlow.`,
      );
    }
    targetFlow = {
      name: targetFlow.name,
      data: { ...targetFlow.data, ...effect.data },
    };
  }

  return targetFlow !== existingFlow ? targetFlow : null;
}
