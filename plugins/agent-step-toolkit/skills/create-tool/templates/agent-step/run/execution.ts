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
//   a. `invalidatesOnChange` cascade  (BEFORE stateUpdate, so the executor's
//      own re-writes of downstream slots win over the nulls)
//   b. `stateUpdate`                  (domain slots only — guarded)
//   c. `request_handoff` effect      (terminal cleanup + handoff slot; the
//      point where v1 hosts wrote the slot through stateUpdate)
//   d. pageable cache patch
//   e. ok-only lifecycle: flow open/merge → consume OTP/match gate → `otp_issued`
//      consumption → `startsMatchFor` → `endsFlow` — SKIPPED once a handoff
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
import { formatMessage } from "../messages.js";
import type { CompiledAction, CompiledPlan } from "../compile/plan.js";
import { CONTROL_REGISTRY } from "../controls/registry.js";
import { climbLadder } from "../controls/note-refusal.js";
import type { ControlRunContext } from "../controls/contract.js";
import {
  applyPagination,
  tryPageFromCache,
  type PagedCache,
} from "../paginate.js";
import { CONFIRMATION_DEFAULTS, confirmLatchKey } from "../interaction/confirmation.js";
import type { HandoffRequest } from "../state.js";
import { refuseOtpNotPending, refuseOtpIssueWhileMatchPending } from "../interaction/otp.js";
import {
  MATCH_DEFAULT_MAX_ATTEMPTS,
  matchLatchKey,
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
import type { PlannedStep } from "./planning.js";

export interface ExecutionOutcome {
  results: StepResult[];
  failedAt: number | undefined;
  lastSummary: string;
  /** Whether any step actually invoked its executor — the error counter's
   *  neutrality rule keys on it (run/finalize.ts). */
  anExecutorRan: boolean;
}

export async function executeSteps<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  planned: PlannedStep[],
  st: BatchState<T>,
  currentCallerTurnId: string | undefined,
): Promise<ExecutionOutcome> {
  const { msgs, activation } = plan;
  const results: StepResult[] = [];
  let failedAt: number | undefined;
  let lastSummary = "";
  let anExecutorRan = false;

  // Snapshot the awaiting-input gate as it stood at BATCH START — the match
  // gate's consumer check is frozen against it (interaction/match.ts). The OTP
  // gate deliberately reads the live view instead.
  const batchStartAwaiting = getAwaitingInput(st.view);

  const controlCtx: ControlRunContext<T> = {
    msgs,
    activation,
    currentCallerTurnId,
    state: st,
  };

  const fail = (entry: StepResult): void => {
    results.push(entry);
    lastSummary = entry.summary as string;
    failedAt = results.length - 1;
  };

  // ─── Capture-bounce bound (ActionDef.captureBounces) ──────────────────────
  //     The `invalid_params` bounce is deliberately FREE: no gate is stored, no
  //     confirmation attempt is spent, no executor runs — that is what keeps a
  //     caller-capture shape rule out of the model's JSON Schema. The cost is
  //     that no other counter in the pipeline can see it (the gate's
  //     `attemptsLeft` needs a stored gate, `errorCount` needs a verdict, a
  //     host tracker needs the executor), so an unbounded policy re-asks a
  //     mis-supplying caller forever. Counts live in the task-scoped
  //     `spentLadders` latch under `capture:<action>` — the record that already
  //     carries every once-latch — and a parse that SUCCEEDS clears the run, so
  //     only consecutive failures escalate.
  const captureLatchKey = (action: string): string => `capture:${action}`;

  const spentLaddersOf = (): Record<string, number> =>
    (st.view as { spentLadders?: Record<string, number> | null }).spentLadders ?? {};

  // ─── Gate budgets (confirmation proposals, match mismatches). The gates keep
  //     `attempts_left` on the transient `awaitingInput` slot, which an abort
  //     clears and a capturer re-run rewrites — so the slot alone refunded the
  //     whole budget every time (a bare "no" then a new value, without bound).
  //     What the task has SPENT is mirrored into the same task-scoped latch as
  //     every other once-counter; a fresh gate opens with what is left.

  /** Write (`value`) or drop (`undefined`) one latch entry. */
  const setLatch = (key: string, value: number | undefined): void => {
    const spent = spentLaddersOf();
    if (value === undefined) {
      if (spent[key] === undefined) return;
      const { [key]: _dropped, ...rest } = spent;
      st.apply({ spentLadders: rest } as unknown as Partial<T>);
      return;
    }
    st.apply({ spentLadders: { ...spent, [key]: value } } as unknown as Partial<T>);
  };

  /** A spent gate budget ends the task: apply the gate's `onExhaust` handoff
   *  (default: abandon with the auto-handoff closing) — the same atomic patch
   *  a spent ladder applies. Without a handoff path there is nowhere to
   *  escalate to, so the budget starts over (the historical behaviour) rather
   *  than deadlocking the action for the rest of the thread. */
  const escalateExhausted = (
    key: string,
    onExhaust: HandoffRequest | undefined,
  ): Record<string, unknown> => {
    if (!activation.handoffEnabled || getHandoff(st.view) != null) {
      setLatch(key, undefined);
      return {};
    }
    const request = onExhaust ?? { reason: "abandon", context: msgs.auto_handoff };
    st.apply(requestHandoffPatch<T>(request));
    return {
      summary: formatMessage(msgs.handoff_requested, { reason: request.reason }),
      handoff_requested: true,
      reason: request.reason,
    };
  };

  /** A capture that parsed ends this action's bounce run. */
  const clearCaptureBounces = (action: CompiledAction): void => {
    if (!action.captureBounces) return;
    const key = captureLatchKey(action.name);
    const spent = spentLaddersOf();
    if (spent[key] === undefined) return;
    const { [key]: _spentRun, ...rest } = spent;
    st.apply({ spentLadders: rest } as unknown as Partial<T>);
  };

  /** Bounce a malformed capture. Past the configured run the engine CLIMBS the
   *  configured escalation ladder instead of bouncing plainly: the ladder's
   *  free use returns its instruction (explain/suggest once and re-ask in the
   *  SAME turn) and the use after that applies its `onExhaust` handoff
   *  atomically — the same `climbLadder` core `note_refusal` uses, so there is
   *  one escalation mechanism, not two. Every byte here stays COUNT-FREE: a
   *  count in a capture message measurably makes the model pad digits to
   *  satisfy it. */
  const failInvalidParams = (action: CompiledAction, message: string): void => {
    const debug = `Invalid params for "${action.name}": ${message}`;
    const plain: StepResult = {
      action: action.name,
      ok: false,
      summary: msgs.invalid_params,
      error: "invalid_params",
      _debug: debug,
    };
    const policy = action.captureBounces;
    if (!policy) {
      fail(plain);
      return;
    }
    const key = captureLatchKey(action.name);
    const spent = spentLaddersOf();
    const bounces = (spent[key] ?? 0) + 1;
    st.apply({ spentLadders: { ...spent, [key]: bounces } } as unknown as Partial<T>);
    if (bounces <= policy.max) {
      fail(plain);
      return;
    }
    // The ladder's existence was validated at construction (compile/validate).
    const ladder = activation.ladders[policy.ladder];
    const climb = climbLadder(
      controlCtx,
      policy.ladder,
      ladder.maxFreeUses ?? 1,
      ladder.onExhaust,
    );
    if (climb.exhausted) {
      // The handoff patch is applied; `finalize` skips the standing-ask
      // lifecycle whenever a handoff is set, so nothing is left owing.
      fail({
        action: action.name,
        ok: false,
        summary: climb.summary,
        error: "invalid_params",
        ladder: policy.ladder,
        ladder_exhausted: true,
        handoff_requested: true,
        reason: climb.reason,
        _debug: debug,
      });
      return;
    }
    // Free use: the step still FAILED (`error: invalid_params` keeps the
    // standing ask recorded — the caller still owes the value), but the summary
    // is now the ladder's instruction for this one turn.
    fail({
      action: action.name,
      ok: false,
      summary: ladder.instruction,
      error: "invalid_params",
      ladder: policy.ladder,
      _debug: debug,
    });
  };

  for (const step of planned) {
    // ─── Control dispatch. Admission already refused inactive control names
    //     as unknown (abort excepted — it degrades to a no-op when inactive).
    if (plan.controlNames.has(step.action)) {
      const control = CONTROL_REGISTRY.find((c) => c.name === step.action);
      if (control) {
        const { entry, failed } = control.execute(step.params, controlCtx);
        results.push(entry);
        lastSummary = entry.summary as string;
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
      msgs,
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
          summary: verifier.denial.summary,
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
      clearCaptureBounces(action);
      // Propose-time state-aware refusal (ConfirmationOpts.refuseProposal):
      // a schema-valid proposal may still be impossible given state (e.g. an
      // empty capture probing for carried identity that does not exist). It
      // refuses BEFORE anything commits — no gate, no attempt spent, and the
      // pending bounded choice stays unburnt, exactly like `invalid_params`.
      const proposeRefusal = action.confirmation?.refuseProposal(
        params as Record<string, unknown>,
        st.view,
      );
      if (proposeRefusal) {
        fail({ action: step.action, ok: false, ...proposeRefusal });
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
      const summary =
        step.confirmMode === "propose"
          ? formatMessage(msgs.confirm_proposed, { action: step.action })
          : formatMessage(msgs.confirm_reproposed, { action: step.action });
      // What the runner ACTUALLY recorded, rendered by the host for the model
      // to speak back verbatim (ConfirmationOpts.readBack). The library owns
      // the capture — it sanitized, joined and validated these params — so it
      // owns reporting them back; the host owns only the lexicon.
      const readBack = action.confirmation?.readBack(
        params as Record<string, unknown>,
        st.preview(confirmationPatch),
      );
      const hasReadBack = typeof readBack === "string" && readBack.length > 0;
      // Framing for the rendered bytes (what may precede/follow them) — only
      // meaningful when a read-back exists at all.
      const readBackDirective = hasReadBack
        ? action.confirmation?.readBackDirective(
            params as Record<string, unknown>,
            st.preview(confirmationPatch),
          )
        : undefined;
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
      // The proposal is spent the moment it is stored — an abort will not
      // give it back.
      setLatch(confirmLatchKey(step.action), maxAttempts - attemptsLeft + 1);
      results.push({
        action: step.action,
        ok: true,
        summary,
        needs_confirmation: true,
        proposed_params: params as object,
        ...(hasReadBack ? { read_back: readBack } : {}),
        ...(hasDirective ? { read_back_directive: readBackDirective } : {}),
        attempts_left: attemptsLeft,
        // The gate turn reacts to THIS, not to prompt memory: what each class
        // of caller reply means for the pending proposal (journey-engine G2 —
        // both agents' skipped-yes-turn incidents are this failure class). A
        // non-empty per-action override is that action's SOLE authority.
        reply_contract:
          action.confirmation?.replyContract ||
          formatMessage(msgs.confirm_reply_contract, {
            action: step.action,
          }),
      });
      lastSummary = summary;
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
        summary:
          `The "${step.action}" proposal was made on the current caller turn; ` +
          "wait for the caller's confirmation before executing.",
        error: "confirmation_same_turn_locked",
      });
      break;
    }

    // ─── 6. Confirm-required attempts exhausted: clear the gate, escalate.
    if (step.confirmMode === "exhausted") {
      st.apply(clearAwaitingInputPatch<T>());
      fail({
        action: step.action,
        ok: false,
        summary: formatMessage(msgs.confirm_exhausted, { action: step.action }),
        error: "confirmation_attempts_exhausted",
        ...escalateExhausted(confirmLatchKey(step.action), action.confirmation?.onExhaust),
      });
      break;
    }

    // ─── 7. Execute mode: clear the gate atomically BEFORE the executor runs.
    //     The caller accepted a proposal — the only event that refunds the
    //     action's proposal budget.
    if (step.confirmMode === "execute") {
      st.apply(clearAwaitingInputPatch<T>());
      setLatch(confirmLatchKey(step.action), undefined);
    }

    // ─── 7.–9. OTP / match gates (freeze semantics documented per gate).
    const otpRefusal = refuseOtpNotPending(
      step.action,
      controller,
      getAwaitingInput(st.view),
      msgs,
    );
    if (otpRefusal) {
      fail(otpRefusal);
      break;
    }
    const matchRefusal = refuseMatchNotPending(
      step.action,
      controller,
      batchStartAwaiting,
      msgs,
    );
    if (matchRefusal) {
      fail(matchRefusal);
      break;
    }
    const otpIssueRefusal = refuseOtpIssueWhileMatchPending(
      step.action,
      controller,
      getAwaitingInput(st.view),
      msgs,
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
    clearCaptureBounces(action);

    // ─── 11. Pageable self-paginate cache hit: re-page from the
    //     library-managed `pagedRead` slot WITHOUT calling the executor.
    if (action.pageable?.mode === "self") {
      const cache =
        (st.view as { pagedRead?: PagedCache<unknown> | null }).pagedRead ?? null;
      const cachedBody = tryPageFromCache(step.action, action.pageable, params, cache);
      if (cachedBody) {
        results.push({ action: step.action, ok: true, ...cachedBody });
        lastSummary = (cachedBody.summary as string | undefined) ?? lastSummary;
        continue;
      }
    }

    // ─── Snapshot watched-slot values BEFORE the executor runs, for the
    //     invalidatesOnChange cascade below.
    const watchMap = action.invalidatesOnChange;
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
    anExecutorRan = true; // set before the call — a throw still counts as ran
    try {
      // The declarative return ({verdict, data, …}) is composed into the
      // internal result shape from the action's VerdictDef row; an undeclared
      // verdict throws here and surfaces through the executor_error path
      // below (host bug, loud in _debug). There is NO legacy pass-through —
      // the rows ARE the result space (b8e9e95).
      result = normalizeExecutorResult(step.action, action, await executor(params, slice), st.view);
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
        summary: msgs.executor_error,
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

    results.push({
      action: step.action,
      ok: result.ok,
      ...entryBody,
    });

    // ─── a. invalidatesOnChange cascade — BEFORE stateUpdate, so the
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
        // Matched — the only event that refunds the mismatch budget.
        setLatch(matchLatchKey(step.action), undefined);
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
      // consumer with what is LEFT of the consumer's budget: a re-capture
      // changes the first entry, it does not refund spent mismatches.
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
        const attemptsLeft = Math.max(
          1,
          maxAttempts - (spentLaddersOf()[matchLatchKey(consumerName)] ?? 0),
        );
        st.apply(
          setAwaitingMatchPatch<T>(consumerName, attemptsLeft, maxAttempts, finalFlow?.name),
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
        msgs,
      );
      if (mismatch) {
        st.apply(mismatch.patch);
        const entryIndex = results.length - 1;
        results[entryIndex] = { ...results[entryIndex], ...mismatch.entryPatch };
        const key = matchLatchKey(step.action);
        if (mismatch.exhausted) {
          results[entryIndex] = {
            ...results[entryIndex],
            ...escalateExhausted(key, controller?.requiresMatch?.onExhaust),
          };
          lastSummary = results[entryIndex].summary as string;
        } else {
          const live = getAwaitingInput(st.view);
          if (live?.kind === "match") {
            setLatch(key, live.max_attempts - live.attempts_left);
          }
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
    if (typeof summary === "string") lastSummary = summary;

    if (!result.ok) {
      failedAt = results.length - 1;
      break;
    }
    // Handoff monotonicity: an ok step that requested a handoff still ends
    // the batch — later steps must not run.
    if (handoffSet) break;
  }

  return { results, failedAt, lastSummary, anExecutorRan };
}

/** Compose an executor's declarative return into the runner's internal
 *  ExecutorResult via the action's declared {@link VerdictDef} row. `summary`
 *  renders over the CURRENT state view (language catalogs — the readBack
 *  division); the row's `body` fields compose IN DECLARATION ORDER (wire
 *  order, so a converted action reproduces its historical body bytes);
 *  `resultExtras` append after them; the row's static `stateUpdate`/`effects`
 *  merge UNDER the executor's dynamic ones. */
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
  const body: Record<string, unknown> = {
    summary: typeof row.summary === "function" ? row.summary(state, data) : row.summary,
  };
  for (const [key, value] of Object.entries(row.body ?? {})) {
    body[key] =
      typeof value === "function"
        ? (value as (d: Record<string, unknown>) => unknown)(data)
        : value;
  }
  Object.assign(body, raw.resultExtras ?? {});
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
