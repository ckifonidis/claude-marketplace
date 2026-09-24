# Automatic layout

The spec holds no coordinates. `templates/flowdoc/layout.py` computes every box, path, label and chip
position at build time, deterministically (the same spec always gives the same bytes — `verify.py`
checks it), and the page only draws them.

**Why not a graph-layout library.** An agent flow is a ladder: one dominant happy path read top to
bottom, side branches that rejoin it, failures that loop back up. Generic layered layouts (dagre, ELK)
balance the whole graph and scatter the spine, and shipping one inside the page costs hundreds of KB to
MB of JavaScript — the first hand-built version of this page inlined a diagram library and weighed
3.4 MB. The purpose-built layout is one stdlib Python module with no network dependency.

## How it places things

1. **Spine.** From the first step in `order`, follow each step's first `main`/`opt` outcome that moves
   forward. These steps form the main column (lane 0).
2. **Rows.** Each top-level node gets a rank: the longest path over forward, non-failure edges, never
   earlier than its stage's first row (stages stay contiguous bands). Nodes sharing a rank share a row;
   off-spine nodes take lanes 1, 2, … to the right. A branch step therefore sits between the rows of the
   step it leaves and the step it rejoins.
3. **Terminals.** Reached only by the failures of ONE step: a *side terminal* beside it, joined by a
   short horizontal edge. Anything else (a happy end, an end several steps reach, even by failures
   only): a row after the LAST step that reaches it, so every edge into it runs forward. Pill height
   follows the label. A node with a neighbour to its right sends its detours out of its bottom, so
   they never cut through that neighbour.
4. **Containers.** A step that other steps name as `parent` becomes a box holding its children in a grid
   (up to four columns); `cross_cutting` children are full-width bars under the grid.
5. **Edges.**
   - self-loop → a bracket on the node's right, labelled to its right (a second loop nests outside);
   - forward, overlapping spans → a straight drop (the spine stays one line); otherwise an elbow;
   - into a lane on the right → out of the source's right side, then down;
   - **back edges** → up a gutter, one track each, shortest spans innermost so they nest without
     crossing: the left gutter for edges leaving the main column, a right gutter for edges leaving a
     branch lane (so none cuts across the spine);
   - a second edge between the same pair → a parallel drop beside the first (or round the right side);
   - a corridor blocked by another box → a detour through the right gutter;
   - **any route that would pass through a box** (other than its own ends, their container or
     children) is replaced by the first clean alternative — down out of the source and along the row
     gap, or round the right gutter from the side or the bottom. If none is clean the build prints a
     `layout warning` and `verify.py` fails; `layout/edge-crossings` re-checks every run independently.
6. **Labels and chips.** Chips stay on their own edge next to the source — the first run out of it, or
   the run after the first bend — and nowhere else: a chip beside another step reads as that step's
   chain (`layout/chips-on-edge`). A sub-step closing back into its container has no drawn edge, so its
   chips sit inside its box (`layout/every-trigger-drawn`). A label shares a vertical run on the left.
   Every edge is routed before any label is placed; each label or chip then takes the free spot nearest
   its anchor (at most ~70 px away) that overlaps no box, stage name, line or earlier label — left-gutter
   labels may sit across the other gutter tracks. When none is free, the build prints a `layout warning`
   and `verify.py` fails (`layout/labels`); `browser/collisions` re-checks it in the real render. Widths
   are estimated for the system fallback fonts, so an offline reader sees the same fit.
7. **Side exits.** Several edges leaving the same node's right side each leave at their own height, so
   they never share a horizontal run.

## Steering it from the spec

When the canvas screenshot reads badly, change the data, not the drawing:

| Symptom | Fix in the spec |
|---|---|
| a box title wraps to three lines | give the step a shorter `label`; keep the long `title` for the panel |
| an edge label is long and crowds its neighbours | set the outcome's `label` to two or three words, or `False` for none; the full `when` stays in the tooltip and panel |
| an alternative path is drawn in the main colour, or pulls the spine sideways | make it `kind: "branch"`, and make sure the intended happy path is the step's FIRST main outcome |
| a failure edge is drawn solid | it needs `kind: "fail"` |
| chips appear on the wrong edge | name `triggers` on the outcome(s) the chain leads along and `triggers: []` on the others — every trigger must ride at least one outcome (the validator refuses one that rides none) |
| a chain fires on every exit (e.g. a save that runs whatever the answer) | leave the default — the chips ride the first non-failure edge — and say "runs on every outcome" in the completion text; repeating the chips on each edge only crowds the graph |
| the spine jumps to the right | the step's first forward main outcome points at a branch step — reorder `next` |
| too many boxes in one row | a hub whose sub-steps are visited in any order is a container: give the sub-steps `parent` |
| bands in the wrong order | `order` must group steps by stage, in `stages` order |

Visual constants (widths, gaps, glyph-width estimates) are named at the top of `layout.py`. Change them
there if a project's language runs systematically longer, never per node.
