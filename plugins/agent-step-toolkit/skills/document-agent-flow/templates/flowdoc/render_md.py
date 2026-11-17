"""Write the Markdown design document from the same spec that feeds the graph and the sheet.

Everything structural — the ladder, the route table, the open items, the counts — is generated,
so the prose cannot contradict the picture. Only the judgement lives in the spec as text: the
intro, the decisions and their why, the engine notes, the change list. The section checklist is
in references/design-guide.md; verify.py asserts every required heading is present.
"""

from __future__ import annotations

from pathlib import Path

from model import EDGE_FAIL, STATUS_LABELS, STATUSES, children_of

H_VOCAB = "Two words the whole ladder uses"
H_LADDER = "The ladder"
H_ENGINE = "How the ladder runs on agent-step"
H_DECISIONS = "The steps where a decision was made"
H_ROUTES = "Brief names vs real routes"
H_CHANGES = "What has to be built or changed, ordered by what it unblocks"
H_REVISIONS = "What changed since the previous draft"
H_OPEN = "Open items"
REQUIRED_HEADINGS = (H_VOCAB, H_LADDER, H_ENGINE, H_DECISIONS, H_ROUTES, H_CHANGES, H_OPEN)

NONE_YET = "None yet."
CHIP = "⚡ "
CHIP_JOIN = " → "
TITLE_COL_MAX = 34
CHILD_INDENT = "     "

VOCABULARY = (
    "- A **step** keeps gathering until a completeness check passes. On every turn it acknowledges "
    "what it received and lists what is still pending.\n"
    "- A **trigger** is a plain API call fired when a step completes. When a step has several, they run "
    "**in order**, and the first failure stops the chain and decides where the flow goes next.\n\n"
    "Two consequences follow. Human input between two backend calls forces a new step. Consecutive "
    "calls with nothing gathered between them stay together as one step's trigger chain, run by that "
    "step's single closing action."
)


def write_md(flow: dict, path: Path, files: dict[str, str]) -> None:
    path.write_text(render(flow, files), encoding="utf-8")


def render(flow: dict, files: dict[str, str]) -> str:
    sections = [
        (H_VOCAB, _vocab(flow)),
        (H_LADDER, _ladder(flow)),
        (H_ENGINE, _engine(flow)),
        (H_DECISIONS, _decisions(flow)),
        (H_ROUTES, _routes(flow)),
        (H_CHANGES, _changes(flow)),
    ]
    if flow["revisions"]:
        sections.append((H_REVISIONS, _numbered(flow["revisions"])))
    sections.append((H_OPEN, _open(flow)))
    body = [_header(flow, files), "---"]
    body += [f"## {i}. {title}\n\n{text}" for i, (title, text) in enumerate(sections, start=1)]
    return "\n\n".join(body).rstrip() + "\n"


def _header(flow: dict, files: dict[str, str]) -> str:
    meta = flow["meta"]
    parts = [f"# {meta['title']}"]
    if meta["intro"]:
        parts.append(meta["intro"])
    if meta["source_of_truth"]:
        parts.append(f"**Source of truth for the flow:** {meta['source_of_truth']}")
    engine = f"**Step engine:** agent-step {meta['engine_version']}"
    code = meta.get("code_engine_version")
    if code and code != meta["engine_version"]:
        engine += f" — the project's code vendors {code} today, so every step's `status_note` describes the {code} code"
    parts.append(engine + ".")
    rows = ["| File | What it holds |", "|---|---|"] + [f"| `{name}` | {what} |" for name, what in files.items()]
    parts.append("\n".join(rows))
    note = "The graph, the sheet and this document come from the same data, so they cannot disagree. Edit the spec, then rebuild"
    parts.append(note + (f": `{meta['rebuild']}`" if meta["rebuild"] else "."))
    return "\n\n".join(parts)


def _vocab(flow: dict) -> str:
    extra = flow["meta"].get("vocabulary_extra", "")
    return VOCABULARY + (f"\n\n{extra}" if extra else "")


def _ladder(flow: dict) -> str:
    steps, triggers = flow["steps"], flow["triggers"]
    rows = []
    last_stage = None
    for sid in flow["order"]:
        s = steps[sid]
        if s["parent"]:
            continue
        stage = s["stage"] if s["stage"] != last_stage else ""
        last_stage = s["stage"]
        rows.append((stage, sid, _fit(s), _chain(s, triggers), _targets(s)))
        for kid in children_of(flow, sid):
            k = steps[kid]
            rows.append(("", CHILD_INDENT + kid, _fit(k), _chain(k, triggers), _targets(k)))
    title_w = min(TITLE_COL_MAX, max(len(r[2]) for r in rows))
    id_w = max(len(r[1]) for r in rows)
    chain_w = max(len(r[3]) for r in rows)
    lines = [f"{r[0]:<2} {r[1]:<{id_w}}  {r[2]:<{title_w}}  {r[3]:<{chain_w}}  → {r[4]}".rstrip() for r in rows]
    exits = [str(x).rstrip(" .;") for x in flow["meta"].get("global_exits", [])]
    anywhere = ("\n\nFrom any step:\n" + "\n".join(f"- {x}" for x in exits)) if exits else ""
    return "```\n" + "\n".join(lines) + "\n```" + anywhere + "\n\n" + _totals(flow)


