# Reference: Pre-release docs staleness checks

<overview>
A release publishes the plugin's docs as its description of itself, so the docs must be verifiably
honest about the package's current contents. These checks are deliberately **cheap and mechanical**
— greps and directory comparisons an LLM runs in minutes, every release. Deep contract-vs-runtime
conformance (live conversations, subagent audits) is a separate, occasional exercise; do NOT fold it
in here.

Each check lists what to compare and what a finding means. Findings are classified in the workflow
(fix-now / block / defer). Every check is bidirectional where applicable: documented-but-missing AND
existing-but-undocumented are both findings.
</overview>

<check name="A_index_vs_directory">
## A. Index ↔ directory cross-checks

Skill docs carry inventories that drift when files are added without updating the prose. Compare
each inventory against the actual directory listing, both directions:

1. **Every `SKILL.md` in the plugin** — `templates_index`, `reference_index`, `workflows_index`
   sections vs the real contents of `templates/`, `references/`, `workflows/`.
2. **agent-step-toolkit only:** `skills/bump-version/references/tracked-assets.md` — every tier's
   file list vs the real tree (Tier 1 vs `templates/agent-step/*`, Tier 2 vs
   `templates/*.template`, Tier 3 vs `templates/project/*`, Tier 4 vs `references/*.md`,
   Tier 5 vs `workflows/*.md`). This file declares itself "the single place that knows what mirrors
   the library" — hold it to that.
3. **agent-step-toolkit only:** the bootstrap workflow's library copy list
   (`workflows/bootstrap-project.md`) vs `templates/agent-step/*`.
4. **Root `README.md`** — the per-plugin skill listings and layout tree vs the actual
   `plugins/*/skills/` directories.

```bash
# example: extract names from an index section, then diff against ls
ls plugins/<plugin>/skills/<skill>/templates/
grep -o '`[a-z0-9-]*\.\(template\|md\|ts\)`' plugins/<plugin>/skills/<skill>/SKILL.md | sort -u
```
</check>

<check name="B_claims">
## B. Claim checks (counts, versions, "currently …")

Prose that states a quantity or version goes stale silently. Find and re-derive:

```bash
grep -rn "currently [0-9]\+\|all [0-9]\+ tests\|[0-9]\+ tests pass" --include='*.md' plugins/<plugin>/skills/
grep -rn "version [0-9]\+\.[0-9]\+\|v[0-9]\+\.[0-9]\+\.[0-9]\+" --include='*.md' plugins/<plugin>/skills/ | grep -v CHANGELOG
```

- Test counts: re-derive from the source (`grep -o "test(" <file> | wc -l` per test file) and
  correct, or rephrase to avoid a hard count.
- Version strings in skill prose: must match the current library `VERSION` / plugin version, or be
  phrased version-agnostically. (CHANGELOG and migration files legitimately contain old versions —
  exclude them.)
</check>

<check name="C_dangling_terms">
## C. Dangling-term grep

Identifiers mentioned in docs that don't exist in the source they describe — the class of error
where a rename leaves stale references behind (e.g. a doc naming an action `cancel_pending_confirmation`
when the source defines `abort_pending_input`).

1. Extract candidate identifiers from the plugin's references/workflows: backticked snake_case and
   camelCase terms (`grep -o '\`[a-z][a-z0-9_]*\`'`, `grep -o '\`[a-z][a-zA-Z0-9]*\`'`), action
   names, exported symbols, error codes, template file names.
2. For each, confirm it exists where the doc implies it lives — the library source
   (`templates/agent-step/*.ts`), the templates tree, or the skill's own files.
3. A term that exists nowhere is a finding: either the doc is stale (rename happened) or the term is
   illustrative — if illustrative, it should read as such in context.

Prioritize: error codes, reserved action names, exported types/functions, state slot names. Skip
obvious placeholders (`{{LIKE_THIS}}`, `<like-this>`).
</check>

<check name="D_cross_doc_consistency">
## D. Cross-doc consistency

The same fact stated in two places must agree. Known multi-source facts in this repo:

- Reserved action name(s) — library source vs `agent-step-api.md` vs SKILL.md quick references.
- Inert/forward-compat fields (e.g. `ConfirmationOpts.ttlMs`) — type doc-comment vs
  `agent-step-api.md` vs runner defaults.
- The semver rules — PLUGIN_CHANGELOG header vs CHANGELOG header vs any SKILL prose quoting them.
- Which copy of the library is canonical — bump-version SKILL prose vs root README.

When two sources disagree and the source of truth is clear, fix the other; when it isn't clear,
**block** and ask.
</check>

<classification>
## Fix-now vs block vs defer

- **Fix now** (rides in the release commit, joins the changelog entry): wrong inventory lists,
  wrong counts, stale identifiers with an unambiguous correct value, missing index entries.
- **Block** (stop the release): a doc asserts contract/behavior that contradicts the source and the
  correct resolution requires a decision (e.g. is the doc wrong or is the code?).
- **Defer** (list in the proposal; user opts in): cosmetic wording, improvements that are new
  content rather than corrections, anything needing a deep audit.
</classification>
