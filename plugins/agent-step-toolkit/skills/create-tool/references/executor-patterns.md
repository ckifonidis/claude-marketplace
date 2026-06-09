# Reference: Executor Patterns

<overview>
Executors do the actual work: parse the LLM-supplied params, call the backend, interpret the response, return an `ExecutorResult`. The pattern variants you'll encounter:

1. **Read-only executor** — fetches data, no state mutation (some still update state for caching, e.g. `verify_*` updates `verifiedCustomer`).
2. **Identity/verification executor** — locates an entity by user-supplied identifiers; populates state slots so subsequent actions can rely on them.
3. **Mutation executor** — modifies backend state. Owns its own pre-check (reject before write if state isn't acceptable) and post-read (verify write landed); returns `preState`/`postState`.
4. **OTP issuer (`issuesOtp` + typically `startsFlow`)** — opens a multi-turn flow and mints an SCA challenge. Returns `lifecycle: { issuesOtp }` and `flowData` so the consumer can read `challengeId` later.
5. **OTP consumer (`requiresOtp`)** — validates the customer's 6-digit code against the backend. Library auto-clears the gate on `ok:true`; executor signals timeout / lockout via `lifecycle.clearAwaitingInput` / `lifecycle.abortFlow`.
6. **Double-entry capturer + consumer (`startsMatchFor` / `requiresMatch`)** — captures the first entry into `flowData`, then verifies the repeat matches.
7. **Self-sufficient read executor** — a read that loads its own dependencies on demand instead of gating on a prior step via a prereq.
8. **Reference resolver** — turns a user's human-terms reference into a concrete entity (or a candidate set) by matching over more than primary keys.
9. **Compute / analysis executor** — runs a computation over data already in state; the agent supplies the computation, the host runs it.

All share the same TypeScript signature; the differences are in what they read/write.
</overview>

<contract>
Every executor matches:

```ts
// `Slice` is whatever this action's stateSelector returned — NOT the whole
// state. The executor receives only its slice; its result may still patch any
// host slot via stateUpdate (ExecutorResult<T>, T = full state).
type Executor<Slice, T> = (params: unknown, state: Slice) => Promise<ExecutorResult<T>>;

interface ExecutorResult<T> {
  resultBody: object;              // JSON-serializable; spread into the StepResult the LLM sees
  stateUpdate?: Partial<T>;        // patch threaded to next step and committed at end
  flowData?: Record<string, unknown>;
                                   // shallow-merged into currentFlow.data (on ok, or when this
                                   // action declares startsFlow). Writing flowData with no flow
                                   // active is a programmer error → runner throws.
  lifecycle?: {
    issuesOtp?: { challengeId: string; mobile_masked: string };
    clearAwaitingInput?: true;
    abortFlow?: true;
  };
  ok: boolean;                     // false short-circuits the batch
}
```

Key points:
- `params` is `unknown` because the runner has already validated against `paramsSchema`. The first line of the executor should cast: `const p = params as MyParams;`
- `state` is the **slice** this action's `stateSelector.ts` produced from the step-start snapshot (which includes any in-batch updates from earlier steps). Import the slice type as `import type { Slice } from "./stateSelector.js"`. The executor sees only what the selector handed it — narrow the selector to what the action actually reads.
- `resultBody` should always contain a `summary` field (human-readable for the LLM) plus structured fields the prompt expects (`verdict`, `error`, action-specific data).
- `ok: false` ends the batch but commits all preceding state updates.
- `flowData` and `lifecycle` are reserved for actions opted into the corresponding `controller.*` lifecycle hook. Returning them outside that context will (for `flowData`/`issuesOtp`) throw at runtime.
</contract>

<pattern_1_read_executor>
## Pattern 1: Read-only executor

Example: `check_pin` (PIN attempt counter for an active card).

```ts
import { postBackend } from "../../backend/client.js";
import { cardsEnv } from "../../backend/env.js";
import { tryResolveCard } from "../../shared/resolve-card.js";
import type { AgentState } from "../../../../state.js";
import type { ExecutorResult } from "../../../../agent-step/index.js";

type State = typeof AgentState.State;

interface Params { lastFour?: string; }

interface BackendPayload {
  pinTryCounter?: number;
}

export async function checkPin(
  rawParams: unknown,
  state: State,
): Promise<ExecutorResult<State>> {
  const p = rawParams as Params;
  const card = tryResolveCard(state, p.lastFour);
  if ("error" in card) {
    return { resultBody: { summary: card.summary, error: card.error }, ok: false };
  }

  const resp = await postBackend<{ payload?: BackendPayload }>(
    cardsEnv.cardsPinManagementApiBaseUrl,
    "CardsPinManagement/getPinTryCounter",
    { cardNumber: card.cardNumber, /* ... */ },
    { envelope: "payload-only" },
  );
  const counter = resp?.payload?.pinTryCounter ?? 0;
  const locked = counter >= 3;
  const summary = locked
    ? `PIN is LOCKED (${counter} failed attempts).`
    : `PIN not locked (${counter} failed attempts so far).`;
  return { resultBody: { summary, counter, locked }, ok: true };
}
```

Rules:
- No `stateUpdate` returned — read-only.
- `ok: true` even when "negative" outcomes occur (locked PIN is still a successful read).
- `ok: false` only when the call failed (e.g. card resolution couldn't find the card).
</pattern_1_read_executor>

<pattern_2_verification_executor>
## Pattern 2: Verification / identity executor

Example: `verify_customer` (locate customer by AFM + name).

```ts
export async function verifyCustomer(
  rawParams: unknown,
  state: State,
): Promise<ExecutorResult<State>> {
  const { taxNo, firstName, lastName, fatherName } = rawParams as VerifyParams;

  const search = await postBackend<SearchResponse>(/* ... */);
  const items = search?.payload?.items ?? [];
  if (items.length === 0) {
    return {
      resultBody: { summary: "...", verdict: "customer_not_found", customer: null },
      ok: false,
    };
  }
  const c = items[0];
  const customerCode = String(c.customerCode ?? "");

  // Speaker-change guard: thread bound to one customer
  const prior = state?.verifiedCustomer?.customerCode ?? "";
  if (prior && prior !== customerCode) {
    return {
      resultBody: { summary: "...", verdict: "speaker_change_forbidden", customer: null },
      ok: false,
    };
  }

  // Name match (in-tool helper)
  const match = matchName(c, firstName, lastName, fatherName);
  if (!match.matched) {
    return {
      resultBody: { summary: "...", verdict: "name_mismatch", customer: { ... }, missing: match.missing, misplaced: match.misplaced },
      ok: false,
    };
  }

  return {
    resultBody: { summary: "Customer verified.", verdict: "ok", customer: { ... } },
    stateUpdate: { verifiedCustomer: { customerCode, fullName: c.name, mobile: c.mobile, taxNumber: taxNo } } as Partial<State>,
    ok: true,
  };
}
```

Rules:
- Verdict-style result body: `{ summary, verdict, ...entity }` with `verdict ∈ { ok, not_found, mismatch, forbidden, ... }`.
- `stateUpdate` only on `verdict: "ok"` — populates the slot that downstream prereqs check.
- `ok` mirrors `verdict === "ok"`. Non-ok verdicts short-circuit the batch (saves the LLM from hammering follow-up actions that would just fail prereqs).
- Speaker-change / cross-entity guards live INSIDE the verification executor, not in the runner.
- Pin everything later actions might need (mobile for SCA, taxNumber for re-identification on mutations) in the state slot. Re-prompting later costs a turn.
</pattern_2_verification_executor>

<pattern_3_mutation_executor>
## Pattern 3: Mutation executor with internal pre-check + post-read

Example: `change_status` (freeze/cancel a card).

```ts
export async function changeStatus(
  rawParams: unknown,
  state: State,
): Promise<ExecutorResult<State>> {
  const p = rawParams as ChangeStatusParams;
  const card = tryResolveCard(state, p.lastFour);
  if ("error" in card) {
    return { resultBody: { summary: card.summary, error: card.error }, ok: false };
  }

  // ─── Pre-read: get current state to decide whether the mutation is even valid
  const pre = await fetchCardStatus({ lastFour: p.lastFour }, state);
  const preState = (pre.resultBody as { state?: string }).state;
  if (preState && (preState.startsWith("permanently_closed_") || preState === "cancelled")) {
    return {
      resultBody: {
        summary: `Card is already ${preState}; mutation refused.`,
        error: "mutation_blocked_already_closed",
        verdict: "mutation_blocked_already_closed",
        preState,
      },
      ok: false,
    };
  }

  // ─── Write
  const resp = await postBackend<{ payload?: { success?: boolean } }>(
    cardsEnv.cardsManagementApiBaseUrl,
    "CardsManagement/changeCardStatus",
    { cardNumber: card.cardNumber, newStatus: p.newStatus, /* ... */ },
    { envelope: "payload-only" },
  );
  const success = resp?.payload?.success === true;

  if (!success) {
    return {
      resultBody: { summary: "Card status change did not persist.", success: false, preState },
      ok: false,
    };
  }

  // ─── Post-read: verify the write landed
  const post = await fetchCardStatus({ lastFour: p.lastFour }, state);
  const postState = (post.resultBody as { state?: string }).state;

  return {
    resultBody: {
      summary: `Card status change persisted; new state: ${postState}.`,
      success: true,
      newStatus: p.newStatus,
      preState,
      postState,
    },
    ok: true,
  };
}
```

Rules:
- **Always** pre-read before writing. The pre-read decides whether the mutation should happen at all.
- **Always** post-read after a successful write. The post-read is the receipt — `postState` is what the LLM speaks to confirm the action took effect.
- Both `preState` and `postState` go in the result body. The prompt teaches the LLM to read `postState` for the spoken confirmation.
- The executor owns the pre-read and post-read. The library does not wrap reads around mutations.
- The library DOES manage the propose → execute lifecycle around this executor. Your executor only runs in execute mode (matching pending params). The propose mode never calls your executor.
- Mutations typically declare `soleOnExecute: true` (LLM-friendly relaxation: propose may ride with prereq verifications) or `soleStep: true` (strict alone). See `agent-step-api.md`.
</pattern_3_mutation_executor>

<pattern_4_otp_issuer>
## Pattern 4: OTP issuer (`issuesOtp` + `startsFlow`)

Opens a multi-turn flow and mints an SCA challenge. The library wires `awaitingInput.kind = "otp"` for the named consumer when the executor returns `lifecycle.issuesOtp`.

Example: `request_card_activation` (simplified).

```ts
export async function requestCardActivation(
  rawParams: unknown,
  state: State,
): Promise<ExecutorResult<State>> {
  const p = rawParams as RequestCardActivationParams;
  const card = tryResolveCard(state, p.lastFour);
  if ("error" in card) return { resultBody: { summary: card.summary, error: card.error }, ok: false };

  // Owner-of-record check, PSD T&Cs, eligibility checks…
  // (Each can short-circuit with a structured refusal verdict.)

  // Mint the SCA challenge.
  const ch = await postBackend<{ payload?: ChallengePayload; exception?: BackendException }>(
    cardsEnv.scaApiBaseUrl,
    "sca/challenge",
    { userId: customerId, application: cardsEnv.applicationId, /* ... */ },
  );
  const challengeId = ch?.payload?.challengeId;
  const masked = ch?.payload?.sentNotificationData?.details?.[0]?.recipients?.[0]?.maskedRecipient ?? "";
  if (!challengeId) {
    return { resultBody: { summary: "SCA challenge failed.", error: "otp_send_failed" }, ok: false };
  }

  return {
    resultBody: {
      summary: `OTP sent to ${masked}. Ask the customer to read back the 6-digit code.`,
      otp_sent: true,
      mobile_masked: masked,
    },
    // Scratch data the consumer (confirm_otp) will read from currentFlow.data.
    flowData: {
      customerId,
      challengeId,
      cardNumber: card.cardNumber,
      psdAccepted: p.psdAccepted === true,
    },
    // Library reads this and sets awaitingInput.kind="otp" for the named consumer.
    lifecycle: { issuesOtp: { challengeId, mobile_masked: masked } },
    ok: true,
  };
}
```

Config side (lifecycle opts live inline on the action's `controller`):
```ts
request_card_activation: {
  // … description, paramsSchema, prereqs …
  controller: {
    startsFlow: { name: "card_activation" },
    issuesOtp: { consumer_action: "confirm_otp" },
  },
}
```

Idempotency: re-running the same issuer while its flow is already active does NOT reset `currentFlow.data` (idempotent merge of `flowData`). Useful for "the customer asked to resend the code" — re-call the issuer, get a fresh `challengeId`, the consumer reads the new one.
</pattern_4_otp_issuer>

<pattern_5_otp_consumer>
## Pattern 5: OTP consumer (`requiresOtp`)

Validates the customer's 6-digit OTP against the backend. The library:
- Refuses unless `awaitingInput.kind === "otp"` for this action (error: `otp_not_pending`).
- Auto-clears `awaitingInput` on `ok: true`.
- Does NOT count attempts (backend-authoritative).

The executor reads `challengeId` from `state.currentFlow.data` (no extra params needed beyond the OTP digits).

Example: `confirm_otp`.

```ts
export async function confirmOtp(
  rawParams: unknown,
  state: State,
): Promise<ExecutorResult<State>> {
  const { otp } = rawParams as ConfirmOtpParams;
  const flow = state?.currentFlow;
  if (!flow) {
    return { resultBody: { summary: "No flow in progress for OTP validation.", error: "no_flow_data" }, ok: false };
  }
  const flowData = flow.data as OtpFlowData;

  const resp = await postBackend<{ payload?: { valid?: boolean }; exception?: BackendException }>(
    cardsEnv.scaApiBaseUrl,
    "sca/validate",
    { userId: flowData.customerId, challengeId: flowData.challengeId, token: otp, /* ... */ },
  );

  // Lockout — terminal; abort the flow.
  if (resp?.exception?.code === "SCA012" || resp?.exception?.code === "SCA002") {
    return {
      resultBody: { summary: `OTP locked. ${flow.name} flow cleared.`, error: "otp_locked", verdict: "otp_locked" },
      lifecycle: { abortFlow: true },
      ok: false,
    };
  }

  // Timeout — drop the gate so the LLM can re-issue.
  if (resp?.exception?.code === "SCA006" || resp?.exception?.code === "SCA005") {
    return {
      resultBody: { summary: "OTP timed out. Offer to resend.", error: "otp_timeout", verdict: "otp_timeout" },
      lifecycle: { clearAwaitingInput: true },
      ok: false,
    };
  }

  // Wrong code — leave state alone; let the customer retry.
  if (resp?.payload?.valid !== true) {
    return { resultBody: { summary: "OTP incorrect. Ask the customer to read it again.", error: "otp_invalid", verdict: "otp_invalid" }, ok: false };
  }

  // Success — library will auto-clear awaitingInput.
  return {
    resultBody: { summary: `OTP validated. Proceed to the next flow step.`, otp_valid: true },
    flowData: { otpValidated: true },
    ok: true,
  };
}
```

Rules:
- Lockdown lifecycle signals are mutually exclusive: pick `abortFlow` (terminal) or `clearAwaitingInput` (recoverable). Never both.
- The `flowData` write on success (`otpValidated: true`) is the natural way to gate the next step in the flow (the next action can refuse if `state.currentFlow.data.otpValidated !== true`).
- The library prevents replay: once the gate clears, this executor can't run again until a fresh issuer fires.
</pattern_5_otp_consumer>

<pattern_6_double_entry_match>
## Pattern 6: Double-entry capturer + consumer (`startsMatchFor` / `requiresMatch`)

The customer provides a value once (capturer), then again (consumer); the library counts mismatches against a budget and aborts the flow on exhaustion. Used for PIN setup, password change, secret-answer confirmation.

### Capturer

```ts
// config: propose_new_pin: { …, controller: { requiresFlow: "pin_setup", startsMatchFor: { consumer_action: "commit_pin" } } }

export async function proposeNewPin(
  rawParams: unknown,
  state: State,
): Promise<ExecutorResult<State>> {
  const { pin } = rawParams as { pin: string };
  // Local validation (length, all-same, monotonic) — refuse with a verdict on fail.
  const ruleResult = validatePin(pin);
  if (!ruleResult.ok) {
    return { resultBody: { summary: ruleResult.summary, error: "pin_rule_violation", verdict: ruleResult.reason }, ok: false };
  }

  // Wrap via the backend's encryption endpoint; persist ciphertext in flowData.
  const encrypted = await encryptPin(pin);
  return {
    resultBody: { summary: "PIN captured. Ask the customer to repeat the PIN.", pin_accepted: true },
    flowData: { encryptedPin: encrypted },
    ok: true,
  };
}
```

Library on `ok: true`: sets `awaitingInput.kind = "match"` for the consumer with `attempts_left = consumer.requiresMatch.maxAttempts`. Re-running the capturer mid-match resets that counter.

### Consumer

```ts
// config: commit_pin: { …, controller: { requiresFlow: "pin_setup", requiresMatch: { capturer: "propose_new_pin", maxAttempts: 3 }, endsFlow: true } }

export async function commitPin(
  rawParams: unknown,
  state: State,
): Promise<ExecutorResult<State>> {
  const { pin: confirmPin } = rawParams as { pin: string };
  const stored = (state.currentFlow?.data as { encryptedPin?: string } | undefined)?.encryptedPin;
  if (!stored) {
    return { resultBody: { summary: "No captured PIN to confirm.", error: "match_capturer_missing" }, ok: false };
  }

  // Encrypt the second entry the same way and compare. Host owns the comparison;
  // library owns the counter.
  const confirmEncrypted = await encryptPin(confirmPin);
  if (confirmEncrypted !== stored) {
    return {
      // Library reads `verdict: "match_mismatch"` → decrement attempts_left or
      // abort flow on exhaustion. Library injects attempts_left back into the
      // result entry; do NOT include it here.
      resultBody: { summary: "PINs do not match. Ask the customer to repeat.", error: "match_mismatch", verdict: "match_mismatch" },
      ok: false,
    };
  }

  // Match — persist, finish the flow.
  await persistPin(/* ... */);
  return {
    resultBody: { summary: `PIN set successfully.`, success: true, masked_pin_last2: `**${confirmPin.slice(-2)}` },
    ok: true,
  };
}
```

On `ok: true`: library auto-clears `awaitingInput`. The `endsFlow: true` opt also clears `currentFlow`.

On `ok: false` + `verdict: "match_mismatch"`: library decrements `attempts_left`. On exhaustion, library clears both slots and re-shapes the result entry to surface `error: "match_attempts_exhausted"`, `verdict: "match_attempts_exhausted"`, `attempts_left: 0`.

On `ok: false` + any other verdict: library leaves state alone (this is a "real" failure, e.g. backend error, not a mismatch).
</pattern_6_double_entry_match>

<pattern_7_self_sufficient_read>
## Pattern 7: Self-sufficient read executor

For reads, prefer an executor that **loads its own dependencies** over one that gates on a prior step via a prereq. Prereq verifiers are the right tool for *safety* gates (identity; an active entity before a mutation) — but using them to enforce mere sequencing ("you must have listed the inventory first") causes two recurring failures:

- The model reports an empty or negative answer from a slot that was simply never loaded.
- The model asks the user for an identifier it could have looked up itself.

Instead, a self-sufficient read resolves what it needs on demand:

```ts
export async function getItemDetails(rawParams, state): Promise<ExecutorResult<State>> {
  const p = rawParams as { ref?: string };
  // Auto-load the inventory if it isn't in state yet, rather than refusing on a prereq.
  const inventory = state.items ?? (await loadInventory(state));
  const item = resolveRef(inventory, p.ref);          // see Pattern 8
  if (!item) return { resultBody: { summary: "...", verdict: "not_found" }, ok: false };
  // ... fetch and return the details for the resolved item ...
}
```

Rules:
- Keep the identity/session prereq as the only prereq; let the executor own everything downstream of identity.
- Reserve prereq verifiers for genuine gates, not sequencing hints. (See also the "unloaded vs. empty" prompt rule in `state-and-prompt-integration.md`.)

The flip side of this negative rule is the positive one (principle #10): the prereqs you *do* keep are how the tool encodes **where the user is in their journey** — identity acquired, entity selected, flow open. That's their job; sequencing isn't.
</pattern_7_self_sufficient_read>

<pattern_8_reference_resolver>
## Pattern 8: Reference resolver

Users refer to things in human terms, not primary keys. A resolver that matches only on id/primary key will miss "my main one", an alias, a label, an attribute. Resolve in **tiers over human-referenceable fields**, widening only as needed:

1. exact primary key / id,
2. a stable short token the user can voice (a tail, a code),
3. label / alias / name,
4. attribute (category, type, status, …).

Rules:
- A resolver **may match many** — return the candidate set and let the agent disambiguate, rather than silently picking one.
- For references that could span **separate namespaces** (two entity types, two collections), don't blind-match across them. Let the model tag the namespace via a typed param and resolve within it.
- Pair the resolver with a **selection key** in list results (see `<voice_safe_results>`) so the user's phrasing maps back to a concrete item.
</pattern_8_reference_resolver>

<pattern_9_compute_analysis>
## Pattern 9: Compute / analysis executor

For open-ended analysis over data already in state ("what's the trend", "which is largest"), an effective pattern is **the agent writes the computation, the host runs it**:

- The agent model is already in the loop, so it emits the analysis snippet **directly as a param** — no second model call to generate code.
- The host executes that snippet in a **constrained in-process evaluator** against the in-state datasets and returns the computed result.
- Drive the available data from a **single source of truth** feeding three consumers: (a) the datasets exposed to the evaluator, (b) the schema described statically in the prompt, and (c) a live, per-turn "data available now" summary so the model writes code against what actually exists this turn. One schema, three projections — they cannot drift.

Security caveat: an in-process evaluator is **not** a security boundary — it constrains accidents, not adversaries, and carries the same trust posture as any "run model-authored code" feature. If the input can't be trusted, isolate execution properly (a real sandbox / separate process with no ambient capabilities) instead of relying on the in-process evaluator.

**Build recipe + templates:** `references/data-analysis-pattern.md` is the end-to-end how — the five pieces, the four-stage data flow, the single-source-of-truth datasets module, the state-dependent prompt upgrade, and the security posture. Templates: `executor-analysis.ts.template`, `analysis-vm.ts.template` (the `node:vm` runner), `datasets.ts.template`, `verifier-data-loaded.ts.template`.
</pattern_9_compute_analysis>

<state_update_shape>
## stateUpdate semantics

A `stateUpdate` patch flows through TWO consumers:
1. **In-batch threading** — subsequent steps in the same batch see the updated value via the runner's `view`.
2. **Final commit** — landed in the LangGraph state at the end of the tool call.

Both consumers go through the reducers declared in `state.ts`. So:
- Replace-on-write slots (e.g. `verifiedCustomer`, `activeCardNumber`) → just put the new value in the patch.
- Record-by-key merge slots (e.g. `verifiedCards`) → put a single-key record in the patch; the reducer merges.

Pattern:
```ts
return {
  resultBody: { ... },
  stateUpdate: {
    verifiedCustomer: customer,                         // replace
    verifiedCards: { [cardNumber]: card },              // record merge
    activeCardNumber: cardNumber,                       // replace
  } as Partial<State>,
  ok: true,
};
```

You can return state updates from `ok: false` executors too — but they only land if the executor returns `ok: false` AFTER doing something legitimately persistable. Most failure paths return no `stateUpdate`.

**Never write `awaitingInput` or `currentFlow` from `stateUpdate`.** Those slots are library-managed. Use the `ActionDef.controller.*` opts and the `flowData` / `lifecycle` fields on the return value instead.
</state_update_shape>

<error_handling>
- **Backend HTTP error** — let the `postBackend` helper throw; the runner catches the throw at the executor boundary, marks the step `ok: false`, and short-circuits. The agent's prompt should handle these gracefully ("προσωρινό τεχνικό πρόβλημα").
- **Domain "negative" outcome** (e.g. `card_not_found`, `name_mismatch`) — return `{ ok: false }` with a structured `verdict` field. The batch short-circuits cleanly.
- **Library-managed gate failure** (no flow, no OTP awaiting) — the runner intercepts BEFORE calling the executor, with error codes `no_flow_active` / `wrong_flow` / `otp_not_pending` / `match_not_pending`. You don't need to check these in the executor; they're library-enforced.
- **Unrecoverable bug** — throw. The runner catches and short-circuits.

Never silently swallow errors. The LLM relies on the `summary` field to know what went wrong.
</error_handling>

<voice_safe_results>
The executor's `resultBody` is LLM-facing JSON — the LLM reads it before producing the spoken response. The LLM's spoken response (the AIMessage that follows the ToolMessage) is what TTS speaks; THAT must be voice-safe.

But the result body still shouldn't include:
- Long, repetitive prose (wastes tokens)
- Internal IDs the customer would never hear (e.g. full PAN, raw challenge IDs)
- Sensitive raw data (the new PIN's plaintext — only persist ciphertext in `flowData`; only echo masked tails in the summary)

Keep result bodies focused: enough for the LLM to compose a correct spoken reply, no more.

**Selection key, even under masking.** Mask secrets in what gets *spoken*, not in what the model *reads*. When a list result masks an identifier for voice safety, still include a stable, voiceable **selection key** (a short tail, a code) in the result body — it's how the user's natural reference ("the one ending fifty-fifty") maps to a concrete item. Stripping the value out of the body entirely breaks that mapping and forces the model to re-ask. The key is a selector, not the secret: a maskable tail is fine to carry; the full sensitive value is not.
</voice_safe_results>

<backend_client_helpers>
`templates/backend-client.ts.template` ships two transport helpers that most new tools can adapt with minimal change:

- `postBackend<T>(apiBaseUrl, endpoint, payload, { envelope })` — JSON POST with `{ header, payload }` envelope (or `{ payload }` only when `envelope: "payload-only"`). Adds `sandbox-id` header when set. Trace logging gated by a `<TOOL>_BACKEND_TRACE` env var.
- `getBackend<T>(apiBaseUrl, endpoint, extraHeaders)` — JSON GET helper for REST-style sandbox endpoints that take their parameters via headers (e.g. a `detailsByVat` endpoint expecting `vatnumber` + `application-id` headers).

Both throw on non-2xx or non-JSON responses with the upstream status + truncated body in the message. Executors don't need to wrap them — let them throw; the runner catches and surfaces `ok: false`.

Set the trace env var to `<TOOL>_BACKEND_TRACE` (per-tool) so the CLI can suppress one tool's logs without affecting another's.
</backend_client_helpers>
