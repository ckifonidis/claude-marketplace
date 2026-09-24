# Design guide

The three files share one visual language so a reader moving between them recognises every mark. It is
implemented once — in `templates/flowdoc/template.html` (the page) and `render_xlsx.py` (the sheet) —
and a spec cannot override it. Change it there, for every flow, or not at all.

## The page

**Type.** Fira Sans (body), Fira Sans Condensed (headings, box titles, stage names — condensed fits a
step name into a 280 px box), IBM Plex Mono (ids, routes, engine expressions). Loaded from Google Fonts
with a full system fallback stack, so the page renders offline; `verify.py` checks with the font
stylesheet served empty.

**Tokens** (light → dark). Every colour is a CSS custom property on `:root`; nothing is hard-coded.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--ground` / `--surface` / `--sunk` | `#f3f6f7` / `#ffffff` / `#e9eef0` | `#0f171c` / `#16222a` / `#1c2a33` | page, boxes, sub-steps |
| `--ink` / `--muted` / `--line` | `#14212b` / `#566874` / `#cfd9de` | `#e3ecf0` / `#93a6b2` / `#2c3d48` | text, secondary text, rules |
| `--accent` | `#0b5f73` | `#5fb6c9` | happy path, ids, terminals, sheet header |
| `--alt` | `#5b4fa8` | `#a79cf0` | branch edges and branch-only steps |
| `--fail` | `#b23a48` | `#ec7d8a` | failure edges, `new` status, bad terminals |
| `--trigger` | `#a35f00` | `#e8a748` | ⚡ chips, `change` status |
| `--ok` | `#2f7d4f` | `#6fcf97` | `exists` status |
| `--tbd` | `#7a6a00` | `#e3cf5a` | `tbd` status |
| `--band-a` / `--band-b` | `#eef3f5` / `#f6f9fa` | `#121d23` / `#15212a` | alternating stage bands |
| `*-soft` variants | tinted backgrounds for pills, chips and cards | | |

**Dark mode has three states**, and all three must work: the OS preference (`@media
(prefers-color-scheme: dark)` scoped to `:root:not([data-theme="light"])`), a page pinned dark
(`:root[data-theme="dark"]`), and a page pinned light (the `:not(...)` guard keeps the OS query out).
The two dark blocks are deliberately identical — keep them so.

**Marks.**
- Edges: happy = solid accent, 2 px · branch = solid `--alt` · failure = dashed `--fail` · optional /
  skip = dotted `--muted`. Arrowheads match the stroke colour.
- Boxes: step = surface with an accent border · branch-only step = `--alt` border · optional step =
  dashed border · sub-step = sunk background · container = tinted accent · terminal = pill (accent, or
  `--fail` tint for a failure end). A status dot sits top-right of every step box.
- ⚡ chips carry the trigger's short name; hovering shows the real route.

**Layout of the page.** Header (title, subtitle, legend; top-right, the agent-step version the engine
column targets, plus "code today: X.Y.Z" in the change colour when the project vendors another) → tabs (Graph · Steps · Triggers & APIs · one
tab per domain sheet · Open / TBD) → the graph in a scroll box with Fit width / 100 % controls, beside a
sticky 420 px detail panel. Below 1100 px the panel drops under the graph. At 400 px the page has no
horizontal scroll (the graph box scrolls inside itself). Keyboard: every step box is focusable and opens
on Enter/Space. The last selected step is remembered per flow in `localStorage`, wrapped in try/catch
(storage can be blocked).

**Budget.** One self-contained file: data as JSON in an inert `<script type="application/json">` block
(with `</` escaped), vanilla JS, no script from any host, no inlined diagram library. `verify.py` fails
the page above 500 KB; a ladder runs 40–150 KB (a 24-step flow with three domain sheets is ~120 KB).

## The sheet

Header row: white bold on the accent colour. Panes frozen at C2 (id + stage visible while scrolling);
autofilter on every tab; text wraps top-aligned.

**Steps** — one row per step, in `order`, rows banded by stage in two light tints:

| Column | Why it is there |
|---|---|
| Step · Stage · Part of | identity, band, container |
| Name | the owner's name for it |
| On entry the agent says | the opening line — what the user hears first |
| Must gather (completion needs all) | the completeness check's inputs |
| Offer — skippable | optional inputs, offered once |
| Arrives prefilled | what is already known, and from where |
| Complete when | the completeness check in words |
| Triggers on completion (in order) | the chain |
| Next step (by outcome) | every outcome and where it goes |
| Trigger APIs (real routes) | the chain's real routes, so the row stands alone |
| Lookups while gathering | reads that are not triggers |
| Step-engine expression | how it runs on agent-step |
| Status today · Status note | the gap to close, with evidence |
| Open items | the questions that bite here |

**Triggers & APIs** — one row per trigger, filled by status colour: Trigger · Name · Fired by · Name in
the brief · Real route · Evidence · On success · On failure · Retry policy · Status.

**Domain sheets** — as the spec defines them (fields, documents…).

**Open & TBD** — ID · Question · Where it bites · Default until decided.

## The Markdown

Generated; `verify.py` asserts the required headings, that every step id and open-item id appears.
Sections are numbered in order: "What changed since the previous draft" appears only when `revisions`
is non-empty, so Open items is §7 without it and §8 with it.

1. Title, intro, source of truth, the file table, the rebuild line.
2. **§1 Two words the whole ladder uses** — step and trigger, and the two consequences (always).
3. **§2 The ladder** — a monospace one-line-per-step ladder with ⚡ chains and targets, the totals, and a
   status table (always).
4. **§3 How the ladder runs on agent-step** — the concept → primitive table and the facts (from the
   code, or from the platform for a new design) that drove it (from `engine_notes`).
5. **§4 The steps where a decision was made** — one block per decision, with the why.
6. **§5 Brief names vs real routes** — every trigger whose brief name differs from the real route, plus
   `route_notes`.
7. **§6 What has to be built or changed, ordered by what it unblocks** — for a design with no code yet, what must be built.
8. **What changed since the previous draft** — only when `revisions` is non-empty.
9. **Open items** (always last) — each with where it bites and its default.

Write the prose parts for a reader who was not in the room: short sentences, the reason next to the
rule, `file:line` next to the claim, no internal jargon without a gloss.
