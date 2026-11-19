// FILE: src/agent-step/reply.ts
//
// Required-call mode (`config.tool.toolChoice: "required"`): every model
// invocation makes exactly one call to the agent-step tool, and speech is the
// library-owned `respond_to_caller` control instead of free assistant text.
// This module is the host-facing half of that mode — the per-turn model
// surface, the bind options, delivery of the spoken reply — plus the
// transcript readers the runner shares with it.
//
// HOST WIRING (the whole contract; the graph needs no speech node):
//
//   agent node
//     1. `completedReply(messages)` — when it returns a chunk, return that as
//        the node's message and make NO model call: the reply the model
//        already supplied to the control is delivered exactly once.
//     2. otherwise bind `modelToolsForTurn(tools, messages)` with
//        `modelToolOptions(config)`, invoke with the `langsmith:nostream` tag,
//        and return `toolOnlyMessage(response)`.
//   edges
//     agent → tools while the last message carries a tool call, else END;
//     tools → the handoff node when a handoff was requested, else agent (the
//     pass that lets step 1 deliver the reply).
//
// WHAT THE MODE ASSUMES OF THE HOST. The library checks none of these; most
// violations do not throw — the surface silently stops being narrowed:
//
//   - OPENAI-FORMAT TOOLS. A narrowed surface is emitted through
//     `convertToOpenAITool` as `{ type: "function", function: { …, strict } }`
//     and `modelToolOptions` returns the OpenAI bind options (`tool_choice`,
//     `parallel_tool_calls`). The chat model must accept such definitions in
//     `bindTools` and honour `strict` on the presentation-only surface.
//   - ONE AGENT-STEP TOOL, AND NO OTHER TOOL, bound to the model. The
//     transcript readers take the caller turn's latest ToolMessage to be an
//     agent-step result body, and `toolOnlyMessage` requires exactly one tool
//     call. A second tool could satisfy `tool_choice: "required"` without
//     agent-step, and its ToolMessage would hide the result that owns the
//     turn's continuation.
//   - THE EXACT TOOL OBJECT `buildAgentStepTool` RETURNED. The reply scope
//     (which gates accept reply kinds, which controls are sole steps, what a
//     locked gate offers) is registered against that object's identity. A
//     wrapped, cloned or re-created tool has no scope and comes back without
//     reply-kind scoping, the sole-step split, or the required `turn` field.
//   - GENUINE MESSAGES IN STATE. `messages` holds the thread's real LangChain
//     messages: continuation and spoken bytes are read from the ToolMessages
//     since the latest human message, never from a state slot or caller text.

import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { ENGINE_TEXT, formatMessage } from "./engine-text.js";
import type { StepResult } from "./types.js";
import type { AwaitingInput } from "./state.js";

/** Name of the speech control injected in required mode. A control, not a
 *  domain action: completing it never resolves pending input. */
export const RESPOND_TO_CALLER_ACTION = "respond_to_caller";

type ParamVariant = { properties?: Record<string, unknown>; anyOf?: ParamVariant[]; [key: string]: unknown };
type Variant = { properties?: { action?: { const?: string }; params?: ParamVariant } };
type StepSurface = { properties?: { steps?: { items?: { anyOf?: Variant[] } } } };

// Private construction metadata, never a model-authored or host-maintained
// allow-list. The compiled activation owns which gates can append a recap.
const replyScopes = new WeakMap<object, {
  repeatable: readonly string[];
  lockedActions: Readonly<Record<string, readonly string[]>>;
  exclusiveControls: readonly string[];
}>();
/** Record a built tool's reply scope against its identity. Called once, by
 *  `buildAgentStepTool`; hosts never call it. `actions`: the confirm-gated
 *  actions whose gate accepts reply kinds (`repeatReadBack`). `lockedActions`:
 *  per locking gate, the only actions offered while it is pending.
 *  `exclusiveControls`: the controls that must be a batch's sole step. */
