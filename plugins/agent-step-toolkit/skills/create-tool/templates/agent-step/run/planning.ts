// FILE: src/agent-step/run/planning.ts
//
// Plan expansion: tag each user step with its confirmation mode based on
// pending state AT BATCH START. We deliberately do not re-read pending after
// each step is planned — that's what blocks the same-batch propose-then-execute
// bypass: a propose written by step 0 cannot be observed by step 1's planning,
// so step 1 also gets `propose` rather than `execute`. The model must wait for
// a NEW tool call (next turn) to see the pending and re-call with matching
// params. See interaction/confirmation.ts for the full property statement.
//
// Control steps pass through untagged; actions without `requiresConfirmation`
// skip the machine entirely and run as normal steps.
//
// ABORT-AWARENESS: an `abort_pending_input` step destroys the pending gate,
// so confirm steps AFTER it in the same batch are planned against NO pending —
// they propose fresh (with whatever budget the task has left — an abort does
// not refund it) instead of resolving to execute / re-propose against a gate
// the batch just cleared. Without this,
// `[abort, mutation(matching params)]` would execute a mutation whose
// confirmation the same batch aborted.

import type { CompiledPlan } from "../compile/plan.js";
import type { LibraryManagedSlots } from "../state.js";
import {
  confirmLatchKey,
  decideConfirmMode,
  pendingConfirmationOf,
  type ConfirmMode,
} from "../interaction/confirmation.js";
import { ABORT_ACTION } from "../controls/registry.js";
import { getAwaitingInput } from "./batch-state.js";

export interface UserStep {
  action: string;
  params: unknown;
}

export interface PlannedStep extends UserStep {
  confirmMode?: ConfirmMode;
  proposeAttemptsLeft?: number;
}

export function expandPlan<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  userSteps: UserStep[],
  batchStartView: Partial<T>,
  currentCallerTurnId: string | undefined,
): PlannedStep[] {
  const pending = pendingConfirmationOf(getAwaitingInput(batchStartView));
  const spent =
    (batchStartView as { spentLadders?: Record<string, number> | null }).spentLadders ?? {};
  const planned: PlannedStep[] = [];
  let aborted = false;
  for (const s of userSteps) {
    if (plan.controlNames.has(s.action)) {
      if (s.action === ABORT_ACTION) aborted = true;
      planned.push({ action: s.action, params: s.params });
      continue;
    }
    const action = plan.actions[s.action];
    if (action?.confirmation) {
      const effectivePending = aborted ? null : pending;
      const decision = decideConfirmMode(
        action,
        effectivePending,
        s.params,
        currentCallerTurnId,
        spent[confirmLatchKey(action.name)] ?? 0,
      );
      planned.push({
        action: s.action,
        params: s.params,
        confirmMode: decision.mode,
        ...(decision.attemptsLeft !== undefined
          ? { proposeAttemptsLeft: decision.attemptsLeft }
          : {}),
      });
      continue;
    }
    planned.push({ action: s.action, params: s.params });
  }
  return planned;
}
