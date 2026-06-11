# Reference: Translating Inputs Into an Action List

<overview>
The skill accepts four input formats; each maps differently onto the action list / mutations / state slots. This reference is the playbook for each format.
</overview>

<format_1_user_stories>
## Format 1: User stories / scenarios prose

Sentences like "the customer asks if their account is overdrawn" or "the agent must be able to freeze a card the customer reports as lost".

**Translation rules:**

- **Subject + verb** → an action. "asks if" / "wants to know" / "requests" → read action. "freezes" / "transfers" / "cancels" → mutation.
- **Object** → params + state slots. "their account" requires the account to be in state (state slot + verifier). "their card" same with cards.
- **Conditions** → prereqs. "after identifying themselves" → `customerVerified`. "for an active card" → `cardVerified`. This mapping is exactly how the user's journey position becomes a constraint: each condition names a point the user must have reached, and the prereq is the snapshot of that progress (principle #11).
- **Confirmation language** → `requiresConfirmation`. "the customer says yes before we proceed" / "we recap and ask" / "we require explicit confirmation" → set the flag.

Example:
> The customer reports they've lost a card, gives the last four digits, and asks us to freeze it. We must identify the customer first by AFM + name. We must NOT freeze without explicit confirmation.

Maps to:
- `verify_customer` (params: taxNo, firstName, lastName, fatherName; prereqs: []; mutation: no)
- `verify_card` (params: lastFour; prereqs: [customerVerified]; mutation: no)
- `change_status` (params: newStatus, lastFour?; prereqs: [cardVerified]; mutation: yes; **soleOnExecute**: true; requiresConfirmation: { maxAttempts: 3 })
- State slots: verifiedCustomer, verifiedCards, activeCardNumber, awaitingInput, currentFlow
- Verifiers: customerVerified, cardVerified

**Pick `soleOnExecute` over `soleStep` by default.** It lets the LLM batch `[verify_customer, verify_card, change_status]` on the propose turn (the LLM-natural shape), while still requiring the execute re-call to ride alone. Use the strict `soleStep` only when the mutation must never share a batch (e.g. it has a destructive side effect even when only proposed, which is unusual).

**Heuristic:** every distinct verb-object pair the description mentions → one action. Re-use existing verifiers/state slots when possible; introduce new ones only when needed.

### Multi-turn flow detection

Some operations span MULTIPLE customer turns and are best modelled as a library-managed flow:

- **OTP-gated operations** ("we send a code via SMS, the customer reads it back, then we apply the change") → split into a request action (`issuesOtp` + `startsFlow`), an OTP validator (`requiresOtp`), and a commit action (`requiresFlow` + `endsFlow`). The OTP validator can be **shared** across flows in the same tool — a single `confirm_otp` action with `requiresOtp: true` works for every issuer that targets it.
- **Double-entry verification** ("the customer enters a new PIN, then repeats it to confirm") → split into a capturer (`startsMatchFor`) and a consumer (`requiresMatch`). Library handles the attempts counter and flow abort on exhaustion.
- **Free-form multi-turn** without OTP / match (e.g. "first set the limit type, then the amount") → typically NOT a library flow. Just use multiple independent actions with appropriate prereqs; let the LLM sequence them.

If you see "we send a code", "OTP", "SMS confirmation", "two-factor" → it's an OTP flow. If you see "repeat the PIN", "confirm by entering again", "secret answer" → it's a match flow. Otherwise, keep it as independent actions.
</format_1_user_stories>

<format_2_transcripts>
## Format 2: Example conversations / transcripts

Sample turn-by-turn exchanges showing the customer talking to the agent.

**Translation rules:**

- **First customer utterance** → infer the OPERATING LOOP entry: what intent does the agent need to recognize? (E.g. "Καλημέρα, θέλω να ελέγξω…" → intent: account/card status query.)
- **Each subsequent customer turn → tool call(s) in the next agent turn.** Look at what the agent must answer; that's a tool result the LLM needs.
- **Agent turns that recap-and-ask-for-confirmation** → that mutation has `requiresConfirmation`.
- **Agent turns that refuse with "I can't… please call our service line"** → OOS refusal, not an action (already in prompt SCOPE).

Walkthrough strategy:
1. Read the full transcript.
2. Tag each agent turn: (a) reads data → 1 or more read actions; (b) modifies → 1 mutation; (c) asks for affirmation → mutation propose; (d) speaks → no tool call.
3. List the actions in encounter order; de-dupe.
4. Note any state the agent appears to "remember" mid-conversation (e.g. "the card ending 5050 you just mentioned") → state slot.

If transcripts aren't in English, don't translate the dialogue but DO use English snake_case for action names.
</format_2_transcripts>

<format_3_structured_action_list>
## Format 3: Pre-written structured action list

A list/table the user has already worked out, e.g.:

```
| action          | params               | prereq          | mutation | confirm |
|-----------------|----------------------|-----------------|----------|---------|
| verify_customer | taxNo, name, patron. | -               | no       | -       |
| list_accounts   | -                    | customerVerified | no      | -       |
| ...             | ...                  | ...              | ...      | ...     |
```