export function registerReplyScope<T extends object>(
  tool: T, actions: readonly string[], lockedActions: Readonly<Record<string, readonly string[]>> = {},
  exclusiveControls: readonly string[] = [],
): T {
  replyScopes.set(tool, { repeatable: actions, lockedActions, exclusiveControls });
  return tool;
}

function textOnlyReply(variant: Variant): Variant {
  const params = variant.properties?.params;
  const plain = params?.anyOf?.find(v => v.properties?.text && !v.properties.kind);
  return plain ? { ...variant, properties: { ...variant.properties, params: plain } } : variant;
}

/** Reply kinds are legal only at an opted-in confirmation. Derive that
 * scope from the latest engine result; never classify the caller's words.
 * Admission still validates the real state if history is stale or missing. */
function scopeReplyKinds<T>(tool: T, result: Record<string, unknown> | undefined): T {
  if (!tool || typeof tool !== "object") return tool;
  const scope = replyScopes.get(tool);
  if (!scope) return tool;
  const cursor = result?.awaiting as { kind?: string; for_action?: string } | undefined;
  const pending = cursor?.kind === "confirmation" ? cursor.for_action
    : result?.needs_confirmation === true ? result.for_action ?? result.action : undefined;
  const canClarify = typeof pending === "string" && scope.repeatable.includes(pending);
  const allowed = typeof pending === "string" ? scope.lockedActions[pending] : undefined;
  const surface = convertToOpenAITool(tool as never);
  const parameters = surface.function.parameters as StepSurface;
  const variants = parameters.properties?.steps?.items?.anyOf;
  if (!variants?.some(v => v.properties?.action?.const === RESPOND_TO_CALLER_ACTION)) return tool;
  const scoped = variants
    .filter(v => !allowed || allowed.includes(v.properties?.action?.const ?? ""))
    .map(v => !canClarify && v.properties?.action?.const === RESPOND_TO_CALLER_ACTION ? textOnlyReply(v) : v);
  const exclusive = scoped.filter(v => scope.exclusiveControls.includes(v.properties?.action?.const ?? ""));
  const batchable = scoped.filter(v => !scope.exclusiveControls.includes(v.properties?.action?.const ?? ""));
  // Admission already rejects a sole-step control in a mixed batch. Expose
  // that SAME declared rule to the model, without changing the execution
  // wrapper: malformed calls still receive the runner's recoverable verdict.
  // Derive mutually exclusive array alternatives from construction metadata,
  // never caller text. Each action's full schema appears exactly once.
  const arrayOf = (members: Variant[], sole = false) => ({
    ...parameters.properties?.steps,
    minItems: 1,
    ...(sole ? { maxItems: 1 } : {}),
    items: members.length === 1 ? members[0] : { anyOf: members },
  });
  const stepSchema = exclusive.length === 0 ? arrayOf(scoped)
    : batchable.length === 0 ? arrayOf(exclusive, true)
    : { anyOf: [arrayOf(batchable), arrayOf(exclusive, true)] };
  // The required-mode `turn` classification (compile/schema.ts) is optional
  // for the wrapper but REQUIRED on this full surface, so every fresh caller
  // turn is classified before any step is chosen.
  const declared = (parameters as { required?: string[] }).required ?? [];
  const required = parameters.properties && "turn" in parameters.properties
    ? ["turn", ...declared.filter(name => name !== "turn")]
    : declared;
  return {
    ...surface,
    function: { ...surface.function, parameters: {
      ...parameters, properties: { ...parameters.properties, steps: stepSchema }, required,
    } },
  } as T;
}

/** The bind options for the host's `bindTools` call: the config's
 *  `toolChoice` (default `"auto"`) and, in BOTH modes, one tool call per model
 *  turn. Multi-step work already rides one call's `steps` batch, and sibling
 *  calls would each read the same state snapshot — a pending confirmation
 *  could then execute twice, which the runner cannot see from inside a call. */
export function modelToolOptions(config: { tool: { toolChoice?: "auto" | "required" } }) {
  return { parallel_tool_calls: false, tool_choice: config.tool.toolChoice ?? "auto" } as const;
}

