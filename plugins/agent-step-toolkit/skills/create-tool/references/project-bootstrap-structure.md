# Reference: Project Bootstrap Structure

<overview>
The shape produced by the `bootstrap-project` workflow. This is a complete LangGraph TypeScript agent project, with the agent-step runner library embedded, ready for the first tool to be added via the `create-tool` workflow.
</overview>

<final_layout>
```
<project_name>/
├── package.json                  # scripts: build / typecheck / test / dev / cli
├── tsconfig.json
├── langgraph.json                # dev server entry → src/graph.ts:graph
├── .env.example                  # copy to .env and fill before running
├── .gitignore
├── Dockerfile                    # langgraph/langgraphjs-api:20 base image
├── build_and_push.sh             # ACR push helper
└── src/
    ├── agent-step/               # LIBRARY — do not modify. Verbatim copy.
    │   ├── types.ts
    │   ├── runner.ts
    │   ├── runner.test.ts        # unit tests; should pass out of the box
    │   ├── define-config.ts
    │   └── index.ts
    ├── llm-env.ts                # AZURE_OPENAI_* env loader
    ├── cli-env-init.ts           # side-effect-only: suppresses backend trace logs in CLI
    ├── state.ts                  # graph state — messages + awaitingInput + currentFlow
    ├── agent.ts                  # createReactAgent wire-up
    ├── graph.ts                  # exports `graph` (langgraph.json points here)
    ├── prompt.ts                 # system prompt with TBD section placeholders
    ├── cli.ts                    # streaming REPL (npm run cli)
    ├── test-harness/             # SHARED test scaffolding — generic, tool-agnostic
    │   ├── sandbox.ts            # runSteps re-export, foldCommitted, requireReachable, resetViaHttp
    │   ├── prompt-input.ts       # live-model drivers + expect* helpers + PROMPT_INPUT_LIVE gating
    │   └── index.ts              # barrel
    └── tools/
        └── index.ts              # empty barrel: `export const tools = [] as const;`
```

After the first `/create-tool`, each tool also gets a `tests/` subtree built on the shared harness:
```
src/tools/<name>/tests/
├── tool/                         # sandbox tests — runner + executors, no LLM
│   ├── _setup.ts                 # per-tool wiring: toolOpts, seedState, resetToSeed
│   ├── seed.json                 # canonical sandbox seed
│   ├── <action>.test.ts          # one per action (npm run test:sandbox)
│   └── FINDINGS.md
└── prompt-input/                 # routing tests — live model, no execution
    ├── <topic>.test.ts           # one per routing decision (npm run test:prompt)
    └── FINDINGS.md
```
</final_layout>

<per_file_purpose>
## Config files

**package.json** — Declares dependencies (`@langchain/core`, `@langchain/langgraph`, `@langchain/openai`, `dotenv`, `zod`) and dev-deps (`@langchain/langgraph-cli`, `tsx`, `typescript`, `@types/node`). Scripts: `build`, `typecheck`, `test` (runner unit tests — fast, no backend, no LLM), `test:sandbox` (per-tool sandbox tests — needs the local sandbox), `test:prompt` (prompt-input tests — live model, sets `PROMPT_INPUT_LIVE=1`), `test:all` (unit + sandbox), `dev` (LangGraph dev server on :2024), `cli` (in-process REPL). The `test:sandbox` / `test:prompt` scripts use a guarded `find` so they're clean no-ops until a tool ships tests.

