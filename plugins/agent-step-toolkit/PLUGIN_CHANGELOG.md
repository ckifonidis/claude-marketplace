# agent-step-toolkit plugin changelog

Version history for the **plugin package** (`.claude-plugin/plugin.json` + the marketplace entry) —
the skills, templates, references, and workflows the plugin ships.

This is distinct from [`CHANGELOG.md`](CHANGELOG.md), which tracks only the **vendored agent-step
runner library** version (`skills/create-tool/templates/agent-step/VERSION`, bumped by `/bump-version`).
A plugin release may or may not include a library bump.

Format follows [Keep a Changelog](https://keepachangelog.com/); newest first. Semver on the plugin:
**major** = removed/renamed skill or breaking workflow change, **minor** = new skill / capability /
template, **patch** = doc or fix with no new surface.

## [0.27.0] — 2026-09-24

New skill **`document-agent-flow`** — documents any agent-step agent as three files generated from
ONE validated flow spec: a Markdown design document, a self-contained interactive step graph and an
xlsx step sheet. Starts from a prose description, an existing codebase, or specs and a walkthrough.
No library change (agent-step stays 3.0.1).

### Added
- `skills/document-agent-flow/` — `SKILL.md`, three intake workflows (`intake-describe`,
  `intake-existing`, `intake-docs`) converging on `document-flow.md` (vocabulary → parallel research
  briefs → spec → build → verify → adversarial review → owner iteration), and five references:
  `data-model.md`, `engine-notation.md` (3.x primitive catalog, notation, pitfalls), `layout.md`,
  `design-guide.md`, `research-briefs.md`.
- `templates/flowdoc/` — the vendorable generator (stdlib + openpyxl): spec validator, automatic ladder
  layout (spine, branch lanes, gutter-routed back edges, self-loops, containers — no coordinates in the
  spec), md / html / xlsx renderers, and `verify.py` (determinism, xlsx read-back, headless render in
  light / dark / 400 px, edge, label and chip placement checks, validator and page break tests,
  optional `--deny` scan).
- The engine column is linted against the current library (removed primitives and `readOnly` are
  refused); every set states the agent-step version it targets, shown top-right on the page.
- `examples/pizza-order/` — a synthetic worked spec and its three outputs.

### Changed
- `bump-version`'s `references/tracked-assets.md` (Tier 6) now lists `skills/document-agent-flow/` — its
  engine-notation catalog, `RETIRED_ENGINE_TERMS` and `engine_version` examples mirror the library, so a
  library bump reconciles them.

Verified: `verify.py` passes (0 failed, 0 skipped) on the example, two more synthetic flows and five
existing agent-step projects spanning library 1.0.0–3.0.1.

## [0.26.1] — 2026-08-29

Ships **agent-step library 3.0.1** — a patch release: OTP/match gate-interplay fixes. The folded
consumer-issuer shape ("confirming the value sends the code" — one action declaring both
`requiresMatch` and `issuesOtp`) is now allowed, with consume-before-issue ordering so the fresh
OTP gate survives; and a pending OTP can be re-sent without aborting the flow (lockdown admits a
same-flow issuer of the gate). `/pull-library` replaces the vendored library wholesale — **no
transforms** ([migrations/3.0.0-to-3.0.1.md](migrations/3.0.0-to-3.0.1.md)). Library suite
222 → 225 tests; verified by throwaway bootstrap from these templates: clean typecheck,
225/225 passing.

### Changed
- **Library 3.0.1** — the match-then-OTP ordering guard exempts the match's own consumer;
  the ok-lifecycle applies gate consumption BEFORE `otp_issued`; OTP lockdown additionally admits
  a same-flow issuer of the pending gate (re-send). Details in [CHANGELOG.md](CHANGELOG.md).
- Reference docs reconciled to the new gate semantics: `agent-step-api.md` (lockdown table,
  admission bullet, apply order, `<otp_lifecycle>` re-send + consumer-exemption paragraphs,
  match-consumer fold mention, error table), `executor-patterns.md` Pattern 6 (folded
  consumer-issuer note), `test-agent-step` SKILL.md (same-turn-guards note).

## [0.26.0] — 2026-08-20

Ships **agent-step library 3.0.0** — a major library release; `/pull-library` is **required** for
downstream projects and applies 10 transforms, one of them mandatory per action (see
[migrations/2.5.0-to-3.0.0.md](migrations/2.5.0-to-3.0.0.md)). Authoring goes declarative — verdict
rows are the result space and the legacy executor return shape is gone — and the engine takes over
the model-facing language it enforces (action descriptions, gate reply contracts, the turn-protocol
prompt fragment). Three zero-host subsystems are removed. Library suite 236 → 222 tests (the removed
subsystems took their suites with them); verified by throwaway bootstrap from these templates: clean
typecheck, 222/222 passing.

### Added
- **Library 3.0.0** — **declared verdict rows** (`ActionDef.verdicts` / `VerdictDef` +
  `DeclaredExecutorResult`: the executor names a verdict and hands over dynamic data; the runner
  composes the body in declaration order, merges the row's static `stateUpdate`/`effects`, and
  derives the backend-failure code list from `backendFailure` rows), **standing asks** (`ActionDef.asks`
  + the non-locking `dictation` awaiting-kind, stamped on the wire as `standing_ask` / `ask_contract`
  / engine-rendered `ask_text`), **escalation ladders** (`ladders` + the sole-step `note_refusal`
  control over the task-scoped `spentLadders` latch, escalating atomically into a configured handoff),
  **`captureBounces`** (bounded consecutive `invalid_params` re-asks, `max: 2` measured),
  **`composeGateContract` / `GateContractSpec`**, **`composeProtocolPrompt`**,
  **`ConfirmationOpts.readBackDirective`**, the capture builders `callerTextParam` / `relayParam` /
  `exactlyOneOf`, and **`AGENT_STEP_SLOT_META`** (one slot table; mask, task-scoped and
  runner-owned lists derived and compile-key-locked).
- **Two new tool templates** — `action.ts.template` (the per-action declaration: schema, verdict
  rows, asks, captureBounces, controller) and `names.ts.template` (the types-only `ActionName` /
  `PrereqName` leaf that keeps the declaration ↔ config import graph acyclic).
- **Migration `2.5.0-to-3.0.0.md`** — prose + 10 ordered transforms (executors→rows with a per-action
  wire byte-diff check, the repeat-control rename, gate contracts for repeatable gates, the
  choices→ladders and deflect-aside→ladder folds, forced-handoff removal, guard-latch drop,
  description trimming, the protocol splice, slot cleanup) plus the golden re-measurement and
  checkpointed-thread follow-ups.

### Changed
- **The canonical tool layout** — per-action `action.ts` beside its executor, a `names.ts` leaf, and
  `config.ts` as a slim assembler. Rippled through all five executor templates (now returning
  `DeclaredExecutorResult`), `tool-index.ts.template` (ladders in, bounded choices out),
  `project/state.ts.template` (six library slots), and `project/prompt.ts.template`, which now
  splices the engine-composed `{PROTOCOL}` fragment instead of carrying hand-rolled machinery prose.
- **References rewritten for the 3.0.0 contract** — `agent-step-api.md` (new `<declared_verdicts>`,
  `<composed_surface>`, `<standing_asks>`, `<ladders>`, `<gate_contracts>` sections; refreshed
  construction-check and result-envelope tables), `executor-patterns.md` (all ten patterns on rows),
  `tool-directory-layout.md` (new layout + 10-step creation order). `state-and-prompt-integration.md`,
  `agent-design-principles.md`, `project-bootstrap-structure.md`, both create-tool workflows, and the
  `create-tool` / `test-agent-step` SKILLs reconciled.
- **Plugin + marketplace descriptions rewritten** as capability text: they had accreted into a
  per-release narrative (3,143 chars) that still advertised four features 3.0.0 removes.

### Fixed
- Stale test-file count in the bootstrap library copy list ("the ten `*.test.ts` files" → every
  suite, phrased version-agnostically).
- `ExecutorResult` references in the maintainer blast-radius map
  (`.claude/skills/bump-version/references/tracked-assets.md`, Tiers 2 and 4).
- Incomplete reserved-action-name list in the `create-tool` quick reference — the three
  conditionally reserved control names were missing, and declaring one throws at construction.

### Breaking (for downstream projects, not for the plugin)
- The legacy `ExecutorResult` executor return is removed from the public contract; the bounded-choice
  subsystem, the `deflect_aside` control, the `guardTurn` guard latch and `HandoffSpec.forcedHandoff`
  are gone (zero-host or superseded by ladders / row-declared terminality);
  `repeat_pending_confirmation` → `repeat_pending_question`; `repeatReadBack` now requires
  `replyContract`. Library state is six slots. Hosts re-measure their model-surface goldens — the
  engine-composed bytes moved.

## [0.25.0] — 2026-08-12

Ships **agent-step library 2.5.0** (from 2.4.0): the confirmation gate hardens and configuration
keeps absorbing prompt prose. Six capabilities, all opt-in; without adoption the model-facing
surface is byte-identical to 2.4.0, and no state-schema change is needed (no new slot). Downstream
projects catch up with `/pull-library`.

### Added
- **Library 2.5.0** — `repeat_pending_confirmation` + `ConfirmationOpts.repeatReadBack` (the pending
  gate persists its exact read-back rendering; a "pardon?" turn returns the stored bytes without
  consent, re-render, or attempt spend, and the repeat advances the gate's presentation-turn
  provenance), `ConfirmationOpts.refuseProposal` (propose-time state-aware refusal with
  `invalid_params`-grade non-burning semantics), `BuildAgentStepToolOptions.abortPolicy` (abort as an
  engine-enforced in-domain transition: leads the batch, real target, declared followers),
  `HandoffSpec.modelRequestSchema` (typed terminal reason/context routes as configuration the engine
  renders AND parses), `BoundedChoiceDef.renderRequest` / `renderResolution` (engine-rendered choice
  offer/resume riding results as `read_back`), `choice_consumed` transcript visibility plus the
  leading-resolve batch admission. Library suite 207 → 236.
- **New reference `agent-design-principles.md`** — how a well-formed host agent divides
  responsibility around the engine: twelve measured principles (mechanism-in-engine, language-only
  prompt, transcript-only state, discovery-by-calling, engine-rendered consequence text, one prompt
  authority per behaviour, configuration-owned payloads, safe-shape admission, engine-bounded
  consequences, substance-not-phrasing fixtures, layered live measurement) and the five-question
  port-mode audit. Indexed in the create-tool SKILL and wired into the workflow's prompt step.
- **Migration `2.4.0-to-2.5.0.md`** — additive; verify-only transform (including the golden
  re-verification note for projects that carried pre-release drafts of these capabilities) plus
  per-capability adoption follow-ups.

### Changed
- `config.ts.template` / `tool-index.ts.template` comment blocks and the create-tool workflow teach
  the new opts (`repeatReadBack`, `refuseProposal`, `abortPolicy`, `modelRequestSchema`, the choice
  renderers); the workflow's verification step now expects 236 library tests.

## [0.24.0] — 2026-08-11

Ships **agent-step library 2.4.0** (from 2.3.0): `deflect_aside`, the trigger-happy-handoff damper.
Downstream projects catch up with `/pull-library`; the change is additive and opt-in — without
`HandoffSpec.deflectAside` the model-facing surface is byte-identical to 2.3.0, so the upgrade is
safe to take before adopting it.

### Added
- **Library `deflect_aside` control** — one free in-place deflection per task of an aside NO
  configured agent serves: the task-scoped `deflectedAside` latch is set, every pending gate/flow
  survives untouched, and the model is instructed to decline in ONE short sentence and repeat its
  pending question in the SAME turn; a repeat in the same task escalates ATOMICALLY into the
  `off_topic` handback with the aside as routing context. Opt-in via `HandoffSpec.deflectAside`
  (`true`, or `{ actionDescription }` to state the fleet's own classification policy in the model's
  terms); construction requires the `deflectedAside` channel only when the control is enabled. New
  exports `DEFLECT_ASIDE_ACTION` / `DEFLECT_ASIDE_ACTION_DESCRIPTION`; new overridable
  `SystemMessages.aside_deflected`. Library suite 193 → 207.
- **Migration `2.3.0-to-2.4.0.md`** — additive; one verify-transform (the slot arrives with the
  spread state fragments; the internal-slot mask now carries eight keys) plus opt-in adoption
  follow-ups. `/pull-library` applies it.

### Changed
- Toolkit docs/templates propagate the 2.4.0 contract: the `HandoffSpec` listing + a control-semantics
  section in `agent-step-api.md`, slot enumerations across references and project templates, the
  reserved-names list, and the library file inventories.

### Fixed
- `create-tool.md` verification step: stale library test count (193 → 207) and the suite enumeration
  now includes `deflect-aside`.

## [0.23.0] — 2026-08-09

Ships **agent-step library 2.3.0** (from 2.2.0): the mechanisms hosts were hand-rolling move into the
engine. Downstream projects catch up with `/pull-library`; every addition is optional and every default
preserves existing behaviour, so the upgrade is safe to take before adopting any of it — the migration's
transforms are about DELETING host workarounds, not adding wiring.

### Added
- **Library handoff hooks** — `forcedHandoff` + the `forcedHandoffRequested` edge predicate (a
  state-derived handoff, resolved inside `createHandoffNode` so no host code writes the library slot and
  no arming node is needed), `resolveHandoffType` (the handback signal decided from state, resolved
  before the first control-plane event), `resolveHandoffMetadata` (host fields merged into
  `handoff_metadata`, the library's own keys applied last).
- **Library guard latch** — the `guardTurn` slot plus `guardFiredOnTurn` / `markGuardFired`, and
  `resolveCallerTurnId` now exported: fire a host model-input guard once per caller turn without
  re-deriving the turn identity or parking it in the channel envelope.
- **Library `ConfirmationOpts.readBack`** → `read_back` on the proposal body, so the model speaks back
  what the runner actually recorded instead of paraphrasing captured digits.
- `agent-step-api.md`: a `guardTurn` section (including why its patches do not compose by spreading),
  the three handoff hooks with the pre-event ordering rationale and the forced-handoff re-fire trap,
  `readBack` through both propose paths and the result envelope, and `resolveCallerTurnId` in
  `<caller_turn_identity>`.
- `streaming-and-channel-contract.md`: `handoff_metadata` may carry host-derived fields — supplied
  through the hook, never by patching the envelope after the node built it (which also left the
  control-plane event carrying pre-override values).
- `migrations/2.2.0-to-2.3.0.md`: six transforms, four of which retire a host workaround.

### Changed
- Vendored library `VERSION` 2.2.0 → **2.3.0**; library suite 173 → **193**; two library files added
  (`interaction/guard-latch.ts`, `guard-latch.test.ts`).
- Library-slot enumerations across the templates, references, and SKILL prose now carry `guardTurn`,
  each noting it is HOST-written — it is the one library slot excluded from the executor `stateUpdate`
  guard, and `executor-patterns.md` now says why.
- `tracked-assets.md` (repo-level maintainer skill) tracks `tool-sandbox-test.ts.template`, which calls
  `runSteps` directly and so mirrors that public entry point.
- Plugin + marketplace descriptions name the 2.3.0 capabilities.

### Fixed
- `workflows/create-tool.md`'s library-test expectation was stale (173) — now the verified 193.
- `agent-step-api.md` claimed `agentStepZodShape` brings "all six slots" in; it is seven.
- `project-bootstrap-structure.md`'s `state.ts` slot list omitted `boundedChoice` — stale since the
  bounded-choice release, corrected here.

## [0.22.0] — 2026-08-07

Ships **agent-step library 2.2.0** (from 2.1.0): a task-ending handback now clears task-scoped
state. Downstream projects catch up with `/pull-library`; the library half needs no project change,
and the migration's single transform is an optional (recommended) declaration of the host's own
terminal domain slots.

### Added
- **Library `agentStepTaskScopedSlots`** (`state.ts`, re-exported from `index.ts`): the library
  slots that describe work in progress — `awaitingInput`, `currentFlow`, `boundedChoice`,
  `pagedRead`, `errorCount`. `handoff` is deliberately absent; the handoff node returns it as null
  either way.
- **Library `HandoffSpec.clearsOnHandback`** (optional): host DOMAIN slots to null when a
  task-ending handback resolves. The library's own task-scoped slots clear automatically.
- `agent-step-api.md`: `clearsOnHandback` in the `HandoffSpec` block, the task-scoped-clearing rules
  with both carve-outs, and `agentStepTaskScopedSlots` alongside `agentStepInternalSlotMask`.
- `streaming-and-channel-contract.md`: the middleware-side fact the behavior rests on — one thread id
  is reused for a whole call and never reset, so the thread outlives the task. Middlewares need no
  change; the note exists because that is where the reasoning belongs.
- `migrations/2.1.0-to-2.2.0.md`: prose plus one optional transform (declare terminal domain slots),
  with guidance on what NOT to list — cross-task identity/session slots, and slots whose reducer
  merges rather than replaces.

### Changed
- Vendored library `VERSION` 2.1.0 → **2.2.0**; library suite 168 → **173**.
- Plugin + marketplace descriptions name the clean-task-ending behavior and the 2.2.0 library.

### Fixed
- `workflows/create-tool.md`'s library-test expectation was stale (168) — now the verified 173.
- `test-agent-step/SKILL.md`'s library test-file list omitted `capture`; stale since the 2.1.0
  release, corrected here.

## [0.21.0] — 2026-08-06

Ships **agent-step library 2.1.0** (from 2.0.0): the caller-digit capture primitives. Additive —
downstream projects catch up with `/pull-library`, and no project-side change is required (existing
hand-rolled digit params keep working; adoption is an optional migration transform).

### Added
- **Library `capture.ts`** (+ `capture.test.ts`, exported from `index.ts`): `digitsOnly`,
  `digitsOnlyDeep`, `callerDigits`, `digitGroupsParam`, `digitCandidatesParam` and their opts types
  — schema helpers for params that carry caller-dictated digits (a tax number, a card-number tail).
  The module is **authoring-only**: nothing in the runner calls it (unlike `paginate.ts`, whose
  primitives the runner uses). It lives in the library because each rule it encodes is a consequence
  of a runner contract — shape rules as refinements so no `pattern` reaches the model-facing JSON
  Schema, refinement messages that carry no digit count because issue text rides `_debug` back to
  the model, separator strip + singleton-array collapse in the preprocess so the confirmation gate's
  parsed-params compare never reads a representation flip as drift, and the honest wire union for
  group-array fields. Omission is the one spelling of "absent" on both builders.
- The model-facing `describe` is a **required** option with no default: field text is live prompt
  surface, tuned and QA-gated per host, so the library ships no wording of its own.
- `agent-step-api.md` `<caller_digit_capture>`: the capture doctrine plus description-authoring
  guidance (transcription framing, semantic neutrality, concrete renderings, omission semantics).
- `migrations/2.0.0-to-2.1.0.md`: additive migration whose single transform is OPTIONAL adoption,
  gated on a byte-identical model-facing-schema check so no host's prompt surface shifts.

### Changed
- Vendored library `VERSION` 2.0.0 → **2.1.0**; library suite 144 → **168**.
- Library inventories gained `capture.ts` + `capture.test.ts`: `create-tool` SKILL `templates_index`,
  `references/project-bootstrap-structure.md`, and the `bootstrap-project.md` copy list.
- Plugin + marketplace descriptions name the capture primitives and the 2.1.0 library.

### Fixed
- `workflows/create-tool.md`'s library-test expectation was stale (144, and omitted capture from the
  suite list) — now the verified 168.
- `agent-step-api.md`'s count-free rule now scopes the ban to the VALUE's digit count, matching
  `capture.ts` header rule 2: a count of alternative readings (`maxCandidates`) says nothing about
  the digits and is fine. The two statements of the same rule had drifted apart in precision.

## [0.20.0] — 2026-08-05

Library unchanged (**2.0.0**). The toolkit's workflows now integrate with the new
`kafka-observability` plugin so every generated agent gets the Kafka observability
layer — and existing agents get pointed at it at the natural moments.

### Added
- `create-tool` bootstrap **Step 8b — Observability**: after verification, offer to run
  `/add-kafka-observability` (from the `kafka-observability` plugin, same marketplace) to
  vendor the LangSmith-parity Kafka run-tracing library into the new project; when that
  plugin isn't installed, the Step 9 report points at
  `/plugin install kafka-observability@ckifonidis-marketplace`. The observability library
  is deliberately NOT bundled into this toolkit — one canonical, versioned source, owned
  by its own plugin. Step 9's report gains an observability-status line.
- `create-tool` port workflow (Step 2): a port that reuses an existing project (skipping
  bootstrap and its Step 8b) now checks for `src/observability/` and offers
  `/add-kafka-observability`; a source project's `src/observability/` is explicitly never
  copied over (the sandbox reuse exception does not extend to vendored libraries) — the
  target gets the library from its canonical plugin instead.
- `pull-library` Phase 5: a report-only courtesy check — if `src/observability/VERSION`
  is older than what the installed `kafka-observability` plugin ships, the report says so
  and points at `/add-kafka-observability`. This skill still upgrades `src/agent-step/`
  ONLY; each vendored library keeps exactly one upgrade skill. (No change to the add-tool
  workflow: the observability tracer hooks the callback system globally, so new
  tools/actions are traced automatically with zero wiring.)

## [0.19.0] — 2026-08-05

Ships **agent-step library 2.0.0** — a major library release; `/pull-library` is **required** for
downstream projects and applies 7 transforms (see
[migrations/1.8.1-to-2.0.0.md](migrations/1.8.1-to-2.0.0.md)). The runner is restructured into
phase modules, the executor contract moves to typed effects, and the library gains the
bounded-choice overlay plus turn-provenance hardening. Model-facing tool surface and runtime
semantics for existing flows are unchanged (golden-verified upstream); suite grows 105 → 144.

### Added
- Library **2.0.0**: the **bounded-choice overlay** (`boundedChoices` option injecting the
  `request_bounded_choice` / `resolve_bounded_choice` controls, the `boundedChoice` state slot,
  one-shot + lockdown + offered/resolved same-turn locks, `onRepeatHandoff` fallback) and the
  **`getCallerTurnId`** option (stable caller-turn identity behind the turn-keyed guards). New
  `ExecutorEffect` export. Full details: [CHANGELOG.md](CHANGELOG.md).
- `agent-step-api.md`: new `<bounded_choice>` and `<caller_turn_identity>` sections; the v2
  admission → planning → execution pipeline documented step by step; error tables extended with
  the same-turn and bounded-choice refusal codes, verified against the source throw strings.
- Test-harness template: `runConfirmed` / `answeredTurn` / `callerTurn` helpers — confirm-gated
  propose → execute tests must now cross two caller turns (the 2.0.0 same-turn lock);
  `test-agent-step` documents the pattern.

### Changed
- Library **2.0.0 breaking** (tool-authoring contract; the migration's transforms cover all of
  these): `ExecutorResult.lifecycle`/`flowData` → typed `effects[]`; `stateUpdate` is domain-only
  (library-slot writes throw; terminal handoffs via the `request_handoff` effect);
  `stateAnnotation` option removed (use `stateSchema`); `ConfirmationOpts.ttlMs` and `OtpOpts`
  deleted; cross-action config pairs + state-schema channel completeness validated at
  construction; confirmation same-turn lock (`confirmation_same_turn_locked`).
- The library is now a **tree** (`compile/`, `run/`, `interaction/`, `controls/`, `handoff/` —
  flat `handoff.ts` split into `handoff/{contract,node,delegate-client}.ts`); the bootstrap and
  pull-library workflows copy it recursively. Hosts import only from `index.js`.
- References/templates reconciled to the effects vocabulary end to end: `executor-patterns.md`
  recipes, `config.ts.template` / `plan.md.template` comments, `project-bootstrap-structure.md`
  library inventory, `state-and-prompt-integration.md` + SKILL slot lists (now six slots incl.
  `boundedChoice`), project `package.json` test scripts gain `rm -rf dist` (stale-dist guard).

### Fixed
- `pull-library` workflow: the vendored-library replacement enumerated the pre-2.0 flat file list —
  on 2.0.0 it would have produced a broken copy (missing the five module directories). Now a
  recursive wipe-and-copy with a sanity check.
- Stale claims: `create-tool` workflow test count 105 → 144; the create-tool acceptance check now
  runs the whole `dist/agent-step/*.test.js` suite instead of `runner.test.js` only.

## [0.18.1] — 2026-07-23

Ships **agent-step library 1.8.1** (`/pull-library` recommended for downstream projects — note the
behavior delta below). One runner fix: the auto-handoff error counter treats no-executor batches
as neutral, so the escalation backstop actually works for confirm-gated actions.

### Fixed
- Library **1.8.1**: the consecutive backend-failure streak survives confirm-gate
  proposals/re-proposals — the `errorCount` reset now requires that an executor **actually ran**
  in the batch. Previously the proposal a confirm gate interleaves between two failing executes
  reset the counter (fail → 1, re-propose → 0, fail → 1, …), making the auto-handoff threshold
  unreachable for every confirm-gated action. No-executor batches (proposals, prereq/param
  refusals, aborts, handoff signals) neither increment nor reset. **Downstream impact:** hosts
  using confirm gates + `backendFailureCodes` now actually escalate at the threshold; nothing
  should rely on a non-executed turn wiping the streak. Docs: `agent-step-api.md` (`errorCount`
  slot + `<auto_handoff>`), `create-tool` workflow test count 103 → 105. See
  [CHANGELOG.md](CHANGELOG.md) and [migrations/1.8.0-to-1.8.1.md](migrations/1.8.0-to-1.8.1.md).

## [0.18.0] — 2026-07-23

Ships **agent-step library 1.8.0** (`/pull-library` recommended for downstream projects — note the
behavior deltas below). Absorbed from a downstream agent: the confirmation gate now compares
schema-NORMALIZED params, every runner-emitted summary is host-overridable
(localization-ready templated messages), invalidation uses deep value equality, and the
auto-handoff instruction defaults to platform-delivers wording.

### Added
- Library **1.8.0**: 17 templated `SystemMessages` keys + a `formatMessage` helper — every
  runner-emitted summary (lockdown, batch-shape, confirmation, OTP/match gate refusals, and more)
  is now overridable, with `{placeholder}` interpolation; templates are plain strings so overrides
  can live in JSON locale resources. New `HandoffSpec.actionDescription` for schema-honest
  `request_handoff` descriptions. Docs: `agent-step-api.md` (`<system_messages>`,
  `<confirmation_lifecycle>`, `<invalidates_on_change>`, `<auto_handoff>`, `<handoff>`). See
  [CHANGELOG.md](CHANGELOG.md) and [migrations/1.7.2-to-1.8.0.md](migrations/1.7.2-to-1.8.0.md).

### Changed
- Library behavior: the confirm gate parses raw re-calls with the action's effective schema before
  comparing against the stored (parsed) proposal — a value-normalizing schema (e.g. STT separator
  stripping) no longer re-proposes forever; propose-path `invalid_params` is voice-safe (raw Zod
  detail in `_debug`); `invalidatesOnChange` uses deep value equality (fresh-but-value-equal
  object writes no longer fire spurious cascades); the auto-handoff instruction defaults to
  platform-delivers wording (override `auto_handoff_instruction` with the `{message}` placeholder
  to restore speak-this). **Downstream impact:** `/pull-library` replaces the vendored library and
  applies the 1.7.2→1.8.0 transforms; re-verify confirm-gated flows and decide who delivers the
  auto-handoff closing.

### Fixed
- `agent-step-api.md`: stale `resolveClosingMessage` comment claimed off_topic always speaks
  `terminateMessage` (silent hand-back since 1.6.0); `create-tool` workflow library test count
  94 → 103.

## [0.17.1] — 2026-07-02

Ships **agent-step library 1.7.2** (`/pull-library` recommended for downstream projects — the
library replacement is the whole upgrade; no project-side transforms). Rolls up library 1.7.1 and
1.7.2: the LangGraph Studio chat-box `AgentInputSchema` fix and two runtime fixes aligning the
runner with its documented contract. No new surface.

### Fixed
- Library **1.7.1** (contributed by Konstantinos Sekaras, PR #3): the recommended
  `AgentInputSchema` derivation re-attaches `messages` after `.partial()` —
  `.extend({ messages: MessagesZodState.shape.messages })` — so LangGraph Studio renders its chat
  input box instead of the raw-state editor (the 1.7.0 recipe stripped the messages-channel
  metadata). Project-state template + references; vendored runner byte-identical to 1.7.0. See
  [migrations/1.7.0-to-1.7.1.md](migrations/1.7.0-to-1.7.1.md).
- Library **1.7.2**: the delegate stream timer (`HandoffDelegateTarget.timeoutMs`) now starts
  after the connect phase instead of at delegate entry, so a slow thread-creation call no longer
  eats the streaming budget; `buildAgentStepTool` without a state schema now throws at
  construction (was: on the first tool call), matching the 1.7.0 docs. Suite grows 91 → 94. See
  [CHANGELOG.md](CHANGELOG.md) and [migrations/1.7.1-to-1.7.2.md](migrations/1.7.1-to-1.7.2.md).
- Docs staleness: `agent-step-api.md`'s `AgentInputSchema` recipe (missed by the 1.7.1 sweep) now
  shows the `messages` re-attach; the `errorCount` doc-comment matches the runner (host-listed
  `backendFailureCodes` verdicts also increment; reset on any non-backend-failure batch); the
  1.6.0→1.7.0 migration gains a peer-dependency note (`schemaMetaRegistry` requires
  `@langchain/langgraph` ~1.3); `create-tool` workflow test count 91 → 94; `plugin.json` /
  `marketplace.json` descriptions now reference the shipped library version (were pinned at
  1.6.0 / 1.7.0).

## [0.17.0] — 2026-06-30

Ships **agent-step library 1.7.0** (`/pull-library` recommended for downstream projects). Makes a
**Zod state schema a first-class alternative to a LangGraph `Annotation.Root`** — a project defines
graph state once (single source of truth for reducers AND validation) and derives an invoke-boundary
input schema. No breaking change (`stateAnnotation` still works). The toolkit's templates, references,
and workflows now teach **only** the single Zod-schema pattern.

### Added
- Library **1.7.0**: new `stateSchema` option on `buildAgentStepTool` (accepts a LangGraph
  `Annotation.Root` OR a Zod object whose fields carry reducer/default metadata via `withLangGraph`);
  new exports `StateSchemaLike` and `agentStepInternalSlotMask` (omit-mask for deriving a graph input
  schema); `agentStepZodShape` slots now carry channel reducers/defaults via `withLangGraph`; new
  `zod-state.test.ts`. See [CHANGELOG.md](CHANGELOG.md) and
  [migrations/1.6.0-to-1.7.0.md](migrations/1.6.0-to-1.7.0.md).

### Changed
- Bootstrap + tool templates adopt the single Zod state schema: `state.ts.template` defines one
  `AgentStateSchema` (`withLangGraph` reducers), exports `State = ExtractStateType<…>` and a derived
  `AgentInputSchema`; tool/test wiring uses `stateSchema:` (was `stateAnnotation:`); `prompt.ts` /
  verifier templates import the exported `State`.
- References (`agent-step-api.md`, `state-and-prompt-integration.md`, `project-bootstrap-structure.md`,
  `tool-directory-layout.md`, `executor-patterns.md`, `data-analysis-pattern.md`), the create-tool +
  bootstrap workflows, and SKILL prose updated to the Zod pattern. `stateAnnotation` is documented as
  a deprecated (still-accepted) alias.
- **Downstream impact:** `/pull-library` replaces the vendored library and applies the
  1.6.0→1.7.0 transforms (consolidate `state.ts` to one Zod schema, switch wiring to `stateSchema`).
  Invoke-boundary validation runtime effect requires a hand-built `StateGraph` (createReactAgent takes
  no separate input schema).

### Fixed
- `create-tool` workflow: corrected the stale library unit-test count (89 → 91; added `zod-state`).
- `bump-version` `tracked-assets.md`: added `zod-state.test.ts` to the Tier-1 library inventory.

## [0.16.0] — 2026-06-26

Ships **agent-step library 1.6.0** (`/pull-library` recommended for downstream projects — note the
behavior change below). Adds an auto-handoff safety net, a silent off_topic hand-back, and split
delegate timeouts.

### Added
- Library **1.6.0**: auto-handoff on repeated backend failures — new library-managed `errorCount`
  slot plus opt-in `backendFailureCodes` / `errorHandoffThreshold` / `onErrorThreshold` on
  `buildAgentStepTool` (host-configurable; the library bakes in no domain codes);
  `SystemMessages.auto_handoff`; `HandoffDelegateTarget.connectTimeoutMs`. Docs:
  `create-tool/references/agent-step-api.md` (new `<auto_handoff>` section, the `errorCount`
  library-managed slot), `streaming-and-channel-contract.md`, and SKILL prose. See
  [CHANGELOG.md](CHANGELOG.md) and [migrations/1.5.0-to-1.6.0.md](migrations/1.5.0-to-1.6.0.md).

### Changed
- Library behavior: the off_topic hand-back is now **silent** (empty spoken content;
  `terminateMessage` becomes the delegate-failure fallback); delegate timeouts split into a connect
  phase (10s) and a streaming phase (20s). **Downstream impact:** `/pull-library` replaces the
  vendored library; projects opt into auto-handoff via config and should re-verify off_topic UX.

### Fixed
- `create-tool` workflow: corrected the stale library unit-test count (83 → 89).

## [0.15.0] — 2026-06-26

Ships **agent-step library 1.5.0** (was 1.4.0). `/pull-library` recommended for downstream projects —
note the behavior change below. Absorbed from a downstream project.

### Added
- Library **1.5.0**: new `messages.ts` — the runner's own refusal/error `summary` strings are now
  host-overridable via `buildAgentStepTool({ messages })` (neutral English defaults, shallow-merged);
  `HandoffSpec.resolveClosingMessage` for honest `completed`/`abandon` closings; a `_debug` field on
  error step results. Docs updated across `create-tool/references/agent-step-api.md` (new
  `<system_messages>` section), the bootstrap copy list, `create-tool` step 6c, and SKILL prose. See
  [CHANGELOG.md](CHANGELOG.md) and [migrations/1.4.0-to-1.5.0.md](migrations/1.4.0-to-1.5.0.md).

### Changed
- Library behavior: double-entry `requiresMatch` is frozen to batch start, and a new `issuesOtp` guard
  refuses with `otp_blocked_match_pending` — a single batch can no longer bypass the second PIN entry.
  **Downstream impact:** tools that batched a capturer with its consumer or with an OTP issuer in one
  turn must split them across turns (`/pull-library` surfaces this in its manual follow-ups).

### Fixed
- `create-tool` workflow: corrected the stale library unit-test count (79 → 83).

## [0.14.0] — 2026-06-14

New skill — `audit-middleware-contract-compliance`. Library unchanged at **1.4.0** (no
`/pull-library` needed). Closes the loop on the channel-contract series: the toolkit
already scaffolds the agent side of the wire and tests it; this audits the *other* side —
the hand-written channel middleware the toolkit doesn't generate.

### Added
- **`audit-middleware-contract-compliance` skill** — audits a channel middleware
  implementation (the proxy that invokes a generated agent's LangGraph API, forwards reply
  tokens, and routes handoffs) against the wire contract in
  `create-tool/references/streaming-and-channel-contract.md`. Mechanizes that doc's
  `<middleware_requirements>` adherence checklist (invoke shape; sync + streaming handoff
  detection; the routing/handback table; stream modes; token dedupe; trigger point;
  library-handoff custom events) into a five-phase audit — scope/discovery, checklist walk,
  a dedicated adversarial pass on the three assumption-breakers, an evidence-backed findings
  report (status + file:line + contract clause + impact + fix direction per item, **never a
  patch**), and an optional wire-level verification pass against a captured SSE golden
  fixture. The contract doc is declared normative; agent-side findings route to
  `/create-tool` and `/test-agent-step`.

### Changed
- `bump-version`'s `references/tracked-assets.md` (Tier 6) now lists the new skill's
  `SKILL.md` as a contract-mirroring asset — its checklist summaries get reconciled when the
  channel/streaming surface (handoff custom events, `HANDBACK_SIGNALS`, the `resolve_handoff`
  node, stream modes) shifts in a future library bump.
- Plugin and marketplace descriptions, the root `README.md` skill listing and layout tree:
  updated to reflect the fourth skill.

## [0.13.0] — 2026-06-12

The full-handback release, shipping agent-step library **1.4.0** (additive; `/pull-library`
is a plain replacement — prompt follow-ups for already-opted-in agents are listed in the
migration). Closes the open items from the channel-contract series.

### Added
- **agent-step library 1.4.0**: the built-in `request_handoff` accepts the full handback
  signal set — `reason: off_topic | completed | abandon`, with `completed` / `abandon`
  speaking the **LLM-composed closing** carried in `context` (delivered verbatim by the
  resolver node; may reference what was done — matching the middleware's passive handback
  semantics). Suite grows 76 → 79. See `CHANGELOG.md` 1.4.0 +
  `migrations/1.3.1-to-1.4.0.md`.
- **`channel` wire-contract slot** in the bootstrap `state.ts` scaffold (preserve-initial,
  like the identity slots) — the middleware sends it; read it for channel-gated behavior and
  forward it in handoff/delegate payloads.

### Changed
- `agent-step-api.md` / `streaming-and-channel-contract.md` document the per-reason `context`
  semantics and the three-signal resolver behavior.
- Reference docs no longer point at a specific existing project for prompt-shape examples
  (generic "the project's existing tool(s)" phrasing).

## [0.12.0] — 2026-06-12

The intake release (library unchanged at **1.3.1**). Agent creation and tool creation now ask
every question the functionality demands, instead of inferring or assuming:

### Added
- **Bootstrap intake questions** (`bootstrap-project.md` step 1 + SKILL `<intake>`): **agent
  language** (never assumed — parameterizes the prompt's VOICE RULES via the new
  `{{AGENT_LANGUAGE}}` placeholder and every success/envelope message), **behind the channel
  middleware?** (sets the wire-contract/adherence-checklist expectations), and **role
  follow-ups** — specialized: off-topic resolution (terminate / delegate) + envelope message +
  delegate target (URL / assistant id / `replyNode` / `delegateInput` contents); orchestrator:
  whether the agreed service catalog exists (else recorded as an open dependency).
- **Conditional tool-time asks** at their trigger points (`create-tool.md`): identity model
  (pre-authenticated vs collected-and-verified) when specs are ambiguous; whether users will
  ask open-ended aggregate questions (the analysis action is a product decision); handoff
  mechanism + off-topic mode if not captured at bootstrap (step 6c now checks `.env.example`'s
  recorded answers first); backend-pages vs self-paginate for ambiguous list reads.
- **`.env.example` handoff block** (role-tagged, commented): `HANDOFF_ENABLED` /
  `HANDOFF_TOOLS` for orchestrators, `HANDOFF_OFF_TOPIC_MODE` / `HANDOFF_TERMINATE_MESSAGE` /
  `HANDOFF_DELEGATE_*` for specialized agents — bootstrap records the answers, step 6c wires
  them.

### Changed
- `prompt.ts.template` VOICE RULES are language-parameterized (`{{AGENT_LANGUAGE}}` + worked
  number/date examples filled in the agent's language at bootstrap) — no baked-in language.

## [0.11.1] — 2026-06-12

The middleware-source alignment release, shipping agent-step library **1.3.1** (internal fix;
`/pull-library` is a plain library replacement). The channel contract was cross-checked against
the middleware's handoff-processor, kwargs-model, and stream-processor source, and the docs now
carry ground truth instead of expectations.

### Changed
- **`streaming-and-channel-contract.md`**: the verified routing table (current agent ×
  `handoff_type` → response source + routing) lifted from the middleware source; a handoff
  requires BOTH `is_handoff: true` AND a non-empty `handoff_type`; type matching is
  case-insensitive with canonical lowercase spellings; sync-vs-streaming kwargs consumption
  nuances (`success_message` is a streaming/client-side concern; sync speech is the message
  `content`); two optional fields (`handoff_metadata.requires_authentication`, `routing_url`);
  the middleware-side auth gate on handoff targets.
- **Signal vocabulary lowercased everywhere current** (`completed` / `abandon` / `off_topic`)
  to match the middleware's canonical strings — SKILL principle #12, the role-model tables,
  prompt template, workflows, test guidance, and the scaffold handback `z.enum`.
- **agent-step library 1.3.1**: `HANDBACK_SIGNALS` emits the canonical lowercase signal
  (`"off_topic"`); behaviorally identical (case-insensitive matching), no API change. See
  `CHANGELOG.md` 1.3.1 + `migrations/1.3.0-to-1.3.1.md`.

## [0.11.0] — 2026-06-12

The library-handoff release, shipping agent-step library **1.3.0** (downstream projects adopt via
`/pull-library` — additive; one transform for hand-rolled state literals). The specialized agent's
off-topic plays become library infrastructure: opt into `buildAgentStepTool({ handoff })` and the
runner auto-injects the reserved `request_handoff` action (sole-step, no prereqs,
lockdown-bypassing) writing the new library-managed `handoff` slot; the host graph resolves it
with `createHandoffNode(spec)` — **terminate** mode emits the OFF_TOPIC handback kwargs with the
envelope as `success_message`, **delegate** mode routes the turn to another LangGraph deployment
with live token pass-through and KEEPS the conversation (its final message is not a handoff).
`request_handoff` is reserved only while the opt is provided — an orchestrator's scaffold tool
action may keep that name (verified against the reference orchestrator implementation).

### Added
- **agent-step library 1.3.0** (`templates/agent-step/`): `handoff.ts` + `handoff.test.ts`
  (`HandoffSpec`, `createHandoffNode`, `handoffRequested`, `HANDOFF_ACTION` / `HANDOFF_NODE` /
  `HANDBACK_SIGNALS`, the Platform-API delegate client with `replyNode` token filtering), the
  optional `BuildAgentStepToolOptions.handoff`, the library-managed `handoff` slot, control-plane
  custom events (`handoff`, `delegated_token`, `handoff_complete`, `delegated_restart`). Suite
  grows 65 → 76. See `CHANGELOG.md` 1.3.0 + `migrations/1.2.0-to-1.3.0.md`.
- **`agent-step-api.md` `<handoff>` section** — the opt-in spec, reserved-name rules, exclusivity
  (`handoff_must_be_sole_step`), graph wiring, kwargs contract, custom events.
- `streaming-and-channel-contract.md` — **two mechanisms, one kwargs contract** (scaffold tool
  action vs library built-in), the delegate play in the specialized agent's off-topic policy, and
  middleware checklist item 8 (`"custom"` stream mode; never route on `delegated_to`-only
  messages).

### Changed
- create-tool workflow step 6c picks the handoff mechanism by role: orchestrator → scaffold
  catalog action; specialized → the library built-in (scaffold handback action remains the
  `createReactAgent` fallback).
- SKILL principle #12, reserved-names convention, slot lists, bootstrap copy list (+2 library
  files), and the library test-count claim (65 → 76) updated.

### Fixed
- `project-bootstrap-structure.md`: the library file list was missing the 1.1.0 paginate files,
  and the channel wire-contract slots were described under the library `state.ts` instead of the
  project scaffold's.

## [0.10.0] — 2026-06-12

The agent-roles release (library unchanged at **1.2.0**; `/pull-library` not needed). Agents are
now role-typed at bootstrap — **orchestrator** (starts conversations; in-domain topics are handled
or routed to specialized agents, never refused; out-of-domain gets a fixed steer-back line),
**specialized** (owns one domain; hands back ONLY to the orchestrator with `COMPLETED` / `ABANDON`
/ `OFF_TOPIC` signals), or **standalone** (the previous refuse-politely default) — and the
off-topic policy is part of the contract. Verified against the reference orchestrator
implementation.

### Added
- **`<agent_roles>` section in `streaming-and-channel-contract.md`** — the role model, the three
  handback signals (riding the existing `handoff_type` kwargs: no new wire mechanics, same slot,
  same hook), the specialized agent's two-play off-topic policy (absorb brief asides from general
  knowledge, or signal `OFF_TOPIC`), and middleware checklist item 3b (handback routing:
  `OFF_TOPIC` re-sends the turn to the orchestrator; `COMPLETED` / `ABANDON` deliver the closing
  reply and return ownership).
- **OFF-TOPIC POLICY prompt section** in `project/prompt.ts.template` (specialized agents), plus
  role-conditional placeholders for the SCOPE closer, the CHANNEL CONSTRAINTS transfer line, and
  the OPERATING LOOP wrap (`COMPLETED` replaces the open-ended close for specialized agents).
- **Agent role bootstrap input** (orchestrator / specialized / standalone) in
  `bootstrap-project.md` step 1; the prompt scaffold step resolves the role conditionals.
- **Role-aware handoff recipe** in create-tool step 6c: orchestrator catalogs route outbound to
  the specialized agents (+ client-side types); specialized agents get a single handback action
  with `{ signal, reason }` params and per-signal success messages.

### Changed
- SKILL essential principle #12 carries the role model; "orchestrator" now exclusively means the
  agent role (the fronting proxy is "the channel middleware" throughout).
- The handoff-when rule distinguishes outbound transfers (explicit request only) from handbacks
  (role policy).
- Prompt-input test guidance (`test-agent-step` SKILL + the test template) matches off-topic
  expectations to the agent's role.
- `project-bootstrap-structure.md` documents the role-conditional prompt sections.

### Fixed
- The bootstrap prompt's CHANNEL CONSTRAINTS no longer contradicts a handoff surface: "no
  live-agent transfer mechanism exists" is explicitly the no-handoff default, replaced by
  "transfers happen ONLY through the handoff tool" once a handoff action exists.

## [0.9.0] — 2026-06-11

The channel-contract release (library unchanged at **1.2.0**; `/pull-library` not needed). Every
bootstrapped project now ships the channel middleware wire contract — snake_case identity slots,
the `pendingHandoff` slot, and the post-model hook that stamps handoff replies — and
`/create-tool` can add channel-handoff actions on top of it.

### Added
- **`create-tool/references/streaming-and-channel-contract.md`** — the wire contract a generated
  agent emits plus the middleware adherence checklist: invoke shape (snake_case `user_id` /
  `customer_code` / `role`, `assistant_id: "agent"`), the handoff `additional_kwargs` contract on
  the final reply, the verified LangGraph JS streaming event order (tokens vs `updates`, where
  `is_handoff` appears, the correct trigger point), and testing guidance per layer.
- **`create-tool/templates/executor-handoff.ts.template`** — channel-handoff executor: env-gated
  service catalog (`HANDOFF_ENABLED` / `HANDOFF_TOOLS`), guardrail pre-checks returning structured
  refusal verdicts, writes `pendingHandoff`, returns `isHandoff: true`; declared
  `controller: { soleStep: true }`.
- **Bootstrap scaffold wire contract**: `project/state.ts.template` gains the identity slots
  (`user_id` / `customer_code` / `role` with preserve-initial reducers, `?? null` coercion
  caveat) and the `pendingHandoff` slot + `PendingHandoff` schema; `project/agent.ts.template`
  gains the `postModelHook` annotator that stamps the final reply with the `is_handoff`
  `additional_kwargs` contract (a no-op until a handoff tool exists).
- **SKILL essential principle #12** (the channel wire contract is bootstrap-level, not per-tool)
  and **create-tool workflow step 6c** (the handoff-action recipe: service catalog, executor,
  config, guardrails, prompt section).

### Changed
- `references/project-bootstrap-structure.md` — `state.ts` / `agent.ts` descriptions cover the
  new slots and the post-model hook.
- `templates/backend-env.ts.template` / `templates/project/env.example.template` — `BANK` no
  longer carries a baked-in default; set it per backend in `.env`.
- `workflows/bootstrap-project.md` — agent display name and one-line description are always asked
  of the user, never invented.
- Reference wording polish (voice-rule closers, transcript-language guidance); bump-version
  `tracked-assets.md` inventories the new template (Tier 2) and reference (Tier 4).

## [0.8.0] — 2026-06-11

The sandbox-contract release, shipping agent-step library **1.2.0**. Every project the toolkit
produces now formally requires a root `sandbox/` service — a standalone local API mimicking the
tools' backends (never AI resources) — and the skills now say what it is, how to acquire it, and
when to extend it. Downstream projects adopt the library via `/pull-library` (additive; no
transforms — with an optional cleanup to replace hand-rolled state slots with the library
fragments).

### Added
- **`create-tool/references/sandbox-contract.md`** — the required sandbox: lifecycle CRUD at
  `POST/GET /sandbox` + `GET/PUT/DELETE /sandbox/:sandboxId` (POST accepts an optional
  `{"sandboxId"}` body), case-insensitive `Sandbox-Id` header isolation on every domain endpoint,
  **mandatory JSON seeding** via PUT (what the test reset cycle depends on; boot-time default seeds
  are an optional convenience), APIs-only scope, the best-effort acquisition ladder (reference
  project → adapt a near-miss → Postman collection → specs), and a compliance checklist.
- **Sandbox establishment/extension steps in all three create-tool workflows**: bootstrap intake
  question + Step 6c (establish, or defer explicitly — never silently); port Step 1 sandbox
  inventory + Step 2b (reusing the source's sandbox verbatim is the one sanctioned exception to
  paradigm-not-blueprint); create-tool Step 2 endpoint check + plan "sandbox extensions" section +
  Step 4a (extend the sandbox; never stub the backend in-process).
- **`create-tool/SKILL.md` essential principle #10** — "the sandbox is part of the deliverable"
  (previous #10 renumbered to #11; cross-references updated) — plus a quick-reference sandbox block;
  the skill description now advertises sandbox setup/extension.

### Changed
- **Library 1.2.0** (CHANGELOG `[1.2.0]`, migration `1.1.1-to-1.2.0.md`): `PagedCacheSchema`
  re-exported from `index.ts`, completing the library-managed slot-schema trio.
- **`templates/project/state.ts.template`** now spreads `agentStepStateSpec` / `agentStepZodShape`
  instead of hand-declaring the library-managed slots — what the library's own doc-comment mandates.
  Verified against the template's pinned deps: typecheck clean, all 65 library unit tests pass.
- **`state-and-prompt-integration.md`** and **`agent-step-api.md`** now teach the spread instead of
  hand-declaration; **`test-agent-step/SKILL.md`** points its sandbox-enrichment rule and reference
  list at the sandbox contract.

### Fixed
- **`pull-library` workflow:** the library-replacement `cp` omitted `paginate.ts` +
  `paginate.test.ts` (silent file loss on any 0.1.0/1.0.0 → 1.1.x upgrade — the byte-for-byte
  success criterion could never pass); the impossible `1.0.0-to-2.0.0.md` chain example replaced
  with the real adjacent chain; the no-`VERSION` baseline explicitly named (`0.1.0`); the
  post-migration test claim now accounts for the 1.1.0+ test-glob broadening.
- **`project-bootstrap-structure.md`:** the `src/agent-step/` listing was missing `state.ts`, the
  paginate files, and `VERSION`; now complete, with `sandbox/` added to the project layout.

## [0.7.0] — 2026-06-10

Removed-skill release, inert for consumers: the maintainer-side `bump-version` skill moved out of
the published plugin into the marketplace repo (`.claude/skills/bump-version/`). It edits the
plugin's **source tree**, which only exists in the repo checkout — from an installed plugin cache it
never could function, and the cached copy lags the repo (observed running as its 0.5.0 snapshot
against a 0.6.x repo). Consumers keep `/pull-library`; nothing usable was removed. By the semver
rule a removed skill is major; with the plugin still pre-1.0 the breaking slot is the minor →
**0.7.0**. Ships agent-step library **1.1.1** (unchanged since 0.6.1); no `/pull-library` needed.

### Removed
- **`skills/bump-version/`** — relocated to the repo-level `.claude/skills/bump-version/` together
  with its `tracked-assets.md` blast-radius reference (its plugin-relative paths rewritten, and its
  Tier-1 file list / copy command corrected to include `paginate.ts` + `paginate.test.ts`). The
  marketplace description no longer advertises `/bump-version`.

### Fixed
- **`create-tool/workflows/create-tool.md`:** library unit-test count corrected 53 → 65
  (runner + paginate).
- **`pull-library/SKILL.md`:** the `/bump-version` complement is now described as a maintainer
  skill in the marketplace repo (not "in the toolkit").

## [0.6.1] — 2026-06-09

Ships agent-step runner library **1.1.1** (doc-comment corrections only — no behavior change).
Downstream projects can adopt via `/pull-library`; no consumer transforms.

### Fixed
- **Library contract doc-comments**, surfaced by a contract audit against live runtime behavior:
  `runner.ts` header `cancel_pending_confirmation` → `abort_pending_input`; `ConfirmationOpts.ttlMs`
  documented INERT (and the unused `CONFIRMATION_DEFAULTS.ttlMs` annotated); `ExecutorResult.ok`
  documented as a batch-continuation control flag (not a verdict); `startsFlow` documents
  flow-persistence-across-turns / no implicit goal-switch reset. CHANGELOG [1.1.1] +
  migration `1.1.0-to-1.1.1.md`.

### Changed
- **`executor-patterns.md`:** reconciled the Pattern 1 vs Pattern 2 `ok` guidance (it's
  batch-continuation control, not success), and added **Pattern 10 — Router / classifier executor**
  (single action, always-`ok:true` with the verdict in `resultBody`, `currentFlow.data` as a
  cross-turn accumulator) so the references no longer read as data-tool-only.
- **`agent-step-api.md`:** added an explicit note that `requiresFlow`/prereqs are evaluated before a
  confirm-gated mutation proposes, so an unmet flow refuses rather than proposing into a doomed state.

## [0.6.0] — 2026-06-09

### Added
- **Port mode in `create-tool`.** New 4th intake option and `workflows/port-project.md`: re-platform
  an existing (non-agent-step) project onto agent-step by reading the source as a *domain spec only*
  (capabilities, endpoints, identity model, business rules), then deriving each tool fresh via
  `create-tool.md`. Wired into `SKILL.md` intake / routing / workflows index.
- **Data-analysis pattern in `create-tool`.** New `references/data-analysis-pattern.md` (the build
  recipe for executor Pattern 9 — LLM-authored compute over fetched data) plus four templates:
  `executor-analysis.ts.template`, `analysis-vm.ts.template` (the constrained `node:vm` runner),
  `datasets.ts.template` (single-source-of-truth `DATASETS` schema feeding the VM, the static prompt
  schema, and the live data block), and `verifier-data-loaded.ts.template`. Wired into `SKILL.md`
  (reference + templates index), the `create-tool.md` workflow (new Step 6b + the required prompt
  upgrade), and cross-linked from `executor-patterns.md` Pattern 9 and `read-tool-patterns.md`
  `<retrieve_vs_analyze>`. Uses only existing runner primitives — no library change.

### Changed
- **Two essential principles made explicit in `create-tool/SKILL.md`:**
  - *#9 — Paradigm, not blueprint.* The bundled `templates/` + references are the only structural
    source of truth; a referenced/source project is domain input (the *what*), never architecture to
    copy (the *how*).
  - *#10 — Prereqs express journey progress; `invalidatesOnChange` keeps it coherent.* Prereqs encode
    where the user is in their journey (identity acquired → entity selected → flow open); the
    `invalidatesOnChange` library opt is now surfaced at planning time (SKILL quick reference + the
    create-tool workflow's Step 2 derivation and Step 3 plan template) instead of only in the deep
    API reference.
- **Phantom `src/tools/cards/` references repointed to the bundled templates.** The reference docs
  pointed agents at a non-existent `cards` reference tool as the "source of truth"; they now point at
  `templates/*.template` and explicitly warn against copying a pre-existing or ported tool's code.
  Touches `tool-directory-layout.md`, `executor-patterns.md`, `state-and-prompt-integration.md`,
  `input-formats.md`, `agent-step-api.md`, and `templates/backend-client.ts.template`.

### Notes
- Docs/skill-only release — no agent-step runner library change (still **1.1.0**); no `/pull-library`
  needed.

## [0.5.0] — 2026-06-08

### Changed
- Ships agent-step runner library **1.1.0** — native read pagination via the `pageable` action opt
  (the runner injects `page`/`pageSize`, returns a uniform envelope, and caches the full set in the
  library-managed `pagedRead` slot). See [`CHANGELOG.md`](CHANGELOG.md) and
  [migrations/1.0.0-to-1.1.0.md](migrations/1.0.0-to-1.1.0.md).
- `create-tool` pagination reconciled to the library opt: `executor-read-paginated.ts.template` now
  uses `pageable`; the hand-rolled `reslice-cache.ts.template` from 0.4.0 is **removed**
  (`querySignature` is now a library export); the `pagedRead` library-managed slot is added to the
  bootstrap state template; references/workflows updated; the bootstrap `test` script runs
  `dist/agent-step/*.test.js` (runner + paginate).

### Notes
- Downstream projects pull the new library via `/pull-library` (additive; `pageable` is opt-in, so
  existing tools are unaffected).

## [0.4.0] — 2026-06-05

### Added
- **Paginated-read support in `create-tool`.** New `executor-read-paginated.ts.template`
  (single-source paginated read in the per-action `Slice` shape: `page`/`pageSize` params, full rows
  → state, one bounded page → the model, optional reslice-cache) and `reslice-cache.ts.template`
  (`querySignature` helper). Generalized from a working agent-step read action.
- Result size is now a **prompted decision**, not just documented: the derivation checklist asks
  "large/list read → paginate?", the plan template surfaces it per read action, and the create-tool
  workflow picks the executor template by shape.

### Notes
- No library change — still vendors agent-step `1.0.0`. Downstream projects do **not** need
  `/pull-library`; the new templates apply only to newly-authored actions.

## [0.3.0]

- Vendored agent-step runner library **1.0.0** (per-action state selectors). See
  [`CHANGELOG.md`](CHANGELOG.md) and [migrations/0.1.0-to-1.0.0.md](migrations/0.1.0-to-1.0.0.md).
- Self-contained test scaffolding (shared harness + per-tool sandbox / prompt-input templates),
  general references (identity patterns, read-tool patterns), and config-doc fixes.

## [0.2.0]

- Added library versioning skills: `/bump-version` (maintainer) and `/pull-library` (downstream).

## [0.1.0]

- Initial release: `create-tool` (bootstrap + add-tool) and `test-agent-step` skills.
