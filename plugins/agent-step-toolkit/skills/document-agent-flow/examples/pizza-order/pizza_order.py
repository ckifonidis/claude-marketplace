"""Synthetic example: a phone pizza-ordering agent, documented with flowdoc.

Everything here is invented to exercise every feature of the generator — stage bands, a spine,
a branch lane that rejoins it, a container with sub-steps and a cross-cutting sub-flow, back
edges, self-loops, a side terminal, an optional step and a domain sheet. File paths in
`evidence` point into an imaginary `src/tools/pizza/` project.

    uvx --with openpyxl python3 ../../templates/flowdoc/build.py pizza_order.py --out out
"""

from menu_fields import MENU_COLUMNS, MENU_FIELDS

EXISTS, CHANGE, NEW, TBD = "exists", "change", "new", "tbd"
FAIL, BRANCH, OPT = "fail", "branch", "opt"

RETRY_GRADED = (
    "Transient (5xx, timeout): retry in the executor, at most 3 attempts with exponential backoff "
    "(proposal, see Q1). Validation 4xx: no retry, name the field. Business refusal: no retry."
)
ITEM_ENGINE = (
    "add_item{menuCode, size?, extras[]} · prereqs[orderTypeSet] · verdicts: "
    "added✓→cart (a host slot, so an edit during the read-back cannot lose it) | unavailable✗ (summary names two alternatives) · "
    "asks invalid_params→add_item.menuCode · captureBounces{max:2, ladder: menu_help}"
)
ACTIONS = "src/tools/pizza/actions"


def item_step(sid, title, required, optional, completion):
    """A sub-step of the order hub: gathers one kind of item, saves it, returns to the hub."""
    return {
        "stage": "C", "parent": "P3", "title": title, "required": required, "optional": optional,
        "completion": completion, "triggers": [],
        "next": [
            {"to": "P3", "when": "item added to the cart → back to the hub"},
            {"to": sid, "when": "item unavailable → two alternatives offered", "kind": FAIL},
        ],
        "engine": ITEM_ENGINE, "status": EXISTS,
        "lookups": ["menu read (get_menu, pageable) — today's items and prices"],
    }


