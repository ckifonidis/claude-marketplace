# Workflow: Bootstrap a New Project

<required_reading>
Read these reference files NOW, in order:
1. `references/agent-step-api.md` — the runner library contract (you'll be copying it as-is)
2. `references/tool-directory-layout.md` — the tool shape the project will host
3. `references/project-bootstrap-structure.md` — the project-level layout this workflow produces
</required_reading>

<overview>
This workflow scaffolds a brand-new agent-step-based project from scratch: TypeScript config, langgraph dev server config, the agent-step library (copied verbatim from `templates/agent-step/`), graph + state + prompt + agent skeleton, the streaming CLI, the **shared test harness** (`src/test-harness/` — generic sandbox + prompt-input scaffolding the per-tool tests build on), Dockerfile, and ACR build script. Total ~23 files. After bootstrap, the project is **agent-shaped but tool-empty** — the user runs the `create-tool` workflow next to add the first tool (which scaffolds that tool's tests against the harness shipped here).
</overview>

<process>
## Step 1: Gather inputs

Ask via AskUserQuestion (group into 2–3 questions; skip what's obvious from context):

- **Project directory** (absolute path). Either an existing empty directory or a path to create.
- **Project name** (npm package name; kebab-case; e.g. `accounts-agent-ts`). Becomes `name` in package.json + the Docker image name + the LangSmith project name default.
- **Agent display name** (one short phrase shown in CLI header + prompt; e.g. "NBG Accounts Agent").
- **One-line description** (lands in package.json description + prompt lead sentence).
- **Voice or chat?** Determines whether to keep CHANNEL CONSTRAINTS and VOICE RULES in the prompt template.
- **ACR registry + image name** (for `build_and_push.sh`). Default: ask whether they have ACR creds in env.

If any answer is unclear, ask one round-trip; don't write files until the inputs are complete.

## Step 2: Write the plan (mandatory before file writes)

Generate a short plan listing every file the workflow will create, grouped by purpose. Show absolute paths. Get explicit user confirmation before writing.

```
# Bootstrap Plan: <project_name>

Target: /absolute/path/to/<project_name>/

## Files to create (~23)

### Config (project root)
- package.json
- tsconfig.json
- langgraph.json
- .env.example
- .gitignore
- Dockerfile
- build_and_push.sh

### Agent-step library source (verbatim from skill templates)
- src/agent-step/types.ts
- src/agent-step/state.ts
- src/agent-step/runner.ts
- src/agent-step/runner.test.ts
- src/agent-step/paginate.ts
- src/agent-step/paginate.test.ts
- src/agent-step/define-config.ts
- src/agent-step/index.ts
- src/agent-step/VERSION  (library version marker; lets `/pull-library` know what the project currently vendors)

### Graph scaffold (tool-empty; first tool added via /create-tool)
- src/llm-env.ts
- src/cli-env-init.ts          (suppresses backend trace in the CLI)
- src/state.ts                 (messages + awaitingInput + currentFlow + pagedRead; per-tool slots added later)
- src/agent.ts
- src/graph.ts
- src/prompt.ts                (sections with TBD placeholders for tool-specific content)
- src/cli.ts                   (streaming REPL)
- src/tools/index.ts           (empty barrel)

### Shared test harness (generic; per-tool tests built on this by /create-tool)
- src/test-harness/sandbox.ts        (runSteps re-export, foldCommitted, requireReachable, resetViaHttp)
- src/test-harness/prompt-input.ts   (live-model drivers + expect* helpers + PROMPT_INPUT_LIVE gating)
- src/test-harness/index.ts          (barrel)

## Next actions after bootstrap
- npm install
- Verify: npm run typecheck (zero errors), npm test (all runner unit tests pass, zero failures), npm run dev (server starts)
- Add the first tool: /create-tool
```

Wait for explicit go-ahead.

## Step 3: Create directories

```bash
PROJECT=/absolute/path/to/<project_name>
mkdir -p "$PROJECT"/{src/agent-step,src/tools,src/test-harness}
```

If the directory exists and is non-empty, ASK before proceeding — refuse to overwrite without confirmation.

## Step 4: Write project root files

For each project-root file, copy from the corresponding template under `templates/project/<file>.template` and substitute placeholders. Placeholders to fill:

| placeholder | source | example |
|-------------|--------|---------|
| `{{PROJECT_NAME}}` | step 1 input | `accounts-agent-ts` |
| `{{AGENT_DISPLAY_NAME}}` | step 1 input | `NBG Accounts Agent` |
| `{{ONE_LINE_DESCRIPTION}}` | step 1 input | `Voice agent for NBG account inquiries` |
| `{{AGENT_DESCRIPTION_ONE_LINER}}` | step 1 input | `the bank's voice agent for account inquiries` |
| `{{TOOL_NAME}}` | first tool name (or leave as `{{TOOL_NAME}}` if unknown — user replaces during /create-tool) | `accounts` |
| `{{ACR_REGISTRY}}` | step 1 input | `idpdirectacr.azurecr.io` |
| `{{ACR_USERNAME_DEFAULT}}` | optional; leave the placeholder if user wants to set via env | `<uuid>` |
| `{{ACR_PASSWORD_DEFAULT}}` | optional; leave the placeholder if user wants to set via env | `<secret>` |
| `{{IMAGE_NAME}}` | step 1 input | `accounts-agent-ts` |

Files to write (in any order — all independent):
- `package.json` ← `templates/project/package.json.template`
- `tsconfig.json` ← `templates/project/tsconfig.json.template`
- `langgraph.json` ← `templates/project/langgraph.json.template`
- `.env.example` ← `templates/project/env.example.template`
- `.gitignore` ← `templates/project/gitignore.template`
- `Dockerfile` ← `templates/project/Dockerfile.template`
- `build_and_push.sh` ← `templates/project/build_and_push.sh.template` (then `chmod +x`)

After writing, the project directory looks like:
```
<project_name>/
├── .env.example
├── .gitignore
├── Dockerfile
├── build_and_push.sh
├── langgraph.json
├── package.json
├── tsconfig.json
└── (src/ still empty)
```

## Step 5: Copy agent-step library source

These files are NOT templates — they're verbatim source. Just copy:

```bash
cp templates/agent-step/types.ts        "$PROJECT/src/agent-step/types.ts"
cp templates/agent-step/state.ts        "$PROJECT/src/agent-step/state.ts"
cp templates/agent-step/runner.ts       "$PROJECT/src/agent-step/runner.ts"
cp templates/agent-step/runner.test.ts  "$PROJECT/src/agent-step/runner.test.ts"
cp templates/agent-step/paginate.ts      "$PROJECT/src/agent-step/paginate.ts"
cp templates/agent-step/paginate.test.ts "$PROJECT/src/agent-step/paginate.test.ts"
cp templates/agent-step/define-config.ts "$PROJECT/src/agent-step/define-config.ts"
cp templates/agent-step/index.ts        "$PROJECT/src/agent-step/index.ts"
cp templates/agent-step/VERSION         "$PROJECT/src/agent-step/VERSION"
```

Don't edit them. If the templates need updating later, treat that as a separate maintenance task (sync new library changes back into `templates/agent-step/`).

## Step 6: Write graph scaffold files

For each, copy from `templates/project/*.template` and substitute placeholders. Files (write in this order so each can reference the previous):

1. `src/llm-env.ts` ← `templates/project/llm-env.ts.template` (no substitution needed)
2. `src/cli-env-init.ts` ← `templates/project/cli-env-init.ts.template` (no substitution; side-effect-only)
3. `src/state.ts` ← `templates/project/state.ts.template` (no substitution; per-tool slots commented out — first /create-tool fills them in)
4. `src/agent.ts` ← `templates/project/agent.ts.template` (no substitution)
5. `src/graph.ts` ← `templates/project/graph.ts.template` (no substitution)
6. `src/prompt.ts` ← `templates/project/prompt.ts.template` (substitute `{{AGENT_DISPLAY_NAME}}`, `{{AGENT_DESCRIPTION_ONE_LINER}}`, `{{TOOL_NAME}}`)
7. `src/cli.ts` ← `templates/project/cli.ts.template` (substitute `{{AGENT_DISPLAY_NAME}}`, `{{PROJECT_NAME}}`)
8. `src/tools/index.ts` ← `templates/project/tools-index.ts.template` (no substitution; empty barrel)

## Step 6b: Write the shared test harness

Generic, tool-agnostic test scaffolding the per-tool suites (added later by `/create-tool`) build on. No substitution — copy verbatim:

```bash
cp templates/project/test-harness-sandbox.ts.template      "$PROJECT/src/test-harness/sandbox.ts"
cp templates/project/test-harness-prompt-input.ts.template "$PROJECT/src/test-harness/prompt-input.ts"
cp templates/project/test-harness-index.ts.template        "$PROJECT/src/test-harness/index.ts"
```

These compile against an EMPTY tools array (the prompt-input harness lazy-imports the model + tools, so it needs no credentials at typecheck time). The `package.json.template` already declares the `test:sandbox` / `test:prompt` / `test:all` scripts that drive them.

## Step 7: npm install

```bash
cd "$PROJECT" && npm install
```

Expect: ~200 packages, ~30 seconds. If install fails, surface the error and stop.

## Step 8: Verify

Run these checks in order. Stop on first failure:

```bash
cd "$PROJECT"

# 1. Typecheck — should pass with an empty tools array
npx tsc --noEmit
```
Expected: zero errors. (The empty `tools: []`, stub prompt, and the shared test harness all typecheck fine against zero tools — intentional empty start. The prompt-input harness lazy-imports the model/tools, so it needs no Azure creds to typecheck.)

```bash
# 2. Library tests (runner + paginate) — all should pass; count grows as the library evolves
npx tsc && node --test dist/agent-step/*.test.js
```
Expected: zero failures. This validates the library copy is intact.

```bash
# 3. Dev server boot — should start cleanly
npm run dev
```
Wait for `Welcome to LangGraph.js dev server` (or similar). Kill the process after confirming. If the boot fails with `agent-step: ...`, the library wasn't copied correctly; check Step 5 outputs.

## Step 9: Report + suggest next step

Tell the user:
- ✅ Bootstrap complete at `<PROJECT>`.
- The project has graph, agent, state, prompt, CLI, and the **shared test harness** scaffolding, but **no tools yet**.
- Test scripts are wired: `npm test` (runner unit, fast), `npm run test:sandbox` (per-tool sandbox tests, needs the local sandbox up), `npm run test:prompt` (prompt-input, live model). The sandbox/prompt scripts are no-ops until the first tool ships its tests.
- Next: `cd <PROJECT> && /create-tool` to add the first tool — it scaffolds that tool's tests against the harness shipped here.
- Reminder: `.env` doesn't exist yet — they need to copy `.env.example` to `.env` and fill in Azure OpenAI keys before `npm run dev` or `npm run cli` will work.

## Optional: initial commit

If the user wants a starting commit, propose:

```bash
cd "$PROJECT" && git init && git add -A && git commit -m "Bootstrap <project_name> from /create-tool"
```

(Only on user confirmation; never auto-commit.)
</process>

<success_criteria>
Workflow complete when:
- [ ] Plan was written and explicitly confirmed by the user
- [ ] All ~23 files exist at the target project directory (incl. `src/test-harness/`)
- [ ] `npm install` succeeded
- [ ] `npx tsc --noEmit` passes with zero errors (library + scaffold + shared test harness against zero tools)
- [ ] All runner unit tests pass (zero failures)
- [ ] `npm run dev` starts cleanly (server reaches "Welcome" / equivalent)
- [ ] User informed of `.env` setup requirement, the `test` / `test:sandbox` / `test:prompt` scripts, and the next step (`/create-tool`)
</success_criteria>
