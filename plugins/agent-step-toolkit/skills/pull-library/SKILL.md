---
name: pull-library
description: Upgrade THIS project's vendored agent-step runner library to the newest version shipped by the agent-step-toolkit plugin. Run inside a downstream project (one that bootstrapped from the toolkit and vendored src/agent-step/) after the plugin has been updated. Compares the project's src/agent-step/VERSION against the toolkit's, replaces the vendored library files, bumps the project's VERSION, then applies the version-keyed migration transforms to the project's own tools (adding per-action files, rewriting executor/registry signatures, updating buildAgentStepTool wire-up), and verifies with typecheck + tests. Use when a downstream project needs to catch up to a newer agent-step library.
---

<objective>
This skill is the **consumer side** of agent-step library versioning. It runs inside a downstream
project that vendored `src/agent-step/` from the toolkit. After the user updates the
`agent-step-toolkit` plugin (getting a newer embedded library), this skill pulls that library into
the project and adapts the project's own tools so they keep compiling against the new contract.

The complement is `/bump-version`, which runs in the toolkit to produce the newer library, the
`VERSION`, the CHANGELOG, and the migration guides this skill consumes.

Scope (per project decision): **copy + attempt tool adaptation**. The library replacement and
VERSION bump are mechanical and always done. The tool adaptation applies each migration's
`<transforms>` to the project's tools with judgment, then verifies — and surfaces anything it
couldn't safely automate as explicit manual follow-ups.
</objective>

<essential_principles>
**1. The toolkit is the source; this project is the target.** The library, `VERSION`, and migration
guides come from the installed plugin's own files — never invented here. This skill reads them out
of the plugin directory and writes into the current project's `src/agent-step/` and `src/tools/`.

**2. Version-gated.** Read the toolkit `VERSION` and the project `VERSION`. If equal, the project is
current — report and stop. If the project has no `VERSION`, treat it as the baseline and apply the
full chain. Apply migration files in version order for multi-step jumps.

**3. The migration `<transforms>` are the instructions.** Don't free-style the tool edits. Each
applicable `migrations/<from>-to-<to>.md` carries an ordered, checked `<transforms>` section; apply
them top to bottom, honouring each `check`. Transforms are idempotent — re-running should be a no-op.

**4. It edits the user's own code — gate it.** Replacing `src/agent-step/` is safe (vendored, never
hand-edited). Rewriting the project's tools is not. Propose the full plan (files replaced, transforms
to run, tools/actions affected) and wait for approval before touching `src/tools/`.

**5. Verify, then be honest about gaps.** After applying, run typecheck + tests. Report what passed,
and surface every transform that couldn't be fully applied as a concrete manual follow-up with
file:line — never silently leave the project half-migrated.
</essential_principles>

<intake>
Confirm this is a downstream project (an `src/agent-step/` directory exists in the cwd) and that the
`agent-step-toolkit` plugin is available. Resolve the plugin's directory (its installed location) —
the library source is `<plugin>/skills/create-tool/templates/agent-step/` and the migration guides
are `<plugin>/migrations/`. If `src/agent-step/` is absent, this isn't a vendored project; tell the
user to bootstrap with `/create-tool` instead.
</intake>

<routing>
Follow `workflows/pull-library.md` exactly — locate → plan the jump → propose (gate) → apply →
verify & report. The approval gate is before any edit to the project's own tools.
</routing>

<quick_reference>
**Source (from the installed plugin):**
- Library: `<plugin>/skills/create-tool/templates/agent-step/` + its `VERSION`.
- Migrations: `<plugin>/migrations/<from>-to-<to>.md` (+ `README.md` for the format).

**Target (this project):**
- `src/agent-step/*` + `src/agent-step/VERSION` (replaced / bumped).
- `src/tools/*` (adapted per transforms).

**Outcome:** project's `src/agent-step/VERSION` equals the toolkit's; tools compile; tests pass;
any non-automatable steps reported as manual follow-ups.
</quick_reference>

<reference_index>
- **../../migrations/README.md** — the migration file format (prose + `<transforms>`) this skill consumes.
- **../create-tool/references/agent-step-api.md** — the post-upgrade contract, if you need to check what a transform is steering toward.
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| workflows/pull-library.md | Locate source+target → plan the version jump → propose (gate) → replace library + apply transforms → verify & report. |
</workflows_index>

<success_criteria>
- [ ] `src/agent-step/*` matches the toolkit's embedded copy byte-for-byte; project `VERSION` equals the toolkit `VERSION`.
- [ ] Every applicable migration's `<transforms>` was applied in order; each `check` holds (or is listed as a manual follow-up).
- [ ] `npm run typecheck` passes (or remaining errors are reported as explicit follow-ups, not hidden).
- [ ] `npm test` (runner tests) passes — the vendored library is intact.
- [ ] The user has a clear summary: version old→new, files replaced, tools adapted, manual follow-ups.
</success_criteria>
