/**
 * agent-step handoff
 *
 * Library-coordinated conversation handoff. Two cooperating halves:
 *
 * 1. The runner auto-injects a built-in `request_handoff` action into the tool
 *    schema when `BuildAgentStepToolOptions.handoff` is provided. The action is
 *    the LLM's actuator — detection lives in the host's prompt. Its "executor"
 *    (runner-internal, see runner.ts) only patches the library-managed
 *    `handoff` state slot; it performs no I/O, so the runner stays pure.
 *
 * 2. `createHandoffNode` builds the graph node that RESOLVES the slot. The host
 *    graph wires a conditional edge after its tool node (`handoffRequested`)
 *    into this node, which:
 *      - emits a `handoff` custom event via `config.writer` (streamMode
 *        "custom") BEFORE any response content, so streaming clients can react
 *        (abort TTS, switch routing) without parsing message text;
 *      - terminate mode: uses the fixed `terminateMessage` envelope;
 *      - delegate mode (off_topic): calls the delegate LangGraph deployment
 *        with the SAME thread id, forwards its LLM tokens through the writer
 *        as `delegated_token` custom events, and uses its final text;
 *        any delegate failure falls back to the terminate envelope
 *        (behavioral fallback — not a config fallback);
 *      - emits a `handoff_complete` custom event carrying the final text
 *        (node-constructed AIMessages never appear in the `messages` token
 *        stream, so streaming clients need this to render/speak the reply);
 *      - returns `{ handoff: null, messages: [AIMessage] }` — the final
 *        AIMessage carries the channel-contract `additional_kwargs`:
 *        terminate (and delegate-failure fallback) is the off_topic HANDBACK
 *        (`is_handoff: true`, `handoff_type: "off_topic"`, `handoff_reason` =
 *        the customer's request, `handoff_metadata: { service_type,
 *        success_message }` — the middleware re-routes the turn to the
 *        orchestrator); delegate success is NOT a handoff (the conversation
 *        stays with this agent; only an informational `delegated_to` rides
 *        along). The model never sees the result: the host graph routes this
 *        node straight to END, so there is no paraphrase pass.
 *
 * The delegate client is a minimal fetch/SSE implementation of the LangGraph
 * Platform API (`POST /threads`, `POST /threads/{id}/runs/stream` with
 * `stream_mode: ["messages-tuple"]`) — no SDK dependency. The shared thread id
 * is safe by construction: the delegate is a separate deployment with its own
 * checkpointer (one graph per deployment), so the id is pure correlation.
 */
import { createHash } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { HandoffRequestSchema, type HandoffRequest, type LibraryManagedSlots } from "./state.js";

/** Reserved action name auto-injected by the runner when
 *  `BuildAgentStepToolOptions.handoff` is provided. Disallowed in
 *  user-defined `config.actions`. */
export const HANDOFF_ACTION = "request_handoff";

/** Conventional node name for the handoff resolver in host graphs. (Not
 *  "handoff" — LangGraph forbids a node named after a state channel, and the
 *  library-managed slot already claims that name.) */
export const HANDOFF_NODE = "resolve_handoff";

/** Params the LLM provides to `request_handoff` — the slot schema itself:
 *  the action is a pure slot write. */
export const handoffParamsSchema = HandoffRequestSchema;

/** Handback signal emitted as `handoff_type` for each handoff reason — the
 *  middleware's canonical (lowercase) vocabulary; its matching is
 *  case-insensitive, but we emit the exact canonical strings. The mapping is
 *  identity today and kept as the explicit contract point: `off_topic` is the
 *  only reason; `completed` / `abandon` are the planned extensions. */
export const HANDBACK_SIGNALS = {
  off_topic: "off_topic",
} as const satisfies Record<HandoffRequest["reason"], string>;

/** LLM-facing mechanics attached to the `request_handoff` schema variant. */
export const HANDOFF_ACTION_DESCRIPTION =
  "Hand the conversation off instead of answering. Call with reason \"off_topic\" when the customer's request is outside this agent's scope (an operation this agent does not perform, a product it does not serve, or a non-banking question beyond a greeting). `context` carries the customer's request for the receiving agent — verbatim or tightly summarized, in the customer's language. MUST be the only step in the batch; has no prereqs (works even before any data is loaded). After it succeeds, produce NO answer text — the platform delivers the handoff response.";

/** Delegate target: another LangGraph deployment (one graph per deployment)
 *  reachable over the Platform API. */
