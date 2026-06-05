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

## [0.1.0] — baseline

Initial embedded library. No migration guide (nothing precedes it).

- `buildAgentStepTool({ config, stateAnnotation, executors, verifiers })`, `runSteps`, `defineConfig`.
- Executor signature `Executor<T> = (params, state: T) => Promise<ExecutorResult<T>>` — executor
  receives the whole state.
- Lifecycle: confirmation propose/execute, OTP issue/consume, double-entry match, multi-turn flow,
  batch-isolation (`soleStep` / `soleOnExecute`), `invalidatesOnChange`.
