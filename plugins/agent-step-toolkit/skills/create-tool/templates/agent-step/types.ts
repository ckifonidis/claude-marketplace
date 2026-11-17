// FILE: src/agent-step/types.ts
//
// Public authoring contracts for the agent-step library: what a host DECLARES
// (actions, controller hooks, registries) and what an executor RETURNS. The
// compiled/runtime shapes derived from these live under compile/ and run/ —
// hosts never import those.

import type { z } from "zod";
import type { PageableSpec } from "./paginate.js";
import type { HandoffRequest } from "./state.js";

/** A typed library-state transition an executor may request. Effects are
 *  SIGNALS, not an ordered program: the runner honours each one at a fixed,
 *  documented point of the step lifecycle (see run/execution.ts):
 *
 *  - `request_handoff` — terminal business outcome: atomically clears every
 *    transient runner slot (`awaitingInput`, `currentFlow`,
 *    `pagedRead`) and writes the `handoff` slot, exactly like the built-in
 *    `request_handoff` action. Honoured regardless of `ok` — a refusal verdict
 *    (e.g. "already closed") may still be terminal. TERMINAL IS ENFORCED:
 *    once the handoff is set, the step's remaining interaction lifecycle
 *    (flow open, OTP/match gates) is skipped and the batch ends after the
 *    current step — later steps do not run (handoff monotonicity, see
 *    run/execution.ts). This is the ONLY way an executor requests a handoff;
 *    writing the `handoff` slot through `stateUpdate` is rejected loudly.
 *  - `merge_flow_data` — shallow-merge into `currentFlow.data`. Honoured on
 *    `ok: true`; requesting it with no active flow (and no `startsFlow` on the
 *    action) is a programmer mistake and throws.
 *  - `otp_issued` — this step minted an SCA challenge; the runner opens the
 *    OTP gate for the consumer named in the action's `issuesOtp` hook.
 *    Honoured on `ok: true`; requires an active flow and the config hook.
 *  - `clear_awaiting_input` — drop the pending input gate only, keep the flow.
 *    Used for "the current OTP is dead but the flow continues" (e.g. timeout).
 *    Honoured regardless of `ok`.
 *  - `abort_flow` — terminal in-flow failure; drop the gate AND the flow (and
 *    any bounded-choice overlay). Honoured regardless of `ok`. */
export type ExecutorEffect =
  | { type: "request_handoff"; request: HandoffRequest }
  | { type: "merge_flow_data"; data: Record<string, unknown> }
  | { type: "otp_issued" }
  | { type: "clear_awaiting_input" }
  | { type: "abort_flow" };

/** Result a single executor returns to the runner. `resultBody` is the
 *  JSON-serializable object the LLM sees as that step's payload. `ok` is a
 *  batch-continuation control flag, NOT a success/verdict signal: `ok: true`
 *  proceeds to the next step; `ok: false` short-circuits the batch and sets
 *  `failed_at`. An executor may return `ok: true` for a "negative" domain
 *  outcome (carry the verdict in `resultBody`) when later steps should still
 *  run — decide on whether the batch should continue, not on whether the
 *  outcome was "good".
 *
 *  `stateUpdate` is a partial patch of HOST-OWNED slots, threaded to
 *  subsequent steps in the batch AND accumulated into the final tool Command.
 *  Library-managed slots (`awaitingInput`, `currentFlow`,
 *  `pagedRead`, `handoff`, `errorCount`) may NOT appear in it — the runner is
 *  their only writer and rejects such a patch loudly. Library transitions go
 *  through `effects` instead. */
/** INTERNAL — the runner's composed result shape, produced by normalizing a
 *  {@link DeclaredExecutorResult} against the action's {@link VerdictDef} row.
 *  NOT an authoring surface: executors return the declarative shape only, so
 *  the composed verdict index and gate contracts are provably complete (an
 *  outcome cannot exist outside the rows). */
