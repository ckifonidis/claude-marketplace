# Workflow: run path (one pipeline run)

The step-by-step script for promoting one component to a stage that the operator's team owns and that is promoted by a pipeline (`mode: pipeline`, `owner == operatorTeam`). Each step is a hard gate: when a step fails, report and stop; never skip ahead and never work around a refusal. The gates and the engine's own guarantees are in `../references/safety-gates.md`; the landed proof is in `../references/lifecycle-model.md`. Engine commands are given by name; the exact form of each is in the `SKILL.md` "Engine invocation" section.

Example used throughout (synthetic): workspace `acme-platform`, `operatorTeam: dev-team`, component `acme-api`, stage `stage-1` (mode `pipeline`, owner `dev-team`), target `api`.

## 0. Preconditions

- [ ] The workspace is resolved and has passed the canonical-file gate (`SKILL.md` steps 1–2).
- [ ] Component, stage and action are resolved exactly; an omitted action means the mapping's `primaryAction` (say so).
- [ ] Exactly **one** target is selected. Several mapped targets → the user picks one; each other target is a separate promotion.
- [ ] Every `userSelectable` parameter has a value **the user chose** from its closed list.
- [ ] The stage is triggerable (mode `pipeline` and owner equal to `operatorTeam`). If not, this workflow does not apply: refuse, naming the owner and mode.

## 1. Fresh deployment status

1. Run the engine's `status` command for the component (all stages, pipelines included).
2. Interpret the exit code (`deployment-status/references/exit-codes.md`). Exit 20 is an authentication or tooling problem — give the engine's next step and stop. 24/29 → back to the gate.
3. Note for the target: the commit and image it runs now (repository, tag, digest), and whether the stage is internally consistent. An inconsistent stage stops here until the user picks a target.
4. Note the latest pipeline runs and any pipeline/target drift for the target; mention them in the answer.

Never reuse a report or snapshot from before this invocation.

## 2. Fresh change-risk verdict

1. Run the change-risk review for `<component> <previous stage> <stage>` (`local` when the stage is the first in the lifecycle), using the `status` report from step 1 as its deployment data.
2. Keep the verdict, its findings by severity, the blocking findings, and the `beforePromote` pointer(s).
3. Keep the **promoted commit** the review covered; step 3 checks it against the commit the pipeline will build.

## 3. Preview

