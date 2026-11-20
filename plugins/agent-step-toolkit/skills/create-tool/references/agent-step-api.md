# Reference: agent-step Library API

<overview>
This is the runner contract the new tool consumes. The library lives at `src/agent-step/` and is **treated as immutable**: never modify it; only call `buildAgentStepTool({...})` with the right shape. The summary below is the canonical contract — match it exactly. The ground truth is in `src/agent-step/types.ts` (authoring contracts) + `src/agent-step/index.ts` (the public surface); if this doc disagrees with those, the source wins.

Since 2.0.0 the library is laid out as phase modules — `compile/` (validate → normalize → model-facing schema/description/contract composers), `run/` (admission → planning → execution → finalize), `interaction/` (one policy module per gate kind), `controls/` (the library-owned model-facing actions), `handoff/` (contract + graph node + delegate transport). **Hosts import ONLY from `src/agent-step/index.js`** — the module layout is internal and free to move; everything a tool consumes is re-exported at the index.

Since 3.0.0 the authoring model is **declarative**: every executor outcome is a declared verdict row (`ActionDef.verdicts`), executors return the row's code plus dynamic data (`DeclaredExecutorResult`), and the engine composes the wire body, the action descriptions, the gate reply contracts, and the protocol prompt fragment from the declarations. The model-facing English the engine composes is measured surface — hosts pin it in goldens; a library upgrade that moves a composed byte owes a re-measurement.

Since 4.0.0 **every sentence has one owner, and the wire says which** (see the `registers` section): engine text is a model-facing `instruction` the engine owns outright — there is no wording override; caller-audible text is rendered by the host from state and rides `summary` / `read_back` / `ask_text`. Params declare what they are through the capture builders' field kinds, standing asks sit on the verdict row that asks, and bounded patience is universal — nothing is declared per action; its numbers are deployment-level tolerances with measured defaults and `AGENT_STEP_*` environment overrides (the `caller_digit_capture`, `standing_asks` and `escalation` sections).

Since 4.1.0 a tool can run under **required tool calling** (`tool.toolChoice: "required"`): every model turn is one call to the tool, speech is the library's `respond_to_caller` control, each call classifies the caller's turn, and a result's `continuation` decides what the next call may be (the `required_mode` section). The same release lets a verdict row declare what happens next independently of `ok` (`continuation`, `presentation`), lets a capture name a row that explains a failed validation (`invalidParamsVerdict`), and lets `note_refusal` speak its decline in the same call. Auto mode stays the default and needs none of it.
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
  handoff: handoffSpec,            // OPTIONAL — opt into the built-in request_handoff (see <handoff>);
                                   // also switches on bounded patience — the note_refusal control and
                                   // the capture-bounce escalation (see <escalation>; its numbers are
                                   // deployment-level AGENT_STEP_* tolerances, not options)
  abortPolicy: { ... },            // OPTIONAL (2.5.0) — narrow the built-in abort control to an
                                   // engine-enforced in-domain transition; omit for the legacy
                                   // permissive behaviour (see <conventions> §3)
  getCallerTurnId: (state) => id,  // OPTIONAL — stable caller-turn identity resolver (see <caller_turn_identity>)
  askContract: { categories },     // OPTIONAL (4.0.0) — the host's reply categories spliced into the
                                   // engine's standing-ask contract frame (see <standing_asks>). There
                                   // is NO override for engine text itself (see <registers>)
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
  tool: {
    name: string;
    description: string;
    toolChoice?: "auto" | "required";
                                   // (4.1.0) the tool-calling mode. Default "auto": the model answers
                                   // with text or calls the tool. "required": every model turn is one
                                   // call to this tool. See <required_mode>.
  };
  actions: Record<ActionName, ActionDef<PrereqName, T>>;
  invalidations?: Record<string, string[]>;
                                   // (4.0.0) ONE downstream-invalidation table for the whole config:
                                   // watched slot → slots reset to null when ANY executor's stateUpdate
                                   // CHANGES it. See <invalidations>.
}
```

`tool.name` becomes the LangChain tool name surfaced to the LLM (e.g. `"card_agent_step"`, `"accounts_agent_step"`).

`tool.description` is the lead paragraph — ONE semantic sentence; the library appends a per-action bullet list automatically, and the mechanics (batching, result shape, gate handshake) are engine-composed elsewhere (see `<composed_surface>`).

`tool.toolChoice` (4.1.0) selects the tool-calling mode, default `"auto"`. `"required"` is not a one-line switch: it adds the `respond_to_caller` speech control and the `turn` classification to the tool, switches the protocol fragment, and needs a hand-rolled agent node plus three assumptions about the host (OpenAI-format tool definitions, this tool as the only tool bound to the model, the exact tool object `buildAgentStepTool` returned). See `<required_mode>` before setting it.

The third type param `T` is the host state — it types each row's static `stateUpdate` (`VerdictDef<T>`), so a typo'd slot fails compilation instead of silently dropping at the patch merger.

There is **no top-level `mutations` map**. All per-action behavioural opts (confirmation / OTP / match / flow lifecycle, batch-shape flags) live inline on each action under `ActionDef.controller`. Downstream-slot invalidation is the one config-level table, `invalidations` — staleness is a fact about the slots, not about which action wrote them.

## ActionDef

```ts
interface ActionDef<PrereqName extends string, T = unknown> {
  description: string;             // non-empty; the SEMANTIC LEAD only — the engine composes the
                                   // final model-facing description (gate marker first, then this).
                                   // Never restate the gate handshake or enumerate verdicts here.
  summary?: string;                // optional one-line label for the tool-level action index. Add one
                                   // when the action NAME isn't self-explanatory to the model. Omit it
                                   // and the index just lists the action name alone.
  paramsSchema: z.ZodTypeAny;      // params the LLM must send. Declare each field with a capture
                                   // builder so it carries a FIELD KIND (see <caller_digit_capture>);
                                   // a value-shape keyword (pattern / minLength / maxLength / format)
                                   // in the model-facing schema fails construction.
  prereqs: PrereqName[];           // state predicates checked before invoking executor
  verdicts?: Record<string, VerdictDef<T>>;
                                   // (3.0.0) declared verdict rows — the executor's RESULT SPACE.
                                   // Row keys are LOOKUP codes the executor names in its return;
                                   // an undeclared verdict fails loudly, and an action with NO rows
                                   // fails construction. A row's `ask` is the standing ask that
                                   // outcome leaves behind. See <declared_verdicts>, <standing_asks>.
  satisfies?: SatisfiesSpec;       // (4.0.0) state-satisfied inputs: an EMPTY call (no capture field
                                   // supplied) may be answered from values state already carries.
                                   // See <satisfies>.
  bounceCapture?: string;          // (4.0.0) ONLY for an action with SEVERAL capture fields: the one
                                   // a malformed-capture bounce leaves owed. Derived (and forbidden)
                                   // with a single capture. See <escalation>.
  invalidParamsVerdict?: string;   // (4.1.0) key of one of this action's rows, used as DOMAIN guidance
                                   // when a call's params fail the schema parse: the `invalid_params`
                                   // result then also carries that row's `summary` (say, the length a
                                   // value must have) and body fields. See <escalation>.
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
  ok: boolean;                     // the outcome flag (StepResult.ok). With no `continuation` it also
                                   // decides the batch: false stops it and sets `failed_at`
  continuation?: "continue" | "await_caller" | { action: string };
                                   // (4.1.0) what happens NEXT, independently of `ok` — see below
  presentation?: "verbatim";       // (4.1.0) the rendered summary must be spoken exactly; it rides the
                                   // result again as `reply_text` — see below
  summary: string | ((state: unknown, data: Record<string, unknown>) => string);
                                   // the body `summary` — CALLER-AUDIBLE host text the model relays
                                   // faithfully. Static, or a renderer over the CURRENT state view
                                   // (language-keyed catalogs; the readBack division) plus the
                                   // executor's `data` (interpolated summaries)
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
  ask?: RowAsk;                    // (4.0.0) the standing ask this outcome leaves behind: "self", or
                                   // { action, param?, render? }. Omit when the outcome owes nothing.
                                   // Not allowed on a terminal row. See <standing_asks>.
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
label — ride the executor's `data`. Keep the two registers apart on the row: `summary` is what the
caller may hear; what the model should DO about the outcome is doctrine and rides a `body` field
(e.g. `reason`). Several row keys may share one wire `verdict` (via `body.verdict`)
when their summaries differ. A terminal verdict declares its `request_handoff` effect ON THE ROW, so
the handoff can never fork from the outcome `stateUpdate` writes.

The shared-module row pattern: a deterministic continuation (a step whose result space another action
owns) declares its rows on the ACTION whose result space it shares, keeping one vocabulary.

**What happens next — `continuation` (4.1.0).** `ok` says whether the outcome succeeded;
`continuation` says what the batch, and in required mode the rest of the caller turn, do after it.
The two are independent:

| `continuation` | The batch | The step | Required mode adds |
|---|---|---|---|
| omitted | runs on after `ok: true`; stops after `ok: false` | `failed_at` is set when `ok` is false | nothing |
| `"await_caller"` | stops here | keeps its `ok` — a successful question is not a failure (`failed_at` only when `ok` is false) | the next call of this caller turn must be the sole `respond_to_caller` step |
| `{ action }` | stops here | keeps its `ok` | the next call of this caller turn must be that action, as its sole step, before any speech |
| `"continue"` | runs on even though `ok` is false | `ok: false` with NO `failed_at` — a negative informational read | nothing |

The declared value rides the result as `continuation` in both modes. Construction rejects a value
that is not one of the three forms or names an unknown action; a `continuation` other than
`"await_caller"` on a row that declares an `ask`; and any `continuation` on a `backendFailure` row or
a row carrying a `request_handoff` effect. Reads stay repeatable and batchable by default — declare
a continuation only where the flow really has a boundary.

**Exact speech — `presentation: "verbatim"` (4.1.0).** Marks the rendered `summary` as text the
caller must hear exactly; the result carries it again as `reply_text`. In required mode the model
presents it through the `{reply_text}` placeholder and the engine refuses a reply that omits or
alters the bytes (`<required_mode>`); in auto mode the field rides the result and nothing enforces
it. Pair it with `continuation: "await_caller"` when the summary is a QUESTION: it then stays visible
as the unanswered question through conversational asides — but the engine stores no gate for it, so
it is re-asked by speech and `repeat_pending_question` does not serve it. Never set it on a row
whose summary is an instruction to the model.

`continuation` and `reply_text` are ENGINE-OWNED result fields: a row `body` key under either name
fails construction, and a `resultExtras` key under either name fails the step loudly.

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
                                   // the generic reply contract does not select. (4.1.0) In required
                                   // mode it also enables the speech control's reply kinds
                                   // (`clarification` / `choice`) at this gate — see <required_mode>.
  replyContract?: GateContractSpec;// (3.0.0) replace the runner's generic `reply_contract` on THIS
                                   // action's proposals with an engine-COMPOSED action-specific one.
                                   // See <gate_contracts>.
  refuseProposal?: (params: Record<string, unknown>, state: unknown)
    => { verdict: string; data?: Record<string, unknown> } | null | undefined;
                                   // (2.5.0) propose-time, STATE-aware refusal. Runs on the
                                   // propose/re-propose path AFTER params parse and BEFORE anything
                                   // commits: no gate stored, no attempt spent. (4.0.0) Return the
                                   // DECLARED verdict row that answers (plus the `data` its function
                                   // fields read) to refuse; null/undefined to proceed.
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
the executor's own consumption rule so the two can never disagree. The refusal is a ROW like every
other outcome — the body, its register and its standing ask come from the declaration, not from a
hand-built object.

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

Empty/omitted keeps the runner's generic template (`ENGINE_TEXT.confirm_reply_contract`). A
non-empty spec is the SOLE authority for that action — the generic template is not concatenated, so
declare every reply class you want handled, including the generic yes/correction ones (the frame's yes
clause covers the yes). A snake_case name in double quotes inside a category must be a declared action
or control — construction fails otherwise (write wire fields in backticks).

## Verifier

```ts
interface Verifier<T> {
  check: (state: T) => boolean;
  denial: { instruction: string; error: string };
}
```

Self-contained: the predicate AND the denial body live together in one file. The denial body is what appears in the result envelope when the prereq fails. Its `instruction` is **model-facing host doctrine** in English (`Run "verify_customer" first.`) — it tells the model what to do, never the caller what to hear, and rides the refused entry's `instruction` field (see `<registers>`).

The `check` predicate is a snapshot of **journey progress** — "is the user identified?", "is an entity selected?" — not a record of step ordering. Gate on *where the user is*, never on *what ran first*. The companion mechanism for keeping that progress coherent when an upstream slot changes is the config-level `invalidations` table (see `<invalidations>` below).

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
type Executor<Slice, T> = (
  params: unknown,
  state: Slice,
  source?: SatisfiedSource,        // (4.0.0) the resolved state-satisfied bundle when this was an
                                   // EMPTY call answered from state (ActionDef.satisfies); absent on
                                   // dictated calls. Ignore it unless the action declares `satisfies`.
) => Promise<DeclaredExecutorResult<T>>;

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
      expects: "digits" | "text"; ask_text?: string; flow_ref?: string }
                                              // the STANDING ASK — a verdict row asked the caller for a
                                              // fresh value (VerdictDef.ask), or a capture bounced. A
                                              // record, not a gate: it does NOT lock the surface.
                                              // `ask_text` holds the host-rendered ask bytes (when the
                                              // row's ask declares `render`) so the repeat control can
                                              // re-present them exactly. See <standing_asks>.
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

