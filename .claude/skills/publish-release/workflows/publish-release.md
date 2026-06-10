# Workflow: Publish a Plugin Release

<process>

## Phase 0: Find the release baseline

1. Resolve the target plugin (from intake).
2. Find the last release commit for it:
   ```bash
   git log --oneline --grep="Release <plugin>" -1
   ```
   If none exists (first release), the baseline is the plugin's first commit.
3. Sanity-check the working tree: `git status` must be clean (or contain only changes that belong to this release — confirm with the user before sweeping them in).

## Phase 1: Collect unreleased changes

```bash
git diff --stat <baseline>..HEAD -- plugins/<plugin>/ .claude-plugin/marketplace.json
git log --oneline <baseline>..HEAD -- plugins/<plugin>/
```

Read the actual diffs for anything non-trivial. Output of this phase: a factual change list grouped as **Added / Changed / Fixed** — the raw material for the changelog entry and the semver call. If there are NO unreleased changes, say so and stop (nothing to release).

## Phase 2: Docs staleness sweep

Run every check in `references/staleness-checks.md` against the target plugin (plus the root `README.md`). For each finding, classify:

- **Fix now** — wrong inventory entries, wrong counts/claims, dangling terms. Apply the fix; it rides in the release commit and joins the changelog entry.
- **Block** — a doc describes behavior/contract that contradicts the source and the right fix isn't obvious. Surface it and stop until resolved.
- **Defer** — cosmetic or out-of-scope; list it in the proposal so the user can opt in or consciously skip.

## Phase 3: Library gate (agent-step-toolkit only)

```bash
git diff --name-only <baseline>..HEAD -- plugins/agent-step-toolkit/skills/create-tool/templates/agent-step/
```

- Library files changed AND `VERSION` among them, with a matching `CHANGELOG.md` entry and `migrations/<from>-to-<to>.md` → fine; the release commit message gains "(ships agent-step library A.B.C)".
- Library files changed but `VERSION` did NOT move (or CHANGELOG/migration missing) → **HALT.** Tell the user to run `/bump-version` first, then re-run this skill.
- Library untouched → plain plugin release.

## Phase 4: Classify + draft

1. **Semver:** apply the rule (major = removed/renamed skill or breaking workflow; minor = new skill/capability/template; patch = docs/fix, no new surface) to the Phase 1+2 change list. The HIGHEST-ranked change wins.
2. **Draft the PLUGIN_CHANGELOG entry** — Keep-a-Changelog format, newest-first, dated today, with Added/Changed/Fixed sections drawn from the change list (including the staleness fixes). For agent-step-toolkit, state which library version ships and whether `/pull-library` is needed. If the plugin has no PLUGIN_CHANGELOG.md yet, draft the file (copy the header conventions from agent-step-toolkit's).
3. **Draft the manifest edits** — new version for both files; decide whether the capability set changed enough to refresh either `description` (plugin.json and/or the marketplace entry), and draft the new text if so.
4. **Draft the commit message** per the convention in `<quick_reference>`.

**Present the proposal**: change summary, staleness findings (fixed/deferred), proposed version with one-line justification, the changelog entry draft, any description changes, and the push-mode question (direct push to `main` — recent default — vs branch + PR). **Wait for explicit approval. Do not edit files before it.**

## Phase 5: Apply + commit + push

After approval:
1. Apply the staleness fixes (if not already applied in Phase 2 with consent).
2. Edit `plugins/<plugin>/.claude-plugin/plugin.json` (version, description if agreed).
3. Edit `.claude-plugin/marketplace.json` (the plugin's entry: version, description if agreed).
4. Prepend the PLUGIN_CHANGELOG entry (or create the file).
5. Commit everything as ONE release commit with the conventional message.
6. Push per the chosen mode:
   - **Direct:** `git push origin main`, then verify `git ls-remote origin main` matches local HEAD.
   - **PR:** branch `release-<plugin>-X.Y.Z`, push, `gh pr create` with the changelog entry as the body; after the user merges, sync local `main` and delete the branch.

## Phase 6: Wrap

- Confirm remote state (commit hash on `main`, or PR URL).
- Remind: installed plugins pick the release up via `/plugin marketplace update`.
- If other plugins also had unreleased changes (Phase 0), offer to release them next.

</process>

<success_criteria>
See SKILL.md `<success_criteria>` — all boxes checked before declaring the release done.
</success_criteria>
