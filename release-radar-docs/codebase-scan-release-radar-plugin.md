---
language: markdown (skill prose) + typescript/javascript (vendored templates; no compiled code ships today)
framework: none (Claude Code plugin marketplace; skills are SKILL.md files with references/workflows/templates)
package_manager: none at marketplace level (no package.json, lockfile or .gitignore exists in the repo); template projects use npm
build_command: null  # marketplace has no build. Per plugin: none. Template libraries are not standalone projects; they are verified by instantiation in a throwaway project
test_command: null   # marketplace has no test runner. Library tests (*.test.ts beside the template sources) run only after instantiation, via the generated project's "node --test dist/...". flowdoc: verify.py (uvx)
lint_command: null
entry_points:
  - .claude-plugin/marketplace.json
  - plugins/agent-step-toolkit/.claude-plugin/plugin.json
  - plugins/langgraph-plugin/.claude-plugin/plugin.json
  - plugins/kafka-observability/.claude-plugin/plugin.json
last_scanned_commit: dc60ec71c51d0ed882d3869069ce2216bd051ce5
scanned_for_request: refined-request-release-radar-plugin.md
scanned_at: 2026-11-25T07:51:11Z
---

# Codebase Scan — claude-marketplace (target of the `release-radar` plugin)

All paths are relative to the marketplace repo root unless prefixed `source-engine/`,
`source-tests/` or `source-skill/` (the private, read-only originating material; see section 6).

## 1. Project Overview

A public Claude Code plugin marketplace (`ckifonidis-marketplace`, MIT). It holds three plugins
(`agent-step-toolkit` 0.31.0, `langgraph-plugin` 0.3.0, `kafka-observability` 0.9.0) listed in
`.claude-plugin/marketplace.json`, two repo-local maintainer skills (`.claude/skills/bump-version`,
`.claude/skills/publish-release`, not shipped) and a root `README.md`. There is **no build system,
no package manifest, no `.gitignore` and no test runner at repo level**. Every plugin is
documentation-driven: skills are `SKILL.md` + `references/` + `workflows/` + `templates/`.
Code in the repo is TypeScript/Python **template code that is copied into a consumer's project**
and is never executed in place.

Working-tree state at scan time: `.agents/` (a derived Codex-flavoured mirror of the maintainer
skills) and `release-radar-docs/` are untracked. HEAD is the release commit of
agent-step-toolkit 0.31.0.

**Key structural fact for this request:** no existing plugin ships an executable that its skills
run in place. `release-radar`'s `engine/` (Node CLI, committed `dist/`, tests run in the plugin
tree) is a new pattern for this repo, and the maintainer tooling has no gate that recognises it.

## 2. Module Map

Marketplace level:

| Path | Purpose | Representative contents |
|---|---|---|
| `.claude-plugin/marketplace.json` | Marketplace manifest: `name`, `owner`, `metadata{description,version}`, `plugins[]` | 3 entries; `metadata.version` = `1.0.0` |
| `README.md` | Install instructions, one `### <plugin>` section per plugin, `## Layout` tree | sections for the 3 plugins; Layout code block |
| `.claude/skills/` | Maintainer skills, not shipped | `bump-version/`, `publish-release/` |
| `.agents/skills/` | Untracked mirror of the two maintainer skills with `.claude-plugin` rewritten to `.Codex-plugin` | same files, differing only in that substitution and some prose drift |
| `plugins/` | The three shipped plugins | see below |
| `release-radar-docs/` | Untracked dev docs for this request | `refined-request-...md`, `research/` (4 notes: Azure DevOps REST, plugin runtime, deployment-source CLIs, image-reference parsing) |

Plugins (each: `.claude-plugin/plugin.json`, `PLUGIN_CHANGELOG.md`, `skills/`; optional `CHANGELOG.md` + `migrations/`):

| Plugin | Skills | Shipped code | Library `VERSION` |
|---|---|---|---|
| `agent-step-toolkit` | `create-tool`, `test-agent-step`, `pull-library`, `audit-middleware-contract-compliance`, `document-agent-flow` | `skills/create-tool/templates/agent-step/*.ts` (runner library + co-located `*.test.ts`), `templates/project/*.template` (package.json, tsconfig, cli, Dockerfile, ...), `templates/*.template`; `document-agent-flow/templates/flowdoc/*.py` + `template.html` (Python, stdlib + openpyxl) | `skills/create-tool/templates/agent-step/VERSION` (single line, e.g. `4.2.0`) |
| `kafka-observability` | `add-kafka-observability` | `skills/add-kafka-observability/templates/observability/*.ts` + co-located `*.test.ts` + in-library `README.md` | `.../templates/observability/VERSION` |
| `langgraph-plugin` | `run-langgraph-conversation`, `follow-langgraph-conversation` | none (pure prose + curl recipes) | none; no `CHANGELOG.md`/`migrations/` |

Skill directory conventions observed (8 skills, 1528 SKILL.md lines in total):
- `SKILL.md` frontmatter has **only** `name` and `description` in all 8 skills (no `allowed-tools`, no other keys). Descriptions are long and carry trigger phrases ("Use when ...").
- Body uses XML-style section tags, in two families. Router-style (create-tool, document-agent-flow, pull-library, add-kafka-observability): `<essential_principles>`, `<intake>`, `<routing>`, `<quick_reference>`, `<reference_index>`, `<workflows_index>`, `<templates_index>`, `<success_criteria>`. Linear-style (langgraph skills, test-agent-step, audit): `<objective>`, `<assumptions>`, `<quick_start>`, `<process>`, `<reference_files>`/`<api_reference>`, `<anti_patterns>`, `<success_criteria>`. `<objective>` is the opener of most skills.
- `references/*.md` hold contract/pattern docs; `workflows/*.md` hold step-by-step procedures wrapped in `<process>` / `<success_criteria>` with `## Phase N` headings; routing sections point at `workflows/<name>.md` "exactly".
- No plugin uses `commands/`, `hooks/`, `agents/`, `bin/`, `.mcp.json` or `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_SKILL_DIR}` (grep over `plugins/`, `.claude/`, `.agents/` finds no occurrence outside `release-radar-docs/`).

