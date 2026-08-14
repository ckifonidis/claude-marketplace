# Reference: Graph-Level Integration (state.ts, prompt.ts, tools/index.ts)

<overview>
A new tool requires three graph-level patches: declaring state slots, registering the tool, and teaching the prompt about new actions. The library does NOT handle any of these — you do them by hand (or via this skill).
</overview>

<state_ts>
## src/state.ts

Graph state is defined **once** as a single Zod schema, `AgentStateSchema` (`MessagesZodState.extend({...})`). Each channel carries its reducer + default via `withLangGraph` (from `@langchain/langgraph/zod`) — a field WITH a reducer becomes a `BinaryOperatorAggregate` channel, one WITHOUT becomes `LastValue` (replace-on-write). The same schema is wired as the graph's `stateSchema` (agent.ts) AND passed to `buildAgentStepTool({ stateSchema })` in each tool's `index.ts`, so the runner derives its intra-batch merger from the same reducers. **No separate Annotation, no dual definition.**

Add per-tool state slots as fields on `AgentStateSchema`:

- **Always carry an explicit reducer** via `withLangGraph` — even for replace-on-write. A plain field (no `withLangGraph`) is `LastValue`, which is fine but inconsistent with the explicit pattern the project uses.
- **Use record-by-key merge** when multiple identities can be cached. Example: `verifiedCards: Record<string, VerifiedCard>` merges so successive verifications accumulate.
- **Use replace-on-write** for scalar selections. Example: `activeCardNumber: string | null`.
- **`withLangGraph` field shape:** supply the channel default via the meta `default` (NOT a zod `.default()`), and use plain `.nullable()` on the field — `withLangGraph` requires the field's zod input type to equal its value type, which `.optional()`/`.default()` would widen with `undefined`.

Pattern:

```ts
// types for the new tool's domain data
export interface VerifiedAccount {
  accountNumber: string;
  iban: string;
  balance: string;
  // ...
}
const VerifiedAccountSchema = z.object({
  accountNumber: z.string(),
  iban: z.string(),
  // ...
});

// In AgentStateSchema:
verifiedAccounts: withLangGraph(z.record(z.string(), VerifiedAccountSchema), {
  reducer: { fn: (a, b) => ({ ...(a ?? {}), ...(b ?? {}) }) },
  default: () => ({}),
}),

activeAccountNumber: withLangGraph(z.string().nullable(), {
  reducer: { fn: (_prev: string | null, next: string | null) => next ?? null },
  default: (): string | null => null,
}),
```

## Session-context identity slots (pre-authenticated tools)

If the tool receives identity as run context rather than collecting it (see `identity-patterns.md`), declare those fields with a **preserve-initial** reducer so the value set on the first turn survives later turns and isn't clobbered by an empty update:

```ts
sessionUserKey: withLangGraph(z.string().nullable(), {
  reducer: { fn: (prev: string | null, next: string | null) => prev ?? next }, // first non-null wins
  default: (): string | null => null,
}),
```

And remember: a default — even one reading an env var — does **not** fill state. The **caller must pass these fields in the invoke input on every run**; the launcher (CLI, server handler, scheduler) owns reading the environment/request and threading them in. A `sessionReady` verifier then just checks presence. If the field is caller-supplied and you want it coerced/validated at the invoke boundary (e.g. an unquoted JSON number → string), use `z.coerce.string().nullable()` and wire `AgentInputSchema` (below) into a hand-built `StateGraph`.

## Library-managed slots (awaitingInput + currentFlow + boundedChoice + pagedRead + deflectedAside + handoff + errorCount + guardTurn + actionTrail)

`awaitingInput` / `currentFlow` are required whenever the new tool declares any lifecycle opt on a mutation (`requiresConfirmation`, `requiresOtp`, `issuesOtp`, `requiresMatch`, `startsMatchFor`, `startsFlow`, `endsFlow`, `requiresFlow`); `boundedChoice` whenever `boundedChoices` is configured; `pagedRead` whenever an action declares `pageable`; `handoff` / `errorCount` for the library handoff + auto-handoff guard; `deflectedAside` (2.4.0) whenever `HandoffSpec.deflectAside` is set; `actionTrail` (2.6.0) is required UNCONDITIONALLY — the runner records the per-task audit trail on every finalized batch, whatever the config uses. (Since library 2.0.0 `buildAgentStepTool` enforces this at construction: a state schema missing a channel for any slot the configuration writes throws.) `guardTurn` (2.3.0) is the one slot the RUNNER never writes — the host's model-input guards write it through `markGuardFired`, so it is never in that required set; it still arrives with the fragment. All arrive by **spreading the library's exported `agentStepZodShape` fragment** — never hand-declare them (the library's `state.ts` doc-comment forbids it; hand-rolled copies drift). Each slot in the fragment is already wrapped with `withLangGraph` carrying the runner's expected reducer/default:

```ts
import { MessagesZodState, type ExtractStateType } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { agentStepZodShape, agentStepInternalSlotMask } from "./agent-step/index.js";

export const AgentStateSchema = MessagesZodState.extend({
  ...agentStepZodShape,    // awaitingInput + currentFlow + boundedChoice + pagedRead + deflectedAside + handoff + errorCount + guardTurn + actionTrail, correct reducers
  // … per-tool slots (withLangGraph) …
});

/** Value types nodes receive — tools import this to type selectors + ExecutorResult. */
export type State = ExtractStateType<typeof AgentStateSchema>;
```

The bootstrap template already does this. Shared across all tools — only one of each in the whole graph; subsequent tools reuse them. The individual schemas (`AwaitingInputSchema`, `CurrentFlowSchema`, `PagedCacheSchema`, `HandoffRequestSchema`) are also exported from `index.ts` if a host needs one directly.

## Graph INPUT schema (invoke-boundary validation)

`state.ts` also exports `AgentInputSchema` — the state schema minus the library-managed slots (via `agentStepInternalSlotMask`, which are runner-written only) and any executor-derived slots, then `.partial()`, with `messages` re-attached from its native shape:

```ts
export const AgentInputSchema = AgentStateSchema.omit({
  ...agentStepInternalSlotMask,
  pendingHandoff: true,   // + any other executor-written / derived slot
})
  .partial()
  .extend({ messages: MessagesZodState.shape.messages });
```

Re-attach `messages` after `.partial()` — do **not** leave it partial. `.partial()` wraps every field in an optional and strips the messages-channel metadata LangGraph Studio keys off to render the chat input box; without the re-attach Studio falls back to the raw-state editor ("pass new messages as state"). The caller-supplied fields stay optional, while `messages` keeps its native typed-and-required messages shape (`MessagesZodState` is already imported for `AgentStateSchema`).

When you add a per-tool slot that is **executor-written (not caller input)**, add its key to this `.omit({...})` so it can't be injected at the invoke boundary. `AgentInputSchema` is consumed by a hand-built `new StateGraph({ state: AgentStateSchema, input: AgentInputSchema })`; the `createReactAgent` scaffold takes no separate `input` schema, so it ships exported-but-unwired until the project graduates to a hand-built graph.
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
Per-action block. Use this exact shape (when the project already has a tool, lift the shape from its existing action blocks in `src/prompt.ts`):

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
- If the new tool has fallback content gated on the customer's segment / branch / channel, leave a `[TBD — knowledge-base content]` placeholder rather than inventing a script.
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
