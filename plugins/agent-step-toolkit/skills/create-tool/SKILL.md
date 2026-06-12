---
name: create-tool
description: Bootstraps a new agent-step LangGraph project OR adds a tool to an existing one. For bootstrap, scaffolds the full project (package.json, tsconfig, graph.ts, state.ts, prompt.ts, CLI, Dockerfile, build_and_push.sh, the agent-step library) and establishes the required root sandbox/ service (reused from a reference project, built from a Postman collection, or best-effort from specs). For tools, builds src/tools/<name>/ from backend specs + a functionality description, wires state slots + prompt sections + tools/index, and extends the sandbox for any backend the tool calls. Use when starting a new agent project from scratch, adding a domain tool to an existing project, or setting up/extending the project's local sandbox.
---

<essential_principles>
This skill builds a new domain tool that plugs into the **existing** `src/agent-step/` runner library. The library is provided — never modify it; only consume its API. Adopt these rules globally across every workflow:

**1. The runner is the backbone.** The deliverable is a `src/tools/<name>/` directory plus graph-level wiring. The runner in `src/agent-step/runner.ts` handles batching, prereq resolution, state threading, batch-shape enforcement, the confirmation propose/execute lifecycle, OTP and double-entry-match gates, multi-turn flow lifecycle, and lockdown. The new tool only declares actions, executors, and verifiers — it does NOT reimplement runner behavior.

**2. Conventions are construction-time enforced.**
- **Selectors + executors are keyed by the exact action name** (snake_case) — 1:1, no name transformation. Each action has a `stateSelector.ts` (`getSlice` + `Slice`) projecting the state down to the slice its executor receives; the executor sees only that slice. Build `selectors` with `satisfies SelectorRegistry<State, ActionName>` and `executors` as `ExecutorRegistry<State, typeof selectors>`, so a selector/executor type mismatch is a compile error. The runner throws at construction if either registry is missing an action's entry.
- **Verifier shape** is `{ check, denial }` — a record, NOT a function. Each verifier file owns both the predicate and the denial body.
- **Action `abort_pending_input`** is reserved by the library and auto-injected into the tool schema whenever any lifecycle opt (confirmation, OTP, match, or flow) is declared. Never declare it in `config.actions`.
- **Per-action `description`** is required (non-empty string); the library composes it into the tool's overall description AND into the Zod schema's `.describe()`.

**3. Mutations carry their own pre-check and post-read.** The library does not wrap reads around mutations. A mutation executor (e.g. `change_status`) reads card/account state before writing, decides whether to refuse based on that pre-state, performs the write, then re-reads after the write — and returns `preState` and `postState` fields in its result body. The library enforces only the batch-shape opts (`soleStep` / `soleOnExecute`) and the lifecycle gates (`requiresConfirmation`, `requiresOtp`, `requiresMatch`, `requiresFlow`).

**4. Library-managed state slots are off-limits to executors.** `awaitingInput` and `currentFlow` are written by the runner in response to per-action opts (`requiresConfirmation` / `issuesOtp` / `requiresOtp` / `startsMatchFor` / `requiresMatch` / `startsFlow` / `endsFlow` / `requiresFlow`) and to the executor's return-value hooks (`flowData`, `lifecycle.issuesOtp`, `lifecycle.clearAwaitingInput`, `lifecycle.abortFlow`). Executors must never put these slots in `stateUpdate`.

**5. Plan before writing.** Always produce a written plan first: action list, params schemas, prereqs per action, mutation opts (confirmation / OTP / match / flow), new state slots needed, new prompt fragments needed. Get user confirmation. THEN write files. Never start with file writes — the plan is the cheap review surface.

**6. Voice-safe by default.** This project's agent is a voice agent (TTS-spoken output). Executor result bodies are LLM-facing JSON (fine to be verbose, numeric, terse). The prompt edits MUST keep the voice rules — no markdown, no URLs, no digit numerals in spoken text, no echoing of full secrets (PIN plaintext, OTP digits the customer just read back). When a list result masks an identifier, still carry a voiceable **selection key** (a tail, a code) so the user's reference maps to an item. References cover this explicitly.

