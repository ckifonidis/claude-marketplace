# Tracked assets — observability library (kafka-observability plugin)

The single place that knows what mirrors the observability library's contract. Counterpart of
`tracked-assets.md` (agent-step). All paths relative to the plugin root,
`plugins/kafka-observability/`. Four tiers; for each concrete change found in the Phase 2 diff,
walk the tiers and list the specific assets to hand-update.

## Tier 1 — the library itself (verbatim replacement, never hand-merged)

`skills/add-kafka-observability/templates/observability/`:

- Code: `index.ts`, `run-tracer.ts`, `run-filter.ts`, `configure-slot.ts`, `event-emitter.ts`,
  `schemas.ts`, `registry.ts`, `kafka-producer.ts`, `bounded-queue.ts`, `event-producer.ts`,
  `redaction.ts`, `settings.ts`, `env.ts`
- Tests: `index.test.ts`, `run-tracer.test.ts`, `run-filter.test.ts`, `configure-slot.test.ts`,
  `event-emitter.test.ts`, `schemas.test.ts`, `kafka-producer.test.ts`, `bounded-queue.test.ts`,
  `redaction.test.ts`
- `VERSION` — written by this skill (the new version), never copied from the source.

**What touches it:** every bump. Added/removed files must also be mirrored in Tier 3's
file inventory mentions.

## Tier 2 — in-library docs (ship to consumers inside the vendored copy)

- `skills/add-kafka-observability/templates/observability/README.md` — env-var tables (must match
  `settings.ts`/`env.ts` exactly), the event-schema example (must match `schemas.ts`), the
  architecture diagram (emitter/producer pipeline), reliability + redaction notes, the
  LangSmith-migration section.

**What touches it:** any env-var change (add/rename/default), any `schemas.ts` field change, any
pipeline/reliability-semantics change (queue, retries, shutdown, truncation cap, Kafka key
choice), any redaction-pattern change.

## Tier 3 — skill docs (the install/upgrade instructions)

- `skills/add-kafka-observability/SKILL.md` — `<quick_reference>` (env-var list, wiring snippet,
  test script, event-contract line, dependency name), `<essential_principles>` (strict
  `KAFKA_ENABLED` note, fire-and-forget, Kafka-key rule), `<intake>` (which values are asked).
- `skills/add-kafka-observability/workflows/add-kafka-observability.md` — the `.env.example`
  block, the vendored-file count (Step 3 plan + Step 4), the wiring snippet (Step 5), the
  dependency name/version note, the verify commands (Step 8).

**What touches it:** env-var changes, public API changes (`startup`/`shutdown`/exports), a new
required wiring step, dependency changes, file additions/removals (the count), test-command
changes.

## Tier 4 — plugin + marketplace prose

- `CHANGELOG.md` (plugin root) — owned by this skill: the new entry each bump.
- `migrations/` (plugin root) — owned by this skill: the `<from>-to-<to>.md` guide each
  contract-changing bump (format: `migrations/README.md`).
- `.claude-plugin/plugin.json` `description` + the plugin's entry in
  `.claude-plugin/marketplace.json` + root `README.md` section — **NOT edited by this skill**
  (they describe the plugin package, `/publish-release` owns them), but flag in the Phase 3
  proposal when a library change makes their prose stale (e.g. a headline capability changed) so
  the next `/publish-release` refreshes them.
- `.claude/skills/publish-release/references/staleness-checks.md` cross-references the env-var and
  schema facts — keep its kafka-observability checks accurate if the source-of-truth files move.

**What touches it:** every bump (CHANGELOG + migration); capability-level changes (flag for
release); moved/renamed source-of-truth files (staleness checks).
