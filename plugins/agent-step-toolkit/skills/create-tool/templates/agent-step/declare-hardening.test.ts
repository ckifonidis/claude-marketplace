// FILE: src/agent-step/declare-hardening.test.ts
//
// The construction-time guarantees added when field kinds became declarable.
// Each test pins a defect that shipped BECAUSE the fact it depends on had no
// machine-readable home:
//
//   - validation ran only in `buildAgentStepTool`, so every test harness that
//     used `runSteps` (i.e. all of them) bypassed every check;
//   - the ask-param check read `.shape` directly, which is `undefined` on a
//     refined schema, and then skipped itself SILENTLY;
//   - an ask could name a judged field, asking the caller to dictate a
//     classification;
//   - a row-less action compiled fine and failed on every call at runtime;
//   - `resultExtras` could overwrite a declared body field, forking the row;
//   - the flow mutex looked only at the batch's FIRST step;
//   - contract prose could route the model to an action that does not exist.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Annotation } from "@langchain/langgraph";
import { agentStepStateSpec } from "./state.js";
import { defineConfig } from "./define-config.js";
import { runSteps } from "./runner.js";
import { callerTextParam, digitGroupsParam, judgedEnum } from "./capture.js";
import type { BuildAgentStepToolOptions } from "./compile/plan.js";
import type { ActionDef } from "./types.js";

// The library slots are all OPTIONAL on `LibraryManagedSlots`, so a host state
// that simply omits them satisfies the constraint — the runner writes them
// through the annotation, and no test here reads one directly.
interface S {
  // One real library slot, concretely typed: TS's weak-type check requires an
  // overlap with `LibraryManagedSlots`, and the rest of the slots stay omitted
  // (they are optional there, and the runner writes them via the annotation).
  errorCount?: number | null;
}

const stateSchema = Annotation.Root({ ...agentStepStateSpec });

const digits = () =>
  digitGroupsParam({ shape: /^\d{4}$/u, message: "not a usable capture", describe: "digits" });

/** A minimal two-action tool: one asker, one capture target. Callers mutate
 *  the returned actions to express the specific defect under test. */
function makeOpts(
  mutate: (actions: Record<string, ActionDef<never, S>>) => void = () => {},
): BuildAgentStepToolOptions<S, string, never, Record<string, (s: S) => unknown>> {
  const actions: Record<string, ActionDef<never, S>> = {
    ask_source: {
      description: "asks for the value",
      paramsSchema: z.object({}),
      prereqs: [],
      verdicts: {
        need_value: {
          ok: false,
          summary: "need it",
          body: { verdict: "need_value" },
          ask: { action: "capture_value" },
        },
      },
    },
    capture_value: {
      description: "receives the value",
      paramsSchema: z.object({
        spokenDigits: digits(),
        pickedKind: judgedEnum(["a", "b"], "which one"),
      }),
      prereqs: [],
      verdicts: { ok: { ok: true, summary: "captured", body: { verdict: "ok" } } },
    },
  };
  mutate(actions);
  return {
    config: defineConfig<string, never>({
      tool: { name: "declare_test_tool", description: "declare hardening tool" },
      actions,
    }),
    stateSchema,
    selectors: { ask_source: (s: S) => s, capture_value: (s: S) => s },
    executors: {
      ask_source: async () => ({ verdict: "need_value" }),
      capture_value: async () => ({ verdict: "ok" }),
    },
    verifiers: {},
  } as unknown as BuildAgentStepToolOptions<S, string, never, Record<string, (s: S) => unknown>>;
}

const run = (opts: unknown, steps: { action: string; params: unknown }[] = []) =>
  runSteps(
    opts as BuildAgentStepToolOptions<S, string, never, Record<string, (s: S) => unknown>>,
    steps.length ? steps : [{ action: "ask_source", params: {} }],
    {} as S,
  );

test("runSteps validates the config — the harness seam no longer bypasses every check", async () => {
  // The very defect this closes: an ask to a param that does not exist used to
  // reach production untouched by any test that went through runSteps.
  const opts = makeOpts((actions) => {
    actions.ask_source.verdicts!.need_value.ask = { action: "capture_value", param: "nonExistent" };
  });
  await assert.rejects(() => run(opts), /names param "nonExistent" which is not declared/);
});

