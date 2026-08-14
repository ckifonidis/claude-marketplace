# Reference: agent-step Library API

<overview>
This is the runner contract the new tool consumes. The library lives at `src/agent-step/` and is **treated as immutable**: never modify it; only call `buildAgentStepTool({...})` with the right shape. The summary below is the canonical contract — match it exactly. The ground truth is in `src/agent-step/types.ts` (authoring contracts) + `src/agent-step/index.ts` (the public surface); if this doc disagrees with those, the source wins.

Since 2.0.0 the library is laid out as phase modules — `compile/` (validate → normalize → model-facing schema), `run/` (admission → planning → execution → finalize), `interaction/` (one policy module per gate kind), `controls/` (the library-owned model-facing actions), `handoff/` (contract + graph node + delegate transport). **Hosts import ONLY from `src/agent-step/index.js`** — the module layout is internal and free to move; everything a tool consumes is re-exported at the index.
</overview>

<runner_signature>
```ts
import { buildAgentStepTool } from "../../agent-step/index.js";

export const myTool = buildAgentStepTool({
  config: myConfig,                // AgentStepConfig<ActionName, PrereqName>
  stateSchema: AgentStateSchema,   // StateSchemaLike — the host's graph state schema
  selectors,                       // SelectorRegistry<T, ActionName> — one per action
  executors,                       // ExecutorRegistry<T, typeof selectors>
  verifiers,                       // VerifierRegistry<T>
  handoff: handoffSpec,            // OPTIONAL — opt into the built-in request_handoff (see <handoff>)
  boundedChoices: { ... },         // OPTIONAL — opt into the one-shot bounded-choice overlay (see <bounded_choice>)
  abortPolicy: { ... },            // OPTIONAL (2.5.0) — narrow the built-in abort control to an
                                   // engine-enforced in-domain transition; omit for the legacy
                                   // permissive behaviour (see <conventions> §3)
  getCallerTurnId: (state) => id,  // OPTIONAL — stable caller-turn identity resolver (see <caller_turn_identity>)
  messages: { ... },               // OPTIONAL — override the runner's own system summary strings (see <system_messages>)
});
```

`stateSchema` is **required**: `StateSchemaLike = LangGraphAnnotationLike | z.ZodObject` — it accepts **either** a LangGraph `Annotation.Root` **or** a Zod object schema whose fields carry reducer/default metadata via `withLangGraph` (`@langchain/langgraph/zod`). Both resolve to the same channel classes (`BinaryOperatorAggregate` / `LastValue`), so the runner derives the intra-batch merger uniformly. The bootstrap scaffold defines graph state **once** as a Zod schema (`AgentStateSchema` in `state.ts`) and passes it here — a single source of truth for reducers AND invoke validation, no Annotation/Zod drift. (The pre-2.0 `stateAnnotation` alias was **removed** in 2.0.0 — pass `stateSchema`, which accepts the same values.)

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
  requiresOtp?: boolean;                    // refuse unless awaitingInput.kind="otp"
                                            // for this action; auto-clears on ok:true.
  issuesOtp?: { consumer_action: string };  // executor reports the `otp_issued` effect;
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
  lockdown?: boolean;              // default true — refuses unrelated batches while a confirmation is
                                   // pending. Leave it true. Set false only if you deliberately want
                                   // unrelated READS to proceed mid-confirmation (rare; weakens the
                                   // safety gate, since the customer can wander off the pending action).
  readBack?: (params: Record<string, unknown>, state: unknown) => string | undefined;
                                   // OPTIONAL (2.3.0) — render what the runner ACTUALLY recorded, for
                                   // the model to speak back verbatim. A non-empty return rides the
                                   // proposal body as `read_back` beside `proposed_params`. See below.
  repeatReadBack?: boolean;        // OPTIONAL (2.5.0) — persist the non-empty readBack rendering on the
                                   // pending gate (`awaitingInput.read_back`) and inject the built-in
                                   // `repeat_pending_confirmation` control, which may return those EXACT
                                   // stored bytes on a later caller turn — never re-rendering from
                                   // mutable state, never confirming/executing, never spending an
                                   // attempt. Default false. Enabling it without a non-empty rendering
                                   // leaves that proposal ineligible for repetition. See below.
  refuseProposal?: (params: Record<string, unknown>, state: unknown)
    => ({ summary: string; error: string } & Record<string, unknown>) | null | undefined;
                                   // OPTIONAL (2.5.0) — propose-time, STATE-aware refusal. Runs on the
                                   // propose/re-propose path AFTER params parse and BEFORE anything
                                   // commits: no gate stored, no attempt spent, a pending bounded choice
                                   // NOT consumed (the same non-burning semantics as invalid_params).
                                   // Return a result body to refuse; null/undefined to proceed. For
                                   // proposals whose validity depends on STATE, not shape — e.g. an
                                   // empty probe proposing to consume a carried identity when nothing
                                   // was carried: answer immediately instead of storing a gate over a
                                   // value that does not exist. Same non-generic state contract as
                                   // readBack.
}
```

**`readBack`** exists because the library owns the CAPTURE half — `capture.ts` sanitized, joined and
validated those params — so it alone knows the exact stored value. Handing the model raw
`proposed_params` and leaving "tell the caller what was recorded" to its discretion is measurably where
read-backs break: a model converting digits to words drops or doubles one on runs of equals, and the
caller then confirms against wrong words — the one mistake a confirmation gate cannot catch. The
library does NOT own the LEXICON (rendering is language- and channel-specific), so the host supplies
this function. It receives the **parsed** params (rendering from what was stored is what stops the
read-back drifting from what executes) and the current state view. Deliberately non-generic —
`ConfirmationOpts` carries no state type, so hosts cast their own state exactly as executors do with
their slices. Pair it with a prompt rule telling the model to speak `read_back` verbatim when present;
without such a rule the field is inert.

**`repeatReadBack`** (2.5.0) closes the other half of the same failure: 2.3.0 made the FIRST recap
engine-rendered, but when the caller asks for it again ("pardon?"), the model was back to reproducing
the recap itself from mutable context. With the opt set, the rendering is persisted on the gate and the
sole-step `repeat_pending_confirmation` control (reserved only when at least one action opts in) returns
the stored bytes verbatim. Repetition advances the gate's presentation-turn provenance — the repeated
recap becomes the consent question the caller must answer on a LATER turn — so a second ReAct loop can
neither repeat again nor execute the mutation on the same caller turn. The control validates that the
pending gate belongs to an opted-in action and actually carries a rendering; a misdirected call
fails closed and changes nothing.

**`refuseProposal`** (2.5.0) fills the lifecycle gap between the params schema (shape, no state
access) and the executor (state, but runs only AFTER consent): a schema-valid, state-impossible
proposal is answered immediately, storing nothing and burning nothing. Keep it a pure function of
(params, state) and mirror the executor's own consumption rule so the two can never disagree.

There is deliberately **no TTL**: the runner times nothing out. Stale gates clear via `abort_pending_input` or via backend signals the executor surfaces as `clear_awaiting_input` / `abort_flow` effects. (2.0.0 removed the inert `ttlMs` field and the empty `OtpOpts` type — `requiresOtp` is a plain `boolean`; the library never counts OTP attempts, the backend is authoritative.)

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

## ExecutorResult + ExecutorEffect

```ts
interface ExecutorResult<T> {
  resultBody: object;              // JSON-serializable; the LLM sees this
  stateUpdate?: Partial<T>;        // HOST-OWNED slots only — threaded to subsequent batch
                                   // steps + committed at end. Writing a library-managed slot
                                   // (awaitingInput, currentFlow, boundedChoice, pagedRead,
                                   // deflectedAside, handoff, errorCount, actionTrail) through it
                                   // THROWS — library transitions go through `effects` instead.
  effects?: ExecutorEffect[];      // typed library-state transitions (below)
  ok: boolean;                     // false short-circuits the batch
}

type ExecutorEffect =
  | { type: "request_handoff"; request: HandoffRequest }
                                   // terminal business outcome: atomically clears every transient
                                   // runner slot (awaitingInput, currentFlow, boundedChoice,
                                   // pagedRead) and writes the `handoff` slot — exactly like the
                                   // built-in request_handoff action. Honoured regardless of `ok`
                                   // (a refusal verdict may still be terminal). TERMINAL IS
                                   // ENFORCED: once the handoff is set, the step's remaining
                                   // interaction lifecycle is skipped and the batch ends after
                                   // the current step (handoff monotonicity). The ONLY way an
                                   // executor requests a handoff.
  | { type: "merge_flow_data"; data: Record<string, unknown> }
                                   // shallow-merge into currentFlow.data. Honoured on ok:true;
                                   // requesting it with no active flow (and no startsFlow on the
                                   // action) is a programmer mistake and throws.
  | { type: "otp_issued" }         // this step minted an SCA challenge; the runner opens the OTP
                                   // gate for the consumer named in the action's issuesOtp hook.
                                   // Honoured on ok:true; requires an active flow + the config
                                   // hook. Keep challenge details (challengeId etc.) in
                                   // resultBody and/or a merge_flow_data effect — the runner
                                   // never read them.
  | { type: "clear_awaiting_input" }
                                   // drop the pending input gate only, keep the flow. Use for
                                   // "the current OTP is dead but the flow continues" (timeout).
                                   // Honoured regardless of `ok`.
  | { type: "abort_flow" };        // terminal in-flow failure; drop the gate AND the flow (and
                                   // any bounded-choice overlay). Honoured regardless of `ok`.
