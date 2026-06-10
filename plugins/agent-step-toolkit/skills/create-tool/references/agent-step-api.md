# Reference: agent-step Library API

<overview>
This is the runner contract the new tool consumes. The library lives at `src/agent-step/` and is **treated as immutable**: never modify it; only call `buildAgentStepTool({...})` with the right shape. The summary below is the canonical contract — match it exactly. The ground truth is in `src/agent-step/types.ts` + `src/agent-step/runner.ts`; if this doc disagrees with those, the source wins.
</overview>

<runner_signature>
```ts
import { buildAgentStepTool } from "../../agent-step/index.js";

export const myTool = buildAgentStepTool({
  config: myConfig,                // AgentStepConfig<ActionName, PrereqName>
  stateAnnotation: AgentState,     // LangGraph Annotation.Root for the graph
  selectors,                       // SelectorRegistry<T, ActionName> — one per action
  executors,                       // ExecutorRegistry<T, typeof selectors>
  verifiers,                       // VerifierRegistry<T>
});
```

`selectors` and `executors` are both **keyed 1:1 by the exact action name** (snake_case). Build `selectors` with `satisfies SelectorRegistry<State, ActionName>` (not a type annotation) so each selector's precise return type is preserved into `typeof selectors`; `executors` is then `ExecutorRegistry<State, typeof selectors>`, which types each executor's `state` param from its selector's return — a mismatch is a compile error here, at the construction boundary. See `<conventions>` §1.

Returns a LangChain `StructuredTool` ready to register in `src/tools/index.ts`.
</runner_signature>

<types>
## AgentStepConfig

```ts
interface AgentStepConfig<ActionName extends string, PrereqName extends string> {
  tool: { name: string; description: string };
  actions: Record<ActionName, ActionDef<PrereqName>>;
}
```

`tool.name` becomes the LangChain tool name surfaced to the LLM (e.g. `"card_agent_step"`, `"accounts_agent_step"`).

`tool.description` is the lead paragraph; the library appends a per-action bullet list automatically.

There is **no top-level `mutations` map**. All per-action behavioural opts (confirmation / OTP / match / flow lifecycle, batch-shape flags) live inline on each action under `ActionDef.controller`. Downstream-slot invalidation lives inline under `ActionDef.invalidatesOnChange`.

## ActionDef

```ts
interface ActionDef<PrereqName extends string> {
  description: string;             // non-empty; flows into Zod .describe() AND tool description
  summary?: string;                // optional one-line label for the tool-level action index. Add one
                                   // when the action NAME isn't self-explanatory to the model; the full
                                   // mechanics always live in `description` regardless. Omit it and the
                                   // index just lists the action name alone.
  paramsSchema: z.ZodTypeAny;      // params the LLM must send
  prereqs: PrereqName[];           // state predicates checked before invoking executor
  invalidatesOnChange?: Record<string, string[]>;
                                   // keys are slots this action may write; values are downstream
                                   // slots to reset to null when the watched slot's value CHANGES
                                   // (non-null → different value). First-time set / same-value
                                   // writes do NOT fire. See <invalidates_on_change>.
  pageable?: PageableSpec;         // opt a LIST read into uniform pagination. The runner injects
                                   // page/pageSize params, slices the result, and emits a standard
                                   // envelope. Requires a z.object paramsSchema. See <pagination>.
  controller?: ControllerHooks;    // lifecycle hooks coordinated by the runner (confirmation /
                                   // OTP / match / flow / batch-isolation). Omit for plain reads.
}
```

## ControllerHooks

Per-action behavioural opts coordinated by the library, declared inline as `ActionDef.controller`. Despite the "mutation" framing, it covers gating, lifecycle, and flow hooks for read-ish actions too (`request_*` issuing OTPs, `confirm_*_otp` consuming them).

