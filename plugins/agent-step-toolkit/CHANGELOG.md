# agent-step library changelog

Version history for the **agent-step runner library** vendored by this toolkit. This tracks the
library only — NOT the plugin package version in `.claude-plugin/plugin.json`. The current version
ships in `skills/create-tool/templates/agent-step/VERSION` and travels into every bootstrapped
project at `src/agent-step/VERSION`.

Entries are written by `/bump-version` (newest first). Each breaking or behaviour-changing entry
links a migration guide under `migrations/` that `/pull-library` applies to downstream projects.

Format follows [Keep a Changelog](https://keepachangelog.com/). The library uses semver:
**major** = breaking public-API change (exports/signatures in `index.ts` / `types.ts`, or the
`buildAgentStepTool` options), **minor** = additive, **patch** = internal-only.

## [3.1.0] — 2026-10-21

Minor: **`HandoffSpec.onHandback`** — an OBSERVER of the resolved handback, for host side effects
that must follow the task's outcome (e.g. a CRM contact record). Additive; a spec without the field
behaves byte-for-byte as before.
Migration: [migrations/3.0.1-to-3.1.0.md](migrations/3.0.1-to-3.1.0.md).

### Added
- `HandoffSpec.onHandback?: (state, request) => void | Promise<void>` — called by
  `createHandoffNode` once per handback (`completed` / `abandon` / `off_topic` / a delegate failure;
  never a successful delegate) with the EFFECTIVE request (after `resolveHandoffType`) and the
  PRE-clear state, after the reply, the signal and the metadata are final. Called synchronously
  (what it starts inherits the node's run context) but never awaited; a throw or a rejection is
  contained, so it cannot change the reply, the signal, the metadata or the clears.
- Why: engine-decided endings — an exhausted ladder, the auto-handoff over a thrown executor — run
  no host executor, so the resolver is the only place that sees every ending. Hosts otherwise had to
  wrap the node (forbidden by the design principles) or hide I/O in the pure `resolve*` functions.
- `handoff.test.ts` +4: called once per handback type with the effective request and the pre-clear
  state; a throw cannot break the reply; not awaited and a rejection contained (no unhandled
  rejection); a delegate failure is observed, a delegate success is not. Library suite 225 → 229.

## [3.0.1] — 2026-08-29

Patch: OTP/match gate-interplay fixes enabling the folded **"confirming the value sends the code"**
shape — one action that consumes the double-entry match AND issues the OTP — and letting a pending
OTP be re-sent without aborting the flow. No public-surface change.
Migration: [migrations/3.0.0-to-3.0.1.md](migrations/3.0.0-to-3.0.1.md).

### Fixed
- The match-then-OTP ordering guard exempts the match's own consumer: an `issuesOtp` action whose
  pending match names it as `for_action` may issue (`otp_blocked_match_pending` no longer fires for
  the consumer-issuer fold; the hazard the guard exists for — an issuer overwriting a match whose
  consumer never ran — cannot arise when the issuer IS the consumer).
- Ok-lifecycle apply order: `requiresOtp`/`requiresMatch` gate consumption now applies BEFORE the
  `otp_issued` effect. `awaitingInput` is a single replace-on-write slot, so the old order had a
  consumer-issuer action wipe the OTP gate it had just opened, stranding the caller. (Equivalent
  orders when consuming and issuing are separate steps — which is why it went unnoticed.)

### Changed
- OTP gate lockdown additionally admits a **same-flow issuer** of the pending gate
  (`issuesOtp.consumer_action` = the gate's `for_action` AND `requiresFlow` = the gate's
  `flow_ref`) as the batch's first step, so a code that never arrived can be re-sent without
  `abort_pending_input` (which takes the whole flow — and everything captured in it — down).
  Scoped: an issuer for the same consumer in a different flow is not a re-send and stays locked out.

## [3.0.0] — 2026-08-19

Major: **the authoring model goes declarative, and the engine takes over the model-facing language.**
The turn-protocol, declarative-authoring and capture arcs measured on the reference voice host land
together: every executor outcome becomes a declared verdict row the runner composes the wire body
from; the engine now composes the action descriptions (gate marker first, no verdict index), the
gate reply contracts, and the whole protocol prompt fragment hosts used to hand-roll (and fork); a
non-locking `dictation` awaiting-kind records the standing question a verdict asked; engine-owned
escalation ladders absorb the prompt's "once" rules, with `deflect_aside` folded onto the same
latch; and capture re-ask loops are bounded by an engine counter. Three zero-host subsystems are
removed outright (bounded choices, the guard latch, the forced-handoff net). State drops to six
library slots with the metadata in one compile-key-locked table.
Migration: [migrations/2.5.0-to-3.0.0.md](migrations/2.5.0-to-3.0.0.md).

### Breaking
- **The legacy executor return shape is removed from the public contract** — `Executor` returns only
  `DeclaredExecutorResult` (`{ verdict, data?, stateUpdate?, effects?, resultExtras? }`) against the
  action's declared `ActionDef.verdicts` rows; a verdict with no row fails loudly as
  `executor_error`. `ExecutorResult` is no longer exported. Every downstream executor converts to
  rows (the migration's convert-executors-to-rows transform is mandatory, per action, with a wire
  byte-diff check — declaration order is wire order, so a converted action reproduces its historical
  body bytes exactly).
- **The bounded-choice subsystem is removed** (zero hosts; its jobs are expressed as ladders):
  `REQUEST_BOUNDED_CHOICE_ACTION` / `RESOLVE_BOUNDED_CHOICE_ACTION`, `BoundedChoiceDef` /
  `BoundedChoiceRegistry` / `BoundedChoiceSchema` / `BoundedChoice`,
  `BuildAgentStepToolOptions.boundedChoices`, the `choice` cursor kind, `choice_consumed`, the
  admission choice locks, and the choice message templates are all gone.
- **`deflect_aside` is removed as a control** — the free-aside damper is now a configured ladder
  (`HandoffSpec.deflectAside`, `DEFLECT_ASIDE_ACTION`, the `aside_deflected` template and the
  `deflectedAside` slot are gone; the composed protocol's human-override clause deliberately keeps
  its vestigial "or choice" bytes pending a re-measured scrub).
- **`repeat_pending_confirmation` → `repeat_pending_question`** — the repeat control generalized to
  the whole cursor; export renamed to `REPEAT_PENDING_QUESTION_ACTION`. The sole-step group's error
  code keeps the historical `repeat_confirmation_must_be_sole_step` vocabulary (byte-pinned).
- **`repeatReadBack` now REQUIRES `replyContract`** — validated at construction: a repeatable gate
  routes re-asks through the repeat control, which the generic reply contract forbids.
- **`HandoffSpec.forcedHandoff` / `forcedHandoffRequested` are removed** — the resolver reads only
  the armed `handoff` slot; a terminal business outcome arms its handoff atomically via its verdict
  row's `request_handoff` effect, so "terminal but nothing armed" is unreachable by construction.
  Input-derived terminality converts to a first-turn probe action.
- **`guardTurn` + the guard latch are removed** (`guardFiredOnTurn` / `markGuardFired`; zero users
  family-wide). `resolveCallerTurnId` survives, extracted to `interaction/turn-identity.ts`.
- **The verdict index left the composed action description** — descriptions are now
  `<engine gate marker> <host semantic lead>`; results explain their own verdicts (the enumerated
  index measured as 34% of the domain-action bytes while duplicating the per-turn `reason`s).
- **Library state is six slots** — `awaitingInput`, `currentFlow`, `pagedRead`, `spentLadders`
  (new), `handoff`, `errorCount`; `boundedChoice` / `deflectedAside` / `guardTurn` are gone from
  every fragment, mask, and the task-scoped list.

### Added
- **Declared verdict rows** — `ActionDef.verdicts: Record<string, VerdictDef>`: per code — the `ok`
  flag, the summary (static or a `(state, data)` renderer for language-keyed catalogs), body fields
  composed in declaration order, static `stateUpdate` typed against the host state, row `effects`
  applied ahead of the executor's, and `backendFailure` deriving the auto-handoff code list from the
  declarations. `AgentStepConfig` / `ActionDef` thread the state type (`<ActionName, PrereqName, State>`).
- **Standing asks / the `dictation` awaiting-kind** — `ActionDef.asks` keyed by verdict-or-error
  code (`invalid_params` is a legal key); the batch's FINAL entry sets/clears the non-locking
  record, stamped on the wire as `standing_ask` + `ask_contract` + engine-rendered `ask_text`
  (`DictationAsk.render`; fixed asks measured 8/8 on the wire vs 2/8 from prompt memory).
- **Escalation ladders + `note_refusal`** — `BuildAgentStepToolOptions.ladders` (requires
  `handoff`): the prompt's "once" rules become engine-counted ladders in the task-scoped
  `spentLadders` latch; a free use returns the ladder's instruction, exhaustion escalates atomically
  into its configured handoff (an engine-only route — leave it out of `modelRequestSchema`). Shared
  `climbLadder` core.
- **`ActionDef.captureBounces { max, ladder }`** — consecutive `invalid_params` bounces counted
  under `spentLadders["capture:<action>"]`, cleared by any successful parse, escalating through the
  named ladder. `max: 2` is the measured knob.
- **Engine-composed gate reply contracts** — `ConfirmationOpts.replyContract: GateContractSpec`
  (+ exports `composeGateContract`, `GateContractContext`): the engine writes the frame clauses it
  enforces around the host's measured reply categories; proposals carry the result as
  `reply_contract` (generic template: the new `confirm_reply_contract` message).
- **The engine-composed protocol prompt fragment** — `composeProtocolPrompt(ProtocolSurface)`:
  tool-turn/speaking-turn, the reply/ask contracts, the gate handshake, read-back authority, and
  handoff silence composed from the feature surface; hosts splice `{PROTOCOL}` and put domain
  clauses on `toolTurnRules` (detached placement measured 0/4).
- **`ConfirmationOpts.readBackDirective`** — per-proposal framing of the rendered `read_back`,
  riding the wire as `read_back_directive` (+ the `read_back_directive_repeat` template).
- **Capture builders** — `callerTextParam` (bounded caller-dictated text, count-free refinements),
  `relayParam` (relay-only transcription field), `exactlyOneOf` (XOR refinement over optional params).
- **`AGENT_STEP_SLOT_META`** — one metadata row per library slot; the internal mask, the task-scoped
  list, and the new `agentStepRunnerOwnedSlots` are derived and compile-key-locked (adding a slot
  without its table row fails the build). `compile/activation.ts` unifies the ControlActivation
  construction. New message templates: `confirm_reply_contract`, `standing_ask_contract` (including
  the repeated-value clause: a reply repeating an already-refused value still calls — the engine
  counts those turns), `read_back_directive_repeat`.
- New test suites: `capture-bounce`, `repeat-question`, `note-refusal`, `dictation`, `verdict-map`,
  `action-describe`, `gate-contract`.

### Changed
- Model-facing composed bytes are a versioned contract: hosts pin the model-surface and wire-text
  goldens; an upstream change to composed bytes owes a live re-measurement.
- The canonical tool layout gains `names.ts` (types-only leaf) and per-action `action.ts`
  declarations beside their executors, with `config.ts` a slim assembler.

## [2.5.0] — 2026-08-11

Minor: **the confirmation gate hardens, and configuration keeps absorbing prompt prose.** A survey of
live behaviour across downstream voice agents surfaced the next round of mechanisms being carried in
prompts and host code: recaps re-composed by the model when a caller asks to hear them again,
schema-valid proposals over state that cannot satisfy them, a permissive abort that could discard a
pending gate and start new work in one utterance, terminal-handoff routing pairs living as prompt
prose, silent engine transitions the model could only infer, and fixed choice offers paraphrased at
the moment they mattered. All six move into the engine. Everything is opt-in; nothing is removed or
reshaped, and every default preserves 2.4.0 behaviour byte-for-byte. No new state slot. Suite 207 → 236.
Migration: [migrations/2.4.0-to-2.5.0.md](migrations/2.4.0-to-2.5.0.md).

### Added
- **`repeat_pending_confirmation` control + `ConfirmationOpts.repeatReadBack`** — persist the
  non-empty `readBack` rendering on the pending gate (`awaitingInput.read_back`) and let the
  sole-step control return those EXACT stored bytes on a later caller turn — never re-rendering from
  mutable state, never confirming/executing, never spending an attempt. Repetition advances the
  gate's presentation-turn provenance, so a second ReAct loop can neither repeat again nor execute
  the mutation on the same caller turn; a misdirected call fails closed. Reserved (and injected)
  only when at least one confirm-gated action opts in; the eligible actions are rendered into the
  control's own model-facing description.
- **`ConfirmationOpts.refuseProposal?(params, state)`** — propose-time, STATE-aware refusal: runs
  after params parse and before anything commits; refusing stores no gate, spends no attempt, and
  does not consume a pending bounded choice (the same non-burning semantics as `invalid_params`).
  For proposals whose validity depends on state, not shape — e.g. an empty probe proposing to
  consume a carried identity when nothing was carried.
- **`BuildAgentStepToolOptions.abortPolicy?: AbortPolicy`** — narrow the built-in abort to an
  engine-enforced in-domain transition: `requireActive`, `allowStandalone`, `allowedFollowers`,
  `allowedPendingTargets`. Admission enforces abort-leads-the-batch and at-most-one declared domain
  follower; every knob is validated at construction and the configured contract is rendered into the
  control's model-facing description. Omit for legacy permissive abort, byte-for-byte.
- **`HandoffSpec.modelRequestSchema?: z.ZodType<HandoffRequest>`** — a narrower MODEL-FACING
  `request_handoff` schema, used to generate the wire schema AND parse the control at runtime, so
  exact reason/context route pairs become configuration instead of prompt prose. The library-managed
  slot and trusted executor/config effects keep the base schema.
- **`BoundedChoiceDef.renderRequest` / `renderResolution`** — engine-rendered caller-audible choice
  OFFER and RESUME, riding the control results as `read_back` for the model to speak verbatim — the
  read-back doctrine extended to the bounded-choice overlay.
- New exports: `REPEAT_PENDING_CONFIRMATION_ACTION`, `AbortPolicy` (type). New test suite
  `repeat-confirmation.test.ts`.

### Changed
- **Bounded-choice consumption is transcript-visible** — the consuming step's result is stamped
  `choice_consumed`, so pending/resolved status derives from tool results alone.
- **Leading-resolve batch admitted** — `resolve_bounded_choice` may lead a batch whose followers are
  the pending choice's own `directInputActions` (the shape a model naturally emits when one reply
  both selects "continue" and supplies the suspended detail). Every permitted follower is already
  trusted to consume caller input while the choice is pending; the same-turn locks still apply, and
  nothing is relaxed toward a mutation.
- Control injection order is now: `abort_pending_input` → `request_handoff` →
  `repeat_pending_confirmation` → `request_bounded_choice` → `resolve_bounded_choice` →
  `deflect_aside`. Since every 2.4.0+ control is opt-in, a host that enables none of them keeps a
  byte-identical model-facing surface.

### Docs
- New reference `agent-design-principles.md` — the host-architecture doctrine (mechanism-in-engine,
  language-only prompt, transcript-only state, discovery-by-calling, engine-rendered consequence
  text, one prompt authority per behaviour, configuration-owned payloads, engine-bounded
  consequences, substance-not-phrasing fixtures, layered live measurement), with the five-question
  port-mode audit.

## [2.4.0] — 2026-08-10

Minor: **the trigger-happy-handoff damper.** Field observation across voice agents: a social aside
mid-task ("what's the weather?") was handed off `off_topic` on the FIRST utterance — the caller was
re-routed to an agent that serves the aside no better, and the task dangled. For chit-chat NO
configured agent serves, the re-route buys the caller nothing but a lost turn. The new
`deflect_aside` control makes the POLICY engine-owned (one free in-place deflection per task, then a
deterministic escalation) while the CLASSIFICATION stays with the model (a topic another configured
agent may serve still goes to `request_handoff` with `off_topic`). Misclassification is benign in
both directions. Nothing removed or reshaped. Suite 193 → 207.
Migration: [migrations/2.3.0-to-2.4.0.md](migrations/2.3.0-to-2.4.0.md).

### Added
- **`deflect_aside` control** (`controls/deflect-aside.ts`, opt-in via `HandoffSpec.deflectAside`) —
  params `{ aside }` (the caller's off-task request, in the caller's language). FIRST use per task:
  no handoff — the task-scoped `deflectedAside` latch is set, every pending gate/flow survives
  untouched (allowed during gate lockdown and choice-pending, like the handoff), and the step result
  instructs the model (`SystemMessages.aside_deflected`) to decline in ONE short sentence and repeat
  its pending question in the SAME turn. REPEAT in the same task: escalates ATOMICALLY into the
  `off_topic` handback with the aside as routing `context` — one-shot, like the bounded-choice
  overlay, with no window where the model must issue a second call. Sole-step enforced via the new
  `deflect` exclusivity group (`deflect_must_be_sole_step`); registered LAST so the four established
  schema variants keep their injection order; reserved name only when enabled.
- **`HandoffSpec.deflectAside?: boolean | { actionDescription?: string }`** — `true`/`{}` enables
  the control with its domain-neutral default description; the object form's `actionDescription`
  replaces the LLM-facing schema-variant description (the same override seam `request_handoff` has)
  so a host states its own classification policy. Requires the handoff by construction — the repeat
  path escalates into it.
- **`deflectedAside` slot** — task-scoped: in `agentStepZodShape` / `agentStepStateSpec` /
  `agentStepTaskScopedSlots` (a task-ENDING handback clears it; an `off_topic` roundtrip
  deliberately does NOT re-arm the freebie) and in the runner's `stateUpdate` ownership guard.
  `agentStepInternalSlotMask` grows 7 → 8 keys. Construction REQUIRES the channel only when the
  control is enabled — without it the latch write would be silently discarded, so
  `buildAgentStepTool` refuses to construct.
- **Exports** `DEFLECT_ASIDE_ACTION`, `DEFLECT_ASIDE_ACTION_DESCRIPTION`; **`SystemMessages.aside_deflected`**
  (model-facing instruction, not caller-audible; host-overridable like every system message).
- `deflect-aside.test.ts` — 14 tests: opt-in gating, latch + survival of confirmation / OTP+flow /
  match / bounded-choice pendings, atomic escalation with context, task-scoped clearing AND
  `off_topic` latch survival, sole-step, invalid params, message override, missing-channel
  construction refusal, object-form description override.

## [2.3.0] — 2026-08-09

Minor: **mechanisms move into the engine.** A survey of the voice-agent family found three mechanisms
being hand-rolled per host and two re-derivations of things the library already owned — each one
reaching around a library boundary. Hosts overrode the handback signal and metadata by mutating the
resolved message's `additional_kwargs` from OUTSIDE (a shape the library documents as a frozen channel
contract), which also left the `handoff` control-plane event carrying the pre-override reason; hosts
forced a handback from their own graph node, writing the library-managed `handoff` slot that 2.0.0 put
off-limits; hosts re-derived "the current caller turn" by scanning the transcript because the library's
own resolver was unreachable; and the model was left to paraphrase captured digits back to the caller
even though the library owns the capture. Nothing is removed or reshaped. Suite 173 → 193.
Migration: [migrations/2.2.0-to-2.3.0.md](migrations/2.2.0-to-2.3.0.md).