export interface HandoffDelegateTarget {
  mode: "delegate";
  /** Base URL of the delegate deployment (e.g. `http://localhost:2025`). */
  url: string;
  /** Assistant id (or graph name) registered on the delegate deployment. */
  assistantId: string;
  /** The delegate graph node that produces the customer-facing reply (its
   *  `langgraph_node` in messages-tuple metadata). When set, ONLY that node's
   *  tokens are forwarded/accumulated — deterministic live pass-through with
   *  intact time-to-first-token (router/structured-output chatter from other
   *  nodes never reaches the client). When omitted, the library falls back to
   *  a last-message heuristic with `delegated_restart` boundary events —
   *  acceptable for text clients, NOT for voice (spoken tokens cannot be
   *  recalled). Discover the node name by streaming one run with
   *  `stream_mode: ["messages-tuple"]` and reading the metadata. */
  replyNode?: string;
  /** Abort the delegate run after this many ms and fall back to the
   *  terminate envelope. Default 60_000. */
  timeoutMs?: number;
  /** Extra headers for the delegate API (e.g. `x-api-key`). */
  headers?: Record<string, string>;
}

export type HandoffOffTopicSpec = { mode: "terminate" } | HandoffDelegateTarget;

export interface HandoffSpec<T> {
  /** How off-topic handoffs resolve: terminate with the fixed envelope, or
   *  delegate to another LangGraph deployment and pass its answer through. */
  offTopic: HandoffOffTopicSpec;
  /** The fixed envelope content for terminate mode — also the fallback when a
   *  delegate run fails. This is what the customer sees/hears. */
  terminateMessage: string;
  /** Build the delegate run's input from host state + the handoff request.
   *  Default: `{ messages: [{ role: "user", content: request.context }] }`.
   *  Use this to forward identity/context the delegate needs (the shared
   *  thread id gives it memory, not history — the first delegated turn knows
   *  only what this input carries). */
  delegateInput?: (state: T, request: HandoffRequest) => Record<string, unknown>;
}

/** Edge predicate for the host graph's conditional edge after its tool node:
 *  `handoffRequested(state) ? HANDOFF_NODE : <model node>`. */
export function handoffRequested(state: LibraryManagedSlots): boolean {
  return state.handoff != null;
}

const DELEGATE_DEFAULT_TIMEOUT_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Platform API requires UUID thread ids. A platform-generated host
 *  thread id IS a UUID and passes through unchanged (shared-id correlation);
 *  any other id (a local CLI thread, a missing-checkpointer fallback) maps to
 *  a UUID derived deterministically from it, so repeated delegations from the
 *  same host thread still land on the same delegate thread. */
function delegateThreadId(hostThreadId: string): string {
  if (UUID_RE.test(hostThreadId)) return hostThreadId;
  const h = createHash("sha1").update(`agent-step-handoff:${hostThreadId}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Extract plain text from a serialized message chunk's `content` (string, or
 *  the array-of-parts form with `{ type: "text", text }` entries). */
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        out += (part as { text: string }).text;
      }
    }
    return out;
  }
  return "";
}

/** Minimal SSE parser over a fetch body. Yields `{ event, data }` per SSE
 *  message; multi-line `data:` fields are joined with newlines per spec. */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buf.match(/\r?\n\r?\n/);
        if (!boundary || boundary.index === undefined) break;
        const raw = buf.slice(0, boundary.index);
        buf = buf.slice(boundary.index + boundary[0].length);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Serialized message chunk as it arrives in a `messages-tuple` SSE event:
 *  `data` is the `[chunk, metadata]` tuple. */
interface SerializedChunk {
  id?: string;
  type?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_chunks?: unknown[];
}

/** True for AI message chunks (the delegate's spoken tokens). Server
 *  serializations vary (`AIMessageChunk` | `ai`); reject the known non-AI
 *  types rather than allowlisting one spelling. */
function isAiChunk(chunk: SerializedChunk): boolean {
  const t = (chunk.type ?? "").toLowerCase();
  if (t.includes("tool") || t.includes("human") || t.includes("system")) return false;
  return true;
}

/** Run the delegate over the Platform API and return its final text. Streams
 *  each AI token through `writer` (as `delegated_token` custom events) as it
 *  arrives. Throws on any HTTP/parse failure — the caller falls back to the
 *  terminate envelope. */
async function runDelegate(
  target: HandoffDelegateTarget,
  threadId: string,
  input: Record<string, unknown>,
  writer: ((chunk: unknown) => void) | undefined,
): Promise<string> {
  const signal = AbortSignal.timeout(target.timeoutMs ?? DELEGATE_DEFAULT_TIMEOUT_MS);
  const headers = { "Content-Type": "application/json", ...(target.headers ?? {}) };
  const base = target.url.replace(/\/+$/, "");

  // Idempotently ensure the shared thread exists on the delegate deployment.
  const threadRes = await fetch(`${base}/threads`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({ thread_id: threadId, if_exists: "do_nothing" }),
  });
  if (!threadRes.ok) {
    throw new Error(`delegate thread create failed: HTTP ${threadRes.status}`);
  }

  const runRes = await fetch(`${base}/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      assistant_id: target.assistantId,
      input,
      stream_mode: ["messages-tuple"],
    }),
  });
  if (!runRes.ok || !runRes.body) {
    throw new Error(`delegate run failed: HTTP ${runRes.status}`);
  }

  // A delegate graph may run SEVERAL LLM calls in one turn (router /
  // structured-output nodes emit tokens before the customer-facing reply).
  // With `replyNode` configured (the production path), only that node's
  // tokens are forwarded/accumulated — the first forwarded token is already
  // the reply, preserving time-to-first-token for voice clients. Without it,
  // fall back to grouping tokens per message (chunk id / emitting node) and
  // keeping the LAST message, emitting `delegated_restart` on each boundary
  // so live consumers discard earlier tokens — fine for text, not for voice.
  let text = "";
  let currentKey: string | null = null;
  for await (const evt of parseSse(runRes.body)) {
    if (evt.event === "error") {
      throw new Error(`delegate stream error: ${evt.data}`);
    }
    // messages-tuple events arrive as `event: messages`.
    if (evt.event !== "messages") continue;
    let data: unknown;
    try {
      data = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (!Array.isArray(data) || data.length === 0) continue;
    const chunk = data[0] as SerializedChunk | null;
    if (!chunk || typeof chunk !== "object" || !isAiChunk(chunk)) continue;
    const token = textContent(chunk.content);
    if (token.length === 0) continue;
    const meta = (data[1] ?? {}) as { langgraph_node?: string };
    if (target.replyNode) {
      if (meta.langgraph_node !== target.replyNode) continue;
    } else {
      const key = chunk.id ?? meta.langgraph_node ?? "m0";
      if (currentKey !== null && key !== currentKey && text.length > 0) {
        text = "";
        writer?.({ type: "delegated_restart" });
      }
      currentKey = key;
    }
    text += token;
    writer?.({ type: "delegated_token", content: token });
  }
  return text;
}

