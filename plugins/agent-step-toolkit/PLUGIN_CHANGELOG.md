# agent-step-toolkit plugin changelog

Version history for the **plugin package** (`.claude-plugin/plugin.json` + the marketplace entry) —
the skills, templates, references, and workflows the plugin ships.

This is distinct from [`CHANGELOG.md`](CHANGELOG.md), which tracks only the **vendored agent-step
runner library** version (`skills/create-tool/templates/agent-step/VERSION`, bumped by `/bump-version`).
A plugin release may or may not include a library bump.

Format follows [Keep a Changelog](https://keepachangelog.com/); newest first. Semver on the plugin:
**major** = removed/renamed skill or breaking workflow change, **minor** = new skill / capability /
template, **patch** = doc or fix with no new surface.

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