export interface ExecutorResult<T> {
  resultBody: object;
  stateUpdate?: Partial<T>;
  effects?: ExecutorEffect[];
  ok: boolean;
}

/** One DECLARED verdict of an action (`ActionDef.verdicts`): the row the
 *  runner composes the result body from when the executor returns the
 *  declarative shape ({@link DeclaredExecutorResult}). One authority per
 *  verdict for the summary, the model-facing doctrine, the static state
 *  write, the effects, and the standing ask — the five things that used to
 *  be hand-kept consistent across executors, shared constants, and wiring
 *  lists (and measurably forked). */
export interface VerdictDef<T = unknown> {
  /** Batch-continuation flag (`StepResult.ok`) for this verdict. */
  ok: boolean;
  /** The body `summary` — a string, or a renderer over the CURRENT state
   *  view (for language-keyed catalogs; same division as
   *  `ConfirmationOpts.readBack`) plus the executor's `data` (for
   *  interpolated summaries, e.g. a kind label). */
  summary: string | ((state: unknown, data: Record<string, unknown>) => string);
  /** The remaining body fields, composed IN DECLARATION ORDER after
   *  `summary` (e.g. `verdict`, `error`, `reason`) — declaration order is
   *  wire order, so a converted action reproduces its historical body bytes
   *  exactly. A function value receives the executor's `data`. */
  body?: Record<string, unknown | ((data: Record<string, unknown>) => unknown)>;
  /** Static host-state patch for this verdict — typed against the host
   *  state so a typo'd slot fails compilation instead of silently dropping
   *  at the patch merger. The executor's dynamic `stateUpdate` wins on key
   *  conflicts. */
  stateUpdate?: Partial<T>;
  /** Effects applied for this verdict, ahead of any executor-supplied ones
   *  (e.g. the terminal handoff that must never fork from the outcome
   *  written in `stateUpdate`). */
  effects?: ExecutorEffect[];
  /** Marks this verdict's `body.error` code as a backend failure for the
   *  auto-handoff counter — derives `backendFailureCodes`, so the hand-kept
   *  list in the host wiring goes away. Requires `body.error` to be a
   *  static string (validated at construction). */
  backendFailure?: boolean;
}

/** The executor return: name the verdict, hand over the dynamic data; the
 *  runner composes the body from the action's {@link VerdictDef} row (unknown
 *  verdicts fail loudly as `executor_error`). `resultExtras` are appended
 *  after the declared body fields; `effects` append after the row's. This is
 *  the ONLY authorable result shape — every verdict an executor can return
 *  must have a declared row. */
export interface DeclaredExecutorResult<T> {
  verdict: string;
  /** Dynamic values the row's function fields read (e.g. a diagnostic
   *  message interpolated into `reason`). */
  data?: Record<string, unknown>;
  stateUpdate?: Partial<T>;
  effects?: ExecutorEffect[];
  resultExtras?: Record<string, unknown>;
}

/** Projects the host state down to the slice one action's executor needs. The
 *  runner runs the action's selector (looked up by action name, like the
 *  executor) and hands the result to the executor as its `state` — the executor
 *  never sees the whole state, and never declares its own slice. A selector is
 *  trusted glue: it may reshape/rename, not just narrow. */
export type Selector<T> = (state: T) => unknown;

/** Selectors keyed 1:1 by action name. The runner looks the selector up by the
 *  step's action name (no transformation — the key IS the action name) and runs
 *  it to build the executor's `state`. */
export type SelectorRegistry<T, ActionName extends string> = Record<ActionName, Selector<T>>;

/** Executor called by the runner for each step. Receives `Slice` — whatever the
 *  action's selector returned — NOT the whole state, so it can't see anything
 *  the selector didn't hand it. Mutations that need verification (e.g.
 *  read-back after the write) handle it internally — the library has no wrap
 *  concept. */
export type Executor<Slice, T> = (
  params: unknown,
  state: Slice,
) => Promise<DeclaredExecutorResult<T>>;

