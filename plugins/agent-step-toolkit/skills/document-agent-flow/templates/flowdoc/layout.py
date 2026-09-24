"""Automatic layout for a step ladder: stage bands, a main spine, branch lanes, gutters, containers.

Why a purpose-built layout instead of a generic graph library: an agent flow is a LADDER — one
dominant happy path read top to bottom, a few side branches that rejoin it, failure edges that
loop back up, and self-loops for "stay here and ask again". A generic layered layout (Sugiyama,
as in dagre/ELK) balances the whole graph and scatters the spine; embedding one also costs
hundreds of KB to MB of JavaScript, which the page budget forbids. This module places the ladder
deterministically in pure Python, so the same spec always yields the same picture and the page
ships only coordinates.

Placement rules (documented for authors in references/layout.md):
  * spine    — from the first step, follow each step's first ``main`` outcome forward. Spine
               nodes sit in lane 0, the main column.
  * rank     — longest path over forward edges (target later in ``order``), never earlier than
               the stage's floor, so stages stay contiguous bands. Two nodes of the same rank share
               a row; off-spine nodes take lanes 1, 2, … to the right.
  * terminal — reached by a main/opt edge from the spine: ranks below it. Reached only by
               failure edges: a side terminal in its first source's row.
  * container— a step that is some steps' ``parent`` is drawn as a box holding its children in a
               grid; cross-cutting children run full width along its bottom.
  * routing  — self-loops on the right; forward edges straight down or as elbows; back edges up a
               dedicated gutter track each — the left gutter for edges leaving the main column, a
               right gutter for edges leaving a branch lane, so none cuts across the spine (short
               spans take the inner tracks, so they nest without crossing); a second edge between
               the same pair runs beside the first; edges blocked by a node detour to the right.
"""

from __future__ import annotations

import math

from model import EDGE_BRANCH, EDGE_FAIL, EDGE_MAIN, EDGE_OPT, children_of, edges_of

# ---- geometry constants (px) -------------------------------------------------------------------
BAND_LABEL_W = 120          # left strip that carries the stage names
TRACK_GAP = 16              # distance between neighbouring back-edge tracks in a gutter
GUTTER_PAD = 24             # breathing room between the outermost track and the band labels
MAIN_W = 280                # main-column node width
LANE_W = 250                # branch-lane node width
TERM_W = 220                # terminal pill width
TERM_H = 46
TERM_PAD_Y = 14
LOOP_DX = 34                # how far a self-loop bulges out of the node's right side
LOOP_LABEL_MAX_W = 190      # self-loop labels wrap past this width
LANE_GAP = 40
ROW_GAP = 86                # vertical room between rows: trigger chips and labels live here
BAND_PAD = 34               # space between a band's top and its first row
CANVAS_PAD = 30
NODE_PAD_Y = 16             # top + bottom padding inside a node
ID_LINE_H = 14
TITLE_LINE_H = 17
SUB_LINE_H = 15
TITLE_CHAR_W = 7.6          # average glyph widths, used to estimate wrapping — sized for the SYSTEM
                            # fallback fonts (wider than Fira), so an offline page still fits
SUB_CHAR_W = 6.1
LABEL_CHAR_W = 6.9
LABEL_LINE_H = 15
LABEL_PAD_W = 10
CHIP_CHAR_W = 6.9
CHIP_PAD_W = 24             # chip padding + the ⚡ glyph
CHIP_ARROW_W = 14
CHIP_H = 20
CHIP_MAX_W = 330
MIN_NODE_H = 64
CHILD_W = 190
CHILD_GAP_X = 50            # wide enough for a child's self-loop
CHILD_GAP_Y = 30
CHILD_COLS_MAX = 4
CONTAINER_PAD_X = 20
CONTAINER_HEAD_H = 78       # the container's own title + subtitle strip
CONTAINER_PAD_B = 20
CROSS_H = 58                # height of a cross-cutting child bar
LABEL_NUDGE = 17            # step used to push a colliding label down
LABEL_NUDGE_TRIES = 12
LABEL_MAX_DRIFT = 4         # a label moves at most this many nudges (~70 px) from its anchor, then warns
SIDE_EXIT_FRACTION = 0.88   # side exits leave near the bottom, clear of the self-loop
SIDE_EXIT_STEP = 0.1        # each further right-side exit of a node leaves this much higher …
SIDE_EXIT_MIN = 0.7         # … but never inside the self-loop band
LOOP_TOP, LOOP_BOTTOM = 0.28, 0.66
BACK_EXIT_FRACTION = 0.5
BACK_ENTRY_FRACTION = 0.35
LABEL_OFFSET = 6
ROW_GAP_LANE = 0.3          # rerouted edges run along the row gap this far below the source
LINE_HALO = 2              # labels and chips keep this far off every edge line
EDGE_CLEARANCE = 1          # an edge may touch a box's border, not enter it
INNER_CHIP_GAP = 4          # spacing around the chip row drawn inside a sub-step's box
CHIP_RUNS = 2               # chips may sit on the first run, or the one after the first bend
PARALLEL_GAP = 28           # a second edge between the same two nodes runs this far to the right
PARALLEL_MIN_SPLIT = 110    # room the first edge's chips need before a parallel edge can run beside it
LOOP_NEST = 0.7             # each further self-loop on a node bulges this much further out
LOOP_NEST_SPREAD = 0.12     # … and spans this much more of the node's height
BAND_NAME_H = 34            # a stage name wraps to at most two lines in the left strip
GUTTER_LABEL_MIN_W = 70