### Added
- **`HandoffSpec.forcedHandoff?(state)`** + **`forcedHandoffRequested(state, spec)`** — derive a handoff
  when the MODEL ended a turn in plain text but state says the task is over. Resolved inside
  `createHandoffNode` (`state.handoff ?? spec.forcedHandoff?.(state)`), so the graph stays three nodes,
  the forced request is never written to state, and predicate and resolver call the same pure function
  and cannot disagree. A pending slot always wins.
- **`HandoffSpec.resolveHandoffType?(state, request)`** — decide the handback SIGNAL from state,
  resolved BEFORE the first control-plane event so the event, the closing line, `handoff_type` and
  `service_type` agree. Terminate-mode `completed`/`abandon` only; it can never produce or erase an
  `off_topic`, so delegate detection and the task-ending clear are unaffected by construction.
- **`HandoffSpec.resolveHandoffMetadata?(state, request)`** — host fields merged into
  `handoff_metadata` for every handback INCLUDING `off_topic` (identity forwarded to a call-scoped
  store must survive a re-route), never for a successful delegate. The library's own keys are applied
  LAST and cannot be clobbered.
- **`guardTurn` slot + `guardFiredOnTurn` / `markGuardFired`** (`interaction/guard-latch.ts`) — fire a
  HOST model-input guard at most once per caller turn despite the ReAct loop re-entering the model
  within that turn. Entries expire when the turn id changes, so it is deliberately turn-scoped, not
  task-scoped. With no turn identity it stays UNLATCHED rather than locking a consumer out.
