# Research briefs

Dispatch the applicable briefs in ONE message so they run in parallel, each in a fresh read-only
context. Fill the `<…>` placeholders. Every brief carries the same evidence rules; paste them in
verbatim — they are the rules the reference project learnt by getting them wrong.

## Evidence rules (paste into every brief)

```
Evidence rules:
- Cite path:line for every claim about code, a route, or a spec. No citation → say "unverified".
- Read the body, not the name. A method or flag name is not evidence of what it does.
- Absence from one search is NOT evidence. Before writing "not found", search at least two ways that
  fail differently: name variants (camel/snake/kebab, singular/plural, synonyms), shared constants and
  object spreads, controllers AND client interfaces, API specs / Postman collections, settings, and
  every sibling repo in scope. Then write the scoped claim: "not found in <surfaces>, searched <how>".
- Verify fresh. Do not copy claims from earlier documents; re-check them and say which ones changed.
- Never copy personal data, credentials, tokens or live responses. Shapes and field names only.
- This is context for <FIELDS | DOCUMENTS | ROUTES | THE ACTION SURFACE> only, not for the flow. The
  flow comes from <source of truth>; do not propose a different one.
```

## (a) Field inventory

```
Build the field inventory for <flow> from <spec folder(s)>.
Group by the owner's sections: <list the sections from the walkthrough>. Fields that fit none go in a
separate "unplaced" list — do not invent a section.
Per section, a table: field | requirement (M / O / C: <condition>) | multi-entry? | already known from
an earlier step (which) | prefillable from <external source> | supporting document | validation rules |
spec reference (story / criterion id).
Also per section: its completion rule and any cascades (changing X clears Y).
If several copies of the spec exist, diff them first and say which you used.
Flag every ambiguity as a question with a proposed default.
<evidence rules>
Return Markdown, ≤2500 words.
```

## (b) Document inventory

```
Build the document inventory for <flow> from <spec folder(s)> and <repos>.
1. Document type → what it proves → which section needs it → mandatory / conditional (condition) →
   produced by the system or uploaded.
2. The ways a document gets in (upload, scan, generated, fetched from a registry): for each, the steps,
   inputs, outputs, and the real endpoint with path:line — or "not found" per the rules.
3. The business rules about documents, with criterion ids.
<evidence rules>
```

## (c) Action-surface and engine audit

For a large surface (more than ~12 actions), split this brief across two or three agents by action
group (e.g. reads / writes / gates), each with the whole numbered question list in section 4 answered
only for its group — one agent over 20+ actions takes long and still needs heavy spot-checking.


```
Audit the agent at <repo>. It vendors agent-step <version> (src/agent-step/VERSION).
1. Every action: purpose, params, prereqs, controller hooks (resolve presets and spreads!), verdict
   rows or result bodies, backend method + route, state written — each with path:line.
2. The verifier registry: each prereq and the slot its predicate reads.
3. The backend clients and their environment keys (names only, never values).
4. Answer each by citing lines in the vendored runner:
   - how confirmation propose/execute works, and what a pending gate admits (lockdown);
   - how OTP issue/consume works, and what happens when an OTP is issued with no flow open;
   - flows: open, close, mutex, what ends them;
   - batching: does a batch stop on a business conflict returned as success? can step N use step N-1's
     result?
   - invalidation: what `invalidatesOnChange` clears and when;
   - an action carrying two gates at once.
5. For each step of <ladder draft>, which action(s) implement it today and what is missing.
<evidence rules>
```

## (d) Real routes

```
For each capability the brief names (<list: brief name → one line of what it does>), find the real
route across <repos, including sibling services, API gateways, proxies, sandboxes/mocks>.
Per capability: brief name | real route + body shape | path:line | called by our agent today? (path:line).
End with a gaps list: capabilities with no route found, and exactly how you searched for each.
<evidence rules>
```

## Review (adversarial, after the first build)

```
Review a flow documentation set adversarially. You are checking it, not improving its prose.
Unit: <slug> — <one sentence of what the flow is>. Owner's intended scope, verbatim: <quote>.
Files: <out>/<slug>.md, .html, .xlsx; the spec <spec path>; source of truth <path>; repos <paths>.
What the author did NOT check: <be honest — e.g. "routes in repo X were not traced", "payload shapes
unconfirmed">.
Check:
1. A sample of ≥10 path:line claims, opened and read. Does the code say that?
2. Every step of the source of truth is present, in order, with nothing invented.
3. Every step obeys the document's own rules: one closing action per step; human input between two
   calls splits a step; waiting steps close on backend state, never on the user's say-so.
4. Every engine expression uses current agent-step primitives correctly (gates, flow mutex, lockdown).
5. Stale text: a claim in one field that a later correction elsewhere contradicts.
6. Every "not found" names how it was searched.
Return: findings triaged (wrong / unverified / fine), each with the file and the fix, then a YAML block
`findings: [{id, severity, where, claim, evidence, fix}]`.
```
