# Reference: Tool Directory Layout

<overview>
Every tool follows the same directory shape, mirroring `src/tools/cards/`. Adopting this layout uniformly means: predictable file locations, one-import-per-action wire-up, and convention-name lookups by the runner.
</overview>

<canonical_layout>
```
src/tools/<name>/
├── config.ts                                # action declarations (pure data)
├── index.ts                                 # wire-up: buildAgentStepTool({...})
├── actions/
│   ├── <action_1>/
│   │   ├── stateSelector.ts                 # exports getSlice + Slice — projects state to this action's slice
│   │   └── executor.ts                      # exports the executor function (receives the slice)
│   ├── <action_2>/
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
│   ├── match.ts                             # entity-matching helpers (name fields, ID fields, etc.)
│   └── ...                                  # add as needed (e.g. pin-rules.ts, normalize.ts)
└── tests/                                   # OPTIONAL — per-tool integration tests
    └── <action>.test.ts                     # sandbox-backed e2e for that action
```
</canonical_layout>

<per_file_responsibility>
## config.ts
- Pure data. No closures, no lambdas, no state references.
- Declares `ActionName` and `PrereqName` literal type unions.
- Calls `defineConfig<ActionName, PrereqName>({...})`.
- Tool description = lead paragraph + (library appends per-action bullets at runtime).
- Action `description` field is mandatory; LLM-facing prose covering: what verdicts it returns, what the result body contains, what side-effects it has on state.

## index.ts
- The ONLY file where `agent-step/index.js` is consumed.
- Imports every state selector from `actions/<name>/stateSelector.js` (e.g. `import { getSlice as verifyCustomerSlice } from "./actions/verify_customer/stateSelector.js"`) and every executor from `actions/<name>/executor.js`.
- Imports every verifier from `verifiers/<name>.js`.
- Builds `selectors` (with `satisfies SelectorRegistry<State, ActionName>`) and `executors` (`ExecutorRegistry<State, typeof selectors>`), both **keyed by the exact action name**, plus `verifiers`, then calls `buildAgentStepTool({ config, stateAnnotation, selectors, executors, verifiers })`.
- Exports the tool as `export const <name>Tool = ...`.

## actions/<action_name>/stateSelector.ts
- Exports `getSlice = (s: State) => ({ ... })` — projects the full state down to exactly the slot(s) this action's executor needs. Pure (no I/O).
- Exports `export type Slice = ReturnType<typeof getSlice>` — the executor imports this as its `state` param type, keeping projection and consumer in lockstep.
- Use `satisfies SelectorRegistry<State, ActionName>` on the registry in `index.ts` (not a type annotation) so each selector's precise return type survives into `typeof selectors`.

## actions/<action_name>/executor.ts
- Exports ONE function. The function name is free (camelCase conventional, e.g. `verifyCustomer`); the **registry key in index.ts is the exact action name**.
- Signature: `async (rawParams: unknown, state: Slice) => Promise<ExecutorResult<State>>` — `state` is the SLICE this action's selector returned, NOT the whole state. The return `stateUpdate` may still patch any host slot.
- Imports its slice type: `import type { Slice } from "./stateSelector.js";`.
- Casts `rawParams` to the concrete params interface (Zod has already parsed at the runner level).
- Calls backend helpers via `backend/client.js`.
- Returns `{ resultBody, stateUpdate?, ok }`.
- See `executor-patterns.md` for read vs mutation shapes.

## tests/ (optional)
- Per-tool integration tests: `src/tools/<name>/tests/*.test.ts`. The cards tool uses this directory for sandbox-backed end-to-end checks (`npm run test:sandbox`).
- Keep file names ending in `.test.ts` so `node --test dist/**/*.test.js` picks them up after `tsc`.
- These are OPTIONAL — the agent-step library has its own runner tests under `src/agent-step/runner.test.ts` that you should never need to touch.

## verifiers/<prereq>.ts
- One file per unique prereq name.
- Exports a record matching `Verifier<State>`:
  ```ts
  export const customerVerified: Verifier<State> = {
    check: (s) => s?.verifiedCustomer != null,
    denial: { summary: "Customer is not verified in this session.", error: "customer_not_verified" },
  };
  ```
- Predicate AND denial body co-located. No reference to config.

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
  - For HTTP JSON APIs: `postBackend<T>(baseUrl, endpoint, payload, opts?) => Promise<T>` (see `src/tools/cards/backend/client.ts` as a reference).
  - For SOAP / gRPC / other: write the equivalent client and keep it stateless.
- Centralize envelope building (headers, auth, sandbox id) here so executors stay focused on domain logic.

## shared/
- Multi-action helpers, e.g. an entity-resolution helper that several executors invoke.
- Stays inside the tool directory. Don't promote to a global `src/shared/` until a SECOND tool needs the same code (YAGNI).
</per_file_responsibility>

<file_creation_order>
Create files in this order — each step only depends on what's already created:

1. `backend/env.ts`        — no internal imports
2. `backend/client.ts`     — imports env
3. `shared/*.ts`           — may import env (rare); typically state-only
4. `verifiers/*.ts`        — no internal imports beyond state types
5. `actions/<x>/stateSelector.ts` × N — imports only the `State` type; exports `getSlice` + `Slice`
6. `actions/<x>/executor.ts` × N — imports client, shared, state types, AND its `Slice` from `./stateSelector.js`
7. `config.ts`             — imports nothing except Zod + defineConfig; `export type ActionName`
8. `index.ts`              — wires everything together (selectors + executors + verifiers)

This order also makes incremental verification possible: after step 6 you can `npx tsc --noEmit` on the new tool's files even before `index.ts` exists.
</file_creation_order>

<naming_rules>
- **Action names** — snake_case, verb-led (`verify_customer`, `list_accounts`, `fetch_balance`, `change_status`). Becomes the literal in the discriminated union AND the directory name under `actions/`.
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
import type { AgentState } from "../../../../state.js";
import type { ExecutorResult } from "../../../../agent-step/index.js";
```

Four `../`s back to `src/state.ts` and `src/agent-step/index.js` from inside `actions/<x>/`. Three from inside `verifiers/` and `backend/`. Use the existing cards files for ground-truth examples.
</imports_convention>

<grep_for_examples>
For a fully-worked example tool, read these files in this order:

1. `src/tools/cards/config.ts`                    — every config field shown
2. `src/tools/cards/index.ts`                     — the wire-up
3. `src/tools/cards/verifiers/customer-verified.ts` — verifier record shape
4. `src/tools/cards/actions/verify_customer/executor.ts` — read executor
5. `src/tools/cards/actions/change_status/executor.ts` — mutation executor with internal pre-check + post-read
6. `src/tools/cards/backend/env.ts`               — env loader pattern
7. `src/tools/cards/backend/client.ts`            — HTTP helper
8. `src/tools/cards/shared/resolve-card.ts`       — cross-action helper

Treat these as the source of truth. Anything you write should look structurally identical.
</grep_for_examples>
