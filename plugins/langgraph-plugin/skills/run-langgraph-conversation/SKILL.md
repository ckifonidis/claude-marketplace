---
name: run-langgraph-conversation
description: Runs a user-specified conversation against the local LangGraph dev server, captures the resulting thread_id, and hands off to the follow-langgraph-conversation skill for full trace analysis. Use when the user wants to execute a test conversation (single or multi-turn) against a LangGraph.js graph and investigate agent behaviour in one shot.
---

<objective>
Execute a user-described conversation against a local LangGraph.js dev server, then delegate the captured `thread_id` to the `follow-langgraph-conversation` skill for state + LLM-trace analysis.

Input (from the user invocation): a natural-language description of what to ask the agent. May be single-turn or multi-turn, and may include optional input-state fields the graph reads (e.g. a user id, a tenant/customer key, a role) — discover what those fields are from the graph rather than assuming.
</objective>

<assumptions>
This skill talks to the **LangGraph.js dev server** over HTTP (the server `npx @langchain/langgraph-cli dev` / `langgraph dev` exposes, default port `2024`). It is graph-agnostic: it discovers the registered graph and passes whatever input fields the user supplies. Nothing here is specific to any one project.

Several things vary per project and must be **discovered, not assumed** — read them from the project's own files (Phase 0):
- **The port** — read it from the dev script / compose mapping / env; treat `2024` as a last-resort default, and ask the user if it's unclear.
- **The graph id** (`assistant_id`) — discover it from `/assistants/search`; do not hardcode a name.
- **How the server is started** — `npm run dev`, `langgraph dev`, a `docker compose` service, etc. Probe first; only suggest a start command if it's down.
</assumptions>

<quick_start>
1. Discover the server config (port, start command, graph) by scanning the project's files.
2. Ensure the dev server is up on the discovered port (probe `/info`; start it only if down).
3. Discover the registered graph id via `/assistants/search`.
4. Create a fresh thread via `POST /threads`.
5. For each turn the user specified, call `POST /threads/{id}/runs/wait` with messages + any input-state fields.
6. Echo the turn-by-turn exchange back to the user along with the `thread_id`.
7. Invoke the `follow-langgraph-conversation` skill with that `thread_id`.
</quick_start>

<process>

<phase name="0_discover_config">
**Phase 0: Discover the server configuration**

Don't assume port `2024` or how the server starts — read it from the project first. Scan, in order, and stop once you have a port + a start command:

- **`langgraph.json`** (repo root) — confirms a LangGraph.js project. Its `graphs` map lists the registered graph ids (candidates for `assistant_id`); its `env` key names the env file (commonly `.env`) the dev server loads.
- **`package.json` scripts** — the dev script is the real start command and often pins the port, e.g. `"dev": "langgraph dev --port 8123"` or `"@langchain/langgraph-cli dev --port …"`. No `--port` flag → the CLI default is `2024`.
- **`docker-compose.y*ml`** — if the server runs in a container, the published host port is the `ports:` mapping (`host:container`) for the langgraph service, and the start command is `docker compose up -d <service>`.
- **`.env` / `.env.*`** (including the file `langgraph.json`'s `env` points at) — a `PORT` / `LANGGRAPH_PORT` var if the project wires one.
- **README** — for a documented port or start command.

Resolve the port from the strongest signal (dev-script `--port` > compose mapping > explicit env var > default `2024`). If sources conflict, or none is found and `/info` isn't reachable, **ask the user** for the port. Carry the resolved port through every URL below (this doc writes `2024` as a placeholder).
</phase>

<phase name="1_ensure_server">
**Phase 1: Ensure the dev server is running and find the graph**

Probe on the port resolved in Phase 0:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:2024/info
```

- `200` → continue. (The body looks like `{"flags":{"assistants":true,"crons":false}}`.)
- `404` / connection refused → the server isn't up. Start it with the **project's** dev command — commonly `npm run dev`, `npx @langchain/langgraph-cli dev`, or a `docker compose up -d` service if the graph runs in a container. Then poll `/info` until `200` (typical ready time 5–15s; fail after ~60s with a clear message). Don't guess a start command if the repo documents one — read `package.json` scripts / `README` / `langgraph.json` first.

Discover the graph id (don't assume it's `"agent"`):
```bash
curl -s -X POST http://localhost:2024/assistants/search \
  -H "Content-Type: application/json" -d '{"limit": 10}' | python3 -c "
import json, sys
for a in json.load(sys.stdin):
    print(f'  assistant_id={a.get(\"assistant_id\")} graph_id={a.get(\"graph_id\")}')
"
```

Use the returned `graph_id` as the `assistant_id` in Phase 3. If several graphs are registered, pick the one the user named, or ask.
</phase>

<phase name="2_create_thread">
**Phase 2: Create a new thread**

```bash
curl -s -X POST http://localhost:2024/threads \
  -H "Content-Type: application/json" -d '{}'
```

Extract `thread_id` from the JSON response. Reuse it for every turn below and for the handoff in Phase 4.
</phase>

<phase name="3_run_turns">
**Phase 3: Run each turn synchronously**

For every turn the user described:

```bash
curl -s -X POST "http://localhost:2024/threads/{THREAD_ID}/runs/wait" \
  -H "Content-Type: application/json" \
  -d '{
    "assistant_id": "{GRAPH_ID}",
    "input": {
      "messages": [{"role": "user", "content": "{USER_TEXT}"}]
    }
  }'