`plugin.json` shape (identical across the 3 plugins): `name`, `version`, `description`, `author: { "name": "Charalampos Kyfonidis" }`, `keywords: [...]` (inline array on one line). No `repository`, `license`, `category` or `tags` in `plugin.json`; those live only in the marketplace entry.

`marketplace.json` entry shape: `name`, `source: "./plugins/<name>"`, `description`, `version`, `author{name}`, `repository: "https://github.com/ckifonidis/claude-marketplace"`, `license: "MIT"`, `keywords` (inline array), `category: "development"`, `tags` (inline array). The entry `description` is long "storefront" prose and is usually richer than `plugin.json`'s. `version` is kept equal to `plugin.json` by `/publish-release`.

## 3. Conventions

Changelogs
- `PLUGIN_CHANGELOG.md` (all 3 plugins): H1 `# <plugin> plugin changelog`, intro paragraph naming `.claude-plugin/plugin.json` + the marketplace entry, a "Format follows Keep a Changelog; newest first. Semver on the plugin: major = removed/renamed skill or breaking workflow change, minor = new skill / capability / template, patch = doc or fix with no new surface" paragraph, then `## [X.Y.Z] — YYYY-MM-DD` entries with `### Added` / `### Changed` / `### Fixed` (`plugins/langgraph-plugin/PLUGIN_CHANGELOG.md:1-60`, `plugins/agent-step-toolkit/PLUGIN_CHANGELOG.md:1-14`). The 0.1.0 entry in the smallest one is a single `### Added` bullet list ("Initial release: ...").
- `CHANGELOG.md` (library history; agent-step-toolkit and kafka-observability only): explicitly distinguishes the **library** version (the `VERSION` file) from the plugin version, and links `migrations/<from>-to-<to>.md` per breaking entry (`plugins/agent-step-toolkit/CHANGELOG.md:1-14`). Heading styles differ between the two plugins (`## [4.2.0] — date` vs `## 1.8.0 (date)`). `release-radar`'s `CHANGELOG.md` (engine history) is a new instance of this role but has no `migrations/` (engine is not vendored).

Versioned libraries
- A library is "any directory containing a `VERSION` file under `skills/*/templates/`". `VERSION` is one line, `X.Y.Z\n`. It is written by `/bump-version`, never by hand and never copied from the upstream source. The same `VERSION` travels into the consumer project (`src/agent-step/VERSION`, `src/observability/VERSION`).
- Library sources are TypeScript with co-located `*.test.ts`; in this repo they are **not compiled or tested in place** (no tsconfig/package.json beside them). The only tsconfig in the repo is `plugins/agent-step-toolkit/skills/create-tool/templates/project/tsconfig.json.template`. Verification happens by instantiation: bootstrap a throwaway project from the templates and run its `npm test` (`rm -rf dist && tsc && node --test dist/agent-step/*.test.js`, from `templates/project/package.json.template:9`).
- Template package.json pins dev tooling with caret ranges (`tsx ^4.22.3` at `package.json.template:27`) and uses the Node built-in test runner (`node --test`). This matches the engine's intended toolchain (Node test runner, `tsc`).

Skill prose rules recurring across plugins (cite: `plugins/kafka-observability/skills/add-kafka-observability/SKILL.md:1-40`, `plugins/langgraph-plugin/skills/run-langgraph-conversation/SKILL.md:1-30`)
- Fail-fast / no config fallbacks, "discover, don't assume" (ports, graph ids, endpoints discovered from project files; defaults are "last resort" and called out).
- Propose-only discovery with user confirmation of every value; never overwrite a foreign module.
- Public-safe wording: examples are generic; `document-agent-flow/SKILL.md:32` ships a `--deny <file>` regex scan as a precedent for the private-denylist check in acceptance criterion 26.
- Docs are held honest by the staleness sweep (section 4), so inventories inside SKILL.md (`reference_index`, `workflows_index`, `templates_index`) must match the directory exactly, both directions.

Release flow (`.claude/skills/publish-release/`)
- One conventional commit per plugin release: `Release <plugin> X.Y.Z[ (ships <library> library A.B.C)]`; version lives in `plugin.json` AND the marketplace entry; marketplace `metadata.version` is left alone (`publish-release/SKILL.md` `<quick_reference>`). The spec's "initial entry `0.1.0`, marketplace `metadata.version` unchanged" matches this.

README conventions (`README.md`)
- Per plugin: `### <name>` + one-paragraph pitch + "Install:" fenced block `/plugin install <name>@ckifonidis-marketplace` + "Ships N skill(s):" bullet list (`- **\`skill\`** — ...`) + a closing paragraph about the embedded library when one exists.
- `## Layout` is a fenced tree. The last plugin uses `└──` with 4-space child indent (`kafka-observability/` at the end of the tree); appending `release-radar/` after it forces that block to change to `├──` and a `│   ` indent.

## 4. Integration Points

### 4.1 Release tooling interaction (maintainer skills; Out-of-Scope to modify)

`/publish-release` (`.claude/skills/publish-release/workflows/publish-release.md`) phases and how a `plugins/release-radar/` tree meets them:

| Phase / gate | What it enforces today | Effect on `release-radar` |
|---|---|---|
| 0-1 baseline + unreleased changes | `git log --grep="Release <plugin>"`; `git diff --stat <baseline>..HEAD -- plugins/<plugin>/ .claude-plugin/marketplace.json` | Works unchanged. First release: baseline is the plugin's first commit. `engine/dist/` and `package-lock.json` show up in the diff stat as ordinary changes. |
| 2 staleness sweep (`references/staleness-checks.md`) | A: SKILL.md index sections vs `templates/`, `references/`, `workflows/`; root README skill list and Layout vs `plugins/*/skills/`. B: grep for "N tests pass" / "version X.Y" claims in `skills/` only. C: dangling backticked identifiers, resolved against library source under `templates/` or the skill's own files. D: cross-doc facts (semver rules, env-var lists). | A and README checks apply to the new plugin (so each new SKILL.md needs accurate `reference_index` / `workflows_index`, and README Layout must list all three skills). **C/D do not look at `engine/src/`**, so exit-code tables, command names and env-var names in `references/` are unchecked against the engine. B scans only `skills/`, not `engine/`. |
| 3 library gate | `find plugins/<plugin>/skills/*/templates -name VERSION`; if library files changed without a `VERSION` move, HALT and send the user to `/bump-version` | **Not triggered.** `engine/VERSION` is not under `skills/*/templates/`, so `find` returns nothing and the release is classed "plain plugin release". A change to `engine/src/` with no `engine/VERSION` bump, or with a stale committed `dist/`, passes silently. This is the gap behind requirement 6. |
| 4 classify + draft | Semver on plugin; PLUGIN_CHANGELOG draft; "state which library version ships" only for plugins with a vendored library | The engine's `VERSION`/`CHANGELOG.md` would not be mentioned in the release commit or changelog unless done by hand. The commit-message variant "(ships <library> library A.B.C)" has no equivalent for an in-place engine. |
| 5 apply | edits plugin.json, marketplace entry, PLUGIN_CHANGELOG; one commit; push | Works unchanged. Nothing rebuilds or checks `dist/`. |

`/bump-version` (`.claude/skills/bump-version/`) refreshes only the two known **vendored** libraries from an upstream source, writes `VERSION`, `CHANGELOG.md` and `migrations/`, and mirrors contract changes into "tracked assets" (`references/tracked-assets.md`, `references/tracked-assets-observability.md`, each "the single place that knows what mirrors the library"). `release-radar`'s engine is built in place and is not vendored, so `/bump-version` neither applies nor is the right owner; the follow-up (spec requirement 6) is a new `engine/VERSION`+`dist/` gate in `publish-release` Phase 3 and a matching `staleness-checks` entry, in both `.claude/skills/publish-release/` and the `.agents/skills/publish-release/` mirror. The mirror differs from `.claude` only by the `.claude-plugin` to `.Codex-plugin` rewrite plus some prose drift in `tracked-assets.md`, and is untracked; whichever form is edited must be applied to both.

