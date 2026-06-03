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
/plugin install agent-step-toolkit@claude-marketplace
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

## Layout

```
.claude-plugin/marketplace.json     # marketplace manifest (lists plugins)
plugins/
└── agent-step-toolkit/
    ├── .claude-plugin/plugin.json   # plugin manifest
    └── skills/
        ├── create-tool/             # full skill + workflows + references + templates (incl. agent-step library)
        └── test-agent-step/         # single-file skill
```
