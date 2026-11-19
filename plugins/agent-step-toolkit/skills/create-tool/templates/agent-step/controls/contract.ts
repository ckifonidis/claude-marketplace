// FILE: src/agent-step/controls/contract.ts
//
// A CONTROL is a library-owned, model-facing action that performs a pure
// orchestration transition — no domain executor, no backend I/O. Controls are
// first-class participants: one `ControlAction` implementation carries
// everything the engine needs, so adding a control never requires editing the
// compile or run phases:
//
//   - activation      — when the control is injected (schema + description +
//                       reserved-name validation), from `activeWhen`;
//   - model surface   — its schema variant and its line in the composed tool
//                       description;
//   - admission       — whether it may lead a locked batch
//                       (`allowedDuringGateLockdown`,
//                       `allowedDuringChoicePending`), how it escapes the
//                       resolved-choice same-turn lock (`sameTurnEscape`),
//                       and its batch-exclusivity group (`exclusivityGroup`);
//   - execution       — `execute()`, which applies its state transition
//                       through the batch-state patch vocabulary and returns
//                       the LLM-facing result entry.
//
// The registry (controls/registry.ts) fixes the injection ORDER — part of the
// model-facing surface, do not reorder.

import type { z } from "zod";
import type { StepResult } from "../types.js";
import type { HandoffRequest, LibraryManagedSlots } from "../state.js";
import type { BatchState } from "../run/batch-state.js";
import type { EngineTolerances } from "../tolerances.js";

/** Optional host policy for the built-in `abort_pending_input` control.
 *
 * Omit the policy to preserve the legacy, permissive behaviour. When present,
 * abort is a deliberately narrow in-domain transition: it must lead the batch,
 * may be required to have something to clear, and may only continue into one
 * configured domain action. The action-name generic keeps the allow-list tied
 * to the host's declared domain surface at construction time. */
export interface AbortPolicy<ActionName extends string> {
  /** Refuse abort when no confirmation/OTP/match, flow, or pending bounded
   * choice is active. A resolved choice is a persistent one-shot marker, not
   * active caller input. Default `false`. */
  requireActive?: boolean;
  /** Permit abort as the batch's only step. When `false`, exactly one legal
   * follower is required. Default `true`. */
  allowStandalone?: boolean;
  /** Domain actions which may immediately follow abort. Omit to allow any
   * declared domain action; an empty list permits no follower. */
  allowedFollowers?: readonly ActionName[];
  /** Pending-input action targets from which abort is permitted. When set,
   * batch-start `awaitingInput` must exist and its `for_action` must be in this
   * list; an active flow or pending bounded choice alone is not sufficient.
   * Omit to allow abort from any active interaction target. */
  allowedPendingTargets?: readonly ActionName[];
}

/** Compile-time-normalized abort policy consumed by controls and admission.
 * `null` is meaningful: no policy was configured, so legacy behaviour stays
 * byte-for-byte compatible. */
export interface ResolvedAbortPolicy {
  requireActive: boolean;
  allowStandalone: boolean;
  allowedFollowers: readonly string[] | null;
  allowedPendingTargets: readonly string[] | null;
}

export function resolveAbortPolicy<ActionName extends string>(
  policy: AbortPolicy<ActionName> | undefined,
): ResolvedAbortPolicy | null {
  if (!policy) return null;
  return {
    requireActive: policy.requireActive ?? false,
    allowStandalone: policy.allowStandalone ?? true,
    allowedFollowers:
      policy.allowedFollowers === undefined ? null : [...policy.allowedFollowers],
    allowedPendingTargets:
      policy.allowedPendingTargets === undefined
        ? null
        : [...policy.allowedPendingTargets],
  };
}

/** What the compile phase resolved about which library features are on. Built
 *  once per plan (compile/plan.ts); drives control activation everywhere. */
export interface ControlActivation {
  /** Any action opted into a library-managed gate or flow lifecycle. */
  hasLifecycleOpts: boolean;
  handoffEnabled: boolean;
  /** Host override for the `request_handoff` schema-variant description. */
  handoffActionDescription?: string;
  /** Effective model-facing AND runtime schema for `request_handoff`. The
   * base handoff state/effect schema remains broader and library-owned. */
  handoffModelRequestSchema: z.ZodType<HandoffRequest>;
  /** `null` preserves the legacy permissive abort mechanics. */
  abortPolicy: ResolvedAbortPolicy | null;
  /** Confirm-gated domain actions which opted into exact stored read-back
   *  repetition. Non-empty activates `repeat_pending_question`; the control
   *  still verifies that the current gate belongs to one of these actions
   *  and actually carries a rendered read-back. (A standing dictation with
   *  stored `ask_text` is also served once active — a safety net for a stray
   *  call, never named in the describe.) */
  repeatableConfirmationActions: readonly string[];
}

/** Runtime context a control's `execute` receives. Narrow on purpose: a
 *  control transitions library state through `state.apply` and composes its
 *  result entry — nothing else. Engine text comes straight from ENGINE_TEXT
 *  (engine-text.ts), so no message catalog is threaded here. */
export interface ControlRunContext<T extends LibraryManagedSlots> {
  activation: ControlActivation;
  /** The plan's resolved engine tolerances (../tolerances.ts) — the bounds a
   *  counting control compares against. */
  tolerances: EngineTolerances;
  /** Stable identity of the current caller turn, when one exists. */
  currentCallerTurnId: string | undefined;
  state: BatchState<T>;
}

/** What a control's execution produced. The run loop pushes `entry`, takes
 *  its `instruction` (or host `summary`) as the batch's running last-text,
 *  and short-circuits the batch when `failed` is true. */
export interface ControlOutcome {
  entry: StepResult;
  failed: boolean;
}

/** Exclusivity groups, evaluated in REGISTRY order at admission: for each
 *  group, if the batch has more than one step and contains any member, the
 *  batch is refused. Group identity (not per-control checks) preserves the
 *  refusal attribution when two controls of the same family are mixed. */
export interface ExclusivityGroup {
  name: string;
  memberNames: readonly string[];
  errorCode: string;
  instruction(foundAction: string): string;
}

export interface ControlAction {
  name: string;
  /** Inject this control into the model-facing surface? Also gates its name
   *  reservation and its acceptance at admission/planning. (`abort_pending_input`
   *  additionally short-circuits the unknown-action guard and executes as a
   *  no-op even when inactive — see run/admission.ts.) */
  activeWhen(ctx: ControlActivation): boolean;
  /** The full `{ action, params }` schema variant, carrying the LLM-facing
   *  mechanics via `.describe()`. */
  schemaVariant(ctx: ControlActivation): z.ZodTypeAny;
  /** The control's bullet in the composed tool description. */
  descriptionLine(ctx: ControlActivation): string;
  /** May lead a batch while a confirmation/OTP/match gate lockdown is active. */
  allowedDuringGateLockdown: boolean;
  /** How the control escapes the resolved-choice same-turn lock: as the
   *  batch's ONLY step (`"sole"`), as its FIRST step (`"first"`), or not at
   *  all (`"none"`). */
  sameTurnEscape: "sole" | "first" | "none";
  /** Exclusivity-group name, or null when the control may ride along with
   *  other steps (abort). Groups are declared in controls/registry.ts. */
  exclusivityGroup: string | null;
  execute<T extends LibraryManagedSlots>(
    params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome;
}
