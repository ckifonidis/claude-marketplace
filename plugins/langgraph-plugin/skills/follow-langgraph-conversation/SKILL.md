---
name: follow-langgraph-conversation
description: Investigates a LangGraph thread conversation by querying the LangGraph dev server API and (when configured) the LangSmith cloud API. Extracts runs, checkpoints, state progressions, LLM prompts/responses, and produces root cause analysis. Use when debugging a LangGraph conversation thread or analyzing agent behavior for a specific thread_id.
---

<objective>
Deep-dive investigation of a LangGraph.js conversation thread. Exhaustively queries the available log sources — the LangGraph dev server (local HTTP API) and LangSmith (cloud traces, when enabled) — to reconstruct the full state progression, identify where things went wrong, and produce actionable root-cause analysis.

Takes a `thread_id` as input. Optionally accepts a port (default `2024`) and a LangSmith project name (default: whatever `LANGSMITH_PROJECT` is set to in the project's environment).
</objective>

<assumptions>
Graph-agnostic. This skill knows the LangGraph dev-server and LangSmith **API shapes**, not your graph. The state fields, node names, and decision signals it surfaces are **discovered from the thread**, not assumed. Where this doc shows field names (e.g. a routing decision, a confidence score), treat them as *illustrative examples* of the kind of signal to look for — substitute your graph's actual state fields, which you learn from the thread `values` and the graph's `state` definition (`src/**/state.ts` or equivalent).
</assumptions>

<quick_start>
Given a thread_id, run through these phases in order:

0. **Discover config** — the dev-server port and the LangSmith credentials, read from the project's files.
1. **LangGraph dev server** — thread state, runs list, full checkpoint history.
2. **LangSmith cloud** — trace tree, LLM prompts and responses (only if LangSmith is enabled — see Phase 2 prerequisites).
3. **Analysis** — state-progression table, root-cause identification.

All queries use `curl` piped to `python3` for JSON parsing. This doc writes `2024` as a placeholder — use the port resolved in Phase 0.
</quick_start>

<process>

<phase name="0_discover_config">
**Phase 0: Discover the configuration**

Read the project before assuming anything. Two things live in the project, not in defaults — the dev-server **port** and the **LangSmith credentials**.

**Port.** Scan, in order: `langgraph.json` (the `graphs` map gives candidate graph ids; the `env` key names the env file the server loads), `package.json` dev script (a `--port` flag, else the CLI default `2024`), `docker-compose.y*ml` (the published `host:container` port mapping for the langgraph service), and the README. Resolve to one port; if it's unclear and `/info` isn't reachable, **ask the user**.

**LangSmith credentials.** The API key and project name almost always live in the agent's **`.env`** — specifically the file `langgraph.json`'s `env` key points at (commonly `.env`, sometimes a nested path like `config/<agent>/.env`). Read them straight from there:

```bash
grep -E '^(LANGSMITH_API_KEY|LANGCHAIN_API_KEY|LANGSMITH_PROJECT|LANGSMITH_TRACING|LANGCHAIN_TRACING_V2)=' .env
```

- `LANGSMITH_API_KEY` (or legacy `LANGCHAIN_API_KEY`) — the key for Phase 2.
- `LANGSMITH_PROJECT` — the session/project name to query in Phase 2.
- `LANGSMITH_TRACING=true` (or legacy `LANGCHAIN_TRACING_V2=true`) — tracing is only being **recorded** when this is on. If it's absent/false, expect no cloud traces and lean on Phase 1.

If the server runs in a container and the values are injected there rather than committed to a local `.env`, read them from the running process instead: `docker exec <container> printenv LANGSMITH_API_KEY`. Only ask the user for a key if neither source has it.
</phase>

<phase name="1_langgraph_dev_server">
**Phase 1: LangGraph dev server queries**

Run these three queries to get the full picture from the local server.

**1a. Thread current state**

```bash
curl -s http://localhost:2024/threads/{thread_id} | python3 -m json.tool
```

Extract: `status`, `updated_at`, and the `values` keys. From `values`, note the message list plus whatever **domain signals** your graph writes — routing/classification decisions, detected tools, confidence scores, extracted arguments, input-context fields, accumulated lists, etc. (Read the `values` to learn which fields exist; they are graph-specific.)

**1b. All runs for the thread**

```bash
curl -s http://localhost:2024/threads/{thread_id}/runs | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f'Total runs: {len(data)}')
for r in data:
    print(f'  run={r[\"run_id\"][:8]} status={r[\"status\"]} created={r[\"created_at\"]} updated={r[\"updated_at\"]}')
"
```

**1c. Full checkpoint history (state progression)**

This is the most valuable query. It shows every intermediate state the graph passed through — one checkpoint per node transition, with `metadata.step` counting up from `-1` (input) through the node sequence.

```bash
curl -s -X POST 'http://localhost:2024/threads/{thread_id}/history' \
  -H 'Content-Type: application/json' \
  -d '{"limit": 50}' | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f'Total checkpoints: {len(data)}')
# Large fields drown the output if printed per-checkpoint. Keep them in state,
# just don't echo them here — request them individually when diagnosing.
# Add YOUR graph's big derived fields (formatted blobs, retrieved docs, etc.).
SKIP = {'messages'}
for i, cp in enumerate(data):
    meta = cp.get('metadata', {}) or {}
    step = meta.get('step', '?')
    source = meta.get('source', '?')
    run_id = str(meta.get('run_id', ''))[-8:]
    next_nodes = cp.get('next', [])
    vals = cp.get('values', {}) or {}
    msgs = vals.get('messages', []) or []
    last_msg_type = msgs[-1].get('type', '?') if msgs else 'none'
    last_msg_content = msgs[-1].get('content', '') if msgs else ''
    if isinstance(last_msg_content, list):
        last_msg_content = last_msg_content[0].get('text', '') if last_msg_content else ''
    last_msg_content = (last_msg_content or '')[:120]

    print(f'\n--- Checkpoint {i} (step={step}, source={source}, run=...{run_id}) ---')
    print(f'  next: {next_nodes}')
    print(f'  messages: {len(msgs)}, last: [{last_msg_type}] {last_msg_content}')
    for k in sorted(vals.keys()):
        if k in SKIP:
            continue
        v = vals[k]
        s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
        print(f'  {k}: {s[:160]}')
"
```

To inspect a large field (retrieved docs, full conversation, a big formatted blob), pull it from `vals` on the specific checkpoint of interest — don't widen `SKIP`'s exclusions globally or the dump becomes unreadable.

**`/history` deserialization caveat**

`/history` can return HTTP 500 (e.g. `Invalid identifer: $`) when a thread's messages include a **custom message subclass** the checkpoint deserializer doesn't recognise. When you hit this:
- Note it as an app-side checkpoint-serde issue, not a skill bug — re-running won't help.
- Fall back to what still works: 1a (`GET /threads/{id}`) and 1b (`GET /threads/{id}/runs`). The final `values` from 1a still contains the end-state signals; lean on LangSmith (Phase 2) for per-step LLM detail.
</phase>

<phase name="2_langsmith_cloud">
**Phase 2: LangSmith cloud queries**

LangSmith provides the detailed LLM-level traces (prompts, responses, token counts) that the dev server doesn't expose.

**Prerequisites**: LangSmith is opt-in and often **off by default**. You already located the key, project name, and tracing flag in Phase 0 (from the agent's `.env`, or the running container). Export the key for the queries below:
```bash
export LANGSMITH_API_KEY=$(grep -E '^LANGSMITH_API_KEY=' .env | cut -d= -f2-)
```
If the tracing flag wasn't on (`LANGSMITH_TRACING` / `LANGCHAIN_TRACING_V2`), or no key exists anywhere, **skip Phase 2 entirely** and rely on Phase 1 + the final assistant message — there will be no cloud traces to retrieve.

**2a. Find the project/session ID**

```bash
curl -s "https://api.smith.langchain.com/api/v1/sessions" \
  -H "x-api-key: $LANGSMITH_API_KEY" | python3 -c "
import json, sys
for p in json.load(sys.stdin):
    print(f'  id={p[\"id\"]} name={p[\"name\"]}')
"
```

**2b. List trace runs (note: `session` is an array)**

```bash
curl -s -X POST "https://api.smith.langchain.com/api/v1/runs/query" \
  -H "x-api-key: $LANGSMITH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "session": ["{PROJECT_ID}"],
    "limit": 30
  }' | python3 -c "
import json, sys
data = json.load(sys.stdin)
runs = data.get('runs', [])
print(f'Found {len(runs)} runs')
for r in runs:
    parent = r.get('parent_run_id')
    trace = r.get('trace_id', '')
    print(f'  id={r[\"id\"][:16]} name={r.get(\"name\"):24s} type={r.get(\"run_type\"):6s} parent={str(parent)[:16] if parent else \"ROOT\":16s} trace={str(trace)[:16]}')
"
```

Match traces to thread runs by comparing timestamps and run IDs. LangGraph run IDs typically appear as LangSmith trace IDs for the root run named after the registered `graph_id`. The child run names map to your graph's nodes — the LLM-call nodes (`run_type=llm`) are the ones to read in full when classification, generation, or grounding misbehaves.

**2c. Get a detailed LLM run (prompt + response)**

For each LLM run (look for `run_type=llm`, typically named after the chat model, e.g. `AzureChatOpenAI` / `ChatOpenAI`):

```bash
curl -s "https://api.smith.langchain.com/api/v1/runs/{RUN_ID}" \
  -H "x-api-key: $LANGSMITH_API_KEY" | python3 -c "
import json, sys
r = json.load(sys.stdin)
print(f'name: {r.get(\"name\")}  status: {r.get(\"status\")}')

inputs = r.get('inputs', {})
msgs = inputs.get('messages', [])
for mg in msgs:
    items = mg if isinstance(mg, list) else [mg]
    for m in items:
        kwargs = m.get('kwargs', {})
        content = kwargs.get('content', '')
        if isinstance(content, str) and len(content) > 100:
            print(f'\n--- PROMPT ({len(content)} chars) ---')
            print(content[:5000])
            if len(content) > 5000:
                print(f'... [{len(content) - 5000} more chars]')

outputs = r.get('outputs', {})
gens = outputs.get('generations', [[]])
if gens and gens[0]:
    text = gens[0][0].get('text', '')
    gen_info = gens[0][0].get('generation_info', {})
    print(f'\n--- LLM RESPONSE ---')
    print(text[:3000])
    print(f'\n--- TOKEN USAGE ---')
    usage = gen_info.get('token_usage', {})
    print(f'  prompt={usage.get(\"prompt_tokens\")} completion={usage.get(\"completion_tokens\")} total={usage.get(\"total_tokens\")}')
    print(f'  model={gen_info.get(\"model_name\")}')
"
```

For long prompts, slice further: `print(content[5000:12000])`. Read the system prompt in full when routing/classification or grounding misbehaves — the prompt is half the explanation for any LLM decision.

**2d. Get graph-node inputs/outputs**

```bash
curl -s "https://api.smith.langchain.com/api/v1/runs/{NODE_RUN_ID}" \
  -H "x-api-key: $LANGSMITH_API_KEY" | python3 -c "
import json, sys
r = json.load(sys.stdin)
print('--- INPUTS ---')
print(json.dumps(r.get('inputs', {}), ensure_ascii=False, indent=2)[:5000])
print('\n--- OUTPUTS ---')
print(json.dumps(r.get('outputs', {}), ensure_ascii=False, indent=2)[:3000])
"
```
</phase>

<phase name="3_analysis">
**Phase 3: Produce analysis**

After collecting all data, produce a structured report.

**3a. Thread summary table**

| Run | Input (user message) | Decision / branch | Result | Status |
|-----|---------------------|-------------------|--------|--------|
| 1 (`...xxxx`) | "user said this" | which branch the graph took | "agent responded this" | success/fail |

**3b. State progression (for failing or surprising runs)**

Show how state variables changed at each checkpoint within the failing run. Build the node sequence from the checkpoints' `next`/`step` rather than assuming one — then, per step, list the key state changes:

| Step | Node | Key state changes |
|------|------|-------------------|
| -1 (input) | `__start__` | initial state from input |
| 0 | `<first node>` | which fields it set |
| … | … | … |

The single most common bug location in a routed/branched graph is the **first decision node picking the wrong branch** — the rest of the graph then executes the wrong path correctly. Always compare the user's intent with what the graph decided before suspecting downstream nodes.

**3c. LLM analysis (for failing runs)**

- What the LLM was prompted with (the key sections of the system prompt for the failing node).
- What the LLM returned (extracted classification, reasoning, or text).
- Whether that was correct against the user's intent, and what it should have been.

**3d. Code-path analysis**

- Which node processed the LLM output and how (parsed JSON, emitted text, etc.).
- How the state reducer interpreted the values (straight-set vs append vs custom merge).
- Where the logic failed — e.g. a branch didn't fire because a confidence/threshold check or a config value blocked it.

**3e. Root cause**

Identify the root cause(s), distinguishing between:
- **LLM decision errors** — a node misunderstood the input.
- **Prompt engineering issues** — the prompt didn't guide the LLM well enough. Note where the prompt actually lives: if it's loaded at runtime from an external source (blob store, DB, files) rather than read from source at request time, fixing it means editing that source and redeploying/re-seeding — not just editing a file in the repo.
- **Config issues** — a threshold, feature flag, or registry entry blocked the expected path.
- **Tool / retrieval gaps** — an external call returned nothing relevant (inspect that node's output payload and the query it actually sent).
- **Code logic errors** — a node mishandled the LLM output (rare; usually visible in the node's outputs payload).
- **State-management issues** — a reducer didn't apply as expected (e.g. a preserve-initial reducer keeping a stale value across turns, or an append reducer duplicating).
</phase>

</process>

<api_reference>
**LangGraph dev server endpoints:**
- `GET /threads/{thread_id}` — current thread state.
- `GET /threads/{thread_id}/runs` — list of runs.
- `POST /threads/{thread_id}/history` — checkpoint history (body: `{"limit": N}`).
- `GET /info` — server health (returns `{"flags":{...}}`).

**LangSmith API endpoints:**
- `GET /api/v1/sessions` — list projects.
- `POST /api/v1/runs/query` — query runs (body: `{"session": ["ID"], "limit": N}`).
- `GET /api/v1/runs/{run_id}` — detailed run with inputs/outputs.

**LangSmith query gotchas:**
- `session` must be an **array** of project IDs, not a single string.
- The thread ID may not be in run metadata — match by timestamps and trace IDs instead.
- LLM inputs are nested: `inputs.messages[].kwargs.content` (LangChain serialization).
- LLM outputs are in: `outputs.generations[0][0].text`.
</api_reference>

<anti_patterns>
<pitfall name="shallow_investigation">
Don't stop at the current thread state. The final state only shows the end result; the checkpoint history shows HOW you got there — intermediate states reveal where things diverged (especially which branch the first decision node picked).
</pitfall>

<pitfall name="ignoring_decision_signals">
Always inspect the decision/routing signals your graph writes at its branch points (classification, confidence, detected tool, extracted args). These are the primary explanation for unexpected behaviour — the rest of the graph just executes the branch that was chosen.
</pitfall>

<pitfall name="missing_the_prompt">
The LLM response is only half the story. Read the full system prompt to understand WHY the LLM decided as it did. If prompts are loaded from an external source at runtime (blob/DB/files), edit there and redeploy — editing the repo copy alone won't change runtime behaviour.
</pitfall>

<pitfall name="treating_history_500_as_skill_failure">
An HTTP 500 from `/history` is usually an app-side checkpoint-deserialization issue (often a custom message subclass), not a skill or query problem. Fall back to 1a + 1b + LangSmith and call it out. Re-running won't help.
</pitfall>

<pitfall name="only_checking_last_run">
If there are retry runs (the user re-sent a similar message), compare ALL failing runs. The graph may have decided differently each time, revealing whether the issue is deterministic or probabilistic.
</pitfall>

<pitfall name="assuming_a_fixed_state_schema">
Don't hardcode field names from one project. Read the thread `values` (and the graph's state definition) to learn which signals exist, then investigate those.
</pitfall>
</anti_patterns>

<success_criteria>
Investigation is complete when:

- All runs for the thread have been identified and summarized with the branch/decision each took.
- Full checkpoint history has been extracted showing state at every step (or the `/history` 500 has been called out and the fallback path used).
- LLM prompts and responses have been retrieved for the relevant LLM runs (when LangSmith is enabled).
- A state-progression table shows exactly where state diverged from expected.
- A root cause has been identified with a clear distinction between LLM error vs prompt issue vs config issue vs tool/retrieval gap vs code error vs state/reducer issue.
- The user has enough information to decide on a fix.
</success_criteria>
