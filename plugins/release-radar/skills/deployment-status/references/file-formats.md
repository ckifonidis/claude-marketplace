# File formats

Every structured file release-radar creates or reads has **exactly one canonical form**, a declared `schemaVersion` (currently `1` everywhere), and one of three states. This file is the contract for all of them: the canonical JSON rules, each file's key order and array ordering, the checklist grammar, what `format` and `format --check` do, the cleanup rules, the files that are never rewritten, and the member-repository rule. Engine commands are described in the `SKILL.md` "Engine invocation" section. This file never shows an invocation.

## The files

| File | Where | Owner | `format` rewrites it? |
|---|---|---|---|
| `workspace.json` | `.release-radar/` of the workspace (orchestration) repository | workspace repo | yes |
| `repos.local.json` | `.release-radar/` of the workspace repository (gitignored, per machine) | workspace repo | yes |
| external repos file | wherever `workspace.json` `reposFile.path` points | other tooling | **never** — validated only |
| fleet checklist | `workspace.json` `checklist` (e.g. `.release-radar/checks.md`) | workspace repo | yes |
| `component.json` | `<clone>[/<repoSubdir>]/.release-radar/` of each member | member repo | only with `--include-members` |
| component checklist | `<clone>[/<repoSubdir>]/.release-radar/checks.md` (optional) | member repo | only with `--include-members` |
| snapshots | `.release-radar/snapshots/<timestamp>.json` of the workspace | engine | yes |
| handoff manifests | `.release-radar/handoff/<package>/manifest.json` of the workspace | engine | yes |
| handoff copies | `.release-radar/handoff/<package>/files/**` | engine | **never** — checked against the manifest |
| workspace index | the per-user file the skill passes (`${CLAUDE_PLUGIN_DATA}/workspace-index.json`) | per user | yes |

In a **single-repo project** the member's clone is the workspace repository, so its `component.json` and checklist are workspace-repo files and are rewritten without `--include-members`.

Skills never hand-write any of these files. Everything is written through the engine, canonically.

## Canonical JSON

