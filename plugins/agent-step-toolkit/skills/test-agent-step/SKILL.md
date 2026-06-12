---
name: test-agent-step
description: The testing methodology for an agent-step action — three layers, three questions. Runner unit tests prove the flow controller's mechanics (no backend, no LLM). Sandbox/tool tests prove the runner + executors behave correctly given hand-crafted step batches against a real local sandbox (no LLM). Prompt-input tests prove the LLM emits the right steps given a realistic user message (live model, no execution). Use when adding or reshaping an action's tests, or changing a prompt section that routes to an action.
---

<objective>
For a vertical slice of the agent — one config entry, one executor, one prompt block — produce tests at the layers that apply: a **sandbox test** proving the runner + executor behave correctly given explicit step batches, and (when the LLM has a routing decision) a **prompt-input test** proving the model emits those batches given realistic user utterances. The library's own **runner unit tests** cover the flow-controller mechanics and rarely need extending for a new action.

The most common failure mode is conflating the layers — asserting on the LLM's `tool_calls` in a sandbox test, or asserting on executed runner state in a prompt-input test. The boundaries below exist to prevent that.
</objective>

<quick_start>
1. **Pick the layer** for what you're testing. Flow-controller mechanics → runner unit. Runner + executor behaviour → sandbox. LLM routing → prompt-input. Some slices need more than one.
2. **Sandbox test**: file under `src/tools/<tool>/tests/tool/`. Imports from the tool's `tests/tool/_setup.ts` (which bundles `toolOpts`, `seedState`, `resetToSeed`, and re-exports `runSteps` from the shared harness). Calls `runSteps(toolOpts, [...steps], state)` directly. Asserts on `body.results[i]`, `body.failed_at`, and `committed.*` slot values. Resets a real local sandbox to the checked-in `seed.json` in `before`.
3. **Prompt-input test**: file under `src/tools/<tool>/tests/prompt-input/`. Imports the turn drivers + `expect*` helpers from the shared harness at `src/test-harness/prompt-input.ts`. Asserts on the emitted steps. Gated behind `PROMPT_INPUT_LIVE` (live model, costs money).
4. **Run them** with the project's scripts: `npm test` (library unit tests — fast, scoped to `dist/agent-step/*.test.js`: `runner.test.js` + `paginate.test.js`), `npm run test:sandbox` (per-tool sandbox tests; needs the local sandbox up), `npm run test:prompt` (prompt-input; sets `PROMPT_INPUT_LIVE=1`). The sandbox/prompt scripts discover compiled test files via a guarded `find`, so they only run the layer they name.
5. **Failing tests are findings, not flakes.** If a test fails for a real reason, rename it with a `FINDING:` prefix and document it under the test directory's `FINDINGS.md`. Do not relax the assertion.
</quick_start>

<process>

<phase name="1_pick_layer">
**Phase 1: pick the right layer**

Three layers, three distinct questions. Mixing them produces useless tests.

| Layer | Asks | LLM? | Backend? | Cost / latency |
|-------|------|------|----------|----------------|
| Runner unit (`src/agent-step/runner.test.ts`) | "Given a config + step batch, does the flow controller gate/sequence correctly?" | No | No (synthetic executors) | Instant, free |
| Sandbox / tool (`tests/tool/`) | "Given these explicit steps, do the runner + executors do the right thing?" | No | Real local sandbox | Fast, free |
| Prompt-input (`tests/prompt-input/`) | "Given this user message, does the prompt route to the right steps with the right params?" | Yes (live model) | Not invoked — assert on the emitted steps before execution | Per-call cost; gated behind an env flag |

How to classify a bug:

- A bug in the executor's verdict mapping → **sandbox** (the LLM wouldn't change the answer).
- A bug where the LLM forgets to batch a prerequisite read before a dependent step → **prompt-input** (the runner would happily run whatever the LLM emitted; the question is what it emitted).
- A bug where a not-found verdict should make the LLM re-ask the user (no tool call) → **prompt-input** with a "no tool call" assertion.
- A bug where the runner mis-gates a confirmation/OTP/match/flow interaction → **runner unit** if it's a generic mode bug, **sandbox** if it's this action's wiring.

If a slice needs more than one layer, write more than one. They're cheap (except prompt-input, which is merely not free).
</phase>

<phase name="2_sandbox_test">
**Phase 2: the sandbox / tool test**

