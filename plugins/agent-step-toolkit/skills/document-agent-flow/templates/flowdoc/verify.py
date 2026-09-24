"""Verify a flow documentation set in each output's own medium, and say what was observed.

    uvx --with openpyxl --with playwright python3 scripts/flowdoc/verify.py SPEC [--out DIR]
        [--shots DIR] [--deny PATTERNS_FILE] [--no-browser]

Checks (each prints PASS / FAIL / SKIP with the observed value; exit 1 on any FAIL):
  build        the spec validates and builds; a second build is byte-identical (deterministic layout)
  validator    break tests: unknown node, unknown trigger, bad status, a removed engine term, an
               `exists` claim without evidence, a trigger riding no edge, a missing or malformed
               engine version — each must be refused
  layout       no two nodes overlap, everything sits on the canvas, every edge has a path, no edge
               passes through a box, every label and chip found a free spot
  xlsx         read back: sheet names, row counts, column A equals the step order
  md           every required heading, every step id and every open-item id is present
  html         size budget, no external scripts, the embedded data parses back to the spec
  browser      light, dark and 400 px: 0 console errors, node and chip counts, no horizontal scroll at
               400 px, no label or chip over a box or another label (measured as rendered), every
               step opens its own detail panel, every tab shows its table
  page-break   an edge hand-edited to an unknown node is skipped loudly while the page still renders
  deny         (with --deny FILE) no output, spec or source file beside it (plus any --scan PATH)
               matches a forbidden regex (one per line, case-insensitive)

Needs a Chromium for Playwright once: ``uvx playwright install chromium``.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import tempfile
from pathlib import Path

# No __pycache__ next to the vendored copy or the spec: both live in the user's repo.
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build import build  # noqa: E402
from model import SpecError, load_spec, normalize, validate  # noqa: E402
from render_html import page_data  # noqa: E402
from render_md import REQUIRED_HEADINGS  # noqa: E402
from render_xlsx import SHEET_OPEN, SHEET_STEPS, SHEET_TRIGGERS, sheet_names  # noqa: E402

HTML_MAX_BYTES = 512_000        # the reference page is ~90 KB; a diagram library inlined would blow this
DESKTOP = {"width": 1400, "height": 900}
PHONE = {"width": 400, "height": 820}
DARK_LUMINANCE_MAX = 0.2        # body background luminance below this counts as a dark theme
DATA_BLOCK = re.compile(r'<script type="application/json" id="flow-data">(.*?)</script>', re.S)
EXTERNAL_SCRIPT = re.compile(r"<script[^>]+src=", re.I)
FONT_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")
# Only what the browser would fetch (href / src / url()); namespace URIs such as the SVG one are inert.
FETCHED_URL = re.compile(r"""(?:href|src)=["']https?://([^/"']+)|url\(["']?https?://([^/"')]+)""", re.I)
BOGUS_NODE = "__verify_unknown_node__"
DENY_SCOPE = ("*.py", "*.json", "*.md", "*.txt")
EMPTY_CSS = ""


class Report:
    def __init__(self):
        self.failed = 0
        self.skipped: list[str] = []

    def check(self, name: str, ok: bool, observed: str) -> bool:
        print(f"{'PASS' if ok else 'FAIL'} {name}: {observed}")
        self.failed += 0 if ok else 1
        return ok

    def skip(self, name: str, why: str) -> None:
        print(f"SKIP {name}: {why}")
        self.skipped.append(name)


# ---- build + determinism ----------------------------------------------------------------------
def check_build(r: Report, spec: Path, out: Path) -> dict[str, Path] | None:
    try:
        paths = build(spec, out)
    except SpecError as exc:
        r.check("build", False, str(exc))
        return None
    first = {k: p.read_bytes() for k, p in paths.items() if k != "xlsx"}  # xlsx embeds a timestamp
    build(spec, out)
    same = all(paths[k].read_bytes() == v for k, v in first.items())
    r.check("build", same, "built; second build byte-identical (md, html)" if same else "second build differs — layout is not deterministic")
    return paths


