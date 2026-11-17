# Reference: agent-step Library API

<overview>
This is the runner contract the new tool consumes. The library lives at `src/agent-step/` and is **treated as immutable**: never modify it; only call `buildAgentStepTool({...})` with the right shape. The summary below is the canonical contract — match it exactly. The ground truth is in `src/agent-step/types.ts` (authoring contracts) + `src/agent-step/index.ts` (the public surface); if this doc disagrees with those, the source wins.

Since 2.0.0 the library is laid out as phase modules — `compile/` (validate → normalize → model-facing schema/description/contract composers), `run/` (admission → planning → execution → finalize), `interaction/` (one policy module per gate kind), `controls/` (the library-owned model-facing actions), `handoff/` (contract + graph node + delegate transport). **Hosts import ONLY from `src/agent-step/index.js`** — the module layout is internal and free to move; everything a tool consumes is re-exported at the index.

Since 3.0.0 the authoring model is **declarative**: every executor outcome is a declared verdict row (`ActionDef.verdicts`), executors return the row's code plus dynamic data (`DeclaredExecutorResult`), and the engine composes the wire body, the action descriptions, the gate reply contracts, and the protocol prompt fragment from the declarations. The model-facing English the engine composes is measured surface — hosts pin it in goldens; a library upgrade that moves a composed byte owes a re-measurement.
</overview>

<runner_signature>
```ts
import { buildAgentStepTool } from "../../agent-step/index.js";

export const myTool = buildAgentStepTool({
  config: myConfig,                // AgentStepConfig<ActionName, PrereqName, State>
  stateSchema: AgentStateSchema,   // StateSchemaLike — the host's graph state schema
  selectors,                       // SelectorRegistry<T, ActionName> — one per action
  executors,                       // ExecutorRegistry<T, typeof selectors>
  verifiers,                       // VerifierRegistry<T>
  handoff: handoffSpec,            // OPTIONAL — opt into the built-in request_handoff (see <handoff>)
  ladders: { ... },                // OPTIONAL (3.0.0) — engine-owned escalation ladders behind the
                                   // note_refusal control; also the escalation target for
                                   // captureBounces. Requires `handoff` (see <ladders>)
  abortPolicy: { ... },            // OPTIONAL (2.5.0) — narrow the built-in abort control to an
                                   // engine-enforced in-domain transition; omit for the legacy
                                   // permissive behaviour (see <conventions> §3)
  getCallerTurnId: (state) => id,  // OPTIONAL — stable caller-turn identity resolver (see <caller_turn_identity>)
  messages: { ... },               // OPTIONAL — override the runner's own system summary strings (see <system_messages>)
  backendFailureCodes: [...],      // OPTIONAL — extra failure codes for the auto-handoff counter;
                                   // rows with `backendFailure: true` are derived automatically (see <auto_handoff>)
});
```

`stateSchema` is **required**: `StateSchemaLike = LangGraphAnnotationLike | z.ZodObject` — it accepts **either** a LangGraph `Annotation.Root` **or** a Zod object schema whose fields carry reducer/default metadata via `withLangGraph` (`@langchain/langgraph/zod`). Both resolve to the same channel classes (`BinaryOperatorAggregate` / `LastValue`), so the runner derives the intra-batch merger uniformly. The bootstrap scaffold defines graph state **once** as a Zod schema (`AgentStateSchema` in `state.ts`) and passes it here — a single source of truth for reducers AND invoke validation, no Annotation/Zod drift.

`selectors` and `executors` are both **keyed 1:1 by the exact action name** (snake_case). Build `selectors` with `satisfies SelectorRegistry<State, ActionName>` (not a type annotation) so each selector's precise return type is preserved into `typeof selectors`; `executors` is then `ExecutorRegistry<State, typeof selectors>`, which types each executor's `state` param from its selector's return — a mismatch is a compile error here, at the construction boundary. See `<conventions>` §1.

Returns a LangChain `StructuredTool` ready to register in `src/tools/index.ts`.
</runner_signature>

<types>
## AgentStepConfig

```ts
interface AgentStepConfig<ActionName extends string, PrereqName extends string, T = unknown> {
  tool: { name: string; description: string };
  actions: Record<ActionName, ActionDef<PrereqName, T>>;
}
```

`tool.name` becomes the LangChain tool name surfaced to the LLM (e.g. `"card_agent_step"`, `"accounts_agent_step"`).

`tool.description` is the lead paragraph — ONE semantic sentence; the library appends a per-action bullet list automatically, and the mechanics (batching, result shape, gate handshake) are engine-composed elsewhere (see `<composed_surface>`).

The third type param `T` is the host state — it types each row's static `stateUpdate` (`VerdictDef<T>`), so a typo'd slot fails compilation instead of silently dropping at the patch merger.

There is **no top-level `mutations` map**. All per-action behavioural opts (confirmation / OTP / match / flow lifecycle, batch-shape flags) live inline on each action under `ActionDef.controller`. Downstream-slot invalidation lives inline under `ActionDef.invalidatesOnChange`.

## ActionDef

```ts
interface ActionDef<PrereqName extends string, T = unknown> {
  description: string;             // non-empty; the SEMANTIC LEAD only — the engine composes the
                                   // final model-facing description (gate marker first, then this).
                                   // Never restate the gate handshake or enumerate verdicts here.
  summary?: string;                // optional one-line label for the tool-level action index. Add one
                                   // when the action NAME isn't self-explanatory to the model. Omit it
                                   // and the index just lists the action name alone.
  paramsSchema: z.ZodTypeAny;      // params the LLM must send
  prereqs: PrereqName[];           // state predicates checked before invoking executor
  verdicts?: Record<string, VerdictDef<T>>;
                                   // (3.0.0) declared verdict rows — the executor's RESULT SPACE.
                                   // Row keys are LOOKUP codes the executor names in its return;
                                   // an undeclared verdict fails loudly. See <declared_verdicts>.
  asks?: Record<string, DictationAsk>;
                                   // (3.0.0) standing asks keyed by verdict-or-error code — when the
                                   // batch's FINAL entry carries a listed code, the engine records the
                                   // mapped ask as the `dictation` awaiting state. See <standing_asks>.
  captureBounces?: CaptureBouncePolicy;
                                   // (3.0.0) bound consecutive `invalid_params` bounces; escalate
                                   // through a configured ladder when spent. See <ladders>.
  invalidatesOnChange?: Record<string, string[]>;
                                   // keys are slots this action may write; values are downstream
                                   // slots to reset to null when the watched slot's value CHANGES
                                   // (non-null → different value). First-time set / same-value
                                   // writes do NOT fire. See <invalidates_on_change>.
  pageable?: PageableSpec;         // opt a LIST read into uniform pagination. See <pagination>.
  controller?: ControllerHooks;    // lifecycle hooks coordinated by the runner (confirmation /
                                   // OTP / match / flow / batch-isolation). Omit for plain reads.
}
```

## VerdictDef + DeclaredExecutorResult (3.0.0) {#declared_verdicts}

<declared_verdicts>
One declared row per verdict code. The row is the ONE authority for the five things that used to be
hand-kept consistent across executors, shared constants, and wiring lists (and measurably forked):
the batch-continuation flag, the summary, the model-facing doctrine, the static state write, and the
effects.

```ts
interface VerdictDef<T = unknown> {
  ok: boolean;                     // batch-continuation flag (StepResult.ok) for this verdict
  summary: string | ((state: unknown, data: Record<string, unknown>) => string);
                                   // the body `summary` — static, or a renderer over the CURRENT
                                   // state view (language-keyed catalogs; the readBack division)
                                   // plus the executor's `data` (interpolated summaries)
  body?: Record<string, unknown | ((data: Record<string, unknown>) => unknown)>;
                                   // the remaining body fields, composed IN DECLARATION ORDER after
                                   // `summary` (declaration order IS wire order — a converted action
                                   // reproduces its historical body bytes exactly). A function value
                                   // receives the executor's `data`.
  stateUpdate?: Partial<T>;        // static host-state patch for this verdict — typed against T.
                                   // The executor's dynamic stateUpdate wins on key conflicts.
  effects?: ExecutorEffect[];      // effects applied for this verdict, AHEAD of any executor-supplied
                                   // ones — e.g. the terminal handoff that must never fork from the
                                   // outcome written in stateUpdate.
  backendFailure?: boolean;        // marks this row's `body.error` code as a backend failure for the
                                   // auto-handoff counter (derives backendFailureCodes). Requires
                                   // body.error to be a STATIC string (validated at construction).
}

interface DeclaredExecutorResult<T> {
  verdict: string;                 // names the declared row (unknown → loud `executor_error`)
  data?: Record<string, unknown>;  // dynamic values the row's function fields read
  stateUpdate?: Partial<T>;        // dynamic host-slot patch (merges OVER the row's static one)
  effects?: ExecutorEffect[];      // appended AFTER the row's effects
  resultExtras?: Record<string, unknown>;
                                   // raw fields appended to the body AFTER the declared fields
                                   // (e.g. a pageable action's `items`)
}
```

**Authoring rule:** STATIC doctrine strings live on the row (one authority); only genuinely
branch-dependent values — diagnostics, a miss reason chosen at the decision site, an interpolated
label — ride the executor's `data`. Several row keys may share one wire `verdict` (via `body.verdict`)
when their summaries differ. A terminal verdict declares its `request_handoff` effect ON THE ROW, so
the handoff can never fork from the outcome `stateUpdate` writes.

The shared-module row pattern: a deterministic continuation (a step whose result space another action
owns) declares its rows on the ACTION whose result space it shares, keeping one vocabulary.

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
  requiresMatch?: { capturer: string; maxAttempts?: number };
}

