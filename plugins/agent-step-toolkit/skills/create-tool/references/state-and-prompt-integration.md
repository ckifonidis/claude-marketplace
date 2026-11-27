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

## Library-managed slots (awaitingInput + currentFlow + pagedRead + spentLadders + handoff + errorCount)

`awaitingInput` / `currentFlow` are required whenever the new tool declares any lifecycle opt on a mutation (`requiresConfirmation`, `requiresOtp`, `issuesOtp`, `requiresMatch`, `startsMatchFor`, `startsFlow`, `endsFlow`, `requiresFlow`) or collects any caller capture (a row `ask`, or the derived bounce re-ask, records the `dictation` slot); `pagedRead` whenever an action declares `pageable`; `spentLadders` (the bounded-patience latch) and `handoff` whenever the `handoff` opt is configured; `errorCount` for the auto-handoff guard. (`buildAgentStepTool` enforces this at construction: a state schema missing a channel for any slot the configuration writes throws.) All arrive by **spreading the library's exported `agentStepZodShape` fragment** — never hand-declare them (the library's `state.ts` doc-comment forbids it; hand-rolled copies drift). Each slot in the fragment is already wrapped with `withLangGraph` carrying the runner's expected reducer/default:

```ts
import { MessagesZodState, type ExtractStateType } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { agentStepZodShape, agentStepInternalSlotMask } from "./agent-step/index.js";

export const AgentStateSchema = MessagesZodState.extend({
  ...agentStepZodShape,    // awaitingInput + currentFlow + pagedRead + spentLadders + handoff + errorCount, correct reducers
  // … per-tool slots (withLangGraph) …
});

/** Value types nodes receive — tools import this to type selectors + DeclaredExecutorResult. */
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

The MACHINERY text is engine-composed since 3.0.0 — the prompt keeps only domain semantics. Places to extend, in this order:

### 0. TURN PROTOCOL — the `{PROTOCOL}` splice (once per project)
The turn/speech machinery (tool turn vs speaking turn, the reply/ask contracts, the gate handshake,
READ-BACK authority, handoff silence) comes from `composeProtocolPrompt` (see `agent-step-api.md`
`<composed_surface>`): `prompt.ts` composes the fragment from the tool's feature surface (config +
handoff) and splices it at the `{PROTOCOL}` placeholder. When adding the FIRST tool, wire
this splice (the bootstrap `prompt.ts` carries the commented scaffolding); when adding a later tool
to a single-tool prompt, the fragment recomposes automatically from the updated config. Domain
capture doctrines that must outrank the generic contracts go on `toolTurnRules` — never hand-written
into the fragment's territory. Write NONE of the machinery text yourself.

The fragment follows the tool's calling mode. With `config.tool.toolChoice: "required"` (agent-step
4.1.0) it composes the required-mode protocol — speech through the `respond_to_caller` control,
`continuation`, the READ-BACK placeholders — and the rest of the prompt must then never say "answer
without a tool call" or "make no call": write WHAT to convey and let the fragment own how a reply is
delivered. The streamed spoken answer (4.2.0) runs on the same prompt, with calls switched off by the
graph: add no prompt text for it, and do not tell the model when to speak rather than call. A guardrail section points at the call's `turn` classification rather than redefining
misuse. See `agent-step-api.md` `<required_mode>`.

### 1. SCOPE
If the new tool covers user intents the current prompt refuses, broaden SCOPE so they're not refused. Example: if cards-only refuses account inquiries, and you're adding accounts, drop the refusal clause.

### 2. ACTIONS section
Per-action block — SEMANTIC content only: when to invoke the action and the business meaning of each
verdict. The mechanics (params, the gate handshake, batching, result shape) are engine-composed — the
schema's composed description and the wire contracts own them; restating them duplicates engine bytes:

```
- `<action_name>` — <when to call it; how to recover from each verdict, in business terms>.
```

Place the new tool's actions either in a new heading or appended to the existing ACTIONS list, whichever reads cleanly.

### 3. MUTATION SAFETY — mostly engine-owned now
The propose → execute handshake, the reply classification while a gate pends, and the read-back
authority ride the WIRE (the composed gate marker, `reply_contract`, `read_back` +
`read_back_directive`) and the protocol fragment. The prompt keeps only the domain halves: which
mutations exist, what the caller must consent TO in business terms, and any post-state reading rule
(e.g. "read `postState` from the mutation's own result for the spoken confirmation").

### 4. FLOW NARRATIVE (if multi-turn flows exist — OTP, double-entry match)
For each multi-turn flow, teach the LLM:
- The opener (e.g. `request_card_activation` / `request_pin_setup`) starts the flow and mints an OTP — quote the masked mobile, ask the customer to read the 6-digit code on the next turn.
- The OTP consumer (e.g. `confirm_otp`) validates the code. Verdicts: `otp_invalid` (retry the same code), `otp_timeout` (offer to resend → re-call the opener), `otp_locked` (terminal — abort gracefully).
- For double-entry: the capturer records the first entry, the consumer takes the repeat. The library decrements on `match_mismatch` and aborts on exhaustion (`match_attempts_exhausted`). The customer can re-enter (re-run the capturer) at any time; with a handoff configured (4.3.0) that does not refund spent mismatches.
- Lockdown semantics: while a gate is pending, only the targeted action, the capturer (match only), or `abort_pending_input` are allowed.
- The customer's verbal "say PIN / repeat PIN" or "say the code" IS the affirmation for those gates — there is no separate "are you sure?" recap.

### 5. Unloaded vs. empty — never report "none" from a slot that might be unloaded

A state slot has two "empty" meanings the model cannot distinguish: *not fetched yet* and *fetched and genuinely empty*. If the prompt lets the model answer "you have none" straight from a slot, it will sometimes report absence for data it simply hasn't loaded. Rule for the prompt: **before reporting absence, ensure the relevant read ran this conversation** — or rely on self-sufficient read actions (see `executor-patterns.md`) that load on demand. State slots are a cache, not proof of absence.

### 6. TOOL USE / Recovery from denials
If your tool introduces new prereq denials (e.g. `account_not_verified`), add a one-line recovery hint in the same style as the existing identity denials (`customer_not_verified` / `card_not_verified`): tell the model what to collect or do to clear the gate.

Library-emitted errors the prompt should recognise: `pending_confirmation_locked`, `otp_pending_locked`, `match_pending_locked`, `no_flow_active`, `wrong_flow`, `otp_not_pending`, `match_not_pending`, `flow_already_active`, `confirmation_attempts_exhausted`, `match_attempts_exhausted`, `mutation_must_be_sole_step`, `mutation_must_be_last_in_batch`. Under required tool calling also: `continuation_required` (the latest result of this caller turn requires a specific next step), `empty_batch`, `invalid_reply` (a spoken reply the engine refused — the instruction says what to fix), `reply_must_be_sole_step`. These are self-explaining engine instructions; the prompt does not need to teach recovery from them.

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
+- `list_accounts` — call when the customer asks what accounts they hold. Read-only.
+- `fetch_balance` — call when the customer asks a balance for a specific account; a `not_found` verdict means the reference resolved to no account — offer the list.

EXAMPLES
+- Account read flow:
+  `{ steps: [{ action: "verify_customer", params: { ... } }, { action: "fetch_balance", params: { accountNumber: "..." } }] }`
+  → `results` contains verify_customer (ok) and fetch_balance (ok, with the balance).
```

That's roughly the diff. No MUTATION SAFETY edits (no mutations in this example). No FLOW NARRATIVE edits (no multi-turn). No new prereq denials beyond the existing `customer_not_verified` (reused).
</a_minimal_diff_for_a_new_tool>