/** The executor registry, keyed 1:1 by action name. Each entry's `state` param
 *  is derived from that action's selector return (`ReturnType<Selectors[K]>`),
 *  so an executor whose signature doesn't match what its selector produces is a
 *  compile error. */
export type ExecutorRegistry<
  T,
  Selectors extends Record<string, Selector<T>>,
> = {
  [K in keyof Selectors]: Executor<ReturnType<Selectors[K]>, T>;
};

/** Self-contained prereq: the predicate that tests state plus the denial body
 *  the runner emits when the predicate is false. The key in the registry is
 *  the prereq's name (used in `ActionDef.prereqs`). */
export interface Verifier<T> {
  check: (state: T) => boolean;
  denial: { summary: string; error: string };
}
export type VerifierRegistry<T> = Record<string, Verifier<T>>;

/** One verdict's standing ask: which action the requested value feeds, on
 *  which param, and whether the value is deterministic digit content. Declared
 *  per verdict in {@link ActionDef.asks}; the batch finalizer turns the
 *  batch's FINAL entry into the library `awaitingInput` `dictation` record. */
export interface DictationAsk {
  /** Target action the customer's value will be sent to. Must exist. */
  action: string;
  /** The target action's param carrying the capture (e.g. `spokenDigits`). */
  param: string;
  /** `digits` → a purely digit-bearing caller turn may be intercepted
   *  deterministically; `text` → standing-question record only. */
  expects: "digits" | "text";
  /** Render the caller-audible ask itself (language/lexicon live in state, so
   *  the host supplies the function — the same division as
   *  `ConfirmationOpts.readBack`). A non-empty return rides the final entry as
   *  `ask_text` beside `standing_ask`, and the ask contract directs the model
   *  to speak it exactly — engine-rendered bytes are how fixed sentences stay
   *  verbatim (a model asked to speak a catalog line "verbatim" from prompt
   *  memory measurably decorates it). Omit for asks whose wording the model
   *  may own (e.g. the shortened re-ask after a bounce). */
  render?: (state: unknown) => string | undefined;
}

/** Bound on CONSECUTIVE malformed captures for one action — the runner's
 *  `invalid_params` bounce ({@link ActionDef.captureBounces}).
 *
 *  The bounce is deliberately cheap: no confirmation attempt is spent, no
 *  verdict is produced, no executor runs. That is what keeps a caller-capture
 *  shape rule out of the model's JSON Schema — but it also means NOTHING in
 *  the engine counts it, so a caller who keeps mis-supplying a value is
 *  re-asked forever (live incident 2026-08-19: seven identical AFM bounces in
 *  105 seconds with no exit, while a well-formed AFM the backend cannot
 *  resolve is terminal on the FIRST miss). This policy closes that asymmetry.
 *
 *  Past `max` consecutive bounces the engine CLIMBS the named escalation
 *  ladder instead of bouncing plainly: the ladder's free use returns its
 *  instruction (explain/suggest once and re-ask in the SAME turn) and the use
 *  after that applies its `onExhaust` handoff atomically. Counts live in the
 *  task-scoped `spentLadders` latch under `capture:<action>` and RESET on any
 *  capture for that action that parses, so only a consecutive run escalates.
 *
 *  Model-invisible by design: nothing about the bound reaches the schema, and
 *  the bounce summary stays count-free — a count in a capture message
 *  measurably makes the model pad digits to satisfy it. */
export interface CaptureBouncePolicy {
  /** Plain bounces tolerated before the ladder is climbed. Integer ≥ 1. */
  max: number;
  /** Which configured escalation ladder an exhausted capture enters. Must name
   *  a ladder in the config's `ladders` registry (validated at construction). */
  ladder: string;
}

