// FILE: src/agent-step/deflect-aside.test.ts
//
// The trigger-happy-handoff damper (`deflect_aside`, HandoffSpec.deflectAside):
// one free in-place deflection of an out-of-scope aside per task; the repeat
// escalates atomically into the `off_topic` handback. What these tests pin:
//
//   - opt-in: without the spec flag the control is not injected (unknown
//     action), with it the schema/description carry the variant;
//   - first use: latch set, NO handoff, and — the whole point — a pending
//     confirmation gate survives untouched, so the task resumes;
//   - repeat: the off_topic handback is armed in the SAME step (no second
//     model call), with the aside as the routing context, and the pending
//     interaction is abandoned exactly as request_handoff abandons it;
//   - the latch is task-scoped: a task-ending handback resolution clears it,
//     so the next task on the thread gets its own free deflection;
//   - sole-step exclusivity and invalid-params behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Annotation } from "@langchain/langgraph";

import { defineConfig } from "./define-config.js";
import {
  buildAgentStepTool,
  runSteps,
  type BuildAgentStepToolOptions,
} from "./runner.js";
import { DEFLECT_ASIDE_ACTION } from "./controls/deflect-aside.js";
import { createHandoffNode } from "./handoff/node.js";
import type { HandoffSpec } from "./handoff/contract.js";
import type { ExecutorRegistry, VerifierRegistry } from "./types.js";
import type {
  AwaitingInput,
  BoundedChoice,
  CurrentFlow,
  HandoffRequest,
  TrailEntry,
} from "./state.js";
import type { PagedCache } from "./paginate.js";

interface S {
  thing?: string | null;
  messages?: unknown[];
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
  boundedChoice?: BoundedChoice | null;
  pagedRead?: PagedCache<unknown> | null;
  guardTurn?: Record<string, string> | null;
  deflectedAside?: boolean | null;
  handoff?: HandoffRequest | null;
  errorCount?: number | null;
}

const replaceNull = <T>() => ({
  reducer: (_o: T | null, n: T | null) => n ?? null,
  default: () => null as T | null,
});

const testStateAnnotation = Annotation.Root({
  actionTrail: Annotation<TrailEntry[] | null>(replaceNull<TrailEntry[]>()),
  thing: Annotation<string | null>(replaceNull<string>()),
  awaitingInput: Annotation<AwaitingInput | null>(replaceNull<AwaitingInput>()),
  currentFlow: Annotation<CurrentFlow | null>(replaceNull<CurrentFlow>()),
  boundedChoice: Annotation<BoundedChoice | null>(replaceNull<BoundedChoice>()),
  pagedRead: Annotation<PagedCache<unknown> | null>(
    replaceNull<PagedCache<unknown>>(),
  ),
  guardTurn: Annotation<Record<string, string> | null>(
    replaceNull<Record<string, string>>(),
  ),
  deflectedAside: Annotation<boolean | null>(replaceNull<boolean>()),
  handoff: Annotation<HandoffRequest | null>(replaceNull<HandoffRequest>()),
  errorCount: Annotation<number | null>(replaceNull<number>()),
});

type ActionName = "read_thing" | "change_thing";

const selectors = {
  read_thing: (s: S) => s,
  change_thing: (s: S) => s,
};

function makeOpts(
  deflectAside: boolean,
): BuildAgentStepToolOptions<S, string, string, typeof selectors> {
  const executors: ExecutorRegistry<S, typeof selectors> = {
    read_thing: async () => ({
      resultBody: { summary: "thing read" },
      ok: true,
    }),
    change_thing: async () => ({
      resultBody: { summary: "thing changed" },
      stateUpdate: { thing: "y" },
      ok: true,
    }),
  };
  const verifiers: VerifierRegistry<S> = {};
  const handoff: HandoffSpec<S> = {
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
    ...(deflectAside ? { deflectAside: true } : {}),
  };
  return {
    config: defineConfig<ActionName, never>({
      tool: { name: "test_tool", description: "test tool" },
      actions: {
        read_thing: {
          description: "read the thing",
          paramsSchema: z.object({}),
          prereqs: [],
        },
        change_thing: {
          description: "change the thing",
          paramsSchema: z.object({ v: z.string() }),
          prereqs: [],
          controller: { requiresConfirmation: true },
        },
      },
    }),
    stateSchema: testStateAnnotation,
    selectors,
    executors,
    verifiers,
    handoff,
  };
}

