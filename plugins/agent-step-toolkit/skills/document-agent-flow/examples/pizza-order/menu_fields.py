"""Domain sheet for the synthetic pizza example: what each order sub-step gathers.

Row shape: (section, field, requirement, multi, prefilled from, rules, ref)
requirement: "M" mandatory · "O" optional (offer, skippable) · "C: <condition>" conditional.
"""

M, O = "M", "O"
YES, NO = "yes", "—"

MENU_COLUMNS = ("Section", "Field", "Required", "Multi-entry", "Prefilled from", "Rules", "Ref")

MENU_FIELDS = [
    ("C1", "Pizza", M, "yes (many pizzas)", NO, "From today's menu only", "walkthrough §2"),
    ("C1", "Size", M, NO, NO, "small | medium | large", "walkthrough §2"),
    ("C1", "Crust", M, NO, "last order (T1)", "thin | classic | stuffed", "walkthrough §2"),
    ("C1", "Extra toppings", O, YES, NO, "Max 5 per pizza", "walkthrough §2"),
    ("C2", "Side or drink", O, YES, NO, "From today's menu only", "walkthrough §3"),
    ("C2", "Quantity", "C: required when an item is chosen", NO, NO, "1–20", "walkthrough §3"),
    ("C3", "Allergy / preference", O, YES, NO, "Free text, read back verbatim", "walkthrough §3"),
]
