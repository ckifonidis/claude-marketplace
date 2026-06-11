# Reference: Graph-Level Integration (state.ts, prompt.ts, tools/index.ts)

<overview>
A new tool requires three graph-level patches: declaring state slots, registering the tool, and teaching the prompt about new actions. The library does NOT handle any of these — you do them by hand (or via this skill).
</overview>

<state_ts>
## src/state.ts

Add per-tool state slots using LangGraph's `Annotation<T>({ reducer, default })`. The runner extracts each reducer at runtime via `BinaryOperatorAggregate.operator`, so:

- **Always provide an explicit reducer** — even for replace-on-write. Without one, the field gets the default LangGraph behavior (replace-on-write through the `LastValue` channel), which is fine but inconsistent with the explicit pattern the project uses.
- **Use record-by-key merge** when multiple identities can be cached. Example: `verifiedCards: Record<string, VerifiedCard>` merges so successive verifications accumulate.
- **Use replace-on-write** for scalar selections. Example: `activeCardNumber: string | null`.

Pattern:

```ts
// types for the new tool's domain data
export interface VerifiedAccount {
  accountNumber: string;
  iban: string;
  balance: string;
  // ...
}

// In AgentState:
verifiedAccounts: Annotation<Record<string, VerifiedAccount>>({
  reducer: (a, b) => ({ ...(a ?? {}), ...(b ?? {}) }),
  default: () => ({}),
}),

activeAccountNumber: Annotation<string | null>({
  reducer: (_, n) => n ?? null,
  default: () => null,
}),
```

## Session-context identity slots (pre-authenticated tools)

If the tool receives identity as run context rather than collecting it (see `identity-patterns.md`), declare those fields with a **preserve-initial** reducer so the value set on the first turn survives later turns and isn't clobbered by an empty update:

```ts
sessionUserKey: Annotation<string | null>({
  reducer: (prev, next) => prev ?? next,   // first non-null wins
  default: () => null,
}),
```

And remember: a default — even one reading an env var — does **not** fill state. The **caller must pass these fields in the invoke input on every run**; the launcher (CLI, server handler, scheduler) owns reading the environment/request and threading them in. A `sessionReady` verifier then just checks presence.

## Library-managed slots (awaitingInput + currentFlow + pagedRead)

`awaitingInput` / `currentFlow` are required whenever the new tool declares any lifecycle opt on a mutation (`requiresConfirmation`, `requiresOtp`, `issuesOtp`, `requiresMatch`, `startsMatchFor`, `startsFlow`, `endsFlow`, `requiresFlow`); `pagedRead` is required whenever an action declares `pageable`. All three arrive by **spreading the library's exported fragments** — never hand-declare them (the library's `state.ts` doc-comment forbids it; hand-rolled copies drift):

```ts
import { agentStepStateSpec } from "./agent-step/index.js";

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  ...agentStepStateSpec,   // awaitingInput + currentFlow + pagedRead, correct reducers
  // … per-tool slots …
});
```

The bootstrap template already does this. Shared across all tools — only one of each in the whole graph; subsequent tools reuse them.

## Zod schema (if state.ts declares one)

This project declares `AgentStateSchema` (Zod) alongside the Annotation for input validation. If your new tool adds state fields, mirror them in the Zod schema:

```ts
const VerifiedAccountSchema = z.object({
  accountNumber: z.string(),
  iban: z.string(),
  // ...
});

// In AgentStateSchema:
verifiedAccounts: z.record(z.string(), VerifiedAccountSchema).optional().default({}),
activeAccountNumber: z.string().nullable().optional().default(null),
```

The `awaitingInput` / `currentFlow` / `pagedRead` Zod fields come from spreading the library's `agentStepZodShape` into `AgentStateSchema` (the bootstrap template already does this) — never re-declare them by hand. The individual schemas (`AwaitingInputSchema`, `CurrentFlowSchema`, `PagedCacheSchema`) are also exported from `index.ts` if a host needs one directly.
</state_ts>

<tools_index_ts>
## src/tools/index.ts

Two lines per new tool — import + add to the exported array:

```ts
import { cardsTool } from "./cards/index.js";
import { accountsTool } from "./accounts/index.js";    // NEW

export const tools = [cardsTool, accountsTool] as const; // NEW: added accountsTool
```

The order doesn't affect runtime correctness, but it's worth keeping consistent — declared order ≈ functional priority (read-only first, mutations later, etc., is one valid convention).
</tools_index_ts>

<prompt_ts>
## src/prompt.ts

Three places to extend, in this order:

### 1. SCOPE / OPERATING LOOP
If the new tool covers user intents the current prompt refuses, broaden SCOPE so they're not refused. Example: if cards-only refuses account inquiries, and you're adding accounts, drop the refusal clause.

