# Refined Request: `release-radar` plugin — deployment status, change risk, real-world verification, release lifecycle, promotion, canonical files and multi-repo workspaces

## Category
Development (new Claude Code plugin: three skills plus a bundled TypeScript engine, published in a public marketplace repository)

## Objective
Add a new plugin, `release-radar`, to the public `ckifonidis/claude-marketplace` repository. It generalizes an existing private, single-project "component status" skill and its Azure App Service image-verification engine into a reusable product. The product understands a project's **release lifecycle**: an ordered set of stages, each declaring how it is promoted into and who owns that promotion. One example: a development team may run pipelines up to QA, while a separate operations team promotes to production from a handed-over image and settings file.

Projects are modelled as a **workspace** made of **member components**:
- A workspace file (in an orchestration repository, or in the single repository of a one-repo project) declares the stages, the lifecycle, the fleet settings and an explicit member list.
- Each component's own configuration lives **only in that component's repository**.
- Member repositories are located only through a per-machine repos file. No directory is ever scanned.

The skills can be run from the orchestration repository, from inside any member's clone, or from anywhere else through a per-user workspace index.

The plugin has three skills:
1. **`deployment-status`** (read-only) reports what is deployed where: the running image and commit for each component, stage and target; within-stage consistency; deltas between neighbouring stages; recent Azure DevOps pipeline runs and pipeline/target drift. On request it also gives the **real-world verification** results that each application declares for itself.
2. **`change-risk`** (read-only) reports what could break in a promotion or an explicit git range. It covers boot-blocking config, contracts, dependencies, builds, data, and key-level diffs of the settings files that travel to another team.
3. **`promote`** (the only mutating skill). For a stage the user's own team owns and that is promoted by a pipeline, it triggers the Azure DevOps pipeline run for a declared action (build, or configuration-only) behind a fresh risk verdict, an exact preview and an explicit confirmation. It then proves the result landed, including the application's own real-world verification. For a stage another team owns, it assembles the handoff package without triggering anything.

A strictly gated TypeScript engine provides the facts. It has pluggable deployment-source adapters, an Azure DevOps client and a read-only verification runner. Everything project-specific lives in the consuming projects' `.release-radar/` files. The plugin ships none of it. **Every file the plugin writes or reads has one canonical, schema-versioned, machine-checkable form.** Hand edits are detected, re-formatted losslessly when the file is still valid, and reported with exact locations when it is not.

## Scope

**In scope**
- Marketplace-level edits: a new `release-radar` entry in `.claude-plugin/marketplace.json`, and a new plugin section plus a `Layout` tree update in `README.md`.
- The plugin package `plugins/release-radar/`:
  - `.claude-plugin/plugin.json`
  - `PLUGIN_CHANGELOG.md` (Keep-a-Changelog + semver)
  - `CHANGELOG.md` (engine history)
  - `skills/deployment-status/` with `SKILL.md`, `references/config-schema.md` (workspace and component schemas), `references/workspace-model.md`, `references/exit-codes.md`, `references/adapters.md`, `references/verification.md`, `references/file-formats.md`, `workflows/init-workspace.md` and `workflows/init-component.md`
  - `skills/change-risk/` with `SKILL.md`, `references/generic-checks.md`, `references/stack-signals.md` and `references/checklist-format.md`
  - `skills/promote/` with `SKILL.md`, `references/safety-gates.md`, `references/lifecycle-model.md`, `references/handoff-package.md`, `workflows/run-pipeline.md` and `workflows/assemble-handoff.md`
  - `engine/` with:
    - `VERSION`, `package.json`, `tsconfig.json`, `.gitignore` (`node_modules/`)
    - `src/{cli,config,workspace,workspace-index,repo-paths,image,git,snapshot,report,lifecycle,settings-diff,handoff,verify,format,checklist}.ts`
    - `src/adapters/{types,azure-appservice,azure-containerapp,kubernetes,compose,command}.ts`
    - `src/pipelines/{types,azure-devops}.ts`
    - the committed compiled `dist/`
    - `test/` (fixtures, fake CLI shims, a fake Azure DevOps REST server, a fake HTTP application server, `*.test.mjs`)

  The additions made since the user approved the original layout are flagged in Assumption 8.
- The workspace/component configuration model, member resolution through the repos file, and the per-user workspace index.
- Five deployment-source adapters, the release-lifecycle model, the Azure DevOps client (reads plus one gated write), the per-application real-world verification runner, and canonical formatting and cleanup of every structured file.
- A complete engine test suite that runs offline. Development of the plugin is fixture-based for every adapter and client.
- Development documentation (plan, design, decisions, functions, research, dependency-vetting log, pending items, synthetic worked examples) in `release-radar-docs/` at the marketplace root. This is committed to the repo but not shipped.

**Out of scope**
- Migrating the originating private project to the plugin (the workspace file in its orchestration repo, `component.json` in each sibling, fleet `checks.md`, retiring its existing engine, aliases and skill). That is a follow-up. The originating project keeps its current tooling until parity is shown.
- Any version-control operation, including in member repositories: commits, pushes, tags, releases, and running `/publish-release` or `/bump-version`. The user does these personally. The skills may write `component.json` and its checklist into a member's working tree, after confirmation, but never commit them.
- Directory scanning or globbing to find repositories or component configs. Worktree copies and similarly named sibling folders are never read.
- Component definitions inside the workspace file. A component's config exists only in its own repository.
- Shipping any real organization's or project's configuration, checklists, resource, pipeline or endpoint names, subscriptions, registries, issue numbers or real run output.
- Triggering anything for a stage whose `promotion.mode` is not `pipeline`, or whose owner is not the operator's own team.
- Direct writes against deployment sources (deploy, restart, scale, edit settings), git (fetch, pull, checkout, commit, push, history rewrite) and application endpoints (no request other than GET or HEAD). Queuing a configured Azure DevOps pipeline run through `promote` is the only remote mutation in the plugin.
- Deleting any file other than release-radar's own snapshots and handoff packages beyond their retention counts, and workspace-index entries removed after confirmation. Re-formatting or deleting files that release-radar does not own (requirement 82).
- Approving or rejecting Azure DevOps approvals or checks, cancelling or retrying runs, and creating or editing pipeline definitions.
- Pipeline providers other than Azure DevOps in v1 (a `provider` discriminator keeps this extensible).
- Plugin-level live tests against real CLIs, real Azure DevOps organizations or real applications. Real-world proof comes from each application's own `verification` block.
- Invoking `beforePromote` hook skills automatically (they are only pointed at).
- Changing the existing plugins and the repo-local maintainer skills. The `engine/VERSION` release-gate gap is recorded as a follow-up (requirement 6).

## Requirements

### A. Packaging, naming and invocation
1. **Names are final:** the plugin is `release-radar`, and its skills are `deployment-status`, `change-risk` and `promote`.
2. `plugins/release-radar/.claude-plugin/plugin.json` declares `name`, `version`, `description`, `author` (`Charalampos Kyfonidis`) and `keywords`, in the same shape as the existing plugins.
3. `.claude-plugin/marketplace.json` gains a `release-radar` entry with the existing entries' fields (`name`, `source: "./plugins/release-radar"`, `description`, `version`, `author`, `repository`, `license: "MIT"`, `keywords`, `category`, `tags`). Its `version` equals `plugin.json`'s. The marketplace `metadata.version` stays unchanged.
4. `README.md` gains a `### release-radar` section:
   - the install command `/plugin install release-radar@ckifonidis-marketplace`;
   - the three skills and their invocation shapes;
   - the engine;
   - the workspace/member model;
   - per-application real-world verification;
   - canonical files;
   - an explicit statement that only `promote` can trigger anything, and only behind a preview and a confirmation.

   The `## Layout` tree gains the subtree.