**tsconfig.json** — ESM, Node 20+, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`. Outputs to `dist/`.

**langgraph.json** — Tells the LangGraph dev server which file exports the graph (`./src/graph.ts:graph`) and where to load env from (`.env`).

**.env.example** — Lists every env var the project consumes. The user copies to `.env` and fills in real values.

**.gitignore** — Standard: `node_modules/`, `dist/`, `.env`, `.langgraph_api/`, `*.log`.

**Dockerfile** — Based on `langchain/langgraphjs-api:20`. Builds the project for deployment to ACR or any other registry. `LANGSERVE_GRAPHS` env tells the prod runtime which graph to serve.

**build_and_push.sh** — Cross-platform buildx + ACR login + push. Cards-style template; adapt the registry / image name.

## Library: src/agent-step/

Verbatim copy of the runner library. The skill treats these as templates-by-copy (no substitution). Files:

- **types.ts** — `AgentStepConfig` (`{ tool, actions }`), `ActionDef` (with inline `controller: ControllerHooks` + `invalidatesOnChange`), `ControllerHooks` (batch-shape opts + confirmation / OTP / match / flow lifecycle opts), `ConfirmationOpts`, `Verifier`, `ExecutorResult` (with `flowData` / `lifecycle`).
- **state.ts** — the library-managed state slots: `AwaitingInputSchema` (discriminated union over confirmation / otp / match) → `AwaitingInput`, `CurrentFlowSchema` → `CurrentFlow`, plus the `agentStepStateSpec` / `agentStepZodShape` fragments hosts spread into their state.
- **runner.ts** — `buildAgentStepTool`, `runSteps`, the construction-time validator, the propose/execute lifecycle, OTP gate, double-entry match gate, flow mutex, lockdown enforcement, `invalidatesOnChange` cascade, library-injected `abort_pending_input` action.
- **runner.test.ts** — unit tests covering every runner branch. Run via `npm test`.
- **define-config.ts** — identity helper for typed `defineConfig({...})` calls.
- **index.ts** — public exports (re-exports from `types.ts`, `state.ts`, `define-config.ts`, `runner.ts`).

**Never modify the library in a generated project.** The source of truth for the runner library is this skill's own `templates/agent-step/` directory. If you find a real bug in the runner, fix it there (and update `templates/agent-step/runner.test.ts` to cover it), then regenerate — never hand-patch a copy inside a generated project, or it will drift from the templates and the next bootstrap will reintroduce the bug.

## Graph scaffold

**llm-env.ts** — Reads `AZURE_OPENAI_*` env at module load via `dotenv.config({ override: true })`; throws if any required var is missing. Exports `llmEnv` constants including `temperature` parsed from `TEMPERATURE` (default 0).

**cli-env-init.ts** — Side-effect-only module imported FIRST by `cli.ts`. Sets `CARDS_BACKEND_TRACE=0` (or equivalent per tool) by default so the CLI's structured per-step output isn't drowned by raw backend chatter. Override by setting `<TOOL>_BACKEND_TRACE=1` explicitly.

**state.ts** — `Annotation.Root({...})` with `MessagesAnnotation.spec` spread in + two library-managed slots (`awaitingInput`, `currentFlow`). Per-tool slots are added in this file as tools are introduced. Also exports a Zod `AgentStateSchema` for input validation, including a discriminated-union schema for `awaitingInput` (confirmation / otp / match) and a `{ name, data }` schema for `currentFlow`.

**agent.ts** — Builds the `createReactAgent` with `AzureChatOpenAI` LLM + `MemorySaver` checkpointer + the tools registered in `src/tools/index.ts` + the prompt builder.

**graph.ts** — Single export `graph` — what `langgraph.json` references. Logs env presence at load (useful for diagnosing missing env in deployed containers).

**prompt.ts** — System prompt builder. Has sections (SCOPE, OPERATING LOOP, IDENTIFICATION, ACTIONS, MUTATION SAFETY, VOICE RULES, EXAMPLES) — most start as `{{TBD — ...}}` placeholders. The `create-tool` workflow fills them in incrementally. MUTATION SAFETY teaches `abort_pending_input` as the universal abort for any pending input or flow.

**cli.ts** — In-process streaming REPL. Raw-mode terminal, multi-line input, history, ESC to abort, slash commands (`/state`, `/history`, `/new`, `/last`, `/copy`, `/quit`, `/help`). Per-step tool envelope display: each batch step printed as a dim bullet with ok/fail and surfaced fields. Imports `cli-env-init.ts` first to silence backend logs.

**tools/index.ts** — Empty barrel. The first `create-tool` invocation adds an import + array entry. Subsequent tools append.

## Shared test harness: src/test-harness/

Generic, tool-agnostic scaffolding the per-tool test suites build on. Shipped at bootstrap so the testing methodology (see the `test-agent-step` skill) has real, in-project infrastructure to grade against — not files that only exist in some reference project.

- **sandbox.ts** — The sandbox/tool layer (no LLM). Re-exports `runSteps` and `assert`; provides `foldCommitted` (thread one batch's `committed` into the next batch's starting state, mirroring the graph between turns), `requireReachable` (assert the local sandbox answers before a suite runs), and `resetViaHttp` (POST a seed to a reset endpoint). Tool tests import these via their own `tests/tool/_setup.ts`.
- **prompt-input.ts** — The prompt-input layer (live model, no execution). Lazy-imports the model + tools + `llm-env` (so the file imports without credentials and the suite self-skips), binds the project's real tools to the model, runs the real `buildPrompt`, and returns the **steps the model emitted** before any execution. Provides `runUserTurn` / `runTurn` / `priorToolTurn` drivers, `expect*` assertions over emitted steps, and `promptInputEnabled()` / `promptInputSkipReason` for gating behind `PROMPT_INPUT_LIVE`.
- **index.ts** — Barrel over both layers. (Tests usually import the specific layer directly; keeping the two layers in separate modules ensures a sandbox test never pulls in the live-model machinery.)

**The harness compiles against zero tools.** At bootstrap the tools array is empty and there are no `tests/` directories yet; the harness still typechecks because the prompt-input layer defers all model/tool imports to call time.
</per_file_purpose>

<what_bootstrap_does_NOT_do>
The bootstrap workflow intentionally does NOT:

- **Write `.env`** — only `.env.example`. The user fills in real secrets manually.
- **Add tools** — `src/tools/` is empty after bootstrap. The user runs `/create-tool` to add the first one.
- **Run `npm run dev`** — only verifies it can boot. The user runs it for real interactive testing.
- **Initialize git** — proposed as an optional final step, not auto-done.
- **Configure LangSmith** — `.env.example` lists the variables; the user fills them in if they want tracing.

These are deliberate boundaries: bootstrap produces a runnable shape, the user owns the credentials and the domain content.
</what_bootstrap_does_NOT_do>

<post_bootstrap_workflow>
After bootstrap, the user's next steps are:

1. `cp .env.example .env`, fill in Azure OpenAI + (eventually) backend creds.
2. `/create-tool` — add the first tool. This scaffolds the tool's `tests/` (sandbox + prompt-input) against the shared harness.
3. `npm run dev` to test via the dev server, OR `npm run cli` to test via the REPL. `npm run test:sandbox` once the local sandbox is up; `npm run test:prompt` for routing checks (live model).
4. Iterate: more `/create-tool` invocations for additional tools, then `./build_and_push.sh latest` when ready to deploy.

Bootstrap ships the shared **harness** but no per-tool **tests** (there are no tools yet) — those arrive with each `/create-tool`. The `test:sandbox` / `test:prompt` scripts are clean no-ops until then.
</post_bootstrap_workflow>
