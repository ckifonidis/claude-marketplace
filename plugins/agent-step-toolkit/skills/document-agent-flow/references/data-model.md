# The flow spec

One spec per flow: a Python module binding `FLOW` (preferred — constants and helpers keep repeated text
in one place, and domain inventories can live in sibling modules the spec imports) or a JSON file with
the same shape. `templates/flowdoc/model.py` is the executable form of this page: `normalize()` fills
every default below, `validate()` refuses everything listed under **Rules**, reporting all problems at
once.

## Top level

| Key | Type | Required | Feeds |
|---|---|---|---|
| `meta` | dict | yes | page header, md title, file names |
| `stages` | list of `{id, name}` | yes | bands in the graph, band fills in the sheet, the ladder's stage column |
| `steps` | dict id → step | yes | everything |
| `order` | list of step ids | default: `steps` insertion order | row order everywhere; the layout's reading order |
| `triggers` | dict id → trigger | yes (may be empty) | ⚡ chips, trigger cards, the Triggers & APIs sheet, md §5 |
| `terminals` | dict id → `{label, tone}` | no | end pills (`tone`: `good` default, `bad` for a failure end) |
| `open` | list of open items | no | Open & TBD sheet and tab, the md's last section, the step panels' "Open" block |
| `engine_notes` | `{intro?, concepts: [(concept, primitive)], facts: [str]}` | no | md §3 |
| `decisions` | list of `{title, step?, points: [str]}` | no | md §4 |
| `route_notes` | list of `{name, real}` (`brief` accepted for `name`) | no | md §5 "Other routes worth knowing" — routes no single trigger owns |
| `changes` | list of `{what, unblocks?, detail?: [str]}` | no | md §6, in the order given |
| `revisions` | list of str | no | md §7 "What changed since the previous draft" (omitted when empty) |
| `sheets` | list of `{id, title, columns, rows, widths?}` | no | extra xlsx tabs AND page tabs, between Triggers and Open |

## `meta`