interface ConfirmationOpts {
  maxAttempts?: number;            // re-propose budget before the gate exhausts. Default 3.
  lockdown?: boolean;              // default true — refuses unrelated batches while pending.
  readBack?: (params: Record<string, unknown>, state: unknown) => string | undefined;
                                   // (2.3.0) render what the runner ACTUALLY recorded, for the model
                                   // to speak back verbatim. Rides the proposal as `read_back`.
  readBackDirective?: (params: Record<string, unknown>, state: unknown) => string | undefined;
                                   // (3.0.0) how the model must FRAME the rendered read_back — what,
                                   // if anything, may precede or follow the verbatim bytes ("this is
                                   // the capture: append one short confirm question"; "this recap is
                                   // complete: add nothing"). Called only when readBack rendered
                                   // non-empty; a non-empty return rides the proposal as
                                   // `read_back_directive`. Model-facing English, never caller-audible.
  repeatReadBack?: boolean;        // (2.5.0) persist the readBack rendering on the gate and inject the
                                   // sole-step `repeat_pending_question` control, which returns those
                                   // EXACT stored bytes on a later caller turn. Default false.
                                   // (3.0.0) REQUIRES replyContract — validated at construction: a
                                   // repeatable gate routes re-asks through the repeat control, which
                                   // the generic reply contract forbids ("make no call").
  replyContract?: GateContractSpec;// (3.0.0) replace the runner's generic `reply_contract` on THIS
                                   // action's proposals with an engine-COMPOSED action-specific one.
                                   // See <gate_contracts>.
  refuseProposal?: (params: Record<string, unknown>, state: unknown)
    => ({ summary: string; error: string } & Record<string, unknown>) | null | undefined;
                                   // (2.5.0) propose-time, STATE-aware refusal. Runs on the
                                   // propose/re-propose path AFTER params parse and BEFORE anything
                                   // commits: no gate stored, no attempt spent. Return a result body
                                   // to refuse; null/undefined to proceed.
}
```

**`readBack`** exists because the library owns the CAPTURE half — `capture.ts` sanitized, joined and
validated those params — so it alone knows the exact stored value. Handing the model raw
`proposed_params` and leaving "tell the caller what was recorded" to its discretion is measurably where
read-backs break. The library does NOT own the LEXICON, so the host supplies this function; it receives
the **parsed** params and the current state view (deliberately non-generic — hosts cast their own state
exactly as executors do with their slices). The protocol prompt fragment (`<composed_surface>`) carries
the READ-BACK authority rule, so no per-host prompt rule is needed any more.

**`repeatReadBack`** persists the rendering on the gate; the sole-step `repeat_pending_question` control
(reserved only when at least one action opts in) returns the stored bytes verbatim — no executor run, no
re-render from mutable state, no params/attempts change, and the gate is not consumed. Repetition
advances the gate's presentation-turn provenance — the repeated recap becomes the question the caller
must answer on a LATER turn.

**`refuseProposal`** fills the lifecycle gap between the params schema (shape, no state access) and the
executor (state, but runs only AFTER consent): a schema-valid, state-impossible proposal is answered
immediately, storing nothing and burning nothing. Keep it a pure function of (params, state) and mirror
the executor's own consumption rule so the two can never disagree.

There is deliberately **no TTL**: the runner times nothing out. Stale gates clear via `abort_pending_input` or via backend signals the executor surfaces as `clear_awaiting_input` / `abort_flow` effects.

The executor owns any pre-read and post-read; the library enforces the gates above plus the propose-then-execute handshake (see `<confirmation_lifecycle>`).

## GateContractSpec (3.0.0) {#gate_contracts}

<gate_contracts>
The declarative form of `ConfirmationOpts.replyContract`. The reply contract riding a proposal is the
COMPLETE classification of the caller's next reply while the gate pends; for mutations whose gate
outranks the generic yes/correction taxonomy (a permanent closure seeing third-party speech,
re-selection, clarification-with-repeat), the host declares only what the engine cannot know, and
`composeGateContract` (exported) writes the frame clauses the engine enforces — the lead, the
exact-params yes clause (sole-step when the action declares `soleOnExecute`), and the closing
never-re-call guard — AROUND the host's categories. Composed at construction; the action name and
sole-step rule come from the action itself (`GateContractContext`), never the spec, so the contract
cannot fork from the gate it governs.

```ts
interface GateContractSpec {
  subject: string;         // the pending question as the lead clause names it
                           // (e.g. "this permanent-closure consent question")
  subjectNoun: string;     // its short noun phrase, cited by the yes clause and the closing guard
                           // (e.g. "consent question")
  executesLabel: string;   // what the execute re-call performs (e.g. "the permanent closure")
  categories: readonly string[];
                           // the host's measured reply categories, joined verbatim in order between
                           // the yes clause and the closing guard. Complete sentences, host bytes.
}
```

Empty/omitted keeps the runner's generic template (`SystemMessages.confirm_reply_contract`). A
non-empty spec is the SOLE authority for that action — the generic template is not concatenated, so
declare every reply class you want handled, including the generic yes/correction ones (the frame's yes
clause covers the yes).

## Verifier

```ts
interface Verifier<T> {
  check: (state: T) => boolean;
  denial: { summary: string; error: string };
}
```

Self-contained: the predicate AND the denial body live together in one file. The denial body is what appears in the result envelope when the prereq fails.

The `check` predicate is a snapshot of **journey progress** — "is the user identified?", "is an entity selected?" — not a record of step ordering. Gate on *where the user is*, never on *what ran first*. The companion mechanism for keeping that progress coherent when an upstream slot changes is `invalidatesOnChange` (see `<invalidates_on_change>` below).

## ExecutorEffect

```ts
type ExecutorEffect =
  | { type: "request_handoff"; request: HandoffRequest }
                                   // terminal business outcome: atomically clears every transient
                                   // runner slot (awaitingInput, currentFlow, pagedRead) and writes
                                   // the `handoff` slot — exactly like the built-in request_handoff
                                   // action. Honoured regardless of `ok` (a refusal verdict may still
                                   // be terminal). TERMINAL IS ENFORCED: once the handoff is set, the
                                   // step's remaining interaction lifecycle is skipped and the batch
                                   // ends after the current step (handoff monotonicity). The ONLY way
                                   // an executor (or verdict row) requests a handoff. Declare it on
                                   // the terminal verdict's ROW so it can never fork from the outcome.
  | { type: "merge_flow_data"; data: Record<string, unknown> }
                                   // shallow-merge into currentFlow.data. Honoured on ok:true;
                                   // requesting it with no active flow (and no startsFlow on the
                                   // action) is a programmer mistake and throws.
  | { type: "otp_issued" }         // this step minted an SCA challenge; the runner opens the OTP
                                   // gate for the consumer named in the action's issuesOtp hook.
  | { type: "clear_awaiting_input" }
                                   // drop the pending input gate only, keep the flow (e.g. OTP timeout).
  | { type: "abort_flow" };        // terminal in-flow failure; drop the gate AND the flow.
```

Effects are **signals, not an ordered program** — the runner honours each one at a fixed, documented point of the step lifecycle (see `<state_threading>` step 5f). Row effects apply ahead of executor effects.

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
// state. Returns a DeclaredExecutorResult<T> naming a declared verdict row;
// its stateUpdate may patch any HOST-OWNED slot (the reducers merge them);
// library-managed slots are rejected loudly — request those transitions via
// `effects` (usually on the row).
type Executor<Slice, T> = (params: unknown, state: Slice) => Promise<DeclaredExecutorResult<T>>;

// Keyed 1:1 by action name. Each entry's `state` param is derived from that
// action's selector return (ReturnType<Selectors[K]>), so an executor whose
// signature doesn't match what its selector produces is a compile error.
type ExecutorRegistry<T, Selectors extends Record<string, Selector<T>>> = {
  [K in keyof Selectors]: Executor<ReturnType<Selectors[K]>, T>;
};
```

