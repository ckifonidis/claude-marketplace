# claude-marketplace

A personal [Claude Code](https://claude.com/claude-code) plugin marketplace.

## Add this marketplace

```
/plugin marketplace add ckifonidis/claude-marketplace
```

(or with the full URL: `/plugin marketplace add https://github.com/ckifonidis/claude-marketplace`)

## Plugins

### agent-step-toolkit

Tools for building **agent-step** LangGraph agents (ReAct agents fronted by a single
batching tool + deterministic flow-controller runner).

Install:

```
/plugin install agent-step-toolkit@ckifonidis-marketplace
```

Ships four skills:

- **`create-tool`** — bootstrap a new agent-step project (package.json, tsconfig,
  langgraph config, the agent-step runner **library**, graph/agent/state/prompt
  skeleton, streaming CLI, Dockerfile, build script), add a domain tool to an
  existing one (actions, executors, verifiers, `controller` lifecycle hooks,
  `invalidatesOnChange` cascades, state slots, prompt sections), **or port an
  existing project** onto agent-step (reading the source as a domain spec only).
  Covers read-tool patterns (native paginated reads via `pageable`) and the
  data-analysis pattern (an analyze action running LLM-authored snippets over
  fetched data). Every project carries a root `sandbox/` service — a local mock of
  the tools' backend APIs (lifecycle CRUD at `/sandbox`, `Sandbox-Id` header
  isolation, JSON seeding for tests) acquired best-effort from a reference project,
  a Postman collection, or specs (`references/sandbox-contract.md`). The runner
  library and the config/scaffold templates travel with the skill under
  `skills/create-tool/templates/`.
- **`test-agent-step`** — the three-layer testing methodology for an agent-step
  action: runner unit tests (flow-controller mechanics, no backend/LLM), sandbox/tool
  tests (runner + executors against a local sandbox, no LLM), and prompt-input tests
  (the LLM emits the right steps, no execution).
- **`pull-library`** — consumer side of library versioning: run inside a downstream
  project to upgrade its vendored `src/agent-step/` to the toolkit's version and apply
  the migration transforms to the project's own tools. (The maintainer side,
  `bump-version`, lives in this repo at `.claude/skills/` — it edits the plugin's
  source tree, so it isn't shipped.)
- **`audit-middleware-contract-compliance`** — audit a channel middleware
  implementation (the proxy that invokes a generated agent's LangGraph API, forwards
  reply tokens to the channel, and routes handoffs) against the wire contract in
  `streaming-and-channel-contract.md`. Walks the adherence checklist — invoke shape,
  sync + streaming handoff detection, routing/handback table, stream modes, token
  dedupe, trigger point, library-handoff custom events — into an evidence-backed
  findings report (file:line per item, never fixes), with an optional wire-level pass
  against a captured SSE stream. The agent side is correct by construction
  (`create-tool` scaffolds it, `test-agent-step` tests it); this grades the
  hand-written consumer of the wire.

The embedded runner library (`skills/create-tool/templates/agent-step/`) is the
**canonical, versioned source** — its `VERSION` marker travels into every
bootstrapped project at `src/agent-step/VERSION`. `CHANGELOG.md` tracks the library;
`PLUGIN_CHANGELOG.md` tracks the plugin package itself.

### langgraph-plugin

Run and debug **any** LangGraph.js conversation against the local dev server. Graph-agnostic:
it discovers the registered graph and your state fields rather than assuming a fixed schema.

Install:

```
/plugin install langgraph-plugin@ckifonidis-marketplace
```

Ships two skills:

- **`run-langgraph-conversation`** — execute a single- or multi-turn test conversation against
  the local dev server (find the running instance that serves the project on any port, discover
  the `graph_id`, create a thread, run each turn with `/runs/wait`, reuse the `thread_id`),
  surface the replies + any decision/handoff signals, optionally capture a turn's raw SSE stream
  (token/handoff/custom event order), then hand off the captured `thread_id` to the analysis skill.
