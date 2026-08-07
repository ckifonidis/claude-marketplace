# Kafka Run Observability (LangSmith parity)

Fire-and-forget Kafka observability for every traced LangChain/LangGraph run in this
process. Disabled by default. Vendored from the `kafka-observability` plugin
(`claude-marketplace`) — version in `VERSION`; upgrade with `/add-kafka-observability`.
Do not hand-edit library files; project-specific behavior belongs at the project level.

## What it captures

Everything the application would send to LangSmith. `KafkaRunTracer` extends the same
`BaseTracer` base class as LangSmith's own tracer and is attached globally through two
redundant paths (see **Attachment** below) — every run (graph invocation, LangGraph
node, LLM call with full rendered messages + outputs + token usage, tool run) produces:

- one `direction: "request"` event at run start (inputs, serialized constructor info),
- one `direction: "response"` event at run end (inputs + outputs/error, status, latency,
  streaming-token event timestamps).

Apps that have verified which of their runs carry duplicated content can opt into
emitting fewer events — see **Run filtering** (default: off, everything emits).

Trace hierarchy (`trace_id`, `parent_run_id`, `dotted_order`) travels in every event, so
the LangSmith-style run tree is reconstructable downstream. `thread_id` comes from run
metadata (LangGraph injects `configurable.thread_id`); events outside a thread use
`"no-thread"`.

```
graph/node/LLM/tool run (via BaseTracer hooks)
       │ onRunCreate ──► request event      │ onRunUpdate ──► response event
       ▼
RunEventEmitter (event-emitter.ts)
       ├── project Run → event data (child_runs dropped; each run emits its own)
       ├── validate (zod), redact sensitive fields
       ├── serialize, truncate if >512 KB ({original_bytes, sha256} marker)
       └── produce (key = event.id — the ES sink upserts by key; design-027 rev.2)
       ▼
KafkaEventProducer (kafka-producer.ts)
       └── bounded queue → 10ms background drain loop → librdkafka
```

## Environment variables

### Required to enable

| Variable | Description |
|----------|-------------|
| `KAFKA_ENABLED` | Exactly `true` to activate (strict — the global hook compares `=== "true"`). Defaults off; every other var below is ignored when disabled. |
| `APPLICATION_NAME` | Service identifier (e.g. `ib_password_reset_agent`). |
| `KAFKA_BOOTSTRAP_SERVERS` | Broker address(es) (e.g. `kafka:29092`). |
| `KAFKA_OBSERVABILITY_TOPIC` | Topic name (e.g. `observability-events`). |

### Optional

| Variable | Description |
|----------|-------------|
| `KAFKA_SECURITY_PROTOCOL` | e.g. `SASL_SSL`, `PLAINTEXT` |
| `KAFKA_SASL_MECHANISM` | e.g. `PLAIN`, `SCRAM-SHA-256` |
| `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` | SASL credentials (Key Vault in deployment settings) |
| `KAFKA_CLIENT_ID` | Producer client ID |
| `KAFKA_PRODUCER_LINGER_MS` / `KAFKA_PRODUCER_BATCH_SIZE` | Batching |
| `KAFKA_QUEUE_MAXSIZE` | In-memory queue capacity (default: 1000) |
| `KAFKA_PRODUCER_RETRIES` | Producer retry count (default: 5) |
| `KAFKA_DELIVERY_TIMEOUT_MS` | Per-message delivery timeout in ms (default: 30000) |
| `KAFKA_ATTACH_MODE` | Tracer attachment path: `hook` \| `patch` \| `both` (default: `both` — see **Attachment**). Invalid values throw at startup. |
| `KAFKA_RUN_FILTER_MODE` | Opt-in run filtering: `off` \| `allow` \| `deny` (default: `off` — every run emitted, full LangSmith parity; see **Run filtering**). Invalid values or inconsistent combinations throw at startup. |
| `KAFKA_RUN_FILTER_PATTERNS` | Comma-separated `run_type:name` globs (required when the mode is `allow`/`deny`, forbidden when `off`), e.g. `llm:*,tool:*,chain:resolve_handoff`. |

## Event schema

