"""Write the self-contained interactive graph page from the template + the laid-out flow."""

from __future__ import annotations

import html
import json
from pathlib import Path

from layout import layout

TEMPLATE_PATH = Path(__file__).resolve().parent / "template.html"
DATA_PLACEHOLDER = "/*__DATA__*/"
TITLE_PLACEHOLDER = "/*__TITLE__*/"
PAGE_KEYS = ("meta", "steps", "triggers", "order", "open", "sheets")


def page_data(flow: dict) -> dict:
    """Everything the page needs: the spec's own data plus the computed geometry."""
    data = {k: flow[k] for k in PAGE_KEYS}
    data["graph"] = layout(flow)
    return data


def write_html(flow: dict, path: Path) -> dict:
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    for marker in (DATA_PLACEHOLDER, TITLE_PLACEHOLDER):
        if marker not in template:
            raise SystemExit(f"template.html is missing the placeholder {marker!r} — was it hand-edited?")
    data = page_data(flow)
    # "</" is escaped so no string in the data can close the <script> block early.
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    page = template.replace(TITLE_PLACEHOLDER, html.escape(flow["meta"]["title"]), 1)
    path.write_text(page.replace(DATA_PLACEHOLDER, payload, 1), encoding="utf-8")
    return data
