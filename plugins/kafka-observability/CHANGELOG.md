# observability library — CHANGELOG

The version here is the **vendored library** version (`templates/observability/VERSION`),
independent of the plugin version in `.claude-plugin/plugin.json`. Downstream projects
carry a copy of this library in `src/observability/`; `/add-kafka-observability` compares
their `src/observability/VERSION` against the shipped one and upgrades via the
version-keyed guides in `migrations/`.

## 1.4.0 (2026-08-07)

Redaction-precision release, closing a real information-loss bug found by the downstream
timeline-UI team during the 1.3.0 QA verification (thread 019fdaef…, 400+ over-redacted
fields across 20 events): the sensitive-key pattern's `token` substring also matched every
LLM usage counter LangChain emits — `tokenUsage`, `prompt_tokens`, `completion_tokens`,
`input/output_tokens`, the `*_token(s)_details` objects — masking them all to
`***REDACTED***` and making cost/usage analytics impossible from the pipeline.

Two surgical carve-outs in `redaction.ts`; the credential key pattern itself is untouched
(deliberately NOT tightened — an under-match there would leak a real credential):

- **Scalar type guard** — a number, boolean, or null value is never masked, whatever its
  key: only strings can BE a credential and only objects/arrays can contain one. This
  alone un-redacts every numeric counter, including provider-specific ones inside details
  objects (`cached_tokens`, `reasoning_tokens`, `audio_tokens`, camelCase `promptTokens`)
  and future counters not yet on any list. Consequence: `password: null` now passes as
  null (was masked — carried no information either way).
- **Usage-container exemption** — an anchored allowlist
  (`(prompt|completion|input|output|total)_tokens?(_details)?`, `(estimated_)?token_?usage`
  / `tokenUsage`, `usage(_metadata)?`) recurses into these objects instead of masking them
  whole. Deliberately NOT a generic `_tokens?$` suffix rule, which would also exempt
  `access_token`-style credentials. Contents still pass through full redaction — a string
  secret inside a usage object stays masked.

Unchanged, fail-safe: sensitive-keyed strings stay masked; any other sensitive-keyed
object/array is still masked whole (`credentials: {…}` never leaks unmatched inner keys);
`password=` fragment masking in string values unchanged. Streaming `new_token`
`kwargs.token` chunks stay masked (string under key `token`) — redundant rather than
harmful, the full content survives in `outputs`; dropping those entries outright would be
a separate, deliberate behavior change this release does not make.

- **`redaction.test.ts`** — pins both directions: OpenAI/LangChain/Anthropic-shaped usage
  payloads survive verbatim (incl. details objects and camelCase counters) while
  `api_key`, `Authorization`, `access_token`, `refresh_token`, `client_secret`, `token`
  (string), `connection_string`, and whole credential objects stay masked; a string
  secret inside `tokenUsage` is still caught; two pre-1.4.0 pins updated as documented
  behavior changes (numeric under sensitive-substring key, `password: null`).

## 1.3.0 (2026-08-06)

Event-volume release: **opt-in run filtering**. By default the tracer emits a
request/response pair for every traced run (full LangSmith parity — unchanged). Payload
verification in ib-password-reset-agent-ts showed ~73% of a real turn's events carry zero
unique content: LangGraph's `__start__` pseudo-node echoes the root inputs, auto-generated
conditional-edge `RunnableLambda` wrappers carry only the routing decision, and thin
wrapper nodes (`agent`, `tools`) rewrap their single nested llm/tool run's output
byte-identically. A survey of the sibling agents (set-pin, ivr-router, rag-handoff base)
confirmed the wrapper≈child duplication does **not** generalize — several of their nodes
transform outputs or have no nested run at all — so name-based filtering is strictly a
per-app, payload-verified opt-in, never a default.

Additive: no event-schema, transport, or wiring change; two new **optional** env vars.
With filtering off (default) emitted bytes are identical to 1.2.0.