(The pre-3.0 `ExecutorResult` return shape — `{ resultBody, ok, stateUpdate?, effects? }` — was
**removed from the public contract** in 3.0.0: rows ARE the result space. The type survives only as the
runner's internal normalization target and is no longer exported.)

## AwaitingInput (library-managed)

The runner's cursor for "what input does the customer owe right now". Discriminated union over the four kinds — three locking GATES plus one non-locking ASK:

```ts
type AwaitingInput =
  | { kind: "dictation";    for_action: string; param: string;
      expects: "digits" | "text"; flow_ref?: string }
                                              // (3.0.0) the STANDING ASK — a verdict asked the caller
                                              // for a fresh value (ActionDef.asks). A record, not a
                                              // gate: it does NOT lock the surface. See <standing_asks>.
  | { kind: "confirmation"; for_action: string; params: object;
      attempts_left: number; max_attempts: number; flow_ref?: string;
      proposed_on_caller_turn_id?: string;    // the caller turn the proposal was stored on (or last
                                              // REPEATED on — the repeat control advances it); a
                                              // matching re-call on the SAME turn is refused.
      read_back?: string }                    // exact caller-audible rendering, persisted only when the
                                              // owning action sets repeatReadBack;
                                              // repeat_pending_question returns these stored bytes.
  | { kind: "otp";          for_action: string; flow_ref: string }
  | { kind: "match";        for_action: string;
      attempts_left: number; max_attempts: number; flow_ref?: string };
```

Lockdown semantics for the three GATES (first step of the next batch must satisfy this):

| kind | allowed first step | else |
|------|-------------------|------|
| `confirmation` | `for_action` (resolves to execute/re-propose/exhausted) or `abort_pending_input` | `pending_confirmation_locked` |
| `otp` | `for_action`, a **same-flow issuer** (an action whose `issuesOtp.consumer_action` is this gate's `for_action` AND whose `requiresFlow` equals this gate's `flow_ref` — re-send replaces the gate with a fresh one), or `abort_pending_input` | `otp_pending_locked` |
| `match` | `for_action`, the **capturer** (re-capture resets), or `abort_pending_input` | `match_pending_locked` |

A `dictation` never locks anything — the caller may pivot; the record exists so results can tell the model what is owed. The library does NOT TTL any slot. Stale gates clear via `abort_pending_input` or via backend signals (surfaced by the executor as `clear_awaiting_input` / `abort_flow` effects).

## CurrentFlow (library-managed)

Single active flow at a time (flow mutex). Set on `startsFlow` ok; cleared on `endsFlow` ok or an `abort_flow` effect:

```ts
interface CurrentFlow {
  name: string;
  data: Record<string, unknown>;   // scratch bag; executors merge via the merge_flow_data effect
}
```

Starting a different flow while another is active fails with `error: "flow_already_active"`. Re-entering the SAME flow is idempotent — the executor runs (e.g. to re-issue an OTP), and its `merge_flow_data` effect shallow-merges into the existing `currentFlow.data` (no reset).

## spentLadders (library-managed) — 3.0.0

Per-ladder free-use counts: `Record<string, number> | null`, ladder name → uses so far. Carries every
once-latch — the configured `note_refusal` ladders AND the per-action capture-bounce counters (under
the reserved key shape `"capture:<action>"`). When a ladder's count reaches its configured
`maxFreeUses` (or a capture policy's `max`), the next use escalates atomically into the configured
handoff. Task-scoped: a task-ending handback clears it; an `off_topic` roundtrip does not — a spent
explanation stays spent when the same task resumes. The runner is the only writer.

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

The host gets the six library slots (`awaitingInput` / `currentFlow` / `pagedRead` / `spentLadders` / `handoff` / `errorCount`) by spreading the library's `agentStepZodShape` into its Zod state schema — the bootstrap state template does this. Each slot is wrapped with `withLangGraph` so it carries the runner's expected last-writer-wins reducer/default as channel metadata. The per-slot schemas (`AwaitingInputSchema`, `CurrentFlowSchema`, `PagedCacheSchema`, `HandoffRequestSchema`) are individually exported from `index.ts` too. (A host still on a LangGraph `Annotation.Root` spreads the equivalent `agentStepStateSpec` fragment instead.) `buildAgentStepTool` **verifies channel completeness at construction**: a state schema missing a channel for any library slot the configuration writes throws (the message names the missing slots and the spreadable fragments).

Since 3.0.0 the slot metadata lives in ONE table — **`AGENT_STEP_SLOT_META`** (exported) — from which
the derived views are computed and key-locked at compile time:

- **`agentStepTaskScopedSlots`** — the subset describing work IN PROGRESS (`awaitingInput`, `currentFlow`, `pagedRead`, `spentLadders`, `errorCount`), which `createHandoffNode` nulls when a task-ENDING handback resolves. `handoff` is deliberately absent: the node returns it as null either way.
- **`agentStepRunnerOwnedSlots`** — the slots an executor `stateUpdate` may not write (currently all six; the flag exists because history proved the exception class).
- **`agentStepInternalSlotMask`** — a Zod `.omit()` mask of the six library-managed slot keys. A host derives a graph INPUT schema by omitting these (runner-written only, never caller input): `AgentStateSchema.omit({ ...agentStepInternalSlotMask, /* + host-derived slots */ }).partial().extend({ messages: MessagesZodState.shape.messages })`. Re-attach `messages` after `.partial()` — `.partial()` strips the messages-channel metadata LangGraph Studio keys off to render its chat input box (see `state-and-prompt-integration.md`).

## HandoffRequest (library-managed)

The pending channel-handoff request, written by the built-in `request_handoff` action (only available when the tool opted in via `BuildAgentStepToolOptions.handoff`), by a `request_handoff` **effect** (on a verdict row or an executor return), or by the engine itself (ladder exhaustion, auto-handoff) — never through `stateUpdate`, which throws. Resolved — then cleared — by the host graph's `createHandoffNode(spec)` node. `null` otherwise; rides `agentStepZodShape` like the other slots. Once set, handoff is **monotonic**: the step's remaining interaction lifecycle is skipped and the batch ends after the current step. See `<handoff>`.

```ts
interface HandoffRequest {
  reason: "off_topic" | "completed" | "abandon";
  context: string;  // per-reason, never empty, always in the customer's language:
                    // off_topic → the customer's request (verbatim or tightly summarized);
                    // completed / abandon → the closing line the node speaks
}
```

## errorCount (library-managed)

The consecutive backend-failure counter for the auto-handoff guard (`<auto_handoff>`). `number | null`; rides `agentStepZodShape` like the other slots. The runner increments it when a batch ends in a backend failure, resets it to 0 when a batch in which an executor **actually ran** ends without one, and clears it to 0 when it auto-triggers a handoff at the threshold. Batches where no executor ran (confirm-gate proposals/re-proposals, prereq or param refusals, aborts, handoff signals) are **neutral** — they neither increment nor reset. Executors must never write it.

</types>

<composed_surface>
## The engine-composed model surface (3.0.0)

Three composers turn the declarations into the model-facing English, so no host hand-rolls (and forks)
the machinery text. All three are **measured surface**: hosts pin the output in a model-surface golden,
and an upstream change to composed bytes owes a live re-measurement.

**Action descriptions** (`compile/action-describe.ts`, applied automatically): each schema variant's
`.describe()` bytes are `<gate marker> <host semantic lead>` — the marker (derived from the controller:
gate presence, `read_back` presence, the sole-on-execute rule, the invalid_params recoverability note)
comes FIRST, then `ActionDef.description` verbatim. There is deliberately NO verdict index — a result
that explains itself does not need a preview in the schema (the enumerated index was measured as 34% of
the domain-action bytes while duplicating what results already carry). Hosts therefore write
descriptions as the semantic lead ONLY.

**Gate reply contracts** (`compile/gate-contract.ts`): see `<gate_contracts>` above. Composed at
construction from `ConfirmationOpts.replyContract`; rides proposals as `reply_contract`.

**The protocol prompt fragment** (`compile/protocol.ts`, exported as `composeProtocolPrompt`): the
system-prompt text that interprets the engine's own machinery — tool-turn vs speaking-turn, the
reply/ask contracts, the gate handshake, READ-BACK authority, handoff silence — composed from the
host's feature surface. Hosts splice it into their system prompt via a placeholder and write NONE of
it themselves:

```ts
const PROTOCOL_FRAGMENT = composeProtocolPrompt({
  config: myConfig,               // tool name + actions (asks/gate presence read from it)
  ladders: myLadders,             // omit if none
  handoff: handoffSpec,           // omit if none
  toolTurnRules: [ /* host DOMAIN tool-turn clauses — e.g. the digit-capture hard rule.
                      Spliced as the FIRST lettered clauses of the TOOL TURN bullet — the
                      measured position; detached placement measured 0/4. */ ],
});
// prompt template carries "{PROTOCOL}"; splice PROTOCOL_FRAGMENT there.
```

`ProtocolSurface` is deliberately narrow (config + registries + handoff presence) so an env-free prompt
module can call it with exactly what it already exports. Sentence ownership is exclusive (one
authority): the tool DESCRIPTION keeps its per-action/control one-liners, RESULT BODIES keep the
per-turn contracts/directives/asks, and the fragment keeps the turn/speech protocol.
</composed_surface>

<standing_asks>
## Standing asks / dictation (3.0.0)

The plainest input kind — "the customer owes a fresh value" — declared per verdict via
`ActionDef.asks`, applied by the batch finalizer, and made visible to the model on the final entry.
Unlike the three gates it does NOT lock the surface: it is the engine's record of the standing
question; capturing the answer remains the MODEL's job (deterministic caller-turn interception was
built, measured live, and removed — the engine must never fabricate assistant turns).

```ts
interface DictationAsk {
  action: string;                  // target action the customer's value feeds (must exist)
  param: string;                   // the target's param carrying the capture (must be declared on it)
  expects: "digits" | "text";      // what was asked for (descriptive; kind-specific behavior keys on it)
  render?: (state: unknown) => string | undefined;
                                   // render the caller-audible ask ITSELF (language/lexicon live in
                                   // state — the readBack division). A non-empty return rides the
                                   // final entry as `ask_text`, and the ask contract directs the model
                                   // to speak it EXACTLY — engine-rendered bytes are how fixed
                                   // sentences stay verbatim (a model reciting a catalog line from
                                   // prompt memory measurably decorates it; measured 2/8 prompt-side
                                   // vs 8/8 on the wire). Omit for asks whose wording the model may own.
}
```

Lifecycle — the batch's FINAL entry decides (`ok:false` short-circuits, so the last entry is exactly
what the model relays):

- Final entry's verdict-or-error code is listed in the acting action's `asks` → the mapped ask becomes
  `awaitingInput = { kind: "dictation", for_action, param, expects }`, and the entry is stamped with
  `standing_ask: { action, param }`, `ask_contract` (the `standing_ask_contract` system message), and
  `ask_text` when `render` returned bytes.
- Final entry from the SAME action with an unlisted code → a dictation standing for that action was
  serviced; it clears. A dictation for a DIFFERENT action stands (the caller still owes the value).
- A live GATE always outranks an ask: a confirmation/OTP/match set or left standing by the batch IS
  the standing question; asks never stomp it. Skipped entirely on a handoff.

Keys are verdict-or-error codes as the wire carries them (`resultBody.verdict`, else the entry's
`error`) — runner-raised codes like `invalid_params` are legal keys, which is how "every recoverable
digit miss re-asks digits for this action" is declared once.
</standing_asks>

<ladders>
## Escalation ladders + note_refusal + captureBounces (3.0.0)

Engine-owned "once" counters. The prompt's once-rules — explain a refusal once, deflect an aside once,
suggest the lookup once — used to make the model count from conversation history; they become
configured ladders whose state lives in the task-scoped `spentLadders` latch. The model keeps only the
semantic classification; the engine owns first-versus-repeat.

```ts
// BuildAgentStepToolOptions.ladders: LadderRegistry — requires `handoff`.
type LadderRegistry = Record<string, EscalationLadder>;

interface EscalationLadder {
  description: string;             // one-line semantic condition, shown in the control's schema index
  instruction: string;             // model-facing instruction returned on a FREE use (rides the
                                   // result as its summary — e.g. "decline in ONE short sentence and
                                   // re-ask your pending question in the SAME turn")
  onExhaust: HandoffRequest;       // the handoff applied ATOMICALLY when the free uses are spent.
                                   // Validated against the LIBRARY schema, not the host's
                                   // modelRequestSchema — an escalation route is engine-only by
                                   // design (remove it from the model-requestable routes and the
                                   // engine holds the only path to it).
  maxFreeUses?: number;            // free in-place uses before escalation. Default 1.
}
```

A non-empty registry injects the sole-step **`note_refusal`** control (`NOTE_REFUSAL_ACTION`; the name
becomes reserved). Params: `{ ladder: <configured name> }` (a Zod enum over the registry). The control:

- **Free use:** counts the latch (`spentLadders[name]++`), touches nothing else — every pending
  gate/flow survives — and returns the ladder's `instruction` as the summary (`refusal_noted: true`).
  The standing ask/gate the caller stepped away from is exactly what the model must return to.
- **Uses spent:** escalates ATOMICALLY into `onExhaust` (the same slot transition `request_handoff`
  performs) — no window where the model must issue a second call, and no model-selectable route. The
  result carries `ladder_exhausted: true, handoff_requested: true`.
- A refusal while a gate/choice pends is classified by THAT interaction's reply contract, never by the
  ladder (`allowedDuringGateLockdown: false`).

The host prompt teaches only the semantic classification (declined/unavailable vs a question your
instructions answer vs a cancellation); the control's composed description carries the ladder index.

**`ActionDef.captureBounces`** rides the same latch: `{ max, ladder }` counts CONSECUTIVE
`invalid_params` bounces of that action under `spentLadders["capture:<action>"]`, cleared by any parse
that succeeds; when the count reaches `max`, the bounce escalates through the named ladder (which must
exist in the registry — validated at construction). `max: 2` is the measured knob — the model
improvises past ~3 identical bounces, and the escalation must fire before that.
</ladders>

<conventions>
## 1. Selector + executor keyed by the exact action name

Selectors and executors are registered **1:1 under the exact action name** (snake_case). There is NO name transformation — the registry key IS the action name.

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

The runner throws at construction if either registry is missing an action's entry:

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

