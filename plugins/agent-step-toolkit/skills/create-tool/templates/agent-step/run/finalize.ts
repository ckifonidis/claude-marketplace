// FILE: src/agent-step/run/finalize.ts
//
// Batch finalization: assemble the LLM-facing result body, apply the one
// CROSS-BATCH policy the runner owns — the consecutive-backend-failure counter
// and its auto-handoff — and record the batch into the `actionTrail` audit
// slot.
//
// Trail semantics: one entry per step RESULT of this batch (domain steps,
// controls, the synthetic `auto_handoff`), appended to the trail carried in
// `initialState` and written as the FULL array (the slot is replace-on-write).
// Recording happens HERE, after the body is final, for two reasons: (a) it is
// the single point that sees every result — including the auto-handoff entry
// this phase itself appends and the match-mismatch patches execution applied
// to earlier entries; (b) an admission-refused batch never reaches finalize,
// which keeps the refusal invariant intact: nothing admitted, nothing
// committed, no trail. The projection records `action`/`ok`/`error`/`proposed`
// ONLY — never params or result bodies, so no caller data can enter the trail.
//
// Error-counter semantics: the counter increments on each batch whose failing
// step is a backend failure (the runner-raised `executor_error`, or an
// executor verdict listed in the host's `backendFailureCodes`) and resets to 0
// when a batch in which an executor ACTUALLY RAN ends without one — executed
// work is the only proof the backend recovered. Batches where no executor ran
// (confirm-gate proposals/re-proposals, prereq or param refusals, aborts,
// handoff signals) are NEUTRAL — they neither increment nor reset; without
// this, a confirm-gated action could never reach the threshold (the propose
// interleaved between two failing executes would wipe the streak every
// round). At the threshold the runner writes the library `handoff` slot (when
// handoff is enabled) and/or invokes the host's `onErrorThreshold` callback,
// so the customer is never trapped in an unrecoverable error loop. The
// feature is inert unless one of those two mechanisms is available.
//
// NOTE on the direct `committed` writes: this phase deliberately bypasses
// `BatchState.apply`. Its writes are conditional on what the batch ALREADY
// committed (`handoff` must not overwrite an executor-requested handoff), they
// must not disturb the threaded view (the batch is over), and every touched
// slot is replace-on-write — a reducer merge would be an identity operation.

import type { RunnerResultBody, StepResult } from "../types.js";
import type { HandoffRequest, LibraryManagedSlots, TrailEntry } from "../state.js";
import { formatMessage } from "../messages.js";
import type { CompiledPlan } from "../compile/plan.js";
import type { BatchState } from "./batch-state.js";
import type { ExecutionOutcome } from "./execution.js";

export interface RunResult<T> {
  body: RunnerResultBody;
  committed: Partial<T>;
}

/** Project one step result down to its trail entry. A deliberate allow-list —
 *  `action`, `ok`, the `error` code, and the confirmation-proposal marker —
 *  so no params, summaries, or result-body fields (i.e. nothing caller-derived
 *  beyond the action's own name) can ever reach the trail. */
function trailEntryOf(result: StepResult): TrailEntry {
  const entry: TrailEntry = { action: result.action, ok: result.ok };
  if (typeof result.error === "string") entry.error = result.error;
  if (result.needs_confirmation === true) entry.proposed = true;
  return entry;
}

export function finalizeRun<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  exec: ExecutionOutcome,
  st: BatchState<T>,
  initialState: T,
): RunResult<T> {
  const { msgs } = plan;
  const body: RunnerResultBody = {
    summary: exec.lastSummary || msgs.no_steps,
    results: exec.results,
  };
  if (exec.failedAt !== undefined) body.failed_at = exec.failedAt;

  const autoHandoffEnabled =
    plan.activation.handoffEnabled || plan.onErrorThreshold != null;
  if (autoHandoffEnabled) {
    const prevErrorCount =
      ((initialState as Record<string, unknown>).errorCount as number | null | undefined) ?? 0;
    const failedError =
      body.failed_at !== undefined ? body.results[body.failed_at]?.error : undefined;
    const isBackendFailure =
      typeof failedError === "string" && plan.backendFailureCodes.has(failedError);
    const committedRec = st.committed as Record<string, unknown>;
    if (isBackendFailure) {
      const newErrorCount = prevErrorCount + 1;
      if (newErrorCount >= plan.errorHandoffThreshold) {
        // Threshold reached → escalate. Write the library `handoff` slot (when
        // handoff is enabled and the batch didn't already request one) and/or
        // let the host inject a custom signal.
        if (plan.activation.handoffEnabled && !committedRec.handoff) {
          committedRec.handoff = {
            reason: "abandon",
            context: msgs.auto_handoff,
          } satisfies HandoffRequest;
        }
        if (plan.activation.boundedChoicesEnabled) committedRec.boundedChoice = null;
        plan.onErrorThreshold?.(committedRec, initialState);
        committedRec.errorCount = 0;
        // Platform delivers the wording: the host graph's handoff resolver
        // speaks the closing (possibly overriding `auto_handoff` from state),
        // so instructing the model to voice it invites double-speaking. Hosts
        // whose graph does NOT deliver it can override the template and use
        // the `{message}` placeholder.
        const handoffInstruction = formatMessage(msgs.auto_handoff_instruction, {
          message: msgs.auto_handoff,
        });
        body.results.push({
          action: "auto_handoff",
          ok: true,
          isHandoff: true,
          signal: "abandon",
          successMessage: msgs.auto_handoff,
          summary: handoffInstruction,
        });
        body.summary = handoffInstruction;
        delete body.failed_at;
      } else {
        committedRec.errorCount = newErrorCount;
      }
    } else if (exec.anExecutorRan && prevErrorCount > 0) {
      committedRec.errorCount = 0;
    }
  }

  // ── Trail recording. Direct `committed` write like the error counter above
  //    (the batch is over; the slot is replace-on-write). Base is the trail
  //    carried in `initialState` — previous batches of the SAME task; a
  //    task-ending handback clears the slot (agentStepTaskScopedSlots), so a
  //    reused thread's next task starts from []. An empty batch writes
  //    nothing: no results, no state churn.
  if (body.results.length > 0) {
    const prevTrail =
      ((initialState as Record<string, unknown>).actionTrail as
        | TrailEntry[]
        | null
        | undefined) ?? [];
    (st.committed as Record<string, unknown>).actionTrail = [
      ...prevTrail,
      ...body.results.map(trailEntryOf),
    ];
  }

  return { body, committed: st.committed };
}
