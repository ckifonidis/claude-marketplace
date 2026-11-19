// FILE: src/agent-step/satisfies.test.ts
//
// State-satisfied inputs (`ActionDef.satisfies`): the engine mechanic behind
// the hand-rolled carry patterns hosts kept writing (a probe module, a
// carried-value source + graph opener, carried-value prompt flags, an
// authenticated-channel executor branch). What the mechanic must guarantee:
//
//   - a DICTATED capture always wins — a call carrying its capture field
//     never consults the declaration;
//   - an empty CONSENT call with values carried proposes on the ordinary
//     gate, read_back = the rendered reuse-consent question (engine
//     directive framing it), and the yes re-call hands the executor the
//     resolved bundle — which never appears in params or proposed_params;
//   - an empty CONSENT call with nothing usable answers through the declared
//     elseVerdict row — no gate stored, no attempt spent, the row's own ask
//     recorded (the host's "nothing carried" business answer);
//   - a MALFORMED carried value (fails the capture field's own refinement)
//     counts as nothing carried — the gate never opens over garbage;
//   - a SILENT (ungated) empty call executes immediately with the bundle,
//     and with nothing carried still reaches the executor (which owns that
//     answer);
//   - every declared fact is construction-checked: paths against the state
//     schema, mode against the gate, the else row against the verdicts.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Annotation } from "@langchain/langgraph";
import { agentStepStateSpec } from "./state.js";
import { defineConfig } from "./define-config.js";
import { runSteps } from "./runner.js";
import { digitGroupsParam, judgedEnum } from "./capture.js";
import { ENGINE_TEXT } from "./engine-text.js";
import type { BuildAgentStepToolOptions } from "./compile/plan.js";
import type { ActionDef, SatisfiedSource } from "./types.js";

interface S {
  errorCount?: number | null;
  carried?: { afm?: string } | null;
  session_code?: string | null;
  session_user?: string | null;
}

const stateSchema = Annotation.Root({
  ...agentStepStateSpec,
  carried: Annotation<{ afm?: string } | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),
  session_code: Annotation<string | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),
  session_user: Annotation<string | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),
});

const human = (id: string) => ({ type: "human", id, content: "…" });

const digits = () =>
  digitGroupsParam({ shape: /^\d{9}$/u, message: "not a usable capture", describe: "digits" });

const ASK_BYTES = "Να χρησιμοποιήσω τα στοιχεία που δώσατε νωρίτερα;";

/** One gated consent action + one ungated silent action. `seen` records what
 *  each executor received. Callers mutate the actions to express the variant
 *  under test. */
