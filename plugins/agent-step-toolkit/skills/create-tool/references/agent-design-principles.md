# Reference: Agent design principles

<overview>
How to architect a HOST agent on the agent-step engine. `agent-step-api.md` states what the engine
does; this document states how a well-formed agent divides responsibility around it. Every principle
below was extracted from live-measured behaviour on production voice agents — they are conclusions,
not aspirations. Use them when bootstrapping, when adding tools, when writing or consolidating the
prompt, and when porting an existing agent (the closing checklist is the port-mode audit).
</overview>

<architecture>
## The architecture in one paragraph

The graph is three nodes — `agent`, `tools`, `resolve_handoff` — and the agent node does exactly one
thing: build the prompt, invoke the model over the transcript, return its message. Nothing is
injected, nothing is wrapped, no state is patched from outside. Every mechanism — confirmation
gates, standing asks, escalation ladders, abort policy, handoff resolution, attempt accounting,
admission — lives in
the agent-step engine; every business behaviour lives in the configuration, the prompt, or an
executor. The model learns the world only from the transcript: tool results carry every engine
transition, and the caller-audible sentences that matter are rendered by the engine and spoken by
the model verbatim.
</architecture>

<principles>
## 1. The moving parts are configuration, prompt, and executors — mechanism belongs to the engine

Anything that is flow control belongs to agent-step. Hand-rolling it in the host is a defect **even
when it works**, because it forks behaviour away from the runner every sibling agent shares, and the
fork is invisible until two agents disagree.

*Why:* host-side mechanisms — envelope patching, hand-rolled guard latches, model-input notes —
eventually either duplicate something the engine grows properly or actively fight the prompt. The
host owns exactly: the Zod configuration, the prompt, the executors, and pure renderers (read-back
lexicon, recaps, probe messages). A side effect that must follow the task's OUTCOME (a contact
record) is the `HandoffSpec.onHandback` observer in that configuration — never a wrapper around the
resolver node.

*Enforcement:* the engine throws on library-slot writes from executors; a needed capability the
engine lacks is drafted in the vendored tree and ported upstream via the toolkit's versioning flow —
never patched around.

## 2. The prompt is a function of the session language alone

The prompt builder takes one degree of freedom: the language. Its placeholders are the language name
and language-keyed catalog constants. No turn state, no call state, no per-turn system notes
appended at the model call. The agent node injects nothing beyond the built prompt.

*Why:* runtime injections are a second, invisible instruction channel — measured overriding the
prompt's own routing on the turns they touched, and structurally invisible to the prompt-input test
layer, so the divergence is undetectable by the very suite meant to catch it. A prompt that varies
with state also cannot be reviewed as one artifact.

*Enforcement:* state the rule on the prompt builder itself. A build-time pin — asserting the built
prompt is byte-identical across differing states — is a cheap guard worth adding.

## 3. State reaches the model only through the message stream

If the model must know an engine fact, that fact must appear in a tool result. Every engine
transition is visible in the transcript (e.g. a recorded standing ask stamps `standing_ask` +
`ask_contract` on the final entry; a ladder escalation stamps `ladder_exhausted` +
`handoff_requested`); pending status is derived from the results themselves. A
silent state mutation in the engine is a bug by definition, because the transcript is the model's
only authority.

*Why:* the alternatives are injecting state into the prompt (principle 2 forbids it) or letting the
model infer state from spoken wording (measured unreliable). Structured result fields are the one
channel that is both visible to the model and stable to test.

*Enforcement:* the prompt names tool results as the sole authority and forbids inference from
wording; engine unit tests pin the visibility fields.

## 4. Capabilities are discovered by calling, never announced

When the model needs to know whether something exists — a carried identity, an eligible entity, a
repeatable gate — it calls an action and the engine answers. The canonical case: identification
opens with an empty probe call; the engine either proposes the carried identity (with the consent
question as its rendered read-back) or answers that nothing was carried. The model is never told in
advance, and the carried value never surfaces raw.

*Why:* announcing state in the prompt violates principle 2; more deeply, a tool answer is
adjudicated, typed, and testable, while an announced flag is an assertion the model may stale-read
or ignore.

*How:* build probe contracts on `ConfirmationOpts.refuseProposal` — a schema-valid but
state-impossible proposal is answered immediately instead of storing a gate over a value that does
not exist. Mirror the refusal logic and the executor's consumption rule so the two can never
disagree.

## 5. The model extracts; the engine validates

Caller-dictated digits are transcribed exactly as heard and sent — always. The model never counts,
never judges completeness, never withholds a call because its own arithmetic says the capture is
short. Shape rules live in refinements invisible to the model-facing schema (see the capture
primitives in `agent-step-api.md` `<caller_digit_capture>`); the engine's `invalid_params` verdict
is the only authority that a capture fell short.

*Why:* a shape rule visible to the model becomes a precondition for emitting the call — the model
then refuses valid input or invents digits to satisfy the pattern. Both failure modes were observed
live before this doctrine existed.

*Enforcement:* a build-failing test asserting no shape keyword reaches the model-facing JSON Schema
is cheap and worth having; treat the prompt region around capture as brittle — edits near it
obligate a full live re-run.

## 6. Caller-audible consequence text is engine-rendered; the model only speaks it

Whatever the caller must hear *exactly* — a digit read-back, an irreversible-action recap, a
carried-identity consent question, a fixed standing ask — is rendered by the engine
from state and catalogs, carried on the result as `read_back` (or `ask_text`), and spoken by the
model verbatim. If a sentence must be heard before an irreversible action, the model's discretion
is precisely what must be removed from it.