STEPS = {
    "P0": {
        "stage": "A", "title": "Greeting & order type", "sub": "delivery or pickup?",
        "opens": "“Thanks for calling. Is this for delivery or pickup?”",
        "required": ["order type = delivery | pickup"],
        "completion": "Order type chosen.",
        "next": [{"to": "P1", "when": "type chosen"}],
        "engine": "start_order{orderType} · no gate · verdicts: set✓→orderType — the journey lives in host slots; no flow is opened here",
        "status": CHANGE, "status_note": ("Today add_item opens an `order` flow and keeps the cart in flow data "
                                          "(src/tools/pizza/actions/add_item/action.ts:14); an edit during the P4 read-back "
                                          "has to abort, which drops the flow and the cart with it."),
    },
    "P1": {
        "stage": "B", "title": "Identify the caller", "sub": "phone number → known customer?",
        "opens": "“Can I have the phone number for the order?”",
        "required": ["phone number (10 digits)"], "optional": ["name, if new"],
        "completion": "Phone number valid; the customer is found or a new record is started.",
        "triggers": ["T1"],
        "next": [
            {"to": "P2", "when": "delivery"},
            {"to": "P2B", "when": "pickup", "kind": BRANCH},
            {"to": "P1", "when": "number invalid → re-ask", "kind": FAIL},
        ],
        "engine": "identify_caller{phone: digits} · prereqs[orderTypeSet] · asks invalid_params→identify_caller.phone:digits · "
                  "captureBounces{max:2} · verdicts: known✓→customer | new✓→customer",
        "status": EXISTS,
    },
    "P2": {
        "stage": "B", "title": "Delivery address", "sub": "saved address offered first",
        "opens": "“Same address as last time — 12 Example Street?”",
        "required": ["street + number", "postcode"], "optional": ["floor / doorbell note"],
        "prefilled": ["last used address (from T1)"],
        "completion": "Address complete and inside a delivery zone.",
        "triggers": ["T2"],
        "next": [
            {"to": "P3", "when": "in zone"},
            {"to": "P2", "when": "out of zone → offer pickup", "kind": FAIL},
        ],
        "engine": "set_address{street, postcode} · invalidatesOnChange{address:[quote]} · verdicts: in_zone✓→address | "
                  "out_of_zone✗ (summary offers pickup)",
        "status": CHANGE, "status_note": "Zone check exists but is called by the model after the fact; move it into set_address.",
    },
    "P2B": {
        "stage": "B", "title": "Pick the store", "sub": "nearest open stores",
        "opens": "“The nearest open stores are Central and Harbour. Which one?”",
        "required": ["store"],
        "completion": "An open store chosen.",
        "next": [{"to": "P3", "when": "store chosen", "kind": BRANCH}],
        "engine": "choose_store{storeCode} · prereqs[orderTypeSet] · verdicts: chosen✓→store | closed✗",
        "status": NEW, "open": ["Q2"],
    },
    "P3": {
        "stage": "C", "title": "Build the order", "sub": "cart hub · names what is still missing · routes to the next item",
        "opens": "Reads the cart back and asks what to add next.",
        "required": ["at least one pizza"],
        "completion": "The caller says the order is complete and the cart has at least one pizza.",
        "next": [{"to": "P4", "when": "cart complete"}],
        "engine": "get_cart{} · no gate (a plain read) · verdicts: shown✓ — the pending list is computed in code from the cart slot, never by the model",
        "status": EXISTS,
    },
    "C1": item_step("C1", "Pizzas", ["pizza", "size", "crust"], ["extra toppings", "half-and-half"],
                    "Every pizza has a size and a crust."),
    "C2": item_step("C2", "Sides & drinks", ["item", "quantity"], [], "Each item has a quantity."),
    "C3": item_step("C3", "Dietary notes", ["allergy or preference, if any"], [], "Answered, or the caller says none."),
    "CX": {
        "stage": "C", "parent": "P3", "cross_cutting": True, "title": "Menu questions — callable from any item",
        "label": "Menu questions",
        "required": ["the caller's question"],
        "completion": "Question answered from the menu data, never from memory.",
        "next": [{"to": "P3", "when": "answered → back where the caller was"}],
        "engine": "ask_menu{question} · no gate · verdicts: answered✓ | unknown✓ (summary says so plainly)",
        "status": TBD, "open": ["Q3"],
    },
    "P4": {
        "stage": "D", "title": "Review & confirm", "sub": "full read-back · confirm or edit",
        "opens": "Reads back every item, the address or store, and the total.",
        "required": ["the caller's yes to the read-back"],
        "completion": "The caller confirms the exact read-back.",
        "triggers": ["T3", "T4"],
        "next": [
            {"to": "P5", "when": "order placed"},
            {"to": "P3", "when": "edit", "kind": FAIL},
            {"to": "TECH", "when": "till system down, retries exhausted", "kind": FAIL},
        ],
        "engine": "place_order{} · prereqs[cartReady, destinationSet] · soleOnExecute · "
                  "requiresConfirmation{maxAttempts:3, readBack} · verdicts: placed✓→orderId | "
                  "price_changed✗ (re-propose) | pos_down✗ backendFailure",
        "status": CHANGE, "status_note": "Quote and place are two model-driven calls today; fold them into one closing action.",
    },
    "P5": {
        "stage": "D", "title": "Payment method", "sub": "card now or cash on delivery",
        "required": ["method = card | cash"],
        "completion": "Method chosen.",
        "next": [
            {"to": "P7", "when": "cash"},
            {"to": "P6", "when": "card", "kind": BRANCH, "triggers": ["T5"]},
        ],
        "triggers": ["T5"],
        "engine": "choose_payment{method} · card: startsFlow payment · issuesOtp{consumer_action: confirm_payment} · "
                  "verdicts: cash✓→payment | card✓ fx:otp_issued — the only flow in this agent spans the payment code",
        "status": NEW,
    },
    "P6": {
        "stage": "D", "title": "Card payment code", "sub": "6-digit code from the bank",
        "opens": "“Your bank sent a 6-digit code. Please read it out.”",
        "required": ["6-digit code"],
        "completion": "The bank accepts the code. The caller's say-so never closes it.",
        "triggers": ["T6"],
        "next": [
            {"to": "P7", "when": "paid", "kind": BRANCH},
            {"to": "P6", "when": "wrong code → re-ask", "kind": FAIL},
            {"to": "P5", "when": "card declined → choose again", "kind": FAIL},
        ],
        "engine": "confirm_payment{code: digits} · requiresFlow payment · requiresOtp · endsFlow · verdicts: paid✓→payment | "
                  "code_invalid✗ | declined✗ fx:abort_flow (only the payment flow dies; the order is in host slots) · "
                  "re-send: resend_payment_code · requiresFlow payment · issuesOtp{consumer_action: confirm_payment} — "
                  "a startsFlow-only issuer is not admitted while the code is pending",
        "status": NEW, "open": ["Q1"],
    },
    "P7": {
        "stage": "E", "title": "Kitchen & tracking", "sub": "caller asks → we always check",
        "opens": "“Your order is in the oven. Anything else I can help with?”",
        "required": ["nothing — waits"],
        "completion": "The till reports the order out for delivery (or ready for pickup).",
        "triggers": ["T7"],
        "next": [
            {"to": "P8", "when": "out for delivery"},
            {"to": "P7", "when": "still baking → check again", "kind": FAIL},
        ],
        "engine": "check_order_status{} · no gate · closing action close_tracking prereqs[dispatched] — the verifier reads "
                  "the till's status slot, never the caller's word",
        "status": CHANGE, "status_note": "Status comes from local state today; ask the till every time.",
    },
    "P8": {
        "stage": "E", "title": "Tip & feedback", "sub": "optional", "optional_step": True,
        "required": ["tip amount or none", "rating 1–5 or skip"],
        "completion": "Answered or skipped.",
        "triggers": ["T8"],
        "next": [
            {"to": "END", "when": "saved", "triggers": ["T8"]},
            {"to": "END", "when": "skipped", "kind": OPT, "label": "skip", "triggers": []},
        ],
        "engine": "leave_feedback{tip?, rating?} · verdicts: saved✓ fx:request_handoff(completed)",
        "status": NEW,
    },
}