| Key | Required | Meaning |
|---|---|---|
| `slug` | yes | kebab-case; names `<slug>.md/.html/.xlsx` |
| `title` | yes | page `<title>`, h1, md title |
| `subtitle` | yes | one or two sentences under the h1: how to read the graph |
| `engine_version` | yes | the agent-step version the engine column is written against (`X.Y.Z`, from the toolkit's `templates/agent-step/VERSION`) — shown top-right on the page and in the md header |
| `code_engine_version` | no | the version the project's code vendors today (`src/agent-step/VERSION`); shown beside it when different |
| `intro` | no | md opening paragraph |
| `source_of_truth` | no | md line "Source of truth for the flow: …" — say whose walkthrough, which date |
| `branch_label` | no | legend text for `branch` edges (default "alternative branch") |
| `rebuild` | no | the exact rebuild command, quoted in the md |
| `vocabulary_extra` | no | extra md §1 paragraph for domain words |
| `global_exits` | no | [str] — exits reachable from ANY step (off-topic delegation, abandon handback); shown under the page title and after the md ladder instead of as edges |

## Step

| Key | Type | Required | Meaning / output |
|---|---|---|---|
| `stage` | stage id | yes | its band |
| `title` | str | yes | panel heading, sheet Name column, md ladder |
| `label` | str | no | shorter box title (default `title`) |
| `sub` | str | no | one-line box subtitle — the step at a glance |
| `opens` | str | no | "On entry the agent says" |
| `required` | [str] | no | "Must gather" — completion needs all |
| `optional` | [str] | no | "Offer — skippable" |
| `prefilled` | [str] | no | "Arrives prefilled" — and from where |
| `completion` | str | yes | "Complete when" — the completeness check, in words |
| `triggers` | [trigger id] | no | the chain fired on closing, **in order** |
| `next` | [outcome] | yes | where the flow goes, by outcome |
| `lookups` | [str] | no | reads while gathering (not triggers) |
| `engine` | str | yes | the step in agent-step primitives (`engine-notation.md`) |
| `status` | `exists` · `change` · `new` · `tbd` | yes | dot, pill, sheet column |
| `status_note` | str | no | "Today": what the code does now, with file:line |
| `open` | [open id] | no | open items that bite here |
| `parent` | step id | no | draw this step inside that step's container box |
| `cross_cutting` | bool | no | inside a container: a full-width bar under the grid (a sub-flow callable from any sibling) |
| `optional_step` | bool | no | dashed border |

### Outcome (`next` entries)

| Key | Meaning |
|---|---|
| `to` | a step id or a terminal id. A terminal reached by one step's failures only sits beside it; a terminal several steps reach gets its own row after the last of them |
| `when` | the condition, in words — shown in the panel, the sheet, the edge tooltip |
| `kind` | `main` (default) · `branch` (an alternative path, drawn in the branch colour) · `fail` (dashed; loops and back edges) · `opt` (dotted; a skip) |
| `label` | short text drawn on the edge. Default: `when` (shortened) — except a `main` edge that is the step's only non-failure outcome, which stays unlabelled (its chips say what happens). `False` = no label on the canvas (the `when` stays in tooltip and panel) |
| `triggers` | which of the step's triggers ride THIS edge. If no outcome of a step says, the whole chain rides its first non-failure outcome |

An outcome from a container to its own child (or back) is not drawn — the box already shows it — but it
stays in the sheet and the panel.

## Trigger

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | full name ("Create the customer") |
| `short` | yes | chip text ("create") — two words at most |
| `real` | yes | the real route and body shape, or what is known ("no route found — searched …") |
| `spec` | no | the name the brief/spec uses when it differs — a route (`GET /x`, shown as code) or just a capability ("availability lookup", shown as words) — feeds md §5 |
| `evidence` | when status is `exists`/`change` | `path:line` proving `real`. From a pasted excerpt rather than the repo itself: `excerpt <file>:<line> (quoting <repo path>)` — never present an excerpt as a repo read |
| `on_ok` | yes | what success leads to |
| `on_fail` | no | [str] — one line per failure class and where it goes |
| `retry` | no | the retry policy (graded: transient / validation / business / exhausted) |
| `status` | yes | as for steps, **from the agent's point of view**: `exists` = the agent calls this route today; `change` = it calls it, wrongly; `new` = the route exists in the backend but the agent does not call it yet (give the route's `evidence` anyway); `tbd` = no route found or not verified |
| `step` | no | default: the step(s) listing it |

## Open item

`{id, question, where, default}` — all four required. `where` names the steps/triggers it bites;
`default` is what the ladder does until someone decides.

## Domain sheets

`{id, title, columns: [str], rows: [[cell]], widths?: {column: width}}`. A cell may be a string or a
list (rendered as bullets). Every row must have as many cells as `columns`. Typical sheets:

- **Fields** — Section · Field · Required (`M`, `O`, or `C: <condition>`) · Multi-entry · Prefilled from ·
  Supporting document · Rules · Spec ref.
- **Documents** — Document type · What it proves · Section · Required · Source (uploaded / produced) ·
  Spec ref.

## Rules the validator enforces

- `meta.slug`, `title`, `subtitle` present; slug is `[a-z0-9-]`.
- Every step has `stage`, `title`, `completion`, `next`, `engine`, `status`; every outcome `to` + `when`
  and a valid `kind`.
- Every reference resolves: stage, trigger, open item, outcome target, `parent`, outcome `triggers`
  (must be the step's own), decision `step`. No id is both a step and a terminal.
- Every trigger is fired by some step. `exists`/`change` triggers carry `evidence`. When a step names
  `triggers` on its outcomes, each of its triggers rides at least one outcome.
- `order` lists every step exactly once, grouped by stage in the stages' order (bands are contiguous).
- Containers nest one level; a child shares its container's stage.
- Sheet rows match their header width; sheet ids are unique.
- `engine` names no removed or non-library primitive (`engine-notation.md`).
