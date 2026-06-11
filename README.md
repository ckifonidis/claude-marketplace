# claude-marketplace

A personal [Claude Code](https://claude.com/claude-code) plugin marketplace.

## Add this marketplace

```
/plugin marketplace add ckifonidis/claude-marketplace
```

(or with the full URL: `/plugin marketplace add https://github.com/ckifonidis/claude-marketplace`)

## Plugins

### agent-step-toolkit

Tools for building **agent-step** LangGraph agents (ReAct agents fronted by a single
batching tool + deterministic flow-controller runner).

Install:

```
/plugin install agent-step-toolkit@ckifonidis-marketplace
```

Ships three skills:

- **`create-tool`** — bootstrap a new agent-step project (package.json, tsconfig,
  langgraph config, the agent-step runner **library**, graph/agent/state/prompt
  skeleton, streaming CLI, Dockerfile, build script), add a domain tool to an
  existing one (actions, executors, verifiers, `controller` lifecycle hooks,
  `invalidatesOnChange` cascades, state slots, prompt sections), **or port an
  existing project** onto agent-step (reading the source as a domain spec only).
  Covers read-tool patterns (native paginated reads via `pageable`) and the
  data-analysis pattern (an analyze action running LLM-authored snippets over
  fetched data). Every project carries a root `sandbox/` service — a local mock of
  the tools' backend APIs (lifecycle CRUD at `/sandbox`, `Sandbox-Id` header
  isolation, JSON seeding for tests) acquired best-effort from a reference project,
  a Postman collection, or specs (`references/sandbox-contract.md`). The runner
  library and the config/scaffold templates travel with the skill under
  `skills/create-tool/templates/`.
- **`test-agent-step`** — the three-layer testing methodology for an agent-step
  action: runner unit tests (flow-controller mechanics, no backend/LLM), sandbox/tool
  tests (runner + executors against a local sandbox, no LLM), and prompt-input tests
  (the LLM emits the right steps, no execution).
- **`pull-library`** — consumer side of library versioning: run inside a downstream
  project to upgrade its vendored `src/agent-step/` to the toolkit's version and apply
  the migration transforms to the project's own tools. (The maintainer side,
  `bump-version`, lives in this repo at `.claude/skills/` — it edits the plugin's
  source tree, so it isn't shipped.)

The embedded runner library (`skills/create-tool/templates/agent-step/`) is the
**canonical, versioned source** — its `VERSION` marker travels into every
bootstrapped project at `src/agent-step/VERSION`. `CHANGELOG.md` tracks the library;
`PLUGIN_CHANGELOG.md` tracks the plugin package itself.

### langgraph-plugin

Run and debug **any** LangGraph.js conversation against the local dev server. Graph-agnostic:
it discovers the registered graph and your state fields rather than assuming a fixed schema.

Install:

```
/plugin install langgraph-plugin@ckifonidis-marketplace
```

Ships two skills:

- **`run-langgraph-conversation`** — execute a single- or multi-turn test conversation against
  the local dev server (probe `/info`, discover the `graph_id`, create a thread, run each turn
  with `/runs/wait`, reuse the `thread_id`), surface the replies + any decision signals, then hand
  off the captured `thread_id` to the analysis skill.
- **`follow-langgraph-conversation`** — investigate a thread end-to-end: dev-server thread state,
  runs, and full checkpoint history (state progression), plus LangSmith traces (LLM prompts /
  responses / token usage) when tracing is enabled — ending in a state-progression table and
  root-cause analysis.

## Layout

```
.claude-plugin/marketplace.json     # marketplace manifest (lists plugins)
.claude/skills/                      # repo-maintainer skills (not shipped)
├── bump-version/                    # absorb a newer agent-step runner into the toolkit's embedded library
└── publish-release/                 # cut a plugin release — staleness sweep, version sync, changelog, release commit
plugins/
├── agent-step-toolkit/
│   ├── .claude-plugin/plugin.json   # plugin manifest
│   ├── CHANGELOG.md                 # agent-step runner library version history
│   ├── PLUGIN_CHANGELOG.md          # plugin package version history
│   ├── migrations/                  # per-version migration guides (written by bump-version, applied by pull-library)
│   └── skills/
│       ├── create-tool/             # bootstrap / add-tool / extend / port + workflows + references + templates (incl. the canonical agent-step library)
│       ├── test-agent-step/         # three-layer testing methodology
│       └── pull-library/            # upgrade a downstream project's vendored library (consumer side)
└── langgraph-plugin/
    ├── .claude-plugin/plugin.json   # plugin manifest
    └── skills/
        ├── run-langgraph-conversation/      # execute a test conversation, capture thread_id
        └── follow-langgraph-conversation/   # investigate a thread (dev server + LangSmith) → root cause
```
