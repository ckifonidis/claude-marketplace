# Workflow: initialise a workspace

Creates `.release-radar/workspace.json`, the per-machine repos file and (optionally) a fleet `checks.md` in the **workspace repository** — the orchestration repository of a multi-repo project, or the one repository of a single-repo project — and proposes the `.gitignore` lines. Every key is documented in [../references/config-schema.md](../references/config-schema.md); read it before drafting.

Engine commands are named here by command only; run each one exactly as shown in the `SKILL.md` "Engine invocation" section. This file never shows an invocation.

## Ground rules

- **Facts come only from the user, from files the user points at, and from read-only engine commands.** Never invent a stage, team, member, repository key, path, subscription, organization URL or project. When you suggest a value (for example a timeout), label it a suggestion; it is written only after the user confirms it. Nothing is ever filled in silently: the engine has no defaults and neither does this workflow.
- **No directory scanning.** Clone paths come from the user. You may check that a path the user gave exists (Glob/Read), nothing more.
- **Write only after explicit confirmation** of the complete draft, and only these files: `.release-radar/workspace.json`, `.release-radar/repos.local.json` (when the repos file is owned), the fleet checklist (when the user wants one), and the workspace repository's `.gitignore` lines.
- **Skills never hand-write a final structured file.** You write a *draft*; the engine's `format` command turns it into the canonical file, and `validate-config` proves it. A file that `format` reports invalid is fixed with the user and formatted again.
- **Never commit, push or stage anything.** The user manages git.
- **Names only.** Never ask for, write or echo a secret, token or header value. The Azure DevOps PAT is an environment variable and never enters a file.

## Step 1: Check the starting point

1. Determine the repository root of the current directory (`git rev-parse --show-toplevel`; outside a git repository, the current directory) and confirm with the user that the workspace belongs there.
2. If `<root>/.release-radar/workspace.json` already exists, stop: this is not an initialisation. Offer to use it (back to the SKILL.md steps) or to change it through the same draft → `format` → `validate-config` cycle.
3. Run the engine's `workspace-index resolve` command for the root. If another registered workspace already covers this location, tell the user and ask whether a second workspace is really intended.

## Step 2: Gather the facts

Ask in this order. Keep the questions short; batch related ones. Record each answer as given.

1. **Project shape:** multi-repo (this repository orchestrates members that live in other repositories) or single-repo (the one component lives in this repository).
2. **Stages, in promotion order.** For each stage:
   - its name (lower-case `a-z 0-9 . _ -`; `local` is reserved and cannot be used);
   - how its images are tagged → the tag convention: the commit sha (`sha`), a git tag with an exact prefix (`git-tag` + `gitTagPrefix`, e.g. `v`), a mixed scheme (`regex` with a named group `ref`, plus whether the capture is a sha or a git tag), or not traceable (`none`). If the user is unsure, say that the convention can be checked against a real tag once a component is set up (`discover` shows running images), and that a component may override it per stage;
   - its promotion `mode` (`pipeline`, `handoff`, `manual`, `none`) and, unless `none`, its `owner` team.