- **`follow-langgraph-conversation`** — investigate a thread end-to-end: locate the instance that
  OWNS the thread, inventory the available monitoring sources, then dev-server thread state,
  runs, and full checkpoint history (state progression), plus LangSmith traces (LLM prompts /
  responses / token usage; EU/self-hosted endpoints supported) when tracing was on for the thread
  — ending in a state-progression table and root-cause analysis.

### kafka-observability

LangSmith-parity observability over Kafka for **any** LangGraph.js / LangChain.js agent —
built so LangSmith can eventually be unplugged without losing telemetry.

Install:

```
/plugin install kafka-observability@ckifonidis-marketplace
```

Ships one skill:

- **`add-kafka-observability`** — install OR upgrade a vendored `src/observability/`
  library in the current repo. The library attaches a `BaseTracer` subclass globally
  through two redundant paths — the configure hook plus the configure-slot LangSmith's
  own tracer occupies, so it attaches even on platform runtimes that sever async-context
  ancestry (one `startup()` call at the graph entrypoint, zero per-node
  instrumentation) — and publishes **every** traced run — graph
  invocation, each LangGraph node, each LLM call (full rendered prompts, outputs, token
  usage), each tool run, errors — as start/end events to a Kafka topic:
  bank-standard envelope (`id` as Kafka key, `thread_id` correlation), zod-validated,
  secret-redacted, 512 KB-truncated, over a bounded non-blocking fire-and-forget producer
  (librdkafka, `acks=all`, idempotent, bounded shutdown). Disabled by default
  (`KAFKA_ENABLED`); runs alongside LangSmith for parallel validation. Apps that have
  payload-verified which runs duplicate root/LLM/tool content can opt into run filtering
  (`KAFKA_RUN_FILTER_MODE` allow/deny + `run_type:name` globs; the root run always
  survives) — default stays emit-everything. Repos with pre-existing Kafka
  functionality are safe: the skill detects a foreign `src/observability/` module or
  producers elsewhere, asks the user to classify them (agent-flow observability →
  keep-both/replace; unrelated, e.g. liveness or business events → always preserved),
  and never vendors over a foreign module. The skill also
  wires the dependency, `.env.example`, deployment settings (Key Vault refs for SASL
  secrets), a `test:observability` script, and verifies with typecheck + the library's
  unit suite.

The embedded library (`skills/add-kafka-observability/templates/observability/`) is the
canonical, versioned source — its `VERSION` travels into every target project at
`src/observability/VERSION`; `CHANGELOG.md` tracks it, `migrations/` carries upgrade
guides.

## Layout

```
.claude-plugin/marketplace.json     # marketplace manifest (lists plugins)
.claude/skills/                      # repo-maintainer skills (not shipped)
├── bump-version/                    # absorb a newer agent-step runner into the toolkit's embedded library
└── publish-release/                 # cut a plugin release — staleness sweep, version sync, changelog, release commit
plugins/
├── agent-step-toolkit/
│   ├── .claude-plugin/plugin.json   # plugin manifest
│   ├── CHANGELOG.md                 # agent-step runner library version history
│   ├── PLUGIN_CHANGELOG.md          # plugin package version history
│   ├── migrations/                  # per-version migration guides (written by bump-version, applied by pull-library)
│   └── skills/
│       ├── create-tool/             # bootstrap / add-tool / extend / port + workflows + references + templates (incl. the canonical agent-step library)
│       ├── test-agent-step/         # three-layer testing methodology
│       ├── pull-library/            # upgrade a downstream project's vendored library (consumer side)
│       └── audit-middleware-contract-compliance/  # audit a channel middleware against the wire/streaming/handoff contract
├── langgraph-plugin/
│   ├── .claude-plugin/plugin.json   # plugin manifest
│   └── skills/
│       ├── run-langgraph-conversation/      # execute a test conversation, capture thread_id
│       └── follow-langgraph-conversation/   # investigate a thread (dev server + LangSmith) → root cause
└── kafka-observability/
    ├── .claude-plugin/plugin.json   # plugin manifest
    ├── CHANGELOG.md                 # observability library version history
    ├── migrations/                  # per-version upgrade guides
    └── skills/
        └── add-kafka-observability/ # install/upgrade the vendored library + wiring (templates incl. the canonical observability library)
```
