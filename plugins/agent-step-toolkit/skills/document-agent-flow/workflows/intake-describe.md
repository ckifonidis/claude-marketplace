# Intake (a): from a prose description

The user describes an agent in words: what it is for, what it asks, what it calls. There may be no
code and no specs yet — the output is then a design to build against, and most statuses are `new`.

<process>

1. **Save the description verbatim** next to the spec (`docs/<slug>/source/description.md`) and cite it
   as `meta.source_of_truth`. The flow is theirs; keep their step names.

2. **Extract the ladder** into a numbered draft and show it to the user before writing the spec:
   - one line per step: what it gathers → what closes it → calls fired on closing → where it goes next;
   - every failure you can infer ("what if the code is wrong?", "what if the backend is down?") as a
     candidate outcome, marked *inferred*;
   - every gap as a question with a proposed default.
   Keep this short — it is the cheap review surface. Wait for corrections.

3. **Name the triggers** from the description's verbs ("check", "send", "create", "notify"). With no
   backend to cite:
   - `real` states what is known ("route not chosen yet — POST /orders proposed");
   - `status: "tbd"` (or `new` if the description says it must be built), no `evidence`;
   - `spec` holds the description's own name for the call, so the md's route table shows the gap.

4. **Step status**: `new` for every step the description asks for, unless the user says part of it
   runs today (then `exists`/`change` with evidence, which means you are in mode (b) as well).
   `changes` lists what must be BUILT, ordered by what it unblocks; `engine_notes.facts` holds the
   platform facts that shaped the design (library rules such as the flow mutex), not code facts.

5. **Engine column**: write each step as it WOULD be declared on the current agent-step
   (`references/engine-notation.md`). This is where the doc adds most value for a new agent: it turns
   "the agent confirms the order" into `requiresConfirmation{maxAttempts: 3, readBack}` on a named
   closing action.

6. Go to `workflows/document-flow.md`, Phase 2. Usually only brief (d) applies, and only if a backend
   exists; say which briefs were skipped and why.

</process>