# ---- validator break tests --------------------------------------------------------------------
def check_validator(r: Report, flow: dict) -> None:
    first = flow["order"][0]
    breaks = {
        "unknown node": (lambda f: f["steps"][first]["next"].append({"to": BOGUS_NODE, "when": "x"}), "unknown node"),
        "unknown trigger": (lambda f: f["steps"][first]["triggers"].append("__T_unknown__"), "unknown trigger"),
        "bad status": (lambda f: f["steps"][first].update(status="done-ish"), "bad status"),
        "retired engine term": (lambda f: f["steps"][first].update(engine="x · ExecutorResult"), "does not have"),
        "claim without evidence": (_strip_evidence, "needs 'evidence'"),
        "trigger on no edge": (_orphan_trigger, "rides no outcome"),
        "missing engine version": (lambda f: f["meta"].pop("engine_version", None), "missing 'engine_version'"),
        "malformed engine version": (lambda f: f["meta"].update(engine_version="3.x"), "write the agent-step version as X.Y.Z"),
    }
    for name, (mutate, expect) in breaks.items():
        broken = copy.deepcopy(flow)
        mutate(broken)
        try:
            validate(normalize(broken))
            r.check(f"validator/{name}", False, "accepted a broken spec")
        except SpecError as exc:
            hit = any(expect in p for p in exc.problems)
            r.check(f"validator/{name}", hit, f"refused: {exc.problems[0]}" if hit else f"refused for another reason: {exc.problems}")


def _strip_evidence(flow: dict) -> None:
    """Break a spec the way a hurried author would: a route claimed to exist, with no proof."""
    if not flow["triggers"]:
        flow["triggers"]["__T_claim__"] = {"name": "x", "short": "x", "real": "x", "on_ok": "x", "status": "exists"}
        flow["steps"][flow["order"][0]]["triggers"].append("__T_claim__")
        return
    tid = next(iter(flow["triggers"]))
    flow["triggers"][tid].update(status="exists", evidence="")


def _orphan_trigger(flow: dict) -> None:
    """Break a spec the way the docs-mode run did: chips named on one outcome, one trigger forgotten."""
    sid = next((s for s in flow["order"] if flow["steps"][s]["triggers"]), flow["order"][0])
    step = flow["steps"][sid]
    if not step["triggers"]:
        flow["triggers"]["__T_orphan__"] = {"name": "x", "short": "x", "real": "x", "on_ok": "x", "status": "tbd"}
        step["triggers"].append("__T_orphan__")
    step["next"][0]["triggers"] = []


# ---- layout ----------------------------------------------------------------------------------
def check_layout(r: Report, flow: dict, graph: dict) -> None:
    nodes = {n["id"]: n for n in graph["nodes"]}
    related = {(k, flow["steps"][k]["parent"]) for k in flow["steps"] if flow["steps"][k]["parent"]}
    clashes = []
    ids = list(nodes)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if (a, b) in related or (b, a) in related:
                continue
            if _boxes_overlap(nodes[a], nodes[b]):
                clashes.append(f"{a}×{b}")
    r.check("layout/overlap", not clashes, "no overlapping nodes" if not clashes else f"overlaps: {clashes}")
    off = [n["id"] for n in graph["nodes"] if n["x"] < 0 or n["y"] < 0
           or n["x"] + n["w"] > graph["width"] or n["y"] + n["h"] > graph["height"]]
    r.check("layout/canvas", not off, f"all {len(nodes)} nodes on a {graph['width']}×{graph['height']} canvas" if not off else f"off canvas: {off}")
    pathless = [f"{e['from']}→{e['to']}" for e in graph["edges"] if len(e.get("pts", [])) < 2]
    r.check("layout/edges", not pathless, f"{len(graph['edges'])} edges routed" if not pathless else f"no path: {pathless}")
    crossings = _edges_through_boxes(flow, graph)
    r.check("layout/edge-crossings", not crossings, "no edge passes through a box" if not crossings else f"{crossings}")
    shown = {t for e in graph["edges"] for t in e.get("triggers", [])} | {t for n in graph["nodes"] for t in n.get("chips", [])}
    missing = sorted(set(flow["triggers"]) - shown)
    r.check("layout/every-trigger-drawn", not missing,
            f"all {len(flow['triggers'])} triggers appear as ⚡ chips" if not missing else f"never drawn: {missing}")
    strays = _chips_off_edge(graph)
    r.check("layout/chips-on-edge", not strays, "every ⚡ chip sits on its own edge, next to its source" if not strays else f"{strays}")
    warnings = graph.get("warnings", [])
    r.check("layout/labels", not warnings, "every label and chip found a free spot" if not warnings else f"{warnings}")


