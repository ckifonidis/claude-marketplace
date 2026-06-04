---
name: create-tool
description: Bootstraps a new agent-step LangGraph project OR adds a tool to an existing one. For bootstrap, scaffolds the full project (package.json, tsconfig, graph.ts, state.ts, prompt.ts, CLI, Dockerfile, build_and_push.sh, and the agent-step library). For tools, builds src/tools/<name>/ from backend specs + a functionality description, wires state slots + prompt sections + tools/index. Use when starting a new agent project from scratch OR adding a domain tool to an existing project.
---

<essential_principles>
This skill builds a new domain tool that plugs into the **existing** `src/agent-step/` runner library. The library is provided — never modify it; only consume its API. Adopt these rules globally across every workflow:

**1. The runner is the backbone.** The deliverable is a `src/tools/<name>/` directory plus graph-level wiring. The runner in `src/agent-step/runner.ts` handles batching, prereq resolution, state threading, batch-shape enforcement, the confirmation propose/execute lifecycle, OTP and double-entry-match gates, multi-turn flow lifecycle, and lockdown. The new tool only declares actions, executors, and verifiers — it does NOT reimplement runner behavior.

**2. Conventions are construction-time enforced.**
- **Executor names** are derived from action names by snake-to-camel: action `verify_customer` → executor `verifyCustomer`. The runner throws at construction if the mapping is missing.
- **Verifier shape** is `{ check, denial }` — a record, NOT a function. Each verifier file owns both the predicate and the denial body.
- **Action `abort_pending_input`** is reserved by the library and auto-injected into the tool schema whenever any lifecycle opt (confirmation, OTP, match, or flow) is declared. Never declare it in `config.actions`.
- **Per-action `description`** is required (non-empty string); the library composes it into the tool's overall description AND into the Zod schema's `.describe()`.

**3. Mutations carry their own pre-check and post-read.** The library does not wrap reads around mutations. A mutation executor (e.g. `change_status`) reads card/account state before writing, decides whether to refuse based on that pre-state, performs the write, then re-reads after the write — and returns `preState` and `postState` fields in its result body. The library enforces only the batch-shape opts (`soleStep` / `soleOnExecute`) and the lifecycle gates (`requiresConfirmation`, `requiresOtp`, `requiresMatch`, `requiresFlow`).

**4. Library-managed state slots are off-limits to executors.** `awaitingInput` and `currentFlow` are written by the runner in response to per-action opts (`requiresConfirmation` / `issuesOtp` / `requiresOtp` / `startsMatchFor` / `requiresMatch` / `startsFlow` / `endsFlow` / `requiresFlow`) and to the executor's return-value hooks (`flowData`, `lifecycle.issuesOtp`, `lifecycle.clearAwaitingInput`, `lifecycle.abortFlow`). Executors must never put these slots in `stateUpdate`.

**5. Plan before writing.** Always produce a written plan first: action list, params schemas, prereqs per action, mutation opts (confirmation / OTP / match / flow), new state slots needed, new prompt fragments needed. Get user confirmation. THEN write files. Never start with file writes — the plan is the cheap review surface.

**6. Voice-safe by default.** This project's agent is a voice agent (TTS-spoken output). Executor result bodies are LLM-facing JSON (fine to be verbose, numeric, terse). The prompt edits MUST keep the voice rules — no markdown, no URLs, no digit numerals in spoken text, no echoing of full secrets (PIN plaintext, OTP digits the customer just read back). When a list result masks an identifier, still carry a voiceable **selection key** (a tail, a code) so the user's reference maps to an item. References cover this explicitly.

**7. Identity has two models — don't force the wrong one.** Either collect-and-verify (for mutations / proof-of-identity) OR session-context (identity passed in at invoke, for pre-authenticated / read-only tools — no verify action, a `sessionReady` presence check). Match the tool. See `identity-patterns.md`.

**8. Reads should be self-sufficient; the surface is for the user, not the backend.** Prereqs are safety gates, not sequencing hints — a read action should load what it needs rather than gate on a prior step, and the prompt must never report "none" from a slot that may simply be unloaded. Design actions around the user task: fold endpoint boundaries (list→details) into one action, keep sibling entity types symmetric. See `executor-patterns.md`, `read-tool-patterns.md`, `input-formats.md`.
</essential_principles>