- **`resolveCallerTurnId`** is now exported — the library's own definition of the current caller turn
  (host hook, else the latest human message id), the same identity the confirmation gate and the
  bounded-choice control use.
- **`ConfirmationOpts.readBack?(params, state)`** → **`read_back`** on the proposal body. The library
  owns the capture (`capture.ts` sanitized, joined and validated the params), so it owns reporting it
  back; the host supplies only the lexicon. Rendered from the PARSED params — including on a
  re-proposal, from the corrected value — and never on the executing re-call.

### Changed
- `agentStepInternalSlotMask` grows to seven keys (`guardTurn`). `agentStepTaskScopedSlots` is
  unchanged: the latch is turn-scoped and expires on its own.
- The executor `stateUpdate` guard stays at the six RUNNER-owned slots and now says why: `guardTurn` is
  a library slot the runner never transitions, so guarding executors against it would ban nothing.
- `markGuardFired` patches do NOT compose by spreading — each carries a whole `guardTurn` map built
  from the state passed in, and the reducer replaces, so two patches from the SAME state lose the
  first. Documented on the helper and pinned by a test.

## [2.2.0] — 2026-08-07

Minor: **task-scoped state no longer outlives the task**. A channel middleware reuses ONE thread id
for a whole call and never resets it on re-dispatch, so the thread outlives the task — whatever sits
in state when a handback resolves is what the NEXT task on that thread starts from. A host whose
graph derives a forced handback or escalation from a terminal domain slot re-fired it on every later
turn, with no way out. `createHandoffNode` now nulls task-scoped state as it resolves a task-ENDING
handback. Public surface is additive only; no existing export or signature changes.
Suite 168 → 173. Migration: [migrations/2.1.0-to-2.2.0.md](migrations/2.1.0-to-2.2.0.md).