- **`run-filter.ts`** (new) — `RunFilter`: allowlist/denylist over `run_type:name`
  `*`-glob patterns, where the name side matches the run name OR
  `metadata.langgraph_node` (the run_type side prevents `chain:agent` from also dropping
  the nested llm run, which inherits the wrapper's langgraph_node). **The root run always
  survives, in both modes** — it is the sole carrier of the full invocation input/final
  state and the only event without `langgraph_node`, the turn-boundary marker for
  timeline consumers. Filtering drops a run's request+response pair atomically (the
  predicate reads only fields stable across the run's lifetime) and never re-parents:
  surviving events' `parent_run_id`/`dotted_order` may reference dropped runs.
- **`KAFKA_RUN_FILTER_MODE`** / **`KAFKA_RUN_FILTER_PATTERNS`** (new optional env vars) —
  `off` (default) | `allow` | `deny`, plus comma-separated patterns. Fail-fast at startup
  on an invalid mode, a mode without patterns, or patterns while the mode is off
  (no-config-fallback rule). When active, startup logs one greppable line:
  `[observability] run filter active: mode=… patterns=… (root run always emitted)`.
- **`run-tracer.ts`** — `safeEmit` consults the filter (registry-resolved, like the
  emitter; `filter` test seam on `KafkaRunTracerFields`) before `emitter.emitRun`.
  Filtered runs are still traced — children are matched independently, and the thread map
  keeps learning `thread_id` from the always-kept root.
- **`registry.ts`** — holds the once-validated `RunFilter` alongside the emitter (the
  hook/slot construct fresh tracer instances per configure; the filter must be one per
  process).
- **`index.ts`** — reads and validates ALL config (settings, attach mode, filter) before
  any side effect; exports `RunFilter` / `readRunFilterFromEnv`; `__resetForTests()`
  clears the filter.
- **`run-filter.test.ts`** (new) + run-tracer/index test additions — parsing fail-fast
  combinations, glob anchoring/escaping, run_type-guarded langgraph_node matching, the
  root guarantee in both modes, pair-atomic dropping through the real BaseTracer
  entrypoints, and thread inheritance across a filtered parent.
- **`configure-slot.ts`** — housekeeping that rode into `main` via the PR #5 merge
  without a version and ships here: the idempotency/startup `Symbol.for` keys were
  de-branded (`nbg.kafkaObservability.*` → `kafkaObservability.*`). Runtime-internal,
  no contract change; only relevant if two library copies of different versions ever
  share one process (their markers no longer collide — each copy would install its own
  slot wrap, which the name-dedupe still keeps to one tracer per run).

## 1.2.0 (2026-08-05)

Attachment-robustness release, closing the INC-2026-0045 root cause: in QA App Service
(LangGraph Platform image) the tracer **never attached** — `registerConfigureHook` stores
its registry in AsyncLocalStorage (`enterWith` at registration, `getStore()` at configure
time), so a hook registered at graph-module load is invisible to any run whose async
context does not descend from `startup()`. Platform harnesses that create their
run-dispatch channel before importing the graph sever exactly that ancestry; the hook
registers cleanly at boot, then silently never fires (`_getConfigureHooks()` returns `[]`).
The identical image worked in local docker-compose because there the graph import
preceded the server — reproduced mechanically on Node 22 (a server created before the
import never sees the `enterWith` store, even for later connections).

Additive: no event-schema, transport, or wiring change; existing deployments upgrade by
file refresh (see `migrations/1.1.0-to-1.2.0.md`).

- **`configure-slot.ts`** (new) — `installConfigureSlot()` wraps this package's own
  `CallbackManager._configureSync` (the exact attachment point LangSmith's tracer
  occupies — the only ancestry-independent slot) and appends a `KafkaRunTracer` with the
  hook path's exact semantics: `KAFKA_ENABLED === "true"` gate checked at configure time,
  fresh instance per configure, deduped by handler name, inheritable. Idempotent
  (Symbol.for marker), reversible, runtime-only (nothing on disk is patched), confined to
  the library's own `@langchain/core` copy. Falls back to wrapping `configure()` with a
  warning if the underscored static ever disappears.
- **ALS-break detector** — when the hook was registered too (`both` mode) and the slot
  still had to attach, one loud `[observability] ALS context break detected: … (store
  classification)` line fires, distinguishing severed ancestry (`store-undefined`) from a
  clobbered store and from a foreign-core-copy registration — the discriminating evidence
  for the upstream escalation.
- **Boot attachment diagnostics** — startup now logs one greppable line: attach mode,
  pid, resolved `@langchain/core/context` URL (which physical copy), shared-ALS presence,
  hooks visible at boot (registration readback), `NODE_OPTIONS` + `execArgv` (injected
  agent/loader detection); plus a duplicate-library warning when a second `startup()`
  sees a different core URL.
- **`KAFKA_ATTACH_MODE`** (`settings.ts`, new optional env var) — `hook` | `patch` |
  `both` (default `both`: hook + slot, deduped; the slot doubles as the hook's failure
  detector). Invalid values throw at startup (no-config-fallback rule).
- **`index.ts`** — `startup()` wires the chosen attachment path(s) and the diagnostics;
  exports `getAttachDiagnostics()`; `__resetForTests()` also restores the configure slot
  (the hook remains un-unregisterable — unchanged upstream limitation).
- **`configure-slot.test.ts`** (new) — documents the upstream failure (a registered hook
  firing in a descendant context but NOT under `als.run(undefined, …)`), and proves the
  slot attaches under that break, dedupes by name, installs idempotently, stays inert
  unless `KAFKA_ENABLED` is exactly `"true"`, and uninstalls cleanly.

## 1.1.0 (2026-08-04)

Connection-diagnostics release, motivated by a real QA incident: an agent's events never
reached the shared sink, and the logs made the failure undiagnosable — startup printed
"Kafka run tracing ready" **before** any broker/SASL handshake, and a producer that never
connects is otherwise silent (the drain loop no-ops until librdkafka's "ready" event,
`event.error` does not reliably fire against black-holed egress, and the queue-full
warning needs `KAFKA_QUEUE_MAXSIZE` events to trigger). "Connected" and "never connected"
were indistinguishable from application logs.

No behavior changes beyond logging: `produce()`, drain, shutdown semantics, config keys,
and the disabled-by-default contract are untouched. Pure file refresh for consumers —
re-run `/add-kafka-observability` (see `migrations/1.0.0-to-1.1.0.md`).

- **`kafka-producer.ts`** — logs `[observability] Kafka producer connected` when the
  broker handshake actually completes, and arms a one-shot, `unref()`'d connection
  watchdog (default 30 s — 10× the 3 s socket setup timeout, generous for SASL_SSL) that
  warns when the producer has still not connected, including the current in-memory queue
  fill (`queue N/max`). Cleared on "ready" and on `shutdown()`. The threshold is an
  injectable constructor parameter so tests don't wait 30 s.
- **`index.ts`** — the startup line no longer claims readiness:
  "Kafka run tracing ready: …" → "Kafka run tracing initialized (producer connecting in
  background): …" (same app/topic/brokers/retries fields).
