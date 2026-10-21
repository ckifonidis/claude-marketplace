// FILE: src/agent-step/handoff/contract.ts
//
// The handoff CONTRACT: the built-in action's name/schema/description, the
// handback signal vocabulary, the host-facing `HandoffSpec`, and the graph
// edge predicate. Two cooperating halves consume it:
//
//   1. The runner auto-injects the built-in `request_handoff` action into the
//      tool schema when `BuildAgentStepToolOptions.handoff` is provided
//      (controls/request-handoff.ts). The action is the LLM's actuator —
//      detection lives in the host's prompt. It atomically abandons transient
//      runner state and patches the library-managed `handoff` slot; it
//      performs no I/O, so the runner stays pure.
//
//   2. `createHandoffNode` (handoff/node.ts) builds the graph node that
//      RESOLVES the slot — event emission and terminate/delegate I/O live
//      there, wired after the tool node behind the `handoffRequested` edge
//      predicate.

import type { z } from "zod";
import { HandoffRequestSchema, type HandoffRequest, type LibraryManagedSlots } from "../state.js";

/** Reserved action name auto-injected by the runner when
 *  `BuildAgentStepToolOptions.handoff` is provided. Disallowed in
 *  user-defined `config.actions`. */
export const HANDOFF_ACTION = "request_handoff";

/** Conventional node name for the handoff resolver in host graphs. (Not
 *  "handoff" — LangGraph forbids a node named after a state channel, and the
 *  library-managed slot already claims that name.) */
export const HANDOFF_NODE = "resolve_handoff";

/** Base/default params schema for `request_handoff`, and the trusted schema
 * for the handoff state/effect contract. A host may narrow only the model
 * actuator with `HandoffSpec.modelRequestSchema`; internal effects stay here. */
export const handoffParamsSchema = HandoffRequestSchema;

/** Handback signal emitted as `handoff_type` for each handoff reason — the
 *  middleware's canonical (lowercase) vocabulary; its matching is
 *  case-insensitive, but we emit the exact canonical strings. The mapping is
 *  identity and kept as the explicit contract point. */
export const HANDBACK_SIGNALS = {
  off_topic: "off_topic",
  completed: "completed",
  abandon: "abandon",
} as const satisfies Record<HandoffRequest["reason"], string>;

/** LLM-facing mechanics attached to the `request_handoff` schema variant. */
export const HANDOFF_ACTION_DESCRIPTION =
  "Hand the conversation back instead of answering. Reasons: \"off_topic\" — the customer's request is outside this agent's scope (an operation this agent does not perform, a product it does not serve, or an unrelated question beyond a greeting); `context` carries the customer's request for the receiving agent, verbatim or tightly summarized, in the customer's language. \"completed\" — the delegated task is wrapped up; `context` carries the closing line to speak (it may reference what was done), in the customer's language. \"abandon\" — the customer gave up or declined to continue; `context` carries the acknowledgement line to speak, in the customer's language. MUST be the only step in the batch; has no prereqs (works even before any data is loaded). After it succeeds, produce NO answer text — the platform delivers the handoff response.";

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
  /** Abort the connect phase (the thread-creation POST) after this many ms
   *  and fall back to the terminate envelope. Detects an unavailable agent
   *  quickly without stalling the conversation.
   *  Default: see CONNECT_DEFAULT_TIMEOUT_MS in handoff/delegate-client.ts. */
  connectTimeoutMs?: number;
  /** Abort the run + streaming phase after this many ms and fall back to the
   *  terminate envelope. The timer starts only after the connect phase
   *  returns, so a slow thread-creation call never eats the streaming budget.
   *  Default: see DELEGATE_DEFAULT_TIMEOUT_MS in handoff/delegate-client.ts. */
  timeoutMs?: number;
  /** Extra headers for the delegate API (e.g. `x-api-key`). */
  headers?: Record<string, string>;
}

export type HandoffOffTopicSpec = { mode: "terminate" } | HandoffDelegateTarget;