export interface ActionDef<PrereqName extends string, T = unknown> {
  /** Full LLM-facing mechanics for this action — params, verdicts/refusal
   *  codes, result-body shape, lifecycle. Attached to the action's Zod schema
   *  variant via `.describe()`, so the model receives it once, in the schema.
   *  Keep it mechanics-only; conversational policy belongs in the prompt. */
  description: string;
  /** Optional one-line label for the action, used ONLY in the composed
   *  tool-level description's action index. The full `description` is NOT
   *  repeated there — it already reaches the model through the schema. When
   *  omitted, the composed description lists the action name alone. */
  summary?: string;
  paramsSchema: z.ZodTypeAny;
  prereqs: PrereqName[];
  /** Downstream-slot invalidation map. Keys are state slot names this action
   *  may write; values are the slot names to reset to `null` when the watched
   *  slot's value CHANGES between pre-step and post-step state (after the
   *  executor's `stateUpdate` has been folded in). Used to express "if X is
   *  re-collected with a different value, anything derived from X is stale."
   *
   *  Change rule: invalidation fires only when the pre-step value was non-null
   *  AND the written value is not deep-VALUE-equal to it (canonicalized JSON
   *  compare — reference identity never counts, so an executor writing a
   *  fresh-but-equal object does not fire). First-time set (null → value)
   *  does NOT fire — there was nothing downstream to invalidate.
   *
   *  Invalidated slots are written as `null` regardless of their schema type.
   *  CAUTION: the `null` must survive the HOST's reducer for that slot —
   *  list only replace-on-write slots as invalidation targets. A record-merge
   *  reducer (`{...prev, ...(next ?? {})}`) swallows the `null` at the graph
   *  boundary, so the slot resurrects on the next turn even though the
   *  in-batch view saw it cleared. */
  invalidatesOnChange?: Record<string, string[]>;
  /** Opt this read into uniform pagination. `true` self-paginates (executor
   *  returns the FULL set in `resultBody.items`; the runner slices + caches it
   *  in `pagedRead`, skipping the executor on a same-query re-page); `"delegate"`
   *  means the backend pages (executor reads the injected `page`/`pageSize`,
   *  returns the page in `resultBody.items` + `resultBody.totalCount`; the runner
   *  just wraps it). The object form tunes page size. The runner injects
   *  `page`/`pageSize` params and emits a uniform `{ page, pageSize, totalCount,
   *  totalPages, hasMore, items, fromCache }` envelope. Requires a `z.object`
   *  params schema. Omit for non-list reads. */
  pageable?: PageableSpec;
  /** Optional library-coordinated lifecycle hooks: confirmation gating, OTP
   *  issue/consume, flow open/close, double-entry capture/consume, and
   *  batch-isolation flags. Omit for plain reads and collection steps that
   *  don't participate in any controller-managed lifecycle. */
  controller?: ControllerHooks;
  /** Standing asks, keyed by the verdict-or-error code THIS action's results
   *  carry (`resultBody.verdict`, else the entry's `error` — runner-raised
   *  codes like `invalid_params` are legal keys). When the batch's FINAL entry
   *  carries a listed code, the finalizer records the mapped ask as the
   *  library `awaitingInput` `dictation` state — the engine-owned "current
   *  question" the caller now owes an answer to. A final entry from this
   *  action whose code is NOT listed clears a dictation that was standing for
   *  this same action (the ask was serviced); it never disturbs a
   *  confirmation/OTP/match gate. Non-locking by design. */
  asks?: Record<string, DictationAsk>;
  /** Declared verdict rows ({@link VerdictDef}), keyed by the code the
   *  executor returns ({@link DeclaredExecutorResult}). The rows ARE the
   *  action's result space: an executor returning a verdict with no row here
   *  fails loudly as `executor_error`. Each row's `ask` merges into `asks` at
   *  construction (duplicates fail); rows with `backendFailure` derive
   *  `backendFailureCodes`. */
  verdicts?: Record<string, VerdictDef<T>>;
  /** Bound the runner's `invalid_params` bounce for this action's captures —
   *  see {@link CaptureBouncePolicy}. Requires `ladders`; omit for actions
   *  whose params the caller does not dictate. */
  captureBounces?: CaptureBouncePolicy;
}