```ts
interface ControllerHooks {
  // ─── Batch-shape constraints ───────────────────────────────────────────────
  soleStep?: boolean;                       // strict: refuse any batch larger than 1.
  soleOnExecute?: boolean;                  // relaxed: propose may ride as LAST step;
                                            // execute mode must be alone.
                                            // (soleStep wins if both are set.)

  // ─── Confirm-required propose/execute gate ─────────────────────────────────
  requiresConfirmation?: boolean | ConfirmationOpts;

  // ─── SCA / OTP gating ──────────────────────────────────────────────────────
  requiresOtp?: boolean | OtpOpts;          // refuse unless awaitingInput.kind="otp"
                                            // for this action; auto-clears on ok:true.
  issuesOtp?: { consumer_action: string };  // executor reports lifecycle.issuesOtp;
                                            // library sets awaitingInput=otp.

  // ─── Multi-turn flow lifecycle ─────────────────────────────────────────────
  startsFlow?: { name: string };            // on ok: create currentFlow (or merge if same name).
  endsFlow?: boolean;                       // on ok: clear currentFlow AND awaitingInput.
  requiresFlow?: string;                    // refuse unless currentFlow.name matches.

  // ─── Double-entry verification (PIN/password repeat) ───────────────────────
  startsMatchFor?: { consumer_action: string };
                                            // capturer: on ok, set awaitingInput=match for consumer.
  requiresMatch?: { capturer: string; maxAttempts?: number };
                                            // consumer: refuse unless awaitingInput=match for this;
                                            // library decrements on verdict:"match_mismatch";
                                            // aborts flow on exhaustion; auto-clears on ok:true.
}

interface ConfirmationOpts {
  maxAttempts?: number;            // re-propose budget before the gate exhausts. Default 3 —
                                   // almost always right. Lower to 1–2 for high-stakes mutations
                                   // where you want to bail fast on param drift.
  ttlMs?: number;                  // INERT. The field exists on the type for forward-compat, but the
                                   // runner removed time-based expiry (see runner.ts: "timestamps
                                   // removed; runner no longer does TTL"). Gating is conversation-
                                   // driven, not time-driven. Setting it does nothing today — omit it.
  lockdown?: boolean;              // default true — refuses unrelated batches while a confirmation is
                                   // pending. Leave it true. Set false only if you deliberately want
                                   // unrelated READS to proceed mid-confirmation (rare; weakens the
                                   // safety gate, since the customer can wander off the pending action).
}

interface OtpOpts {
  // Reserved for future use. Library never counts OTP attempts (backend-authoritative).
}
```

The executor owns any pre-read and post-read; the library enforces the gates above plus the propose-then-execute handshake (see `<confirmation_lifecycle>`).

## Verifier

```ts
interface Verifier<T> {
  check: (state: T) => boolean;
  denial: { summary: string; error: string };
}
```

Self-contained: the predicate AND the denial body live together in one file. The denial body is what appears in the result envelope when the prereq fails.

The `check` predicate is a snapshot of **journey progress** — "is the user identified?", "is an entity selected?" — not a record of step ordering. Gate on *where the user is*, never on *what ran first*. The companion mechanism for keeping that progress coherent when an upstream slot changes is `invalidatesOnChange` (see `<invalidates_on_change>` below).

## ExecutorResult

```ts
interface ExecutorResult<T> {
  resultBody: object;              // JSON-serializable; the LLM sees this
  stateUpdate?: Partial<T>;        // threaded to subsequent batch steps + committed at end
  flowData?: Record<string, unknown>;
                                   // shallow-merged into currentFlow.data on ok (or when the
                                   // action declares startsFlow); error to write when no flow active.
  lifecycle?: {
    issuesOtp?: { challengeId: string; mobile_masked: string };
                                   // pair with controller.issuesOtp.consumer_action;
                                   // library sets awaitingInput=otp for the named consumer.
    clearAwaitingInput?: true;     // drop awaitingInput only; keep currentFlow.
                                   // Use for "OTP timeout: gate dead, flow continues."
    abortFlow?: true;              // terminal failure; drop awaitingInput AND currentFlow.
                                   // Use for "OTP locked, no recovery within this flow."
  };
  ok: boolean;                     // false short-circuits the batch
}
```

## Selector / SelectorRegistry

```ts
// Projects the host state T down to the slice ONE action's executor needs.
// Trusted glue: may reshape/rename, not just narrow. Looked up by action name.
type Selector<T> = (state: T) => unknown;

// Selectors keyed 1:1 by action name (the key IS the action name).
type SelectorRegistry<T, ActionName extends string> = Record<ActionName, Selector<T>>;
```