```

Effects are **signals, not an ordered program** — the runner honours each one at a fixed, documented point of the step lifecycle (see `<state_threading>` step 5f). Pre-2.0 executors expressed these as `flowData` and a `lifecycle` object; both are gone.

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
// state. Returns an ExecutorResult<T> whose stateUpdate may patch any
// HOST-OWNED slot (the reducers merge them); library-managed slots are
// rejected loudly — request those transitions via `effects`.
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
      attempts_left: number; max_attempts: number; flow_ref?: string;
      proposed_on_caller_turn_id?: string;    // the caller turn the proposal was stored on (or last
                                              // REPEATED on — the repeat control advances it); a
                                              // matching re-call on the SAME turn is refused
                                              // (confirmation_same_turn_locked) — see
                                              // <confirmation_lifecycle>. Absent when no stable
                                              // turn identity existed at propose time.
      read_back?: string }                    // (2.5.0) exact caller-audible rendering, persisted only
                                              // when the owning action sets ConfirmationOpts.repeatReadBack;
                                              // repeat_pending_confirmation returns these stored bytes.
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

The library does NOT TTL any slot. Stale gates clear via `abort_pending_input` or via backend signals (timeout/lockout, surfaced by the executor as `clear_awaiting_input` / `abort_flow` effects).

## CurrentFlow (library-managed)

Single active flow at a time (flow mutex). Set on `startsFlow` ok; cleared on `endsFlow` ok or an `abort_flow` effect:

```ts
interface CurrentFlow {
  name: string;
  data: Record<string, unknown>;   // scratch bag; executors merge via the merge_flow_data effect
}
```

Starting a different flow while another is active fails with `error: "flow_already_active"`. Re-entering the SAME flow is idempotent — the executor runs (e.g. to re-issue an OTP), and its `merge_flow_data` effect shallow-merges into the existing `currentFlow.data` (no reset).

## BoundedChoice (library-managed)

The one-shot conversational-choice overlay's slot (see `<bounded_choice>`). `null` until a configured choice is offered; the runner is the only writer. Unlike `awaitingInput`, this does NOT replace or unlock a pending confirmation/OTP/match gate — a caller-facing meta-choice may temporarily suspend the spoken question while the original gate remains authoritative underneath.

```ts
interface BoundedChoice {
  name: string;                        // which configured choice
  status: "pending" | "resolved";      // pending = the caller still owes a selection
  selection?: string;                  // the recorded nonterminal selection
  requested_on_caller_turn_id?: string;// turn the choice was OFFERED on — while current,
                                       // it cannot be resolved/consumed (same-turn lock)
  resolved_on_caller_turn_id?: string; // turn a nonterminal selection resolved on — domain
                                       // actions stay locked while that turn is current
}
```

`resolved` deliberately persists until the surrounding flow ends or a terminal handoff clears it, so the same one-shot choice cannot be offered again later in the conversation.

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

The host gets the `pagedRead: PagedCache<unknown> | null` slot (alongside `awaitingInput` / `currentFlow` / `boundedChoice` / `deflectedAside` / `handoff` / `errorCount` / `guardTurn` / `actionTrail`) by spreading the library's `agentStepZodShape` into its Zod state schema — the bootstrap state template does this. Each slot in `agentStepZodShape` is wrapped with `withLangGraph` so it carries the runner's expected last-writer-wins reducer/default as channel metadata. The per-slot schemas (`AwaitingInputSchema`, `CurrentFlowSchema`, `BoundedChoiceSchema`, `PagedCacheSchema`, `HandoffRequestSchema`, `TrailEntrySchema`) are individually exported from `index.ts` too. (A host still on a LangGraph `Annotation.Root` spreads the equivalent `agentStepStateSpec` fragment instead — still exported, but the scaffold uses the Zod path.) Since 2.0.0 `buildAgentStepTool` **verifies channel completeness at construction**: a state schema missing a channel for any library slot the configuration writes throws (the message names the missing slots and the spreadable fragments).

`index.ts` also exports **`agentStepTaskScopedSlots`** (2.2.0) — the subset of library slots that describe work IN PROGRESS (`awaitingInput`, `currentFlow`, `boundedChoice`, `pagedRead`, `deflectedAside` (2.4.0), `errorCount`, `actionTrail` (2.6.0)), which `createHandoffNode` nulls when a task-ENDING handback resolves. `handoff` is deliberately absent: the node returns it as null either way. (`deflectedAside` being task-scoped means a task-ENDING handback re-arms the free deflection for the next task, while an `off_topic` re-route — not a task ending — deliberately does NOT.) See `<handoff>` for the clearing rules and the host-slot counterpart (`HandoffSpec.clearsOnHandback`).

`index.ts` also exports **`agentStepInternalSlotMask`** — a Zod `.omit()` mask of the nine library-managed slot keys. A host derives a graph INPUT schema by omitting these (they are runner-written only, never caller input) from its full state schema: `AgentStateSchema.omit({ ...agentStepInternalSlotMask, /* + any host-derived slots */ }).partial().extend({ messages: MessagesZodState.shape.messages })`. Re-attach `messages` after `.partial()` — `.partial()` strips the messages-channel metadata LangGraph Studio keys off to render its chat input box (see `state-and-prompt-integration.md`). Wired as the `input` of a hand-built `new StateGraph({ state, input })`, this rejects/coerces a malformed or internal-slot-injecting invoke at the boundary.

## HandoffRequest (library-managed)

The pending channel-handoff request, written by the built-in `request_handoff` action (only available when the tool opted in via `BuildAgentStepToolOptions.handoff`) or by an executor's `request_handoff` **effect** — never through `stateUpdate` — and resolved — then cleared — by the host graph's `createHandoffNode(spec)` node. `null` otherwise; rides `agentStepZodShape` like the other slots. Once set, handoff is **monotonic**: the step's remaining interaction lifecycle is skipped and the batch ends after the current step. See `<handoff>`.

```ts
interface HandoffRequest {
  reason: "off_topic" | "completed" | "abandon";
  context: string;  // per-reason, never empty, always in the customer's language:
                    // off_topic → the customer's request (verbatim or tightly summarized);
                    // completed / abandon → the LLM-composed closing line the node speaks
}
```

## guardTurn (library-managed, HOST-written) — 2.3.0

The turn-scoped latch for **host model-input guards**: `Record<string, string> | null`, mapping a guard id to the caller-turn id it last fired on. It exists because the ReAct loop re-enters the model several times within ONE caller turn (agent → tools → agent …), so a host guard whose condition stays true would re-inject its note on every pass. Deciding "has this already fired since the caller last spoke?" needs the stable caller-turn identity the library already owns (`<caller_turn_identity>`) — hosts that re-derived it by scanning messages backwards ended up parking the answer in the resolved message's `additional_kwargs`, i.e. inside the frozen channel contract.

```ts
guardFiredOnTurn(state, guardId, getCallerTurnId?): boolean   // has it fired on the CURRENT turn?
markGuardFired(state, guardId, getCallerTurnId?): Partial<T>  // patch recording that it just did
```

- **The runner never writes this slot** — it is the one library slot excluded from the executor `stateUpdate` guard (`LIBRARY_MANAGED_KEYS`), because banning a slot the runner doesn't coordinate would ban nothing. It is also absent from `agentStepTaskScopedSlots`: entries expire by themselves when the turn id changes, so the latch is turn-scoped, not task-scoped.
- **No turn identity ⇒ UNLATCHED** (returns false, patch is empty) — an identity-less consumer keeps the unlatched behaviour rather than being silently locked out, the same stance the confirmation gate takes for `sameTurnLocked`.
- **The patches do NOT compose by spreading.** Each carries a whole `guardTurn` map built from the state passed in, and the reducer replaces — so `{...markGuardFired(s,"a"), ...markGuardFired(s,"b")}` loses `"a"`. Chain them instead (feed the first patch's state forward, or merge the maps by hand). Pinned by a library test.
- The library owns the LATCH and the turn identity only. What a guard says, and where the host injects it, stay the host's prompt.

## errorCount (library-managed)

The consecutive backend-failure counter for the auto-handoff guard (`<auto_handoff>`). `number | null`; rides `agentStepZodShape` like the other slots. The runner increments it when a batch ends in a backend failure, resets it to 0 when a batch in which an executor **actually ran** ends without one, and clears it to 0 when it auto-triggers a handoff at the threshold. Batches where no executor ran (confirm-gate proposals/re-proposals, prereq or param refusals, aborts, handoff signals) are **neutral** — they neither increment nor reset. Executors must never write it.

## actionTrail (library-managed, 2.6.0)

The runner's per-task audit record: `TrailEntry[] | null`, one `{ action, ok, error?, proposed? }` entry per step RESULT of every admitted batch — domain steps, controls, and the synthetic `auto_handoff` — in execution order, appended by `run/finalize.ts` and carried across batches of the same task. A deliberate projection ALLOW-LIST: never params, summaries, or result bodies, so the trail is PII-free by construction. `proposed: true` marks a confirmation propose/re-propose (no executor ran); `error` carries the step result's error code, so execution-phase refusals (gate locks, prereq denials, `invalid_params`) are visible. An ADMISSION-refused batch leaves no trail — refusal commits nothing, and the trail is state like everything else. Forced handoffs (`HandoffSpec.forcedHandoff`) never reach the runner and never appear.

**Audit-only.** Nothing in the runner, the controls, or the prompt reads it, and the model never sees it — the model-facing surface is independent of the slot. Consumers read it from observability's graph-state capture; the complete per-task record lives in the INPUT state of the `resolve_handoff` run (the node clears task-scoped slots in its output). Task-scoped (`agentStepTaskScopedSlots`): a task-ENDING handback clears it, so each task on a reused thread starts a fresh trail. Executors must never write it (`LIBRARY_MANAGED_KEYS` throws). Its channel is the one UNCONDITIONALLY required entry in the construction check — the trail is written on every finalized batch, whatever the config uses — and it arrives with the spread fragments like every other slot.

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

## 3. Reserved action names

`abort_pending_input` is ALWAYS reserved — the library auto-injects it into the tool schema whenever ANY action declares one of: `requiresConfirmation`, `requiresOtp`, `issuesOtp`, `startsFlow`, `endsFlow`, `requiresFlow`, `requiresMatch`, `startsMatchFor`. `request_handoff` is reserved ONLY when `BuildAgentStepToolOptions.handoff` is provided (see `<handoff>`) — a tool that does NOT opt in may define its own action under that name (the orchestrator/scaffold handoff mechanism does exactly that). `request_bounded_choice` / `resolve_bounded_choice` are reserved ONLY when `boundedChoices` is provided (see `<bounded_choice>`). `deflect_aside` (2.4.0) is reserved ONLY when `HandoffSpec.deflectAside` is set (see `<handoff>`). `repeat_pending_confirmation` (2.5.0) is reserved ONLY when at least one action sets `ConfirmationOpts.repeatReadBack` — sole-step (`repeat_confirmation_must_be_sole_step`: a recap is a read-only turn boundary; domain work in the same batch could turn the caller's clarification into consent). These library-owned actions are **controls** (`controls/` in the library): each carries its own activation, schema variant, description line, lockdown allowances, and execution — the run pipeline dispatches them instead of an executor. Declaring a reserved name throws:

```
agent-step: "<name>" is a reserved action name auto-injected by the library; remove it from config.actions.
```

`abort_pending_input` is idempotent — it clears `awaitingInput` AND `currentFlow` together. No-op when nothing is active.

**`abortPolicy`** (2.5.0, optional) narrows abort from that permissive default into an engine-enforced
in-domain transition. Omit it and the legacy behaviour is preserved byte-for-byte. When configured:

```ts
interface AbortPolicy<ActionName extends string> {
  requireActive?: boolean;                      // refuse abort when no gate, flow, or PENDING bounded
                                                // choice is active (a resolved choice is a persistent
                                                // one-shot marker, not active input). Default false.
  allowStandalone?: boolean;                    // permit abort as the batch's only step; when false,
                                                // exactly one legal follower is required. Default true.
  allowedFollowers?: readonly ActionName[];     // domain actions that may immediately follow abort.
                                                // Omit = any declared domain action; [] = none.
  allowedPendingTargets?: readonly ActionName[];// gates abort may clear: batch-start awaitingInput
                                                // must exist and its for_action be listed. Omit = any.
}
```

Admission then enforces: abort LEADS the batch, clears something real when `requireActive`, and has at
most one declared domain follower — control followers are never legal. Every knob is validated at
construction (unknown or duplicate action names, an unsatisfiable `allowStandalone=false` with an empty
follower list — all throw). The activation renders the configured contract into the control's own
model-facing description, so the surface the model reads is derived from the same configuration the
engine enforces.

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
2. Merger is built from the state schema passed as `stateSchema` (a Zod object whose fields carry reducer metadata via `withLangGraph`, OR a LangGraph `Annotation.Root`). Each field's reducer is extracted from its channel's `BinaryOperatorAggregate.operator`; a Zod schema's channels are resolved through the langgraph zod registry to the same channel classes. The `messages` field is explicitly skipped (the runner emits its own `ToolMessage` at the end). When any confirm gate or bounded choice is configured, the runner also resolves the **caller-turn identity** here (`getCallerTurnId`, defaulting to the latest human message id — see `<caller_turn_identity>`).
3. **Admission** (`run/admission.ts`) — every whole-batch precondition, in a FIXED order, each able to refuse the batch (a single result entry, `failed_at: 0`, nothing committed):
   a. **Unknown action** — hallucinated/typo'd names get a structured refusal.
   b. **Choice same-turn lock** — a bounded choice resolved on THIS caller turn keeps domain work locked until the caller speaks again.
   c. **Choice pending lockdown** — a pending bounded choice admits only its controls / abort / handoff / configured direct inputs.
   d. **Gate lockdown** — a pending confirmation/OTP/match admits only its target action / abort / handoff / choice controls (+ the capturer, for match; see lockdown table above).
   e. **Flow mutex** — first step `startsFlow=X` while `currentFlow.name=Y` (≠X) → refuse `flow_already_active`.
   f. **Control exclusivity** — sole-step control families (handoff, bounded-choice) refuse to share a batch.
   g. **soleStep / soleOnExecute** — per-action batch-shape refusal (computed off batch-start pending so the LLM-natural `[verify, mutate]` batch can propose).
4. **Plan expansion** (`run/planning.ts`) — tag each user step with its confirmation mode (`propose` | `rePropose` | `execute` | `sameTurnLocked` | `exhausted`) based on pending state at batch-start. Frozen before any executor runs (same-batch-bypass safety). Planning is **abort-aware**: confirm steps AFTER an `abort_pending_input` in the same batch plan against NO pending — they propose fresh instead of executing against the gate the batch just cleared.
5. For each planned step (`run/execution.ts`):
   a. Control steps (`abort_pending_input`, `request_handoff`, the bounded-choice controls) dispatch to their `ControlAction` implementation, not an executor.
   b. Library-managed prereqs (`requiresFlow`, then `requiresOtp` / `requiresMatch`) → refuse if not gated.
   c. User-declared prereqs (verifiers) → refuse with denial body.
   d. Validate params via `paramsSchema.parse`.
   e. Run the action's selector against the running `view` to build the slice, then call the executor: `executors[action](params, selectors[action](view))`. If the executor throws, the runner catches it, marks the step `ok:false` (`error: "executor_error"`), and short-circuits — earlier steps' commits are preserved.
   f. Apply executor outputs in this order: `stateUpdate` (host slots only — library slots throw) → `request_handoff` effect (terminal; skips the rest) → `startsFlow` + `merge_flow_data` → `otp_issued` → auto-clear of `requiresOtp`/`requiresMatch` on ok → `startsMatchFor` → `endsFlow` → `clear_awaiting_input` / `abort_flow`. On ok:false + `verdict:"match_mismatch"`, decrement match attempts (or abort flow on exhaustion). **Handoff monotonicity:** once the `handoff` slot is set (control or effect), the remaining interaction lifecycle is skipped and the batch ends after the current step, whatever `ok` was.
6. **Finalize** (`run/finalize.ts`) — build the result body, apply the error-counter/auto-handoff policy, and emit a single `ToolMessage` whose content is the JSON-stringified `RunnerResultBody = { summary, results, failed_at? }`.

**Cumulative commit on partial failure:** state patches from successful earlier steps DO commit even if a later step fails. Example: `[verify_customer (ok), verify_card (fail)]` → `verifiedCustomer` persists for the next turn.

**Crucial:** state slots in the graph's `state.ts` MUST declare an explicit reducer (`Annotation<T>({ reducer, default })`). The library reads the reducer at runtime. Slots declared without a reducer get replace-on-write behavior (which is fine — but be explicit about it).
</state_threading>

<confirmation_lifecycle>
## Mutation propose → execute lifecycle (when `requiresConfirmation` is set)

The runner switches the mutation action into a five-mode state machine. Detected by reading `awaitingInput.kind === "confirmation"`:

**Ordering with prereqs (non-obvious, but guaranteed).** A step's library prereqs (`requiresFlow`) and user verifiers run BEFORE its confirmation mode is acted on (`<state_threading>` step 5b/5c, ahead of the propose in 5f). So a confirm-gated mutation whose `requiresFlow`/prereqs are unmet is **refused, not proposed** — `awaitingInput` is never set into a doomed state. Compose `requiresConfirmation` with `requiresFlow` freely; the gate order is correct.

### First call (no pending, or pending action ≠ this action) → **propose mode**
- Parse params with the action's **effective schema** (the declared `paramsSchema`, page-extended for `pageable` actions) and store them **PARSED** — schema normalization (`z.preprocess`, coercion) is applied before storage: `awaitingInput = { kind: "confirmation", for_action, params, attempts_left: maxAttempts, max_attempts, proposed_on_caller_turn_id? }`. The proposal is stamped with the current caller-turn identity when one exists (see `<caller_turn_identity>`).
- A failed parse returns `{ ok: false, error: "invalid_params" }` with the overridable `invalid_params` system-message summary and the raw Zod detail in `_debug` (nothing is stored).
- Return `{ ok: true, summary, needs_confirmation: true, proposed_params, attempts_left }`, plus **`read_back`** when the action declares `ConfirmationOpts.readBack` and it renders a non-empty string for these parsed params (2.3.0). Absent — not empty — when it renders nothing.
- **Executor is NOT invoked.**

### Re-call whose params **parse to the pending proposal**, on a LATER caller turn → **execute mode**
- The incoming RAW params are parsed with the same effective schema, then compared (deep value equality) against the stored parsed proposal — value normalization never reads as drift (e.g. a `z.preprocess` stripping STT separators: `"70,76"` ≡ `"7076"`). A failed parse counts as drift (→ rePropose).
- Clear `awaitingInput` atomically BEFORE invoking the executor.
- Invoke the executor with the parsed params + view.
- Whatever the executor returns is the result (the executor performs its own pre-read + write + post-read).

### Matching re-call on the SAME caller turn → **sameTurnLocked** (2.0.0)
- The proposal carries `proposed_on_caller_turn_id`; a matching re-call while that turn is still current means the caller has NOT actually answered the read-back — the model is confirming with itself. Refused with `error: "confirmation_same_turn_locked"`: no attempt is spent, the gate stays untouched, and execution requires a re-call on a later caller turn.
- Enforced only when both turn identities exist. Identity-less direct `runSteps` consumers (state fixtures without message ids) keep the pre-2.0 params-only behavior. **Test-harness implication:** manual propose → execute sequences must simulate the caller's answering turn — append a fresh human message id between the two calls (the bootstrap harness ships `answeredTurn` / `runConfirmed` helpers for exactly this).

### Re-call with **genuinely different params** (or params that fail to parse) → **rePropose mode**
- Update `awaitingInput.params` to the newly parsed params, decrement `attempts_left`.
- If the re-call's params fail to parse: the step fails with `invalid_params` (summary = the overridable system message, raw Zod detail in `_debug`) and the pending proposal is left **unchanged** — no decrement, the prior proposal still stands.
- If `attempts_left > 0`: return new `needs_confirmation` envelope with decremented `attempts_left` — including a fresh `read_back` rendered from the CORRECTED params, so the caller hears what actually replaced the old value.
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
- Fires only when the watched slot's pre-step value was **non-null** AND the written value is not **deep-VALUE-equal** to it (canonicalized-JSON compare — reference identity never counts, so an executor writing a fresh-but-value-equal object does NOT fire).
- First-time set (`null → value`) does NOT fire — there was nothing downstream to invalidate yet.
- Same-value writes (no real change) do NOT fire — including a fresh object with identical contents.
- Slots set later in the same batch are NOT retro-cleared; an executor's own writes to a downstream slot win over the cascade.

Invalidated slots are written as `null` regardless of their declared type, so any slot listed as a target must accept `null` as its "unset" sentinel. CAUTION: the `null` must also survive the HOST's reducer for that slot — list only **replace-on-write** slots as invalidation targets. A record-merge reducer (`{...prev, ...(next ?? {})}`) swallows the `null` at the graph boundary, so the slot resurrects on the next turn even though the in-batch view saw it cleared.
</invalidates_on_change>

<otp_lifecycle>
## OTP gate (when `issuesOtp` / `requiresOtp` are set)

Two actions cooperate: the **issuer** mints an SCA challenge; the **consumer** validates the customer's OTP. Library coordinates `awaitingInput.kind === "otp"`.

### Issuer (`controller.issuesOtp = { consumer_action }`)
- Executor calls the SCA backend to mint a challenge.
- On `ok: true`, the executor returns `effects: [{ type: "otp_issued" }, { type: "merge_flow_data", data: { challengeId, customerId, ... } }]` — the merge carries the challenge details so the consumer can read them from `currentFlow.data`; surface caller-facing bits (e.g. a masked mobile) in `resultBody`.
- Library sets `awaitingInput = { kind: "otp", for_action: consumer_action, flow_ref: currentFlow.name }`.

Issuer typically also declares `startsFlow: { name: "X" }` so the OTP gate is tied to a flow.

**Match-then-OTP ordering guard.** An `issuesOtp` step is refused (pre-execution, so the SCA backend is never called) when a double-entry **match** gate is still pending in the live view — error `otp_blocked_match_pending`. This enforces "at most one input gate at a time, match before OTP": without it, a `[capturer, issuer]` batch would mint+send the OTP and overwrite the still-pending match gate, skipping the second entry entirely. The check reads the **live** view (not batch-start), so the legitimate `[consumer, issuer]` batch still works — the consumer clears the match earlier in the same batch, so no match is pending by the time the issuer runs.

### Consumer (`controller.requiresOtp = true`)
- Refused unless `awaitingInput.kind === "otp" && for_action === <this action>`. Error: `otp_not_pending` if the gate isn't pending; `otp_pending_locked` if something else is awaiting.
- Executor reads `challengeId` (etc.) from `state.currentFlow.data`, calls SCA validate.
- Library **does not count OTP attempts**. The backend is authoritative for lock / timeout / wrong:
  - **valid** → executor returns `ok: true`; library auto-clears `awaitingInput`. Flow continues.
  - **wrong, retry allowed** → executor returns `ok: false` (no effects). Library leaves state alone; customer re-reads the same code.
  - **timeout** → executor returns `ok: false, effects: [{ type: "clear_awaiting_input" }]`. The gate dies; the LLM offers to resend (re-call the issuer to mint a fresh challenge).
  - **lockout** → executor returns `ok: false, effects: [{ type: "abort_flow" }]`. The flow is dead; library clears `awaitingInput` AND `currentFlow`.

### Single consumer, multiple issuers
A single `confirm_otp` action can serve every OTP-protected flow in the tool. Each issuer points its `issuesOtp.consumer_action` at that one consumer, and the consumer reads `currentFlow.data` to know which challenge is in play.
</otp_lifecycle>

<match_lifecycle>
## Double-entry match gate (when `startsMatchFor` / `requiresMatch` are set)

The customer provides a value once, then again; the system verifies they match. Used for PIN setup, password change, secret-answer confirmation. Library coordinates `awaitingInput.kind === "match"`.

### Capturer (`controller.startsMatchFor = { consumer_action }`)
- Executor validates/encodes/persists the first entry (typically into flow data, via a `merge_flow_data` effect).
- On `ok: true`, library sets `awaitingInput = { kind: "match", for_action: consumer_action, attempts_left: maxAttempts, max_attempts: maxAttempts, flow_ref? }`.
- Re-running the capturer while a match is awaiting **resets** `attempts_left` (lets the customer change their first entry).

### Consumer (`controller.requiresMatch = { capturer, maxAttempts }`)
- Refused unless `awaitingInput.kind === "match" && for_action === <this action>`. Error: `match_not_pending` if absent.
- **Same-batch double-entry is refused (batch-start freeze).** The gate check reads the awaiting-input snapshot as it stood at **batch start**, not the live in-batch view — so a match gate the capturer opens *earlier in the same batch* is NOT consumable by the consumer in that same batch. The double-entry repeat must arrive in a SEPARATE turn (mirrors the confirmation same-batch-bypass protection). A `[capturer, consumer]` batch fails at the consumer with `match_not_pending`; the legitimate `[consumer, issuer]` batch is unaffected (the consumer's gate was opened in a prior turn, so it IS present at batch start).
- Executor receives the second entry, owns the comparison (e.g. compares ciphertexts), performs the side-effect on match.
- Library reads the executor's outcome:
  - `ok: true` → match succeeded; library auto-clears `awaitingInput`. Pair with `endsFlow: true` to wrap the flow.
  - `ok: false` + `resultBody.verdict === "match_mismatch"` → library decrements `attempts_left`. On exhaustion, library clears `awaitingInput` AND `currentFlow` (terminal) and surfaces `verdict: "match_attempts_exhausted"`, `error: "match_attempts_exhausted"`.
  - `ok: false` + any other verdict → library leaves state alone (unrelated failure, e.g. backend error).

### Lockdown
While `awaitingInput.kind === "match"`, only three actions are allowed as the first step: the consumer, the capturer (re-capture), or `abort_pending_input`.
</match_lifecycle>

<caller_turn_identity>
## Caller-turn identity (`BuildAgentStepToolOptions.getCallerTurnId`)

Four protections key on a **stable identity for the latest caller turn**: the confirmation gate's same-turn lock (`<confirmation_lifecycle>`), the bounded choice's offered-this-turn lock, the bounded choice's resolved-this-turn lock (`<bounded_choice>`), and — since 2.3.0 — the host guard latch (`guardTurn`). By default the runner resolves it as the **latest human/user message id** in `state.messages` — LangGraph's messages reducer assigns missing ids before a node sees state, so this is stable across every ReAct loop within one caller turn and independent of history length.

- Hosts that **compact or replace messages** must provide `getCallerTurnId: (state) => string | null | undefined` returning a stable, non-compacted turn token.
- When no identity exists (e.g. direct `runSteps` calls with message-less fixtures), the confirmation same-turn guard is **deliberately unavailable** (params-only behavior) — the runner never guesses. Bounded-choice **resolution**, by contrast, **fails closed** (`bounded_choice_turn_identity_unavailable`): recording a selection requires knowing which turn it happened on.
- The hook (and the message scan) is only consulted when a confirm gate or bounded choice is actually configured — hosts using neither never pay for it.
- **`resolveCallerTurnId(state, getCallerTurnId?)` is exported** (2.3.0) so hosts stop re-deriving this. It returns the host hook's value when configured, else the latest human message id; blank/whitespace collapses to `undefined` (identity unavailable). The guard latch is built on it — pass the same `getCallerTurnId` you gave `buildAgentStepTool`, or the two halves will disagree about where a turn starts.
</caller_turn_identity>

<bounded_choice>
## Bounded-choice overlay (`BuildAgentStepToolOptions.boundedChoices`)

An opt-in, **engine-owned, one-shot conversational choice** layered OVER whatever domain gate is pending. Use it when the conversation must fork on a meta-question ("do you want to continue with X, or stop?") without clearing or unlocking a suspended confirmation/OTP/match — the original gate stays authoritative underneath. The host prompt decides WHEN the configured choice applies; the runner owns its persisted pending/resolved state, locks, and repeat fallback.

```ts
// BuildAgentStepToolOptions.boundedChoices: BoundedChoiceRegistry
type BoundedChoiceRegistry = Record<string, BoundedChoiceDef>;

