// FILE: src/agent-step/tolerances.test.ts
//
// THE ENGINE TOLERANCES (tolerances.ts) — the four numbers behind bounded
// patience and the backend-failure auto-handoff, and the deployment's
// `AGENT_STEP_*` environment overrides.
//
// What is locked here:
//
//   • The RESOLVER: measured defaults when nothing is set, a set variable
//     wins, a blank one is unset, a malformed or out-of-range one THROWS
//     naming the variable, and an explicit `errorHandoffThreshold` outranks
//     its variable (which is still validated).
//   • END TO END: each variable actually moves its bound — one plain bounce
//     instead of two, an immediate escalation instead of a free explanation,
//     a first malicious attempt that ends the task, a first backend failure
//     that hands off.
//   • CONSTRUCTION: `buildAgentStepTool` reads the environment ONCE and fails
//     loudly on a bad value; a compiled plan keeps the bounds it was compiled
//     with.
//   • MODEL-INVISIBLE: moving a tolerance moves no model-facing byte — the
//     description, the protocol fragment and the plain bounce are identical.
//
// Each test that sets a variable restores the environment afterwards; the file
// runs in its own process (`node --test`), sequentially.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import { runSteps, buildAgentStepTool, type BuildAgentStepToolOptions } from "./runner.js";
import { agentStepStateSpec, type LibraryManagedSlots } from "./state.js";
import { callerDigits } from "./capture.js";
import { compilePlan } from "./compile/plan.js";
import { composeProtocolPrompt } from "./compile/protocol.js";
import { MALICIOUS_CONTEXT, escalationContext } from "./interaction/escalation.js";
import { AUTO_HANDOFF_CONTEXT } from "./handoff/contract.js";
import { ENGINE_TEXT } from "./engine-text.js";
import {
  BOUNCE_TOLERANCE,
  DEFAULT_TOLERANCES,
  ERROR_HANDOFF_THRESHOLD,
  FREE_EXPLANATIONS,
  MALICIOUS_LIMIT,
  TOLERANCE_ENV,
  resolveTolerances,
} from "./tolerances.js";
import * as publicSurface from "./index.js";

// ─── Fixture ────────────────────────────────────────────────────────────────

interface S extends LibraryManagedSlots {
  messages?: unknown[];
}

const stateSchema = Annotation.Root({
  messages: Annotation<unknown[]>({
    reducer: (_old, next) => next,
    default: () => [],
  }),
  ...agentStepStateSpec,
});

type ActionName = "capture_value" | "call_backend";

const selectors = {
  capture_value: (state: S) => state,
  call_backend: (state: S) => state,
};

const digitsParams = z
  .object({ value: callerDigits(/^\d{9}$/u, "not a usable capture") })
  .strict();

const BAD = { action: "capture_value", params: { value: "0354081" } };
const MALICIOUS = { action: "note_refusal", params: { kind: "malicious_intent" } };
const UNSUPPORTED = { action: "note_refusal", params: { kind: "unsupported_question" } };
const THROW = { action: "call_backend", params: {} };

type Opts = BuildAgentStepToolOptions<S, ActionName, never, typeof selectors>;

function makeOpts(extra: Partial<Opts> = {}): Opts {
  const config = defineConfig<ActionName, never>({
    tool: { name: "tolerance_tool", description: "tolerance tool" },
    actions: {
      capture_value: {
        description: "receives a dictated value",
        paramsSchema: digitsParams,
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
      call_backend: {
        description: "calls a backend that is down",
        paramsSchema: z.object({}),
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "called" } },
      },
    },
  });
  return {
    config,
    stateSchema,
    selectors,
    executors: {
      capture_value: async () => ({ verdict: "ok" }),
      call_backend: async () => {
        throw new Error("backend down");
      },
    },
    verifiers: {},
    handoff: {
      offTopic: { mode: "terminate" },
      resolveClosingMessage: (_s: unknown, r: { context: string }) => r.context,
    },
    ...extra,
  } as unknown as Opts;
}

