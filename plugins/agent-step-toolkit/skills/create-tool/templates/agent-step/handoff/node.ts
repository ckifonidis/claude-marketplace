// FILE: src/agent-step/handoff/node.ts
//
// The graph node that RESOLVES a pending `handoff` slot. The host wires a
// conditional edge after its tool node (`handoffRequested`) into this node,
// with a direct edge to END — the model must never see (and paraphrase) the
// result. The node:
//
//   - emits a `handoff` custom event via `config.writer` (streamMode "custom")
//     BEFORE any response content, so streaming clients can react (abort TTS,
//     switch routing) without parsing message text;
//   - terminate mode: uses the fixed `terminateMessage` envelope;
//   - delegate mode (off_topic): calls the delegate LangGraph deployment with
//     the SAME thread id (handoff/delegate-client.ts), forwards its LLM tokens
//     through the writer as `delegated_token` custom events, and uses its
//     final text; any delegate failure falls back to the terminate envelope
//     (behavioral fallback — not a config fallback);
//   - emits a `handoff_complete` custom event carrying the final text
//     (node-constructed AIMessages never appear in the `messages` token
//     stream, so streaming clients need this to render/speak the reply);
//   - clears task-scoped state on a task-ENDING handback (`completed` /
//     `abandon`): the library's own `agentStepTaskScopedSlots` plus the host's
//     `HandoffSpec.clearsOnHandback` domain slots, because the thread outlives
//     the task (middlewares reuse one thread id per call). `off_topic` and a
//     successful delegate clear nothing — both stay resumable;
//   - calls the host's `onHandback` observer once the handback is final (never
//     for a successful delegate) — not awaited, a throw or rejection contained;
//   - returns `{ handoff: null, ...clears, messages: [AIMessage] }` — the final AIMessage
//     carries the channel-contract `additional_kwargs`: terminate (and
//     delegate-failure fallback) is the HANDBACK (`is_handoff: true`,
//     `handoff_type`, `handoff_reason` = the request's context,
//     `handoff_metadata: { service_type, success_message }` — the middleware
//     routes on it); delegate success is NOT a handoff (the conversation stays
//     with this agent; only an informational `delegated_to` rides along).
//
// THIS FILE IS PART OF THE FROZEN CHANNEL CONTRACT — the custom-event shapes
// and the final-message `additional_kwargs` envelope are read by the voice
// middleware. Do not reshape them without coordinating the middleware repos.

import { AIMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { agentStepTaskScopedSlots, type HandoffRequest, type LibraryManagedSlots } from "../state.js";
import { HANDBACK_SIGNALS, type HandoffSpec } from "./contract.js";
import { delegateThreadId, runDelegate } from "./delegate-client.js";

/** Build the graph node that resolves a pending `handoff` slot. Wire it after
 *  the tool node behind the `handoffRequested` edge predicate, with a direct
 *  edge to END. */
export function createHandoffNode<T extends LibraryManagedSlots>(spec: HandoffSpec<T>) {
  return async (
    state: T,
    config: LangGraphRunnableConfig,
  ): Promise<Record<string, unknown>> => {
    // The pending slot is the ONLY source: the model's `request_handoff`, an
    // executor's `request_handoff` effect, or the runner's auto-handoff — all
    // three arm it before this node runs. The 2.3.0 `forcedHandoff` net
    // ("state is terminal but nothing armed") was REMOVED in 3.0.0: the
    // effects pattern makes that state unreachable — the executor that
    // decides a terminal outcome arms the handoff atomically on the same
    // verdict row — and input-derived terminality (a session doomed from
    // turn 0) belongs to a first-turn probe executor, not a spec-side net.
    const request = state.handoff ?? null;
    if (!request) return {};
    const writer = config.writer as ((chunk: unknown) => void) | undefined;
    const delegate =
      request.reason === "off_topic" && spec.offTopic.mode === "delegate"
        ? spec.offTopic
        : null;

    // The host may decide the SIGNAL from state rather than take the model's
    // word for it (`resolveHandoffType`). Resolve it HERE — before the first
    // control-plane event — so the event, the closing line, `handoff_type` and
    // `handoff_metadata.service_type` all carry one value. Hosts used to do
    // this by mutating the resolved message's kwargs afterwards, which left
    // this event carrying the pre-override reason. Terminate-mode task endings
    // only: an override can swap completed↔abandon, never produce or erase an
    // `off_topic`, so delegate detection and the clearing gate below are
    // unaffected by construction.
    const overridden =
      !delegate && request.reason !== "off_topic"
        ? spec.resolveHandoffType?.(state, request)
        : undefined;
    const effective: HandoffRequest =
      overridden !== undefined && overridden !== request.reason
        ? { ...request, reason: overridden }
        : request;

    // Control-plane signal FIRST — before any response content exists — so a
    // streaming client can abort TTS / reroute immediately.
    writer?.({
      type: "handoff",
      reason: effective.reason,
      mode: delegate ? "delegate" : "terminate",
      ...(delegate ? { delegated_to: delegate.assistantId } : {}),
    });

    // off_topic is a SILENT hand-back: a topic change is an agent-to-agent
    // re-route, never announced to the caller ("don't tell the user about the
    // redirect"). The spoken content is empty; the orchestrator/destination
    // agent owns the caller-facing reply, so the caller still always hears a
    // response — just from the agent that actually serves them, not a "your
    // request concerns another service" line. The `off_topic` `handoff_type` +
    // the caller's verbatim request in `handoff_reason`/`context` are still
    // emitted so the router can route. (delegate mode overrides `content`
    // below; a delegate FAILURE falls back to the spoken terminateMessage.)
    // completed / abandon are genuine endings, NOT redirects — they keep their
    // closing line (resolveClosingMessage override, else the LLM `context`).
    let content =
      effective.reason === "off_topic"
        ? ""
        : (spec.resolveClosingMessage?.(state, effective) ?? effective.context);
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
    // - everything else → the handback: the reason's signal in
    //   `handoff_type` (off_topic re-routes the turn to the orchestrator;
    //   completed / abandon deliver this reply and flip routing for the NEXT
    //   request), `context` in `handoff_reason`, the spoken text in
    //   `handoff_metadata.success_message`.
    const signal = HANDBACK_SIGNALS[effective.reason];
    const kwargs: Record<string, unknown> = delegated
      ? { delegated_to: delegate!.assistantId }
      : {
          is_handoff: true,
          handoff_type: signal,
          handoff_reason: effective.context,
          handoff_metadata: {
            // Host-derived fields first; the library's own keys are applied
            // LAST so a host cannot clobber the contract (`resolveHandoffMetadata`).
            ...(spec.resolveHandoffMetadata?.(state, effective) ?? {}),
            service_type: signal,
            success_message: content,
          },
          ...(delegateError !== null ? { delegate_error: delegateError } : {}),
        };

    // Task-scoped state must not outlive the task. `completed`/`abandon` END
    // the task, but the thread does NOT end with it: channel middlewares reuse
    // one thread id per call and never reset it, so whatever stays in state
    // here is what the NEXT task on this thread starts from. Cleared: the
    // library's own task-scoped slots plus whatever domain slots the host
    // declared. Deliberately NOT cleared on `off_topic` (a mid-task aside must
    // stay resumable) nor after a successful delegate (the conversation never
    // left this agent). Everything the reply needs — the closing line, the
    // signal, any host override reading state — is already computed above.
    const clears: Record<string, null> = {};
    if (!delegated && effective.reason !== "off_topic") {
      for (const slot of agentStepTaskScopedSlots) clears[slot] = null;
      for (const slot of spec.clearsOnHandback ?? []) clears[slot] = null;
    }

    // The host's observer (`onHandback`), once the handback is final. Called
    // synchronously — so whatever it starts inherits this node's run context —
    // but never awaited, and fully contained: neither a throw nor a rejection
    // can reach the reply below.
    if (!delegated && spec.onHandback) {
      try {
        const pending = spec.onHandback(state, effective);
        if (pending && typeof (pending as Promise<void>).catch === "function") {
          (pending as Promise<void>).catch(() => {});
        }
      } catch {
        // Contained by contract: the observer can never break the handback.
      }
    }

    return {
      handoff: null,
      ...clears,
      messages: [new AIMessage({ content, additional_kwargs: kwargs })],
    };
  };
}
