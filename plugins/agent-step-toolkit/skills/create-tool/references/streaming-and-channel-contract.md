# Reference: Streaming & Channel-Handoff Wire Contract

<overview>
Agents built by this skill assume they sit behind a **channel middleware**: a proxy service
that invokes the agent's LangGraph API (`/threads/{id}/runs/wait`
and `/runs/stream`), forwards reply tokens to the client channel, and detects **handoffs** —
signals that the caller must be transferred to another service/agent. This reference is
double-sided: it is the wire contract a generated agent emits, AND the set of **assumptions
the agent makes about its middleware** — adherence mandates any middleware implementation
must satisfy to integrate one of these agents. Hand the `<middleware_requirements>` checklist
to the middleware developers. It includes the verified facts about how a LangGraph JS agent
streams — several of them break common middleware assumptions, so they are stated as
mandates, not trivia. Every claim here was verified live against a reference middleware
integration and captured SSE streams (2026-06-11), and cross-checked against the middleware
source — handoff processor, kwargs model, stream processor — on 2026-06-12 (the routing
table in `<handoff_contract>` is lifted from it).
</overview>

<wire_input>
## Invoke input (what the agent assumes the middleware sends)

```json
{
  "input": {
    "messages": [{ "type": "human", "content": "…" }],
    "user_id": "1234567",
    "customer_code": "1234567",
    "role": ["retail"],
    "channel": "…"
  },
  "assistant_id": "agent",
  "if_not_exists": "create",
  "config": { "recursion_limit": 25 }
}
```

- Field names are **snake_case** — the bootstrap `state.ts` declares `user_id`,
  `customer_code`, `role`, and `channel` with preserve-initial reducers. Never rename them.
- **Absent fields arrive as `undefined`, not `null`.** Any executor that copies identity
  into a schema-validated structure must coerce: `state.user_id ?? null`. (A live run died
  on exactly this before the guard existed.)
- The agent registers its graph as assistant id `"agent"`; the middleware must invoke that
  assistant id.
</wire_input>

<handoff_contract>
## Channel-handoff contract (what the middleware reads back)

On a handoff turn the **final AI message** must carry:

```json
"additional_kwargs": {
  "handoff_type": "<service_type>",
  "handoff_reason": "<one sentence>",
  "handoff_metadata": { "service_type": "<service_type>", "success_message": "<spoken msg>" },
  "is_handoff": true
}
```

`handoff_reason` is ROUTING METADATA, not prose to display or speak. With the library handoff
(agent-step ≥ 4.0.0) it is the request's `context`: the caller's request for `off_topic`, a short note
or host routing label for `completed` / `abandon`, and a STRUCTURAL CODE for the engine's own endings —
`auto_handoff` (repeated backend failures), `agent-step:escalated` / `agent-step:escalated:<action>`
(bounded patience ran out), `agent-step:malicious` (the misuse attempt that reaches the limit — by default the third — signalled as
`completed`: nothing for a human queue — the channel ends the call). The spoken closing is always
`success_message` / the message `content`, rendered by the host.

`handoff_metadata` may carry **additional host-derived fields** (e.g. an identity the agent verified,
forwarded so a call-scoped store keeps it for the rest of the call). With the library handoff these come
from `HandoffSpec.resolveHandoffMetadata` (agent-step ≥ 2.3.0), which is merged FIRST so the two contract
keys above are applied last and cannot be clobbered. Supply them through that hook — never by mutating
this envelope after the node built it: an outside patch also leaves the `handoff` control-plane event
carrying the pre-override values.

