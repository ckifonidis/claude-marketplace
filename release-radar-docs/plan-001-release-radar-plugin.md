# Plan 001 — `release-radar` plugin (engine + three skills)

## Provenance
- **Specification (authoritative):** `release-radar-docs/refined-request-release-radar-plugin.md` (REFINED_REQUEST_FILE)
- **Investigation:** skipped — the approach was chosen by the user in conversation (TypeScript engine + adapters, three skills).
- **Technical research:**
  - `release-radar-docs/research/claude-code-plugin-runtime.md`
  - `release-radar-docs/research/azure-devops-pipelines-rest.md`
  - `release-radar-docs/research/deployment-source-clis.md`
  - `release-radar-docs/research/image-reference-parsing.md`
- **Codebase scan:** `release-radar-docs/codebase-scan-release-radar-plugin.md` (scanned at `dc60ec7`)
- **Parity reference:** the private source engine, its tests and the source skill (locations supplied by the
  orchestrating conversation, deliberately not recorded here — spec Assumption 7).

## 1. Decisions taken after the specification

The spec's Open Questions and the research findings are resolved as follows. Requirement numbers are the spec's.

| # | Decision | Source |
|---|---|---|
| D1 | Checklists are **structured Markdown** with the requirement-80 grammar (Open Question 6 confirmed). | user, 2026-11-25 |
| D2 | `promote`'s remote-head check reads the ref through the **Azure DevOps Git Refs REST API** with the same PAT. Requirement 70's documented PAT scopes gain **Code (Read)**; `git ls-remote` is not used. | user, 2026-11-25 |
| D3 | Real-world verification on a stage the operator's team does NOT own: **HTTP and version checks only**. Smoke commands run only on stages owned by `operatorTeam` — no per-run override (narrows Open Question 5's recommendation). | user, 2026-11-25 |
| D4 | Landed proof **polls**: after a succeeded run, `promote` re-reads the target every `followPollSeconds` until it runs the expected version or the required per-mapping `landedWaitMinutes` window ends, then runs verification once (Open Question 4's recommendation; the user asked for polling). Window expiry = "not landed" (pipeline/target drift), not a run failure. | user, 2026-11-25 |
| D5 | **Exit 30 = verification inconclusive** (≥1 UNREACHABLE, no FAIL). Precedence: 64 > 24 > 29 > 20 > 26 > 27 > 21 > 25 > 23 > 28 > 30 > 22 (Open Questions 2, 3). | adopted default |
| D6 | Non-`format` commands **refuse non-canonical input with exit 29** (Open Question 7). | adopted default |
| D7 | **Deviation from requirement 66:** Azure DevOps exposes no read call returning a pipeline's declared parameters (Pipelines Get returns `id, name, folder, revision, url, configuration.type` only; the only server-side check, `previewRun`, is a POST needing execute scope). `pipeline-preview` therefore validates parameters **locally against the config's template and declared actions** and uses Pipelines Get only to prove the pipeline exists (exit 23) and show its name. No `--remote-validate` in v1, so acceptance criterion 7(a) stays strict ("only `run-pipeline` issues a non-GET"). | research §3.1 |
| D8 | Run **facts** come from the **Build API list** (`sourceVersion`, `templateParameters`, times in one call); **queueing** uses the **Runs API** with `resources.repositories.self.{refName,version}` pinning, and the engine checks the echoed `version` equals the previewed SHA (loud report if not). The result of record while following comes from Build `GET builds/{id}` (it carries `partiallySucceeded`); any terminal result other than `succeeded` → exit 25. | research §3.3–3.5 |
| D9 | The queue POST is **never retried**. A timeout on it is "unknown outcome": the engine lists runs read-only to detect whether the run was created and reports that, never re-POSTs. Reads honour `Retry-After` and get at most one bounded retry on 429. | research §3.10 |
| D10 | Pushed image tag is determined only from the run's `templateParameters` (the mapping declares which parameter carries it) or from the stage tag convention when the mapping states the pipeline follows it; otherwise `undetermined`. No log parsing in v1. | research §3.7 |
| D11 | Skills invoke the engine through the literal `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js"` **in the SKILL.md body only** (substituted at load; not a shell variable). References/workflows point back to it. A sentinel tells the model to stop on an unsubstituted `${`. Fallback form `${CLAUDE_SKILL_DIR}/../../engine/dist/cli.js` documented. The engine gains a read-only `where` command (prints its own root from `import.meta.url`). No `bin/` launcher (not installed on claude.ai/Cowork). | research (plugin runtime) |
| D12 | `allowed-tools` pre-allows only read-only engine subcommands, one rule each; `run-pipeline` and `format` are never pre-allowed (the permission prompt is a second gate). Validated by the probe (Phase 0). | research (plugin runtime) |
| D13 | Trailer line name: `RELEASE_RADAR_RESULT=<OK|FAIL> PHASE=<phase> EXIT=<code>` on every run (requirement 22). | design |
| D14 | Engine-local `plugins/release-radar/engine/.gitignore` containing `node_modules/` (the marketplace has no `.gitignore`; scan §5). **Needs the user's nod** — it is outside the approved layout. | scan |
| D15 | `$ARGUMENTS` is referenced in skill prose only, never spliced into a shell line; the engine validates names exactly (exit 64). | research |
| D16 | Image references: lenient-case parsing with `nonCanonical` flag; only `sha256` digests are comparable; `sameBuild` = proven/different/unproven; display prints `raw`, never the `library/`-normalised form. | research (image parsing) |
| D17 | **Two-level config (spec 31, 31a–31h):** `.release-radar/workspace.json` in the orchestration repo (lifecycle, `operatorTeam`, Azure DevOps, retention, fleet checklist, explicit `members` with `repoKey`) and `.release-radar/component.json` **only** in each component's own repo. Members are located **only** through the repos file — no directory scanning, so worktree copies are never read. Missing clone/config → `unavailable`, never substituted. | user, 2026-11-25 |
| D18 | `component.json` revision: working tree for `status`; at the promoted commit (`git show`) for `change-risk` and `promote`; differences reported (spec 31d). | spec |
| D19 | **Per-user workspace index** under `${CLAUDE_PLUGIN_DATA}`, passed by the skill as `--index <path>`; engine command `workspace-index list|register|unregister|resolve`; register/unregister only after confirmation (spec 31f, 31g). | user + probe |
| D20 | Re-formatting a non-canonical file inside a **member repo** asks once per run (the user manages that repo's git); workspace-repo and engine-owned files are re-formatted automatically (spec 83a). `--config` is rejected (64) in favour of `--workspace`. | spec |
| D22 | **Monorepos allowed:** several members may share one `repoKey` with different `repoSubdir`s (each with its own `component.json`); only the same repoKey + same normalised subdir is invalid. Motivated by a repository building several deployables (e.g. a proxy and a core service, or several flavours of one agent). | user, 2026-11-25 |
| D23 | Phase 2 resolutions adopted: required `gitTimeoutSeconds` in the workspace (no default exists); `git-tag` resolves exactly `<prefix><tag>` (no `v` guessing; mixed schemes use the `regex` convention); smoke checks on a non-owned stage are valid config reported "not run (stage not owned)"; per-check `target` narrows verification; `src/files.ts` added as the single read funnel (observable in tests). | Phase 2 |
| D24 | Phase 3 resolutions adopted: App Service refuses (21) only when a **requested** webapp name exists in two subscriptions of one stage (narrower than the source engine, which refused the whole stage — an unrelated duplicate no longer blocks a report; discover lists both, flagged ambiguous); optional `adapters.command.discoverArgv`; `az` runs with `AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no` so it can never self-install an extension (a write); the `command` adapter passes the environment through unchanged; shared `src/json-path.ts` (`$`, `.key`, `[n]`) reused by verification. | Phase 3 |
| D25 | Phase 5 resolutions adopted: fifth check outcome **INCONCLUSIVE** (the app answered with a version but the expected version is unknown — missing target, unresolved commit, digest-pinned image, or stage targets disagree for a target-less check); it counts toward exit 30, never 28. `verify` requires `--stage`; `--check <names>` is how an "explicit request" is expressed (naming a smoke check on a non-owned stage → 26 before any request); redirects are never followed (3xx is just a status); a version endpoint that answers without a usable version is FAIL; empty/control-character header values count as missing (20); `verify` writes no snapshot (`status --verify` does); `src/observe.ts` holds the shared preflight/read/resolve path. | Phase 5 |
| D26 | Phase 6 resolutions adopted: all reads use the Build API (incl. the result of record); optional mapping keys `imageTagParameter` (names a declared parameter) and `pushedTagTemplate` (closed placeholders `{commit.sha}`, `{commit.shortSha}`, `{component}`, `{target}`; a string, not a boolean, so nothing is guessed); a run's action = the single declared action whose fixed parameters all match; drift counts only finished, exactly-succeeded, identified **build**-kind runs; `pipeline-run` exits 0 with phase `still-running` / `waiting` / `in-progress` (never 25) and 25 only for a finished non-`succeeded` run; `pipelineName` matching several pipelines → 21; PAT/expiry checks precede adapter preflight; test environments strip `AZURE_DEVOPS_EXT_PAT`/`_EXPIRES` so a real PAT can never reach the engine under test. **Unconfirmed API assumptions → sandbox checklist before first real use:** build definition id = pipeline id; approval id = timeline record id. | Phase 6 |
| D27 | Phase 7 resolutions adopted. **Commit to build** = the remote head of the mapping's ref (Git Refs), pinned through the Runs API `version`; preview blocked (26, no token) if the local clone lacks that commit or `component.json` at that commit carries a different mapping; local unpushed commits shown "not buildable". **Optional mapping key `repository`** (Azure Repos repo for the ref check; else Pipelines Get `configuration.repository` when Azure Repos Git — unconfirmed field; neither / GitHub → 26). `{image.repository}` in a template, or `{image.tag}` without `pushedTagTemplate`, → 26. **Token** `rr1.` + base64url `{commit, digest, expiresAt, v:1}`, digest = canonicalHash of the binding (organizationUrl, project, pipelineId, pipelineName, repository, ref, commit, component, stage, target, action, actionKind, every parameter value, selections, engineVersion) + expiresAt — a commitment, not an authenticator (the human confirmation authenticates); a TTL claim beyond `confirmTokenTtlMinutes`+60 s → 27. **Pin mismatch** → exit 21 (phase `pin-mismatch`), never reported as success. **Unknown outcome** (timeout/reset/5xx/2xx without run id) → builds listed before and after, any new run reported, exit 21, never re-POSTed. **Deviation from requirement 20's precedence:** triggerability/mapping/action refusals (26) are decided from config BEFORE the PAT check (20) — a refusal needs no credential and both send nothing. Boundary: `"POST"` only in `azure-devops-write.js`, imported only by `run-pipeline.js`, which `cli.js` loads by dynamic `import()` for that command alone (statically tested). No hidden clock hook. | Phase 7 |
| D28 | Phase 8 resolutions adopted: `settings-diff --from <stage|local|sha> --to <stage|sha>` (direction of promotion; both required; a stage = the one commit all its targets run; `local` = clone HEAD, `--from` only; settings files listed from `component.json` at the promoted commit); `handoff-package --commit` required and checked against the upstream stage's live commit; a missing settings path or unknown upstream image → package still written with `complete: false` + `blocking[]`, **exit 23** (never 0 for an incomplete package); non-handoff stage → 26 from config before any adapter call; `handoffRetention` counted per (component, stage); retention never deletes invalid files; orphans → `.release-radar/quarantine/<run stamp>/…`; member-repo files rewritten only with `--include-members` (else 29 with that hint; a single-repo project counts as workspace); secret-reference detectors (Azure Key Vault reference/URI, CI `${{ secrets.X }}`, AWS Secrets Manager/SSM SecureString, GCP Secret Manager, HashiCorp Vault) and a conservative literal-secret heuristic reporting key names only. | Phase 8 |
| D21 | Open Question 1 closed by the Phase 0 probe (`design.md`): the engine invocation lives literally in each SKILL.md body; `allowed-tools` with `${CLAUDE_PLUGIN_ROOT}` is expanded and enforced. | probe |

## 2. Architecture (engine)

```
cli.ts ──► commands (status, verify, discover, validate-config, format, settings-diff,
           pipeline-runs, pipeline-run, pipeline-preview, run-pipeline, handoff-package, where)
  │
  ├─ format.ts      canonical JSON renderer + schema descriptors (key order, array sort keys),
  │                 file classification (canonical / non-canonical / invalid), cleanup, quarantine
  ├─ checklist.ts   Markdown checklist grammar: parse → model → canonical render
  ├─ config.ts      schema for config.json (lifecycle, mappings, artefacts, verification) on top of format.ts;
  │                 strict validators; JSON-pointer locations; exit 24
  ├─ repo-paths.ts  repos.local.json (owned) / external repos file (validated, never rewritten)
  ├─ image.ts       reference parser + sameBuild
  ├─ git.ts         tag→commit per convention, HEAD relation, stage ranges, ancestry, `git show` reads
  ├─ adapters/      types.ts (preflight/read, AuthError/SourceError, stderr-pattern table, spawn helper),
  │                 azure-appservice, azure-containerapp, kubernetes, compose, command
  ├─ pipelines/     types.ts, azure-devops.ts (reads module + write module imported only by run-pipeline)
  ├─ lifecycle.ts   triggerability, deltas per neighbouring pair, consistency, drift, preview + token
  ├─ verify.ts      HTTP / version / smoke checks → PASS / FAIL / UNREACHABLE
  ├─ settings-diff.ts  key-level JSON diff, secret-reference names, never values
  ├─ handoff.ts     package writer (manifest + verbatim copies + sha256)
  ├─ snapshot.ts    canonical snapshot + config fingerprint (over canonical form) + retention
  └─ report.ts      human table / fleet table / --json (schemaVersion, additive), trailer
```

Exit-code precedence is enforced in one place (`cli.ts` phase runner). Every module throws typed errors carrying the exit code and a location.

## 3. Phases

Each phase ends with `npm --prefix plugins/release-radar/engine test` green and `tsc --noEmit` clean. Tests live in `engine/test/` (deliberate exception to `test_scripts/`, spec Constraints).

### Phase 0 — Scaffold, vetting, runtime probe
- `plugins/release-radar/` tree per spec "In scope"; `plugin.json` (0.1.0); `engine/{VERSION 0.1.0, package.json (type module, engines node>=20, devDeps only, scripts build/test/check), tsconfig.json (strict, ES2022, NodeNext), .gitignore (D14)}`.
- Dependency vetting (global rule): `npm view typescript versions`, `npm view @types/node versions`; check advisories; pin caret to verified versions; `npm install`; `npm audit` = 0; log the date in `release-radar-docs/dependency-vetting-log.md`.
- **Probe** (research §4): a throw-away `skills/probe/SKILL.md` in a scratch copy outside the repo, run non-interactively with `claude -p --plugin-dir <scratch>`; record whether `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_SKILL_DIR}` are substituted in the body and in `allowed-tools`, and positional splitting. Result recorded in `release-radar-docs/design.md`; the probe skill is never shipped.

### Phase 1 — Canonical-file core (foundation for everything)
- `format.ts`: schema descriptor DSL (object key order, required/optional, enums, closed sets, array kind `sorted(by)` / `ordered`, dedupe of byte-identical entries), canonical renderer (2-space, LF, trailing newline), comment detection → invalid with location, `schemaVersion` gate, classification + change summary.
- `checklist.ts`: grammar of requirement 80 (header, `schemaVersion`, `## <id>`, five fields in order, continuation indent), parse with line/column errors, canonical render, layer check.
- Tests: requirement 86 round-trips, hand-edited fixtures → exact bytes, invalid fixtures → 24 + location, determinism.

### Phase 2 — Workspace, components, repos, index, image, git (port + generalise)
- `config.ts` on the Phase 1 DSL, two schemas (D17): **workspace** (stages/tag conventions/promotion/`operatorTeam`/`members`/`azureDevOps`/retention/freshness/fleet checklist/`beforePromote`/repos-file location/adapter settings) and **component** (name, per-stage targets with explicit null = not deployed, tag overrides, mappings with closed-set placeholders, actions with `kind`, `primaryAction`, `userSelectable` closed lists, `landedWaitMinutes`, handoff artefacts, verification blocks). A loader that resolves members through the repos file and reads each `component.json` from the working tree or at a commit (D18), with the 31c rules (unavailable vs invalid) and every requirement-37 rule.
- `repo-paths.ts` (port; owned vs external repos file), `workspace-index.ts` (D19: canonical index file, list/register/unregister/resolve cwd → workspace + component), `image.ts` (research parser; parity with the source's 9 parse tests), `git.ts` (port of `resolveDeployedCommit` generalised to the four conventions + override; configurable timeout; stage ranges + ancestry verdicts; `git show <sha>:<path>` reads).
- Tests: source parse/config/git groups re-expressed synthetically (scan §6.3 mapping), every requirement-37 rule naming the key, and requirement 76a (member resolution, worktree-like sibling never read, working-tree vs commit `component.json`, index register/resolve/stale/multiple match, single-repo project).

### Phase 3 — Adapters
- `adapters/types.ts`: interface, spawn helper (argv, no shell, timeout, ENOENT → 20), shared stderr-pattern table.
- `azure-appservice` (port: one list per subscription, two-subscription ambiguity refusal, stopped, non-container, `config show` single-target fallback read only when `linuxFxVersion` is null), `azure-containerapp`, `kubernetes`, `compose`, `command` (argv + JSON path/regex + optional preflight).
- Fake shims (`#!${process.execPath}` scripts on PATH, scenario via env, argv logged) for `az`, `kubectl`, `docker`, an arbitrary command; scenarios ok / cli-missing / not-logged-in / absent / other-error / timeout; assert read-only argv from the log.
- `references/adapters.md` fixture provenance table (requirement 30).

### Phase 4 — Status, lifecycle, report, snapshots, discover, validate-config
- `lifecycle.ts` (triggerability, consistency, cross-stage `sameBuild`, deltas incl. inconsistent stages), `report.ts` (component report, fleet table, `--json` with `schemaVersion`, trailer), `snapshot.ts` (written on 0/22/23/28/30; fingerprint over canonical config; retention).
- Commands `status` (`--all`, `--stage`, `--json`, `--no-pipelines`, `--fail-on-drift[ a:b]`), `discover`, `validate-config` (prints every configured command), `where`.
- Tests: the source report-integration group (scan §6.3) + new areas of requirement 76.

### Phase 5 — Real-world verification
- `verify.ts`: HTTP GET/HEAD checks with env-var headers (missing var → 20 before any check), version check (JSON path/regex, commit prefix ≥ 7 / tag equality), smoke argv (own stages only, D3); PASS/FAIL/UNREACHABLE; exit 28/30; nothing but status/exit/latency/extracted value recorded.
- Fake HTTP application server (counts methods; asserts no non-GET/HEAD).
- Commands `verify`, `status --verify`.

### Phase 6 — Azure DevOps reads and drift
- `pipelines/azure-devops.ts` read module: auth classification (research §3.9), Build list facts, run get, Pipelines Get (existence), timeline + approvals for waits, Git Refs head (D2), `Retry-After`, PAT + `AZURE_DEVOPS_PAT_EXPIRES` handling.
- `pipeline-runs`, `pipeline-run [--follow]`, pipeline sections in `status`, pipeline/target drift (ancestry-based), pushed-tag determination (D10).
- Fake REST server (all research §5 modes; counts non-GET).

### Phase 7 — Preview, token, the one write
- `pipeline-preview`: local parameter resolution (D7), commit to build, remote-ref presence (D2), token = HMAC/sha256 over the recursive-canonical request + expiry.
- Separate write module imported only by `run-pipeline`: re-resolve, verify token (27), triggerability (26), ref-moved check (27), single POST, echo check (D8), never retry (D9), `--follow`.
- Tests: acceptance criteria 6 and 7 in full (zero POSTs on every refusal; exactly one POST with exact parameters; config-kind action; partiallySucceeded/failed/canceled → 25; follow timeout = still running; approval wait).

### Phase 8 — Settings diff, handoff package, format command complete
- `settings-diff.ts` (added/removed/renamed/changed-keys-without-values, secret-reference names, unparseable summary).
- `handoff.ts` (`.release-radar/handoff/<component>-<stage>-<timestamp>/`, verbatim copies via `git show`, manifest with sha256 + source commit, canonical manifest).
- `format` / `format --check` over every file type, cleanup (dedupe, retention pruning, quarantine of orphans), never-rewrite list (verbatim copies checked against manifest hashes, external repos file, commit-pinned checklists).
- Tests: requirement 86 cleanup/never-rewrite items, secrets never in output.

### Phase 9 — Skills and references
- `deployment-status/SKILL.md` (+ `init-config` workflow, references config-schema, exit-codes, adapters, verification, file-formats), `change-risk/SKILL.md` (+ generic-checks, stack-signals, checklist-format), `promote/SKILL.md` (+ safety-gates, lifecycle-model, handoff-package, workflows run-pipeline / assemble-handoff).
- Every SKILL.md: frontmatter with trigger phrases, invocation shapes + namespaced forms (requirement 7), the canonical-file gate as first engine step (requirement 83), names-only rule, engine invocation block (D11), `allowed-tools` per D12.

### Phase 10 — Marketplace integration and documentation
- `marketplace.json` entry, README section + Layout tree, `PLUGIN_CHANGELOG.md`, `CHANGELOG.md`.
- `release-radar-docs/`: `design.md` (architecture, decisions D1–D16, probe result), `functions.md` (feature register), `follow-ups.md` (requirement 6 `/publish-release` gate item; real-CLI fixture capture; sandbox checklist from research §6 before the first real `promote`), `pending-items.md`, `worked-examples.md` (acceptance criterion 24, produced by actually running the engine against the fakes), dependency-vetting log.
- Final gates: clean rebuild leaves `dist/` unchanged; `npm audit` 0; full suite offline; private-denylist scan (denylist kept outside the public repo) = 0 matches; no absolute local paths.

## 4. Files to modify (scan §4.2) and create (scan §4.3)
- **Modify:** `.claude-plugin/marketplace.json` (append entry), `README.md` (section + Layout tree).
- **Create:** everything under `plugins/release-radar/` per spec "In scope" + D14; docs under `release-radar-docs/`.
- **Untouched (scan §4.4):** other plugins, `.claude/skills/bump-version`, `.claude/skills/publish-release`, the `.agents/` mirror, the source project.

## 5. Risks
| Risk | Mitigation |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` not substituted in a marketplace install | Phase 0 probe; `CLAUDE_SKILL_DIR` fallback; sentinel stop |
| Runs API pinning semantics undocumented | echo check after queue (D8); refs check before queue; sandbox checklist before first real use |
| Container Apps / K8s / Compose JSON shapes are modelled | fixture provenance in `adapters.md`; follow-up to capture real output |
| Scale (≈20 modules, well over 51 tests) | phase-gated; each phase green before the next |
| Public-repo leakage | synthetic names only; denylist scan as a final gate |

## 6. Out of scope (unchanged from the spec)
Voice-stack migration, any git operation or release, real pipeline runs, other pipeline providers, approving/cancelling runs, editing pipeline definitions.