`abort_pending_input` is ALWAYS reserved — the library auto-injects it into the tool schema whenever ANY action declares one of: `requiresConfirmation`, `requiresOtp`, `issuesOtp`, `startsFlow`, `endsFlow`, `requiresFlow`, `requiresMatch`, `startsMatchFor`. `request_handoff` is reserved ONLY when `BuildAgentStepToolOptions.handoff` is provided (see `<handoff>`) — a tool that does NOT opt in may define its own action under that name (the orchestrator/scaffold handoff mechanism does exactly that). `note_refusal` (3.0.0) is reserved ONLY when `ladders` is non-empty (see `<ladders>`) — sole-step (`note_refusal_must_be_sole_step`: the turn answers a refusal, not a value; on the exhausted path the step escalates into a handoff, which abandons the turn). `repeat_pending_question` (renamed from `repeat_pending_confirmation` in 3.0.0) is reserved ONLY when at least one action sets `ConfirmationOpts.repeatReadBack` — sole-step (`repeat_confirmation_must_be_sole_step`: a recap is a read-only turn boundary; domain work in the same batch could turn the caller's clarification into consent; the group name keeps the historical "confirmation" vocabulary deliberately — byte-pinned engine codes). These library-owned actions are **controls** (`controls/` in the library): each carries its own activation, schema variant, description line, lockdown allowances, and execution — the run pipeline dispatches them instead of an executor. Declaring a reserved name throws:

```
agent-step: "<name>" is a reserved action name auto-injected by the library; remove it from config.actions.
```

`abort_pending_input` is idempotent — it clears `awaitingInput` AND `currentFlow` together. No-op when nothing is active.

**`abortPolicy`** (2.5.0, optional) narrows abort from that permissive default into an engine-enforced
in-domain transition. Omit it and the legacy behaviour is preserved byte-for-byte. When configured:

```ts
interface AbortPolicy<ActionName extends string> {
  requireActive?: boolean;                      // refuse abort when no gate or flow is active.
                                                // Default false.
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

## 4. Per-action description is required — and is the semantic lead ONLY

A non-empty `description` string is required on every action (empty/missing throws). Since 3.0.0 the
engine composes the final model-facing description (`<composed_surface>`): write the business
semantics, the param meanings, and what `ok` changes; never the gate handshake or a verdict
enumeration — those bytes are engine-owned and restating them duplicates them on the wire.

## 5. Controller hooks live on the action

Lifecycle opts are declared inline as `ActionDef.controller`, so there is no separate map that can drift from `actions`. A controller-referenced peer action (e.g. an `issuesOtp.consumer_action` or a `requiresMatch.capturer`) must still name a real action, or the corresponding check throws (see `<construction_time_checks>`).

## 6. Tool layout: declaration beside executor

Row-based actions declare beside their executors — `src/tools/<name>/actions/<action>/action.ts`
(schema + description + rows + asks + controller), with `config.ts` a slim assembler and `names.ts` a
types-only leaf (`ActionName`/`PrereqName`) so the declaration ↔ config import graph stays acyclic.
See `tool-directory-layout.md`.
</conventions>

<state_threading>
## How state flows through a batch

When the LLM calls the tool with `[step1, step2, step3]`:

1. Runner reads the FULL state via `getCurrentTaskInput<T>()` — this is the snapshot at batch start (NOT a live view, important for same-batch-bypass safety).
2. Merger is built from the state schema passed as `stateSchema` (a Zod object whose fields carry reducer metadata via `withLangGraph`, OR a LangGraph `Annotation.Root`). Each field's reducer is extracted from its channel's `BinaryOperatorAggregate.operator`; a Zod schema's channels are resolved through the langgraph zod registry to the same channel classes. The `messages` field is explicitly skipped (the runner emits its own `ToolMessage` at the end). When any confirm gate is configured, the runner also resolves the **caller-turn identity** here (`getCallerTurnId`, defaulting to the latest human message id — see `<caller_turn_identity>`).
3. **Admission** (`run/admission.ts`) — every whole-batch precondition, in a FIXED order, each able to refuse the batch (a single result entry, `failed_at: 0`, nothing committed):
   a. **Unknown action** — hallucinated/typo'd names get a structured refusal.
   b. **Gate lockdown** — a pending confirmation/OTP/match admits only its target action / abort / handoff / the repeat control (+ the capturer, for match; + a same-flow issuer, for otp; see lockdown table above).
   c. **Flow mutex** — first step `startsFlow=X` while `currentFlow.name=Y` (≠X) → refuse `flow_already_active`.
   d. **Control exclusivity** — sole-step control families (handoff, repeat, ladder), in registry-group order.
   e. **Abort policy** — the optional host source/follower allow-lists.
   f. **soleStep / soleOnExecute** — per-action batch-shape refusal (computed off batch-start pending so the LLM-natural `[verify, mutate]` batch can propose).
4. **Plan expansion** (`run/planning.ts`) — tag each user step with its confirmation mode (`propose` | `rePropose` | `execute` | `sameTurnLocked` | `exhausted`) based on pending state at batch-start. Frozen before any executor runs (same-batch-bypass safety). Planning is **abort-aware**: confirm steps AFTER an `abort_pending_input` in the same batch plan against NO pending — they propose fresh instead of executing against the gate the batch just cleared.
5. For each planned step (`run/execution.ts`):
   a. Control steps (`abort_pending_input`, `request_handoff`, `repeat_pending_question`, `note_refusal`) dispatch to their `ControlAction` implementation, not an executor.
   b. Library-managed prereqs (`requiresFlow`, then `requiresOtp` / `requiresMatch`) → refuse if not gated.
   c. User-declared prereqs (verifiers) → refuse with denial body.
   d. Validate params via `paramsSchema.parse` — an `invalid_params` bounce also feeds the action's `captureBounces` counter when declared (escalating through the named ladder when spent).
   e. Run the action's selector against the running `view` to build the slice, then call the executor: `executors[action](params, selectors[action](view))`. The declared return is normalized through the named verdict row (summary rendered over the current view; body composed in declaration order; `resultExtras` appended; row stateUpdate/effects merged UNDER the executor's). An undeclared verdict — or a thrown executor — is caught, marked `ok:false` (`error: "executor_error"`), and short-circuits; earlier steps' commits are preserved.
   f. Apply the outputs in this order: `stateUpdate` (host slots only — library slots throw) → `request_handoff` effect (terminal; skips the rest) → `startsFlow` + `merge_flow_data` → auto-clear of `requiresOtp`/`requiresMatch` on ok → `otp_issued` → `startsMatchFor` → `endsFlow` → `clear_awaiting_input` / `abort_flow`. (Consume BEFORE issue: one action may both consume a match and issue an OTP, and `awaitingInput` is a single replace-on-write slot — issuing first would have the consume wipe the freshly opened gate.) On ok:false + `verdict:"match_mismatch"`, decrement match attempts (or abort flow on exhaustion). **Handoff monotonicity:** once the `handoff` slot is set (control, row effect, or executor effect), the remaining interaction lifecycle is skipped and the batch ends after the current step, whatever `ok` was.
6. **Finalize** (`run/finalize.ts`) — build the result body, apply the **standing-ask lifecycle** (the final entry sets/clears the `dictation` record and is stamped `standing_ask` / `ask_text` / `ask_contract` — see `<standing_asks>`), apply the error-counter/auto-handoff policy, and emit a single `ToolMessage` whose content is the JSON-stringified `RunnerResultBody = { summary, results, failed_at? }`.

**Cumulative commit on partial failure:** state patches from successful earlier steps DO commit even if a later step fails. Example: `[verify_customer (ok), verify_card (fail)]` → `verifiedCustomer` persists for the next turn.

**Crucial:** state slots in the graph's `state.ts` MUST declare an explicit reducer. The library reads the reducer at runtime. Slots declared without a reducer get replace-on-write behavior (which is fine — but be explicit about it).
</state_threading>

<confirmation_lifecycle>
## Mutation propose → execute lifecycle (when `requiresConfirmation` is set)

The runner switches the mutation action into a five-mode state machine. Detected by reading `awaitingInput.kind === "confirmation"`:

**Ordering with prereqs (non-obvious, but guaranteed).** A step's library prereqs (`requiresFlow`) and user verifiers run BEFORE its confirmation mode is acted on (`<state_threading>` step 5b/5c, ahead of the propose in 5f). So a confirm-gated mutation whose `requiresFlow`/prereqs are unmet is **refused, not proposed** — `awaitingInput` is never set into a doomed state. Compose `requiresConfirmation` with `requiresFlow` freely; the gate order is correct.

### First call (no pending, or pending action ≠ this action) → **propose mode**
- Parse params with the action's **effective schema** (the declared `paramsSchema`, page-extended for `pageable` actions) and store them **PARSED** — schema normalization (`z.preprocess`, coercion) is applied before storage: `awaitingInput = { kind: "confirmation", for_action, params, attempts_left: maxAttempts, max_attempts, proposed_on_caller_turn_id? }`. The proposal is stamped with the current caller-turn identity when one exists (see `<caller_turn_identity>`).
- A failed parse returns `{ ok: false, error: "invalid_params" }` with the overridable `invalid_params` system-message summary and the raw Zod detail in `_debug` (nothing is stored; the action's `captureBounces` counter, when declared, counts the bounce).
- Return `{ ok: true, summary, needs_confirmation: true, proposed_params, attempts_left }`, plus:
  - **`read_back`** when the action declares `ConfirmationOpts.readBack` and it renders non-empty for these parsed params. Absent — not empty — when it renders nothing.
  - **`read_back_directive`** when `readBackDirective` renders non-empty (how to frame the bytes).
  - **`reply_contract`** — the complete classification of the caller's next reply: the composed action-specific contract when the action declares `replyContract`, else the generic `confirm_reply_contract` template. The gate turn reacts to THIS, not prompt memory.
- **Executor is NOT invoked.**

### Re-call whose params **parse to the pending proposal**, on a LATER caller turn → **execute mode**
- The incoming RAW params are parsed with the same effective schema, then compared (deep value equality) against the stored parsed proposal — value normalization never reads as drift (e.g. a `z.preprocess` stripping STT separators: `"70,76"` ≡ `"7076"`). A failed parse counts as drift (→ rePropose).
- Clear `awaitingInput` atomically BEFORE invoking the executor.
- Invoke the executor with the parsed params + view.
- The executor's named verdict row composes the result (the executor performs its own pre-read + write + post-read).

### Matching re-call on the SAME caller turn → **sameTurnLocked** (2.0.0)
- The proposal carries `proposed_on_caller_turn_id`; a matching re-call while that turn is still current means the caller has NOT actually answered the read-back — the model is confirming with itself. Refused with `error: "confirmation_same_turn_locked"`: no attempt is spent, the gate stays untouched, and execution requires a re-call on a later caller turn.
- Enforced only when both turn identities exist. Identity-less direct `runSteps` consumers (state fixtures without message ids) keep the params-only behavior. **Test-harness implication:** manual propose → execute sequences must simulate the caller's answering turn — append a fresh human message id between the two calls (the bootstrap harness ships `answeredTurn` / `runConfirmed` helpers for exactly this).

### Re-call with **genuinely different params** (or params that fail to parse) → **rePropose mode**
- Update `awaitingInput.params` to the newly parsed params, decrement `attempts_left`.
- If the re-call's params fail to parse: the step fails with `invalid_params` (summary = the overridable system message, raw Zod detail in `_debug`) and the pending proposal is left **unchanged** — no decrement, the prior proposal still stands.
- If `attempts_left > 0`: return new `needs_confirmation` envelope with decremented `attempts_left` — including a fresh `read_back` rendered from the CORRECTED params, so the caller hears what actually replaced the old value.
- If `attempts_left === 0`: return `{ ok: false, summary, error: "confirmation_attempts_exhausted" }` and clear pending.

### The repeat control (`repeat_pending_question`)
When an action opts into `repeatReadBack`, a "pardon?" / channel-check turn has a legal move that is
neither consent nor drift: the sole-step `repeat_pending_question` control re-presents the gate's
stored `read_back` bytes (with `read_back_directive_repeat` framing) — no executor run, no re-render
from mutable state, no params/attempts change, and the gate is not consumed. It advances only the
gate's presentation-turn provenance: the repeated recap is now the question the caller must answer on
a LATER turn. Misdirected calls (no pending gate, gate not opted in, no stored rendering) fail closed
and change nothing.

### Lockdown
If `awaitingInput.kind === "confirmation"` and `lockdown: true` (default), the batch MUST start with either:
- The same action as the pending one (resolves to execute / rePropose / exhausted), OR
- `abort_pending_input` (library-handled; clears `awaitingInput` AND `currentFlow`; abort may be the first step of a larger batch — subsequent steps run after the gate clears), OR
- an allowed control (`request_handoff`, `repeat_pending_question`, per its own rules).

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
- On the ok verdict, the return carries `effects: [{ type: "otp_issued" }, { type: "merge_flow_data", data: { challengeId, customerId, ... } }]` (on the row or the executor return) — the merge carries the challenge details so the consumer can read them from `currentFlow.data`; surface caller-facing bits (e.g. a masked mobile) on the row's body / `resultExtras`.
- Library sets `awaitingInput = { kind: "otp", for_action: consumer_action, flow_ref: currentFlow.name }`.

Issuer typically also declares `startsFlow: { name: "X" }` so the OTP gate is tied to a flow.

**Re-send without aborting.** While the issued gate is pending, the OTP lockdown admits a **same-flow issuer** of that gate as the batch's first step: an action whose `issuesOtp.consumer_action` is the gate's `for_action` AND whose `requiresFlow` equals the gate's `flow_ref`. A code that never arrived (or expired unnoticed) can thus be re-sent without `abort_pending_input` — which would take the whole flow, and everything captured in it, down with it. Re-issuing replaces the gate with a fresh one, so "one gate at a time, belonging to the flow" is untouched. The admission is deliberately scoped: an issuer for the same consumer that belongs to a DIFFERENT flow is not a re-send and stays locked out (`otp_pending_locked`), and a `startsFlow`-only issuer (no `requiresFlow`) is not admitted — give the re-sendable issuer a `requiresFlow` tying it to the gate's flow.

**Match-then-OTP ordering guard.** An `issuesOtp` step is refused (pre-execution, so the SCA backend is never called) when a double-entry **match** gate is still pending in the live view — error `otp_blocked_match_pending` — **unless the issuer is that match's own consumer** (the pending gate's `for_action`). The guard enforces "at most one input gate at a time, match before OTP": without it, a `[capturer, issuer]` batch would mint+send the OTP and overwrite the still-pending match gate, skipping the second entry entirely. When the issuer IS the consumer that hazard cannot arise — it is running right now and clears the gate as it goes — so the folded "confirming the value sends the code" shape (one action declaring both `requiresMatch` and `issuesOtp`) is allowed: on its ok verdict the consumed match is cleared first, then `otp_issued` opens the OTP gate (consume-before-issue, see the apply order in `<state_threading>`); on a mismatch the issue never happens (effects ride the ok row only) and the match gate stands. The check reads the **live** view (not batch-start), so the legitimate `[consumer, issuer]` batch still works — the consumer clears the match earlier in the same batch, so no match is pending by the time the issuer runs.

### Consumer (`controller.requiresOtp = true`)
- Refused unless `awaitingInput.kind === "otp" && for_action === <this action>`. Error: `otp_not_pending` if the gate isn't pending; `otp_pending_locked` if something else is awaiting.
- Executor reads `challengeId` (etc.) from `state.currentFlow.data`, calls SCA validate.
- Library **does not count OTP attempts**. The backend is authoritative for lock / timeout / wrong:
  - **valid** → an `ok: true` verdict; library auto-clears `awaitingInput`. Flow continues.
  - **wrong, retry allowed** → an `ok: false` verdict (no effects). Library leaves state alone; customer re-reads the same code.
  - **timeout** → an `ok: false` verdict whose row (or return) carries `effects: [{ type: "clear_awaiting_input" }]`. The gate dies; the LLM offers to resend (re-call the issuer to mint a fresh challenge).
  - **lockout** → an `ok: false` verdict with `effects: [{ type: "abort_flow" }]`. The flow is dead; library clears `awaitingInput` AND `currentFlow`.

### Single consumer, multiple issuers
A single `confirm_otp` action can serve every OTP-protected flow in the tool. Each issuer points its `issuesOtp.consumer_action` at that one consumer, and the consumer reads `currentFlow.data` to know which challenge is in play.
</otp_lifecycle>

<match_lifecycle>
## Double-entry match gate (when `startsMatchFor` / `requiresMatch` are set)

The customer provides a value once, then again; the system verifies they match. Used for PIN setup, password change, secret-answer confirmation. Library coordinates `awaitingInput.kind === "match"`.

### Capturer (`controller.startsMatchFor = { consumer_action }`)
- Executor validates/encodes/persists the first entry (typically into flow data, via a `merge_flow_data` effect).
- On the ok verdict, library sets `awaitingInput = { kind: "match", for_action: consumer_action, attempts_left: maxAttempts, max_attempts: maxAttempts, flow_ref? }`.
- Re-running the capturer while a match is awaiting **resets** `attempts_left` (lets the customer change their first entry).

### Consumer (`controller.requiresMatch = { capturer, maxAttempts }`)
- Refused unless `awaitingInput.kind === "match" && for_action === <this action>`. Error: `match_not_pending` if absent.
- **Same-batch double-entry is refused (batch-start freeze).** The gate check reads the awaiting-input snapshot as it stood at **batch start**, not the live in-batch view — so a match gate the capturer opens *earlier in the same batch* is NOT consumable by the consumer in that same batch. The double-entry repeat must arrive in a SEPARATE turn (mirrors the confirmation same-batch-bypass protection). A `[capturer, consumer]` batch fails at the consumer with `match_not_pending`; the legitimate `[consumer, issuer]` batch is unaffected (the consumer's gate was opened in a prior turn, so it IS present at batch start).
- Executor receives the second entry, owns the comparison (e.g. compares ciphertexts), performs the side-effect on match.
- Library reads the verdict's outcome:
  - `ok: true` → match succeeded; library auto-clears `awaitingInput`. Pair with `endsFlow: true` to wrap the flow — or with `issuesOtp` for the folded "confirming the value sends the code" shape (the consumed match is cleared, then the OTP gate opens; see `<otp_lifecycle>`).
  - `ok: false` + body `verdict === "match_mismatch"` → library decrements `attempts_left`. On exhaustion, library clears `awaitingInput` AND `currentFlow` (terminal) and surfaces `verdict: "match_attempts_exhausted"`, `error: "match_attempts_exhausted"`.
  - `ok: false` + any other verdict → library leaves state alone (unrelated failure, e.g. backend error).

### Lockdown
While `awaitingInput.kind === "match"`, only three actions are allowed as the first step: the consumer, the capturer (re-capture), or `abort_pending_input`.
</match_lifecycle>

<caller_turn_identity>
## Caller-turn identity (`BuildAgentStepToolOptions.getCallerTurnId`)

The confirmation gate's protections key on a **stable identity for the latest caller turn**: the same-turn lock (`<confirmation_lifecycle>`) and the repeat control's presentation-turn provenance. By default the runner resolves it as the **latest human/user message id** in `state.messages` — LangGraph's messages reducer assigns missing ids before a node sees state, so this is stable across every ReAct loop within one caller turn and independent of history length.

- Hosts that **compact or replace messages** must provide `getCallerTurnId: (state) => string | null | undefined` returning a stable, non-compacted turn token.
- When no identity exists (e.g. direct `runSteps` calls with message-less fixtures), the confirmation same-turn guard is **deliberately unavailable** (params-only behavior) — the runner never guesses.
- The hook (and the message scan) is only consulted when a confirm gate is actually configured — hosts using none never pay for it.
- **`resolveCallerTurnId(state, getCallerTurnId?)` is exported** (from `interaction/turn-identity.ts` since 3.0.0) so hosts stop re-deriving this. It returns the host hook's value when configured, else the latest human message id; blank/whitespace collapses to `undefined` (identity unavailable). Pass the same `getCallerTurnId` you gave `buildAgentStepTool`, or the two halves will disagree about where a turn starts.
</caller_turn_identity>

<pagination>
## Read pagination (`pageable`)

A LIST read opts in with `pageable` on its `ActionDef`. The runner then injects optional `page` / `pageSize` params into the action's schema (so the model can ask for a page), runs/serves the read, and emits a **uniform envelope** spread into the StepResult:

```ts
{ page, pageSize, totalCount, totalPages, hasMore, items, fromCache }
```

The row's other composed fields (e.g. `summary`) are preserved on every page, including cache hits. Two modes:

- **`pageable: true`** — **self-paginate.** The executor returns the **FULL set** as `items` (via `resultExtras.items`); the runner slices the requested page and caches the full set in the library-managed `pagedRead` slot. A same-query re-page (same params minus `page`/`pageSize`) is served from the cache **without re-running the executor** (`fromCache: true`).
- **`pageable: "delegate"`** — **backend pages.** The executor reads the injected `page`/`pageSize`, returns that page as `items` plus `totalCount`; the runner just wraps it (no cache).
- **`pageable: { mode, pageSize?, maxPageSize? }`** — same, with tuned sizes (defaults: `DEFAULT_PAGE_SIZE=10`, `MAX_PAGE_SIZE=50`).

**Constraint:** a `pageable` action's `paramsSchema` MUST be a `z.object` (the runner merges `page`/`pageSize` in) — otherwise construction throws.

**Primitives** (exported from `index.ts`, for hand-rolled cases — the runner uses them internally): `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `clampPageSize`, `querySignature`, `pageRows`, `buildPageEnvelope`, and types `PageEnvelope`, `PagedCache`, `PageableSpec`. Prefer the `pageable` opt over hand-rolling.
</pagination>

<caller_digit_capture>
## Caller capture params (`callerDigits` / `digitGroupsParam` / `digitCandidatesParam` / `callerTextParam` / `relayParam` / `exactlyOneOf`)

Schema helpers for params that carry **caller-dictated values** (a tax number, a card-number tail, a spoken name). Unlike `paginate.ts` — whose primitives the runner itself uses — this module is **authoring-only**: nothing in the runner calls it. It lives in the library because each rule below is a consequence of a runner contract, so a host that hand-rolls the field re-derives (or misses) them one live failure at a time:

- **Shape rules are refinements, never `.regex()` / `.min()` / `.max()`.** A `.regex()` becomes a `pattern` keyword in the model-facing JSON Schema (and `.min`/`.max` become `minLength`/`maxLength`), turning the tool's validation into a precondition the model must satisfy before it may call. The model then counts digits itself — unreliable on grouped STT captures — and either **withholds the call** (answers the caller instead; a valid capture never reaches the tool) or **pads an invented digit** to satisfy the pattern. The builders keep the wire type plain; the runner's propose-path parse bounces a bad shape as recoverable `invalid_params` — before any read-back, without spending a confirmation attempt.
- **Refinement messages carry no digit count.** Issue text rides the StepResult's `_debug` back to the model; "must be exactly 9 digits" re-introduces through the error path the very constraint the refinement keeps out of the schema. Say WHAT failed ("not a usable capture"), never HOW MANY DIGITS.
- **Representation flips must not read as drift.** The confirmation gate compares schema-PARSED params, so `["7070"]` ≡ `"7070"` and separator variants must normalize identically — the separator strip and the singleton-array collapse live in the preprocess, before the compare.
- **The declared type is the honest wire union.** A field that accepts digit GROUPS carries the array branch in its TYPE — a preprocess is invisible to the model's schema, and with a bare string type a group-array call bounces as a raw schema error instead of the runner's voice-safe `invalid_params`.

The builders (each takes a **required** `describe` — the library ships NO model-facing wording; field text is live prompt surface, owned and QA-gated per host):

- **`digitGroupsParam({ shape, message, describe })`** — the "transcription field": the model transcribes one array entry per **spoken digit group** («δεκαεπτά, είκοσι ένα, πενήντα δύο, δύο, ογδόντα δύο» → `["17","21","52","2","82"]`) or a single string; the JOIN happens in the preprocess, never in the model (models regroup, drop repeated groups, and lose the zero of round tens). `shape` validates the JOINED value. Omission stays `undefined` — the host's channel for "consume a carried/collected value".
- **`digitCandidatesParam({ shape, message, candidateMessage?, maxCandidates?, describe })`** — the ambiguous-reading field: a single digit string, or an array of EVERY plausible reading of one utterance («χίλια τρία» → `["1003","10003"]`) for the executor to try — the model never picks a reading itself.
- **`callerTextParam({ min, max, shortMessage, longMessage, describe })`** (3.0.0) — a caller-dictated TEXT capture (a spoken name, a free-form answer): trim + bounded length as a REFINEMENT with count-free messages — the text analogue of `callerDigits`.
- **`relayParam(describe)`** (3.0.0) — a relay-only transcription field: the caller's exact words, OPTIONAL, passed through for the SYSTEM to classify — the model never translates, normalizes, or invents them. Mechanically a described optional string; the builder NAMES the intent (stenographer field).
- **`exactlyOneOf(fields, message)`** (3.0.0) — an exactly-one-of selector for a params object (XOR over optional fields) as a refinement, applied via `z.object({...}).superRefine(exactlyOneOf([...], msg))` — the model-facing JSON Schema stays a plain object, and a bad shape bounces as recoverable `invalid_params` on the propose path.

**Description authoring (the part the host owns).** The proven register for `describe` — adapt, don't invent:
- Frame the field as **pure transcription** ("you are a stenographer here"): write down the digit groups exactly as heard, in spoken order; never concatenate, merge, regroup, shorten, extend, count, or judge; a group is never dropped because it repeats its neighbour; the SYSTEM sanitizes, joins, and does ALL validation, answering `invalid_params` on an unusable capture.
- Keep the field **semantically neutral**: naming the domain entity ("the AFM") or its length ("nine digits") re-activates the model's world knowledge — the measured source of withheld calls and reshaped captures no prompt scrub fully suppresses.
- Give 2–3 concrete renderings in the caller's language(s), e.g. `«10, 2, 22. 8078» → ["10","2","22","8078"]`.
- If omission consumes a carried value, say exactly that ("Omit the field entirely to consume …") — omission semantics belong in the field text, not only the prompt.
- Bound a capture's re-ask loop with `captureBounces` (see `<ladders>`) rather than prompt counting.
</caller_digit_capture>

<handoff>
## Library-coordinated channel handoff (`BuildAgentStepToolOptions.handoff`)

Opt-in machinery for a SPECIALIZED agent's off-topic plays (see `streaming-and-channel-contract.md` `<agent_roles>`): delegate the turn to another deployment and keep the conversation, or hand the conversation back. Two cooperating halves — the runner writes a slot; a host graph node resolves it.

### Runner half (opt-in)

Pass `handoff: HandoffSpec<T>` to `buildAgentStepTool`. The runner then:

- Auto-injects the reserved **`request_handoff`** control into the tool schema (with the opt provided, declaring it in `config.actions` throws; WITHOUT the opt the name is free — the orchestrator/scaffold mechanism uses it for its own action). Params = `HandoffRequestSchema`: `{ reason: "off_topic" | "completed" | "abandon", context }` — `context` is the customer's request for `off_topic`, the closing line for `completed` / `abandon`.
- Handles the action internally as an **atomic slot transition** — validates params, clears every transient runner slot (`awaitingInput`, `currentFlow`, `pagedRead`), writes the `handoff` slot into view + committed state, and returns an ok result telling the model the turn ends here. No I/O in the runner. A verdict row or executor requests the same terminal transition (identical atomic cleanup) via the `request_handoff` effect — never by writing the slot through `stateUpdate`, which throws.
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
                                     // to replace `request.context`, or `undefined` to fall through.
                                     // NEVER called for off_topic (a silent hand-back;
                                     // terminateMessage only backs delegate failures).
  resolveHandoffType?: (state: T, request: HandoffRequest)
                        => "completed" | "abandon" | undefined;
                                     // OPTIONAL (2.3.0) — decide the handback SIGNAL from state
                                     // instead of taking the model's word for it. Consulted ONLY for
                                     // a terminate-mode completed/abandon; never for off_topic and
                                     // never for a successful delegate. `undefined` falls through.
  resolveHandoffMetadata?: (state: T, request: HandoffRequest)
                        => Record<string, unknown> | undefined;
                                     // OPTIONAL (2.3.0) — host fields merged into handoff_metadata.
                                     // Called for EVERY handback type INCLUDING off_topic (identity
                                     // forwarded to a call-scoped store must survive a re-route), but
                                     // never for a successful delegate. The library's own keys
                                     // (service_type, success_message) are applied LAST and win.
  delegateInput?: (state: T, request: HandoffRequest) => Record<string, unknown>;
  clearsOnHandback?: readonly (keyof T & string)[];
                                     // OPTIONAL (2.2.0) — host DOMAIN slots to null when a
                                     // task-ENDING handback resolves (completed / abandon in
                                     // terminate mode). The library's own task-scoped slots are
                                     // cleared automatically; list only your own. Each is written
                                     // as `null`, so it must be nullable with a replace-style
                                     // reducer.
  onHandback?: (state: T, request: HandoffRequest) => void | Promise<void>;
                                     // OPTIONAL (3.1.0) — OBSERVE a resolved handback, for a host
                                     // side effect that must follow the task's outcome (e.g. a
                                     // CRM contact record). Called once per handback — completed,
                                     // abandon, off_topic, a delegate failure — never for a
                                     // successful delegate; gets the EFFECTIVE request and the
                                     // PRE-clear state. Never awaited; a throw or a rejection is
                                     // contained — it cannot change the reply, signal or clears.
  modelRequestSchema?: z.ZodType<HandoffRequest>;
                                     // OPTIONAL (2.5.0) — a NARROWER schema for the MODEL-FACING
                                     // request_handoff params, used both to generate the wire
                                     // schema and to parse the control at runtime — exact
                                     // reason/context route pairs become configuration instead of
                                     // prompt prose, each variant carrying its own when-to-use
                                     // description. Does NOT replace HandoffRequestSchema: the
                                     // library-managed slot and trusted effects keep the base
                                     // schema. Output must still be a HandoffRequest. Engine-only
                                     // escalation routes (ladder onExhaust contexts) are deliberately
                                     // OMITTED from it, so the engine holds the only path to them.
}
```

**`resolveClosingMessage`** lets the host gate the spoken closing on what actually happened: e.g. only
speak a success line for `completed` when the mutating action truly persisted, otherwise return a
neutral/failed phrasing. It runs in `createHandoffNode` for `completed` / `abandon` only; a returned
string becomes the final message `content` (and `handoff_metadata.success_message`), `undefined` falls
through to `request.context`.

**State can decide the signal and the metadata (2.3.0).** `resolveHandoffType` is resolved **before the
first control-plane event**, so the `handoff` custom event, the closing line, `handoff_type` and
`handoff_metadata.service_type` all carry one value. An override can only swap `completed` ↔ `abandon`;
it can never produce or erase an `off_topic`, so delegate detection and the clearing gate below are
unaffected by construction. `resolveHandoffMetadata` is the same move for host-derived fields: they are
spread FIRST and the library's keys applied last, so a host cannot clobber the contract.

**Terminality is declared on verdict rows (3.0.0).** The resolver reads only the armed `handoff`
slot: `createHandoffNode` resolves `state.handoff`, and the graph routes on `handoffRequested(state)`
alone. A terminal business outcome arms its handoff ATOMICALLY via the verdict row's
`request_handoff` effect — the row that writes the outcome carries the effect, so "terminal but
nothing armed" is unreachable by construction. (The 2.3.0 `forcedHandoff` state-predicate net — and
its `forcedHandoffRequested` edge predicate — were REMOVED in 3.0.0: the hook duplicated executor
outcome sets in the spec, and its `clearsOnHandback` coupling carried a re-fire-forever trap. A host
whose terminality was INPUT-derived — a predicate over raw invoke fields, reachable with no executor
run — converts it to a first-turn probe action whose executor answers the fact as a verdict row
carrying the terminal effect.)

**Task-scoped state is cleared when the task ends (2.2.0).** The THREAD outlives the TASK: a channel
middleware reuses one thread id for a whole call and never resets it on re-dispatch, so whatever sits
in state when a handback resolves is what the NEXT task on that thread starts from. On `completed` /
`abandon` in terminate mode, `createHandoffNode` therefore nulls the library's own
`agentStepTaskScopedSlots` (`awaitingInput`, `currentFlow`, `pagedRead`, `spentLadders`, `errorCount`)
plus every domain slot the host named in **`clearsOnHandback`**. Two carve-outs, both correctness
invariants rather than preferences, so neither is configurable: **`off_topic` clears nothing** (a
mid-task aside must stay resumable — the caller can come straight back; a spent ladder stays spent),
and **a successful delegate clears nothing** (the conversation never left this agent). The closing
line, the signal, and any `resolveClosingMessage` reading state are all computed before the clear, so
the reply is unaffected.

Declare `clearsOnHandback` when the host graph derives anything from a terminal domain slot — an
escalation, a "this task already finished" branch. Left undeclared, such a slot survives into the next
task and re-fires its branch on every later turn of the same call. Slots whose reducer MERGES cannot
be cleared this way (the write is a plain `null`); reset those through the pointer slot that selects
from them.

**A side effect that follows the outcome is an observer (3.1.0).** `onHandback` runs once the reply,
the signal and the metadata are final, with the same state view the closing was chosen from — the
PRE-clear state and the EFFECTIVE request — so whatever it records cannot disagree with what the
caller heard. It is called synchronously (anything it starts inherits the node's run context, so
its traces stay in the conversation) but never awaited, and a throw or a rejection is contained:
nothing it does can reach the reply, the signal, the metadata or the clears. It is called for every
handback type (`off_topic` included — the host filters) and never for a successful delegate. It is
an observer by construction: it returns nothing the node reads and cannot write state, so it can
never become a second resolver. Why the field exists: some endings run no host executor at all —
an exhausted ladder, the auto-handoff over a thrown executor — so the resolver is the only place
that sees every ending; without it a host could reach those endings only by wrapping the node or by
hiding I/O in the pure `resolve*` functions. The library does not log: report failures inside the
hook.

**Asides mid-task**: the free-deflection damper that was `HandoffSpec.deflectAside` (2.4.0) is now a
LADDER — configure an aside ladder in the `ladders` registry (instruction: decline in one short
sentence and re-ask in the same turn; `onExhaust`: the `off_topic` handback carrying the aside as
routing context) and let the prompt route nobody-serves-it chit-chat to `note_refusal`. Same policy,
one mechanism, one latch (see `<ladders>`).

Exports: `HANDOFF_ACTION` (`"request_handoff"`), `HANDOFF_NODE` (`"resolve_handoff"` — a node can't be named `handoff`, the state channel claims it), `HANDOFF_ACTION_DESCRIPTION`, `HANDBACK_SIGNALS` (reason → `handoff_type` signal; identity over `off_topic` / `completed` / `abandon`), `handoffParamsSchema`, `handoffRequested(state)` (edge predicate), `createHandoffNode(spec)`, and types `HandoffSpec`, `HandoffOffTopicSpec`, `HandoffDelegateTarget`.

Wire a conditional edge after the tool node — `createReactAgent` cannot express it, so the graph is hand-rolled: `addConditionalEdges("tools", s => handoffRequested(s) ? HANDOFF_NODE : "agent")`, `addNode(HANDOFF_NODE, createHandoffNode(spec))`, `addEdge(HANDOFF_NODE, END)`. The node emits a `handoff` custom event FIRST (streaming clients abort TTS / reroute before any content), resolves the response (terminate envelope, or a delegate run over the Platform API with live `delegated_token` pass-through and a behavioral fallback to the envelope on failure), emits `handoff_complete`, calls the host's `onHandback` observer when one is configured (3.1.0 — not awaited, contained), and returns `{ handoff: null, ...clears, messages: [AIMessage] }` (the clears are empty unless a task-ending handback resolved — see above) — the model never paraphrases the result.

**Final-message kwargs** (the channel contract): every non-delegate resolution is a handback — `is_handoff: true`, `handoff_type` = the effective reason's signal (`off_topic` / `completed` / `abandon`, after any `resolveHandoffType`), `handoff_reason` = `context`, `handoff_metadata: { ...host fields from resolveHandoffMetadata, service_type, success_message }` — host fields first, library keys last and unclobberable. Spoken content: the `off_topic` envelope (`terminateMessage`, also the delegate-failure fallback) or the closing in `context` for `completed` / `abandon` (the middleware delivers it and flips routing for the NEXT request). Delegate success → NOT a handoff (conversation kept) — informational `{ delegated_to }` only. Streaming clients must request `stream_mode: ["messages-tuple", "custom"]` — the node-built final message never appears in the token stream; `handoff_complete` carries its text. Full wire details + the middleware checklist: `streaming-and-channel-contract.md`.
</handoff>

<system_messages>
## Runner-emitted system messages (`BuildAgentStepToolOptions.messages`)

The runner emits its own `summary` strings for structured refusals/errors it raises directly (not from a verdict row): executor crash, invalid params, unknown action, the abort outcomes, the flow gates, the lockdown/batch-shape refusals, and the confirmation/OTP/match gate outcomes — plus the model-facing CONTRACTS that ride result bodies (reply contracts, the standing-ask contract, the read-back framing directives). **Every runner-emitted string is overridable.** These ship as **neutral English defaults** in `src/agent-step/messages.ts` so the library has ZERO dependency on any host project.

```ts
interface SystemMessages {
  executor_error: string;     // an executor threw / named an undeclared verdict (raw cause in `_debug`)
  invalid_params: string;     // step params failed schema validation (raw detail in `_debug`)
  unknown_action: string;     // a hallucinated/typo'd action name reached the runner
  flow_already_active: string;// tried to open a flow while a different flow is active
  no_flow: string;            // a flow-scoped step ran with no flow active
  wrong_flow: string;         // a flow-scoped step ran against the wrong flow
  abort_done: string;         // abort_pending_input cleared a pending gate / active flow
  abort_nothing: string;      // abort_pending_input ran with nothing pending (no-op)
  auto_handoff: string;       // spoken when the auto-handoff threshold is hit (see <auto_handoff>)

