# Reference: Data-Analysis Pattern (LLM-authored compute over fetched data)

<overview>
Some tools must answer open-ended analytical questions over data they fetched — totals, averages, counts, group-by, top-N, filtered aggregations ("how much did I spend on groceries this year", "which month was highest"). You cannot pre-build an action per question. The proven pattern is **the agent writes the computation, the host runs it**: one analyze action takes a JavaScript snippet as a param, and the host runs it in a constrained VM against the datasets already in state.

This is the build recipe for executor **Pattern 9** (`executor-patterns.md`) and the analyze half of the **retrieve-vs-analyze** boundary (`read-tool-patterns.md`). It uses ONLY the standard library primitives (`paramsSchema`, `prereqs` + `Verifier`, `Selector`, `Executor`) — there is no special runner feature. Everything analysis-specific is host code in the tool directory plus a prompt upgrade.

**Use it when** the tool retrieves rows the user will ask aggregate questions about. **Skip it** when the answers are a small fixed set — just write those as ordinary read actions.
</overview>

<the_shape>
## The five pieces

| Piece | File | Role |
|-------|------|------|
| Analyze action | `config.ts` entry | `paramsSchema: z.object({ code: z.string() })`; `prereqs: ["dataLoaded"]` |
| `dataLoaded` verifier | `verifiers/data-loaded.ts` | Refuse when no analyzable slot is populated (else the snippet runs over empty arrays and returns a misleading 0) |
| Dataset selector | `actions/<analyze>/stateSelector.ts` | Returns the `DatasetSource` slice — every cached collection the snippet can aggregate over; NO session/identity context (analysis never calls the backend) |
| Analysis executor | `actions/<analyze>/executor.ts` | Calls `runAnalysis(slice, code)`; turns the outcome into a result body. Read-only — no `stateUpdate` |
| Datasets module | `shared/datasets.ts` | The single source of truth (below). Plus `shared/analysis-vm.ts`, the `node:vm` runner |

Templates: `executor-analysis.ts.template`, `verifier-data-loaded.ts.template`, `datasets.ts.template`, `analysis-vm.ts.template` (+ the generic `state-selector.ts.template` for the dataset slice).
</the_shape>

<data_flow>
## The four-stage flow

1. **Retrieval writes native rows into keyed state slots.** Retrieval actions (`get_transactions`, `list_*`) persist the *full, native* rows in record-by-key slots with a merge reducer, so they accumulate across a thread. This is separate from the bounded view they return to the model: the model sees a trimmed/paginated `items` list; analysis works from the authoritative native rows. (`<bound_what_the_model_sees>` in `read-tool-patterns.md`.)

2. **The prereq gates analysis until data exists.** `dataLoaded` checks that *any* analyzable slot is non-empty. Without it the snippet would aggregate over empty arrays and "helpfully" return 0.

3. **The selector hands the snippet every cached collection.** The analyze action's `stateSelector` projects state down to `DatasetSource` (a `Pick<State, ...>` of the cache slots). That slice is the executor's entire view — it cannot reach the backend.

4. **`buildDatasets` → VM → `result`.** `runAnalysis` flattens the keyed slots into plain-object arrays (`buildDatasets`), injects them into a `node:vm` context alongside an empty `result` slot, runs the snippet under a wall-time cap, and reads `result` back. A throw → `analysis_error`; never assigning `result` → an explicit error; an un-serializable `result` → coerced to `String`. Failure is returned as a normal `ok:false` result body the model can read and retry against — not a crash.
</data_flow>

<single_source_of_truth>
## One schema, three projections — they cannot drift

The most common failure mode for code-writing agents is the model's mental model of the data drifting from the runtime shape. Prevent it structurally: `shared/datasets.ts` is the **single source of truth** driving three consumers from one `DATASETS` declaration:

1. **`buildDatasets(state)`** — the actual arrays injected into the VM.
2. **`DATASETS`** (the static schema) — rendered into the prompt as a `# DATA SCHEMA` section: column names, types, fixed-enum `values`, and `note`s.
3. **`buildDataSummary(state)`** — the live, per-turn `# AVAILABLE DATA` block: real row counts + up-to-10 sampled distinct values for categorical columns; returns `""` when nothing is loaded.

