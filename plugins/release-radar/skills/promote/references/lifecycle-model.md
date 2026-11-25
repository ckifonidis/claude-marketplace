# Lifecycle model

release-radar understands a project's **release lifecycle**: an ordered list of stages, each saying how a change is promoted into it and which team owns that promotion. Everything `promote` is allowed to do follows from this model, and so does the shape of every `deployment-status` and `change-risk` answer. This file describes the model, the triggerable rule, a typical two-team lifecycle, what each skill does per mode, and the landed proof after a run. Engine commands are described in the `SKILL.md` "Engine invocation" section; this file never shows an invocation.

## Stages

- The workspace's `workspace.json` declares `stages[]` **in lifecycle order** (the order carries meaning and is never sorted): for example `stage-1`, then `production`.
- The reserved name **`local`** stands for the member clone's HEAD, "as of its last fetch" (release-radar never fetches). It is not a stage and cannot be declared; it is valid only as the starting point of a promotion (`local → stage-1`) and as `settings-diff --from local`.
- Promotion deltas are computed for each **neighbouring pair** along `local → stage-1 → … → last stage`: the downstream..upstream range, a count, and a verdict `equal` / `behind N` / `ahead` / `diverged` / `unknown`.
- Each component declares, in its own `component.json`, which stages it is deployed to: one or more targets per stage, or an explicit `null` ("not deployed by design").
- A stage whose targets run **different** commits is **internally inconsistent**. Its deltas are computed per distinct commit and flagged "inconsistent stage"; `change-risk` gives no single verdict and `promote` runs nothing until the user picks a target.

## Promotion mode and owner

Each stage carries a `promotion` block:

| `mode` | Meaning | `owner` |
|---|---|---|
| `pipeline` | Promoted by an Azure DevOps pipeline run. The operator's team may trigger it, but only when it owns the stage. | required |
| `handoff` | Another team promotes it, from a package the operator prepares: an image reference and settings files. | required |
| `manual` | Promoted by hand, outside release-radar. | required |
| `none` | Not promoted at all (for example a stage only reported on). | absent |

`owner` is a free-text team label (for example `dev-team` or `ops-team`). The workspace's **`operatorTeam`** names the team of the people running the skills from this workspace; it is required as soon as any stage declares an owner.

## The triggerable rule

A stage is **triggerable** exactly when

> `promotion.mode == "pipeline"` **and** `promotion.owner == operatorTeam`.

Nothing else makes a stage triggerable: not an acknowledgement, not a "do not promote" override, not a user's insistence, not a mapping that happens to exist. The engine enforces the rule itself — `pipeline-preview` and `run-pipeline` refuse a non-triggerable stage with exit 26 before any request — and every report shows each stage's mode, owner and triggerability.

The same ownership boundary governs real-world verification: **smoke commands run only on stages owned by `operatorTeam`**. On another team's stage only HTTP and version checks run, and a smoke check is reported "not run (stage not owned)"; an explicit request for it is refused (exit 26).

## A typical two-team lifecycle

A development team can run pipelines up to a pre-production stage. A separate operations team promotes to production from a handed-over image and settings file. In the workspace of `acme-platform`, whose `operatorTeam` is `dev-team`:

| Stage | Mode | Owner | Triggerable for `dev-team` | What reaches it |
|---|---|---|---|---|
| `local` (reserved) | — | — | — | the clone's HEAD |
| `stage-1` | `pipeline` | `dev-team` | **yes** | a pipeline run that builds the remote head of the mapping's ref, pushes an image and deploys it |
| `production` | `handoff` | `ops-team` | no | the image `stage-1` runs, plus the production settings file, packaged for `ops-team` |

For `acme-api`:

- `/promote acme-api stage-1` takes the **run path**: a fresh status and risk review, an exact preview, an explicit confirmation, one queued run, a read-only follow, and the landed proof.
- `/promote acme-api stage-1 config` runs the mapping's declared **configuration-kind** action under the same gates; its result is "configuration applied; image unchanged".
- `/promote acme-api production` takes the **package path**: nothing is triggered; a handoff package is written for `ops-team`.
- Seen from the operations team's own workspace (where `operatorTeam` is `ops-team` and `production` is a `pipeline` stage it owns), the same `production` stage would be triggerable for them. Ownership is always judged against the workspace's `operatorTeam`.

## What each skill does per mode

