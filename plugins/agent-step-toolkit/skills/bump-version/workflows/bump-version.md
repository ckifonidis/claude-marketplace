# Workflow: bump-version

Refresh the toolkit's embedded agent-step library from a newer source and propagate the change.
Five phases with a hard approval gate after Phase 3. All toolkit paths below are relative to the
plugin root (`plugins/agent-step-toolkit/`); resolve it from this skill's location (the plugin root
is two levels up from `skills/bump-version/`).

Read first: `references/tracked-assets.md` (the blast-radius map) and `../../migrations/README.md`
(the migration file format).

---

## Phase 1 — Resolve & stage the source

Turn the user's reference into a local, read-only snapshot of the new `src/agent-step/`.

1. **Local path** — if it points at a project root, find `src/agent-step/` under it; if it points
   directly at an `agent-step/` dir, use it as-is.
2. **Git repo URL + ref** — shallow-clone to a temp dir at the given ref (default branch if none),
   then locate `src/agent-step/`:
   ```
   tmp=$(mktemp -d) && git clone --depth 1 [--branch <ref>] <url> "$tmp"
   ```
3. **Git ref in a local repo** — materialise the ref without disturbing the working tree:
   ```
   tmp=$(mktemp -d) && git -C <repo> archive <ref> src/agent-step | tar -x -C "$tmp"
   ```

Then:
- Confirm the core files exist: `types.ts`, `state.ts`, `runner.ts`, `runner.test.ts`,
  `define-config.ts`, `index.ts`. (A `VERSION` in the source is informational — this skill assigns
  the toolkit's library version, it doesn't inherit the source project's.)
- Capture the source project's `package.json` (for the dependency comparison in Phase 2/4).
- Note the staged path; everything below diffs against `skills/create-tool/templates/agent-step/`.

---

## Phase 2 — Diff & evaluate

1. **Diff** each staged file against the embedded copy:
   ```
   diff -u skills/create-tool/templates/agent-step/<f> "$staged/<f>"
   ```
   Include files that exist in one side only (added/removed library files).

2. **Classify the public surface.** The version bump is decided by the surface, not line count:
   - Read `index.ts` (exports) and `types.ts` (exported signatures), plus the `buildAgentStepTool`
     options type in `runner.ts`.
   - **major** — an export was removed/renamed, a type signature changed, or `buildAgentStepTool`
     gained a required arg / changed an existing one.
   - **minor** — only additive (new export, new optional arg/field), nothing existing broke.
   - **patch** — internal-only: `runner.ts` behaviour, comments, or tests changed with no surface delta.
   Compute the new version from the current `VERSION` accordingly.

3. **Diff dependencies.** Compare the source `package.json` deps against
   `templates/project/package.json.template` (`@langchain/*`, `zod`, `tsx`, `typescript`, etc.). Note
   any that should bump.

4. **Compute blast radius.** Walk `references/tracked-assets.md` tier by tier and, for each concrete
   change found in the diff, list the specific assets that must be hand-updated. Be exact — name
   files, and for reference docs/SKILL prose name the sections.

5. **Write the evaluation report** (in your response, not a file yet): the per-file diff summary, the
   surface classification + chosen version, the dependency deltas, and the blast-radius list. Call out
   anything you're unsure how to propagate.

---

## Phase 3 — Propose (APPROVAL GATE)

Present a proposal and **stop for approval**. Do not edit any toolkit file before the user approves.

The proposal contains:
- The evaluation report from Phase 2.
- The proposed new version string.
- An **ordered planned-edit list**: Tier-1 verbatim replacements first, then each dependent asset
  with a one-line description of the edit.
- A **draft CHANGELOG entry**.
- A **migration outline**: the prose headings + the intended `<transforms>` (the actual edit rules
  `/pull-library` will run). For an additive-only bump, state that no transforms are needed.

If the user requests changes, revise and re-present. Only proceed to Phase 4 on explicit approval.

---

## Phase 4 — Apply

In dependency order:

1. **Verbatim replace** every Tier-1 file from the staged source:
   ```
   cp "$staged"/{types,state,runner,runner.test,define-config,index}.ts skills/create-tool/templates/agent-step/
   ```
   Mirror any added/removed library files into the bootstrap copy list
   (`workflows/bootstrap-project.md` Step 5 + file-list) and `create-tool/SKILL.md` `templates_index`.

2. **Write the new `VERSION`:** `skills/create-tool/templates/agent-step/VERSION`.

3. **Hand-update each dependent asset** in the approved blast radius (Tiers 2–6). Match the new
   contract exactly — e.g. if the executor signature changed, every executor template, the
   `tool-index.ts.template` wire-up, `agent-step-api.md`, `tool-directory-layout.md`,
   `executor-patterns.md`, the create-tool workflow's file-creation order, and the SKILL
   `essential_principles`/`quick_reference` must all reflect it. If a new per-action file exists,
   add its template AND the import/registry lines in `tool-index.ts.template`.

4. **Bump deps** in `templates/project/package.json.template` to match the source project.

5. **Prepend the CHANGELOG entry** to `CHANGELOG.md` (newest first): version, date, Added / Changed /
   Breaking sections, and a link to the migration file.

6. **Write `migrations/<from>-to-<to>.md`** per `../../migrations/README.md` — prose + a
   `<transforms>` section of ordered, specific, idempotent edit rules `/pull-library` applies to a
   consumer's tools, each with a `check`. (Additive-only: library replacement only; say so.)

---

## Phase 5 — Verify by instantiation

The templates aren't a standalone TS project, so prove the bump by bootstrapping one:

1. Bootstrap a throwaway project from the updated `create-tool` templates into a temp dir (follow
   `../create-tool/workflows/bootstrap-project.md`, or copy the project + agent-step templates and
   substitute placeholders).
2. Run:
   ```
   npm install
   npm run typecheck
   npx tsc && node --test dist/agent-step/runner.test.js
   ```
3. Expected: zero typecheck errors, all runner tests pass. Failures here mean drift between the new
   library and a hand-edited template — fix the template, not the library.
4. Report results: version old→new, files changed, dep bumps, the migration file written, and the
   verification outcome. Remind the user that downstream projects upgrade via `/pull-library`.