## spentLadders (library-managed)

The bounded-patience latch: `Record<string, number> | null` with three FIXED keys — `bounce`
(consecutive unusable captures), `escalation` (free in-place explanations spent) and `malicious`
(misuse attempts). Nothing is named or configured. `bounce` and `escalation` RESET ON PROGRESS — any
call whose params parse clears them — so friction is counted consecutively; `malicious` is cumulative.
Task-scoped on top of that: a task-ending handback clears the slot; an `off_topic` roundtrip does not.
The runner is the only writer. (The slot name is historical: through 3.x it held a per-ladder
free-use map.) See `<escalation>`.

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

The pending channel-handoff request, written by the built-in `request_handoff` action (only available when the tool opted in via `BuildAgentStepToolOptions.handoff`), by a `request_handoff` **effect** (on a verdict row or an executor return), or by the engine itself (an exhausted escalation, the third misuse attempt, the auto-handoff) — never through `stateUpdate`, which throws. Resolved — then cleared — by the host graph's `createHandoffNode(spec)` node. `null` otherwise; rides `agentStepZodShape` like the other slots. Once set, handoff is **monotonic**: the step's remaining interaction lifecycle is skipped and the batch ends after the current step. See `<handoff>`.

```ts
interface HandoffRequest {
  reason: "off_topic" | "completed" | "abandon";
  context: string;  // per-reason, never empty. ROUTING METADATA — never spoken:
                    // off_topic → the customer's request (verbatim or tightly summarized, in
                    //   their language) for the receiving agent;
                    // completed / abandon → a short note of what was done / why, or a host
                    //   routing label; the HOST renders the spoken closing from state
                    //   (HandoffSpec.resolveClosingMessage).
                    // Engine-decided endings carry STRUCTURAL codes: AUTO_HANDOFF_CONTEXT
                    //   ("auto_handoff"), escalationContext(action)
                    //   ("agent-step:escalated[:<action>]"), MALICIOUS_CONTEXT
                    //   ("agent-step:malicious").
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
  config: myConfig,               // tool name + actions — gate presence, row asks and capture
                                  // fields are read from each action's declaration
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

The fragment follows the tool's calling mode (4.1.0): with `config.tool.toolChoice: "required"` it
composes the required-mode protocol — speech through `respond_to_caller`, `continuation`, the
READ-BACK placeholders — in place of the tool-turn / speaking-turn text (see `<required_mode>`). In
either mode it names a control, or a reply kind, only when the tool surface carries it.

**The standing-ask contract** (`compile/ask-contract.ts`, exported as `composeAskContract`): the
`ask_contract` riding every entry that records a standing ask — an engine frame around the host's
`askContract.categories`. See `<standing_asks>`.
</composed_surface>

<registers>
## Registers — who owns each sentence (4.0.0)

Every string on the wire has exactly one owner, and the FIELD it rides says which:

| Field | Owner | What the model does with it |
|---|---|---|
| `summary` (a verdict row's), `read_back`, `ask_text` | the HOST, rendered from state (`VerdictDef.summary`, `ConfirmationOpts.readBack`, a row ask's `render`) | relays the bytes faithfully — this is what the caller hears |
| `reply_text` (4.1.0) | the HOST — a `presentation: "verbatim"` row's rendered `summary`, repeated | speaks it exactly; in required mode the engine inserts it through the `{reply_text}` placeholder and refuses a reply without it |
| `summary` on a SPOKEN result (4.1.0: `respond_to_caller`; a `note_refusal` that declined in place with its `reply`) | the MODEL composed it; the engine validated it and inserted any fixed bytes | nothing more — in required mode the agent node delivers it as the reply (`turn_complete: true`) |
| `instruction` | the ENGINE (`engine-text.ts`) — or host model-facing doctrine on a prereq denial (`Verifier.denial.instruction`) | FOLLOWS it, composing any caller line it calls for in the session language. Never spoken verbatim |
| `reply_contract`, `ask_contract`, `read_back_directive` | engine frame + host content through a structured seam (`GateContractSpec`, `AskContractSpec`, `readBackDirective`) | classifies the caller's next reply / frames the read-back |
| handoff closing | the HOST (`HandoffSpec.resolveClosingMessage`) | nothing — the platform delivers it; the model produces no text |

A result entry carries `summary` OR `instruction`, with two exceptions: a match-gate exhaustion
strips the row's `summary` when the engine's exhaustion instruction replaces it, and (4.1.0) an
`invalid_params` bounce on an action that names an `invalidParamsVerdict` carries BOTH — that row's
`summary` is the domain guidance, the engine `instruction` directs the re-ask, and the batch mirror
takes the instruction. Engine-raised entries — admission refusals, prereq denials, proposals, control
results, `invalid_params`, `executor_error`, the empty batch — carry `instruction`; the one control
result that carries `summary` is a SPOKEN one (the table above), where `summary` is the reply itself.
The batch body mirrors its last entry:

```ts
interface RunnerResultBody {
  summary?: string;       // the batch ended on a host caller-audible summary
  instruction?: string;   // the batch ended on an engine directive
  results: StepResult[];
  failed_at?: number;
}
```

**There is no wording override.** The 1.x–3.x `messages` option (`SystemMessages`) is gone: engine
text is English instruction and needs no localization, because it is never spoken. `ENGINE_TEXT`,
`formatMessage` and `EngineTextKey` are exported for goldens and tests only. If a caller must hear
specific words on some path, a host renderer over state produces them (a row `summary`, a row ask's
`render`, the closing table). Hosts EXTEND engine frames through the structured seams above — content
extension, never wording replacement.

Engine text on capture paths is count-free by construction (no numerals, no "digit"/"attempt"): a count
in a capture message measurably makes the model pad digits. Keep host refinement messages count-free
for the same reason. A fact about a value's shape (its length, say) has exactly ONE legal carrier: the
`summary` of an `invalidParamsVerdict` row (4.1.0), which reaches the model only AFTER a capture was
rejected — never the schema, a field description or the prompt.

`_debug` (raw Zod issues, executor throw text) never reaches the model: `buildAgentStepTool` strips it
from the `ToolMessage` content and carries it on the message's `artifact` (`{ debug: string[] }`) —
trace-visible, model-invisible. `runSteps` (the test seam) still returns it on the body.
</registers>

<standing_asks>
## Standing asks / dictation

The plainest input kind — "the customer owes a fresh value" — declared ON the verdict row whose
outcome asks the question (`VerdictDef.ask`), applied by the batch finalizer, and made visible to the
model on the final entry. Unlike the three gates it does NOT lock the surface: it is the engine's
record of the standing question; capturing the answer remains the MODEL's job (deterministic
caller-turn interception was built, measured live, and removed — the engine must never fabricate
assistant turns).

```ts
type RowAsk =
  | "self"                         // re-ask THIS action's own capture — the common case
  | {
      action: string;              // target action the customer's value feeds (must exist) — how one
                                   // step chains to the next ("the name was accepted; now the digits")
      param?: string;              // ONLY when the target declares SEVERAL capture fields; otherwise
                                   // the sole one is used
      render?: (state: unknown) => string | undefined;
                                   // render the caller-audible ask ITSELF (language/lexicon live in
                                   // state — the readBack division). A non-empty return rides the
                                   // final entry as `ask_text`, and the ask contract directs the model
                                   // to speak it EXACTLY — engine-rendered bytes are how fixed
                                   // sentences stay verbatim (a model reciting a catalog line from
                                   // prompt memory measurably decorates it; measured 2/8 prompt-side
                                   // vs 8/8 on the wire). Omit for asks whose wording the model may own.
    };
