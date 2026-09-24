"""Load a flow spec, fill its defaults, and validate it before anything is rendered.

A flow spec is ONE data source (a Python module exposing ``FLOW``, or a JSON file of the same
shape) from which the Markdown design, the interactive graph and the step sheet are all built.
Because every output reads the same normalized dict, the three cannot drift apart — the failure
that makes hand-maintained flow documentation go stale. The schema is documented in
``references/data-model.md``; this module is its executable form.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import re
import sys
from pathlib import Path

EXISTS, CHANGE, NEW, TBD = "exists", "change", "new", "tbd"
STATUSES = (EXISTS, CHANGE, NEW, TBD)
STATUS_LABELS = {EXISTS: "exists", CHANGE: "needs change", NEW: "new", TBD: "TBD"}

EDGE_MAIN, EDGE_BRANCH, EDGE_FAIL, EDGE_OPT = "main", "branch", "fail", "opt"
EDGE_KINDS = (EDGE_MAIN, EDGE_BRANCH, EDGE_FAIL, EDGE_OPT)

TONE_GOOD, TONE_BAD = "good", "bad"
TONES = (TONE_GOOD, TONE_BAD)

SPEC_VARIABLE = "FLOW"  # the name a Python spec module must bind
REQUIRED_META = ("slug", "title", "subtitle", "engine_version")
# "3.0.1" — the version a step-engine expression is written against; also "code_engine_version".
VERSION_PATTERN = r"^\d+\.\d+\.\d+$"
REQUIRED_STEP = ("stage", "title", "completion", "next", "engine", "status")
REQUIRED_TRIGGER = ("name", "short", "real", "on_ok", "status")
REQUIRED_OPEN = ("id", "question", "where", "default")
REQUIRED_SHEET = ("id", "title", "columns", "rows")
STEP_LIST_FIELDS = ("required", "optional", "prefilled", "triggers", "lookups", "open")
SLUG_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-")
EXCEL_TITLE_MAX = 31                       # Excel's own sheet-name limits
EXCEL_TITLE_FORBIDDEN = set("[]:*?/\\")
RESERVED_SHEETS = {"Steps", "Triggers & APIs", "Open & TBD"}

# Primitives agent-step removed or renamed (library CHANGELOG, 2.0.0 and 3.0.0 "Breaking"). An
# `engine` expression describes how the step WILL run, on the current library, so naming one of
# these is a documentation bug. The value says what to write instead.
# Keys are regexes: word-bounded so DeclaredExecutorResult (current) does not trip ExecutorResult.
RETIRED_ENGINE_TERMS = {
    r"(?<![A-Za-z])ExecutorResult\b": "a declared verdict row (ActionDef.verdicts) that the executor names",
    r"\bresultBody\b": "a verdict row's body",
    r"\b[Bb]oundedChoice": "an escalation ladder or verdict rows (bounded choices were removed in 3.0.0)",
    r"\bdeflect_?[Aa]side\b": "an escalation ladder via note_refusal",
    r"\bforcedHandoff": "an escalation ladder's onExhaust, or a request_handoff effect",
    r"\bguardTurn\b": "a verdict row or an escalation ladder (the guard latch was removed in 3.0.0)",
    r"\brepeat_pending_confirmation\b": "repeat_pending_question",
    r"\bttlMs\b": "nothing — pending gates do not expire by time (removed in 2.0.0)",
    r"\bstateAnnotation\b": "the Zod state schema (removed in 2.0.0)",
    # Never shipped by the toolkit (some projects patched it into a vendored copy): in 3.x a read is simply an
    # action with no gate, and a pending gate admits only its target / abort / handoff / repeat.
    r"\breadOnly\b": "a plain action with no gate (agent-step has no read-only flag)",
}


class SpecError(ValueError):
    """The spec is structurally wrong. Carries every problem found, not just the first."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("flow spec invalid:\n  " + "\n  ".join(problems))


