# kafka-observability plugin changelog

Version history for the **plugin package** (`.claude-plugin/plugin.json` + the marketplace entry) —
the skills, templates, references, and workflows the plugin ships.

This is distinct from [`CHANGELOG.md`](CHANGELOG.md), which tracks only the **vendored observability
library** version (`skills/add-kafka-observability/templates/observability/VERSION`, bumped by
`/bump-version`). A plugin release may or may not include a library bump.

Format follows [Keep a Changelog](https://keepachangelog.com/); newest first. Semver on the plugin:
**major** = removed/renamed skill or breaking workflow change, **minor** = new skill / capability /
template, **patch** = doc or fix with no new surface.

## [0.4.0] — 2026-08-06

Ships observability library **1.3.0**. Downstream projects upgrade via
`/add-kafka-observability` (applies `migrations/1.2.0-to-1.3.0.md`: one idempotent
`.env.example` transform, no wiring change; with filtering off — the default — emitted
bytes are identical to 1.2.0).

### Added
- **Library 1.3.0 — opt-in run filtering**: `KAFKA_RUN_FILTER_MODE` (`off` default |
  `allow` | `deny`) + `KAFKA_RUN_FILTER_PATTERNS` (`run_type:name` `*`-globs; the name
  side also matches `metadata.langgraph_node`, the run_type side keeps `chain:agent`
  from dropping the nested llm run). The root run always survives filtering, in both
  modes — it carries the full invocation input/final state and is the only event without
  `langgraph_node` (the turn-boundary marker for timeline consumers). Motivated by
  payload verification in ib-password-reset-agent-ts (~73% of a real turn's events were
  byte-duplicates of root/llm/tool content); a cross-repo survey of sibling agents
  confirmed the duplication does NOT generalize, so filtering is a per-app,
  payload-verified opt-in — never a default. Fail-fast validation of every inconsistent
  env combination; one greppable startup line when active.

### Changed
- Library 1.3.0 also carries the configure-slot `Symbol.for` de-branding
  (`nbg.kafkaObservability.*` → `kafkaObservability.*`) that rode into `main` via the
  PR #5 merge without a version (runtime-internal, no contract change).
- Skill workflow `.env.example` block gains the commented `KAFKA_RUN_FILTER_*` lines;
  vendored-file count corrected 22 → 24; plugin/marketplace/root-README descriptions now
  mention the opt-in filter.

### Fixed
- `tracked-assets-observability.md` (bump-version reference) Tier 1 inventory: added
  `run-filter.ts` and `run-filter.test.ts`.

## [0.3.0] — 2026-08-05

Ships observability library **1.2.0**. Because 0.2.0 shipped 1.0.0, this release also
carries the library's 1.1.0 connection diagnostics. Downstream projects upgrade via
`/add-kafka-observability` (applies `migrations/1.0.0-to-1.1.0.md` then
`1.1.0-to-1.2.0.md` in order; one idempotent `.env.example` transform, no wiring change).

### Added
- **Library 1.2.0 — ancestry-proof attachment** (INC-2026-0045 root cause): upstream's
  `registerConfigureHook` stores its registry in AsyncLocalStorage, so a hook registered
  at graph-module load never fires for runs whose async context does not descend from
  `startup()` (LangGraph Platform on Azure App Service severs exactly that ancestry —
  hook registered at boot, zero tracer events). The library now also attaches via a
  configure-slot wrap of its own `CallbackManager._configureSync` (the
  ancestry-independent slot LangSmith's tracer occupies), deduped by handler name; new
  optional `KAFKA_ATTACH_MODE` env var (`hook` | `patch` | `both`, default `both`);
  one-line boot attachment diagnostics (core copy URL, ALS presence, boot-visible hooks,
  `NODE_OPTIONS`/`execArgv`); an `ALS context break detected` warning with store
  classification; a duplicate-library sentinel. New library files: `configure-slot.ts`,
  `configure-slot.test.ts` (vendored set now 22 files).
- **Library 1.1.0 — connection diagnostics** (committed after 0.2.0, first shipped
  here): `Kafka producer connected` log on real handshake completion, a one-shot 30 s
  never-connected watchdog with queue fill, startup line reworded from "ready" to
  "initialized (producer connecting in background)".

### Changed
- `add-kafka-observability` SKILL + workflow + library README describe the dual
  attachment; the workflow's `.env.example` block gains the commented `KAFKA_ATTACH_MODE`
  line; vendored-directory file count 20 → 22; plugin + marketplace descriptions
  refreshed accordingly.

### Fixed
- Staleness sweep: root `README.md` attachment wording updated; the repo-level
  `bump-version` tracked-assets inventory gains the two new library files.

## [0.2.0] — 2026-08-04

Library unchanged (**1.0.0**). No downstream upgrade needed — changes affect the
`/add-kafka-observability` intake behavior only.

### Added
- Intake now scans sibling repos in the parent directory for an existing
  `src/observability/` install (detected via `src/observability/VERSION`) and proposes
  their `KAFKA_*` values — brokers, topic naming convention, security mode, Key Vault
  secret names — as per-environment defaults. Propose-only: the user confirms every
  value; the scan is read-only outside the target repo.

### Fixed
- Workflow plan template: vendored-directory file count corrected (~17 → 20).

## [0.1.0] — 2026-08-03

Initial release. Ships observability library **1.0.0**.

### Added
- **`add-kafka-observability`** skill — install OR upgrade a vendored `src/observability/`
  library in a LangGraph.js / LangChain.js agent repo: a `BaseTracer` subclass attached
  globally via `registerConfigureHook` (the same mechanism LangSmith's tracer uses) that
  publishes every traced run — graph invocation, LangGraph nodes, LLM calls with full
  prompts/outputs/token usage, tool runs, errors, trace hierarchy — as start/end events
  to a Kafka topic. Bank-standard envelope keyed by event id with `thread_id`
  correlation, zod-validated, secret-redacted, 512KB-truncated, over a bounded
  non-blocking fire-and-forget producer (librdkafka, `acks=all`, idempotent, bounded
  shutdown). Disabled by default (`KAFKA_ENABLED`); runs alongside LangSmith for
  parallel validation. The skill wires the `@confluentinc/kafka-javascript` dependency,
  one `startup()` call at the graph entrypoint, `.env.example`, deployment settings with
  Key Vault refs, a `test:observability` script, and verifies with typecheck + the
  library's unit suite.