const BASE: S = { messages: [{ role: "user", id: "t1", content: "…" }] };
type Handoff = { reason: string; context: string } | null | undefined;
const handoffOf = (s: unknown): Handoff => (s as { handoff?: Handoff }).handoff;

/** Drive one step and thread the committed state forward. */
async function step(opts: Opts, s: S, call: { action: string; params: unknown }) {
  const { body, committed } = await runSteps(opts, [call], s);
  return { body, entry: body.results[0], committed, next: { ...s, ...committed } as S };
}

/** Run `fn` with the given variables set, then restore the environment
 *  exactly — including variables that were unset before. */
async function withEnv<R>(
  vars: Record<string, string | undefined>,
  fn: () => R | Promise<R>,
): Promise<R> {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ENV = TOLERANCE_ENV;

// ─── The resolver ───────────────────────────────────────────────────────────

test("the variable names are the documented AGENT_STEP_* four", () => {
  assert.deepEqual(TOLERANCE_ENV, {
    bounceTolerance: "AGENT_STEP_BOUNCE_TOLERANCE",
    freeExplanations: "AGENT_STEP_FREE_EXPLANATIONS",
    maliciousLimit: "AGENT_STEP_MALICIOUS_LIMIT",
    errorHandoffThreshold: "AGENT_STEP_ERROR_HANDOFF_THRESHOLD",
  });
});

test("nothing set: the measured defaults", () => {
  assert.deepEqual(resolveTolerances({}), {
    bounceTolerance: 2,
    freeExplanations: 1,
    maliciousLimit: 3,
    errorHandoffThreshold: 3,
  });
  assert.deepEqual(resolveTolerances({}), { ...DEFAULT_TOLERANCES });
  assert.deepEqual(
    [BOUNCE_TOLERANCE, FREE_EXPLANATIONS, MALICIOUS_LIMIT, ERROR_HANDOFF_THRESHOLD],
    [2, 1, 3, 3],
    "the exported constants ARE the defaults",
  );
});

test("a set variable wins; the others keep their defaults", () => {
  assert.deepEqual(resolveTolerances({ [ENV.bounceTolerance]: "4" }), {
    ...DEFAULT_TOLERANCES,
    bounceTolerance: 4,
  });
  assert.deepEqual(
    resolveTolerances({
      [ENV.bounceTolerance]: "0",
      [ENV.freeExplanations]: "0",
      [ENV.maliciousLimit]: "1",
      [ENV.errorHandoffThreshold]: "1",
    }),
    { bounceTolerance: 0, freeExplanations: 0, maliciousLimit: 1, errorHandoffThreshold: 1 },
    "the minimum of each is accepted",
  );
});

test("a blank variable is UNSET, and surrounding whitespace is ignored", () => {
  assert.deepEqual(
    resolveTolerances({ [ENV.bounceTolerance]: "", [ENV.maliciousLimit]: "   " }),
    { ...DEFAULT_TOLERANCES },
  );
  assert.equal(resolveTolerances({ [ENV.freeExplanations]: " 2 " }).freeExplanations, 2);
});

test("a malformed value throws, naming the variable and the default", () => {
  for (const bad of ["abc", "2.5", "-1", "+2", "1e2", "0x2", "two", "2 3", "99999999999999999999"]) {
    assert.throws(
      () => resolveTolerances({ [ENV.bounceTolerance]: bad }),
      (err: Error) =>
        err.message.startsWith("agent-step: AGENT_STEP_BOUNCE_TOLERANCE must be an integer >= 0") &&
        err.message.includes(JSON.stringify(bad)) &&
        err.message.includes("default (2)"),
      `"${bad}" must be refused`,
    );
  }
});

test("each variable enforces its own minimum", () => {
  assert.throws(
    () => resolveTolerances({ [ENV.maliciousLimit]: "0" }),
    /AGENT_STEP_MALICIOUS_LIMIT must be an integer >= 1 \(got "0"\)/,
  );
  assert.throws(
    () => resolveTolerances({ [ENV.errorHandoffThreshold]: "0" }),
    /AGENT_STEP_ERROR_HANDOFF_THRESHOLD must be an integer >= 1 \(got "0"\)/,
  );
  assert.throws(
    () => resolveTolerances({ [ENV.freeExplanations]: "-1" }),
    /AGENT_STEP_FREE_EXPLANATIONS must be an integer >= 0/,
  );
});

test("an explicit errorHandoffThreshold outranks its variable — which is still validated", () => {
  assert.equal(
    resolveTolerances({ [ENV.errorHandoffThreshold]: "5" }).errorHandoffThreshold,
    5,
    "the variable applies when the option is omitted",
  );
  assert.equal(
    resolveTolerances({ [ENV.errorHandoffThreshold]: "5" }, { errorHandoffThreshold: 1 })
      .errorHandoffThreshold,
    1,
    "the option wins",
  );
  assert.throws(
    () => resolveTolerances({ [ENV.errorHandoffThreshold]: "nope" }, { errorHandoffThreshold: 1 }),
    /AGENT_STEP_ERROR_HANDOFF_THRESHOLD must be an integer >= 1/,
    "a malformed variable is a deployment mistake even when outranked",
  );
});

test("the resolver defaults to the process environment", async () => {
  await withEnv({ [ENV.bounceTolerance]: "7" }, () => {
    assert.equal(resolveTolerances().bounceTolerance, 7);
  });
  await withEnv({ [ENV.bounceTolerance]: undefined }, () => {
    assert.equal(resolveTolerances().bounceTolerance, BOUNCE_TOLERANCE);
  });
});

test("the public surface exports the resolver, the names and the defaults", () => {
  assert.equal(publicSurface.resolveTolerances, resolveTolerances);
  assert.equal(publicSurface.TOLERANCE_ENV, TOLERANCE_ENV);
  assert.equal(publicSurface.DEFAULT_TOLERANCES, DEFAULT_TOLERANCES);
  assert.equal(publicSurface.BOUNCE_TOLERANCE, 2);
  assert.equal(publicSurface.FREE_EXPLANATIONS, 1);
  assert.equal(publicSurface.MALICIOUS_LIMIT, 3);
  assert.equal(publicSurface.ERROR_HANDOFF_THRESHOLD, 3);
});

// ─── End to end: each variable moves its bound ──────────────────────────────

test("AGENT_STEP_BOUNCE_TOLERANCE moves the plain-bounce allowance", async () => {
  // Default: two plain bounces, the third explains.
  await withEnv({ [ENV.bounceTolerance]: undefined }, async () => {
    const opts = makeOpts();
    let s = BASE;
    for (let i = 0; i < 2; i += 1) {
      const r = await step(opts, s, BAD);
      s = r.next;
      assert.equal(r.entry.instruction, ENGINE_TEXT.invalid_params, `bounce ${i + 1} is plain`);
    }
    assert.equal((await step(opts, s, BAD)).entry.instruction, ENGINE_TEXT.explain_detail_needed);
  });
  // One: a single plain bounce, the second explains.
  await withEnv({ [ENV.bounceTolerance]: "1" }, async () => {
    const opts = makeOpts();
    const first = await step(opts, BASE, BAD);
    assert.equal(first.entry.instruction, ENGINE_TEXT.invalid_params);
    const second = await step(opts, first.next, BAD);
    assert.equal(second.entry.instruction, ENGINE_TEXT.explain_detail_needed);
    assert.equal(handoffOf(second.committed) ?? null, null, "explained, not escalated");
  });
  // Zero: the very first unusable capture is explained.
  await withEnv({ [ENV.bounceTolerance]: "0" }, async () => {
    const r = await step(makeOpts(), BASE, BAD);
    assert.equal(r.entry.instruction, ENGINE_TEXT.explain_detail_needed);
  });
  // Four: still plain on the fourth.
  await withEnv({ [ENV.bounceTolerance]: "4" }, async () => {
    const opts = makeOpts();
    let s = BASE;
    for (let i = 0; i < 4; i += 1) {
      const r = await step(opts, s, BAD);
      s = r.next;
      assert.equal(r.entry.instruction, ENGINE_TEXT.invalid_params, `bounce ${i + 1} is plain`);
    }
    assert.equal((await step(opts, s, BAD)).entry.instruction, ENGINE_TEXT.explain_detail_needed);
  });
});

test("AGENT_STEP_FREE_EXPLANATIONS moves the explanations before the escalation", async () => {
  // Zero: the first climb escalates — no in-place explanation at all.
  await withEnv({ [ENV.freeExplanations]: "0" }, async () => {
    const r = await step(makeOpts(), BASE, UNSUPPORTED);
    assert.equal(r.entry.escalated, true);
    assert.deepEqual(handoffOf(r.committed), {
      reason: "abandon",
      context: escalationContext(null),
    });
  });
  // Two: two free uses, the third escalates.
  await withEnv({ [ENV.freeExplanations]: "2" }, async () => {
    const opts = makeOpts();
    let s = BASE;
    for (let i = 0; i < 2; i += 1) {
      const r = await step(opts, s, UNSUPPORTED);
      s = r.next;
      assert.equal(r.entry.instruction, ENGINE_TEXT.decline_unsupported, `use ${i + 1} is free`);
      assert.equal(handoffOf(r.committed) ?? null, null);
    }
    const last = await step(opts, s, UNSUPPORTED);
    assert.equal(last.entry.escalated, true);
  });
});

test("the two patience variables compose on the capture path", async () => {
  await withEnv({ [ENV.bounceTolerance]: "1", [ENV.freeExplanations]: "0" }, async () => {
    const opts = makeOpts();
    const first = await step(opts, BASE, BAD);
    assert.equal(first.entry.instruction, ENGINE_TEXT.invalid_params, "one plain bounce");
    const second = await step(opts, first.next, BAD);
    assert.equal(second.entry.escalated, true, "no free explanation: straight to the handoff");
    assert.deepEqual(handoffOf(second.committed), {
      reason: "abandon",
      context: escalationContext("capture_value"),
    });
  });
});

test("AGENT_STEP_MALICIOUS_LIMIT moves the attempt that ends the task", async () => {
  await withEnv({ [ENV.maliciousLimit]: "1" }, async () => {
    const r = await step(makeOpts(), BASE, MALICIOUS);
    assert.equal(r.entry.handoff_requested, true, "the first attempt ends it");
    assert.deepEqual(handoffOf(r.committed), { reason: "completed", context: MALICIOUS_CONTEXT });
  });
  await withEnv({ [ENV.maliciousLimit]: "5" }, async () => {
    const opts = makeOpts();
    let s = BASE;
    for (let i = 1; i < 5; i += 1) {
      const r = await step(opts, s, MALICIOUS);
      s = r.next;
      assert.equal(r.entry.instruction, ENGINE_TEXT.decline_malicious, `attempt ${i} stays in place`);
      assert.equal(handoffOf(r.committed) ?? null, null);
    }
    assert.equal((await step(opts, s, MALICIOUS)).entry.handoff_requested, true);
  });
});

test("AGENT_STEP_ERROR_HANDOFF_THRESHOLD moves the auto-handoff — unless the option pins it", async () => {
  // Default: the first backend failure only counts.
  await withEnv({ [ENV.errorHandoffThreshold]: undefined }, async () => {
    const r = await step(makeOpts(), BASE, THROW);
    assert.equal((r.committed as { errorCount?: number }).errorCount, 1);
    assert.equal(handoffOf(r.committed) ?? null, null);
  });
  // One: the first backend failure hands off.
  await withEnv({ [ENV.errorHandoffThreshold]: "1" }, async () => {
    const r = await step(makeOpts(), BASE, THROW);
    assert.equal(handoffOf(r.committed)?.context, AUTO_HANDOFF_CONTEXT);
    assert.equal(r.body.results[r.body.results.length - 1].action, "auto_handoff");
  });
  // The explicit option outranks the variable.
  await withEnv({ [ENV.errorHandoffThreshold]: "1" }, async () => {
    const r = await step(makeOpts({ errorHandoffThreshold: 2 }), BASE, THROW);
    assert.equal(handoffOf(r.committed) ?? null, null, "the option's 2 holds: no handoff yet");
    assert.equal((r.committed as { errorCount?: number }).errorCount, 1);
  });
});

// ─── Construction ───────────────────────────────────────────────────────────

test("buildAgentStepTool fails loudly on a malformed variable", async () => {
  await withEnv({ [ENV.maliciousLimit]: "three" }, () => {
    assert.throws(
      () => buildAgentStepTool(makeOpts()),
      /agent-step: AGENT_STEP_MALICIOUS_LIMIT must be an integer >= 1 \(got "three"\)/,
    );
  });
  await withEnv({ [ENV.bounceTolerance]: "-2" }, async () => {
    await assert.rejects(
      () => runSteps(makeOpts(), [BAD], BASE),
      /AGENT_STEP_BOUNCE_TOLERANCE must be an integer >= 0/,
      "the runSteps seam refuses it too",
    );
  });
});

test("a compiled plan keeps the bounds it was compiled with", async () => {
  // `buildAgentStepTool` compiles ONCE and closes over the plan, so the plan's
  // snapshot is what a running tool keeps for its lifetime.
  const plan = await withEnv(
    { [ENV.bounceTolerance]: "0", [ENV.maliciousLimit]: "9" },
    () => compilePlan(makeOpts()),
  );
  await withEnv({ [ENV.bounceTolerance]: "6", [ENV.maliciousLimit]: undefined }, () => {
    assert.deepEqual(plan.tolerances, {
      bounceTolerance: 0,
      freeExplanations: FREE_EXPLANATIONS,
      maliciousLimit: 9,
      errorHandoffThreshold: ERROR_HANDOFF_THRESHOLD,
    });
    assert.equal(compilePlan(makeOpts()).tolerances.bounceTolerance, 6, "a NEW compile re-reads");
  });
});

// ─── Model-invisible ────────────────────────────────────────────────────────

test("moving a tolerance moves no model-facing byte", async () => {
  const surface = () => {
    const opts = makeOpts();
    const t = buildAgentStepTool(opts);
    return {
      description: t.description,
      schema: JSON.stringify((t as unknown as { schema: unknown }).schema),
      protocol: composeProtocolPrompt(opts),
    };
  };
  const baseline = await withEnv(
    {
      [ENV.bounceTolerance]: undefined,
      [ENV.freeExplanations]: undefined,
      [ENV.maliciousLimit]: undefined,
      [ENV.errorHandoffThreshold]: undefined,
    },
    surface,
  );
  const moved = await withEnv(
    {
      [ENV.bounceTolerance]: "5",
      [ENV.freeExplanations]: "4",
      [ENV.maliciousLimit]: "9",
      [ENV.errorHandoffThreshold]: "7",
    },
    surface,
  );
  assert.deepEqual(moved, baseline);
  // And the plain bounce itself is the same count-free instruction.
  const plain = await withEnv({ [ENV.bounceTolerance]: "5" }, () => step(makeOpts(), BASE, BAD));
  assert.equal(plain.entry.instruction, ENGINE_TEXT.invalid_params);
  assert.doesNotMatch(JSON.stringify(plain.body), /\b5\b/);
});
