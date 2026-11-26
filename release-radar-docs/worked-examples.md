# Release Radar in a synthetic workspace

These examples use the compiled engine, temporary Git repositories, a deployment adapter fixture, and Azure DevOps and application servers bound to loopback. The commands use the operator-facing stage names `qa` and `production`. The pipeline fixture calls the team-owned QA stage `stage-1`. The handoff fixture calls the source `stage-2` and the production destination `stage-3`. Commit IDs and temporary paths vary on each run.

## Locate the workspace and inspect a deployment

From the orchestration repository, `/deployment-status acme-api --verify` found successful build **105**. The target was one commit behind that build. The health check returned HTTP 200 and the version check matched the deployed commit. Both checks passed, while the newer build was still waiting to land.

After the example operator confirmed workspace registration, running `/deployment-status` from the `acme-api` clone resolved the workspace through its index and pre-selected `acme-api` at lookup step (c). Removing the `acme-worker` clone mapping and running `/deployment-status --all` left `acme-api` available and reported `acme-worker` as unavailable with reason `no-local-clone`. The fleet command exited 0. A stale index entry is shown in the lookup results. The operator can confirm removal of that individual entry before the skill calls `workspace-index unregister`. [Workspace lookup tests](../plugins/release-radar/engine/test/workspace-index.test.mjs)

In the single-repository case, `workspace.json`, `component.json` and `repos.local.json` lived together in `.release-radar/`. The repository mapping for `acme-api` was `..` relative to the repos file. Starting in the repository resolved it at step (b) and pre-selected the component. [Single-repository fixture](../plugins/release-radar/engine/test/workspace.test.mjs)

## Review what production needs

`/change-risk acme-api qa production` compared the candidate with the older production commit. The candidate's startup code required `/Payments/Endpoint`. Starting it with the destination revision's settings exited 1. The settings comparison identified the added key, changes to `/Logging/Level` and a probable rename from `/Old/FeatureFlag` to `/New/FeatureFlag`. Reports showed key names and secret-reference names.

The generic startup check, the fleet's `startup` checklist item and the component's committed `payments` item all applied. The working tree also listed an extra handoff file in `component.json`. The review reported that difference at `/stages/stage-3/handoff/settingsFiles` and selected the file list at the promoted commit. The verdict was **do not promote until ops-team configures `/Payments/Endpoint`**. [Settings comparison tests](../plugins/release-radar/engine/test/settings-diff.test.mjs) and [committed checklist tests](../plugins/release-radar/engine/test/checklist-check.test.mjs)

## Promote a build and apply configuration

In the operator-owned stage, `/promote acme-api qa` refreshed status and risk, then previewed pipeline 101 on `refs/heads/main`. With the example operator's confirmation for that build, the engine queued **run 900** once. Two read-only polls observed the run in progress and then succeeded. A fresh target read found the previewed commit. The health and version checks both passed. The resulting verdict was **landed and verified**.

`/promote acme-api qa config` used the separately declared configuration action and its own confirmation. **Run 901** succeeded. The target image was identical before and after the run, and both application checks passed. The local Azure DevOps server recorded two queue requests across the two examples, one for each confirmed action. [Pipeline confirmation and follow tests](../plugins/release-radar/engine/test/pipelines-run-gate.test.mjs)

For a team-owned QA promotion with two blocking findings, the user can explicitly acknowledge each one. For example, “I acknowledge that QA lacks `/Payments/Endpoint` and that the QA database still needs its migration.” The skill records each acknowledgement against its finding, shows the exact preview and asks for confirmation of that run. The acknowledgements alone cannot queue it. Ownership still determines who can deploy production. [Operator override workflow](../plugins/release-radar/skills/promote/workflows/run-pipeline.md)

## Hand off to the receiving team

`/promote acme-api production` prepared a local package for **ops-team**. Its manifest named the promoted commit and three files, `config/appsettings.json`, `config/extra.env` and `config/new.json`. Every copy matched its Git blob and the SHA-256 in the manifest. The working-tree-only entry was absent from the package. No pipeline was queued or package sent for this stage. [Handoff package tests](../plugins/release-radar/engine/test/handoff.test.mjs)

## Correct a hand-edited file

A compacted `workspace.json` and a checklist with changed line endings caused `format --check` to return 29. Running `format` rewrote the workspace-owned files, and a second check returned 0. Adding an unknown `surplus` key caused validation to return 24 and identify `/surplus`. Member-owned files require confirmation before the skill includes them in a rewrite. [Format tests](../plugins/release-radar/engine/test/format-command.test.mjs)

To run the installed engine's fixture tests from a checkout with Node.js 20 or newer, use the following commands.

```sh
cd plugins/release-radar/engine
npm ci
npm test
```
