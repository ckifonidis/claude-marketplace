// FILE: src/agent-step/runner.ts
//
// The public entry points, and NOTHING else — the machinery lives in the
// phase modules:
//
//   compile/  validate → normalize → model-facing schema + description
//   run/      admit → plan → execute → finalize
//
// One tool invocation = one batch of steps:
//
//   admission (run/admission.ts)  — whole-batch preconditions, fixed order
//   planning  (run/planning.ts)   — confirm modes frozen at batch start
//                                   (the same-batch bypass safety property)
//   execution (run/execution.ts)  — sequential steps: controls, gates,
//                                   prereqs, params, executors, effects
//   finalize  (run/finalize.ts)   — result body + error-counter policy
//
// Patches from earlier successful steps land in `committed` even when a later
// step fails (cumulative commit on partial failure) — see run/batch-state.ts.
//
// `buildAgentStepTool` validates + compiles ONCE and closes over the plan;
// `runSteps` compiles per call (it is the direct test seam and accepts
// hand-built minimal options without construction-time validation, exactly so
// tests can drive sparse configs).

import { tool } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";
import type { Selector } from "./types.js";
import type { LibraryManagedSlots } from "./state.js";
import {
  compilePlan,
  type BuildAgentStepToolOptions,
  type CompiledPlan,
} from "./compile/plan.js";
import { validateConfig } from "./compile/validate.js";
import { buildStepSchema, TURN_FIELD, TURN_MISUSE } from "./compile/schema.js";
import { composeToolDescription } from "./compile/describe.js";
import { resolveCallerTurnId } from "./interaction/turn-identity.js";
import { createBatchState } from "./run/batch-state.js";
import { admitBatch } from "./run/admission.js";
import { expandPlan, type UserStep } from "./run/planning.js";
import { executeSteps } from "./run/execution.js";
import { finalizeRun, type RunResult } from "./run/finalize.js";
import { refuseContinuation, registerReplyScope } from "./reply.js";
import { EXCLUSIVITY_GROUPS } from "./controls/registry.js";
import { NOTE_REFUSAL_ACTION } from "./controls/note-refusal.js";

export type { BuildAgentStepToolOptions } from "./compile/plan.js";
export type { RunResult } from "./run/finalize.js";
export type { StateSchemaLike } from "./compile/state-schema.js";
export { REPEAT_PENDING_QUESTION_ACTION } from "./controls/registry.js";

/** Run one batch against an explicit initial state, with a pre-compiled plan.
 *  The tool binding compiles once and calls this; `runSteps` compiles per
 *  call. */
async function runCompiled<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  userSteps: UserStep[],
  initialState: T,
): Promise<RunResult<T>> {
  const st = createBatchState<T>(initialState, plan.merge);
  // Bounded-choice locks AND the confirmation gate's same-turn protection key
  // on the caller-turn identity; hosts using neither never have the hook (or
  // the message scan) consulted.
  const currentCallerTurnId = plan.needsCallerTurnId
    ? resolveCallerTurnId(initialState, plan.getCallerTurnId)
    : undefined;

  const messages = (initialState as { messages?: unknown[] }).messages ?? [];
  const continuationRefusal = plan.activation.toolRepliesEnabled
    ? refuseContinuation(messages, userSteps) : undefined;
  const refusal = admitBatch(plan, userSteps, st.view, currentCallerTurnId)
    ?? (continuationRefusal ? {entry: continuationRefusal} : null);
  if (refusal) {
    // Admission refusals are engine directives — instruction register.
    return {
      body: {
        instruction: refusal.entry.instruction as string,
        results: [refusal.entry],
        failed_at: 0,
      },
      committed: st.committed,
    };
  }

  const planned = expandPlan(plan, userSteps, st.view, currentCallerTurnId);
  const exec = await executeSteps(plan, planned, st, currentCallerTurnId, messages);
  return finalizeRun(plan, exec, st, initialState);
}

/** Pure execution of a declared batch given an explicit initial state — the
 *  public test seam and the entry point for non-LangChain consumers.
 *  Tool-binding wraps this with the LangGraph state-input read and the
 *  Command emission. */
export async function runSteps<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
>(
  opts: BuildAgentStepToolOptions<T, ActionName, PrereqName, Selectors>,
  userSteps: { action: string; params: unknown }[],
  initialState: T,
): Promise<RunResult<T>> {
  validateOnce(opts);
  return runCompiled(compilePlan(opts), userSteps, initialState);
}

/** Configs already validated in this process. `runSteps` is the seam every
 *  test harness uses, and it used to skip `validateConfig` entirely — so a
 *  mistake the validator exists to catch (an ask to a param that is not a caller
 *  capture, a row-site ask on a terminal row, a missing state channel) surfaced only
 *  when the real tool was built, i.e. at `npm run dev` rather than in the
 *  suite that exercises the wiring. Validation is idempotent and pure, so
 *  running it once per opts identity costs nothing on the hot path. */
const VALIDATED = new WeakSet<object>();

function validateOnce(opts: object): void {
  if (VALIDATED.has(opts)) return;
  validateConfig(opts as never);
  VALIDATED.add(opts);
}

/** True when no tool result follows the latest caller message — i.e. this is
 *  the first agent-step call of the current caller turn. */
function isFirstCallOfCallerTurn(state: unknown): boolean {
  const messages = ((state as { messages?: unknown[] } | null)?.messages ?? []) as Array<{
    _getType?: () => string;
    type?: string;
  }>;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const kind = messages[i]?._getType?.() ?? messages[i]?.type;
    if (kind === "tool") return false;
    if (kind === "human") return true;
  }
  return true;
}