/** Per-mutation opt-in for state-driven confirmation gating. Truthy form
 *  switches the action into a two-mode runner (propose / execute) with a
 *  lockdown that refuses unrelated steps while pending and bounded re-proposes.
 *  Library injects a generic `abort_pending_input` action into the
 *  tool schema whenever any mutation opts in to a library-managed gate.
 *
 *  There is deliberately NO TTL: the runner times nothing out. Stale gates
 *  clear via `abort_pending_input` or via backend signals the executor
 *  surfaces as `clear_awaiting_input` / `abort_flow` effects. */
export interface ConfirmationOpts {
  /** Proposals the caller may REJECT before the gate is spent. The budget is
   *  task-scoped (`spentLadders["confirm:<action>"]`): a drifted re-proposal
   *  spends it, and so does a fresh proposal after `abort_pending_input` — a
   *  bare "no" followed by a new value is a rejected proposal like any other.
   *  Only an EXECUTE refunds it. Default 3. */
  maxAttempts?: number;
  /** The handoff applied when the budget is spent (requires the library
   *  handoff). Default: `abandon` with the `auto_handoff` message. Without a
   *  handoff path the spent gate errors once and the budget starts over. */
  onExhaust?: import("./state.js").HandoffRequest;
  lockdown?: boolean;
  /** Persist a non-empty `readBack` rendering on the pending confirmation and
   *  inject the built-in `repeat_pending_question` control. The control
   *  may return those exact stored bytes on a later caller turn without
   *  confirming, executing, re-rendering, or spending an attempt. Default
   *  `false`; enabling it without a non-empty rendering leaves that proposal
   *  ineligible for repetition. */
  repeatReadBack?: boolean;
  /** Render what the runner ACTUALLY recorded, for the model to speak back to
   *  the caller verbatim. Called when a proposal is stored; a non-empty return
   *  rides on the proposal body as `read_back` beside `proposed_params`.
   *
   *  Why the library asks: it owns the capture half (capture.ts sanitizes,
   *  joins spoken digit groups and validates), so it alone knows the exact
   *  value. Handing the model raw `proposed_params` and leaving "tell the
   *  caller what was recorded" to its discretion is measurably where read-backs
   *  break — a model converting digits to words drops or doubles one on runs of
   *  equals, and the caller then confirms against wrong words, the one mistake
   *  a confirmation gate cannot catch. Whoever owns the capture owns reporting
   *  it back.
   *
   *  The library does NOT own the lexicon: rendering is language- and
   *  channel-specific, so the host supplies this function as configuration.
   *  Deliberately non-generic — `ConfirmationOpts` carries no state type today
   *  and threading one ripples through `ControllerHooks`/`ActionDef`; hosts cast
   *  their own state, exactly as executors do with their slices. */
  readBack?: (params: Record<string, unknown>, state: unknown) => string | undefined;
  /** How the model must FRAME the rendered `read_back` this proposal carries —
   *  what, if anything, may precede or follow the verbatim bytes ("this is the
   *  capture: append one short confirm question"; "this recap is complete: add
   *  nothing"). Called only when `readBack` rendered non-empty, with the same
   *  params/state; a non-empty return rides the proposal body as
   *  `read_back_directive`. The model reads the framing from the wire instead
   *  of a per-shape prompt table. Model-facing English, never caller-audible. */
  readBackDirective?: (
    params: Record<string, unknown>,
    state: unknown,
  ) => string | undefined;
  /** Propose-time, state-aware refusal. Runs on the propose/re-propose path
   *  AFTER the params parsed and BEFORE anything is committed — no gate is
   *  stored, no attempt is spent, and a pending bounded choice is NOT
   *  consumed (the same non-burning semantics as `invalid_params`). Return a
   *  result body (`summary` + `error`, plus any extra fields) to refuse the
   *  proposal; return null/undefined to proceed.
   *
   *  For proposals whose validity depends on STATE, not shape: e.g. an empty
   *  capture that proposes consuming identity carried from earlier in the
   *  call — with nothing carried, the gate must answer immediately instead of
   *  asking the caller to confirm a value that does not exist. Same
   *  non-generic state contract as `readBack`. */
  refuseProposal?: (
    params: Record<string, unknown>,
    state: unknown,
  ) => ({ summary: string; error: string } & Record<string, unknown>) | null | undefined;
  /** Replace the runner's generic `reply_contract` on THIS action's proposal
   *  bodies with an action-specific one. The contract is the COMPLETE
   *  classification of the caller's next reply while the gate pends — a
   *  non-empty override is the sole authority for that action (the generic
   *  template is not concatenated), so it must classify every reply class it
   *  wants handled, including the generic yes/correction ones.
   *
   *  For mutations whose gate outranks the generic taxonomy: a permanent
   *  closure needs reply classes a generic proposal never sees (third-party
   *  speech, re-selection, clarification-with-repeat). Model-facing English,
   *  never caller-audible; empty/omitted keeps the runner template.
   *
   *  Declared as a {@link GateContractSpec} and composed at construction
   *  (compile/gate-contract.ts): the engine writes the frame clauses it
   *  enforces — the lead, the exact-params yes clause, and the closing
   *  never-re-call guard — around the host's domain categories, so no host
   *  can omit or reword them. */
  replyContract?: GateContractSpec;
}