function makeOpts(mutate: (actions: Record<string, ActionDef<never, S>>) => void = () => {}): {
  opts: BuildAgentStepToolOptions<S, string, never, Record<string, (s: S) => unknown>>;
  seen: { verify: Array<{ params: unknown; source: SatisfiedSource | undefined }>; silent: Array<{ params: unknown; source: SatisfiedSource | undefined }> };
} {
  const seen = {
    verify: [] as Array<{ params: unknown; source: SatisfiedSource | undefined }>,
    silent: [] as Array<{ params: unknown; source: SatisfiedSource | undefined }>,
  };
  const actions: Record<string, ActionDef<never, S>> = {
    verify_thing: {
      description: "verifies the caller",
      paramsSchema: z.object({ spokenDigits: digits() }),
      prereqs: [],
      controller: {
        requiresConfirmation: {
          maxAttempts: 3,
          readBack: (params) =>
            typeof params.spokenDigits === "string" && params.spokenDigits.length > 0
              ? `digits: ${params.spokenDigits}`
              : undefined,
        },
      },
      satisfies: {
        values: { spokenDigits: "carried.afm" },
        mode: "consent",
        ask: () => ASK_BYTES,
        elseVerdict: "nothing_carried",
      },
      verdicts: {
        ok: { ok: true, summary: "verified", body: { verdict: "ok" } },
        nothing_carried: {
          ok: false,
          summary: "nothing carried — ask for the value",
          body: { verdict: "nothing_carried" },
          ask: "self",
        },
      },
    },
    silent_thing: {
      description: "resolves the session identity",
      paramsSchema: z.object({}),
      prereqs: [],
      satisfies: {
        values: { code: "session_code", user: "session_user" },
        mode: "silent",
      },
      verdicts: {
        ok: { ok: true, summary: "resolved", body: { verdict: "ok" } },
        anonymous: { ok: false, summary: "no session", body: { verdict: "anonymous" } },
      },
    },
  };
  mutate(actions);
  const opts = {
    config: defineConfig<string, never>({
      tool: { name: "satisfies_test_tool", description: "satisfies test tool" },
      actions,
    }),
    stateSchema,
    selectors: { verify_thing: (s: S) => s, silent_thing: (s: S) => s },
    executors: {
      verify_thing: async (params: unknown, _s: S, source?: SatisfiedSource) => {
        seen.verify.push({ params, source });
        return { verdict: "ok" };
      },
      silent_thing: async (params: unknown, _s: S, source?: SatisfiedSource) => {
        seen.silent.push({ params, source });
        return { verdict: source ? "ok" : "anonymous" };
      },
    },
    verifiers: {},
  } as unknown as BuildAgentStepToolOptions<S, string, never, Record<string, (s: S) => unknown>>;
  return { opts, seen };
}

const run = (
  opts: unknown,
  steps: { action: string; params: unknown }[],
  state: Partial<S> & Record<string, unknown> = {},
) =>
  runSteps(
    opts as BuildAgentStepToolOptions<S, string, never, Record<string, (s: S) => unknown>>,
    steps,
    state as S,
  );

// ─── The consent path ──────────────────────────────────────────────────────

test("empty consent call with a carried value proposes: read_back is the consent question", async () => {
  const { opts, seen } = makeOpts();
  const { body, committed } = await run(
    opts,
    [{ action: "verify_thing", params: {} }],
    { messages: [human("t1")], carried: { afm: "012345678" } },
  );
  const entry = body.results[0] as Record<string, unknown>;
  assert.equal(entry.needs_confirmation, true);
  assert.deepEqual(entry.proposed_params, {}, "the carried value never enters proposed_params");
  assert.equal(entry.read_back, ASK_BYTES);
  assert.equal(entry.read_back_directive, ENGINE_TEXT.read_back_directive_satisfies_consent);
  assert.equal(seen.verify.length, 0, "propose never executes");
  const gate = (committed as { awaitingInput?: unknown }).awaitingInput as {
    kind?: string;
    for_action?: string;
  };
  assert.equal(gate.kind, "confirmation");
  assert.equal(gate.for_action, "verify_thing");
});

test("the yes re-call executes with the resolved bundle — params stay empty", async () => {
  const { opts, seen } = makeOpts();
  const carried = { afm: "012345678" };
  const first = await run(opts, [{ action: "verify_thing", params: {} }], {
    messages: [human("t1")],
    carried,
  });
  const { body } = await run(opts, [{ action: "verify_thing", params: {} }], {
    messages: [human("t1"), human("t2")],
    carried,
    awaitingInput: (first.committed as { awaitingInput?: unknown }).awaitingInput,
  });
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].verdict, "ok");
  assert.equal(seen.verify.length, 1);
  const call = seen.verify[0];
  assert.equal((call.params as { spokenDigits?: string }).spokenDigits, undefined);
  assert.deepEqual(call.source, { values: { spokenDigits: "012345678" } });
});