**7. Identity has two models — don't force the wrong one.** Either collect-and-verify (for mutations / proof-of-identity) OR session-context (identity passed in at invoke, for pre-authenticated / read-only tools — no verify action, a `sessionReady` presence check). Match the tool. See `identity-patterns.md`.

**8. Reads should be self-sufficient; the surface is for the user, not the backend.** Prereqs are safety gates, not sequencing hints — a read action should load what it needs rather than gate on a prior step, and the prompt must never report "none" from a slot that may simply be unloaded. Design actions around the user task: fold endpoint boundaries (list→details) into one action, keep sibling entity types symmetric. For a large/list read, declare `pageable` (the runner handles paging + the `pagedRead` cache) rather than hand-rolling pagination. See `executor-patterns.md`, `read-tool-patterns.md`, `input-formats.md`.

**9. Paradigm, not blueprint.** The bundled `templates/` (plus `templates/agent-step/`) and this skill's references are the ONLY structural source of truth. When you are handed an existing or reference project — especially in port mode — treat it strictly as a *domain spec* (what capabilities the tool must offer, which backend endpoints, which business rules, which identity model). Never inherit its file structure, abstractions, control flow, layering, or naming idioms verbatim. Re-derive the action surface, state slots, and wiring from the agent-step paradigm every time. A referenced project tells you *what*, never *how*.

**10. The sandbox is part of the deliverable.** Every project carries a `sandbox/` directory at its root: a standalone local API service mimicking the backend APIs the tools call (never AI resources — LLM endpoints and search indexes stay real). It exposes lifecycle CRUD at `POST/GET /sandbox` + `GET/PUT/DELETE /sandbox/:sandboxId` (POST accepts an optional `{ "sandboxId" }` body), isolates all domain endpoints by a required case-insensitive `Sandbox-Id` header, and supports seeding a sandbox's data model from JSON (`PUT /sandbox/:id`) — the seed-reset cycle the sandbox tests depend on. When bootstrapping or porting, acquire it best-effort: reuse a compliant one from the reference project, else adapt a near-miss, else build it from a Postman collection, else from specs. See `sandbox-contract.md`.

