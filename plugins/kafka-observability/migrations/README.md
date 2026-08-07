# observability library migrations

Version-keyed upgrade guides consumed by `/add-kafka-observability` when it finds an
older `src/observability/VERSION` in a target project (the skill handles both first
install and upgrade).

Format (same as agent-step-toolkit's `migrations/`): one file per version step, named
`<from>-to-<to>.md`, containing:

- a summary of what changed in the library,
- an ordered `<transforms>` section — the concrete, idempotent edits to apply to the
  PROJECT's own files (wiring, env examples, deployment settings). The library files
  themselves are always replaced wholesale (vendored, never hand-edited), so transforms
  only ever cover project-level integration points.

For multi-step jumps, apply the files in version order. A project with no
`src/observability/VERSION` is a fresh install — no migrations apply; the skill vendors
the current library directly.

| Step | Summary |
|------|---------|
| `1.0.0-to-1.1.0.md` | Connection diagnostics (connected log, never-connected watchdog, startup reword). Pure file refresh — no project-level transforms. |
| `1.1.0-to-1.2.0.md` | Attachment robustness (INC-2026-0045): configure-slot wrap alongside the ALS-scoped configure hook, `KAFKA_ATTACH_MODE`, attachment/break diagnostics. One transform: `.env.example` gains the commented `KAFKA_ATTACH_MODE` line. |
| `1.2.0-to-1.3.0.md` | Opt-in run filtering (`KAFKA_RUN_FILTER_MODE`/`KAFKA_RUN_FILTER_PATTERNS`, default off = every run emitted; root run always survives). One transform: `.env.example` gains the commented filter lines. |
| `1.3.0-to-1.4.0.md` | Redaction precision: LLM usage counters/containers survive (scalar type guard + anchored usage-container exemption); credential masking unchanged. Pure file refresh — no transforms. |
