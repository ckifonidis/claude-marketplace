---
name: change-risk
description: Read-only promotion risk review for a release-radar workspace. Reports what could break when a component is promoted from one stage to the next (or across an explicit git range, branch or pull request) - boot-blocking configuration, contract changes, dependency changes with versions and advisory status, build and image changes, data and migration changes, key-level settings-file diffs for stages another team deploys, and the fleet and component checklists - with evidence per finding and a verdict of safe to promote, needs preparation, or do not promote until X. Use when the user asks "what could break promoting acme-api from stage-1 to production", "is acme-api safe to promote", "change risk for this branch / range / PR", "what do we need to prepare before promoting", or runs /change-risk or /release-radar:change-risk.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" where *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --check *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index list *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index resolve *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" validate-config *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" status *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" settings-diff *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-runs *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" snapshot-info *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" checklist-check *), Bash(git log *), Bash(git show *), Bash(git diff *), Bash(git rev-parse *), Bash(git merge-base *), Read, Grep, Glob
---

<objective>
Answer one question with evidence: **what could break if this change reaches that stage, and what must be prepared first?**

The engine supplies the facts (what each stage runs, the commits between them, key-level settings diffs, the `component.json` at the promoted commit). This skill supplies the judgement: it reads the commits, classifies each risk, and gives one verdict per promotion:

- **safe to promote**;
- **needs preparation** — with the list of what to prepare;
- **do not promote until X** — naming each blocking finding.

The skill is **strictly read-only** towards every remote system and every git repository. It never fetches, pulls, checks out, deploys, queues a pipeline or edits a file it does not own. It may recommend those actions; it never performs them.
</objective>

## Engine invocation

Every engine call starts with exactly this prefix:

```
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" <command> --workspace "<workspace.json path>" ...
```

If the path above still shows a literal `${`, stop and report that the plugin root was not substituted. Never rewrite it as a shell variable (`$CLAUDE_PLUGIN_ROOT` is not set in the shell) and never guess another path. Once per session, `where` confirms the root (its `pluginRoot` must equal the path above):

```
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" where --json
```

The commands this skill uses:

```
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index resolve "<current directory>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json" --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --check --workspace "<workspace.json path>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json" --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --workspace "<workspace.json path>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json"
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --workspace "<workspace.json path>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json" --include-members
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json"
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" snapshot-info --workspace "<workspace.json path>" <component> --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" status --workspace "<workspace.json path>" <component> --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" settings-diff --workspace "<workspace.json path>" <component> --from <stage|local|sha> --to <stage|sha> [--stage <stage>] --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-runs --workspace "<workspace.json path>" <component> --stage <stage> --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" checklist-check --workspace "<workspace.json path>" <component> --commit <full sha> --json
```

- Always put `--check` directly after `format` in the check form; only that form is pre-allowed. `format` without `--check` rewrites files and therefore raises the permission prompt, which is intended.
- Fill in `<component>`, stage names and shas only with values resolved in step 3 (exact names from the workspace or the engine, shas from git). Never splice the raw user text into a command line.
- With `--json`, stdout is one JSON document and the trailer `RELEASE_RADAR_RESULT=<OK|FAIL> PHASE=<phase> EXIT=<code>` is on stderr. Read the exit code first; `deployment-status/references/exit-codes.md` is the contract.
- Read-only git runs inside the member's clone. The plain forms `git log`, `git show`, `git diff`, `git rev-parse` and `git merge-base` are pre-allowed. A `git -C <clone> …` form is deliberately **not** pre-allowed (a wildcard in front of the subcommand could match a write), so it raises a prompt. Never use `--output` with any git command, and never run `git fetch`, `pull`, `checkout`, `switch`, `reset`, `stash`, `commit`, `push` or `tag`.

<invocation>
Arguments as given: $ARGUMENTS

Shapes:

- `/change-risk <component> <from-stage> <to-stage>` — a promotion between two declared stages, in the promotion's direction: the commit that `<from-stage>` runs is promoted into `<to-stage>`. The reserved name `local` stands for the member clone's HEAD and is valid only as `<from-stage>` (e.g. `/change-risk acme-api local stage-1`).
- `/change-risk [component] <range|branch|PR>` — an explicit git range (`<base>..<head>`), a branch, or a pull request. With no component, it works on the git repository of the current directory and needs no workspace or deployment data.
- Optional `--workspace <path>` with either shape.
- Namespaced form, when another installed plugin also defines `change-risk`: `/release-radar:change-risk acme-api stage-1 production`.