/** The tool surface for ONE model invocation. Call it on every invocation,
 * with the tools exactly as `buildAgentStepTool` returned them and the full
 * message list; never cache the result across invocations.
 *
 *  - Latest result of this caller turn says `continuation: "await_caller"` →
 *    only a single text-only `respond_to_caller` step, `strict`.
 *  - It names a follow-up `{ action }` → only that action, as a single step.
 *  - Otherwise (a fresh caller turn, or `continue`) → the full surface,
 *    scoped: reply kinds only while a repeatable confirmation is pending, a
 *    locking gate reduced to what it permits, sole-step controls in their own
 *    one-item alternative, `turn` required.
 *
 * The next caller turn restores the full surface, including the human
 * override. Nothing here classifies an utterance or synthesizes a call, and
 * the runner enforces the same boundaries at admission (`refuseContinuation`,
 * the gate lock) for a call that arrives outside this surface. An auto-mode
 * tool — one without the speech control — is returned unchanged. */
export function modelToolsForTurn<T>(tools: T[], messages: readonly unknown[]): T[] {
  const result = latestResult(messages);
  const next = continuationOf(result);
  if (!next || next === "continue") {
    const context = latestResult(messages, true);
    return tools.map(tool => scopeReplyKinds(tool, context));
  }
  const allowed = next === "await_caller" ? RESPOND_TO_CALLER_ACTION : next.action;
  return tools.map((tool) => {
    const surface = convertToOpenAITool(tool as never);
    const parameters = surface.function.parameters as StepSurface;
    let variant = parameters.properties?.steps?.items?.anyOf?.find(
      (v) => v.properties?.action?.const === allowed,
    );
    // Auto-mode hosts have no speech control and retain their old surface.
    if (!variant || !parameters.properties?.steps?.items?.anyOf?.some(
      v => v.properties?.action?.const === RESPOND_TO_CALLER_ACTION,
    )) return tool;
    if (allowed === RESPOND_TO_CALLER_ACTION && variant.properties?.params) {
      // This invocation presents a completed result. Reply kinds classify a
      // fresh caller turn, not this presentation. Keep those variants out of
      // the strict presentation schema. Derive the text field from the
      // control rather than maintaining a second description/schema for it.
      variant = textOnlyReply(variant);
    }
    return {
      ...surface,
      function: {
        ...surface.function,
        // Required chooses the outer tool; strict enforces this turn's
        // speech action. The presentation schema has no optional captures.
        // Arbitrary action params may have optional caller captures. Keep
        // those schemas intact; runtime admission enforces the same boundary.
        ...(allowed === RESPOND_TO_CALLER_ACTION ? { strict: true } : {}),
        // The `turn` classification rides EVERY call, narrowed ones included:
        // the model copies the shape of its own recent calls, and presentation
        // calls without it taught the next fresh turn to omit it (measured
        // 2026-11-19). The engine counts only a caller turn's first call.
        parameters: {
          type: "object", properties: {
            ...(parameters.properties && "turn" in parameters.properties
              ? { turn: (parameters.properties as Record<string, unknown>).turn }
              : {}),
            steps: { type: "array", minItems: 1, maxItems: 1, items: variant },
          },
          required: parameters.properties && "turn" in parameters.properties ? ["turn", "steps"] : ["steps"],
          additionalProperties: false,
        },
      },
    } as T;
  });
}

type Continuation = "continue" | "await_caller" | { action: string };
function continuationOf(result: Record<string, unknown> | undefined): Continuation | undefined {
  const next = result?.continuation;
  if (next === "continue" || next === "await_caller") return next;
  if (next && typeof next === "object" && typeof (next as {action?:unknown}).action === "string") {
    return next as {action:string};
  }
  // Old checkpoints still carry read_back without the explicit contract.
  if (result?.read_back) return "await_caller";
  return undefined;
}

/** The runtime twin of `modelToolsForTurn`'s narrowing, enforced for direct
 * or stale calls: the refusal entry (`continuation_required`) when the batch
 * is not the single step the latest result requires, else undefined. Only
 * genuine ToolMessages since the latest caller message impose a boundary. */