| Destination mode / owner | `deployment-status` | `change-risk` | `promote` |
|---|---|---|---|
| `pipeline`, owned by `operatorTeam` | reports targets, pipeline runs, pipeline/target drift; verification on request (smoke included) | full review of the promotion | **run path**: preview → confirmation → one run → follow → landed proof |
| `pipeline`, owned by another team | reports targets and runs; verification without smoke | full review | **refuses**, naming the owner and mode; offers the read-only reports |
| `handoff` | reports targets; verification without smoke (unless owned) | full review **plus settings-file diffs** of the declared handoff files ("receiving team must provide", "coordinate removals/renames") | **package path**: a handoff package for the receiving owner; nothing triggered |
| `manual` | reports targets | full review | **refuses**, naming the owner and mode; offers the read-only reports |
| `none` | reports targets | full review | **refuses**, naming the mode; offers the read-only reports |

`beforePromote` pointers — the workspace's `beforePromote[<stage>]` and, on handoff stages, the component's `handoff.beforePromote` at the promoted commit — are shown by `change-risk` and `promote` next to the verdict. They point at work to do (a checklist, another skill, a runbook); release-radar never runs them. Neither overrides the other; both are shown.

## Actions

A pipeline mapping (per target, in `component.json`) declares **actions**: a name, the parameter values the action sets, and a `kind`:

- **`build`** — the run builds the commit, pushes an image and deploys it. Its landed proof waits for the target to run the built version.
- **`configuration`** — the run applies configuration only; the image stays the same. Its landed proof checks that the image is **unchanged**.

`primaryAction` names the action used when none is given. Any other action must be named and declared; an undeclared action is refused (exit 26). Parameters marked `userSelectable` are chosen by the user from their closed list before the preview and are bound into the confirmation token.

## Landed proof (after a succeeded run)

The run's success is the pipeline's opinion. Landed proof is the deployment source's and the application's: it proves that the target actually runs what was built and that it works. It happens **only** after the run finished with result `succeeded` and, for a build, only when the pin check did not report a mismatch.

### Build kind

1. **What to expect.** From the preview and the run: the built commit (the previewed commit), the pushed image tag when the preview determined it, and the pushed digest when one is known.
2. **Poll.** Read the target with the engine's `status` command for the component and stage, every `followPollSeconds` (workspace `azureDevOps`), for at most the mapping's `landedWaitMinutes`. The target has **landed** when it runs the built commit, the pushed tag, or the pushed digest.
3. **Verify once.** Once landed, run the engine's `verify` command for that stage and target **once**, with `--expect` set to the built version: the built commit for version checks that compare `commit`, the pushed tag for checks that compare `tag`. If the stage's version checks use both kinds, run `verify` once per kind with `--check` naming that kind's version checks (the other checks go with the first run), so every check still runs exactly once. Never re-run a check to get a better result.
4. **Window expired.** If `landedWaitMinutes` passes first, the result is **not landed**. That is pipeline/target drift (the run succeeded, the target does not run its output), not a run failure. Report what the target runs instead, and run no verification.

### Configuration kind

The landed proof is: the run's `succeeded` result, plus one `status` read showing the target's image **unchanged** (the same reference and, when known, digest as in the fresh status taken before the run), plus the configured verification run once (expected version: the commit the target runs, which is unchanged). It is reported as **"configuration applied; image unchanged"**. If the image changed, say so plainly: that is not the expected result of a configuration action.

### Outcomes

| Outcome | When | Exit of the verification step |
|---|---|---|
| **landed and verified** | the target runs the built version and every check is PASS | 0 |
| **landed, verification failed** | the target runs the built version and at least one check is FAIL — name the failed checks | 28 |
| **landed, verification inconclusive** | the target runs the built version, no FAIL, at least one UNREACHABLE (or INCONCLUSIVE) — name them; this is not a failure verdict | 30 |
| **landed, no real-world verification configured** | the target runs the built version and the stage/target has no `verification` block | — |
| **not landed** | the window expired, or the target runs something else (pipeline/target drift) — report what it runs instead | — |
| **configuration applied; image unchanged** | a configuration-kind run succeeded, the image is the same, and the verification result is added (verified / failed / inconclusive / none configured) | 0 / 28 / 30 |

A run that did not succeed (exit 25), an unknown outcome or a pin mismatch (exit 21), or a run still waiting for an approval or check gets **no** landed proof: report it and stop.