interface BoundedChoiceDef {
  description: string;                     // model-facing: when/why to offer this choice
  selections: readonly string[];           // the nonterminal resolutions the runner may record
                                           // (e.g. ["continue"]). Terminal alternative = the
                                           // built-in request_handoff action.
  directInputActions?: readonly string[];  // domain actions allowed to CONSUME a pending choice
                                           // because the caller supplied the exact detail the
                                           // suspended question asked for. Everything else stays
                                           // locked until resolve_bounded_choice runs.
  onRepeatHandoff?: HandoffRequest;        // atomic handoff fallback when the model re-requests
                                           // an already-used choice (requires the handoff opt).
  renderRequest?: (state: unknown) => string | undefined;
                                           // OPTIONAL (2.5.0) — render the exact caller-audible
                                           // OFFER when the choice is stored. A non-empty return
                                           // rides the control result as `read_back`, spoken
                                           // verbatim. Receives the in-batch state view including
                                           // the newly pending choice and any suspended gate.
  renderResolution?: (selection: string, state: unknown) => string | undefined;
                                           // OPTIONAL (2.5.0) — render the exact caller-audible
                                           // RESUME after a nonterminal selection is recorded;
                                           // same `read_back` contract. The read-back doctrine
                                           // (see ConfirmationOpts.readBack) extended to the
                                           // choice overlay: fixed offers and resumes are exactly
                                           // where model paraphrase was measured to drift.
}
```

Providing a non-empty registry injects two library-owned **controls** into the tool schema (both exported as constants): **`request_bounded_choice`** (`REQUEST_BOUNDED_CHOICE_ACTION`) and **`resolve_bounded_choice`** (`RESOLVE_BOUNDED_CHOICE_ACTION`). Both names become reserved. The policy, stated once:

- **One-shot.** Once a choice has been requested it can never be offered again (`bounded_choice_already_used`). With `onRepeatHandoff` configured, a repeat request atomically emits that handoff instead of refusing. A `resolved` choice persists in the slot until the surrounding flow ends or a terminal handoff clears it.
- **Lockdown while pending.** Only the choice controls, `abort_pending_input`, `request_handoff`, and the configured `directInputActions` may run (`bounded_choice_pending_locked` otherwise). This is what prevents a meta-level "continue" from becoming consent for a suspended permanent mutation if the model emits the wrong action.
- **Offered-this-turn lock.** The request control stamps `requested_on_caller_turn_id`; while that turn is current, `resolve_bounded_choice` and direct-input consumption are refused (`bounded_choice_same_turn_locked`) — the caller must actually hear the fork and reply before anything counts as their selection. Abort / handoff / repeat-request stay available.
- **Resolved-this-turn lock.** A nonterminal resolution records `resolved_on_caller_turn_id`; domain work stays locked while that turn is current (`bounded_choice_resume_turn_locked`), so a second ReAct loop in the SAME turn cannot execute suspended work. Resolution **fails closed** without a stable turn identity (`bounded_choice_turn_identity_unavailable`) — see `<caller_turn_identity>`.
- **Consume-on-acceptance.** A pending choice is consumed as `domain_input` only when a direct-input step is ACCEPTED (flow gate + prereqs + params all passed; a confirm propose counts). `invalid_params` / prereq denials do NOT burn the one-shot. (2.5.0) Consumption is **transcript-visible**: the consuming step's result is stamped `choice_consumed`, so the model derives pending/resolved status from tool results alone — a silent engine transition the model can only learn from state is a bug by definition.
- **Leading-resolve batch (2.5.0).** A batch may open with `resolve_bounded_choice` followed by the pending choice's own `directInputActions` — the shape a model naturally emits when one caller reply both selects "continue" and supplies the suspended detail. Every permitted follower is an action the config already trusts to consume caller input while the choice is pending (a confirm-required mutation is structurally never among them), so "continue" still cannot become consent; the same-turn locks above still apply, and any other follower keeps refusing.
- `resolve_bounded_choice` with nothing pending → `bounded_choice_not_pending`; an unknown selection is an `invalid_params` refusal.

The registry is validated at construction: non-empty names/descriptions/selections, no duplicate selections, `directInputActions` must name real actions, `onRepeatHandoff` requires the `handoff` opt (see `<construction_time_checks>`).
</bounded_choice>

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

<caller_digit_capture>
## Caller-digit capture (`digitsOnly` / `callerDigits` / `digitGroupsParam` / `digitCandidatesParam`)

Schema helpers for params that carry **caller-dictated digits** (a tax number, a card-number tail, an OTP-adjacent code). Unlike `paginate.ts` — whose primitives the runner itself uses — this module is **authoring-only**: nothing in the runner calls it. It lives in the library because each rule below is a consequence of a runner contract, so a host that hand-rolls the field re-derives (or misses) them one live failure at a time:

- **Shape rules are refinements, never `.regex()`.** A `.regex()` becomes a `pattern` keyword in the model-facing JSON Schema, turning the tool's validation into a precondition the model must satisfy before it may call. The model then counts digits itself — unreliable on grouped STT captures — and either **withholds the call** (answers the caller instead; a valid capture never reaches the tool) or **pads an invented digit** to satisfy the pattern. `callerDigits(shape, message)` keeps the wire type a plain `string`; the runner's propose-path parse bounces a bad shape as recoverable `invalid_params` — before any read-back, without spending a confirmation attempt.
- **Refinement messages carry no digit count.** Issue text rides the StepResult's `_debug` back to the model; "must be exactly 9 digits" re-introduces through the error path the very constraint the refinement keeps out of the schema, precisely on the turn where the model is about to re-ask. Say WHAT failed ("not a usable capture"), never HOW MANY DIGITS. The ban is on the VALUE's length: a count of something else — how many alternative readings `maxCandidates` allows, say — tells the model nothing about the digits and is fine.
- **Representation flips must not read as drift.** The confirmation gate compares schema-PARSED params, so `["7070"]` ≡ `"7070"` and separator variants must normalize identically — the separator strip and the singleton-array collapse live in the preprocess, before the compare.
- **The declared type is the honest wire union.** A field that accepts digit GROUPS carries the array branch in its TYPE — a preprocess is invisible to the model's schema and to shape-only wrapper validation, and with a bare string type a group-array call bounces as a raw schema error instead of the runner's voice-safe `invalid_params`.

Two field builders (both take a **required** `describe` — the library ships NO model-facing wording; field text is live prompt surface, owned and QA-gated per host):

- **`digitGroupsParam({ shape, message, describe })`** — the "transcription field": the model transcribes one array entry per **spoken digit group** («δεκαεπτά, είκοσι ένα, πενήντα δύο, δύο, ογδόντα δύο» → `["17","21","52","2","82"]`) or a single string; the JOIN happens in the preprocess, never in the model (models regroup, drop repeated groups, and lose the zero of round tens). `shape` validates the JOINED value. Omission stays `undefined` — the host's channel for "consume a carried/collected value".
- **`digitCandidatesParam({ shape, message, candidateMessage?, maxCandidates?, describe })`** — the ambiguous-reading field: a single digit string, or an array of EVERY plausible reading of one utterance («χίλια τρία» → `["1003","10003"]`) for the executor to try — the model never picks a reading itself.

**Description authoring (the part the host owns).** The proven register for `describe` — adapt, don't invent:
- Frame the field as **pure transcription** ("you are a stenographer here"): write down the digit groups exactly as heard, in spoken order; never concatenate, merge, regroup, shorten, extend, count, or judge; a group is never dropped because it repeats its neighbour; the SYSTEM sanitizes, joins, and does ALL validation, answering `invalid_params` on an unusable capture.
- Keep the field **semantically neutral**: naming the domain entity ("the AFM") or its length ("nine digits") re-activates the model's world knowledge — the measured source of withheld calls and reshaped captures no prompt scrub fully suppresses.
- Give 2–3 concrete renderings in the caller's language(s), e.g. `«10, 2, 22. 8078» → ["10","2","22","8078"]`.
- If omission consumes a carried value, say exactly that ("Omit the field entirely to consume …") — omission semantics belong in the field text, not only the prompt.
</caller_digit_capture>

<handoff>
## Library-coordinated channel handoff (`BuildAgentStepToolOptions.handoff`)

Opt-in machinery for a SPECIALIZED agent's off-topic plays (see `streaming-and-channel-contract.md` `<agent_roles>`): delegate the turn to another deployment and keep the conversation, or hand the conversation back. Two cooperating halves — the runner writes a slot; a host graph node resolves it.

### Runner half (opt-in)

Pass `handoff: HandoffSpec<T>` to `buildAgentStepTool`. The runner then:

- Auto-injects the reserved **`request_handoff`** control into the tool schema (with the opt provided, declaring it in `config.actions` throws; WITHOUT the opt the name is free — the orchestrator/scaffold mechanism uses it for its own action). Params = `HandoffRequestSchema`: `{ reason: "off_topic" | "completed" | "abandon", context }` — `context` is the customer's request for `off_topic`, the LLM-composed closing line for `completed` / `abandon`.
- Handles the action internally as an **atomic slot transition** — validates params, clears every transient runner slot (`awaitingInput`, `currentFlow`, `boundedChoice`, `pagedRead`), writes the `handoff` slot into view + committed state, and returns an ok result telling the model the turn ends here. No I/O in the runner. An **executor** requests the same terminal transition (identical atomic cleanup) via the `request_handoff` effect — never by writing the slot through `stateUpdate`, which throws.
- Enforces **exclusivity**: batched with anything else ⇒ the whole batch is refused with `error: "handoff_must_be_sole_step"`, nothing executes.
- **No prereqs**, and allowed as the first step under input lockdown (pending confirmation / OTP / match) — "transfer me" must work before any data is loaded and cannot be blocked by a pending gate.

### Graph half (`createHandoffNode`)

```ts
interface HandoffSpec<T> {
  offTopic: { mode: "terminate" }
          | { mode: "delegate"; url: string; assistantId: string; replyNode?: string;
              connectTimeoutMs?: number; timeoutMs?: number; headers?: Record<string, string> };
  actionDescription?: string;        // OPTIONAL — override the LLM-facing description of the
                                     // auto-injected request_handoff schema variant. The default
                                     // (HANDOFF_ACTION_DESCRIPTION) says `context` is SPOKEN for
                                     // completed/abandon — wrong for a host whose resolveClosingMessage
                                     // composes every closing from state; describe `context` truthfully
                                     // (e.g. routing metadata) or the schema contradicts the host prompt.
  terminateMessage: string;          // spoken envelope; also the delegate-failure fallback
  resolveClosingMessage?: (state: T, request: HandoffRequest) => string | undefined;
                                     // OPTIONAL — override the completed/abandon closing line from
                                     // actual operation outcomes (honesty invariant). Returns a string
                                     // to replace the LLM-composed `request.context`, or `undefined` to
                                     // fall through to it. NEVER called for off_topic (a silent hand-back
                                     // since 1.6.0; terminateMessage only backs delegate failures).
  resolveHandoffType?: (state: T, request: HandoffRequest)
                        => "completed" | "abandon" | undefined;
                                     // OPTIONAL (2.3.0) — decide the handback SIGNAL from state
                                     // instead of taking the model's word for it. Consulted ONLY for
                                     // a terminate-mode completed/abandon; never for off_topic (a
                                     // re-route is not a task ending) and never for a successful
                                     // delegate. `undefined` falls through to the request's reason.
  resolveHandoffMetadata?: (state: T, request: HandoffRequest)
                        => Record<string, unknown> | undefined;
                                     // OPTIONAL (2.3.0) — host fields merged into handoff_metadata.
                                     // Called for EVERY handback type INCLUDING off_topic (identity
                                     // forwarded to a call-scoped store must survive a re-route), but
                                     // never for a successful delegate. The library's own keys
                                     // (service_type, success_message) are applied LAST and win.
  forcedHandoff?: (state: T) => HandoffRequest | undefined;
                                     // OPTIONAL (2.3.0) — derive a handoff when the MODEL ended a turn
                                     // without one ("don't dead-end the caller"). Must be a PURE
                                     // function of state. See below for the re-fire trap.
  delegateInput?: (state: T, request: HandoffRequest) => Record<string, unknown>;
  clearsOnHandback?: readonly (keyof T & string)[];
                                     // OPTIONAL (2.2.0) — host DOMAIN slots to null when a
                                     // task-ENDING handback resolves (completed / abandon in
                                     // terminate mode). The library's own task-scoped slots are
                                     // cleared automatically; list only your own. Each is written
                                     // as `null`, so it must be nullable with a replace-style
                                     // reducer.
  deflectAside?: boolean | { actionDescription?: string };
                                     // OPTIONAL (2.4.0) — enable the `deflect_aside` control: one
                                     // free in-place deflection per task of an aside NO configured
                                     // agent serves, before the off_topic handback fires. The
                                     // object form's `actionDescription` replaces the LLM-facing
                                     // description of the auto-injected schema variant (the same
                                     // override `actionDescription` above provides for
                                     // request_handoff) so the host states its own classification
                                     // policy. Requires the `deflectedAside` state channel —
                                     // construction throws without it. See below.
  modelRequestSchema?: z.ZodType<HandoffRequest>;
                                     // OPTIONAL (2.5.0) — a NARROWER schema for the MODEL-FACING
                                     // request_handoff params, used both to generate the wire
                                     // schema and to parse the control at runtime — exact
                                     // reason/context route pairs become configuration instead of
                                     // prompt prose, each variant carrying its own when-to-use
                                     // description. Does NOT replace HandoffRequestSchema: the
                                     // library-managed slot and trusted executor/config effects
                                     // keep the base schema. Output must still be a HandoffRequest.
}
```

**`resolveClosingMessage`** lets the host gate the spoken closing on what actually happened: e.g. only
speak a success line for `completed` when the mutating action truly persisted, otherwise return a
neutral/failed phrasing. It runs in `createHandoffNode` for `completed` / `abandon` only; a returned
string becomes the final message `content` (and `handoff_metadata.success_message`), `undefined` falls
through to `request.context`.

**State can decide the signal and the metadata (2.3.0).** `resolveHandoffType` is resolved **before the
first control-plane event**, so the `handoff` custom event, the closing line, `handoff_type` and
`handoff_metadata.service_type` all carry one value. That ordering is the point: hosts previously
overrode the signal by mutating the resolved message's `additional_kwargs` from OUTSIDE — a shape this
library documents as a frozen channel contract — which left the event carrying the PRE-override reason.
An override can only swap `completed` ↔ `abandon`; it can never produce or erase an `off_topic`, so
delegate detection and the clearing gate below are unaffected by construction. `resolveHandoffMetadata`
is the same move for host-derived fields: they are spread FIRST and the library's keys applied last, so
a host cannot clobber the contract. No extra toggle is needed for either — omit the field for the host,
return `undefined` for one resolution; a rollout kill-switch belongs in the host function.

**A handoff can be FORCED from state (2.3.0).** `forcedHandoff` covers the turn where state already says
the task is over but the model answered in plain text. Wire `forcedHandoffRequested(state, spec)` on the
MODEL node's conditional edge ahead of `END`; `createHandoffNode` then re-derives the same request from
the same pure function (`state.handoff ?? spec.forcedHandoff?.(state)`), so predicate and resolver cannot
disagree, the graph needs no arming node, and **the forced request is never written to state** — no host
code goes near the library-managed `handoff` slot. A pending slot always wins: the guard never overrides
a handoff the model actually requested.

> **The re-fire trap.** `forcedHandoff` runs on every turn the model answers in text. If it derives its
> decision from a TERMINAL domain slot that is not listed in `clearsOnHandback`, it fires again on every
> later turn of the same call and the caller is bounced with no way out. Adopting `forcedHandoff` and
> declaring `clearsOnHandback` are one change, not two.

**Task-scoped state is cleared when the task ends (2.2.0).** The THREAD outlives the TASK: a channel
middleware reuses one thread id for a whole call and never resets it on re-dispatch, so whatever sits
in state when a handback resolves is what the NEXT task on that thread starts from. On `completed` /
`abandon` in terminate mode, `createHandoffNode` therefore nulls the library's own
`agentStepTaskScopedSlots` (`awaitingInput`, `currentFlow`, `boundedChoice`, `pagedRead`, `deflectedAside`, `errorCount`, `actionTrail`)
plus every domain slot the host named in **`clearsOnHandback`**. Two carve-outs, both correctness
invariants rather than preferences, so neither is configurable: **`off_topic` clears nothing** (a
mid-task aside must stay resumable — the caller can come straight back), and **a successful delegate
clears nothing** (the conversation never left this agent). The closing line, the signal, and any
`resolveClosingMessage` reading state are all computed before the clear, so the reply is unaffected.

Declare `clearsOnHandback` when the host graph derives anything from a terminal domain slot — a forced
handback, an escalation, a "this task already finished" branch. Left undeclared, such a slot survives
into the next task and re-fires its branch on every later turn of the same call. Slots whose reducer
MERGES cannot be cleared this way (the write is a plain `null`); reset those through the pointer slot
that selects from them.

**One free aside deflection before the handback (2.4.0).** `deflectAside` opts into the
`deflect_aside` control — a damper for the trigger-happy `off_topic` handoff on a social aside
mid-task (weather, small talk — chit-chat NO configured agent serves, where a re-route buys the
caller nothing but a lost turn). Params: `{ aside: string }` (the caller's off-task request, in the
caller's language). The CLASSIFICATION stays with the model — a topic another configured agent may
serve still goes to `request_handoff` with `off_topic`; only nobody-serves-it chit-chat is deflected
— while the POLICY is engine-owned:

- **First use per task:** no handoff. The task-scoped `deflectedAside` latch is set, every pending
  gate/flow survives untouched (the control is allowed during gate lockdown and choice-pending, like
  the handoff), and the step result instructs the model (`SystemMessages.aside_deflected`) to decline
  in ONE short sentence and repeat its pending question in the SAME turn.
- **Repeat in the same task:** the free deflection is spent — the control escalates ATOMICALLY into
  the `off_topic` handback (the same slot transition `request_handoff` performs), with the aside as
  the routing `context`. One-shot, like the bounded-choice overlay: a caller who keeps pivoting away
  still re-routes deterministically, with no window where the model must issue a second call.

Misclassification is benign in both directions: an in-scope ask wrongly deflected hands off one turn
later on persistence; chit-chat wrongly sent through `request_handoff` is exactly the pre-control
behaviour. `deflect_aside` must be the SOLE step in its batch (`deflect_must_be_sole_step`) and is a
reserved name only when enabled. The latch is task-scoped: a task-ENDING handback clears it (next
task gets its own freebie), but an `off_topic` roundtrip deliberately does NOT re-arm it. Enabling
the control makes the `deflectedAside` channel REQUIRED at construction — without it the latch write
would be silently discarded and the escalation would never fire, so `buildAgentStepTool` refuses to
construct. The host prompt must teach the split (which topics other agents serve vs. chit-chat) —
the domain-neutral default description (`DEFLECT_ASIDE_ACTION_DESCRIPTION`) can't know the fleet, so
a real deployment usually states its own policy via `deflectAside: { actionDescription }`.

Exports: `DEFLECT_ASIDE_ACTION` (`"deflect_aside"`), `DEFLECT_ASIDE_ACTION_DESCRIPTION` (the
domain-neutral default the object form overrides), plus `HANDOFF_ACTION` (`"request_handoff"`), `HANDOFF_NODE` (`"resolve_handoff"` — a node can't be named `handoff`, the state channel claims it), `HANDBACK_SIGNALS` (reason → `handoff_type` signal; identity over `off_topic` / `completed` / `abandon`), `handoffParamsSchema`, `handoffRequested(state)` (edge predicate), `forcedHandoffRequested(state, spec)` (the forced-handoff edge predicate — true when nothing is pending yet `spec.forcedHandoff` derives one), `createHandoffNode(spec)`.

Wire a conditional edge after the tool node — `createReactAgent` cannot express it, so the graph is hand-rolled: `addConditionalEdges("tools", s => handoffRequested(s) ? HANDOFF_NODE : "agent")`, `addNode(HANDOFF_NODE, createHandoffNode(spec))`, `addEdge(HANDOFF_NODE, END)`. A host using `forcedHandoff` adds one more predicate on the MODEL node's own edge — `forcedHandoffRequested(s, spec) ? HANDOFF_NODE : END` — and still no extra node. The node emits a `handoff` custom event FIRST (streaming clients abort TTS / reroute before any content), resolves the response (terminate envelope, or a delegate run over the Platform API with live `delegated_token` pass-through and a behavioral fallback to the envelope on failure), emits `handoff_complete`, and returns `{ handoff: null, ...clears, messages: [AIMessage] }` (the clears are empty unless a task-ending handback resolved — see above) — the model never paraphrases the result.

**Final-message kwargs** (the channel contract): every non-delegate resolution is a handback — `is_handoff: true`, `handoff_type` = the effective reason's signal (`off_topic` / `completed` / `abandon`, after any `resolveHandoffType`), `handoff_reason` = `context`, `handoff_metadata: { ...host fields from resolveHandoffMetadata, service_type, success_message }` — host fields first, library keys last and unclobberable. Spoken content: the `off_topic` envelope (`terminateMessage`, also the delegate-failure fallback) or the LLM-composed closing in `context` for `completed` / `abandon` (the middleware delivers it and flips routing for the NEXT request). Delegate success → NOT a handoff (conversation kept) — informational `{ delegated_to }` only. Streaming clients must request `stream_mode: ["messages-tuple", "custom"]` — the node-built final message never appears in the token stream; `handoff_complete` carries its text. Full wire details + the middleware checklist: `streaming-and-channel-contract.md`.
</handoff>

<system_messages>
## Runner-emitted system messages (`BuildAgentStepToolOptions.messages`)

The runner emits its own `summary` strings for structured refusals/errors it raises directly (not from an executor): executor crash, invalid params, unknown action, the abort outcomes, the flow gates, the lockdown/batch-shape refusals, and the confirmation/OTP/match gate outcomes. **Every runner-emitted summary is overridable** (since 1.8.0). These ship as **neutral English defaults** in `src/agent-step/messages.ts` so the library has ZERO dependency on any host project.

```ts
interface SystemMessages {
  executor_error: string;     // an executor threw / hard failure (raw cause in `_debug`)
  invalid_params: string;     // step params failed schema validation (raw detail in `_debug`)
  unknown_action: string;     // a hallucinated/typo'd action name reached the runner
  flow_already_active: string;// tried to open a flow while a different flow is active
  no_flow: string;            // a flow-scoped step ran with no flow active
  wrong_flow: string;         // a flow-scoped step ran against the wrong flow
  abort_done: string;         // abort_pending_input cleared a pending gate / active flow
  abort_nothing: string;      // abort_pending_input ran with nothing pending (no-op)
  auto_handoff: string;       // spoken when the auto-handoff threshold is hit (see <auto_handoff>)