1. Run the engine's `pipeline-preview` command in human form, with exactly the resolved component, stage, target, action and `--select` values.
2. **Blocked** (exit 26 or 23, "no confirmation token was issued"): report every `BLOCKED` line and stop. Typical blockers: the commit to build is not in the local clone (the user must fetch; release-radar never fetches), the `component.json` at that commit carries a different mapping, no repository is available for the remote-head check, a placeholder cannot be determined, the pipeline or ref does not exist.
3. **Not blocked** (exit 0): note the commit it will build (the remote head of the mapping's ref), the token, and its expiry.
4. If that commit differs from the promoted commit of step 2, run the change-risk review again in range form for `<target's deployed commit>..<preview commit>` and use that verdict instead. If this took longer than the token's lifetime, run a new preview.

## 4. Show and ask

1. Show the preview output **verbatim** in a code block — every line, including organization, project, pipeline, stage with mode and owner, target, ref and repository, action and kind, every parameter name and value, the commit and whether it is on the remote ref, the local HEAD and whether it is buildable, the image it will push (or "configuration applied; image unchanged" for a configuration action), the verification that will follow, and the token.
2. Next to it: the change-risk verdict, its blocking findings, and the `beforePromote` pointer(s).
3. Ask exactly one question that names the component, stage, target, action with its kind, and the short commit:

   > Queue this one run — `acme-api` → `stage-1`, target `api`, action `build` (kind build), commit `5d6e7f8`? Reply **yes** to confirm.

4. Only an explicit "yes" to that question counts. If the user changes anything (action, target, selection), or a new preview is needed, go back to step 3 and ask again.

## 5. "Do not promote" override (only when the verdict is *do not promote until X*)

1. List the blocking findings, numbered.
2. Ask for a **separate, explicit acknowledgement of each** — one at a time or itemised in one reply, but each finding named. A general "I accept the risk" does not acknowledge a specific finding.
3. Record each acknowledgement in the answer: the finding and the user's words.
4. Never acknowledge on the user's behalf. An acknowledgement never bypasses the ownership or mode gates, and does not replace the confirmation of step 4.

## 6. Queue

1. Tell the user that Claude Code will now show a **permission prompt** for `run-pipeline`, and that it is a second gate.
2. Run the engine's `run-pipeline` command with `--confirm <token>` from **that** preview and exactly the same component, stage, target, action and `--select` values.
3. Prompt denied → stop. Nothing was sent.
4. Read the result:

| Exit / phase | Meaning | Do |
|---|---|---|
| 0, pin `matched` | queued, the run is pinned to the confirmed commit | note the run id and link; step 7 |
| 0, pin `unconfirmed` | queued; the answer did not echo the version (the ref check passed just before queueing) | report the warning; step 7 |
| 27 | token missing, expired or mismatched, or the remote head moved — **nothing was sent** | offer a new preview (step 3) and a new confirmation |
| 26 | refused — **nothing was sent** | report the refusal; stop |
| 20 | PAT absent, expired or rejected; a 401/403 on the queue request means the PAT lacks Build (Read & execute) — no run was created | ask the user to fix the PAT; stop |
| 21, phase `pin-mismatch` | the run exists but builds another commit than the confirmed one | report loudly ("the pipeline built X instead of Y"); never a success; no landed proof; stop |
| 21, phase `unknown-outcome` | no usable answer to the queue request; the engine listed the runs and reports any new one | report it; **never queue again**; follow a detected run read-only, or ask the user to check the pipeline's runs |
| 21 (other) / 23 | the request was rejected, or the pipeline/ref is missing | report verbatim; stop |

## 7. Follow (read-only)

1. Run the engine's `pipeline-run` command for the run id with `--follow` (bounded by `followTimeoutMinutes`; give the Bash call a long enough timeout or run it in the background).
2. Read the result:
   - **phase `complete`, exit 0** — the run succeeded → step 8.
   - **phase `waiting`** — the run waits at an approval or check: report who or what it waits for and stop following. **Never approve.** The user can ask to follow again later.
   - **phase `still-running`** — the follow window passed: report "still running" (not a failure) and offer to follow again.
   - **exit 25** — the run finished `failed`, `canceled`, `partiallySucceeded` or `none`: report the result and the link, and do nothing further.
3. Never cancel, never retry.

## 8. Landed proof

Follow `../references/lifecycle-model.md` § "Landed proof".

**Build kind:**

1. Expected version: the previewed commit, the pushed tag (when the preview determined one), the pushed digest (when known).
2. Poll the engine's `status` command for the component and stage, without pipelines, every `followPollSeconds`, for at most the mapping's `landedWaitMinutes`, until the target runs the expected commit, tag or digest.
3. Window expired → **not landed**: report what the target runs instead (pipeline/target drift). Run no verification. Stop.
4. Landed → run the engine's `verify` command **once** for the stage and target with `--expect` the built commit (version checks comparing `commit`) or the pushed tag (comparing `tag`). If both comparison kinds exist, split by `--check` so each check runs exactly once.

**Configuration kind:**

1. One `status` read for the stage. The image must be the same as in step 1 (reference and, when known, digest).
2. Run the configured verification once (expected version: the unchanged commit the target runs).
3. Report **"configuration applied; image unchanged"** with the verification result. If the image changed, say so plainly instead.

## 9. Answer

One verdict line, then the details:

```
acme-api → stage-1 (target api, action build): landed and verified
Run 4711 succeeded (link); pin matched 5d6e7f8; target api runs 5d6e7f8 after 3 min.
Verification: health PASS (200), version PASS (5d6e7f8).
Change-risk before the run: needs preparation (2 items, both prepared by the user).
```

The outcome is exactly one of: **landed and verified**, **landed, verification failed** (name the failed checks), **landed, verification inconclusive** (name the UNREACHABLE checks), **landed, no real-world verification configured**, **not landed** (say what the target runs), or **configuration applied; image unchanged** — or the reason the run produced none (failed, waiting, still running, pin mismatch, unknown outcome). Include any recorded acknowledgements. Never include a PAT, header value or settings value.
