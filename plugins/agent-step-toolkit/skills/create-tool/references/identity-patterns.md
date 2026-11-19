# Reference: Identity Patterns

<overview>
Not every tool collects identity. Two models exist — pick one per tool (a single agent can mix them). The rest of the skill's references lean on the collected-and-verified model; this note makes the alternative first-class.
</overview>

<model_a_collected>
## Model A — collected-and-verified

The agent asks the user for identifying fields, an action verifies them against a backend, and a state slot records the verified entity. Downstream actions gate on a prereq that checks that slot.

Use it when the tool performs sensitive operations (mutations, anything needing proof of identity) or when identity simply isn't known until the user supplies it.

- One `verify_*` action populates the identity slot on success.
- Prereqs (`<entity>Verified`) chain off that slot.
- See the verification-executor pattern in `executor-patterns.md`.
</model_a_collected>

<model_b_session_context>
## Model B — session context (pre-authenticated / read-only)

The caller already knows who the user is and passes identity in as run context. There is nothing to collect and no verify step. Common for read-only or pre-authenticated assistants sitting behind an existing auth boundary.

- Identity lives in **input-state fields** set at invocation (e.g. a user key, a tenant/account key, a channel).
- There is **no verify action**. A single `sessionReady` verifier checks the fields are present; read actions prereq on that.
- Use a **preserve-initial reducer** so the value set on the first turn survives later turns and isn't clobbered by an empty update:

  ```ts
  sessionUserKey: Annotation<string | null>({
    reducer: (prev, next) => prev ?? next,   // first non-null wins; later turns don't overwrite
    default: () => null,
  }),
  ```
- Alternative carrier: the run's configurable bag instead of state. That fits ordinary graph nodes, but agent-step executors only receive `(params, state)` — for them, the state-field route is simpler.
</model_b_session_context>

<model_c_carried>
## In between — identity that MAY already be carried (agent-step ≥ 4.0.0)

A collected-and-verified action whose input is sometimes already in state: an identifier the caller gave an earlier agent on the same call, or a pair of session fields that together mean "authenticated". Do not branch on it by hand (a probe module, a prompt flag saying "a value is carried", an executor branch per channel) — declare it on the verify action with `satisfies`:

- **`mode: "consent"`** (the action is confirmation-gated) — an EMPTY call, with no capture supplied, proposes a rendered reuse-consent question on the action's own gate; the caller's yes executes with the carried value, which never reaches the model. Nothing usable carried → the declared `elseVerdict` row answers (typically the row that asks for the value).
- **`mode: "silent"`** (ungated) — an empty call executes immediately when EVERY declared value resolves; the bundle's completeness is the predicate (the authenticated-session pair).

A dictated value always wins, and a carried value that fails the capture's own refinement counts as nothing carried. The executor receives the resolved bundle as its third argument. See `agent-step-api.md` `<satisfies>`.
</model_c_carried>

<gotcha_defaults_are_not_values>
## Gotcha: a state default is not a value source

An `Annotation`/Zod **default** — including one wired to read an environment variable — does **not** populate graph state on its own. State fields are filled from the **invoke input**. If the caller omits a field, it stays at its default, which for session context means "absent," not "the env value."

Consequence: per-run context (who the user is, which tenant, which channel) must be **passed in by the caller on every invoke**. Don't rely on env-defaults inside the graph to supply it. The launcher (CLI, server handler, scheduler) owns reading the environment/request and threading those values into the invoke input.
</gotcha_defaults_are_not_values>

<choosing>
## Choosing

- Mutations, or any proof-of-identity requirement → **Model A**.
- Pre-authenticated, read-only, or identity-known-upfront → **Model B**.
- Mixed: session context for the principal, collected verification for a *second* party the tool acts upon.
- Collected, but the value may arrive with the call → **Model A + `satisfies`**.
</choosing>