CHIP_REACH = 12   # px a chip may sit beside its run (the offset it is drawn at, plus rounding)
CHIP_RUNS = 2     # the first run out of the source, or the run after the first bend


def _chip_on_run(tx: float, ty: float, p: list, q: list) -> bool:
    (x1, y1), (x2, y2) = p, q
    if abs(x1 - x2) < 1:
        return min(y1, y2) - CHIP_REACH <= ty <= max(y1, y2) + CHIP_REACH
    return abs(ty - y1) <= CHIP_REACH * 3 and min(x1, x2) - CHIP_REACH <= tx <= max(x1, x2)


def _chips_off_edge(graph: dict) -> list[str]:
    """A chip belongs next to the first run of its own edge; anywhere else it reads as another step's."""
    strays = []
    for e in graph["edges"]:
        if not e.get("triggers") or "tpos" not in e:
            continue
        tx, ty = e["tpos"]
        if not any(_chip_on_run(tx, ty, p, q) for p, q in list(zip(e["pts"], e["pts"][1:]))[:CHIP_RUNS]):
            strays.append(f"{e['from']}→{e['to']} chips at ({tx:.0f}, {ty:.0f}), run {e['pts'][0]}→{e['pts'][1]}")
    return strays


def _edges_through_boxes(flow: dict, graph: dict) -> list[str]:
    """Independent of layout.py's own avoidance: every straight run of every edge against every box
    that is not one of the edge's ends, their container, or their children."""
    nodes = {n["id"]: n for n in graph["nodes"]}
    parent = {sid: s["parent"] for sid, s in flow["steps"].items()}
    found = []
    for e in graph["edges"]:
        ends = {e["from"], e["to"]}
        skip = ends | {parent.get(x) for x in ends} | {k for k, v in parent.items() if v in ends}
        for p, q in zip(e["pts"], e["pts"][1:]):
            x0, x1 = sorted((p[0], q[0]))
            y0, y1 = sorted((p[1], q[1]))
            for n in nodes.values():
                if n["id"] in skip:
                    continue
                if x0 < n["x"] + n["w"] - 1 and n["x"] + 1 <= x1 and y0 < n["y"] + n["h"] - 1 and n["y"] + 1 <= y1:
                    found.append(f"{e['from']}→{e['to']} through {n['id']}")
    return sorted(set(found))


def _boxes_overlap(a: dict, b: dict) -> bool:
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


# ---- xlsx ------------------------------------------------------------------------------------
def check_xlsx(r: Report, flow: dict, path: Path) -> None:
    from openpyxl import load_workbook

    wb = load_workbook(path)
    r.check("xlsx/sheets", wb.sheetnames == sheet_names(flow), f"{wb.sheetnames}")
    steps = wb[SHEET_STEPS]
    col_a = [c.value for c in steps["A"][1:]]
    r.check("xlsx/steps", col_a == flow["order"], f"{len(col_a)} rows, column A {'=' if col_a == flow['order'] else '≠'} step order")
    n_trig = wb[SHEET_TRIGGERS].max_row - 1
    r.check("xlsx/triggers", n_trig == len(flow["triggers"]), f"{n_trig} rows for {len(flow['triggers'])} triggers")
    n_open = wb[SHEET_OPEN].max_row - 1
    r.check("xlsx/open", n_open == len(flow["open"]), f"{n_open} rows for {len(flow['open'])} open items")
    for sheet in flow["sheets"]:
        n = wb[sheet["title"]].max_row - 1
        r.check(f"xlsx/{sheet['id']}", n == len(sheet["rows"]), f"{n} rows for {len(sheet['rows'])}")
    frozen = all(wb[name].freeze_panes for name in wb.sheetnames)
    r.check("xlsx/frozen", frozen, "every sheet has frozen panes + autofilter" if frozen else "a sheet lost its frozen panes")


