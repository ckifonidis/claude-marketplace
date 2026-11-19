# The "Step-engine expression" column

Each step's `engine` field says how the step runs on agent-step: which action closes it, which gates it
carries, which verdict rows it can end in. It is the column an implementer reads, so it uses the
library's own names — the ones in `../create-tool/references/agent-step-api.md` — and nothing else.
When the project under study vendors an older library, this column still describes the step on the
**current** library; the old mechanism goes in `status_note`.

## Notation

Readable, not symbolic. One line per step, parts joined with ` · `, in this order:

```
<closing_action>{param: kind} · prereqs[a, b] · <batch shape> · <gates> · <flow> · <satisfies> · verdicts: code✓→slot | code✗ fx:effect ask:self · <bounceCapture / paging> · <config: invalidations>
```

- `✓` marks an `ok: true` row (the batch continues), `✗` an `ok: false` row (the batch stops; earlier
  steps' commits stand). `→slot` is the row's static `stateUpdate`; `fx:` lists its `effects`;
  `backendFailure` marks a row counted by the auto-handoff guard.
- `next:await_caller` / `next:action_name` / `next:continue` after a row is its `continuation`
  (`VerdictDef.continuation`), for the rows where what happens next differs from what `✓` / `✗`
  imply: a `✓` row that stops for the caller's answer, a row whose one follow-up call is fixed, a `✗`
  row the batch reads past. `verbatim` marks a row whose summary must be spoken exactly
  (`presentation: "verbatim"`). Write neither on a row that keeps the default.
- `ask:self` / `ask→action` after a row is its standing ask (`VerdictDef.ask`): the value the caller
  owes once that outcome is spoken, and the action their answer becomes. Write `ask→action.param` only
  when the target has several capture fields.
- `{param: kind}` names a param's field kind where it matters: `digits` and `text` are caller-dictated
  captures (the only ask targets), `judged` is the model's classification, `relay` is the caller's
  words passed through for the system to classify. A plain param stays `{param}`.
- `satisfies{param: state.path, mode: silent|consent, elseVerdict: code}` says an empty call may be
  answered from state.
- Do not write the re-ask after an unusable capture, or its escalation. An `invalid_params` bounce
  re-asks the action's own capture field, and bounded patience is the engine's for every action;
  neither is declared (`bounceCapture: field` only when the action has several capture fields). Say
  it in the prose after the expression when a failure edge depends on it.
- Invalidation is one table for the whole tool, not an action option: write
  `config: invalidations{slot:[downstream]}` on the step that writes the watched slot.
- Name only what the step uses. Prose is allowed after the expression for the *why* ("runs T1 then T2
  and stops at the first failure").
- A step with no gate and no write says so: `get_cart{} · no gate · verdicts: shown✓`.

Examples (from `examples/pizza-order/`):
```
place_order{} · prereqs[cartReady, destinationSet] · soleOnExecute · requiresConfirmation{maxAttempts:3, readBack} · verdicts: placed✓→orderId | price_changed✗ (re-propose) | pos_down✗ backendFailure
choose_payment{method: judged} · card: startsFlow payment · issuesOtp{consumer_action: confirm_payment} · verdicts: cash✓→payment | card✓ fx:otp_issued
confirm_payment{code: digits} · requiresFlow payment · requiresOtp · endsFlow · verdicts: paid✓→payment | code_invalid✗ | declined✗ fx:abort_flow
start_order{orderType: judged} · no gate · verdicts: set✓→orderType ask→identify_caller
identify_caller{phone: digits} · prereqs[orderTypeSet] · verdicts: known✓→customer | new✓→customer
set_address{street: text, postcode: digits} · requiresConfirmation{readBack} · satisfies{street: customer.lastAddress.street, postcode: customer.lastAddress.postcode, mode: consent, elseVerdict: no_saved_address} · bounceCapture: postcode · verdicts: in_zone✓→address | out_of_zone✗ (summary offers pickup) | no_saved_address✗ ask→set_address.street · config: invalidations{address:[quote]}
```
`identify_caller` declares no re-ask: `phone` is its one capture field, so a number the schema rejects
bounces and the caller owes `phone` again.

## Catalog (agent-step 4.x)

Per action — `ActionDef` (`agent-step-api.md` `<types>`):

| Primitive | Declared as | Use in a step when… |
|---|---|---|
| params | `paramsSchema` (Zod) | always — what the model sends |
| field kinds | the capture builders (`<caller_digit_capture>`): `digits` — `digitGroupsParam` / `digitCandidatesParam` / `callerDigits`; `text` — `callerTextParam`; `judged` — `judgedEnum` / `judgedFlag`; `relay` — `relayParam` | a param is dictated by the caller (`digits`, `text`), concluded by the model from what the caller meant (`judged`), or the caller's words passed through (`relay`). Shape rules are refinements: a `pattern` / `minLength` / `maxLength` / `format` in the model-facing schema fails construction |
| prereqs | `prereqs: PrereqName[]` + one verifier each | the step needs journey state (identity known, cart ready). A prereq is a safety gate, not a sequencing hint |
| verdict rows | `verdicts: {code: {ok, summary, body?, stateUpdate?, effects?, ask?, backendFailure?, continuation?, presentation?}}` (`<declared_verdicts>`) | always — the step's outcomes; ✗ rows are the failure edges. `summary` is what the caller hears, rendered by the host (`<registers>`). `continuation` says what happens next when that differs from `ok` (`await_caller` · `{action}` · `continue`); `presentation: "verbatim"` makes the summary exact speech |
| effects | `request_handoff` · `merge_flow_data` · `otp_issued` · `clear_awaiting_input` · `abort_flow` | handoff out, gather into flow data, open an OTP gate, drop a gate but keep the flow, kill the flow |
| standing ask | `ask: "self" \| {action, param?, render?}` on the verdict row (`<standing_asks>`) | an outcome leaves the caller owing a value: the same one again (`"self"`), or the one the next action takes (`{action}`). Non-locking `dictation`; `param` defaults to the target's one capture field and `expects` is derived from its kind |
| capture bounce | nothing — derived (`<escalation>`). `bounceCapture: "field"` only when the action has several capture fields; `invalidParamsVerdict: "code"` when a bounce should carry a row's guidance on what a usable value looks like | the params schema rejects an answer (`invalid_params` only — a well-formed value the backend refuses is a ✗ verdict row, not a bounce): the caller owes the action's capture again, and the engine bounds the repeats |
| state-satisfied input | `satisfies: {values: {name: "state.path"}, mode: "silent" \| "consent", ask?, elseVerdict?}` (`<satisfies>`) | the state may already carry the value (a saved address, a carried identity). An empty call is answered from state: at once (`silent`), or behind the host's reuse question on the action's confirmation gate (`consent`, with an `elseVerdict` row for "nothing carried"). A dictated value always wins |
| paging | `pageable: true \| "delegate" \| {mode, pageSize, maxPageSize}` (`<pagination>`) | a list read |

Per action — `controller` hooks:

| Primitive | Declared as | Use in a step when… |
|---|---|---|
| batch shape | `soleStep` / `soleOnExecute` | the closing write must run alone (execute alone; the propose may be last in a batch) |
| confirmation | `requiresConfirmation: {maxAttempts, lockdown, readBack, readBackDirective, repeatReadBack, replyContract, refuseProposal}` (`<confirmation_lifecycle>`) | the step completes on the user's yes to a read-back |
| OTP | `issuesOtp: {consumer_action}` on one step, `requiresOtp` on the next (`<otp_lifecycle>`) | a code is sent and read back — always two steps |
| double entry | `startsMatchFor: {consumer_action}` / `requiresMatch: {capturer, maxAttempts}` (`<match_lifecycle>`) | a value is typed twice |
| flow | `startsFlow: {name}` / `requiresFlow` / `endsFlow` | a multi-turn span. **One flow at a time** (starting another fails `flow_already_active`); re-entering the same flow is idempotent |

Tool level — the config and the `buildAgentStepTool` options:

| Primitive | Declared as | In the ladder |
|---|---|---|
| invalidation | `invalidations: {slot: [downstream]}` on the config (`<invalidations>`) | editing an earlier answer must void later results (a back edge). Any action's write that changes the watched slot nulls the downstream slots; a first-time set does not |
| handoff | `handoff: HandoffSpec` (`offTopic`, `modelRequestSchema` typed routes, `clearsOnHandback`, `resolve*`, the `onHandback` observer) (`<handoff>`) | terminals; off-topic delegation. The library's own reasons are `off_topic` / `completed` / `abandon` (back to the orchestrator). The closing the caller hears is always the host's: `resolveClosingMessage` is required and total (`delegateFailureMessage` as well in delegate mode), with rows for the engine's own contexts — `auto_handoff`, `agent-step:escalated[:<action>]`, `agent-step:malicious`. A side effect that must follow the outcome (a contact record) is `onHandback` — it sees every handback, including the engine-decided ones, and cannot change the reply or the signal |
| transfer to a named human or team (a nurse, a fraud desk) | the scaffold's own handoff action (`soleStep`, the `pendingHandoff` slot, `is_handoff` kwargs — `streaming-and-channel-contract.md`), routed by the channel middleware | a terminal naming who takes over |
| bounded patience | nothing to declare (`<escalation>`); on whenever `handoff` is configured | a "try again, explain once, then get a human" rule. At the default tolerances two consecutive unusable captures bounce plainly, the next earns one in-place explanation, the turn after hands back `abandon` on `agent-step:escalated:<action>`. The counters reset on progress. The numbers are deployment-level (`AGENT_STEP_*` environment variables read by the engine) — a flow document states the defaults and never a per-step count |
| refusals | the `note_refusal{kind, reply?}` control — `declined_or_cannot` · `unsupported_question` · `malicious_intent` (with `reply`, the in-place decline is recorded and spoken by the same call) | the caller declines the owed value, asks what the flow cannot answer, or tries to misuse the call. The model names the kind; the engine instructs the in-place handling once, then escalates as above (`declined_or_cannot` needs a standing ask to refuse). The third `malicious_intent` hands back `completed` on `agent-step:malicious` |
| ask contract | `askContract: {categories}` (`<standing_asks>`) | the host's own reply categories for a standing ask. Engine text is otherwise an `instruction` the engine owns — there is no wording override (`<registers>`) |
| abort policy | `abortPolicy: {requireActive, allowStandalone, allowedFollowers, allowedPendingTargets}` | what "cancel" does mid-gate |
| tool-calling mode | `tool: {toolChoice: "required"}` (`<required_mode>`); default `auto` | every model turn must be a tool call: speech is the `respond_to_caller` control, each call classifies the caller's turn (`turn: service \| misuse`), and a result's `continuation` bounds the next call. A property of the whole tool — a flow document states it once, on the config; the steps and their rows do not change |
| auto-handoff | `backendFailureCodes`, `errorHandoffThreshold`, `onErrorThreshold` (`<auto_handoff>`) | the "technical issue" terminal |

Library controls the model can call: `abort_pending_input`, `request_handoff`, `repeat_pending_question`,
`note_refusal{kind}` and, under required tool calling, `respond_to_caller{text}` (with
`{kind: clarification | choice}` at a repeatable confirmation). Library-owned state slots (never written by executors): `awaitingInput`, `currentFlow`,
`pagedRead`, `spentLadders`, `handoff`, `errorCount`. (`spentLadders` keeps its old name; it holds the
bounded-patience counters.)

**Lockdown.** While a confirmation / OTP / match gate is pending, the next batch must start with that
gate's target action, `abort_pending_input`, the handoff, or the repeat control (plus the capturer for a
match, and a same-flow re-issuer for an OTP). There is no read-only exemption: design waiting steps so
their status checks run when no gate is pending. `note_refusal` is not admitted either: a refusal while a
gate is pending is classified by that gate's reply contract — except `note_refusal{kind: malicious_intent}`,
which is recorded behind any gate and leaves it untouched. Under required tool calling the speech
control is admitted too: speaking never resolves a gate.

## Not current — never write these in the engine column

The validator refuses them (`templates/flowdoc/model.py` `RETIRED_ENGINE_TERMS`):

| Term | Status | Write instead |
|---|---|---|
| the `asks` map (`asks: {code: …}`, `asks code→action.param`), `DictationAsk` | removed in 4.0.0 | a row ask on the verdict row that asks — `code✗ ask:self` / `ask→action`. The `invalid_params` re-ask is derived: write nothing |
| `captureBounces` | removed in 4.0.0 | nothing — the bounce re-ask and its bound are the engine's (`bounceCapture: field` when the action has several capture fields) |
| `ladders`, a named ladder (`ladder: name`), `onExhaust`, `maxFreeUses` | removed in 4.0.0 | nothing — bounded patience is universal. A refusal is `note_refusal{kind}`; the closing after an escalation is the host's `resolveClosingMessage` row for `agent-step:escalated:<action>` |
| `invalidatesOnChange` | removed in 4.0.0 | `config: invalidations{slot:[downstream]}` — one table on the config |
| `SystemMessages` (the `messages` build option) | removed in 4.0.0 | nothing — engine text is an `instruction` the engine owns. A host adds reply categories with `askContract{categories}` and renders what the caller hears itself |
| `terminateMessage` | removed in 4.0.0 | `resolveClosingMessage` (required and total); `delegateFailureMessage` in delegate mode |
| `ExecutorResult`, `resultBody` | removed from the public contract in 3.0.0 | a verdict row the executor names |
| bounded choices (`boundedChoices`, …) | removed in 3.0.0 | verdict rows — a ✗ row with a row ask re-asks, and the engine bounds the repeats |
| `deflect_aside` | removed in 3.0.0 | `note_refusal{kind: unsupported_question}` |
| `forcedHandoff` | removed in 3.0.0 | a `request_handoff` effect on the verdict row; the engine's own escalation needs no declaration |
| `guardTurn` | removed in 3.0.0 | a verdict row or a `note_refusal` kind |
| `repeat_pending_confirmation` | renamed in 3.0.0 | `repeat_pending_question` |
| `ttlMs`, `stateAnnotation` | removed in 2.0.0 | nothing (gates never time out) / the Zod state schema |
| `readOnly` | never shipped by the toolkit (some projects patched it into their vendored copy to let reads through a lockdown) | a plain action with no gate; under a pending gate only the target / abort / handoff / repeat run |

Do not describe gates, flows or OTP as new machinery: confirmation, OTP, match, flows, `soleStep` /
`soleOnExecute` and slot invalidation have been in the library since its first release. What 3.0.0
changed is the authoring model — outcomes are declared verdict rows, and the engine composes the
model-facing language (descriptions, reply contracts, the turn-protocol prompt fragment). What 4.0.0
changed is who owns each sentence, and how much is left to configure: engine text is a model-facing
`instruction` no host rewords, everything a caller hears is rendered by the host from state, asks sit
on the row that asks, capture params declare their kind, and patience is universal instead of
configured. What 4.1.0 added is optional: a row can say what happens next apart from `ok`
(`continuation`, `presentation`), and a tool can require every model turn to be a tool call
(`toolChoice: "required"`). The version history is in the toolkit's `CHANGELOG.md`.

## Pitfalls the validator cannot see

**Keep the journey out of flow data when a read-back can be edited.** While a confirmation is pending,
the lockdown admits only the pending action, `abort_pending_input`, the handoff and the repeat control
(a misuse note is still recorded, and speech under required tool calling still passes — neither
touches the gate) — and `abort_pending_input` clears `awaitingInput` AND `currentFlow` together
(`<confirmation_lifecycle>`).
An "edit" answer to a read-back must therefore abort (unless the edit is just new params for the same
action, which re-proposes). If the journey's data lived in `flowData`, the first edit would throw it
away, and every `requiresFlow` action would then be refused. So: the journey lives in host slots; a
flow wraps only a span that needs one (an OTP, a double entry) and holds nothing the user would have
to repeat. `examples/pizza-order/` shows the shape: `cart` is a slot, `payment` is the only flow.

**An OTP re-send needs a `requiresFlow` issuer.** The OTP lockdown admits a same-flow issuer of the
pending gate as a re-send — but only one whose `requiresFlow` names the gate's flow. The action that
started the flow (`startsFlow` only) is not admitted. Declare a separate re-send action (`requiresFlow
<flow>` + `issuesOtp{consumer_action}`), or the user must abort to get a new code (`<otp_lifecycle>`).

**One flow at a time.** A step that `startsFlow` while another flow is open is refused
(`flow_already_active`). Nesting is not available; two spans that overlap are one flow.

**A row ask targets a capture.** `ask` may only name an action that has a `digits` or `text` capture
field — a `judged` or `relay` param cannot be dictated — it must name the `param` when that action has
several, and it cannot sit on a row that carries a `request_handoff` effect. `satisfies` in `consent`
mode needs `requiresConfirmation` on the same action and an `elseVerdict` row; `silent` needs an action
with no confirmation gate. The library refuses each of these at construction (`<standing_asks>`,
`<satisfies>`); this validator does not.

**Bounded patience needs a handoff to end in.** The bounce counter and `note_refusal` exist only when
`handoff` is configured; without it an unusable capture stays a plain, uncounted rejection. A ladder
that relies on "then get a human" declares the handoff and gives `resolveClosingMessage` a row for
`agent-step:escalated:<action>` (`<escalation>`).

## The concepts table (md §3)

`engine_notes.concepts` maps each ladder concept to its primitive. The rows that recur in almost every
agent:

| Ladder concept | agent-step primitive |
|---|---|
| "We are in step Sx" | host state slots written by verdict rows (`stateUpdate`); each step's prereq verifiers read them |
| Gathering, "acknowledge what I got, list what is pending" | a collection action writing a host slot; received / pending computed in code, never by the model |
| A multi-turn span with a gate inside (a code, a double entry) | a short flow around just that span (`startsFlow` … `endsFlow`) |
| Completion clause | a verifier per step, used as the closing action's prereq |
| Trigger chain | one closing action per step; its executor runs the calls in order and names one verdict row |
| Recap before a write | `requiresConfirmation` with `readBack` on the closing action |
| A code the user reads out | `issuesOtp` on one step's closing action, `requiresOtp` on the next step's |
| A waiting step (approval, signature, delivery) | a status read plus a closing action whose prereq verifier reads backend-derived state — the user's say-so never closes it |
| Editing an earlier answer | the config-level `invalidations` table: a changed slot nulls the slots that depended on it |
| What the caller owes next | a row ask (`VerdictDef.ask`): `"self"` re-asks the same value after a ✗ row, `{action}` hands the question to the next step's action |
| An answer the tool cannot use | nothing to declare: the params schema rejects it (`invalid_params`) and the re-ask is derived from the capture field |
| "Try again, then get a human" | nothing to declare: universal bounded patience ends in an `abandon` handoff on `agent-step:escalated:<action>`, and the host's `resolveClosingMessage` words the closing |
| The caller declines, or asks something the flow cannot answer | the `note_refusal` control: the model names the kind, the engine instructs the reply or escalates |
| A value the state already carries (a saved address, a carried identity) | `satisfies`: `silent`, or `consent` on the action's confirmation gate |
| What the caller hears | rendered by the host from state: a row's `summary`, the gate's `readBack`, a row ask's `render`, the handoff closing. Engine text is a model-facing `instruction`, never spoken |