5. `PLUGIN_CHANGELOG.md` and `CHANGELOG.md` each have an initial entry. The plugin starts at `0.1.0`, the engine `VERSION` at `0.1.0` (matching the top `CHANGELOG.md` entry), and every file schema's `schemaVersion` at `1`.
6. `release-radar-docs/` records a follow-up item. The marketplace's `/publish-release` library gate (and its `.agents/` mirror) recognizes only `templates/**/VERSION`. It should be extended so that a change under `plugins/release-radar/engine/src/` requires an `engine/VERSION` bump and a rebuilt `dist/`. The item is not implemented in this request.
7. **Invocation shapes** *(amended)*. Each `SKILL.md` documents its shape, and natural-language equivalents work for all three (e.g. "promote acme-api to qa", "what's deployed for acme-api", "what could break promoting acme-api from qa to production"):
   - `/deployment-status [component|--all] [stage] [--verify]`. With no component argument it gives the fleet summary (same as `--all`), unless the skill was started inside a member's clone (requirement 31f(c)), in which case that component is pre-selected and the answer says so. `[stage]` restricts the report to one stage. `--verify` also runs the real-world verification.
   - `/change-risk <component> <from-stage> <to-stage>`, or `/change-risk [component] <range|branch|PR>`. With no component the range form works on the current repository. The reserved name `local` stands for the clone's HEAD in `<from-stage>`.
   - `/promote <component> <stage> [action]`, e.g. `/promote acme-api qa` (the mapping's declared primary action) or `/promote acme-api qa config` (a declared configuration-only action).
   - All three accept an optional `--workspace <path>` (requirement 31f(a)).
   - Docs state that the namespaced forms (`/release-radar:promote …`, `/release-radar:deployment-status …`, `/release-radar:change-risk …`) apply when another installed plugin defines a skill with the same name.
8. **Argument resolution is exact** *(amended)*. Component names come from the workspace's `members` list, and stage and action names from the workspace and the member's `component.json`. All of them match exactly. A natural-language or near-miss name is resolved to a candidate, and the skill confirms it with the user before acting. On a miss the skill lists the valid names. It never silently substitutes.
9. All three `SKILL.md` files have YAML frontmatter (`name`, `description`) with trigger phrases and follow the marketplace's section conventions. `promote`'s description states that it is the mutating skill and requires confirmation.

### B. Engine: runtime, invocation and commands
10. The engine is TypeScript compiled with `tsc`. It has **zero runtime dependencies** (HTTP through Node's built-in facilities), requires Node >= 20 and `git`, and the compiled `dist/` is committed.
10a. *(new)* `engine/.gitignore` contains `node_modules/`. The user approved this layout addition.
11. **Engine invocation** *(amended: settled by the plugin runtime probe of 2026-11-25, recorded in `release-radar-docs/design.md` § "Plugin runtime probe")*.
    - **What the probe established:**
      - `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PLUGIN_DATA}` are substituted in the **`SKILL.md` body**.
      - `${CLAUDE_PLUGIN_ROOT}` inside the frontmatter `allowed-tools` is expanded. In default permission mode the engine call ran pre-allowed while a control command was denied.
      - None of the three variables is set in the Bash environment.
      - Files read later through Read (`references/`, `workflows/`) are **not** substituted.
      - Positional arguments are quote-aware.
    - **Consequences:**
      - Each skill invokes the engine as `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" <command> ...`, written **literally in its `SKILL.md` body**, never in `references/` or `workflows/` files (which receive no substitution) and never through a Bash environment variable. Reference and workflow files describe commands by engine command name only and point back to the `SKILL.md` invocation.
      - **Pre-allowed commands.** Each `SKILL.md`'s frontmatter `allowed-tools` pre-allows **only the read-only engine subcommands**, with one rule per subcommand built on `${CLAUDE_PLUGIN_ROOT}`. This is plan decision D12 and `release-radar-docs/design.md` § "Plugin runtime probe", consequence 2.
        - `format` is pre-allowed only in its `--check` form.
        - `workspace-index` is pre-allowed only for `list` and `resolve`.
        - **`run-pipeline`, `format` without `--check`, and `workspace-index register|unregister` are never pre-allowed.** Each of them always goes through the normal permission prompt, on top of the skill's own confirmation gates.
      - The derivation `<skill-dir>/../../engine/dist/cli.js` is not needed. It is kept only as a documented contingency in case a future Claude Code version stops substituting the variable.
      - The workspace-index path is passed by the skill as the substituted `${CLAUDE_PLUGIN_DATA}` value through `--index` (requirement 31g, unchanged).
12. Commands *(amended)*:
    - **Read-only:**
      - `status` (components, or `--all`; `--stage`; `--json`; `--verify`; `--no-pipelines`);
      - `verify` (real-world verification only; `--expect <sha|tag>` supplies the expected version, otherwise it comes from a live status read);
      - `discover`;
      - `validate-config` (the workspace plus every available member's `component.json`, with unavailable members reported);
      - `format --check` (section N);
      - `settings-diff`;
      - `pipeline-runs`;
      - `pipeline-run` (optional `--follow`);
      - `pipeline-preview`;
      - `handoff-package`;
      - `workspace-index list`;
      - `workspace-index resolve <cwd>`;
      - `where` (prints the engine's own root directory, used by the skills to confirm the plugin-root mechanism).
    - **Remote mutation (the only one):** `run-pipeline --confirm <token>`.
    - **Local file maintenance:**
      - `format` (without `--check`). It rewrites and cleans up only the files that section N assigns to release-radar, and only losslessly.
      - `workspace-index register <path>` / `unregister <path>`. These touch only the workspace-index file.

      None of these touches deployment sources, Azure DevOps, git history or application endpoints.
13. **Explicit paths** *(amended)*. Every engine command that needs a workspace takes it explicitly as `--workspace <path>`, which replaces `--config` everywhere. Workspace-index commands take the index file explicitly as `--index <path>`. Location resolution (requirement 31f) is performed only by `workspace-index resolve`, in its fixed order. No other command searches for or assumes a workspace.
14. **Unknown and unavailable names** *(amended)*. A component name not in `members`, or an unknown stage or action, fails with exit 64 **before any preflight, source, REST or HTTP call**, and the message lists the valid names. A listed member that is unavailable is handled by requirement 31c.
15. **Read-only except `run-pipeline` and the local maintenance commands** *(amended)*. Filesystem writes are limited to:
    - the engine's own snapshots and handoff-package directories under the workspace's `.release-radar/`;
    - `format` rewrites (section N);
    - the workspace-index file;
    - files that the init workflows write after explicit user confirmation (`workspace.json`, `repos.local.json`, `.gitignore` lines in the workspace repo; `component.json` and the component `checks.md` in a member's working tree).

    Network requests to application endpoints are GET or HEAD only.
16. **Credentials and environment variables.** The engine reads exactly these, and only when the feature that needs them is in use:
    - **Source adapters:** none. Authentication is delegated to each CLI's own login or context.
    - **Azure DevOps:** `AZURE_DEVOPS_EXT_PAT`.
      - If it is absent or empty, the run exits 20 before any REST call.
      - The optional `AZURE_DEVOPS_PAT_EXPIRES` (ISO-8601) gives days-remaining reporting, and a warning inside `patExpiryWarningDays`. An expired or unparseable value exits 20.
    - **Verification headers:** the environment variables that a `verification` block names explicitly. If one is missing, the run exits 20 before any check runs.
    - **Output:** `NO_COLOR` (human output only).

    No credential or header value ever appears in output, logs, snapshots, error messages or handoff packages.
17. Azure DevOps responses that are not authenticated JSON (401, 403, or a 203/HTML sign-in page) are auth failures (exit 20). They are never read as "no runs" or "not found".
18. **Fail-whole-run on preflight.** Any failing adapter, Azure DevOps or verification-credential preflight for the selected components exits 20 with no partial report. The exception is `--no-pipelines`, which explicitly omits the pipeline sections (and their PAT requirement), and the report says the pipelines were omitted.

### C. Exit codes (safety contract)
19. Exit codes *(amended: 24 widened, 30 added)*:

| Code | Meaning |
|---|---|
| 0 | Success; no gate tripped |
| 1 | Unexpected internal error only (never used for config) |
| 20 | Auth or preflight failed (source CLI missing or not logged in; PAT absent, invalid or expired; a verification header env var missing) |
| 21 | Source or REST error other than auth |
| 22 | Drift gate tripped (requirement 47) |
| 23 | A declared target or pipeline does not exist |
| 24 | Invalid: workspace, component config, repos file, checklist, workspace index or engine-written file fails parsing or schema validation (exact location given); a configured-but-missing checklist path; a specifically requested member that is unavailable (requirement 31c) |
| 25 | Pipeline run finished with a result other than `succeeded` |
| 26 | Refused: not triggerable (mode or owner), no mapping, undeclared action, or a smoke command on a stage not owned by `operatorTeam` |
| 27 | Confirmation token missing, mismatched or expired |
| 28 | Real-world verification failed: at least one check returned FAIL |
| 29 | Non-canonical: at least one file is valid but not in canonical form. Returned by `format --check`, and by any other command given non-canonical input (requirement 83) |
| **30** | **Real-world verification inconclusive:** at least one check UNREACHABLE and none FAIL |
| 64 | Bad arguments |

20. **Precedence** *(amended)*, applied when several conditions occur at once: the earliest phase wins, in the order **64 > 24 > 29 > 20 > 26 > 27 > 21 > 25 > 23 > 28 > 30 > 22**. Exits 22, 23, 25, 28 and 30 still emit the full parseable report. Exits 26 and 27 guarantee that no write request was sent.
21. An auth, preflight or reachability failure is never reported as "not deployed", "missing", "no runs" or "verification failed".
22. Every run prints a machine-readable trailer line (`<NAME>_RESULT=... PHASE=<phase>`). The exact name is set at design time.

### D. Deployment-source adapters
23. One interface: **preflight** (CLI present, auth/context valid) and **read** (per target: existence, image `registry`/`repository`/`tag`/`digest`/`raw`, state, last-modified when exposed).
24. `azure-appservice`: a port of the existing logic, in two parts.
    - Calls: `az account show` and `az webapp list` once per subscription.
    - Image and target handling (full parity): `linuxFxVersion` parsing, including registry ports, Docker Hub namespaces, nested repositories, implicit `latest`, digest-pinned and non-container/multi-container references, and refusal of a name that appears in two subscriptions of one stage.
25. `azure-containerapp`: the active revision's image(s) and state, read through read-only `az containerapp` calls.
26. `kubernetes`: workload images and readiness through read-only `kubectl` calls against a configured context and namespace, with the digest from pod `imageID` when exposed.
27. `compose`: running container images and states through read-only `docker` calls, with the digest or image ID when available.
28. `command`: a configured command given as an **argv array, executed without a shell**. The image reference is extracted through a JSON path or a regex and run through the same parser. It has an optional preflight command. `validate-config` prints every configured command, and `deployment-status` shows them to the user the first time it uses a config. The docs state that the engine cannot verify read-only-ness; that responsibility lies with the config author.
29. Every adapter, REST and HTTP call applies a configured timeout. A timeout maps to exit 21, or to UNREACHABLE for verification checks, unless it can be identified as an auth problem. A missing CLI exits 20, naming the binary.
30. **Fixture provenance.** All adapters and the Azure DevOps client are developed and tested against fixtures only. For each adapter and client, `references/adapters.md` states where its fixtures come from: the documented CLI or REST output shape it models, with a reference to the documentation or CLI version, and the fact that all fixture data is synthetic.

### E. Configuration: workspace, components and release-lifecycle model
31. **`.release-radar/workspace.json`** *(amended: replaces the single `config.json`; member entries carry `repoSubdir`)*. It is committed in the orchestration repository, or in the single repository of a one-repo project, and declares:
    - `schemaVersion`;
    - the ordered stages (`local` is a reserved name; using it is invalid);
    - per stage, a tag convention (`sha` | `git-tag` | `regex` | `none`) and a `promotion` block (requirement 32);
    - `operatorTeam`;
    - an explicit **`members`** list, each entry being `{ name, repoKey, repoSubdir }`. `repoSubdir` is explicit: `null` means the repository root, and a relative path means a subdirectory of the clone (requirement 31c);
    - `freshnessMinutes`, the fleet `checklist` path, `beforePromote`, the repos-file location, per-adapter settings, and the required retention counts `snapshotRetention` and `handoffRetention`;
    - an `azureDevOps` block when any member uses pipelines: `organizationUrl` (a full base URL), the default `project`, the request timeout, `runHistoryCount`, `followPollSeconds`, `followTimeoutMinutes`, `confirmTokenTtlMinutes` and `patExpiryWarningDays`.

    The workspace **never** contains component definitions (targets, mappings, artefacts, verification). Every key is required when its feature is used. Nothing is defaulted.
31a. *(new)* **`.release-radar/component.json`** is committed in each component's **own** repository, under `repoSubdir` when one is set. It declares:
    - `schemaVersion`;
    - the component `name`, which must equal the member name;
    - per stage, one or more targets (adapter + params). An explicit `null`/empty means not deployed by design;
    - optional, explicitly typed per-stage tag-convention overrides. When absent, the stage's convention applies, as documented semantics rather than a fallback;
    - per-target pipeline mappings, actions, `primaryAction` and `landedWaitMinutes` (requirement 33);
    - handoff artefacts (requirement 35);
    - verification blocks (requirement 40).

    The component checklist stays at `<repo>/.release-radar/checks.md`, or under `repoSubdir` when set.
31b. *(new)* **Configs live in one place: the component's repository.** The workspace locates each member's repository **only** through the per-machine repos file (`repoKey` → clone path; requirement 36). No directory is scanned or globbed. Worktree copies, similarly named sibling folders, and `component.json` files in repositories that are not members are never read from the workspace side.
31c. *(new; amended: monorepos allowed)* **Member resolution rules**, all strict, with no fallbacks:
    - **Unavailable members.** A member is `unavailable (no local clone)` when its `repoKey` is unmapped in the repos file or the mapped clone path does not exist. It is `unavailable (no component config)` when the clone exists but has no `component.json` at the expected location. An unavailable member is reported and excluded from a fleet run, which is not fatal. When the user asked for that specific component, it is fatal (exit 24, naming the member and the missing key or path).
    - **Monorepos and multi-flavour repositories are allowed.** Several members may share one `repoKey` when each has a different `repoSubdir`. Each subdirectory holds its own `.release-radar/component.json` and, optionally, its own `checks.md`. A member with `repoSubdir: null` occupies the repository root. Locations are compared after normalisation: the path is relative to the clone root, with no `.` segments and no trailing separator, and `null` means the root.
    - **Invalid workspaces** (exit 24):
      - a `component.json` whose `name` differs from the member name;
      - a `component.json` referencing a stage the workspace does not declare;
      - **two members with the same `repoKey` and the same normalised `repoSubdir` location**. The error points at the later member's `repoSubdir`.
31d. *(new)* **Which `component.json` revision is used:**
    - `deployment-status` reads the **working-tree** file of the mapped clone.
    - `change-risk` and `promote` read it **at the promoted commit** via `git show`. Handling at a commit is the same as for component checklists (requirement 84): a non-canonical file is used and reported, and an invalid file is a blocking finding.
    - When the working-tree and promoted-commit versions differ, the report says so and names the differing keys.
31e. *(new)* **Single-repo projects.** `workspace.json`, `component.json`, `repos.local.json` and the checklists sit together in the one repository's `.release-radar/`. The single member's `repoKey` is still mapped explicitly in the repos file (to the repository root relative to the repos file). No special case bypasses the rules in requirements 31b–31d.
31f. *(new)* **Starting location.** The workspace is resolved in this fixed order:
    - (a) an explicit `--workspace <path>`;
    - (b) a `.release-radar/workspace.json` found by searching upward from the current working directory to the git root (outside a git repository, the current working directory only);
    - (c) when the current working directory is inside a member's mapped clone of a registered workspace (found through (d)), that workspace, with that component pre-selected;
    - (d) the per-user workspace index (requirement 31g).

    When several workspaces match, the skill asks the user to choose. When none matches, the skill says so and offers `init-workspace` or registration. It never guesses.
31g. *(new)* **Workspace index.** A per-user file under the plugin data directory (`${CLAUDE_PLUGIN_DATA}/workspace-index.json`; it persists across plugin updates and is never committed) lists registered workspace paths.
    - It is canonical and schema-versioned, and section N applies to it.
    - A workspace is registered the first time it is used or created, after the user confirms.
    - Stale entries (paths that no longer exist, or no longer hold a valid workspace) are reported, and removed only after the user confirms.
    - Engine command: `workspace-index list | register <path> | unregister <path> | resolve <cwd>`, always with an explicit `--index <path>`. The skill supplies the path (requirement 11).
31h. *(new)* **Two init workflows.**
    - `workflows/init-workspace.md`, run in the orchestration or single repo, writes `workspace.json`, the repos file and the `.gitignore` lines.
    - `workflows/init-component.md` writes `component.json` (and optionally a `checks.md` skeleton) in a member's working tree. It uses `discover` and read-only Azure DevOps lookups, and drafts only from discovered or user-confirmed facts.

    Both write only after explicit user confirmation, write through `format`, end with `validate-config`, and never commit. The user manages git in member repositories.
32. **Promotion block** (in `workspace.json`, per stage):
    - `mode` is one of:
      - `pipeline`: the operator's team may trigger it, if it owns the stage;
      - `handoff`: another team promotes, and the operator prepares a package;
      - `manual`;
      - `none`.
    - `owner` is a free-text team label.

    A stage is **triggerable** only when `mode == "pipeline"` **and** `owner == operatorTeam`.
33. **Pipeline mapping** *(amended: lives in `component.json`; `landedWaitMinutes` added)*, per target. Both shapes are supported: several pipelines per target, and one pipeline with an action-selecting choice parameter. A mapping contains:
    - `provider: "azure-devops"`;
    - `project`;
    - the pipeline `id` and/or `name`;
    - `ref`;
    - a **parameter template**: parameter name → literal, or a placeholder from a closed documented set (`{commit.sha}`, `{commit.shortSha}`, `{image.repository}`, `{image.tag}`, `{component}`, `{target}`);
    - **declared actions**: name → the parameter values the action sets, plus a `kind` of `build` or `configuration`;
    - a required `primaryAction`;
    - a required **`landedWaitMinutes`** (requirement 63).

    Unknown placeholders, undeclared parameters and undeclared actions are invalid (exit 24), and so is a mapping on a stage that is not `pipeline`. Templates must not contain secret values.
34. **Immutable parameters.** Every parameter value comes from the template and the declared action. None can be edited at preview time; changing a value means changing the committed `component.json`. A parameter may be declared `userSelectable` with a **closed list of allowed values**. It is then chosen before the preview and bound into the confirmation token.
35. **Handoff artefacts** *(amended: live in `component.json`)*, only on `handoff` stages:
    - the image reference (`repository:tag`, plus the digest when known);
    - one or more settings-file paths, read at the promoted commit;
    - an optional per-stage `beforePromote` pointer, which overrides nothing in the workspace; both are shown.

    A path missing at the promoted commit is a blocking finding, not a config error.
36. **Repos file** *(amended wording)*. Per-machine clone paths live in the workspace's `.release-radar/repos.local.json` (gitignored, with a `schemaVersion`). The file maps `repoKey` → path, resolved relative to the repos file. Alternatively, `workspace.json` points at an **externally owned** repos file of the same mapping shape, which release-radar validates but never rewrites (requirement 82).
37. **Strict validation, no fallbacks** *(amended; monorepo rule)*:
    - Missing and unknown keys are fatal (exit 24) and the error names the file and key.
    - **Entries with the same name or id but different content** are fatal. Byte-identical duplicate entries are not fatal: they are non-canonical and are de-duplicated by `format` (requirement 81).
    - Workspace and component consistency:
      - targets on stages the workspace does not declare;
      - the reserved `local` stage name;
      - a stage omitted in `component.json` without an explicit `null`/empty;
      - a `component.json` `name` that differs from its member;
      - **two members with the same `repoKey` and the same normalised `repoSubdir` location** (pointer at the later member's `repoSubdir`). Several members sharing a `repoKey` with different `repoSubdir` values is valid (requirement 31c);
      - an empty-string `repoKey`;
      - a `repoSubdir` without a `repoKey`.
    - Non-positive timeouts, counts, intervals, retention values and `landedWaitMinutes` are fatal.
    - Unknown adapter, mode, provider, action-kind, check-type or severity values are fatal.
    - A missing or unsupported `schemaVersion` is fatal.
    - A mapping or artefact on the wrong mode is fatal.
    - A `promotion.owner` without an `operatorTeam` is fatal.
    - A missing `primaryAction`, or a `primaryAction` that is not declared, is fatal.
    - A verification check with a method other than GET or HEAD, or with an inline header value, is fatal.
    - A configured checklist path that does not exist is fatal.

    A member that is unmapped or unavailable is governed by requirement 31c, not by this list.
38. `.release-radar/snapshots/`, `.release-radar/handoff/`, `.release-radar/quarantine/` and `.release-radar/repos.local.json` must be gitignored in the workspace repository. `init-workspace` proposes these lines and adds them only after the user confirms.
39. **Retention** is part of cleanup (requirement 81). The engine keeps the newest `snapshotRetention` snapshots and `handoffRetention` packages and deletes only older ones that it created itself and that carry a supported `schemaVersion`.

### F. Real-world verification (per application)
40. **The `verification` block** *(amended: lives in `component.json`)* is declared per stage, and can be narrowed to a single target. It states how that application is proven to work in the real world:
    - a required block-level `timeoutSeconds` that every check in the block uses, unless the check sets its own `timeoutSeconds` (documented semantics, not a fallback);
    - one or more **HTTP checks**: URL; method `GET` or `HEAD` only; expected status (one value or a list); optional `headers` map of header name → `{ "env": "<ENV_VAR_NAME>" }`. Header values come only from named environment variables and are never written inline;
    - an optional **version check**: URL (GET), a JSON path or regex that extracts a value, and `compare: "commit" | "tag"`. The extracted value must equal the expected deployed version;
    - an optional **smoke command**: an argv array executed without a shell, expected exit 0, with the same read-only disclaimer as the `command` adapter.
40a. *(new)* **Stages not owned by `operatorTeam`** run only HTTP and version checks. Smoke commands run **only on stages owned by `operatorTeam`**, and there is no per-run override. A smoke command declared on a stage the team does not own is reported as "not run (stage not owned)". An explicit request to run it is refused with exit 26.
41. **Outcome per check** *(amended)*:
    - **PASS** when the expectation is met;
    - **FAIL** when the endpoint or command answered but the expectation was not met (wrong status, version mismatch, non-zero exit);
    - **UNREACHABLE** when no answer was obtained (DNS failure, connection refused, TLS failure, timeout, command not found).

    UNREACHABLE is never reported as FAIL. Any FAIL gives exit 28. At least one UNREACHABLE with no FAIL gives **exit 30 (verification inconclusive)**.
42. **Version comparison:**
    - `tag`: exact string equality.
    - `commit`: equal when one value is a prefix of the other and the shorter one has at least 7 hex characters.

    The expected value is the commit or tag the target is reported to run (from `status`), or `--expect` when given (`promote` passes the commit or tag it just built).
43. **Recorded results.** Each check's outcome, HTTP status or exit code, latency, and extracted version value go into the report and the snapshot. Response bodies, header values and command output beyond the exit code are never stored or printed.
44. When a component or stage has no `verification` block, the report states **"no real-world verification configured"**. Nothing is invented or inferred.
45. Verification runs only when it is asked for (`status --verify`, `verify`, `/deployment-status … --verify`, or natural language), and automatically as part of `promote`'s landed proof (requirement 63).

### G. Engine report content
46. For each component, stage and target:
    - status (`found` / `missing` / `not-deployed`), state and image;
    - last-modified, labelled as an **upper bound**;
    - the resolved commit (`sha`, `date`, `subject`, HEAD relation `at-head` / `behind N` / `not-ancestor`) or a non-resolved status (`no-clone`, `tag-not-found`, `digest-pinned`, `no-convention`, `git-error`);
    - the promotion mode, owner and triggerability;
    - verification results, when verification ran.
47. **Drift gate (`--fail-on-drift`, exit 22)** trips on within-stage inconsistency and on pipeline/target drift. It also trips on a non-`equal` cross-stage delta, but only for stage pairs named explicitly (e.g. `--fail-on-drift stage-1:stage-2`).
48. **Pipeline-run facts**, unless `--no-pipelines` is passed: the latest `runHistoryCount` runs per pipeline-mapped target, each with run id, state/result, times, source ref and commit, action, pushed image tag (`undetermined` when it cannot be derived from parameters or the convention; never guessed) and a link.
49. **Pipeline/target drift:** the latest succeeded *build-kind* run built X, but the target runs Y. Which one is newer is decided by ancestry. An in-progress run is not drift.
50. **Snapshots** *(amended)*: every `status` run that produces a report (exit 0, 22, 23, 28 or 30) writes `<workspace>/.release-radar/snapshots/<timestamp>.json` in canonical form. Each snapshot holds:
    - the full JSON report, including pipeline-run facts and any verification results;
    - `schemaVersion`;
    - the engine version;
    - the time;
    - the components;
    - each member's availability;
    - a fingerprint computed over the **canonical form of the workspace plus each `component.json` used, at the revision used** (working tree or commit), so that re-formatting invalidates nothing and a real config change does.

    Runs ending in 20, 21, 24, 29 or 64 write none. Snapshots never hold secret values.
51. **Within-stage consistency** across several targets of one component in a stage (e.g. `api`, `api-internal`, `api-mobile`) is judged by digest where available, otherwise by repository + tag, and every target that differs is named.
52. **Cross-stage comparison:** equal digests are proof of the same build. Tags alone prove nothing either way.
53. **Promotion deltas**, computed by the engine, for each neighbouring pair along `local HEAD → stage 1 → …`:
    - the downstream..upstream range, with a count and a list;
    - an ancestry verdict: `equal` / `behind N` / `ahead` / `diverged` / `unknown` with a reason.

    "Local" means the clone's HEAD as of its last fetch; no fetch is performed. **When a stage is internally inconsistent**, a delta is computed for each distinct commit and the pair is flagged "inconsistent stage". `change-risk` and `promote` then refuse a single verdict or run until the user picks a target.
54. **Fleet summary (`--all`)** *(amended)*: one row per member, with each stage's short commit or tag, the consistency flag, pending counts, non-running or missing targets, the latest pipeline result, pipeline/target drift, the verification outcome when it ran, and **unavailable members** with their reason (`no local clone` / `no component config`).
55. The `--json` output carries `schemaVersion` and is an additive contract (fields are only added within a major version), documented in `references/`.
56. **`settings-diff`:** a structural, key-level comparison of each declared settings file between the downstream stage's deployed commit and the promoted commit. It reports:
    - added keys;
    - removed keys;
    - probable renames;
    - keys whose value changed (**without the value**);
    - added, removed or renamed Key Vault-style secret-reference names;
    - file added or removed;
    - files that cannot be parsed (line-count summary only).

### H. `deployment-status` skill (read-only)
57. Steps *(amended)*:
    1. **Resolve the workspace** (requirement 31f), then run the canonical-file gate (requirement 83) on the workspace, the repos file, the workspace index and each used member's working-tree `component.json`. If there is no workspace, offer `init-workspace`. If a member is unavailable (no component config), offer `init-component` for it.
    2. **Resolve the arguments exactly** (requirement 8).
    3. **Run the engine** and interpret exit codes exactly as in section C. Exit 20 means re-authenticate (`az login`, refresh the kube context, set or renew `AZURE_DEVOPS_EXT_PAT`, set the named verification header variable), never "absent".
    4. **Report** the state per stage and target, the promotion mode, owner and triggerability, consistency, the cross-stage comparison with the digest/tag caveat, deltas grouped by conventional-commit type, pipeline runs and drift, PAT days remaining, the verification results when asked (PASS/FAIL/UNREACHABLE per check, and "not run (stage not owned)" for smoke commands), and unavailable members.
    5. **Visible degradation:** no clone; tag not found (recommend, never run, `git fetch --tags`); digest-pinned; git error; not-ancestor; not deployed by design; pushed tag undetermined; "no real-world verification configured"; "pipelines omitted (--no-pipelines)"; member unavailable.
    6. **Answer:** a one-line verdict, then sections, or the fleet table plus exceptions. The answer is given in the conversation. If the user asks for a report file, the engine writes it in canonical form (requirement 78).
57a. *(new)* After a workspace is first used or created successfully, the skill offers to register it in the workspace index. Registration happens only after the user confirms (requirement 31g).

### I. `change-risk` skill (read-only)
58. Steps *(amended)*:
    1. **Resolve the workspace** (requirement 31f) and run the canonical-file gate (requirement 83) on the workspace, the repos file, the fleet checklist and any snapshot it will read. The member's `component.json` and component checklist are read **at the promoted commit** (requirements 31d and 84). Any difference from the working-tree `component.json` is stated.
    2. **Settle the target:** a promotion between stages (including `local` → first stage), or an explicit range or branch (no workspace or deployment data needed). A **PR** is accepted only through refs available locally. If they are missing, the skill asks the user to fetch. Optionally it may use a read-only `gh pr view --json baseRefOid,headRefOid` when `gh` is installed and authenticated, labelled as a network read.
    3. **Freshness:** use the newest snapshot only if it is younger than `freshnessMinutes`, covers the component and matches the fingerprint (requirement 50). Otherwise run `deployment-status` first. State the snapshot's age. Pipeline facts follow the same rule.
    4. **Enumerate** with `git log --stat <range>` and inspect suspects with `git show` / `git diff`.
    5. **Detect the stack** at the promoted commit.
    6. **Generic checks:**
       - (a) new or renamed required config: **boot-blocking, highest severity**;
       - (b) contract changes;
       - (c) dependency changes. Each added or bumped dependency is listed with its old and new version from `git diff`. Advisories are looked up only through read-only means that do not modify the working tree. A dependency whose advisory status could not be determined is marked **"unverified"**, never "clean". HIGH-or-above advisories are flagged;
       - (d) build, Dockerfile, base-image and context changes;
       - (e) data, migration and cache-key changes.
    7. **Settings-file diffs** for every declared settings file when the target stage is `handoff`. Added keys and new secret-reference names become "receiving team must provide/configure" findings. Removals and renames are flagged for coordination. Values are never shown.
    8. **Checklist layers**, applied as generic → fleet → component (`.release-radar/checks.md` at the promoted commit via `git show`, under `repoSubdir` when set; requirement 84). Each finding names its layer, and a missing layer is stated.
    9. **Evidence per finding:** severity, the commit, `file:line`, why it could break, what to prepare. Secret names only.
    10. **Verdict per promotion:** *safe to promote* / *needs preparation (list)* / *do not promote until X*, together with the target stage's promotion mode and owner and the `beforePromote` pointer(s).

### J. `promote` skill (the only mutating skill)
59. **Path selection by stage mode** *(amended)*, after resolving the workspace (requirement 31f), running the canonical-file gate (requirement 83), and reading the member's `component.json` at the commit to be promoted (requirement 31d):
    - `pipeline` + `owner == operatorTeam` → run path;
    - `handoff` → package path;
    - anything else → refusal that names the owner and mode and offers the read-only reports (plus a package when the mode is `handoff`).
60. **Run path.** Each step is a hard gate:
    1. Resolve the component, stage and action exactly. An omitted action means the mapping's `primaryAction`, and the preview shows it. Undeclared actions are refused (exit 26). `userSelectable` parameters are chosen from their closed lists.
    2. **Refresh unconditionally**, ignoring `freshnessMinutes`: run `deployment-status` for the target, then `change-risk` for the promotion.
    3. Run `pipeline-preview`. It shows: organization, project, pipeline (id and name), ref, **every parameter name and value**, the action and its kind, **the commit that will be built**, whether that commit exists on the remote ref, the image repository and tag it will push (build kind), the target, the change-risk verdict and its blocking findings, the verification that will be run afterwards (or "no real-world verification configured"), and a confirmation token.
    4. Show the preview verbatim and ask for explicit confirmation of **this one run**.
    5. **"Do not promote" override.** When the verdict is *do not promote until X*, the run is allowed only after a separate, explicit acknowledgement of each blocking finding. The acknowledgement is recorded in the answer. It never bypasses the ownership or mode gates.
    6. Only after confirmation, call `run-pipeline --confirm <token>`.
    7. **Never auto-retry.** Each further run needs a new preview and a new confirmation.
    8. Follow the run read-only (`pipeline-run --follow`, bounded by `followTimeoutMinutes`). If the run is waiting on an approval or check, report who or what it is waiting for and stop following. Never approve. A failed run is reported with its link (exit 25), and nothing further is done.
    9. **Landed proof** (requirement 63).
61. **Binding the built commit** *(amended)*.
    - Where the pipeline allows it, the run is pinned to the previewed commit SHA through the Runs API's repository resource version.
    - Otherwise the engine re-reads the remote ref head immediately before queueing, through the **Azure DevOps Git Refs REST API with the same PAT**, and refuses with exit 27, without sending the write, if the head differs from the preview.
    - The preview's "commit exists on the remote ref" check uses the same Git Refs call.
    - An unpushed local commit is shown as not buildable.
62. **Configuration-only actions** (`kind: configuration`) for a dev-owned stage are allowed under identical gates (preview, confirmation, token, no retry). Their landed proof is the run result, plus a `deployment-status` showing the **unchanged** image, plus the configured verification. It is reported as **"configuration applied; image unchanged"**.
63. **Landed proof** *(amended)*.
    - **Build kind:** after a succeeded run, `promote` polls `status` for the target at `followPollSeconds`, within the mapping's required `landedWaitMinutes`, until the target runs the expected commit or tag (or the pushed digest). If the window expires, the result is **not landed**. Once landed, the target's verification runs **once**, never retried, with `--expect` set to the built version.
    - **Outcomes:**
      - **landed and verified:** image matches and all checks PASS;
      - **landed, verification failed:** any FAIL (exit 28; name the failed checks);
      - **landed, verification inconclusive:** UNREACHABLE checks and no FAIL (exit 30);
      - **landed, no real-world verification configured;**
      - **not landed:** pipeline/target drift or the window expired; report what the target runs instead.
64. **Package path (handoff, no triggering):**
    1. Refresh deployment data and run `change-risk` as in requirement 60 step 2.
    2. Run `handoff-package`. It writes `<workspace>/.release-radar/handoff/<component>-<stage>-<timestamp>/` with a canonical manifest, the image reference and digest (or "digest unknown"), each declared settings file **copied verbatim** at the promoted commit, and the settings diffs. The manifest records each copy's sha256 and source commit.
    3. The skill adds the change-risk report, the `beforePromote` pointer(s) and the receiving owner.
    4. When a settings value looks like a literal secret rather than a secret reference, the skill warns **by key name**.
    5. File contents are never printed in chat, and nothing is sent or triggered.
65. `promote` never edits configuration files or pipeline definitions, never cancels or approves runs, and never acts on more than one target or action per confirmation.

### K. Azure DevOps client and `run-pipeline` gate (engine)
66. **REST calls** *(amended)*:
    - **Read:**
      - list runs;
      - get run;
      - **Pipelines Get, which proves only that the pipeline exists and identifies it**;
      - **Git Refs** (the remote-head check, requirement 61).
    - **Write:** queue a run, reachable **only** from `run-pipeline`. Tests assert that no other path reaches it.

    The Azure DevOps REST API offers **no server-side parameter validation**: Pipelines Get returns no declared parameters, and `previewRun` is a POST. `pipeline-preview` therefore validates parameters **locally** against the component's template and declared actions. Evidence: `release-radar-docs/research/azure-devops-pipelines-rest.md` §3.1.
67. `pipeline-preview` emits the resolved request and a confirmation token bound to: organization, project, pipeline, ref, every parameter value, commit, target, action and selected `userSelectable` values. The token expires after `confirmTokenTtlMinutes`. `run-pipeline` recomputes the request and refuses with exit 27, **without sending any write**, on a missing, mismatched or expired token.
68. `run-pipeline` refuses with exit 26, without sending any write, when the stage is not triggerable, the target has no mapping, or the action is undeclared.
69. `run-pipeline` sends exactly one queue request and never retries. With `--follow` it polls read-only until the run completes or the timeout passes. A timeout is reported as "still running", not as a failure.
70. **PAT scopes** *(amended)*. Documentation states the scopes required:
    - **Build (Read)** and **Code (Read)** for the read features. Code (Read) is needed for the Git Refs remote-head check.
    - **Build (Read & execute)** additionally, only for `run-pipeline`.

    It recommends a separate read-only PAT for users who will not trigger runs.

### L. Hard rules
71. `deployment-status` and `change-risk` are strictly read-only towards every remote system: no fetch, pull, checkout, deploy, cloud write, pipeline queue, or non-GET/HEAD application request. They may recommend, never perform. Their only local writes are engine snapshots, the lossless canonical re-formatting and cleanup in section N, workspace-index registration after confirmation, and init-workflow writes after confirmation.
72. `promote` performs at most one remote mutation per confirmation: the queued run. That run is always preceded by a fresh risk verdict, an exact preview and explicit confirmation, plus an acknowledgement of each blocking finding when the verdict is "do not promote". Other teams' stages and non-pipeline stages are never triggered.
73. Secret, token, credential, header and settings values are never recorded or echoed in chat, snapshots, reports or docs. The only exception is that handoff packages carry the declared settings files verbatim, because those files are the artefact the receiving team needs. Names are the most detail allowed.
74. No component, stage, target, pipeline, parameter, action, endpoint, repository or resource name is ever invented. Each comes from the workspace, a member's `component.json`, the repos file, the engine, git, Azure DevOps reads, or user confirmation.

### M. Tests
75. The suite lives in `engine/test/` and runs with `npm --prefix plugins/release-radar/engine test`. It uses the Node built-in test runner, fake CLI shims (`az`, `kubectl`, `docker`, an arbitrary command, a smoke command), a fake Azure DevOps REST server and a fake HTTP application server, all local. Everything runs offline, and no real source, organization or application is contacted.
76. Minimum coverage *(amended: exit codes 20–30; Git Refs; smoke ownership)*, at least the original 51-test App Service suite's behaviours, plus:
    - **Parsing and config:**
      - image parsing edge cases;
      - every rule in requirement 37;
      - repo paths and `repoSubdir`;
      - each tag convention and the per-component override;
      - `tag-not-found`, `no-clone`, `git-error`;
      - HEAD relations.
    - **Adapters and exit codes:**
      - each adapter's success, auth failure, missing CLI, source error, missing target and normal read;
      - App Service ambiguity, stopped and non-container targets;
      - every exit code 0/20–30/64, and the precedence order in requirement 20.
    - **Report and outputs:**
      - stage deltas (`equal`, `behind`, `ahead`, `diverged`, `unknown`) and inconsistent-stage deltas;
      - multi-target consistency;
      - `--all`, `--stage`, `--no-pipelines`;
      - the `--json` contract;
      - snapshots, including the workspace-plus-components fingerprint;
      - `discover`, `validate-config` and `where`;
      - `settings-diff` (no values in the output).
    - **Pipelines:**
      - run listing and pushed-tag determination;
      - pipeline/target drift and in-progress runs that are not drift;
      - drift gate variants;
      - PAT absent (no request sent), invalid (401/403/203) and expired → exit 20.
    - **Run gate:**
      - preview → run with a valid token (exactly one POST with the exact parameters, primary action when none is given, `userSelectable` bound);
      - local parameter validation against the template and actions;
      - Pipelines Get used for existence only;
      - mismatched or expired token → exit 27 with zero POSTs;
      - remote head moved (Git Refs) → exit 27 with zero POSTs;
      - non-triggerable stage, another team's stage, undeclared action → exit 26 with zero POSTs;
      - failed, canceled and partially-succeeded run → exit 25;
      - follow timeout and approval wait;
      - landing window expiry → "not landed";
      - configuration-kind action reported as "configuration applied; image unchanged";
      - **every read-only command issues zero non-GET requests to the REST server and zero non-GET/HEAD requests to the application server**.
    - **Verification:**
      - PASS, FAIL (status mismatch, version mismatch, smoke non-zero) and UNREACHABLE (refused connection, timeout, missing command), with UNREACHABLE never counted as FAIL;
      - UNREACHABLE-only → exit 30;
      - commit prefix rule and tag equality;
      - header from env var sent;
      - missing header env var → exit 20 before any check;
      - smoke command on a stage not owned by `operatorTeam` is not run, and an explicit request is refused with exit 26;
      - "no real-world verification configured";
      - verification results in snapshots.
    - **Secrets:** the PAT and header values never appear in stdout, stderr, snapshots or packages.
    - **Handoff:** `handoff-package` contents, including manifest hashes.
    - **Canonical files:** every item in requirement 86.
76a. *(new; amended: monorepo cases)* Workspace-model coverage:
    - **Member resolution:**
      - mapped and available;
      - `repoKey` unmapped → `unavailable (no local clone)`;
      - clone path absent → `unavailable (no local clone)`;
      - `component.json` absent → `unavailable (no component config)`;
      - each of the above is non-fatal in a fleet run and exit 24 when that member is requested specifically;
      - `name` mismatch → 24;
      - undeclared stage in `component.json` → 24;
      - **monorepo:** two members on one clone (same `repoKey`) with different `repoSubdir` values (and, as a variant, one of them at the root with `repoSubdir: null`) both load from their own `.release-radar/component.json` and report independently;
      - **same-location duplicate:** two members with the same `repoKey` and the same normalised `repoSubdir` location (including equivalent spellings such as a trailing separator or a `./` prefix) → exit 24, with the pointer at the later member's `repoSubdir`;
      - a repository that is not a member, and that contains a `component.json`, is never read;
      - a worktree-like sibling folder containing an identical `component.json` is never read (proven by a read-tracking fixture).
    - **Revisions:** the working-tree `component.json` is used by `status`. The promoted-commit `component.json` is used by the `change-risk`/`promote` paths. Differences between the two are reported. A non-canonical file at a commit is used and reported; an invalid one is a blocking finding.
    - **Workspace index:** register, list, unregister, `resolve` in the order (a)–(d) (requirement 31f), with cases for a cwd inside a member clone (component pre-selected), stale entries reported and not removed, multiple matches (listed, nothing chosen), and no match.
    - **Single-repo project:** `workspace.json`, `component.json` and the repos file in one `.release-radar/` resolve and report correctly.
    - **Explicit paths:** `--config` is rejected (exit 64) and `--workspace` is required.
77. Fixtures, git repos, pipeline data and application responses are synthetic and created in temporary directories.

### N. Canonical structured files
78. **One canonical form per file** *(amended: list extended)*. Every structured file that the plugin creates, or that the skills read, has exactly one canonical, machine-checkable form with a declared `schemaVersion`, documented in `references/file-formats.md`. The files in scope:
    - `.release-radar/workspace.json`;
    - every member's `.release-radar/component.json`;
    - `.release-radar/repos.local.json`;
    - the per-user workspace index;
    - the fleet checklist and every component checklist;
    - snapshots;
    - handoff-package manifests;
    - any verification or report file written on request.

    Skills never hand-write a structured file. Anything they create or change is written through the engine and leaves the write in canonical form.
79. **Canonical JSON:**
    - key order fixed by the schema;
    - 2-space indentation, LF line endings and a single trailing newline;
    - no comments (a file with comments is `invalid`, with the location);
    - arrays in schema-defined order:
      - **sorted** where order carries no meaning (e.g. members by name, targets by name, checks and actions by name, repos-file entries by key, index entries by path), with the sort key declared in the schema;
      - **preserved** where order carries meaning (e.g. stages, argv arrays, expected-status lists as written).
80. **Canonical checklists** *(amended: format confirmed)*. Checklists (`checks.md`) use a strictly structured Markdown grammar that the engine parses and re-renders. **Structured Markdown is the confirmed format** (formerly Open Question 6).
    - **Header:** a fixed header line, then a `schemaVersion` field.
    - **Items:** one item per `## <id>` heading, with items sorted by `id`. Each item has exactly these fields, in this fixed order, as `- <field>: <value>` lines:
      - `layer` (`fleet` | `component`; it must match the file's location);
      - `severity` (`blocker` | `high` | `medium` | `low` | `info`);
      - `paths` (comma-separated globs);
      - `signal`;
      - `prepare`. Multi-line values use a fixed continuation indent.
    - **Rejected input:** free prose outside this grammar, an unknown field, a missing field or a duplicate `id` with different content makes the file `invalid` (exit 24, with the line).
81. **`format` and `format --check`.** Each command parses each target file, validates it against its schema, and renders it canonically.
    - **`format --check` reports one of three states per file:**
      - `canonical`;
      - `non-canonical (hand-edited)`, which exits 29;
      - `invalid`, which exits 24 and gives the exact location: file plus JSON pointer, or file plus line and column.
    - **Normalization is lossless.** The parsed semantic content before and after is identical, apart from (a) the canonical ordering of arrays whose order has no meaning, and (b) the removal of byte-identical duplicate list entries, each of which is reported. `format` never drops, invents or defaults a value. Anything it cannot place (unknown key, same id with different content, malformed item, unsupported `schemaVersion`) makes the file `invalid`. It never silently fixes anything.
    - **`format` without `--check`** rewrites non-canonical valid files in place and prints a per-file summary of what changed: keys reordered, whitespace normalized, arrays sorted, duplicates removed, checklist items normalized. It leaves invalid files untouched (exit 24).
    - **Cleanup**, performed by `format`, covers:
      - canonical ordering and whitespace;
      - de-duplication of exact-duplicate list entries (reported);
      - pruning snapshots and handoff packages beyond `snapshotRetention` / `handoffRetention`;
      - moving orphaned engine files to `.release-radar/quarantine/`, with a report and never a silent deletion. Orphans are engine-written files with an unknown or unsupported `schemaVersion`, or files in engine directories that do not match the engine's naming pattern.

      Stale workspace-index entries are only reported. They are removed through `workspace-index unregister` after confirmation (requirement 31g). Deleting anything else is out of scope.
82. **Files release-radar must not rewrite** *(amended)* are validated but never re-formatted or deleted:
    - (a) the settings-file copies inside handoff packages. They must stay byte-identical to the promoted commit. `format --check` verifies them against the sha256 values in the manifest and reports a mismatch as `invalid` ("copy differs from <commit>"); the remedy is to re-run `handoff-package`;
    - (b) an externally owned repos file referenced by the workspace, which other tools may share. It is reported as "externally owned — not re-formatted";
    - (c) any `component.json` or checklist read at a commit through `git show`. History is never rewritten.
83. **The canonical-file gate in every skill** *(amended: exit 29 on non-canonical input confirmed)*. The first engine step of every skill is `format --check` on the files it is about to use.
    - **`non-canonical`:** the skill runs `format` on those files (requirement 83a covers files in member repositories), shows a short summary of what changed, and proceeds.
    - **`invalid`:** the skill stops and shows the exact problems for the user to resolve.

    Engine-written files (snapshots, handoff manifests, report files, the workspace index) are always written canonically. Hand edits to them are detected the same way, and re-formatted when valid or reported when not. All other engine commands **refuse non-canonical input with exit 29**, naming the file and telling the user to run `format` (formerly Open Question 7).
83a. *(new)* **Re-formatting files in member repositories.** A non-canonical working-tree `component.json` or `checks.md` in a member's repository is re-formatted only after the user confirms once for that run, with the files listed. The user manages git in those repositories, and the skill never commits. Files in the workspace repository and engine-owned files are re-formatted automatically, as in requirement 83.
84. **Component files at a commit** *(amended: covers `component.json` as well as checklists)*.
    - **Valid but non-canonical:** the file is used, and the report says it is "non-canonical at <sha>". The skill offers to run `format` on the member's working-tree copy (requirement 83a).
    - **Invalid:** the file becomes a blocking finding, "<file> invalid at <sha>: <location>", and the verdict cannot be *safe to promote*. For `promote`, the run path is refused until the file is fixed.
85. **Canonical rendering is deterministic.** The same semantic content always renders to the same bytes, regardless of the input's formatting, platform or engine run.
86. **Required tests:**
    - round-trip idempotence, `format(format(x)) == format(x)`, for every file type in requirement 78 (including `workspace.json`, `component.json` and the workspace index);
    - valid hand-edited fixtures (reordered keys, odd whitespace, unsorted unordered arrays, duplicate identical entries, checklist field-order and indentation variations) normalize to the exact canonical bytes with no semantic diff;
    - invalid fixtures (unknown key, same id with different content, malformed checklist item, comments in JSON, unsupported `schemaVersion`) exit 24 and report the exact location;
    - every engine-written file passes `format --check` as `canonical` straight after it is written;
    - retention pruning keeps exactly the configured counts, and orphan files are moved to `quarantine/` and reported, never deleted;
    - verbatim handoff copies are never re-formatted, and a modified copy is `invalid`;
    - an externally owned repos file is never rewritten;
    - files read at a commit are never rewritten;
    - non-`format` commands exit 29 on non-canonical input;
    - re-formatting the workspace or a `component.json` does not change the snapshot fingerprint.

## Constraints
- **Public repository.** No organization- or originating-project-specific identifiers in `plugins/release-radar/` or `release-radar-docs/`: no company names, subscription or tenant IDs, resource, webapp, pipeline, endpoint, repository or component names, Azure DevOps organization or project names, registry hosts, issue numbers, internal skill names, real run output or local paths. The motivating lifecycle and workspace layout are described only generically. Examples are synthetic (`acme-platform` as the orchestration repo, `acme-api`, `qa`, `production`, `https://dev.azure.example/acme`, `https://acme-api.qa.example.com/health`, `registry.example.com`).
- **Configs live in one place.** A component's configuration exists only in its own repository. The workspace holds only fleet-level settings and the member list. Repositories are located only through the repos file, and never by scanning.
- **Safety model.** The read-only skills never mutate any remote system. `promote` mutates only by queuing a configured run, only for a dev-owned `pipeline` stage, only after a fresh change-risk verdict, an exact preview and per-run confirmation (plus a per-finding acknowledgement when the verdict is "do not promote"), and the engine enforces this with the confirmation token. No auto-retry. No approvals. Application endpoints only ever receive GET or HEAD. Smoke commands only run on owned stages.
- **Structured-files rule.** Every generated or consumed structured file is canonical and schema-versioned. Hand edits trigger lossless re-formatting, or a precise `invalid` report. Nothing is ever silently fixed or deleted.
- **Global no-fallback rule.** Missing configuration or credentials fail with a specific exit code. Nothing is defaulted. Documented semantics, such as an absent override meaning "use the stage convention", are not fallbacks.
- **Expiring credential rule.** `AZURE_DEVOPS_PAT_EXPIRES` is supported, and a warning is given within `patExpiryWarningDays`.
- **Language and dependencies.** TypeScript only, with zero runtime dependencies (including the Markdown checklist parser and the canonical JSON renderer). Dev dependencies are vetted for HIGH-or-above advisories before pinning (caret range), the audit must report zero advisories, and the vetting date is logged in `release-radar-docs/`.
- **Committed `dist/`** stays in sync with `src/`. A clean rebuild must produce no diff.
- **Layout.** The approved layout stands, plus the additions in Assumption 8. Engine tests live in `engine/test/`, a deliberate exception to the general `test_scripts/` convention.
- **Marketplace conventions** for manifests, changelogs (major = removed or renamed skill or a breaking workflow change; minor = new skill or capability; patch = docs or fix), skill structure and README.
- **Plugin development is fixture-based.** No real CLI, Azure DevOps organization or application is contacted, and no real pipeline is queued, during development or testing.
- **No version control** in this request, including in member repositories.
- **Runtime prerequisites** documented for users: Node >= 20, `git`, the CLIs of the configured adapters, `AZURE_DEVOPS_EXT_PAT` (Build Read + Code Read; plus Build Read & execute for `run-pipeline`) only when pipelines are configured, and the named header variables only when verification uses them.

## Acceptance Criteria
1. `plugins/release-radar/` exists with the layout in "In scope". `plugin.json` and the `marketplace.json` entry are valid and share the same `version` (`0.1.0`). The README has the `release-radar` section (install command, three skills with invocation shapes, workspace/member model, verification, canonical files, mutation-boundary statement) and the Layout tree.
2. Each `SKILL.md` documents its invocation shape (requirement 7, including `--workspace`), natural-language equivalents and the namespaced `/release-radar:<skill>` form. `/promote <component> <stage>` resolves to the mapping's `primaryAction`, and `/promote <component> <stage> <action>` to a declared action.
3. `npm --prefix plugins/release-radar/engine run build` succeeds, and a clean rebuild leaves `dist/` unchanged. `engine/.gitignore` contains `node_modules/`.
4. `engine/package.json` has no runtime `dependencies`, the audit reports zero advisories, and the vetting log entry exists.
5. `npm --prefix plugins/release-radar/engine test` passes offline and covers every item in requirements 76, 76a and 86, with at least 51 tests.
6. *(amended)* Every exit code (0, 20–30, 64) has at least one asserting test, and the precedence order 64 > 24 > 29 > 20 > 26 > 27 > 21 > 25 > 23 > 28 > 30 > 22 is tested. Auth failure is proven to yield 20, never 23, "no runs" or FAIL. UNREACHABLE is proven never to yield 28, and UNREACHABLE-only is proven to yield 30.
7. **Safety (mutation boundary):** tests prove that:
   - (a) only `run-pipeline` ever issues a non-GET request to Azure DevOps;
   - (b) no command issues a non-GET/HEAD request to an application endpoint;
   - (c) a missing, mismatched or expired token, or a moved remote head (Git Refs), sends zero writes (exit 27);
   - (d) `handoff`/`manual`/`none` stages, other teams' `pipeline` stages and undeclared actions send zero writes (exit 26);
   - (e) a valid run sends exactly one queue request with exactly the previewed parameters;
   - (f) a failed run is not retried.
8. **Safety (confirmation):** `promote/SKILL.md` and `references/safety-gates.md` require, for every run, a fresh `deployment-status` + `change-risk`, the complete preview (requirement 60 step 3) and explicit confirmation of that single run. On a "do not promote" verdict they also require a separate acknowledgement of each blocking finding, recorded in the answer, and they state that this acknowledgement never bypasses the ownership or mode gates.
9. **Safety (ownership):** docs and tests show that another team's stage is never triggerable, that `promote` on such a stage refuses and names the owner (plus a package when the mode is `handoff`), and that smoke commands never run on stages the team does not own (requirement 40a).
10. **Safety (secrets):** tests prove the PAT and verification header values never appear in any output, snapshot or package, and that `settings-diff` output contains no values. Every SKILL.md states the names-only rule.
11. **Verification:** a component with a `verification` block produces PASS/FAIL/UNREACHABLE per check in the report and snapshot. A component without one is reported as "no real-world verification configured". `promote`'s landed proof polls within `landedWaitMinutes`, runs verification once with the built version as `--expect`, and reports one of the five landed outcomes in requirement 63.
12. A configuration-only action is shown in the preview, gated identically, and reported as "configuration applied; image unchanged".
13. `references/adapters.md` states the fixture provenance of every adapter and of the Azure DevOps client (requirement 30).
14. Pipeline awareness: "latest succeeded build run built X, target runs Y" yields a drift finding, and an in-progress run does not.
15. `change-risk` into a `handoff` stage includes the settings-diff findings, and dependencies whose advisory status could not be determined are labelled "unverified".
16. Config-strictness tests cover every rule in requirement 37 (exit 24, naming the file and key), and no test observes a defaulted value.
17. *(amended)* Snapshot tests: a file is written on 0/22/23/28/30 and not on 20/21/24/29/64. It contains `schemaVersion`, the engine version, the time, the components, member availability, the workspace-plus-components fingerprint, the pipeline facts and the verification results.
18. **Canonical files: round-trip.** `format(format(x)) == format(x)` holds byte-for-byte for every file type in requirement 78. Valid hand-edited fixtures normalize to the exact canonical bytes with no semantic diff. Invalid fixtures exit 24 with the exact location.
19. **Canonical files: engine output.** Every engine-written file (snapshot, handoff manifest, report file, workspace index, `workspace.json`/`component.json` written by the init workflows) passes `format --check` as `canonical` straight after it is written.
20. **Canonical files: skill gate.** Each `SKILL.md` runs `format --check` as its first engine step on the files it will use. On non-canonical files it re-formats them (with one confirmation for member-repo files) and summarizes the changes. On invalid files it stops and shows the locations. A worked example demonstrates both.
21. **Canonical files: cleanup safety.** Tests prove that cleanup deletes only out-of-retention snapshots and packages, moves orphans to `quarantine/` with a report, never re-formats verbatim handoff copies, externally owned repos files or files read at a commit, and never deletes any other file.
22. *(amended)* Reference docs are complete:
    - `config-schema.md`: every key of `workspace.json` and `component.json`, including lifecycle, members, pipeline, action, `landedWaitMinutes`, handoff, verification and retention keys;
    - `workspace-model.md`: repo-only configs, member resolution, unavailable states, revision rules, starting-location order, the workspace index, the single-repo layout;
    - `exit-codes.md`: all codes and the precedence;
    - `adapters.md`;
    - `verification.md`: check types, outcomes, comparison rules, env-var headers, ownership rule for smoke commands;
    - `file-formats.md`: canonical JSON rules, per-file key order, array ordering, the checklist grammar, the `format` states and cleanup rules;
    - `lifecycle-model.md`, `safety-gates.md`, `handoff-package.md`;
    - `generic-checks.md`, `stack-signals.md`, `checklist-format.md`;
    - the PAT scopes (Build Read, Code Read, Build Read & execute) and the expiry variable.
23. *(amended)* `workflows/init-workspace.md` and `workflows/init-component.md` produce files only from `discover`, read-only Azure DevOps lookups and user confirmation, write them canonically, end with a passing `validate-config`, and never commit.
24. *(amended)* A synthetic end-to-end worked example in `release-radar-docs/` covers:
    - `/deployment-status acme-api --verify` run from the orchestration repo (pipeline runs, drift, verification);
    - `/deployment-status` run from inside the `acme-api` clone (workspace found through the index, component pre-selected);
    - `/deployment-status --all` with one unavailable member;
    - `/change-risk acme-api qa production` (boot-blocking finding, settings-diff findings, checklist layers, working-tree vs promoted-commit `component.json` difference);
    - `/promote acme-api qa` against the fake servers (preview → confirmation → run → follow → landed and verified);
    - `/promote acme-api qa config` (configuration applied; image unchanged);
    - a "do not promote" override with per-finding acknowledgement;
    - `/promote acme-api production` producing a handoff package;
    - a hand-edited workspace file and checklist being re-formatted, plus an invalid file being reported;
    - a single-repo project.
25. `release-radar-docs/` contains the `publish-release` follow-up item (requirement 6).
26. A reviewer-run scan of `plugins/release-radar/` and `release-radar-docs/` against a private denylist of organization and originating-project terms (kept outside the public repo) returns zero matches, and no absolute local path appears.
27. No git operation was performed (in the marketplace or in any member repository), no real Azure DevOps pipeline was queued, and no real application endpoint was contacted as part of this work.
28. *(new)* **Repo-only configs:** tests prove that the workspace never carries component definitions (a workspace containing one is invalid, exit 24), that members are located only through the repos file, and that no directory scanning occurs (a non-member repo and a worktree-like sibling with identical `component.json` are never read).
29. *(new)* **Workspace resolution:** tests cover every step (a)–(d) of requirement 31f, multiple matches (the skill asks), and no match (the skill offers `init-workspace` or registration, never guesses). `SKILL.md` text states the same order.
30. *(new)* **Workspace index:** stored at the path the skill supplies from the plugin data directory, canonical and schema-versioned; registration and stale-entry removal happen only after confirmation, as shown in the worked example.
31. *(new)* **Azure DevOps REST facts:** `pipeline-preview` validates parameters locally (no server-side validation call exists), Pipelines Get is used only for existence, and the remote-head check uses Git Refs with the same PAT. This is documented with a citation of `release-radar-docs/research/azure-devops-pipelines-rest.md` §3.1.

## Assumptions
1. *(superseded by requirements 13 and 31f)* Workspace discovery follows the fixed order in requirement 31f. The engine itself always takes an explicit `--workspace`.
2. **`/deployment-status` with no component** gives the fleet summary, unless the skill was started inside a member clone (requirement 7). This is a read-only argument convention, not a config default, and the answer says so.
3. **`/tool-conventions scaffold` does not apply.** The engine is plugin-embedded, configured by the project's `.release-radar/` files, uses the vendor-canonical Azure DevOps variable and user-named header variables, and is documented in the skills' `references/`.
4. **Component checklist path:** `<repoSubdir>/.release-radar/checks.md` when `repoSubdir` is set, otherwise the repo root.
5. **Development docs** (plan, design, functions, research, pending items, vetting log) live in `release-radar-docs/`, following the user's skill-development rule.
6. **`discover`:** the four CLI adapters support listing. The `command` adapter supports it only when a list command is configured. `init-component` uses `discover` for target candidates.
7. **Source material:** the originating private skill, its development record and worked examples, its engine (source, config, docs) and its 51-test suite are the parity reference. Their locations are deliberately not recorded in this public file; the orchestrating conversation supplies them. The originating engine doc says 48 tests, but the suite has 51.
8. **Layout additions** since the originally approved layout, all following its conventions:
   - `skills/promote/...`;
   - `skills/deployment-status/references/{verification,file-formats,workspace-model}.md`;
   - `skills/deployment-status/workflows/{init-workspace,init-component}.md`, replacing `init-config.md`;
   - `engine/src/{workspace,workspace-index,lifecycle,settings-diff,handoff,verify,format,checklist}.ts`;
   - `engine/src/pipelines/...`;
   - `engine/.gitignore`, which the user approved.
9. **Division of labour:** deterministic facts (runs, settings diffs, package skeleton, preview and token, verification outcomes, canonical rendering, member and workspace resolution) come from the engine. Judgement (risk classification, verdicts, the confirmation conversation) belongs to the skills.
10. **TLS:** verification and Azure DevOps calls use Node's standard trust store. Corporate CAs are supplied through Node's documented `NODE_EXTRA_CA_CERTS` mechanism, which is documented rather than configured by the engine. A TLS failure is UNREACHABLE, or exit 21 for Azure DevOps.
11. **Synthetic examples:** this spec and the plugin docs use `acme-platform` and `acme-api` in place of the user's real orchestration repo and component names, because of the public-repository constraint.
12. **Re-formatting is a local file write, not a "mutation" in the safety-model sense.** The read-only skills may run `format` because it is lossless and limited to release-radar's own files (requirement 82 lists what it never rewrites). It never touches remote systems or git history, and in member repos it runs only after confirmation (requirement 83a).
13. **Pipeline source repositories are Azure Repos Git** in v1, so the Git Refs check applies. If neither commit pinning nor the Git Refs check is possible for a mapping, `promote` refuses the run (exit 26) rather than build an unverified head.

## Open Questions
None remaining.

Open Question 1 (plugin-root and plugin-data substitution) was closed by the plugin runtime probe of 2026-11-25, recorded in `release-radar-docs/design.md` § "Plugin runtime probe". The outcome is in requirement 11.

## Original Request
The user's own words, in sequence. Decisions the user made later in the conversation, as summarized by the orchestrating agent, are folded into the Requirements and Constraints above, with originating-project identifiers replaced by synthetic ones. Organization and repository names have been redacted as `[organization]` / `[the orchestration repo]` to honour the public-repository constraint; the text is otherwise verbatim.

> "can we generalize the skill component-status and put in my marketplace ../../claude-marketplace? lets discuss what we could generalize"
>
> "inside my claude marketplace it should be a new plugin and deployment status a new skill"
>
> "i want something in two parts. one part what is deployed etc and the other what could break. what could break can optionally depend on the other skill of what is deployed if fresh information is missing"
>
> engine: "typescript engine sounds good, ship it"
>
> sources: "any deployment source that is/can be configured"
>
> shape: ordered stages, multi-webapp components, fleet summary mode, project checklist file (all four chosen) → reviewed the file layout → "proceed".
>
> Scope addition: "it should also be able to run azure pipelines and understand the release lifecycle. for example, in [organization] case, we as devs can only run QA pipelines and after that another cloud devops team takes the image and production settings json and promote to production"
>
> On real-world verification: "real world verification should be configured per application"
>
> On generated files: "very important for any generated files required by the plugin skills is to always be structured. any handrolled updates in the generated files should trigger the skill to re-format them and clean them up"
>
> On multi-repo use: "will i be able to run the skill for any repo or directory of repos?" → "for [the orchestration repo], since the repos are available locally as siblings i would expect per-repo config that when i run the skill from [the orchestration repo] is able to find them" → membership: explicit member list → "configs should only live at only one place" → chose "Repo only".
>
> On monorepos: "allow a monorepo. this also applies for [a component repository with several deployable flavours]"