test("the ask-param check sees through a refinement instead of skipping itself", async () => {
  // `.shape` is undefined on the ZodEffects a superRefine produces, so the old
  // check read undefined and treated it as "nothing to verify".
  const opts = makeOpts((actions) => {
    actions.capture_value.paramsSchema = z
      .object({ spokenDigits: digits() })
      .superRefine(() => {});
    actions.ask_source.verdicts!.need_value.ask = { action: "capture_value", param: "typoDigits" };
  });
  await assert.rejects(() => run(opts), /names param "typoDigits" which is not declared/);
});

test("an ask may not target a judged field — you cannot dictate a classification", async () => {
  const opts = makeOpts((actions) => {
    actions.ask_source.verdicts!.need_value.ask = { action: "capture_value", param: "pickedKind" };
  });
  await assert.rejects(() => run(opts), /not a caller-capture field/);
});

test("an ask may omit param only when the target has ONE capture field", async () => {
  // `expects` and `param` are derived, so the failure mode they used to have
  // (a hand-written copy disagreeing with the field) is gone. What remains is
  // ambiguity: two captures and no `param` is not something to guess at.
  const opts = makeOpts((actions) => {
    actions.capture_value.paramsSchema = z.object({
      spokenDigits: digits(),
      spokenName: callerTextParam({
        min: 2,
        max: 20,
        shortMessage: "short",
        longMessage: "long",
        describe: "a name",
      }),
    });
    actions.ask_source.verdicts!.need_value.ask = { action: "capture_value" };
  });
  await assert.rejects(() => run(opts), /omits `param` but "capture_value" declares 2 capture fields/);
});

test("a text capture is a legal ask target and derives its own kind", async () => {
  const opts = makeOpts((actions) => {
    actions.capture_value.paramsSchema = z.object({
      fullName: callerTextParam({
        min: 2,
        max: 20,
        shortMessage: "short",
        longMessage: "long",
        describe: "the name",
      }),
    });
    actions.ask_source.verdicts!.need_value.ask = { action: "capture_value", param: "fullName" };
  });
  const { body } = await run(opts);
  assert.equal(body.results[0].ok, false);
  assert.deepEqual(body.results[0].standing_ask, {
    action: "capture_value",
    param: "fullName",
  });
});

test("an action with no verdict rows cannot compile", async () => {
  const opts = makeOpts((actions) => {
    delete (actions.capture_value as { verdicts?: unknown }).verdicts;
  });
  await assert.rejects(() => run(opts), /declares no verdict rows/);
});

test("resultExtras may not overwrite a field the declared row composed", async () => {
  const opts = makeOpts();
  (opts as { executors: Record<string, unknown> }).executors.ask_source = async () => ({
    verdict: "need_value",
    // `verdict` is already composed by the row — a silent overwrite here is
    // how a result body forks away from its declaration.
    resultExtras: { verdict: "something_else" },
  });
  // Loud, through the same path an undeclared verdict takes: the step fails as
  // `executor_error` rather than shipping a forked body.
  const { body } = await run(opts);
  assert.equal(body.results[0].error, "executor_error");
  assert.match(
    String((body.results[0] as { _debug?: string })._debug),
    /collides with a field the declared row already composed/,
  );
});

test("resultExtras that add NEW fields still append", async () => {
  const opts = makeOpts();
  (opts as { executors: Record<string, unknown> }).executors.ask_source = async () => ({
    verdict: "need_value",
    resultExtras: { dual: true },
  });
  const { body } = await run(opts);
  assert.equal((body.results[0] as { dual?: boolean }).dual, true);
});

test("contract prose may only route to something callable", async () => {
  // Escalation text is engine-owned now, so the host prose that still ROUTES
  // the model is the gate contract's reply categories and the ask contract's.
  // A stale action name there is a construction error: the model would be told
  // to call something that no longer exists, and its call would bounce as
  // `unknown_action` on the very turn the prose exists to smooth over.
  const withCategory = (category: string) => {
    const opts = makeOpts((actions) => {
      actions.capture_value.controller = {
        requiresConfirmation: {
          maxAttempts: 3,
          replyContract: {
            subject: "this question",
            subjectNoun: "question",
            executesLabel: "the thing",
            categories: [category],
          },
        },
      };
    });
    return opts;
  };

  await assert.rejects(
    () => run(withCategory('A no → call "fetch_card_status" instead.')),
    /not a declared action or control/,
  );
  // A real control name passes.
  await assert.doesNotReject(() =>
    run(withCategory('A no → call "abort_pending_input" and start again.')),
  );
  // Wire fields are not actions: written bare or in backticks they are never
  // linted, so the convention stays usable.
  await assert.doesNotReject(() =>
    run(withCategory("A no → make no call; repeat the read_back you already spoke.")),
  );
});