The middleware routes on the handoff type. A handoff fires ONLY when BOTH `is_handoff: true`
AND a non-empty `handoff_type` are present. Type matching is **case-insensitive**; this
contract emits the middleware's canonical lowercase spellings (`completed` / `abandon` /
`off_topic`). The verified routing table (from the middleware's handoff processor):

| Current agent | `handoff_type` | Response from | Routing after |
|---|---|---|---|
| Orchestrator | specialized agent name | target agent (seamless re-send) | that agent |
| Orchestrator | client-side type (e.g. human escalation) | orchestrator (passed through to client) | orchestrator |
| Specialized | `completed` / `abandon` | the specialized agent's own closing reply | orchestrator (next request) |
| Specialized | `off_topic` | the orchestrator (seamless re-send) | orchestrator |
| Specialized | known agent name | target agent (seamless re-send) | that agent |
| Specialized | unknown type | the orchestrator (fallback) | orchestrator |
| any | *(no kwargs)* | the agent itself | unchanged |

Two consumption nuances: the **sync** (`/runs/wait`) path reads only `is_handoff` /
`handoff_type` / `handoff_reason` — `handoff_metadata.success_message` is consumed on the
**streaming** path (and by client-side transfers); the spoken text in sync mode is simply
the message `content` (both mechanisms already set it). The middleware also understands two
OPTIONAL fields: `handoff_metadata.requires_authentication` (bool) and a top-level
`routing_url` — relevant mainly to client-side types. And it gates handoffs middleware-side:
a transfer to an agent that requires an authenticated user is rejected when the session has
no user id (the middleware answers with its own not-allowed message — not the agent's
concern).

Which types exist — and which are client-side vs agent names — is project configuration,
outside this agent's scope: `service_type` values are a shared vocabulary between the
agent's service catalog and the middleware's configuration, agreed with the middleware
developers.

### How a generated agent produces this (three pieces, all scaffolded)

1. **`pendingHandoff` state slot** — in the bootstrap `state.ts` (with the `PendingHandoff`
   interface incl. `successMessage`). Written ONLY by a handoff executor; `null` otherwise.
2. **Handoff executor** (`templates/executor-handoff.ts.template`) — validates the target
   service (env-gated enablement), applies guardrails, writes `pendingHandoff`, and returns
   `resultBody: { verdict: "ok", isHandoff: true, successMessage, … }`. Declare the action
   with `controller: { soleStep: true }` — a handoff never shares a batch.
3. **Post-model hook** (in the bootstrap `agent.ts`) — after the final reply (an AI message
   with no tool calls), if `pendingHandoff` is set AND a tool result in THIS turn contains
   `"isHandoff":true`, it rewrites the reply in place (same message id) adding the
   `additional_kwargs` above. The this-turn guard stops a persisted `pendingHandoff` from
   re-annotating later replies. The `isHandoff: true` field in the executor's resultBody is
   therefore REQUIRED — the hook greps the tool message for it.

The prompt must teach: when a handoff fires (for outbound transfers: only on explicit
request, never for a question the knowledge base answers; for a specialized agent's
handbacks: the role policy in `<agent_roles>` below), `soleStep`, speak the returned
`successMessage` then STOP (no closing question — the channel transfers the caller), and
the recovery for refusal verdicts (`service_disabled`, guardrail verdicts like
`outside_business_hours`).
</handoff_contract>

<agent_roles>
## Agent roles: orchestrator vs specialized

Every generated agent has one of two roles — chosen at bootstrap — and the role determines
its handoff surface and its off-topic policy. The wire mechanics are identical for both (the
`pendingHandoff` slot, the post-model hook, the `additional_kwargs` contract above); only the
service catalog and the prompt policy differ.

**Orchestrator** — conversations normally start here; it owns routing.
- Handoff targets: the specialized agents (agent-name `service_type`s), plus any client-side
  types the channel supports.
- There is NO off-topic concept for an orchestrator *within the agent ecosystem*: any
  in-domain utterance is either handled by the orchestrator itself or handed off to the
  specialized agent that covers it — never refused, and there is no handback signal (it has
  nowhere to hand back to). The orchestrator still holds the overall domain boundary: truly
  out-of-domain content (general knowledge, entertainment, prompt-extraction attempts) gets
  a fixed one-line steer-back refusal that invites the user back to the domain — it does NOT
  end the conversation (the refuse-and-end closer belongs to standalone agents).

**Specialized** — owns one domain; receives the conversation via an orchestrator handoff.
- Its ONLY handoff target is the orchestrator, and every handoff is a *handback* whose
  `handoff_type` carries one of three signals:

| `handoff_type` | Meaning | When |
|---|---|---|
| `completed` | the delegated task is done | after the wrap-up of a successful flow |
| `abandon` | the user gave up or declined to continue | the user bails out of the flow |
| `off_topic` | the utterance is outside this agent's specialty | a substantive topic change the agent won't absorb |

  (These ARE the middleware's canonical spellings — emit them exactly; its matching is
  case-insensitive, but exact-match leaves nothing to chance.)

- **Off-topic policy** (plays in order of preference): (1) **absorb the aside** — answer
  briefly from general knowledge, steer back to the task, keep the conversation; (2)
  **delegate the turn** — route the off-topic utterance to a general/knowledge agent and pass
  its answer through while KEEPING the conversation (the library handoff's delegate mode);
  (3) **signal `off_topic`** — hand the conversation back for re-routing when the user has
  genuinely changed topic.

### Two mechanisms, one kwargs contract

- **Scaffold tool action** (orchestrator outbound routing): a per-tool handoff
  executor writes the scaffold `pendingHandoff` slot; the bootstrap `agent.ts` post-model
  hook stamps the kwargs onto the final LLM reply — the agent SPEAKS the transition
  (token-streamed success message), then the middleware transfers.
- **Library built-in** (specialized agents; agent-step ≥ 1.3.0): opt into
  `buildAgentStepTool({ handoff })` — the runner auto-injects the reserved `request_handoff`
  action (sole-step, no prereqs, lockdown-bypassing) writing the library `handoff` slot; the
  host graph's `createHandoffNode(spec)` resolves it ATOMICALLY (node-built final message, no
  second LLM pass): every non-delegate resolution emits the handback kwargs with the reason's
  signal — `off_topic` is a **SILENT** hand-back (agent-step ≥ 1.6.0): empty spoken content
  (`success_message: ""`), because a topic change is an agent-to-agent re-route the destination
  agent narrates, not this one (a delegate FAILURE speaks the host-rendered
  `delegateFailureMessage(state)`);
  `completed` / `abandon` speak the HOST-RENDERED closing (`HandoffSpec.resolveClosingMessage` —
  required and total since agent-step 4.0.0; the request's `context` is routing metadata and is
  never spoken — for engine-decided endings it is a structural code: `auto_handoff`,
  `agent-step:escalated[:<action>]`, `agent-step:malicious`), and — since agent-step 2.2.0 — also
  CLEAR the task's state as they resolve:
  a middleware reuses ONE thread id for a whole call and never resets it on re-dispatch, so the
  thread outlives the task and the next task on it would otherwise inherit the finished one's
  pending gates and terminal outcome slots (`off_topic` clears nothing — a mid-task aside must
  stay resumable). Middlewares need no change for this; it is stated here because thread reuse is
  the middleware-side fact the behavior depends on — while delegate mode (off_topic only) calls the delegate deployment directly and keeps the
  conversation — its final message is NOT a handoff (no `is_handoff`; informational
  `delegated_to` only). Requires a hand-rolled graph (conditional edge — `createReactAgent`
  can't express it) and clients/middleware streaming `["messages-tuple", "custom"]` for the
  control-plane events (`handoff`, `delegated_token`, `handoff_complete`). See
  `agent-step-api.md` `<handoff>`.

Both mechanisms emit the SAME `additional_kwargs` contract above — signal (or target) in
`handoff_type`, spoken/envelope text in `handoff_metadata.success_message`. The signal names
(`HANDBACK_SIGNALS` in the library: identity over `off_topic` / `completed` / `abandon`) are part of the shared
vocabulary agreed with the middleware developers.
</agent_roles>

<streaming_facts>
## How LangGraph JS streams an agent-step agent (verified)

With `stream_mode: ["messages-tuple", "updates"]`, a handoff turn produces this exact event
order on the wire (captured):

| # | Event | Content |
|---|-------|---------|
| 1 | `messages` chunks | the model streaming the tool call (no user-visible content) |
| 2 | `updates` from `tools` | the tool node's state delta — **includes `pendingHandoff`**, i.e. the earliest possible handoff signal, BEFORE the first spoken token |
| 3 | `messages` chunks | the spoken reply streams token-by-token from node `agent` |
| 4 | `updates` from `post_model_hook` | the annotated final message with the full `is_handoff` kwargs — the `/wait`-identical contract |

Three facts that break common middleware assumptions:

1. **Token chunks serialize as `type: "ai"`** — the same type as a consolidated final AI
   message. A middleware must NOT use the message `type` to tell streamed chunks from final
   messages (e.g. to dedupe); dedupe by message id instead. Filtering out `type == "ai"`
   drops **every** token this agent streams.
2. **The `messages` stream carries ONLY LLM outputs.** Tool messages and node-returned
   state messages never appear there — so `is_handoff` kwargs are **never visible in
   `messages` mode**. Handoff detection MUST read `updates` events. (Verified on the stack of
   the date above. On LangGraph JS 1.3.7 an AI message a NODE returns does appear in
   `messages` events — the required-tool-calling subsection below depends on it, and records
   what was observed. The mandate is unchanged: detect handoffs in `updates`, and dedupe by
   message id.)
3. **The reply node is named `agent`** (createReactAgent) — if the middleware filters
   tokens per node, that filter must include it.

### UX note — what the caller hears before the transfer

The agent **speaks the success message via token streaming** (the LLM reply), THEN the
handoff fires — a spoken transition, usually better for voice channels (no dead air). If a
channel prefers a silent/atomic transfer instead, it can take
`handoff_metadata.success_message` from the kwargs and the prompt can instruct a minimal
spoken reply.

### Required tool calling (agent-step ≥ 4.1.0; streamed spoken answer ≥ 4.2.0) — what the channel observes

An agent whose tool runs with `toolChoice: "required"` (`agent-step-api.md` `<required_mode>`) puts
three kinds of frame on the `messages` stream, all from node `agent`:

| Frame | When | Shape |
|-------|------|-------|
| the tool call | every tool-call invocation of the turn — one per caller turn, two when the first result carries no `continuation` | ONE consolidated AI message: empty content, the tool call, NO `tool_call_chunks` key. No token chunks — the invocation is tagged `langsmith:nostream`, and the agent node drops any prose beside the call |
| a spoken answer (≥ 4.2.0) | the turn's result awaits the caller — a read-back, a question, an ask | a TOKEN STREAM: one empty chunk, the text chunks, then two empty chunks, all under ONE message id and each with a `tool_call_chunks` key (empty). No consolidated copy follows |
| a delivered reply | a turn that only speaks; the presentation of a result with no `continuation`; an in-place decline | ONE message chunk holding the complete text, with a fresh message id and a `tool_call_chunks` key (empty) |

An agent on agent-step 4.1.x — or a 4.2.0 host that does not wire the spoken answer — emits only the
first and the third: every reply arrives whole. This mode runs on a hand-rolled graph with the
library handoff (`resolve_handoff`), not on the `createReactAgent` scaffold, so there is no
`post_model_hook` event.

Observed twice on 2026-11-20, with the same result. In-process: LangGraph JS 1.3.7, `graph.stream`
with modes `messages` / `updates`, the real OpenAI client against a scripted streaming endpoint.
And as raw SSE from a LangGraph dev server (`stream_mode: ["messages-tuple","updates"]`), where
EVERY frame above serializes as `type: "ai"` — so it is the `tool_call_chunks` key, never `type`,
that tells a chunk from a consolidated message. A handoff turn (item 6 below) is observed in-process
only: its `custom` events are still owed to the wire capture in `<testing>`.

A turn whose result awaits the caller (≥ 4.2.0):

| # | Event | Content |
|---|-------|---------|
| 1 | `messages` from node `agent` | the consolidated, empty-content AI message carrying the tool call |
| 2 | `updates` from `agent`, then from `tools` | the tool call, then the tool result |
| 3 | `messages` from node `agent`, many | the spoken answer as token chunks — the first chunk empty, the last two empty |
| 4 | `updates` from `agent` | the complete spoken answer as the node's state delta |

A turn that only speaks, or that presents a result with no `continuation`:

| # | Event | Content |
|---|-------|---------|
| 1 | `messages` from node `agent` | the consolidated, empty-content AI message carrying the tool call |
| 2 | `updates` from `agent`, then from `tools` | the tool call, then the tool result |
| 3 | *(1–2 repeat when a workflow call is followed by the presentation call)* | |
| 4 | `messages` from node `agent` | the reply — ONE message CHUNK holding the complete text, with a fresh message id |
| 5 | `updates` from `agent` | the same reply as the node's state delta |

What this means for a middleware:

1. **Speak non-empty content from node `agent` as it arrives.** One rule covers both replies: a
   token stream is forwarded chunk by chunk, and a whole reply is a stream of one. Do not wait for
   several chunks, a trailing consolidated message, or the end of a stream before speaking — and do
   not take the first non-empty chunk to be the complete reply.
2. **Ignore empty content.** The tool-call messages are empty, and a spoken answer opens with one
   empty chunk and closes with two. Never take the first AI message of a turn to be the reply.
3. **Skipping consolidated AI messages stays safe.** The only consolidated messages are the empty
   tool-call ones; both kinds of reply are chunks. The whole reply is a chunk on purpose.
4. **Dedupe by message id.** A spoken answer's chunks share the model's response id; a delivered
   reply has a freshly generated one. No frame repeats a reply: no consolidated copy follows a token
   stream.
5. **Time to first audio differs by reply.** For a spoken answer it is the tool call plus the first
   tokens of the answer; for a delivered reply it is the full model latency of the turn's calls.
6. **A handoff turn ends at the handoff node.** No model call follows the tool result. On this
   stack the resolver's final message appears in `messages` events as a consolidated AI message
   (with the `is_handoff` kwargs) BESIDE the `handoff_complete` custom event carrying the same
   text — speak it once.
7. **`streamEvents` is not silenced by `langsmith:nostream`.** A consumer of that API receives
   `on_chat_model_stream` events for EVERY model invocation. Those of the tool-call invocation carry
   the `langsmith:nostream` tag (`event.tags`) and must never be spoken — they include prose the
   agent node then drops. Events without the tag are the spoken answer. A delivered reply produces
   no chat-model event at all: read it from the node's output.
</streaming_facts>

<middleware_requirements>
## Middleware adherence checklist

Everything a middleware implementation must do to integrate an agent generated by this skill,
in one place — hand this section to the middleware developers. Items 1–3 cover the sync
(`/runs/wait`) path; items 4–7 are streaming-only.

1. **Invoke shape.** Send `{ messages, user_id, customer_code, role, channel }` (snake_case)
   as the run input, targeting `assistant_id: "agent"`. Identity fields may be omitted for
   anonymous sessions; never rename them.
2. **Handoff detection (sync).** Read `additional_kwargs.is_handoff` / `handoff_type` /
   `handoff_reason` off the final message of the run; trigger only when `is_handoff: true`
   AND `handoff_type` is non-empty. Type matching is case-insensitive.
3. **Routing.** Per the verified table in `<handoff_contract>`: client-side handoff types
   pass through to the client to perform the transfer; known agent names trigger a seamless
   re-send of the turn (with history) to that agent; unknown types fall back to the default
   agent. Keep the `service_type` vocabulary in sync with the agent's service catalog.
3b. **Handback routing.** A `handoff_type` of `completed` / `abandon` / `off_topic` from a
   specialized agent returns conversation ownership to the orchestrator. For `off_topic`,
   re-send the triggering turn (with history) to the orchestrator so the utterance gets
   answered; for `completed` / `abandon`, deliver the agent's closing reply and route
   subsequent turns to the orchestrator.
4. **Stream modes.** Request `stream_mode: ["messages-tuple", "updates"]`. The `is_handoff`
   kwargs are NEVER visible in `messages` events — handoff detection must read `updates`.
5. **Token filter.** Do not use the message `type` to tell streamed chunks from final
   messages — token chunks serialize as `type: "ai"` too, so filtering on it drops every
   token; dedupe by message id instead. If tokens are filtered per node, include node
   `agent`.
6. **Handoff detection (streaming).** Watch `updates` node deltas for
   `messages[].additional_kwargs.is_handoff`.
7. **Trigger point.** Do NOT act on the early `pendingHandoff` signal in the `tools` update —
   cutting the stream there truncates the spoken transition mid-sentence. The
   `post_model_hook` update arrives after the full reply has streamed; that is the correct
   trigger.
8. **Library-handoff agents (agent-step ≥ 1.3.0).** For agents using the library built-in:
   add `"custom"` to the stream modes — the resolver node's final message never appears in
   the token stream; `handoff_complete` carries its text, and delegate-mode reply tokens
   arrive as `delegated_token` events. Detect the handback in the `resolve_handoff` node's
   `updates` delta. And do NOT route on a `delegated_to`-only final message — no
   `is_handoff` means the conversation STAYS with the agent (the delegate answered through
   it).
9. **Required-tool-calling agents (agent-step ≥ 4.1.0).** For agents whose tool runs with
   `toolChoice: "required"`: speak the non-empty content of every message chunk from node `agent`
   as it arrives — whether the reply comes as ONE chunk with no token stream before it or
   (agent-step ≥ 4.2.0) as a token stream bracketed by empty chunks; ignore empty-content frames,
   the tool-call messages included; dedupe by message id; and from an events API speak only
   chat-model stream content that is NOT tagged `langsmith:nostream`. Handoffs are those of item
   8 — and where the resolver's final message also shows up in `messages` events, speak the
   closing once.
</middleware_requirements>

<testing>
## Testing the contract

- **Sandbox layer**: the handoff executor is pure state+env — test verdicts (`ok` with
  `isHandoff:true` + committed `pendingHandoff`, `service_disabled`, guardrail refusals,
  `soleStep` batch refusal) with env vars varied per case.
- **Prompt-input layer**: explicit transfer request → sole `request_handoff` step with the
  right `service`; informational question about the same topic → NOT a handoff. For a
  SPECIALIZED agent, also cover the role policy: a brief off-topic aside → answered inline,
  no handback; a substantive topic change → sole handback step with `signal: "off_topic"`;
  a wrapped-up task → `signal: "completed"`; the user bailing mid-flow → `signal: "abandon"`.
- **Wire layer**: capture a streaming handoff turn from the dev server
  (`POST /threads/{id}/runs/stream`, `stream_mode: ["messages-tuple","updates"]`, save the
  raw SSE) and assert the four-phase event order above — the capture doubles as a golden
  fixture for the middleware team's stream-processor tests.
- The `?? null` identity guard is only exercised when identity is ABSENT from the invoke
  input — include one anonymous-caller case in the sandbox tests.
- **Required tool calling**: at the graph layer, drive the compiled graph with a scripted model
  (a stubbed STREAMING endpoint is enough — no live model) and assert: the turn's requests carry
  `tool_choice` `"required"` then `"none"` when the result awaits the caller; the spoken answer
  reaches the `messages` stream as chunks from node `agent`, exactly once; a delivered reply
  reaches it as one chunk; and the tool-call invocation's incidental prose is nowhere on the
  stream or in state. At the wire layer, capture one turn of each reply shape and one handoff
  turn (`stream_mode: ["messages-tuple","updates","custom"]`) and confirm the event orders in
  `<streaming_facts>` against the middleware's stream processor.
</testing>
