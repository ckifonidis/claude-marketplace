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

Ships two skills:

- **`create-tool`** — bootstrap a new agent-step project (package.json, tsconfig,
  langgraph config, the agent-step runner **library**, graph/agent/state/prompt
  skeleton, streaming CLI, Dockerfile, build script) **or** add a domain tool to an
  existing one (actions, executors, verifiers, `controller` lifecycle hooks,
  `invalidatesOnChange` cascades, state slots, prompt sections). The runner library
  and the config/scaffold templates travel with the skill under
  `skills/create-tool/templates/`.
- **`test-agent-step`** — the three-layer testing methodology for an agent-step
  action: runner unit tests (flow-controller mechanics, no backend/LLM), sandbox/tool
  tests (runner + executors against a local sandbox, no LLM), and prompt-input tests
  (the LLM emits the right steps, no execution).

The bundled runner library is a **versioned snapshot**. The canonical source lives in
the agent projects; when it changes, bump `agent-step-toolkit`'s version and re-sync.

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
plugins/
├── agent-step-toolkit/
│   ├── .claude-plugin/plugin.json   # plugin manifest
│   └── skills/
│       ├── create-tool/             # full skill + workflows + references + templates (incl. agent-step library)
│       └── test-agent-step/         # single-file skill
└── langgraph-plugin/
    ├── .claude-plugin/plugin.json   # plugin manifest
    └── skills/
        ├── run-langgraph-conversation/      # execute a test conversation, capture thread_id
        └── follow-langgraph-conversation/   # investigate a thread (dev server + LangSmith) → root cause
```