### 2. ACTIONS section
Per-action block. Use this exact shape (lift from cards' existing actions in `src/prompt.ts`):

```
- `<action_name>` — params: `{ <field>, <field?> }`. <Optional flags/enum values>. Prereq: `<prereqName>` (or "none"). <One-paragraph summary of what it does, what verdicts/states it returns, what changes in session state.> Result body: `{ summary, <key>, <key>, ... }`.
```

Place the new tool's actions either in a new heading or appended to the existing ACTIONS list, whichever reads cleanly.

### 3. MUTATION SAFETY (if confirm-required mutations exist)
Extend the existing MUTATION SAFETY section. The runner enforces:
- `soleStep` — strict: mutation must be alone in batch
- `soleOnExecute` — relaxed: propose may ride as the LAST step of a multi-step batch; execute must be alone
- `requiresConfirmation` — propose → execute lifecycle, lockdown while pending

The prompt should teach the LLM:
- Propose call returns `{ ok: true, needs_confirmation: true, proposed_params, attempts_left }` — recap, do NOT speak as if executed
- Wait for affirmation in this turn; on the next turn re-issue with same params to execute
- Drifted params re-propose and decrement `attempts_left`
- On execute, read the executor's `postState` field to confirm the change landed
- While pending, any other action returns `error: "pending_confirmation_locked"`; recover with `abort_pending_input` (auto-injected by library — clears `awaitingInput` AND `currentFlow` together) or re-issue the same mutation

### 4. FLOW NARRATIVE (if multi-turn flows exist — OTP, double-entry match)
For each multi-turn flow, teach the LLM:
- The opener (e.g. `request_card_activation` / `request_pin_setup`) starts the flow and mints an OTP — quote the masked mobile, ask the customer to read the 6-digit code on the next turn.
- The OTP consumer (e.g. `confirm_otp`) validates the code. Verdicts: `otp_invalid` (retry the same code), `otp_timeout` (offer to resend → re-call the opener), `otp_locked` (terminal — abort gracefully).
- For double-entry: the capturer records the first entry, the consumer takes the repeat. The library decrements on `match_mismatch` and aborts on exhaustion (`match_attempts_exhausted`). The customer can re-enter (capturer reset) at any time.
- Lockdown semantics: while a gate is pending, only the targeted action, the capturer (match only), or `abort_pending_input` are allowed.
- The customer's verbal "say PIN / repeat PIN" or "say the code" IS the affirmation for those gates — there is no separate "are you sure?" recap.

### 5. Unloaded vs. empty — never report "none" from a slot that might be unloaded

A state slot has two "empty" meanings the model cannot distinguish: *not fetched yet* and *fetched and genuinely empty*. If the prompt lets the model answer "you have none" straight from a slot, it will sometimes report absence for data it simply hasn't loaded. Rule for the prompt: **before reporting absence, ensure the relevant read ran this conversation** — or rely on self-sufficient read actions (see `executor-patterns.md`) that load on demand. State slots are a cache, not proof of absence.

### 6. TOOL USE / Recovery from denials
If your tool introduces new prereq denials (e.g. `account_not_verified`), add a one-line recovery hint in the same style as the existing identity denials (`customer_not_verified` / `card_not_verified`): tell the model what to collect or do to clear the gate.

Library-emitted errors the prompt should recognise: `pending_confirmation_locked`, `otp_pending_locked`, `match_pending_locked`, `no_flow_active`, `wrong_flow`, `otp_not_pending`, `match_not_pending`, `flow_already_active`, `confirmation_attempts_exhausted`, `match_attempts_exhausted`, `mutation_must_be_sole_step`, `mutation_must_be_last_in_batch`.

### 7. EXAMPLES section
Add one or two worked batch examples for the new tool. The format:

```
- Read flow — list accounts and fetch one's balance:
  `{ steps: [{ action: "verify_customer", params: { ... } }, { action: "list_accounts", params: {} }, { action: "fetch_balance", params: { accountNumber: "..." } }] }`
  → `results` contains three entries: verify_customer, list_accounts, fetch_balance.

- Mutation propose (rides with prereqs because of `soleOnExecute`):
  `{ steps: [{ action: "verify_customer", params: { ... } }, { action: "verify_card", params: { ... } }, { action: "change_status", params: { newStatus: "freeze" } }] }`
  → last entry is `change_status` with `needs_confirmation: true`. Recap; next turn re-call as a sole step with the same params.

- Multi-turn OTP flow (one turn):
  `{ steps: [{ action: "confirm_otp", params: { otp: "123456" } }, { action: "commit_activation", params: {} }] }`
  → validates OTP and proposes the activation in one batch.
```

Worked examples make the difference between the LLM batching aggressively (the win) and the LLM serializing one action per turn (the loss).
</prompt_ts>

<voice_rules_preservation>
The prompt has voice agent rules (no digits as numerals, no URLs, no off-channel redirects except for OOS refusals). When extending the prompt:

- **Never instruct the LLM to read identifiers numerically.** If a new action returns an IBAN, account number, etc., the prompt should say "spell the digits as words" (in the agent's spoken language).
- **Never recommend the LLM close with an off-channel redirect** ("call our service line", "visit your branch") — those are reserved for OOS refusal, not for successful operations.
- **Never echo full secrets** (new PINs, OTPs the customer just dictated). For PIN-set, the prompt should quote only the masked last-two; for OTPs, the prompt should never quote the digits back at all.
- If the new tool has fallback content gated on the customer's segment / branch / channel, leave a `[TBD — knowledge-base content]` placeholder rather than inventing a script. The cards prompt uses this pattern.
</voice_rules_preservation>

<a_minimal_diff_for_a_new_tool>
For a hypothetical "accounts" tool with one verification and two read actions, the prompt diff is small:

```diff
SCOPE
-Cards only. Refuse account/loan/general inquiries.
+Cards and account inquiries. Refuse loan/general inquiries.

ACTIONS
+## Accounts
+- `list_accounts` — params: `{}`. Prereq: `customerVerified`. Returns `{ accounts: [{ iban, category, balance? }] }`. Read-only.
+- `fetch_balance` — params: `{ accountNumber }`. Prereq: `customerVerified`. Returns `{ balance, currency, asOf }`. Reads current balance for the named account.

EXAMPLES
+- Account read flow:
+  `{ steps: [{ action: "verify_customer", params: { ... } }, { action: "fetch_balance", params: { accountNumber: "..." } }] }`
+  → `results` contains verify_customer (ok) and fetch_balance (ok, with the balance).
```

That's roughly the diff. No MUTATION SAFETY edits (no mutations in this example). No FLOW NARRATIVE edits (no multi-turn). No new prereq denials beyond the existing `customer_not_verified` (reused).
</a_minimal_diff_for_a_new_tool>
