# Reference: Tool Directory Layout

<overview>
Every tool follows the same directory shape — the canonical layout below, materialized from the bundled `templates/`. Adopting it uniformly means: predictable file locations, one-import-per-action wire-up, and convention-name lookups by the runner. The bundled templates (not any pre-existing tool you may find in the project) are the structural source of truth.
</overview>

<canonical_layout>
```
src/tools/<name>/
├── names.ts                                 # ActionName / PrereqName type unions (types-only leaf)
├── config.ts                                # assembles the action declarations (pure data)
├── index.ts                                 # wire-up: buildAgentStepTool({...})
├── actions/
│   ├── <action_1>/
│   │   ├── action.ts                        # the DECLARATION: schema, description, verdict rows (+ their asks), controller
│   │   ├── stateSelector.ts                 # exports getSlice + Slice — projects state to this action's slice
│   │   └── executor.ts                      # exports the executor function (receives the slice, names verdicts)
│   ├── <action_2>/
│   │   ├── action.ts
│   │   ├── stateSelector.ts
│   │   └── executor.ts
│   └── ...
├── verifiers/
│   ├── <prereqName_1>.ts                    # exports the verifier record
│   └── <prereqName_2>.ts
├── backend/
│   ├── env.ts                               # per-tool env constants (frozen, validated at module load)
│   └── client.ts                            # postBackend + getBackend transport helpers
├── shared/                                  # OPTIONAL — cross-action helpers
│   ├── resolve-<entity>.ts                  # e.g. resolve-card.ts for picking the active card
│   ├── rows.ts                              # shared verdict-row vocabulary (rows several actions reuse)
│   └── ...                                  # add as needed (e.g. pin-rules.ts, normalize.ts)
└── tests/                                   # OPTIONAL — per-tool integration tests
    └── <action>.test.ts                     # sandbox-backed e2e for that action
```
</canonical_layout>

<per_file_responsibility>
## names.ts
- The action and prerequisite NAMES, alone in a types-only leaf module: `export type ActionName = ...`, `export type PrereqName = ...`.
- Exists so an action declaration can be typed (`ActionDef<PrereqName, State>`) without importing `config.ts` — which imports the declarations back. The cheapest way to keep that graph acyclic.

## actions/<action_name>/action.ts
- The action's DECLARATION, beside the executor that names its verdicts: `export const <actionCamel>Action: ActionDef<PrereqName, State> = { ... }`.
- Carries: `summary`, `description` (the SEMANTIC LEAD only — the engine composes the gate marker and mechanics; never restate the handshake or enumerate verdicts), `paramsSchema`, `prereqs`, `verdicts` (the declared rows — static summaries/doctrine/state writes/effects, and the standing `ask` an outcome leaves behind), optional `controller` / `satisfies` / `bounceCapture` / `pageable`. Params are declared with the library's capture builders so each carries a field kind. (Downstream-slot invalidation is NOT per action — it is the config-level `invalidations` table in `config.ts`.)
- MUST NOT import `./executor.js`: executors pull backend/env, and the config → prompt chain has to stay env-free.

## config.ts
- Pure data, ASSEMBLED: imports each `actions/<name>/action.js` declaration and collects them in `defineConfig<ActionName, PrereqName, State>({...})`.
- Tool description = ONE semantic sentence (the library appends per-action bullets at runtime; the mechanics are engine-composed).

## index.ts
- The place where `agent-step/index.js` is consumed for wire-up.
- Imports every state selector from `actions/<name>/stateSelector.js` and every executor from `actions/<name>/executor.js`.
- Imports every verifier from `verifiers/<name>.js`.
- Builds `selectors` (with `satisfies SelectorRegistry<State, ActionName>`) and `executors` (`ExecutorRegistry<State, typeof selectors>`), both **keyed by the exact action name**, plus `verifiers`, then calls `buildAgentStepTool({ config, stateSchema, selectors, executors, verifiers, ... })` — passing the project's single Zod `AgentStateSchema` as `stateSchema`, plus the optional features (`handoff`, `abortPolicy`, `askContract`, `getCallerTurnId`).
- Exports the tool as `export const <name>Tool = ...`.

