# Intake (c): from documents — specs, user stories, a walkthrough

<process>

1. **Rank the documents.** If the owner gave a walkthrough (a meeting note, a recorded call, a message
   thread), it owns the FLOW. Specs and stories own the FIELDS, the DOCUMENTS and the names of APIs.
   Write that ranking into `meta.source_of_truth`, and when two documents disagree about the flow, the
   walkthrough wins and the disagreement becomes an open item (quote both, give the default).
   Several copies of the same spec folder are common: diff them (`diff -rq`) and say which one you used.

2. **Quote, then structure.** Copy the walkthrough into `docs/<slug>/source/walkthrough.md` verbatim
   (translated alongside if needed, never instead). **Bound for a public place?** Keep the verbatim copy
   in the private workspace; the published `source/` gets a copy with each sensitive span replaced by
   `[redacted: <why>]`, and the deny check runs on what is published (`--scan` any other input the
   outputs cite, so nothing cited escapes the check). Build the ladder draft from it, one line per step,
   and show it before writing the spec.

3. **Fields and documents** come from research briefs (a) and (b) (`references/research-briefs.md`),
   grouped by the owner's sections — not by the spec's chapter order. They land as `sheets` in the spec.
   A field the spec marks optional that the owner says is mandatory is mandatory ("a spec omission is
   not a ruling").

4. **Routes**: the specs' API names go in each trigger's `spec` field; brief (d) finds the `real` route
   and its evidence. When nothing is found after the variant searches, `real` says so and names the
   surfaces searched; the step still gets drawn.

5. If the agent code exists too, also run brief (c) and use `workflows/intake-existing.md` step 3 for
   statuses. Then continue with `workflows/document-flow.md`, Phase 2.

</process>