export function refuseContinuation(messages: readonly unknown[], steps: readonly {action:string}[]): StepResult | undefined {
  const next = continuationOf(latestResult(messages));
  if (!next || next === "continue") return undefined;
  const allowed = next === "await_caller" ? RESPOND_TO_CALLER_ACTION : next.action;
  if (steps.length === 1 && steps[0].action === allowed) return undefined;
  return {
    action: steps[0]?.action ?? "(empty)", ok: false,
    error: "continuation_required",
    instruction: next === "await_caller"
      ? ENGINE_TEXT.continuation_await_caller
      : formatMessage(ENGINE_TEXT.continuation_action_required, { action: allowed }),
  };
}

function kind(message: unknown): string {
  const m = message as { getType?: () => string; role?: string; type?: string } | null;
  return m?.getType?.() ?? m?.role ?? m?.type ?? "";
}

/** The `awaiting` record a `respond_to_caller` result carries, so the model
 * still sees what is unanswered after a conversational aside. Public context
 * only — engine gates remain authoritative, and caller text is never read as
 * state.
 *
 *  - A stored gate or ask (`pending`) → its kind and `for_action`; a dictation
 *    adds its `param` and, when the host rendered the ask, those bytes as
 *    `question`.
 *  - Otherwise the UNGATED question a verbatim `await_caller` result posed →
 *    `{ kind: "question", for_action, question }`, carried from reply to reply
 *    until a later domain result supersedes it. This record lives in the
 *    transcript alone: the engine stores nothing for it, so it is re-asked by
 *    speech and `repeat_pending_question` does not serve it. */
export function pendingReplyContext(messages: readonly unknown[], pending?: AwaitingInput | null): Record<string, unknown> | undefined {
  if (pending) return {
    kind: pending.kind, for_action: pending.for_action,
    ...(pending.kind === "dictation" ? {param: pending.param, ...(pending.ask_text ? {question:pending.ask_text} : {})} : {}),
  };
  for (let i=messages.length-1;i>=0;i--) {
    if (kind(messages[i]) !== "tool") continue;
    const content=(messages[i] as {content?:unknown}).content;
    if (typeof content !== "string") return undefined;
    try {
      const entry=JSON.parse(content).results?.at(-1);
      if (entry?.ok === false && entry.error && !entry.verdict &&
          !entry.continuation && !entry.standing_ask && !entry.read_back) continue;
      if (entry?.action === RESPOND_TO_CALLER_ACTION && entry.ok === true) {
        return entry.awaiting?.kind === "question" ? entry.awaiting : undefined;
      }
      if (entry?.continuation === "await_caller" && typeof entry.reply_text === "string") {
        return {kind:"question",for_action:entry.action,question:entry.reply_text};
      }
      return undefined;
    } catch { return undefined; }
  }
  return undefined;
}

/** Only an actual tool reply from this caller turn can supply spoken bytes.
 * No state disclosure, caller-authored JSON, or historical result is eligible. */
function latestResult(messages: readonly unknown[], acrossCaller = false): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const type = kind(messages[i]);
    if ((type === "human" || type === "user") && !acrossCaller) return undefined;
    if (type !== "tool") continue;
    const message = messages[i] as { content?: unknown };
    if (typeof message.content !== "string") return undefined;
    try {
      const body = JSON.parse(message.content);
      const result = Array.isArray(body.results) ? body.results.at(-1) : undefined;
      // A mechanical rejection (same-turn lock, invalid speech, etc.) did not
      // consume the question being presented. A new verdict or fixed question
      // does supersede it. Never walk across the next caller's message.
      if (result?.ok === false && result.error && !result.verdict &&
          !result.read_back && !result.ask_text && !result.standing_ask &&
          !result.continuation) continue;
      // A batch of informational reads may have several required passages.
      // The placeholder presents all of them, in execution order.
      const required = Array.isArray(body.results)
        ? body.results.flatMap((entry:Record<string,unknown>) => typeof entry.reply_text === "string" && entry.reply_text ? [entry.reply_text] : []) : [];
      if (required.length > 0) return {...result,reply_text:required.join(" ")};
      return result;
    } catch { return undefined; }
  }
  return undefined;
}

