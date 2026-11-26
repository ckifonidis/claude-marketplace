# Checklist format (`checks.md`)

Checklists add project knowledge to the generic checks: "when these files change, look for this signal, and prepare that". There are two layers on top of the generic one, applied in the order **generic → fleet → component**. Both use one strictly structured Markdown grammar (`schemaVersion: 1`) that the engine parses and re-renders canonically. This file is the authoring guide and states the grammar exactly as the engine implements it; `deployment-status/references/file-formats.md` § "Checklists" gives the same rules in short. Engine commands are described in the `SKILL.md` "Engine invocation" section; this file never shows an invocation.

## Where the layers live

| Layer | File | Read from | Re-formatted by `format` |
|---|---|---|---|
| fleet | the path in `workspace.json` `checklist` (relative to the workspace root, e.g. `.release-radar/checks.md`); `checklist: null` means "no fleet layer" | the workspace repository's working tree | yes (workspace repository) |
| component | `<clone>/.release-radar/checks.md`, or `<clone>/<repoSubdir>/.release-radar/checks.md` when the member has a `repoSubdir`; optional | **the promoted commit**, through the engine's read-only `checklist-check` command | the working-tree copy only, and only with `--include-members` after the user confirms once; the copy at a commit **never** |

- In a monorepo, each member's component checklist sits under its own `repoSubdir`, next to its `component.json`.
- In a single-repo project, the member's clone is the workspace repository, so the fleet and component checklists can both live in the one `.release-radar/` (with different file names: the fleet one is wherever `checklist` points).
- A configured fleet checklist path that does not exist is invalid configuration (exit 24). A missing component checklist is simply "no component checklist at <sha>".
- Every item's `layer` must match the file's location: `fleet` in the fleet checklist, `component` in a component checklist. A mismatch makes the file invalid.

## Canonical form

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

Byte for byte:

1. The header line `# release-radar checklist`.
2. One blank line, then `schemaVersion: 1`.
3. For each item, sorted by id: one blank line, the heading `## <id>`, then the five field lines in the fixed order `layer`, `severity`, `paths`, `signal`, `prepare`.
4. Every continuation line is indented by exactly **4 spaces**.
5. LF line endings, no trailing spaces, exactly one trailing newline. A checklist with no items (header and `schemaVersion` only) is valid.

## Grammar

### Header and version

- The first non-blank line must be the header (`#`, whitespace, `release-radar checklist`). Canonically it is `# release-radar checklist` with one space.
- The next non-blank line must be `schemaVersion: <integer>`. Only `1` is supported; any other number is invalid ("unsupported schemaVersion"), and a non-integer is invalid.

### Items

- Each item starts with a heading `## <id>`: exactly two `#`, whitespace, and one id with no spaces. `###` or any other `#` line is a malformed heading (invalid).
- The id matches `[a-z0-9][a-z0-9-]*`: lower-case letters, digits and hyphens, not starting with a hyphen.
- Each field is a line `- <field>: <value>`. Exactly the five fields, each exactly once:

| Field | Value |
|---|---|
| `layer` | `fleet` or `component`, matching the file's location. Single line. |
| `severity` | `blocker`, `high`, `medium`, `low` or `info`. Single line. |
| `paths` | Comma-separated globs (below). |
| `signal` | What to look for in the diff. Free text, may span lines. |
| `prepare` | What to prepare when the signal is present. Free text, may span lines. |

- A field line outside an item, an unknown field name, a repeated field, a missing field, an empty value, or a multi-line `layer` / `severity` is invalid.
- Fields may be written in any order on input; the canonical order is the one above ("field order normalised").

### Indentation and continuation lines

- Structural lines (header, `schemaVersion:`, `## <id>`, `- <field>: …`) may be indented by 0–3 columns on input; canonically they are not indented.
- A line indented by **4 or more columns** is always a continuation of the field above it (a tab counts as advancing to the next multiple of 4 columns). A line indented 1–3 columns that is not a structural line is also a continuation. An indented line with no field above it is invalid.
- Continuation lines are dedented to the least-indented continuation line of that value and re-indented by 4 spaces, so **deeper indentation relative to that line is kept** (nested bullets inside a `signal` survive).
- A field may start empty (`- signal:`) with its text on continuation lines; canonically the first continuation line moves up onto the field line.
- **Blank lines only separate.** They are never part of a value: a blank line inside a multi-line `signal` is dropped by the canonical rendering, and the text after it still belongs to the same field when it is indented.
- Any other unindented text — free prose, a Markdown paragraph, a list without a field name — is "text outside the checklist grammar" and makes the file invalid. Comments have no place either; put explanations in `signal` or `prepare`.

### `paths`

- A comma-separated list of globs, order kept, canonical separator `", "` (comma and one space). Surrounding whitespace is trimmed from each entry.
- Commas inside `{…}` (brace alternation, e.g. `services/{api,worker}/**`) or `[…]` (character classes, e.g. `db/[0-9]*.sql`) belong to the glob and do not separate entries.
- An unbalanced or unclosed `{` / `[` / `}` / `]` is invalid. An empty entry (a doubled or trailing comma) is invalid.
- A long list may continue on indented lines; the lines are joined with a single space before splitting, so break the line **only after a comma**.

### Duplicates and order

- Items are sorted by id (plain character order; `-` sorts before digits, digits before letters).
- An item that is identical, after canonical rendering, to an earlier item with the same id is removed and reported ("duplicate item … removed").
- A **different** item with an id already used is invalid ("duplicate id … with different content (first at line N)").