/** The declarative form of {@link ConfirmationOpts.replyContract}: the host
 *  supplies only what the engine cannot know — how the model should name the
 *  pending question, what the execute re-call does, and the measured domain
 *  reply categories. The action name and sole-step rule come from the action
 *  itself at compile time, so the contract can never fork from the gate it
 *  governs. */
export interface GateContractSpec {
  /** The pending question as the lead clause names it (e.g. "this
   *  permanent-closure consent question"). */
  subject: string;
  /** The question's short noun phrase, cited by the yes clause ("addressed
   *  to this {subjectNoun}") and the closing guard ("a clear answer to the
   *  {subjectNoun}") — e.g. "consent question". */
  subjectNoun: string;
  /** What the execute re-call performs, spoken inside the yes clause's
   *  parenthetical ("that executes {executesLabel}") — e.g. "the permanent
   *  closure". */
  executesLabel: string;
  /** The host's reply categories, joined verbatim in order between the yes
   *  clause and the closing guard. Each is one or more complete sentences
   *  ending in a period, with no trailing space. */
  categories: readonly string[];
}

/** Per-action behavioural opts coordinated by the runner. Covers
 *  confirmation gating, OTP issue/consume, multi-turn flow lifecycle,
 *  double-entry capture/consume, and batch-isolation flags. Lives under
 *  `ActionDef.controller` — omit for plain reads / collection steps. */