3. **`operatorTeam`:** the team the operator belongs to (required as soon as any stage has an owner). Then state the consequence back: which stages are **triggerable** (mode `pipeline` and owner = operatorTeam) and which are not, and let the user correct it.
4. **Members.** For each component: its name, its `repoKey`, and its `repoSubdir` (`null` for the repository root; a relative path for a monorepo subdirectory — several members may share one `repoKey` with different subdirectories, but never the same location twice). A member with no clone by design has `repoKey: null`. In a single-repo project there is exactly one member, mapped to the repository root.
5. **Repos file.** Owned (`.release-radar/repos.local.json`, gitignored, one per machine) or external (a mapping file other tooling already maintains: its path relative to the workspace root). For an owned file, ask for each `repoKey`'s clone path on this machine and write it **relative to `.release-radar/`** (a sibling clone is `../../<folder>`; the single-repo root is `..`). Check each path exists; a missing path is not an error (the member is then reported `unavailable (no local clone)`), but say so.
6. **Adapters** the members will use (`azure-appservice`, `azure-containerapp`, `kubernetes`, `compose`, `command`), each with its `timeoutSeconds`. For `azure-appservice`, the subscription ids to search **per stage** (from the user; never looked up by guessing). For `command`, the optional `discoverArgv`. A block is needed for every adapter a target will use; without it `discover` lists nothing.
7. **Azure DevOps** — only if any member will have a pipeline mapping: `organizationUrl` (the full base URL), the default `project`, `requestTimeoutSeconds`, `runHistoryCount`, `followPollSeconds`, `followTimeoutMinutes`, `confirmTokenTtlMinutes`, `patExpiryWarningDays`. Explain the credential: `AZURE_DEVOPS_EXT_PAT` (scopes Build Read and Code Read; Build Read & execute only for triggering runs) and the recommended `AZURE_DEVOPS_PAT_EXPIRES` (ISO-8601 date) so expiry is warned about in advance. Never ask for the token itself.
8. **Fleet settings:** `gitTimeoutSeconds`, `freshnessMinutes`, `snapshotRetention`, `handoffRetention`; the fleet `checklist` (`null`, or a path such as `.release-radar/checks.md`); any `beforePromote` pointer per stage.

## Step 3: Show the complete draft and get confirmation

Show, in one message:
- the draft `workspace.json` and the draft repos file (or the external path), in the key order of `config-schema.md`;
- when a fleet checklist was chosen and does not exist yet, the skeleton — exactly the header and version lines, plus only the items the user dictated (grammar in [../references/file-formats.md](../references/file-formats.md)):

  ```
  # release-radar checklist

  schemaVersion: 1
  ```
- a summary: stages with mode/owner/triggerable, members with their resolved clone locations, adapters, whether pipelines are configured;
- the files that will be written, with their absolute paths.

Ask for explicit confirmation. Any change → update the draft and show it again. No confirmation → write nothing.

## Step 4: Write the drafts, then make them canonical

1. Write the repos file (owned case), the checklist skeleton (if chosen), then `workspace.json` — each exactly as confirmed.
2. Run the engine's `format` command on the workspace. It is not pre-allowed, so a permission prompt appears; tell the user why: it re-renders the drafts in release-radar's single canonical form (key order, indentation, sorted lists) without changing any value. Summarise what it changed.
3. If `format` exits **24**, show the file and the exact location (JSON pointer and line:column) with the message, fix the draft **with the user**, and run `format` again. Never work around a reported problem.

## Step 5: Validate

Run the engine's `validate-config` command. Expect exit **0**:
- Show the **configured commands** it lists (command-adapter and `discoverArgv` argv). The engine cannot prove they are read-only; the user must look at each.
- Members are typically `unavailable (no component config)` at this point, because their `component.json` does not exist yet. That is expected; offer [init-component.md](init-component.md) for each one. `unavailable (no local clone)` means the repos file does not map the key or the path does not exist.
- Any other exit: interpret it with [../references/exit-codes.md](../references/exit-codes.md) and fix before continuing.

## Step 6: Gitignore lines (workspace repository only)

Read the workspace repository's `.gitignore` (it may not exist). Propose only the lines that are missing from:

```
.release-radar/snapshots/
.release-radar/handoff/
.release-radar/quarantine/
.release-radar/repos.local.json
```

Add them only after the user confirms. With an external repos file the last line is not needed for release-radar (the external file is not inside `.release-radar/`), but propose it if the user may still create an owned one.

## Step 7: Register and hand over

1. Offer to register the workspace in the per-user index so the skills can find it from member clones and other directories. Only after a yes, run the engine's `workspace-index register` command for the workspace root (it prompts for permission; it writes only the index file).
2. Tell the user what to commit in the workspace repository (`workspace.json`, the fleet checklist, `.gitignore`) and what never to commit (`repos.local.json`, snapshots, handoff packages, quarantine). Do not commit anything yourself.
3. Next: [init-component.md](init-component.md) for each member, then `/deployment-status`.
