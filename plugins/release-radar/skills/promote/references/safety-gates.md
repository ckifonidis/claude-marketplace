# Safety gates

`promote` is the only skill that changes anything outside the machine, and it changes exactly one thing: it **queues one pipeline run** per confirmation. Everything else it does is read-only. This file states every gate that stands between a request and that run: the gates the skill must apply, and the guarantees the engine enforces whatever the skill does. Engine commands are described in the `SKILL.md` "Engine invocation" section. This file never shows an invocation.

## The run path, gate by gate

Each step is a hard gate. When a step fails, stop and report; never skip ahead, never work around a refusal.

1. **Resolve the workspace and run the canonical-file gate** on every file the run uses. Read the member's `component.json` **at the commit to be promoted**.
2. **Select the path by the stage's mode and owner.**
   - Mode `pipeline` and owner equal to the workspace's `operatorTeam`: the run path (this file).
   - Mode `handoff`: the package path. Nothing is triggered.
   - Anything else (another team's `pipeline` stage, `manual`, `none`): refuse. Name the owner and the mode, and offer the read-only reports (plus a handoff package when the mode is `handoff`).
3. **Resolve the component, stage, target and action exactly.** Names come from the workspace, the `component.json`, the engine or the user, and are never invented. An omitted action means the mapping's `primaryAction`, and the preview says so. An undeclared action is refused. Every `userSelectable` parameter is chosen **by the user** from its closed list. Never pick a value for them.
4. **Refresh unconditionally.** Run a fresh `deployment-status` for the target, then a fresh `change-risk` for this promotion. Ignore `freshnessMinutes`, and never reuse an earlier report or verdict, even one from the same conversation.
5. **Preview.** Run `pipeline-preview` and show its output **verbatim**. It names the organization, project, pipeline (id and name), stage with its mode and owner, target, ref and repository, the action and its kind, **every parameter name and value**, **the commit that will be built** and whether it exists on the remote ref, the local HEAD and whether it is buildable, the image tag it will push (build kind) or "configuration applied; image unchanged" (configuration kind), the verification that will run afterwards (or "no real-world verification configured"), and the confirmation token. Add the change-risk verdict and its blocking findings next to it. When the preview is **blocked** (no token, exit 26 or 23), report the blockers and stop.
6. **Ask for explicit confirmation of this one run.** The question names the component, stage, target, action and commit. Only an explicit "yes" to that question counts. Silence, an ambiguous answer, a confirmation given before the preview, or a blanket "go ahead with everything" does not. If anything changes (a different action, target or selection, or a new commit), run a new preview and ask again.
7. **"Do not promote" override.** When the change-risk verdict is *do not promote until X*, the run is allowed only after a **separate, explicit acknowledgement of each blocking finding**, one by one. Record each acknowledgement in the answer: the finding and the user's words. An acknowledgement never bypasses the ownership or mode gates, and it is never assumed or given on the user's behalf.
8. **Only then queue.** Call `run-pipeline` with `--confirm <token>` from **that** preview and exactly the same component, stage, target, action and `--select` values. `run-pipeline` is never pre-allowed, so the permission prompt appears. That prompt is a **second gate**: if the user denies it, stop.
9. **Never auto-retry.** Whatever the outcome (a refusal, a rejected request, an unknown outcome, a failed run), report it and stop. Every further run needs a new preview and a new confirmation. After an **unknown outcome**, never queue again: follow the run the engine detected, read-only, or ask the user to check the pipeline's runs.
10. **Follow read-only.** Follow the run with `pipeline-run --follow` (or `run-pipeline --follow`), bounded by `followTimeoutMinutes`. When the run waits on an approval or a check, report who or what it waits for and stop following. **Never approve, reject or cancel** anything. "Still running" after the follow window is a report, not a failure. A failed run is reported with its link and nothing further is done.
11. **Landed proof** follows a succeeded run, as described in `lifecycle-model.md`.

## What the exit codes mean on the run path

| Exit | Where | Meaning | What the skill does |
|---|---|---|---|
| 0 | preview | A complete preview and a token | Show it verbatim and ask for confirmation |
| 0 | run | Queued (and, with `--follow`, succeeded, still running or waiting) | Report it; follow read-only; landed proof after success |
| 20 | both | PAT absent, empty, expired or rejected; on the run, a 401/403 to the queue request (the PAT lacks Build (Read & execute)). No run was created | Ask the user to fix the PAT; stop |
| 21 | run | The queue request was rejected (400, 429), its outcome is **unknown**, or the pin check found a **mismatch** | Report verbatim; never retry; follow a detected run read-only |
| 23 | both | The pipeline, the repository or the ref does not exist | Report; stop |
| 24 / 29 | both | An invalid or non-canonical file | Run the canonical-file gate; stop on invalid files |
| 25 | run (`--follow`) | The run finished with a result other than `succeeded` (`failed`, `canceled`, `partiallySucceeded`, `none`) | Report it with its link; nothing further |
| 26 | both | Refused: not triggerable, no mapping, undeclared action, or a blocked preview. **Nothing was sent** | Report the refusal; offer the read-only reports or a package |
| 27 | run | The token is missing, malformed, expired, does not match, or the remote head moved. **Nothing was sent** | Run a new preview and ask again |
| 64 | both | Bad arguments or names | Correct them from the engine's list of valid names |

## Engine-side guarantees

These hold whatever the skill does, and the test suite proves each one.

**Order of the gates.** `run-pipeline` checks, in this order, and sends **nothing that writes** before every check has passed:

1. arguments and names (64), canonical workspace (24, 29);
2. triggerability, mapping, declared action, renderable parameters (26), and `userSelectable` choices (64);
3. the PAT (20), before any request;
4. the token: present, decodable, not expired, not claiming an expiry beyond the TTL (27), before any request;
5. the preview, **recomputed from scratch** with reads only (Pipelines Get, Git Refs, local git); a blocked preview gives its own exit (26 or 23);
6. the token's commit and digest against the recomputed request (27);
7. a read of the pipeline's latest runs, the baseline for detecting an unknown outcome;
8. the remote ref head, **re-read immediately before queueing**; a head that moved is refused (27);
9. the queue request.

**26 and 27 mean nothing was sent.** No request that writes is ever sent on exit 26 or 27. Most refusals happen before any request at all.

**Exactly one queue request, never retried.** The queue request is sent once. No outcome, including a timeout, a rejection or a failed run, leads to a second one. Only one engine module can send a request other than GET, only `run-pipeline` uses it, and no other command even loads it. `pipeline-preview` sends GET requests only (no `previewRun`): Azure DevOps offers no read that returns a pipeline's declared parameters, so parameters are validated locally against the mapping's template and declared actions.

**The token binds the whole request.** The token is bound to the organization, project, pipeline id and name, repository, ref, **commit**, component, stage, target, action and its kind, **every parameter value**, the selected `userSelectable` values, and the engine version. It expires after the workspace's `confirmTokenTtlMinutes`. The digest covers the expiry, so editing the expiry breaks the token, and a token claiming more than the configured TTL is refused. The token is a **commitment, not an authenticator**: no secret is involved. It proves that the run is exactly the previewed one and that the preview is recent. The authenticator is the human confirmation of the verbatim preview, followed by the permission prompt.

**The commit that is built.** The commit is the **remote head of the mapping's ref**, read through the Azure DevOps Git Refs API. It is pinned in the queue request through the Runs API's repository version. In addition:

- the local clone must contain that commit, so that the change-risk review could have seen it (otherwise 26: fetch first; release-radar never fetches);
- the member's `component.json` at that commit must carry the same pipeline mapping for the target as the working tree (otherwise 26);
- a local HEAD with commits that are not on the remote ref is shown as **not buildable**. The run never builds unpushed work.

**Pinning plus the ref check.** Because the pin's semantics are not documented by Microsoft, the engine never relies on the pin alone: the Git Refs check is mandatory. The repository it reads is the mapping's `repository`, or else the pipeline's own repository as reported by Pipelines Get when that is an Azure Repos Git repository. When neither is available (or the repository is on another host), the run is refused (26): neither pinning nor the ref check is possible. A head that moved since the preview, or between the recomputation and the queue request, is refused (27) without sending anything.

**The pin check after queueing.** When Azure DevOps echoes the run's repository version:

- the version equals the previewed commit: **matched**;
- the answer carries no version: **unconfirmed**, reported as a warning (the ref check passed immediately before queueing);
- the version is a different commit: a loud **pin mismatch** ("the pipeline built X instead of Y") with exit 21. The run exists and cannot be undone. It is not the confirmed commit, so the result is never reported as a success, and landed proof must not proceed as if it were.

**Unknown outcome.** When the queue request gets no answer (timeout, connection reset), a server error, or an answer without a run id, a run may or may not exist. The engine never sends the request again. It lists the pipeline's runs read-only, compares them with the baseline taken before the request, and reports any run that appeared (with its id, link, and whether its ref and commit match the request). The exit is 21 whether or not a run was found.

**Nothing else is ever done.** The engine never approves, rejects or cancels a run, never edits a pipeline definition or a configuration file, and never acts on more than one target or action per confirmation.

**Placeholders that cannot be determined are refused.** A parameter that uses `{image.repository}`, or `{image.tag}` without a `pushedTagTemplate`, is refused (26). No value is ever guessed.

## PAT scopes

All Azure DevOps access uses the personal access token in `AZURE_DEVOPS_EXT_PAT`. The optional `AZURE_DEVOPS_PAT_EXPIRES` gives renewal warnings. Neither value is ever shown, logged or recorded.

| Feature | Scopes |
|---|---|
| Pipeline sections of `status`, `pipeline-runs`, `pipeline-run`, `pipeline-preview` | **Build (Read)** and **Code (Read)**. Code (Read) is needed for the Git Refs remote-head check. |
| `run-pipeline` | **Build (Read & execute)** in addition |

Recommendation: use a **separate read-only PAT** (Build (Read) + Code (Read)) for everyday reporting, and for users who never trigger runs. Provide a PAT with Build (Read & execute) only in the session where a run will actually be queued. A read-only PAT turns any accidental queue attempt into a rejected request (exit 20), so no run is created.

## Permissions

`run-pipeline` is **never** pre-allowed in a skill's `allowed-tools`, and neither are `handoff-package`, `format` without `--check` (only the read-only `format --check` form is pre-allowed), or `workspace-index register|unregister`. Every queue attempt therefore raises Claude Code's permission prompt, which is a second, independent gate after the confirmation. Never suggest adding `run-pipeline` to an allow list.

## Before the first real run

Some Azure DevOps behaviours are modelled rather than confirmed. Before the first real `promote`, check them in a sandbox project:

- whether the Runs API repository version pins the commit, and whether the answer echoes it;
- what happens when the pinned commit is not on the ref;
- whether the run id equals the build id;
- whether Pipelines Get reports the pipeline's repository (otherwise declare `repository` in the mapping);
- whether an approval id equals its timeline record id.