  // Templated summaries — may carry `{placeholder}` tokens the runner
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
  no_steps: string;                      // (no placeholders)
  auto_handoff_instruction: string;      // {message} — see <auto_handoff>

  // Model-facing CONTRACTS riding result bodies (3.0.0) — the gate/ask turns
  // react to these wire bytes instead of prompt memory:
  confirm_reply_contract: string;        // {action} — the GENERIC reply contract on every proposal
                                         // (replaced per-action by a composed replyContract)
  standing_ask_contract: string;         // {action} {param} — rides the entry that recorded a
                                         // standing ask (see <standing_asks>); includes the
                                         // repeated-value clause (a reply repeating an
                                         // already-refused value still calls — the engine counts
                                         // those turns for captureBounces)
  read_back_directive_repeat: string;    // framing directive on the repeat control's returned
                                         // read_back: the stored recap is complete and ends the turn
}
```

A host overrides any subset via `buildAgentStepTool({ messages })` (`Partial<SystemMessages>`, **shallow-merged** over `DEFAULT_SYSTEM_MESSAGES`). Use this for localized / voice-safe wording on a TTS or non-English agent — and remember the contract strings are MODEL-facing (never caller-audible): they stay English on a Greek agent, but a host may tighten their taxonomy (the reference host overrides `standing_ask_contract` with domain reply categories). The library never imports host strings; the host injects them.

Exports (from `index.ts`): `DEFAULT_SYSTEM_MESSAGES`, `resolveSystemMessages(overrides?)`, type `SystemMessages`. Note these are the **runner's own** strings only — a verdict row's `summary` (the LLM-facing per-action text) is authored on the row and is unaffected.
</system_messages>

<auto_handoff>
## Auto-handoff on repeated backend failures

A safety net so a customer is never trapped in an unrecoverable backend-error loop. The runner keeps a consecutive **backend-failure** counter in the library-managed `errorCount` slot; when it reaches a threshold the runner auto-triggers a handoff.

**What counts as a backend failure.** The runner-raised **`executor_error`** (an executor threw, or named an undeclared verdict) ALWAYS counts. A verdict row with **`backendFailure: true`** marks its static `body.error` code as counting — this DERIVES the code list from the declarations, so the hand-kept list disappears; `BuildAgentStepToolOptions.backendFailureCodes` remains for codes that reach the wire outside any row. List ONLY true backend/network failures. User mistakes (wrong OTP, value mismatch) and business-logic refusals are recoverable and must NOT count, or the counter will escalate recoverable situations. The counter resets to 0 only when a batch in which an executor **actually ran** ends without a backend failure — executed work is the only proof the backend recovered. Batches where no executor ran (confirm-gate proposals/re-proposals, prereq or param refusals, aborts, handoff signals) are **neutral**: they neither increment nor reset, so the proposal a confirm gate interleaves between two failing executes cannot wipe the streak.

```ts
// BuildAgentStepToolOptions additions
backendFailureCodes?: string[];   // extra codes that count (executor_error + backendFailure rows
                                  // always count)
