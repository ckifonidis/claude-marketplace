---
name: add-kafka-observability
description: Install or upgrade LangSmith-parity Kafka observability in a LangGraph.js / LangChain.js agent repo. Vendors the src/observability/ library (a BaseTracer subclass publishing EVERY traced run — graph, nodes, LLM calls with full prompts/outputs/usage, tool runs — as start/end events to a Kafka topic), adds the @confluentinc/kafka-javascript dependency, wires ONE startup() call at the graph entrypoint (dual global attachment: configure hook + configure-slot wrap, robust to platform harnesses that sever async-context ancestry), updates .env.example and deployment settings (Key Vault refs for secrets), adds a test script, and verifies with typecheck + unit tests. Detects pre-existing Kafka functionality first — a foreign module on src/observability/ or producers elsewhere — and asks the user to classify it (agent-flow observability vs unrelated, e.g. liveness/business events) and decide keep-both vs replace before touching anything; never overwrites a foreign module. Use when a repo must stream its LangSmith telemetry to Kafka, replace/unplug LangSmith, add Kafka observability, or upgrade an already-vendored src/observability/ library.
---

<objective>
Give any LangGraph.js/LangChain.js agent repo a Kafka observability layer with **LangSmith
parity**: everything the application sends to LangSmith (every run create + run end, with
inputs, outputs, errors, latency, trace hierarchy, thread correlation) lands on a Kafka
topic as structured events. LangSmith is untouched — both sinks run in parallel until the
team flips `LANGSMITH_TRACING` off. The library is vendored (a copy in `src/observability/`,
like the agent-step runner), versioned via `VERSION`, and this skill handles BOTH first
install and upgrade.
</objective>

<essential_principles>
**1. The library is vendored and never hand-edited.** Library files are replaced wholesale
from the plugin's `templates/observability/`; project-specific behavior lives at the
project level (wiring, env values, deployment settings). Fixing a project problem by
patching the vendored library is always wrong.

**2. One wiring point.** The tracer attaches through two redundant, name-deduped global
paths — `registerConfigureHook` plus a configure-slot wrap of the repo's own
`CallbackManager._configureSync` (the attachment point LangSmith's tracer occupies; the
hook alone is AsyncLocalStorage-scoped and platform harnesses can sever its ancestry —
see the library README "Attachment"). The ONLY project edit that touches code is a
single `startup()` call at the graph entry module. Never instrument nodes, tools, or the
shared agent-step library, and never wrap the compiled graph (`withConfig`) — the export
shape consumed by `langgraph.json` must stay a `CompiledStateGraph`.

**3. Fire-and-forget is non-negotiable.** Observability must never block, slow, or crash a
conversation: bounded queue, drop-on-full, errors logged not thrown. If a change would
trade this for durability, it needs team sign-off first, not a local patch.

**4. Disabled by default, fail-fast when enabled.** `KAFKA_ENABLED` ships `false`/absent in
`.env.example` and deployment settings unless the user explicitly asks to enable. When it
IS `"true"` (strict lowercase — the hook compares exactly), missing required settings must
throw at boot (no-config-fallback rule).

**5. Secrets take Key Vault references.** In `configuration/**/settings.*.json`, SASL
credentials use `@Microsoft.KeyVault(...)` references, never plaintext. `.env` values are
the developer's local concern; never write real secrets into tracked files.

**6. PII is a conscious decision, not an accident.** The events carry full prompts and
transcripts (that is the point — LangSmith parity). Redaction masks secrets, not PII.
State this in the final report so the data-boundary decision is explicit and on the user.

**7. Gate before editing the project's own files.** Vendoring `src/observability/` is safe
— when the directory is absent, empty, or holds this library (its `VERSION` file
present). A non-empty `src/observability/` WITHOUT a `VERSION` file is a **foreign
module**: overwriting it destroys working code and possibly a live event contract —
never vendor over it, and never assume its purpose from its shape (see the
existing-Kafka guard in intake). Everything else (graph entry wiring, package.json,
.env.example, deployment settings) is the user's code — present the full plan and get
approval before writing.
</essential_principles>

<intake>
Confirm the target repo qualifies: `package.json` depends on `@langchain/core` (directly or
via `@langchain/langgraph`). If not, stop — this library hooks LangChain's callback system
and has nothing to attach to.

**Existing-Kafka guard (before anything else touches the repo).** Two detections, run
always:

- `src/observability/` exists, non-empty, NO `VERSION` file → a **foreign module** owns
  the library's canonical path. It is NOT this library and vendoring would overwrite its
  same-named files and break its call sites.
- Kafka producer usage anywhere else in the repo (`@confluentinc/kafka-javascript`,
  `kafkajs`, `node-rdkafka` imports outside `src/observability/`) → no path collision,
  but the env/topic questions below still apply.

