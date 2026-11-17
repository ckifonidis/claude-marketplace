# Pizza order — phone agent step ladder

The ladder a phone agent walks to take one pizza order, from greeting to delivery.

**Source of truth for the flow:** the product owner's call walkthrough (synthetic).

**Step engine:** agent-step 3.0.1.

| File | What it holds |
|---|---|
| `pizza-order.html` | The graph. Click any box for what that step gathers, when it completes, what it triggers, where it goes next and which real routes it uses. The tabs repeat the sheet. |
| `pizza-order.xlsx` | The step sheet. Tabs: **Steps**, **Triggers & APIs**, **Menu fields**, **Open & TBD**. |
| `pizza-order.md` | This design document. |

The graph, the sheet and this document come from the same data, so they cannot disagree. Edit the spec, then rebuild: `uvx --with openpyxl python3 ../../templates/flowdoc/build.py pizza_order.py --out out`

---

## 1. Two words the whole ladder uses

- A **step** keeps gathering until a completeness check passes. On every turn it acknowledges what it received and lists what is still pending.
- A **trigger** is a plain API call fired when a step completes. When a step has several, they run **in order**, and the first failure stops the chain and decides where the flow goes next.

Two consequences follow. Human input between two backend calls forces a new step. Consecutive calls with nothing gathered between them stay together as one step's trigger chain, run by that step's single closing action.

## 2. The ladder

```
A  P0       Greeting & order type                     → P1
B  P1       Identify the caller    ⚡ lookup           → P2 | P2B
   P2       Delivery address       ⚡ zone check       → P3
   P2B      Pick the store                            → P3
C  P3       Build the order                           → P4
        C1  Pizzas                                    → P3
        C2  Sides & drinks                            → P3
        C3  Dietary notes                             → P3
        CX  Menu questions                            → P3
D  P4       Review & confirm       ⚡ quote → ⚡ place  → P5
   P5       Payment method         ⚡ send code        → P7 | P6
   P6       Card payment code      ⚡ charge           → P7
E  P7       Kitchen & tracking     ⚡ status           → P8
   P8       Tip & feedback         ⚡ feedback         → END
```

In total: 10 ladder steps, 4 sub-steps and 8 triggers.

| Status | Steps | Triggers |
|---|---|---|
| exists | 5 | 2 |
| needs change | 4 | 3 |
| new | 4 | 1 |
| TBD | 1 | 2 |

The xlsx has every row in full. The sections below cover only the places where a decision was needed.

## 3. How the ladder runs on agent-step

Every mechanism below is agent-step configuration, not prompt prose.

| Ladder concept | agent-step primitive |
|---|---|
| “We are in step Px” | Host slots (`orderType`, `cart`, `destination`, `orderId`) written by verdict rows' `stateUpdate`; each step's prereq verifier reads them. |
| Gathering with acknowledge / pending | A collection action writing a host slot; pending lists computed in code. |
| Completion clause | A verifier per step, used as the closing action's prereq. |
| Trigger chain | One closing action per step; its executor runs the chain in order and names one verdict row. |
| Read-back before placing | `requiresConfirmation{maxAttempts:3, readBack}` on `place_order`. |
| Payment code | A short `payment` flow: `choose_payment` starts it and `issuesOtp`; `confirm_payment` `requiresOtp` and ends it. |
| Re-ask a bad phone number | `asks` + `captureBounces`, escalating through a ladder. |

Facts that drove this design:

1. A batch stops only on a ✗ verdict row, so a quote whose price changed must be a ✗ row — otherwise the order would be placed at the old price.
2. An address edit after the quote must void the quote: `invalidatesOnChange{address:[quote]}`.
3. While the read-back is pending, only `place_order`, `abort_pending_input`, the handoff or the repeat control may run — and abort clears the gate AND any open flow. An edit therefore aborts and re-enters P3; it is safe only because the cart is a host slot, not flow data.

## 4. The steps where a decision was made

**P4: one closing action for quote + place.**
- The caller confirms the exact read-back; the quote and the order run in one executor.
- A price change is a business outcome, not an error: re-propose with the new total.

**P7: the caller's word never closes a waiting step.**
- “Is it ready?” triggers a status check; only the till's answer moves the flow.

## 5. Brief names vs real routes

| In the brief | Real |
|---|---|
| `GET /customer?phone=` | GET /customers/by-phone/{phone} |
| `POST /basket/price` | POST /orders/quote {items[], destination} |

## 6. What has to be built or changed, ordered by what it unblocks

1. **Move the cart out of flow data into a host slot; keep a flow only around the payment code.** Unblocks: the P4 → P3 edit.
2. **Fold quote + place into `place_order`.** Unblocks: P4.
   - price_changed becomes a ✗ row
3. **Find the card gateway route.** Unblocks: P5, P6 (T5, T6 are TBD).

## 7. Open items

These are listed in the **Open & TBD** sheet, each with the default used until it is decided:

- **Q1** (P6 / T6): Retry numbers for the card charge (≤3, exponential) — accepted? *Default:* Proposal: 3 attempts, 1 s → 4 s.
- **Q2** (P2B): Is the store list served by the till API, or kept in config? *Default:* Config list, refreshed at deploy.
- **Q3** (CX): Where do allergen answers come from? The menu API has no allergen field. *Default:* Answer 'please ask the store' until an allergen source exists.