File: `src/tools/<tool>/tests/tool/<name>.test.ts`. It imports everything from the directory's `_setup.ts` — `runSteps`, `toolOpts` (the bundled config + stateAnnotation + selectors + executors + verifiers, selectors and executors keyed by action name), `seedState`, `resetToSeed`, `foldCommitted`, `assert` — which in turn re-exports the shared `src/test-harness/sandbox.ts`. Never import runner internals directly. Read the generated `_setup.ts` for the exact helper names; the shape:

- A `before` hook asserts the sandbox is reachable, routes the env at it, and resets it to the checked-in seed. Layer any per-suite fixtures on top of the seed via the setup helpers — don't edit the seed file unless the data is broadly useful.
- Each `test` invokes `runSteps` with a hand-crafted step batch and asserts on the **result**, not on HTTP.

**What to assert**

- `body.failed_at` — `undefined` for success; the failing index when the batch short-circuits.
- `body.results[i].ok` — the executor's boolean.
- `body.results[i].verdict` — the structured outcome code (`ok`, and the specific failure codes the executor declares).
- `committed.<slot>` — state mutations the runner accepted (verified entities, the active flow, pending-input slots).
- For multi-batch flows, fold one batch's committed mutations into the next batch's starting state with the directory's threading helper — that mirrors what the graph does between turns.

**What NOT to assert**

- Anything about `tool_calls` or the LLM's wording — there is no LLM in this layer.
- Exact HTTP shapes — that's the executor's concern; assert on the verdict it returns.