TRIGGERS = {
    "T1": {"name": "Customer lookup", "short": "lookup", "spec": "GET /customer?phone=",
           "real": "GET /customers/by-phone/{phone}", "evidence": f"{ACTIONS}/identify_caller/executor.ts:18",
           "on_ok": "known or new → P2 / P2B", "on_fail": ["lookup down → continue as a new customer"],
           "retry": RETRY_GRADED, "status": EXISTS},
    "T2": {"name": "Delivery zone check", "short": "zone check",
           "real": "POST /zones/check {postcode, street}", "evidence": "src/tools/pizza/backend/zones.ts:9",
           "on_ok": "in zone → P3", "on_fail": ["out of zone → stay, offer pickup"], "retry": RETRY_GRADED, "status": CHANGE},
    "T3": {"name": "Price quote", "short": "quote", "spec": "POST /basket/price",
           "real": "POST /orders/quote {items[], destination}", "evidence": f"{ACTIONS}/get_quote/executor.ts:22",
           "on_ok": "total → T4", "on_fail": ["price changed → re-propose with the new total"], "retry": RETRY_GRADED, "status": EXISTS},
    "T4": {"name": "Place the order", "short": "place", "real": "POST /orders {quoteId}",
           "evidence": f"{ACTIONS}/place_order/executor.ts:31",
           "on_ok": "orderId → P5", "on_fail": ["transient → graded retry", "exhausted → TECH, cart held"],
           "retry": RETRY_GRADED, "status": CHANGE},
    "T5": {"name": "Request payment code", "short": "send code", "real": "not found in the till API — card gateway TBD",
           "on_ok": "code sent → P6", "on_fail": ["gateway down → offer cash"], "retry": RETRY_GRADED, "status": TBD},
    "T6": {"name": "Charge the card", "short": "charge", "real": "POST /payments/confirm {orderId, code} (gateway TBD)",
           "on_ok": "paid → P7", "on_fail": ["wrong code → re-ask", "declined → P5"], "status": TBD},
    "T7": {"name": "Order status", "short": "status", "real": "GET /orders/{orderId}/status",
           "evidence": f"{ACTIONS}/check_order_status/executor.ts:12",
           "on_ok": "out for delivery → P8", "on_fail": ["still baking → stay"], "retry": "on demand", "status": CHANGE},
    "T8": {"name": "Save feedback", "short": "feedback", "real": "POST /feedback {orderId, tip, rating}",
           "on_ok": "→ END", "on_fail": ["save failed → thank the caller anyway, log it"], "retry": "none", "status": NEW},
}

