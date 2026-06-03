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
    └── tools/
        └── index.ts              # empty barrel: `export const tools = [] as const;`
```
</final_layout>

<per_file_purpose>
## Config files

**package.json** — Declares dependencies (`@langchain/core`, `@langchain/langgraph`, `@langchain/openai`, `dotenv`, `zod`) and dev-deps (`@langchain/langgraph-cli`, `tsx`, `typescript`, `@types/node`). Scripts: `build`, `typecheck`, `test`, `dev` (LangGraph dev server on :2024), `cli` (in-process REPL).

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

**Never modify the library in a generated project.** If you find a real bug in the runner, fix it upstream (in `cards-info-agent-ts/src/agent-step/`) and re-sync the skill's templates.

## Graph scaffold

**llm-env.ts** — Reads `AZURE_OPENAI_*` env at module load via `dotenv.config({ override: true })`; throws if any required var is missing. Exports `llmEnv` constants including `temperature` parsed from `TEMPERATURE` (default 0).

**cli-env-init.ts** — Side-effect-only module imported FIRST by `cli.ts`. Sets `CARDS_BACKEND_TRACE=0` (or equivalent per tool) by default so the CLI's structured per-step output isn't drowned by raw backend chatter. Override by setting `<TOOL>_BACKEND_TRACE=1` explicitly.

**state.ts** — `Annotation.Root({...})` with `MessagesAnnotation.spec` spread in + two library-managed slots (`awaitingInput`, `currentFlow`). Per-tool slots are added in this file as tools are introduced. Also exports a Zod `AgentStateSchema` for input validation, including a discriminated-union schema for `awaitingInput` (confirmation / otp / match) and a `{ name, data }` schema for `currentFlow`.

**agent.ts** — Builds the `createReactAgent` with `AzureChatOpenAI` LLM + `MemorySaver` checkpointer + the tools registered in `src/tools/index.ts` + the prompt builder.

**graph.ts** — Single export `graph` — what `langgraph.json` references. Logs env presence at load (useful for diagnosing missing env in deployed containers).

**prompt.ts** — System prompt builder. Has sections (SCOPE, OPERATING LOOP, IDENTIFICATION, ACTIONS, MUTATION SAFETY, VOICE RULES, EXAMPLES) — most start as `{{TBD — ...}}` placeholders. The `create-tool` workflow fills them in incrementally. MUTATION SAFETY teaches `abort_pending_input` as the universal abort for any pending input or flow.

**cli.ts** — In-process streaming REPL. Raw-mode terminal, multi-line input, history, ESC to abort, slash commands (`/state`, `/history`, `/new`, `/last`, `/copy`, `/quit`, `/help`). Per-step tool envelope display: each batch step printed as a dim bullet with ok/fail and surfaced fields. Imports `cli-env-init.ts` first to silence backend logs.

**tools/index.ts** — Empty barrel. The first `create-tool` invocation adds an import + array entry. Subsequent tools append.
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
2. `/create-tool` — add the first tool.
3. `npm run dev` to test via the dev server, OR `npm run cli` to test via the REPL.
4. Iterate: more `/create-tool` invocations for additional tools, then `./build_and_push.sh latest` when ready to deploy.
</post_bootstrap_workflow>
