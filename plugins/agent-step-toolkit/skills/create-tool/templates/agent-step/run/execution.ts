// FILE: src/agent-step/run/execution.ts
//
// Sequential step execution. Each planned step dispatches to either a CONTROL
// (library-owned transition, controls/) or the DOMAIN pipeline below. Any step
// may short-circuit the batch: a control failure, a gate refusal, a prereq
// denial, a param-validation failure, an exhausted confirmation, or a non-ok
// executor all set `failedAt` and stop the loop. Earlier steps' state patches
// stay applied (cumulative commit on partial failure — see run/batch-state.ts).
//
// DOMAIN STEP ORDER (behavior — do not reorder):
//   1. `requiresFlow` gate            (before confirm-mode resolution, so a
//   2. user-declared prereqs           doomed mutation never proposes)
//   3. confirm propose / re-propose   (validate params, store gate + caller
//                                      turn id, NO executor; consumes a
//                                      pending bounded choice ON ACCEPTANCE)
//   4. confirm same-turn lock         (matching re-call on the propose turn —
//                                      refuse, no attempt spent, gate intact)
//   5. confirm exhausted              (clear gate, error out)
//   6. confirm execute                (clear gate atomically, fall through)
//   7. OTP gate                       (live view — same-batch [consumer,
//                                      issuer] chains work)
//   8. match gate                     (BATCH-START frozen — the double-entry
//                                      repeat must arrive in a separate turn)
//   9. OTP-issue-vs-match ordering    (live view)
//  10. param validation               (the action's effective schema; success
//                                      consumes a pending bounded choice — a
//                                      refused/malformed step never burns the
//                                      one-shot)
//  11. pageable cache short-circuit   (self-paginate re-page skips the executor)
//  12. executor invocation
//
// POST-EXECUTION EFFECT ORDER (behavior — do not reorder):
//   a. invalidation cascade (config `invalidations`; BEFORE stateUpdate, so the executor's
//      own re-writes of downstream slots win over the nulls)
//   b. `stateUpdate`                  (domain slots only — guarded)
//   c. `request_handoff` effect      (terminal cleanup + handoff slot; the
//      point where v1 hosts wrote the slot through stateUpdate)
//   d. pageable cache patch
//   e. ok-only lifecycle: flow open/merge → OTP/match gate consumption →
//      `otp_issued` → `startsMatchFor` → `endsFlow` — SKIPPED once a handoff
//      is set (handoff monotonicity: nothing may reopen interaction state)
//   f. ok:false match-mismatch accounting (decrement / exhaust+abort) —
//      likewise skipped once a handoff is set
//   g. `clear_awaiting_input` / `abort_flow` effects (regardless of ok)
//
// HANDOFF MONOTONICITY: once `handoff` is non-null in the view, the batch is
// terminal — sections e/f are skipped and the loop ends after the current
// step, whatever `ok` was.

import { z } from "zod";
import type {
  DeclaredExecutorResult,
  ExecutorEffect,
  ExecutorResult,
  StepResult,
  VerdictDef,
} from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import { ENGINE_TEXT, formatMessage } from "../engine-text.js";
import type { CompiledAction, CompiledPlan } from "../compile/plan.js";
import { CONTROL_REGISTRY } from "../controls/registry.js";
import {
  clearOnProgress,
  climb,
  climbEntry,
  countBounce,
} from "../interaction/escalation.js";
import type { ControlRunContext } from "../controls/contract.js";
import {
  applyPagination,
  tryPageFromCache,
  type PagedCache,
} from "../paginate.js";
import { CONFIRMATION_DEFAULTS, confirmationReplyContract } from "../interaction/confirmation.js";
import { refuseOtpNotPending, refuseOtpIssueWhileMatchPending } from "../interaction/otp.js";
import {
  MATCH_DEFAULT_MAX_ATTEMPTS,
  matchMismatchLifecycle,
  refuseMatchNotPending,
} from "../interaction/match.js";
import { refuseWrongFlow, flowAfterOkStep } from "../interaction/flow.js";
import {
  assertDomainOnlyStateUpdate,
  clearAwaitingInputPatch,
  clearGatePatch,
  clearInteractionPatch,
  getAwaitingInput,
  getCurrentFlow,
  getHandoff,
  requestHandoffPatch,
  setAwaitingMatchPatch,
  setAwaitingOtpPatch,
  setConfirmationPatch,
  setCurrentFlowPatch,
  type BatchState,
} from "./batch-state.js";
import { valueEqual } from "./value-equal.js";
import { isEmptyCaptureCall, resolveSatisfies } from "./satisfies.js";
import type { PlannedStep } from "./planning.js";

