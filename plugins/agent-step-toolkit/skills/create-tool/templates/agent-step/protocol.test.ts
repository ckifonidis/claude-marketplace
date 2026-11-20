// FILE: src/agent-step/protocol.test.ts
//
// The protocol fragment and the tool surface are composed from ONE config and
// must agree on what exists: the prompt may name a control, or a reply kind,
// only when the tool the model is handed carries it. A name with nothing
// behind it costs a refused call (`unknown_action`) on a live turn — the
// required-mode fragment once sent every host to `repeat_pending_question`,
// a control only a `repeatReadBack` gate activates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { buildAgentStepTool, runSteps } from "./runner.js";
import { callerTextParam } from "./capture.js";
import { agentStepStateSpec } from "./state.js";
import { compilePlan } from "./compile/plan.js";
import { composeProtocolPrompt } from "./compile/protocol.js";
import { CONTROL_REGISTRY } from "./controls/registry.js";
import { REPEAT_PENDING_QUESTION_ACTION } from "./controls/repeat-question.js";
import { modelToolsForTurn } from "./reply.js";

const stateSchema = Annotation.Root({
  ...agentStepStateSpec,
  messages: Annotation<unknown[]>({ reducer: (_old, next) => next, default: () => [] }),
});

type Gate = "none" | "plain" | "repeatable";
const GATES: Gate[] = ["none", "plain", "repeatable"];

function options(gate: Gate, toolChoice: "auto" | "required", handoff: boolean) {
  const confirmation =
    gate === "none"
      ? undefined
      : {
          maxAttempts: 3,
          readBack: () => "Shall I proceed?",
          ...(gate === "repeatable"
            ? {
                repeatReadBack: true,
                replyContract: {
                  subject: "this confirmation",
                  subjectNoun: "confirmation",
                  executesLabel: "the change",
                  categories: ["A question about the change is answered before asking again."],
                },
              }
            : {}),
        };
  return {
    config: {
      tool: { name: "surface_test", description: "Surface test", toolChoice },
      actions: {
        change: {
          description: "Change the selected item",
          paramsSchema: z.object({ target: z.string() }),
          prereqs: [] as never[],
          verdicts: { ok: { ok: true, summary: "Changed." } },
          ...(confirmation ? { controller: { requiresConfirmation: confirmation } } : {}),
        },
      },
    },
    stateSchema,
    selectors: { change: (state: unknown) => state },
    executors: { change: async () => ({ verdict: "ok" }) },
    verifiers: {},
    ...(handoff
      ? { handoff: { offTopic: { mode: "terminate" as const }, resolveClosingMessage: () => "Goodbye." } }
      : {}),
  };
}

/** Everything the model reads about the tool on a fresh caller turn. */
function modelSurface(opts: ReturnType<typeof options>): string {
  const tool = buildAgentStepTool(opts as never);
  return JSON.stringify(modelToolsForTurn([tool], [])[0]);
}

test("the protocol names a control only when the tool carries it", () => {
  for (const toolChoice of ["auto", "required"] as const) {
    for (const gate of GATES) {
      for (const handoff of [true, false]) {
        const opts = options(gate, toolChoice, handoff);
        const active = new Set(compilePlan(opts as never).controls.map((c) => c.name));
        const protocol = composeProtocolPrompt(opts as never);
        for (const control of CONTROL_REGISTRY) {
          if (active.has(control.name)) continue;
          assert.ok(
            !protocol.includes(control.name),
            `${toolChoice}/${gate}/handoff=${handoff}: the protocol names \`${control.name}\`, which this tool does not carry`,
          );
        }
      }
    }
  }
});

test("without a repeatable gate, neither the protocol nor the model's surface mentions repeating or reply kinds", () => {
  for (const gate of ["none", "plain"] as const) {
    const opts = options(gate, "required", true);
    const protocol = composeProtocolPrompt(opts as never);
    const surface = modelSurface(opts);
    for (const absent of [REPEAT_PENDING_QUESTION_ACTION, "reply kind", 'kind: "clarification"', 'kind: "choice"']) {
      assert.ok(!protocol.includes(absent), `${gate}: the protocol mentions ${absent}`);
    }
    for (const absent of [REPEAT_PENDING_QUESTION_ACTION, "reply kind", "requires kind", '"const":"clarification"', "no configured action"]) {
      assert.ok(!surface.includes(absent), `${gate}: the model's surface mentions ${absent}`);
    }
    // What remains is still a complete READ-BACK rule.
    assert.match(protocol, /\*\*READ-BACK \(sole authority\):\*\* .*placeholder in `respond_to_caller\.text`\. The system inserts/);
    assert.match(protocol, /latest tool result\. Otherwise compose the permitted reply/);
  }
});

test("a repeatable gate puts the repeat control and the reply kinds on both sides", () => {
  const opts = options("repeatable", "required", true);
  const protocol = composeProtocolPrompt(opts as never);
  const active = compilePlan(opts as never).controls.map((c) => c.name);
  assert.ok(active.includes(REPEAT_PENDING_QUESTION_ACTION));
  assert.ok(protocol.includes(`\`${REPEAT_PENDING_QUESTION_ACTION}\``));
  assert.ok(protocol.includes('kind: "clarification"'));
  assert.ok(protocol.includes(", without a reply kind."));
  const description = (buildAgentStepTool(opts as never) as unknown as { description: string }).description;
  assert.ok(description.includes(`\`${REPEAT_PENDING_QUESTION_ACTION}\``));
  assert.ok(description.includes("the reply kind governs a pending repeatable confirmation"));
});