The runner runs `selectors[action](view)` and hands the result to the executor as its `state`. The executor never sees the whole state — only what its selector returned. Keep selectors pure (no I/O).

## Executor / ExecutorRegistry

```ts
// Receives `Slice` — whatever the action's selector returned — NOT the whole
// state. Returns an ExecutorResult<T> whose stateUpdate may still patch ANY
// host slot (writes are unrestricted; the reducers merge them).
type Executor<Slice, T> = (params: unknown, state: Slice) => Promise<ExecutorResult<T>>;

// Keyed 1:1 by action name. Each entry's `state` param is derived from that
// action's selector return (ReturnType<Selectors[K]>), so an executor whose
// signature doesn't match what its selector produces is a compile error.
type ExecutorRegistry<T, Selectors extends Record<string, Selector<T>>> = {
  [K in keyof Selectors]: Executor<ReturnType<Selectors[K]>, T>;
};
```

## AwaitingInput (library-managed)

The runner's lockdown slot. Discriminated union over the three input gates:

```ts
type AwaitingInput =
  | { kind: "confirmation"; for_action: string; params: object;
      attempts_left: number; max_attempts: number; flow_ref?: string }
  | { kind: "otp";          for_action: string; flow_ref: string }
  | { kind: "match";        for_action: string;
      attempts_left: number; max_attempts: number; flow_ref?: string };
```

Lockdown semantics (first step of the next batch must satisfy this):

| kind | allowed first step | else |
|------|-------------------|------|
| `confirmation` | `for_action` (resolves to execute/re-propose/exhausted) or `abort_pending_input` | `pending_confirmation_locked` |
| `otp` | `for_action` or `abort_pending_input` | `otp_pending_locked` |
| `match` | `for_action`, the **capturer** (re-capture resets), or `abort_pending_input` | `match_pending_locked` |

The library does NOT TTL any slot. Stale gates clear via `abort_pending_input` or via backend signals (timeout/lockout, surfaced by the executor as `lifecycle.clearAwaitingInput` / `lifecycle.abortFlow`).

## CurrentFlow (library-managed)

Single active flow at a time (flow mutex). Set on `startsFlow` ok; cleared on `endsFlow` ok or `lifecycle.abortFlow`:

```ts
interface CurrentFlow {
  name: string;
  data: Record<string, unknown>;   // scratch bag; executors merge via ExecutorResult.flowData
}
```

Starting a different flow while another is active fails with `error: "flow_already_active"`. Re-entering the SAME flow is idempotent — the executor runs (e.g. to re-issue an OTP), and `flowData` shallow-merges into the existing `currentFlow.data` (no reset).

## PagedCache (library-managed)

The reslice-cache for `pageable` reads (self mode). On a cache miss the runner stores the full result set + the query signature; on a same-query re-page it serves the page from here WITHOUT re-running the executor. One active set at a time; untouched unless an action declares `pageable`.

```ts
interface PagedCache<Row> {
  key: string;                       // the action name that produced the set
  signature: string;                 // params signature (excludes page/pageSize)
  rows: Row[];                       // the FULL set
  extras: Record<string, unknown>;   // the executor's non-`items` result fields, replayed per page
}
```

