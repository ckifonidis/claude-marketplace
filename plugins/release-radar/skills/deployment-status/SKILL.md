---
name: deployment-status
description: Read-only report of what is deployed where in a release-radar workspace — the running image and commit per component, stage and target, within-stage consistency, cross-stage comparison, the commits pending between neighbouring stages, recent Azure DevOps pipeline runs and pipeline/target drift, and on request each application's own real-world verification (PASS/FAIL/UNREACHABLE). Use when the user asks "what's deployed for acme-api", "what runs on stage-2", "is acme-api up to date", "what is pending between stage-1 and stage-2", "did the last pipeline run land", "fleet status", "verify acme-api on stage-1", or wants to set up release-radar (initialise a workspace or a component).
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" status *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" verify *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" discover *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" validate-config *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-runs *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-run *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" where *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --check *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index list *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index resolve *)
  - Bash(git rev-parse *)
  - Read
  - Grep
  - Glob
---

<objective>
Answer "what is deployed where, and is it what we expect?" for one component or the whole fleet of a release-radar workspace, from live, read-only reads made by the bundled engine:

- per component, stage and target: status, state, running image, last-modified (an upper bound), the resolved commit and its relation to the clone's HEAD;
- the promotion mode, owner and triggerability of each stage;
- within-stage consistency and the cross-stage comparison (equal digests prove the same build; tags prove nothing);
- the commits pending between neighbouring stages (`local HEAD → stage 1 → …`), grouped by conventional-commit type;
- recent Azure DevOps pipeline runs, pipeline/target drift and the PAT's days remaining;
- on request, the real-world verification each application declares for itself.

This skill is **strictly read-only** towards every remote system. It never fetches, pulls, checks out, deploys, queues a pipeline or sends anything but GET/HEAD to an application. Its only local writes are engine snapshots, the lossless canonical re-formatting of release-radar's own files, workspace-index registration after confirmation, and the init workflows' files after confirmation.
</objective>

<invocation>
```
/deployment-status [component|--all] [stage] [--verify] [--workspace <path>]
```

- **No component** → the fleet summary (same as `--all`), and the answer says it is the fleet summary. Exception: when the skill starts inside a member's clone (workspace found at resolution step (c)), that component is pre-selected and the answer says so ("pre-selected from the current directory: acme-api").
- **`[stage]`** restricts the report to that stage.
- **`--verify`** also runs the real-world verification.
- **`--workspace <path>`** names the workspace explicitly (its root or its `.release-radar/workspace.json`).
- When another installed plugin also has a `deployment-status` skill, use the namespaced form `/release-radar:deployment-status …`.
- Natural language works the same: "what's deployed for acme-api", "acme-api on stage-2", "fleet status", "is acme-api healthy on stage-1" (= `--verify`), "set up release-radar here" (→ init workflows).

`$ARGUMENTS` holds whatever the user typed after the command. Read it as prose to find the component, stage, flags and path; never paste it into a command line. Every name passed to the engine is one you matched exactly against the configuration (step 3).
</invocation>

<engine_invocation>
## Engine invocation

Every engine call has exactly this prefix:

```
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" <command> --workspace "<workspace.json path>" ...
```

If the path above still shows a literal `${`, stop and report that the plugin root was not substituted.

The commands this skill uses (`<ws>` = the resolved `workspace.json` path; `<index>` = `${CLAUDE_PLUGIN_DATA}/workspace-index.json`):

```
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" where --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index resolve "<cwd>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json" --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index list --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json"
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --check --workspace "<ws>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json"
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" validate-config --workspace "<ws>"
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" status --workspace "<ws>" <component>... --json [--stage <stage>] [--verify] [--no-pipelines]
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" status --workspace "<ws>" --all --json [--stage <stage>] [--verify] [--no-pipelines]
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" verify --workspace "<ws>" <component> --stage <stage> --json [--target <target>] [--check <name>,<name>]
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-runs --workspace "<ws>" <component> --json [--stage <stage>] [--target <target>]
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-run --workspace "<ws>" <component> <runId> --json [--stage <stage>] [--target <target>]
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" discover --workspace "<ws>" --adapter <adapter> --json [scope flags, see references/adapters.md]
```

Local maintenance — **never pre-allowed**, so a permission prompt appears; tell the user why before running:

```
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --workspace "<ws>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json" [--include-members]
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json"
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index register "<workspace root>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json"
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index unregister "<path>" --index "${CLAUDE_PLUGIN_DATA}/workspace-index.json"
```

Rules for every call:
- One engine command per Bash call, **exactly in this shape**: `format --check` with `--check` first; no `cd`, pipes, redirections, `&&`, `;` or `echo $?` — anything extra stops the pre-allow from matching. The exit code is in the last trailer line, `RELEASE_RADAR_RESULT=<OK|FAIL> PHASE=<phase> EXIT=<code>` (on stderr with `--json`).
- Quote every path. Pass only names that exist in the configuration.
- Never write `$CLAUDE_PLUGIN_ROOT` as a shell variable; it is not set in the shell. The documented contingency path `${CLAUDE_SKILL_DIR}/../../engine/dist/cli.js` is for a future Claude Code that stops substituting the plugin root; it is not pre-allowed — use it only with the user's agreement.
- Prerequisites: Node.js 20 or newer and `git`; the CLIs of the adapters in use; `AZURE_DEVOPS_EXT_PAT` only when pipelines are configured; the verification header variables only when checks name them.
</engine_invocation>

<process>

<step name="1_resolve_workspace">
**Step 1: Resolve the workspace** — in this fixed order, never guessing:

(a) a path the user gave (`--workspace` or in words);
(b) a `.release-radar/workspace.json` found searching upward from the current directory to the git root (outside a git repository: the current directory only);
(c) the current directory is inside a member's mapped clone of a registered workspace → that workspace, with that component pre-selected;
(d) the current directory is inside a registered workspace's root.

The model behind these steps (where each file lives, how members are located, unavailable vs invalid, which `component.json` revision each skill reads, single-repo projects, the per-user index) is [references/workspace-model.md](references/workspace-model.md).

For (b)–(d) run the engine's `workspace-index resolve` with the current directory; it applies the order and returns `step`, `candidates[]` (each with `root`, `component` when pre-selected, `registered`), `stale[]` and `skipped[]`.
- One candidate → use it. Several (e.g. two workspaces list the same clone) → list them and ask. None → say no workspace was found, and offer `workflows/init-workspace.md` or registering an existing workspace whose path the user gives.
- Report `stale[]` entries; offer `workspace-index unregister` for each, only after the user confirms. Report `skipped[]` reasons.
- Exit 29 from `resolve` means the index itself was hand-edited. Re-format it alone with the index-only form `format --index` (no workspace needed; permission prompt — say it re-renders the index losslessly, and that its report has `workspace: null` and quarantine/retention "skipped: index-only run"), show what changed, then run `resolve` again. `format --check --index` alone classifies it without writing; exit 24 means the index is invalid — show the location and stop.
</step>

<step name="2_canonical_gate">
**Step 2: Canonical-file gate — always the first engine step on the workspace.** Run `format --check` with the workspace and the index. It classifies the workspace, the repos file, the checklists, every located member's working-tree `component.json`, the engine's snapshots/packages and the index as `canonical`, `non-canonical (hand-edited)` or `invalid` (rules: [references/file-formats.md](references/file-formats.md)).

- **Exit 0** → continue.
- **Exit 29 (non-canonical)** → re-format, then continue:
  - workspace-repository and engine-owned files (and the index) are re-formatted without asking;
  - files marked "re-format requires --include-members (member repository)" live in a member's repository that the user manages: list them and ask **once** for this run;
  - run `format` (with `--include-members` only after a yes). Before it runs, say that it re-renders those files losslessly and also applies the cleanup that `--check` listed (out-of-retention snapshots/packages deleted, orphans moved to `.release-radar/quarantine/`) — quote those counts. Then summarise per file what changed (keys reordered, whitespace normalised, arrays sorted, duplicates removed).
  - If the user declines the member files, they stay non-canonical and the engine refuses every command that uses them (exit 29): continue only with what does not need them, and say which components were left out.
- **Exit 24 (invalid)** → stop. Show each invalid file with its exact location (JSON pointer and line:column) and the message, and ask the user to fix it (offer to draft the fix; edit only with their confirmation, then run the gate again).

The first time a workspace is used in a conversation, also run `validate-config` and show the **configured commands** it lists (command-adapter argv, `discoverArgv`) — the engine cannot prove they are read-only — and the unavailable members: `no component config` → offer `workflows/init-component.md`; `no local clone` → the repos file does not map that `repoKey` or the path is missing.
</step>