### Added
- `agentStepTaskScopedSlots` (`state.ts`, re-exported from `index.ts`): the library slots that
  describe work in progress — `awaitingInput`, `currentFlow`, `boundedChoice`, `pagedRead`,
  `errorCount`. `handoff` is deliberately absent (the node returns it as null either way).
- `HandoffSpec.clearsOnHandback?: readonly (keyof T & string)[]` — host DOMAIN slots to null on a
  task-ending handback. Optional; the library's own task-scoped slots clear automatically.

### Changed
- `createHandoffNode` clears the task-scoped slots plus the host's declared domain slots when a
  `completed` / `abandon` handback resolves in terminate mode. **`off_topic` clears nothing** (a
  mid-task aside must stay resumable) and **a successful delegate clears nothing** (the conversation
  never left this agent) — both are correctness invariants, not configurable. The closing line, the
  signal, and any `resolveClosingMessage` reading state are computed BEFORE the clear, so the reply
  is unaffected.
- Cleared slots are written as plain `null`, so a declared domain slot must be nullable with a
  replace-style reducer; slots whose reducer merges cannot be cleared this way.

## [2.1.0] — 2026-08-06

Minor: adds the **caller-digit capture primitives** (`capture.ts`) — pure schema helpers for
params carrying caller-dictated digits (tax numbers, card-number tails). Promoted from a
downstream voice agent where the pattern was developed against live STT failures; the helpers
encode invariants the runner already imposes (shape rules as refinements so no `pattern` reaches
the model-facing JSON Schema; count-free refinement messages because issue text rides `_debug`
back to the model; separator strip + singleton-array collapse in the preprocess so the
confirmation gate's parsed-params compare never reads a representation flip as drift; the honest
wire union for group-array fields). The model-facing `describe` is a REQUIRED option with no
default — field wording stays owned and QA-gated per host; the authoring doctrine and a proven
description template live in `agent-step-api.md` `<caller_digit_capture>`.
No existing export changes. Suite grows 144 → 168 (24 capture tests).
Migration: [migrations/2.0.0-to-2.1.0.md](migrations/2.0.0-to-2.1.0.md).

### Added
- `capture.ts` + `capture.test.ts`: `digitsOnly`, `digitsOnlyDeep`, `callerDigits`,
  `digitGroupsParam`, `digitCandidatesParam` (+ `DigitGroupsParamOpts`,
  `DigitCandidatesParamOpts`), exported from `index.ts`.
- `agent-step-api.md` `<caller_digit_capture>`: the capture doctrine (refinement-not-regex,
  count-free messages, representation-flip normalization, honest wire union) and the
  description-authoring guidance (transcription framing, semantic neutrality, concrete
  renderings, omission semantics).

## [2.0.0] — 2026-08-05

Major: the executor contract is reshaped around **typed effects**, the runner is restructured into
phase modules with explicit contracts, and the library absorbs the **bounded-choice** capability
plus a hardening round of turn-provenance guards. Runtime semantics for existing flows are
otherwise 1.8.1's, and the model-facing tool surface (name + description + provider JSON schema)
is byte-identical to 1.8.1 (golden-verified upstream). Absorbed from a downstream agent where the
restructure was developed and verified (full unit suite + 182 host sandbox tests).
Migration: [migrations/1.8.1-to-2.0.0.md](migrations/1.8.1-to-2.0.0.md).

### Breaking
- **`ExecutorResult` reshape.** `lifecycle` and `flowData` are gone; both are typed entries in the
  new optional `effects: ExecutorEffect[]`: `lifecycle.issuesOtp: {…}` → `{ type: "otp_issued" }`
  (the payload was never read by the runner — keep challenge details in `resultBody` /
  `merge_flow_data`); `lifecycle.clearAwaitingInput` → `{ type: "clear_awaiting_input" }`;
  `lifecycle.abortFlow` → `{ type: "abort_flow" }`; `flowData: {…}` →
  `{ type: "merge_flow_data", data: {…} }`.
- **`stateUpdate` is domain-only.** Writing a library-managed slot (`awaitingInput`, `currentFlow`,
  `boundedChoice`, `pagedRead`, `handoff`, `errorCount`) through `stateUpdate` now throws. An
  executor-requested terminal handoff is `{ type: "request_handoff", request }` — and unlike the
  1.x slot write, it applies the same atomic cleanup as the built-in `request_handoff` action.
- **`stateAnnotation` option removed** (deprecated alias since 1.7.0) — pass `stateSchema` (same
  accepted values: `Annotation.Root` or Zod object).
- **`ConfirmationOpts.ttlMs` removed** (was accepted-but-inert) and **`OtpOpts` deleted** (was an
  empty placeholder; never exported) — `requiresOtp` is plain `boolean`.
- **Stricter construction-time validation.** Cross-action config pairs
  (`startsMatchFor`↔`requiresMatch`, `issuesOtp.consumer_action` / `requiresMatch.capturer`
  existence) fail at construction instead of mid-conversation; `buildAgentStepTool` also rejects a
  state schema missing a channel for any library slot the configuration writes.
