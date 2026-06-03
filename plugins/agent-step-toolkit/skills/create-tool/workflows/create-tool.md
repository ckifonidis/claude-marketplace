# Workflow: Create (or Extend) an Agent-Step Tool

<required_reading>
Read these reference files NOW, in this order:
1. `references/agent-step-api.md` — the runner contract you'll be coding against
2. `references/tool-directory-layout.md` — canonical file layout
3. `references/input-formats.md` — how to turn the user's inputs into an action list
4. `references/executor-patterns.md` — read vs mutation executor shapes
5. `references/state-and-prompt-integration.md` — graph-level wiring
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
- **mutation?** — if yes: pick `soleStep` (strict alone) or `soleOnExecute` (propose may ride; execute alone); plus `requiresConfirmation` opts (maxAttempts, ttlMs, lockdown) if confirm-required
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
- transfer_funds: soleOnExecute=true, requiresConfirmation={maxAttempts:3, ttlMs:300_000}

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

## Step 5: Validate

Run these in order. Stop on first failure and fix root cause:

```bash
npx tsc --noEmit
```
Expected: zero errors in the new tool's files. (Unrelated WIP errors in other dirs are fine to ignore — flag them to the user.)

```bash
npx tsc && node --test dist/agent-step/runner.test.js
```
Expected: all 20 runner tests still pass. The new tool shouldn't affect them.

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
- [ ] Runner unit tests still pass (20/20)
- [ ] Dev server starts without construction-time errors
- [ ] At least one read scenario verified end-to-end in `npm run cli`
- [ ] (If mutations) one propose → execute lifecycle verified end-to-end
- [ ] User signed off on the deliverable
</success_criteria>