When either fires, STOP and ask the user to **classify the existing functionality —
never infer purpose from code shape** (producer code that looks like telemetry may be
emitting liveness heartbeats, business/audit events, or billing triggers consumed by
alerting and downstream automations the tracer does not replace):

1. **Agent-flow observability** — a predecessor/equivalent of what the tracer emits
   (e.g. the design-027 manual `agent`/`tool_call` emitter this library descends from,
   live in ivr-router-ts). Only for this classification, ask the follow-up: **keep the
   existing events alongside the tracer (coexistence — suggest this default; the events
   are a live downstream contract), or replace them?** Replace requires the user to
   explicitly confirm downstream consumers signed off on losing the legacy event
   families in favor of `"run"` events.
2. **Unrelated Kafka functionality** (liveness, business events, audit, anything else) —
   **preserve untouched; replace is never offered.** Only mechanical questions remain:
   relocation if it occupies `src/observability/` (moved wholesale, call-site imports
   updated), plus the collision review below.
3. **Unsure / mixed** — treat as unrelated (preserve) until the user says otherwise.

In every case, grep which `KAFKA_*` / `APPLICATION_NAME` env keys the existing code
reads and put the overlap in the Step 3 plan explicitly (e.g. "`KAFKA_ENABLED=true`
activates BOTH the existing producer and the tracer — confirm that is intended"), along
with topic sharing (consumers must discriminate by `data.type`) and the extra broker
connection. Execution is `workflows/add-kafka-observability.md` Step 4a, still behind
the Step 3 approval gate; **abort** is always on the table and leaves the repo untouched.

Detect install vs upgrade: if `src/observability/VERSION` exists, this is an **upgrade**
(compare against the plugin template's `VERSION`; if equal, report current and stop).
Otherwise (directory absent or empty, guard resolved) it is a **first install**.

Then gather, asking only for what cannot be derived:
1. **`APPLICATION_NAME`** — propose the snake_cased `package.json` name.
2. **`KAFKA_BOOTSTRAP_SERVERS`** and **`KAFKA_OBSERVABILITY_TOPIC`** — per environment if
   the repo has `configuration/**/settings.*.json` files. Before asking, scan sibling
   repos in the parent directory for an existing install (`src/observability/VERSION`
   present) and propose their `KAFKA_*` values (brokers, topic naming convention, security
   mode, Key Vault secret names) as defaults — agents in one workspace usually share the
   same Kafka estate. Propose, never silently adopt: the user confirms every value.
3. **Security** — none (PLAINTEXT, e.g. local/compose) or SASL (`KAFKA_SECURITY_PROTOCOL`,
   `KAFKA_SASL_MECHANISM`, username, and the Key Vault secret name for the password).
4. **Enable now or ship disabled?** Default: disabled everywhere; flipping QA/PROD to
   `true` is an ops decision.
5. Which deployment settings files to update (default: all under `configuration/`).
</intake>

<routing>
Follow `workflows/add-kafka-observability.md` exactly — detect (incl. existing-Kafka
guard) → plan → approve (gate) → existing-Kafka handling (4a, when the guard fired) →
vendor → wire → configure → verify → report.
</routing>

<quick_reference>
- Library source: `<plugin>/skills/add-kafka-observability/templates/observability/` (+ `VERSION`).
- Upgrade guides: `<plugin>/migrations/<from>-to-<to>.md` (apply in version order).
- Wiring (graph entry module, right after env/dotenv setup, before any invoke path):
  `import { startup as startupObservability } from "./observability/index.js";`
  `startupObservability();`
- Dependency: `@confluentinc/kafka-javascript` (native librdkafka — Docker images need a
  matching prebuild or the source-build toolchain; node-pre-gyp prebuilds cover glibc+musl).
- Test script: `"test:observability": "tsc && node --test dist/observability/*.test.js"`.
- Event contract: envelope `{ id, thread_id, application_name, timestamp, data }`, Kafka
  key = event `id` (the shared ES sink upserts by key — never key by thread_id).
- Env vars: required when enabled — `KAFKA_ENABLED`, `APPLICATION_NAME`,
  `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_OBSERVABILITY_TOPIC`; optional —
  `KAFKA_SECURITY_PROTOCOL`, `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`,
  `KAFKA_SASL_PASSWORD`, `KAFKA_CLIENT_ID`, `KAFKA_PRODUCER_LINGER_MS`,
  `KAFKA_PRODUCER_BATCH_SIZE`, `KAFKA_QUEUE_MAXSIZE`, `KAFKA_PRODUCER_RETRIES`,
  `KAFKA_DELIVERY_TIMEOUT_MS`, `KAFKA_ATTACH_MODE` (`hook`|`patch`|`both`,
  default `both`), `KAFKA_RUN_FILTER_MODE` (`off`|`allow`|`deny`, default `off` —
  every run emitted; root run always survives filtering) +
  `KAFKA_RUN_FILTER_PATTERNS` (`run_type:name` globs, name side also matches
  `metadata.langgraph_node`).
</quick_reference>
