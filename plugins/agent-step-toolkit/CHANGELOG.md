# agent-step library changelog

Version history for the **agent-step runner library** vendored by this toolkit. This tracks the
library only — NOT the plugin package version in `.claude-plugin/plugin.json`. The current version
ships in `skills/create-tool/templates/agent-step/VERSION` and travels into every bootstrapped
project at `src/agent-step/VERSION`.

Entries are written by `/bump-version` (newest first). Each breaking or behaviour-changing entry
links a migration guide under `migrations/` that `/pull-library` applies to downstream projects.

Format follows [Keep a Changelog](https://keepachangelog.com/). The library uses semver:
**major** = breaking public-API change (exports/signatures in `index.ts` / `types.ts`, or the
`buildAgentStepTool` options), **minor** = additive, **patch** = internal-only.

## [1.0.0] — 2026-06-05

Breaking: per-action **state selectors**. The runner now projects the host state down
to a per-action slice before calling the executor, so executors receive only what they
need — not the whole state. Migration: [migrations/0.1.0-to-1.0.0.md](migrations/0.1.0-to-1.0.0.md).

### Breaking
- `buildAgentStepTool` / `runSteps` require a new `selectors` registry — one `Selector` per
  action, keyed by action name. New signature:
  `buildAgentStepTool({ config, stateAnnotation, selectors, executors, verifiers })`.
- Selectors and the `executors` registry are now keyed by the **exact action name** (snake_case).
  The snake-to-camel executor-key convention is gone (`toExecutorKey` removed); the runner now
  dispatches `executors[action](params, selectors[action](view))`.
- `Executor<T>` → `Executor<Slice, T>` — the executor's `state` param is the selector's return,
  not the whole state. `ExecutorRegistry<T>` → `ExecutorRegistry<T, Selectors>`, per-action typed
  from each selector's return so a mismatch is a compile error at the construction boundary.

### Added
- `Selector<T>` and `SelectorRegistry<T, ActionName>` exports.

### Changed
- Executor throws are now caught by the runner and surfaced as an `ok:false` step
  (`error: "executor_error"`) instead of escaping `runSteps`; earlier steps' commits are preserved.
- Removed the inert `proposedAt` timestamp from pending confirmations (TTL was already removed).

## [0.1.0] — baseline

Initial embedded library. No migration guide (nothing precedes it).

- `buildAgentStepTool({ config, stateAnnotation, executors, verifiers })`, `runSteps`, `defineConfig`.
- Executor signature `Executor<T> = (params, state: T) => Promise<ExecutorResult<T>>` — executor
  receives the whole state.
- Lifecycle: confirmation propose/execute, OTP issue/consume, double-entry match, multi-turn flow,
  batch-isolation (`soleStep` / `soleOnExecute`), `invalidatesOnChange`.