```

Rules:
- **`messages` is the one field every graph takes.** Add other input-state fields only when (a) the user supplied them and (b) the graph actually declares them. Discover the graph's input fields from its state definition (e.g. `src/**/state.ts`, an `InputState` annotation) or by inspecting a prior thread's `values`. Unknown keys are silently ignored by LangGraph, so a wrong guess fails silently — verify.
- **Match each field's declared type exactly.** A field typed as a string array must be passed as an array (`["x"]`, not `"x"`); a custom reducer can coerce or drop a mistyped value unpredictably. This is the most common input mistake.
- `/runs/wait` blocks until the turn completes. Chain turns sequentially using the same `thread_id` so the agent sees prior context.
- From each response, extract the last AI message (`messages[-1].content`) and show it to the user with the turn index.
- If the graph exposes top-level decision signals on the response (routing/classification/branch fields, a detected tool/handoff, a confidence score, etc.), surface those too so the user can see which path the turn took. Which fields exist is graph-specific — read them from the response `values`, don't assume a fixed set.

After all turns finish, print:
- `thread_id: {uuid}`
- 1 line per turn: `[N] user: "..." → agent: "..."` (truncated, with any non-default decision signals).
</phase>

<phase name="4_handoff">
**Phase 4: Hand off to the analysis skill**

Invoke the `follow-langgraph-conversation` skill via the Skill tool, passing the captured `thread_id` (and the port / graph id if non-default). That skill produces the full state-progression + LLM-trace report. Do NOT duplicate its work here — kick it off and relay its output.
</phase>

</process>

<input_format>
Accept flexible phrasings. Parse and, when ambiguous, echo your interpretation before executing. Examples:

- Single turn: *"ask the agent: show me current savings rates"*
- Multi-turn: *"turn 1: hi. turn 2: book me an appointment tomorrow."*
- With input-state context: *"as user_id=123 role=[\"manager\"], ask: what products do you offer?"* — only pass fields the graph declares.
- Other languages: pass user text through verbatim; many agents are multilingual.
</input_format>

<api_reference>
**LangGraph.js dev server endpoints used here:**
- `GET /info` — health probe (returns `{"flags":{...}}` when up; the dev server does not expose `/ok` or `/health`).
- `POST /assistants/search` — list registered graphs (body: `{"limit": N}`); read `graph_id`.
- `POST /threads` — create a thread (body: `{}`).
- `POST /threads/{thread_id}/runs/wait` — synchronous run (body: `{"assistant_id": "<graph_id>", "input": {...}}`).

**Input shape** mirrors the graph's input-state annotation:
- `messages[]` — required (LangChain-style `{role, content}` entries).
- Any additional input-state fields the graph declares (optional). Discover them; don't assume.
</api_reference>

<anti_patterns>
<pitfall name="starting_server_without_probing">
Always probe `/info` first. If it's down, start it with the project's documented dev command — and if the graph runs in a container, the right command is the container one (e.g. `docker compose up -d`), not a host `npm run dev` that skips the container's startup dependencies.
</pitfall>

<pitfall name="assuming_the_graph_id">
Don't hardcode `assistant_id: "agent"`. Discover the registered `graph_id` from `/assistants/search` and use it. A wrong id fails the run.
</pitfall>

<pitfall name="assuming_the_port">
Don't assume `2024`. Resolve the port from the project (Phase 0: dev script `--port`, compose port mapping, env var) and ask the user if it's unclear. Probing the wrong port reads as "server down" and sends you starting a server that's already running elsewhere.
</pitfall>

<pitfall name="using_non_blocking_runs">
Use `/runs/wait`, not `/runs/stream` or `/runs`. The latter two return immediately and require polling, which complicates turn chaining.
</pitfall>

<pitfall name="new_thread_per_turn">
Multi-turn conversations MUST reuse the same `thread_id`. A new thread per turn means the agent loses conversation memory and the follow-up analysis only covers the last turn.
</pitfall>

<pitfall name="mistyped_input_fields">
Match each input-state field's declared type. The classic failure is passing a string where the graph declares a string array — a custom reducer then stores something other than what you intended. Arrays must be arrays.
</pitfall>

<pitfall name="dumping_raw_api_responses">
Don't paste entire JSON responses back to the user. Extract the final AI message content plus any decision signals and summarise.
</pitfall>

<pitfall name="skipping_the_handoff">
The point of this skill is analysis, not just execution. Always invoke `follow-langgraph-conversation` at the end with the captured `thread_id`. Stopping after the conversation runs defeats the purpose.
</pitfall>
</anti_patterns>

<success_criteria>
- The dev server was confirmed (or freshly started and confirmed) healthy via `/info`.
- The registered graph id was discovered and used as `assistant_id`.
- A new `thread_id` was captured.
- Every user-specified turn ran to completion with no HTTP errors, and the final AI reply (+ any decision signals) was surfaced.
- The `follow-langgraph-conversation` skill was invoked with that `thread_id` and its report was relayed to the user.
</success_criteria>
