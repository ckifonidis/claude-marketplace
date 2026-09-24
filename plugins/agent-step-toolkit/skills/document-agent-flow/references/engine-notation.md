# The "Step-engine expression" column

Each step's `engine` field says how the step runs on agent-step: which action closes it, which gates it
carries, which verdict rows it can end in. It is the column an implementer reads, so it uses the
library's own names — the ones in `../create-tool/references/agent-step-api.md` — and nothing else.
When the project under study vendors an older library, this column still describes the step on the
**current** library; the old mechanism goes in `status_note`.

## Notation

Readable, not symbolic. One line per step, parts joined with ` · `, in this order:

```
<closing_action>{params} · prereqs[a, b] · <batch shape> · <gates> · <flow> · verdicts: code✓→slot | code✗ fx:effect · <asks / bounces / invalidation / paging>
```

- `✓` marks an `ok: true` row (the batch continues), `✗` an `ok: false` row (the batch stops; earlier
  steps' commits stand). `→slot` is the row's static `stateUpdate`; `fx:` lists its `effects`;
  `backendFailure` marks a row counted by the auto-handoff guard.
- Name only what the step uses. Prose is allowed after the expression for the *why* ("runs T1 then T2
  and stops at the first failure").
- A step with no gate and no write says so: `get_cart{} · no gate · verdicts: shown✓`.

Examples (from `examples/pizza-order/`):
```
place_order{} · prereqs[cartReady, destinationSet] · soleOnExecute · requiresConfirmation{maxAttempts:3, readBack} · verdicts: placed✓→orderId | price_changed✗ (re-propose) | pos_down✗ backendFailure
choose_payment{method} · card: startsFlow payment · issuesOtp{consumer_action: confirm_payment} · verdicts: cash✓→payment | card✓ fx:otp_issued
confirm_payment{code: digits} · requiresFlow payment · requiresOtp · endsFlow · verdicts: paid✓→payment | code_invalid✗ | declined✗ fx:abort_flow
identify_caller{phone: digits} · prereqs[orderTypeSet] · asks invalid_params→identify_caller.phone:digits · captureBounces{max:2} · verdicts: known✓→customer | new✓→customer
```

## Catalog (agent-step 3.x)

Per action — `ActionDef` (`agent-step-api.md` `<types>`):

| Primitive | Declared as | Use in a step when… |
|---|---|---|
| params | `paramsSchema` (Zod) | always — what the model sends |
| prereqs | `prereqs: PrereqName[]` + one verifier each | the step needs journey state (identity known, cart ready). A prereq is a safety gate, not a sequencing hint |
| verdict rows | `verdicts: {code: {ok, summary, body?, stateUpdate?, effects?, backendFailure?}}` (`<declared_verdicts>`) | always — the step's outcomes; ✗ rows are the failure edges |
| effects | `request_handoff` · `merge_flow_data` · `otp_issued` · `clear_awaiting_input` · `abort_flow` | handoff out, gather into flow data, open an OTP gate, drop a gate but keep the flow, kill the flow |
| standing ask | `asks: {code: {action, param, expects, render?}}` (`<standing_asks>`) | the step re-asks a value after a bad answer (non-locking `dictation`) |
| capture bounce | `captureBounces: {max, ladder}` (`<ladders>`) | cap repeated answers the params schema rejects (`invalid_params` only — a well-formed value the backend refuses is a ✗ verdict row, not a bounce), then escalate |
| invalidation | `invalidatesOnChange: {slot: [downstream]}` (`<invalidates_on_change>`) | editing an earlier answer must void later results (a back edge) |
| paging | `pageable: true \| "delegate" \| {mode, pageSize, maxPageSize}` (`<pagination>`) | a list read |

Per action — `controller` hooks:

| Primitive | Declared as | Use in a step when… |
|---|---|---|
| batch shape | `soleStep` / `soleOnExecute` | the closing write must run alone (execute alone; the propose may be last in a batch) |
| confirmation | `requiresConfirmation: {maxAttempts, lockdown, readBack, readBackDirective, repeatReadBack, replyContract, refuseProposal}` (`<confirmation_lifecycle>`) | the step completes on the user's yes to a read-back |
| OTP | `issuesOtp: {consumer_action}` on one step, `requiresOtp` on the next (`<otp_lifecycle>`) | a code is sent and read back — always two steps |
| double entry | `startsMatchFor: {consumer_action}` / `requiresMatch: {capturer, maxAttempts}` (`<match_lifecycle>`) | a value is typed twice |
| flow | `startsFlow: {name}` / `requiresFlow` / `endsFlow` | a multi-turn span. **One flow at a time** (starting another fails `flow_already_active`); re-entering the same flow is idempotent |

Tool level — `buildAgentStepTool` options:

| Primitive | Declared as | In the ladder |
|---|---|---|
| handoff | `handoff: HandoffSpec` (`offTopic`, `modelRequestSchema` typed routes, `clearsOnHandback`, `resolve*`) (`<handoff>`) | terminals; off-topic delegation. The library's own reasons are `off_topic` / `completed` / `abandon` (back to the orchestrator) |
| transfer to a named human or team (a nurse, a fraud desk) | the scaffold's own handoff action (`soleStep`, the `pendingHandoff` slot, `is_handoff` kwargs — `streaming-and-channel-contract.md`), routed by the channel middleware | a terminal naming who takes over |
| escalation ladders | `ladders` + the `note_refusal` control | a "say it once, then escalate" rule |
| abort policy | `abortPolicy: {requireActive, allowStandalone, allowedFollowers, allowedPendingTargets}` | what "cancel" does mid-gate |
| auto-handoff | `backendFailureCodes`, `errorHandoffThreshold`, `onErrorThreshold` (`<auto_handoff>`) | the "technical issue" terminal |

Library controls the model can call: `abort_pending_input`, `request_handoff`, `repeat_pending_question`,
`note_refusal`. Library-owned state slots (never written by executors): `awaitingInput`, `currentFlow`,
`pagedRead`, `spentLadders`, `handoff`, `errorCount`.

**Lockdown.** While a confirmation / OTP / match gate is pending, the next batch must start with that
gate's target action, `abort_pending_input`, the handoff, or the repeat control (plus the capturer for a
match, and a same-flow re-issuer for an OTP). There is no read-only exemption: design waiting steps so
their status checks run when no gate is pending.

## Not current — never write these in the engine column

The validator refuses them (`templates/flowdoc/model.py` `RETIRED_ENGINE_TERMS`):

| Term | Status | Write instead |
|---|---|---|
| `ExecutorResult`, `resultBody` | removed from the public contract in 3.0.0 | a verdict row the executor names |
| bounded choices (`boundedChoices`, …) | removed in 3.0.0 | a ladder or verdict rows |
| `deflect_aside` | removed in 3.0.0 | a ladder via `note_refusal` |
| `forcedHandoff` | removed in 3.0.0 | a ladder's `onExhaust`, or a `request_handoff` effect |
| `guardTurn` | removed in 3.0.0 | a verdict row or a ladder |
| `repeat_pending_confirmation` | renamed in 3.0.0 | `repeat_pending_question` |
| `ttlMs`, `stateAnnotation` | removed in 2.0.0 | nothing (gates never time out) / the Zod state schema |
| `readOnly` | never shipped by the toolkit (some projects patched it into their vendored copy to let reads through a lockdown) | a plain action with no gate; under a pending gate only the target / abort / handoff / repeat run |

Do not describe gates, flows or OTP as new machinery: confirmation, OTP, match, flows, `soleStep` /
`soleOnExecute` and `invalidatesOnChange` have been in the library since its first release. What 3.0.0
changed is the authoring model — outcomes are declared verdict rows, and the engine composes the
model-facing language (descriptions, reply contracts, the turn-protocol prompt fragment). The version
history is in the toolkit's `CHANGELOG.md`.

## Pitfalls the validator cannot see

**Keep the journey out of flow data when a read-back can be edited.** While a confirmation is pending,
the lockdown admits only the pending action, `abort_pending_input`, the handoff and the repeat control
— and `abort_pending_input` clears `awaitingInput` AND `currentFlow` together (`<confirmation_lifecycle>`).
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
| Editing an earlier answer | `invalidatesOnChange` |