errorHandoffThreshold?: number;   // default 3
onErrorThreshold?: (update: Record<string, unknown>, state: T) => void;
                                  // host hook fired at the threshold — inject a custom
                                  // handoff signal (e.g. write a scaffold `pendingHandoff` slot)
```

**At the threshold the runner:** (1) writes the library `handoff` slot `{ reason: "abandon", context: messages.auto_handoff }` when the `handoff` opt is enabled; (2) calls `onErrorThreshold(committed, state)` if provided; (3) resets `errorCount` to 0; (4) appends a synthetic step result `{ action: "auto_handoff", ok: true, isHandoff: true, signal: "abandon", successMessage: <auto_handoff> }`, sets `body.summary` to the **`auto_handoff_instruction`** template, and clears `failed_at`.

**Who speaks the closing.** The default `auto_handoff_instruction` tells the model the turn ends here and to produce NO further answer — **the platform delivers the closing** (a `createHandoffNode` graph speaks the handoff `context`; a scaffold/middleware host speaks `success_message` from the final-message kwargs). A host whose graph does NOT deliver the closing overrides `auto_handoff_instruction` and uses the `{message}` placeholder (= the `auto_handoff` closing) to have the model speak it.

**Inert by default.** The whole mechanism is skipped unless a handoff path exists — i.e. the `handoff` opt is provided OR `onErrorThreshold` is set. A tool with neither never touches `errorCount`.
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
  [key: string]: unknown;          // the row-composed body fields spread in
}
```