test("empty consent call with NOTHING carried answers through the elseVerdict row — no gate", async () => {
  const { opts, seen } = makeOpts();
  const { body, committed } = await run(
    opts,
    [{ action: "verify_thing", params: {} }],
    { messages: [human("t1")] },
  );
  const entry = body.results[0] as Record<string, unknown>;
  assert.equal(entry.ok, false);
  assert.equal(entry.verdict, "nothing_carried");
  assert.equal(entry.needs_confirmation, undefined, "no gate is proposed over nothing");
  // The row's own ask is recorded — the caller now owes the value.
  assert.deepEqual(entry.standing_ask, { action: "verify_thing", param: "spokenDigits" });
  const gate = (committed as { awaitingInput?: unknown }).awaitingInput as { kind?: string };
  assert.equal(gate?.kind, "dictation", "a standing ask, never a confirmation gate");
  assert.equal(seen.verify.length, 0);
});

test("a MALFORMED carried value counts as nothing carried — the gate never opens over garbage", async () => {
  const { opts } = makeOpts();
  const { body } = await run(
    opts,
    [{ action: "verify_thing", params: {} }],
    { messages: [human("t1")], carried: { afm: "0354081" } }, // 7 digits
  );
  assert.equal(body.results[0].verdict, "nothing_carried");
  assert.equal(body.results[0].needs_confirmation, undefined);
});

test("a DICTATED capture bypasses satisfies entirely — the host read-back renders", async () => {
  const { opts } = makeOpts();
  const { body } = await run(
    opts,
    [{ action: "verify_thing", params: { spokenDigits: ["987654321"] } }],
    { messages: [human("t1")], carried: { afm: "012345678" } },
  );
  const entry = body.results[0] as Record<string, unknown>;
  assert.equal(entry.needs_confirmation, true);
  assert.equal(entry.read_back, "digits: 987654321", "the dictated value wins");
  assert.notEqual(entry.read_back_directive, ENGINE_TEXT.read_back_directive_satisfies_consent);
});

// ─── Partial resolution (consent riders) ───────────────────────────────────

test("consent: a missing RIDER is skipped — the offer stands on the capture value alone", async () => {
  const { opts, seen } = makeOpts((a) => {
    a.verify_thing.satisfies!.values = {
      spokenDigits: "carried.afm",
      extra: "session_code", // rider — not a param of the action
    };
  });
  const carried = { afm: "012345678" }; // session_code deliberately absent
  const first = await run(opts, [{ action: "verify_thing", params: {} }], {
    messages: [human("t1")],
    carried,
  });
  const entry = first.body.results[0] as Record<string, unknown>;
  assert.equal(entry.needs_confirmation, true, "the partial carry still offers");
  assert.equal(entry.read_back, ASK_BYTES);
  const { body } = await run(opts, [{ action: "verify_thing", params: {} }], {
    messages: [human("t1"), human("t2")],
    carried,
    awaitingInput: (first.committed as { awaitingInput?: unknown }).awaitingInput,
  });
  assert.equal(body.results[0].ok, true);
  assert.deepEqual(
    seen.verify[0].source,
    { values: { spokenDigits: "012345678" } },
    "the bundle carries what resolved — the rider is simply absent",
  );
});

test("consent: a missing CAPTURE key is unavailable no matter which riders exist", async () => {
  const { opts } = makeOpts((a) => {
    a.verify_thing.satisfies!.values = {
      spokenDigits: "carried.afm",
      extra: "session_code",
    };
  });
  const { body } = await run(
    opts,
    [{ action: "verify_thing", params: {} }],
    { messages: [human("t1")], session_code: "C123" }, // rider present, capture absent
  );
  assert.equal(body.results[0].verdict, "nothing_carried");
  assert.equal(body.results[0].needs_confirmation, undefined);
});

test("consent whose values name NO capture field fails construction", async () => {
  const { opts } = makeOpts((a) => {
    a.verify_thing.satisfies!.values = { extra: "session_code" };
  });
  await assert.rejects(
    () => run(opts, [{ action: "verify_thing", params: {} }]),
    /no values key naming one of the action's own capture fields/,
  );
});

// ─── The silent path ───────────────────────────────────────────────────────

