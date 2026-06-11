# Reference: The Local Sandbox Contract

<overview>
Every project this skill produces **requires a sandbox**: a standalone local API service, living in a
`sandbox/` directory at the project root, that mimics the backend APIs the agent's tools call. The
whole sandbox-test layer (`npm run test:sandbox`, the seed-reset cycle, the "extend the sandbox, never
stub in-process" rule in `test-agent-step`) depends on it existing and honouring the contract below.

The sandbox is part of the deliverable, not an optional extra. A project whose tools call backends the
sandbox doesn't model cannot run its sandbox tests — which means the tool was never verified.
</overview>

<scope_apis_only>
## Scope: backend APIs only — never AI resources

The sandbox mimics **domain backend APIs** (cards, accounts, customers, payments, …). It must NOT
attempt to mimic AI resources:

- The LLM endpoint (Azure OpenAI / OpenAI) stays real — prompt-input tests use the live model, and the
  sandbox layer never invokes an LLM at all.
- Azure AI Search indexes, embedding endpoints, vector stores, and similar AI infrastructure stay real
  (or are exercised by other test layers) — they are not sandbox content.

Rule of thumb: if a tool's **executor** calls it over HTTP as a domain backend, the sandbox models it.
If it's part of the model/retrieval plumbing, it doesn't belong in the sandbox.
</scope_apis_only>

<contract>
## The contract

The sandbox is an HTTP service (any framework — the contract is HTTP-level) with two surfaces:

### 1. Sandbox lifecycle — standard CRUD, id in the URL path

| Verb + route | Behaviour |
|---|---|
| `POST /sandbox` | Create a sandbox. JSON body may carry the desired id: `{ "sandboxId": "my-test-1" }`; if omitted, generate one (e.g. a UUID). Returns the created sandbox. |
| `GET /sandbox` | List all sandboxes. |
| `GET /sandbox/:sandboxId` | Get one sandbox's data/entity summary. 404 if unknown. |
| `PUT /sandbox/:sandboxId` | Update the sandbox's entities (add / update / remove). If the body also carries a `sandboxId`, reject a mismatch with the URL (400) — silent URL-wins causes "I updated the wrong sandbox" bugs. |
| `DELETE /sandbox/:sandboxId` | Delete the sandbox. 204 on success. |

### 2. Domain endpoints — isolation via a `Sandbox-Id` header

Every non-lifecycle endpoint (the mimicked backend APIs) reads the active sandbox from a
**`Sandbox-Id` HTTP header**:

- Required on every domain request; missing header → `400 {"message":"Missing Sandbox-Id header"}`.
- Header-name matching is case-insensitive (`Sandbox-Id`, `sandbox-id`, `SANDBOX-ID` all work).
- All state is keyed by that id — two sandboxes never see each other's data. This is what lets test
  suites run isolated against one shared sandbox process.

Domain routes keep the **real backend's paths, payloads, envelopes, and error shapes** — executors
must be able to point their `*_BASE_URL` at the sandbox and work unchanged.

### 3. JSON seeding — what the test layer depends on

- **Mandatory:** a sandbox's data model can be seeded from JSON over the lifecycle API —
  `PUT /sandbox/:sandboxId` with an entity payload populates the sandbox's entities. This is what
  the per-tool test reset cycle is built on: `DELETE /sandbox/:id` → `POST /sandbox` (with the
  suite's id) → `PUT /sandbox/:id` with the tool's **checked-in** `seed.json` — so the
  repo-committed seed, not whatever the sandbox happens to contain, is the source of truth.
- **Optional convenience:** the sandbox may also auto-create a pre-seeded sandbox on boot (e.g. id
  from `$SANDBOX_ID`, data from checked-in `sandbox/seeds/` files) so it's usable immediately for
  manual poking. Tests must not rely on it — they always seed explicitly from their own JSON.
</contract>

<acquisition>
## Getting a sandbox: the best-effort ladder

When establishing a project (bootstrap or port), work down this ladder until a sandbox exists for
**every backend service the tools require**:

1. **The reference project ships a compliant sandbox** → bring it from there. Copy its `sandbox/`
   directory into the new project root (it's a self-contained service: own `package.json`, `src/`,
   `seeds/`). Verify it against the compliance checklist; trim controllers for services the new agent
   doesn't use.
2. **A sandbox exists but deviates from the contract** (e.g. different lifecycle paths such as
   `/sandboxes`, missing header isolation, no seed support) → bring it and adapt: add/rename the
   lifecycle CRUD, enforce the `Sandbox-Id` header, wire JSON seeding via PUT. Keep its domain
   controllers — those encode real envelope/error knowledge you don't want to re-derive.
3. **A Postman collection is provided** → build the sandbox from it. Each request gives you route,
   verb, payload, and (from saved examples) response envelopes; group requests into controllers per
   service, back them with an in-memory entity store keyed by `Sandbox-Id`, and derive seed JSON
   from the example data.
4. **Neither** → best effort from whatever exists: OpenAPI specs, backend docs, captured
   request/response transcripts. Model at minimum the endpoints the planned actions call, with
   realistic envelopes and the error cases the executors map to verdicts.

Whatever rung you land on, the result must satisfy the checklist below — and if some required service
could not be modeled, say so explicitly in the plan/report rather than letting `test:sandbox`
silently not cover it.
</acquisition>

<compliance_checklist>
## Compliance checklist

- [ ] `sandbox/` directory at the project root; self-contained service (own `package.json`, starts
      with one command, port configurable via `$PORT`).
- [ ] Lifecycle CRUD at `POST /sandbox`, `GET /sandbox`, `GET/PUT/DELETE /sandbox/:sandboxId`.
- [ ] `POST /sandbox` accepts an optional `{ "sandboxId": ... }` JSON body; generates an id when
      omitted.
- [ ] Every domain endpoint requires the `Sandbox-Id` header (case-insensitive); 400 when missing;
      state fully isolated per id.
- [ ] A sandbox's data model can be seeded from a JSON payload via `PUT /sandbox/:sandboxId` —
      mandatory; this is what test execution depends on.
- [ ] Domain routes mirror the real backends' paths/payloads/envelopes/errors closely enough that
      executors run unchanged with `*_BASE_URL` pointed at the sandbox.
- [ ] Models every backend service the project's tools call — AI resources excluded by design.
- [ ] The per-tool test reset cycle (DELETE → POST → PUT checked-in seed) works against it.
</compliance_checklist>