/** Public entry point. Validates the wiring at construction time, compiles the
 *  plan and the model-facing schema/description from it, and returns a
 *  LangChain tool whose invocation reads state from LangGraph via
 *  `getCurrentTaskInput`, runs the batch, and emits a `Command` carrying the
 *  cumulative state patch plus one `ToolMessage` with the JSON-stringified
 *  result body. */
export function buildAgentStepTool<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
>(opts: BuildAgentStepToolOptions<T, ActionName, PrereqName, Selectors>) {
  validateOnce(opts);
  const plan = compilePlan(opts);
  const InputSchema = buildStepSchema(plan);
  // The tool is bound with the JSON-SCHEMA rendering of the input schema, not
  // the Zod object. Two deliberate consequences:
  //   1. The provider-visible surface is IDENTICAL — `convertToOpenAITool`
  //      emits exactly this object either way (golden-pinned by the host).
  //   2. Wrapper validation is SHAPE-ONLY (@cfworker/json-schema): the Zod
  //      REFINEMENTS carrying caller-capture rules do not run at the wrapper,
  //      so a malformed capture (e.g. a bad card tail) reaches the
  //      runner's per-action parse and returns the voice-safe
  //      `invalid_params` envelope the prompt contract licenses — instead of
  //      dying at the LangChain layer as an English ToolInputParsingException
  //      the model was never instructed about. The runner re-parses every
  //      step's params with the full Zod schema regardless (run/execution.ts),
  //      so nothing is validated less — only later, by the right authority.
  // The cast keeps zod-to-json-schema's non-portable node types out of this
  // function's public signature.
  const wireSchema = toJsonSchema(InputSchema) as Record<string, unknown>;

  // A conservative gate surface derived from the same declared capabilities
  // as admission. Keep legal abort followers in the union: a batch may clear
  // the gate and re-select. An unrestricted abort leaves the surface broad.
  const lockedActions: Record<string, readonly string[]> = {};
  const followers = plan.activation.abortPolicy?.allowedFollowers;
  if (followers != null) {
    // note_refusal is NOT offered at a locked gate: misuse there arrives
    // through the required `turn` field (admission admits that substituted
    // malicious_intent note), and offering the control let the model file
    // ordinary gate replies as unsupported_question, which the gate refuses.
    const gateControls = plan.controls.filter(c => c.allowedDuringGateLockdown).map(c => c.name);
    for (const name of plan.actionOrder) {
      if (plan.actions[name].confirmation?.lockdown) {
        lockedActions[name] = [...new Set([name, ...gateControls, ...followers])];
      }
    }
  }

  return registerReplyScope(tool(
    async (
      input: unknown,
      runtime: { toolCall?: { id?: string } } = {},
    ): Promise<Command> => {
      const toolCallId = runtime.toolCall?.id ?? "";
      const rawSteps = Array.isArray((input as { steps?: unknown }).steps)
        ? ((input as { steps: Array<{ action?: unknown; params?: unknown }> }).steps)
        : [];
      let userSteps: UserStep[] = rawSteps.map((s) => ({
        action: typeof s.action === "string" ? s.action : "",
        params: s.params ?? {},
      }));

      // Snapshot from LangGraph rather than threading the model's view of
      // state. Plan expansion reads pending from this snapshot; this is the
      // same-batch bypass safety net (see run/planning.ts).
      const initialState = getCurrentTaskInput<T>() as T;

      // Required-mode turn classification (compile/schema.ts): a turn the
      // model marks as misuse is recorded through the existing
      // `malicious_intent` path IN PLACE of its steps — counter, decline
      // instruction and termination unchanged. Only the FIRST call of a caller
      // turn classifies; a follow-up call in the same turn never counts the
      // same utterance twice.
      if (
        plan.activation.toolRepliesEnabled &&
        (input as { [TURN_FIELD]?: unknown })[TURN_FIELD] === TURN_MISUSE &&
        isFirstCallOfCallerTurn(initialState)
      ) {
        userSteps = [{ action: NOTE_REFUSAL_ACTION, params: { kind: "malicious_intent" } }];
      }
      const { body, committed } = await runCompiled(plan, userSteps, initialState);

      // The `Command.update` carries two things: the cumulative state patch
      // accumulated across successful steps, AND exactly one ToolMessage tied
      // to this tool call id. The state annotation's `messages` reducer
      // appends; we never merge intermediate ToolMessages from individual
      // steps because there's only one tool call from LangGraph's POV.
      //
      // `_debug` never reaches the model: raw Zod issues and executor throw
      // text are stripped from the serialized content and carried on the
      // ToolMessage's `artifact` instead (trace-visible, model-invisible). A
      // refinement message carrying a number measurably re-leaks the
      // digit-count pathology when it rides the content, so the strip is the
      // library's barrier, not a host convention. `runSteps` (the test seam)
      // still returns the body WITH `_debug`.
      const debug: string[] = [];
      const wireResults = body.results.map((entry) => {
        if (entry._debug === undefined) return entry;
        const { _debug, ...rest } = entry;
        debug.push(String(_debug));
        return rest;
      });
      const update: Record<string, unknown> = { ...committed };
      update.messages = [
        new ToolMessage({
          content: JSON.stringify({ ...body, results: wireResults }),
          tool_call_id: toolCallId,
          ...(debug.length > 0 ? { artifact: { debug } } : {}),
        }),
      ];
      return new Command({ update });
    },
    {
      name: plan.toolName,
      description: composeToolDescription(plan),
      schema: wireSchema,
    },
  ), plan.activation.repeatableConfirmationActions, lockedActions,
    EXCLUSIVITY_GROUPS.flatMap(group => group.memberNames).filter(name => plan.controlNames.has(name)));
}
