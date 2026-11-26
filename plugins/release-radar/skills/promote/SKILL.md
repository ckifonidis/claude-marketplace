---
name: promote
description: Promote a component of a release-radar workspace to its next stage - the ONLY mutating skill of release-radar, and every run requires explicit confirmation. For a stage that the operator's own team owns and that is promoted by an Azure DevOps pipeline, it refreshes the deployment status and the change-risk verdict, shows the exact run preview, asks for confirmation of that one run, queues exactly one pipeline run for a declared action (build or configuration-only), follows it read-only and proves it landed with the application's own verification. For a stage another team deploys (handoff), it triggers nothing and assembles a handoff package instead; any other stage is refused, naming its owner and mode. Use when the user says "promote acme-api to stage-1", "run the stage-1 pipeline for acme-api", "apply the configuration to stage-1", "prepare the production handoff for acme-api", or runs /promote or /release-radar:promote.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" where *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" format --check *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index list *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" workspace-index resolve *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" validate-config *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" status *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" verify *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" settings-diff *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-runs *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-run *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-preview *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" snapshot-info *), Bash(node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" checklist-check *), Bash(git log *), Bash(git show *), Bash(git diff *), Bash(git rev-parse *), Bash(git merge-base *), Read, Grep, Glob
---

<objective>
Move one component to one stage, the way that stage's lifecycle allows, and prove the result.

- **Run path** — the stage's mode is `pipeline` and its owner is the workspace's `operatorTeam`: queue **exactly one** Azure DevOps pipeline run for a declared action, behind a fresh risk verdict, the verbatim preview and an explicit confirmation of that one run; follow it read-only; prove it landed.
- **Package path** — the stage's mode is `handoff`: trigger nothing; write a handoff package for the team that deploys the stage.
- **Anything else** — refuse, naming the stage's owner and mode, and offer the read-only reports.

`promote` is the only release-radar skill that changes anything outside the machine, and the only change it can make is that one queued run. It never edits configuration files or pipeline definitions, never approves, rejects, cancels or retries a run, and never acts on more than one target or action per confirmation.
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
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-preview --workspace "<workspace.json path>" <component> --stage <stage> [--target <target>] [--action <action>] [--select <parameter>=<value>]...
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" run-pipeline --workspace "<workspace.json path>" <component> --stage <stage> [--target <target>] [--action <action>] [--select <parameter>=<value>]... --confirm <token> --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" pipeline-run --workspace "<workspace.json path>" <component> <runId> --stage <stage> --target <target> --follow --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" status --workspace "<workspace.json path>" <component> --stage <stage> --no-pipelines --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" verify --workspace "<workspace.json path>" <component> --stage <stage> --target <target> --expect <built sha|tag> [--check <name>,...] --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" settings-diff --workspace "<workspace.json path>" <component> --from <upstream stage> --to <stage> --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" checklist-check --workspace "<workspace.json path>" <component> --commit <full sha> --json
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" handoff-package --workspace "<workspace.json path>" <component> --stage <stage> --commit <full sha> --json
```

- Only read-only commands are pre-allowed. **`run-pipeline`, `handoff-package`, `format` without `--check`, and `workspace-index register|unregister` always raise Claude Code's permission prompt.** For `run-pipeline` that prompt is a **second gate** after the user's confirmation: tell the user it is coming, and stop if they deny it. Never suggest adding any of them to an allow list.
- Always put `--check` directly after `format` in the check form; only that form is pre-allowed.
- Fill in names, shas, tokens and `--select` values only with values resolved in this skill (exact names from the workspace, the `component.json` or the engine; the token from the preview). Never splice raw user text into a command line.
- With `--json`, stdout is one JSON document and the trailer `RELEASE_RADAR_RESULT=<OK|FAIL> PHASE=<phase> EXIT=<code>` is on stderr. Read the exit code first; `deployment-status/references/exit-codes.md` is the contract, and `references/safety-gates.md` has the run-path table.
- `pipeline-run --follow` may run up to the workspace's `followTimeoutMinutes`: give the Bash call a timeout above that (up to the tool's maximum), or run it in the background. A tool timeout is not a run failure; follow again with `pipeline-run`, read-only.
- Read-only git (the five pre-allowed forms) runs inside the member's clone; a `git -C <clone> …` form is deliberately not pre-allowed. Never fetch, pull, check out, commit, push or tag.

<invocation>
Arguments as given: $ARGUMENTS

Shape: `/promote <component> <stage> [action]`, with an optional `--workspace <path>`.

- `/promote acme-api stage-1` — the mapping's declared `primaryAction` (the preview says it was chosen because no action was given).
- `/promote acme-api stage-1 config` — the declared action named `config` (for example a configuration-only action).
- `/promote acme-api production` — on a `handoff` stage: the handoff package.
- Namespaced form, when another installed plugin also defines `promote`: `/release-radar:promote acme-api stage-1`.

Natural-language equivalents: "promote acme-api to stage-1", "run the stage-1 pipeline for acme-api", "apply the stage-1 configuration for acme-api", "prepare the production handoff for acme-api".

The arguments above are prose for you to interpret. They are never pasted into a shell line; every name is resolved first (step 3).
</invocation>

<hard_rules>
1. **One run per confirmation.** One component, one stage, one target, one action, one commit. A second target, action or run needs its own preview and its own confirmation.
2. **Fresh evidence every time.** A run is preceded by a fresh `status` and a fresh change-risk verdict, taken in this invocation, whatever `freshnessMinutes` says and whatever was reported earlier in the conversation.
3. **The preview is shown verbatim** and the confirmation refers to it. A confirmation given before the preview, an ambiguous answer, silence or a blanket "go ahead with everything" is not a confirmation.
4. **Ownership and mode are absolute.** Another team's stage, a `handoff`, `manual` or `none` stage is never triggered. No acknowledgement or override changes that.
5. **Never auto-retry.** No outcome — refusal, rejection, unknown outcome, failed run — leads to another run without a new preview and a new confirmation. After an unknown outcome, never queue again in this invocation.
6. **Never approve, reject or cancel** anything, and never edit `workspace.json`, `component.json`, a checklist, a settings file or a pipeline definition.
7. **Names only.** Never echo a PAT, header value, secret or settings value, and never print the content of a handoff file. Keys, JSON pointers, secret-reference names, file paths, sizes and shas are the most detail allowed.
8. **Never invent** a component, stage, target, pipeline, parameter, action, value or commit. When something cannot be determined, stop and say why.
</hard_rules>

<process>

<step name="1_locate_workspace">
**1. Resolve the workspace**, in this fixed order:

1. A path the user gave (`--workspace <path>`, or a path in the request).
2. `workspace-index resolve` on the current directory: upward search for `.release-radar/workspace.json` to the git root, then a member clone of a registered workspace (that component is pre-selected — say so), then the registered workspace roots.

Several matches: list them and ask. None: say so, and point to the `deployment-status` skill's `init-workspace` workflow (or to registering the workspace there). Never guess. Exit 29 from `resolve` means the index itself was hand-edited: run `format --index` on it alone (permission prompt; no workspace needed), then resolve again.
</step>

<step name="2_canonical_gate">
**2. Canonical-file gate — the first engine step.** Run `format --check`.

- All `canonical`: continue.
- `non-canonical` workspace-repository or engine-owned files: run `format`, show its summary, continue.
- `non-canonical` member-repository files: list them, ask **once** for this run, then `format --include-members` on an explicit yes; on no, stop.
- `invalid` (exit 24): stop and show each file with its exact location.

The `component.json` the promotion will use is read **at the promoted commit** by the engine (the preview's `config` line on the run path; `handoff-package` on the package path), and so is the component checklist (`checklist-check --commit <full sha>` in the change-risk review). Non-canonical there is used and reported "non-canonical at <sha>" — offer, never run automatically, to re-format the working-tree copy. Invalid there (`component.json`, or a checklist `checklist-check` reports `invalid` with exit 24) refuses the promotion until the file is fixed.
</step>

<step name="3_resolve_arguments">
**3. Resolve the arguments exactly.** The component from the workspace's `members`, the stage from its `stages`, the action from the target's pipeline mapping in the member's `component.json`. Exact matches only; a near miss ("prod" for `production`, "configure" for `config`) is offered as a candidate and confirmed before anything runs; a miss lists the valid names. `local` is not a stage and cannot be promoted to.

- No action given: the mapping's `primaryAction` applies. Say so; the preview shows it too.
- Several mapped targets on the stage: list them and ask the user to pick **one**. Each target is its own promotion.
- `userSelectable` parameters: show each one's closed list and let the **user** choose. Never pick a value for them.
</step>

<step name="4_select_path">
**4. Select the path by the stage's mode and owner** (from `workspace.json`, shown in every `status` report as the stage's promotion):

| Mode and owner | Path |
|---|---|
| `pipeline`, owner equals `operatorTeam` | **run path** (step 5) |
| `handoff` | **package path** (step 6); an `[action]` argument does not apply there — say so and ask whether to continue with the package |
| `pipeline` owned by another team, `manual`, `none` | **refuse**: "stage <stage> is promoted by <owner> (mode <mode>); this workspace's team is <operatorTeam>, so release-radar does not trigger it." Offer the read-only reports (`deployment-status`, `change-risk`). A handoff package exists only for `handoff` stages. |

The engine enforces the same rule (exit 26 before any request), but the skill refuses first and never tries.
</step>

<step name="5_run_path">
**5. Run path** — follow `workflows/run-pipeline.md` step by step; every step is a hard gate described in `references/safety-gates.md`. In short:

1. **Refresh unconditionally.** Run `status` for the component (all stages, pipelines included) — even when `snapshot-info` would report the newest snapshot as `fresh: true`; for a promotion it may only be used to state how old the previous data was. Then run the change-risk review for this promotion — invoke the `change-risk` skill (`/release-radar:change-risk <component> <previous stage, or local for the first stage> <stage>`), using the `status` report you just produced as its fresh deployment data, or follow its steps directly (the component checklist at the promoted commit comes from `checklist-check`). A stage that is internally inconsistent stops here until the user picks a target.
2. **Preview.** Run `pipeline-preview` (human form, no `--json`) with the resolved component, stage, target, action and `--select` values, and show its output **verbatim** in a code block. Add the change-risk verdict and its blocking findings next to it. If the preview's commit is not the promoted commit the change-risk review covered, run the review again for exactly `<target's deployed commit>..<preview commit>` before asking anything. A blocked preview (exit 26 or 23, no token) is reported with its blockers, and the skill stops.
3. **Confirm this one run.** Ask one question naming the component, stage, target, action (and kind), and commit: "Queue this one run? Reply yes to confirm." Only an explicit yes to that question counts. Anything that changes (action, target, selection, commit, a new preview) needs a new question.
4. **"Do not promote" override.** When the verdict is *do not promote until X*, list the blocking findings one by one and require a **separate, explicit acknowledgement of each**. Record each in the answer (the finding and the user's words). Never acknowledge on the user's behalf. An acknowledgement never bypasses the ownership or mode gates.
5. **Queue.** Say that a permission prompt will follow, then run `run-pipeline` with `--confirm <token>` from **that** preview and exactly the same component, stage, target, action and `--select` values. If the prompt is denied, stop. Exit 27 (token expired or mismatched, remote head moved) or 26 means nothing was sent: offer a new preview, never a silent retry.
6. **Never auto-retry** (hard rule 5).
7. **Follow read-only** with `pipeline-run <runId> --follow`. A run waiting at an approval or check: report who or what it waits for and stop following; never approve. "Still running" after `followTimeoutMinutes` is a report, not a failure. A finished run that did not succeed (exit 25): report its result and link, and do nothing further. A pin mismatch or unknown outcome (exit 21): report it loudly, never as a success, and do not continue to the landed proof.
8. **Landed proof** after a `succeeded` run, as in `references/lifecycle-model.md` § "Landed proof": for a build, poll `status <component> --stage <stage> --no-pipelines` every `followPollSeconds` within the mapping's `landedWaitMinutes` until the target runs the built commit, tag or digest, then run `verify --expect <built>` **once**; for a configuration action, one `status` read showing the image unchanged, then the configured verification once. Report exactly one outcome:
   - **landed and verified**;
   - **landed, verification failed** (exit 28 — name the failed checks);
   - **landed, verification inconclusive** (exit 30 — name the UNREACHABLE checks; not a failure verdict);
   - **landed, no real-world verification configured**;
   - **not landed** (the window expired or the target runs something else — say what it runs);
   - for a configuration-kind action: **configuration applied; image unchanged**, with its verification result.
</step>

<step name="6_package_path">
**6. Package path** — follow `workflows/assemble-handoff.md`; the package is described in `references/handoff-package.md`. In short:

1. **Refresh.** Run `status` for the component, then the change-risk review from the stage before the handoff stage into it (it includes the key-level settings diffs).
2. **Settle the promoted commit** — normally what the upstream stage runs, from that fresh `status` — and confirm it with the user (short sha, subject, which stage runs it). An inconsistent or unresolved upstream stops here.
3. **Write the package.** Run `handoff-package --commit <full sha>` (a permission prompt follows; it writes only the package directory in the workspace repository).
4. **Report**: the package directory, `complete` or not, the image reference and digest (or "digest unknown"), each copied file by path and size, the settings-diff summary (keys and secret-reference names only), each literal-secret warning **by key name**, the change-risk verdict and findings, the `beforePromote` pointer(s), and the receiving owner. **Exit 23 means the package is incomplete**: list the blocking findings and say plainly that it must not be handed over as complete.
5. **Never print file contents**, never send the package anywhere, never trigger anything. Handing it over is the user's action.
</step>

</process>

<exit_codes>
Read every exit code through `deployment-status/references/exit-codes.md`; the run-path meanings are tabled in `references/safety-gates.md`. The ones that decide what happens next:

| Exit | Meaning here | Next |
|---|---|---|
| 0 | preview with a token / run queued (pin matched or unconfirmed) / run succeeded / package complete | continue to the next gate |
| 20 | auth or preflight: PAT absent, expired or rejected (a 401/403 on the queue request means the PAT lacks Build (Read & execute)); a CLI not logged in | fix credentials; nothing was created |
| 21 | queue rejected, **unknown outcome** (the engine lists runs to find one; never re-queue), **pin mismatch** (the run built another commit), or a source error | report verbatim; never a success; no landed proof |
| 23 | the pipeline, repository, ref or a target does not exist; for `handoff-package`, an **incomplete package** | report; never hand over an incomplete package |
| 24 / 29 | invalid / non-canonical input (including `component.json` invalid at the commit) | back to the canonical-file gate |
| 25 | the run finished with a result other than `succeeded` | report the result and link; nothing further |
| 26 | refused (not triggerable, no mapping, undeclared action, blocked preview, not a handoff stage). **Nothing was sent** | report; offer the read-only reports |
| 27 | token missing, expired or mismatched, or the remote head moved. **Nothing was sent** | a new preview and a new confirmation |
| 28 / 30 | landed proof: verification failed / inconclusive | report the outcome |
| 64 | bad names or arguments | resolve again with the user |
</exit_codes>

<references>
- `references/safety-gates.md` — every gate of the run path, the engine-side guarantees, PAT scopes, permissions.
- `references/lifecycle-model.md` — stages, modes, owners, `operatorTeam`, the triggerable rule, what each skill does per mode, the landed proof and its outcomes.
- `references/handoff-package.md` — the package layout, manifest, settings diff, secret checks, blocking findings.
- `workflows/run-pipeline.md` — the operator script for the run path.
- `workflows/assemble-handoff.md` — the operator script for the package path.
- `../change-risk/SKILL.md` — the risk review that precedes every promotion.
- `../deployment-status/references/exit-codes.md` — exit codes and their precedence.
</references>

<anti_patterns>
<pitfall name="reusing_an_earlier_verdict">
A change-risk verdict from earlier in the conversation, or a snapshot within `freshnessMinutes` (even one `snapshot-info` reports as `fresh: true`), is not fresh for a promotion. Refresh every time.
</pitfall>
<pitfall name="summarising_the_preview">
The preview is the contract the user confirms. Show it verbatim, never paraphrased or trimmed.
</pitfall>
<pitfall name="retrying_after_a_failure">
A failed, rejected or unknown-outcome run is reported and the skill stops. A second run is a new promotion with a new preview and confirmation.
</pitfall>
<pitfall name="treating_success_as_landed">
`succeeded` is the pipeline's view. Only the target running the built version, plus its verification, is landed proof — and a pin mismatch is never a success.
</pitfall>
<pitfall name="handing_over_an_incomplete_package">
Exit 23 from `handoff-package` means blocking findings. The package exists on disk as evidence, not as something to deliver.
</pitfall>
<pitfall name="triggering_another_teams_stage">
No argument, override or acknowledgement makes another team's stage triggerable. Refuse and name the owner.
</pitfall>
</anti_patterns>

<success_criteria>
- The workspace was resolved in the fixed order and passed the canonical-file gate first.
- The path matched the stage's mode and owner; a refusal named both.
- Run path: fresh status and change-risk, verbatim preview, explicit confirmation of that one run, per-finding acknowledgements recorded when the verdict was "do not promote", exactly one `run-pipeline` call, read-only following, and one landed-proof outcome (or the reason there is none).
- Package path: fresh status and change-risk, a confirmed commit, the package written, and the report given with names only, its completeness stated, nothing printed from the files and nothing triggered.
</success_criteria>
