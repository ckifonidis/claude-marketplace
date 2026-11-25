# Decision ownership and progression

Compare instructions by trigger, decision and effect across the assembled prompt, exposed schema and returned results. Consolidate separately authored versions of the same rule at one owner. Multiple views generated from one declaration share an owner. Code can enforce the same business constraint that a verdict explains to the caller.

| Instruction owner | What belongs there |
| --- | --- |
| Main prompt | Rules that apply across actions and turns, including when tools are unavailable. |
| Tool or action description | The caller intent that selects the action and the condition that distinguishes its closest neighbor. |
| Field description | One input's meaning, permitted source, representation and omission. Keep absence distinct from an explicit negative. |
| Verdict | What this specific outcome establishes, what may be said, and what is still owed. Render caller wording from verified facts and keep internal guidance separate. |

Write rules directly, without examples, sample values or phrase lists. Narrow overlapping triggers and resolve contradictory outcomes against the workflow contract.

Code enforces admission, consent, state freshness, mandatory transitions and writes. Fetch prerequisite facts inside the operation that needs them. Choose the next step by what remains undecided.

- A specific committed verdict with one authorized successor and known arguments can dispatch through the existing guards. Preserve the original request and its subject across recovery steps.
- Outstanding consent, a choice or missing information needs the caller. Bind consent to its subject, target and parameters. Preserve permitted reads while waiting.
- If the next decision depends on the meaning of the caller's words, the model can interpret them. Ask for clarification when the distinction changes the effect and the current evidence is insufficient.
- For side effects, distinguish replay from a fresh request. Preserve completed work across restarts. Reconcile an uncertain write against authoritative state or reuse a service-enforced idempotency key. Preserve the unknown outcome if safe retry is unavailable.

Check the installed API and tool mode. In runner 4.2.0, the verdict's optional `continuation` governs progression. `"continue"` permits the rest of the current batch. `"await_caller"` ends it for a caller reply. `{ action }` ends it and requests a separate model-issued call. Required-tool mode enforces that restriction across calls in the same caller turn. A named continuation can be appropriate when the model still has to interpret an input. `proposes` opens a confirmation gate. An OTP gate opens after issuance. [Runner API](../../create-tool/references/agent-step-api.md)
