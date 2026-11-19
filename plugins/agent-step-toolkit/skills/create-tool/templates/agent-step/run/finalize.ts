// FILE: src/agent-step/run/finalize.ts
//
// Batch finalization: assemble the LLM-facing result body, then apply the one
// CROSS-BATCH policy the runner owns — the consecutive-backend-failure counter
// and its auto-handoff.
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

import type { RunnerResultBody } from "../types.js";
import type { HandoffRequest, LibraryManagedSlots } from "../state.js";
import { ENGINE_TEXT, formatMessage } from "../engine-text.js";
import { AUTO_HANDOFF_CONTEXT } from "../handoff/contract.js";
import type { CompiledPlan } from "../compile/plan.js";
import { askOfFinalEntry, dictationAfterBatch } from "../interaction/dictation.js";
import { getAwaitingInput, getHandoff, type BatchState } from "./batch-state.js";
import type { ExecutionOutcome } from "./execution.js";

export interface RunResult<T> {
  body: RunnerResultBody;
  committed: Partial<T>;
}

export function finalizeRun<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  exec: ExecutionOutcome,
  st: BatchState<T>,
  initialState: T,
): RunResult<T> {
  // The top-level body mirrors the last entry's text on the field matching
  // its REGISTER: host caller-audible bytes under `summary`, engine/host
  // directives under `instruction`. An empty batch is an engine instruction.
  const body: RunnerResultBody = { results: exec.results };
  if (exec.last) {
    body[exec.last.register] = exec.last.text;
  } else {
    body.instruction = ENGINE_TEXT.no_steps;
  }
  if (exec.failedAt !== undefined) body.failed_at = exec.failedAt;

  // ─── Standing-ask lifecycle (`VerdictDef.ask` → the `dictation` awaiting
  //     kind): the batch's FINAL entry decides the standing question — set the
  //     mapped ask, clear a serviced one, never disturb a live gate. Skipped
  //     entirely on a handoff (the terminal cleanup already cleared the slot,
  //     and a handed-back thread owes nothing). Applied through the same
  //     direct-`committed` channel as the error counter below: the batch is
  //     over, and `awaitingInput` is replace-on-write.
  if (getHandoff(st.view) == null) {
    const transition = dictationAfterBatch(plan, exec.results, exec.rowKeys, getAwaitingInput(st.view));
    if (transition !== undefined) {
      let awaiting =
        transition === null ? null : (transition as Record<string, unknown>).awaitingInput;
      // Host-rendered ask bytes, when the ask declares them: the model speaks
      // `ask_text` exactly instead of reciting a catalog line from prompt
      // memory (which measurably drifts). Rendered ONCE here, then (a) stored
      // on the dictation record so `repeat_pending_question` can re-present
      // the standing question byte-exact, and (b) stamped on the final entry.
      const askText = askOfFinalEntry(plan, exec.results, exec.rowKeys)?.render?.(st.view);
      if (awaiting != null && typeof askText === "string" && askText.length > 0) {
        awaiting = { ...(awaiting as Record<string, unknown>), ask_text: askText };
      }
      (st.committed as Record<string, unknown>).awaitingInput = awaiting;
      // Make the recorded ask VISIBLE on the final entry — the transcript is
      // the model's only authority for engine state (never injected into the
      // prompt), so a silent record would leave the model unaware the system
      // now expects this value.
      const dictation = awaiting as { for_action?: string; param?: string } | null;
      if (dictation?.for_action && dictation.param && body.results.length > 0) {
        const lastIndex = body.results.length - 1;
        body.results[lastIndex] = {
          ...body.results[lastIndex],
          standing_ask: { action: dictation.for_action, param: dictation.param },
          ...(typeof askText === "string" && askText.length > 0
            ? { ask_text: askText }
            : {}),
          ask_contract: formatMessage(plan.askContract, {
            action: dictation.for_action,
            param: dictation.param,
          }),
        };
      }
    }
  }

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
      if (newErrorCount >= plan.tolerances.errorHandoffThreshold) {
        // Threshold reached → escalate. Write the library `handoff` slot (when
        // handoff is enabled and the batch didn't already request one) and/or
        // let the host inject a custom signal.
        if (plan.activation.handoffEnabled && !committedRec.handoff) {
          // STRUCTURAL marker, never prose: the host's resolveClosingMessage
          // matches this context code to render the caller-facing closing in
          // the session language. The engine never authors spoken bytes.
          committedRec.handoff = {
            reason: "abandon",
            context: AUTO_HANDOFF_CONTEXT,
          } satisfies HandoffRequest;
        }
        // Latch clears at the threshold. Deliberately NOT a loop over
        // agentStepTaskScopedSlots: writing null to a channel a minimal host
        // never declared is a LangGraph error, so each clear stays gated on
        // the feature that required the channel — and the resolver's
        // task-scoped sweep (handoff/node.ts) is the loop-driven authority
        // when a handoff path exists. The invariant that no task-scoped slot
        // survives the resolved handback is pinned by test instead.
        if (true) committedRec.spentLadders = null;
        plan.onErrorThreshold?.(committedRec, initialState);
        committedRec.errorCount = 0;
        // Platform delivers the wording: the host graph's handoff resolver
        // renders and speaks the closing from state, so instructing the model
        // to voice anything invites double-speaking.
        body.results.push({
          action: "auto_handoff",
          ok: true,
          isHandoff: true,
          signal: "abandon",
          instruction: ENGINE_TEXT.auto_handoff_instruction,
        });
        body.instruction = ENGINE_TEXT.auto_handoff_instruction;
        delete body.summary;
        delete body.failed_at;
      } else {
        committedRec.errorCount = newErrorCount;
      }
    } else if (exec.anExecutorRan && prevErrorCount > 0) {
      committedRec.errorCount = 0;
    }
  }

  return { body, committed: st.committed };
}
