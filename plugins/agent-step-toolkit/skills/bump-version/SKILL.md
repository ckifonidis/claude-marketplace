---
name: bump-version
description: Refresh the toolkit's embedded agent-step runner library from a newer source (a local path, a git repo + ref, or a git ref in a local repo), then propagate the change. Diffs the new runner against the embedded copy, evaluates the change (additive/breaking/internal) and picks a semver bump, updates every tracked plugin asset that mirrors the library contract (templates, references, workflows, SKILL prose), bumps the library VERSION, appends a CHANGELOG entry, and writes a version-keyed migration guide (prose + machine-actionable transforms) that /pull-library applies to downstream projects. Use when a new version of the agent-step runner exists and the toolkit should adopt it.
---

<objective>
This skill is the **maintainer side** of agent-step library versioning. The toolkit ships a vendored
copy of the runner library at `skills/create-tool/templates/agent-step/` plus a layer of dependent
assets that encode its contract. When a newer runner exists somewhere, this skill absorbs it: refresh
the copy, propagate the contract change across every dependent asset, version it, and record how
downstream projects should upgrade.

The complement is `/pull-library`, which runs INSIDE a downstream project to pull the refreshed
library out of the (updated) plugin and adapt that project's own tools. This skill writes the
migration guide that `/pull-library` consumes — so the migration's `<transforms>` section is a
deliverable, not an afterthought.

The skill is generic (works for any future bump). Its evaluation discovers what changed; it does not
hard-code any particular library version's shape.
</objective>

<essential_principles>
**1. The embedded copy is the source of truth.** `skills/create-tool/templates/agent-step/` is what
new projects bootstrap from AND what `/pull-library` upgrades to. Replacing it is the core of the
bump; everything else (refs, templates, prose) exists to keep the toolkit's *instructions* honest
about the new contract.

**2. Library version ≠ plugin version.** Bump only the library `VERSION` marker
(`skills/create-tool/templates/agent-step/VERSION`). Never touch `.claude-plugin/plugin.json`.

**3. Verbatim copy, hand-merged contract.** When absorbing an external source, Tier-1 library files
are replaced byte-for-byte — never hand-merged with local edits. Every OTHER tracked asset is
hand-updated to match the new contract. The two are different operations; don't blur them.
(The embedded copy is itself the canonical source; a release may instead be authored directly in it
— e.g. doc-comment corrections — with no external source to copy from. The same version bookkeeping
applies either way: bump `VERSION`, write the CHANGELOG entry and the migration file.)

**4. Evaluate before you touch anything.** Classify the diff (additive / breaking / internal),
pick the semver bump from the PUBLIC surface (`index.ts` exports + `types.ts` signatures +
`buildAgentStepTool` options), and compute the blast radius from `references/tracked-assets.md`
BEFORE editing. Surface it for approval — this is the cheap review surface.

**5. The migration guide is machine-actionable.** For any breaking or contract-changing release,
the `migrations/<from>-to-<to>.md` file MUST carry a `<transforms>` section of ordered, specific
edit rules `/pull-library` can apply to a consumer's tools — not just prose. See
`migrations/README.md` for the format.

**6. Verify by instantiation.** The templates aren't a standalone TS project. Prove the bump by
bootstrapping a throwaway project from the updated templates and running typecheck + the vendored
runner tests. The source library is known-good; this catches drift in the hand-edited assets.
</essential_principles>

<intake>
**Resolve the library source from the user's reference.** Accept any of:

1. **Local filesystem path** — to a project root (auto-find `src/agent-step/` under it) or directly
   to an `agent-step/` directory. The primary case (e.g. `../../../agents/personalized-info-agents-ts`).
2. **Git repo URL + ref** — `<url>` plus an optional branch/tag/commit. Shallow-clone to a temp dir,
   then locate `src/agent-step/`.
3. **Git ref in a local repo** — a tag/commit/branch of an already-local repo. Materialise that ref
   (temp worktree or `git archive`) and locate `src/agent-step/`.

**If the reference is ambiguous or missing,** ask for it before proceeding. Otherwise go straight to
the workflow.
</intake>

<routing>
Follow `workflows/bump-version.md` exactly — the 5 phases (resolve & stage → diff & evaluate →
propose → apply → verify). It has a hard approval gate after Phase 3; do not edit toolkit files
before approval.
</routing>

<quick_reference>
**What the bump produces:**
- `skills/create-tool/templates/agent-step/*` refreshed verbatim + new `VERSION`.
- Every affected tracked asset (see `references/tracked-assets.md`) hand-updated.
- `CHANGELOG.md` (plugin root) — new entry prepended.
- `migrations/<from>-to-<to>.md` (plugin root) — prose + `<transforms>`.

**Semver rule (from the public surface):**
- **major** — removed/renamed export, changed signature, new required `buildAgentStepTool` arg.
- **minor** — additive export / optional arg, no break.
- **patch** — internal-only (runner.ts behaviour, comments, tests) with no surface change.

**Blast-radius map:** `references/tracked-assets.md` — the 6 tiers and what kind of change touches each.

**Migration file format:** `migrations/README.md` — prose + `<transforms>` contract with `/pull-library`.
</quick_reference>

<reference_index>
- **references/tracked-assets.md** — the inventory of plugin assets that mirror the library contract, by tier, with "what touches it." The blast-radius map for Phase 2 and the edit list for Phase 4.
- **../../migrations/README.md** — the migration file format (prose + `<transforms>`) this skill writes.
- **../create-tool/references/agent-step-api.md** — the current written contract; the highest-fidelity Tier-4 asset to reconcile.
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| workflows/bump-version.md | Resolve & stage the source → diff & evaluate → propose (gate) → apply → verify by instantiation. |
</workflows_index>

<success_criteria>
- [ ] `templates/agent-step/*` match the new source byte-for-byte; `VERSION` holds the new version.
- [ ] Every asset named in the approved blast radius is updated; no Tier-4 reference still describes the old contract.
- [ ] `templates/project/package.json.template` deps match the source project's `package.json`.
- [ ] `CHANGELOG.md` has a new top entry (version, date, Added/Changed/Breaking, migration link).
- [ ] `migrations/<from>-to-<to>.md` exists with prose + a `<transforms>` section (for breaking/contract changes).
- [ ] A throwaway bootstrap from the updated templates passes `npm install`, `npm run typecheck`, and the vendored `runner.test.ts`.
- [ ] `.claude-plugin/plugin.json` is untouched.
</success_criteria>