Natural-language equivalents work the same way: "what could break promoting acme-api from stage-1 to production", "is acme-api safe to promote to production", "change risk for acme-api local to stage-1", "what does this branch risk", "review the risk of PR 42".

The arguments above are prose for you to interpret. They are never pasted into a shell line; every name is resolved first (step 3).
</invocation>

<hard_rules>
1. **Read-only.** No fetch, pull, checkout, deploy, cloud write, pipeline queue, or non-GET/HEAD request. The only local writes are the engine's own snapshot (written by `status`), the lossless re-formatting of the canonical-file gate, and nothing else.
2. **Names only.** Never echo a secret, token, credential, header value or settings value — not from a diff, not from a settings file, not from the environment. Keys, JSON pointers, secret-reference names and file paths are the most detail allowed. When a diff line holds a value, describe the change ("`/Database/Password` changed"), never quote it.
3. **Never invent.** Components, stages, targets, pipelines, settings files, packages and versions come from the workspace, the `component.json`, the engine, git, or the user. When something cannot be determined, say "unverified" or "unknown" with the reason. A dependency whose advisory status could not be determined is **"unverified"**, never "clean".
4. **Recommend, never perform.** A missing tag means "run `git fetch --tags` yourself"; a missing PR ref means "fetch it yourself". The skill does neither.
5. **Never pre-allow or suggest pre-allowing** `run-pipeline`, `handoff-package`, `format` without `--check`, or `workspace-index register|unregister`.
</hard_rules>

<process>

<step name="1_locate_workspace">
**1. Resolve the workspace** (skip for the range form without a component when the current directory is a git repository).

In this fixed order, stopping at the first that gives an answer:

1. A path the user gave (`--workspace <path>`, or a path in the request).
2. `workspace-index resolve` on the current directory. It searches upward for `.release-radar/workspace.json` to the git root, then checks whether the directory lies inside a member's clone of a registered workspace (that component is then pre-selected — say so), then the registered workspace roots.

Several matches: list them and ask the user which one. No match: say so, and point to the `deployment-status` skill's `init-workspace` workflow (or to registering an existing workspace there). Never guess a workspace, and never search the disk for one.

Exit 29 from `resolve` means the index itself was hand-edited: run `format --index` on it alone (no workspace needed; it raises the permission prompt), show what changed, and resolve again.
</step>

<step name="2_canonical_gate">
**2. Canonical-file gate — the first engine step.** Run `format --check` on the workspace (it covers `workspace.json`, the repos file, the fleet checklist, every located member's working-tree `component.json` and `checks.md`, the snapshots, the handoff manifests and the workspace index).

- All `canonical`: continue.
- `non-canonical` files in the workspace repository or engine-owned files: run `format` (it raises the permission prompt), show its per-file summary of what changed, and continue.
- `non-canonical` files in a **member repository** (reported with "re-format requires --include-members"): list them and ask the user **once** for this run. On an explicit yes, run `format --include-members`; on no, stop — every other engine command refuses non-canonical input (exit 29).
- `invalid` files (exit 24): stop. Show each file with its exact location (JSON pointer or line:column) for the user to fix. Never edit them yourself.

The member's `component.json` and component checklist are **also** read at the promoted commit later (steps 6 and 9); those copies are never re-formatted.
</step>

<step name="3_resolve_arguments">
**3. Resolve the arguments exactly.**

- Component names come from the workspace's `members`; stage names from its `stages`. They match exactly. A near miss ("api" for `acme-api`, "prod" for `production`) is offered as a candidate and confirmed with the user before anything runs. On a miss, list the valid names. Never substitute silently.
- `local` is reserved and valid only as `<from-stage>`.
- A range is taken as written; both ends must resolve with `git rev-parse --verify <ref>^{commit}`. A branch alone needs a base: use the base the user named; otherwise ask for it. Never pick a default branch.
- A **pull request** is accepted only through refs that exist locally. Ask the user which local refs hold it (or try the names they give with `git rev-parse --verify`). When they are missing, ask the user to fetch them. Optionally, when `gh` is installed and authenticated, `gh pr view <number> --json baseRefOid,headRefOid` may supply the two commits — announce it as **a network read** before running it (it is not pre-allowed). Both commits must then exist in the local clone; otherwise ask the user to fetch. The range is `merge-base(base, head)..head`.
- A component with several flavours in one repository is still one member; its files are under its `repoSubdir`.
</step>

<step name="4_settle_target_and_freshness">
**4. Settle what is promoted and what it replaces.** (Stage form only; the range form has its two commits already.)

**Freshness.** Run `snapshot-info` for the component (read-only; it writes nothing and exits 0 whether or not the snapshot is fresh). It selects the newest snapshot that covers the component and judges the three conditions: its `time` is younger than the workspace's `freshnessMinutes`, its `components[]` covers this component, and its recorded `fingerprint` equals the **current** fingerprint (the canonical workspace plus the working-tree `component.json` of every component that snapshot's run used).