- **Confirmation turn-provenance.** Proposals are stamped with the caller turn
  (`proposed_on_caller_turn_id`, additive `AwaitingInputSchema` field); a matching re-call on the
  SAME caller turn is refused (`confirmation_same_turn_locked`) without spending an attempt —
  execution requires the caller to have actually answered on a later turn. Enforced only when both
  turn identities exist; identity-less direct `runSteps` fixtures keep params-only behavior.
  Test suites driving propose → execute by hand must simulate the answering turn (the bootstrap
  harness ships `runConfirmed` / `answeredTurn` / `callerTurn` helpers).
- **Import paths for non-index imports** changed (`handoff.js` split into `handoff/contract.js` +
  `handoff/node.js` + `handoff/delegate-client.js`). Projects importing only from
  `agent-step/index.js` (the documented surface) are unaffected — every 1.x index export except the
  deleted items above is still there.

### Added
- **Bounded-choice overlay.** `BuildAgentStepToolOptions.boundedChoices` injects two library-owned
  controls — `request_bounded_choice` / `resolve_bounded_choice` — implementing one engine-owned,
  one-shot conversational choice layered OVER any pending domain gate: lockdown while pending
  (only controls / abort / handoff / configured `directInputActions` run), offered-this-turn and
  resolved-this-turn locks keyed on caller-turn identity, consume-on-acceptance for direct inputs,
  an `onRepeatHandoff` atomic fallback, and a persistent `resolved` state so the choice is never
  re-offered. New `boundedChoice` state slot (rides `agentStepZodShape`), `BoundedChoiceSchema` /
  `BoundedChoice` / `BoundedChoiceDef` / `BoundedChoiceRegistry` exports, and the
  `REQUEST_/RESOLVE_BOUNDED_CHOICE_ACTION` constants.
- **`getCallerTurnId` option** — stable caller-turn identity resolver backing the turn-keyed
  guards (defaults to the latest human message id; hosts that compact or replace messages must
  provide one).
- **`ExecutorEffect`** exported type.

### Changed
- **Phase-module restructure.** One 2,268-line `runner.ts` becomes `compile/` (validate →
  normalize → schema/description), `run/` (admission → planning → execution → finalize, with
  `batch-state.ts` as the single write path), `interaction/` (one policy module per gate kind),
  `controls/` (model-facing library actions in an ordered registry), `handoff/` (contract / node /
  delegate transport). `runner.ts` is now the thin public entry point; hosts import only from
  `index.js`.
- **Handoff monotonicity enforced.** Once the `handoff` slot is set (control or executor effect),
  the step's remaining interaction lifecycle is skipped and the batch ends after the current step.
- **Abort-aware planning + admission.** Confirm steps after an `abort_pending_input` in the same
  batch plan against no pending (propose fresh, full attempts); `soleOnExecute`'s execute
  prediction is abort-aware the same way.
- **Bounded-choice consume-on-acceptance** and same-turn locks (see Added) are enforced batch-wide
  by admission, in a fixed, documented rule order.
- **Canonical value equality** builds null-prototype objects — own `__proto__` keys are data,
  never prototype writes.
- Test suite grows 105 → 144 across six files: `runner.test.ts`, `handoff.test.ts`,
  `paginate.test.ts`, `zod-state.test.ts` + new `bounded-choice.test.ts` and `hardening.test.ts`.

### Unchanged on purpose
- State slot names and shapes (persisted threads and observability tooling keep their vocabulary).
- `runSteps(opts, steps, initialState)` / `buildAgentStepTool(opts)` signatures — the test and
  host seams.
- The wire result body (`{ summary, results, failed_at? }`, entry fields, error codes, `_debug`)
  and all runner-emitted summaries/messages (`messages.ts` is byte-identical).
- The channel contract (handoff node events + final-message `additional_kwargs` envelope).

## [1.8.1] — 2026-07-23

Patch: the auto-handoff error counter now treats **no-executor batches as NEUTRAL** — they neither
increment nor reset the consecutive-failure streak. Absorbed from a downstream agent that traced a
live simulated outage. No API surface change; no project-side transforms. Suite grows 103 → 105.
Migration: [migrations/1.8.0-to-1.8.1.md](migrations/1.8.0-to-1.8.1.md).

### Fixed
- **The failure streak survives confirm-gate proposals.** A confirm-gated action retried during a
  backend outage necessarily interleaves a proposal between every two failing executes (the failed
  execute consumes the pending confirmation, so the retry re-proposes). The proposal — a successful
  batch in which NO executor ran — reset the counter under the 1.8.0 rule: fail → 1, re-propose →
  0, fail → 1, … so the auto-handoff threshold was unreachable for EVERY confirm-gated action. The
  reset now requires that an executor **actually ran** in the batch (`anExecutorRan`, set before
  the call so a throw still counts): executed work is the only proof the backend recovered.
  Proposals/re-proposals, prereq denials, param-validation failures, `abort_pending_input`, and
  handoff signals are neutral — aligning the main loop with the early-return refusals (lockdown,
  batch shape), which already bypassed the counter. The increment side is unchanged.
  Behavior delta: hosts using confirm gates + `backendFailureCodes` now actually escalate at the
  threshold (previously never); a host that relied on a non-executed turn (e.g. `invalid_params`)
  wiping the streak will see it survive instead. `state.ts` `errorCount` doc-comment updated.

## [1.8.0] — 2026-07-23

Additive surface + four behavior fixes, absorbed from a downstream agent — all host-configurable,
no domain strings baked in. The confirmation gate now compares schema-NORMALIZED params (a
value-normalizing schema no longer makes confirmation impossible), `invalidatesOnChange` uses deep
value equality (no spurious cascades on fresh-but-equal object writes), EVERY runner-emitted
summary is now a host-overridable templated system message, and the auto-handoff instruction
defaults to platform-delivers wording. No API removal or signature change. Suite grows 94 → 103.
Migration: [migrations/1.7.2-to-1.8.0.md](migrations/1.7.2-to-1.8.0.md).

### Added
- **17 templated `SystemMessages` keys** — the lockdown refusals (`lockdown_confirmation` /
  `lockdown_otp` / `lockdown_match`), the batch-shape refusals (`handoff_must_be_sole_step`,
  `mutation_must_be_sole_step`, `mutation_execute_must_be_sole`, `mutation_must_be_last_in_batch`),
  the confirmation outcomes (`confirm_proposed` / `confirm_reproposed` / `confirm_exhausted`), the
  OTP/match gate refusals (`otp_not_pending`, `match_not_pending`, `otp_blocked_match_pending`,
  `match_attempts_exhausted`), `handoff_requested`, `no_steps`, and `auto_handoff_instruction` —
  with `{placeholder}` interpolation via a new `formatMessage` helper (`messages.ts`; unknown
  placeholders stay verbatim). Templates are plain strings, so overrides can live in JSON locale
  resources. English defaults preserve the previous hardcoded strings (except
  `auto_handoff_instruction`, below). Previously only 9 runner summaries were overridable; now all are.
