// FILE: src/agent-step/paginate.ts
//
// Read-pagination primitives + the `pageable` orchestration the runner uses to
// auto-wire paginated reads. An action opts in with `pageable` in its config;
// the runner then injects `page`/`pageSize` params, slices/wraps the result into
// a uniform envelope, and (for self-paginate) caches the full set in the
// library-managed `pagedRead` slot so a same-query re-page skips the executor.
//
// Two strategies, chosen by the action's `pageable` value:
//   - true / { mode: true }       — SELF: executor returns the FULL set in
//     `resultBody.items`; the runner slices + caches it.
//   - "delegate" / { mode: "delegate" } — DELEGATE: the backend pages; executor
//     reads the injected `page`/`pageSize`, returns the page in `resultBody.items`
//     plus `resultBody.totalCount`; the runner just wraps it. No cache.
//
// These functions are pure (no runner state); the runner passes in the params,
// the executor's resultBody, and the current cache value.

/** Default page size when the caller/action omits one. */
export const DEFAULT_PAGE_SIZE = 10;
/** Upper bound on page size handed to the model (keeps result bodies lean). */
export const MAX_PAGE_SIZE = 50;

/** Opt-in shape for `ActionDef.pageable`. `false`/absent = not paginated;
 *  `true` = self-paginate with library defaults; `"delegate"` = backend-paged
 *  with library defaults; object form tunes the page size per action. */
export type PageableSpec =
  | boolean
  | "delegate"
  | { mode: true | "delegate"; pageSize?: number; maxPageSize?: number };

/** Normalized pageable config used by the runner. */
export interface ResolvedPageable {
  mode: "self" | "delegate";
  defaultPageSize: number;
  maxPageSize: number;
}

/** The uniform page envelope every paginated read returns. The runner spreads
 *  it into the StepResult alongside the executor's `summary` + domain fields. */
export interface PageEnvelope<Row> {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
  items: Row[];
  fromCache: boolean;
}

/** Library-managed cache of a full result set for self-paginate reads. Keyed by
 *  action name + query signature; `extras` preserves the executor's non-`items`
 *  result fields so a cache-hit page still carries `summary`/domain headlines. */
export interface PagedCache<Row> {
  key: string;
  signature: string;
  rows: Row[];
  extras: Record<string, unknown>;
}

/** Clamp a requested page size into `[1, max]`, defaulting when omitted. */
export function clampPageSize(
  requested: number | undefined,
  max: number = MAX_PAGE_SIZE,
): number {
  return Math.min(Math.max(1, requested ?? DEFAULT_PAGE_SIZE), max);
}

/** Normalize an `ActionDef.pageable` value, or `null` when not paginated. */
export function resolvePageable(spec: PageableSpec | undefined): ResolvedPageable | null {
  if (!spec) return null; // false / undefined
  if (spec === true) {
    return { mode: "self", defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE };
  }
  if (spec === "delegate") {
    return { mode: "delegate", defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE };
  }
  const mode = spec.mode === "delegate" ? "delegate" : "self";
  const defaultPageSize = spec.pageSize ?? DEFAULT_PAGE_SIZE;
  return {
    mode,
    defaultPageSize,
    maxPageSize: spec.maxPageSize ?? Math.max(MAX_PAGE_SIZE, defaultPageSize),
  };
}

/** Deterministic signature of a query's result set. Pass the normalized parts
 *  that DEFINE the set — every filter / id / range field — but NOT page or
 *  pageSize (paging within one set must reuse the cache).
 *
 *  - Array-valued parts are sorted, so they're order-independent.
 *  - Scalar parts are positional; null/undefined collapse to empty (pass fields
 *    in a STABLE order so an omitted optional doesn't shift the others). */
export function querySignature(
  ...parts: Array<string | number | boolean | string[] | null | undefined>
): string {
  return parts
    .map((part) => {
      if (part == null) return "";
      if (Array.isArray(part)) return [...part].map(String).sort().join(",");
      return String(part);
    })
    .join("|");
}

function stableStringify(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => `${k}:${stableStringify(o[k])}`)
        .join(",") +
      "}"
    );
  }
  return String(v);
}

const PAGE_PARAM_KEYS = new Set(["page", "pageSize"]);

