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
The embedded runner. Replaced byte-for-byte from the new source; never hand-merged.

- `skills/create-tool/templates/agent-step/types.ts`
- `skills/create-tool/templates/agent-step/state.ts`
- `skills/create-tool/templates/agent-step/runner.ts`
- `skills/create-tool/templates/agent-step/runner.test.ts`
- `skills/create-tool/templates/agent-step/define-config.ts`
- `skills/create-tool/templates/agent-step/index.ts`
- `skills/create-tool/templates/agent-step/VERSION` — rewrite to the new version string.

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

- `skills/create-tool/templates/config.ts.template`
- `skills/create-tool/templates/tool-index.ts.template`  — the `buildAgentStepTool({...})` call + registries
- `skills/create-tool/templates/executor-read.ts.template`
- `skills/create-tool/templates/executor-mutation.ts.template`
- `skills/create-tool/templates/verifier.ts.template`
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
- `skills/create-tool/references/agent-step-api.md` — the canonical contract: runner signature, type listings (`Executor`, `ExecutorRegistry`, `Verifier`, `ActionDef`, `ControllerHooks`, `ExecutorResult`, lifecycle), construction-time checks. The highest-fidelity doc; update it for ANY public-surface change.
- `skills/create-tool/references/tool-directory-layout.md` — canonical `src/tools/<name>/` layout, per-file responsibility, naming rules, file-creation order, imports convention. Update when files are added/removed per action or the signatures in the per-file notes change.
- `skills/create-tool/references/executor-patterns.md` — read vs mutation executor shapes; update when the executor signature or state-update shape changes.
- `skills/create-tool/references/state-and-prompt-integration.md` — how `src/state.ts` / `src/prompt.ts` / `src/tools/index.ts` are patched; update if state wiring changes.
- (Other references — `identity-patterns.md`, `read-tool-patterns.md`, `input-formats.md`, `project-bootstrap-structure.md` — update only if their examples encode a changed signature.)

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

**Touched by:** invariant changes (e.g. "executor receives whole state" → "executor receives a
projected slice"), layout changes, template inventory changes.
</tier>

<not_tracked>
## Not tracked (do NOT touch on a library bump)
- `.claude-plugin/plugin.json` `version` — the plugin package version is independent of the library version.
- The new skills themselves (`skills/bump-version/`, `skills/pull-library/`) — they describe the
  process, not the library contract.
- `CHANGELOG.md` / `migrations/` — these are *outputs* of the bump, written in Phase 4, not mirrors
  to reconcile.
</not_tracked>