- **`HandoffSpec.actionDescription`** — override the LLM-facing description of the auto-injected
  `request_handoff` schema variant, for hosts whose `resolveClosingMessage` composes every closing
  from state (the built-in text tells the model its `context` is SPOKEN — describe it truthfully
  instead, or the schema contradicts the host prompt).

### Changed
- **Confirm gate compares canonicalized PARSED params** — new `paramsMatchPending` parses the raw
  re-call with the action's effective schema before comparing against the stored (parsed) proposal;
  a failed parse counts as drift. The propose branch parses with the same schema (was the bare
  `paramsSchema`). Fixes a blocking defect: any value-normalizing schema (e.g. a `z.preprocess`
  stripping STT separators, `"70,76"` ≡ `"7076"`) made a confirmed re-call read as drift →
  re-propose loop → attempts exhausted without ever executing. Behavior delta: re-calls that
  normalize to the stored proposal now EXECUTE (previously re-proposed); no legitimate flow relied
  on the old behavior.
- **Propose-path `invalid_params` no longer leaks raw Zod text** — the summary is the overridable
  `invalid_params` system message; the raw detail moves to `_debug`, matching the execute path and
  the documented `_debug` convention.
- **`invalidatesOnChange` uses deep value equality** (canonicalized JSON) instead of `Object.is` —
  an executor writing a fresh-but-value-equal OBJECT no longer fires a spurious cascade. New
  `types.ts` caveat: invalidation targets must be replace-on-write slots (a record-merge reducer
  swallows the cascade's `null` at the graph boundary).
- **Auto-handoff instruction defaults to platform-delivers wording** — the synthetic `auto_handoff`
  result's summary no longer instructs the model to speak the closing (both taught wiring paths
  deliver it platform-side; "speak this exact message" invited double-speaking). A host whose graph
  does NOT deliver the closing overrides `auto_handoff_instruction` and uses the `{message}`
  placeholder to restore the old behavior.

## [1.7.2] — 2026-07-02

Patch: two runtime fixes aligning the runner with its documented contract, plus doc-comment
precision. No API surface change; no project-side transforms. Suite grows 91 → 94.
Migration: [migrations/1.7.1-to-1.7.2.md](migrations/1.7.1-to-1.7.2.md).

### Fixed
- **Delegate stream timer now starts after connect.** `runDelegate` created both timeout signals
  at entry, so a slow thread-creation call ate into the streaming budget (`timeoutMs` was
  documented as starting "once the run has started", but the timer ticked from delegate entry).
  The stream signal is now created only after the connect phase returns; `connectTimeoutMs` /
  `timeoutMs` doc-comments state the phase each timer actually covers. Two new handoff tests
  cover the connect-timeout fallback and the stream-timer start point.
- **Missing state schema now throws at construction.** `buildAgentStepTool` called with neither
  `stateSchema` nor the deprecated `stateAnnotation` threw only on the first tool call (inside
  `runSteps`), although 1.7.0 documented the failure as construction-time — and since 1.7.0 made
  both options optional in the type, nothing failed at startup. `validateConfig` now enforces it
  at construction; the `runSteps` guard remains for direct callers (test harnesses).
- **`errorCount` doc-comment matched to the runner** (`state.ts`): host-listed
  `backendFailureCodes` verdicts also increment the counter (not only `executor_error`), and it
  resets on any batch that does not end in a backend failure — not only on a "fully successful"
  one.

## [1.7.1] — 2026-06-30

Patch: corrects the recommended `AgentInputSchema` derivation so LangGraph Studio renders its chat
input box. The 1.7.0 recipe ran `.partial()` over the whole input schema, which strips the
`messages` channel metadata Studio keys off — Studio then fell back to the raw-state editor ("pass
new messages as state") instead of the message input box. No library code change (the vendored
runner is byte-identical to 1.7.0); the fix is in the toolkit's project-state template + references.
Absorbed from a downstream agent that hit the missing-chat-box symptom after migrating its graph
input to `AgentInputSchema`. Migration: [migrations/1.7.0-to-1.7.1.md](migrations/1.7.0-to-1.7.1.md).

### Changed
- **`AgentInputSchema` re-attaches `messages` after `.partial()`** —
  `AgentStateSchema.omit({...}).partial().extend({ messages: MessagesZodState.shape.messages })`.
  The caller-supplied identity fields stay optional, while `messages` keeps its native
  typed-and-required messages shape (with the channel metadata) so Studio renders the chat input box.
  `MessagesZodState` is already imported for `AgentStateSchema`, so no new import is needed.

## [1.7.0] — 2026-06-30

Additive: a **Zod state schema is now a first-class alternative to a LangGraph `Annotation.Root`**.
The runner derives its intra-batch merger from either form, so a project can define graph state
**once** in Zod — one source of truth for reducers AND validation — and gain invoke-boundary
validation/coercion via a derived input schema. Absorbed from a downstream agent that used it to fix
a Studio crash (a numeric `telephone_number` reaching `.startsWith` as a non-string) and to stop
internal slots being injected at invoke. No breaking change — `stateAnnotation` still works as a
deprecated alias. Suite grows 89 → 91. The toolkit's templates + references now teach **only** the
single Zod-schema pattern. Migration: [migrations/1.6.0-to-1.7.0.md](migrations/1.6.0-to-1.7.0.md).

### Added
- **`stateSchema` option** on `buildAgentStepTool` (`BuildAgentStepToolOptions.stateSchema:
  StateSchemaLike`) — accepts a LangGraph `Annotation.Root` OR a Zod object whose fields carry
  reducer/default metadata via `withLangGraph` (`@langchain/langgraph/zod`). Both resolve to the same
  channel classes, so the merger reads `.operator` off either uniformly (a Zod schema's channels are
  resolved through the langgraph zod registry).
- **`StateSchemaLike`** type and **`agentStepInternalSlotMask`** const exported from `index.ts`. The
  mask is a Zod `.omit()` mask of the five library-managed slot keys (`awaitingInput`, `currentFlow`,
  `pagedRead`, `handoff`, `errorCount`) for deriving a graph INPUT schema that callers can't use to
  inject internal slots.
- **`zod-state.test.ts`** — isolation test proving the merger derives reducers off a Zod schema
  (first-wins vs `LastValue`) exactly as off an `Annotation.Root`.

### Changed
- **`agentStepZodShape` slots are now `withLangGraph`-wrapped** — spreading the fragment into a Zod
  state schema now carries each library slot's real last-writer-wins reducer + default as channel
  metadata (previously the Zod fragment was `.nullable().optional().default(null)`, i.e. `LastValue`
  with no registered reducer). The channel default rides the meta `default`, and fields stay plain
  `.nullable()` (a `withLangGraph` requirement).

### Deprecated
- **`stateAnnotation`** is now a deprecated alias of `stateSchema` (still accepted; the runner reads
  whichever is set). The runner throws at construction if neither is provided. New code uses
  `stateSchema`.