**11. Prereqs express journey progress; `invalidatesOnChange` keeps it coherent.** A prereq is a snapshot of *where the user is* in their journey — identity acquired, entity selected, flow open — not a record of which step ran first (that distinction is principle #8). You model journey state by adding a state slot plus the verifier predicate that gates on it. When an upstream slot changes mid-journey (the user re-identifies, or picks a different entity), declare `ActionDef.invalidatesOnChange` so stale downstream journey slots are cleared automatically — this is a library-provided option at your disposal, not something an executor hand-rolls. See the `<invalidates_on_change>` section of `agent-step-api.md`.

**12. The channel wire contract is bootstrap-level, not per-tool.** Every generated agent assumes a fronting channel middleware: identity arrives in the invoke input as snake_case `user_id` / `customer_code` / `role` (absent ⇒ `undefined` — coerce with `?? null` before writing into validated structures), and channel handoffs are signalled via the `pendingHandoff` slot + the post-model hook in `agent.ts` that stamps the final reply with the `is_handoff` `additional_kwargs` contract. These ship in the bootstrap templates — never rename the fields, never strip the hook. Agents are role-typed at bootstrap: an **orchestrator** hands off to the specialized agents (in-domain topics are handled or routed, never refused; out-of-domain gets a one-line steer-back, not a goodbye) via a `soleStep` tool action following `templates/executor-handoff.ts.template`; a **specialized** agent hands back ONLY to the orchestrator with `handoff_type` ∈ {`completed`, `abandon`, `off_topic`} — preferably via the library built-in (`buildAgentStepTool({ handoff })`, agent-step ≥ 1.3.0, which also delegates off-topic turns to a general agent while KEEPING the conversation). Both mechanisms emit the same kwargs contract. See `streaming-and-channel-contract.md`.

</essential_principles>

<intake>
**Ask the user:**

What do you want to do?

1. **Bootstrap a new project** — empty target directory, you want the full scaffold (package.json, tsconfig, agent-step library, graph/agent/state/prompt skeleton, streaming CLI, Dockerfile, build_and_push.sh). After this, the project is agent-shaped but tool-empty.
2. **Add a tool** to an existing project — `src/agent-step/` already exists in the cwd; you have backend API specs and/or a functionality description for the new tool.
3. **Extend an existing tool** — add new actions/mutations to a tool that already exists under `src/tools/<name>/`.
4. **Port an existing project** — you have a pre-agent-step project (any framework) and want to re-platform its capabilities onto agent-step. The source project is read as a *domain spec only* (principle #9); its architecture is never copied. See `workflows/port-project.md`.

**Skip the intake if the user's request makes the intent obvious** (e.g. "bootstrap a new project at /path/X" → go straight to bootstrap; "create a tool named accounts" → go straight to create-tool; "port this project to agent-step" → go straight to port).

**For bootstrap, also ask** (full definitions + role follow-ups in `workflows/bootstrap-project.md` Step 1): project directory (absolute path), project name (kebab-case), agent display name, one-line description, voice or chat, **agent language** (never assume), **agent role** (orchestrator / specialized / standalone) **plus its follow-ups** — specialized: off-topic resolution (terminate / delegate) + envelope message + delegate target; orchestrator: does the agreed service catalog exist — **behind the channel middleware?**, ACR registry + image name, sandbox source.

**For tool, also ask:** tool name (snake-case directory name) and one-sentence domain summary. **Conditional asks at their trigger points in the workflow:** identity model (pre-authenticated session-context vs collected-and-verified) when the specs leave it ambiguous; whether users will ask open-ended aggregate questions (the analysis action is a product decision, not derivable from specs); handoff mechanism + off-topic mode for handoff actions (if not captured at bootstrap); backend-pages vs self-paginate when the spec is ambiguous.

**Wait for response before proceeding.**
</intake>

<routing>
| Response | Workflow |
|----------|----------|
| 1, "bootstrap", "new project", "from scratch" | `workflows/bootstrap-project.md` |
| 2, "add a tool", "new tool" | `workflows/create-tool.md` |
| 3, "extend", "add action to existing" | `workflows/create-tool.md` (uses ADD-MODE branch) |
| 4, "port", "migrate", "re-platform", "onto agent-step" | `workflows/port-project.md` |

**After reading the workflow, follow it exactly.**
</routing>

<quick_reference>
**Tool directory layout (canonical):**
```
src/tools/<name>/
├── config.ts                              # defineConfig({ tool, actions }); export type ActionName — lifecycle opts inline on ActionDef.controller
├── index.ts                               # buildAgentStepTool wire-up (selectors + executors + verifiers, keyed by action name)
├── actions/<action_name>/stateSelector.ts # one per action; exports getSlice + Slice (projects state → slice)
├── actions/<action_name>/executor.ts      # one per action; receives the slice
├── verifiers/<prereq-name>.ts             # one per prereq; exports record
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

**Local sandbox (required; see `sandbox-contract.md`):**
```
sandbox/                     # root-level standalone service mimicking the tools' backend APIs
├── package.json             # self-contained; starts with one command
├── src/                     # lifecycle CRUD (/sandbox) + domain controllers (Sandbox-Id header)
└── seeds/                   # optional checked-in boot seeds; tests seed explicitly via PUT
```
The sandbox tests can't run without it. If a new tool calls a backend the sandbox doesn't model, extend the sandbox — never stub in-process.

**Keeping journey state coherent:** when an action writes an upstream slot that downstream journey state depends on, declare `invalidatesOnChange` on that action (in `config.ts`) so the runner clears the stale downstream slots when the upstream value actually changes — don't re-clear them by hand in an executor. See the `<invalidates_on_change>` section of `agent-step-api.md`.

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
- **streaming-and-channel-contract.md** — The middleware wire contract: invoke-input field names, the channel-handoff `additional_kwargs` contract, the orchestrator-vs-specialized agent roles (incl. the completed / abandon / off_topic handback signals, the off-topic policy, and the two handoff mechanisms — scaffold tool action vs the agent-step ≥ 1.3.0 library built-in with delegate mode), the verified LangGraph JS streaming event order (tokens vs `updates`, where `is_handoff` appears), the post-model annotator, and UX/testing guidance. Read when the tool includes a channel-handoff action, or when integrating/debugging an agent behind a channel middleware — the doc doubles as the middleware developers' adherence checklist.
- **data-analysis-pattern.md** — The LLM-authored-compute pattern (executor Pattern 9): an analyze action takes a JS snippet param, the host runs it in a `node:vm` over the in-state datasets; single-source-of-truth datasets module feeding VM + prompt schema + live data block; the state-dependent prompt upgrade; security posture. Read when the tool answers open-ended aggregate questions (totals / group-by / top-N) over fetched data.
- **project-bootstrap-structure.md** — Top-level project layout produced by the bootstrap workflow; what each scaffold file is for.
- **sandbox-contract.md** — The required root `sandbox/` service: lifecycle CRUD (`/sandbox` routes), `Sandbox-Id` header isolation, mandatory JSON seeding for tests, the acquisition ladder (reference project → adapt → Postman → specs), APIs-only scope, compliance checklist.
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| bootstrap-project.md | Scaffold a brand-new project: package.json, tsconfig, agent-step library copy, graph/agent/state/prompt skeleton, streaming CLI, Dockerfile, build script. Empty tools — runs `create-tool` next. |
| create-tool.md | Build a new tool inside an existing project, or extend an existing tool with new actions. Parse inputs → plan → user confirms → write files → verify. |
| port-project.md | Re-platform an existing (non-agent-step) project onto agent-step: read the source as a domain spec only, bootstrap if needed, then derive tools fresh via `create-tool.md`. Never copies the source's architecture. |
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
- `agent-step/types.ts`, `agent-step/state.ts`, `agent-step/runner.ts`, `agent-step/runner.test.ts`, `agent-step/paginate.ts`, `agent-step/paginate.test.ts`, `agent-step/define-config.ts`, `agent-step/index.ts`
- `agent-step/VERSION` — the library version marker. Bumped by `/bump-version` when the embedded copy is refreshed; read by `/pull-library` to upgrade a downstream project's vendored copy. Travels into every bootstrapped project at `src/agent-step/VERSION`.

**Tool scaffold** (used by create-tool.md):
- `config.ts.template`, `tool-index.ts.template`, `verifier.ts.template`
- `state-selector.ts.template` (per-action `stateSelector.ts` — `getSlice` + `Slice`)
- `executor-read.ts.template`, `executor-mutation.ts.template`
- `executor-read-paginated.ts.template` (large/list read via the library `pageable` opt — runner injects page/pageSize, slices, and caches in the `pagedRead` slot)
- `executor-handoff.ts.template` (channel-handoff action — validates the target service, writes the `pendingHandoff` slot the bootstrap `agent.ts` hook stamps onto the final reply; `soleStep`; see `references/streaming-and-channel-contract.md`)
- `backend-env.ts.template`, `backend-client.ts.template`
- `plan.md.template` (proposed-plan document the workflow writes before file edits)

**Data-analysis scaffold** (LLM-authored compute over fetched data — executor Pattern 9; see `references/data-analysis-pattern.md`):
- `executor-analysis.ts.template` (the analyze action's executor — runs an LLM-authored JS snippet via the VM)
- `analysis-vm.ts.template` (`shared/analysis-vm.ts` — the constrained `node:vm` runner; largely domain-agnostic)
- `datasets.ts.template` (`shared/datasets.ts` — the single source of truth: `DATASETS` schema + `buildDatasets` + `buildDataSummary`, feeding the VM, the static prompt schema, and the live data block)
- `verifier-data-loaded.ts.template` (the `dataLoaded` prereq — refuse analysis until some dataset is populated)

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
