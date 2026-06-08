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

## [1.1.0] — 2026-06-08

Additive: native read-pagination. Opt a list read into uniform pagination with `pageable` on its
action; the runner injects `page`/`pageSize` params, returns a standard
`{ page, pageSize, totalCount, totalPages, hasMore, items, fromCache }` envelope, and (self mode)
caches the full set in the new library-managed `pagedRead` slot so a same-query re-page skips the
executor. Opt-in — existing tools are unaffected. Migration: [migrations/1.0.0-to-1.1.0.md](migrations/1.0.0-to-1.1.0.md).

### Added
- `paginate.ts` (new library file): `PageableSpec` / `PageEnvelope` / `PagedCache` types +
  `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `clampPageSize`, `querySignature`, `pageRows`,
  `buildPageEnvelope`. Exported from `index.ts`.
- `ActionDef.pageable?: PageableSpec` — `true` (self-paginate), `"delegate"` (backend pages), or
  `{ mode, pageSize?, maxPageSize? }`.
- Library-managed `pagedRead` state slot (`PagedCacheSchema`; added to `agentStepStateSpec` +
  `agentStepZodShape`).

### Changed
- New construction-time check: a `pageable` action's `paramsSchema` must be a `z.object` (the runner
  merges `page`/`pageSize` into it).
- `package.json` `test` script broadened to `dist/agent-step/*.test.js` (runs the new `paginate.test.js`
  alongside `runner.test.js`).

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