def _fit(step: dict) -> str:
    """The step's name for the ladder column: the short box label if any, cut visibly if still long."""
    name = step["label"] or step["title"]
    return name if len(name) <= TITLE_COL_MAX else name[: TITLE_COL_MAX - 1].rstrip() + "…"


def _chain(step: dict, triggers: dict) -> str:
    """One arrow chain when the whole chain rides one outcome; otherwise each outcome's chips with
    where they lead, so a reader never takes two alternatives for a sequence."""
    run = lambda ids: CHIP_JOIN.join(CHIP + triggers[t]["short"] for t in ids)
    split = [o for o in step["next"] if o.get("triggers")]
    if any("triggers" in o for o in step["next"]) and len(split) > 1:
        return " | ".join(f"{run(o['triggers'])} (→ {o['to']})" for o in split)
    return run(step["triggers"])


def _targets(step: dict) -> str:
    seen = []
    for o in step["next"]:
        if o["kind"] != EDGE_FAIL and o["to"] not in seen:
            seen.append(o["to"])
    return " | ".join(seen) or "(failure outcomes only)"


def _totals(flow: dict) -> str:
    steps, trigs = flow["steps"].values(), flow["triggers"].values()
    top = sum(1 for s in steps if not s["parent"])
    kids = len(flow["steps"]) - top
    text = f"In total: {top} ladder steps" + (f", {kids} sub-steps" if kids else "") + f" and {len(flow['triggers'])} triggers."
    text += "\n\n| Status | Steps | Triggers |\n|---|---|---|\n"
    text += "\n".join(f"| {STATUS_LABELS[st]} | {sum(1 for s in steps if s['status'] == st)} | "
                      f"{sum(1 for t in trigs if t['status'] == st)} |" for st in STATUSES)
    text += "\n\nThe xlsx has every row in full. The sections below cover only the places where a decision was needed."
    return text


def _engine(flow: dict) -> str:
    notes = flow["engine_notes"]
    parts = []
    if notes.get("intro"):
        parts.append(notes["intro"])
    if notes["concepts"]:
        rows = ["| Ladder concept | agent-step primitive |", "|---|---|"]
        rows += [f"| {_cell(c)} | {_cell(p)} |" for c, p in notes["concepts"]]
        parts.append("\n".join(rows))
    if notes["facts"]:
        parts.append("Facts that drove this design:\n\n" + _numbered(notes["facts"]))
    return "\n\n".join(parts) or NONE_YET


def _decisions(flow: dict) -> str:
    if not flow["decisions"]:
        return NONE_YET
    blocks = []
    for d in flow["decisions"]:
        head = f"**{d['title']}.**" if d.get("title") else f"**{d['step']}.**"
        blocks.append(head + "\n" + "\n".join(f"- {p}" for p in d.get("points", [])))
    return "\n\n".join(blocks)


def _routes(flow: dict) -> str:
    rows = [(t["spec"], t["real"]) for t in flow["triggers"].values() if t["spec"]]
    parts = []
    if rows:
        parts.append("\n".join(["| In the brief | Real |", "|---|---|"]
                               + [f"| {_brief_name(b)} | {_cell(r)} |" for b, r in rows]))
    else:
        parts.append("No brief or spec names to reconcile: every trigger is named by its real route.")
    notes = [(r.get("name") or r.get("brief", ""), r["real"]) for r in flow["route_notes"]]
    if notes:
        parts.append("Other routes worth knowing:\n\n" + "\n".join(["| Name | Route |", "|---|---|"]
                     + [f"| {_cell(n)} | {_cell(r)} |" for n, r in notes]))
    return "\n\n".join(parts)


def _changes(flow: dict) -> str:
    if not flow["changes"]:
        return NONE_YET
    items = []
    for i, c in enumerate(flow["changes"], start=1):
        line = f"{i}. **{c['what']}**"
        if c.get("unblocks"):
            line += f" Unblocks: {c['unblocks']}."
        items.append(line + "".join(f"\n   - {d}" for d in c.get("detail", [])))
    return "\n".join(items)


def _open(flow: dict) -> str:
    if not flow["open"]:
        return NONE_YET
    head = "These are listed in the **Open & TBD** sheet, each with the default used until it is decided:\n\n"
    return head + "\n".join(f"- **{o['id']}** ({o['where']}): {o['question']} *Default:* {o['default']}" for o in flow["open"])


ROUTE_HINTS = ("/", "GET ", "POST ", "PUT ", "PATCH ", "DELETE ")


def _brief_name(name: str) -> str:
    """A brief may name a route (shown as code) or only a capability (shown as words)."""
    text = _cell(name)
    return f"`{text}`" if any(h in text for h in ROUTE_HINTS) else text


def _numbered(items: list[str]) -> str:
    return "\n".join(f"{i}. {x}" for i, x in enumerate(items, start=1))


def _cell(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")