## actions/<action_name>/stateSelector.ts
- Exports `getSlice = (s: State) => ({ ... })` — projects the full state down to exactly the slot(s) this action's executor needs. Pure (no I/O).
- Exports `export type Slice = ReturnType<typeof getSlice>` — the executor imports this as its `state` param type, keeping projection and consumer in lockstep.

## actions/<action_name>/executor.ts
- Exports ONE function. The function name is free (camelCase conventional, e.g. `verifyCustomer`); the **registry key in index.ts is the exact action name**.
- Signature: `async (rawParams: unknown, state: Slice) => Promise<DeclaredExecutorResult<State>>` — `state` is the SLICE this action's selector returned, NOT the whole state. The return `stateUpdate` may still patch any host slot.
- Imports its slice type: `import type { Slice } from "./stateSelector.js";`.
- Casts `rawParams` to the concrete params interface (Zod has already parsed at the runner level).
- Calls backend helpers via `backend/client.js`.
- Returns `{ verdict, data?, stateUpdate?, effects?, resultExtras? }` — it NAMES the declared row; the wire body is composed from the row.
- See `executor-patterns.md` for read vs mutation shapes.

## tests/ (optional)
- Per-tool integration tests: `src/tools/<name>/tests/*.test.ts` — sandbox-backed end-to-end checks (`npm run test:sandbox`). Scaffolded from the `templates/tool-*.template` test files.
- Keep file names ending in `.test.ts` so `node --test dist/**/*.test.js` picks them up after `tsc`.
- These are OPTIONAL — the agent-step library has its own runner tests under `src/agent-step/*.test.ts` that you should never need to touch.

## verifiers/<prereq>.ts
- One file per unique prereq name.
- Exports a record matching `Verifier<State>`:
  ```ts
  export const customerVerified: Verifier<State> = {
    check: (s) => s?.verifiedCustomer != null,
    denial: { instruction: 'The customer is not verified in this session. Run "verify_customer" first.', error: "customer_not_verified" },
  };
  ```
- Predicate AND denial body co-located. No reference to config. The denial's `instruction` is model-facing doctrine (what the model does next), never a caller sentence.

## backend/env.ts
- Per-tool env constants. Read `process.env`; throw at module load if required vars are missing.
- Exports a frozen object so executors can `import { myEnv } from "../../backend/env.js"`.
- Pattern:
  ```ts
  function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  }
  export const myEnv = Object.freeze({
    baseUrl: required("MY_API_BASE_URL"),
    apiKey: required("MY_API_KEY"),
    // ...
  });
  export type MyEnv = typeof myEnv;
  ```

## backend/client.ts
- Transport helper. Patterns:
  - For HTTP JSON APIs: `postBackend<T>(baseUrl, endpoint, payload, opts?) => Promise<T>` (see `templates/backend-client.ts.template`).
  - For SOAP / gRPC / other: write the equivalent client and keep it stateless.
- Centralize envelope building (headers, auth, sandbox id) here so executors stay focused on domain logic.

## shared/
- Multi-action helpers, e.g. an entity-resolution helper that several executors invoke, or a `rows.ts` with verdict rows several actions share (the shared-module row pattern: a deterministic continuation declares its rows on the ACTION whose result space it shares).
- Stays inside the tool directory. Don't promote to a global `src/shared/` until a SECOND tool needs the same code (YAGNI).
</per_file_responsibility>

<file_creation_order>
Create files in this order — each step only depends on what's already created:

1. `names.ts`               — no imports (types-only leaf)
2. `backend/env.ts`         — no internal imports
3. `backend/client.ts`      — imports env
4. `shared/*.ts`            — may import env (rare); typically state-only
5. `verifiers/*.ts`         — no internal imports beyond state types
6. `actions/<x>/stateSelector.ts` × N — imports only the `State` type; exports `getSlice` + `Slice`
7. `actions/<x>/action.ts` × N — imports Zod, `names.js`, state types, capture builders; NEVER `./executor.js`
8. `actions/<x>/executor.ts` × N — imports client, shared, state types, AND its `Slice` from `./stateSelector.js`
9. `config.ts`              — imports `names.js` + every `action.js`; calls `defineConfig`
10. `index.ts`              — wires everything together (selectors + executors + verifiers + options)

This order also makes incremental verification possible: after step 8 you can `npx tsc --noEmit` on the new tool's files even before `index.ts` exists.
</file_creation_order>

<naming_rules>
- **Action names** — snake_case, verb-led (`verify_customer`, `list_accounts`, `fetch_balance`, `change_status`). Becomes the literal in the discriminated union AND the directory name under `actions/`.
- **Action declaration exports** — camelCase of the action name + `Action` (e.g. `verifyCustomerAction` in `actions/verify_customer/action.ts`).
- **Executor function names** — camelCase of the action name (e.g. `verifyCustomer`) by convention. The function name is free, though: what the runner matches is the **registry key**, which must be the exact action name (`verify_customer`). Same for the selector — `getSlice` per file, registered under the action name.
- **Prereq names** — camelCase, predicate-style (`customerVerified`, `accountActive`). Same string in `ActionDef.prereqs[]`, in `verifiers` registry, and in the verifier file name (kebab-case file, e.g. `verifiers/customer-verified.ts`).
- **Backend env constants** — UPPER_SNAKE_CASE in `.env`, camelCase in `backend/env.ts` (`CUSTOMER_API_BASE_URL` → `customerApiBaseUrl`).
- **Tool export** — `<name>Tool` (e.g. `cardsTool`, `accountsTool`).
</naming_rules>

<imports_convention>
Inside the tool directory, always use relative `./` and `../` paths with `.js` extensions (the project compiles ESM, so import paths reference compiled file extensions). Examples:

```ts
// In src/tools/accounts/actions/verify_customer/executor.ts:
import { postBackend } from "../../backend/client.js";
import { accountsEnv } from "../../backend/env.js";
import { resolveAccount } from "../../shared/resolve-account.js";
import type { State } from "../../../../state.js";
import type { DeclaredExecutorResult } from "../../../../agent-step/index.js";
```

Four `../`s back to `src/state.ts` and `src/agent-step/index.js` from inside `actions/<x>/`. Three from inside `verifiers/` and `backend/`. The bundled `templates/` show the exact import paths.
</imports_convention>

<templates_are_the_source_of_truth>
For a worked example of each file, read the bundled templates in this order:

1. `templates/names.ts.template`              — the types-only name leaf
2. `templates/action.ts.template`             — the per-action declaration (schema, rows with their asks, controller)
3. `templates/config.ts.template`             — the assembler
4. `templates/tool-index.ts.template`         — the wire-up
5. `templates/verifier.ts.template`           — verifier record shape
6. `templates/state-selector.ts.template`     — per-action `getSlice` + `Slice`
7. `templates/executor-read.ts.template`      — read executor (declared return)
8. `templates/executor-mutation.ts.template`  — mutation executor with internal pre-check + post-read
9. `templates/executor-read-paginated.ts.template` — large/list read via the `pageable` opt
10. `templates/backend-env.ts.template`       — env loader pattern
11. `templates/backend-client.ts.template`    — HTTP helper

Treat **these templates** as the structural source of truth — your output should be structurally
identical to the templates and the canonical layout above. If the project already contains another
tool, or you are porting from a source project, do NOT treat that code as the model to copy: it is
domain input (principle #9), and may encode decisions that don't belong in this paradigm. Derive
structure from the templates every time.
</templates_are_the_source_of_truth>