The `summary` of a runner-emitted refusal/error (executor crash, invalid params, abort, flow gates) is a **host-overridable system message** — see `<system_messages>`. For the `executor_error` and `invalid_params` kinds the runner also attaches a **`_debug`** field carrying the raw technical cause (the thrown message / the Zod issue list), so the overridable `summary` can stay user-safe while the diagnostic detail is preserved for logs.

Library-injected fields on specific step kinds:
- `abort_pending_input` results carry `aborted_awaiting: { kind, for_action }` and/or `aborted_flow: "<name>"` when something was actually cleared.
- `executor_error` / `invalid_params` results carry `_debug` with the raw cause (the `summary` itself is the overridable system message).
- `issuesOtp` refused while a match gate is pending carries `error: "otp_blocked_match_pending"`.
- propose / re-propose results carry `needs_confirmation: true`, `proposed_params`, `attempts_left`, a **`reply_contract`** (the composed action-specific contract, or the generic `confirm_reply_contract`), and — when the action declares `ConfirmationOpts.readBack` and it renders something — `read_back` (proposal-only; never on the executing re-call) plus `read_back_directive` when `readBackDirective` renders.
- exhausted results carry `error: "confirmation_attempts_exhausted"`.
- lockdown refusals carry `error: "pending_confirmation_locked" | "otp_pending_locked" | "match_pending_locked"` and `awaiting: { kind, for_action }`.
- match-mismatch results gain `attempts_left` (decremented) or `verdict: "match_attempts_exhausted"` on the last try.
- a matching confirm re-call on the proposal's own caller turn carries `error: "confirmation_same_turn_locked"` (no attempt spent; gate untouched).
- the final entry that recorded a standing ask carries `standing_ask: { action, param }`, `ask_contract`, and `ask_text` when the ask's `render` returned bytes (see `<standing_asks>`).
- `repeat_pending_question` results carry the stored `read_back` + the `read_back_directive_repeat` framing.
- `note_refusal` results carry `refusal_noted: true` and the ladder's `instruction` as summary on a free use, or `ladder_exhausted: true, handoff_requested: true, reason` on the escalation (see `<ladders>`).
</result_envelope>

