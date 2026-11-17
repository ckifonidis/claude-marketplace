# Workflow: document an agent flow (shared by all entry modes)

<required_reading>
Before Phase 1, read fully:
1. `references/data-model.md` — what the spec holds.
2. `references/engine-notation.md` — how the engine column is written.
3. `../create-tool/references/agent-step-api.md` — the CURRENT library contract. The engine column is
   written against this, even when the project under study vendors an older copy.
Read `references/layout.md` and `references/design-guide.md` before Phase 5.
</required_reading>

<process>

## Phase 0 — Survey, build nothing

- List what already exists: earlier flow docs, their dates, the owner's walkthrough, the specs, the
  knowledge base or decision log if the project has one.
- If an earlier doc set exists, read it **for its claims to re-verify**, not to copy. Every route and code
  claim is checked again this pass (the reference redo found an earlier draft had copied a wrong route
  that a knowledge-base note had propagated).
- Note the agent-step version the project vendors (`src/agent-step/VERSION`) and the toolkit's current
  version (`../create-tool/templates/agent-step/VERSION`). Write them into `meta.engine_version` (the
  toolkit's) and `meta.code_engine_version` (the project's); the page shows both top-right. A gap means
  the engine column describes the target on the current library and `status_note` says what the old
  code does today.

## Phase 1 — Fix the flow and the vocabulary

- Write the ladder down from the source of truth (see the intake workflow for your mode): stages,
  steps in order, what each gathers, what closes it, which calls fire on closing, where each outcome
  goes. Use the owner's words for titles.
- Apply the vocabulary rules (SKILL.md principle 3). Split a step wherever a human answer sits between
  two backend calls. Merge consecutive calls with nothing gathered between them into one trigger chain.
- Every place where the source is silent or ambiguous becomes an open item **with a default**. Do not
  resolve it by choosing quietly.

## Phase 2 — Research in parallel

Dispatch the research agents in ONE message so they run concurrently (briefs and evidence rules in
`references/research-briefs.md`). Tell each "verify fresh; do not copy claims from earlier docs".

| Agent | Needed when |
|---|---|
| (a) field inventory, grouped by the owner's sections | specs or stories define fields |
| (b) document inventory + upload paths | the flow collects or produces documents |
| (c) action-surface + engine audit of the agent repo | an agent codebase exists (mode b, or c with code) |
| (d) real routes across the backend / sibling repos | the brief names APIs |

Skip the ones that do not apply and say so. While they run, draft the spec skeleton (Phase 3) from
Phase 1 — do not duplicate their searches.

When reports arrive: **spot-check every new route or code claim yourself** at the cited `file:line`
before it enters the spec. A claim you cannot confirm is entered as `tbd` with the reason.

## Phase 3 — Write the spec

- Copy the generator and the spec template if the project does not have them (SKILL.md quick reference).
- Fill `docs/<slug>/source/<slug_>_flow.py`. Put large inventories (fields, documents) in sibling modules
  the spec imports, and pass them as `sheets`.
- Name every repeated string once (retry policies, shared engine text) — Python specs exist so you can.
- Write the prose parts from the research, not from memory: `engine_notes` (concept → primitive table,
  the code facts that drove the design), `decisions` (one block per step where fitting the flow onto the
  engine forced a choice, with the why), `changes` (what the code needs, ordered by what it unblocks),
  `revisions` (only when this pass replaces an earlier one).

## Phase 4 — Build

```bash
uvx --with openpyxl python3 scripts/flowdoc/build.py docs/<slug>/source/<slug_>_flow.py --out docs/<slug>
```
The build validates first and lists EVERY problem. Fix the spec; never silence the validator by editing
an output.

## Phase 5 — Verify in each medium

```bash
uvx --with openpyxl --with playwright python3 scripts/flowdoc/verify.py docs/<slug>/source/<slug_>_flow.py \
    --out docs/<slug> --shots <scratch>/shots [--deny forbidden.txt]
```
- All checks must PASS. Report the summary lines verbatim to the user, not "verified".
- **Look at `<slug>-canvas.png`** (the whole graph at 100 %). The automatic layout avoids overlaps
  between boxes, but judgement is still needed: a label crowding a line, a long edge that would read
  better as a branch. Fix through the spec (`label`, `sub`, outcome kind, ordering — `references/layout.md`),
  never with coordinates.
- Re-read the generated md top to bottom once. It is generated, so errors in it are errors in the spec.

## Phase 6 — Adversarial review

Dispatch a reviewer with a fresh context (brief: `references/research-briefs.md` §Review). Give it the
three outputs, the spec, the source-of-truth document, and the repos, and tell it what you did NOT
check. For every finding: fix the spec and rebuild, or answer it with evidence. After any correction,
**grep every output for the old claim** — stale text in one field after a fix elsewhere is the most
common residue.

## Phase 7 — Iterate with the owner

- Present: the three files, the verify summary, and the open items as a **numbered list** in plain
  words, each with options and the default (the owner answers inline, question by question).
- Each ruling: close or edit the open item, change the steps it touches, rebuild, re-verify, and re-read
  the md sections the change touches.
- A ruling that conflicts with a project invariant (e.g. removing a confirm-before-write gate) is not
  applied silently: record the conflict as an open item with both options.

## Phase 8 — Hand over

- Commit only when the user asks. Commit the spec, the vendored `scripts/flowdoc/`, and the outputs
  together; confirm a clean rebuild reproduces the committed md and html byte for byte: run `build.py`,
  then `git diff --exit-code` on them (verify's build check only proves two builds agree).
- Scan the outputs (including the xlsx cell text) for secrets and customer data before committing.

</process>

<success_criteria>
See SKILL.md `<success_criteria>`; every box is ticked with the named check that ticked it.
</success_criteria>