const DEFLECT = (aside = "τι καιρό έχει στην Αθήνα") => ({
  action: DEFLECT_ASIDE_ACTION,
  params: { aside },
});

// Confirmation-turn helper: propose change_thing so a gate is genuinely
// pending (stamped to a caller turn distinct from the deflect turn).
const turn = (id: string) => ({ type: "human", id, content: "…" });
async function pendingGateState(
  opts: BuildAgentStepToolOptions<S, string, string, typeof selectors>,
): Promise<S> {
  const base: S = { messages: [turn("t-ask")] };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "change_thing", params: { v: "y" } }],
    base,
  );
  assert.equal(
    (body.results[0] as { needs_confirmation?: boolean }).needs_confirmation,
    true,
  );
  return {
    ...base,
    ...committed,
    messages: [...base.messages!, turn("t-aside")],
  };
}

test("deflect_aside: NOT injected without the spec flag — unknown action", async () => {
  const { body } = await runSteps(makeOpts(false), [DEFLECT()], {} as S);
  assert.equal(body.failed_at, 0);
  assert.equal((body.results[0] as { error?: string }).error, "unknown_action");
});

test("deflect_aside: first use latches, hands NOTHING off, and instructs the re-ask", async () => {
  const { body, committed } = await runSteps(
    makeOpts(true),
    [DEFLECT()],
    {} as S,
  );
  const r = body.results[0] as {
    ok?: boolean;
    deflected?: boolean;
    handoff_requested?: boolean;
    summary?: string;
  };
  assert.equal(r.ok, true);
  assert.equal(r.deflected, true);
  assert.equal(
    r.handoff_requested,
    undefined,
    "no handoff on the free deflection",
  );
  assert.match(
    r.summary ?? "",
    /repeat your pending question in the SAME turn/,
  );
  assert.equal((committed as S).deflectedAside, true, "latch set");
  assert.equal((committed as S).handoff ?? null, null);
});

test("deflect_aside: a pending confirmation SURVIVES the deflection — the task resumes", async () => {
  const opts = makeOpts(true);
  const pending = await pendingGateState(opts);
  assert.ok(pending.awaitingInput, "precondition: a gate is pending");

  const { body, committed } = await runSteps(opts, [DEFLECT()], pending);
  assert.equal((body.results[0] as { deflected?: boolean }).deflected, true);
  const next = { ...pending, ...committed } as S;
  assert.deepEqual(next.awaitingInput, pending.awaitingInput, "gate untouched");
  assert.equal(next.handoff ?? null, null);
  assert.equal(next.deflectedAside, true);
});

test("deflect_aside: the REPEAT escalates atomically into the off_topic handback", async () => {
  const opts = makeOpts(true);
  const pending = await pendingGateState(opts);
  const first = await runSteps(opts, [DEFLECT()], pending);
  const afterFirst = { ...pending, ...first.committed } as S;

  const second = await runSteps(opts, [DEFLECT("και ο τελικός; τι έγινε;")], {
    ...afterFirst,
    messages: [...afterFirst.messages!, turn("t-aside-2")],
  });
  const r = second.body.results[0] as {
    ok?: boolean;
    deflect_exhausted?: boolean;
    handoff_requested?: boolean;
    reason?: string;
  };
  assert.equal(r.ok, true);
  assert.equal(r.deflect_exhausted, true);
  assert.equal(r.handoff_requested, true);
  assert.equal(r.reason, "off_topic");
  const next = { ...afterFirst, ...second.committed } as S;
  assert.deepEqual(next.handoff, {
    reason: "off_topic",
    context: "και ο τελικός; τι έγινε;",
  });
  assert.equal(
    next.awaitingInput ?? null,
    null,
    "the abandoned gate is cleared, like any handoff",
  );
});