def layout(flow: dict) -> dict:
    """Return ``{nodes, edges, stages, width, height}`` with absolute pixel geometry."""
    graph = _Graph(flow)
    graph.place()
    return graph.result()


class _Graph:
    def __init__(self, flow: dict):
        self.flow = flow
        self.steps = flow["steps"]
        self.order = flow["order"]
        self.terminals = flow["terminals"]
        self.edges = edges_of(flow)
        self.inner_chips = self._inner_chips()
        self.top = [s for s in self.order if not self.steps[s]["parent"]]
        self.index = {sid: i for i, sid in enumerate(self.order)}
        self.nodes: dict[str, dict] = {}
        self.label_boxes: list[tuple[float, float, float, float]] = []
        self.side_exits: dict[str, int] = {}   # right-side exits handed out per node, top of the stack last
        self.warnings: list[str] = []
        self.detours = 0                        # right-gutter tracks handed to rerouted edges

    def _inner_chips(self) -> dict[str, list[str]]:
        """Chips of edges that are never drawn — a sub-step closing back into its own container (the
        box already shows that edge). They are drawn INSIDE the sub-step's box instead, so no fired
        call ever disappears from the picture."""
        inner: dict[str, list[str]] = {}
        for e in self.edges:
            a, b = e["from"], e["to"]
            child = a if self.steps.get(a, {}).get("parent") == b else b if self.steps.get(b, {}).get("parent") == a else None
            if child and e["triggers"]:
                inner.setdefault(child, [])
                inner[child] += [t for t in e["triggers"] if t not in inner[child]]
        return inner

    # ---- ranking ------------------------------------------------------------------------------
    def place(self) -> None:
        self.spine = self._spine()
        self.rank = self._ranks()
        self.lane = self._lanes()
        self._size_nodes()
        self._position_nodes()
        self._route_edges()

    def _outer(self, node: str) -> str:
        """A child step is represented at top level by its container."""
        return self.steps[node]["parent"] or node if node in self.steps else node

    def _order_of(self, node: str) -> float:
        # Terminals have no slot in ``order``; they count as just after their LAST source, so every
        # edge into a shared end (several steps can finish the call) runs forward, never back up.
        if node in self.index:
            return self.index[node]
        sources = [self.index[e["from"]] for e in self.edges if e["to"] == node]
        return (max(sources) if sources else len(self.order)) + 0.5

    def _is_forward(self, e: dict) -> bool:
        a, b = self._outer(e["from"]), self._outer(e["to"])
        return a != b and self._order_of(b) > self._order_of(a)

    def _spine(self) -> list[str]:
        spine, node, seen = [], self.top[0], set()
        while node and node not in seen:
            seen.add(node)
            spine.append(node)
            node = next((self._outer(e["to"]) for e in self.edges
                         if self._outer(e["from"]) == node and e["kind"] in (EDGE_MAIN, EDGE_OPT)
                         and self._is_forward(e) and self._outer(e["to"]) not in seen), None)
        return spine

    def _side_terminals(self) -> set[str]:
        side = set()
        for tid in self.terminals:
            incoming = [e for e in self.edges if e["to"] == tid]
            sources = {self._outer(e["from"]) for e in incoming}
            # Beside its source only when exactly one step fails into it; shared ends get a row.
            if tid not in self.spine and len(sources) == 1 and all(e["kind"] == EDGE_FAIL for e in incoming):
                side.add(tid)
        return side

    def _ranks(self) -> dict[str, int]:
        self.side = self._side_terminals()
        nodes = self.top + [t for t in self.terminals if t not in self.side]
        nodes.sort(key=self._order_of)
        rank: dict[str, int] = {}
        stage_of = {n: self.steps[n]["stage"] if n in self.steps else None for n in nodes}
        floor, last_stage, stage_max = 0, None, -1
        for n in nodes:
            stage = stage_of[n] or last_stage
            if stage != last_stage:
                floor, last_stage = stage_max + 1, stage
            # A step's row follows its non-failure predecessors; a terminal's follows ALL of them
            # (a failure-only end shared by several steps sits below the last, not beside the first).
            preds = [rank[self._outer(e["from"])] + 1 for e in self.edges
                     if self._outer(e["to"]) == n and self._is_forward(e) and self._outer(e["from"]) in rank
                     and (e["kind"] != EDGE_FAIL or n in self.terminals)]
            rank[n] = max([floor] + preds)
            stage_max = max(stage_max, rank[n])
        for t in self.side:
            first = min((e for e in self.edges if e["to"] == t), key=lambda e: self._order_of(e["from"]))
            rank[t] = rank[self._outer(first["from"])]
        return rank

    def _lanes(self) -> dict[str, int]:
        lane, used = {}, {}
        # Spine first so it always owns lane 0; the rest fill rightwards in ladder order.
        ordered = self.spine + sorted((n for n in self.rank if n not in self.spine), key=self._order_of)
        for n in ordered:
            row = used.setdefault(self.rank[n], set())
            k = 0 if n in self.spine and 0 not in row else 1
            while k in row:
                k += 1
            lane[n] = k
            row.add(k)
        return lane

    # ---- sizing -------------------------------------------------------------------------------
    def _size_nodes(self) -> None:
        for n in self.rank:
            if n in self.terminals:
                label = self.terminals[n]["label"]
                h = max(TERM_H, TERM_PAD_Y + _lines(label, TITLE_CHAR_W, TERM_W - 2 * CONTAINER_PAD_X) * TITLE_LINE_H)
                self.nodes[n] = {"id": n, "label": label, "w": TERM_W, "h": h,
                                 "cls": "term" + (" bad" if self.terminals[n]["tone"] == "bad" else "")}
            elif children_of(self.flow, n):
                self._size_container(n)
            else:
                w = MAIN_W if self.lane[n] == 0 else LANE_W
                self.nodes[n] = self._step_node(n, w)

    def _step_node(self, sid: str, w: float) -> dict:
        step = self.steps[sid]
        label = step["label"] or step["title"]
        inner = w - 2 * CONTAINER_PAD_X
        h = NODE_PAD_Y + ID_LINE_H + _lines(label, TITLE_CHAR_W, inner) * TITLE_LINE_H
        if step["sub"]:
            h += _lines(step["sub"], SUB_CHAR_W, inner) * SUB_LINE_H
        chips = self.inner_chips.get(sid, [])
        if chips:
            rows = _lines(" " * math.ceil(_chips_w(chips, self.flow) / LABEL_CHAR_W), LABEL_CHAR_W, inner)
            h += INNER_CHIP_GAP + rows * (CHIP_H + INNER_CHIP_GAP)
        cls = ["alt"] if self._only_branch_in(sid) else []
        if step["optional_step"]:
            cls.append("opt")
        node = {"id": sid, "label": label, "sub": step["sub"], "w": w, "h": max(MIN_NODE_H, math.ceil(h)),
                "cls": " ".join(cls), "status": step["status"]}
        if chips:
            node["chips"] = chips
        return node

    def _only_branch_in(self, sid: str) -> bool:
        incoming = [e for e in self.edges if e["to"] == sid and self._outer(e["from"]) != sid]
        return bool(incoming) and all(e["kind"] == EDGE_BRANCH for e in incoming)

    def _size_container(self, cid: str) -> None:
        kids = children_of(self.flow, cid)
        grid = [k for k in kids if not self.steps[k]["cross_cutting"]]
        cross = [k for k in kids if self.steps[k]["cross_cutting"]]
        cols = min(CHILD_COLS_MAX, max(1, len(grid)))
        rows = math.ceil(len(grid) / cols) if grid else 0
        child_nodes = {k: self._step_node(k, CHILD_W) for k in grid}
        row_h = max((c["h"] for c in child_nodes.values()), default=0)
        w = max(MAIN_W, 2 * CONTAINER_PAD_X + cols * CHILD_W + (cols - 1) * CHILD_GAP_X + LOOP_DX)
        h = CONTAINER_HEAD_H + rows * row_h + max(0, rows - 1) * CHILD_GAP_Y
        h += len(cross) * (CROSS_H + CHILD_GAP_Y) + CONTAINER_PAD_B
        node = self._step_node(cid, w)
        node.update({"w": w, "h": h, "cls": (node["cls"] + " container").strip()})
        self.nodes[cid] = node
        for i, k in enumerate(grid):
            child_nodes[k].update({"cls": (child_nodes[k]["cls"] + " sub").strip(), "h": row_h,
                                   "_dx": CONTAINER_PAD_X + (i % cols) * (CHILD_W + CHILD_GAP_X),
                                   "_dy": CONTAINER_HEAD_H + (i // cols) * (row_h + CHILD_GAP_Y)})
            self.nodes[k] = child_nodes[k]
        base = CONTAINER_HEAD_H + rows * (row_h + CHILD_GAP_Y)
        for j, k in enumerate(cross):
            bar = self._step_node(k, w - 2 * CONTAINER_PAD_X)
            bar.update({"cls": (bar["cls"] + " sub cross").strip(), "h": CROSS_H,
                        "_dx": CONTAINER_PAD_X, "_dy": base + j * (CROSS_H + CHILD_GAP_Y)})
            self.nodes[k] = bar

    # ---- positions ----------------------------------------------------------------------------
    def _position_nodes(self) -> None:
        back = [e for e in self._drawable() if self._is_back(e)]
        self.left_tracks = len(back)
        self.main_x = BAND_LABEL_W + GUTTER_PAD + self.left_tracks * TRACK_GAP
        loop_zone = LOOP_DX + LABEL_OFFSET + self._widest_loop_label()
        rows = sorted(set(self.rank.values()))
        self.row_top, y = {}, CANVAS_PAD + BAND_PAD
        stage_starts = self._stage_start_rows()
        for r in rows:
            if r in stage_starts and r != rows[0]:
                y += BAND_PAD
            self.row_top[r] = y
            members = [n for n in self.rank if self.rank[n] == r]
            x = self.main_x
            for n in sorted(members, key=lambda m: self.lane[m]):
                node = self.nodes[n]
                if self.lane[n] == 0:
                    node["x"] = self.main_x
                else:
                    node["x"] = max(x, self.main_x + MAIN_W + loop_zone + (self.lane[n] - 1) * (LANE_W + LANE_GAP))
                node["y"] = y
                x = node["x"] + node["w"] + (loop_zone if self._has_loop(n) else LANE_GAP)
            y += max(self.nodes[n]["h"] for n in members) + ROW_GAP
        self._center_side_terminals()
        for n, node in self.nodes.items():   # children are placed relative to their container
            if "_dx" in node:
                parent = self.nodes[self.steps[n]["parent"]]
                node["x"], node["y"] = parent["x"] + node.pop("_dx"), parent["y"] + node.pop("_dy")
        self.height_rows = y - ROW_GAP + BAND_PAD

    def _center_side_terminals(self) -> None:
        # A side terminal lines up with the bottom exit of its source so its edge stays horizontal.
        for t in self.side:
            src = next(e["from"] for e in self.edges if e["to"] == t)
            s = self.nodes[self._outer(src)]
            self.nodes[t]["y"] = s["y"] + s["h"] * SIDE_EXIT_FRACTION - self.nodes[t]["h"] / 2

    def _stage_start_rows(self) -> set[int]:
        starts, seen = set(), set()
        for n in sorted(self.rank, key=self._order_of):
            stage = self.steps[n]["stage"] if n in self.steps else None
            if stage and stage not in seen:
                seen.add(stage)
                starts.add(self.rank[n])
        return starts

    def _widest_loop_label(self) -> float:
        widths = [min(LOOP_LABEL_MAX_W, _text_w(self._display_label(e))) for e in self._drawable()
                  if e["from"] == e["to"] and self.steps[e["from"]]["parent"] == ""]
        return max(widths, default=0)

    def _display_label(self, e: dict) -> str:
        """What the edge says on the canvas. The full ``when`` is always in the tooltip and the panel."""
        if e["label"] is False:
            return ""   # the author switched this edge's label off; `when` stays in the tooltip and panel
        if e["label"]:
            return e["label"]
        if e["from"] == e["to"] and self.steps.get(e["from"], {}).get("parent"):
            return ""   # child loops are too tight to label; the detail panel says it
        if e["kind"] == EDGE_MAIN:
            # A lone happy edge needs no words (its chips say what happens); a fork does.
            forks = [o for o in self.steps[e["from"]]["next"] if o["kind"] != EDGE_FAIL]
            if len(forks) < 2:
                return ""
        return _short(e["when"])

    def _has_loop(self, n: str) -> bool:
        return any(e["from"] == n and e["to"] == n for e in self.edges)

    # ---- routing ------------------------------------------------------------------------------
    def _drawable(self) -> list[dict]:
        """Edges worth drawing: containment already says container ↔ own child."""
        out = []
        for e in self.edges:
            a, b = e["from"], e["to"]
            if self.steps.get(a, {}).get("parent") == b or self.steps.get(b, {}).get("parent") == a:
                continue
            out.append(e)
        return out

    def _is_back(self, e: dict) -> bool:
        a, b = self._outer(e["from"]), self._outer(e["to"])
        return a != b and e["to"] not in self.side and self.rank.get(b, 0) < self.rank.get(a, 0)

    def _route_edges(self) -> None:
        self.routed = []
        for n in self.nodes.values():
            self.label_boxes.append((n["x"], n["y"], n["x"] + n["w"], n["y"] + n["h"]))
        for band in self._bands(0):   # stage names sit in the left strip; labels must not cover them
            self.label_boxes.append((0, band["y0"], BAND_LABEL_W, band["y0"] + BAND_NAME_H))
        back = sorted((e for e in self._drawable() if self._is_back(e)), key=self._span)
        # Back edges leaving the main column climb the left gutter; those leaving a branch lane climb
        # a right gutter, so they never cut across the spine. Short spans take the inner tracks.
        left = [e for e in back if self.lane[self._outer(e["from"])] == 0]
        right = [e for e in back if self.lane[self._outer(e["from"])] != 0]
        left_track = {id(e): i for i, e in enumerate(left)}
        right_track = {id(e): i for i, e in enumerate(right)}
        right_x = self._right_edge() + GUTTER_PAD
        seen_pairs: dict[tuple[str, str], int] = {}
        planned = []
        for e in self._drawable():
            a, b = self.nodes[e["from"]], self.nodes[e["to"]]
            nth = seen_pairs.get((e["from"], e["to"]), 0)
            seen_pairs[(e["from"], e["to"])] = nth + 1
            if e["from"] == e["to"]:
                pts = _self_loop(a, small="sub" in a["cls"], nth=nth)
            elif id(e) in left_track:
                pts = _back_edge(a, b, self.main_x - GUTTER_PAD / 2 - left_track[id(e)] * TRACK_GAP, side="left")
            elif id(e) in right_track:
                pts = _back_edge(a, b, right_x + right_track[id(e)] * TRACK_GAP, side="right")
            elif e["to"] in self.side:
                pts = _side_exit(a, b)
            else:
                pts = self._forward(a, b, nth)
            if e["from"] != e["to"]:
                pts = self._clear_route(e, pts, a, b)
            planned.append((e, pts, id(e) in left_track))
        # Two passes: every line is known before any label or chip is placed, so none lands on one.
        for _, pts, _ in planned:
            for p, q in zip(pts, pts[1:]):
                if max(p[0], q[0]) < self.main_x - 1:
                    continue   # the left gutter is all parallel tracks: its labels may sit across them
                self.label_boxes.append((min(p[0], q[0]) - LINE_HALO, min(p[1], q[1]) - LINE_HALO,
                                         max(p[0], q[0]) + LINE_HALO, max(p[1], q[1]) + LINE_HALO))
        for e, pts, gutter_left in planned:
            self.routed.append(self._decorate(e, pts, gutter_left=gutter_left))

    # ---- keeping edges out of boxes ------------------------------------------------------------
    def _clear_route(self, e: dict, pts: list[list[float]], a: dict, b: dict) -> list[list[float]]:
        """Keep the planned route if it crosses no box; otherwise take the first clean alternative
        (drop out of the source's bottom and run along the row gap; or round the right gutter).
        If none is clean, keep the plan and RECORD it: build warns, verify fails."""
        if not self._crossed(pts, a, b):
            return pts
        for candidate in (self._via_row_gap(a, b), self._via_gutter(a, b, from_bottom=False),
                          self._via_gutter(a, b, from_bottom=True)):
            if not self._crossed(candidate, a, b):
                return candidate
        self.warnings.append(f"edge {e['from']}→{e['to']}: every route crosses {self._crossed(pts, a, b)}")
        return pts

    def _crossed(self, pts: list[list[float]], a: dict, b: dict) -> str:
        """Id of the first box a route passes through (its own ends, their containers and their
        children excluded), or '' when the route is clear."""
        skip = {a["id"], b["id"]} | {self.steps.get(x, {}).get("parent") for x in (a["id"], b["id"])}
        for n in self.nodes.values():
            if n["id"] in skip or self.steps.get(n["id"], {}).get("parent") in (a["id"], b["id"]):
                continue
            if any(_segment_hits(p, q, n) for p, q in zip(pts, pts[1:])):
                return n["id"]
        return ""

    def _via_row_gap(self, a: dict, b: dict) -> list[list[float]]:
        sx = a["x"] + a["w"] - 2 * TRACK_GAP             # right of the spine line, left of the loop
        gy = a["y"] + a["h"] + ROW_GAP * ROW_GAP_LANE
        bx = min(max(sx, b["x"] + TRACK_GAP), b["x"] + b["w"] - TRACK_GAP)
        end_y = b["y"] if b["y"] > gy else b["y"] + b["h"]   # enter from above, or from below
        return [[sx, a["y"] + a["h"]], [sx, gy], [bx, gy], [bx, end_y]]

    def _via_gutter(self, a: dict, b: dict, from_bottom: bool) -> list[list[float]]:
        gx = self._right_edge() + GUTTER_PAD + self.detours * TRACK_GAP
        self.detours += 1
        y2 = b["y"] + b["h"] / 2
        end = [b["x"] + b["w"], y2]
        if not from_bottom:
            y1 = self._side_y(a)
            return [[a["x"] + a["w"], y1], [gx, y1], [gx, y2], end]
        sx, gy = a["x"] + a["w"] - 2 * TRACK_GAP, a["y"] + a["h"] + ROW_GAP * ROW_GAP_LANE
        return [[sx, a["y"] + a["h"]], [sx, gy], [gx, gy], [gx, y2], end]

    def _right_edge(self) -> float:
        """Right-most point any node or self-loop label reaches — the right gutter starts past it."""
        right = 0.0
        for n in self.nodes.values():
            extra = LOOP_DX + LABEL_OFFSET + self._widest_loop_label() if self._has_loop(n["id"]) and "sub" not in n["cls"] else 0
            right = max(right, n["x"] + n["w"] + extra)
        return right

    def _span(self, e: dict) -> int:
        return abs(self.rank[self._outer(e["from"])] - self.rank[self._outer(e["to"])])

    def _forward(self, a: dict, b: dict, nth: int = 0) -> list[list[float]]:
        if nth:   # a second edge between the same pair (e.g. "done" and "skip") runs beside the first
            return self._parallel(a, b, nth)
        ax, ay = _shared_x(a, b), a["y"] + a["h"]
        bx = min(max(ax, b["x"] + TRACK_GAP), b["x"] + b["w"] - TRACK_GAP)  # enter a wide box under the source
        if b["y"] <= a["y"] + a["h"] / 2:                                    # same row: side to side
            y = a["y"] + a["h"] / 2
            return [[a["x"] + a["w"], y], [b["x"], y]] if b["x"] > a["x"] else [[a["x"], y], [b["x"] + b["w"], y]]
        if b["x"] >= a["x"] + a["w"]:                                        # into a lane on the right
            y = self._side_y(a)
            tx = b["x"] + b["w"] / 2
            return [[a["x"] + a["w"], y], [tx, y], [tx, b["y"]]]
        if abs(ax - bx) < 1 and not self._blocked(ax, ay, b["y"], a, b):
            return [[ax, ay], [bx, b["y"]]]
        if not self._blocked(bx, ay, b["y"], a, b):
            mid = ay + ROW_GAP / 2
            return [[ax, ay], [ax, mid], [bx, mid], [bx, b["y"]]]
        # Something sits in the straight corridor: detour through the right gutter.
        gx = max(n["x"] + n["w"] for n in self.nodes.values()) + GUTTER_PAD
        if self._has_right_neighbour(a):
            # The right side belongs to whatever sits beside it; leave from the bottom, along the row gap.
            sx, gy = a["x"] + a["w"] - 2 * TRACK_GAP, a["y"] + a["h"] + ROW_GAP * ROW_GAP_LANE
            return [[sx, a["y"] + a["h"]], [sx, gy], [gx, gy],
                    [gx, b["y"] - ROW_GAP / 3], [bx, b["y"] - ROW_GAP / 3], [bx, b["y"]]]
        y = self._side_y(a)
        return [[a["x"] + a["w"], y], [gx, y],
                [gx, b["y"] - ROW_GAP / 3], [bx, b["y"] - ROW_GAP / 3], [bx, b["y"]]]

    def _has_right_neighbour(self, a: dict) -> bool:
        r = self.rank.get(a["id"])
        return any(self.rank[n] == r and self.lane[n] > self.lane[a["id"]] for n in self.rank if n != a["id"])

    def _parallel(self, a: dict, b: dict, nth: int) -> list[list[float]]:
        # Beside the first edge, near the right of the boxes' shared span, when there is room for
        # the first edge's chips in between; otherwise round the right side into the target's flank.
        hi = min(a["x"] + a["w"], b["x"] + b["w"]) - TRACK_GAP * nth
        first = _shared_x(a, b)
        if b["y"] > a["y"] + a["h"] and hi - first >= PARALLEL_MIN_SPLIT:
            return [[hi, a["y"] + a["h"]], [hi, b["y"]]]
        x = max(a["x"] + a["w"], b["x"] + b["w"]) + nth * PARALLEL_GAP
        y1 = a["y"] + a["h"] * SIDE_EXIT_FRACTION
        y2 = b["y"] + b["h"] / 2
        return [[a["x"] + a["w"], y1], [x, y1], [x, y2], [b["x"] + b["w"], y2]]

    def _blocked(self, x: float, y0: float, y1: float, a: dict, b: dict) -> bool:
        for n in self.nodes.values():
            if n is a or n is b or "_dx" in n or self._inside(n, a) or self._inside(n, b):
                continue
            if n["x"] <= x <= n["x"] + n["w"] and y0 < n["y"] + n["h"] and n["y"] < y1:
                return True
        return False

    def _inside(self, n: dict, box: dict) -> bool:
        return self.steps.get(n["id"], {}).get("parent") == box["id"]

    def _decorate(self, e: dict, pts: list[list[float]], gutter_left: bool = False) -> dict:
        out = {"from": e["from"], "to": e["to"], "kind": e["kind"], "pts": pts,
               "label": self._display_label(e), "when": e["when"], "triggers": e["triggers"]}
        if out["triggers"]:
            out["tpos"] = self._place_chips(e, pts)
        if out["label"]:
            w = min(LOOP_LABEL_MAX_W, _text_w(out["label"]))
            if gutter_left:   # the label lives in the gutter, left of its track: wrap to what fits
                w = min(w, max(GUTTER_LABEL_MIN_W, pts[1][0] - 2 * LABEL_OFFSET))
            h = _lines(out["label"], LABEL_CHAR_W, w - LABEL_PAD_W) * LABEL_LINE_H
            anchor = [pts[1][0] - LABEL_OFFSET - w, (pts[1][1] + pts[2][1]) / 2 - h / 2] if gutter_left \
                else self._label_anchor(e, pts, w)
            out["lpos"] = self._place(anchor, w, h, f"label on {e['from']}→{e['to']}")
            out["lw"] = w
        return out

    def _place_chips(self, e: dict, pts: list[list[float]]) -> list[float]:
        """Chips must stay ON the edge, next to its source — a chip nudged beside another step reads as
        that step's chain (the drift this whole generator exists to prevent). Try the first run out of
        the source, then the run after the first bend; within a run, only positions along it; else warn."""
        what = f"chips on {e['from']}→{e['to']}"
        for run in range(min(CHIP_RUNS, len(pts) - 1)):
            spot = self._chip_spot(e, pts[run], pts[run + 1])
            if spot:
                return spot
        w = _chips_w(e["triggers"], self.flow)
        anchor = self._chip_anchor(pts)
        self.warnings.append(f"{what}: no free spot on the edge's first runs — shorten the chip names, "
                             f"or give the step's row more room")
        self.label_boxes.append((anchor[0], anchor[1], anchor[0] + w, anchor[1] + CHIP_H))
        return [round(anchor[0], 1), round(anchor[1], 1)]

    def _chip_spot(self, e: dict, p: list[float], q: list[float]) -> list[float] | None:
        w = _chips_w(e["triggers"], self.flow)
        (x1, y1), (x2, y2) = p, q
        if abs(x1 - x2) < 1:   # vertical run: any height along it, right side first, then left
            lo, hi = min(y1, y2), max(y1, y2) - CHIP_H
            sides = [x1 + LABEL_OFFSET * 2, x1 - LABEL_OFFSET * 2 - w]
        else:                  # horizontal run: anywhere along it, just above it or just below it
            lo = hi = None
            start, end = min(x1, x2) + LABEL_OFFSET, max(x1, x2) - w
            sides = [start + k * LABEL_NUDGE for k in range(int(max(0, end - start) // LABEL_NUDGE) + 1)]
        anchor = self._chip_anchor([p, q])
        heights = ([anchor[1]] + [anchor[1] + d * LABEL_NUDGE * k for k in range(1, LABEL_NUDGE_TRIES) for d in (1, -1)]
                   if lo is not None else [min(y1, y2) - CHIP_H - LABEL_OFFSET / 2, max(y1, y2) + LABEL_OFFSET / 2])
        for x in sides:
            for y in heights:
                if lo is not None and not (lo <= y <= max(lo, hi)):
                    continue
                box = (x, y, x + w, y + CHIP_H)
                if not any(_overlap(box, other) for other in self.label_boxes):
                    self.label_boxes.append(box)
                    return [round(x, 1), round(y, 1)]
        return None

    def _chip_anchor(self, pts: list[list[float]]) -> list[float]:
        # On the FIRST run out of the source: chips belong to the step that fires them, and on a
        # long edge the far end sits beside some other step.
        (x1, y1), (x2, y2) = pts[0], pts[1]
        if abs(x1 - x2) < 1:   # vertical: chips sit just right of the line, centred on it
            return [x1 + LABEL_OFFSET * 2, (y1 + y2) / 2 - CHIP_H / 2]
        return [min(x1, x2) + LABEL_OFFSET, min(y1, y2) - CHIP_H - LABEL_OFFSET / 2]

    def _label_anchor(self, e: dict, pts: list[list[float]], w: float) -> list[float]:
        if e["from"] == e["to"]:
            return [pts[1][0] + LABEL_OFFSET, (pts[1][1] + pts[2][1]) / 2 - LABEL_LINE_H / 2]
        (x1, y1), (x2, y2) = _longest_segment(pts)
        if abs(x1 - x2) < 1:
            if e["triggers"]:   # chips own the right side; the label goes left of the line
                return [x1 - LABEL_OFFSET - w, (y1 + y2) / 2 - LABEL_LINE_H / 2]
            return [x1 + LABEL_OFFSET, (y1 + y2) / 2 - LABEL_LINE_H / 2]
        # Horizontal: centred over the run, clear of whatever sits at either end.
        return [(x1 + x2) / 2 - w / 2, min(y1, y2) - LABEL_LINE_H - LABEL_OFFSET / 2]

    def _side_y(self, a: dict) -> float:
        """The y of the next right-side exit of ``a``. Each exit gets its own height below the
        self-loop band, so two edges leaving the same side never share a horizontal run."""
        k = self.side_exits.get(a["id"], 0)
        self.side_exits[a["id"]] = k + 1
        return a["y"] + a["h"] * max(SIDE_EXIT_MIN, SIDE_EXIT_FRACTION - k * SIDE_EXIT_STEP)

    def _place(self, anchor: list[float], w: float, h: float, what: str) -> list[float]:
        """Put a label at the free spot nearest its anchor: below, above, further below, further above…

        If every candidate collides, keep the anchor and RECORD it — build.py prints layout warnings
        and verify.py fails on them, so a crowded graph is never shipped silently."""
        x, y0 = anchor
        for step in range(2 * LABEL_MAX_DRIFT + 1):   # never drift so far it reads as another edge's
            dy = LABEL_NUDGE * ((step + 1) // 2) * (1 if step % 2 else -1) if step else 0
            box = (x, y0 + dy, x + w, y0 + dy + h)
            if not any(_overlap(box, other) for other in self.label_boxes):
                self.label_boxes.append(box)
                return [round(x, 1), round(y0 + dy, 1)]
        self.warnings.append(f"{what}: no free spot near ({x:.0f}, {y0:.0f}) — give the outcome a shorter "
                             f"`label` (two or three words); the full `when` stays in the panel")
        self.label_boxes.append((x, y0, x + w, y0 + h))
        return [round(x, 1), round(y0, 1)]

    # ---- output -------------------------------------------------------------------------------
    def result(self) -> dict:
        right = max(n["x"] + n["w"] for n in self.nodes.values())
        right = max([right] + [x for e in self.routed for x, _ in e["pts"]]
                    + [e["lpos"][0] + e.get("lw", 0) for e in self.routed if "lpos" in e]
                    + [e["tpos"][0] + CHIP_MAX_W / 2 for e in self.routed if "tpos" in e])
        width = math.ceil(right + CANVAS_PAD)
        height = math.ceil(max(self.height_rows, max(n["y"] + n["h"] for n in self.nodes.values()) + BAND_PAD))
        return {"nodes": [self._public(n) for n in self.nodes.values()], "edges": self.routed,
                "stages": self._bands(height), "width": width, "height": height, "warnings": self.warnings}

    def _public(self, n: dict) -> dict:
        return {k: (round(v, 1) if isinstance(v, float) else v) for k, v in n.items()}

    def _bands(self, height: float) -> list[dict]:
        bands = []
        for stage in self.flow["stages"]:
            members = [self.nodes[n] for n in self.rank if n in self.steps and self.steps[n]["stage"] == stage["id"]]
            if not members:
                continue
            bands.append({"id": stage["id"], "name": stage["name"], "y0": min(m["y"] for m in members) - BAND_PAD})
        for i, band in enumerate(bands):
            band["y1"] = bands[i + 1]["y0"] if i + 1 < len(bands) else height
        if bands:
            bands[0]["y0"] = 0
        return bands


# ---- pure geometry helpers ---------------------------------------------------------------------
def _lines(text: str, char_w: float, width: float) -> int:
    return max(1, math.ceil(len(text) * char_w / max(width, 1)))


def _text_w(text: str) -> float:
    return len(text) * LABEL_CHAR_W + LABEL_PAD_W


def _chips_w(tids: list[str], flow: dict) -> float:
    w = sum(len(flow["triggers"][t]["short"]) * CHIP_CHAR_W + CHIP_PAD_W for t in tids)
    return min(CHIP_MAX_W, w + CHIP_ARROW_W * (len(tids) - 1))


def _short(text: str, limit: int = 48) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _overlap(a: tuple, b: tuple) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _longest_segment(pts: list[list[float]]) -> tuple[list[float], list[float]]:
    return max(zip(pts, pts[1:]), key=lambda s: math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]))


def _self_loop(n: dict, small: bool, nth: int = 0) -> list[list[float]]:
    # A second loop on the same node (two different "stay here" outcomes) nests outside the first.
    dx = (LOOP_DX / 2 if small else LOOP_DX) * (1 + nth * LOOP_NEST)
    x = n["x"] + n["w"]
    spread = nth * LOOP_NEST_SPREAD
    y1, y2 = n["y"] + n["h"] * (LOOP_TOP - spread), n["y"] + n["h"] * (LOOP_BOTTOM + spread)
    return [[x, y1], [x + dx, y1], [x + dx, y2], [x, y2]]


def _back_edge(a: dict, b: dict, gx: float, side: str) -> list[list[float]]:
    # The right side also carries the node's self-loop, so a right exit leaves below it.
    y1 = a["y"] + a["h"] * (BACK_EXIT_FRACTION if side == "left" else SIDE_EXIT_FRACTION)
    y2 = b["y"] + min(b["h"] * BACK_ENTRY_FRACTION, CONTAINER_HEAD_H / 2)
    ax = a["x"] if side == "left" else a["x"] + a["w"]
    bx = b["x"] if side == "left" else b["x"] + b["w"]
    return [[ax, y1], [gx, y1], [gx, y2], [bx, y2]]


def _shared_x(a: dict, b: dict) -> float:
    """Where to leave ``a`` so the edge can drop straight into ``b``.

    Prefer ``a``'s own centre (the spine stays one straight line), then ``b``'s centre, both only
    when inside the horizontal overlap of the two boxes; with no overlap, ``a``'s centre.
    """
    lo, hi = max(a["x"], b["x"]) + TRACK_GAP, min(a["x"] + a["w"], b["x"] + b["w"]) - TRACK_GAP
    a_mid, b_mid = a["x"] + a["w"] / 2, b["x"] + b["w"] / 2
    if lo > hi or lo <= a_mid <= hi:
        return a_mid
    return min(max(b_mid, lo), hi)


def _segment_hits(p: list[float], q: list[float], n: dict) -> bool:
    """Does the axis-aligned segment p→q pass through box n (its 1 px border excluded)?"""
    x0, x1 = sorted((p[0], q[0]))
    y0, y1 = sorted((p[1], q[1]))
    return (x0 < n["x"] + n["w"] - EDGE_CLEARANCE and n["x"] + EDGE_CLEARANCE < x1 + (x0 == x1)
            and y0 < n["y"] + n["h"] - EDGE_CLEARANCE and n["y"] + EDGE_CLEARANCE < y1 + (y0 == y1))


def _side_exit(a: dict, b: dict) -> list[list[float]]:
    y = a["y"] + a["h"] * SIDE_EXIT_FRACTION
    return [[a["x"] + a["w"], y], [b["x"], y]]