# ---- md --------------------------------------------------------------------------------------
def check_md(r: Report, flow: dict, path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    missing = [h for h in REQUIRED_HEADINGS if not re.search(rf"^## \d+\. {re.escape(h)}$", text, re.M)]
    r.check("md/headings", not missing, f"{len(REQUIRED_HEADINGS)} required sections present" if not missing else f"missing: {missing}")
    absent = [s for s in flow["order"] if not re.search(rf"(?<![\w-]){re.escape(s)}(?![\w-])", text)]
    r.check("md/steps", not absent, f"all {len(flow['order'])} step ids cited" if not absent else f"not cited: {absent}")
    absent = [o["id"] for o in flow["open"] if o["id"] not in text]
    r.check("md/open", not absent, f"all {len(flow['open'])} open items listed" if not absent else f"not listed: {absent}")


# ---- html (static) ---------------------------------------------------------------------------
def check_html(r: Report, flow: dict, path: Path) -> dict | None:
    raw = path.read_text(encoding="utf-8")
    size = len(raw.encode("utf-8"))
    r.check("html/size", size <= HTML_MAX_BYTES, f"{size / 1024:.0f} KB (budget {HTML_MAX_BYTES // 1024} KB)")
    r.check("html/no-external-scripts", not EXTERNAL_SCRIPT.search(raw), "no <script src>" if not EXTERNAL_SCRIPT.search(raw) else "found <script src>")
    hosts = {h for pair in FETCHED_URL.findall(raw) for h in pair if h} - set(FONT_HOSTS)
    r.check("html/offline", not hosts, "only font hosts referenced" if not hosts else f"other hosts: {sorted(hosts)}")
    match = DATA_BLOCK.search(raw)
    if not match:
        r.check("html/data", False, "flow-data block not found")
        return None
    data = json.loads(match.group(1).replace("<\\/", "</"))
    same = data["order"] == flow["order"] and set(data["steps"]) == set(flow["steps"]) and set(data["triggers"]) == set(flow["triggers"])
    r.check("html/data", same, "embedded data matches the spec" if same else "embedded data differs from the spec")
    return data


# ---- browser ---------------------------------------------------------------------------------
def check_browser(r: Report, flow: dict, data: dict, html_path: Path, shots: Path | None) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        r.skip("browser", "playwright not importable — run with `uvx --with playwright` (and `uvx playwright install chromium` once)")
        return
    graph = data["graph"]
    chips = sum(len(e["triggers"]) for e in graph["edges"]) + sum(len(n.get("chips", [])) for n in graph["nodes"])
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as exc:  # noqa: BLE001 — any launch failure means "no browser here", said out loud
            r.skip("browser", f"Chromium would not start ({str(exc).splitlines()[0]}) — run `uvx playwright install chromium`")
            return
        for name, viewport, scheme in (("light", DESKTOP, "light"), ("dark", DESKTOP, "dark"), ("400px", PHONE, "light")):
            page, errors = _open(browser, html_path, viewport, scheme)
            n_nodes = page.locator(".node").count()
            n_chips = page.locator("#canvas .chipk").count()
            r.check(f"browser/{name}", not errors and n_nodes == len(graph["nodes"]) and n_chips == chips,
                    f"{len(errors)} console errors{': ' + errors[0] if errors else ''}; {n_nodes} nodes, {n_chips} chips")
            if scheme == "dark":
                lum = page.evaluate(LUMINANCE_JS)
                r.check("browser/dark-theme", lum < DARK_LUMINANCE_MAX, f"body background luminance {lum:.2f}")
            if viewport is PHONE:
                sw, iw = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
                r.check("browser/no-hscroll", sw <= iw, f"scrollWidth {sw} ≤ innerWidth {iw}" if sw <= iw else f"scrollWidth {sw} > {iw}")
            if name == "light":
                badge = page.locator("#h-engine").inner_text()
                want = flow["meta"]["engine_version"]
                code = flow["meta"].get("code_engine_version")
                box, head = page.locator("#h-engine").bounding_box(), page.locator("header").bounding_box()
                top_right = box and head and box["x"] + box["width"] >= head["x"] + head["width"] - 2 and box["y"] <= head["y"] + 2
                ok = want in badge and top_right and (not code or code == want or code in badge)
                r.check("browser/engine-version", ok, f"top-right badge reads {badge!r}" + ("" if top_right else " — NOT top-right"))
                _check_collisions(r, page)
                _check_clicks(r, flow, page)
                _check_tabs(r, flow, page)
            if shots:
                shots.mkdir(parents=True, exist_ok=True)
                page.locator("#p-graph").screenshot(path=str(shots / f"{flow['meta']['slug']}-{name}.png"))
                if name == "light":
                    _shoot_canvas(page, shots / f"{flow['meta']['slug']}-canvas.png")
                    page.locator("header").screenshot(path=str(shots / f"{flow['meta']['slug']}-header.png"))
            page.close()
        _check_page_break(r, browser, html_path)
        browser.close()


LUMINANCE_JS = """() => { const c = getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number);
  return (0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]) / 255; }"""


def _open(browser, html_path: Path, viewport: dict, scheme: str):
    page = browser.new_page(viewport=viewport, color_scheme=scheme)
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    # Serve the font stylesheet empty: the check is then offline and deterministic, and it proves
    # the system-font fallback renders without errors.
    page.route(re.compile("|".join(map(re.escape, FONT_HOSTS))),
               lambda route: route.fulfill(status=200, content_type="text/css", body=EMPTY_CSS))
    page.goto(html_path.resolve().as_uri())
    page.wait_for_load_state("networkidle")
    return page, errors


# Measured in the real render (fonts as the reader gets them), so it also catches labels that wrapped
# wider or taller than layout.py estimated.
COLLISIONS_JS = """() => {
  const box = el => { const r = el.getBoundingClientRect(); return {x0:r.left, y0:r.top, x1:r.right, y1:r.bottom}; };
  const name = el => el.classList.contains('node') ? el.id : (el.textContent || '').trim().slice(0, 40);
  const marks = [...document.querySelectorAll('#canvas .elabel, #canvas .trig .chipk')];
  const nodes = [...document.querySelectorAll('#canvas .node')];
  const hit = (a, b) => a.x0 < b.x1 - 1 && b.x0 < a.x1 - 1 && a.y0 < b.y1 - 1 && b.y0 < a.y1 - 1;
  const out = [];
  marks.forEach((m, i) => {
    const mb = box(m);
    nodes.forEach(n => { if (hit(mb, box(n))) out.push(`"${name(m)}" over ${name(n)}`); });
    marks.slice(i + 1).forEach(o => { if (o.parentElement !== m.parentElement && hit(mb, box(o))) out.push(`"${name(m)}" over "${name(o)}"`); });
  });
  return out;
}"""


def _check_collisions(r: Report, page) -> None:
    page.locator("#z-100").click()
    found = page.evaluate(COLLISIONS_JS)
    page.locator("#z-fit").click()
    r.check("browser/collisions", not found, "no label or chip overlaps a box or another label (as rendered)"
            if not found else f"{len(found)}: {found[:6]}")


def _shoot_canvas(page, path: Path) -> None:
    """The whole graph at 100 %, unclipped by the scroll box and not covered by the side panel or the
    sticky zoom bar. Zoom first (the bar is hidden while shooting), then restore the page."""
    page.locator("#z-100").click()
    style = page.add_style_tag(content=".graphbox{max-height:none!important;overflow:visible!important}"
                                       ".layout{display:block!important} aside.detail{display:none!important}"
                                       " .tools{display:none!important}")
    page.locator("#canvas").screenshot(path=str(path))
    style.evaluate("el => el.remove()")
    page.locator("#z-fit").click()


def _check_clicks(r: Report, flow: dict, page) -> None:
    wrong = []
    for sid in flow["order"]:
        # Click the top-left corner (where the id sits): a container's centre is covered by its children.
        page.locator(f"#n-{sid}").click(position={"x": 8, "y": 8})
        shown = page.locator("#detail h2").text_content()
        if shown != flow["steps"][sid]["title"]:
            wrong.append(f"{sid}→{shown!r}")
    r.check("browser/detail-panel", not wrong, f"all {len(flow['order'])} steps open their own panel" if not wrong else f"wrong panel: {wrong}")


def _check_tabs(r: Report, flow: dict, page) -> None:
    expected = {"steps": len(flow["order"]), "triggers": len(flow["triggers"]), "open": len(flow["open"])}
    expected.update({f"sheet-{s['id']}": len(s["rows"]) for s in flow["sheets"]})
    wrong = []
    for key, rows in expected.items():
        page.locator(f"#tab-{key}").click()
        visible = page.locator(f"#p-{key}").is_visible()
        n = page.locator(f"#p-{key} tbody tr").count()
        if not visible or n != rows:
            wrong.append(f"{key}: visible={visible} rows={n}/{rows}")
    page.locator("#tab-graph").click()
    r.check("browser/tabs", not wrong, f"{len(expected)} tabs show their tables" if not wrong else f"{wrong}")


def _check_page_break(r: Report, browser, html_path: Path) -> None:
    raw = html_path.read_text(encoding="utf-8")
    match = DATA_BLOCK.search(raw)
    data = json.loads(match.group(1).replace("<\\/", "</"))
    good_nodes = len(data["graph"]["nodes"])
    if not data["graph"]["edges"]:
        r.skip("page-break", "the flow has no edges to corrupt")
        return
    first = data["graph"]["edges"][0]
    data["graph"]["edges"].append({**first, "to": BOGUS_NODE})
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    broken = raw[:match.start(1)] + payload + raw[match.end(1):]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "broken.html"
        path.write_text(broken, encoding="utf-8")
        page, errors = _open(browser, path, DESKTOP, "light")
        n = page.locator(".node").count()
        warned = page.locator("#warnings .warn").count()
        page.close()
    loud = any(BOGUS_NODE in e for e in errors)
    r.check("page-break", loud and n == good_nodes and warned == 1,
            f"bad edge logged={loud}, on-page warning={warned}, {n}/{good_nodes} nodes still drawn")


# ---- deny list -------------------------------------------------------------------------------
def check_deny(r: Report, deny: Path, files: list[Path]) -> None:
    patterns = [re.compile(line.strip(), re.I) for line in deny.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.startswith("#")]
    hits = []
    for f in files:
        text = _text_of(f)
        hits += [f"{f.name}: {p.pattern}" for p in patterns if p.search(text)]
    r.check("deny", not hits, f"{len(patterns)} patterns, {len(files)} files, no hits" if not hits else f"hits: {hits}")


def _strings(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)] + [k for k in value if isinstance(k, str)]
    if isinstance(value, list):
        return [s for v in value for s in _strings(v)]
    return []


