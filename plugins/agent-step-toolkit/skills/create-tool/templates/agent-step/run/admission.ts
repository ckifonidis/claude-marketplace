// FILE: src/agent-step/run/admission.ts
//
// Batch admission: every whole-batch precondition, checked in a FIXED order
// before plan expansion. Each rule either refuses the batch (a single result
// entry, `failed_at: 0`, nothing committed) or passes to the next. The order
// is behavior — later rules assume earlier ones passed:
//
//   1. unknown action           — hallucinated/typo'd names, structured refusal
//   4. gate lockdown            — a pending confirmation/OTP/match admits only
//                                 its target action / abort / handoff / choice
//                                 controls (+ the capturer, for match)
//   5. flow mutex               — opening a DIFFERENT flow while one is active
//   6. control exclusivity      — sole-step control families (handoff,
//                                 bounded-choice), in registry-group order
//   7. abort policy             — optional host source/follower allow-lists
//   8. soleStep / soleOnExecute — per-action batch-isolation opts
//
// Lockdown (cross-turn, "the customer owes an answer") and exclusivity
// (within-batch, "this transition cannot share a batch") are distinct rules
// on purpose — see the individual rule comments.

import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import { ENGINE_TEXT, formatMessage } from "../engine-text.js";
import type { CompiledPlan } from "../compile/plan.js";
import { ABORT_ACTION, EXCLUSIVITY_GROUPS } from "../controls/registry.js";
import {
  paramsMatchPending,
  pendingConfirmationOf,
} from "../interaction/confirmation.js";
import {
  getAwaitingInput,
  getCurrentFlow,
} from "./batch-state.js";
import type { UserStep } from "./planning.js";

/** A refused batch: one result entry; the runner shapes it into the standard
 *  `{ summary, results: [entry], failed_at: 0 }` body with nothing committed. */
export interface BatchRefusal {
  entry: StepResult;
}

