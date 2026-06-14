---
name: audit-middleware-contract-compliance
description: Audit a channel middleware implementation — the proxy service that invokes a generated agent's LangGraph API, forwards reply tokens to the client channel, and routes handoffs — against the agent-step wire contract. Walks the middleware's source against the contract's adherence checklist (invoke shape, sync + streaming handoff detection, routing and handback table, stream modes, token dedupe, trigger point, library-handoff custom events) and produces an evidence-backed findings report (file:line per item), with an optional wire-level verification pass against a captured SSE stream. Use when integrating a new middleware with an agent-step agent, reviewing middleware changes that touch streaming or handoff processing, or diagnosing handoff/streaming integration bugs (dropped tokens, truncated transitions, missed or double-fired handoffs).
---

<objective>
Determine whether a middleware implementation satisfies every assumption an agent-step agent
makes about it, and report the result as findings with evidence — not fixes.

The contract is double-sided: generated agents are structurally correct by construction
(scaffolded by `/create-tool`, tested by `/test-agent-step`), but the middleware is hand-written
by another team, and several of the contract's mandates are stated as mandates precisely because
they break common middleware assumptions. This skill mechanizes the
`<middleware_requirements>` checklist that the contract doc says to "hand to the middleware
developers" — instead of a checklist humans read once, it is an audit run against their code.

**The contract doc is normative.** The single source of truth is
`../create-tool/references/streaming-and-channel-contract.md` (plus `agent-step-api.md`
`<handoff>` for the library built-in mechanism). Read it at the start of every audit and cite
its clauses in findings. If this skill's prose and the doc ever disagree, the doc wins.

**Deliverable:** a report with one entry per checklist item — status
(`compliant` / `violation` / `not-applicable` / `unverifiable`), the evidence (file:line in the
middleware source), the contract clause it satisfies or violates, the user-facing impact, and a
fix *direction* (not a patch). The skill never edits the middleware.
</objective>

<quick_start>
1. **Locate the target.** The audit runs against a middleware codebase — the current directory,
   or a path/repo the user names. If no middleware source is available, only the wire-level
   pass (Phase 5) is possible; say so rather than auditing from memory.
2. **Read the contract.** `../create-tool/references/streaming-and-channel-contract.md`,
   end to end — especially `<middleware_requirements>` (the checklist), `<handoff_contract>`
   (the routing table), and `<streaming_facts>` (the three assumption-breakers).
3. **Scope the agent population** (Phase 1): which paths the middleware uses (sync `/runs/wait`,
   streaming `/runs/stream`, or both) and whether any integrated agent uses the library
   handoff built-in (agent-step ≥ 1.3.0) — this decides which checklist items apply.
4. **Walk the checklist** (Phases 2–3): for each applicable item, locate the responsible code
   and record evidence or a finding. No item passes without a file:line.
5. **Report** (Phase 4). Optionally **verify on the wire** (Phase 5) with a captured SSE stream.
</quick_start>

<process>

<phase name="1_scope_and_discovery">
**Phase 1: scope the integration, map the middleware**

The middleware is a foreign codebase — assume nothing about layout or language. Locate, by
reading (not by filename guessing alone), the components the contract doc names:

- the **invoke/request builder** — where run input is assembled and the LangGraph API is called;
- the **stream processor** — where SSE events are consumed, filtered, and forwarded;
- the **handoff processor** — where `additional_kwargs` are read and routing decisions made;
- the **routing configuration** — the `service_type` vocabulary (client-side types vs agent names).

Then settle the applicability matrix, asking the user only for what code and config can't answer:

| Question | Decides |
|---|---|
| Sync path used? | items 1–3b |
| Streaming path used? | items 4–7 |
| Any library-handoff agent (agent-step ≥ 1.3.0) integrated? | item 8 |
| Specialized agents in the population? | item 3b (handback routing) |

Record the matrix in the report header. An item ruled out here is `not-applicable`, with the
reason — never silently skipped.
</phase>