/** Build the graph node that resolves a pending `handoff` slot. Wire it after
 *  the tool node behind the `handoffRequested` edge predicate, with a direct
 *  edge to END — the model must never see (and paraphrase) the result. */
export function createHandoffNode<T extends LibraryManagedSlots>(spec: HandoffSpec<T>) {
  return async (
    state: T,
    config: LangGraphRunnableConfig,
  ): Promise<Record<string, unknown>> => {
    const request = state.handoff;
    if (!request) return {};
    const writer = config.writer as ((chunk: unknown) => void) | undefined;
    const delegate =
      request.reason === "off_topic" && spec.offTopic.mode === "delegate"
        ? spec.offTopic
        : null;

    // Control-plane signal FIRST — before any response content exists — so a
    // streaming client can abort TTS / reroute immediately.
    writer?.({
      type: "handoff",
      reason: request.reason,
      mode: delegate ? "delegate" : "terminate",
      ...(delegate ? { delegated_to: delegate.assistantId } : {}),
    });

    let content = spec.terminateMessage;
    let delegated = false;
    let delegateError: string | null = null;

    if (delegate) {
      try {
        const threadId = delegateThreadId(
          (config.configurable?.thread_id as string | undefined) ?? crypto.randomUUID(),
        );
        const input = spec.delegateInput
          ? spec.delegateInput(state, request)
          : { messages: [{ role: "user", content: request.context }] };
        const text = await runDelegate(delegate, threadId, input, writer);
        if (text.trim().length === 0) {
          throw new Error("delegate returned no message content");
        }
        content = text;
        delegated = true;
      } catch (err) {
        delegateError = err instanceof Error ? err.message : String(err);
        content = spec.terminateMessage;
        writer?.({ type: "handoff_delegate_failed", error: delegateError });
      }
    }

    // Final text for streaming clients — the AIMessage below is node-built,
    // so it never appears in the `messages` token stream. (Control-plane
    // events keep the resolution-mode vocabulary: terminate | delegated.)
    writer?.({
      type: "handoff_complete",
      handoff_type: delegated ? "delegated" : "terminate",
      content,
    });

    // Final-message contract (what the channel middleware reads):
    // - delegate success → the conversation STAYS with this agent (the
    //   delegate answered through us) — NOT a handoff; `delegated_to` is
    //   informational only, so middleware routing is untouched.
    // - terminate / delegate-failure fallback → the off_topic handback:
    //   signal in `handoff_type`, the customer's request in `handoff_reason`
    //   (for re-routing), the spoken envelope in
    //   `handoff_metadata.success_message`.
    const signal = HANDBACK_SIGNALS[request.reason];
    const kwargs: Record<string, unknown> = delegated
      ? { delegated_to: delegate!.assistantId }
      : {
          is_handoff: true,
          handoff_type: signal,
          handoff_reason: request.context,
          handoff_metadata: { service_type: signal, success_message: content },
          ...(delegateError !== null ? { delegate_error: delegateError } : {}),
        };

    return {
      handoff: null,
      messages: [new AIMessage({ content, additional_kwargs: kwargs })],
    };
  };
}