- `fresh: true` **and** `snapshot.scope.stages` contains both `<from-stage>` and `<to-stage>` (the `local` side needs no stage) **and**, when pipeline facts are needed, `snapshot.pipelines` is `"read"`: use that snapshot's report (Read the `snapshot.file` it names; the report is under `report`). State its age ("data from a snapshot 12 minutes old").
- Otherwise: state why, from `reasons[]` (`no-snapshot`, `component-not-covered`, `too-old`, `time-in-future`, `fingerprint-differs`, `fingerprint-unavailable`) or the missing stage / pipeline facts, with the snapshot's age when there is one ("newest snapshot is 42 minutes old (freshnessMinutes 30), so the deployment data was refreshed"), and run `status` for the component (no `--stage`: both stages are needed).

Pipeline facts follow the same rule. When the PAT is missing (exit 20 from the pipeline preflight), say so and offer to run again with `--no-pipelines`; the report must then say "pipelines omitted (--no-pipelines)".

**The two commits.** From the `status` report:

- the **promoted commit**: what `<from-stage>` runs, or the clone's HEAD for `local` ("as of its last fetch; no fetch was performed");
- the **deployed commit**: what `<to-stage>` runs now.

Stop and report, without a verdict, when:

- a stage is **internally inconsistent** (its targets run different commits): list each target with its commit and ask the user to pick one; never merge them into one verdict;
- a commit is unresolved (`no-clone`, `tag-not-found` — recommend `git fetch --tags`, never run it — `digest-pinned`, `no-convention`, `git-error`): name the reason;
- `<to-stage>` does not run the component yet: there is no baseline. Say so and ask the user for a baseline commit (or a range).

Use the engine's delta for the pair when the stages are neighbours; otherwise compute the relation with `git merge-base --is-ancestor`. The range is `<deployed>..<promoted>`. When the deployed commit is **not** an ancestor of the promoted one (`ahead` or `diverged`), the promotion would remove commits from the destination: that is a blocking finding of its own (list the commits that would be lost with `git log <promoted>..<deployed>`).
</step>

<step name="5_enumerate">
**5. Enumerate the changes.** Run `git log --stat` over the range in the member's clone (restrict to the member's `repoSubdir` with `-- <repoSubdir>` when one is set, and say so). Inspect each suspect with `git show <sha>` and `git diff <deployed> <promoted> -- <path>`. Read files at the promoted commit with `git show <sha>:<path>` and list a directory at a commit with `git show <sha>:<dir>/`. Never check anything out.
</step>

<step name="6_detect_stack">
**6. Detect the stack at the promoted commit** from the files present there (manifests, lockfiles, Dockerfiles, charts, IaC). `references/stack-signals.md` lists the concrete files and patterns per stack and per risk category. Report the detected stacks in one line.
</step>

<step name="7_generic_checks">
**7. Generic checks**, in this order, following `references/generic-checks.md`:

- **(a) New or renamed required configuration — boot-blocking, the highest severity.** A setting read without a default, a new required environment variable, a renamed key, a new secret reference. If it is missing at the destination, the application does not start.
- **(b) Contract changes** — APIs, events, schemas, CLI flags, routes, response shapes consumed by others.
- **(c) Dependency changes.** List every added, removed or bumped dependency with its old and new version, taken from `git diff` of the manifests and lockfiles. Look advisories up only through read-only means that do not modify the working tree, and only when the lockfile in the working tree is identical to the promoted commit's (`git diff --quiet <sha> -- <lockfile>`) or when the lookup takes the package and version directly. Any lookup that contacts the network is announced as a network read. A dependency whose advisory status could not be determined is **"unverified"**, never "clean". HIGH-or-above advisories are flagged.
- **(d) Build, Dockerfile, base-image and build-context changes.**
- **(e) Data, migration and cache-key changes.**
</step>