  // Templated summaries (1.8.0) — may carry `{placeholder}` tokens the runner
  // interpolates at emit time (via `formatMessage`; unknown placeholders stay
  // verbatim so a bad override is visible, not silently blanked). Overrides
  // are plain strings, so they can live in a host's JSON locale resources.
  lockdown_confirmation: string;         // {action} {abort_action}
  lockdown_otp: string;                  // {action} {abort_action}
  lockdown_match: string;                // {action} {capturer} {abort_action}
  handoff_must_be_sole_step: string;     // {action}
  mutation_must_be_sole_step: string;    // {action}
  mutation_execute_must_be_sole: string; // {action}
  mutation_must_be_last_in_batch: string;// {action}
  confirm_proposed: string;              // {action}
  confirm_reproposed: string;            // {action}
  confirm_exhausted: string;             // {action}
  otp_not_pending: string;               // {action}
  match_not_pending: string;             // {action} {capturer}
  otp_blocked_match_pending: string;     // {action} {match_action}
  match_attempts_exhausted: string;      // {action}
  handoff_requested: string;             // {reason}
  aside_deflected: string;               // (no placeholders) the deflect_aside control accepted the
                                         // task's ONE free deflection: instructs the model to decline
                                         // the aside in one short sentence and repeat its pending
                                         // question in the SAME turn. Model-facing, not caller-audible.
  no_steps: string;                      // (no placeholders)
  auto_handoff_instruction: string;      // {message} — see <auto_handoff>
}
```

A host overrides any subset via `buildAgentStepTool({ messages })` (`Partial<SystemMessages>`, **shallow-merged** over `DEFAULT_SYSTEM_MESSAGES`). Use this for localized / voice-safe wording on a TTS or non-English agent. The library never imports host strings; the host injects them.

Exports (from `index.ts`): `DEFAULT_SYSTEM_MESSAGES`, `resolveSystemMessages(overrides?)`, type `SystemMessages`. Note these are the **runner's own** summaries only — an executor's `resultBody.summary` (the LLM-facing per-action text) is authored by the executor and is unaffected.
</system_messages>

<auto_handoff>
## Auto-handoff on repeated backend failures

A safety net so a customer is never trapped in an unrecoverable backend-error loop. The runner keeps a consecutive **backend-failure** counter in the library-managed `errorCount` slot; when it reaches a threshold the runner auto-triggers a handoff.

**What counts as a backend failure.** The runner-raised **`executor_error`** (an executor threw, uncaught) ALWAYS counts. A host adds its own executor-returned verdict `error` codes via `BuildAgentStepToolOptions.backendFailureCodes` — list ONLY true backend/network failures there (e.g. `"service_error"`). User mistakes (wrong OTP, value mismatch) and business-logic refusals are recoverable and must NOT be listed, or the counter will escalate recoverable situations. The counter resets to 0 only when a batch in which an executor **actually ran** ends without a backend failure — executed work is the only proof the backend recovered. Batches where no executor ran (confirm-gate proposals/re-proposals, prereq or param refusals, aborts, handoff signals) are **neutral**: they neither increment nor reset, so the proposal a confirm gate interleaves between two failing executes cannot wipe the streak (without this, a confirm-gated action could never reach the threshold).

```ts
// BuildAgentStepToolOptions additions
backendFailureCodes?: string[];   // host verdicts that count (executor_error always counts)
errorHandoffThreshold?: number;   // default 3
onErrorThreshold?: (update: Record<string, unknown>, state: T) => void;
                                  // host hook fired at the threshold — inject a custom
                                  // handoff signal (e.g. write a scaffold `pendingHandoff` slot)