Host the slot as `pagedRead: PagedCache<unknown> | null` (it's in the bootstrap state template, alongside `awaitingInput` / `currentFlow`).

</types>

<conventions>
## 1. Selector + executor keyed by the exact action name

Selectors and executors are registered **1:1 under the exact action name** (snake_case). There is NO name transformation — the registry key IS the action name. (Earlier versions derived a camelCase executor key by snake-to-camel; that convention is gone.)

```ts
const selectors = {
  verify_customer: verifyCustomerSlice,   // getSlice from actions/verify_customer/stateSelector.ts
  list_accounts:   listAccountsSlice,
} satisfies SelectorRegistry<State, ActionName>;

const executors: ExecutorRegistry<State, typeof selectors> = {
  verify_customer: verifyCustomer,        // the function name is free; the KEY is the action name
  list_accounts:   listAccounts,
};
```

The executor function name itself is unconstrained (camelCase is conventional, e.g. `verifyCustomer`), but the **registry key** must be the action name. The runner throws at construction if either registry is missing an action's entry:

```
agent-step: action "verify_customer" expects a state selector at selectors["verify_customer"] but none was found.
agent-step: action "verify_customer" expects an executor at executors["verify_customer"] but none was found.
```

## 2. Verifier name = prereq name

A prereq name in `ActionDef.prereqs` (e.g. `"customerVerified"`) is the same key used in the `verifiers` registry. Runner throws:

```
agent-step: action "verify_card" lists prereq "customerVerified" but verifiers["customerVerified"] was not provided.
```

## 3. Reserved action name

`abort_pending_input` is reserved. The library auto-injects it into the tool schema whenever ANY action declares one of: `requiresConfirmation`, `requiresOtp`, `issuesOtp`, `startsFlow`, `endsFlow`, `requiresFlow`, `requiresMatch`, `startsMatchFor`. Trying to declare it manually throws:

```
agent-step: "abort_pending_input" is a reserved action name auto-injected by the library; remove it from config.actions.
```

The action is idempotent — it clears `awaitingInput` AND `currentFlow` together. No-op when nothing is active.

## 4. Per-action description is required

A non-empty `description` string is required on every action. Empty/missing throws:

```
agent-step: action "fetch_balance" is missing a non-empty description.
```

## 5. Controller hooks live on the action

Lifecycle opts are declared inline as `ActionDef.controller`, so there is no separate map that can drift from `actions`. A controller-referenced peer action (e.g. an `issuesOtp.consumer_action` or a `requiresMatch.capturer`) must still name a real action, or the corresponding runtime check throws (see `<construction_time_checks>`).
</conventions>

<state_threading>
## How state flows through a batch

When the LLM calls the tool with `[step1, step2, step3]`:

1. Runner reads the FULL state via `getCurrentTaskInput<T>()` — this is the snapshot at batch start (NOT a live view, important for same-batch-bypass safety).
2. Merger is built from the LangGraph annotation passed as `stateAnnotation`. Each field's reducer is extracted from `BinaryOperatorAggregate.operator`. The `messages` field is explicitly skipped (the runner emits its own `ToolMessage` at the end).
3. Pre-flight checks fire in this order, each able to short-circuit the batch:
   a. **Input lockdown** — `awaitingInput` set → first step must satisfy it (see lockdown table above).
   b. **Flow mutex** — first step `startsFlow=X` while `currentFlow.name=Y` (≠X) → refuse `flow_already_active`.
   c. **soleStep / soleOnExecute** — batch-shape refusal (computed off batch-start pending so the LLM-natural `[verify, mutate]` batch can propose).
4. **Plan expansion** — tag each user step with its confirmation mode (`propose` | `rePropose` | `execute` | `exhausted`) based on pending state at batch-start. Frozen before any executor runs (same-batch-bypass safety).
5. For each planned step:
   a. Library-managed prereqs (`requiresFlow`, then `requiresOtp` / `requiresMatch`) → refuse if not gated.
   b. User-declared prereqs (verifiers) → refuse with denial body.
   c. Validate params via `paramsSchema.parse`.
   d. Run the action's selector against the running `view` to build the slice, then call the executor: `executors[action](params, selectors[action](view))`. If the executor throws, the runner catches it, marks the step `ok:false` (`error: "executor_error"`), and short-circuits — earlier steps' commits are preserved.
   e. Apply executor outputs in this order: `stateUpdate` → `startsFlow`+`flowData` → `lifecycle.issuesOtp` → auto-clear of `requiresOtp`/`requiresMatch` on ok → `startsMatchFor` → `endsFlow` → `lifecycle.clearAwaitingInput` / `lifecycle.abortFlow`. On ok:false + `verdict:"match_mismatch"`, decrement match attempts (or abort flow on exhaustion).
6. Emit a single `ToolMessage` whose content is the JSON-stringified `RunnerResultBody = { summary, results, failed_at? }`.

**Cumulative commit on partial failure:** state patches from successful earlier steps DO commit even if a later step fails. Example: `[verify_customer (ok), verify_card (fail)]` → `verifiedCustomer` persists for the next turn.

**Crucial:** state slots in the graph's `state.ts` MUST declare an explicit reducer (`Annotation<T>({ reducer, default })`). The library reads the reducer at runtime. Slots declared without a reducer get replace-on-write behavior (which is fine — but be explicit about it).
</state_threading>

<confirmation_lifecycle>
## Mutation propose → execute lifecycle (when `requiresConfirmation` is set)

The runner switches the mutation action into a four-mode state machine. Detected by reading `awaitingInput.kind === "confirmation"`:

**Ordering with prereqs (non-obvious, but guaranteed).** A step's library prereqs (`requiresFlow`) and user verifiers run BEFORE its confirmation mode is acted on (`<state_threading>` step 5a/5b, ahead of the propose in 5e). So a confirm-gated mutation whose `requiresFlow`/prereqs are unmet is **refused, not proposed** — `awaitingInput` is never set into a doomed state. Compose `requiresConfirmation` with `requiresFlow` freely; the gate order is correct.

### First call (no pending, or pending action ≠ this action) → **propose mode**
- Validate params, set `awaitingInput = { kind: "confirmation", for_action, params, attempts_left: maxAttempts, max_attempts }`.
- Return `{ ok: true, summary, needs_confirmation: true, proposed_params, attempts_left }`.
- **Executor is NOT invoked.**

### Re-call with **same params** as pending → **execute mode**
- Clear `awaitingInput` atomically BEFORE invoking the executor.
- Invoke the executor with the parsed params + view.
- Whatever the executor returns is the result (the executor performs its own pre-read + write + post-read).

### Re-call with **different params** as pending → **rePropose mode**
- Update `awaitingInput.params` to the new params, decrement `attempts_left`.
- If `attempts_left > 0`: return new `needs_confirmation` envelope with decremented `attempts_left`.
- If `attempts_left === 0`: return `{ ok: false, summary, error: "confirmation_attempts_exhausted" }` and clear pending.

### Lockdown
If `awaitingInput.kind === "confirmation"` and `lockdown: true` (default), the batch MUST start with either:
- The same action as the pending one (resolves to execute / rePropose / exhausted), OR
- `abort_pending_input` (library-handled; clears `awaitingInput` AND `currentFlow`; abort may be the first step of a larger batch — subsequent steps run after the gate clears).

Anything else → `{ ok: false, error: "pending_confirmation_locked", awaiting: { kind, for_action } }`.

### abort_pending_input
Library auto-injects this action into the schema whenever ANY lifecycle opt is declared. It is library-handled (no executor needed):
- If `awaitingInput` or `currentFlow` is set → clear both; return `{ ok: true, summary: "Pending input and/or flow aborted.", aborted_awaiting?, aborted_flow? }`.
- If nothing is active → no-op; return `{ ok: true, summary: "Nothing to abort." }`.
</confirmation_lifecycle>

<invalidates_on_change>
## Downstream-slot invalidation (`ActionDef.invalidatesOnChange`)

A per-action map declaring "if this action re-collects slot X with a *different* value, reset everything derived from X to `null`." Keys are slot names the action may write; values are the downstream slots to clear.

```ts
verify_customer: {
  // …
  invalidatesOnChange: {
    customerCode: ["cardVerified", "amountCollected", "reasoningCollected", /* … */],
  },
},
```

Fire rule (evaluated after the executor's `stateUpdate` has been folded in):
- Fires only when the watched slot's pre-step value was **non-null** AND `!Object.is(pre, post)`.
- First-time set (`null → value`) does NOT fire — there was nothing downstream to invalidate yet.
- Same-value writes (no real change) do NOT fire.
- Slots set later in the same batch are NOT retro-cleared; an executor's own writes to a downstream slot win over the cascade.

Invalidated slots are written as `null` regardless of their declared type, so any slot listed as a target must accept `null` as its "unset" sentinel.
</invalidates_on_change>

<otp_lifecycle>
## OTP gate (when `issuesOtp` / `requiresOtp` are set)

Two actions cooperate: the **issuer** mints an SCA challenge; the **consumer** validates the customer's OTP. Library coordinates `awaitingInput.kind === "otp"`.

### Issuer (`controller.issuesOtp = { consumer_action }`)
- Executor calls the SCA backend to mint a challenge.
- On `ok: true`, the executor returns `lifecycle: { issuesOtp: { challengeId, mobile_masked } }` and (typically) writes `flowData: { challengeId, customerId, ... }` so the consumer can read them.
- Library sets `awaitingInput = { kind: "otp", for_action: consumer_action, flow_ref: currentFlow.name }`.

Issuer typically also declares `startsFlow: { name: "X" }` so the OTP gate is tied to a flow.

### Consumer (`controller.requiresOtp = true`)
- Refused unless `awaitingInput.kind === "otp" && for_action === <this action>`. Error: `otp_not_pending` if the gate isn't pending; `otp_pending_locked` if something else is awaiting.
- Executor reads `challengeId` (etc.) from `state.currentFlow.data`, calls SCA validate.
- Library **does not count OTP attempts**. The backend is authoritative for lock / timeout / wrong:
  - **valid** → executor returns `ok: true`; library auto-clears `awaitingInput`. Flow continues.
  - **wrong, retry allowed** → executor returns `ok: false` (no `lifecycle`). Library leaves state alone; customer re-reads the same code.
  - **timeout** → executor returns `ok: false, lifecycle: { clearAwaitingInput: true }`. The gate dies; the LLM offers to resend (re-call the issuer to mint a fresh challenge).
  - **lockout** → executor returns `ok: false, lifecycle: { abortFlow: true }`. The flow is dead; library clears `awaitingInput` AND `currentFlow`.

### Single consumer, multiple issuers
A single `confirm_otp` action can serve every OTP-protected flow in the tool. Each issuer points its `issuesOtp.consumer_action` at that one consumer, and the consumer reads `currentFlow.data` to know which challenge is in play.
</otp_lifecycle>

<match_lifecycle>
## Double-entry match gate (when `startsMatchFor` / `requiresMatch` are set)

The customer provides a value once, then again; the system verifies they match. Used for PIN setup, password change, secret-answer confirmation. Library coordinates `awaitingInput.kind === "match"`.

### Capturer (`controller.startsMatchFor = { consumer_action }`)
- Executor validates/encodes/persists the first entry (typically into `flowData`).
- On `ok: true`, library sets `awaitingInput = { kind: "match", for_action: consumer_action, attempts_left: maxAttempts, max_attempts: maxAttempts, flow_ref? }`.
- Re-running the capturer while a match is awaiting **resets** `attempts_left` (lets the customer change their first entry).

### Consumer (`controller.requiresMatch = { capturer, maxAttempts }`)
- Refused unless `awaitingInput.kind === "match" && for_action === <this action>`. Error: `match_not_pending` if absent.
- Executor receives the second entry, owns the comparison (e.g. compares ciphertexts), performs the side-effect on match.
- Library reads the executor's outcome:
  - `ok: true` → match succeeded; library auto-clears `awaitingInput`. Pair with `endsFlow: true` to wrap the flow.
  - `ok: false` + `resultBody.verdict === "match_mismatch"` → library decrements `attempts_left`. On exhaustion, library clears `awaitingInput` AND `currentFlow` (terminal) and surfaces `verdict: "match_attempts_exhausted"`, `error: "match_attempts_exhausted"`.
  - `ok: false` + any other verdict → library leaves state alone (unrelated failure, e.g. backend error).

### Lockdown
While `awaitingInput.kind === "match"`, only three actions are allowed as the first step: the consumer, the capturer (re-capture), or `abort_pending_input`.
</match_lifecycle>

<pagination>
## Read pagination (`pageable`)

A LIST read opts in with `pageable` on its `ActionDef`. The runner then injects optional `page` / `pageSize` params into the action's schema (so the model can ask for a page), runs/serves the read, and emits a **uniform envelope** spread into the StepResult:

```ts
{ page, pageSize, totalCount, totalPages, hasMore, items, fromCache }
```

The executor's other `resultBody` fields (e.g. `summary`) are preserved on every page, including cache hits. Two modes:

- **`pageable: true`** — **self-paginate.** The executor returns the **FULL set** in `resultBody.items`; the runner slices the requested page and caches the full set in the library-managed `pagedRead` slot. A same-query re-page (same params minus `page`/`pageSize`) is served from the cache **without re-running the executor** (`fromCache: true`).
- **`pageable: "delegate"`** — **backend pages.** The executor reads the injected `page`/`pageSize`, returns that page in `resultBody.items` plus `resultBody.totalCount`; the runner just wraps it (no cache).
- **`pageable: { mode, pageSize?, maxPageSize? }`** — same, with tuned sizes (defaults: `DEFAULT_PAGE_SIZE=10`, `MAX_PAGE_SIZE=50`).

**Constraint:** a `pageable` action's `paramsSchema` MUST be a `z.object` (the runner merges `page`/`pageSize` in) — otherwise construction throws.

**Primitives** (exported from `index.ts`, for hand-rolled cases — the runner uses them internally): `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `clampPageSize`, `querySignature`, `pageRows`, `buildPageEnvelope`, and types `PageEnvelope`, `PagedCache`, `PageableSpec`. Prefer the `pageable` opt over hand-rolling.
</pagination>

<result_envelope>
## What the LLM sees per tool call

```ts
interface RunnerResultBody {
  summary: string;                 // last step's summary (success) OR failing step's summary
  results: StepResult[];           // one entry per executed step
  failed_at?: number;              // index into results where batch short-circuited
}

interface StepResult {
  action: string;
  ok: boolean;
  [key: string]: unknown;          // executor's resultBody fields spread in
}
```

Library-injected fields on specific step kinds:
- `abort_pending_input` results carry `aborted_awaiting: { kind, for_action }` and/or `aborted_flow: "<name>"` when something was actually cleared.
- propose / re-propose results carry `needs_confirmation: true`, `proposed_params`, `attempts_left`.
- exhausted results carry `error: "confirmation_attempts_exhausted"`.
- lockdown refusals carry `error: "pending_confirmation_locked" | "otp_pending_locked" | "match_pending_locked"` and `awaiting: { kind, for_action }`.
- match-mismatch results gain `attempts_left` (decremented) or `verdict: "match_attempts_exhausted"` on the last try.
</result_envelope>

<construction_time_checks>
The runner validates the config + registries at construction. These all throw at startup before any user input — fix the misconfig before continuing:

| Error message contains | Cause |
|------------------------|-------|
| `is a reserved action name` | You declared `abort_pending_input` in config.actions |
| `expects a state selector at selectors["xxx"]` | `selectors` registry missing the action-name key for an action |
| `expects an executor at executors["xxx"]` | `executors` registry missing the action-name key for an action |
| `is missing a non-empty description` | An action lacks `description` |
| `verifiers["xxx"] was not provided` | A prereq referenced by some action has no verifier |
| `pageable action's paramsSchema must be a z.object` | A `pageable` action's `paramsSchema` isn't a `z.object` (the runner can't merge `page`/`pageSize` in) |
| `at least one action must be defined` | Empty `config.actions` |

Runtime errors raised by the runner (not construction-time, but loud):

| Error message contains | Cause |
|------------------------|-------|
| `returned flowData but no flow is active` | Executor wrote `flowData` without `startsFlow` and no flow is open |
| `reported lifecycle.issuesOtp but no flow is active` | Issuer didn't pair with `startsFlow` |
| `reported lifecycle.issuesOtp but config lacks issuesOtp opt` | Executor returned the lifecycle signal but mutation config didn't declare `issuesOtp` |
| `declares startsMatchFor "X" but that consumer doesn't declare requiresMatch` | Capturer / consumer mismatch |

The runner does NOT validate at runtime that you declared `awaitingInput` / `currentFlow` / `pagedRead` in state when using the lifecycle / pagination opts. If you forget, the runner will write a patch to a non-existent slot and the library-managed gates will silently misbehave. Always add all three slots — they're already in the bootstrap state template.
</construction_time_checks>

<key_files_to_inspect>
For ground truth, read these files in the project (don't paraphrase — they ARE the contract):

- `src/agent-step/types.ts` — every type listed above
- `src/agent-step/runner.ts` — the runtime; especially `validateConfig`, `runSteps`, the selector→executor dispatch (`selectors[action](view)` → `executors[action]`), `buildMergerFromAnnotation`, lockdown handling, lifecycle ordering
- `src/agent-step/paginate.ts` — the read-pagination primitives + the `pageable` orchestration the runner uses (self / delegate, the cache, the envelope)
- `src/agent-step/index.ts` — what's exported (only what's here is part of the API)
- `src/agent-step/runner.test.ts` + `src/agent-step/paginate.test.ts` — worked examples covering every runner branch + the pagination primitives; all pass on `npm test`
</key_files_to_inspect>