```json
{
  "id": "uuid-v4 (Kafka message key)",
  "thread_id": "conversation-correlation-id",
  "application_name": "ib_password_reset_agent",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "data": {
    "type": "run",
    "direction": "request | response",
    "run_id": "...", "trace_id": "...", "parent_run_id": "...", "dotted_order": "...",
    "run_type": "chain | llm | tool | ...",
    "name": "agent | AzureChatOpenAI | password_reset_agent_step | ...",
    "inputs": { "...": "always present" },
    "outputs": { "...": "response only" },
    "error": "response only, when failed",
    "status": "success | error (response only)",
    "events": [{ "name": "new_token", "time": "...", "kwargs": { "token": "..." } }],
    "metadata": { "thread_id": "...", "langgraph_node": "...", "...": "..." },
    "start_time": "...", "end_time": "...", "latency_ms": 123.4
  }
}
```

## Run filtering (opt-in — default emits every run)

By default the tracer emits a request/response pair for **every** traced run — full
LangSmith parity, and the contract every downstream consumer was built against. Real
traces show much of that volume is duplicated content: a LangGraph `agent` node's output
is often byte-identical to its nested `llm` run's, a `tools` node's to its nested `tool`
run's, and the `__start__` pseudo-node echoes the root run's inputs (verified
field-by-field against raw payloads in ib-password-reset-agent-ts — 16 of a turn's 22
events carried zero unique content there).

An app team that has **verified this against its own payloads** can opt in:

```
KAFKA_RUN_FILTER_MODE=off | allow | deny        (default off)
KAFKA_RUN_FILTER_PATTERNS=<run_type>:<name>[,…]
```

- A pattern is two `*`-globs: the left side matches `run_type` (`chain`, `llm`, `tool`,
  …); the right side matches the run **name** OR `metadata.langgraph_node`. Both must
  match. The `run_type` side is what keeps `chain:agent` from also dropping the nested
  `llm` run, which inherits the wrapping node's `langgraph_node` value.
- `deny` drops matching runs (both events); `allow` drops everything that does not match.
- **The root run always survives, in both modes.** It is the sole carrier of the full
  invocation input/final state and the only event without `metadata.langgraph_node` —
  the turn-boundary marker for timeline consumers.
- Config is validated fail-fast at startup: an invalid mode, a mode without patterns, or
  patterns without a mode all throw (no-config-fallback rule). When active, startup logs
  `[observability] run filter active: mode=… patterns=…`.

Recipes:

- **Framework pseudo-nodes only** — safe by construction in any LangGraph app
  (`__start__`-style nodes never transform state):
  `KAFKA_RUN_FILTER_MODE=deny`, `KAFKA_RUN_FILTER_PATTERNS=chain:__*`
- **Keep only content-bearing runs** — root + LLM + tool runs + verified terminal nodes:
  `KAFKA_RUN_FILTER_MODE=allow`, `KAFKA_RUN_FILTER_PATTERNS=llm:*,tool:*,chain:resolve_handoff`

**What filtering is NOT safe for, unverified.** App-named wrapper nodes (`agent`,
`tools`, …) are droppable only when they delegate to exactly one nested run and return
its output verbatim — a property of *this app's* node code, not of the names. Survey of
sibling agents found the opposite in most: nodes that merge parallel tool calls or strip
content before returning (so the node output ≠ the nested llm run), and nodes with **no
nested run at all** (KB-driven envelope builders, escalation writers, nodes doing
untraced I/O in the node body) — for those the node run is the only record of the work.
Verify per node against real payloads before adding it to a pattern, and re-verify when
node code changes. Note also that filtering never re-parents events: surviving events'
`parent_run_id`/`dotted_order` may reference dropped runs, so tree-walking consumers
(none known today — the timeline UI groups by `thread_id` + `langgraph_node`) would see
gaps.

## Attachment (and why there are two paths)

`@langchain/core`'s `registerConfigureHook` — the mechanism offered for globally
attaching tracers — stores its registry **inside AsyncLocalStorage** (`enterWith` at
registration; `getStore()` at configure time). A hook registered at graph-module load is
therefore visible only to runs whose async context descends from that `startup()` call.
Platform harnesses that create their run-dispatch channel *before* importing the graph
(observed on LangGraph Platform under Azure App Service — INC-2026-0045) sever that
ancestry: the hook registers cleanly at boot and then never fires, silently.