/** Signature derived from an action's parsed params, excluding `page`/`pageSize`
 *  (so paging within one set reuses the cache). Keys are sorted for stability. */
export function paramsSignature(params: unknown): string {
  if (params == null || typeof params !== "object") return "";
  const obj = params as Record<string, unknown>;
  return Object.keys(obj)
    .filter((k) => !PAGE_PARAM_KEYS.has(k))
    .sort()
    .map((k) => `${k}=${stableStringify(obj[k])}`)
    .join("&");
}

/** Build the envelope for a page sliced from a FULL in-memory set (self path).
 *  `page` is clamped into `[1, totalPages]`. */
export function pageRows<Row>(
  rows: Row[],
  page: number | undefined,
  pageSize: number,
  fromCache = false,
): PageEnvelope<Row> {
  const totalCount = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const current = Math.min(Math.max(1, page ?? 1), totalPages);
  const items = rows.slice((current - 1) * pageSize, current * pageSize);
  return { page: current, pageSize, totalCount, totalPages, hasMore: current < totalPages, items, fromCache };
}

/** Build the envelope for a page a backend already sliced (delegate path).
 *  `items` is the backend's page; `totalCount` its reported total. */
export function buildPageEnvelope<Row>(opts: {
  items: Row[];
  page: number | undefined;
  pageSize: number;
  totalCount: number;
}): PageEnvelope<Row> {
  const { items, pageSize, totalCount } = opts;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const current = Math.min(Math.max(1, opts.page ?? 1), totalPages);
  return { page: current, pageSize, totalCount, totalPages, hasMore: current < totalPages, items, fromCache: false };
}

function requestedPageSize(params: unknown, resolved: ResolvedPageable): number {
  const ps = (params as { pageSize?: unknown } | null)?.pageSize;
  return clampPageSize(typeof ps === "number" ? ps : resolved.defaultPageSize, resolved.maxPageSize);
}

function requestedPage(params: unknown): number | undefined {
  const p = (params as { page?: unknown } | null)?.page;
  return typeof p === "number" ? p : undefined;
}

/** Outcome of paginating an executor's result: the StepResult body to surface
 *  and, for self-paginate misses, the cache patch to commit. */
export interface PaginationOutcome {
  body: Record<string, unknown>;
  cachePatch: { pagedRead: PagedCache<unknown> } | null;
}

/** Transform an executor's ok result into a paginated envelope. SELF: slice the
 *  full `items` + emit a cache patch. DELEGATE: wrap the page using `totalCount`. */
export function applyPagination(
  actionName: string,
  resolved: ResolvedPageable,
  params: unknown,
  resultBody: Record<string, unknown>,
): PaginationOutcome {
  const pageSize = requestedPageSize(params, resolved);
  const page = requestedPage(params);
  const items = Array.isArray(resultBody.items) ? (resultBody.items as unknown[]) : [];
  const extras: Record<string, unknown> = { ...resultBody };
  delete extras.items;

  if (resolved.mode === "delegate") {
    const totalCount = typeof resultBody.totalCount === "number" ? (resultBody.totalCount as number) : items.length;
    delete extras.totalCount;
    return { body: { ...extras, ...buildPageEnvelope({ items, page, pageSize, totalCount }) }, cachePatch: null };
  }

  // self-paginate: items is the FULL set
  const env = pageRows(items, page, pageSize, false);
  const cache: PagedCache<unknown> = {
    key: actionName,
    signature: paramsSignature(params),
    rows: items,
    extras,
  };
  return { body: { ...extras, ...env }, cachePatch: { pagedRead: cache } };
}

/** If a self-paginate cache holds this exact query, return the requested page's
 *  body WITHOUT re-running the executor; otherwise `null` (miss → run executor). */
export function tryPageFromCache(
  actionName: string,
  resolved: ResolvedPageable,
  params: unknown,
  cache: PagedCache<unknown> | null | undefined,
): Record<string, unknown> | null {
  if (resolved.mode !== "self" || !cache) return null;
  if (cache.key !== actionName || cache.signature !== paramsSignature(params)) return null;
  const env = pageRows(cache.rows, requestedPage(params), requestedPageSize(params, resolved), true);
  return { ...cache.extras, ...env };
}