// ── What the repeat control serves ──────────────────────────────────────────
//
// A standing value ask's stored bytes are shown as `ask_text` on the result
// that asked and as `awaiting.question` on its record after an aside; both are
// served. An ungated verbatim question shows an `awaiting.question` too, but
// lives in the transcript alone: the control refuses it and it is re-asked by
// speech. (READ-BACK's clause does not draw this line — see protocol.ts for
// why its measured wording stays.)

const ASK_TEXT = "Which reference should I use?";
const QUESTION = "Is this the item you mean?";

function repeatFixture() {
  const base = options("repeatable", "required", true);
  const opts = {
    ...base,
    config: {
      ...base.config,
      actions: {
        ...base.config.actions,
        ask_source: {
          description: "Asks for the value",
          paramsSchema: z.object({}),
          prereqs: [] as never[],
          verdicts: {
            need_value: {
              ok: false,
              summary: "The value is needed.",
              ask: { action: "capture_value", render: () => ASK_TEXT },
            },
          },
        },
        capture_value: {
          description: "Receives the value",
          paramsSchema: z.object({
            value: callerTextParam({
              min: 1, max: 100, shortMessage: "missing", longMessage: "unusable",
              describe: "The value exactly as supplied.",
            }),
          }),
          prereqs: [] as never[],
          verdicts: { ok: { ok: true, summary: "Captured." } },
        },
        locate: {
          description: "Locates the item",
          paramsSchema: z.object({}),
          prereqs: [] as never[],
          verdicts: {
            ok: { ok: true, summary: QUESTION, continuation: "await_caller" as const, presentation: "verbatim" as const },
          },
        },
      },
    },
    selectors: {
      change: (state: unknown) => state,
      ask_source: (state: unknown) => state,
      capture_value: (state: unknown) => state,
      locate: (state: unknown) => state,
    },
    executors: {
      change: async () => ({ verdict: "ok" }),
      ask_source: async () => ({ verdict: "need_value" }),
      capture_value: async () => ({ verdict: "ok" }),
      locate: async () => ({ verdict: "ok" }),
    },
  };
  return opts as never;
}

type Body = { results: Array<Record<string, unknown>> };
const caller = (id: string) => new HumanMessage({ id, content: "…" });
const result = (body: unknown) => new ToolMessage({ tool_call_id: "call", content: JSON.stringify(body) });
const one = (action: string, params: Record<string, unknown> = {}) => [{ action, params }];

test("a standing value ask is served by repeat from either field: ask_text, then awaiting.question after an aside", async () => {
  const opts = repeatFixture();
  let messages: unknown[] = [caller("turn-1")];
  let state: Record<string, unknown> = { messages, awaitingInput: null };

  const asked = await runSteps(opts, one("ask_source"), state as never);
  assert.equal((asked.body as Body).results[0].ask_text, ASK_TEXT);
  state = { ...state, ...(asked.committed as object) };
  messages = [...messages, result(asked.body)];

  const aside = await runSteps(opts, one("respond_to_caller", { text: "Take your time. {ask_text}" }), { ...state, messages } as never);
  const record = (aside.body as Body).results[0].awaiting as Record<string, unknown>;
  assert.equal(record.kind, "dictation");
  assert.equal(record.question, ASK_TEXT, "after an aside the stored ask rides awaiting.question");
  messages = [...messages, result(aside.body), caller("turn-2")];

  const repeated = await runSteps(opts, one(REPEAT_PENDING_QUESTION_ACTION), { ...state, messages } as never);
  assert.equal((repeated.body as Body).results[0].ok, true);
  assert.equal((repeated.body as Body).results[0].read_back, ASK_TEXT);
});

test("an ungated verbatim question is not served by repeat; the refusal leaves it standing for a spoken re-ask", async () => {
  const opts = repeatFixture();
  let messages: unknown[] = [caller("turn-1")];
  const state: Record<string, unknown> = { messages, awaitingInput: null };

  const located = await runSteps(opts, one("locate"), state as never);
  assert.equal((located.body as Body).results[0].reply_text, QUESTION);
  assert.equal(
    (located.committed as { awaitingInput?: unknown }).awaitingInput ?? null,
    null,
    "the engine stores no gate for it",
  );
  messages = [...messages, result(located.body)];

  const presented = await runSteps(opts, one("respond_to_caller", { text: "{reply_text}" }), { ...state, messages } as never);
  assert.deepEqual((presented.body as Body).results[0].awaiting, { kind: "question", for_action: "locate", question: QUESTION });
  messages = [...messages, result(presented.body), caller("turn-2")];

  const repeated = await runSteps(opts, one(REPEAT_PENDING_QUESTION_ACTION), { ...state, messages } as never);
  assert.equal((repeated.body as Body).results[0].ok, false);
  assert.equal((repeated.body as Body).results[0].error, "repeat_confirmation_not_available");
  assert.deepEqual(repeated.committed, {});
  messages = [...messages, result(repeated.body)];

  const reasked = await runSteps(opts, one("respond_to_caller", { text: `Of course. ${QUESTION}` }), { ...state, messages } as never);
  assert.equal((reasked.body as Body).results[0].ok, true);
  assert.deepEqual((reasked.body as Body).results[0].awaiting, { kind: "question", for_action: "locate", question: QUESTION });
});
