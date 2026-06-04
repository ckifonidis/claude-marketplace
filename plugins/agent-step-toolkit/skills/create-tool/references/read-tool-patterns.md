# Reference: Read-Tool Patterns

<overview>
The lifecycle model (confirmation, OTP, match, flow) says little about read ergonomics. Read-heavy tools — search, browse, history, analytics — need their own patterns. These keep result bodies small, state authoritative, and the action surface clean. They are domain-agnostic; apply whichever fit.
</overview>

<bound_what_the_model_sees>
## Bound what the model sees; keep the full data in state

A read can return more rows than the model should ingest. Split the two audiences:

- **Full/native rows → state.** Persist the complete result in a state slot so later steps (and analysis actions) work from authoritative data.
- **A bounded view → the model.** Return only a page or a summary in the result body, plus enough metadata to ask for more (a cursor/offset and a total count).

This prevents token blow-ups and stops the model re-deriving data it can't see in full.
</bound_what_the_model_sees>

<pagination>
## Pagination

Page over a large set with an explicit `offset`/`cursor` + `limit` param. The full set lives in state (fetched once, or page-by-page); the result body carries one page plus `{ total, offset, hasMore }`. The prompt teaches the model to advance the cursor on "show me more."
</pagination>

<windowing>
## Windowing / last-N / walk-back

For time-ordered data, support "the last N" and "go back another period" directly, rather than making the model compute date ranges. A windowed read takes a count or a relative period and returns that slice plus a marker for the next walk-back.
</windowing>

<merge>
## Multi-source merge

When one user-level answer spans several backend collections, merge them inside the executor into one coherent, consistently-keyed view — rather than exposing one action per source and making the model stitch results together.
</merge>

<reslice_cache>
## Reslice cache

If the same underlying set is filtered or sorted repeatedly, cache it under a **query signature** (the normalized parameters that define the set). A request with the same signature reslices the cached rows from state instead of re-fetching; a different signature refetches. Keeps repeated "now sort by X / filter to Y" cheap.
</reslice_cache>

<retrieve_vs_analyze>
## Retrieve vs. analyze — keep the boundary clean

Separate **retrieval** (fetch / select / paginate / window) from **analysis** (filter / aggregate / compute):

- Retrieval actions own *getting the right rows into state*.
- Analysis actions own *answering questions over rows already in state*.

Don't bloat a retrieval action's params with filters or aggregations an analysis action already covers — duplicated surface confuses the model about which action to call. When an analysis action exists, the retrieval action should fetch broadly and let analysis narrow.
</retrieve_vs_analyze>
