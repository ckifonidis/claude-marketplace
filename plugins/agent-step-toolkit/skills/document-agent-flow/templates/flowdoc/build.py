"""Build the three-part flow documentation from one spec: <slug>.md, <slug>.html, <slug>.xlsx.

    uvx --with openpyxl python3 scripts/flowdoc/build.py path/to/flow_spec.py [--out DIR]

The spec is validated first; any dangling reference stops the build with every problem listed,
so a typo can never ship a broken graph or sheet. Outputs are never edited by hand — change the
spec and rebuild.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# No __pycache__ next to the vendored copy or the spec: both live in the user's repo.
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from model import SpecError, load_spec  # noqa: E402
from render_html import write_html  # noqa: E402
from render_md import write_md  # noqa: E402
from render_xlsx import sheet_names, write_xlsx  # noqa: E402

EXIT_INVALID_SPEC = 2
EXIT_LAYOUT_WARNINGS = 3   # outputs written, but the graph needs attention (verify.py fails on it too)


def output_paths(flow: dict, out_dir: Path) -> dict[str, Path]:
    slug = flow["meta"]["slug"]
    return {ext: out_dir / f"{slug}.{ext}" for ext in ("md", "html", "xlsx")}


def file_table(flow: dict, paths: dict[str, Path]) -> dict[str, str]:
    """The md's 'what each file holds' table, written from what is actually being built."""
    sheets = ", ".join(f"**{name}**" for name in sheet_names(flow))
    return {
        paths["html"].name: "The graph. Click any box for what that step gathers, when it completes, what it triggers, "
                            "where it goes next and which real routes it uses. The tabs repeat the sheet.",
        paths["xlsx"].name: f"The step sheet. Tabs: {sheets}.",
        paths["md"].name: "This design document.",
    }


def build(spec_path: Path, out_dir: Path | None = None) -> dict[str, Path]:
    """Build the three files; return their paths. Layout warnings are printed (see build_checked)."""
    return build_checked(spec_path, out_dir)[0]


def build_checked(spec_path: Path, out_dir: Path | None = None) -> tuple[dict[str, Path], list[str]]:
    """Build the three files; return their paths and the layout warnings (empty when the graph is clean)."""
    flow = load_spec(spec_path)
    out_dir = out_dir or spec_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = output_paths(flow, out_dir)
    write_xlsx(flow, paths["xlsx"])
    data = write_html(flow, paths["html"])
    for warning in data["graph"]["warnings"]:
        print(f"layout warning: {warning}", file=sys.stderr)
    write_md(flow, paths["md"], file_table(flow, paths))
    return paths, data["graph"]["warnings"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("spec", type=Path, help="flow spec: a .py module binding FLOW, or a .json file")
    parser.add_argument("--out", type=Path, default=None, help="output directory (default: the spec's directory)")
    args = parser.parse_args(argv)
    try:
        paths, warnings = build_checked(args.spec, args.out)
    except SpecError as exc:
        print(exc, file=sys.stderr)
        return EXIT_INVALID_SPEC
    for p in paths.values():
        print(f"wrote {p}")
    return EXIT_LAYOUT_WARNINGS if warnings else 0


if __name__ == "__main__":
    sys.exit(main())
