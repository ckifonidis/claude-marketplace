# Intake (b): from an existing agent-step codebase

The agent exists. The job is to recover its ladder from the code, mark what each step and call is today,
and — when a walkthrough or brief exists as well — show the gap between the two.

<process>

## 1. Locate the declarations

Find the library version first: `src/agent-step/VERSION` — then `diff -r src/agent-step
<toolkit>/skills/create-tool/templates/agent-step` (ignore tests). The file can lie: projects patch their
"immutable" copy (a local `readOnly` flag; a 3.0.1 fix inside a copy still labelled 3.0.0). Record any
local patch as an open item and in `status_note`. Where the declarations live depends on the version:

| Library | Actions declared in | Outcomes declared in |
|---|---|---|
| 3.x | the scaffold layout puts each in `src/tools/<tool>/actions/<action>/action.ts` (+ `names.ts`, `config.ts` assembles) — but many 3.x projects still declare everything inline in one `config.ts`; grep both | the action's `verdicts` rows |
| < 3.0 | `src/tools/<tool>/config.ts` (one `defineConfig`, often with shared controller presets) | the executor's return bodies (`ok`, `resultBody`, lifecycle) |

Then read, per tool: `index.ts` (handoff, ladders, abortPolicy, messages), `verifiers/*.ts` (each
prereq's predicate — which state slot it reads), `state.ts` (slots), and the prompt — `src/prompt.ts`
or wherever it is assembled (a prompt registry, per-channel variants). The taught order and the example
batches show the ladder the model is taught. When the prompt differs per channel or per caller type
(anonymous vs authenticated), draw one ladder with a branch step per variant, and say in
`meta.source_of_truth` which variants were read.

Greps that list the surface quickly (scaffold layout; when the declarations are inline, point them at `config.ts`):
```bash
grep -rnE "prereqs:|requiresConfirmation|soleStep|soleOnExecute|startsFlow|requiresFlow|endsFlow|issuesOtp|requiresOtp|startsMatchFor|requiresMatch|pageable|asks:|captureBounces|invalidatesOnChange" src/tools/*/actions/*/action.ts
grep -rn 'verdict: "' src/tools/*/actions/*/executor.ts
grep -rnE "request_handoff|otp_issued|abort_flow|clear_awaiting_input|merge_flow_data" src/tools
grep -nE "handoff:|ladders|abortPolicy|modelRequestSchema|clearsOnHandback" src/tools/*/index.ts
```
Presets and spreads (`...SECTION_WRITE`) hide options from these greps — resolve every spread and shared
constant before concluding an action lacks a gate. That is how the reference audit got one of its three
wrong "does not exist" claims.

For a large surface, dispatch research brief (c) (`references/research-briefs.md`) instead of reading
every file in the main context.

## 2. Actions are not steps — group them

A step is what the USER experiences as one stretch of the conversation. Derive steps from the actions:

| In the code | In the ladder |
|---|---|
| an action that writes, consumes a gate, or ends a flow | a step's **closing action**; its backend calls are the step's **triggers**, in executor order |
| gather/collect actions, lookups, reads with no gate | inside the step they serve (`required`, `lookups`) |
| `requiresConfirmation` on the closing action | the completion clause ("the caller confirms the read-back") — one step, not two |
| `issuesOtp` on A, `requiresOtp` on B | TWO steps: the human reads a code out between them |
| `startsMatchFor` / `requiresMatch` | capture step → confirm step (double entry) |
| a prereq P on B whose verifier reads slot X that A writes | an edge A → B |
| a ✗ verdict row / an error body | a failure outcome (`kind: "fail"`), usually a self-loop or a back edge |
| `invalidatesOnChange {X: [Y]}` | a back edge: changing X re-opens the step that set Y |
| a `startsFlow` … `endsFlow` span | the steps inside it (often just a code's send + read-back); name the flow in their `engine`. If the code keeps the whole journey in one flow with editable read-backs inside it, that is a `change` — see `references/engine-notation.md` §Pitfalls |
| `request_handoff` / a handoff route | a terminal |
| one human answer that picks between two actions (agree → A, decline → B) | ONE step whose outcomes name both; its `engine` lists both closing actions |
| a step closed today by two model-batched actions (A then B) | keep it one step. If every failure of A is a ✗ row, the batch already stops where it should: status `exists`, and say so in a `decisions` block. If A can return a business conflict as ✓, B would still run: status `change` — fold the chain into one executor |
| one action that consumes a double-entry match AND issues an OTP (the 3.0.1 fold: "confirming the value sends the code") | it closes the repeat step; the code read-back is the next step |
| an opening the tool picks from state (a no-params first call that asks whatever is missing) | the step's `opens`; the `engine` says the question is state-derived |
| a stretch with no action at all (a greeting, the prompt choosing a path) | a step whose `engine` says so plainly — "no action: a speaking turn; routing only" — and `status_note` says where the routing lives |
| the off-topic / abandon handback reachable from anywhere | not an edge: list it in `meta.global_exits` (shown under the page title and in the md ladder) |

If the owner has grouped actions into thematic steps before (a walkthrough, a redesign note), their
grouping wins; the code supplies status and evidence.

## 3. Status and evidence per step and trigger

- `exists` — the closing action and its calls are there and behave as the ladder needs. Evidence: the
  executor's `file:line` where the call is made.
- `change` — they exist but need a change (wrong gate, wrong order, a missing prereq, two model-driven
  calls that must fold into one executor). `status_note` says exactly what, with `file:line`.
- `new` — nothing in the code does it.
- `tbd` — you could not establish it (and say how you searched).

Read every executor body you cite. A name ("verify_otp") is not evidence of behaviour.

## 4. Routes without a brief

In mode (b) alone there is usually no brief: leave `spec` empty and md §5 says so. Use `route_notes`
for routes worth listing that no single trigger owns (a shared client, a base URL switch).

## 5. Engine column on an old library

When the project vendors an older agent-step, write the engine column for the **current** library (the
target) and put the old mechanism in `status_note`. Never copy a pre-3.0 term into the engine column;
the validator refuses removed primitives and `readOnly`.

## 6. Continue

Go to `workflows/document-flow.md`. Phase 0 is mostly done; start Phase 1 with the derived ladder and
show it to the user before writing the spec.

</process>