<phase name="2_checklist_walk">
**Phase 2: walk the adherence checklist**

For each applicable item of `<middleware_requirements>` (numbered 1–8, plus 3b), find the code
that implements it and grade it against the doc's clause. The doc carries the normative detail;
what follows is where violations of each item hide:

- **1 — Invoke shape.** Check the request builder for the snake_case identity fields and
  `assistant_id: "agent"`. Violations hide in serializers that camelCase field names, and in
  builders that send `null` for absent identity instead of omitting the field.
- **2 — Handoff detection (sync).** The detector must read the *final* message's
  `additional_kwargs` and require BOTH `is_handoff: true` AND a non-empty `handoff_type`.
  Violations: triggering on `is_handoff` alone, case-sensitive type matching, reading kwargs
  from any message other than the final one.
- **3 / 3b — Routing and handbacks.** Compare the implemented routing against the verified
  table in `<handoff_contract>` row by row: client-side types pass through; known agent names
  re-send the turn (with history); unknown types fall back to the default agent; the three
  handback signals (`completed` / `abandon` / `off_topic`) return ownership to the orchestrator,
  with `off_topic` re-sending the triggering turn so the utterance gets answered. Also check the
  vocabulary: every `service_type` in the middleware's config should map to the agent's service
  catalog, and vice versa — orphans on either side are findings.
- **4 — Stream modes.** The stream request must include `["messages-tuple", "updates"]`. A
  middleware that only consumes `messages` events **cannot see handoffs at all** — the kwargs
  never appear there. This is a high-severity violation, not a style issue.
- **5 — Token filter.** Look for any dedupe or filter keyed on message `type` — token chunks
  serialize as `type: "ai"` just like final messages, so such a filter drops every streamed
  token. Dedupe must key on message id. If tokens are filtered per node, the filter must
  include node `agent`.
- **6 — Handoff detection (streaming).** Must read `updates` node deltas for
  `messages[].additional_kwargs.is_handoff` — not the `messages` stream.
- **7 — Trigger point.** The earliest handoff signal on the wire is `pendingHandoff` in the
  `tools` node's `updates` delta — *before* the first spoken token. A middleware that acts
  there cuts the spoken transition mid-sentence. The correct trigger is the
  `post_model_hook` update, which arrives after the full reply has streamed.
- **8 — Library-handoff agents.** Only when the population includes one: `"custom"` must be in
  the stream modes; `handoff_complete` (resolver text) and `delegated_token` (delegate-mode
  reply tokens) must be consumed; the handback is detected in the `resolve_handoff` node's
  `updates` delta; and a `delegated_to`-only final message must NOT be routed on — no
  `is_handoff` means the conversation stays with the agent. See `agent-step-api.md`
  `<handoff>` for the mechanism.

Evidence discipline: **no item is `compliant` without a file:line.** If the responsible code
can't be located or the behavior can't be determined statically, the status is `unverifiable`
with a note on what would settle it (usually the Phase 5 wire check).
</phase>

<phase name="3_assumption_breakers">
**Phase 3: second pass on the three assumption-breakers**

Items 5, 6, and 7 encode the three verified facts that break common middleware assumptions
(`<streaming_facts>`). They earn a dedicated adversarial pass because the violating code often
*looks* reasonable — a tidy `type == "ai"` filter, a prompt-looking `messages`-mode handoff
sniffer, an eager early-exit on the first handoff signal. For each, actively search for the
violating *pattern* across the stream-processing code (not just the one spot found in Phase 2):
every message-type comparison, every place handoff fields are read, every code path that can
terminate or redirect the stream. One compliant call site does not clear an item if a second
call site violates it.
</phase>

<phase name="4_report">
**Phase 4: the findings report**

One entry per checklist item, in checklist order:

- **Status** — `compliant` / `violation` / `not-applicable` / `unverifiable`.
- **Evidence** — file:line in the middleware source (for n/a: the scoping reason).
- **Clause** — the contract section and item it grades against.
- **Impact** — what the user experiences when it bites (dropped tokens, truncated spoken
  transition, missed or misrouted handoff, dead air).
- **Fix direction** — one or two sentences pointing at the compliant shape; never a patch.

Severity, when violations exist: anything that loses user-audible output or breaks handoff
detection outright (items 2, 4, 5, 6) is high; mistimed or misrouted transfers (3, 3b, 7, 8)
are medium-to-high depending on the channel (voice suffers most); invoke-shape drift (1) ranges
from cosmetic to fatal depending on the field. End the report with the applicability matrix and
the list of anything `unverifiable` — that list is the work order for Phase 5.
</phase>

<phase name="5_wire_verification">
**Phase 5 (optional): verify on the wire**

Static reading can't settle behavioral questions — trigger timing, dedupe under real chunk
interleaving. When the user wants the dynamic layer, or Phase 4 left items `unverifiable`:

1. **Capture a golden fixture**: a raw SSE stream of a handoff turn from an agent dev server
   (`POST /threads/{id}/runs/stream`, `stream_mode: ["messages-tuple","updates"]` — plus
   `"custom"` for a library-handoff agent), per the contract doc's `<testing>` section. Assert
   the capture itself shows the four-phase event order before using it.
2. **Replay or observe**: feed the fixture through the middleware's stream processor (if it's
   testable in isolation), or run a live turn through the deployed middleware, and check the
   observable outcomes — every spoken token reached the channel, the transfer fired only after
   the full reply, the routing matched the table.
3. Fold the results back into the report, upgrading `unverifiable` items to `compliant` or
   `violation`.

The fixture doubles as a regression asset for the middleware team's own stream-processor tests —
say so when handing it over.
</phase>

</process>

<reference_files>
- `../create-tool/references/streaming-and-channel-contract.md` — **the normative contract.**
  `<middleware_requirements>` is the checklist this skill audits; `<handoff_contract>` the
  routing table; `<streaming_facts>` the assumption-breakers; `<wire_input>` the invoke shape;
  `<testing>` the wire-capture recipe for Phase 5.
- `../create-tool/references/agent-step-api.md` `<handoff>` — the library handoff built-in
  (agent-step ≥ 1.3.0): `request_handoff`, `createHandoffNode`, the custom events
  (`handoff`, `delegated_token`, `handoff_complete`), `HANDBACK_SIGNALS`. Needed for item 8.
- `../test-agent-step/SKILL.md` — the agent-side test methodology. Agent-side concerns found
  during an audit route there, not into this report.
</reference_files>

<anti_patterns>
- **Auditing from memory.** The contract has been re-verified against live captures and the
  middleware source; this skill's summaries are navigation aids. Read the doc each run and cite
  it — a finding that misquotes the contract costs the audit its credibility.
- **Passing without evidence.** "Looks fine" is `unverifiable`, not `compliant`. Every
  `compliant` carries a file:line.
- **Fixing instead of finding.** The middleware belongs to another team. Report, point at the
  compliant shape, stop.
- **Auditing the agent side.** Malformed kwargs, a missing `isHandoff` in a resultBody, a
  prompt that won't fire the handoff — those are agent bugs; route them to `/create-tool` /
  `/test-agent-step`. This skill grades only the consumer of the wire.
- **Scope drift into code review.** Style, structure, and performance of the middleware are out
  of scope unless they implement a checklist item incorrectly.
- **Skipping item 8 by assumption.** "No library-handoff agents" must come from the scoping
  matrix (config or the user), not from the item being newer than the middleware.
- **Clearing an item on one good call site.** The assumption-breakers recur; Phase 3 exists
  because the second message-type filter is the one that drops the tokens.
- **Acting on the early `pendingHandoff` signal when building the Phase 5 fixture** — the
  capture must include the full four-phase order, or the trigger-point check (item 7) grades
  against a truncated baseline.
</anti_patterns>