Because the column `name`s in `DATASETS` are the *same strings* the VM injects and the prompt documents, the model writes `transactions.filter(t => t.category === "...")` against exactly the shape it will receive. Change a column in one place and all three move together.
</single_source_of_truth>

<prompt_wiring>
## The prompt must become state-dependent

This is the one wiring step that differs from an ordinary read tool. The bootstrap `src/prompt.ts` builds a static template with only `{today}` injected and ignores `state`. The analysis pattern needs the prompt to carry the data contract, so upgrade `buildPrompt` to thread state in and inject two sections:

```ts
import { DATASETS, buildDataSummary, type DatasetName } from "./tools/<tool>/shared/datasets.js";

// Static — generated once from DATASETS so it can never drift from the VM input.
function staticSchemaText(): string {
  const lines: string[] = [];
  for (const name of Object.keys(DATASETS) as DatasetName[]) {
    const spec = DATASETS[name];
    const cols = spec.columns.map((c) => {
      const ann: string[] = [];
      if (c.values) ann.push(`one of: ${c.values.join(" | ")}`);
      if (c.note) ann.push(c.note);
      return ann.length ? `${c.name}(${c.type}) [${ann.join("; ")}]` : `${c.name}(${c.type})`;
    }).join(", ");
    lines.push(`- ${name}: ${spec.description}\n    columns: ${cols}`);
  }
  return lines.join("\n");
}
const SCHEMA_TEXT = staticSchemaText();

export function buildSystemPrompt(state: typeof AgentState.State): string {
  const summary = buildDataSummary(state);
  const availableBlock = summary
    ? `# AVAILABLE DATA (live — write the analyze snippet against these)\n\n${summary}\n\n`
    : "";
  return SYSTEM_PROMPT_TEMPLATE
    .replaceAll("{today}", todayIso())
    .replace("{schema}", SCHEMA_TEXT)
    .replace("{availableData}", availableBlock);
}

export function buildPrompt(state: typeof AgentState.State): BaseMessageLike[] {
  return [{ role: "system", content: buildSystemPrompt(state) }, ...(state.messages ?? [])];
}
```

Add `{schema}` (static `# DATA SCHEMA`) and `{availableData}` placeholders to the template, and an ACTIONS entry for the analyze action that names the in-scope dataset variables and the `result`-assignment contract. The static schema is what lets the model author the analyze action correctly **in the same turn as the fetch**, before any rows have loaded.
</prompt_wiring>

<security>
## Security posture — read before shipping

`node:vm` is **not** a hardened sandbox. Determined code can reach the outer realm; it constrains *accidents*, not *adversaries*. The provided runner injects no Node host objects (no `require`/`process`/`Buffer`), relies on the context's own intrinsics, and caps wall time — but that is mitigation, not isolation.

This is acceptable **only** when the snippet author is your own trusted model in a controlled deployment (the same trust posture as any "run model-authored code" feature). If snippet input could ever be attacker-influenced, swap `analysis-vm.ts` for `isolated-vm` (a separate realm with no ambient capabilities) or a separate process. Make this call explicitly; don't inherit the in-process VM by default for an untrusted surface.
</security>

<gotchas>
## Encode domain gotchas as column `note`s

The snippet author only knows what the schema tells it. Anything it could get subtly wrong belongs in a column `note` (static, always present — unlike the live sample):

- **Sign conventions** — "debits are NEGATIVE, credits positive; a raw sum is not 'spend'."
- **Currency** — "in this row's own `currency`, NOT converted; never sum across currencies."
- **Date format** — "ISO-8601 with time; range-filter via `date.slice(0,10) >= \"2025-01-01\"`," especially when other actions use a different format.
- **Double-counting risks** — when the same economic event appears in two datasets (e.g. a card-bill settlement shows as both a card row and an account debit).

Use fixed-enum `values` for columns whose value set is domain-guaranteed (e.g. a `debit | credit` flag), so the model can filter on them even before any data loads.
</gotchas>

<retrieve_vs_analyze>
## Keep retrieval and analysis separate

Do not bloat retrieval params with filters/aggregations the analyze action covers — duplicated surface confuses the model about which action to call. Retrieval fetches broadly into state; analysis narrows. The retrieval action's job is "get the right rows into the cache slots"; the analyze action's job is "answer questions over rows already in state." See `<retrieve_vs_analyze>` in `read-tool-patterns.md`.
</retrieve_vs_analyze>