/** The batch's running last-text, REGISTER-AWARE: `summary` is host
 *  caller-audible bytes (the model relays), `instruction` is an engine or
 *  host directive (the model follows). The finalizer mirrors it onto the
 *  matching top-level body field. */
export interface LastText {
  register: "summary" | "instruction";
  text: string;
}

export interface ExecutionOutcome {
  results: StepResult[];
  /** Parallel to `results`: the VERDICT ROW that composed each entry, or
   *  `undefined` where the runner raised the entry itself (a bounce, a prereq
   *  denial, a lockdown refusal, a cached page). The standing-ask lifecycle
   *  keys on this — a row that declares no ask serviced the question, while a
   *  runner-raised entry serviced nothing (interaction/dictation.ts). */
  rowKeys: (string | undefined)[];
  failedAt: number | undefined;
  last: LastText | null;
  /** Whether any step actually invoked its executor — the error counter's
   *  neutrality rule keys on it (run/finalize.ts). */
  anExecutorRan: boolean;
}

/** Read an entry's last-text: `instruction` wins when present. A validation
 *  verdict can also carry a caller-audible summary on the result entry. */
function lastOf(entry: StepResult): LastText | null {
  if (typeof entry.instruction === "string") {
    return { register: "instruction", text: entry.instruction };
  }
  if (typeof entry.summary === "string") {
    return { register: "summary", text: entry.summary };
  }
  return null;
}