- **`kafka-producer.test.ts`** — two new watchdog tests on the existing
  unreachable-broker harness: the not-connected warning fires with the queue fill, and
  `shutdown()` clears the watchdog (no stray warning after a deliberate close).

## 1.0.0 (2026-08-03)

Initial release.

- **`KafkaRunTracer`** (`run-tracer.ts`) — a `BaseTracer` subclass attached globally via
  `registerConfigureHook` (the same mechanism LangSmith's own tracer uses). Captures every
  traced run — graph invocation, each LangGraph node, each LLM call (full rendered
  messages, invocation params, outputs, token usage), each tool run — and emits **two
  events per run**: `direction: "request"` at run creation (inputs) and
  `direction: "response"` at run end (inputs + outputs/error, latency, status). Trace
  hierarchy travels in every event (`trace_id`, `parent_run_id`, `dotted_order`) so the
  full LangSmith-style run tree is reconstructable downstream. `thread_id` is resolved
  from run metadata (LangGraph injects `configurable.thread_id` there), with a
  per-trace fallback map for child runs that carry no metadata.
- **Event envelope** (`schemas.ts`, zod-validated) — the bank-standard
  `{ id, thread_id, application_name, timestamp, data }` shape already consumed by the
  shared Elasticsearch sink. Kafka message key is the event's own `id` (per the
  ivr-router design-027 rev.2 finding: the sink upserts by key, so keying by thread
  collapses a thread's events into one document).
- **Transport** (`kafka-producer.ts`, `bounded-queue.ts`) — `@confluentinc/kafka-javascript`
  (librdkafka) behind a bounded in-memory queue (default 1000) with a 10 ms background
  drain loop. `produce()` never blocks; a full queue drops the event and logs a running
  count. `acks=all`, idempotent producer, bounded `shutdown()` (drain → flush → disconnect,
  every phase raced against a timer — librdkafka's own timeouts do not reliably bound a
  never-connected broker). Ported verbatim from ivr-router-ts design-027 (live-verified).
- **Redaction** (`redaction.ts`) — recursive masking of `authorization` / `api_key` /
  `password` / `token` / `secret` / `credential` / `connection_string` keys and
  `password=` fragments in string values, applied to every payload before serialization.
- **Size cap** — events over 512 KB are replaced by a truncation marker
  (`{ type: "truncated", original_bytes, sha256 }`).
- **Config** (`settings.ts`, `env.ts`) — `KAFKA_ENABLED` gate (must be exactly `"true"` —
  the global callback hook compares strictly); when enabled, `APPLICATION_NAME`,
  `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_OBSERVABILITY_TOPIC` are required and fail fast
  (no-config-fallback rule). Optional: `KAFKA_SECURITY_PROTOCOL`, `KAFKA_SASL_MECHANISM`,
  `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_CLIENT_ID`,
  `KAFKA_PRODUCER_LINGER_MS`, `KAFKA_PRODUCER_BATCH_SIZE`, `KAFKA_QUEUE_MAXSIZE`,
  `KAFKA_PRODUCER_RETRIES`, `KAFKA_DELIVERY_TIMEOUT_MS`.
- Disabled by default: `startup()` is a no-op without `KAFKA_ENABLED=true`; no Kafka env
  var is read or required, and the tracer is never attached.