## The three states

The engine classifies each checklist like every other structured file (`deployment-status/references/file-formats.md`):

- **canonical** — the bytes equal the canonical rendering.
- **non-canonical** — valid, but `format` would rewrite it. The change summary names what: line endings or a byte-order mark normalised, "whitespace and indentation normalised", "field order normalised in item …", "duplicate item … removed", "items sorted by id". Re-formatting is lossless.
- **invalid** — exit 24 with the file, line and column of the first problem.

A component checklist **at the promoted commit** is never re-formatted (history is never rewritten). The engine's read-only `checklist-check` command reads the commit's copy, classifies it against this grammar and returns one state — `canonical`, `non-canonical` (with the change summary), `invalid` (exit 24, with the line and column) or `absent` — together with the parsed items and how the working-tree copy compares (`identical`, `same-content`, `differs`, `absent`). It never writes anything. Non-canonical → used and reported "non-canonical at <sha>" (with an offer, never automatic, to re-format the working-tree copy); invalid → a blocking finding "<path> invalid at <sha>: line <n>", and the verdict cannot be *safe to promote*; absent → "no component checklist at <sha>".

## How change-risk applies an item

1. **Match.** The item applies when any file changed in the reviewed range matches one of its `paths`. Globs are matched against paths relative to the **component root** (the clone root, or the member's `repoSubdir`), for both layers: `**` matches any number of directories, `*` anything within one path segment, `?` one character, `{a,b}` either alternative, `[…]` one character of the class.
2. **Read.** The skill reads the matching diffs and decides whether the `signal` is present. A matching path alone is not a finding.
3. **Report.** A present signal becomes a finding with the item's `severity`, its layer, the commit, `file:line`, why it could break (the signal, applied to this diff) and the item's `prepare` text. An applicable item whose signal is absent is listed as "checked, not triggered". A layer with no file is stated ("no fleet checklist configured", "no component checklist at <sha>").

`blocker` items behave like generic blockers: a present signal makes the verdict *do not promote until X*.

## A valid example

A synthetic fleet checklist in `acme-platform`'s `.release-radar/checks.md`. It parses as **canonical** with the engine's parser, and its second item's `paths` splits into two entries, `src/config/**` and `{appsettings,settings}.*.json`:

```
# release-radar checklist

schemaVersion: 1

## base-image-pinned
- layer: fleet
- severity: high
- paths: **/Dockerfile, **/*.Dockerfile
- signal: A FROM line changes its image or drops its @sha256 digest pin.
- prepare: Confirm the new base image is approved for the receiving stage and
    re-pin it by digest before promoting.

## new-required-setting
- layer: fleet
- severity: blocker
- paths: src/config/**, {appsettings,settings}.*.json
- signal: A setting is read without a default, or a new key appears in a
    settings file that travels to another team.
- prepare: Name the key in the handoff notes and confirm the receiving team
    has a value (or a secret reference) for it in every target stage.
```

A component checklist in the `acme-api` clone (`.release-radar/checks.md`, or `<repoSubdir>/.release-radar/checks.md`), also canonical:

```
# release-radar checklist

schemaVersion: 1

## orders-schema-migration
- layer: component
- severity: blocker
- paths: services/{api,worker}/migrations/**, db/[0-9]*.sql
- signal: A migration renames or drops a column that the previous release
    still reads.
- prepare: Ship the expand step first; schedule the contract step for the
    release after.
```

The same component file placed at the fleet location is invalid: `layer "component" does not match this checklist's location (expected "fleet")`, with its line and column.

## Hand edits the engine normalises

This input is valid but non-canonical — the header and `schemaVersion` are not separated by a blank line, the items are not sorted, `zeta-item` lists `severity` before `layer`, its `paths` has no space after the comma, its continuation uses a tab, and `alpha-item`'s field lines are indented by one space:

```
# release-radar checklist
schemaVersion: 1
## zeta-item
- severity: low
- layer: fleet
- paths: a/**,b/**
- signal: one
	continued
- prepare: two
## alpha-item
 - layer: fleet
 - severity: info
 - paths: c/**
 - signal: s
 - prepare: p
```

`format` reports "whitespace and indentation normalised", "field order normalised in item "zeta-item"", "items sorted by id", and rewrites it to:

```
# release-radar checklist

schemaVersion: 1

## alpha-item
- layer: fleet
- severity: info
- paths: c/**
- signal: s
- prepare: p

## zeta-item
- layer: fleet
- severity: low
- paths: a/**, b/**
- signal: one
    continued
- prepare: two
```

## Typical invalid inputs

| Input | Reported as |
|---|---|
| A prose paragraph between items | text outside the checklist grammar (line:column) |
| `### note` | malformed heading, expected "## <id>" |
| `## Bad_Id` | invalid item id (must match `^[a-z0-9][a-z0-9-]*$`) |
| `- owner: dev-team` | unknown field "owner" (allowed: layer, severity, paths, signal, prepare) |
| an item without `prepare` | item "<id>" is missing field "prepare" (at the heading) |
| `- severity: critical` | severity "critical" is not one of: blocker, high, medium, low, info |
| `- paths: src/{api,worker/**` | unclosed "{" in paths |
| `schemaVersion: 2` | unsupported schemaVersion 2 (supported: 1) |
| the same id twice with different content | duplicate id "<id>" with different content (first at line N) |