export async function executeSteps<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  planned: PlannedStep[],
  st: BatchState<T>,
  currentCallerTurnId: string | undefined,
  messages: readonly unknown[] = [],
): Promise<ExecutionOutcome> {
  const { activation } = plan;
  const results: StepResult[] = [];
  // Kept in LOCKSTEP with `results` by `push` below — every entry appends to
  // both, so an entry can never carry another step's row identity.
  const rowKeys: (string | undefined)[] = [];
  const push = (entry: StepResult, rowKey?: string): void => {
    results.push(entry);
    rowKeys.push(rowKey);
  };
  let failedAt: number | undefined;
  let last: LastText | null = null;
  let anExecutorRan = false;

  // Snapshot the awaiting-input gate as it stood at BATCH START — the match
  // gate's consumer check is frozen against it (interaction/match.ts). The OTP
  // gate deliberately reads the live view instead.
  const batchStartAwaiting = getAwaitingInput(st.view);

  const controlCtx: ControlRunContext<T> = {
    messages,
    activation,
    tolerances: plan.tolerances,
    currentCallerTurnId,
    state: st,
  };

  const fail = (entry: StepResult, rowKey?: string): void => {
    push(entry, rowKey);
    last = lastOf(entry) ?? last;
    failedAt = results.length - 1;
  };

  // ─── Bounded patience on unusable captures ────────────────────────────────
  //     The `invalid_params` bounce is deliberately FREE: no gate is stored, no
  //     confirmation attempt is spent, no executor runs — that is what keeps a
  //     caller-capture shape rule out of the model's JSON Schema. The cost is
  //     that no other counter in the pipeline can see it (the gate's
  //     `attemptsLeft` needs a stored gate, `errorCount` needs a verdict, a
  //     host tracker needs the executor), so without a bound the engine
  //     re-asks a mis-supplying caller forever (live incident 2026-08-19:
  //     seven identical bounces in 105 seconds with no exit).
  //
  //     The bound is UNIVERSAL and needs no per-action policy — see
  //     interaction/escalation.ts. Past the tolerance the engine explains
  //     itself once and, if the run continues, escalates. Generic instructions
  //     stay count-free. A declared domain verdict may give length guidance
  //     AFTER validation fails; those facts never enter the input schema.
  const failInvalidParams = (action: CompiledAction, message: string): void => {
    const debug = `Invalid params for "${action.name}": ${message}`;
    const plain: StepResult = {
      action: action.name,
      ok: false,
      ...(action.invalidParamsVerdict
        ? composeRowBody(action.verdicts[action.invalidParamsVerdict], {}, st.view)
        : {}),
      instruction: ENGINE_TEXT.invalid_params,
      error: "invalid_params",
      _debug: debug,
    };
    // Bounded patience needs somewhere to escalate TO. With no library handoff
    // configured there is no exit to climb toward, so the bounce stays the
    // plain, free rejection and nothing is latched — the same behaviour an
    // action without a bounce policy had before the bound was universal.
    if (!activation.handoffEnabled) {
      fail(plain);
      return;
    }
    if (!countBounce(st, plan.tolerances.bounceTolerance).explain) {
      fail(plain);
      return;
    }
    // The caller still owes THIS action's capture, whether the engine explains
    // itself or escalates — and on the exhaust path the finalizer skips the
    // standing-ask lifecycle anyway (a handed-back thread owes nothing).
    const outcome = climb(
      st,
      action.captureField ? action.name : null,
      plan.tolerances.freeExplanations,
    );
    fail(
      climbEntry(action.name, outcome, ENGINE_TEXT.explain_detail_needed, {
        // `invalid_params` keeps the standing ask recorded on the free path:
        // the value is still owed, and the derived bounce re-ask reads it.
        error: "invalid_params",
        _debug: debug,
      }),
    );
  };

  for (const step of planned) {
    // ─── Control dispatch. Admission already refused inactive control names
    //     as unknown (abort excepted — it degrades to a no-op when inactive).
    if (plan.controlNames.has(step.action)) {
      const control = CONTROL_REGISTRY.find((c) => c.name === step.action);
      if (control) {
        const { entry, failed } = control.execute(step.params, controlCtx);
        push(entry);
        last = lastOf(entry) ?? last;
        if (failed) {
          failedAt = results.length - 1;
          break;
        }
        // Handoff monotonicity: a control that set the handoff slot ends the
        // batch (the request control is sole-step by admission, but the
        // invariant is enforced uniformly, not by convention).
        if (getHandoff(st.view) != null) break;
        continue;
      }
    }

    const action = plan.actions[step.action];
    const controller = action.controller;

    // ─── 2. Library-managed flow prereq — BEFORE confirm-mode resolution. A
    //     confirm-required mutation that also `requiresFlow` would otherwise
    //     propose despite the flow being absent, leaving the LLM with a
    //     `needs_confirmation` recap on a doomed action.
    const flowRefusal = refuseWrongFlow(
      step.action,
      controller,
      getCurrentFlow(st.view),
    );
    if (flowRefusal) {
      fail(flowRefusal);
      break;
    }

    // ─── 3. User-declared prereqs — also before confirm-mode resolution, so
    //     propose, re-propose, and execute share the same gate.
    let prereqDenied = false;
    for (const p of action.prereqs) {
      const verifier = plan.verifiers[p];
      if (!verifier.check(st.view as T)) {
        fail({
          action: step.action,
          ok: false,
          instruction: verifier.denial.instruction,
          error: verifier.denial.error,
        });
        prereqDenied = true;
        break;
      }
    }
    if (prereqDenied) break;

    // ─── 4. Confirm-required propose / re-propose: validate params, store the
    //     gate, return needs_confirmation WITHOUT invoking the executor.
    //     Parse with the SAME schema the execute decision compares against
    //     (paramsMatchPending) so stored pending params and re-fired params
    //     are normalized identically. Raw Zod detail goes to `_debug`, never
    //     the summary.
    if (step.confirmMode === "propose" || step.confirmMode === "rePropose") {
      let params: unknown;
      try {
        params = action.effectiveSchema.parse(step.params);
      } catch (err) {
        const message =
          err instanceof z.ZodError
            ? err.issues.map((iss) => iss.message).join("; ")
            : String(err);
        failInvalidParams(action, message);
        break;
      }
      clearOnProgress(st);
      // State-satisfied consent (ActionDef.satisfies, mode "consent"): an
      // EMPTY proposal — no capture field supplied — resolves the declared
      // state paths. Nothing usable answers through the declared elseVerdict
      // row immediately (no gate stored, no attempt spent — the same
      // non-burning semantics as refuseProposal); a resolved bundle proceeds
      // to the ordinary gate, whose read_back becomes the rendered
      // reuse-consent question. The caller's yes re-fires the same empty
      // params, and the execute path resolves the SAME source for the
      // executor — one resolver, so offer and consumption cannot disagree.
      let satisfiedConsent = false;
      if (
        action.satisfies?.mode === "consent" &&
        isEmptyCaptureCall(action, params as Record<string, unknown>)
      ) {
        if (!resolveSatisfies(action, st.view)) {
          const elseKey = action.satisfies.elseVerdict as string;
          const elseRow = action.verdicts[elseKey];
          fail(
            { action: step.action, ok: false, ...composeRowBody(elseRow, {}, st.view) },
            elseKey,
          );
          break;
        }
        satisfiedConsent = true;
      }
      // Propose-time state-aware refusal (ConfirmationOpts.refuseProposal):
      // a schema-valid proposal may still be impossible given state (e.g. an
      // empty capture probing for carried identity that does not exist). It
      // refuses BEFORE anything commits — no gate, no attempt spent, and the
      // pending bounded choice stays unburnt, exactly like `invalid_params`.
      const proposeRefusal = satisfiedConsent
        ? null
        : action.confirmation?.refuseProposal(
            params as Record<string, unknown>,
            st.view,
          );
      if (proposeRefusal) {
        // The refusal NAMES a declared row; the body is composed from it, so
        // the propose-time answer and the executor's own branch for the same
        // outcome are byte-identical by construction (they used to be two
        // hand-kept copies). Naming the row also gives the entry a row key,
        // so the row's `ask` records the standing question exactly as it does
        // on the execute path.
        const refusalRow = action.verdicts[proposeRefusal.verdict];
        if (!refusalRow) {
          throw new Error(
            `action "${step.action}" refuseProposal returned undeclared verdict ` +
              `"${proposeRefusal.verdict}" — declare it in ActionDef.verdicts.`,
          );
        }
        fail(
          {
            action: step.action,
            ok: false,
            ...composeRowBody(refusalRow, proposeRefusal.data ?? {}, st.view),
          },
          proposeRefusal.verdict,
        );
        break;
      }
      const maxAttempts =
        action.confirmation?.maxAttempts ?? CONFIRMATION_DEFAULTS.maxAttempts;
      const attemptsLeft = step.proposeAttemptsLeft ?? maxAttempts;
      const confirmationPatch = setConfirmationPatch<T>(
        step.action,
        params as Record<string, unknown>,
        attemptsLeft,
        maxAttempts,
        currentCallerTurnId,
      );
      const instruction =
        step.confirmMode === "propose"
          ? formatMessage(ENGINE_TEXT.confirm_proposed, { action: step.action })
          : formatMessage(ENGINE_TEXT.confirm_reproposed, { action: step.action });
      // What the runner ACTUALLY recorded, rendered by the host for the model
      // to speak back verbatim (ConfirmationOpts.readBack). The library owns
      // the capture — it sanitized, joined and validated these params — so it
      // owns reporting them back; the host owns only the lexicon.
      const readBack = satisfiedConsent
        ? action.satisfies?.ask?.(st.view)
        : action.confirmation?.readBack(
            params as Record<string, unknown>,
            st.preview(confirmationPatch),
          );
      const hasReadBack = typeof readBack === "string" && readBack.length > 0;
      // Framing for the rendered bytes (what may precede/follow them) — only
      // meaningful when a read-back exists at all.
      const readBackDirective = !hasReadBack
        ? undefined
        : satisfiedConsent
          ? ENGINE_TEXT.read_back_directive_satisfies_consent
          : action.confirmation?.readBackDirective(
              params as Record<string, unknown>,
              st.preview(confirmationPatch),
            );
      const hasDirective =
        typeof readBackDirective === "string" && readBackDirective.length > 0;
      // Commit exactly once. When repetition is enabled, persist the
      // already-rendered bytes on the gate; the repeat control never calls the
      // renderer again against potentially drifted host state.
      st.apply(
        action.confirmation?.repeatReadBack && hasReadBack
          ? setConfirmationPatch<T>(
              step.action,
              params as Record<string, unknown>,
              attemptsLeft,
              maxAttempts,
              currentCallerTurnId,
              readBack,
            )
          : confirmationPatch,
      );
      push({
        action: step.action,
        ok: true,
        instruction,
        needs_confirmation: true,
        proposed_params: params as object,
        ...(hasReadBack ? { read_back: readBack } : {}),
        ...(hasDirective ? { read_back_directive: readBackDirective } : {}),
        attempts_left: attemptsLeft,
        // The gate turn reacts to THIS, not to prompt memory: what each class
        // of caller reply means for the pending proposal (journey-engine G2 —
        // both agents' skipped-yes-turn incidents are this failure class). A
        // non-empty per-action override is that action's SOLE authority.
        reply_contract: confirmationReplyContract(action.confirmation, step.action, activation.toolRepliesEnabled),
      });
      last = { register: "instruction", text: instruction };
      if (activation.toolRepliesEnabled) {
        results[results.length - 1].continuation = "await_caller";
        break;
      }
      continue;
    }

    // ─── 5. Same-turn matching re-call: the proposal was stored on THIS
    //     caller turn, so the caller has not answered the read-back yet.
    //     Refuse without spending an attempt; the gate stays untouched. The
    //     model must wait for the caller's reply (see
    //     interaction/confirmation.ts).
    if (step.confirmMode === "sameTurnLocked") {
      fail({
        action: step.action,
        ok: false,
        instruction: formatMessage(ENGINE_TEXT.confirmation_same_turn_locked, {
          action: step.action,
        }),
        error: "confirmation_same_turn_locked",
      });
      break;
    }

    // ─── 6. Confirm-required attempts exhausted: clear the gate, error out.
    if (step.confirmMode === "exhausted") {
      st.apply(clearAwaitingInputPatch<T>());
      fail({
        action: step.action,
        ok: false,
        instruction: formatMessage(ENGINE_TEXT.confirm_exhausted, {
          action: step.action,
        }),
        error: "confirmation_attempts_exhausted",
      });
      break;
    }

    // ─── 7. Execute mode: clear the gate atomically BEFORE the executor runs.
    if (step.confirmMode === "execute") {
      st.apply(clearAwaitingInputPatch<T>());
    }

    // ─── 7.–9. OTP / match gates (freeze semantics documented per gate).
    const otpRefusal = refuseOtpNotPending(
      step.action,
      controller,
      getAwaitingInput(st.view),
    );
    if (otpRefusal) {
      fail(otpRefusal);
      break;
    }
    const matchRefusal = refuseMatchNotPending(
      step.action,
      controller,
      batchStartAwaiting,
    );
    if (matchRefusal) {
      fail(matchRefusal);
      break;
    }
    const otpIssueRefusal = refuseOtpIssueWhileMatchPending(
      step.action,
      controller,
      getAwaitingInput(st.view),
    );
    if (otpIssueRefusal) {
      fail(otpIssueRefusal);
      break;
    }

    // ─── 10. Params. Pageable actions validate against the schema with the
    //     library-injected page/pageSize merged in.
    let params: unknown;
    try {
      params = action.effectiveSchema.parse(step.params);
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((iss) => iss.message).join("; ")
          : String(err);
      failInvalidParams(action, message);
      break;
    }
    clearOnProgress(st);

    // ─── 11. Pageable self-paginate cache hit: re-page from the
    //     library-managed `pagedRead` slot WITHOUT calling the executor.
    if (action.pageable?.mode === "self") {
      const cache =
        (st.view as { pagedRead?: PagedCache<unknown> | null }).pagedRead ?? null;
      const cachedBody = tryPageFromCache(step.action, action.pageable, params, cache);
      if (cachedBody) {
        push({ action: step.action, ok: true, ...cachedBody });
        // Cached pages re-surface the executor's own host summary.
        if (typeof cachedBody.summary === "string") {
          last = { register: "summary", text: cachedBody.summary };
        }
        continue;
      }
    }

    // ─── Snapshot watched-slot values BEFORE the executor runs, for the
    //     config-level invalidation cascade below (one table for the whole
    //     config — staleness is a fact about the slots, not the writer).
    const watchMap = plan.invalidations;
    const watchedKeys = Object.keys(watchMap);
    const preWatched: Record<string, unknown> = {};
    if (watchedKeys.length > 0) {
      const viewRec = st.view as Record<string, unknown>;
      for (const k of watchedKeys) preWatched[k] = viewRec[k];
    }

    // ─── 12. Execute. The selector projects the running view down to the
    //     slice this executor needs — it can't read anything the selector
    //     didn't hand it.
    const selector = plan.selectors[step.action];
    const executor = plan.executors[step.action];
    const slice = selector(st.view);
    let result: ExecutorResult<T>;
    // The row that composes this step's body — captured from the executor's
    // declared return so the standing-ask lifecycle can key on the ROW rather
    // than on the wire verdict (two rows may emit the same wire code).
    let rowKey: string | undefined;
    anExecutorRan = true; // set before the call — a throw still counts as ran
    try {
      // The declarative return ({verdict, data, …}) is composed into the
      // internal result shape from the action's VerdictDef row; an undeclared
      // verdict throws here and surfaces through the executor_error path
      // below (host bug, loud in _debug). There is NO legacy pass-through —
      // the rows ARE the result space (b8e9e95).
      // State-satisfied execute: an EMPTY call (consent re-call, or a silent
      // ungated call) hands the executor the resolved bundle — the values
      // ride state -> executor and never appear in params or proposed_params.
      const satisfiedSource =
        action.satisfies != null &&
        isEmptyCaptureCall(action, params as Record<string, unknown>)
          ? resolveSatisfies(action, st.view)
          : undefined;
      const declared = await executor(params, slice, satisfiedSource);
      rowKey = declared.verdict;
      result = normalizeExecutorResult(step.action, action, declared, st.view);
    } catch (err) {
      // Executors — and the fetchers / backend client they call — throw on
      // hard failures (backend 5xx, non-JSON, a required URL missing).
      // Convert the throw into an ok:false step and short-circuit, exactly
      // like a returned ok:false: the LLM still receives the
      // { summary, results, failed_at } envelope, and every earlier step's
      // patches stay committed. Without this the throw escapes the runner, no
      // Command is emitted, and those earlier commits are lost.
      const message = err instanceof Error ? err.message : String(err);
      fail({
        action: step.action,
        ok: false,
        instruction: ENGINE_TEXT.executor_error,
        error: "executor_error",
        _debug: `Action "${step.action}" failed: ${message}`,
      });
      break;
    }
    const effects: ExecutorEffect[] = result.effects ?? [];

    // ─── Pageable transform: turn the executor's result into the uniform page
    //     envelope. SELF slices `resultBody.items` (the full set) and emits a
    //     cache patch; DELEGATE wraps the backend's page using `totalCount`.
    let pageCachePatch: Partial<T> | null = null;
    let entryBody = result.resultBody as Record<string, unknown>;
    if (result.ok && action.pageable) {
      const outcome = applyPagination(
        step.action,
        action.pageable,
        params,
        result.resultBody as Record<string, unknown>,
      );
      entryBody = outcome.body;
      pageCachePatch = outcome.cachePatch as Partial<T> | null;
    }

    // The executor's returned verdict IS the row key that composed this body.
    push(
      {
        action: step.action,
        ok: result.ok,
        ...entryBody,
      },
      rowKey,
    );

    // ─── a. invalidation cascade — BEFORE stateUpdate, so the
    //     executor's own re-writes of the same downstream slots win over the
    //     nulls. First-time set (null → value) and same-VALUE re-writes do
    //     not fire.
    if (watchedKeys.length > 0) {
      const stateUpdateRec = (result.stateUpdate ?? {}) as Record<string, unknown>;
      const invalidationPatch: Record<string, unknown> = {};
      for (const watched of watchedKeys) {
        const pre = preWatched[watched];
        if (pre == null) continue;
        if (!(watched in stateUpdateRec)) continue;
        if (valueEqual(pre, stateUpdateRec[watched])) continue;
        for (const downstream of watchMap[watched]) {
          invalidationPatch[downstream] = null;
        }
      }
      if (Object.keys(invalidationPatch).length > 0) {
        st.apply(invalidationPatch as Partial<T>);
      }
    }

    // ─── b. Domain-state patch (applied regardless of ok). Library-managed
    //     slots are rejected loudly — those transitions arrive as effects.
    if (result.stateUpdate) {
      assertDomainOnlyStateUpdate(
        step.action,
        result.stateUpdate as Record<string, unknown>,
      );
      st.apply(result.stateUpdate);
    }

    // ─── c. Terminal handoff effect (regardless of ok — a refusal verdict may
    //     still be terminal). Same atomic cleanup as the built-in control.
    for (const effect of effects) {
      if (effect.type === "request_handoff") {
        st.apply(requestHandoffPatch<T>(effect.request));
      }
    }

    // ─── d. Self-paginate cache miss: persist the full set under its query
    //     signature so a same-query re-page next turn skips the executor.
    if (pageCachePatch) {
      st.apply(pageCachePatch);
    }

    // ─── Handoff monotonicity: once the handoff slot is set, the batch is
    //     terminal — no later transition may (re)open interaction state
    //     (flow, OTP/match gates), and no later step may run. Without this, a
    //     `startsFlow`/`otp_issued` on the same step would reopen slots the
    //     handoff cleanup just cleared, and an ok:true handoff step would let
    //     subsequent steps execute work whose result nobody will see.
    const handoffSet = getHandoff(st.view) != null;

    if (result.ok && !handoffSet) {
      // ─── e. ok-only lifecycle.
      const flowUpdate = flowAfterOkStep(
        step.action,
        controller,
        effects,
        getCurrentFlow(st.view),
      );
      if (flowUpdate) {
        st.apply(setCurrentFlowPatch<T>(flowUpdate.name, flowUpdate.data));
      }

      // requiresOtp / requiresMatch on ok → the gate was consumed. CONSUME
      // BEFORE ISSUE: one action may do both (a confirm action that consumes the
      // double-entry match and mints the OTP in the same step), and
      // `awaitingInput` is a single replace-on-write slot — so opening the new
      // gate first and clearing the old one after would wipe the gate that was
      // just opened and strand the caller with nothing pending. Both orders are
      // equivalent for an action that only consumes OR only issues, which is why
      // this went unnoticed while the two were always separate steps.
      if (controller?.requiresOtp) {
        st.apply(clearAwaitingInputPatch<T>());
      }
      if (controller?.requiresMatch) {
        st.apply(clearAwaitingInputPatch<T>());
      }

      if (effects.some((e) => e.type === "otp_issued")) {
        const finalFlow = getCurrentFlow(st.view);
        if (!finalFlow) {
          throw new Error(
            `agent-step: action "${step.action}" reported otp_issued but no flow is active.`,
          );
        }
        if (!controller?.issuesOtp) {
          throw new Error(
            `agent-step: action "${step.action}" reported otp_issued but config lacks issuesOtp opt.`,
          );
        }
        st.apply(
          setAwaitingOtpPatch<T>(controller.issuesOtp.consumer_action, finalFlow.name),
        );
      }

      // startsMatchFor on ok → open (or reset) the match gate for the named
      // consumer with a fresh attempts counter from the consumer's config.
      // (validate.ts checks the pair at construction; the throw remains as
      // defense for direct runSteps consumers with unvalidated configs.)
      if (controller?.startsMatchFor) {
        const consumerName = controller.startsMatchFor.consumer_action;
        const consumer = plan.actions[consumerName]?.controller;
        if (!consumer?.requiresMatch) {
          throw new Error(
            `agent-step: action "${step.action}" declares startsMatchFor "${consumerName}" but that consumer doesn't declare requiresMatch.`,
          );
        }
        const maxAttempts =
          consumer.requiresMatch.maxAttempts ?? MATCH_DEFAULT_MAX_ATTEMPTS;
        const finalFlow = getCurrentFlow(st.view);
        st.apply(
          setAwaitingMatchPatch<T>(consumerName, maxAttempts, maxAttempts, finalFlow?.name),
        );
      }

      if (controller?.endsFlow) {
        st.apply(clearInteractionPatch<T>());
      }
    } else if (!result.ok && !handoffSet) {
      // ─── f. ok:false — double-entry mismatch accounting (only a
      //     `match_mismatch` verdict spends an attempt).
      const mismatch = matchMismatchLifecycle<T>(
        step.action,
        controller,
        result.resultBody,
        getAwaitingInput(st.view),
      );
      if (mismatch) {
        st.apply(mismatch.patch);
        const entryIndex = results.length - 1;
        results[entryIndex] = { ...results[entryIndex], ...mismatch.entryPatch };
        if (mismatch.exhausted) {
          last = lastOf(results[entryIndex]) ?? last;
        }
      }
    }

    // ─── g. Executor-driven gate clearing (regardless of ok).
    for (const effect of effects) {
      if (effect.type === "clear_awaiting_input") {
        st.apply(clearGatePatch<T>());
      } else if (effect.type === "abort_flow") {
        st.apply(clearInteractionPatch<T>());
      }
    }

    const summary = (result.resultBody as { summary?: string }).summary;
    if (typeof summary === "string") last = { register: "summary", text: summary };

    const continuation = rowKey === undefined ? undefined : action.verdicts[rowKey]?.continuation;
    if (!result.ok && continuation !== "continue") {
      failedAt = results.length - 1;
      break;
    }
    // Handoff monotonicity: an ok step that requested a handoff still ends
    // the batch — later steps must not run.
    if (handoffSet) break;
    // A successful question is still a caller boundary. Do not run the
    // remainder of a speculative batch or ask the model to invent an answer.
    if (continuation && continuation !== "continue") break;
  }

  return { results, rowKeys, failedAt, last, anExecutorRan };
}