<construction_time_checks>
The runner validates the config + registries at construction. These all throw at startup before any user input — fix the misconfig before continuing:

| Error message contains | Cause |
|------------------------|-------|
| `requires \`stateSchema\`` | `stateSchema` not provided |
| `is a reserved action name` | You declared `abort_pending_input` in config.actions (or `request_handoff` while the `handoff` opt is provided, or `note_refusal` while `ladders` is non-empty, or `repeat_pending_question` while some action opts into `repeatReadBack`) |
| `expects a state selector at selectors["xxx"]` | `selectors` registry missing the action-name key for an action |
| `expects an executor at executors["xxx"]` | `executors` registry missing the action-name key for an action |
| `is missing a non-empty description` | An action lacks `description` |
| `verifiers["xxx"] was not provided` | A prereq referenced by some action has no verifier |
| `pageable action's paramsSchema must be a z.object` | A `pageable` action's `paramsSchema` isn't a `z.object` |
| `at least one action must be defined` | Empty `config.actions` |
| `declares startsMatchFor "X" but that consumer doesn't declare requiresMatch` | Capturer names a consumer that exists but lacks the `requiresMatch` hook |
| `declares issuesOtp for "X" but no such action exists` | `issuesOtp.consumer_action` names a non-existent action |
| `declares requiresMatch with capturer "X" but no such action exists` | `requiresMatch.capturer` names a non-existent action |
| `the state schema is missing channel(s)` | Channel-completeness check: a library slot this configuration writes has no channel in the host schema — spread `agentStepZodShape` / `agentStepStateSpec` |
| `has a verdicts entry with an empty code` | A `verdicts` row keyed by an empty string |
| `sets backendFailure but body.error is not a static string` | A `backendFailure: true` row whose `body.error` is missing or dynamic — the failure counter matches on that code (3.0.0) |
| `asks["xxx"] targets unknown action` / `names param "xxx" which is not declared` / `has invalid expects` | Standing-ask validation (3.0.0): the mapped target action must exist and the named param must be a declared field of its params schema |
| `enables repeatReadBack but declares no replyContract` | A repeatable gate routes re-asks through the repeat control, which the generic reply contract forbids — declare the gate's own reply taxonomy (3.0.0) |
| `composeGateContract requires …` | A `replyContract` spec with an empty `subject`/`subjectNoun`/`executesLabel` or no categories (a yes/no-only gate keeps the generic contract instead) |
| `ladders require handoff` | A non-empty `ladders` registry without the `handoff` opt — every ladder escalates into one (3.0.0) |
| `ladder "xxx" …` | Ladder validation (3.0.0): empty name/description/instruction, `maxFreeUses` < 1, or an `onExhaust` that fails `handoffParamsSchema` |
| `captureBounces … not a configured ladder` | An action's `captureBounces.ladder` names no entry in the `ladders` registry (3.0.0) |
| `abortPolicy …` | Abort-policy validation (2.5.0): non-boolean knobs, empty/duplicate/unknown action names in `allowedFollowers` / `allowedPendingTargets`, or `allowStandalone=false` with an explicitly empty follower list |
| `handoff.modelRequestSchema must be a Zod schema` | The model-facing handoff schema narrowing isn't a Zod schema |

Runtime errors raised by the runner (not construction-time, but loud):

| Error message contains | Cause |
|------------------------|-------|
| `returned undeclared verdict` | An executor named a verdict with no row in `ActionDef.verdicts` — declared rows ARE the result space (surfaces as `executor_error` on the wire) |
| `wrote library-managed slot(s) … through stateUpdate` | Executor patched `awaitingInput` / `currentFlow` / `pagedRead` / `spentLadders` / `handoff` / `errorCount` via `stateUpdate` — request the transition as a typed effect instead |
| `requested merge_flow_data but no flow is active` | Executor emitted `merge_flow_data` without `startsFlow` and no flow is open |
| `reported otp_issued but no flow is active` | Issuer didn't pair with `startsFlow` |
| `reported otp_issued but config lacks issuesOtp opt` | Executor returned the effect but the action's config didn't declare `issuesOtp` |
| `otp_blocked_match_pending` (step error) | An `issuesOtp` step ran while a double-entry match gate was still pending — consume the match before issuing the OTP; the match's own consumer is exempt and may issue (see `<otp_lifecycle>`) |

Slot declaration is enforced at construction (the channel-completeness row above) — a state schema missing a required library slot fails at startup instead of silently dropping writes. Spreading `agentStepZodShape` into your Zod state schema (as the bootstrap state template does) brings all six slots in together with their reducers.
</construction_time_checks>

<key_files_to_inspect>
For ground truth, read these files in the project (don't paraphrase — they ARE the contract):

- `src/agent-step/index.ts` — the public surface (only what's re-exported here is part of the API; the module layout below is internal)
- `src/agent-step/types.ts` — the authoring contracts: `VerdictDef`, `DeclaredExecutorResult`, `ExecutorEffect`, `Executor`, registries, `ActionDef`, `ControllerHooks`, `ConfirmationOpts`, `GateContractSpec`, `DictationAsk`, `CaptureBouncePolicy`, `Verifier`
- `src/agent-step/state.ts` — the library-managed slot schemas (`AwaitingInputSchema`, `CurrentFlowSchema`, `PagedCacheSchema`, `HandoffRequestSchema`) + the slot table (`AGENT_STEP_SLOT_META`) + the spreadable fragments (`agentStepZodShape`, `agentStepStateSpec`, `agentStepInternalSlotMask`) and derived lists (`agentStepTaskScopedSlots`, `agentStepRunnerOwnedSlots`)
- `src/agent-step/runner.ts` — the thin public entry points (`buildAgentStepTool`, `runSteps`); the machinery lives in the phase modules:
  - `compile/` — `validate.ts` (every construction-time check), `plan.ts` (`BuildAgentStepToolOptions` + the compiled plan), `activation.ts` (the single ControlActivation construction), `schema.ts` / `describe.ts` (the model-facing schema + tool description), `action-describe.ts` (the composed per-action description), `gate-contract.ts` (`composeGateContract`), `protocol.ts` (`composeProtocolPrompt`), `state-schema.ts`
  - `run/` — `admission.ts` (the fixed-order whole-batch preconditions), `planning.ts` (confirm-mode freeze), `execution.ts` (per-step loop, verdict-row normalization, effects ordering, handoff monotonicity), `finalize.ts` (result body + standing-ask lifecycle + error-counter policy), `batch-state.ts` (the single write path into view/committed), `value-equal.ts`
  - `interaction/` — one policy module per gate kind: `confirmation.ts`, `otp.ts`, `match.ts`, `flow.ts`, `dictation.ts` (the standing-ask lifecycle), `turn-identity.ts` (`resolveCallerTurnId`)
  - `controls/` — the library-owned model-facing actions (`abort.ts`, `request-handoff.ts`, `repeat-question.ts`, `note-refusal.ts` — also `climbLadder` + the ladder types) in an ordered `registry.ts`, over the shared `contract.ts`
  - `handoff/` — `contract.ts` (action + signals + `HandoffSpec`), `node.ts` (`createHandoffNode` — the frozen channel contract), `delegate-client.ts` (SSE/Platform-API transport)
- `src/agent-step/paginate.ts` — the read-pagination primitives + the `pageable` orchestration
- `src/agent-step/capture.ts` — the caller capture primitives (refinement-not-regex, count-free messages, group join, candidate arrays, text/relay/XOR builders; see `<caller_digit_capture>`)
- `src/agent-step/messages.ts` — the runner's overridable strings: `SystemMessages`, `DEFAULT_SYSTEM_MESSAGES`, `resolveSystemMessages`
- Tests (all pass on `npm test`): `runner.test.ts`, `paginate.test.ts`, `capture.test.ts`, `capture-bounce.test.ts`, `handoff.test.ts`, `hardening.test.ts`, `repeat-question.test.ts`, `note-refusal.test.ts`, `dictation.test.ts`, `verdict-map.test.ts`, `action-describe.test.ts`, `gate-contract.test.ts`, `zod-state.test.ts` — worked examples covering every runner branch, the declared-verdict normalization, the standing-ask lifecycle, the ladder mechanism, the capture-bounce bound, the composed descriptions/contracts, and the stored-byte question repeat
</key_files_to_inspect>
