# Workflow: pull-library

Upgrade the current downstream project's vendored agent-step library to the version shipped by the
installed `agent-step-toolkit` plugin, then adapt the project's own tools. Five phases with a hard
approval gate before any edit to `src/tools/`.

Read first: `../../migrations/README.md` (the migration file format).

---

## Phase 1 — Locate source & target

1. **Resolve the plugin directory.** The library source is
   `<plugin>/skills/create-tool/templates/agent-step/` and the migrations live in
   `<plugin>/migrations/`. (When this skill runs, it knows its own plugin root — use it.)
2. **Source version:** read `<plugin>/skills/create-tool/templates/agent-step/VERSION`.
3. **Target:** confirm `src/agent-step/` exists in the cwd. Read `src/agent-step/VERSION` if present;
   if absent, treat the project as the **baseline** version recorded in `<plugin>/CHANGELOG.md`
   (the earliest entry).
4. If `src/agent-step/` is missing entirely, stop — this isn't a vendored project; direct the user to
   `/create-tool` (bootstrap) instead.

---

## Phase 2 — Plan the jump

1. Compare project version → toolkit version.
   - **Equal:** report "already current at `<version>`" and stop.
   - **Toolkit newer:** build the ordered chain of migration files between them, e.g. project `0.1.0`
     → toolkit `1.1.1` ⇒ apply `0.1.0-to-1.0.0.md`, then `1.0.0-to-1.1.0.md`, then `1.1.0-to-1.1.1.md`
     — every adjacent step recorded in `migrations/`, matched by `<from>`/`<to>` names; a single jump
     is the common case.
   - **Project newer than toolkit:** stop and warn (the plugin is older than the project — the user
     likely needs to update the plugin first).
2. **Enumerate the project's tools.** Scan `src/tools/*` to list each tool and its actions
   (`src/tools/<name>/actions/<action>/`). These are what the `<transforms>` will touch.
3. **Read the `<transforms>`** from each migration file in the chain. For each transform, resolve its
   `target` (glob / file role) against this project's actual files, so the proposal can name concrete
   paths.

---

## Phase 3 — Propose (APPROVAL GATE)

Present and **stop for approval** before editing `src/tools/`:
- Version jump: project `<from>` → toolkit `<to>`, and the migration chain to apply.
- Library files that will be replaced (`src/agent-step/*`) — note this is safe (vendored).
- For each migration, the `<transforms>` and the concrete project files each will edit.
- A heads-up of likely **manual follow-ups** the prose flags as non-automatable.

Revise on request; proceed only on explicit approval.

---

## Phase 4 — Apply

1. **Replace the vendored library** from the toolkit (verbatim):
   ```
   cp <plugin>/skills/create-tool/templates/agent-step/{types,state,runner,runner.test,paginate,paginate.test,define-config,index}.ts src/agent-step/
   cp <plugin>/skills/create-tool/templates/agent-step/VERSION src/agent-step/VERSION
   ```
   Mirror any added/removed library files the migration notes.

2. **Apply each migration's `<transforms>` in chain order**, top to bottom. For each transform:
   - Resolve `target` to the concrete files in this project.
   - Make the `change` exactly as specified, with judgment for this project's naming (tool names,
     action names, state shape differ from the toolkit's examples).
   - Honour idempotency — if the change is already present, skip it.
   - Run the transform's `check` mentally / via a quick grep or `tsc` to confirm it landed.
   - If a transform can't be applied safely (ambiguous, needs a design decision), DON'T force it —
     record it as a manual follow-up and continue.

3. **Bump the project `VERSION`** to the toolkit version (already copied in step 1 — confirm it reads
   the new value).

---

## Phase 5 — Verify & report

1. Run:
   ```
   npm run typecheck
   npm test
   ```
   (Use the project's actual scripts; `npm test` runs the vendored library tests and should pass once
   any test-glob broadening a migration prescribes — e.g. `dist/agent-step/*.test.js` for
   `paginate.test.js` in 1.1.0+ — has been applied.)
2. **Report:**
   - Version old → new; migration chain applied.
   - Library files replaced; tools/actions adapted (with the transforms applied to each).
   - Typecheck / test outcome.
   - **Manual follow-ups:** every transform that couldn't be fully applied, with concrete file:line
     and what the user must decide/do by hand. Be explicit — a half-migrated project that typechecks
     by luck is worse than a clear list of what's left.
3. If typecheck still fails after transforms, surface the errors grouped by file — they are the
   precise remaining migration work, not a reason to revert.