## [1.6.0] — 2026-06-26

Additive: an **auto-handoff safety net** — the runner counts consecutive backend failures and
auto-triggers a handoff at a threshold, so a customer is never trapped in an error loop. Plus a
**silent off_topic hand-back** and **split delegate timeouts**. Reconciled from multiple downstream
agents that had each grown the feature with hard-coded, project-specific failure codes; the library
version is **host-configurable** (no domain codes baked in). No
breaking change. Suite grows 83 → 89.
Migration: [migrations/1.5.0-to-1.6.0.md](migrations/1.5.0-to-1.6.0.md).

### Added
- **Auto-handoff** (`agent-step-api.md` `<auto_handoff>`): new library-managed `errorCount` slot
  plus three `BuildAgentStepToolOptions` — `backendFailureCodes?: string[]` (host verdicts that
  count as a backend failure; the runner-raised `executor_error` always counts),
  `errorHandoffThreshold?: number` (default 3), and `onErrorThreshold?(update, state)` (host hook
  to inject a custom handoff signal). At the threshold the runner writes the library `handoff` slot
  (`reason: "abandon"`) and/or calls the hook, resets the counter, and appends a synthetic
  `auto_handoff` step result. **Inert** unless a handoff path (the `handoff` opt or
  `onErrorThreshold`) is configured.
- `SystemMessages.auto_handoff` — the spoken line at the threshold (neutral English default;
  override via `messages`).
- `HandoffDelegateTarget.connectTimeoutMs` — separate connect-phase timeout for delegate runs.

### Changed
- **off_topic hand-back is now silent**: `createHandoffNode` emits empty spoken content
  (`success_message: ""`) for `off_topic` instead of `terminateMessage` — a topic change is an
  agent-to-agent re-route the destination agent narrates. `terminateMessage` is now only the
  delegate-FAILURE fallback. `completed` / `abandon` are unchanged.
- Delegate timeouts split: connect phase defaults to 10s (`connectTimeoutMs`), streaming phase to
  20s (`timeoutMs`, was a single 60s).

## [1.5.0] — 2026-06-26

Additive surface + two flow-control hardenings, absorbed from a downstream project. Host-overridable
runner system messages (new `messages.ts`), an honesty hook for handback closings, and stricter
double-entry / OTP ordering so a single batch can't bypass the second PIN entry. No breaking change;
the new APIs are opt-in and the guards only refuse batch shapes that were never safe. Suite grows
79 → 83. Migration: [migrations/1.4.0-to-1.5.0.md](migrations/1.4.0-to-1.5.0.md).

### Added
- **`messages.ts`** (new library file): `SystemMessages`, `DEFAULT_SYSTEM_MESSAGES` (neutral English),
  `resolveSystemMessages()` — all exported from `index.ts`. The runner's own refusal/error `summary`
  strings (executor crash, invalid params, unknown action, abort, flow gates) are now overridable via
  `buildAgentStepTool({ messages })` (`Partial<SystemMessages>`, shallow-merged). The library imports
  no host strings; a localized / voice-safe agent injects its wording.
- **`_debug`** field on `executor_error` / `invalid_params` step results — carries the raw technical
  cause so the (overridable, user-safe) `summary` no longer has to leak it.
- **`HandoffSpec.resolveClosingMessage?(state, request)`** — override the `completed` / `abandon`
  closing line from actual operation outcomes (honesty invariant: speak success only when state proves
  it persisted). Returns a string to replace `request.context`, or `undefined` to fall through.
  Never called for `off_topic`.

### Changed
- **Double-entry match is frozen to batch start.** A `requiresMatch` consumer is gated on the
  awaiting-input snapshot at batch start, so a capturer + its consumer in ONE batch is refused
  (`match_not_pending`) — the repeat must arrive in a separate turn (mirrors the confirmation
  same-batch-bypass guard). The `[consumer, issuer]` batch is unaffected.
- **Match-then-OTP ordering guard.** An `issuesOtp` step is refused with `otp_blocked_match_pending`
  (pre-execution, before the SCA backend is called) while a double-entry match gate is still pending,
  so `[capturer, issuer]` can no longer mint+send an OTP that overwrites the unconsumed match gate.

## [1.4.0] — 2026-06-12

Additive: the built-in `request_handoff` now covers the **full handback signal set** —
`HandoffRequest.reason` widens to `off_topic | completed | abandon` (`context` is per-reason:
the customer's request for `off_topic`; the **LLM-composed closing line** for `completed` /
`abandon`, which the resolver node delivers verbatim as the final reply — it may reference
what was done, matching the middleware's passive handback semantics: reply delivered, routing
flips for the next request). `completed` / `abandon` are terminate-only by nature (never
delegated); `off_topic` keeps the fixed envelope / delegate run. `HANDBACK_SIGNALS` extends
(identity, canonical lowercase). `context` now requires `min(1)`. Suite grows 76 → 79.
Migration: [migrations/1.3.1-to-1.4.0.md](migrations/1.3.1-to-1.4.0.md).

### Added
- `HandoffRequest.reason`: `"completed"` / `"abandon"` accepted alongside `"off_topic"`;
  `HANDBACK_SIGNALS` maps all three (identity).
- Resolver: `completed` / `abandon` speak `request.context` (LLM-composed closing) with their
  signal in `handoff_type`; the action description teaches all three reasons.

## [1.3.1] — 2026-06-12

Fix: the handback signal emitted as `handoff_type` by `createHandoffNode` (terminate mode /
delegate-failure fallback) is now the middleware's canonical lowercase vocabulary —
`HANDBACK_SIGNALS.off_topic` emits `"off_topic"` instead of `"OFF_TOPIC"`. Behaviorally
compatible either way (the middleware matches handoff types case-insensitively, verified
against its handoff-processor source), but the library now emits the exact canonical
strings. No API-surface change. Migration:
[migrations/1.3.0-to-1.3.1.md](migrations/1.3.0-to-1.3.1.md).

### Fixed
- `HANDBACK_SIGNALS` values lowercased to the middleware's canonical vocabulary (identity
  mapping today: `off_topic` → `"off_topic"`); `handoff_metadata.service_type` follows.

## [1.3.0] — 2026-06-12

Additive: **library-coordinated channel handoff** for specialized agents. Opt in via
`buildAgentStepTool({ handoff: spec })` — the runner auto-injects the reserved
`request_handoff` action (sole-step, no prereqs, lockdown-bypassing; pure write of the new
library-managed `handoff` slot), and the host graph resolves it with `createHandoffNode(spec)`
behind a `handoffRequested` conditional edge: **terminate** mode emits the OFF_TOPIC handback
`additional_kwargs` with the envelope as `success_message`; **delegate** mode calls another
LangGraph deployment over the Platform API (fetch+SSE, `replyNode` token filtering for voice,
behavioral fallback to the envelope) and KEEPS the conversation — its final message is not a
handoff (informational `delegated_to` only). Control-plane custom events (`handoff`,
`delegated_token`, `handoff_complete`, `delegated_restart`) for streaming clients
(`stream_mode: ["messages-tuple", "custom"]`). Hosts spreading
`agentStepStateSpec` / `agentStepZodShape` get the `handoff` slot for free. Test suite grows
65 → 76. Migration: [migrations/1.2.0-to-1.3.0.md](migrations/1.2.0-to-1.3.0.md).

