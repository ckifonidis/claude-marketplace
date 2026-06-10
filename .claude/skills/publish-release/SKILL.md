---
name: publish-release
description: Cut a release of a plugin in this marketplace (agent-step-toolkit, langgraph-plugin, or any future plugin). Detects unreleased changes since the last release commit, sweeps the plugin's docs for staleness BEFORE bumping anything, gates on /bump-version when the embedded agent-step library changed without a library version bump, classifies the plugin semver bump, syncs plugin.json + the marketplace.json entry, writes the PLUGIN_CHANGELOG entry, and lands the conventional "Release <plugin> X.Y.Z" commit. Use when the user wants to release, publish, ship, or version-bump a plugin, or asks why installed plugins don't show recent changes.
---

<objective>
Publish a plugin-package release for this marketplace repo. The deliverable is one release commit on `main` that moves the plugin's version everywhere it lives (plugin.json + marketplace.json), documents the delta (PLUGIN_CHANGELOG), and ships docs that are verifiably honest about the package's current contents.

This skill owns the **plugin package** lifecycle only. The **agent-step library** lifecycle (library `VERSION`, `CHANGELOG.md`, `migrations/`) belongs to `/bump-version` — this skill gates on it, never duplicates it.
</objective>

<essential_principles>
**1. Plugin release ≠ library bump.** `/bump-version` owns `skills/create-tool/templates/agent-step/VERSION`, `CHANGELOG.md`, and `migrations/`. If the embedded library changed since the last release but its `VERSION` did not move, HALT and direct the user to run `/bump-version` first. Never write library version artifacts from this skill.

**2. Docs are part of the release.** Run the staleness sweep (`references/staleness-checks.md`) BEFORE bumping any version. A release publishes the docs as the package's description of itself; shipping a release whose own inventory files are wrong defeats the point. Fixes found by the sweep ride in the same release commit.

**3. Two manifests, one version.** The plugin's version lives in BOTH `plugins/<plugin>/.claude-plugin/plugin.json` and the plugin's entry in `.claude-plugin/marketplace.json`. They must move together, to the same value. When the release changes the plugin's capability set (new skill/workflow/pattern), refresh the marketplace entry's `description` too — it is the storefront text.

**4. Every shipped change rides a version.** Files under `plugins/` changed on `main` without a version bump never reach installed plugin caches (`/plugin marketplace update` only refreshes on a version change). Unreleased changes sitting on `main` are exactly what this skill exists to sweep up.

**5. Semver from the plugin rule** (recorded in PLUGIN_CHANGELOG header): **major** = removed/renamed skill or breaking workflow change; **minor** = new skill / capability / template; **patch** = doc or fix with no new surface.

**6. Approval gate before any edit.** Propose the release first — version, changelog entry draft, staleness findings, push mode — and wait for explicit go-ahead. The proposal is the cheap review surface.
</essential_principles>

<intake>
Determine the target plugin:
- If the user named one, use it.
- Otherwise detect which plugin(s) have unreleased changes (Phase 0 of the workflow) and confirm. If several have changes, ask which to release (or release them sequentially — one release commit per plugin).
</intake>

<routing>
Follow `workflows/publish-release.md` exactly — phases 0–6 with a hard approval gate after Phase 4. Do not edit any file before approval.
</routing>

<quick_reference>
**Release commit convention** (matches repo history):
```
Release <plugin> X.Y.Z                      # plain plugin release
Release <plugin> X.Y.Z (ships agent-step library A.B.C)   # when a library bump rides along
```
Body: short narrative + bullet list of manifest/changelog edits and the headline changes.

**Version locations:**
| File | Field |
|---|---|
| `plugins/<plugin>/.claude-plugin/plugin.json` | `version` (+ `description` if capabilities changed) |
| `.claude-plugin/marketplace.json` | the plugin's entry: `version` (+ `description`) |
| `plugins/<plugin>/PLUGIN_CHANGELOG.md` | new top entry (create the file if the plugin lacks one — copy the header conventions from agent-step-toolkit's) |

**Out of scope:** the marketplace `metadata.version` in `marketplace.json` (left alone unless the marketplace itself restructures); the agent-step library artifacts (see principle 1); deep contract-vs-runtime conformance audits (an occasional, separate exercise — the staleness sweep is the cheap, every-release subset).
</quick_reference>

<reference_index>
- **references/staleness-checks.md** — the pre-release docs-honesty checklist: index↔directory cross-checks, claim checks (counts/versions), dangling-term grep, cross-doc consistency. What blocks vs what gets fixed in-release.
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| workflows/publish-release.md | Detect unreleased changes → staleness sweep → library gate → classify + draft → propose (gate) → apply + commit + push → verify. |
</workflows_index>

<success_criteria>
- [ ] Staleness sweep ran; every finding either fixed in this release or explicitly deferred with the user's consent.
- [ ] If `templates/agent-step/*` changed: library `VERSION` moved, CHANGELOG + migration exist (else the release was halted for `/bump-version`).
- [ ] `plugin.json` and the `marketplace.json` entry hold the SAME new version; descriptions refreshed if the capability set changed.
- [ ] PLUGIN_CHANGELOG has a new top entry naming the version, date, and (for agent-step-toolkit) which library version ships.
- [ ] One release commit with the conventional message; remote `main` verified to be at that commit (or PR opened, per the chosen mode).
- [ ] User reminded that installed plugins pick this up via `/plugin marketplace update`.
</success_criteria>
