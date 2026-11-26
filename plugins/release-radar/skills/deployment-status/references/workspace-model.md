# Workspace model

How release-radar finds its configuration: one **workspace** that lists the fleet, and one **component** file per member that lives only in that member's own repository. Every key of every file is in [config-schema.md](config-schema.md); canonical form and `format` are in [file-formats.md](file-formats.md); exit codes are in [exit-codes.md](exit-codes.md). Engine commands are described in the `SKILL.md` "Engine invocation" section; this file never shows an invocation. All names are synthetic (`acme-platform`, `acme-api`, `acme-jobs`).

## Two levels, each configuration in one place

| Level | File | Lives in | Holds | Never holds |
|---|---|---|---|---|
| workspace | `.release-radar/workspace.json` | the orchestration repository (`acme-platform`), or the one repository of a single-repo project | the ordered stages and their lifecycle, `operatorTeam`, the explicit `members` list, the repos-file location, fleet-wide settings (`freshnessMinutes`, fleet `checklist`, `beforePromote`, retention counts, adapter and Azure DevOps settings) | any component definition — targets, pipeline mappings, actions, handoff artefacts, verification. A workspace that contains one is invalid (exit 24). |
| component | `<clone>[/<repoSubdir>]/.release-radar/component.json` | each member's **own** repository | that component's targets per stage, tag-convention overrides, pipeline mappings and actions, handoff settings files, verification | fleet settings |

Next to each `component.json`, a member may keep its own `checks.md` (the component checklist layer). The fleet checklist is a file in the workspace repository, named by `workspace.json`'s `checklist` (`null` = no fleet layer).

Two per-machine or per-user files complete the picture:

- the **repos file** maps each `repoKey` to a clone path on this machine. It is either **owned** — `.release-radar/repos.local.json` next to `workspace.json`, gitignored, values relative to the `.release-radar/` directory, re-formatted by `format` — or **external** — a file of the same mapping shape owned by other tooling, at the path `workspace.json` names (relative to the workspace root), validated but never rewritten and never refused as non-canonical ("externally owned — not re-formatted");
- the **workspace index** — a per-user list of registered workspace roots under the plugin data directory (see the last section).

## Members are located through the repos file only

A member entry is `{ name, repoKey, repoSubdir }`, all three explicit:

- the clone is `repos[repoKey]` from the repos file, resolved against the repos file's own directory, and must be an existing directory;
- the component root is the clone itself (`repoSubdir: null`) or `<clone>/<repoSubdir>`;
- the component file is `<component root>/.release-radar/component.json`; the component checklist is `<component root>/.release-radar/checks.md`.

Nothing else is consulted. **No directory is scanned or globbed**: a sibling folder with a similar name, a git worktree copy of a member, or a `component.json` in a repository that is not a member is never read from the workspace side, even when it is byte-identical. The only way to make the engine read a repository is to list it as a member and map its `repoKey`.

## Monorepos and multi-flavour repositories

Several members may share one `repoKey` when each has a **different** `repoSubdir`:

```
acme-jobs/                          (one clone, repoKey "acme-jobs")
  export/.release-radar/component.json     member acme-jobs-export, repoSubdir "export"
  export/.release-radar/checks.md          its own checklist (optional)
  import/.release-radar/component.json     member acme-jobs-import, repoSubdir "import"
```