**Coverage bar per action:** one happy-path verdict; each terminal verdict the executor can return; one short-circuit case (a downstream step's prereq fails because an upstream step returned non-ok — assert `failed_at` is the upstream index and the downstream step did not run); and, for any flow-controller mode the action declares, at least one test exercising it.

**Sandbox enrichment.** If the action reaches a backend the local sandbox doesn't model yet, extend the sandbox with the canonical envelope/response shape, then write the executor and test against it. Do not stub the backend in-process — in-process mocks diverge from production envelope/exception behaviour and hide real bugs. The sandbox itself is the project's root `sandbox/` service; its required shape (lifecycle CRUD at `/sandbox`, `Sandbox-Id` header isolation, JSON seeding via PUT — what `resetToSeed` builds on) is defined in the create-tool skill's `references/sandbox-contract.md`.
</phase>

<phase name="3_prompt_input_test">
**Phase 3: the prompt-input test**

File: `src/tools/<tool>/tests/prompt-input/<topic>.test.ts`. Imports come **only** from the shared prompt-input harness at `src/test-harness/prompt-input.ts` — never from runner internals or from the sandbox `_setup.ts`. The harness gives you single-turn (`runUserTurn`) and multi-turn (`runTurn` + `priorToolTurn`) drivers plus a family of `expect*` assertions over the emitted steps (`expectAction`, `expectActionsInOrder`, `expectActionPresent`, `expectActionAbsent`, `expectParam`, `expectParamMatches`, `expectNoToolCall`, `expectContentMatches`).

- The `describe` is **conditionally skipped** via the harness's `promptInputEnabled()` / `promptInputSkipReason` (the gate is `PROMPT_INPUT_LIVE=1` + model credentials). Always pass that skip reason through so the suite is a no-op in environments that can't run it: `describe(name, { skip: promptInputEnabled() ? false : promptInputSkipReason }, () => { … })`.
- A **single-turn** test feeds one user utterance and asserts the emitted action(s) and params.
- A **multi-turn** test feeds prior turns (user message + the tool call the assistant produced + the tool's reply payload) and asserts on the next turn — this is how you test recovery paths.

**What to assert**

- The emitted action at an index, or the exact ordered list, or order-independent presence when the model has latitude.
- A forbidden action is absent.
- A specific param value (including channel-specific shapes, e.g. an ambiguous spoken number producing multiple candidates).
- "No tool call" for branches where the model should ask the user something instead of acting.
- A content sanity check for the channel (e.g. a script/locale regex) — never the exact wording.

**What NOT to assert**

- The exact wording of the reply. The prompt is a contract for *what* gets said, not a template; brittle string matches rot.
- `committed` or anything post-execution — the prompt-input layer stops at the emitted steps.

**Coverage bar per routing decision:** one happy single-utterance path; one ambiguity case where applicable (assert the model produces candidates or asks for clarification); one recovery case (a prior non-ok verdict → the next turn asks appropriately); and, if this is the first action the user hits, one off-topic case **matched to the agent's role**: standalone → polite refusal, no tool call; specialized → a brief aside answered inline with no handback, plus a substantive topic change emitting the sole `off_topic` handback step; orchestrator → in-domain: routed to the covering agent's handoff (or handled), never refused; out-of-domain: the fixed steer-back line, no tool call.

Prompt-input runs are serialised to stay under model rate limits and cost real money. When iterating, target a single compiled test file rather than the whole suite.
</phase>

<phase name="4_findings_not_flakes">
**Phase 4: failing tests are findings, not flakes**

When a test fails for a real reason — the prompt misroutes, the runner drops a verdict, the executor loses a field — **do not relax the assertion or delete the test**. A relaxed assertion is a silent production regression; a finding is a paragraph in `FINDINGS.md`.

1. **Rename** the test with a `FINDING:` prefix so it stays visible in spec-reporter output. It still runs; it's flagged.
2. **Document** it in the matching `FINDINGS.md` (one under `tests/tool/`, one under `tests/prompt-input/`): test name, observed behaviour, expected behaviour, why it matters (channel / money / audit impact), severity, and candidate tightenings (prompt edit, library change, schema tweak). Closed findings stay as breadcrumbs.

Genuine flakes (rate-limit errors, transient connection failures, model latitude between two acceptable phrasings) are different — skip them with a reason that links the finding, but only after arguing why it's a flake and not a regression. The default assumption is regression.
</phase>

<phase name="5_slice_rhythm">
**Phase 5: the per-slice rhythm**

Build one capability at a time. A slice is: config entry → executor → sandbox test → prompt section → prompt-input test.

Order matters: write the sandbox test against the executor **before** touching the prompt, so the prompt-input test grades the model against a stable runner contract. If a prompt-input test fails because the executor isn't ready, the prompt is being graded against a moving target.

**Acceptance for one slice:** typecheck clean; the sandbox test (filtered to the slice) green; the prompt-input test (filtered to the slice) green or any failures triaged as `FINDING:`; the prompt section points at the new action with no safety logic in it; no dead actions, orphan executors, or orphan tests.
</phase>

</process>

<reference_files>
- `src/agent-step/runner.ts` — the flow controller. Reading it once end-to-end is worth more than any spec.
- `src/agent-step/runner.test.ts` — the runner unit tests; they double as documentation of every mode.
- `src/test-harness/prompt-input.ts` — shared prompt-input harness: turn drivers + `expect*` helpers + gating. Import from here for prompt-input tests, never from runner internals.
- `src/test-harness/sandbox.ts` — shared sandbox helpers: `runSteps` re-export, `foldCommitted` (state threading), `requireReachable`, `resetViaHttp`. Consumed via each tool's `_setup.ts`.
- `src/tools/<tool>/tests/tool/_setup.ts` — per-tool sandbox wiring: `toolOpts`, `seedState`, `resetToSeed`, fixtures (built on `src/test-harness/sandbox.ts`).
- `src/tools/<tool>/tests/tool/seed.json` — the canonical sandbox seed; reset to it before every suite.
- `sandbox/` (project root) — the local sandbox service the sandbox layer runs against. Contract (lifecycle CRUD, `Sandbox-Id` header isolation, mandatory JSON seeding): `../create-tool/references/sandbox-contract.md`.
- `src/tools/<tool>/tests/{tool,prompt-input}/FINDINGS.md` — where a failing-but-real test is documented (see Phase 4).
- `package.json` scripts — `npm test` (runner unit), `npm run test:sandbox` (sandbox up locally), `npm run test:prompt` (live model; the script sets `PROMPT_INPUT_LIVE=1`).
</reference_files>

<anti_patterns>
- **Asserting on the LLM's wording.** The prompt evolves; verbatim string assertions rot. Assert on the emitted steps and a script/locale regex for content.
- **Stubbing the backend.** In-process mocks diverge from production envelope/exception behaviour. Extend the local sandbox instead.
- **Skipping the seed reset.** Suites that share a sandbox without resetting in `before` produce order-dependent failures. Always reset.
- **Testing two layers in one file.** A file that does both `runSteps` and a live turn couples failure modes you want separable. One file, one layer.
- **Asserting params the model has latitude over.** When more than one form is acceptable, accept all of them — don't pin a single representation.
- **Relaxing an assertion to make the suite green.** Promote it to a `FINDING:` first; document the why; never silently weaken.
- **A sandbox test for a routing concern** ("the LLM should batch X with Y") — that's prompt-input; the sandbox never sees the LLM.
- **A prompt-input test for an executor-internal concern** ("the verdict should be `ok` when status=00") — that's sandbox; the prompt-input layer never executes.
- **Re-proving the runner for a new action.** The runner's own tests cover gating. Add a runner unit test only for a genuinely new mode combination.
</anti_patterns>