**Translation rules:**

- Take the list as-is. Don't second-guess names or schemas.
- Verify each prereq has a corresponding verifier slot — if a prereq is named that doesn't already exist, propose adding it.
- For each mutation, confirm whether `soleStep` is implied (default: yes — mutations should generally be alone in the batch).
- Backend mapping: pair each action with one or more backend endpoints the executor calls. Ask the user if not stated.
</format_3_structured_action_list>

<format_4_openapi_or_postman>
## Format 4: OpenAPI / Postman / endpoint spec

Machine-readable backend definitions.

**Translation rules:**

- **An endpoint is NOT a 1:1 action.** Multiple endpoints can compose into one action (e.g. a `change_status` action calls `getCardStatus` then `changeCardStatus` then `getCardStatus` again).
- **An action is a domain-level capability the LLM exposes to the customer.** Group endpoints by what they accomplish together.
- **Fold a list→details split into one action.** A backend that separates "list items" from "get item details" is exposing an endpoint boundary, not a user task. Expose one action that returns usable detail, and call both endpoints inside the executor. A two-step `list_x` → `get_x_details` that has no standalone user meaning is an endpoint boundary leaking into the action surface.
- **Keep parallel entity types symmetric.** If two comparable entity types are both browsable, give them the same action shape: if one is one-step, the other should be too. Asymmetry between siblings (one-step vs two-step for the same kind of task) confuses both the model and the user.
- **OpenAPI's GET → read action; POST → potentially a mutation.** Not absolute — POST with semantics like "search" is read-only.
- **Request schemas → params subset.** Strip backend-only fields (user IDs, channel codes, sandbox IDs, branch codes). What's left is what the LLM should send.
- **Response schemas → result body design.** Pick the few fields the LLM needs to speak the answer; ignore the rest.

Backend-only fields (user IDs, channel, branch, workstation, sandbox-id) should go in `backend/env.ts` and be injected by the client helper — never asked of the LLM.

If the spec is large and you're unsure which endpoints to expose, ask the user to confirm the action list before writing code.
</format_4_openapi_or_postman>

<derivation_checklist>
After processing inputs, verify every action has:

- [ ] `name` (snake_case, verb-led)
- [ ] `description` (1–3 sentences, LLM-facing)
- [ ] `paramsSchema` (Zod, minimal fields)
- [ ] `prereqs` list (or `[]`)
- [ ] `mutation?` flag with `soleStep` / `soleOnExecute` + `requiresConfirmation` opts if true
- [ ] lifecycle opts (`startsFlow` / `endsFlow` / `requiresFlow` / `issuesOtp` / `requiresOtp` / `startsMatchFor` / `requiresMatch`) for multi-turn actions
- [ ] Backend endpoints + envelope shape
- [ ] **result size** — could this read return a large or unbounded list (search / browse / history)? If yes, it's a **paginated read**: declare `pageable` on the action (`z.object` params schema required); the runner injects `page`/`pageSize`, returns one page, and caches the full set in the library `pagedRead` slot. Use `executor-read-paginated.ts.template`; see `read-tool-patterns.md` + `agent-step-api.md` `<pagination>`. A small fixed-size read needs none of this.

And every prereq has:

- [ ] `name` matches a state-slot predicate
- [ ] `check` function (one line of logic, just `state.X != null` typically)
- [ ] `denial` body with `summary` (LLM-facing) and `error` (machine-readable)

And every state slot has:

- [ ] field name + type + default
- [ ] reducer (replace-on-write OR record-by-key merge OR domain-specific)
- [ ] mirrored in the Zod `AgentStateSchema` if present

If any item is unclear, ask the user before writing — it's cheaper than refactoring after.
</derivation_checklist>

<common_mistakes>
- **Mapping one endpoint → one action.** Backend granularity ≠ tool granularity. Group endpoints by domain capability.
- **Letting an endpoint boundary become an action boundary.** A list/details split, or a paged endpoint, is backend plumbing. Design for the user task, then audit each action: does it exist only to mirror an endpoint boundary? If so, fold it into the action that has user meaning.
- **Asymmetric sibling actions.** Comparable entity types should share an action surface. Differing step counts for siblings (one product one-step, another two-step) is a design smell — usually one of them leaked an endpoint boundary.
- **Exposing backend identifiers in params.** UserId, channel, sandbox-id, branch code → all live in `backend/env.ts`, not in the action params.
- **Inventing new prereqs unnecessarily.** If `customerVerified` covers the gate, don't add a sub-prereq like `customerHasAccounts`. Let the executor return a domain-level negative result instead.
- **Making every read action depend on a mutation-like confirmation.** Reads should be cheap and batched.
- **Naming actions after backend endpoints.** Use domain verbs: `change_status`, not `change_card_status_v2_endpoint`.
- **Wide param schemas.** Only fields the LLM should know about. `lastFour` (yes); `userId` (no — env).
</common_mistakes>