def load_spec(path: str | Path) -> dict:
    """Read a ``.py`` (binding ``FLOW``) or ``.json`` spec and return a normalized, validated copy."""
    path = Path(path)
    if not path.is_file():
        raise SpecError([f"spec file not found: {path}"])
    raw = _read_python_spec(path) if path.suffix == ".py" else _read_json_spec(path)
    flow = normalize(raw)
    validate(flow)
    return flow


def _read_python_spec(path: Path) -> dict:
    # Import by file location so a spec can live anywhere and import its own sibling modules
    # (field or document inventories kept in separate files) through normal relative imports.
    spec = importlib.util.spec_from_file_location(f"flowspec_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise SpecError([f"cannot import spec module {path}"])
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(path.parent))
    if not hasattr(module, SPEC_VARIABLE):
        raise SpecError([f"{path} does not define {SPEC_VARIABLE}"])
    return getattr(module, SPEC_VARIABLE)


def _read_json_spec(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SpecError([f"{path}: invalid JSON — {exc}"]) from exc


def normalize(raw: dict) -> dict:
    """Return a deep copy with every optional field present, so renderers never branch on absence."""
    flow = copy.deepcopy(raw)
    flow.setdefault("meta", {})
    for key in ("stages", "open", "decisions", "changes", "revisions", "sheets", "route_notes"):
        flow.setdefault(key, [])
    for key in ("steps", "triggers", "terminals"):
        flow.setdefault(key, {})
    flow.setdefault("engine_notes", {})
    flow["engine_notes"].setdefault("concepts", [])
    flow["engine_notes"].setdefault("facts", [])
    meta = flow["meta"]
    meta.setdefault("branch_label", "alternative branch")
    meta.setdefault("intro", "")
    meta.setdefault("source_of_truth", "")
    meta.setdefault("rebuild", "")
    flow.setdefault("order", list(flow["steps"]))
    for sid, step in flow["steps"].items():
        _normalize_step(sid, step)
    for tid, trig in flow["triggers"].items():
        trig["id"] = tid
        trig.setdefault("spec", "")
        trig.setdefault("evidence", "")
        trig.setdefault("on_fail", [])
        trig.setdefault("retry", "")
        trig.setdefault("step", _first_step_firing(flow["steps"], tid))
    for tid, term in flow["terminals"].items():
        term["id"] = tid
        term.setdefault("tone", TONE_GOOD)
    return flow


def _normalize_step(sid: str, step: dict) -> None:
    step["id"] = sid
    for key in STEP_LIST_FIELDS:
        step.setdefault(key, [])
    for key in ("opens", "status_note", "parent", "label", "sub"):
        step.setdefault(key, "")
    step.setdefault("optional_step", False)
    step.setdefault("cross_cutting", False)
    for outcome in step.get("next", []):
        outcome.setdefault("kind", EDGE_FAIL if outcome.get("fail") else EDGE_MAIN)
        outcome["fail"] = outcome["kind"] == EDGE_FAIL
        outcome.setdefault("label", "")


def _first_step_firing(steps: dict, tid: str) -> str:
    firing = [sid for sid, s in steps.items() if tid in s.get("triggers", [])]
    return ", ".join(firing)


def validate(flow: dict) -> None:
    """Raise SpecError listing EVERY dangling reference or bad value; silence means the spec is sound."""
    problems: list[str] = []
    problems += _check_meta(flow["meta"])
    problems += _check_required_keys(flow)
    problems += _check_references(flow)
    problems += _check_order(flow)
    problems += _check_containers(flow)
    problems += _check_sheets(flow["sheets"])
    problems += _check_engine_terms(flow["steps"])
    if problems:
        raise SpecError(problems)


def _check_meta(meta: dict) -> list[str]:
    problems = [f"meta: missing {k!r}" for k in REQUIRED_META if not meta.get(k)]
    slug = meta.get("slug", "")
    if slug and not set(slug) <= SLUG_CHARS:
        problems.append(f"meta.slug {slug!r}: use lowercase letters, digits and '-' only (it names the files)")
    for key in ("engine_version", "code_engine_version"):
        value = meta.get(key)
        if value and not re.match(VERSION_PATTERN, str(value)):
            problems.append(f"meta.{key} {value!r}: write the agent-step version as X.Y.Z (read it from a VERSION file)")
    return problems


def _check_required_keys(flow: dict) -> list[str]:
    problems = []
    for sid, step in flow["steps"].items():
        problems += [f"step {sid}: missing {k!r}" for k in REQUIRED_STEP if k not in step or step[k] in ("", None)]
        if step.get("status") not in STATUSES:
            problems.append(f"step {sid}: bad status {step.get('status')!r} (use one of {', '.join(STATUSES)})")
        for outcome in step.get("next", []):
            if outcome.get("kind") not in EDGE_KINDS:
                problems.append(f"step {sid}: outcome → {outcome.get('to')} has bad kind {outcome.get('kind')!r}")
            if not outcome.get("to") or not outcome.get("when"):
                problems.append(f"step {sid}: every outcome needs 'to' and 'when'")
    for tid, trig in flow["triggers"].items():
        problems += [f"trigger {tid}: missing {k!r}" for k in REQUIRED_TRIGGER if not trig.get(k)]
        if trig.get("status") not in STATUSES:
            problems.append(f"trigger {tid}: bad status {trig.get('status')!r}")
        if trig.get("status") in (EXISTS, CHANGE) and not trig.get("evidence"):
            # A route claimed to exist must say where it was seen; otherwise it is a TBD.
            problems.append(f"trigger {tid}: status {trig['status']!r} needs 'evidence' (file:line) — or mark it tbd")
    for item in flow["open"]:
        problems += [f"open item {item.get('id', '?')}: missing {k!r}" for k in REQUIRED_OPEN if not item.get(k)]
    for tid, term in flow["terminals"].items():
        if not term.get("label"):
            problems.append(f"terminal {tid}: missing 'label'")
        if term.get("tone") not in TONES:
            problems.append(f"terminal {tid}: bad tone {term.get('tone')!r}")
    return problems


def _check_references(flow: dict) -> list[str]:
    steps, triggers, terminals = flow["steps"], flow["triggers"], flow["terminals"]
    stage_ids = {s["id"] for s in flow["stages"]}
    open_ids = {o.get("id") for o in flow["open"]}
    nodes = set(steps) | set(terminals)
    problems = [f"step id {t!r} is also a terminal id" for t in set(steps) & set(terminals)]
    for sid, step in steps.items():
        if step.get("stage") not in stage_ids:
            problems.append(f"step {sid}: unknown stage {step.get('stage')!r}")
        problems += [f"step {sid}: unknown trigger {t}" for t in step["triggers"] if t not in triggers]
        problems += [f"step {sid}: unknown open item {q}" for q in step["open"] if q not in open_ids]
        for outcome in step.get("next", []):
            if outcome.get("to") not in nodes:
                problems.append(f"step {sid}: outcome → unknown node {outcome.get('to')!r}")
            problems += [f"step {sid}: outcome → {outcome.get('to')} names unknown trigger {t}"
                         for t in outcome.get("triggers", []) if t not in step["triggers"]]
    for sid, step in steps.items():
        # When a step says which outcome carries which chips, every trigger must ride SOME outcome —
        # otherwise it silently disappears from the graph while the sheet still lists it.
        if any("triggers" in o for o in step.get("next", [])):
            carried = {t for o in step["next"] for t in o.get("triggers", [])}
            problems += [f"step {sid}: trigger {t} rides no outcome — add it to the outcome its chain leads along"
                         for t in step["triggers"] if t not in carried]
    fired = {t for s in steps.values() for t in s["triggers"]}
    problems += [f"trigger {t}: no step fires it" for t in triggers if t not in fired]
    for dec in flow["decisions"]:
        if dec.get("step") and dec["step"] not in steps:
            problems.append(f"decision {dec.get('title', '?')!r}: unknown step {dec['step']}")
    return problems


def _check_order(flow: dict) -> list[str]:
    steps, order = flow["steps"], flow["order"]
    problems = []
    if set(order) != set(steps) or len(order) != len(steps):
        problems.append(f"order/steps mismatch: {sorted(set(order) ^ set(steps))} (or duplicates in order)")
        return problems
    # Stage bands are drawn as contiguous blocks, so the order must visit each stage once.
    stage_rank = {s["id"]: i for i, s in enumerate(flow["stages"])}
    ranks = [stage_rank.get(steps[sid]["stage"], -1) for sid in order]
    if ranks != sorted(ranks):
        problems.append("order must group steps by stage, in the stages' order (the bands are contiguous)")
    return problems


def _check_containers(flow: dict) -> list[str]:
    steps = flow["steps"]
    problems = []
    for sid, step in steps.items():
        parent = step["parent"]
        if not parent:
            continue
        if parent not in steps:
            problems.append(f"step {sid}: unknown parent {parent!r}")
        elif steps[parent]["parent"]:
            problems.append(f"step {sid}: containers nest one level only ({parent} is itself a child)")
        elif steps[parent]["stage"] != step["stage"]:
            problems.append(f"step {sid}: a child must share its container's stage")
    return problems


def _check_sheets(sheets: list[dict]) -> list[str]:
    problems = []
    seen = set()
    for sheet in sheets:
        problems += [f"sheet {sheet.get('id', '?')}: missing {k!r}" for k in REQUIRED_SHEET if k not in sheet]
        title = str(sheet.get("title", ""))
        if len(title) > EXCEL_TITLE_MAX or set(title) & EXCEL_TITLE_FORBIDDEN or title in RESERVED_SHEETS:
            problems.append(f"sheet {sheet.get('id')}: title {title!r} must be ≤{EXCEL_TITLE_MAX} chars, without "
                            f"{''.join(sorted(EXCEL_TITLE_FORBIDDEN))}, and not one of {sorted(RESERVED_SHEETS)}")
        if sheet.get("id") in seen:
            problems.append(f"sheet id {sheet['id']!r} used twice")
        seen.add(sheet.get("id"))
        width = len(sheet.get("columns", []))
        for i, row in enumerate(sheet.get("rows", [])):
            if len(row) != width:
                problems.append(f"sheet {sheet.get('id')}: row {i + 1} has {len(row)} cells, header has {width}")
    return problems


def _check_engine_terms(steps: dict) -> list[str]:
    problems = []
    for sid, step in steps.items():
        text = str(step.get("engine", ""))
        for pattern, instead in RETIRED_ENGINE_TERMS.items():
            hit = re.search(pattern, text)
            if hit:
                problems.append(f"step {sid}: engine names {hit.group(0)!r}, which the current agent-step does not have — use {instead}")
    return problems


def children_of(flow: dict, parent: str) -> list[str]:
    """Child steps of a container, in ladder order."""
    return [sid for sid in flow["order"] if flow["steps"][sid]["parent"] == parent]


def edges_of(flow: dict) -> list[dict]:
    """Every drawable outcome as an edge, with the trigger chips each one carries.

    Trigger placement rule: if any outcome of a step names its own ``triggers``, those names are
    used as given (a step whose branches fire different chains). Otherwise the whole chain rides
    on the step's first non-failure outcome — the path the chain actually leads to.
    """
    edges = []
    for sid in flow["order"]:
        step = flow["steps"][sid]
        explicit = any("triggers" in o for o in step["next"])
        first_ok = next((o for o in step["next"] if o["kind"] != EDGE_FAIL), None)
        for outcome in step["next"]:
            chips = outcome.get("triggers", []) if explicit else (step["triggers"] if outcome is first_ok else [])
            edges.append({
                "from": sid, "to": outcome["to"], "kind": outcome["kind"],
                "label": outcome["label"], "when": outcome["when"], "triggers": list(chips),
            })
    return edges