Locations are compared **after normalisation** — relative to the clone root, without `.` segments, repeated or trailing `/` — so `export`, `./export` and `export/` are the same location. Two members with the same `repoKey` and the same normalised location make the workspace **invalid** (exit 24, pointing at the later member's `repoSubdir`). A member with `repoSubdir: null` occupies the repository root. An absolute path, `\`, any `..`, or a value that normalises to the root (`.`) is invalid; the root is written `null`. Git operations for such a member run in the shared clone; paths read at a commit are prefixed with its `repoSubdir`.

## Unavailable versus invalid

| State | When | In a fleet run (`--all`) | When that member is requested by name |
|---|---|---|---|
| `unavailable (no local clone)` | `repoKey` is `null` (no clone by design) or not mapped in the repos file, or the mapped path does not exist | reported with the reason and excluded; the run continues | exit **24**, naming the member and the missing key or path |
| `unavailable (no component config)` | the clone exists but has no `component.json` at the expected location | reported and excluded (offer `init-component`) | exit **24** |
| **invalid** | `workspace.json`, the repos file or a loaded `component.json` fails parsing or schema validation; a `component.json` whose `name` differs from the member name or that references a stage the workspace does not declare; a missing configured fleet checklist; a duplicate `repoKey` + location | the run stops: exit **24** with the file and JSON pointer (or line:column) | exit **24** |
| **non-canonical** | a valid file that is not in canonical form | every command except `format` refuses it with exit **29**; the skills' canonical-file gate re-formats it first | exit **29** |

Unavailable is a reported state, never a silent omission: `status` lists unavailable members in its report and records each member's availability in the snapshot.

## Which `component.json` revision each skill reads

| Reader | Revision | Non-canonical there | Invalid there |
|---|---|---|---|
| `deployment-status` (`status`, `verify`, `pipeline-runs`, `snapshot-info`'s current fingerprint) | the **working tree** of the mapped clone | refused (29) until `format` re-formats it — in a member repository only after the user confirms (`--include-members`) | exit 24 |
| `change-risk` | **at the promoted commit**, read with `git show` (`settings-diff` reads `component.json`; `checklist-check` reads the component checklist) | used as is and reported "non-canonical at <sha>"; the skill may offer to re-format the working-tree copy | a **blocking finding** ("<file> invalid at <sha>: <location>"); the verdict cannot be *safe to promote* |
| `promote` | **at the promoted commit** (the preview's config line on the run path, `handoff-package` on the package path, and the change-risk review before both) | used and reported | the promotion is refused until the file is fixed |

When the working-tree and promoted-commit versions differ, the reports say so and name the differing keys (JSON pointers, compared in canonical form, so pure re-formatting is no difference). A file read at a commit is **never** rewritten: history is never touched.

## Single-repo projects

When the orchestration repository and the only component are the same repository, everything sits together in its `.release-radar/`:

```
acme-api/.release-radar/
  workspace.json        members: [{ "name": "acme-api", "repoKey": "acme-api", "repoSubdir": null }]
  repos.local.json      { "repos": { "acme-api": ".." } }   (the repository root, relative to .release-radar/)
  component.json
  checks.md             (optional)
```

No rule is bypassed: the single member is still located through its explicitly mapped `repoKey`, and the revision rules above still apply. Because the member's clone **is** the workspace repository, its `component.json` and `checks.md` count as workspace-repository files, so `format` re-formats them without `--include-members`.

## Workspace resolution order

Every skill resolves the workspace in this fixed order and stops at the first step that gives an answer:

- **(a)** an explicit `--workspace <path>` (the root, or its `.release-radar/workspace.json`), or a path the user names;
- **(b)** a `.release-radar/workspace.json` found by searching **upward** from the current directory to the git root (the nearest directory containing `.git`); outside a git repository only the current directory itself is checked. When the current directory also lies inside one of that workspace's member clones, that member is pre-selected;
- **(c)** the current directory is inside a **member's mapped clone** of a **registered** workspace → that workspace, with that component pre-selected. The deepest matching clone wins; when several members share that clone (a monorepo), each is a candidate;
- **(d)** the current directory is inside the root of a **registered** workspace.

The engine's `workspace-index resolve` applies (b)–(d) read-only and returns the step that matched, every candidate (root, pre-selected component, registered or not), stale index entries and any registered workspace it had to skip with the reason. **Several matches** → the skill lists them and asks the user to choose. **No match** → the skill says so and offers `init-workspace` or registering an existing workspace whose path the user gives. It never guesses and never searches the disk.

## The per-user workspace index

- One file per user, at the path the skill supplies from the plugin data directory (`workspace-index.json`). It persists across plugin updates and is never committed. A missing file is the documented empty initial state.
- Canonical and schema-versioned (`schemaVersion`, `workspaces[]` sorted by `path`, each an absolute workspace root stored as its real path).
- **Registered only after confirmation:** the skill offers registration after a workspace is first used or created successfully, and runs `workspace-index register` only on an explicit yes. Registering a path that does not hold a valid workspace is refused (24).
- **Stale entries** — the path no longer exists, is not a directory, has no `.release-radar/workspace.json`, or no longer holds a valid workspace — are reported by `list`, `resolve` and `format`, and removed only by `workspace-index unregister` after the user confirms. Nothing removes them implicitly.
- `list` and `resolve` refuse a hand-edited (non-canonical) index with exit 29. `format --index <file>` re-formats the index on its own — no workspace is needed (its report then has `workspace: null` and quarantine and retention "skipped: index-only run") — and `format --check --index <file>` classifies it without writing. With `--workspace` as well, both are processed in one run.
