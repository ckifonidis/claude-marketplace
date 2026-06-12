# Workflow: Create (or Extend) an Agent-Step Tool

<required_reading>
Read these reference files NOW, in this order:
1. `references/agent-step-api.md` — the runner contract you'll be coding against
2. `references/tool-directory-layout.md` — canonical file layout
3. `references/input-formats.md` — how to turn the user's inputs into an action list
4. `references/executor-patterns.md` — read vs mutation executor shapes, reference resolution, self-sufficient reads, compute/analysis
5. `references/state-and-prompt-integration.md` — graph-level wiring

Also read when applicable:
- `references/identity-patterns.md` — if the tool is pre-authenticated / doesn't collect identity.
- `references/read-tool-patterns.md` — if the tool is search / browse / history / analytics-heavy.
- `references/data-analysis-pattern.md` — if the tool must answer open-ended aggregate questions (totals / group-by / top-N) over fetched data via an LLM-authored snippet (executor Pattern 9).
- `references/sandbox-contract.md` — if the root `sandbox/` doesn't yet model every backend service this tool calls (you'll be extending it before the sandbox tests can run).
- `references/streaming-and-channel-contract.md` — if the tool includes a CHANNEL-HANDOFF action (transferring the caller to another service/agent/human), or if the agent will be deployed behind a channel middleware and you need the streaming/wire contract (the reference doubles as the middleware developers' adherence checklist; it also defines the orchestrator-vs-specialized agent roles and the completed / abandon / off_topic handback signals).
</required_reading>

<process>
## Step 1: Gather raw materials

Confirm from the intake answers:
- Tool name (snake-case, will be the directory under `src/tools/`)
- One-sentence domain summary
- Backend API spec(s) — read them, or fetch URLs the user gave
- Functionality description — read every doc the user pointed at
- Branch: NEW tool or EXTEND existing tool?

For EXTEND-mode: read the existing tool's `config.ts`, `actions/`, `verifiers/`, and state slots first. Treat the existing tool as immutable infrastructure and add to it.

## Step 2: Derive the action list

Apply `references/input-formats.md` to translate the user's description into:

For each action, capture:
- **action name** (snake_case, becomes the `action` literal in the discriminated union)
- **description** (1–3 sentences, LLM-facing — what the action does, what verdicts/states it can return, what it changes in session state)
- **params schema** (Zod) — only fields the LLM should send
- **prereqs** — list of named state predicates the runner checks before invoking
- **mutation?** — if yes: pick `soleStep` (strict alone) or `soleOnExecute` (propose may ride; execute alone); plus `requiresConfirmation` opts (`maxAttempts` default 3; `lockdown` default true — `ttlMs` exists but is currently inert, don't set it) if confirm-required
- **lifecycle opts?** — if the action is part of a multi-turn flow: `startsFlow` / `endsFlow` / `requiresFlow`; OTP: `issuesOtp` / `requiresOtp`; double-entry: `startsMatchFor` / `requiresMatch`
- **invalidatesOnChange?** — if the action writes an upstream slot that downstream journey state depends on (e.g. re-identifying a customer should drop the previously-selected card), declare which downstream slots to clear when that slot's value changes. The runner clears them automatically — don't re-clear in an executor. See `agent-step-api.md` `<invalidates_on_change>`.
- **backend endpoints touched** — for the executor's implementation. Check each against the root
  `sandbox/`: any endpoint the sandbox doesn't model yet goes on a "sandbox extensions" list in the
  plan — it must be added (per `references/sandbox-contract.md`) before the tool's sandbox tests can
  run. Never stub the backend in-process instead.

Then derive:
- **prereq verifiers** needed (one per unique prereq name; e.g. `customerVerified`, `accountVerified`)
- **state slots** the executors will write to (e.g. `verifiedCustomer`, `verifiedAccounts`)

**Ask the user (don't guess) when the specs leave these ambiguous:**
- **Identity model** — pre-authenticated session-context (middleware-injected `user_id` / `customer_code`; see `references/identity-patterns.md`) vs collected-and-verified? Shapes the verifiers, state slots, and the anonymous-caller test case.
- **Analysis action** — will users ask open-ended aggregate questions (totals / group-by / top-N) over this tool's data? A product decision, not derivable from an API spec; yes ⇒ step 6b.
- **Pagination mode** for large list reads — does the backend page (`pageable: "delegate"`), or do we fetch the full set and self-paginate (`pageable: true`)?

## Step 3: Write the plan

Produce a single short markdown plan with these sections (concrete values, not placeholders):

```
# Tool Plan: <name>

## Actions
| name | params | prereqs | mutation? | summary |
|------|--------|---------|-----------|---------|
| verify_customer | taxNo, name, patronymic | — | no | Identify customer by AFM + name |
| list_accounts | (none) | customerVerified | no | Enumerate customer accounts |
| ... | ... | ... | ... | ... |

## Verifiers
- customerVerified: state.verifiedCustomer != null
- accountVerified: state.activeAccountNumber != null && state.verifiedAccounts[active] != null

## State slots (additions to src/state.ts)
- verifiedAccounts: Record<string, VerifiedAccount> (record-by-key merge)
- activeAccountNumber: string | null (replace-on-write)
- awaitingInput + currentFlow: already declared by the bootstrap

## Mutations
- transfer_funds: soleOnExecute=true, requiresConfirmation={maxAttempts:3}

## Downstream invalidation (invalidatesOnChange — only if any)
- verify_customer: { verifiedCustomer: ["verifiedAccounts", "activeAccountNumber"] }  # re-identifying clears the prior account selection

## Multi-turn flows (if any)
- transfer_otp_flow: opened by request_transfer (startsFlow + issuesOtp→confirm_otp), closed by commit_transfer (endsFlow)

## Backend env vars (per-tool, in backend/env.ts)
- ACCOUNTS_API_BASE_URL
- TRANSFER_API_BASE_URL
- ... + envelope/auth fields shared with the project's existing tool(s)

## Sandbox extensions (only if any — endpoints the root sandbox/ doesn't model yet)
- POST /accounts/fetchList — new accounts controller, envelope per backend spec

## Prompt edits
- src/prompt.ts ACTIONS section: append accounts actions
- MUTATION SAFETY: add transfer_funds if applicable

## tools/index.ts
- add: import { accountsTool } from "./accounts/index.js";
- add to tools array
```

Present the plan to the user and **wait for explicit go-ahead** before writing files. Iterate on the plan if they want adjustments.

## Step 4: Write files (after user confirms plan)

Use the `templates/` files as starting points. Fill in concrete values from the plan. Create files in this order so each subsequent file can reference what's already created:

1. `src/tools/<name>/backend/env.ts` — env constants (see `templates/backend-env.ts.template`)
2. `src/tools/<name>/backend/client.ts` — HTTP helper (see `templates/backend-client.ts.template`; adapt to backend protocol)
3. `src/tools/<name>/shared/` — any shared helpers (e.g. resolve-entity); create only if multiple actions need them. (Pagination needs no shared helper — it's a library opt; see step 6.)
4. `src/tools/<name>/verifiers/<prereq>.ts` — one file per unique prereq (see `templates/verifier.ts.template`)
5. `src/tools/<name>/actions/<action>/stateSelector.ts` — one per action; exports `getSlice` + `Slice` (see `templates/state-selector.ts.template`). Narrow to the slots the action reads.
6. `src/tools/<name>/actions/<action>/executor.ts` — one per action; imports its `Slice` from `./stateSelector.js`. Pick by shape: `templates/executor-read.ts.template` (fixed-size read), `templates/executor-read-paginated.ts.template` (large/list read — declare `pageable` on the action with a `z.object` params schema; the runner injects `page`/`pageSize`, slices, and caches in the library `pagedRead` slot — no per-tool state slot or cache helper needed), `templates/executor-mutation.ts.template` (mutation), `templates/executor-handoff.ts.template` (channel handoff — see step 6c), or `templates/executor-analysis.ts.template` (LLM-authored compute over fetched data — see step 6b).

6b. **Analyze action (only if the tool answers open-ended aggregate questions over fetched data).** Follow `references/data-analysis-pattern.md` and add, alongside the read/mutation actions:
   - `src/tools/<name>/shared/datasets.ts` ← `templates/datasets.ts.template` — the single source of truth (`DATASETS` schema + `buildDatasets` + `buildDataSummary`). Its dataset keys are the variable names the snippet sees and the prompt documents.
   - `src/tools/<name>/shared/analysis-vm.ts` ← `templates/analysis-vm.ts.template` — the `node:vm` runner (mostly verbatim; wire its `DatasetSource` import + injection list to your datasets). **Read the security note** — `node:vm` is not a hardened sandbox; ship it only for a trusted-author surface.
   - `src/tools/<name>/verifiers/data-loaded.ts` ← `templates/verifier-data-loaded.ts.template` — the `dataLoaded` prereq (OR-join a presence check per analyzable slot).
   - The analyze action's `stateSelector.ts` returns the `DatasetSource` slice (the cache slots only — no session/identity context).
   - In `src/state.ts`, export a `DatasetSource = Pick<State, ...>` over the analyzable slots (the slice both the selector and `buildDatasets` consume).
   - **Prompt upgrade (required):** make `src/prompt.ts` state-dependent — inject a static `# DATA SCHEMA` (from `DATASETS`) and a live `# AVAILABLE DATA` block (from `buildDataSummary(state)`). The bootstrap prompt is static; see the `<prompt_wiring>` section of the reference for the exact edit.
6c. **Channel-handoff action (only if the tool transfers the caller to other services/agents).** Follow `references/streaming-and-channel-contract.md` (incl. its `<agent_roles>` section) and add, alongside the other actions:
   - **Ask first, if not captured at bootstrap:** for a SPECIALIZED agent — off-topic resolution (`terminate` / `delegate`), the envelope message (in the agent's language), the delegate target (URL + assistant id + `replyNode` for voice) and what `delegateInput` forwards, and whether a hand-rolled graph is acceptable (the library built-in needs it; staying on `createReactAgent` forces the scaffold fallback). For an ORCHESTRATOR — the agreed service catalog (target names = the middleware's registry + client-side types, strictness tiers, success messages in the agent's language, guardrails). Check `.env.example`'s `HANDOFF_*` block for answers bootstrap already recorded.
   - **The agent's role (a bootstrap fact) picks the mechanism.** ORCHESTRATOR: the scaffold tool action below — targets are the specialized agents (agent-name `serviceType`s) plus any client-side types, outbound routing, spoken transition. SPECIALIZED (agent-step ≥ 1.3.0): prefer the **library built-in** — no per-tool action at all; opt in via `buildAgentStepTool({ handoff: spec })`, write the env→spec module, and wire the `resolve_handoff` node + conditional edge into a hand-rolled graph (see `agent-step-api.md` `<handoff>`); this also buys delegate mode (route an off-topic turn to a general agent and KEEP the conversation). The scaffold alternative for a specialized agent that stays on `createReactAgent` and needs only signals: a handback tool action with params `{ signal: z.enum(["completed","abandon","off_topic"]), reason: z.string() }`, the executor mapping `serviceType` = the signal value, with a per-signal `successMessage` (the completed wrap-up line, the abandon acknowledgement, the off_topic "let me get you back" line).
   - `src/tools/<name>/shared/handoff-services.ts` — the service catalog: `{ name, serviceType, confidenceThreshold, successMessage, … }` per target (for a specialized agent: per signal), with voice/chat-safe success messages, plus call-time env enablement (`handoffEnabled()` / `isServiceEnabled()` reading `HANDOFF_ENABLED` / `HANDOFF_TOOLS` at call time so the disabled path is testable). `serviceType` values are a shared vocabulary with the fronting middleware (its agent registry / client-side handoff types configuration) — agree them with the middleware developers; the three handback signal names are part of that vocabulary.
   - The handoff action's executor ← `templates/executor-handoff.ts.template`. Its `resultBody` MUST carry `isHandoff: true` on the ok verdict (the bootstrap `agent.ts` hook keys off it) and `successMessage`; its `stateUpdate` writes the bootstrap `pendingHandoff` slot (already in `state.ts` — do not redeclare). Identity fields are coerced `?? null`.
   - Config: `controller: { soleStep: true }`; params `{ service: z.enum([...catalog names]), reason: z.string() }` (orchestrator) or the `{ signal, reason }` shape above (specialized).
   - Guardrails (e.g. business-hours gating for a human-escalation target) are executor pre-checks returning a structured refusal verdict — the prompt teaches the recovery.
   - Prompt: a HANDOFF section. ORCHESTRATOR: strictness tiers per target (high threshold ⇒ explicit request only; when in doubt answer from the knowledge surface first). SPECIALIZED: the triggers for the three signals — they're already outlined in the bootstrap OFF-TOPIC POLICY section; the HANDOFF section binds each to the handback action. Both roles: speak the returned `successMessage` then STOP (no closing question), and recoveries for `service_disabled` / guardrail verdicts.
   - Do NOT touch `agent.ts` — the post-model annotator hook is already there from bootstrap and activates automatically once `pendingHandoff` is written.
   - Resolve the prompt's role-conditional leftovers now if bootstrap left the standalone defaults: the SCOPE closer and the CHANNEL CONSTRAINTS "no transfer mechanism" line must match the role (the placeholders in `prompt.ts.template` name the exact replacements).
7. `src/tools/<name>/config.ts` — pure data; `export type ActionName` (see `templates/config.ts.template`)
8. `src/tools/<name>/index.ts` — wire-up: `selectors` (`satisfies SelectorRegistry<State, ActionName>`) + `executors` (`ExecutorRegistry<State, typeof selectors>`), both keyed by action name (see `templates/tool-index.ts.template`)

Then graph-level wiring:

9. `src/state.ts` — add the per-tool state slots with explicit reducers (`awaitingInput` and `currentFlow` are already declared by the bootstrap; reuse them). Ensure `export type State = typeof AgentState.State;` is present — selectors and executors import it.
10. `src/tools/index.ts` — register the new tool in the `tools` array
11. `src/prompt.ts` — add ACTIONS block(s) and (if mutations exist) extend MUTATION SAFETY

## Step 4a: Extend the sandbox (if the plan flagged sandbox extensions)

If Step 2 found backend endpoints the root `sandbox/` doesn't model, add them now, per
`references/sandbox-contract.md`: a controller per service mirroring the real backend's
paths/payloads/envelopes/errors, reading the active sandbox from the `Sandbox-Id` header, backed by
the sandbox's entity store so `PUT /sandbox/:id` JSON seeding reaches it. If there is no `sandbox/`
at all (deferred at bootstrap), establish it first via the acquisition ladder — the sandbox tests in
Step 4b cannot run without it.

## Step 4b: Scaffold the tool's tests

The shared test harness (`src/test-harness/`) already exists from bootstrap. Scaffold THIS tool's tests against it — this is what makes the tool's behaviour verifiable at the sandbox and prompt-input layers. The `test-agent-step` skill is the authority on the methodology (three layers, what to assert / not, coverage bars, findings); these templates are its starting points.

Create under `src/tools/<name>/tests/`:

1. `tests/tool/_setup.ts` ← `templates/tool-test-setup.ts.template` — wire `toolOpts` (config + stateAnnotation + selectors + executors + verifiers, mirroring `index.ts`; selectors and executors keyed by action name), `seedState`, and `resetToSeed` (adapt the reset to the backend's sandbox protocol).
2. `tests/tool/seed.json` ← `templates/tool-seed.json.template` — the canonical seed `resetToSeed` resets to.
3. `tests/tool/<action>.test.ts` ← `templates/tool-sandbox-test.ts.template` — one sandbox test file per action (or per cohesive action group). Fill the coverage bar: happy verdict, each terminal verdict, one short-circuit, plus any flow-controller mode the action declares.
4. `tests/tool/FINDINGS.md` ← `templates/findings.md.template` (substitute `{{LAYER}}` = `sandbox`).
5. `tests/prompt-input/<topic>.test.ts` ← `templates/prompt-input-test.ts.template` — one file per routing decision. Imports ONLY from the shared prompt-input harness.
6. `tests/prompt-input/FINDINGS.md` ← `templates/findings.md.template` (substitute `{{LAYER}}` = `prompt-input`).

Per-slice rhythm (from `test-agent-step`): write the sandbox test against the executor BEFORE the prompt-input test, so the model is graded against a stable runner contract. The runner's own unit tests already cover flow-controller mechanics — only add a runner unit test for a genuinely new mode combination.

## Step 5: Validate

Run these in order. Stop on first failure and fix root cause:

```bash
npx tsc --noEmit
```
Expected: zero errors in the new tool's files. (Unrelated WIP errors in other dirs are fine to ignore — flag them to the user.)

```bash
npx tsc && node --test dist/agent-step/*.test.js
```
Expected: all library unit tests still pass (currently 79: runner + paginate + handoff). The count may grow as the library evolves — what matters is zero failures. The new tool shouldn't affect them.

```bash
npm run test:sandbox
```
Expected: the new tool's sandbox tests pass (requires the local sandbox running and the tool's `*_BASE_URL` env pointed at it). These prove the runner + executors behave correctly given explicit step batches — no LLM. A real failure is a finding, not a flake: promote it to a `FINDING:` and document it in `tests/tool/FINDINGS.md` rather than relaxing the assertion. See the `test-agent-step` skill for the full methodology.

```bash
npm run test:prompt   # optional here — live model, costs money
```
Expected (when run): the prompt routes user utterances to the right steps/params. Gated behind `PROMPT_INPUT_LIVE` (the script sets it). Run when you've added or changed a prompt section that routes to this tool.

```bash
npm run dev
```
Expected: the dev server starts cleanly. If it throws `agent-step: ...` at startup, the construction-time check caught a misconfig — fix and retry. Common causes:
- `selectors["xxx"]` missing → the `selectors` registry lacks an entry keyed by that exact action name
- `executors["xxx"]` missing → the `executors` registry lacks an entry keyed by that exact action name (keys are the action name, not a camelCase function name)
- `verifiers["xxx"]` missing for an action's prereq
- action `abort_pending_input` declared (reserved name — library auto-injects it)
- a `controller` hook (e.g. `issuesOtp.consumer_action`, `requiresMatch.capturer`) names an action that doesn't exist

```bash
npm run cli
```
Drive the tool through one read scenario and (if mutations exist) one mutation propose → execute flow. Verify:
- Tool calls match what the prompt teaches
- `/state` shows the new state slots populating
- For mutations: `awaitingInput` transitions null → `{ kind: "confirmation", ... }` → null across propose / execute
- For multi-turn flows: `currentFlow` transitions null → `{ name: "...", data: { ... } }` → null across open / commit; `awaitingInput.kind` cycles through `otp` / `match` as appropriate

## Step 6: Optional — commit

Ask the user if they want a commit. If yes, propose a single bundled commit covering the new tool directory + the three patched graph files (state.ts, tools/index.ts, prompt.ts). Use a descriptive message naming the tool and listing the action set.
</process>

<success_criteria>
Workflow complete when:
- [ ] Plan was written and explicitly confirmed by the user
- [ ] All files in Step 4 exist and typecheck clean
- [ ] The sandbox models every backend endpoint the tool calls (Step 4a extensions applied if the plan flagged any)
- [ ] The tool's tests exist (Step 4b): `tests/tool/_setup.ts` + seed, a sandbox test per action, a prompt-input test per routing decision, and both `FINDINGS.md` files
- [ ] Runner unit tests still pass (zero failures)
- [ ] `npm run test:sandbox` passes for the new tool (each test green, or any failure triaged as a `FINDING:` in `tests/tool/FINDINGS.md`)
- [ ] Dev server starts without construction-time errors
- [ ] At least one read scenario verified end-to-end in `npm run cli`
- [ ] (If mutations) one propose → execute lifecycle verified end-to-end
- [ ] User signed off on the deliverable
</success_criteria>
