// FILE: src/agent-step/trail.test.ts
//
// Runner unit tests for the `actionTrail` audit slot (run/finalize.ts): the
// per-task, runner-owned record of what each admitted batch actually did.
// Covered properties:
//   - one entry per step result, in order, projected as action/ok/error only
//     (never params or result bodies);
//   - confirmation proposals carry `proposed: true`, the later execute does not;
//   - the trail accumulates across batches through `initialState`;
//   - an admission-refused batch leaves NO trail (nothing admitted, nothing
//     committed) while an execution-phase refusal IS recorded;
//   - the synthetic `auto_handoff` entry appears when the error threshold fires;
//   - an executor writing `actionTrail` through stateUpdate throws loudly;
//   - the slot is task-scoped (cleared by a task-ending handback).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Annotation } from "@langchain/langgraph";

import { defineConfig } from "./define-config.js";
import { runSteps, type BuildAgentStepToolOptions } from "./runner.js";
import type { ExecutorRegistry, VerifierRegistry } from "./types.js";
import { agentStepTaskScopedSlots } from "./state.js";
import type {
  AwaitingInput,
  CurrentFlow,
  HandoffRequest,
  TrailEntry,
} from "./state.js";

interface S {
  customer?: { code: string } | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
  handoff?: HandoffRequest | null;
  errorCount?: number | null;
  actionTrail?: TrailEntry[] | null;
}

const stateSchema = Annotation.Root({
  customer: Annotation<S["customer"] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  awaitingInput: Annotation<AwaitingInput | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  currentFlow: Annotation<CurrentFlow | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  handoff: Annotation<HandoffRequest | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  errorCount: Annotation<number | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
  actionTrail: Annotation<TrailEntry[] | null>({
    reducer: (_, n) => n ?? null,
    default: () => null,
  }),
});

type ActionName = "read_data" | "write_data" | "fail_data" | "rogue_write";

const selectors = {
  read_data: (s: S) => s,
  write_data: (s: S) => s,
  fail_data: (s: S) => s,
  rogue_write: (s: S) => s,
};

function makeOpts(): BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "trail_tool", description: "trail test tool" },
    actions: {
      read_data: {
        description: "read some data",
        paramsSchema: z.object({}),
        prereqs: [],
      },
      write_data: {
        description: "confirm-gated write",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: true },
      },
      fail_data: {
        description: "backend call that throws",
        paramsSchema: z.object({}),
        prereqs: [],
      },
      rogue_write: {
        description: "executor that illegally writes actionTrail",
        paramsSchema: z.object({}),
        prereqs: [],
      },
    },
  });
  const executors: ExecutorRegistry<S, typeof selectors> = {
    read_data: async () => ({ resultBody: { summary: "read ok" }, ok: true }),
    write_data: async () => ({ resultBody: { summary: "written" }, ok: true }),
    fail_data: async () => {
      throw new Error("backend exploded");
    },
    rogue_write: async () => ({
      resultBody: { summary: "rogue" },
      ok: true,
      stateUpdate: { actionTrail: [] } as Partial<S>,
    }),
  };
  return {
    config,
    stateSchema,
    selectors,
    executors,
    verifiers: {} as VerifierRegistry<S>,
  };
}

test("trail: one ordered entry per executed step, projection only", async () => {
  const opts = makeOpts();
  const { committed } = await runSteps(
    opts,
    [
      { action: "read_data", params: {} },
      { action: "read_data", params: {} },
    ],
    {},
  );
  assert.deepEqual(committed.actionTrail, [
    { action: "read_data", ok: true },
    { action: "read_data", ok: true },
  ]);
});

test("trail: executor failure is recorded with its error code, earlier entries survive", async () => {
  const opts = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [
      { action: "read_data", params: {} },
      { action: "fail_data", params: {} },
    ],
    {},
  );
  assert.equal(body.failed_at, 1);
  assert.deepEqual(committed.actionTrail, [
    { action: "read_data", ok: true },
    { action: "fail_data", ok: false, error: "executor_error" },
  ]);
});

test("trail: proposal carries proposed:true, the later execute does not, and the trail accumulates across batches", async () => {
  const opts = makeOpts();
  const carried: TrailEntry[] = [{ action: "read_data", ok: true }];

  // Batch 1: the confirm-gated write proposes (no executor run).
  const propose = await runSteps(
    opts,
    [{ action: "write_data", params: { value: "5" } }],
    { actionTrail: carried },
  );
  assert.equal(propose.body.results[0].needs_confirmation, true);
  assert.deepEqual(propose.committed.actionTrail, [
    { action: "read_data", ok: true },
    { action: "write_data", ok: true, proposed: true },
  ]);

  // Batch 2 (a new tool call after the caller confirmed): same params execute.
  const execState: S = { ...propose.committed };
  const exec = await runSteps(
    opts,
    [{ action: "write_data", params: { value: "5" } }],
    execState,
  );
  assert.deepEqual(exec.committed.actionTrail, [
    { action: "read_data", ok: true },
    { action: "write_data", ok: true, proposed: true },
    { action: "write_data", ok: true },
  ]);
});

test("trail: an admission-refused batch commits nothing — no trail entry", async () => {
  const opts = makeOpts();
  const { body, committed } = await runSteps(
    opts,
    [{ action: "not_an_action", params: {} }],
    {},
  );
  assert.equal(body.results[0].error, "unknown_action");
  assert.ok(!("actionTrail" in committed), "refusal must not write a trail");
  assert.deepEqual(committed, {});
});

test("trail: an empty batch writes nothing (no state churn)", async () => {
  const opts = makeOpts();
  const { committed } = await runSteps(opts, [], {
    actionTrail: [{ action: "read_data", ok: true }],
  });
  assert.ok(!("actionTrail" in committed));
});

test("trail: the request_handoff control is recorded like any step", async () => {
  const opts: BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> = {
    ...makeOpts(),
    handoff: {
      offTopic: { mode: "terminate" },
      terminateMessage: "transferring you now",
    },
  };
  const { committed } = await runSteps(
    opts,
    [{ action: "request_handoff", params: { reason: "completed", context: "done" } }],
    {},
  );
  assert.deepEqual(committed.handoff, { reason: "completed", context: "done" });
  assert.deepEqual(committed.actionTrail, [{ action: "request_handoff", ok: true }]);
});

test("trail: the synthetic auto_handoff entry is recorded when the threshold fires", async () => {
  const opts: BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> = {
    ...makeOpts(),
    onErrorThreshold: () => {},
  };
  let state: S = {};
  for (let i = 0; i < 3; i++) {
    const res = await runSteps(opts, [{ action: "fail_data", params: {} }], state);
    state = { ...state, ...res.committed };
  }
  const failEntry: TrailEntry = { action: "fail_data", ok: false, error: "executor_error" };
  assert.deepEqual(state.actionTrail, [
    failEntry,
    failEntry,
    failEntry,
    { action: "auto_handoff", ok: true },
  ]);
});

test("trail: an executor writing actionTrail through stateUpdate throws loudly", async () => {
  const opts = makeOpts();
  await assert.rejects(
    runSteps(opts, [{ action: "rogue_write", params: {} }], {}),
    /wrote library-managed slot\(s\) "actionTrail"/,
  );
});

test("trail: the slot is task-scoped — a task-ending handback clears it", () => {
  assert.ok(
    (agentStepTaskScopedSlots as readonly string[]).includes("actionTrail"),
    "actionTrail must be cleared when a completed/abandon handback resolves",
  );
});
