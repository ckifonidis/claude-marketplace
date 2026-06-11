# Workflow: Port an Existing Project onto Agent-Step

<intent>
The user has a working project built on some other framework (or no framework) and wants its
capabilities re-platformed onto agent-step. This workflow is **orchestration, not a new
implementation**: it reads the source project as a *domain spec*, establishes an agent-step
project, then drives the normal `create-tool.md` workflow once per capability cluster.
</intent>

<paradigm_not_blueprint>
**This is the mode principle #9 exists for. Read it before anything else.**

The source project answers exactly one question: **WHAT** must the agent be able to do — its
capabilities, backend endpoints, identity model, business rules, validation, error cases. It must
**never** answer **HOW** to structure the agent-step tool. Do not mirror its directory layout,
its class/service abstractions, its control flow, its layering, or its naming idioms. Every
structural decision is re-derived from the agent-step paradigm and the bundled `templates/` —
the same way a fresh `create-tool.md` run would, as if the source project's code did not exist.

If you catch yourself opening a source file to copy its *shape* (rather than to extract a rule or
an endpoint), stop — that is the anti-pattern this workflow is built to prevent.
</paradigm_not_blueprint>

<process>
## Step 1: Read the source project as a domain spec

Survey the source project and extract, into a written **capability inventory** — not code:

- **Capabilities** — every user-facing thing the system can do (read or mutate), phrased as
  user intents (this is the `input-formats.md` "user stories" format).
- **Backend endpoints** — the upstream APIs each capability calls (URL/verb/payload/response),
  the auth/envelope shape, and any sandbox conventions.
- **Sandbox** — does the source project ship a local sandbox (typically a root `sandbox/`
  directory)? If so, assess it against `references/sandbox-contract.md`: which services it models,
  whether it has the lifecycle CRUD / `Sandbox-Id` header isolation / JSON seeding, and whether it
  can be brought over directly or needs adapting. The sandbox is the ONE exception to
  paradigm-not-blueprint: it's a domain artifact (real envelope/error knowledge), not agent
  structure — reusing it verbatim is encouraged.
- **Identity model** — does the system collect-and-verify identity, or run pre-authenticated with
  a session context? (Maps to the two models in `identity-patterns.md`.)
- **Business rules & gates** — preconditions, validations, confirmation requirements, OTP / double-
  entry / multi-turn flows, and refusal cases.
- **Journey structure** — which capabilities only make sense once the user has reached a prior
  state (identity acquired, entity selected, flow open). These become prereqs (principle #11).

Record this as prose + a capability table. Do NOT transcribe the source's file structure.

## Step 2: Establish the agent-step project

- If the target directory has **no** `src/agent-step/`, run `workflows/bootstrap-project.md`
  first to scaffold the project (library, graph/state/prompt skeleton, CLI, test harness).
- If an agent-step project already exists, reuse it.

## Step 2b: Establish the sandbox

Work down the acquisition ladder in `references/sandbox-contract.md`, starting from what Step 1
found in the source project:

- Source sandbox is **compliant** → copy its `sandbox/` directory into the target project root,
  trimming controllers for services the new agent won't use.
- Source sandbox **deviates** (e.g. `/sandboxes` lifecycle paths instead of `/sandbox`, missing
  header isolation or JSON seeding) → copy it and adapt it to the contract; keep its domain
  controllers.
- **No source sandbox** → build one best-effort from a Postman collection, OpenAPI specs, or
  captured transcripts, covering every backend service the capability inventory needs.

The sandbox must be up before Step 4 — each ported tool is taken to green via its sandbox tests.

## Step 3: Cluster capabilities into tools

Group the capability inventory into tools (one `src/tools/<name>/` per cohesive domain — e.g.
`cards`, `accounts`, `transfers`). Keep clusters aligned to the user's domain, not to the source
project's module boundaries.

## Step 4: Derive each tool fresh via create-tool

For each cluster, run `workflows/create-tool.md` (NEW-tool branch), feeding it the captured spec
as the "backend specs + functionality description" inputs. That workflow's plan-then-confirm-then-
write loop applies unchanged. The source project is referenced only to answer domain questions
that arise during planning — never as a structural template.

Port one tool to green (typecheck + sandbox tests) before starting the next.
</process>

<success_criteria>
- [ ] A written capability inventory exists, derived from the source as a domain spec (no copied
      file structure).
- [ ] The target is a valid agent-step project (`src/agent-step/` present; bootstrap criteria met
      if it was scaffolded here).
- [ ] A root `sandbox/` exists, satisfies the `sandbox-contract.md` checklist, and models every
      backend service the ported tools call.
- [ ] Each capability cluster is delivered as a tool via `create-tool.md`, meeting that workflow's
      own `<success_criteria>` (typecheck clean, sandbox tests green or triaged as findings,
      dev server boots without construction-time errors).
- [ ] No tool reproduces the source project's architecture — structure is paradigm-derived.
- [ ] User signed off on the ported deliverable.
</success_criteria>