/** Compose an executor's declarative return into the runner's internal
 *  ExecutorResult via the action's declared {@link VerdictDef} row. `summary`
 *  renders over the CURRENT state view (language catalogs — the readBack
 *  division); the row's `body` fields compose IN DECLARATION ORDER (wire
 *  order, so a converted action reproduces its historical body bytes);
 *  `resultExtras` append after them; the row's static `stateUpdate`/`effects`
 *  merge UNDER the executor's dynamic ones. */
/** Compose a result body from a declared row: the rendered `summary`, then the
 *  row's `body` fields IN DECLARATION ORDER (wire order). Shared by the
 *  executor path and the propose-time refusal, so one outcome declared once
 *  cannot emit two different bodies depending on which path produced it. */
function composeRowBody(
  row: VerdictDef,
  data: Record<string, unknown>,
  state: unknown,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: typeof row.summary === "function" ? row.summary(state, data) : row.summary,
  };
  for (const [key, value] of Object.entries(row.body ?? {})) {
    body[key] =
      typeof value === "function"
        ? (value as (d: Record<string, unknown>) => unknown)(data)
        : value;
  }
  if (row.continuation !== undefined) body.continuation = row.continuation;
  if (row.presentation === "verbatim") body.reply_text = body.summary;
  return body;
}

