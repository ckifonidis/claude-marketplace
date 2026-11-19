// FILE: src/agent-step/compile/schema.ts
//
// The model-facing input schema: `{ steps: Step[] }`, a discriminated union
// over the compiled domain actions (in config order) followed by the active
// controls (in registry order). Each variant carries its full LLM-facing
// mechanics via `.describe()` — the composed tool description never repeats
// them (compile/describe.ts).
//
// THIS OUTPUT IS EMPIRICALLY TUNED MODEL SURFACE. Variant order, descriptions,
// and the absence of value-shape keywords are all measured-brittle; changes
// here must re-verify against the host's model-surface golden and prompt-input
// layer.

import { z } from "zod";
import type { LibraryManagedSlots } from "../state.js";
import type { CompiledPlan } from "./plan.js";
import { MISUSE_DEFINITION } from "../controls/note-refusal.js";

// The required-mode turn classification (owner 2026-11-19). Asked FIRST on
// every call, so misuse is judged on its own, before and apart from the step
// choice — at a consent gate the latest result frames the steps as consent
// options, and an optional `note_refusal` step lost to that framing 5/5.
// Exported from index.ts: these are the wire names a host harness scripts.

/** The argument, beside `steps`, that carries the classification. */
export const TURN_FIELD = "turn";
/** The caller turn is an attempt to misuse the call: the runner records it as
 *  a `malicious_intent` note in place of whatever steps came with it. */
export const TURN_MISUSE = "misuse";
/** Every other caller turn: the steps run as sent. */
export const TURN_SERVICE = "service";

export function buildStepSchema<T extends LibraryManagedSlots>(plan: CompiledPlan<T>) {
  const stepVariants = plan.actionOrder.map((name) => {
    const action = plan.actions[name];
    return z
      .object({ action: z.literal(name), params: action.effectiveSchema })
      .describe(action.description);
  });
  for (const control of plan.controls) {
    stepVariants.push(
      control.schemaVariant(plan.activation) as (typeof stepVariants)[number],
    );
  }
  const StepSchema =
    stepVariants.length === 1
      ? stepVariants[0]
      : z.discriminatedUnion(
          "action",
          stepVariants as [
            (typeof stepVariants)[number],
            ...(typeof stepVariants)[number][],
          ],
        );
  // NOTE: no `.min(1)` — `minItems` is not permitted under OpenAI strict
  // structured outputs. An empty batch is handled gracefully by the run
  // pipeline (the step loops are length-guarded and simply produce no
  // results).
  if (!plan.activation.toolRepliesEnabled) return z.object({ steps: z.array(StepSchema) });
  return z.object({
    [TURN_FIELD]: z
      .enum([TURN_SERVICE, TURN_MISUSE])
      .describe(
        `Classify the caller's latest turn BEFORE choosing steps. "${TURN_MISUSE}": ${MISUSE_DEFINITION} ` +
          `"${TURN_SERVICE}": everything else. When "${TURN_MISUSE}", the system records it in place of your steps and tells you how to reply.`,
      )
      // Optional for the WRAPPER; reply.ts marks it required on every
      // model-facing surface (the model copies the shape of its recent calls).
      .optional(),
    // NOT nonempty for the WRAPPER (QA 2026-11-19): a turn marked misuse may
    // legitimately carry no steps — the runner substitutes the note — and a
    // schema rejection before the runner looped a QA thread into the
    // recursion limit. An empty non-misuse batch is refused by admission
    // (`empty_batch`, instructive). reply.ts keeps minItems on the model's
    // surface as guidance.
    steps: z.array(StepSchema),
  });
}