### Added
- `handoff.ts` + `handoff.test.ts` — `HandoffSpec` / `HandoffOffTopicSpec` /
  `HandoffDelegateTarget`, `createHandoffNode`, `handoffRequested`, `HANDOFF_ACTION`,
  `HANDOFF_NODE`, `HANDOFF_ACTION_DESCRIPTION`, `handoffParamsSchema`, `HANDBACK_SIGNALS`
  (reason → `handoff_type` signal; `off_topic` → `"OFF_TOPIC"`, the extension point for
  `completed` / `abandon`).
- `BuildAgentStepToolOptions.handoff?` (optional) — auto-injects `request_handoff`; the name
  is reserved ONLY while the opt is provided (a tool without the opt may define its own
  `request_handoff` action — the orchestrator/scaffold mechanism does). Batches containing
  the built-in plus anything else are refused whole with
  `error: "handoff_must_be_sole_step"`.
- Library-managed `handoff: HandoffRequest | null` slot — `HandoffRequestSchema` exported,
  included in `agentStepStateSpec` / `agentStepZodShape` / `LibraryManagedSlots`.

## [1.2.0] — 2026-06-11

Additive: `PagedCacheSchema` is now re-exported from `index.ts`, completing the library-managed
slot-schema trio (`AwaitingInputSchema` / `CurrentFlowSchema` were already exported; the paged-read
schema was exported from `state.ts` but missing from the barrel). Hosts that spread
`agentStepStateSpec` / `agentStepZodShape` are unaffected; hosts that hand-rolled a `PagedCache`
Zod schema can now import the real one. Migration:
[migrations/1.1.1-to-1.2.0.md](migrations/1.1.1-to-1.2.0.md).

### Added
- `PagedCacheSchema` re-exported from `index.ts` (no new symbol — `state.ts` already exported it;
  the barrel omission made it unreachable for consumers importing from `./agent-step/index.js`).

## [1.1.1] — 2026-06-09

Internal: doc-comment corrections only — no behavior, signature, or export change. Surfaced by a
contract audit comparing the library's documented guarantees against live runtime behavior across
several consumers. Migration: [migrations/1.1.0-to-1.1.1.md](migrations/1.1.0-to-1.1.1.md) (no
consumer transforms — the refreshed doc-comments are the whole upgrade).

### Fixed
- `runner.ts` header referenced a non-existent `cancel_pending_confirmation` action — corrected to
  the actual reserved action `abort_pending_input`.
- `ConfirmationOpts.ttlMs` is now documented as **INERT** (accepted for forward-compat, never read;
  the runner times nothing out) in `types.ts`, and the `CONFIRMATION_DEFAULTS.ttlMs` value is marked
  unused in `runner.ts` — aligning the type doc-comment with the runner and the `agent-step-api.md`
  reference, which already flagged it inert.

### Changed (documentation)
- `ExecutorResult.ok` is now documented as a **batch-continuation control flag, not a
  success/verdict signal** — `ok: true` for a "negative" outcome (verdict in `resultBody`) is valid
  when later steps should still run. Reconciled the apparent Pattern 1 vs Pattern 2 conflict in
  `executor-patterns.md`.
- `startsFlow` doc now states that a flow persists across turns and is cleared only by
  `endsFlow`/`abortFlow` — there is no implicit reset on a goal-switch; the host must drive it.

## [1.1.0] — 2026-06-08

Additive: native read-pagination. Opt a list read into uniform pagination with `pageable` on its
action; the runner injects `page`/`pageSize` params, returns a standard
`{ page, pageSize, totalCount, totalPages, hasMore, items, fromCache }` envelope, and (self mode)
caches the full set in the new library-managed `pagedRead` slot so a same-query re-page skips the
executor. Opt-in — existing tools are unaffected. Migration: [migrations/1.0.0-to-1.1.0.md](migrations/1.0.0-to-1.1.0.md).

### Added
- `paginate.ts` (new library file): `PageableSpec` / `PageEnvelope` / `PagedCache` types +
  `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `clampPageSize`, `querySignature`, `pageRows`,
  `buildPageEnvelope`. Exported from `index.ts`.
- `ActionDef.pageable?: PageableSpec` — `true` (self-paginate), `"delegate"` (backend pages), or
  `{ mode, pageSize?, maxPageSize? }`.
- Library-managed `pagedRead` state slot (`PagedCacheSchema`; added to `agentStepStateSpec` +
  `agentStepZodShape`).

### Changed
- New construction-time check: a `pageable` action's `paramsSchema` must be a `z.object` (the runner
  merges `page`/`pageSize` into it).
- `package.json` `test` script broadened to `dist/agent-step/*.test.js` (runs the new `paginate.test.js`
  alongside `runner.test.js`).

## [1.0.0] — 2026-06-05

Breaking: per-action **state selectors**. The runner now projects the host state down
to a per-action slice before calling the executor, so executors receive only what they
need — not the whole state. Migration: [migrations/0.1.0-to-1.0.0.md](migrations/0.1.0-to-1.0.0.md).

### Breaking
- `buildAgentStepTool` / `runSteps` require a new `selectors` registry — one `Selector` per
  action, keyed by action name. New signature:
  `buildAgentStepTool({ config, stateAnnotation, selectors, executors, verifiers })`.
- Selectors and the `executors` registry are now keyed by the **exact action name** (snake_case).
  The snake-to-camel executor-key convention is gone (`toExecutorKey` removed); the runner now
  dispatches `executors[action](params, selectors[action](view))`.
- `Executor<T>` → `Executor<Slice, T>` — the executor's `state` param is the selector's return,
  not the whole state. `ExecutorRegistry<T>` → `ExecutorRegistry<T, Selectors>`, per-action typed
  from each selector's return so a mismatch is a compile error at the construction boundary.

### Added
- `Selector<T>` and `SelectorRegistry<T, ActionName>` exports.

### Changed
- Executor throws are now caught by the runner and surfaced as an `ok:false` step
  (`error: "executor_error"`) instead of escaping `runSteps`; earlier steps' commits are preserved.
- Removed the inert `proposedAt` timestamp from pending confirmations (TTL was already removed).

## [0.1.0] — baseline

Initial embedded library. No migration guide (nothing precedes it).

- `buildAgentStepTool({ config, stateAnnotation, executors, verifiers })`, `runSteps`, `defineConfig`.
- Executor signature `Executor<T> = (params, state: T) => Promise<ExecutorResult<T>>` — executor
  receives the whole state.
- Lifecycle: confirmation propose/execute, OTP issue/consume, double-entry match, multi-turn flow,
  batch-isolation (`soleStep` / `soleOnExecute`), `invalidatesOnChange`.
