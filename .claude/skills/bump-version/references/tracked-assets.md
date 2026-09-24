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
- `types.ts` — the authoring contracts (`VerdictDef` / `DeclaredExecutorResult` / `ExecutorEffect`, `ActionDef` (verdicts/asks/captureBounces), `ControllerHooks`, `ConfirmationOpts` (+ `GateContractSpec`), `DictationAsk`, registries)
- `state.ts` — the library-managed slot schemas + the slot table (`AGENT_STEP_SLOT_META`) + spreadable fragments (`agentStepZodShape`, `agentStepStateSpec`) and derived views (`agentStepInternalSlotMask`, `agentStepTaskScopedSlots`, `agentStepRunnerOwnedSlots`)
- `runner.ts` — the thin public entry points (`buildAgentStepTool`, `runSteps`)
- `messages.ts` — runner-emitted system `summary` strings + model-facing wire contracts (neutral English defaults; host-overridable via `BuildAgentStepToolOptions.messages`)
- `define-config.ts`, `index.ts` (the public surface), `paginate.ts`, `capture.ts` (caller capture primitives incl. text/relay/XOR builders)
- Tests: `runner.test.ts`, `handoff.test.ts`, `hardening.test.ts`, `paginate.test.ts`, `capture.test.ts`, `capture-bounce.test.ts`, `repeat-question.test.ts`, `note-refusal.test.ts`, `dictation.test.ts`, `verdict-map.test.ts`, `action-describe.test.ts`, `gate-contract.test.ts`, `zod-state.test.ts` (isolation test: merger derived from a Zod state schema)
- `VERSION` — rewrite to the new version string.

Phase modules (internal layout; hosts import only from `index.ts`):
- `compile/` — `validate.ts`, `plan.ts` (`BuildAgentStepToolOptions`), `activation.ts`, `schema.ts`, `describe.ts`, `action-describe.ts`, `gate-contract.ts`, `protocol.ts`, `state-schema.ts`
- `run/` — `admission.ts`, `planning.ts`, `execution.ts` (verdict-row normalization), `finalize.ts` (standing-ask lifecycle), `batch-state.ts`, `value-equal.ts`
- `interaction/` — `confirmation.ts`, `otp.ts`, `match.ts`, `flow.ts`, `dictation.ts`, `turn-identity.ts` (owns `resolveCallerTurnId`)
- `controls/` — `contract.ts`, `registry.ts`, `abort.ts`, `request-handoff.ts`, `repeat-question.ts`, `note-refusal.ts` (+ `climbLadder`)
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
- `skills/create-tool/templates/action.ts.template` — the per-action declaration (schema, verdict rows, asks, captureBounces, controller); encodes `VerdictDef`/`DictationAsk`/`ConfirmationOpts` authoring
- `skills/create-tool/templates/config.ts.template` — the assembler
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

**Touched by:** executor signature changes, registry shape/typing changes, new/removed
`buildAgentStepTool` options, new per-action files (e.g. a new `stateSelector.ts` sibling means a
new template + a new import line in `tool-index.ts.template`).
</tier>

<tier name="3_project_templates">
## Tier 3 — Project scaffold templates (hand-edit)
- `skills/create-tool/templates/project/state.ts.template` — if `agentStepStateSpec` / `agentStepZodShape` shape changed, or library-managed slots were added/renamed.
- `skills/create-tool/templates/project/package.json.template` — compare the new source project's `package.json` deps (`@langchain/*`, `zod`, `tsx`, `typescript`, etc.) and bump to match.
- `skills/create-tool/templates/project/test-harness-sandbox.ts.template`, `…/test-harness-prompt-input.ts.template` — if `runSteps` / the harness helper surface changed.
- `skills/create-tool/templates/project/prompt.ts.template`, `agent.ts.template`, `graph.ts.template` — only if the graph-wiring or prompt-structure contract changed.

**Touched by:** state-spec changes, dependency bumps, runner/harness API changes.
</tier>

<tier name="4_reference_docs">
## Tier 4 — Reference docs (hand-edit; these ARE the written contract)
- `skills/create-tool/references/agent-step-api.md` — the canonical contract: runner signature, type listings (`Executor`, `ExecutorRegistry`, `Verifier`, `ActionDef`, `VerdictDef`, `DeclaredExecutorResult`, `ControllerHooks`, `GateContractSpec`, `DictationAsk`, lifecycle), the engine-composed model surface, construction-time checks. The highest-fidelity doc; update it for ANY public-surface change.
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
