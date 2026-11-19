# Reference: Tracked assets (library blast-radius map)

<overview>
The agent-step library is embedded in this plugin as a verbatim copy AND mirrored by a layer of
dependent assets that encode its contract (templates, reference docs, workflows, SKILL prose). When
`/bump-version` ingests a new runner, the verbatim copy is replaced mechanically — but every
dependent asset that describes the OLD contract must be hand-updated too, or the toolkit will
bootstrap projects against a contract the library no longer honours.

This file is the durable inventory of those assets, organised by tier, each noting **what kind of
library change touches it**. Phase 2 of the workflow maps a concrete diff onto these tiers to
compute the blast radius; Phase 4 edits them. Keep this file current when the plugin's layout
changes — it is the single place that knows "what mirrors the library."

All paths are relative to the plugin root (`plugins/agent-step-toolkit/`).
</overview>

<tier name="1_library_copy">
## Tier 1 — Library copy (verbatim replace; mechanical)
The embedded runner. Replaced byte-for-byte from the new source; never hand-merged. Since 2.0.0
the library is a TREE (five phase-module subdirectories) — replace recursively, not per-file.

Top level (`skills/create-tool/templates/agent-step/`):
- `types.ts` — the authoring contracts (`VerdictDef` (incl. the row `ask`: `RowAsk`, and `continuation` / `presentation`) / `DeclaredExecutorResult` / `ExecutorEffect`, `ActionDef` (verdicts/satisfies/bounceCapture/invalidParamsVerdict), `AgentStepConfig` (+ `tool.toolChoice`, config-level `invalidations`), `ControllerHooks`, `ConfirmationOpts` (+ `GateContractSpec`), `AskContractSpec`, `SatisfiesSpec` / `SatisfiedSource`, registries)
- `state.ts` — the library-managed slot schemas + the slot table (`AGENT_STEP_SLOT_META`) + spreadable fragments (`agentStepZodShape`, `agentStepStateSpec`) and derived views (`agentStepInternalSlotMask`, `agentStepTaskScopedSlots`, `agentStepRunnerOwnedSlots`)
- `runner.ts` — the thin public entry points (`buildAgentStepTool`, `runSteps`)
- `reply.ts` — required tool calling, host-facing half (4.1.0): `modelToolsForTurn`, `modelToolOptions`, `completedReply`, `toolOnlyMessage`, `renderReplyText` + the transcript readers the runner shares. Mirrored by `agent-step-api.md` `<required_mode>` (the wiring recipe), `streaming-and-channel-contract.md` (what the channel observes), `templates/project/test-harness-prompt-input.ts.template` and `cli.ts.template` (both mode-aware)
- `engine-text.ts` — every string the engine emits to the model (`ENGINE_TEXT`): model-facing `instruction` text, engine-owned, NO host override (replaced `messages.ts` / the `messages` option in 4.0.0)
- `tolerances.ts` — the four engine tolerances: measured defaults, the `AGENT_STEP_*` environment variable names (`TOLERANCE_ENV`), `resolveTolerances`; the only module that reads the environment. Mirrored by `templates/project/env.example.template` (the commented variable block) and `agent-step-api.md` `<escalation>` (the Tolerances table)
- `define-config.ts`, `index.ts` (the public surface), `paginate.ts`, `capture.ts` (param builders incl. text/judged/relay/XOR + the field-kind registry)
- Tests: `runner.test.ts`, `handoff.test.ts`, `hardening.test.ts`, `declare-hardening.test.ts`, `paginate.test.ts`, `capture.test.ts`, `field-kinds.test.ts`, `repeat-question.test.ts`, `escalation.test.ts`, `tolerances.test.ts`, `satisfies.test.ts`, `engine-text.test.ts`, `dictation.test.ts`, `verdict-map.test.ts`, `action-describe.test.ts`, `gate-contract.test.ts`, `reply.test.ts`, `clarification-reply.test.ts`, `continuation.test.ts`, `protocol.test.ts` (the protocol fragment and the tool surface agree on what exists), `zod-state.test.ts` (isolation test: merger derived from a Zod state schema)
- `VERSION` — rewrite to the new version string.