So the library attaches through two redundant, name-deduped paths (`KAFKA_ATTACH_MODE`):

1. **`hook`** — `registerConfigureHook`. The upstream mechanism; works whenever run
   contexts descend from startup().
2. **`patch`** — the *configure slot*: a wrap of this package's own
   `CallbackManager._configureSync`, the exact attachment point LangSmith's tracer
   occupies. Independent of async ancestry. Only this copy of `@langchain/core` is
   touched, at runtime; nothing on disk is patched.
3. **`both`** (default) — register the hook AND install the slot. Dedupe by handler name
   makes them cooperative; the slot then doubles as a failure detector for the hook.

Diagnostics (all one-line, greppable):

- At startup: `[observability] attachment diagnostics: mode=… pid=… core=<resolved
  @langchain/core URL> als=present|MISSING hooks_visible_at_boot=N node_options=…
  exec_argv=…` — answers which core copy registered, whether the shared ALS exists,
  whether the registration is boot-visible, and whether the runtime injected
  loader/agent flags.
- First time the slot must attach although the hook was registered:
  `[observability] ALS context break detected: … (store-undefined | store clobbered |
  foreign core copy …)` — events still flow (the slot attached), but the runtime severs
  async-context ancestry; the classification is the evidence to escalate with.
- A second `startup()` from a different core copy logs a duplicate-library warning.

## Reliability

- **Bounded queue** (default 1000, `KAFKA_QUEUE_MAXSIZE`) drained by a single background
  loop; `produce()` is always synchronous and non-blocking — a run is never slowed down.
- **Drop policy**: a full queue drops the new event immediately and logs a running
  dropped-event count. Never backpressures the caller.
- **Delivery**: `acks=all`, idempotent producer, explicit retries (default 5) and
  `delivery.timeout.ms` (default 30000).
- **Graceful shutdown**: `await shutdown()` drains the queue, flushes librdkafka's
  buffer, then disconnects — each phase bounded by a timeout race (librdkafka's own
  flush/disconnect timeouts do NOT reliably bound a never-connected broker).
- **Connection visibility**: startup logs "Kafka run tracing initialized (producer
  connecting in background)" — the handshake happens asynchronously after it. When the
  broker handshake completes, the producer logs `[observability] Kafka producer
  connected`; if it still hasn't after 30 s (10× the socket setup timeout, generous for
  SASL_SSL), a one-shot watchdog warns that events are accumulating in memory, with the
  current queue fill. Without it a never-connected producer is silent: the drain loop
  no-ops until "ready" and the queue-full warning needs `KAFKA_QUEUE_MAXSIZE` events.
- **Fire-and-forget**: validation/redaction/transport errors are logged, never thrown
  into the run. **Known gap**: no replay — sustained broker unavailability or queue
  saturation loses events (accepted tradeoff for never blocking the caller).
- **Redaction**: `authorization`/`api_key`/`password`/`token`/`secret`/`credential`/
  `connection_string` keys (case-insensitive substring match) and `password=` fragments
  are masked in every payload. Two carve-outs keep the substring match from destroying
  usage analytics: values that cannot carry a secret (numbers, booleans, null) pass
  verbatim whatever their key, and the known LLM usage containers (`tokenUsage`,
  `token_usage`, `usage_metadata`, `prompt/completion/input/output/total_tokens?` +
  `_details` variants) recurse normally instead of being masked whole — their contents
  still pass through full redaction, so a string secret inside stays masked. A
  sensitive-keyed string or any OTHER sensitive-keyed object/array is masked whole
  (`credentials: {…}` never leaks unmatched inner keys). NOTE: redaction masks secrets,
  not PII — full prompts/transcripts (incl. `telephone_number`) flow to the topic by
  design, same data-boundary decision as self-hosted LangSmith.

## LangSmith migration

The tracer runs ALONGSIDE LangSmith — both are callback handlers. Validation sequence:
enable `KAFKA_ENABLED=true` with `LANGSMITH_TRACING=true`, compare sinks, then unset the
`LANGSMITH_*` vars. Not replicated from LangSmith: artifacts created inside LangSmith
itself (feedback, annotations, datasets/experiments) and the UI — the downstream
consumer (e.g. Elasticsearch/Kibana over the topic) owns viewing.