<intake>
**Ask the user:**

What do you want to do?

1. **Bootstrap a new project** — empty target directory, you want the full scaffold (package.json, tsconfig, agent-step library, graph/agent/state/prompt skeleton, streaming CLI, Dockerfile, build_and_push.sh). After this, the project is agent-shaped but tool-empty.
2. **Add a tool** to an existing project — `src/agent-step/` already exists in the cwd; you have backend API specs and/or a functionality description for the new tool.
3. **Extend an existing tool** — add new actions/mutations to a tool that already exists under `src/tools/<name>/`.

**Skip the intake if the user's request makes the intent obvious** (e.g. "bootstrap a new project at /path/X" → go straight to bootstrap; "create a tool named accounts" → go straight to create-tool).

**For bootstrap, also ask:** project directory (absolute path), project name (kebab-case), agent display name, one-line description, voice or chat, ACR registry + image name.

**For tool, also ask:** tool name (snake-case directory name) and one-sentence domain summary.

**Wait for response before proceeding.**
</intake>

<routing>
| Response | Workflow |
|----------|----------|
| 1, "bootstrap", "new project", "from scratch" | `workflows/bootstrap-project.md` |
| 2, "add a tool", "new tool" | `workflows/create-tool.md` |
| 3, "extend", "add action to existing" | `workflows/create-tool.md` (uses ADD-MODE branch) |

**After reading the workflow, follow it exactly.**
</routing>

<quick_reference>
**Tool directory layout (canonical):**
```
src/tools/<name>/
├── config.ts                         # defineConfig({ tool, actions }) — lifecycle opts inline on ActionDef.controller
├── index.ts                          # buildAgentStepTool wire-up
├── actions/<action_name>/executor.ts # one per action; exports camelCase fn
├── verifiers/<prereq-name>.ts        # one per prereq; exports record
├── backend/env.ts                    # per-tool env constants
├── backend/client.ts                 # postBackend helper (or whatever protocol)
└── shared/                           # cross-action helpers (e.g. resolve-X.ts)
```

**Graph-level wiring touched:**
```
src/state.ts            # add per-tool state slots (awaitingInput + currentFlow are already there)
src/tools/index.ts      # one-line tool registration
src/prompt.ts           # ACTIONS + (if mutations) MUTATION SAFETY + (if multi-turn) FLOW NARRATIVE
```

**Tests scaffolded per tool (built on the shared `src/test-harness/`):**
```
src/tools/<name>/tests/tool/_setup.ts          # toolOpts + seedState + resetToSeed
src/tools/<name>/tests/tool/seed.json          # canonical sandbox seed
src/tools/<name>/tests/tool/<action>.test.ts   # sandbox tests (no LLM) — npm run test:sandbox
src/tools/<name>/tests/prompt-input/<topic>.test.ts  # routing tests (live model) — npm run test:prompt
src/tools/<name>/tests/{tool,prompt-input}/FINDINGS.md
```
The `test-agent-step` skill is the authority on HOW to use these (three layers, assertion boundaries, coverage bars, findings-not-flakes).

**Reserved names — do NOT use as action names:** `abort_pending_input`.

**Construction-time errors mean misconfig.** If the dev server crashes at startup with `agent-step: ...`, the config/registries don't match. Read the message; it names the missing piece.
</quick_reference>

<reference_index>
All domain knowledge in `references/`:

- **agent-step-api.md** — Runner types (ActionDef, ControllerHooks, Verifier, ConfirmationOpts, invalidatesOnChange), construction-time checks, library invariants.
- **tool-directory-layout.md** — Per-file purpose, naming conventions, file-creation order.
- **executor-patterns.md** — Read executor vs mutation executor patterns; backend client usage; state update shape; voice-safe outputs.
- **state-and-prompt-integration.md** — How to patch `src/state.ts`, `src/prompt.ts`, `src/tools/index.ts`.
- **input-formats.md** — How to derive actions from user stories, transcripts, structured lists, OpenAPI specs; designing the action surface for the user task, not the endpoint boundary.
- **identity-patterns.md** — The two identity models (collected-and-verified vs session-context / pre-authenticated), session-context state wiring, and the "a default is not a value source" gotcha. Read when the tool does NOT collect identity.
- **read-tool-patterns.md** — Read ergonomics: bounding result size, pagination, windowing/last-N, multi-source merge, reslice cache, and the retrieve-vs-analyze boundary. Read for search / browse / history / analytics tools.
- **project-bootstrap-structure.md** — Top-level project layout produced by the bootstrap workflow; what each scaffold file is for.
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| bootstrap-project.md | Scaffold a brand-new project: package.json, tsconfig, agent-step library copy, graph/agent/state/prompt skeleton, streaming CLI, Dockerfile, build script. Empty tools — runs `create-tool` next. |
| create-tool.md | Build a new tool inside an existing project, or extend an existing tool with new actions. Parse inputs → plan → user confirms → write files → verify. |
</workflows_index>

<templates_index>
All in `templates/`:

**Project scaffold** (used by bootstrap-project.md):
- `project/package.json.template`, `project/tsconfig.json.template`, `project/langgraph.json.template`
- `project/env.example.template`, `project/gitignore.template`
- `project/Dockerfile.template`, `project/build_and_push.sh.template`
- `project/llm-env.ts.template`, `project/cli-env-init.ts.template`
- `project/state.ts.template`, `project/agent.ts.template`, `project/graph.ts.template`
- `project/prompt.ts.template`, `project/cli.ts.template`, `project/tools-index.ts.template`

**Shared test harness** (verbatim copy by bootstrap; no substitution; generic + tool-agnostic):
- `project/test-harness-sandbox.ts.template`, `project/test-harness-prompt-input.ts.template`, `project/test-harness-index.ts.template`

**Agent-step library** (verbatim copy by bootstrap; no substitution):
- `agent-step/types.ts`, `agent-step/runner.ts`, `agent-step/runner.test.ts`, `agent-step/define-config.ts`, `agent-step/index.ts`

**Tool scaffold** (used by create-tool.md):
- `config.ts.template`, `tool-index.ts.template`, `verifier.ts.template`
- `executor-read.ts.template`, `executor-mutation.ts.template`
- `backend-env.ts.template`, `backend-client.ts.template`
- `plan.md.template` (proposed-plan document the workflow writes before file edits)

**Per-tool test scaffold** (used by create-tool.md; built on the shared harness):
- `tool-test-setup.ts.template`, `tool-sandbox-test.ts.template`, `tool-seed.json.template`
- `prompt-input-test.ts.template`, `findings.md.template`
</templates_index>

<success_criteria>
**Bootstrap project** is correctly produced when:
- [ ] All files in the plan exist at the target directory (config, library, scaffold, CLI, shared test harness)
- [ ] `npm install` completes
- [ ] `npx tsc --noEmit` passes with zero errors (empty tools array; shared test harness typechecks against zero tools)
- [ ] All runner unit tests pass (`npx tsc && node --test dist/agent-step/runner.test.js`)
- [ ] `npm run dev` boots cleanly (and is killed after confirmation)
- [ ] User is reminded to `cp .env.example .env`, of the `test` / `test:sandbox` / `test:prompt` scripts, and to run `/create-tool` next

**Tool added** is correctly produced when:
- [ ] `npx tsc --noEmit` passes with zero errors in the new tool files (incl. its `tests/`)
- [ ] `npm test` passes (runner tests) — no regression in the library
- [ ] The tool's tests exist and `npm run test:sandbox` passes (sandbox up); failures triaged as `FINDING:` in `tests/tool/FINDINGS.md`, never silently relaxed
- [ ] `npm run dev` starts cleanly; no construction-time `agent-step:` error
- [ ] `npm run cli` can verify the customer / target entity, run a read action, and (for mutations) propose + execute
- [ ] State slots merge correctly across turns (verified via `/state` in the CLI)
- [ ] For multi-turn flows: `currentFlow` opens and closes as expected; `awaitingInput` transitions through `confirmation` / `otp` / `match` correctly
- [ ] Voice response respects digits-as-words and no-URLs rules (if voice agent); never echoes full PINs or full OTPs
- [ ] Tool description + per-action descriptions surface the contract the LLM needs (verdicts, prereqs, result shape, lifecycle behaviour)
</success_criteria>