test("deflect_aside: the latch is TASK-scoped — a task-ending handback resolution clears it", async () => {
  const spec: HandoffSpec<S> = {
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
    deflectAside: true,
  };
  const node = createHandoffNode<S>(spec);
  const state: S = {
    messages: [],
    deflectedAside: true,
    handoff: { reason: "completed", context: "done" },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = await node(state, {
    configurable: { thread_id: "t-clear" },
    writer: () => {},
  } as any);
  assert.equal(
    (update as S).deflectedAside,
    null,
    "the next task on this thread gets its own free deflection",
  );
});

test("deflect_aside: sole step — a mixed batch is refused", async () => {
  const { body } = await runSteps(
    makeOpts(true),
    [DEFLECT(), { action: "read_thing", params: {} }],
    {} as S,
  );
  assert.equal(body.failed_at, 0);
  assert.equal(
    (body.results[0] as { error?: string }).error,
    "deflect_must_be_sole_step",
  );
});

test("deflect_aside: a missing aside is invalid_params and latches nothing", async () => {
  const { body, committed } = await runSteps(
    makeOpts(true),
    [{ action: DEFLECT_ASIDE_ACTION, params: {} }],
    {} as S,
  );
  assert.equal(body.failed_at, 0);
  assert.equal((body.results[0] as { error?: string }).error, "invalid_params");
  assert.equal((committed as S).deflectedAside ?? null, null);
});

// ─── Gate preservation beyond the confirmation gate ─────────────────────── //
// `allowedDuringGateLockdown` / `allowedDuringChoicePending` must mean what
// they say for EVERY pending-interaction shape, not just the read-back.

test("deflect_aside: a pending OTP gate and its flow SURVIVE the deflection", async () => {
  const pending: S = {
    messages: [turn("t-otp")],
    awaitingInput: { kind: "otp", for_action: "validate_thing_otp", flow_ref: "thing_flow" },
    currentFlow: { name: "thing_flow", data: { step: "otp_sent" } },
  };
  const { body, committed } = await runSteps(makeOpts(true), [DEFLECT()], pending);
  assert.equal((body.results[0] as { deflected?: boolean }).deflected, true);
  const next = { ...pending, ...committed } as S;
  assert.deepEqual(next.awaitingInput, pending.awaitingInput, "OTP gate untouched");
  assert.deepEqual(next.currentFlow, pending.currentFlow, "flow untouched");
  assert.equal(next.handoff ?? null, null);
  assert.equal(next.deflectedAside, true);
});

test("deflect_aside: a pending double-entry match SURVIVES the deflection", async () => {
  const pending: S = {
    messages: [turn("t-match")],
    awaitingInput: {
      kind: "match",
      for_action: "change_thing",
      attempts_left: 2,
      max_attempts: 3,
    },
  };
  const { body, committed } = await runSteps(makeOpts(true), [DEFLECT()], pending);
  assert.equal((body.results[0] as { deflected?: boolean }).deflected, true);
  const next = { ...pending, ...committed } as S;
  assert.deepEqual(next.awaitingInput, pending.awaitingInput, "match gate untouched");
  assert.equal(next.handoff ?? null, null);
  assert.equal(next.deflectedAside, true);
});

test("deflect_aside: a pending bounded choice SURVIVES the deflection (allowedDuringChoicePending)", async () => {
  const opts: BuildAgentStepToolOptions<S, string, string, typeof selectors> = {
    ...makeOpts(true),
    boundedChoices: {
      off_menu_ask: {
        description: "meta-choice while an unsupported detail is pending",
        selections: ["continue"],
      },
    },
  };
  const pending: S = {
    messages: [turn("t-choice")],
    boundedChoice: { name: "off_menu_ask", status: "pending" },
  };
  const { body, committed } = await runSteps(opts, [DEFLECT()], pending);
  assert.equal((body.results[0] as { deflected?: boolean }).deflected, true);
  const next = { ...pending, ...committed } as S;
  assert.deepEqual(next.boundedChoice, pending.boundedChoice, "choice still pending");
  assert.equal(next.handoff ?? null, null);
  assert.equal(next.deflectedAside, true);
});

test("deflect_aside: an off_topic resolution does NOT clear the latch — a roundtrip cannot re-arm the freebie", async () => {
  const spec: HandoffSpec<S> = {
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
    deflectAside: true,
  };
  const node = createHandoffNode<S>(spec);
  const state: S = {
    messages: [],
    deflectedAside: true,
    handoff: { reason: "off_topic", context: "τι καιρό έχει" },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = await node(state, {
    configurable: { thread_id: "t-keep" },
    writer: () => {},
  } as any);
  assert.equal(
    (update as S).deflectedAside,
    undefined,
    "an off_topic handback is not task-ending — the spent latch must survive",
  );
});

// ─── Host surface: message override, channel validation, object form ─────── //

test("deflect_aside: a host messages.aside_deflected override reaches the step summary", async () => {
  const opts: BuildAgentStepToolOptions<S, string, string, typeof selectors> = {
    ...makeOpts(true),
    messages: { aside_deflected: "CUSTOM-ASIDE-NOTE" },
  };
  const { body } = await runSteps(opts, [DEFLECT()], {} as S);
  assert.equal((body.results[0] as { summary?: string }).summary, "CUSTOM-ASIDE-NOTE");
});

test("deflect_aside: construction rejects a state schema missing the deflectedAside channel", () => {
  // Everything ELSE this config writes is present — only the latch channel is
  // missing, so without the validate.ts guard the write would be silently
  // discarded and the escalation would never fire.
  const incomplete = Annotation.Root({
    // actionTrail present so the assertion below stays pinned to the ONE slot
    // this test deliberately omits.
    actionTrail: Annotation<TrailEntry[] | null>(replaceNull<TrailEntry[]>()),
    thing: Annotation<string | null>(replaceNull<string>()),
    awaitingInput: Annotation<AwaitingInput | null>(replaceNull<AwaitingInput>()),
    handoff: Annotation<HandoffRequest | null>(replaceNull<HandoffRequest>()),
    errorCount: Annotation<number | null>(replaceNull<number>()),
  });
  assert.throws(
    () => buildAgentStepTool({ ...makeOpts(true), stateSchema: incomplete }),
    /missing channel\(s\) "deflectedAside"/,
  );
  // Without the opt-in the same schema is complete — the channel is only
  // required by the feature that writes it.
  buildAgentStepTool({ ...makeOpts(false), stateSchema: incomplete });
});

test("deflect_aside: the object form enables the control and overrides the schema description", () => {
  // Read the variant descriptions from the wire shape (what the provider
  // actually receives) — same probe as the request_handoff override test.
  const variantDescriptions = (tool: { schema: unknown }): (string | undefined)[] => {
    const s = tool.schema as {
      properties: { steps: { items: { anyOf?: Array<{ description?: string }> } } };
    };
    return (s.properties.steps.items.anyOf ?? [s.properties.steps.items]).map(
      (o) => (o as { description?: string }).description,
    );
  };

  const stock = variantDescriptions(buildAgentStepTool(makeOpts(true)));
  assert.ok(
    stock.some((d) => d?.includes("OUTSIDE every configured agent's scope")),
    "boolean opt-in carries the domain-neutral default description",
  );

  const custom = makeOpts(true);
  custom.handoff = {
    ...custom.handoff!,
    deflectAside: { actionDescription: "CUSTOM-DEFLECT-DESC" },
  };
  const overridden = variantDescriptions(buildAgentStepTool(custom));
  assert.ok(overridden.includes("CUSTOM-DEFLECT-DESC"), "override replaces the description");
  assert.ok(
    !overridden.some((d) => d?.includes("OUTSIDE every configured agent's scope")),
    "the default text is fully replaced",
  );
});