Phase modules (internal layout; hosts import only from `index.ts`):
- `compile/` — `validate.ts`, `plan.ts` (`BuildAgentStepToolOptions`), `activation.ts`, `schema.ts`, `describe.ts`, `action-describe.ts`, `gate-contract.ts`, `ask-contract.ts`, `asks.ts` (row-ask resolution), `protocol.ts`, `state-schema.ts`
- `run/` — `admission.ts`, `planning.ts`, `execution.ts` (verdict-row normalization), `finalize.ts` (standing-ask lifecycle), `satisfies.ts` (state-satisfied inputs), `batch-state.ts`, `value-equal.ts`
- `interaction/` — `confirmation.ts`, `otp.ts`, `match.ts`, `flow.ts`, `dictation.ts`, `escalation.ts` (bounded patience + the structural handoff contexts), `repeat-confirmation.ts` (shared by the repeat control and the `clarification` reply), `turn-identity.ts` (owns `resolveCallerTurnId`)
- `controls/` — `contract.ts`, `registry.ts`, `abort.ts`, `request-handoff.ts`, `repeat-question.ts`, `note-refusal.ts` (the refusal kinds + the shared misuse definition), `respond-to-caller.ts` (the required-mode speech control)
- `handoff/` — `contract.ts`, `node.ts`, `delegate-client.ts`

A source repo may carry an `UPSTREAM.md` (its own porting note) — do NOT copy it into the toolkit.

**Touched by:** every library change (this IS the library). If the new source adds/removes files
in `src/agent-step/`, mirror that here AND update the bootstrap copy list
(`skills/create-tool/workflows/bootstrap-project.md`, Step 5 + the file-list section) and the
`templates_index` in `skills/create-tool/SKILL.md`.
</tier>

<tier name="2_tool_templates">
## Tier 2 — Tool templates (hand-edit)
What `/create-tool` writes into `src/tools/<name>/`. These spell out the executor/registry
signatures and the wire-up, so any change to the executor signature, the registries, or
`buildAgentStepTool`'s options ripples here.

- `skills/create-tool/templates/names.ts.template` — the types-only ActionName/PrereqName leaf
- `skills/create-tool/templates/action.ts.template` — the per-action declaration (schema with field kinds, verdict rows with their asks, satisfies/bounceCapture, controller); encodes `VerdictDef`/`RowAsk`/`SatisfiesSpec`/`ConfirmationOpts` authoring
- `skills/create-tool/templates/config.ts.template` — the assembler + the config-level `invalidations` table
- `skills/create-tool/templates/tool-index.ts.template`  — the `buildAgentStepTool({...})` call + registries
- `skills/create-tool/templates/state-selector.ts.template` — the per-action `getSlice` + `Slice` shape
- `skills/create-tool/templates/executor-read.ts.template`
- `skills/create-tool/templates/executor-read-paginated.ts.template` — encodes the `pageable` contract (runner-injected page params, `items` envelope)
- `skills/create-tool/templates/executor-mutation.ts.template`
- `skills/create-tool/templates/executor-handoff.ts.template` — channel-handoff executor; mirrors `DeclaredExecutorResult` and the `soleStep` controller opt, writes the bootstrap `pendingHandoff` slot
- `skills/create-tool/templates/executor-analysis.ts.template`, `analysis-vm.ts.template`, `datasets.ts.template`, `verifier-data-loaded.ts.template` — the data-analysis scaffold; mirror the `DeclaredExecutorResult` / verdict-row / `Verifier` / selector shapes
- `skills/create-tool/templates/verifier.ts.template`
- `skills/create-tool/templates/tool-test-setup.ts.template` — wires `toolOpts` (config + registries) mirroring `index.ts`
- `skills/create-tool/templates/tool-sandbox-test.ts.template` — calls `runSteps(toolOpts, steps, state)` directly, so it mirrors that public entry point's signature and the result-body shape it asserts on. (`prompt-input-test.ts.template` imports only from the shared harness, so the Tier-3 harness templates cover it.)
- `skills/create-tool/templates/backend-env.ts.template`, `skills/create-tool/templates/backend-client.ts.template` (rarely — only if transport contract changes)
- `skills/create-tool/templates/plan.md.template` — the per-tool plan the workflow fills before any file is written; its lifecycle-token table spells the controller opts (`startsFlow`, `requiresOtp`, `requiresMatch`, `soleStep`, …) and its Verifiers table spells the denial shape (`{ instruction, error }`), so a renamed controller opt or a changed `Verifier.denial` ripples here
- `skills/create-tool/templates/prompt-input-test.ts.template` — covered by the Tier-3 harness templates (see above); listed so the tier matches the directory
- `skills/create-tool/templates/findings.md.template`, `skills/create-tool/templates/tool-seed.json.template` — NOT library mirrors (the test-findings record and the sandbox seed); a library bump does not touch them