<step name="3_resolve_arguments">
**Step 3: Resolve the arguments exactly.** Component names come only from the workspace `members`; stage names from its `stages` (read `workspace.json`, or the `validate-config` output). An exact match is used as is. A near miss or a natural-language name ("the api") → propose the candidate and confirm before running. No match → list the valid names. Never substitute silently. If the engine still exits 64, show the valid names it printed and ask.
</step>

<step name="4_run">
**Step 4: Run the engine.**
- One or more components: `status … <component>... --json`; fleet: `status … --all --json`; add `--stage` for `[stage]` and `--verify` when verification was asked for. `--no-pipelines` only when the user asks to skip pipelines, or agrees to after a PAT problem — the report then says "pipelines omitted (--no-pipelines)".
- Narrow verification ("just the health check on stage-1"): `verify … --stage <stage> [--target] [--check]`. Naming a smoke check on a stage the operator's team does not own is refused (26). Before verification runs a component's smoke commands for the first time in a conversation, show their argv from `component.json`.
- A specific run ("what happened to run 1234"): `pipeline-run … <runId>`; recent runs only: `pipeline-runs`.

Interpret the exit code exactly as in [references/exit-codes.md](references/exit-codes.md):

| Exit | Meaning for the answer |
|---|---|
| 0 | Report. |
| 20 | Authentication or tooling, **never "absent"** — give the engine's next step: `az login` (with the tenant shown), refresh/select the kube context, start Docker, install the named CLI, set or renew `AZURE_DEVOPS_EXT_PAT`, or set the named verification header variable. No partial report exists. |
| 21 | Source/REST error — quote it; nothing was concluded about the targets. |
| 22 | Drift gate tripped — the report is complete; name each finding. |
| 23 | A declared target or pipeline does not exist — the **report is still complete**: name what is missing, report the rest, suggest `discover`. |
| 24 | Invalid input or a requested member unavailable — quote file and location; offer the fix or `init-component`. |
| 25 | (`pipeline-run`) the run finished with a result other than `succeeded` — report the result and link; nothing is retried. |
| 26 | Refused, nothing ran: a smoke check was named on a stage the operator's team does not own, or (`pipeline-runs`) no pipeline mapping is in scope. |
| 28 | Verification FAIL — name each failing check. |
| 29 | Non-canonical input — run the step 2 gate, then retry. |
| 30 | Verification **inconclusive** (UNREACHABLE or INCONCLUSIVE, no FAIL) — never say "passed" or "failed". |
| 64 | Back to step 3. |
| 1 | Internal error — quote it; conclude nothing. |
</step>

<step name="5_report">
**Step 5: Report** — a one-line verdict, then the sections. Use the `--json` document (contract: `schemaVersion`, additive fields); quote names and values exactly as the engine gives them.