// ─── The caller-capture hard rule, enforced at construction ────────────────
// A value-shape keyword in the model-facing JSON Schema turns a tool verdict
// into a call precondition (measured live 2026-07-31: the model counted the
// digits itself and withheld the call, or padded a digit to satisfy the
// pattern). Through 4.0.0-pre this was guarded only by a per-host test.

test("a JSON-Schema shape keyword in a domain params schema fails construction", async () => {
  const regexOpts = makeOpts((a) => {
    a.capture_value.paramsSchema = z.object({
      spokenDigits: digits(),
      extra: z.string().regex(/^x+$/u),
    });
  });
  await assert.rejects(() => run(regexOpts), /keyword "pattern"/);

  const minOpts = makeOpts((a) => {
    a.capture_value.paramsSchema = z.object({
      spokenDigits: digits(),
      name: z.string().min(2),
    });
  });
  await assert.rejects(() => run(minOpts), /keyword "minLength"/);
});

test("a param NAMED like a keyword is legal — only schema keywords reject", async () => {
  // `properties` keys are property names, not keywords: a param called
  // "format" (or "pattern") must not trip the walk.
  const opts = makeOpts((a) => {
    a.capture_value.paramsSchema = z.object({
      spokenDigits: digits(),
      format: judgedEnum(["a", "b"], "which format"),
    });
  });
  await assert.doesNotReject(() => run(opts));
});

// ─── Config-level invalidations are validated against the state schema ─────

test("invalidations naming a slot with no state channel fails construction", async () => {
  const opts = makeOpts();
  (opts.config as { invalidations?: Record<string, string[]> }).invalidations = {
    pan: ["amount"],
  };
  await assert.rejects(() => run(opts), /not a channel/);
});

test("invalidations naming a library-managed slot fails construction", async () => {
  const opts = makeOpts();
  (opts.config as { invalidations?: Record<string, string[]> }).invalidations = {
    errorCount: ["awaitingInput"],
  };
  await assert.rejects(() => run(opts), /library-managed slot/);
});


// ─── `bounceCapture` ──────────────────────────────────────────
// An action with SEVERAL captures (a digits field and a lettered field for the
// same value, say) used to lose the derived bounce re-ask: the engine will not
// guess which one bounced. `bounceCapture` states it; construction checks it.

const twoCaptures = () =>
  z.object({
    spokenDigits: digits(),
    spokenName: callerTextParam({
      min: 2,
      max: 20,
      shortMessage: "short",
      longMessage: "long",
      describe: "a name",
    }),
  });

test("bounceCapture must name one of the action's own capture fields", async () => {
  const opts = makeOpts((actions) => {
    actions.capture_value.paramsSchema = twoCaptures();
    actions.capture_value.bounceCapture = "pickedKind";
    actions.ask_source.verdicts!.need_value.ask = { action: "capture_value", param: "spokenDigits" };
  });
  await assert.rejects(() => run(opts), /bounceCapture "pickedKind" is not one of its capture fields/);
});

test("bounceCapture is refused on a single-capture action — it is derived there", async () => {
  const opts = makeOpts((actions) => {
    actions.capture_value.bounceCapture = "spokenDigits";
  });
  await assert.rejects(() => run(opts), /single capture field/);
});

test("with bounceCapture, a bounce on a two-capture action records the standing ask", async () => {
  const opts = makeOpts((actions) => {
    actions.capture_value.paramsSchema = twoCaptures();
    actions.capture_value.bounceCapture = "spokenDigits";
    actions.ask_source.verdicts!.need_value.ask = { action: "capture_value", param: "spokenDigits" };
  });
  const { body, committed } = await run(opts, [
    { action: "capture_value", params: { spokenDigits: "12", spokenName: "Ann" } },
  ]);
  assert.equal(body.results[0].error, "invalid_params");
  const awaiting = (committed as { awaitingInput?: Record<string, unknown> }).awaitingInput;
  assert.equal(awaiting?.kind, "dictation");
  assert.equal(awaiting?.for_action, "capture_value");
  assert.equal(awaiting?.param, "spokenDigits");
});