test("silent: an empty call with the session present executes immediately with the bundle", async () => {
  const { opts, seen } = makeOpts();
  const { body } = await run(
    opts,
    [{ action: "silent_thing", params: {} }],
    { messages: [human("t1")], session_code: "C123", session_user: "U9" },
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].verdict, "ok");
  assert.deepEqual(seen.silent[0].source, { values: { code: "C123", user: "U9" } });
});

test("silent: a PARTIAL session (witness missing) resolves nothing — the executor owns the answer", async () => {
  const { opts, seen } = makeOpts();
  const { body } = await run(
    opts,
    [{ action: "silent_thing", params: {} }],
    { messages: [human("t1")], session_code: "C123" }, // no session_user
  );
  assert.equal(body.results[0].verdict, "anonymous");
  assert.equal(seen.silent[0].source, undefined);
});

// ─── Construction checks ───────────────────────────────────────────────────

test("consent on an UNGATED action fails construction", async () => {
  const { opts } = makeOpts((a) => {
    delete a.verify_thing.controller;
  });
  await assert.rejects(
    () => run(opts, [{ action: "verify_thing", params: {} }]),
    /mode "consent" but is not confirmation-gated/,
  );
});

test("silent on a GATED action fails construction", async () => {
  const { opts } = makeOpts((a) => {
    a.silent_thing.controller = { requiresConfirmation: { maxAttempts: 3 } };
  });
  await assert.rejects(
    () => run(opts, [{ action: "silent_thing", params: {} }]),
    /mode "silent" but is confirmation-gated/,
  );
});

test("consent without `ask` fails construction", async () => {
  const { opts } = makeOpts((a) => {
    delete a.verify_thing.satisfies!.ask;
  });
  await assert.rejects(
    () => run(opts, [{ action: "verify_thing", params: {} }]),
    /requires `ask`/,
  );
});

test("consent with an undeclared elseVerdict fails construction", async () => {
  const { opts } = makeOpts((a) => {
    a.verify_thing.satisfies!.elseVerdict = "no_such_row";
  });
  await assert.rejects(
    () => run(opts, [{ action: "verify_thing", params: {} }]),
    /requires `elseVerdict` naming a declared verdict row/,
  );
});

test("silent declaring `ask` or `elseVerdict` fails construction", async () => {
  const { opts } = makeOpts((a) => {
    a.silent_thing.satisfies!.elseVerdict = "anonymous";
  });
  await assert.rejects(
    () => run(opts, [{ action: "silent_thing", params: {} }]),
    /mode "silent" declares/,
  );
});

test("a path whose root is not a state channel fails construction", async () => {
  const { opts } = makeOpts((a) => {
    a.verify_thing.satisfies!.values = { spokenDigits: "no_such_slot.afm" };
  });
  await assert.rejects(
    () => run(opts, [{ action: "verify_thing", params: {} }]),
    /not a channel of the state schema/,
  );
});

test("a path reading a library-managed slot fails construction", async () => {
  const { opts } = makeOpts((a) => {
    a.verify_thing.satisfies!.values = { spokenDigits: "awaitingInput.params" };
  });
  await assert.rejects(
    () => run(opts, [{ action: "verify_thing", params: {} }]),
    /library-managed slot/,
  );
});

test("a bundle key targeting a JUDGED param fails construction — state cannot impersonate a classification", async () => {
  const { opts } = makeOpts((a) => {
    a.verify_thing.paramsSchema = z.object({
      spokenDigits: digits(),
      pickedKind: judgedEnum(["a", "b"], "which one"),
    });
    a.verify_thing.satisfies!.values = { pickedKind: "carried.afm" };
  });
  await assert.rejects(
    () => run(opts, [{ action: "verify_thing", params: {} }]),
    /not a caller-capture field/,
  );
});

test("satisfies with no values fails construction", async () => {
  const { opts } = makeOpts((a) => {
    a.verify_thing.satisfies!.values = {};
  });
  await assert.rejects(
    () => run(opts, [{ action: "verify_thing", params: {} }]),
    /no values/,
  );
});