<step name="8_settings_diff">
**8. Settings-file diffs and the component config at the promoted commit.** Run `settings-diff --from <from-stage|local> --to <to-stage>` (range form with a component and a destination the user named: `--from <head sha> --to <base sha> --stage <stage>`). It reads the member's `component.json` **at the promoted commit**, never a working-tree copy, and reports:

- the config state at that commit: `non-canonical at <sha>` (used as is; offer — never run automatically — to re-format the member's working-tree copy with `format --include-members`), and the JSON pointers where the working-tree `component.json` differs from it (state them: "the working-tree component.json differs at `/stages/production/handoff/settingsFiles`");
- when `<to-stage>` is a **`handoff`** stage, a key-level diff of every declared settings file between what the destination runs and the promoted commit:
  - **added keys** and **new secret-reference names** → "receiving team must provide / configure" findings (boot-blocking when the application requires the key);
  - **removed keys** and **probable renames** (and renamed secret references) → coordinate with the receiving team;
  - **changed keys** → listed by pointer, never with a value;
  - a file **added**, **removed** or **unparseable** (line counts only) → a finding of its own.

Exit 24 with "invalid at <sha>" means the `component.json` at the promoted commit is invalid: that is a **blocking finding** ("<file> invalid at <sha>: <location>"), the verdict cannot be *safe to promote*, and the git-based checks still continue. Exit 21 (a stage side did not resolve to one commit) is reported with its reason. For a destination that is not a `handoff` stage the command reports "no settings files declared"; that is expected.
</step>

<step name="9_checklists">
**9. Checklist layers**, applied in the order **generic → fleet → component**. Each finding names its layer, and a missing layer is stated.

- **generic**: the checks of steps 7 and 8 (`references/generic-checks.md`). Always present.
- **fleet**: the workspace's `checklist` (a file in the workspace repository, already through the gate in step 2). `checklist: null` → "no fleet checklist configured".
- **component**: `.release-radar/checks.md` **at the promoted commit**, under the member's `repoSubdir` when one is set. Run `checklist-check --commit <full promoted sha>`; it reads the file at that commit, classifies it against the grammar in `references/checklist-format.md`, and returns `state`, the parsed `items[]` and how the working-tree copy compares (`workingTree.comparison`).

The component checklist at the commit is never re-formatted (`checklist-check` never writes). By `state`:

- `absent` → "no component checklist at <sha>";
- `canonical` → use `items[]`;
- `non-canonical` (exit 0) → use `items[]`, report "non-canonical at <sha>" with its `changes[]`, and offer (never run automatically) `format --include-members` on the working-tree copy;
- `invalid` (exit **24**, the report is still printed) → a **blocking finding** "<path> invalid at <sha>: <line:column>" from `error.describe`, and the verdict cannot be *safe to promote*. The other checks continue.

When `workingTree.comparison` is `differs`, say that the working-tree checklist differs from the one at the promoted commit (the commit's copy is the one applied).

An item applies when any file changed in the range matches one of its `paths` globs (relative to the component root: the clone root, or `repoSubdir`). Read the matching diffs and decide whether its `signal` is present. A present signal is a finding with the item's `severity` and its `prepare` text. An applicable item whose signal is absent is listed once as "checked, not triggered".
</step>

<step name="10_evidence">
**10. Evidence per finding.** Every finding carries:

- **severity** (`blocker`, `high`, `medium`, `low`, `info`) and **layer** (generic, fleet, component);
- the **commit** (short sha and subject);
- **`file:line`** at the promoted commit;
- **why it could break** — one or two sentences;
- **what to prepare** — concrete, naming keys, secret-reference names, versions or teams, never values.
</step>

<step name="11_verdict">
**11. Verdict per promotion**:

- **do not promote until X** — at least one `blocker` (including an invalid `component.json` or checklist at the promoted commit, or a promotion that would remove commits from the destination). Name each blocking finding as X.
- **needs preparation** — no blocker, but at least one finding that needs action (a `high` or `medium` finding, an "unverified" dependency, a "receiving team must provide" key). List what to prepare.
- **safe to promote** — only `low`/`info` findings, every dependency's advisory status determined, and every config file valid at the promoted commit.

State next to the verdict the destination stage's **promotion mode and owner** (and whether it is triggerable by the operator's team), and the **`beforePromote` pointer(s)**: the workspace's `beforePromote[<to-stage>]` and, at the promoted commit, the component's `stages.<to-stage>.handoff.beforePromote`. Show both when both exist; neither overrides the other. Point at them; never run them.
</step>

</process>

<answer_format>
```
acme-api stage-1 → production — do not promote until ops-team configures /Payments/Endpoint.
Promotion: production is a handoff stage owned by ops-team (not triggerable by dev-team).
Range: 1a2b3c4..5d6e7f8 (7 commits); data from a fresh status run (newest snapshot was 42 min old).
Stacks: Node/TypeScript, Docker.

Findings
1. [blocker | generic] New required setting /Payments/Endpoint — commit 5d6e7f8 "add payments client"
   src/config.ts:41 — read without a default; the service exits at start-up when absent.
   Prepare: ops-team must configure /Payments/Endpoint in production before deploying.
2. ...

Dependencies: 2 bumped, 1 added — 1 unverified (advisory lookup not possible offline).
Checklists: generic applied, fleet (4 items, 1 triggered), component — no component checklist at 5d6e7f8.
Config at the promoted commit: component.json non-canonical at 5d6e7f8 (used); working tree differs at /stages/production/handoff/settingsFiles.
Before promoting: workspace pointer "<text>"; component pointer "<text>".
```

Lead with the verdict line, then the findings by severity, then the summary lines. Answer in the conversation; nothing is written to disk.
</answer_format>

<exit_codes>
Interpret every engine exit through `deployment-status/references/exit-codes.md`. The ones that matter here:

- **20** — an authentication or tooling problem (CLI login, kube context, PAT), never "not deployed". Give the engine's next step; offer `--no-pipelines` when only the PAT is missing.
- **21** — a source error, or a `settings-diff` stage side that did not resolve to one commit. Nothing was concluded about the targets.
- **23** — a declared target does not exist. Report what was found.
- **24** — an invalid file (stop at the gate), or the `component.json` (`settings-diff`) or component checklist (`checklist-check`) invalid at the promoted commit (a blocking finding, not a stop).
- **29** — non-canonical input: go back to the gate.
- **64** — bad names: resolve them again with the user.
</exit_codes>

<references>
- `references/generic-checks.md` — the five generic categories: signals, severity, what to prepare, examples.
- `references/stack-signals.md` — concrete files and patterns per stack (Node/TypeScript, .NET, Python, Go, Docker, Helm/Kubernetes, IaC).
- `references/checklist-format.md` — the `checks.md` grammar, layer locations, how items are applied.
- `../deployment-status/references/exit-codes.md` — exit codes and their precedence.
- `../deployment-status/references/file-formats.md` — canonical files and the `format` states.
- `../promote/references/lifecycle-model.md` — stages, modes, owners and what each skill does per mode.
</references>

<anti_patterns>
<pitfall name="calling_an_unverified_dependency_clean">
No advisory data is not "no advisories". Without a determinable status the dependency is "unverified", and the verdict is at best *needs preparation*.
</pitfall>
<pitfall name="reviewing_the_working_tree_instead_of_the_commit">
The promoted commit is what ships. Read `component.json`, checklists and manifests at that commit with `git show`; the working tree may differ, and the difference must be stated.
</pitfall>
<pitfall name="one_verdict_for_an_inconsistent_stage">
When a stage's targets run different commits, there is no single "what it runs". Ask the user to pick a target.
</pitfall>
<pitfall name="quoting_a_settings_value">
A settings diff shows keys and secret-reference names only. Never print the value of a key, even when `git show` displays it.
</pitfall>
<pitfall name="fetching_to_fill_a_gap">
A missing tag or PR ref is reported with the command the user can run. The skill never fetches.
</pitfall>
</anti_patterns>

<success_criteria>
- The workspace was resolved in the fixed order and passed the canonical-file gate first.
- Both commits were settled from fresh data (or the reason no single verdict is possible was given).
- Every finding has severity, layer, commit, `file:line`, why and what to prepare, with names only.
- Every changed dependency is listed with old and new version and an advisory status (or "unverified").
- For a `handoff` destination, the settings-diff findings are included.
- All three checklist layers are accounted for, each missing layer stated.
- One verdict per promotion, with the destination's mode and owner and the `beforePromote` pointer(s).
</success_criteria>
