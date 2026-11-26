# Exit codes

Every engine run ends with an exit code and one trailer line:

```
RELEASE_RADAR_RESULT=<OK|FAIL> PHASE=<phase> EXIT=<code>
```

The trailer is the last line of **stdout** after a successful human-readable run, and the last line of **stderr** otherwise. With `--json` it is always on **stderr**, so stdout holds exactly one JSON document. `OK` appears only with exit 0. Read the exit code (or the trailer's `EXIT=`) first; the prose around it explains, it does not decide.

The numbers are a public contract and are never renumbered. Engine commands are described in the `SKILL.md` "Engine invocation" section; this file never shows an invocation.

## The codes

| Code | Example phases in the trailer | Meaning | Report printed? | Snapshot written by `status`? |
|---|---|---|---|---|
| **0** | `complete`, `preview`, `queued`, `in-progress`, `waiting`, `still-running` | The command succeeded. The phase gives the pipeline state when a run is pending. | yes | yes |
| **1** | `internal` | Unexpected internal error. Never used for configuration problems. | no | no |
| **20** | `preflight` | Authentication or preflight failed: a source CLI is missing or not logged in, a kube context is unusable, the Docker daemon is unreachable, the Azure DevOps PAT is absent, invalid or expired, or a verification header variable is missing. | **no** — the whole run fails, no partial report | no |
| **21** | `source`, `preflight`, `resolve`, `unknown-outcome`, `pin-mismatch` | A source error, ambiguous target or unresolved queue outcome. | `settings-diff` reports a stage that cannot be resolved to one commit. A queue attempt can include a reconciliation report. | no |
| **22** | `drift` | The drift gate tripped (`--fail-on-drift`). | yes, complete | yes |
| **23** | `missing`, `blocking` | A required target, pipeline or handoff artifact is missing, or the handoff image could not be established. | `status` reports everything it found. `settings-diff` identifies a missing target. A written handoff package has `complete: false` and lists the reasons in `blocking`. | yes |
| **24** | `load`, `validate` | The engine found invalid input, a missing configured checklist or an unavailable requested member. The diagnostic identifies the file and location when available. | `format` lists the invalid files it inspected. | no |
| **25** | `pipeline` | A pipeline run finished with a result other than `succeeded` (`partiallySucceeded`, `failed`, `canceled`, `none`). It is never retried. | yes | — |
| **26** | `refused` (`pipelines` for "no mapping") | Refused: the stage is not triggerable (mode or owner), there is no mapping, the action is undeclared, a parameter cannot be rendered, a smoke command was requested on a stage the operator's team does not own, or a handoff package was asked for a stage that is not a `handoff` stage. No write request was sent. | — | — |
| **27** | `token` | The confirmation token is missing, mismatched or expired, or the remote head moved since the preview. No write request was sent. | — | — |
| **28** | `verification` | Real-world verification failed: at least one check returned FAIL. | yes, complete | yes |
| **29** | `canonical` | A valid file needs canonical formatting. | `format` and `validate-config` identify the affected files. | no |
| **30** | `verification` | Real-world verification inconclusive: at least one check is UNREACHABLE or INCONCLUSIVE (the application answered but the expected version is unknown) and none FAILED. | yes, complete | yes |
| **64** | `arguments` | Bad arguments: an unknown or duplicate flag, a missing required flag, `--config` (use `--workspace`), or an unknown component, stage, action, adapter or drift pair. Decided before any source, git, REST or HTTP call; the message lists the valid names. | no | no |

Who produces which code: **25** comes from `pipeline-run` and `run-pipeline --follow`; **27** only from `run-pipeline`; **26** from the verification commands (an explicitly requested smoke check on a stage the operator's team does not own), from `pipeline-runs` / `pipeline-run` (no mapping in scope), from `pipeline-preview` / `run-pipeline` (the run gate's refusals) and from `handoff-package` (not a `handoff` stage); **28** and **30** from `verify` and `status --verify`.

Some exits carry a more specific phase in the trailer: `pipeline-run` and `run-pipeline --follow` exit **0** with phase `in-progress`, `waiting` (stopped at an approval or check — nothing is ever approved) or `still-running` (the follow window ended), none of which is a failure; `run-pipeline` exits **21** with phase `unknown-outcome` (no readable answer to the queue request — it is never re-sent; any run that appeared is reported) or `pin-mismatch` (the pipeline built another commit than the one confirmed — never report it as success).

## Precedence

When several conditions occur in one run, the earliest entry in this order wins:

**64 > 24 > 29 > 20 > 26 > 27 > 21 > 25 > 23 > 28 > 30 > 22**

Examples:
- An unknown component name in a workspace that is also non-canonical exits **64**: names are checked first.
- A missing target together with a tripped drift gate exits **23**. The report still records the drift findings and `drift.tripped: true`.
- A verification FAIL together with a missing target exits **23**.
- An authentication failure always wins over "missing": it exits **20**, never 23.

## Which runs write a snapshot

A `status` run that produces a report writes `.release-radar/snapshots/<timestamp>.json` in the workspace: exits **0, 22, 23, 28 and 30**. Runs ending in **1, 20, 21, 24, 29 or 64** write none. `status` never deletes snapshots; pruning to `snapshotRetention` is part of `format`'s cleanup.

## What the skill must say

| Code | Say | Never say |
|---|---|---|
| 0 | Report the result. | — |
| 20 | "This is an authentication or tooling problem, not a missing deployment." Give the exact next step the engine printed: `az login` (with the tenant when shown), refresh or select the kube context, start Docker, install the named CLI, set or renew `AZURE_DEVOPS_EXT_PAT`, or set the named verification header variable. Then offer to run again. | "absent", "not deployed", "missing", "no runs", "verification failed" |
| 21 | Quote the source error. Say that nothing was concluded about the targets. For an ambiguous name, say which subscriptions hold it. | "missing" |
| 22 | Name each drift finding (stage and targets for within-stage inconsistency; the stage pair and verdict for a named pair). The full report is still valid. | that the deployment is broken |
| 23 | Name each missing target with its stage, then report everything that was found. Suggest `discover` to list what exists. | that the whole component is absent |
| 24 | Quote the file and exact location. For an unavailable requested member, say which (no local clone / no component config) and offer `init-component` or fixing the repos file. | — |
| 25 | Give the run ID and final result, including a partial success or cancellation. | that the target is running the requested build |
| 26 | Name the stage owner, mapping or action that caused the refusal. | that a pipeline was queued |
| 27 | Generate a fresh preview and obtain confirmation for that exact run. | that an earlier confirmation still applies |
| 28 | Name each failed check and the comparison that failed. | credentials or header values |
| 29 | Name the file and say it is valid but needs `format`; follow the canonical-file gate (re-format workspace and engine files automatically; ask once before re-formatting files in member repositories). | that the file is broken |
| 30 | Name each UNREACHABLE check and why; say the result is inconclusive. | "failed" |
| 64 | Go back to argument resolution: show the valid names the engine listed and ask. Never substitute a near match without the user's confirmation. | — |
| 1 | Say the engine hit an internal error and quote it. | any conclusion about the deployment |

## Sections that carry no results on purpose

Two report sections can be present without results. The skill must present them as stated, never as findings:

- `pipelines.status`: `"read"` means run facts were read. `"omitted"` means `--no-pipelines` was passed — say "pipelines omitted (--no-pipelines)". `"not-configured"` means no target in scope has a pipeline mapping. None of these is "no runs": "no runs" is only a `read` section whose run list is empty. Engine builds before the pipeline reads emitted `"not-implemented"`; if it ever appears, say "pipeline runs are not available in this engine version".
- `verification.status`: `"ran"` carries the results. `"not-requested"` means `--verify` was not passed — say that no check ran. Engine builds before the verification runner emitted `"not-implemented"`; treat it the same way (no check ran).
