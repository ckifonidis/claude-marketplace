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
## Pagination — use the library's `pageable`

Pagination is a **first-class library feature** — don't hand-roll it. Declare `pageable` on the read's `ActionDef` and the runner injects `page`/`pageSize` params, slices the result, and emits a uniform envelope `{ page, pageSize, totalCount, totalPages, hasMore, items, fromCache }`:

- **`pageable: true`** (self) — your executor returns the **FULL set** in `resultBody.items`; the runner slices the page and caches the full set in the library-managed `pagedRead` slot, so a same-query re-page skips the executor (`fromCache: true`). Use when the backend returns everything.
- **`pageable: "delegate"`** — the backend pages; your executor reads `page`/`pageSize` and returns that page in `items` + `totalCount`. No cache.

Constraint: a `pageable` action's `paramsSchema` must be a `z.object` (page params are merged in). The prompt teaches the model to re-call with `page: n+1` (same filters) for "show me more". Starting point: `templates/executor-read-paginated.ts.template`. Contract: `agent-step-api.md` `<pagination>`.
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

If the same underlying set is paged repeatedly, the result should be cached under a **query signature** (the normalized params that define the set, excluding `page`/`pageSize`) so a same-query re-page reslices instead of re-fetching; a different signature refetches.

For a `pageable: true` read this is **automatic** — the runner stores the full set in the library-managed `pagedRead` slot and re-pages from it. Only hand-roll a cache (with the exported `querySignature` helper) for a bespoke read that can't use `pageable` — e.g. one whose "set" is defined by something other than its params, or that merges multiple sources under a custom key.
</reslice_cache>

<retrieve_vs_analyze>
## Retrieve vs. analyze — keep the boundary clean

Separate **retrieval** (fetch / select / paginate / window) from **analysis** (filter / aggregate / compute):

- Retrieval actions own *getting the right rows into state*.
- Analysis actions own *answering questions over rows already in state*.

Don't bloat a retrieval action's params with filters or aggregations an analysis action already covers — duplicated surface confuses the model about which action to call. When an analysis action exists, the retrieval action should fetch broadly and let analysis narrow.

For open-ended aggregation (totals / group-by / top-N / filtered sums) the analysis action is best built as an **LLM-authored snippet run in a host VM** rather than a fixed set of aggregation params. The full build recipe — datasets-as-single-source-of-truth, the `node:vm` runner, the `dataLoaded` prereq, and the prompt schema/data-block wiring — is in `data-analysis-pattern.md` (templates: `executor-analysis.ts.template`, `analysis-vm.ts.template`, `datasets.ts.template`, `verifier-data-loaded.ts.template`).
</retrieve_vs_analyze>