export function admitBatch<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  userSteps: UserStep[],
  view: Partial<T>,
  currentCallerTurnId: string | undefined,
): BatchRefusal | null {
  const { activation } = plan;
  const first = userSteps[0];

  // ── 1. Unknown-action defense. The LangChain wrapper validates input against
  //    the Zod discriminated union before the run starts, so production traffic
  //    can't reach here. But `runSteps` is also the public test seam and is
  //    callable directly by non-LangChain consumers — guard against
  //    hallucinated/typo'd action names with a structured refusal instead of a
  //    crash (executor lookup would otherwise dereference undefined). The abort
  //    control is accepted even when inactive (it executes as a no-op).
  for (const s of userSteps) {
    if (s.action === ABORT_ACTION) continue;
    if (plan.controlNames.has(s.action)) continue;
    if (plan.actions[s.action]) continue;
    return {
      entry: {
        action: s.action,
        ok: false,
        instruction: formatMessage(ENGINE_TEXT.unknown_action, { action: s.action }),
        error: "unknown_action",
      },
    };
  }

  // ── 4. Gate lockdown: if anything is awaiting customer input, the batch's
  //    first step must be the targeted `for_action` (plan expansion / the gate
  //    check resolves what happens next), an allowed control, or — for match —
  //    the capturer, so the customer can re-capture (e.g. enter a different
  //    first PIN) without aborting the flow, or — for otp — an ISSUER of that
  //    gate, so a code that never arrived can be re-sent without aborting.
  //    Abort may lead a multi-step batch: subsequent steps run after the gate
  //    is cleared.
  //
  //    No library-side TTL on any slot — confirmation and OTP are both
  //    conversation-driven. Stale state is cleared by `abort_pending_input` or
  //    executor effects; the runner doesn't time anything out on its own.
  //
  const awaiting = getAwaitingInput(view);
  const gate = awaiting;
  if (gate) {
    // Confirmation lockdown defaults to true and is overridable per action;
    // OTP and match lockdown are always on — no opt to disable. A dictation
    // never locks: it is the record of the standing question, not a gate —
    // the caller may legitimately pivot.
    const isLocked =
      gate.kind === "confirmation"
        ? plan.actions[gate.for_action]?.confirmation?.lockdown !== false
        : gate.kind !== "dictation";
    if (isLocked) {
      let capturer: string | null = null;
      if (gate.kind === "match") {
        capturer =
          plan.actions[gate.for_action]?.controller?.requiresMatch?.capturer ?? null;
      }
      // An OTP gate's ISSUER may re-run, for exactly the reason the match gate
      // lets its capturer re-run: the customer whose code never arrived or has
      // expired must be able to ask for another one WITHOUT aborting — and abort
      // takes the whole flow (with the captured PIN) down with it. Re-issuing
      // replaces this gate with a fresh one, so the invariant "one gate at a
      // time, and it belongs to the flow" is untouched. Observed on a live
      // host: "resend the code" → `otp_pending_locked` → abort → `no_flow_active`
      // → the caller had to restart the flow from identification.
      // Scoped to the gate's OWN flow: an action that issues for this consumer
      // but opens a DIFFERENT flow is not a re-send, it is an unrelated action
      // that would strand the pending code.
      const otpIssuers =
        gate.kind === "otp"
          ? Object.keys(plan.actions).filter((name) => {
              const c = plan.actions[name]?.controller;
              return (
                c?.issuesOtp?.consumer_action === gate.for_action &&
                c?.requiresFlow !== undefined &&
                c.requiresFlow === gate.flow_ref
              );
            })
          : [];
      const allowed =
        !!first &&
        (first.action === gate.for_action ||
          first.action === ABORT_ACTION ||
          // A handoff abandons the conversation path entirely and must work
          // while locked.
          plan.controls.some(
            (c) => c.allowedDuringGateLockdown && c.name === first.action,
          ) ||
          (capturer !== null && first.action === capturer) ||
          otpIssuers.includes(first.action));
      if (!allowed) {
        const errorCode =
          gate.kind === "confirmation"
            ? "pending_confirmation_locked"
            : gate.kind === "otp"
              ? "otp_pending_locked"
              : "match_pending_locked";
        const lockdownVars = {
          action: gate.for_action,
          abort_action: ABORT_ACTION,
          capturer: capturer ?? "",
        };
        const instruction =
          gate.kind === "confirmation"
            ? formatMessage(ENGINE_TEXT.lockdown_confirmation, lockdownVars)
            : gate.kind === "otp"
              ? formatMessage(ENGINE_TEXT.lockdown_otp, lockdownVars)
              : formatMessage(ENGINE_TEXT.lockdown_match, lockdownVars);
        return {
          entry: {
            action: first?.action ?? "(empty)",
            ok: false,
            instruction,
            error: errorCode,
            awaiting: { kind: gate.kind, for_action: gate.for_action },
          },
        };
      }
    }
  }

  // ── 5. Flow mutex: if ANY step opens a flow (`startsFlow`) while a
  //    DIFFERENT flow is active, refuse. `startsFlow` is idempotent within the
  //    same flow — the executor will re-run (e.g. to re-issue an OTP) without
  //    resetting `currentFlow.data`.
  //
  //    Every step, not just the first. Checking only `first` let a batch of
  //    [read, open_other_flow] past the mutex, and `flowAfterOkStep` then took
  //    its "admission already refused this" branch and did nothing — so the
  //    second step's executor RAN (issuing its OTP, doing its backend work)
  //    while `currentFlow` silently stayed the OLD flow, and anything it
  //    merged landed in the wrong flow's data bag. Harmless while a host has
  //    one flow (this one), reachable the moment it has two.
  //
  //    A step EARLIER in the batch may legitimately clear the flow, which is
  //    the library's supported "end the old flow before starting the new one":
  //    `abort_pending_input` clears the whole interaction, and `endsFlow`
  //    closes it on success. So the scan tracks whether a flow is still active
  //    at each position rather than testing every step against batch-start
  //    state — otherwise the supported [abort, open_other_flow] sequence would
  //    be refused. Runtime-only clearers (an `abort_flow` effect) cannot be
  //    seen here; treating a statically-unknowable case as "still active"
  //    would refuse a legal batch, so only declared clearers count.
  //
  //    The scan deliberately does NOT predict flows this batch would OPEN:
  //    whether a later `startsFlow` conflicts depends on whether the earlier
  //    one actually succeeded, so predicting forward invents refusals for
  //    legal batches — and, when a batch is malformed for a second reason,
  //    preempts the more accurate error ([abort, open_a, open_b] must report
  //    `abort_too_many_followers`, not a flow conflict). Two different
  //    `startsFlow` steps in ONE batch therefore still reach
  //    `flowAfterOkStep`, whose no-op branch leaves the first flow standing;
  //    catching that needs a per-step check at execution time, where the flow
  //    state is current.
  const currentFlow = getCurrentFlow(view);
  let activeFlowName = currentFlow?.name;
  for (const step of userSteps) {
    if (step.action === ABORT_ACTION) {
      activeFlowName = undefined;
      continue;
    }
    const controller = plan.actions[step.action]?.controller;
    if (activeFlowName && controller?.startsFlow && controller.startsFlow.name !== activeFlowName) {
      return {
        entry: {
          action: step.action,
          ok: false,
          instruction: ENGINE_TEXT.flow_already_active,
          error: "flow_already_active",
          active_flow: activeFlowName,
        },
      };
    }
    if (controller?.endsFlow) activeFlowName = undefined;
  }

  // ── 6. Control exclusivity, in group order: a sole-step control mixed into
  //    a larger batch refuses the whole batch. Only groups with an ACTIVE
  //    member are evaluated (an inactive control name was already refused as
  //    unknown above).
  if (userSteps.length > 1) {
    for (const group of EXCLUSIVITY_GROUPS) {
      const activeMembers = group.memberNames.filter((n) => plan.controlNames.has(n));
      if (activeMembers.length === 0) continue;
      const found = userSteps.find((s) => activeMembers.includes(s.action));
      if (!found) continue;
      return {
        entry: {
          action: found.action,
          ok: false,
          instruction: group.instruction(found.action),
          error: group.errorCode,
        },
      };
    }
  }

  // ── 7. Optional abort policy. Omission preserves the legacy permissive
  //    behavior. Once configured, abort is an explicit in-domain transition:
  //    it leads the batch, clears something real when required, and has at
  //    most one declared domain follower. Control followers are never legal;
  //    in particular request_handoff was already refused by the sole-step
  //    exclusivity rule above.
  const abortPolicy = activation.abortPolicy;
  const abortIndex = userSteps.findIndex((step) => step.action === ABORT_ACTION);
  if (abortPolicy && abortIndex !== -1) {
    if (abortIndex !== 0) {
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          instruction: formatMessage(ENGINE_TEXT.abort_must_be_first, {
            abort_action: ABORT_ACTION,
          }),
          error: "abort_must_be_first",
        },
      };
    }

    const hasActiveTarget = awaiting != null || currentFlow != null;
    if (abortPolicy.requireActive && !hasActiveTarget) {
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          instruction: formatMessage(ENGINE_TEXT.abort_requires_active, {
            abort_action: ABORT_ACTION,
          }),
          error: "abort_requires_active_input",
        },
      };
    }

    // A pending CHOICE has no target action of its own; its abort target is
    // the suspended gate underneath.
    const awaitingTarget = gate;
    if (
      abortPolicy.allowedPendingTargets !== null &&
      (awaitingTarget == null ||
        !abortPolicy.allowedPendingTargets.includes(awaitingTarget.for_action))
    ) {
      const allowed = abortPolicy.allowedPendingTargets
        .map((name) => `"${name}"`)
        .join(", ");
      const instruction =
        awaitingTarget == null
          ? formatMessage(ENGINE_TEXT.abort_no_pending_target, {
              abort_action: ABORT_ACTION,
              allowed,
            })
          : formatMessage(ENGINE_TEXT.abort_pending_target_not_allowed, {
              abort_action: ABORT_ACTION,
              target: awaitingTarget.for_action,
              allowed,
            });
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          instruction,
          error: "abort_pending_target_not_allowed",
          ...(awaitingTarget
            ? {
                awaiting: {
                  kind: awaitingTarget.kind,
                  for_action: awaitingTarget.for_action,
                },
              }
            : {}),
        },
      };
    }

    const followers = userSteps.slice(1);
    if (followers.length === 0 && !abortPolicy.allowStandalone) {
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          instruction: formatMessage(ENGINE_TEXT.abort_follower_required, {
            abort_action: ABORT_ACTION,
          }),
          error: "abort_follower_required",
        },
      };
    }
    if (followers.length > 1) {
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          instruction: formatMessage(ENGINE_TEXT.abort_too_many_followers, {
            abort_action: ABORT_ACTION,
          }),
          error: "abort_too_many_followers",
        },
      };
    }
    const follower = followers[0];
    if (follower) {
      const isDomainAction = plan.actions[follower.action] != null;
      const isAllowed =
        abortPolicy.allowedFollowers === null ||
        abortPolicy.allowedFollowers.includes(follower.action);
      if (!isDomainAction || !isAllowed) {
        return {
          entry: {
            action: follower.action,
            ok: false,
            instruction: formatMessage(ENGINE_TEXT.abort_follower_not_allowed, {
              action: follower.action,
              abort_action: ABORT_ACTION,
            }),
            error: "abort_follower_not_allowed",
          },
        };
      }
    }
  }

  // ── 8. soleStep / soleOnExecute. Distinct from lockdown — lockdown bars
  //    unrelated actions ACROSS turns while pending; these opts bar them
  //    WITHIN a single batch.
  //    - `soleStep`: strict — refuse any batch larger than 1 containing this
  //      action, regardless of confirm-mode.
  //    - `soleOnExecute`: relaxed — propose/re-propose modes may ride along
  //      (but only as the last step); execute mode must be alone. Lets the
  //      LLM batch `[reads..., propose-mutation]` in one tool call. Uses
  //      batch-start pending to predict execute-vs-propose, matching plan
  //      expansion's freeze.
  const soleCheckPending = pendingConfirmationOf(awaiting);
  let sawAbort = false;
  for (let i = 0; i < userSteps.length; i++) {
    const s = userSteps[i];
    if (s.action === ABORT_ACTION) {
      sawAbort = true;
      continue;
    }
    const m = plan.actions[s.action]?.controller;
    if (!m) continue;
    if (m.soleStep && userSteps.length > 1) {
      return {
        entry: {
          action: s.action,
          ok: false,
          instruction: formatMessage(ENGINE_TEXT.mutation_must_be_sole_step, {
            action: s.action,
          }),
          error: "mutation_must_be_sole_step",
        },
      };
    }
    if (m.soleOnExecute && !m.soleStep && userSteps.length > 1) {
      // Abort-aware, mirroring plan expansion: a preceding abort destroys the
      // gate, so a later matching step is a fresh PROPOSE (rideable at the
      // tail), not an execute.
      const isExecute =
        !sawAbort &&
        !!soleCheckPending &&
        soleCheckPending.action === s.action &&
        paramsMatchPending(plan.actions[s.action], soleCheckPending.params, s.params);
      if (isExecute) {
        return {
          entry: {
            action: s.action,
            ok: false,
            instruction: formatMessage(ENGINE_TEXT.mutation_execute_must_be_sole, {
              action: s.action,
            }),
            error: "mutation_must_be_sole_step",
          },
        };
      }
      if (i !== userSteps.length - 1) {
        return {
          entry: {
            action: s.action,
            ok: false,
            instruction: formatMessage(ENGINE_TEXT.mutation_must_be_last_in_batch, {
              action: s.action,
            }),
            error: "mutation_must_be_last_in_batch",
          },
        };
      }
    }
  }

  return null;
}