Other repo-level facts that affect a plugin with `node_modules` and a committed `dist/`:
- There is **no `.gitignore` anywhere in the repo and no global excludes file**. `git check-ignore plugins/release-radar/engine/node_modules` returns nothing. Running `npm install` in `engine/` would leave `node_modules/` untracked-but-visible, with a real risk of being committed. A gitignore for `node_modules/` is needed; the narrowest placement is `plugins/release-radar/engine/.gitignore` (inside the new plugin, not in the spec's layout list, so it needs a one-line user nod; a repo-root `.gitignore` would be a marketplace-level change). `package-lock.json` should be committed (reproducible `dev` toolchain, audit) and `dist/` must NOT be ignored.
- Cached plugin copies refresh only on a version bump (`publish-release` principle 4), so a committed `dist/` that is not rebuilt before release ships stale behaviour, with no existing check to catch it.
- A first release of `release-radar` needs a `Release release-radar 0.1.0` commit by the user; the spec forbids the agent from doing it.
- `${CLAUDE_PLUGIN_ROOT}` is absent from every existing skill, so there is no in-repo precedent to copy. The repo-local research note `release-radar-docs/research/claude-code-plugin-runtime.md` records that the variable is substituted inline in the SKILL.md body (not exported to Bash) and that `${CLAUDE_SKILL_DIR}/../../engine/dist/cli.js` is the documented fallback. Spec Open Question 1 therefore needs its probe run once the plugin is installed.

### 4.2 In-Scope (modify existing files)

| File | Change | Details |
|---|---|---|
| `.claude-plugin/marketplace.json` | Append a `release-radar` object to `plugins[]` (after `kafka-observability`, line ~70 of the file) | Same 10 fields as the existing entries; `source: "./plugins/release-radar"`; `version: "0.1.0"` equal to `plugin.json`; `author.name` `Charalampos Kyfonidis`; `repository`, `license: "MIT"`, inline `keywords`/`tags` arrays, `category: "development"` (the only value used so far). Leave `metadata.version` (`1.0.0`) untouched. Mind the trailing comma on the preceding entry. |
| `README.md` | New `### release-radar` section under `## Plugins`, between the `kafka-observability` section and `## Layout`; extend the `## Layout` tree | Follow the per-plugin pattern in section 3 (pitch, install command, "Ships three skills:" list, then engine / per-application verification / canonical files / mutation-boundary paragraphs). Layout: change the `kafka-observability/` branch from `└──` to `├──`, add a `release-radar/` subtree with `.claude-plugin/plugin.json`, `CHANGELOG.md` (engine history), `PLUGIN_CHANGELOG.md`, `engine/` (src, dist, test, VERSION) and `skills/{deployment-status,change-risk,promote}/`. Also fix the intro of the Layout tree only if it claims a plugin count (it does not). |

### 4.3 New Integration Points (everything under `plugins/release-radar/`)

No existing file is touched. Recommended landing locations and the convention each adopts:

| Path | Adopts / note |
|---|---|
| `plugins/release-radar/.claude-plugin/plugin.json` | Exact shape of section 2 (`name`, `version` 0.1.0, `description`, `author`, `keywords`); no `license`/`category`/`tags` here. |
| `plugins/release-radar/PLUGIN_CHANGELOG.md` | Copy the header paragraph from `plugins/langgraph-plugin/PLUGIN_CHANGELOG.md:1-10`; first entry `## [0.1.0] — <date>` with `### Added`. |
| `plugins/release-radar/CHANGELOG.md` | Engine history; follow the kafka-observability/agent-step-toolkit pattern of an intro that separates the library version (`engine/VERSION`) from the plugin version. Top entry must equal `engine/VERSION` (`0.1.0`). No `migrations/`. |
| `plugins/release-radar/skills/deployment-status/` and `change-risk/`, `promote/` | `SKILL.md` with frontmatter `name` + `description` only (no `allowed-tools` precedent). The router-style tag set (`<objective>`, `<essential_principles>`, `<intake>`, `<routing>`, `<quick_reference>`, `<reference_index>`, `<workflows_index>`, `<success_criteria>`) fits skills that have `workflows/` (`deployment-status` init-config, `promote` run-pipeline and assemble-handoff); `change-risk` has only references so the linear style is also valid. Keep `*_index` sections identical to the directory (staleness check A). Put the engine invocation line literally in the SKILL.md body (`${CLAUDE_PLUGIN_ROOT}` is only substituted there). |
| `plugins/release-radar/engine/` (`VERSION`, `package.json`, `tsconfig.json`, `src/`, `dist/`, `test/`) | No in-repo analogue. Reuse conventions from the closest template: ES2022/NodeNext/strict tsconfig, `node --test`, caret-pinned devDependencies only, `"type": "module"`. Tests run in place with `npm --prefix plugins/release-radar/engine test`, which must build first because the source tests import from `dist/` (see section 6). Add an engine-local `.gitignore` for `node_modules/` (section 4.1). `engine/VERSION` format: one line `X.Y.Z\n`, same as the library `VERSION` files. |
| `release-radar-docs/` | Already exists (untracked): holds the spec and 4 research notes. Add plan, design, decisions, functions, vetting log, pending items, worked examples, and the `publish-release` follow-up item (requirement 6) here. This scan file is part of it. Not shipped; skill-development material only. |

### 4.4 Out-of-Scope (must stay untouched)

- `plugins/agent-step-toolkit/**`, `plugins/langgraph-plugin/**`, `plugins/kafka-observability/**` (all skills, templates, changelogs, migrations, manifests).
- `.claude/skills/bump-version/**` and `.claude/skills/publish-release/**` and the untracked `.agents/skills/**` mirror: the spec's Out of Scope and requirement 6 make the `engine/VERSION` gate a recorded follow-up, not an edit in this request.
- The marketplace `metadata` block in `marketplace.json`.
- The private originating project (section 6): read-only reference; its tooling stays in place until parity is shown.
- Any git operation (commits, tags, `/publish-release`, `/bump-version`).

### 4.5 Duplication check

None found. A repo-wide search (`README.md`, `plugins/`, `.claude/`, `.agents/`, `.claude-plugin/`) for deployment status, Azure DevOps, `az webapp`, pipeline triggering, promotion and the names `release-radar` / `component-status` yields only incidental hits (the word "promote" in unrelated agent-step prose). No skill or tool in the marketplace reports deployed state, triggers pipelines, or computes promotion risk. The names `deployment-status`, `change-risk` and `promote` collide with no existing plugin or maintainer skill (so the namespaced `/release-radar:<skill>` form is only for third-party collisions). Closest neighbours by theme, not by function: `langgraph-plugin:follow-langgraph-conversation` (read-only investigation of a running dev server, sequenced discovery of "the right instance"), and `kafka-observability` (a gated, default-off, fail-fast-on-missing-config library). Their fail-fast/never-assume wording is the tone precedent.

## 5. Notes

- **No in-place code precedent.** Everything executable in this repo is a template; the engine is the first shipped code with `package.json`, a committed build output and a test suite in the plugin tree. Decide in the design where `node_modules/` is ignored and confirm `package-lock.json` is committed.
- **Release gate blind spot, concretely:** Phase 3 only globs `skills/*/templates`; staleness checks B/C/D read `skills/` and `templates/` only. Until the follow-up lands, a reviewer must manually check `engine/VERSION` vs `CHANGELOG.md` top entry, `dist/` rebuild cleanliness (acceptance criterion 3), and exit-code/command/env-var consistency between `engine/src/` and `references/`.
- **Mirror drift risk:** `.agents/` is untracked and already drifts from `.claude/` (a stale `types.ts` line in `tracked-assets.md`); any future gate edit made in only one of them will diverge further.
- **Spec-vs-convention check:** the spec's `plugin.json` fields (`name`, `version`, `description`, `author`, `keywords`) match the repo; its marketplace entry fields match exactly. The "major/minor/patch" rule in the spec equals the repo's header text verbatim, so it can be copied.

## 6. Source engine (read-only reference, private)

Referred to only as "the source engine" (`source-engine/`), its tests (`source-tests/`) and the "source skill" (`source-skill/SKILL.md`). No value from its config file, no names, subscriptions, registries or paths are recorded here. It is a small zero-runtime-dependency TypeScript CLI (about 1260 lines over 5 modules, ESM, `target ES2022`, `module NodeNext`, `strict`, `rootDir src`, `outDir dist`, `declaration false`, `types ["node"]`) with compiled `dist/` present locally. `package.json`: `"type": "module"`, `engines.node >=20`, scripts `build: tsc`, a verify/discover pair that rebuild then run `dist/cli.js --config <file>`, and `test:unit: npm run build && node --test <test dir>/*.test.mjs`; devDependencies are `@types/node` and `typescript` only (versions informational: re-vet under the dependency-vetting rule before pinning anything).

### 6.1 Per-module analysis

**`source-engine/src/az.ts` (260 lines) -> `adapters/azure-appservice.ts` + `image.ts`**

| Symbol (line) | Role | Disposition |
|---|---|---|
| `AuthError` (21), `AzError` (32) | typed errors; `AuthError` carries a `tenantHint` | generic idea (auth vs other), reusable across all CLI adapters; move to `adapters/types.ts`, give every adapter the same two error classes (exit 20 vs 21) |
| `AUTH_MARKERS` (34), `isAuthFailure` (45), `tenantFrom` (50) | substring detection of expired/revoked/MFA login (Azure AD `AADSTS*` codes, "az login") and tenant-id extraction from the re-login hint | App-Service/Azure-specific -> `azure-appservice` (and `azure-containerapp`, same `az` CLI); kubectl/docker need their own marker sets |
| `runAz` (54) | `execFileSync("az", args, {encoding, timeout, maxBuffer 128 MiB, stdio ["ignore","pipe","pipe"]})`; `ENOENT` -> `AzError` "not on PATH"; auth markers checked in stdout+stderr+message on failure AND on exit-0 stdout; other failures -> first 3 lines joined by `" \| "` | the pattern is generic (shell-free exec with timeout, ENOENT mapping, stderr capture); generalise into one shared spawn helper used by az/kubectl/docker/command adapters. Needs: timeout -> exit 21 (UNREACHABLE for verification), missing CLI -> exit 20 naming the binary (source maps missing CLI to a non-auth error, i.e. 21: a behaviour change required by spec 29) |
| `runAzJson` (86) | appends `--output json`, JSON.parse, non-JSON -> `AzError` | az-specific flag; generic parse-or-error step |
| `Signin` (95), `cachedSignin` (106) | `az account show` -> user/tenant/subscription or `null` | az-specific preflight; the source documents that it reads local cache and does not prove validity, so it must be paired with the first real list call (the trap the source's header comment describes). Becomes adapter `preflight` |
| `WebappRecord` (122), `listWebapps` (144) | one `az webapp list --subscription <s> --query "[].{name,resourceGroup,state,linuxFxVersion:siteConfig.linuxFxVersion,lastModifiedTimeUtc}"` per subscription | App-Service-specific -> `azure-appservice` read; `lastModifiedTimeUtc` is documented as an upper bound (bumps on config change too), carry that label into the report (spec 46) |
| `ParsedImage` (175) | `{registry, repository, tag, digest, notContainer, raw}` | generic -> `image.ts` as the shared image model; spec 23 names the same fields |
| `parseImage` (200) | parses `linuxFxVersion`: no `\|` or blank -> `notContainer`; kind must start with `DOCKER`; registry host recognised by a `.` or `:` in the first segment (else a Docker Hub namespace); `@` -> digest; colon after last slash -> tag; else implicit latest | the reference-parsing core (registry port vs tag, nested repos, digest, implicit latest) is generic and reusable as-is in `image.ts`; the `kind\|reference` prefix handling (`DOCKER\|`, `COMPOSE`, runtimes such as `NODE\|`) is App-Service-specific and stays in the adapter. Other adapters hand `image.ts` a bare reference. Note gaps vs spec: multi-container (`COMPOSE`) is treated as not-a-single-image; `docker.io` and `registry:port/repo@digest` combos need new cases |

**`source-engine/src/config.ts` (203 lines) -> `config.ts`**

| Symbol (line) | Disposition |
|---|---|
| `EnvironmentEntry` (13), `ComponentEntry` (25), `VerifyConfig` (51) | project-shaped (environments with subscriptions, per-environment webapp-name map, a `zone` label, `discoverPatterns`) -> replaced by the lifecycle model (ordered `stages` with tag convention + `promotion`, components with per-stage targets, adapter settings); `zone` and the two-subscription-per-environment assumption are project-specific and dropped; subscriptions move into `azure-appservice` adapter settings |
| `fail` (63), `requireKeys` (67) | generic strict-key checker: missing key and unknown key are both fatal and name the key path -> reusable as-is, but must return the exit-24 error type with a JSON pointer location (spec 19, 81) instead of a bare `Error` |
| `requireString` (74), `requireStringArray` (81), `requirePositiveNumber` (88) | generic validators -> reusable as-is; extend with enum, integer, ISO-8601, closed-set and URL validators (spec 37) |
| `loadConfig` (95) | the strict-loader shape is the template for the new one: explicit config path, JSON parse error -> fatal, `requireKeys` on every object, `repoKey`/`repoSubdir` rules (null must be explicit, empty string fatal, subdir without key fatal), "every environment represented, null = not deployed by design" generalised to "every stage represented", duplicate-name checks. All of that logic ports. Source returns a `repo` that is already resolved to an absolute path (resolved against the repos file directory) and exits 1 for config errors; the new engine must exit 24 and defer path resolution to `repo-paths.ts` |

**`source-engine/src/git.ts` (105 lines) -> `git.ts`**

| Symbol (line) | Disposition |
|---|---|
| `CommitLookup` (19) | generic result union (`resolved{sha, dateIso, subject, vsLocal}` / `no-clone` / `tag-not-found` / `git-error{detail}`), reusable as-is; extend with `digest-pinned` and `no-convention` (spec 46) |
| `git` (42) | `execFileSync("git", ["-C", repo, ...args], timeout 15 s, stdio pipe)` returning `null` on any failure -> generic; the 15 s timeout is hard-coded and must become configuration (spec 29, no defaults) |
| `looksLikeSha` (55) | `/^[0-9a-f]{7,40}$/i` -> generic; the same 7-hex rule is spec 42's commit-prefix rule |
| `resolveDeployedCommit` (66) | generic mechanics: SHA-looking tag -> rev-parse; else `refs/tags/<tag>` then with/without a leading `v`; `show -s --format=%H%x00%cI%x00%s`; `merge-base --is-ancestor <sha> HEAD` then `rev-list --count <sha>..HEAD` -> `at-head` / `behind N` / `not-ancestor`. The source hard-wires the convention "QA = SHA tag, PROD = semver tag" through `looksLikeSha`; the new engine must select by the stage's `sha` / `git-tag` / `regex` / `none` convention and the per-component override. New capability required beyond the source: ancestry verdicts between two arbitrary commits (`equal` / `behind N` / `ahead` / `diverged` / `unknown`), range lists for deltas, `git show <sha>:<path>` for settings and checklists, `log --stat`; all must remain read-only and never fetch |

**`source-engine/src/repo-paths.ts` (70 lines) -> `repo-paths.ts`**

| Symbol (line) | Disposition |
|---|---|
| `RepoPaths` (16), `loadRepoPaths` (27), `repoPathFor` (65) | generic and almost reusable as-is: `{repos: {key: path}}` mapping resolved against the file's directory, missing file / bad JSON / unknown top-level key / non-string value / unmapped key all fatal and name file and key. Adaptations: allow `schemaVersion` (source permits `_comment`), return the exit-24 error type, honour "externally owned repos file validated but never rewritten" (spec 36/82), error text must not mention project-specific copy-the-example instructions |

**`source-engine/src/cli.ts` (623 lines) -> `cli.ts`, `report.ts`, `snapshot.ts`, `lifecycle.ts`**

| Symbol (line) | Disposition |
|---|---|
| `Args` (24), `parseArgs` (65) | flag parser with duplicate-flag rejection and required `--config`; ports as the style, but the command set (spec 12) is far larger (subcommands). Source accepts `--component` with exact match and fails before any `az` call (`main`, line 582+): the same exact-match-before-I/O rule is spec 14 (exit 64 listing valid names) |
| `FailurePhase` (33), `EXIT_CODE` (41), `failArgument` (50), `failPhase` (59) | source codes: arguments 64, config 1, auth 20, source error 21, drift 22, missing 23. New contract adds 24-29 and moves config to 24 (1 only for internal errors) |
| trailer line, e.g. `<TOOL>_RESULT=FAIL PHASE=<PHASE>` (lines 55, 61, 292, 572-578) | machine-readable trailer written to stderr on failure and stdout on success; spec 22 requires one on every run with a name fixed at design time (do not reuse the source tool's literal name) |
| colour helpers (122-127) | `process.stdout.isTTY` and `NO_COLOR` gate; never in `--json`; generic -> reusable as-is (spec 16 `NO_COLOR`) |
| `imageLabel` (105), `pad` (112), `truncate` (116), `isMutableTag` (130), `dateOnly` (136), `ageOf` (142), `vsLocalText` (154) | generic presentation helpers; `isMutableTag` (explicit or implicit `latest` flagged) is worth keeping; `ageOf` is relative to `Date.now()`, so tests must not assert it |
| `indexEnvironment` (163) | one list call per subscription, lower-cased name index, **refuses a name present in two subscriptions of one environment** (`AzError`) -> App-Service-specific (spec 24) -> `azure-appservice` |
| `logicalName` (201, exported), `runDiscover` (207), `DISCOVER_BEGIN/END` (188-189) | `--discover` groups per-environment webapp names by stripping an organisation-specific naming prefix and a `-<region>-<env>-NN` suffix and prints a pasteable components block between BEGIN/END markers. Project-specific naming rules -> dropped (the new `discover` lists raw targets and lets the user group them; no name inference, spec 74); BEGIN/END block idea may be kept |
| `reportAuth` (295) | prints that the failure is an AUTH problem, not a missing target, echoes cached sign-in, prints the exact `az login --tenant` command -> the message pattern is generic, the command is adapter-specific (each adapter supplies its own re-auth hint; spec 57 step 3) |
| `jsonCommit` (312) | the frozen `--json` commit shape `{status, sha, date, subject, vsLocal}` -> keep as the additive-contract baseline (spec 55), adding `schemaVersion` |
| `runVerify` (327) | per-environment indexing, per-component per-environment cells (`declared`, `record`, `image`, `commit`), human table, `--json` array, drift = same component with different image reference across environments (informational by default, `--fail-on-drift` -> 22), missing declared target -> 23 after printing the full report, `null` = not deployed. Becomes `snapshot.ts` (collect), `report.ts` (render) and `lifecycle.ts` (stage order, deltas, consistency). The source deliberately states that a tag difference across environments is normal and proves nothing; only equal digests prove the same build (spec 52). New logic required: ordered N stages, multi-target consistency by digest then repo+tag (spec 51), triggerability, deltas, fleet summary |
| `main` (582) | order of operations to preserve: parse args, load config, validate component name, only then touch the network; `az account show` failure = auth exit 20 with a plain re-login hint; then run |

### 6.2 What the source engine does not contain (net-new for the port)

Azure DevOps client and `run-pipeline` gate, confirmation tokens, verification runner (HTTP/version/smoke), `settings-diff`, `handoff-package`, canonical `format`/`checklist`, snapshots with fingerprints, retention/quarantine, the other four adapters (`azure-containerapp`, `kubernetes`, `compose`, `command`), exit codes 24-29 and the precedence rule, `schemaVersion` on any file, `HEAD`/`GET`-only HTTP, and the PAT/expiry handling. The source reads **no environment variables except `NO_COLOR`** and writes **no files**.

### 6.3 Source tests (`source-tests/`, 51 tests = 31 + 20, Node built-in runner, `node --test`)

Shared technique: ESM `.test.mjs`, `import test from "node:test"` and `node:assert` strict. Tests import the **compiled** `dist/*.js` (so the build step must precede the run; `test:unit` does `npm run build && node --test ...`). Temp dirs from `mkdtempSync(join(tmpdir(), "...-"))` cleaned with `t.after(() => rmSync(root, {recursive: true, force: true}))`.

**Fake-`az`-on-PATH harness (the technique the new adapters reuse).** `fixture(t, {webapps, components, accountFails, authFails})` in the integration file:
1. creates `<tmp>/bin/` and writes an executable file `az` with the shebang `#!${process.execPath}` (the absolute Node binary running the tests, so no `env`/PATH lookup of node is needed), the scenario embedded by `JSON.stringify` into constants at the top of the generated script (`WEBAPPS`, `ACCOUNT_FAILS`, `AUTH_FAILS`), mode `0o700` plus an explicit `chmodSync(..., 0o700)`;
2. the shim reads `process.argv.slice(2)` and dispatches on exactly the argument shapes the engine builds: `account show` prints a synthetic JSON account (or, when `ACCOUNT_FAILS`, writes `ERROR: Please run 'az login'` to stderr and exits 1); `webapp list` finds `--subscription` via `args.indexOf("--subscription")` and prints `WEBAPPS[sub] ?? []` as JSON (or, when `AUTH_FAILS`, writes an `AADSTS50173`-style expiry message plus an `az login --tenant "<guid>"` line to stderr and exits 1); **any other invocation writes `unexpected fake az: <args>` to stderr and exits 90**, so an unplanned read-only-contract violation surfaces as a test failure;
3. repos mapping: a `repos.local.json` of `{repos: {<name>: <clone>}}` is written next to the config, and the config's `repoPaths` points at it;
4. the child environment is `{...process.env, PATH: binDir + path.delimiter + process.env.PATH}` (fake first, real PATH retained so `git` still resolves);
5. `run(fx, extra)` = `spawnSync(process.execPath, [CLI, "--config", fx.configPath, ...extra], {env: fx.env, encoding: "utf8"})` and returns stdout+stderr joined as `out`, with `status` used for the exit-code assertion.
Rationale recorded by the source: fake the **process boundary**, not a module, so real argument construction and real JSON parsing are exercised. No network, account or credential is involved. Git fixtures: `git init -q -b main` in a temp dir, `git -c user.email=... -c user.name=... commit --allow-empty`, tags created with and without `v`, via `execSync(..., {cwd, stdio: ["ignore","pipe","pipe"]})`.
Reuse notes for the new engine: the same shim shape extends to `kubectl`, `docker` and an arbitrary-command/smoke shim; the exit-90-on-unknown-argv rule is the cheapest read-only proof for CLI adapters; recording argv to a log file in the shim (not present in the source) would allow asserting "no other CLI call was made" and arg order; the REST and application servers are `node:http` servers on `127.0.0.1:0`, new relative to the source.

**Mapping of each source test (spec section M areas):**

| Source test group (file, count) | Behaviour | New-engine test area |
|---|---|---|
| parse-and-config: 9 `parseImage` tests (lines 22-81): ACR-style tag, digest-pinned, nested repo, registry port not a tag, implicit latest, Docker Hub namespace, non-container/blank, empty `DOCKER\|`, `COMPOSE`/multi-container | image-reference edge cases | **Parsing and config: image parsing edge cases** (`image.ts`; the `DOCKER\|` wrapper cases go to `azure-appservice` adapter tests) |
| parse-and-config: "the real shipped config loads" (124, skips without a local repos file) | loads the private production config | **Dropped** (project-specific; replaced by a synthetic full-config load test) |
| parse-and-config: valid synthetic config (149), repoKey resolves relative to the repos file (155), `repoSubdir` (163), unmapped key fatal (170), missing `repoKey` key fatal (177), empty-string `repoKey` fatal (183), `repoSubdir` without `repoKey` fatal (189) | repo path and subdir rules | **Parsing and config: repo paths and `repoSubdir`; requirement 37 (repo rules)** |
| parse-and-config: missing top-level key fatal and names key (195), unknown key fatal (201), component missing an environment fatal (206), webapps key not a declared environment (215), duplicate environment names (224), duplicate component names (230), empty subscriptions list (236), non-positive timeout (242), missing file vs invalid JSON distinct (248) | strict validation | **Requirement 37 strictness** (stage omitted without `null`, undeclared-stage target, same-name-different-content, non-positive timeout, bad JSON location) and the exit-24 assertions; "empty subscriptions" becomes the `azure-appservice` adapter-settings check |
| parse-and-config: `resolveDeployedCommit` x5 (281-314): SHA tag with date/subject/behind-count, at-head, semver tag with/without `v`, unknown tag -> `tag-not-found`, null/absent clone -> `no-clone` and non-git dir -> `git-error` | git resolution | **Parsing and config: each tag convention + per-component override, `tag-not-found`, `no-clone`, `git-error`, HEAD relations** |
| report.integration: matching images pass with exit 0 (110), differing tags reported but exit 0 (126), `--fail-on-drift` -> 22 (148) | cross-stage comparison and drift gate | **Report and outputs: stage deltas/equality; Pipelines: drift gate variants** (new: gate only for named stage pairs, within-stage and pipeline/target drift) |
| report.integration: declared target missing -> 23 (163), explicit `null` = not deployed, exit 0 (177) | missing vs not-deployed | **Adapters and exit codes: missing target (23)**, `not-deployed` status |
| report.integration: expired auth -> 20 never missing (189), no cached sign-in -> 20 with plain hint (206) | auth precedence over "missing" | **Adapters and exit codes: auth failure per adapter (20)**; acceptance criterion 6 "auth never yields 23/no runs/FAIL" |
| report.integration: name in two subscriptions refused (217), stopped webapp still shows image with state (230), non-container flagged (244) | App Service ambiguity, stopped, non-container | **Adapters and exit codes: App Service ambiguity, stopped and non-container targets** |
| report.integration: `--json` parseable with per-environment status (256) | JSON contract | **Report and outputs: the `--json` contract** (add `schemaVersion`, additive-field check) |
| report.integration: dates render with humanised age, absent dates say so (276) | last-modified labelling | **Report and outputs** (last-modified as upper bound; keep age out of assertions or inject a clock) |
| report.integration: commit dates resolve from a mapped clone end to end (293) | source + git integration | **Report and outputs: end-to-end `status` with git** |
| report.integration: `--discover` lists matching webapps and emits a components block (327), pairs QA and PROD into one entry (364), keeps an unrecognised name intact (463) | discover output | **Report and outputs: `discover` and `validate-config`** (rewrite: pairing/naming inference is dropped; only listing and the preserved-name rule carry over) |
| report.integration: `--component` restricts report, human and `--json` (393), unknown name fails fast listing valid names before any `az` call (422), combined with `--discover` is an argument error (440), keeps exit 23 on the filtered set (450) | argument resolution | **Adapters and exit codes: exit 64 before any source call listing valid names (req 14)**; `--stage` / `--all` / `--no-pipelines` analogues |

Test-count accounting for the "at least 51" target: all 51 map or are consciously dropped/rewritten (1 dropped: the private-config load; 3 `--discover` tests rewritten); the new suite adds the areas with no source analogue (adapters 2-5, pipelines, run gate, verification, handoff, settings-diff, snapshots, secrets, canonical files). Source suite has **no** test for stdout/stderr secret leakage, snapshots, or any non-GET assertion.

### 6.4 The source skill (`source-skill/SKILL.md`, 137 lines) -> `deployment-status` + `change-risk`

A single linear-style skill with prose headings "Step 1 ... Step 7" and a "Report shape" section; frontmatter `name` + `description`. Mapping:

| Source skill part | New home |
|---|---|
| "Hard rules": read-only (az reads + git inspection only; never fetch/checkout/pull/deploy; recommend `git fetch` but never run it); never record credential values or secret values, key names only | every SKILL.md (spec 71, 73); reused verbatim in spirit |
| Step 1 resolve and validate the component name against config exactly; if no match list valid names, point at the closest, ask; never substitute; resolve `repoKey` (may be null) to a clone path through the per-machine repos file | `deployment-status` step 2 / spec 8: exact resolution, near-miss only as a candidate confirmed with the user; engine enforces exit 64 |
| Step 2 run the engine with `--json --component`, interpret exit codes exactly (0 proceed; 20 re-login and never "absent"; 23 name the missing target and still report what was found as incomplete; 64 back to step 1; 21/22 surface message) | `deployment-status` step 3 with the full section C table |
| Step 3 deployed-state section: status found/missing/not-deployed, state (shout non-Running), registry/repo/tag/digest, last-modified with the upper-bound caveat, resolved commit and `vsLocal`; mandatory note that differing tags prove nothing, only equal digests prove the same build | `deployment-status` step 4 (spec 46, 52); now data comes from the engine, not model-run git |
| Steps 4-5 "missing in env A vs local" and "missing in B vs A": `git log --oneline <a>..<b>` grouped by conventional-commit type; "local = clone HEAD as of last fetch, no fetch"; empty range with differing SHAs -> check ancestry (`merge-base --is-ancestor`): ahead vs diverged; never report up to date on a non-empty difference | now computed by the engine (spec 53 deltas with `equal/behind/ahead/diverged/unknown`); the skill only groups by conventional-commit type |
| Step 6 breaking-change analysis: five categories (new/renamed required env vars as boot-blocking; wire-contract/handoff changes; dependency/lockfile changes with HIGH+ advisories; Dockerfile/base-image/context changes; DB or persisted-state changes), "what must be prepared", and a verdict per direction (safe / needs preparation (list) / do not promote until X), with a pointer to a project-specific acceptance skill for production | `change-risk` generic checks a-e (spec 58 step 6) and the verdict (step 10). The project-specific parts (config file names, registry JSON, Key Vault mentions, the acceptance-skill pointer, the project's own incident labels) go to config/checklists or are dropped; framework-specific signals go to `references/stack-signals.md` |
| Step 7 graceful degradation: `repoKey: null` -> no commit comparison, say so; `tag-not-found` -> recommend (never run) `git fetch --tags`; `git-error`/digest-pinned/`not-ancestor` surfaced verbatim with a one-line interpretation; `declared: null` -> "not deployed by design" | `deployment-status` step 5 (visible degradation, spec 57) |
| Report shape: conversational, one-line verdict first, then sections; no file unless asked; worked examples live in a sibling docs folder | spec 57 step 6; worked examples go to `release-radar-docs/` using synthetic names only |

Gaps relative to the spec that the source skill does not cover: pipeline runs/drift, `--verify`, stages with ownership/promotion mode, handoff packages, settings-diff, checklist layers, the canonical-file gate, and any mutating step.

## 7. Verification of this scan (what was and was not read)

Read in full: the refined request; `marketplace.json`; the three `plugin.json`; the publish-release skill, workflow and staleness references; the source engine's five modules; both source test files' structure and the fake-`az` harness; the source skill. Sampled: SKILL.md headings and frontmatter across all 8 marketplace skills; the head of three changelogs; the observability library README prologue; the template `package.json`/`tsconfig` templates. Not read: library template bodies, migrations, `bump-version`'s workflow body, `document-agent-flow` internals. Serena MCP was not available in this run; traversal used `ls`/`find`/`grep`.