**Single component** — verdict, e.g. "acme-api: stage-1 runs 3f2a9c1 (2 behind HEAD), stage-2 is 4 commits behind stage-1, no drift, verification PASS." Then:
1. **Deployed state** — per stage: mode, owner, triggerable (with the engine's reason); per target: status (`found` / `missing` / `not deployed`), state, image (`raw`), digest status, last-modified **(upper bound)**, commit (short sha, date, subject, `at-head` / `behind N` / `not-ancestor`) or the non-resolved status.
2. **Consistency** — within-stage (`consistent` / `inconsistent` with every differing target named, basis `digest` or `reference`); cross-stage per neighbouring pair (`same-build` only when digests prove it; `same-reference` / `different-reference` carry the caveat that tags alone prove nothing).
3. **Stage deltas** — per pair (`local → stage-1`, `stage-1 → stage-2`, …): verdict (`equal` / `behind N` / `ahead` / `diverged` / `unknown` + reason) and the pending commits **grouped by conventional-commit type** (`feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, …; subjects marked breaking with `!` first; subjects without a type under "other"). "Local" is the clone's HEAD as of its last fetch. An "inconsistent stage" pair lists one delta per distinct commit and has no single verdict.
4. **Pipeline runs & drift** — per mapped target: the latest runs (id, result, source commit, action, pushed tag — `undetermined` stays undetermined, link); drift ("latest succeeded build run built X, target runs Y", with the ancestry relation; an in-progress run is not drift); missing pipelines. **PAT:** "expires in N days" (warn inside `patExpiryWarningDays`), or "expiry unknown — set AZURE_DEVOPS_PAT_EXPIRES".
5. **Verification** — when it ran: per check PASS / FAIL / UNREACHABLE / INCONCLUSIVE / NOT-RUN with HTTP status or exit code, latency and the extracted version; smoke on non-owned stages as "not run (stage not owned)"; the overall outcome. When not requested, say no check ran. A stage without a block: "no real-world verification configured".

**Fleet** (`--all` or no component) — say it is the fleet summary; then one table row per member: each stage's short commit or tag, consistency, pending counts per pair, non-running or missing targets, latest pipeline result, pipeline drift, verification outcome (when it ran), and unavailable members with their reason (`no local clone` / `no component config`). Below the table, only the **exceptions** (inconsistent stages, drift, missing targets, failures, degradations).

**Visible degradation** — list every one that occurred, never hide it: no clone; tag not found (recommend `git fetch --tags` in that clone — never run it); digest-pinned; git error; not-ancestor; not deployed by design; pushed tag undetermined; "no real-world verification configured"; "pipelines omitted (--no-pipelines)"; member unavailable.

The answer is given in the conversation. If the user wants a report file, point at the snapshot the run wrote (`snapshot.file` in the JSON — the full report in canonical form, kept per `snapshotRetention`); never hand-write one.
</step>

<step name="6_register_and_next">
**Step 6: Register, then point onward.**
- When the workspace was used (or created) successfully and is not registered (`registered: false`, or resolved via (a)/(b) and absent from `workspace-index list`), offer to register it so it can be found from member clones and other directories. Run `workspace-index register` only after a yes.
- Next steps: `/change-risk <component> <from-stage> <to-stage>` to see what could break in a promotion; `/promote <component> <stage> [action]` to promote (pipeline stages your team owns) or to assemble a handoff package (stages another team owns).
</step>

</process>

<hard_rules>
- **Read-only.** Never fetch, pull, checkout, commit, deploy, restart, queue or approve anything, and never call an application with anything but GET/HEAD. Recommend `git fetch` when tags are missing; never run it.
- **Names only.** Never echo or record a secret, token, PAT, header value or settings value — not in chat, files or summaries. Key Vault and secret **names** are the maximum detail.
- **Nothing invented.** Every component, stage, target, pipeline, endpoint and resource name comes from the workspace, a `component.json`, the repos file, the engine, git or the user.
- **Exit 20 is never "absent", 23 still has a complete report, 29 means run the gate, 30 is never "passed".**
- **Never hand-write a structured file**; the engine writes them, and the init workflows write drafts that `format` makes canonical.
</hard_rules>

<references>
- [references/workspace-model.md](references/workspace-model.md) — the two-level model: `workspace.json` vs each member's own `component.json`, member location through the repos file only, monorepos, unavailable vs invalid members, revision rules per skill, single-repo projects, workspace resolution order and the per-user index.
- [references/config-schema.md](references/config-schema.md) — every key of `workspace.json`, `component.json`, the repos file and the workspace index, with a validated example.
- [references/exit-codes.md](references/exit-codes.md) — codes, precedence, trailer, what to say.
- [references/adapters.md](references/adapters.md) — what each adapter reads, its commands, `discover` scopes, fixture provenance.
- [references/verification.md](references/verification.md) — check types, outcomes, comparison rules, header variables, smoke ownership.
- [references/file-formats.md](references/file-formats.md) — canonical form, `format` states and cleanup, files never rewritten.
- [workflows/init-workspace.md](workflows/init-workspace.md) — create the workspace, repos file and gitignore lines.
- [workflows/init-component.md](workflows/init-component.md) — create a member's `component.json` from `discover`, Azure DevOps reads and user answers.
</references>

<success_criteria>
- The workspace was resolved in the fixed order (or the user chose among candidates), and `format --check` ran before any other engine step on it.
- Every name passed to the engine matched the configuration exactly or was confirmed by the user.
- The exit code was interpreted per `references/exit-codes.md`; no auth failure was reported as absent, no inconclusive verification as passed.
- The answer starts with a one-line verdict, says when it is a fleet summary or a pre-selected component, and lists every degradation.
- Nothing remote was changed, and no secret value appears anywhere in the answer.
</success_criteria>
