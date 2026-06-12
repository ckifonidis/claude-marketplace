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
integration and captured SSE streams (2026-06-11).
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
  `customer_code`, `role` with preserve-initial reducers. Never rename them.
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

The middleware is expected to route on the handoff type: a **client-side** type (a transfer
the client channel itself performs — e.g. escalating to a human) is passed through to the
client; a **known agent name** triggers a *seamless* handoff (the middleware re-sends the
turn to that agent, with conversation history). Unknown types should fall back to the
middleware's default agent. Which types exist — and which are client-side vs agent names —
is project configuration, outside this agent's scope: `service_type` values are a shared
vocabulary between the agent's service catalog and the middleware's configuration, agreed
with the middleware developers.

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
| `COMPLETED` | the delegated task is done | after the wrap-up of a successful flow |
| `ABANDON` | the user gave up or declined to continue | the user bails out of the flow |
| `OFF_TOPIC` | the utterance is outside this agent's specialty | a substantive topic change the agent won't absorb |

- **Off-topic policy** (plays in order of preference): (1) **absorb the aside** — answer
  briefly from general knowledge, steer back to the task, keep the conversation; (2)
  **delegate the turn** — route the off-topic utterance to a general/knowledge agent and pass
  its answer through while KEEPING the conversation (the library handoff's delegate mode);
  (3) **signal `OFF_TOPIC`** — hand the conversation back for re-routing when the user has
  genuinely changed topic.

### Two mechanisms, one kwargs contract

- **Scaffold tool action** (orchestrator outbound routing; Sofia-style): a per-tool handoff
  executor writes the scaffold `pendingHandoff` slot; the bootstrap `agent.ts` post-model
  hook stamps the kwargs onto the final LLM reply — the agent SPEAKS the transition
  (token-streamed success message), then the middleware transfers.
- **Library built-in** (specialized agents; agent-step ≥ 1.3.0): opt into
  `buildAgentStepTool({ handoff })` — the runner auto-injects the reserved `request_handoff`
  action (sole-step, no prereqs, lockdown-bypassing) writing the library `handoff` slot; the
  host graph's `createHandoffNode(spec)` resolves it ATOMICALLY (node-built final message, no
  second LLM pass): terminate mode emits the OFF_TOPIC handback kwargs with the envelope as
  `success_message`; delegate mode calls the delegate deployment directly and keeps the
  conversation — its final message is NOT a handoff (no `is_handoff`; informational
  `delegated_to` only). Requires a hand-rolled graph (conditional edge — `createReactAgent`
  can't express it) and clients/middleware streaming `["messages-tuple", "custom"]` for the
  control-plane events (`handoff`, `delegated_token`, `handoff_complete`). See
  `agent-step-api.md` `<handoff>`.

Both mechanisms emit the SAME `additional_kwargs` contract above — signal (or target) in
`handoff_type`, spoken/envelope text in `handoff_metadata.success_message`. The signal names
(`HANDBACK_SIGNALS` in the library: `off_topic` → `"OFF_TOPIC"`) are part of the shared
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
   `messages` mode**. Handoff detection MUST read `updates` events.
3. **The reply node is named `agent`** (createReactAgent) — if the middleware filters
   tokens per node, that filter must include it.

### UX note — what the caller hears before the transfer

The agent **speaks the success message via token streaming** (the LLM reply), THEN the
handoff fires — a spoken transition, usually better for voice channels (no dead air). If a
channel prefers a silent/atomic transfer instead, it can take
`handoff_metadata.success_message` from the kwargs and the prompt can instruct a minimal
spoken reply.
</streaming_facts>

<middleware_requirements>
## Middleware adherence checklist

Everything a middleware implementation must do to integrate an agent generated by this skill,
in one place — hand this section to the middleware developers. Items 1–3 cover the sync
(`/runs/wait`) path; items 4–7 are streaming-only.

1. **Invoke shape.** Send `{ messages, user_id, customer_code, role, channel }` (snake_case)
   as the run input, targeting `assistant_id: "agent"`. Identity fields may be omitted for
   anonymous sessions; never rename them.
2. **Handoff detection (sync).** Read `additional_kwargs.is_handoff` plus `handoff_type` /
   `handoff_reason` / `handoff_metadata` off the final message of the run.
3. **Routing.** Client-side handoff types pass through to the client to perform the transfer;
   known agent names trigger a seamless re-send of the turn (with history) to that agent;
   unknown types fall back to the default agent. Keep the `service_type` vocabulary in sync
   with the agent's service catalog.
3b. **Handback routing.** A `handoff_type` of `COMPLETED` / `ABANDON` / `OFF_TOPIC` from a
   specialized agent returns conversation ownership to the orchestrator. For `OFF_TOPIC`,
   re-send the triggering turn (with history) to the orchestrator so the utterance gets
   answered; for `COMPLETED` / `ABANDON`, deliver the agent's closing reply and route
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
</middleware_requirements>

<testing>
## Testing the contract

- **Sandbox layer**: the handoff executor is pure state+env — test verdicts (`ok` with
  `isHandoff:true` + committed `pendingHandoff`, `service_disabled`, guardrail refusals,
  `soleStep` batch refusal) with env vars varied per case.
- **Prompt-input layer**: explicit transfer request → sole `request_handoff` step with the
  right `service`; informational question about the same topic → NOT a handoff. For a
  SPECIALIZED agent, also cover the role policy: a brief off-topic aside → answered inline,
  no handback; a substantive topic change → sole handback step with `signal: "OFF_TOPIC"`;
  a wrapped-up task → `signal: "COMPLETED"`; the user bailing mid-flow → `signal: "ABANDON"`.
- **Wire layer**: capture a streaming handoff turn from the dev server
  (`POST /threads/{id}/runs/stream`, `stream_mode: ["messages-tuple","updates"]`, save the
  raw SSE) and assert the four-phase event order above — the capture doubles as a golden
  fixture for the middleware team's stream-processor tests.
- The `?? null` identity guard is only exercised when identity is ABSENT from the invoke
  input — include one anonymous-caller case in the sandbox tests.
</testing>