export interface HandoffSpec<T> {
  /** How off-topic handoffs resolve: terminate with the fixed envelope, or
   *  delegate to another LangGraph deployment and pass its answer through. */
  offTopic: HandoffOffTopicSpec;
  /** Override the LLM-facing description attached to the auto-injected
   *  `request_handoff` schema variant. The default
   *  (`HANDOFF_ACTION_DESCRIPTION`) tells the model its `context` is the
   *  closing line that gets SPOKEN for completed/abandon — which is wrong for
   *  a host whose `resolveClosingMessage` overrides every closing from state.
   *  Such hosts must describe `context` truthfully here (e.g. "routing
   *  metadata for the receiving system; the platform composes the spoken
   *  closing"), or the schema contradicts the host prompt. */
  actionDescription?: string;
  /** Optional narrower schema for the MODEL-FACING `request_handoff` params.
   * It is used both to generate the wire schema and to parse that control at
   * runtime, so exact reason/context route pairs can be configuration rather
   * than prompt prose. Its output must still be a `HandoffRequest`.
   *
   * This does not replace `HandoffRequestSchema`: the library-managed state
   * slot and trusted executor/config effects retain the base schema. */
  modelRequestSchema?: z.ZodType<HandoffRequest>;
  /** The fixed envelope content for off_topic terminate mode — also the
   *  fallback when a delegate run fails. This is what the customer
   *  sees/hears. (completed / abandon don't use it: they speak the
   *  LLM-composed closing carried in the request's `context`.) */
  terminateMessage: string;
  /** Override the closing line for completed / abandon signals based on
   *  actual operation outcomes. When provided and returns a non-undefined
   *  string, that string replaces the LLM-composed `request.context` for
   *  those signals. Return `undefined` to fall through to `request.context`.
   *  Never called for `off_topic` (that always uses `terminateMessage`). */
  resolveClosingMessage?: (state: T, request: HandoffRequest) => string | undefined;
  /** Decide the handback SIGNAL from state instead of taking the model's word
   *  for it. Consulted only for a terminate-mode `completed` / `abandon` — never
   *  for `off_topic` (a re-route is not a task ending) and never for a
   *  successful delegate (the conversation never left this agent). Return
   *  `undefined` to fall through to `HANDBACK_SIGNALS[request.reason]`, the same
   *  convention `resolveClosingMessage` uses.
   *
   *  Why it belongs here: hosts were overriding `handoff_type` and
   *  `handoff_metadata.service_type` by mutating the resolved message's
   *  `additional_kwargs` from OUTSIDE — a shape this file documents as a frozen
   *  channel contract — which also left the `handoff` control-plane event
   *  carrying the PRE-override reason. Resolving here keeps the event, the
   *  signal and the metadata consistent by construction.
   *
   *  Toggling needs no extra switch: omit the field to disable it for the host,
   *  or return `undefined` to disable it for one resolution. An env/rollout kill
   *  switch therefore lives in the HOST function — feature flags are host
   *  configuration, and an `enabled` flag here would duplicate `undefined`. */
  resolveHandoffType?: (
    state: T,
    request: HandoffRequest,
  ) => Extract<HandoffRequest["reason"], "completed" | "abandon"> | undefined;
  /** Host-derived fields to merge into `handoff_metadata` on a handback. The
   *  library's own keys (`service_type`, `success_message`) are applied LAST and
   *  cannot be clobbered. Called for EVERY handback type — including
   *  `off_topic`, because identity forwarded to a call-scoped store must survive
   *  a re-route — but never for a successful delegate, which is not a handback.
   *
   *  Exists because the library builds the envelope and closes it, so hosts
   *  reopened it afterwards: four agents in this family carry the identical
   *  `(md as Record<string, unknown>).collected_identity = …` line. */
  resolveHandoffMetadata?: (
    state: T,
    request: HandoffRequest,
  ) => Record<string, unknown> | undefined;
  /** Host DOMAIN slots to null when a task-ENDING handback resolves — i.e.
   *  `completed` / `abandon` in terminate mode. Never applied to `off_topic`
   *  (a topic-change aside must stay resumable: the caller can come straight
   *  back mid-task) nor to a successful delegate (the conversation never left
   *  this agent). That gating is a correctness invariant, not a preference, so
   *  it is not configurable.
   *
   *  Why this exists: channel middlewares reuse ONE thread id for a whole call
   *  and never reset it on re-dispatch, so a terminal outcome slot survives
   *  into the NEXT task on the same thread. A host whose graph derives forced
   *  handbacks/escalations from such a slot then re-fires them on every later
   *  turn — the reply carries a stale closing and the caller is bounced,
   *  turn after turn, with no way out (observed on QA 2026-08-07: an
   *  already-active card activation, then a second activation request in the
   *  same call).
   *
   *  The library-managed task-scoped slots (`agentStepTaskScopedSlots`) are
   *  cleared automatically — list only your OWN slots here.
   *
   *  Each listed slot is written as `null`, so it must be nullable with a
   *  replace-style reducer. A slot whose reducer MERGES (e.g. a record that
   *  accumulates) cannot be cleared this way — leave those out and let the
   *  pointer slot that selects from them carry the reset instead. */
  clearsOnHandback?: readonly Exclude<keyof T & string, "messages">[];
  /** Observe a resolved handback — for a host SIDE EFFECT that must follow the
   *  task's outcome, e.g. recording the contact in a CRM. Called once per
   *  handback (`completed`, `abandon` AND `off_topic` — the host filters), never
   *  for a successful delegate, which is not a handback. It receives the
   *  EFFECTIVE request (after `resolveHandoffType`) and the state as it stood
   *  BEFORE `clearsOnHandback` — the same view the closing was chosen from, so
   *  what the host records cannot disagree with what the caller heard.
   *
   *  An observer, never a resolver: it runs after the reply, the signal and the
   *  metadata are final, and NOTHING it does can change them. The node does not
   *  await it — a returned promise runs on while the reply is delivered — and it
   *  contains a throw or a rejection, so a failing side effect can never break
   *  the handback. The library does not log: report failures inside the hook.
   *
   *  Exists because the outcome is known in one place only — this node — while
   *  the engine-decided endings (an exhausted ladder, the auto-handoff) run no
   *  host executor at all. Without the hook a host can reach those endings only
   *  by wrapping this node, or by smuggling I/O into the pure `resolve*`
   *  functions above. */
  onHandback?: (state: T, request: HandoffRequest) => void | Promise<void>;
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