/** A pending proposal may be presented without another reply classification
 * only when this caller turn already contains its tool-rendered read-back. */
export function hasCurrentReadBack(messages: readonly unknown[], readBack: string): boolean {
  return latestResult(messages)?.read_back === readBack;
}

/** What a `respond_to_caller` text becomes once spoken — the pure formatting
 * seam the control and a host's prompt-input harness share. Placeholders keep
 * engine-rendered consent and digit captures out of model transcription.
 *
 * `{read_back}`, `{ask_text}` and `{reply_text}` are replaced by that field of
 * the current caller turn's latest result. Throws an ENGINE_TEXT instruction
 * (the control returns it as `invalid_reply`) when a placeholder names a field
 * the result lacks, when the result carries fixed bytes the text omits or
 * alters, or when a repeated standing ask is not the whole reply. A literal
 * copy differing only in letter case is restored to the engine's exact bytes. */
export function renderReplyText(text: string, messages: readonly unknown[]): string {
  const result = latestResult(messages);
  let rendered = text.replace(/\{(read_back|ask_text|reply_text)\}/g, (_token, field: string) => {
    const value = result?.[field];
    if (typeof value !== "string" || !value) {
      throw new Error(formatMessage(ENGINE_TEXT.reply_field_unavailable, { field }));
    }
    return value;
  });
  for (const field of ["read_back", "ask_text", "reply_text"]) {
    const required = result?.[field];
    if (typeof required === "string" && required && !rendered.includes(required)) {
      // A literal copy may acquire a sentence-initial capital. Restore the
      // engine's exact bytes; never accept changed words, digits or punctuation.
      const literal = new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
      if (!literal.test(rendered)) {
        throw new Error(formatMessage(ENGINE_TEXT.reply_fixed_text_required, { field }));
      }
      rendered = rendered.replace(literal, () => required);
    }
  }
  if (result?.ask_repeated === true && rendered !== result.read_back) {
    throw new Error(ENGINE_TEXT.read_back_directive_repeat_ask);
  }
  return rendered;
}

/** The spoken reply to deliver, or null when the model must be invoked. Call
 * it first in the agent node and return the chunk as the node's message: the
 * reply is delivered exactly once, with no LLM call to repeat text the model
 * already supplied to the control. Non-null only when the LAST message is the
 * tool result of a completed spoken turn. The message CHUNK is intentional —
 * a streaming channel middleware forwards chunks and may skip consolidated AI
 * messages. */
export function completedReply(messages: readonly unknown[]): AIMessageChunk | null {
  if (kind(messages.at(-1)) !== "tool") return null;
  const result = latestResult(messages);
  // Spoken completions: respond_to_caller, and a note_refusal that declined
  // in place with its own reply (controls/note-refusal.ts).
  const speaks = (result?.action === RESPOND_TO_CALLER_ACTION && result.ok === true) ||
    (result?.action === "note_refusal" && result.refusal_noted === true);
  if (!speaks || result?.turn_complete !== true || typeof result?.summary !== "string") return null;
  return new AIMessageChunk({ content: result.summary, tool_call_chunks: [] });
}

/** The model's response reduced to its tool call: incidental prose beside an
 * operation (especially a handoff) is dropped, ids and usage metadata kept.
 * Invoke the model with the `langsmith:nostream` tag as well, so those bytes
 * cannot leak through token callbacks before this validated message reaches
 * the graph. Throws when the response is not exactly one valid tool call —
 * required mode has no other legal shape; the host owns the retry policy. */
export function toolOnlyMessage(response: AIMessage): AIMessage {
  if (response.tool_calls?.length !== 1 || response.invalid_tool_calls?.length) {
    throw new Error("Required-tool response must contain exactly one valid tool call.");
  }
  return new AIMessage({
    content: "",
    id: response.id,
    tool_calls: response.tool_calls,
    additional_kwargs: response.additional_kwargs,
    response_metadata: response.response_metadata,
    usage_metadata: response.usage_metadata,
  });
}
