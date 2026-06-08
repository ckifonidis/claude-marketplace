import type { z } from "zod";
import type { PageableSpec } from "./paginate.js";

/** Result a single executor returns to the runner. `resultBody` is the
 *  JSON-serializable object the LLM sees as that step's payload. `stateUpdate`
 *  is a partial patch the runner threads to subsequent steps in the batch AND
 *  accumulates into the final tool Command. `ok` determines whether the runner
 *  continues to the next step.
 *
 *  `flowData` is shallow-merged into `currentFlow.data` post-execution — used
 *  by flow-bound executors to update their own scratch state. Writing
 *  `flowData` when no flow is active (and the action doesn't open one via
 *  `startsFlow`) is a programmer mistake and the runner errors loudly.
 *
 *  `lifecycle` is a typed union of library-managed state transitions:
 *  - `issuesOtp` — this step minted an SCA challenge; runner sets
 *    `awaitingInput.kind="otp"` for the configured consumer action.
 *  - `clearAwaitingInput` — drop `awaitingInput` only, keep `currentFlow`.
 *    Used for "current OTP is dead but the flow continues" (e.g. timeout).
 *  - `abortFlow` — terminal failure; drop `awaitingInput` AND `currentFlow`.
 *    Used for "OTP locked, no recovery within this flow." */
export interface ExecutorResult<T> {
  resultBody: object;
  stateUpdate?: Partial<T>;
  flowData?: Record<string, unknown>;
  lifecycle?: {
    issuesOtp?: { challengeId: string; mobile_masked: string };
    clearAwaitingInput?: true;
    abortFlow?: true;
  };
  ok: boolean;
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
 *  the selector didn't hand it. Returns an `ExecutorResult` whose `stateUpdate`
 *  may patch any host slot (writes are unrestricted; the reducers merge them).
 *  Mutations that need verification (e.g. read-back after the write) handle it
 *  internally — the library has no wrap concept. */
export type Executor<Slice, T> = (
  params: unknown,
  state: Slice,
) => Promise<ExecutorResult<T>>;

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

export interface ActionDef<PrereqName extends string> {
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
   *  AND `!Object.is(pre, post)`. First-time set (null → value) does NOT fire
   *  — there was nothing downstream to invalidate. Same-value writes (no real
   *  change) also do not fire.
   *
   *  Invalidated slots are written as `null` regardless of their schema type.
   *  Host annotations should accept `null` as the "unset" sentinel for any
   *  slot listed here. */
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
}

/** Per-mutation opt-in for state-driven confirmation gating. Truthy form
 *  switches the action into a two-mode runner (propose / execute) with a
 *  lockdown that refuses unrelated steps while pending, bounded re-proposes,
 *  and a TTL. Library injects a generic `abort_pending_input` action into the
 *  tool schema whenever any mutation opts in to a library-managed gate. */
export interface ConfirmationOpts {
  maxAttempts?: number;
  ttlMs?: number;
  lockdown?: boolean;
}

/** Opts for actions opted into `requiresOtp`. Currently empty — present for
 *  symmetry with `ConfirmationOpts` and as a forward-compat slot for any
 *  future per-action OTP knobs. Library does NOT count OTP attempts; the
 *  backend is authoritative for lock/timeout/wrong-code outcomes. */
export interface OtpOpts {
  // Reserved for future use (e.g. allowed retry budget if ever needed).
  // Library currently has no fields to honour here.
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
   *  name. The library never counts attempts; the executor returns
   *  `lifecycle.clearAwaitingInput` (drop the gate, keep the flow) or
   *  `lifecycle.abortFlow` (terminal) based on backend response. */
  requiresOtp?: boolean | OtpOpts;
  /** This action issues an SCA challenge. The executor reports the
   *  challenge metadata via `lifecycle.issuesOtp`; the runner sets
   *  `awaitingInput.kind="otp"` for the named consumer action. */
  issuesOtp?: { consumer_action: string };
  /** This action opens (or re-enters) a multi-turn flow. On `ok`, the
   *  runner creates `currentFlow` with the given `name` (or merges
   *  `flowData` into the existing flow if `currentFlow.name` matches).
   *  Refused if a different flow is currently active. */
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
   *    fires `abortFlow`. Otherwise leaves the awaiting slot alone so the
   *    customer can retry.
   *  - `ok: false` + any other verdict → library leaves state alone
   *    (unrelated failure, e.g. backend error). */
  requiresMatch?: { capturer: string; maxAttempts?: number };
  /** This action is the *capturer* of a double-entry pattern: it stores
   *  something (typically a tokenised form of the customer's first entry)
   *  for the consumer to compare against on the next turn. On `ok:true`,
   *  the library sets `awaitingInput.kind="match"` for the named consumer
   *  with `attempts_left = consumer.requiresMatch.maxAttempts`. Idempotent —
   *  re-running the capturer while a match is already awaiting just resets
   *  the attempts counter (and the host's stored token, via `flowData`). */
  startsMatchFor?: { consumer_action: string };
}

export interface AgentStepConfig<ActionName extends string, PrereqName extends string> {
  tool: { name: string; description: string };
  actions: Record<ActionName, ActionDef<PrereqName>>;
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