```

```ts
verdicts: {
  not_a_name:     { ok: false, summary: …, body: { verdict: "not_a_name" }, ask: "self" },
  ask_for_digits: { ok: false, summary: …, body: { verdict: "ask_for_digits" },
                    ask: { action: "verify_card" } },
}
```

What is deliberately NOT declared: `param` (defaults to the target's sole capture field) and
`expects` (derived from that field's kind — see `<caller_digit_capture>`). An ask's target must
declare a caller-CAPTURE field (`digits` / `text`); a judged or relayed param cannot be dictated, and
construction says so.

Lifecycle — the batch's FINAL entry decides (`ok:false` short-circuits, so the last entry is exactly
what the model relays):

- Final entry came from a ROW that declares `ask` → the resolved ask becomes
  `awaitingInput = { kind: "dictation", for_action, param, expects, ask_text? }`, and the entry is
  stamped with `standing_ask: { action, param }`, `ask_contract`, and `ask_text` when `render`
  returned bytes.
- Final entry came from a ROW with no `ask` → a dictation standing for THAT action was serviced; it
  clears. A dictation for a DIFFERENT action stands (the caller still owes the value).
- Final entry was RAISED BY THE RUNNER (a denial, a lockdown refusal, a cached page) → never a
  servicing; the record stands. The one that implies an ask is the capture bounce: an
  `invalid_params` entry re-asks the bouncing action's own capture field, **derived** — never
  declared. (An action with several capture fields names the owed one with `bounceCapture`; without
  it the bounce records no ask.)
- A live GATE always outranks an ask: a confirmation/OTP/match set or left standing by the batch IS
  the standing question; asks never stomp it. Skipped entirely on a handoff — which is why a row
  carrying a `request_handoff` effect may not declare an ask (construction fails).

**The ask contract.** `ask_contract` is composed once (`composeAskContract`): the engine owns the
frame — the owes-value lead with the `ask_text` exactness rule, the supply clause (`{action}` /
`{param}` routing), the repeat-is-still-the-value clause, and the closing re-ask-style clause — and
the host owns the measured domain reply categories in between:

```ts
buildAgentStepTool({
  …,
  askContract: {
    categories: [
      // complete sentences, joined verbatim in order. A snake_case name in double quotes must be a
      // declared action or control (construction lints it); write wire fields in backticks.
      'If they ask to cancel instead, call "abort_pending_input".',
    ],
  },
});
```

Omit `askContract` to keep the generic frame. An empty `categories` array is an error.

Two frame clauses were reworded in 4.1.0 (measured surface — goldens move). The supply clause now
says a reply that supplies ALL OR PART of the value goes to the action, which validates it, while a
reply that supplies no new value (a pause, a decline, a pivot, a question) is handled per the host's
instructions. The re-ask-style clause now covers only re-asks the MODEL composes — one short question,
accepting the caller's dictation style without prescribing a pace or grouping; engine-stored questions
stay under READ-BACK.

**Repeating an ask.** When the row's ask declares `render`, the rendered bytes are stored on the
dictation record (`ask_text`), and the `repeat_pending_question` control re-presents them exactly
(`ask_repeated: true`, `read_back` = the stored ask) instead of refusing as ineligible. An ask with
no stored bytes (the model composed it) is re-asked by speech.

In required mode a conversational aside keeps the ask visible: the speech result's `awaiting` record
carries the ask's `ask_contract` and, when stored, its bytes as `question` (see `<required_mode>`).
</standing_asks>

<escalation>
## Bounded patience — capture bounces + note_refusal (4.0.0)

One latch, nothing to declare. The engine counts how long a caller has gone without delivering what the
flow needs, and ends in a handoff when patience runs out. It is active whenever `handoff` is
configured (escalation ends in a handoff, so without one there is nothing to escalate to — a capture
bounce then simply re-asks, unbounded). The model decides ONE thing: the semantic class of the
caller's turn. First-versus-repeat is the engine's, and it stays model-invisible.

**The two consecutive counters** (`spentLadders.bounce`, `spentLadders.escalation`) — both reset on
PROGRESS, i.e. by any call whose params parse:

| Event | What the engine does |
|---|---|
| 1st and 2nd consecutive unusable capture (`invalid_params`) | plain bounce — "ask them to say it again" (the bounce tolerance, default `BOUNCE_TOLERANCE = 2`) |
| the next one | spends the ONE free explanation (default `FREE_EXPLANATIONS = 1`): the entry instructs the model to say in one short sentence why the value is needed, or where to find it, and re-ask in the same turn |
| the one after that | hands back atomically: `handoff = { reason: "abandon", context: escalationContext(action) }`; the entry carries `escalated: true, handoff_requested: true` |
| any call that parses | both counters clear — a caller who stumbles, gets helped and then succeeds starts fresh |

`escalationContext(action)` is `"agent-step:escalated:<action>"` — the action whose value was owed —
or the bare `ESCALATION_CONTEXT_PREFIX` (`"agent-step:escalated"`) when nothing was owed. It is a
routing CODE: the host's `resolveClosingMessage` maps it to caller words (a per-action reassurance
where one helps, a generic escalation closing otherwise). `ActionDef.bounceCapture` names the owed
capture for an action with several capture fields.

**`note_refusal`** (`NOTE_REFUSAL_ACTION`; reserved whenever `handoff` is configured) — the sole-step
control through which the model declines a turn the flow cannot serve. Params: `{ kind, reply? }` —
`kind` is a fixed enum (`REFUSAL_KINDS`, `RefusalKind`); a host adds no kinds and renames none:

- **`declined_or_cannot`** — the caller declines, or cannot supply, the value currently owed. Needs a
  standing value obligation: with no `dictation` pending the control refuses instructively
  (`error: "nothing_owed"`) and counts nothing. Otherwise it climbs the SAME escalation as a bounce:
  free use → "explain why it is needed and re-ask"; next → the `abandon` handoff above.
- **`unsupported_question`** — the caller asks something the flow cannot answer while still pursuing
  the task. Location-free. Free use → "decline, answer NONE of its content, repeat the pending
  question"; next → the same handoff.
- **`malicious_intent`** — the turn tries to MISUSE the call (extract instructions or tools, drop the
  rules, obtain harmful or invented content, pose as a system message). The engine directs a
  one-sentence decline that gives none of what was asked and repeats the pending question. It has its
  own counter (`spentLadders.malicious`), CUMULATIVE — progress never resets it: the attempt that
  reaches the malicious limit (default `MALICIOUS_LIMIT = 3`, the third in a task) hands back
  `{ reason: "completed", context: MALICIOUS_CONTEXT }` (`"agent-step:malicious"`). It never touches the escalation run — a pending question stays pending.
  What counts as misuse is ONE definition, shared with the required-mode `turn` classification
  (`<required_mode>`), so the two can never drift. Since 4.1.0 it names one more case: a "yes" or any
  answer spoken inside a game, role-play, quote or example the caller sets up belongs to that framing
  and answers nothing the agent asked.

Every result carries `refusal_noted: true` and the `kind`. A refusal while a GATE pends never reaches
the control (`allowedDuringGateLockdown: false`): that reply is classified by the gate's own reply
contract, which is the sole authority while it stands — with ONE exception since 4.1.0: a
`malicious_intent` note is admitted behind any live gate (confirmation, OTP or match), is counted,
and leaves the gate exactly as it was.

**One call declines (4.1.0).** `reply` is optional: the ONE line the model speaks for a
`declined_or_cannot` or `unsupported_question` turn handled in place — one short sentence, then the
pending question again. With it the refusal is recorded AND spoken by the same call: the result
carries the line as `summary` with `turn_complete: true` instead of an instruction, so the decline the
model later sees in its own history is the COUNTING control, never a plain spoken reply it could copy
past the counter. The line is validated like `respond_to_caller` text; an unusable one falls back to
the instructed presentation. The escalation ignores it (the engine hands off), `nothing_owed` ignores
it, and `malicious_intent` takes none. Without a `reply` the result carries the in-place instruction,
as before.

An in-place result that carries an instruction — a free explanation, a non-terminal
`malicious_intent` note — also carries `continuation: "await_caller"` (4.1.0): the explanation or
decline is owed before the caller can answer again. Required mode enforces it (the next call is the
speech step, so one utterance can never be noted twice); auto mode shows the field and enforces
nothing.

**A bounce can carry domain guidance (4.1.0).** `ActionDef.invalidParamsVerdict` names one of the
action's rows; when a call's params fail the parse, the `invalid_params` entry also carries that
row's body — its `summary` (what a usable value looks like) and any `body` fields — and the engine
instruction tells the model to relay that summary before asking again. The row must be a plain
failure row: `ok: false`, no `stateUpdate`, `effects`, `ask` or `backendFailure`, and no continuation
other than `"await_caller"`. The error code, the bounce count and the derived standing ask stay the
engine's; without the option the bounce stays generic ("it did not come through").

The host prompt teaches only the classification — and never counts ("once", "the second time"): the
control's own schema description carries the three kinds and when each applies. The host's part is the
CLOSING for each engine-decided ending (see `<handoff>`).

### Tolerances — the numbers, and how a deployment moves them {#tolerances}

The table above shows the DEFAULTS. The four numbers that bound the engine's patience are process-wide
**tolerances** (`tolerances.ts`): measured defaults, each movable per deployment through an environment
variable the ENGINE reads — no host wiring, no build option, nothing per action or per tool.

| Variable (`TOLERANCE_ENV`) | Default (constant) | Range | What it bounds |
|---|---|---|---|
| `AGENT_STEP_BOUNCE_TOLERANCE` | 2 (`BOUNCE_TOLERANCE`) | integer ≥ 0 | consecutive unusable captures answered with the plain bounce before the engine explains itself (0 = explain on the first) |
| `AGENT_STEP_FREE_EXPLANATIONS` | 1 (`FREE_EXPLANATIONS`) | integer ≥ 0 | in-place explanations (an over-tolerance bounce, or a `declined_or_cannot` / `unsupported_question` refusal) before the `abandon` handback (0 = hand back at once) |
| `AGENT_STEP_MALICIOUS_LIMIT` | 3 (`MALICIOUS_LIMIT`) | integer ≥ 1 | the `malicious_intent` attempt that ends the task |
| `AGENT_STEP_ERROR_HANDOFF_THRESHOLD` | 3 (`ERROR_HANDOFF_THRESHOLD`) | integer ≥ 1 | consecutive backend-failure batches before the automatic handoff (see `<auto_handoff>`) |

- **Read once, at construction.** `buildAgentStepTool` resolves the tolerances when the tool is built and
  closes over them (`CompiledPlan.tolerances`): a running process never changes its bounds
  mid-conversation, and a changed variable takes effect on the next start. (`runSteps`, the test seam,
  compiles per call and so re-reads per call.)
- **Fails loudly.** Unset or blank means the default. A value that is set but is not a plain base-10
  integer within range throws at construction — `agent-step: AGENT_STEP_… must be an integer >= N (got
  "…")` — so a typo stops the boot instead of silently changing a bound.
- **One explicit override.** `BuildAgentStepToolOptions.errorHandoffThreshold` wins over its variable —
  a host that pins the threshold in code keeps it (the variable is still validated). The other three
  have NO option on purpose: they are a property of the deployment, not of a tool.
- **Model-invisible.** No engine text carries a count, so moving a tolerance moves no model-facing byte
  (descriptions, contracts, the protocol fragment, every `instruction`): goldens hold. What moves is
  behaviour — the defaults are MEASURED (three plain bounces was seen to make the model improvise on the
  third identical failure), so a deployment that moves them owes its own live measurement, and a very
  large value effectively switches that bound off.
- **Inspectable.** `resolveTolerances(env?, { errorHandoffThreshold? })` is exported (with
  `DEFAULT_TOLERANCES`, `TOLERANCE_ENV`, `EngineTolerances`) so a host can log the effective values at
  boot or assert them in a test. Per-action budgets — a confirmation's or a match's `maxAttempts` —
  are configuration and are NOT tolerances.
</escalation>

<required_mode>
## Required tool calling (`tool.toolChoice: "required"`) — 4.1.0

By default (`"auto"`) the model either calls the tool or answers the caller with text. Under
`"required"` **every model invocation makes exactly one call to the agent-step tool**, and nothing the
caller hears is free assistant text:

- **Speech is a control.** The library injects `respond_to_caller` (`RESPOND_TO_CALLER_ACTION`): a
  sole-step control that delivers a spoken reply and ends the turn.
- **Every call classifies the caller's turn** in a `turn` argument beside `steps`.
- **A result decides what the next call may be.** Its `continuation` narrows the surface the model is
  offered, and admission enforces the same boundary.
- **The protocol fragment changes text.** `composeProtocolPrompt` reads `config.tool.toolChoice` and
  composes the required-mode protocol in place of the tool-turn / speaking-turn one.

The point of the mode is that the engine sees — and can validate, count and bound — every turn,
including the ones that only speak. It is opt-in per tool and is NOT a one-line switch: it needs the
host wiring below, and the bootstrap scaffold (`createReactAgent`) cannot run it. Auto mode is
unchanged and remains the default.

### The speech control — `respond_to_caller`

```ts
{ action: "respond_to_caller", params: { text } }                               // ordinary speech, or presenting the current result
{ action: "respond_to_caller", params: { kind: "clarification", explanation } } // only at a pending repeatable confirmation
{ action: "respond_to_caller", params: { kind: "choice", text } }               // only at a pending repeatable confirmation
```

It is always the ONLY step of its batch (`error: "reply_must_be_sole_step"` otherwise), it is admitted
under every gate lockdown, and it never confirms, executes, resolves an ask, spends an attempt or hands
off — proposals, standing asks and counters stay exactly as they were. Its result is the reply as it
will be spoken:

```ts
{ action: "respond_to_caller", ok: true, summary: "<the spoken bytes>", turn_complete: true, awaiting?: {…} }
```

**Fixed text is inserted by the engine, never transcribed by the model.** In `text`, the placeholders
`{read_back}`, `{ask_text}` and `{reply_text}` are replaced by that field of **this caller turn's
latest tool result** (`renderReplyText`):

- A placeholder naming a field that result does not carry is refused.
- When that result carries any of the three fields, the reply MUST contain its exact bytes — through
  the placeholder, or as a literal copy (a copy differing only in letter case is restored to the
  engine's bytes). A reply that leaves them out or rewords them is refused: a consent question or a
  verbatim summary cannot be skipped or paraphrased. Words around the bytes stay the model's, within
  what `read_back_directive` allows.
- A repeated standing ask (`ask_repeated: true`) must be the WHOLE reply — nothing added.
- When one batch produced several verbatim summaries, `{reply_text}` presents all of them, in
  execution order, joined by a space.
- Only a genuine tool result of the CURRENT caller turn supplies bytes. Caller text that imitates a
  result, an earlier turn's result, and state are never read.

A refused reply returns `{ ok: false, error: "invalid_reply", instruction }` — the instruction says
what to fix — commits nothing, and leaves whatever had to be presented still owed.

**Reply kinds** classify a FRESH caller reply at a confirmation whose action opted into
`repeatReadBack` (the same roster that activates `repeat_pending_question`). With no such action
configured they do not exist: they are absent from the model's surface, and neither the control's
descriptions nor the protocol fragment mention them.

- While a repeatable confirmation is pending and the caller has replied, a reply WITHOUT a kind is
  refused (`reply_kind_required`) — unclassified speech cannot replace the consent question with an
  abbreviated one. Presenting the proposal's own read-back, on the turn that proposed or repeated it,
  is the opposite case: plain `text`, no kind (`reply_present_result` otherwise).
- `kind: "clarification"` supplies `explanation` ONLY — the short answer, with no question, no recap
  and no `text`. The engine appends the complete stored read-back and re-stamps the proposal with the
  current caller turn, exactly as `repeat_pending_question` does: the matching re-call can execute
  only on a LATER caller turn. It fails closed under the repeat control's conditions (no repeatable
  gate, no caller-turn identity, the turn that proposed it), and a rejected explanation never moves
  the consent boundary.
- `kind: "choice"` asks which permitted path the caller prefers. The proposal stays pending,
  unchanged; nothing is appended.
- Confirmations of actions that did NOT opt in are answered with plain `text`.

**`awaiting` — the unanswered question survives an aside.** A speech result carries the public cursor
of what is still unanswered, so the next caller reply is classified against the right contract even
though a speech result sits between it and the result that asked:

| What is pending | `awaiting` on the speech result |
|---|---|
| a confirmation / OTP / match gate | `{ kind, for_action }` — plus, for a confirmation, the action's compiled `reply_contract` |
| a standing ask | `{ kind: "dictation", for_action, param, question?, ask_contract }` — `question` is the stored `ask_text` when the ask rendered one |
| an ungated verbatim question (a `presentation: "verbatim"` + `continuation: "await_caller"` row) | `{ kind: "question", for_action, question }`, carried from reply to reply until a later domain result supersedes it |

It never exposes proposal params, identity data or counters.

### The turn classification — `turn`

Every model-facing surface requires `turn` (`TURN_FIELD`), listed before `steps`: `"service"`
(`TURN_SERVICE`) or `"misuse"` (`TURN_MISUSE`). Its description carries the ONE misuse definition, the
same sentence the `malicious_intent` refusal kind uses. Asking the question on every call — before
any step is chosen — is what makes misuse judged at a consent gate, where the latest result frames
every available step as a consent option (an optional refusal step measurably lost to that framing).

- **`"misuse"` on the FIRST call of a caller turn** (no tool result since the latest caller message):
  the runner records `note_refusal { kind: "malicious_intent" }` IN PLACE of whatever steps came with
  it — the counter, the decline instruction and the termination are those of `<escalation>`. The
  steps may be empty.
- **A later call of the same caller turn never classifies again**, so one utterance is never counted
  twice — whatever `turn` that call carries.
- The wrapper schema leaves `turn` optional (a direct or stale call without it runs as sent); the
  model's surface requires it on every call, narrowed presentation calls included, because the model
  copies the shape of its own recent calls.
- An EMPTY batch that is not a misuse turn is refused (`error: "empty_batch"`, instructive).

### What a result requires next — `continuation`

A result's `continuation` is a contract about the REST OF THIS CALLER TURN:

| `continuation` on the latest result of this caller turn | Next call must be |
|---|---|
| `"await_caller"` | the sole `respond_to_caller` step — present the result and wait for a new caller answer |
| `{ action }` | that action, as the sole step, before any speech |
| `"continue"`, or none | whatever the caller's request calls for |

It comes from three places:

- **A verdict row** that declares it (`VerdictDef.continuation` — see `<declared_verdicts>`).
- **The engine, in required mode:** a proposal or re-proposal (which also ENDS the batch there, so a
  later step cannot open a second gate over it), any final entry carrying `read_back`, and an
  `invalid_params` bounce that left a standing ask — all `"await_caller"`.
- **The engine, in both modes:** a free in-place explanation and a non-terminal `malicious_intent`
  note — `"await_caller"`: the explanation or decline is owed before the caller can answer again.

A standing ask ALONE is not a boundary: the caller may already have volunteered the next value, and
the model may send it in the same turn.

Enforcement is doubled, from one contract:

1. **The surface** — `modelToolsForTurn(tools, messages)` returns, for that one invocation: only the
   text-only speech step (`strict`) after `"await_caller"`; only the named action after `{ action }`;
   otherwise the full surface, scoped — reply kinds only while a repeatable confirmation is pending,
   sole-step controls in their own one-item alternative, `turn` required, at least one step. When an
   `abortPolicy` declares `allowedFollowers`, a pending locking confirmation is also reduced to what
   its lock admits: the pending action, the gate-admissible controls, and those followers.
   `note_refusal` is not offered there — misuse at a gate arrives through `turn`.
2. **Admission** — a batch that is not the single required step is refused with
   `error: "continuation_required"`, for a call that arrives outside that surface.

Only genuine tool results since the latest caller message impose a boundary; the next caller message
restores the full surface, including the human-handoff override. A mechanical refusal (an entry with
an `error` and no verdict, read-back, ask or continuation) does not consume the boundary before it —
the model corrects and the same presentation is still owed. A result written before 4.1.0 that
carries `read_back` and no `continuation` is treated as `"await_caller"`.

In AUTO mode none of this is enforced across calls: a declared `continuation` stops or continues the
BATCH and rides the result as a field, nothing more.

### Repeating a question

`repeat_pending_question` serves what the engine STORES: a repeatable confirmation's read-back, and a
standing ask's rendered `ask_text` (shown as `ask_text` on the result that asked, and as
`awaiting.question` on the speech results after it). An ungated verbatim question lives in the
transcript alone — the engine stores no gate for it — so it is re-asked by SPEECH, and the repeat
control refuses it (`repeat_confirmation_not_available`), leaving it standing. The protocol fragment
names the repeat control and the reply kinds only when some action opts into `repeatReadBack`, so the
prompt never sends the model to a control its tool does not carry.

**Two mechanisms, and the reply's content picks one.** The stored question and NOTHING else goes
through `repeat_pending_question`: its result forbids added words, and that refusal is the only thing
that holds a reply to the unchanged question. Anything of the model's own first — a reassurance, a
short answer — is speech, and the model then re-asks in its own words. The host's reply and ask
contracts decide which of the two a given caller reply calls for; the two are not redundant.

**Known limit.** The fragment's repeat sentence names `awaiting.question` without saying whose it
is, so it also matches the record of an ungated verbatim question — which the control refuses. The
refusal is recoverable: the same caller turn re-asks by speech, at the cost of one extra model round
and nothing audible. The sentence is measured surface and is deliberately left as it is: narrowing
its field list, reducing it to a pointer at the contracts, and folding ask repetition into speech
were each measured, and each moved other replies off the right mechanism (the numbers sit beside
the sentence in `compile/protocol.ts`). Do not reword it in a host prompt either.

### Host wiring

The graph needs no speech node. The agent node does three things the `createReactAgent` scaffold
cannot, so required mode replaces `src/agent.ts` with a hand-rolled graph:

```ts
import { MemorySaver, StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { AIMessage } from "@langchain/core/messages";
import { AgentStateSchema, type State } from "./state.js";
import { buildPrompt } from "./prompt.js";
import { tools } from "./tools/index.js";
import { myConfig } from "./tools/my_tool/config.js";
import { handoffSpec } from "./handoff-spec.js";
import {
  completedReply, modelToolOptions, modelToolsForTurn, toolOnlyMessage,
  createHandoffNode, handoffRequested, HANDOFF_NODE,
} from "./agent-step/index.js";

export function createAgent() {
  const model = /* the chat model, built as in the scaffold */;

  async function agentNode(state: State): Promise<Partial<State>> {
    const messages = state.messages ?? [];
    // 1. A completed spoken turn: deliver the reply the model already handed to
    //    the speech control. NO model call.
    const reply = completedReply(messages);
    if (reply) return { messages: [reply] } as Partial<State>;
    // 2. Otherwise exactly one model call, bound to THIS invocation's surface.
    //    Same tool objects every time; never cache the bound model.
    const bound = model.bindTools(
      modelToolsForTurn([...tools], messages) as never,
      modelToolOptions(myConfig),       // { tool_choice: "required", parallel_tool_calls: false }
    );
    const response = await bound.invoke(buildPrompt(state), { tags: ["langsmith:nostream"] });
    // 3. Keep the tool call, drop any incidental prose; throws unless the
    //    response is exactly one valid tool call.
    return { messages: [toolOnlyMessage(response)] } as Partial<State>;
  }

  const routeAfterAgent = (state: State): "tools" | typeof END => {
    const last = (state.messages ?? []).at(-1) as AIMessage | undefined;
    return (last?.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  };
  const routeAfterTools = (state: State): typeof HANDOFF_NODE | "agent" =>
    handoffRequested(state) ? HANDOFF_NODE : "agent";

  return new StateGraph(AgentStateSchema)
    .addNode("agent", agentNode)
    .addNode("tools", new ToolNode(tools as never))
    .addNode(HANDOFF_NODE, createHandoffNode<State>(handoffSpec))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addConditionalEdges("tools", routeAfterTools, [HANDOFF_NODE, "agent"])
    .addEdge(HANDOFF_NODE, END)
    .compile({ checkpointer: new MemorySaver() });
}
```

| Helper | What it does |
|---|---|
| `completedReply(messages)` | The spoken reply to deliver, or `null` when the model must be called. Non-null only when the LAST message is the tool result of a completed spoken turn (`respond_to_caller`, or a `note_refusal` that declined in place with its `reply`). Returns an `AIMessageChunk` on purpose: a streaming channel forwards chunks and may skip consolidated AI messages. |
| `modelToolsForTurn(tools, messages)` | The tool surface for ONE model invocation (see above). Call it on every invocation with the full message list. An auto-mode tool is returned unchanged. |
| `modelToolOptions(config)` | The bind options: `tool_choice` from `config.tool.toolChoice` (default `"auto"`) and, in BOTH modes, `parallel_tool_calls: false` — sibling calls would each read the same state snapshot, and a pending confirmation could execute twice. |
| `toolOnlyMessage(response)` | The response reduced to its tool call (ids, usage metadata kept). Throws when it is not exactly one valid tool call; the host owns the retry policy. |
| `renderReplyText(text, messages)` | What a `respond_to_caller` text becomes once spoken — the pure seam the control and a prompt-input harness share. Throws the engine instruction a refused reply would carry. |

After the tool node the graph returns to `agent` either way: that pass is what lets step 1 deliver
the reply and end the turn. A handoff still ends through the handoff node, with no model call after
the tool result.

**The `langsmith:nostream` tag** keeps the model's own bytes off LangGraph's `messages` stream — the
tool call it streams and any prose beside it — so the channel receives only completed speech or a
resolved handoff closing. It does not silence `streamEvents`: a consumer of that API still receives
`on_chat_model_stream` events for the call and must ignore their content in required mode (the
scaffold CLI does). See `streaming-and-channel-contract.md` for what the channel observes.

### What the mode assumes of the host

The library checks none of these, and most violations do not throw — the surface silently stops being
narrowed:

- **OpenAI-format tool definitions.** A narrowed surface is emitted as
  `{ type: "function", function: { …, strict } }` and `modelToolOptions` returns the OpenAI bind
  options. The chat model must accept such definitions in `bindTools` and honour `strict` on the
  presentation-only surface.
- **One agent-step tool, and no other tool, bound to the model.** The transcript readers take the
  caller turn's latest tool message to be an agent-step result, and `toolOnlyMessage` requires
  exactly one tool call. A second tool could satisfy `tool_choice: "required"` without agent-step,
  and its result would hide the one that owns the turn's continuation.
- **The exact tool object `buildAgentStepTool` returned.** The reply scope — which gates accept reply
  kinds, which controls are sole steps, what a locked gate offers — is registered against that
  object's identity. A wrapped, cloned or re-created tool comes back without reply-kind scoping, the
  sole-step split, or the required `turn`.
- **Genuine messages in state.** `messages` holds the thread's real messages: continuation and spoken
  bytes are read from the tool messages since the latest caller message, never from a state slot.

### What changes for the prompt and the tests

- **Prompt.** Never tell the model to answer "without a tool call" or to "make no call" — say WHAT to
  convey; the protocol fragment owns how a reply is delivered. Do not restate batch stopping or
  mandatory next calls: `continuation` owns them. A guardrail section points at the `turn`
  classification instead of redefining misuse.
- **Goldens.** The mode moves the whole model surface (the speech control, `turn`, the protocol
  fragment): regenerate the model-surface golden when adopting it, and re-measure the live suites.
- **Sandbox tests.** `runSteps` reads continuation and spoken bytes from `state.messages`. A fixture
  that carries no messages enforces no boundary and has no result to present; to test a presentation,
  append the previous call's body as a `ToolMessage` after the caller's message.
- **Prompt-input tests.** The shared harness binds per turn through `modelToolsForTurn` /
  `modelToolOptions`, records `turn` in history as production writes it, reads a turn marked
  `misuse` as the note the runner records, and exposes `expectSpokenReply` (the sole speech step, in
  this mode). It asserts exactly one tool call per model turn.
</required_mode>

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

`abort_pending_input` is ALWAYS reserved — the library auto-injects it into the tool schema whenever ANY action declares one of: `requiresConfirmation`, `requiresOtp`, `issuesOtp`, `startsFlow`, `endsFlow`, `requiresFlow`, `requiresMatch`, `startsMatchFor`. `request_handoff` is reserved ONLY when `BuildAgentStepToolOptions.handoff` is provided (see `<handoff>`) — a tool that does NOT opt in may define its own action under that name (the orchestrator/scaffold handoff mechanism does exactly that). `note_refusal` is reserved under the same condition as `request_handoff` — whenever `handoff` is provided (see `<escalation>`) — sole-step (`note_refusal_must_be_sole_step`: the turn answers a refusal, not a value; on the exhausted path the step escalates into a handoff, which abandons the turn). `repeat_pending_question` (renamed from `repeat_pending_confirmation` in 3.0.0) is reserved ONLY when at least one action sets `ConfirmationOpts.repeatReadBack` — sole-step (`repeat_confirmation_must_be_sole_step`: a recap is a read-only turn boundary; domain work in the same batch could turn the caller's clarification into consent; the group name keeps the historical "confirmation" vocabulary deliberately — byte-pinned engine codes). `respond_to_caller` (4.1.0) is reserved ONLY when `config.tool.toolChoice` is `"required"` — sole-step (`reply_must_be_sole_step`); see `<required_mode>`. These library-owned actions are **controls** (`controls/` in the library): each carries its own activation, schema variant, description line, lockdown allowances, and execution — the run pipeline dispatches them instead of an executor. Declaring a reserved name throws:

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
(schema + description + rows with their asks + controller), with `config.ts` a slim assembler (plus
the config-level `invalidations` table) and `names.ts` a
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
   b. **Gate lockdown** — a pending confirmation/OTP/match admits only its target action / abort / handoff / the repeat control (+ the capturer, for match; + a same-flow issuer, for otp; see lockdown table above). Since 4.1.0 it also admits a `note_refusal` of kind `malicious_intent` and, in required mode, the speech control.
   c. **Flow mutex** — first step `startsFlow=X` while `currentFlow.name=Y` (≠X) → refuse `flow_already_active`.
   d. **Control exclusivity** — sole-step control families (handoff, repeat, refusal), in registry-group order.
   e. **Abort policy** — the optional host source/follower allow-lists.
   f. **soleStep / soleOnExecute** — per-action batch-shape refusal (computed off batch-start pending so the LLM-natural `[verify, mutate]` batch can propose).

   Required mode (4.1.0) adds two refusals around that order: an EMPTY batch is refused first (`empty_batch`), and a batch the fixed order admits is still refused with `continuation_required` when the latest tool result of this caller turn requires a different single step (see `<required_mode>`). In `buildAgentStepTool` — not in `runSteps`, which takes steps directly — a call marked `turn: "misuse"` on the first call of a caller turn has its steps replaced by the `malicious_intent` note BEFORE admission.
4. **Plan expansion** (`run/planning.ts`) — tag each user step with its confirmation mode (`propose` | `rePropose` | `execute` | `sameTurnLocked` | `exhausted`) based on pending state at batch-start. Frozen before any executor runs (same-batch-bypass safety). Planning is **abort-aware**: confirm steps AFTER an `abort_pending_input` in the same batch plan against NO pending — they propose fresh instead of executing against the gate the batch just cleared.
5. For each planned step (`run/execution.ts`):
   a. Control steps (`abort_pending_input`, `request_handoff`, `repeat_pending_question`, `note_refusal`, and in required mode `respond_to_caller`) dispatch to their `ControlAction` implementation, not an executor.
   b. Library-managed prereqs (`requiresFlow`, then `requiresOtp` / `requiresMatch`) → refuse if not gated.
   c. User-declared prereqs (verifiers) → refuse with denial body.
   d. Validate params via `paramsSchema.parse` — a failure is the `invalid_params` bounce, which also counts toward bounded patience when `handoff` is configured (see `<escalation>`); a successful parse is PROGRESS and resets those counters. For an action declaring `satisfies`, an EMPTY call resolves its state-satisfied bundle here (see `<satisfies>`).
   e. Run the action's selector against the running `view` to build the slice, then call the executor: `executors[action](params, selectors[action](view), source?)`. The declared return is normalized through the named verdict row (summary rendered over the current view; body composed in declaration order; `resultExtras` appended; row stateUpdate/effects merged UNDER the executor's). An undeclared verdict — or a thrown executor — is caught, marked `ok:false` (`error: "executor_error"`), and short-circuits; earlier steps' commits are preserved.
   f. Apply the outputs in this order: the `invalidations` cascade (BEFORE the stateUpdate, so the executor's own re-writes of downstream slots win over the nulls) → `stateUpdate` (host slots only — library slots throw) → `request_handoff` effect (terminal; skips the rest) → `startsFlow` + `merge_flow_data` → auto-clear of `requiresOtp`/`requiresMatch` on ok → `otp_issued` → `startsMatchFor` → `endsFlow` → `clear_awaiting_input` / `abort_flow`. (Consume BEFORE issue: one action may both consume a match and issue an OTP, and `awaitingInput` is a single replace-on-write slot — issuing first would have the consume wipe the freshly opened gate.) On ok:false + `verdict:"match_mismatch"`, decrement match attempts (or abort flow on exhaustion). **Handoff monotonicity:** once the `handoff` slot is set (control, row effect, or executor effect), the remaining interaction lifecycle is skipped and the batch ends after the current step, whatever `ok` was.
   g. Stop or go on. The batch ends after a step that is `ok: false` (unless its row declares `continuation: "continue"`), after a step that requested a handoff, and after a step whose row declares `continuation: "await_caller"` or `{ action }`. In required mode a proposal ends the batch too. Otherwise the next step runs against the updated view.
6. **Finalize** (`run/finalize.ts`) — build the result body, apply the **standing-ask lifecycle** (the final entry sets/clears the `dictation` record and is stamped `standing_ask` / `ask_text` / `ask_contract` — see `<standing_asks>`), apply the error-counter/auto-handoff policy — in required mode also stamp `continuation: "await_caller"` on a final entry that proposes, carries `read_back`, or bounced leaving a standing ask, and attach the pending `reply_contract` / `ask_contract` to a speech result's `awaiting` — and emit a single `ToolMessage` whose content is the JSON-stringified `RunnerResultBody = { summary? | instruction?, results, failed_at? }` (`_debug` stripped onto the message `artifact` — see `<registers>`).

**Cumulative commit on partial failure:** state patches from successful earlier steps DO commit even if a later step fails. Example: `[verify_customer (ok), verify_card (fail)]` → `verifiedCustomer` persists for the next turn.

**Crucial:** state slots in the graph's `state.ts` MUST declare an explicit reducer. The library reads the reducer at runtime. Slots declared without a reducer get replace-on-write behavior (which is fine — but be explicit about it).
</state_threading>

<confirmation_lifecycle>
## Mutation propose → execute lifecycle (when `requiresConfirmation` is set)

The runner switches the mutation action into a five-mode state machine. Detected by reading `awaitingInput.kind === "confirmation"`:

**Ordering with prereqs (non-obvious, but guaranteed).** A step's library prereqs (`requiresFlow`) and user verifiers run BEFORE its confirmation mode is acted on (`<state_threading>` step 5b/5c, ahead of the propose in 5f). So a confirm-gated mutation whose `requiresFlow`/prereqs are unmet is **refused, not proposed** — `awaitingInput` is never set into a doomed state. Compose `requiresConfirmation` with `requiresFlow` freely; the gate order is correct.

### First call (no pending, or pending action ≠ this action) → **propose mode**
- Parse params with the action's **effective schema** (the declared `paramsSchema`, page-extended for `pageable` actions) and store them **PARSED** — schema normalization (`z.preprocess`, coercion) is applied before storage: `awaitingInput = { kind: "confirmation", for_action, params, attempts_left: maxAttempts, max_attempts, proposed_on_caller_turn_id? }`. The proposal is stamped with the current caller-turn identity when one exists (see `<caller_turn_identity>`).
- A failed parse returns `{ ok: false, error: "invalid_params" }` with the engine's count-free `invalid_params` instruction and the raw Zod detail in `_debug` (nothing is stored; the bounce counts toward bounded patience — `<escalation>`).
- Return `{ ok: true, instruction, needs_confirmation: true, proposed_params, attempts_left }`, plus:
  - **`read_back`** when the action declares `ConfirmationOpts.readBack` and it renders non-empty for these parsed params. Absent — not empty — when it renders nothing.
  - **`read_back_directive`** when `readBackDirective` renders non-empty (how to frame the bytes).
  - **`reply_contract`** — the complete classification of the caller's next reply: the composed action-specific contract when the action declares `replyContract`, else the generic `confirm_reply_contract` template. The gate turn reacts to THIS, not prompt memory. The generic template was reworded in 4.1.0 and no longer ends in "make no call and re-ask": a question about what is being confirmed, and unclear, unrelated or third-party speech, are each answered with ONE short spoken yes/no question — through the speaking-turn protocol in auto mode, through `respond_to_caller` in required mode.
- **Executor is NOT invoked.**
- In required mode the proposal ENDS the batch and carries `continuation: "await_caller"`: later steps of the same batch do not run (a second gate cannot overwrite the one just proposed), and the next call must present the read-back.

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
- If the re-call's params fail to parse: the step fails with `invalid_params` (the engine instruction; raw Zod detail in `_debug`) and the pending proposal is left **unchanged** — no decrement, the prior proposal still stands.
- If `attempts_left > 0`: return new `needs_confirmation` envelope with decremented `attempts_left` — including a fresh `read_back` rendered from the CORRECTED params, so the caller hears what actually replaced the old value.
- If `attempts_left === 0`: return `{ ok: false, instruction, error: "confirmation_attempts_exhausted" }` and clear pending.

### The repeat control (`repeat_pending_question`)
When an action opts into `repeatReadBack`, a "pardon?" / channel-check turn has a legal move that is
neither consent nor drift: the sole-step `repeat_pending_question` control re-presents the gate's
stored `read_back` bytes (with `read_back_directive_repeat` framing) — no executor run, no re-render
from mutable state, no params/attempts change, and the gate is not consumed. It advances only the
gate's presentation-turn provenance: the repeated recap is now the question the caller must answer on
a LATER turn. Misdirected calls (no pending gate, gate not opted in, no stored rendering) fail closed
and change nothing. The result carries the gate's compiled `reply_contract` again (4.1.0), so the
caller's next reply is classified by the action's own taxonomy rather than a generic one. In required
mode a `respond_to_caller` reply with `kind: "clarification"` performs the same repeat inside the
speech call (see `<required_mode>`).

The same control serves a standing ASK (4.0.0): when the pending `dictation` record carries `ask_text`
(the row's ask declared `render`), it returns those stored bytes as `read_back` with `ask_repeated:
true` — the caller hears the exact question again, and nothing else changes.

### Lockdown
If `awaitingInput.kind === "confirmation"` and `lockdown: true` (default), the batch MUST start with either:
- The same action as the pending one (resolves to execute / rePropose / exhausted), OR
- `abort_pending_input` (library-handled; clears `awaitingInput` AND `currentFlow`; abort may be the first step of a larger batch — subsequent steps run after the gate clears), OR
- an allowed control (`request_handoff`, `repeat_pending_question`, and in required mode `respond_to_caller` — each per its own rules), OR
- `note_refusal` with kind `malicious_intent` (4.1.0) — recorded and counted, the gate untouched.

Anything else → `{ ok: false, error: "pending_confirmation_locked", awaiting: { kind, for_action } }`. Since 4.1.0 the refusal's instruction also names the way forward for a caller who moved to a DIFFERENT item or value: `abort_pending_input` followed by that action in the SAME call — never a repeat of the pending question about the item they moved away from.

### abort_pending_input
Library auto-injects this action into the schema whenever ANY lifecycle opt is declared. It is library-handled (no executor needed):
- If `awaitingInput` or `currentFlow` is set → clear both; return `{ ok: true, instruction, aborted_awaiting?, aborted_flow? }` (`ENGINE_TEXT.abort_done`: acknowledge the cancellation in one short sentence and continue).
- If nothing is active → no-op; return `{ ok: true, instruction }` (`ENGINE_TEXT.abort_nothing`).
</confirmation_lifecycle>

<invalidations>
## Downstream-slot invalidation (`AgentStepConfig.invalidations`)

ONE table for the whole config, declaring "if slot X is re-collected with a *different* value, reset everything derived from X to `null`" — whichever action wrote it. Staleness is a fact about the SLOTS ("a different card selection makes the report outcome stale" is true whoever re-binds the card); through 3.x it was declared per action (`ActionDef.invalidatesOnChange`), which made every new writer a copy site. Keys are watched slot names; values are the downstream slots to clear.

```ts
export const myConfig = defineConfig<ActionName, PrereqName, State>({
  tool: { … },
  actions: { … },
  invalidations: {
    customerCode: ["cardVerified", "amountCollected", "reasoningCollected", /* … */],
  },
});
```

Every named slot must be a channel of the host state schema (a typo would silently never fire), and no library-managed slot may be watched or nulled through the table — both are checked at construction.

Fire rule (evaluated for every executor `stateUpdate`, against the pre-step view):
- Fires only when the watched slot's pre-step value was **non-null** AND the written value is not **deep-VALUE-equal** to it (canonicalized-JSON compare — reference identity never counts, so an executor writing a fresh-but-value-equal object does NOT fire).
- First-time set (`null → value`) does NOT fire — there was nothing downstream to invalidate yet.
- Same-value writes (no real change) do NOT fire — including a fresh object with identical contents.
- Slots set later in the same batch are NOT retro-cleared; an executor's own writes to a downstream slot win over the cascade.

Invalidated slots are written as `null` regardless of their declared type, so any slot listed as a target must accept `null` as its "unset" sentinel. CAUTION: the `null` must also survive the HOST's reducer for that slot — list only **replace-on-write** slots as invalidation targets. A record-merge reducer (`{...prev, ...(next ?? {})}`) swallows the `null` at the graph boundary, so the slot resurrects on the next turn even though the in-batch view saw it cleared.
</invalidations>

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

**Constraint:** a `pageable` action's `paramsSchema` MUST be a PLAIN `z.object` (the runner extends it with `page`/`pageSize`) — otherwise construction throws. A refined object (`z.object({...}).superRefine(...)`, e.g. one carrying `exactlyOneOf`) is a `ZodEffects` and cannot be extended: keep a pageable action's params plain and move any cross-field rule into the executor.

**Primitives** (exported from `index.ts`, for hand-rolled cases — the runner uses them internally): `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `clampPageSize`, `querySignature`, `pageRows`, `buildPageEnvelope`, and types `PageEnvelope`, `PagedCache`, `PageableSpec`. Prefer the `pageable` opt over hand-rolling.
</pagination>

<caller_digit_capture>
## Param builders and field kinds (`callerDigits` / `digitGroupsParam` / `digitCandidatesParam` / `callerTextParam` / `judgedEnum` / `judgedFlag` / `relayParam` / `exactlyOneOf`)

Schema helpers for a tool's params. Each builder registers a machine-readable **field kind** for the schema it returns (`FieldKind`), so the engine can ASK what a param is instead of inferring it:

| Kind | Builders | What the param is | Ask target? |
|---|---|---|---|
| `digits` | `callerDigits`, `digitGroupsParam`, `digitCandidatesParam` | a caller-DICTATED digit value the model transcribes | yes |
| `text` | `callerTextParam` | a caller-DICTATED text value the model transcribes | yes |
| `judged` | `judgedEnum`, `judgedFlag` | the model's CLASSIFICATION of what the caller meant — never transcribed, never read back | no |
| `relay` | `relayParam` | the caller's exact words passed through for the SYSTEM to classify | no |

`digits` and `text` are the **capture fields**. What the kind buys, all enforced at construction: a standing ask may only target a capture ("you cannot dictate a judgement"); an ask may omit `param` when its target declares exactly one capture; digits-vs-text is derived, never hand-copied; the `invalid_params` bounce re-ask and the escalation's owed action come from the bouncing action's capture; `satisfies` may only satisfy a capture. A param declared with plain zod has NO kind — the library never guesses — so it cannot be an ask target. Registration is identity-based: pass a builder's result on UNCHANGED (a wrapper appending `.optional()` or `.describe()` afterwards returns a new schema object and loses the kind). Introspection helpers are exported for host tests: `fieldKindOf`, `fieldMetaOf`, `captureFieldsOf`, `objectShapeOf`.

The capture rules below are each a consequence of a runner contract, so a host that hand-rolls the field re-derives (or misses) them one live failure at a time:

- **Shape rules are refinements, never `.regex()` / `.min()` / `.max()`.** A `.regex()` becomes a `pattern` keyword in the model-facing JSON Schema (and `.min`/`.max` become `minLength`/`maxLength`), turning the tool's validation into a precondition the model must satisfy before it may call. The model then counts digits itself — unreliable on grouped STT captures — and either **withholds the call** (answers the caller instead; a valid capture never reaches the tool) or **pads an invented digit** to satisfy the pattern. The builders keep the wire type plain; the runner's propose-path parse bounces a bad shape as recoverable `invalid_params` — before any read-back, without spending a confirmation attempt. **Since 4.0.0 this is enforced at construction** for EVERY domain action: a `pattern`, `minLength`, `maxLength` or `format` keyword anywhere in a model-facing params schema throws (`exposes JSON-Schema keyword …`). `minItems`/`maxItems` (arrays the model constructs) and `enum` (closed values) stay legal.
- **Refinement messages carry no digit count.** "must be exactly 9 digits" re-introduces through the error path the very constraint the refinement keeps out of the schema. Since 4.0.0 the issue text no longer reaches the model at all (`_debug` rides the `ToolMessage` artifact — `<registers>`), but it is still read in traces and by `runSteps` tests; keep it count-free. Say WHAT failed ("not a usable capture"), never HOW MANY DIGITS.
- **Representation flips must not read as drift.** The confirmation gate compares schema-PARSED params, so `["7070"]` ≡ `"7070"` and separator variants must normalize identically — the separator strip and the singleton-array collapse live in the preprocess, before the compare.
- **The declared type is the honest wire union.** A field that accepts digit GROUPS carries the array branch in its TYPE — a preprocess is invisible to the model's schema, and with a bare string type a group-array call bounces as a raw schema error instead of the runner's voice-safe `invalid_params`.

The builders (each takes a **required** `describe` — the library ships NO model-facing wording; field text is live prompt surface, owned and QA-gated per host):

- **`callerDigits(shape, message)`** — the primitive: a caller-dictated digit string whose shape check is a refinement. Carries the `digits` kind itself, so a host composing its own preprocess/union around it still declares a capture.
- **`digitGroupsParam({ shape, message, describe, normalize? })`** — the "transcription field": the model transcribes one array entry per **spoken digit group** («δεκαεπτά, είκοσι ένα, πενήντα δύο, δύο, ογδόντα δύο» → `["17","21","52","2","82"]`) or a single string; the JOIN happens in the preprocess, never in the model (models regroup, drop repeated groups, and lose the zero of round tens). `shape` validates the JOINED value. Omission stays `undefined` — the host's channel for "consume a carried/collected value" (see `<satisfies>`). `normalize` (4.0.0) is a per-group canonicaliser applied before the join — the default strips every non-digit; a capture that legitimately carries LETTERS (an alphanumeric document number) supplies its own. It may only strip separators and canonicalise what was spoken — never add, reorder or drop content — and should turn an unreadable token into a character outside `shape` so the capture bounces instead of silently shortening.
- **`digitCandidatesParam({ shape, message, candidateMessage?, maxCandidates?, describe })`** — the ambiguous-reading field: a single digit string, or an array of EVERY plausible reading of one utterance («χίλια τρία» → `["1003","10003"]`) for the executor to try — the model never picks a reading itself.
- **`callerTextParam({ min, max, shortMessage, longMessage, describe })`** (3.0.0) — a caller-dictated TEXT capture (a spoken name, a free-form answer): trim + bounded length as a REFINEMENT with count-free messages — the text analogue of `callerDigits`.
- **`relayParam(describe)`** (3.0.0) — a relay-only transcription field: the caller's exact words, OPTIONAL, passed through for the SYSTEM to classify — the model never translates, normalizes, or invents them. Mechanically a described optional string; the builder NAMES the intent (stenographer field).
- **`judgedEnum(values, describe)`** (4.0.0) — an OPTIONAL enum the model sets from its CLASSIFICATION of what the caller meant, in the system's own vocabulary (the caller never says the enum value). The `describe` must tell the model to OMIT the field when the caller's words do not clearly name one of the values — an unclear description is not a guess. Only safe where being wrong is a cheap, recoverable detour: nothing can validate a judgement.
- **`judgedFlag(describe)`** (4.0.0) — an OPTIONAL boolean for a conversation-level fact the model concludes rather than transcribes. Same licence, same limits.
- **`exactlyOneOf(fields, message)`** (3.0.0) — an exactly-one-of selector for a params object (XOR over optional fields) as a refinement, applied via `z.object({...}).superRefine(exactlyOneOf([...], msg))` — the model-facing JSON Schema stays a plain object, and a bad shape bounces as recoverable `invalid_params` on the propose path.

**Description authoring (the part the host owns).** The proven register for `describe` — adapt, don't invent:
- Frame the field as **pure transcription** ("you are a stenographer here"): write down the digit groups exactly as heard, in spoken order; never concatenate, merge, regroup, shorten, extend, count, or judge; a group is never dropped because it repeats its neighbour; the SYSTEM sanitizes, joins, and does ALL validation, answering `invalid_params` on an unusable capture.
- Keep the field **semantically neutral**: naming the domain entity ("the AFM") or its length ("nine digits") re-activates the model's world knowledge — the measured source of withheld calls and reshaped captures no prompt scrub fully suppresses.
- Give 2–3 concrete renderings in the caller's language(s), e.g. `«10, 2, 22. 8078» → ["10","2","22","8078"]`.
- If omission consumes a carried value, say exactly that ("Omit the field entirely to consume …") — omission semantics belong in the field text, not only the prompt.
- Never bound a capture's re-ask loop by prompt counting: the engine bounds it for every action (see `<escalation>`), and a count in the prompt is exactly what makes the model pad a capture.
</caller_digit_capture>

<handoff>
## Library-coordinated channel handoff (`BuildAgentStepToolOptions.handoff`)

Opt-in machinery for a SPECIALIZED agent's off-topic plays (see `streaming-and-channel-contract.md` `<agent_roles>`): delegate the turn to another deployment and keep the conversation, or hand the conversation back. Two cooperating halves — the runner writes a slot; a host graph node resolves it.

### Runner half (opt-in)

Pass `handoff: HandoffSpec<T>` to `buildAgentStepTool`. The runner then:

- Auto-injects the reserved **`request_handoff`** control into the tool schema (with the opt provided, declaring it in `config.actions` throws; WITHOUT the opt the name is free — the orchestrator/scaffold mechanism uses it for its own action). Params = `HandoffRequestSchema`: `{ reason: "off_topic" | "completed" | "abandon", context }` — `context` is the customer's request for `off_topic`, a short routing note for `completed` / `abandon` (never spoken — the host renders the closing).
- Auto-injects the **`note_refusal`** control and bounds capture bounces (see `<escalation>`) — both end in a handoff, so both ride this opt.
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
                                     // auto-injected request_handoff schema variant, e.g. to enumerate
                                     // the exact reason/context pairs a modelRequestSchema allows. The
                                     // default (HANDOFF_ACTION_DESCRIPTION) already describes `context`
                                     // truthfully as routing metadata.
  resolveClosingMessage: (state: T, request: HandoffRequest) => string;
                                     // REQUIRED and TOTAL (4.0.0) — render the caller-audible closing
                                     // for completed / abandon from state. The return type is `string`:
                                     // the host's table must end in an unconditional row. The engine
                                     // never falls back to `request.context` (model prose) or a library
                                     // default — nothing the engine or the model authors is spoken.
                                     // NEVER called for off_topic (a silent hand-back).
  delegateFailureMessage?: (state: T) => string;
                                     // REQUIRED in delegate mode (4.0.0; validated at construction) —
                                     // the caller-audible fallback when a delegate run fails. Unused
                                     // in terminate mode.
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
                                     // schema. Output must still be a HandoffRequest. The engine's
                                     // own structural contexts (auto-handoff, escalation, misuse) are
                                     // deliberately OMITTED from it, so the engine holds the only
                                     // path to them.
}
```

**`resolveClosingMessage` is the ONLY source of a spoken closing (4.0.0).** It runs in
`createHandoffNode` for `completed` / `abandon`; the returned string becomes the final message
`content` (and `handoff_metadata.success_message`). The host gates the closing on what actually
happened — a success line for `completed` only when the mutating action truly persisted, a
neutral/failed phrasing otherwise — and on the engine's own endings, which arrive as STRUCTURAL
contexts the table matches:

```ts
import { AUTO_HANDOFF_CONTEXT, ESCALATION_CONTEXT_PREFIX, MALICIOUS_CONTEXT, escalationContext }
  from "./agent-step/index.js";

resolveClosingMessage: (state, request) => {
  const c = closingsFor(state.language);                        // host catalog, keyed on state
  if (request.context === MALICIOUS_CONTEXT) return c.misuse;   // first: overrides the task state
  if (state.operationSucceeded) return c.success;               // honesty invariant
  if (request.context === AUTO_HANDOFF_CONTEXT) return c.technical;
  if (request.context === escalationContext("verify_card")) return c.cardDigitsUnknown;
  if (request.context.startsWith(ESCALATION_CONTEXT_PREFIX)) return c.escalated;
  if (request.reason === "abandon") return c.transfer;
  return c.goodbye;                                             // the unconditional last row
},
```

`request.context` stays routing metadata (it rides the envelope as `handoff_reason`). This replaces the
1.x–3.x design in which the context could BE the closing sentence — spoken model prose for
`completed`/`abandon`, and a byte-matched library sentence for the auto-handoff.

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
mid-task aside must stay resumable — the caller can come straight back; spent patience stays spent),
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
an exhausted escalation, the auto-handoff over a thrown executor — so the resolver is the only place
that sees every ending; without it a host could reach those endings only by wrapping the node or by
hiding I/O in the pure `resolve*` functions. The library does not log: report failures inside the
hook.

**Asides mid-task**: a question the flow cannot answer, asked while the caller is still pursuing the
task, is `note_refusal` kind `unsupported_question` — the engine directs a one-sentence decline and
a repeat of the pending question, and escalates by itself if it recurs (see `<escalation>`). A
STANDALONE request for something else is not an aside: that is an `off_topic` handback.

Exports: `HANDOFF_ACTION` (`"request_handoff"`), `HANDOFF_NODE` (`"resolve_handoff"` — a node can't be named `handoff`, the state channel claims it), `HANDOFF_ACTION_DESCRIPTION`, `AUTO_HANDOFF_CONTEXT` (`"auto_handoff"`), `HANDBACK_SIGNALS` (reason → `handoff_type` signal; identity over `off_topic` / `completed` / `abandon`), `handoffParamsSchema`, `handoffRequested(state)` (edge predicate), `createHandoffNode(spec)`, and types `HandoffSpec`, `HandoffOffTopicSpec`, `HandoffDelegateTarget`.

Wire a conditional edge after the tool node — `createReactAgent` cannot express it, so the graph is hand-rolled: `addConditionalEdges("tools", s => handoffRequested(s) ? HANDOFF_NODE : "agent")`, `addNode(HANDOFF_NODE, createHandoffNode(spec))`, `addEdge(HANDOFF_NODE, END)`. The node emits a `handoff` custom event FIRST (streaming clients abort TTS / reroute before any content), resolves the response (the host-rendered closing — or silence for `off_topic` —, or a delegate run over the Platform API with live `delegated_token` pass-through and a fallback to `delegateFailureMessage(state)` on failure), emits `handoff_complete`, calls the host's `onHandback` observer when one is configured (3.1.0 — not awaited, contained), and returns `{ handoff: null, ...clears, messages: [AIMessage] }` (the clears are empty unless a task-ending handback resolved — see above) — the model never paraphrases the result.

**Final-message kwargs** (the channel contract): every non-delegate resolution is a handback — `is_handoff: true`, `handoff_type` = the effective reason's signal (`off_topic` / `completed` / `abandon`, after any `resolveHandoffType`), `handoff_reason` = `context`, `handoff_metadata: { ...host fields from resolveHandoffMetadata, service_type, success_message }` — host fields first, library keys last and unclobberable. Spoken content: EMPTY for a terminate-mode `off_topic` (a silent re-route — the destination agent owns the reply), `delegateFailureMessage(state)` after a failed delegate run, or the host-rendered closing (`resolveClosingMessage`) for `completed` / `abandon` (the middleware delivers it and flips routing for the NEXT request). For engine-decided endings `handoff_reason` is a structural code (`auto_handoff`, `agent-step:escalated[:<action>]`, `agent-step:malicious`), not prose. Delegate success → NOT a handoff (conversation kept) — informational `{ delegated_to }` only. Streaming clients must request `stream_mode: ["messages-tuple", "custom"]` — the node-built final message never appears in the token stream; `handoff_complete` carries its text. Full wire details + the middleware checklist: `streaming-and-channel-contract.md`.
</handoff>

<satisfies>
## State-satisfied inputs (`ActionDef.satisfies`) — 4.0.0

An action's required input may already exist in state — carried from earlier in the call by the
channel, or asserted by the channel itself (an authenticated session). `satisfies` declares that, and
the engine owns the whole mechanic, so the host stops hand-rolling it (a probe module, carried-value
prompt flags, an executor branch per channel):

```ts
interface SatisfiesSpec {
  values: Record<string, string>;  // bundle name → dotted state path, e.g.
                                   // { spokenDigits: "collected_identity.taxNumber" }
  mode: "silent" | "consent";
  ask?: (state: unknown) => string;// consent only (required): the caller-audible reuse-consent question
  elseVerdict?: string;            // consent only (required): the declared row answering an empty call
                                   // when nothing usable is carried
}

interface SatisfiedSource {        // the executor's optional third argument
  values: Record<string, unknown>; // the resolved bundle; capture-field entries already normalized
}
```

**The trigger is an EMPTY call** — one that supplies none of the action's capture fields. A call
carrying any capture value is dictated, and the caller's own words always win: `satisfies` is never
consulted.

| | `mode: "consent"` | `mode: "silent"` |
|---|---|---|
| Requires | the action IS confirmation-gated; `ask`; `elseVerdict` naming a declared row; at least one `values` key naming one of the action's own capture fields | the action is NOT confirmation-gated; no `ask`, no `elseVerdict` |
| Availability | PARTIAL: capture-field keys are required, every other key is an optional rider, skipped when absent | ALL-OR-NOTHING: every key must resolve — the bundle's completeness is the predicate |
| Empty call, source available | proposes on the action's own gate: `read_back` = `ask(state)`, `proposed_params: {}`; the caller's yes re-fires the same empty call, and the executor receives the bundle | executes immediately; the executor receives the bundle |
| Empty call, nothing usable | answers through the `elseVerdict` row at propose time — no gate stored, no attempt spent (that row typically carries the `ask` for the value) | reaches the executor with no `source`; the executor owns that answer |

The mode is gate-bound by construction: the consent question rides the action's existing confirmation
gate (the engine never synthesizes one), and a silent skip of a consent-purpose gate is not
representable.

A `values` key naming one of the action's capture fields is validated — and normalized — through that
field's own schema, the same refinement a dictated value passes: a malformed carried value makes the
source unavailable instead of opening a gate over garbage. Other keys are presence-checked and handed
to the executor as-is. A key may never name a judged or relayed param (state must not impersonate a
model classification), and paths must be rooted at a host channel — never a library-managed slot.

The values ride state → executor and **never reach the model**: the proposal's `proposed_params` stay
`{}`. There is deliberately no model-facing surface for the mechanic — no describe marker, no composed
protocol clause. The LICENCE to make the empty call ("call it with no value first") stays host prompt
text.

```ts
// action.ts
satisfies: {
  values: { spokenDigits: "collected_identity.taxNumber" },
  mode: "consent",
  ask: (state) => carriedIdentityConsentAsk(state as State),
  elseVerdict: "no_identity_carried",
},

// executor.ts
export async function verifyCustomer(params: unknown, slice: Slice, source?: SatisfiedSource) {
  const digits = (params as Params).spokenDigits ?? (source?.values.spokenDigits as string | undefined);
  if (!digits) return { verdict: "no_identity_carried" };   // defense in depth: the same declared row
  …
}
```
</satisfies>


<auto_handoff>
## Auto-handoff on repeated backend failures

A safety net so a customer is never trapped in an unrecoverable backend-error loop. The runner keeps a consecutive **backend-failure** counter in the library-managed `errorCount` slot; when it reaches a threshold the runner auto-triggers a handoff.

**What counts as a backend failure.** The runner-raised **`executor_error`** (an executor threw, or named an undeclared verdict) ALWAYS counts. A verdict row with **`backendFailure: true`** marks its static `body.error` code as counting — this DERIVES the code list from the declarations, so the hand-kept list disappears; `BuildAgentStepToolOptions.backendFailureCodes` remains for codes that reach the wire outside any row. List ONLY true backend/network failures. User mistakes (wrong OTP, value mismatch) and business-logic refusals are recoverable and must NOT count, or the counter will escalate recoverable situations. The counter resets to 0 only when a batch in which an executor **actually ran** ends without a backend failure — executed work is the only proof the backend recovered. Batches where no executor ran (confirm-gate proposals/re-proposals, prereq or param refusals, aborts, handoff signals) are **neutral**: they neither increment nor reset, so the proposal a confirm gate interleaves between two failing executes cannot wipe the streak.

```ts
// BuildAgentStepToolOptions additions
backendFailureCodes?: string[];   // extra codes that count (executor_error + backendFailure rows
                                  // always count)
errorHandoffThreshold?: number;   // default 3 (ERROR_HANDOFF_THRESHOLD), or the deployment's
                                  // AGENT_STEP_ERROR_HANDOFF_THRESHOLD when omitted — a value given
                                  // here wins over the variable (see <escalation>, Tolerances)
onErrorThreshold?: (update: Record<string, unknown>, state: T) => void;
                                  // host hook fired at the threshold — inject a custom
                                  // handoff signal (e.g. write a scaffold `pendingHandoff` slot)
```

**At the threshold the runner:** (1) writes the library `handoff` slot `{ reason: "abandon", context: AUTO_HANDOFF_CONTEXT }` when the `handoff` opt is enabled; (2) calls `onErrorThreshold(committed, state)` if provided; (3) resets `errorCount` to 0; (4) appends a synthetic step result `{ action: "auto_handoff", ok: true, isHandoff: true, signal: "abandon", instruction }`, sets `body.instruction` to the same engine text (`ENGINE_TEXT.auto_handoff_instruction`), and clears `summary` and `failed_at`.

**Who speaks the closing.** The instruction tells the model the turn ends here and to produce NO further answer — **the platform delivers the closing**: a `createHandoffNode` graph calls the host's `resolveClosingMessage`, which matches `request.context === AUTO_HANDOFF_CONTEXT` and renders the technical-escalation closing from state. `AUTO_HANDOFF_CONTEXT` (`"auto_handoff"`) is a routing CODE, never caller prose — through 3.x the context WAS the closing sentence and hosts detected it by byte-equality against a locale entry. A host whose graph does NOT use `createHandoffNode` delivers its own closing from `onErrorThreshold`'s signal.

**Inert by default.** The whole mechanism is skipped unless a handoff path exists — i.e. the `handoff` opt is provided OR `onErrorThreshold` is set. A tool with neither never touches `errorCount`.
</auto_handoff>

<result_envelope>
## What the LLM sees per tool call

```ts
interface RunnerResultBody {
  summary?: string;                // mirrors the LAST entry's host caller-audible `summary`, when the
                                   // batch ended on one
  instruction?: string;            // mirrors the LAST entry's engine `instruction`, when the batch
                                   // ended on one (refusals, proposals, controls, the empty batch)
  results: StepResult[];           // one entry per executed step
  failed_at?: number;              // index into results where batch short-circuited
}

interface StepResult {
  action: string;
  ok: boolean;
  [key: string]: unknown;          // the row-composed body fields spread in — or, for an entry the
                                   // engine raised, its `instruction` + `error`
}
```

An entry carries `summary` (a declared row: host caller-audible bytes) OR `instruction` (engine-raised: a directive the model follows) — see `<registers>`, which lists the entries that differ (a guided `invalid_params` bounce carries both; a spoken control result carries `summary`). For the `executor_error` and `invalid_params` kinds the runner also records a **`_debug`** field carrying the raw technical cause (the thrown message / the Zod issue list). `runSteps` returns it on the entry; `buildAgentStepTool` strips it from the `ToolMessage` content and carries it on the message `artifact` (`{ debug }`) — preserved for traces, invisible to the model.

Library-injected fields on specific step kinds:
- `abort_pending_input` results carry `aborted_awaiting: { kind, for_action }` and/or `aborted_flow: "<name>"` when something was actually cleared.
- `executor_error` / `invalid_params` results carry the engine `instruction` (count-free on the capture path) and — off the wire — `_debug` with the raw cause. When the action names an `invalidParamsVerdict` (4.1.0), the `invalid_params` entry also carries that row's `summary` and body fields.
- an `invalid_params` bounce past the tolerance carries the in-place explanation instruction, then `escalated: true, handoff_requested: true, reason` on the escalation (see `<escalation>`).
- `issuesOtp` refused while a match gate is pending carries `error: "otp_blocked_match_pending"`.
- propose / re-propose results carry `needs_confirmation: true`, `proposed_params`, `attempts_left`, a **`reply_contract`** (the composed action-specific contract, or the generic `confirm_reply_contract`), and — when the action declares `ConfirmationOpts.readBack` and it renders something — `read_back` (proposal-only; never on the executing re-call) plus `read_back_directive` when `readBackDirective` renders.
- exhausted results carry `error: "confirmation_attempts_exhausted"`.
- lockdown refusals carry `error: "pending_confirmation_locked" | "otp_pending_locked" | "match_pending_locked"` and `awaiting: { kind, for_action }`.
- match-mismatch results gain `attempts_left` (decremented) or `verdict: "match_attempts_exhausted"` on the last try.
- a matching confirm re-call on the proposal's own caller turn carries `error: "confirmation_same_turn_locked"` (no attempt spent; gate untouched).
- the final entry that recorded a standing ask carries `standing_ask: { action, param }`, `ask_contract`, and `ask_text` when the ask's `render` returned bytes (see `<standing_asks>`).
- `repeat_pending_question` results carry the stored `read_back` + the `read_back_directive_repeat` framing; over a standing ask, `ask_repeated: true`, `for_action` and the stored ask as `read_back`. A repeated confirmation also carries the gate's compiled `reply_contract` (4.1.0).
- `note_refusal` results carry `refusal_noted: true`, the `kind`, and the engine's in-place `instruction` on a free use; `escalated: true, handoff_requested: true, reason` on the escalation; `handoff_requested: true, reason: "completed"` on the third `malicious_intent`; `error: "nothing_owed"` for a `declined_or_cannot` with no value owed (see `<escalation>`). Since 4.1.0: an in-place result with an instruction also carries `continuation: "await_caller"`; with a `reply`, an in-place refusal carries that line as `summary` plus `turn_complete: true` (and `awaiting` when something is still unanswered) instead of the instruction.
- a consent proposal answered from state (`satisfies`) carries `proposed_params: {}` and the rendered reuse-consent question as `read_back` (see `<satisfies>`).
- (4.1.0) a row that declares `continuation` carries it as `continuation`, and a `presentation: "verbatim"` row repeats its rendered summary as `reply_text` — in both tool-calling modes (see `<declared_verdicts>`).
- (4.1.0, required mode — see `<required_mode>`):
  - `respond_to_caller` results carry `summary` (the spoken bytes), `turn_complete: true`, and `awaiting` when something is still unanswered — `{ kind, for_action, … }` with the pending contract (`reply_contract` / `ask_contract`), or `{ kind: "question", for_action, question }` for an ungated verbatim question. A refused reply carries `error: "invalid_reply"`; a reply batched with anything else, `error: "reply_must_be_sole_step"`.
  - a proposal or re-proposal, any final entry with `read_back`, and an `invalid_params` bounce that left a standing ask carry `continuation: "await_caller"`.
  - a batch that is not the single step the latest result of this caller turn requires is refused with `error: "continuation_required"`; an empty batch that is not a misuse turn, with `error: "empty_batch"`.
  - a call whose `turn` is `"misuse"`, on the first call of a caller turn, returns the `note_refusal` / `malicious_intent` result in place of its steps.
</result_envelope>

<construction_time_checks>
The runner validates the config + registries at construction. These all throw at startup before any user input — fix the misconfig before continuing:

| Error message contains | Cause |
|------------------------|-------|
| `requires \`stateSchema\`` | `stateSchema` not provided |
| `is a reserved action name` | You declared `abort_pending_input` in config.actions (or `request_handoff` / `note_refusal` while the `handoff` opt is provided, or `repeat_pending_question` while some action opts into `repeatReadBack`, or `respond_to_caller` while `tool.toolChoice` is `"required"`) |
| `expects a state selector at selectors["xxx"]` | `selectors` registry missing the action-name key for an action |
| `expects an executor at executors["xxx"]` | `executors` registry missing the action-name key for an action |
| `is missing a non-empty description` | An action lacks `description` |
| `verifiers["xxx"] was not provided` | A prereq referenced by some action has no verifier |
| `pageable action's paramsSchema must be a plain z.object` | A `pageable` action's `paramsSchema` isn't a plain `z.object` (a refined object — `superRefine` / `exactlyOneOf` — cannot be page-extended) |
| `at least one action must be defined` | Empty `config.actions` |
| `declares startsMatchFor "X" but that consumer doesn't declare requiresMatch` | Capturer names a consumer that exists but lacks the `requiresMatch` hook |
| `declares issuesOtp for "X" but no such action exists` | `issuesOtp.consumer_action` names a non-existent action |
| `declares requiresMatch with capturer "X" but no such action exists` | `requiresMatch.capturer` names a non-existent action |
| `the state schema is missing channel(s)` | Channel-completeness check: a library slot this configuration writes has no channel in the host schema — spread `agentStepZodShape` / `agentStepStateSpec` |
| `has a verdicts entry with an empty code` | A `verdicts` row keyed by an empty string |
| `sets backendFailure but body.error is not a static string` | A `backendFailure: true` row whose `body.error` is missing or dynamic — the failure counter matches on that code (3.0.0) |
| `declares no verdict rows` | An action with no `verdicts` — every executor result names a row, so a row-less action can never answer a call (4.0.0) |
| `verdicts["xxx"].ask targets unknown action` / `declares no caller-capture field` / `omits \`param\` but … declares N capture fields` / `names param "xxx" which is not declared` / `is not a caller-capture field` | Row-ask validation (4.0.0): the target must exist and declare a capture field (`digits`/`text`); `param` is required only when the target has several, and must name a capture — not a judged or relayed param |
| `declares an ask AND a terminal handoff` | A row carrying a `request_handoff` effect also declares `ask` — a handed-back conversation owes nothing (4.0.0) |
| `exposes JSON-Schema keyword "xxx"` | A model-facing params schema carries `pattern` / `minLength` / `maxLength` / `format` — express value-shape rules as refinements (4.0.0) |
| `names "xxx" in double quotes, which is not a declared action or control` | An `askContract` or `replyContract` category routes the model to a name that is not callable — fix the name, or write a wire field in backticks (4.0.0) |
| `askContract requires at least one reply category` / `categories must be non-empty strings` | An `askContract` with an empty `categories` list — omit the option to keep the generic frame (4.0.0) |
| `invalidations names …` | The config-level invalidation table names a library-managed slot, or a slot that is not a channel of the state schema (4.0.0) |
| `bounceCapture "xxx" is not one of its capture fields` / `declares bounceCapture with a single capture field` | `bounceCapture` must name one of SEVERAL capture fields; with one it is derived and must be omitted (4.0.0) |
| `declares satisfies …` / `satisfies.values["k"] …` / `satisfies mode "consent" …` / `satisfies mode "silent" …` | State-satisfied-input validation (4.0.0): at least one value; paths rooted at a host channel (never a library slot); a key naming one of the action's params must name a CAPTURE; `consent` needs the confirmation gate, `ask`, a declared `elseVerdict` row and at least one capture key; `silent` forbids the gate, `ask` and `elseVerdict` (see `<satisfies>`) |
| `handoff.resolveClosingMessage is required` | The handoff spec lacks the host closing renderer — required and total (4.0.0) |
| `handoff.delegateFailureMessage is required in delegate mode` | A delegate-mode spec lacks the host-rendered failure fallback (4.0.0) |
| `enables repeatReadBack but declares no replyContract` | A repeatable gate routes re-asks through the repeat control, which the generic reply contract does not select — declare the gate's own reply taxonomy (3.0.0) |
| `.continuation must name continue, await_caller, or an existing action` | A row's `continuation` is not one of the three forms, or its `{ action }` names an action the config does not declare (4.1.0) |
| `.presentation must be verbatim` | A row's `presentation` is set to anything but `"verbatim"` (4.1.0) |
| `.continuation conflicts with its ask or handoff` | A row declares a `continuation` other than `"await_caller"` together with an `ask`, or any `continuation` on a `backendFailure` row or a row carrying a `request_handoff` effect (4.1.0) |
| `is engine-owned; declare it on the row` | A row `body` uses the key `continuation` or `reply_text` — both are result fields the engine writes; declare `continuation` / `presentation` on the row instead (4.1.0) |
| `invalidParamsVerdict must name a failure row with no state writes, effects, ask or backendFailure` | `invalidParamsVerdict` names no row, or a row that is `ok: true`, writes state, carries effects, an `ask` or `backendFailure`, or declares a continuation other than `"await_caller"` (4.1.0) |
| `composeGateContract requires …` | A `replyContract` spec with an empty `subject`/`subjectNoun`/`executesLabel` or no categories (a yes/no-only gate keeps the generic contract instead) |
| `abortPolicy …` | Abort-policy validation (2.5.0): non-boolean knobs, empty/duplicate/unknown action names in `allowedFollowers` / `allowedPendingTargets`, or `allowStandalone=false` with an explicitly empty follower list |
| `handoff.modelRequestSchema must be a Zod schema` | The model-facing handoff schema narrowing isn't a Zod schema |

Since 4.0.0 **`runSteps` runs the same validation** (once per options object), so a test harness surfaces these in the suite that exercises the wiring rather than at `npm run dev`.

Runtime errors raised by the runner (not construction-time, but loud):

| Error message contains | Cause |
|------------------------|-------|
| `returned undeclared verdict` | An executor named a verdict with no row in `ActionDef.verdicts` — declared rows ARE the result space (surfaces as `executor_error` on the wire) |
| `resultExtras key "…" collides with a field the declared row already composed` | An executor's `resultExtras` repeats a key the row composed — or (4.1.0) uses the engine-owned `continuation` / `reply_text` (surfaces as `executor_error` on the wire) |
| `Required-tool response must contain exactly one valid tool call` | Thrown by `toolOnlyMessage` in a required-mode agent node: the model returned no tool call, several, or an invalid one. Not a runner error — the host owns the retry policy (see `<required_mode>`) |
| `wrote library-managed slot(s) … through stateUpdate` | Executor patched `awaitingInput` / `currentFlow` / `pagedRead` / `spentLadders` / `handoff` / `errorCount` via `stateUpdate` — request the transition as a typed effect instead |
| `requested merge_flow_data but no flow is active` | Executor emitted `merge_flow_data` without `startsFlow` and no flow is open |
| `reported otp_issued but no flow is active` | Issuer didn't pair with `startsFlow` |
| `reported otp_issued but config lacks issuesOtp opt` | Executor returned the effect but the action's config didn't declare `issuesOtp` |
| `AGENT_STEP_… must be an integer >= N` | A tolerance environment variable is set to something that is not a plain base-10 integer within range — fix or unset it (see `<escalation>`, Tolerances) |
| `otp_blocked_match_pending` (step error) | An `issuesOtp` step ran while a double-entry match gate was still pending — consume the match before issuing the OTP; the match's own consumer is exempt and may issue (see `<otp_lifecycle>`) |

Slot declaration is enforced at construction (the channel-completeness row above) — a state schema missing a required library slot fails at startup instead of silently dropping writes. Spreading `agentStepZodShape` into your Zod state schema (as the bootstrap state template does) brings all six slots in together with their reducers.
</construction_time_checks>

<key_files_to_inspect>
For ground truth, read these files in the project (don't paraphrase — they ARE the contract):

- `src/agent-step/index.ts` — the public surface (only what's re-exported here is part of the API; the module layout below is internal)
- `src/agent-step/types.ts` — the authoring contracts: `VerdictDef`, `DeclaredExecutorResult`, `ExecutorEffect`, `Executor`, registries, `ActionDef`, `ControllerHooks`, `ConfirmationOpts`, `GateContractSpec`, `AskContractSpec`, `RowAsk`, `SatisfiesSpec`, `SatisfiedSource`, `Verifier`
- `src/agent-step/state.ts` — the library-managed slot schemas (`AwaitingInputSchema`, `CurrentFlowSchema`, `PagedCacheSchema`, `HandoffRequestSchema`) + the slot table (`AGENT_STEP_SLOT_META`) + the spreadable fragments (`agentStepZodShape`, `agentStepStateSpec`, `agentStepInternalSlotMask`) and derived lists (`agentStepTaskScopedSlots`, `agentStepRunnerOwnedSlots`)
- `src/agent-step/reply.ts` — required tool calling, host-facing half (4.1.0): `modelToolsForTurn`, `modelToolOptions`, `completedReply`, `toolOnlyMessage`, `renderReplyText`, plus the transcript readers the runner shares with it. Its header states the host wiring and what the mode assumes (see `<required_mode>`)
- `src/agent-step/runner.ts` — the thin public entry points (`buildAgentStepTool`, `runSteps`); the machinery lives in the phase modules:
  - `compile/` — `validate.ts` (every construction-time check), `plan.ts` (`BuildAgentStepToolOptions` + the compiled plan), `activation.ts` (the single ControlActivation construction), `schema.ts` / `describe.ts` (the model-facing schema + tool description), `action-describe.ts` (the composed per-action description), `gate-contract.ts` (`composeGateContract`), `ask-contract.ts` (`composeAskContract`), `asks.ts` (row-ask resolution + the derived bounce capture), `protocol.ts` (`composeProtocolPrompt`), `state-schema.ts`
  - `run/` — `admission.ts` (the fixed-order whole-batch preconditions), `planning.ts` (confirm-mode freeze), `execution.ts` (per-step loop, verdict-row normalization, effects ordering, handoff monotonicity), `finalize.ts` (result body + standing-ask lifecycle + error-counter policy), `satisfies.ts` (state-satisfied input resolution), `batch-state.ts` (the single write path into view/committed), `value-equal.ts`
  - `interaction/` — one policy module per gate kind: `confirmation.ts`, `otp.ts`, `match.ts`, `flow.ts`, `dictation.ts` (the standing-ask lifecycle), `escalation.ts` (bounded patience: the bounce / explanation / misuse counters and the structural contexts), `repeat-confirmation.ts` (the one eligibility check and consent-boundary patch behind the repeat control and the `clarification` reply), `turn-identity.ts` (`resolveCallerTurnId`)
  - `controls/` — the library-owned model-facing actions (`abort.ts`, `request-handoff.ts`, `repeat-question.ts`, `note-refusal.ts` — the refusal kinds and the shared misuse definition, `respond-to-caller.ts` — the required-mode speech control) in an ordered `registry.ts`, over the shared `contract.ts`
  - `handoff/` — `contract.ts` (action + signals + `HandoffSpec`), `node.ts` (`createHandoffNode` — the frozen channel contract), `delegate-client.ts` (SSE/Platform-API transport)
- `src/agent-step/paginate.ts` — the read-pagination primitives + the `pageable` orchestration
- `src/agent-step/capture.ts` — the param builders and the field-kind registry (refinement-not-regex, count-free messages, group join, candidate arrays, text/judged/relay/XOR builders; see `<caller_digit_capture>`)
- `src/agent-step/engine-text.ts` — every string the engine emits to the model (`ENGINE_TEXT`, `formatMessage`), with the register doctrine; not overridable (see `<registers>`)
- `src/agent-step/tolerances.ts` — the four engine tolerances: measured defaults, the `AGENT_STEP_*` variable names (`TOLERANCE_ENV`) and `resolveTolerances`; the only module that reads the environment (see `<escalation>`, Tolerances)
- Tests (all pass on `npm test`): `runner.test.ts`, `paginate.test.ts`, `capture.test.ts`, `field-kinds.test.ts`, `handoff.test.ts`, `hardening.test.ts`, `declare-hardening.test.ts`, `repeat-question.test.ts`, `escalation.test.ts`, `tolerances.test.ts`, `satisfies.test.ts`, `engine-text.test.ts`, `dictation.test.ts`, `verdict-map.test.ts`, `action-describe.test.ts`, `gate-contract.test.ts`, `zod-state.test.ts`, `reply.test.ts`, `clarification-reply.test.ts`, `continuation.test.ts`, `protocol.test.ts` — worked examples covering every runner branch, the declared-verdict normalization, the standing-ask lifecycle, bounded patience and the refusal kinds, the tolerances and their environment overrides, state-satisfied inputs, the construction checks, the composed descriptions/contracts, and the stored-byte question repeat
</key_files_to_inspect>