*Why:* model-composed consequence text was measured to mangle digits, skip recaps under turn
pressure, and paraphrase fixed offers — each a consent defect the confirmation gate cannot catch,
because both sides then agree on words nobody said.

*How:* `ConfirmationOpts.readBack` + `repeatReadBack` (stored-byte repetition), and
`DictationAsk.render` (`ask_text`). The read-back authority is stated ONCE, by the engine-composed
protocol fragment; the per-result framing rides the wire as `read_back_directive`.

## 7. One authority per behaviour in the prompt

A rule is stated once, at one site; every other mention is a pointer. When a behaviour needs
restating for emphasis, the restatement names the authority instead of paraphrasing it.

*Why:* a rule stated N times is a fork among its own copies. And the mirror lesson: **compression
that drops a clause drops a licence.** Live regressions introduced by prompt consolidation are
typically behaviours whose permission or duty existed only as a clause that summarisation deleted —
outcome-checking tests cannot see a dropped licence until it is measured live.

*Enforcement:* procedural — any consolidation of prompt text obligates the full live battery before
shipping.

## 8. Configuration owns payloads; the prompt decides intent

The prompt classifies what the caller needs; the exact machine-readable payload comes from
configuration the engine renders into the model-facing surface. Terminal handoffs as a typed union
of exact reason/context pairs (`HandoffSpec.modelRequestSchema`), the abort contract
(`abortPolicy`), and the repeatable-gate roster are all rendered into the action descriptions from
the same configuration the engine enforces.

*Why:* a rule the model must obey is most reliable when stated by the same source that enforces it —
surface text derived from configuration cannot drift from the admission rules, while prompt prose
can and did. Measured concretely: naming the repeatable gates in the control's own description fixed
a misuse prompt prose had failed to prevent.

*Enforcement:* pin the model-facing surface byte-for-byte with a golden, regenerated only through a
sanctioned script; the schema is the contract.

## 9. Align the contract with safe model behaviour instead of fighting it

When the model consistently emits a shape the engine forbids, and the shape is provably equivalent
to the sanctioned one and cannot reach danger, the right fix is a narrow admission relaxation with
transcript visibility — not another round of prompt insistence. The propose batch riding behind its
prereq verifications (`soleOnExecute`) entered the engine contract this way. The boundary is
absolute in the other direction: nothing
is ever relaxed toward a mutation — confirm-required executes stay sole, and every relaxation names
its exact admissible shape.

*Why:* a persistent model preference is data. Fighting it with prose yields marginal pass rates that
rot under deployment drift; admitting the safe form makes the behaviour deterministic at the engine
layer, where determinism is cheap.

## 10. The engine bounds every consequence; the prompt is never the last line of defence

Prompt-level marginality is acceptable only where the engine contains the failure. Pending-gate
lockdown means a forgotten abort cannot touch a suspended mutation; choice-pending lockdown means a
stray "continue" cannot execute anything; propose-time refusal means an impossible proposal cannot
store a gate; the fail-closed repeat control means a misdirected repeat call changes nothing. Model
judgement decides *which* safe thing happens — never whether an unsafe thing can.

*Why:* the model's pass rates on judgement calls oscillate with serving conditions outside anyone's
control. A behaviour whose safety depends on a pass rate is not encoded, it is lucky.

## 11. Fixtures pin substance and safety, never phrasing

A live prompt-input fixture asserts what must and must not happen — the action emitted, the safety
absences, the semantic content of the reply — not the model's wording. Safety absences (never
execute, never terminate wrongly) are never relaxed. Where the engine admits two equivalent shapes,
the fixture accepts both. Wording is asserted only where the words themselves are the requirement
(engine-rendered `read_back` spoken verbatim, catalog-fixed lines) — and then against the catalog,
not against a paraphrase.

*Why:* phrasing-proxy assertions produce false alarms that train people to ignore red boards; a
fixture that can only pass via one paraphrase of a correct behaviour measures the deployment's mood,
not the design.

## 12. Measure live, at the right layer, and separate signal from weather

Verification is layered — engine unit tests, sandbox tool tests, live prompt-input fixtures,
end-to-end graph runs — and no layer substitutes for another. The prompt-input layer cannot see
anything the graph adds around the model call, so graph-level behaviour is verified through the
graph. Classify live failures before fixing: a failure that reproduces consistently within a
sampling window is a defect; a failure that flips across windows with identical bytes is deployment
weather, and editing the prompt against weather is forbidden. Design is decided before measuring;
wording is never tuned against a rotating fixture.

*Method:* reproduce first, fix at the authority, resample with neighbouring fixtures, end with
full-suite gates; attribute a swing with an A/B against the suspect clause before reverting or
keeping it. See `test-agent-step` for the layer definitions.
</principles>

<audit_checklist>
## Auditing an existing agent against the paradigm

The questions to ask of any agent (port mode: ask them of the source project before re-deriving it),
in order of payoff:

1. Does the graph inject anything into the model input beyond the built prompt?
2. Does the prompt carry any placeholder that is not the language or a language-keyed constant?
3. Is there any engine transition the model can only learn from state rather than a tool result?
4. Is any caller-audible consequence sentence composed by the model?
5. Does any host code patch a library-owned shape after the fact?

Each "yes" is a fork some downstream project has already paid to unwind.
</audit_checklist>
