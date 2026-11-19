# Reference: Executor Patterns

<overview>
Executors do the actual work: parse the LLM-supplied params, call the backend, interpret the response, and **name the verdict** — the wire body (summary, doctrine, error codes, static state writes, terminal effects) is composed by the runner from the action's declared `verdicts` rows (`action.ts`). The pattern variants you'll encounter:

1. **Read-only executor** — fetches data, no state mutation (some still update state for caching, e.g. `verify_*` updates `verifiedCustomer`).
2. **Identity/verification executor** — locates an entity by user-supplied identifiers; populates state slots so subsequent actions can rely on them.
3. **Mutation executor** — modifies backend state. Owns its own pre-check (reject before write if state isn't acceptable) and post-read (verify write landed); returns `preState`/`postState`.
4. **OTP issuer (`issuesOtp` + typically `startsFlow`)** — opens a multi-turn flow and mints an SCA challenge. Returns the `otp_issued` effect plus a `merge_flow_data` effect so the consumer can read `challengeId` later.
5. **OTP consumer (`requiresOtp`)** — validates the customer's 6-digit code against the backend. Library auto-clears the gate on the ok verdict; timeout / lockout rows carry the `clear_awaiting_input` / `abort_flow` effects.
6. **Double-entry capturer + consumer (`startsMatchFor` / `requiresMatch`)** — captures the first entry into flow data (`merge_flow_data`), then verifies the repeat matches.
7. **Self-sufficient read executor** — a read that loads its own dependencies on demand instead of gating on a prior step via a prereq.
8. **Reference resolver** — turns a user's human-terms reference into a concrete entity (or a candidate set) by matching over more than primary keys.
9. **Compute / analysis executor** — runs a computation over data already in state; the agent supplies the computation, the host runs it.
10. **Router / classifier executor** — no backend; returns a decision and uses `currentFlow.data` as a cross-turn accumulator. All rows `ok: true`. See Pattern 10.

All share the same TypeScript signature; the differences are in what they read/write and how their rows are declared.
</overview>

<contract>
Every executor matches:

```ts
// `Slice` is whatever this action's stateSelector returned — NOT the whole
// state. The executor receives only its slice; its result may patch any
// HOST-OWNED slot via stateUpdate (DeclaredExecutorResult<T>, T = full state).
type Executor<Slice, T> = (params: unknown, state: Slice) => Promise<DeclaredExecutorResult<T>>;

interface DeclaredExecutorResult<T> {
  verdict: string;                 // names a row in the action's declared `verdicts`
                                   // (an undeclared verdict fails loudly as executor_error)
  data?: Record<string, unknown>;  // dynamic values the row's function fields read
  stateUpdate?: Partial<T>;        // HOST-OWNED slots only — threaded to next step, committed at end.
                                   // Library-managed slots in the patch throw (see <state_update_shape>).
  effects?: ExecutorEffect[];      // appended AFTER the row's declared effects
  resultExtras?: Record<string, unknown>;
                                   // raw fields appended to the body AFTER the row's declared fields
}

type ExecutorEffect =
  | { type: "request_handoff"; request: HandoffRequest }   // terminal; atomic cleanup + handoff slot
  | { type: "merge_flow_data"; data: Record<string, unknown> } // shallow-merge into currentFlow.data
  | { type: "otp_issued" }                                 // open the OTP gate (needs issuesOtp hook)
  | { type: "clear_awaiting_input" }                       // drop the gate, keep the flow
  | { type: "abort_flow" };                                // drop the gate AND the flow
```

Key points:
- **The division of labor**: STATIC content — summaries, doctrine `reason` strings, error codes, the `ok` flag, static state writes, terminal handoffs — lives on the ROW (one authority, in `action.ts`). The executor supplies only what is genuinely dynamic: which verdict, the diagnostics/data the row's function fields interpolate, dynamic state patches, and raw payload fields via `resultExtras`.
- `params` is `unknown` because the runner has already validated against `paramsSchema`. The first line of the executor should cast: `const p = params as MyParams;`
- `state` is the **slice** this action's `stateSelector.ts` produced from the step-start snapshot (which includes any in-batch updates from earlier steps). Import the slice type as `import type { Slice } from "./stateSelector.js"`.
- The row's `ok` controls batch continuation: `ok: false` ends the batch but commits all preceding state updates.
- Effects pair with `controller.*` hooks: `merge_flow_data` / `otp_issued` require a flow (and, for `otp_issued`, the `issuesOtp` opt) or the runner throws; `request_handoff` is honoured regardless of `ok` and ends the batch (handoff monotonicity). Declare an effect ON THE ROW when it belongs to the verdict invariantly (a terminal handoff); return it from the executor when it carries dynamic data (`merge_flow_data`). See `agent-step-api.md` `<declared_verdicts>` for the full semantics.
</contract>

<pattern_1_read_executor>
## Pattern 1: Read-only executor

Example: `check_pin` (PIN attempt counter for an active card).

```ts
// actions/check_pin/action.ts (the rows):
//   verdicts: {
//     card_not_resolved: { ok: false,
//       summary: (_s, data) => String(data.summary),
//       body: { error: (data) => data.error } },
//     ok: { ok: true,
//       summary: (_s, data) => data.locked
//         ? `PIN is LOCKED (${data.counter} failed attempts).`
//         : `PIN not locked (${data.counter} failed attempts so far).`,
//       body: {} },
//   }

// actions/check_pin/executor.ts:
import { postBackend } from "../../backend/client.js";
import { cardsEnv } from "../../backend/env.js";
import { tryResolveCard } from "../../shared/resolve-card.js";
import type { State } from "../../../../state.js";
import type { DeclaredExecutorResult } from "../../../../agent-step/index.js";
import type { Slice } from "./stateSelector.js";

interface Params { lastFour?: string; }

export async function checkPin(
  rawParams: unknown,
  state: Slice,
): Promise<DeclaredExecutorResult<State>> {
  const p = rawParams as Params;
  const card = tryResolveCard(state, p.lastFour);
  if ("error" in card) {
    return { verdict: "card_not_resolved", data: { summary: card.summary, error: card.error } };
  }

  const resp = await postBackend<{ payload?: { pinTryCounter?: number } }>(
    cardsEnv.cardsPinManagementApiBaseUrl,
    "CardsPinManagement/getPinTryCounter",
    { cardNumber: card.cardNumber, /* ... */ },
    { envelope: "payload-only" },
  );
  const counter = resp?.payload?.pinTryCounter ?? 0;
  const locked = counter >= 3;
  return { verdict: "ok", data: { counter, locked }, resultExtras: { counter, locked } };
}
```

Rules:
- No `stateUpdate` returned — read-only.
- The ok row is `ok: true` even when "negative" outcomes occur (locked PIN is still a successful read).
- An `ok: false` row only when the call failed (e.g. card resolution couldn't find the card).
- Prefer a STATIC summary on the row whenever the sentence doesn't interpolate — the function form above is for genuinely dynamic renderings (and for language-keyed catalogs, where `summary: (state, data) => messagesFor(state)...` reads the lexicon from state).
</pattern_1_read_executor>

<pattern_2_verification_executor>
## Pattern 2: Verification / identity executor

Example: `verify_customer` (locate customer by tax number + name).

```ts
// actions/verify_customer/action.ts (the rows):
//   verdicts: {
//     customer_not_found:       { ok: false, summary: "…", body: { verdict: "customer_not_found", customer: null } },
//     speaker_change_forbidden: { ok: false, summary: "…", body: { verdict: "speaker_change_forbidden", customer: null } },
//     name_mismatch:            { ok: false, summary: "…", body: { verdict: "name_mismatch",
//                                   customer: (data) => data.customer,
//                                   missing: (data) => data.missing, misplaced: (data) => data.misplaced } },
//     ok:                       { ok: true, summary: "Customer verified.", body: { verdict: "ok",
//                                   customer: (data) => data.customer } },
//   }

export async function verifyCustomer(
  rawParams: unknown,
  state: Slice,
): Promise<DeclaredExecutorResult<State>> {
  const { taxNo, firstName, lastName, fatherName } = rawParams as VerifyParams;

  const search = await postBackend<SearchResponse>(/* ... */);
  const items = search?.payload?.items ?? [];
  if (items.length === 0) {
    return { verdict: "customer_not_found" };
  }
  const c = items[0];
  const customerCode = String(c.customerCode ?? "");

  // Speaker-change guard: thread bound to one customer
  const prior = state?.verifiedCustomer?.customerCode ?? "";
  if (prior && prior !== customerCode) {
    return { verdict: "speaker_change_forbidden" };
  }

  // Name match (in-tool helper)
  const match = matchName(c, firstName, lastName, fatherName);
  if (!match.matched) {
    return {
      verdict: "name_mismatch",
      data: { customer: { /* masked */ }, missing: match.missing, misplaced: match.misplaced },
    };
  }

  return {
    verdict: "ok",
    data: { customer: { /* masked */ } },
    stateUpdate: { verifiedCustomer: { customerCode, fullName: c.name, mobile: c.mobile, taxNumber: taxNo } } as Partial<State>,
  };
}
```

Rules:
- One row per verdict code, with the doctrine on the row: `verdict ∈ { ok, not_found, mismatch, forbidden, ... }`.
- `stateUpdate` only on the ok path — populates the slot that downstream prereqs check. (A static write could live on the row; the customer object here is dynamic, so it rides the executor.)
- The row's `ok` mirrors `verdict === "ok"` *here by choice*: a failed verification should stop the batch because downstream steps gate on the slot this would populate. `ok` is the runner's batch-continuation control, not a success signal (contrast Pattern 1) — set it `false` only when the batch should not continue.
- Speaker-change / cross-entity guards live INSIDE the verification executor, not in the runner.
- Pin everything later actions might need (mobile for SCA, taxNumber for re-identification on mutations) in the state slot. Re-prompting later costs a turn.
- Recoverable misses that re-ask a caller value pair naturally with a standing ask: declare `ask: "self"` on the row (`name_mismatch: { ok: false, summary: …, body: {…}, ask: "self" }`) so the engine records the standing question (see `agent-step-api.md` `<standing_asks>`). The re-ask after an unparseable capture is derived — never declared.
- When the identifier may already be in state (carried by the channel, or implied by an authenticated session), declare `satisfies` on the action instead of branching by hand: an EMPTY call is then answered from state and the executor receives the resolved bundle as its third argument (`agent-step-api.md` `<satisfies>`).
</pattern_2_verification_executor>

<pattern_3_mutation_executor>
## Pattern 3: Mutation executor with internal pre-check + post-read

Example: `change_status` (freeze/cancel a card).

```ts
// actions/change_status/action.ts (the rows):
//   verdicts: {
//     card_not_resolved:  { ok: false, summary: (_s, d) => String(d.summary), body: { error: (d) => d.error } },
//     mutation_blocked:   { ok: false,
//       summary: (_s, d) => `Card is already ${d.preState}; mutation refused.`,
//       body: { error: "mutation_blocked_already_closed", verdict: "mutation_blocked_already_closed" } },
//     write_failed:       { ok: false, summary: "Card status change did not persist.",
//       body: { success: false } },
//     ok:                 { ok: true,
//       summary: (_s, d) => `Card status change persisted; new state: ${d.postState}.`,
//       body: { success: true } },
//   }

export async function changeStatus(
  rawParams: unknown,
  state: Slice,
): Promise<DeclaredExecutorResult<State>> {
  const p = rawParams as ChangeStatusParams;
  const card = tryResolveCard(state, p.lastFour);
  if ("error" in card) {
    return { verdict: "card_not_resolved", data: { summary: card.summary, error: card.error } };
  }

  // ─── Pre-read: get current state to decide whether the mutation is even valid
  const preState = await fetchCardState(card.cardNumber);
  if (preState.startsWith("permanently_closed_") || preState === "cancelled") {
    return { verdict: "mutation_blocked", data: { preState }, resultExtras: { preState } };
  }

  // ─── Write
  const resp = await postBackend<{ payload?: { success?: boolean } }>(
    cardsEnv.cardsManagementApiBaseUrl,
    "CardsManagement/changeCardStatus",
    { cardNumber: card.cardNumber, newStatus: p.newStatus, /* ... */ },
    { envelope: "payload-only" },
  );
  if (resp?.payload?.success !== true) {
    return { verdict: "write_failed", resultExtras: { preState } };
  }

  // ─── Post-read: verify the write landed
  const postState = await fetchCardState(card.cardNumber);

  return {
    verdict: "ok",
    data: { postState },
    resultExtras: { newStatus: p.newStatus, preState, postState },
  };
}
```

Rules:
- **Always** pre-read before writing. The pre-read decides whether the mutation should happen at all.
- **Always** post-read after a successful write. The post-read is the receipt — `postState` is what the LLM speaks to confirm the action took effect.
- Both `preState` and `postState` ride `resultExtras` onto the body. The prompt teaches the LLM to read `postState` for the spoken confirmation.
- The executor owns the pre-read and post-read. The library does not wrap reads around mutations.
- The library DOES manage the propose → execute lifecycle around this executor. Your executor only runs in execute mode (matching pending params). The propose mode never calls your executor.
- Mutations typically declare `soleOnExecute: true` (LLM-friendly relaxation: propose may ride with prereq verifications) or `soleStep: true` (strict alone). See `agent-step-api.md`.
- A TERMINAL outcome (e.g. an identification dead-end that must escalate) declares its
  `request_handoff` effect and its outcome `stateUpdate` ON THE ROW — armed atomically with the
  verdict, never forkable from it.
</pattern_3_mutation_executor>

<pattern_4_otp_issuer>
## Pattern 4: OTP issuer (`issuesOtp` + `startsFlow`)

Opens a multi-turn flow and mints an SCA challenge. The library wires `awaitingInput.kind = "otp"` for the named consumer when the ok verdict carries the `otp_issued` effect.

Example: `request_card_activation` (simplified).

```ts
// actions/request_card_activation/action.ts (rows + controller):
//   verdicts: {
//     card_not_resolved: { …as above… },
//     otp_send_failed:  { ok: false, summary: "SCA challenge failed.", body: { error: "otp_send_failed" } },
//     ok: { ok: true,
//       summary: (_s, d) => `OTP sent to ${d.masked}. Ask the customer to read back the 6-digit code.`,
//       body: { otp_sent: true, mobile_masked: (d) => d.masked },
//       effects: [{ type: "otp_issued" }] },   // invariant for this verdict → lives on the row
//   },
//   controller: {
//     startsFlow: { name: "card_activation" },
//     issuesOtp: { consumer_action: "confirm_otp" },
//   }

export async function requestCardActivation(
  rawParams: unknown,
  state: Slice,
): Promise<DeclaredExecutorResult<State>> {
  const p = rawParams as RequestCardActivationParams;
  const card = tryResolveCard(state, p.lastFour);
  if ("error" in card) return { verdict: "card_not_resolved", data: { summary: card.summary, error: card.error } };

  // Owner-of-record check, PSD T&Cs, eligibility checks…
  // (Each can short-circuit with its own declared refusal verdict.)

  // Mint the SCA challenge.
  const ch = await postBackend<{ payload?: ChallengePayload }>(
    cardsEnv.scaApiBaseUrl,
    "sca/challenge",
    { userId: customerId, application: cardsEnv.applicationId, /* ... */ },
  );
  const challengeId = ch?.payload?.challengeId;
  const masked = ch?.payload?.sentNotificationData?.details?.[0]?.recipients?.[0]?.maskedRecipient ?? "";
  if (!challengeId) {
    return { verdict: "otp_send_failed" };
  }

  return {
    verdict: "ok",
    data: { masked },
    effects: [
      // Scratch data the consumer (confirm_otp) will read from currentFlow.data —
      // dynamic, so it rides the executor return (the otp_issued effect is on the row).
      {
        type: "merge_flow_data",
        data: {
          customerId,
          challengeId,
          cardNumber: card.cardNumber,
          psdAccepted: p.psdAccepted === true,
        },
      },
    ],
  };
}
```

Idempotency: re-running the same issuer while its flow is already active does NOT reset `currentFlow.data` (`merge_flow_data` merges idempotently). Useful for "the customer asked to resend the code" — re-call the issuer, get a fresh `challengeId`, the consumer reads the new one.
</pattern_4_otp_issuer>

<pattern_5_otp_consumer>
## Pattern 5: OTP consumer (`requiresOtp`)

Validates the customer's 6-digit OTP against the backend. The library:
- Refuses unless `awaitingInput.kind === "otp"` for this action (error: `otp_not_pending`).
- Auto-clears `awaitingInput` on the ok verdict.
- Does NOT count attempts (backend-authoritative).

The executor reads `challengeId` from the flow data its selector exposes (no extra params needed beyond the OTP digits).

Example: `confirm_otp`.

```ts
// actions/confirm_otp/action.ts (the rows — gate signals are invariant per verdict, so
// the effects live on the rows):
//   verdicts: {
//     no_flow_data: { ok: false, summary: "No flow in progress for OTP validation.", body: { error: "no_flow_data" } },
//     otp_locked:   { ok: false, summary: (_s, d) => `OTP locked. ${d.flowName} flow cleared.`,
//                     body: { error: "otp_locked", verdict: "otp_locked" },
//                     effects: [{ type: "abort_flow" }] },
//     otp_timeout:  { ok: false, summary: "OTP timed out. Offer to resend.",
//                     body: { error: "otp_timeout", verdict: "otp_timeout" },
//                     effects: [{ type: "clear_awaiting_input" }] },
//     otp_invalid:  { ok: false, summary: "OTP incorrect. Ask the customer to read it again.",
//                     body: { error: "otp_invalid", verdict: "otp_invalid" } },
//     ok:           { ok: true, summary: "OTP validated. Proceed to the next flow step.",
//                     body: { otp_valid: true },
//                     effects: [{ type: "merge_flow_data", data: { otpValidated: true } }] },
//   }

export async function confirmOtp(
  rawParams: unknown,
  state: Slice,
): Promise<DeclaredExecutorResult<State>> {
  const { otp } = rawParams as ConfirmOtpParams;
  const flow = state?.currentFlow;
  if (!flow) return { verdict: "no_flow_data" };
  const flowData = flow.data as OtpFlowData;

  const resp = await postBackend<{ payload?: { valid?: boolean }; exception?: BackendException }>(
    cardsEnv.scaApiBaseUrl,
    "sca/validate",
    { userId: flowData.customerId, challengeId: flowData.challengeId, token: otp, /* ... */ },
  );

  if (resp?.exception?.code === "SCA012" || resp?.exception?.code === "SCA002") {
    return { verdict: "otp_locked", data: { flowName: flow.name } };   // terminal; row aborts the flow
  }
  if (resp?.exception?.code === "SCA006" || resp?.exception?.code === "SCA005") {
    return { verdict: "otp_timeout" };                                 // row drops the gate, keeps the flow
  }
  if (resp?.payload?.valid !== true) {
    return { verdict: "otp_invalid" };                                 // row leaves state alone; retry
  }
  return { verdict: "ok" };                                            // library auto-clears the gate
}
```

Rules:
- The gate signals are mutually exclusive per verdict: `abort_flow` (terminal) or `clear_awaiting_input` (recoverable). Never both — which is exactly why they belong on the rows.
- The `merge_flow_data` write on success (`otpValidated: true`) is the natural way to gate the next step in the flow (the next action can refuse if flow data lacks it).
- The library prevents replay: once the gate clears, this executor can't run again until a fresh issuer fires.
</pattern_5_otp_consumer>

<pattern_6_double_entry_match>
## Pattern 6: Double-entry capturer + consumer (`startsMatchFor` / `requiresMatch`)

The customer provides a value once (capturer), then again (consumer); the library counts mismatches against a budget and aborts the flow on exhaustion. Used for PIN setup, password change, secret-answer confirmation.

### Capturer

```ts
// action.ts: controller: { requiresFlow: "pin_setup", startsMatchFor: { consumer_action: "commit_pin" } }
// rows: pin_rule_violation { ok:false, summary: (_s,d)=>String(d.summary), body: { error: "pin_rule_violation", verdict: (d)=>d.reason } },
//       ok { ok:true, summary: "PIN captured. Ask the customer to repeat the PIN.", body: { pin_accepted: true } }

export async function proposeNewPin(
  rawParams: unknown,
  state: Slice,
): Promise<DeclaredExecutorResult<State>> {
  const { pin } = rawParams as { pin: string };
  const ruleResult = validatePin(pin);
  if (!ruleResult.ok) {
    return { verdict: "pin_rule_violation", data: { summary: ruleResult.summary, reason: ruleResult.reason } };
  }

  const encrypted = await encryptPin(pin);
  return {
    verdict: "ok",
    effects: [{ type: "merge_flow_data", data: { encryptedPin: encrypted } }],
  };
}
```

Library on the ok verdict: sets `awaitingInput.kind = "match"` for the consumer with `attempts_left = consumer.requiresMatch.maxAttempts`. Re-running the capturer mid-match resets that counter.

### Consumer

```ts
// action.ts: controller: { requiresFlow: "pin_setup", requiresMatch: { capturer: "propose_new_pin", maxAttempts: 3 }, endsFlow: true }
// rows: match_capturer_missing { ok:false, … }, match_mismatch { ok:false,
//         summary: "PINs do not match. Ask the customer to repeat.",
//         body: { error: "match_mismatch", verdict: "match_mismatch" } },
//       ok { ok:true, summary: "PIN set successfully.", body: { success: true, masked_pin_last2: (d)=>d.masked } }

export async function commitPin(
  rawParams: unknown,
  state: Slice,
): Promise<DeclaredExecutorResult<State>> {
  const { pin: confirmPin } = rawParams as { pin: string };
  const stored = (state.currentFlow?.data as { encryptedPin?: string } | undefined)?.encryptedPin;
  if (!stored) return { verdict: "match_capturer_missing" };

  // Encrypt the second entry the same way and compare. Host owns the comparison;
  // library owns the counter (it reads the row's body verdict "match_mismatch").
  const confirmEncrypted = await encryptPin(confirmPin);
  if (confirmEncrypted !== stored) {
    // Library injects attempts_left back into the result entry; do NOT include it.
    return { verdict: "match_mismatch" };
  }

  await persistPin(/* ... */);
  return { verdict: "ok", data: { masked: `**${confirmPin.slice(-2)}` } };
}
```

On the ok verdict: library auto-clears `awaitingInput`. The `endsFlow: true` opt also clears `currentFlow`.

On `ok: false` + body `verdict: "match_mismatch"`: library decrements `attempts_left`. On exhaustion, library clears both slots and re-shapes the result entry to surface `error: "match_attempts_exhausted"`, `verdict: "match_attempts_exhausted"`, `attempts_left: 0`.

On `ok: false` + any other verdict: library leaves state alone (this is a "real" failure, e.g. backend error, not a mismatch).

**Folded consumer-issuer ("confirming the value sends the code").** The consumer may additionally declare `issuesOtp` when the successful match should immediately mint an SCA challenge — one action that consumes the repeat AND issues. On its ok verdict the runner clears the consumed match gate first, then `otp_issued` opens the OTP gate (consume-before-issue); on a mismatch nothing is issued and the match gate stands. The match-then-OTP ordering guard exempts the match's own consumer, so this shape is not refused. See `agent-step-api.md` `<otp_lifecycle>`.
</pattern_6_double_entry_match>

<pattern_7_self_sufficient_read>
## Pattern 7: Self-sufficient read executor

For reads, prefer an executor that **loads its own dependencies** over one that gates on a prior step via a prereq. Prereq verifiers are the right tool for *safety* gates (identity; an active entity before a mutation) — but using them to enforce mere sequencing ("you must have listed the inventory first") causes two recurring failures:

- The model reports an empty or negative answer from a slot that was simply never loaded.
- The model asks the user for an identifier it could have looked up itself.

Instead, a self-sufficient read resolves what it needs on demand:

```ts
export async function getItemDetails(rawParams, state): Promise<DeclaredExecutorResult<State>> {
  const p = rawParams as { ref?: string };
  // Auto-load the inventory if it isn't in state yet, rather than refusing on a prereq.
  const inventory = state.items ?? (await loadInventory(state));
  const item = resolveRef(inventory, p.ref);          // see Pattern 8
  if (!item) return { verdict: "not_found" };
  // ... fetch and return { verdict: "ok", resultExtras: { details } } ...
}
```

Rules:
- Keep the identity/session prereq as the only prereq; let the executor own everything downstream of identity.
- Reserve prereq verifiers for genuine gates, not sequencing hints. (See also the "unloaded vs. empty" prompt rule in `state-and-prompt-integration.md`.)

The flip side of this negative rule is the positive one (principle #11): the prereqs you *do* keep are how the tool encodes **where the user is in their journey** — identity acquired, entity selected, flow open. That's their job; sequencing isn't.
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
- For references that could span **separate namespaces** (two entity types, two collections), don't blind-match across them. Let the model tag the namespace via a typed param and resolve within it (the `exactlyOneOf` capture builder gives the XOR shape).
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

<pattern_10_router_classifier>
## Pattern 10: Router / classifier executor

Not every agent-step tool fetches data. A router/classifier (e.g. an IVR intent router) uses the runner as a deterministic step engine with no backend at all. The shape inverts several assumptions the data-tool patterns above make, and that is fine:

- **One action, called repeatedly.** A single action (e.g. `narrow`) advances one level of a decision tree per step. The LLM batches several picks in one tool call; the runner threads them in order.
- **All rows `ok: true`; the decision lives in the body.** Every outcome — a match, an ambiguous set, an invalid pick, a terminal route — is a row with `ok: true`, carrying the decision in its body (e.g. `{ kind: "Candidates" | "Route" | "Fallback" | "InvalidPick" }`). This is the deliberate use of the `ok` contract: `ok` controls **batch continuation**, not success. The router *wants* the whole batch to run so the walk threads end-to-end, so no row returns `ok: false` for a "logically negative" pick. (Contrast Pattern 2's verification executor, whose miss rows are `ok: false` precisely to stop the batch.)
- **`currentFlow.data` as a cross-turn accumulator.** Open the walk with `startsFlow`, accumulate the path via `merge_flow_data` effects (shallow-merged into `currentFlow.data`), and reset on a terminal step via an `abort_flow` effect (or `endsFlow`). The flow rehydrates next turn, so a multi-turn clarification continues from where it left off.
- **No prereqs, no pagination, no mutation gates.** Routing gates nothing on journey-state, returns one decision (not lists), and performs no side effects — so verifiers, `pageable`, and the confirmation/OTP/match machinery are all simply unused.
- **Mind the goal-switch.** Because a non-terminal turn leaves the flow open (no `abort_flow`), an unrelated new goal next turn must be handled by the host — drive a `restart`/`abort_flow`, since the library never resets a flow implicitly (see `startsFlow` doc).

The library *core* (config → schema → selector→executor dispatch → row normalization → flow-data threading → Command commit) generalises cleanly to this shape; only the data-tool surface goes unused.
</pattern_10_router_classifier>

<state_update_shape>
## stateUpdate semantics

A `stateUpdate` patch — whether declared statically on a row or returned dynamically by the executor (the executor's wins on key conflicts) — flows through TWO consumers:
1. **In-batch threading** — subsequent steps in the same batch see the updated value via the runner's `view`.
2. **Final commit** — landed in the LangGraph state at the end of the tool call.

Both consumers go through the reducers declared in `state.ts`. So:
- Replace-on-write slots (e.g. `verifiedCustomer`, `activeCardNumber`) → just put the new value in the patch.
- Record-by-key merge slots (e.g. `verifiedCards`) → put a single-key record in the patch; the reducer merges.

Pattern:
```ts
return {
  verdict: "ok",
  stateUpdate: {
    verifiedCustomer: customer,                         // replace
    verifiedCards: { [cardNumber]: card },              // record merge
    activeCardNumber: cardNumber,                       // replace
  } as Partial<State>,
};
```

Static writes that never vary per call belong on the row (`VerdictDef.stateUpdate`), e.g. an outcome
tag `{ lossReportOutcome: "identification_dead_end" }`. You can return state updates from `ok: false`
verdicts too — they land; most failure paths just don't carry one.

**`stateUpdate` is domain-only (enforced).** Writing any RUNNER-owned slot — `awaitingInput`, `currentFlow`, `pagedRead`, `spentLadders`, `handoff`, `errorCount` — through it throws at runtime. Library transitions go through the `ActionDef.controller.*` opts and `effects` instead; a terminal handoff in particular is the `{ type: "request_handoff", request }` effect (which also gets the built-in action's atomic cleanup), never a slot write.
</state_update_shape>

<error_handling>
- **Backend HTTP error** — let the `postBackend` helper throw; the runner catches the throw at the executor boundary, marks the step `ok: false` (`error: "executor_error"`), and short-circuits. The agent's prompt should handle these gracefully ("a temporary technical problem"). For failures the caller should hear about specifically, catch and name a declared failure verdict instead — a row with `backendFailure: true` also feeds the auto-handoff counter.
- **Domain "negative" outcome** (e.g. `card_not_found`, `name_mismatch`) — name its declared `ok: false` row. The batch short-circuits cleanly.
- **Library-managed gate failure** (no flow, no OTP awaiting) — the runner intercepts BEFORE calling the executor, with error codes `no_flow_active` / `wrong_flow` / `otp_not_pending` / `match_not_pending`. You don't need to check these in the executor; they're library-enforced.
- **Unrecoverable bug** — throw. The runner catches and short-circuits. Naming an undeclared verdict is the same class of bug and fails the same way.

Never silently swallow errors. The LLM relies on the row's `summary` to know what went wrong.
</error_handling>

<voice_safe_results>
The row-composed body is LLM-facing JSON — the LLM reads it before producing the spoken response. The LLM's spoken response (the AIMessage that follows the ToolMessage) is what TTS speaks; THAT must be voice-safe.

But the result body still shouldn't include:
- Long, repetitive prose (wastes tokens)
- Internal IDs the customer would never hear (e.g. full PAN, raw challenge IDs)
- Sensitive raw data (the new PIN's plaintext — only persist ciphertext in flow data; only echo masked tails in the summary)

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