export interface ControllerHooks {
  /** Refuse the batch if this action is mixed with any other step. Strict
   *  variant: applies regardless of confirm-mode state. Prefer
   *  `soleOnExecute` on confirm-required mutations so the LLM-natural
   *  "identify + verify + propose" batch still works. */
  soleStep?: boolean;
  /** Confirm-required-mutation friendly relaxation of `soleStep`:
   *  - When the action would resolve to EXECUTE mode (pending confirmation
   *    for this action with matching params), the batch must contain only
   *    this step — `mutation_must_be_sole_step`.
   *  - Otherwise (propose / re-propose / no pending), the action may ride
   *    alongside earlier steps but must be the LAST step in the batch —
   *    `mutation_must_be_last_in_batch` if not at the tail. This lets
   *    `[verify_customer, verify_card, change_status]` propose in one tool
   *    call while still keeping execute as a solo action.
   *  Mutually-exclusive with `soleStep` (if both are set, `soleStep` wins). */
  soleOnExecute?: boolean;
  /** Two-mode propose/execute gate for confirm-required mutations. */
  requiresConfirmation?: boolean | ConfirmationOpts;
  /** This action validates an OTP. The runner refuses it unless
   *  `awaitingInput.kind === "otp"` and `for_action` matches this action's
   *  name. The library never counts OTP attempts; the executor returns a
   *  `clear_awaiting_input` effect (drop the gate, keep the flow) or an
   *  `abort_flow` effect (terminal) based on the backend response. */
  requiresOtp?: boolean;
  /** This action issues an SCA challenge. The executor reports success via
   *  the `otp_issued` effect; the runner opens the OTP gate for the named
   *  consumer action. */
  issuesOtp?: { consumer_action: string };
  /** This action opens (or re-enters) a multi-turn flow. On `ok`, the
   *  runner creates `currentFlow` with the given `name` (or merges
   *  `merge_flow_data` into the existing flow if `currentFlow.name` matches).
   *  Refused if a different flow is currently active.
   *
   *  A flow persists across turns once opened and is cleared ONLY by `endsFlow`
   *  or an `abort_flow` effect — never implicitly. There is no "a new goal
   *  resets the flow" affordance: if a turn pursues an unrelated goal mid-flow,
   *  the prior flow (and its now-stale data) stays open until the host drives
   *  a reset — end the old flow before `startsFlow` of the new one. */
  startsFlow?: { name: string };
  /** This action terminates the active flow successfully. On `ok`, the
   *  runner clears `currentFlow` AND `awaitingInput`. */
  endsFlow?: boolean;
  /** Prereq: refuse with `wrong_flow` (or `no_flow_active`) if
   *  `currentFlow?.name` doesn't match this string. Cheaper to check than a
   *  full verifier; runs before any user-supplied prereqs. */
  requiresFlow?: string;
  /** This action is the *consumer* of a double-entry pattern: the customer
   *  provides a value (PIN, password, security answer) once, then again,
   *  and the system checks they match. The library refuses the action
   *  unless `awaitingInput.kind === "match"` and `for_action` matches.
   *  The executor runs normally — host owns the actual comparison and
   *  side-effect — and signals match/mismatch via its return:
   *  - `ok: true` → library treats as match, auto-clears `awaitingInput`.
   *  - `ok: false` + `resultBody.verdict === "match_mismatch"` → library
   *    decrements `attempts_left`; on exhaustion clears `awaitingInput` and
   *    aborts the flow. Otherwise leaves the awaiting slot alone so the
   *    customer can retry.
   *  - `ok: false` + any other verdict → library leaves state alone
   *    (unrelated failure, e.g. backend error). */
  requiresMatch?: {
    capturer: string;
    /** Mismatches tolerated. Task-scoped (`spentLadders["match:<action>"]`):
     *  neither `abort_pending_input` nor a capturer re-run refunds a spent
     *  mismatch — only a successful match does. Default 3. */
    maxAttempts?: number;
    /** The handoff applied on exhaustion (requires the library handoff).
     *  Default: `abandon` with the `auto_handoff` message. */
    onExhaust?: import("./state.js").HandoffRequest;
  };
  /** This action is the *capturer* of a double-entry pattern: it stores
   *  something (typically a tokenised form of the customer's first entry)
   *  for the consumer to compare against on the next turn. On `ok:true`,
   *  the library sets `awaitingInput.kind="match"` for the named consumer
   *  with `attempts_left = consumer.requiresMatch.maxAttempts`. Idempotent —
   *  re-running the capturer while a match is already awaiting just resets
   *  the attempts counter (and the host's stored token, via a
   *  `merge_flow_data` effect). */
  startsMatchFor?: { consumer_action: string };
}

export interface AgentStepConfig<
  ActionName extends string,
  PrereqName extends string,
  T = unknown,
> {
  tool: { name: string; description: string };
  actions: Record<ActionName, ActionDef<PrereqName, T>>;
}

export interface StepResult {
  action: string;
  ok: boolean;
  [key: string]: unknown;
}

export interface RunnerResultBody {
  summary: string;
  results: StepResult[];
  failed_at?: number;
}
