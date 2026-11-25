# Workflow: package path (handoff to another team)

The step-by-step script for a stage whose mode is `handoff`: another team deploys it, and the operator prepares what that team needs. **Nothing is triggered and nothing is sent.** The package is written to disk in the workspace repository; handing it over is the user's own action. The package itself is described in `../references/handoff-package.md`. Engine commands are given by name; the exact form of each is in the `SKILL.md` "Engine invocation" section.

Example used throughout (synthetic): workspace `acme-platform`, `operatorTeam: dev-team`, component `acme-api`, lifecycle `stage-1` (pipeline, `dev-team`) → `production` (handoff, `ops-team`).

## 0. Preconditions

- [ ] The workspace is resolved and has passed the canonical-file gate (`SKILL.md` steps 1–2).
- [ ] Component and stage are resolved exactly, and the stage's mode is `handoff`.
- [ ] An `[action]` argument was not given, or the user was told that actions apply only to pipeline stages and agreed to continue with the package.

## 1. Fresh deployment status

1. Run the engine's `status` command for the component (all stages).
2. Interpret the exit code. Exit 20 is an authentication or tooling problem — give the engine's next step and stop.
3. Identify the **upstream stage**: the stage immediately before the handoff stage in the lifecycle (`stage-1` before `production`). Note what it runs: the commit, the image reference and the digest per target.
4. Stop and report when the upstream stage is internally inconsistent (its targets run different commits — the user picks one), unresolved (no clone, tag not found, digest-pinned, no convention, git error — name the reason), or does not deploy the component.

## 2. Settle and confirm the promoted commit

1. The promoted commit is normally what the upstream stage runs. Show it: full and short sha, subject, and which upstream targets run it.
2. Ask the user to confirm that this commit is the one to hand over. If the user names another commit, it must exist in the member's clone (`git rev-parse --verify <sha>^{commit}`); the engine will still check it against the upstream stage and record a mismatch as blocking.
3. Never default the commit silently; the engine requires it explicitly (`--commit`).

## 3. Fresh change-risk verdict

1. Run the change-risk review for `<component> <upstream stage> <handoff stage>`, using the `status` report from step 1 as its deployment data.
2. It includes the key-level diffs of every declared settings file between what the handoff stage runs now and the promoted commit: added keys and new secret-reference names ("receiving team must provide"), removals and renames ("coordinate"), changed keys (never values).
3. Keep the verdict, its findings, and the `beforePromote` pointer(s). A *do not promote until X* verdict does not stop the package from being written — it is evidence for the receiving team — but the answer must lead with it.

## 4. Write the package

1. Tell the user that Claude Code will show a **permission prompt**: `handoff-package` writes the package directory under the workspace's `.release-radar/handoff/`.
2. Run the engine's `handoff-package` command with `--commit <full sha>` from step 2.
3. Read the result:

| Exit | Meaning | Do |
|---|---|---|
| 0 | complete package written | step 5 |
| 23 | package written but **incomplete** (`complete: false`, `blocking[]`): a declared settings file missing at the commit, or no image could be determined (no upstream stage, upstream missing, inconsistent, unresolved, or running a different commit) | step 5, leading with the blocking findings; **never hand it over as complete** |
| 24 | invalid input, including `component.json` missing or invalid at the promoted commit ("<file> invalid at <sha>: <location>") | report the location; the file must be fixed; stop |
| 26 | not a `handoff` stage, or the component declares the stage not deployed | report; stop |
| 29 | non-canonical input | back to the canonical-file gate |
| 20 / 21 | the live read's preflight or source failed; nothing was written | fix credentials or report the source error; stop |
| 64 | unknown names, or `--commit` missing, not a sha, or not in the local clone | resolve again with the user |

## 5. Report

Read the engine's report (names, sizes and the manifest fields — never the copied files). The answer gives:

1. The **verdict line**: complete or incomplete, and the change-risk verdict.
2. The **package directory** (`.release-radar/handoff/acme-api-production-<timestamp>/`).
3. The **receiving owner** (`ops-team`).
4. The **image**: reference as the source reported it, and the digest — or "digest unknown".
5. The **files**: each copied settings file by path and byte size, copied verbatim at the promoted commit.
6. The **settings diff** against what the handoff stage runs now: per file the status, added / removed / renamed / changed keys as JSON pointers, and secret-reference names. "not compared" with its reason when the handoff stage's commit could not be resolved.
7. **Literal-secret warnings**, by file and key name only: "`settings.production.json` `/Storage/AccountKey` looks like a literal secret, not a secret reference". Never the value.
8. The **change-risk findings** for this promotion, by severity.
9. The **`beforePromote` pointer(s)**: the workspace's and the component's, both when both exist.
10. For an incomplete package, each **blocking finding** and the statement that the package must not be handed over until they are resolved (then run the package path again).

Example:

```
acme-api → production (handoff to ops-team): package complete; change-risk: needs preparation (2 items)
Package: .release-radar/handoff/acme-api-production-<timestamp>/
Image: <reference as reported> (digest sha256:…)
Files: settings.production.json (2.1 KB)
Settings diff vs production's 1a2b3c4: +/Payments/Endpoint, secret reference added: acme-kv/payments-api-key
Literal-secret warnings: none
Before promoting: workspace "<pointer>"; component "<pointer>"
```

## 6. Never

- Print the content of a settings file or a copy — not in a code block, not in a summary, not partially.
- Send, upload or attach the package anywhere, or trigger any pipeline.
- Edit the package's files (they are verified against the manifest's sha256; a modified copy makes the package invalid — the remedy is to run `handoff-package` again).
- Edit `component.json`, settings files or pipeline definitions to make a package complete.