```

**At the threshold the runner:** (1) writes the library `handoff` slot `{ reason: "abandon", context: messages.auto_handoff }` when the `handoff` opt is enabled; (2) calls `onErrorThreshold(committed, state)` if provided; (3) resets `errorCount` to 0; (4) appends a synthetic step result `{ action: "auto_handoff", ok: true, isHandoff: true, signal: "abandon", successMessage: <auto_handoff> }`, sets `body.summary` to the **`auto_handoff_instruction`** template, and clears `failed_at`.

**Who speaks the closing.** The default `auto_handoff_instruction` tells the model the turn ends here and to produce NO further answer — **the platform delivers the closing** (a `createHandoffNode` graph speaks the handoff `context`; a scaffold/middleware host speaks `success_message` from the final-message kwargs). Instructing the model to voice it too invites double-speaking. A host whose graph does NOT deliver the closing overrides `auto_handoff_instruction` and uses the `{message}` placeholder (= the `auto_handoff` closing) to have the model speak it — restoring the pre-1.8.0 behavior.

**Inert by default.** The whole mechanism is skipped unless a handoff path exists — i.e. the `handoff` opt is provided OR `onErrorThreshold` is set. A tool with neither never touches `errorCount`. Customize the spoken line via the `auto_handoff` system message and the accompanying instruction via `auto_handoff_instruction` (`<system_messages>`).
</auto_handoff>

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

The `summary` of a runner-emitted refusal/error (executor crash, invalid params, abort, flow gates) is a **host-overridable system message** — see `<system_messages>`. For the `executor_error` and `invalid_params` kinds the runner also attaches a **`_debug`** field carrying the raw technical cause (the thrown message / the Zod issue list), so the overridable `summary` can stay user-safe while the diagnostic detail is preserved for logs.

Library-injected fields on specific step kinds:
- `abort_pending_input` results carry `aborted_awaiting: { kind, for_action }` and/or `aborted_flow: "<name>"` when something was actually cleared.
- `executor_error` / `invalid_params` results carry `_debug` with the raw cause (the `summary` itself is the overridable system message).
- `issuesOtp` refused while a match gate is pending carries `error: "otp_blocked_match_pending"`.
- propose / re-propose results carry `needs_confirmation: true`, `proposed_params`, `attempts_left`, and — when the action declares `ConfirmationOpts.readBack` and it renders something — `read_back` (proposal-only; never on the executing re-call).
- exhausted results carry `error: "confirmation_attempts_exhausted"`.
- lockdown refusals carry `error: "pending_confirmation_locked" | "otp_pending_locked" | "match_pending_locked"` and `awaiting: { kind, for_action }`.
- match-mismatch results gain `attempts_left` (decremented) or `verdict: "match_attempts_exhausted"` on the last try.
- a matching confirm re-call on the proposal's own caller turn carries `error: "confirmation_same_turn_locked"` (no attempt spent; gate untouched).
- bounded-choice refusals carry `error: "bounded_choice_pending_locked" | "bounded_choice_same_turn_locked" | "bounded_choice_resume_turn_locked" | "bounded_choice_already_used" | "bounded_choice_not_pending" | "bounded_choice_turn_identity_unavailable"` per the policy in `<bounded_choice>`.
</result_envelope>

<construction_time_checks>
The runner validates the config + registries at construction. These all throw at startup before any user input — fix the misconfig before continuing:

| Error message contains | Cause |
|------------------------|-------|
| `requires \`stateSchema\`` | `stateSchema` not provided (the pre-2.0 `stateAnnotation` alias no longer exists) |
| `is a reserved action name` | You declared `abort_pending_input` in config.actions (or `request_handoff` while the `handoff` opt is provided, or a bounded-choice control name while `boundedChoices` is provided) |
| `expects a state selector at selectors["xxx"]` | `selectors` registry missing the action-name key for an action |
| `expects an executor at executors["xxx"]` | `executors` registry missing the action-name key for an action |
| `is missing a non-empty description` | An action lacks `description` |
| `verifiers["xxx"] was not provided` | A prereq referenced by some action has no verifier |
| `pageable action's paramsSchema must be a z.object` | A `pageable` action's `paramsSchema` isn't a `z.object` (the runner can't merge `page`/`pageSize` in) |
| `at least one action must be defined` | Empty `config.actions` |
| `declares startsMatchFor "X" but that consumer doesn't declare requiresMatch` | Capturer names a consumer that exists but lacks the `requiresMatch` hook (2.0.0: checked at construction, not mid-conversation) |
| `declares issuesOtp for "X" but no such action exists` | `issuesOtp.consumer_action` names a non-existent action (2.0.0) |
| `declares requiresMatch with capturer "X" but no such action exists` | `requiresMatch.capturer` names a non-existent action (2.0.0) |
| `the state schema is missing channel(s)` | Channel-completeness check (2.0.0): a library slot this configuration writes has no channel in the host schema — spread `agentStepZodShape` / `agentStepStateSpec` |
| `bounded choice "X" …` | Bounded-choice registry validation (2.0.0): empty name/description/selections, duplicate selections, unknown `directInputActions`, or `onRepeatHandoff` without the `handoff` opt |
| `abortPolicy …` | Abort-policy validation (2.5.0): non-boolean knobs, empty/duplicate/unknown action names in `allowedFollowers` / `allowedPendingTargets`, or `allowStandalone=false` with an explicitly empty follower list |
| `handoff.modelRequestSchema must be a Zod schema` | The model-facing handoff schema narrowing (2.5.0) isn't a Zod schema |

Runtime errors raised by the runner (not construction-time, but loud):

| Error message contains | Cause |
|------------------------|-------|
| `wrote library-managed slot(s) … through stateUpdate` | Executor patched `awaitingInput` / `currentFlow` / `boundedChoice` / `pagedRead` / `deflectedAside` / `handoff` / `errorCount` via `stateUpdate` — request the transition as a typed effect instead |
| `requested merge_flow_data but no flow is active` | Executor emitted `merge_flow_data` without `startsFlow` and no flow is open |
| `reported otp_issued but no flow is active` | Issuer didn't pair with `startsFlow` |
| `reported otp_issued but config lacks issuesOtp opt` | Executor returned the effect but the action's config didn't declare `issuesOtp` |
| `otp_blocked_match_pending` (step error) | An `issuesOtp` step ran while a double-entry match gate was still pending — consume the match before issuing the OTP (see `<otp_lifecycle>`) |

Slot declaration is enforced at construction since 2.0.0 (the channel-completeness row above) — a state schema missing a required library slot fails at startup instead of silently dropping writes. Spreading `agentStepZodShape` into your Zod state schema (as the bootstrap state template does) brings all eight slots in together with their reducers.
</construction_time_checks>

<key_files_to_inspect>
For ground truth, read these files in the project (don't paraphrase — they ARE the contract):

- `src/agent-step/index.ts` — the public surface (only what's re-exported here is part of the API; the module layout below is internal)
- `src/agent-step/types.ts` — the authoring contracts: `ExecutorResult`, `ExecutorEffect`, `Executor`, registries, `ActionDef`, `ControllerHooks`, `Verifier`
- `src/agent-step/state.ts` — the library-managed slot schemas (`AwaitingInputSchema`, `CurrentFlowSchema`, `BoundedChoiceSchema`, `PagedCacheSchema`, `HandoffRequestSchema`) + the spreadable fragments (`agentStepZodShape`, `agentStepStateSpec`, `agentStepInternalSlotMask`)
- `src/agent-step/runner.ts` — the thin public entry points (`buildAgentStepTool`, `runSteps`); the machinery lives in the phase modules:
  - `compile/` — `validate.ts` (every construction-time check), `plan.ts` (`BuildAgentStepToolOptions` + the compiled plan), `schema.ts` / `describe.ts` (the model-facing schema + description)
  - `run/` — `admission.ts` (the fixed-order whole-batch preconditions), `planning.ts` (confirm-mode freeze), `execution.ts` (per-step loop, effects ordering, handoff monotonicity), `finalize.ts` (result body + error-counter policy), `batch-state.ts` (the single write path into view/committed)
  - `interaction/` — one policy module per gate kind: `confirmation.ts`, `otp.ts`, `match.ts`, `flow.ts`, `bounded-choice.ts` (each states its lockdown, attempts, freshness, and clearing rules in one place; `bounded-choice.ts` also owns `resolveCallerTurnId`), plus `guard-latch.ts` (the host guard latch over that same identity)
  - `controls/` — the library-owned model-facing actions (`abort.ts`, `request-handoff.ts`, `bounded-choice.ts`, `deflect-aside.ts`, `repeat-confirmation.ts`) in an ordered `registry.ts`
  - `handoff/` — `contract.ts` (action + signals + `HandoffSpec`), `node.ts` (`createHandoffNode` — the frozen channel contract), `delegate-client.ts` (SSE/Platform-API transport)
- `src/agent-step/paginate.ts` — the read-pagination primitives + the `pageable` orchestration the runner uses (self / delegate, the cache, the envelope)
- `src/agent-step/capture.ts` — the caller-digit capture primitives (refinement-not-regex, count-free messages, group join, candidate arrays; see `<caller_digit_capture>`)
- `src/agent-step/messages.ts` — the runner's overridable system `summary` strings: `SystemMessages`, `DEFAULT_SYSTEM_MESSAGES`, `resolveSystemMessages`
- `src/agent-step/runner.test.ts` + `paginate.test.ts` + `capture.test.ts` + `handoff.test.ts` + `bounded-choice.test.ts` + `hardening.test.ts` + `guard-latch.test.ts` + `deflect-aside.test.ts` + `repeat-confirmation.test.ts` + `zod-state.test.ts` — worked examples covering every runner branch, the pagination primitives, the digit-capture primitives, the handoff machinery, the bounded-choice policy, the hardening guards, the turn-scoped guard latch, the aside-deflection control, and the stored-byte confirmation repeat; all pass on `npm test`
</key_files_to_inspect>