**Touched by:** executor signature changes, registry shape/typing changes, new/removed
`buildAgentStepTool` options, new per-action files (e.g. a new `stateSelector.ts` sibling means a
new template + a new import line in `tool-index.ts.template`).
</tier>

<tier name="3_project_templates">
## Tier 3 — Project scaffold templates (hand-edit)
- `skills/create-tool/templates/project/state.ts.template` — if `agentStepStateSpec` / `agentStepZodShape` shape changed, or library-managed slots were added/renamed.
- `skills/create-tool/templates/project/package.json.template` — compare the new source project's `package.json` deps (`@langchain/*`, `zod`, `tsx`, `typescript`, etc.) and bump to match.
- `skills/create-tool/templates/project/test-harness-sandbox.ts.template`, `…/test-harness-prompt-input.ts.template` — if `runSteps` / the harness helper surface changed. The prompt-input harness is MODE-AWARE: under required tool calling it binds through `modelToolsForTurn` / `modelToolOptions`, reads `TURN_FIELD` / `TURN_MISUSE` / `TURN_SERVICE`, and renders speech with `renderReplyText` — a change to any of those `reply.ts` / `compile/schema.ts` exports, or to the speech control's param shapes, ripples here.
- `skills/create-tool/templates/project/prompt.ts.template`, `agent.ts.template`, `graph.ts.template` — only if the graph-wiring or prompt-structure contract changed. `agent.ts.template` is the AUTO-mode graph; the required-mode graph is a documented recipe in `agent-step-api.md` `<required_mode>` (verify it by instantiation when `reply.ts` changes — it is not a template).
- `skills/create-tool/templates/project/cli.ts.template` — the streaming CLI; it declares its own `StepResult` / tool-envelope shapes to print the trace, so a change to the result body (e.g. `summary` vs `instruction`, a renamed envelope field) ripples here. It also detects required tool calling from the tools (the speech control's name) to decide whether chat-model stream text is ever the reply.
- `skills/create-tool/templates/project/env.example.template` — the handoff variables the scaffold reads AND the commented `AGENT_STEP_*` tolerance block, which mirrors `tolerances.ts` (`TOLERANCE_ENV`, the defaults and ranges); update when an environment variable the library or the scaffold reads is added, renamed or removed.
- `skills/create-tool/templates/project/test-harness-index.ts.template`, `tools-index.ts.template` — barrels; touched only if the harness surface or the tool-registration shape changes.
- NOT library mirrors (a library bump does not touch them): `llm-env.ts.template`, `cli-env-init.ts.template`, `Dockerfile.template`, `build_and_push.sh.template`, `gitignore.template`, `langgraph.json.template`, `tsconfig.json.template`.

**Touched by:** state-spec changes, dependency bumps, runner/harness API changes, result-body changes (the CLI), environment variables the library reads.
</tier>

<tier name="4_reference_docs">
## Tier 4 — Reference docs (hand-edit; these ARE the written contract)
- `skills/create-tool/references/agent-step-api.md` — the canonical contract: runner signature, type listings (`Executor`, `ExecutorRegistry`, `Verifier`, `ActionDef`, `VerdictDef`, `DeclaredExecutorResult`, `ControllerHooks`, `GateContractSpec`, `RowAsk`, `AskContractSpec`, `SatisfiesSpec`, lifecycle), the engine-composed model surface, construction-time checks. The highest-fidelity doc; update it for ANY public-surface change.
- `skills/create-tool/references/tool-directory-layout.md` — canonical `src/tools/<name>/` layout, per-file responsibility, naming rules, file-creation order, imports convention. Update when files are added/removed per action or the signatures in the per-file notes change.
- `skills/create-tool/references/executor-patterns.md` — read vs mutation executor shapes; update when the executor signature or state-update shape changes.
- `skills/create-tool/references/state-and-prompt-integration.md` — how `src/state.ts` / `src/prompt.ts` / `src/tools/index.ts` are patched; update if state wiring changes.
- `skills/create-tool/references/agent-design-principles.md` — the host-architecture doctrine (mechanism-in-engine, prompt purity, transcript-only state, engine-rendered consequence text, …). Update when a library change adds/retires a mechanism the principles cite (e.g. a new control, renderer, or refusal hook).
- `skills/create-tool/references/data-analysis-pattern.md` — the analyze-action recipe; embeds the executor/selector/verifier shapes and the `DatasetSource` wiring.
- (Other references — `identity-patterns.md`, `read-tool-patterns.md`, `input-formats.md`, `project-bootstrap-structure.md`, `sandbox-contract.md`, `streaming-and-channel-contract.md` — update only if their examples encode a changed signature; `sandbox-contract.md` and `streaming-and-channel-contract.md` describe the local sandbox service and the channel middleware wire contract respectively, not the library, so a library bump rarely touches them.)

**Touched by:** any change to the public API, the tool layout, or executor patterns.
</tier>

<tier name="5_workflows">
## Tier 5 — Workflows (hand-edit)
- `skills/create-tool/workflows/create-tool.md` — file-creation order, the per-file write steps, the wiring instructions. Update if a new per-action file exists or wire-up changes.
- `skills/create-tool/workflows/bootstrap-project.md` — the agent-step copy list (Step 5) and the file-list section; update if Tier 1 files were added/removed.
- `skills/create-tool/workflows/port-project.md` — orchestration only: it reads the source project as a domain spec and delegates to the two workflows above, naming no library types. Update only if the bootstrap / create-tool steps it points at are renumbered or renamed.

**Touched by:** new/removed per-action files, new library files, changed wire-up steps.
</tier>

<tier name="6_skill_prose">
## Tier 6 — SKILL prose (hand-edit)
- `skills/create-tool/SKILL.md` — `<essential_principles>` (states the library invariants), `<quick_reference>` (canonical layout block), `<templates_index>` (template inventory).
- `skills/test-agent-step/SKILL.md` — only if the test surface (runner unit-test entry points, harness helpers) shifted.
- `skills/audit-middleware-contract-compliance/SKILL.md` — only if the channel/streaming surface shifted (handoff custom events, `HANDBACK_SIGNALS`, the `resolve_handoff` node, stream modes). Its checklist summaries are navigation aids over `streaming-and-channel-contract.md` — when that doc changes, reconcile this prose too.
- `skills/document-agent-flow/` — `references/engine-notation.md` (primitive catalog, controls, library slots, retired terms), `templates/flowdoc/model.py` `RETIRED_ENGINE_TERMS`, and the `engine_version` examples (SKILL.md quick reference, `examples/pizza-order/` — rebuild its `out/`) — update when a primitive, control or slot is added, removed or renamed.

**Touched by:** invariant changes (e.g. "executor receives whole state" → "executor receives a
projected slice"), layout changes, template inventory changes.
</tier>

<not_tracked>
## Not tracked (do NOT touch on a library bump)
- `.claude-plugin/plugin.json` `version` — the plugin package version is independent of the library version.
- The versioning skills themselves (this skill, at the repo-level `.claude/skills/bump-version/`,
  and the plugin's `skills/pull-library/`) — they describe the process, not the library contract.
- `CHANGELOG.md` / `migrations/` — these are *outputs* of the bump, written in Phase 4, not mirrors
  to reconcile.
</not_tracked>
