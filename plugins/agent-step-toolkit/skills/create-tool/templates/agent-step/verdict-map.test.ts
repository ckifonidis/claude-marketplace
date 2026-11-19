// FILE: src/agent-step/verdict-map.test.ts
//
// The per-verdict declaration map (declarative-authoring pass, 2026-08-15):
// executors return `{ verdict, data?, stateUpdate?, effects?, resultExtras? }`
// and the runner composes the result body from the action's VerdictDef row —
// declaration order is wire order, static rows own doctrine, and the derived
// registries (asks, backendFailureCodes) cannot fork from the row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import { buildAgentStepTool, runSteps, type BuildAgentStepToolOptions } from "./runner.js";
import { agentStepStateSpec, type LibraryManagedSlots } from "./state.js";
import type {
  DeclaredExecutorResult,
  ExecutorRegistry,
  VerdictDef,
} from "./types.js";

interface S extends LibraryManagedSlots {
  messages?: unknown[];
  outcome?: string | null;
  detail?: string | null;
}

const stateSchema = Annotation.Root({
  messages: Annotation<unknown[]>({ reducer: (_o, n) => n, default: () => [] }),
  ...agentStepStateSpec,
  outcome: Annotation<string | null>({ reducer: (_o, n) => n, default: () => null }),
  detail: Annotation<string | null>({ reducer: (_o, n) => n, default: () => null }),
});

type ActionName = "act" | "target";
const selectors = { act: (s: S) => s, target: (s: S) => s };

/** Per-test switchable behavior: each test assigns the next return value. */
let nextResult: DeclaredExecutorResult<S> = { verdict: "plain" };

function makeOpts(
  verdicts: Record<string, VerdictDef>,
): BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "verdict_test_tool", description: "verdict-map test tool" },
    actions: {
      act: {
        description: "an action with declared verdict rows",
        paramsSchema: z.object({ value: z.string().optional() }),
        prereqs: [],
        verdicts,
      },
      target: {
        description: "an ask target",
        paramsSchema: z.object({ answer: z.string().optional() }),
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "t" } },
      },
    },
  });
  const executors: ExecutorRegistry<S, typeof selectors> = {
    act: async () => nextResult,
    target: async () => ({ verdict: "ok" }),
  };
  return {
    config,
    stateSchema,
    selectors,
    executors,
    verifiers: {},
    handoff: { offTopic: { mode: "terminate" }, resolveClosingMessage: (_s: unknown, r: { context: string }) => r.context },
    errorHandoffThreshold: 1,
  };
}

const ROWS: Record<string, VerdictDef> = {
  plain: {
    ok: false,
    summary: "a static summary",
    body: { verdict: "plain", error: "plain_code", reason: "static doctrine" },
  },
  rendered: {
    ok: true,
    summary: (state, data) =>
      `lang=${String((state as S).detail ?? "none")} kind=${String(data.kind ?? "?")}`,
    body: { verdict: "rendered", reason: (data: Record<string, unknown>) => `saw ${String(data.diag)}` },
    stateUpdate: { outcome: "row_wrote_this" },
    effects: [{ type: "clear_awaiting_input" }],
  },
  failing: {
    ok: false,
    summary: "backend broke",
    body: { error: "backend_broke", reason: (data: Record<string, unknown>) => data.reason },
    backendFailure: true,
  },
};

const step = { action: "act", params: {} };

test("body composes as summary + declared fields in declaration order + extras last", async () => {
  nextResult = { verdict: "plain", resultExtras: { extra_flag: true } };
  const { body } = await runSteps(makeOpts(ROWS), [step], { messages: [] });
  const entry = body.results[0];
  assert.deepEqual(
    Object.keys(entry).filter((k) => k !== "action"),
    ["ok", "summary", "verdict", "error", "reason", "extra_flag"],
    "declaration order is wire order; extras append last",
  );
  assert.equal(entry.ok, false);
  assert.equal(entry.summary, "a static summary");
  assert.equal(entry.reason, "static doctrine");
  assert.equal(entry.extra_flag, true);
});

test("summary renders over (state, data); reason renders over data; merges favor the executor", async () => {
  nextResult = {
    verdict: "rendered",
    data: { kind: "debit", diag: "d1" },
    stateUpdate: { detail: "executor_wrote_this" },
    effects: [{ type: "abort_flow" }],
  };
  const { body, committed } = await runSteps(makeOpts(ROWS), [step], {
    messages: [],
    detail: "el",
  });
  const entry = body.results[0];
  assert.equal(entry.summary, "lang=el kind=debit");
  assert.equal(entry.reason, "saw d1");
  assert.equal(committed.outcome, "row_wrote_this", "row statics apply");
  assert.equal(committed.detail, "executor_wrote_this", "executor dynamics apply beside them");
});

test("an undeclared verdict fails loudly as executor_error with the verdict named", async () => {
  nextResult = { verdict: "nonexistent" };
  const { body } = await runSteps(makeOpts(ROWS), [step], { messages: [] });
  const entry = body.results[0];
  assert.equal(entry.error, "executor_error");
  assert.match(String(entry._debug), /undeclared verdict "nonexistent"/);
});

test("backendFailure rows derive the auto-handoff code (threshold 1 fires)", async () => {
  nextResult = { verdict: "failing", data: { reason: "socket hang up" } };
  const { body, committed } = await runSteps(makeOpts(ROWS), [step], { messages: [] });
  assert.equal(body.results[0].error, "backend_broke");
  assert.ok(committed.handoff, "one declared backend failure reaches the auto-handoff");
});

test("construction rejects a backendFailure row without a static error code", () => {
  assert.throws(
    () =>
      buildAgentStepTool(
        makeOpts({
          bad: { ok: false, summary: "x", backendFailure: true },
        }),
      ),
    /backendFailure but body\.error/,
  );
});