function normalizeExecutorResult<T>(
  actionName: string,
  action: CompiledAction,
  raw: DeclaredExecutorResult<T>,
  state: unknown,
): ExecutorResult<T> {
  const row = action.verdicts[raw.verdict];
  if (!row) {
    throw new Error(
      `action "${actionName}" returned undeclared verdict "${raw.verdict}" — ` +
        "declare it in ActionDef.verdicts.",
    );
  }
  const data = raw.data ?? {};
  const body = composeRowBody(row, data, state);
  // Extras APPEND — they may never overwrite a declared field. A collision
  // would let a dynamic executor value silently replace the row's declared
  // verdict/reason/error, i.e. reintroduce exactly the fork the rows exist to
  // prevent (and `summary`/`error` are load-bearing: the failure counter
  // matches on the error code). Loud, because extras are dynamic and no
  // construction check can see them.
  for (const [key, value] of Object.entries(raw.resultExtras ?? {})) {
    if (key in body || key === "continuation" || key === "reply_text") {
      throw new Error(
        `action "${actionName}" verdict "${raw.verdict}": resultExtras key "${key}" ` +
          "collides with a field the declared row already composed — rename the extra, " +
          "or move the value into the row's body.",
      );
    }
    body[key] = value;
  }
  const stateUpdate =
    row.stateUpdate || raw.stateUpdate
      ? ({ ...(row.stateUpdate ?? {}), ...(raw.stateUpdate ?? {}) } as Partial<T>)
      : undefined;
  const effects = [...(row.effects ?? []), ...(raw.effects ?? [])];
  return {
    resultBody: body,
    ok: row.ok,
    ...(stateUpdate !== undefined ? { stateUpdate } : {}),
    ...(effects.length > 0 ? { effects } : {}),
  };
}
