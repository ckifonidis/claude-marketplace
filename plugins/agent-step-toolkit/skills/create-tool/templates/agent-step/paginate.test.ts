// FILE: src/agent-step/paginate.test.ts
//
// Unit tests for the read-pagination primitives. Pure functions — no runner, no
// backend, no LLM. Mirrors the runner.test.ts convention (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampPageSize,
  querySignature,
  pageRows,
  buildPageEnvelope,
} from "./paginate.js";

// ─── clampPageSize ───────────────────────────────────────────────────────────
test("clampPageSize: defaults when omitted", () => {
  assert.equal(clampPageSize(undefined), DEFAULT_PAGE_SIZE);
});
test("clampPageSize: floors at 1 and caps at MAX", () => {
  assert.equal(clampPageSize(0), 1);
  assert.equal(clampPageSize(-5), 1);
  assert.equal(clampPageSize(9999), MAX_PAGE_SIZE);
  assert.equal(clampPageSize(9999, 300), 300);
  assert.equal(clampPageSize(25), 25);
});

// ─── querySignature ──────────────────────────────────────────────────────────
test("querySignature: arrays are order-independent, scalars positional", () => {
  assert.equal(querySignature(["b", "a"]), querySignature(["a", "b"]));
  assert.notEqual(querySignature("a", "b"), querySignature("b", "a"));
});
test("querySignature: null/undefined collapse but keep position", () => {
  assert.equal(querySignature("914", undefined), "914|");
  assert.equal(querySignature(undefined, "914"), "|914");
  assert.notEqual(querySignature("914", undefined), querySignature(undefined, "914"));
});
test("querySignature: mixed scalar types", () => {
  assert.equal(querySignature("seg", 1, true), "seg|1|true");
});

// ─── pageRows (self-paginate path) ───────────────────────────────────────────
test("pageRows: slices the requested page and reports totals", () => {
  const rows = Array.from({ length: 23 }, (_, i) => i);
  const p1 = pageRows(rows, 1, 10);
  assert.deepEqual(p1.items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(p1.page, 1);
  assert.equal(p1.totalCount, 23);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.fromCache, false);

  const p3 = pageRows(rows, 3, 10);
  assert.deepEqual(p3.items, [20, 21, 22]);
  assert.equal(p3.hasMore, false);
});
test("pageRows: clamps out-of-range page into [1, totalPages]", () => {
  const rows = [1, 2, 3];
  assert.equal(pageRows(rows, 99, 10).page, 1); // only 1 page
  assert.equal(pageRows(rows, 0, 10).page, 1);
  assert.equal(pageRows(rows, undefined, 10).page, 1);
});
test("pageRows: empty set → 1 page, no items, no more", () => {
  const e = pageRows([], 1, 10);
  assert.deepEqual(e.items, []);
  assert.equal(e.totalCount, 0);
  assert.equal(e.totalPages, 1);
  assert.equal(e.hasMore, false);
});
test("pageRows: fromCache flag passes through", () => {
  assert.equal(pageRows([1], 1, 10, true).fromCache, true);
});

// ─── buildPageEnvelope (delegate path) ───────────────────────────────────────
test("buildPageEnvelope: derives totalPages/hasMore from backend totalCount", () => {
  const env = buildPageEnvelope({ items: [1, 2, 3, 4, 5], page: 2, pageSize: 5, totalCount: 42 });
  assert.equal(env.page, 2);
  assert.equal(env.pageSize, 5);
  assert.equal(env.totalCount, 42);
  assert.equal(env.totalPages, 9); // ceil(42/5)
  assert.equal(env.hasMore, true);
  assert.equal(env.fromCache, false);
  assert.deepEqual(env.items, [1, 2, 3, 4, 5]);
});
test("buildPageEnvelope: last page has no more", () => {
  const env = buildPageEnvelope({ items: [1, 2], page: 9, pageSize: 5, totalCount: 42 });
  assert.equal(env.hasMore, false);
});
