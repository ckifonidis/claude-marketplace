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
- **backend endpoints touched** — for the executor's implementation

Then derive:
- **prereq verifiers** needed (one per unique prereq name; e.g. `customerVerified`, `accountVerified`)
- **state slots** the executors will write to (e.g. `verifiedCustomer`, `verifiedAccounts`)

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

## Multi-turn flows (if any)
- transfer_otp_flow: opened by request_transfer (startsFlow + issuesOtp→confirm_otp), closed by commit_transfer (endsFlow)

## Backend env vars (per-tool, in backend/env.ts)
- ACCOUNTS_API_BASE_URL
- TRANSFER_API_BASE_URL
- ... + envelope/auth fields shared with cards

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
3. `src/tools/<name>/shared/` — any shared helpers (e.g. resolve-entity); create only if multiple actions need them
4. `src/tools/<name>/verifiers/<prereq>.ts` — one file per unique prereq (see `templates/verifier.ts.template`)
5. `src/tools/<name>/actions/<action>/executor.ts` — one directory per action (see `templates/executor-read.ts.template` or `executor-mutation.ts.template`)
6. `src/tools/<name>/config.ts` — pure data (see `templates/config.ts.template`)
7. `src/tools/<name>/index.ts` — wire-up (see `templates/tool-index.ts.template`)

Then graph-level wiring:

8. `src/state.ts` — add the per-tool state slots with explicit reducers (`awaitingInput` and `currentFlow` are already declared by the bootstrap; reuse them)
9. `src/tools/index.ts` — register the new tool in the `tools` array
10. `src/prompt.ts` — add ACTIONS block(s) and (if mutations exist) extend MUTATION SAFETY

## Step 4b: Scaffold the tool's tests

The shared test harness (`src/test-harness/`) already exists from bootstrap. Scaffold THIS tool's tests against it — this is what makes the tool's behaviour verifiable at the sandbox and prompt-input layers. The `test-agent-step` skill is the authority on the methodology (three layers, what to assert / not, coverage bars, findings); these templates are its starting points.

Create under `src/tools/<name>/tests/`:

1. `tests/tool/_setup.ts` ← `templates/tool-test-setup.ts.template` — wire `toolOpts` (config + stateAnnotation + executors + verifiers, mirroring `index.ts`), `seedState`, and `resetToSeed` (adapt the reset to the backend's sandbox protocol).
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
npx tsc && node --test dist/agent-step/runner.test.js
```
Expected: all runner unit tests still pass (currently 53). The count may grow as the library evolves — what matters is zero failures. The new tool shouldn't affect them.

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
- `executors["xxxX"]` missing → action name doesn't snake-to-camel to that key
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
- [ ] The tool's tests exist (Step 4b): `tests/tool/_setup.ts` + seed, a sandbox test per action, a prompt-input test per routing decision, and both `FINDINGS.md` files
- [ ] Runner unit tests still pass (zero failures)
- [ ] `npm run test:sandbox` passes for the new tool (each test green, or any failure triaged as a `FINDING:` in `tests/tool/FINDINGS.md`)
- [ ] Dev server starts without construction-time errors
- [ ] At least one read scenario verified end-to-end in `npm run cli`
- [ ] (If mutations) one propose → execute lifecycle verified end-to-end
- [ ] User signed off on the deliverable
</success_criteria>