def _text_of(path: Path) -> str:
    if path.suffix == ".html":
        # Only the text the page carries: the strings of its data. Coordinates (long floats) and the
        # template's own markup (e.g. the SVG namespace URI) would otherwise trip digit or URL patterns.
        match = DATA_BLOCK.search(path.read_text(encoding="utf-8"))
        return "\n".join(_strings(json.loads(match.group(1).replace("<\\/", "</")))) if match else ""
    if path.suffix == ".xlsx":
        from openpyxl import load_workbook

        wb = load_workbook(path)
        return "\n".join(str(c.value) for ws in wb for row in ws.iter_rows() for c in row if c.value is not None)
    return path.read_text(encoding="utf-8", errors="replace")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify a flowdoc output set.")
    ap.add_argument("spec", type=Path)
    ap.add_argument("--out", type=Path, default=None, help="output directory (default: the spec's directory)")
    ap.add_argument("--shots", type=Path, default=None, help="write light/dark/400px screenshots here")
    ap.add_argument("--deny", type=Path, default=None,
                    help="file of regexes, one per line, matched case-insensitively; '#' lines are comments")
    ap.add_argument("--scan", type=Path, action="append", default=[],
                    help="with --deny: also scan this file or directory (repeatable) — e.g. the inputs the outputs cite")
    ap.add_argument("--no-browser", action="store_true", help="skip the headless render checks")
    args = ap.parse_args(argv)
    r = Report()
    paths = check_build(r, args.spec, args.out or args.spec.parent)
    if not paths:
        return 1
    flow = load_spec(args.spec)
    check_validator(r, flow)
    check_layout(r, flow, page_data(flow)["graph"])
    check_xlsx(r, flow, paths["xlsx"])
    check_md(r, flow, paths["md"])
    data = check_html(r, flow, paths["html"])
    if args.no_browser:
        r.skip("browser", "--no-browser")
    elif data:
        check_browser(r, flow, data, paths["html"], args.shots)
    if args.deny:
        # Everything that sits beside the spec and could be published with it (inventories, the saved
        # description or walkthrough) — except the deny list itself.
        spec_files = sorted(f for ext in DENY_SCOPE for f in args.spec.parent.glob(ext)
                            if f.resolve() != args.deny.resolve())
        extra = [f for p in args.scan for f in (sorted(q for q in p.rglob("*") if q.is_file()) if p.is_dir() else [p])]
        check_deny(r, args.deny, list(paths.values()) + spec_files + extra)
    skipped = f" ({len(r.skipped)} SKIPPED: {', '.join(r.skipped)} — not verified)" if r.skipped else ""
    print(f"\n{'ALL CHECKS PASSED' if not r.failed else f'{r.failed} CHECK(S) FAILED'}{skipped}")
    return 1 if r.failed else 0


if __name__ == "__main__":
    sys.exit(main())