- **Key order** is fixed by the schema (the per-file orders below). Maps with free keys (`{ <stage>: … }`, `repos`, `parameters`) have their keys sorted by UTF-16 code unit, independent of locale. Keys that look like array indices (`"0"`, `"12"`) are rejected, because they cannot be kept in canonical order.
- **Whitespace:** 2-space indentation, LF line endings, exactly one trailing newline, no trailing spaces. A byte-order mark or CRLF line endings make a file non-canonical, never invalid.
- **Numbers and strings** are written the way `JSON.stringify` writes them; any other spelling (`1.0`, `A`) is non-canonical.
- **No comments.** A `//` or `/* */` comment makes the file invalid, with its line and column.
- **Duplicate keys** in one object make the file invalid (JSON parsers would silently keep the last one).
- **Unknown keys** are invalid; **optional keys** are omitted when absent and never defaulted; **missing required keys** are invalid.
- **Arrays** are either **sorted** (order carries no meaning; the sort key is declared per field below; ties are broken by the entry's canonical content, so the order is total) or **ordered** (order carries meaning and is kept as written).
- **Identity:** some arrays name an identity key (e.g. `name`). Two entries with the same identity must be byte-identical after canonicalization — the duplicate is then removed and reported — otherwise the file is invalid. Sorted arrays without an identity also drop byte-identical duplicates. Plain ordered arrays (argv) keep every entry.

Canonical rendering is **deterministic**: the same content always renders to the same bytes, whatever the input formatting, platform or engine run. The configuration fingerprint in snapshots is computed over the canonical form, so re-formatting never changes it.

## Key order per file

`[]` marks an array; **SORTED by x** / **ORDERED** gives its ordering; `?` marks an optional key.

### `workspace.json`

```
schemaVersion
operatorTeam?                  required when any stage declares promotion.owner
stages[]        ORDERED (lifecycle order), identity name
  name                         not "local" (reserved)
  tagConvention                { type: "sha" }
                               { type: "git-tag", gitTagPrefix }
                               { type: "regex", pattern, resolveAs: { type: "sha" } | { type: "git-tag", gitTagPrefix } }
                               { type: "none" }
  promotion
    mode                       pipeline | handoff | manual | none
    owner?                     required unless mode is "none"
members[]       SORTED by name, identity name
  name
  repoKey                      string, or null (no clone by design)
  repoSubdir                   string, or null (the repository root)
reposFile                      { kind: "owned" } | { kind: "external", path }
gitTimeoutSeconds
freshnessMinutes
checklist                      path of the fleet checks.md, or null
beforePromote?                 { <stage>: <pointer> }  (keys sorted)
snapshotRetention
handoffRetention
adapters
  azure-appservice?            timeoutSeconds, stageSubscriptions { <stage>: [ids SORTED] }
  azure-containerapp?          timeoutSeconds
  kubernetes?                  timeoutSeconds
  compose?                     timeoutSeconds
  command?                     timeoutSeconds, discoverArgv[]? ORDERED
azureDevOps?
  organizationUrl, project, requestTimeoutSeconds, runHistoryCount, followPollSeconds,
  followTimeoutMinutes, confirmTokenTtlMinutes, patExpiryWarningDays
```

### `component.json`

```
schemaVersion
name                           equals the member name
tagConventionOverrides?        { <stage>: <tagConvention> }  (keys sorted)
stages                         { <stage>: <entry> | null }  — every workspace stage; null = not deployed
  targets[]     SORTED by name, identity name, at least one
    name
    adapter                    azure-appservice: webapp
                               azure-containerapp: subscription, resourceGroup, app
                               kubernetes: context, namespace, deployment
                               compose: project, service
                               command: argv[] ORDERED, extract, preflightArgv[]? ORDERED
    pipeline?                  pipeline stages only
      provider, project?, pipelineId?, pipelineName?, repository?, ref,
      parameters { … } (keys sorted), userSelectable? { <name>: [values SORTED] },
      imageTagParameter?, pushedTagTemplate?, actions { <name>: { kind, parameters } },
      primaryAction, landedWaitMinutes
  handoff?                     handoff stages only
    settingsFiles[] SORTED     paths relative to the component root
    beforePromote?
  verification?
    timeoutSeconds
    checks[]    SORTED by name, identity name
      http:    name, type, target?, url, method, expectStatus[] ORDERED, headers?, timeoutSeconds?
      version: name, type, target?, url, extract, compare, headers?, timeoutSeconds?
      smoke:   name, type, target?, argv[] ORDERED, timeoutSeconds?
```

### `repos.local.json` (owned)

```
schemaVersion
repos                          { <repoKey>: <path relative to this file> }  (keys sorted)
```

An **external repos file** has the same mapping shape, may omit `schemaVersion`, and may carry a `_comment` string (other tools share such files). It is validated strictly but never rewritten and never counted as non-canonical.

### Workspace index

```
schemaVersion
workspaces[]    SORTED by path, identity path
  path                         absolute workspace root
```

### Snapshot (`.release-radar/snapshots/<YYYY>-<MM>-<DD>T<hh>-<mm>-<ss>-<mmm>Z[-<n>].json`)

```
schemaVersion
engineVersion
time                           ISO-8601 UTC with milliseconds
exitCode                       0 | 22 | 23 | 28 | 30
fingerprint                    sha256 over the canonical workspace + each component.json used
components[]    SORTED
members[]       SORTED by name, identity name
  name, availability, reason, revision
report                         the full --json report; object keys sorted recursively, array order kept
```

### Handoff manifest (`.release-radar/handoff/<component>-<stage>-<timestamp>[-<n>]/manifest.json`)

```
schemaVersion
engineVersion
createdAt
component
stage
receivingOwner
promotedCommit
complete
blocking[]      SORTED
image                          null, or { sourceStage, reference, repository, tag, digest, targets[] SORTED }
files[]         SORTED by path, identity path
  path, sourceCommit, sha256, bytes
settingsDiff
  status, deployedCommit, reason
  files[]       SORTED by path, identity path
    path, status, parse { deployed, promoted }, lines { deployed, promoted },
    addedKeys[] SORTED, removedKeys[] SORTED, changedKeys[] SORTED,
    renamedKeys[] SORTED by from  { from, to },
    secretReferences { added[] SORTED, removed[] SORTED, renamed[] SORTED by pointer { pointer, from, to } }
beforePromote
  workspace, component
literalSecretWarnings[] SORTED by file  { file, key }
```

The package layout and the meaning of every field are in `promote/references/handoff-package.md`.

## Checklists (`checks.md`)

Checklists are structured Markdown with a strict grammar. Canonical form (LF, one trailing newline, no trailing spaces):

```
# release-radar checklist

schemaVersion: 1

## <id>
- layer: fleet | component
- severity: blocker | high | medium | low | info
- paths: <glob>, <glob>
- signal: <first line>
    <continuation line>
- prepare: <first line>
```

- The first line is the fixed header; then `schemaVersion: 1`.
- One item per `## <id>` heading; ids match `[a-z0-9][a-z0-9-]*`; items are **sorted by id**.
- Each item has exactly the five fields, in this order: `layer` (must match the file's location: the workspace checklist is `fleet`, a member's is `component`), `severity`, `paths`, `signal`, `prepare`.
- Structural lines may be indented by 0–3 columns on input; canonically they are not indented.
- A continuation line belongs to the field above it. A line indented by 4 or more columns (a tab counts as 4) is a continuation, and so is a line indented 1–3 columns that is not a structural line. Canonically every continuation line is indented by exactly 4 spaces; deeper indentation relative to the value's least-indented continuation line is preserved.
- Blank lines only separate; they are never part of a value.
- `paths` is a comma-separated glob list (order kept, canonical separator `", "`). Commas inside `{…}` or `[…]` belong to the glob; an unbalanced bracket is invalid. `layer` and `severity` are single-line.
- An item identical to an earlier item with the same id is removed (reported). A **different** item with the same id is invalid.
- Prose outside this grammar, an unknown field, a missing or repeated field, a bad enum value, a wrong layer or an unsupported `schemaVersion` make the file invalid, with its line and column.

## The three states

| State | Meaning | `format --check` | `format` | Every other command |
|---|---|---|---|---|
| `canonical` | The bytes equal the canonical rendering. | counts as fine | leaves it alone | uses it |
| `non-canonical (hand-edited)` | Valid, but `format` would rewrite it. A change summary says what: keys reordered, whitespace or line endings normalised, arrays sorted, duplicates removed, checklist items or fields normalised. | exit **29** | rewrites it in place (losslessly) | refuses with exit **29**, naming the file and telling the user to run `format` |
| `invalid` | It cannot be placed: a parse error, an unknown or missing key, a wrong type, the same id with different content, a malformed checklist item, comments in JSON, an unsupported `schemaVersion`, a semantic rule (e.g. an undeclared stage). The location is exact: file plus JSON pointer and line:column, or file plus line:column. | exit **24** | leaves it untouched; exit **24** | refuses with exit **24** |

**Normalization is lossless.** The parsed content before and after is identical, apart from the canonical order of arrays whose order carries no meaning and the removal of byte-identical duplicates (each reported). `format` never drops, invents or defaults a value; anything it cannot place makes the file invalid.

### Exit codes

- `format --check` writes nothing. It exits **24** if any file is invalid, else **29** if any file is non-canonical, else **0**.
- `format` rewrites every valid non-canonical file it may rewrite, runs the cleanup, and then exits **24** if any file is invalid, else **29** if a non-canonical file was left (a member-repository file without `--include-members`), else **0**.
- An external repos file never counts toward 29. A missing workspace file is exit 24.

## Member repositories (`--include-members`)

The user manages git in member repositories, and the skill never commits. A non-canonical working-tree `component.json` or component `checks.md` in a member repository is therefore rewritten **only when `format` is given `--include-members`**. Without it, `format` reports the file as non-canonical with "re-format requires --include-members (member repository)", leaves it untouched, and exits 29. The skill lists those files, asks the user **once per run**, and passes `--include-members` only after an explicit yes. Workspace-repository files and engine-owned files are rewritten without asking.

## Cleanup

`format` (without `--check`) also cleans up. `--check` reports exactly what it would do and does none of it.

1. **De-duplication.** Byte-identical list entries are removed as part of the canonical rewrite; each removal is reported with the file and the entry's position.
2. **Orphans → quarantine.** These are **moved**, never deleted, to `.release-radar/quarantine/<run timestamp>/<same path relative to .release-radar>`, and each move is reported with its reason:
   - anything in `snapshots/` that is not a regular file matching the snapshot name pattern;
   - a snapshot whose `schemaVersion` is absent or unsupported;
   - anything in `handoff/` that is not a directory matching `<component>-<stage>-<timestamp>[-<n>]`;
   - a package directory without `manifest.json` (an interrupted write), or whose manifest has an absent or unsupported `schemaVersion`;
   - a file inside a package that its manifest does not list.
   The quarantine directory itself is never scanned.
3. **Retention.** Snapshots: the newest `snapshotRetention` valid snapshots are kept and older valid ones deleted. Handoff packages: per (component, stage), the newest `handoffRetention` valid packages are kept and older valid ones deleted. Only files the engine created itself (engine-named, valid, supported `schemaVersion`) are ever deleted; an invalid snapshot or package is reported and kept. Retention needs a valid `workspace.json` (it holds the counts) and is skipped, with the reason, otherwise.
4. **Stale workspace-index entries** (the path is gone or no longer holds a valid workspace) are only reported. They are removed through `workspace-index unregister`, after the user confirms.

Nothing else is ever deleted or moved.

## Files release-radar never rewrites

These are validated but never re-formatted or deleted:

- **(a) Verbatim handoff copies** (`handoff/<package>/files/**`). They must stay byte-identical to the promoted commit. `format --check` checks each one's existence, byte length and sha256 against the manifest; a mismatch is `invalid` with "copy differs from <commit>" (a missing one: "copy missing"). The remedy is to run `handoff-package` again.
- **(b) An external repos file.** It is reported as "externally owned — not re-formatted".
- **(c) Any `component.json` or checklist read at a commit** (through `git show` by `settings-diff`, `handoff-package`, `change-risk` or `promote`). History is never rewritten. A non-canonical file at a commit is used and reported as "non-canonical at <sha>"; an invalid one is exit 24 ("<file> invalid at <sha>: <location>"), and for `change-risk` a blocking finding.

## Gitignore (workspace repository)

These must be gitignored in the workspace repository; the `init-workspace` workflow proposes the lines and adds them only after the user confirms:

```
.release-radar/snapshots/
.release-radar/handoff/
.release-radar/quarantine/
.release-radar/repos.local.json
```