OPEN = [
    {"id": "Q1", "question": "Retry numbers for the card charge (≤3, exponential) — accepted?", "where": "P6 / T6",
     "default": "Proposal: 3 attempts, 1 s → 4 s."},
    {"id": "Q2", "question": "Is the store list served by the till API, or kept in config?", "where": "P2B",
     "default": "Config list, refreshed at deploy."},
    {"id": "Q3", "question": "Where do allergen answers come from? The menu API has no allergen field.", "where": "CX",
     "default": "Answer 'please ask the store' until an allergen source exists."},
]

FLOW = {
    "meta": {
        "slug": "pizza-order",
        "engine_version": "3.0.1",
        "title": "Pizza order — phone agent step ladder",
        "subtitle": ("A synthetic example. A box is a step: it gathers until its completeness check passes. ⚡ chips are "
                     "the API calls fired when it closes, in order. Click any box for the details."),
        "intro": "The ladder a phone agent walks to take one pizza order, from greeting to delivery.",
        "source_of_truth": "the product owner's call walkthrough (synthetic).",
        "branch_label": "pickup / card branch",
        "rebuild": "uvx --with openpyxl python3 ../../templates/flowdoc/build.py pizza_order.py --out out",
    },
    "stages": [
        {"id": "A", "name": "Start"}, {"id": "B", "name": "Caller"}, {"id": "C", "name": "Order"},
        {"id": "D", "name": "Checkout"}, {"id": "E", "name": "Delivery"},
    ],
    "steps": STEPS,
    "order": ["P0", "P1", "P2", "P2B", "P3", "C1", "C2", "C3", "CX", "P4", "P5", "P6", "P7", "P8"],
    "terminals": {
        "END": {"label": "Order delivered"},
        "TECH": {"label": "Technical issue — order held, call back", "tone": "bad"},
    },
    "triggers": TRIGGERS,
    "open": OPEN,
    "engine_notes": {
        "intro": "Every mechanism below is agent-step configuration, not prompt prose.",
        "concepts": [
            ("“We are in step Px”", "Host slots (`orderType`, `cart`, `destination`, `orderId`) written by verdict rows' `stateUpdate`; each step's prereq verifier reads them."),
            ("Gathering with acknowledge / pending", "A collection action writing a host slot; pending lists computed in code."),
            ("Completion clause", "A verifier per step, used as the closing action's prereq."),
            ("Trigger chain", "One closing action per step; its executor runs the chain in order and names one verdict row."),
            ("Read-back before placing", "`requiresConfirmation{maxAttempts:3, readBack}` on `place_order`."),
            ("Payment code", "A short `payment` flow: `choose_payment` starts it and `issuesOtp`; `confirm_payment` `requiresOtp` and ends it."),
            ("Re-ask a bad phone number", "`asks` + `captureBounces`, escalating through a ladder."),
        ],
        "facts": [
            "A batch stops only on a ✗ verdict row, so a quote whose price changed must be a ✗ row — otherwise the order would be placed at the old price.",
            "An address edit after the quote must void the quote: `invalidatesOnChange{address:[quote]}`.",
            "While the read-back is pending, only `place_order`, `abort_pending_input`, the handoff or the repeat control may run — and abort clears the gate AND any open flow. An edit therefore aborts and re-enters P3; it is safe only because the cart is a host slot, not flow data.",
        ],
    },
    "decisions": [
        {"step": "P4", "title": "P4: one closing action for quote + place",
         "points": ["The caller confirms the exact read-back; the quote and the order run in one executor.",
                    "A price change is a business outcome, not an error: re-propose with the new total."]},
        {"step": "P7", "title": "P7: the caller's word never closes a waiting step",
         "points": ["“Is it ready?” triggers a status check; only the till's answer moves the flow."]},
    ],
    "changes": [
        {"what": "Move the cart out of flow data into a host slot; keep a flow only around the payment code.", "unblocks": "the P4 → P3 edit"},
        {"what": "Fold quote + place into `place_order`.", "unblocks": "P4", "detail": ["price_changed becomes a ✗ row"]},
        {"what": "Find the card gateway route.", "unblocks": "P5, P6 (T5, T6 are TBD)"},
    ],
    "sheets": [
        {"id": "menu", "title": "Menu fields", "columns": MENU_COLUMNS, "rows": MENU_FIELDS,
         "widths": {"Field": 28, "Rules": 44}},
    ],
}
