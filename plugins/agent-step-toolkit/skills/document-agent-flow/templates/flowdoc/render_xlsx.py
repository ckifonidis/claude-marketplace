"""Write the step sheet: Steps, Triggers & APIs, any domain sheets, Open & TBD.

Column choices are explained in references/design-guide.md. The fills mirror the page: stage rows
alternate in two light bands so the ladder reads in blocks; trigger rows take their status colour.
"""

from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from model import STATUS_LABELS

HEADER_FILL = "0B5F73"      # the page's --accent in light mode
HEADER_FONT_COLOR = "FFFFFF"
BAND_FILLS = ("EEF3F5", "FFFFFF")
STATUS_FILLS = {"exists": "E1F1E7", "change": "FBEFD9", "new": "F8E3E6", "tbd": "F5F0C8"}
MIN_COL_WIDTH, MAX_COL_WIDTH, HEADER_WIDTH_PAD = 12, 60, 4
FREEZE_AT = "C2"            # keep the id + name columns and the header visible while scrolling
LIST_BULLET = "• "
EMPTY = "—"

SHEET_STEPS, SHEET_TRIGGERS, SHEET_OPEN = "Steps", "Triggers & APIs", "Open & TBD"

STEP_COLUMNS = (
    "Step", "Stage", "Part of", "Name", "On entry the agent says", "Must gather (completion needs all)",
    "Offer — skippable", "Arrives prefilled", "Complete when", "Triggers on completion (in order)",
    "Next step (by outcome)", "Trigger APIs (real routes)", "Lookups while gathering", "Step-engine expression",
    "Status today", "Status note", "Open items",
)
STEP_WIDTHS = {
    "Name": 28, "On entry the agent says": 40, "Must gather (completion needs all)": 50, "Offer — skippable": 34,
    "Arrives prefilled": 30, "Complete when": 44, "Triggers on completion (in order)": 36,
    "Next step (by outcome)": 46, "Trigger APIs (real routes)": 60, "Lookups while gathering": 50,
    "Step-engine expression": 60, "Status note": 50,
}
TRIGGER_COLUMNS = ("Trigger", "Name", "Fired by", "Name in the brief", "Real route", "Evidence",
                   "On success", "On failure", "Retry policy", "Status")
TRIGGER_WIDTHS = {"Name": 30, "Name in the brief": 34, "Real route": 60, "Evidence": 44,
                  "On success": 34, "On failure": 50, "Retry policy": 40}
OPEN_COLUMNS = ("ID", "Question", "Where it bites", "Default until decided")
OPEN_WIDTHS = {"Question": 70, "Where it bites": 20, "Default until decided": 60}


def sheet_names(flow: dict) -> list[str]:
    """The tab order the workbook will have — verify.py asserts it after reading the file back."""
    return [SHEET_STEPS, SHEET_TRIGGERS] + [s["title"] for s in flow["sheets"]] + [SHEET_OPEN]


def write_xlsx(flow: dict, path: Path) -> None:
    wb = Workbook()
    wb.remove(wb.active)
    rows, fills = _step_rows(flow)
    _write_sheet(wb, SHEET_STEPS, STEP_COLUMNS, rows, STEP_WIDTHS, fills)
    rows, fills = _trigger_rows(flow)
    _write_sheet(wb, SHEET_TRIGGERS, TRIGGER_COLUMNS, rows, TRIGGER_WIDTHS, fills)
    for sheet in flow["sheets"]:
        rows = [[_cell(c) for c in r] for r in sheet["rows"]]
        _write_sheet(wb, sheet["title"], sheet["columns"], rows, sheet.get("widths", {}), None)
    rows = [(o["id"], o["question"], o["where"], o["default"]) for o in flow["open"]]
    _write_sheet(wb, SHEET_OPEN, OPEN_COLUMNS, rows, OPEN_WIDTHS, None)
    wb.save(path)


def _bullets(items) -> str:
    return "\n".join(LIST_BULLET + str(i) for i in items) if items else EMPTY


def _cell(value):
    return _bullets(value) if isinstance(value, (list, tuple)) else value


def _step_rows(flow: dict):
    stage_index = {s["id"]: i for i, s in enumerate(flow["stages"])}
    triggers = flow["triggers"]
    rows, fills = [], []
    for sid in flow["order"]:
        s = flow["steps"][sid]
        rows.append((
            sid, s["stage"], s["parent"] or EMPTY, s["title"], s["opens"] or EMPTY,
            _bullets(s["required"]), _bullets(s["optional"]), _bullets(s["prefilled"]), s["completion"],
            _bullets([f"{t} · {triggers[t]['name']}" for t in s["triggers"]]),
            _bullets([f"→ {o['to']} — {o['when']}" for o in s["next"]]),
            _bullets([f"{t}: {triggers[t]['real']}" for t in s["triggers"]]),
            _bullets(s["lookups"]), s["engine"], STATUS_LABELS[s["status"]], s["status_note"] or EMPTY,
            ", ".join(s["open"]) or EMPTY,
        ))
        fills.append(BAND_FILLS[stage_index[s["stage"]] % len(BAND_FILLS)])
    return rows, fills


def _trigger_rows(flow: dict):
    rows, fills = [], []
    for t in flow["triggers"].values():
        rows.append((t["id"], t["name"], t["step"] or EMPTY, t["spec"] or EMPTY, t["real"], t["evidence"] or EMPTY,
                     t["on_ok"], _bullets(t["on_fail"]), t["retry"] or EMPTY, STATUS_LABELS[t["status"]]))
        fills.append(STATUS_FILLS[t["status"]])
    return rows, fills


def _write_sheet(wb: Workbook, title: str, columns, rows, widths, fills) -> None:
    ws = wb.create_sheet(title)
    ws.append(list(columns))
    for cell in ws[1]:
        cell.fill = PatternFill("solid", fgColor=HEADER_FILL)
        cell.font = Font(bold=True, color=HEADER_FONT_COLOR)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
    for idx, row in enumerate(rows):
        ws.append(list(row))
        for cell in ws[ws.max_row]:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            if fills:
                cell.fill = PatternFill("solid", fgColor=fills[idx])
    for i, col in enumerate(columns, start=1):
        width = widths.get(col) or min(MAX_COL_WIDTH, max(MIN_COL_WIDTH, len(str(col)) + HEADER_WIDTH_PAD))
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = FREEZE_AT
    ws.auto_filter.ref = ws.dimensions
