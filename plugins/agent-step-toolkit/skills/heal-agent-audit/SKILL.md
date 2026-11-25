---
name: heal-agent-audit
description: Review an existing agent-step agent for misplaced or conflicting instructions, ambiguous tool routing, and unnecessary model calls. Use for a read-only diagnosis and findings that can be handed to heal-agent-fix.
---

# Audit an agent-step agent

Keep the downstream checkout read-only. Run checks that create files or change test data in a disposable copy or sandbox. Return findings in the conversation unless the requester specifies a report destination. Review the named behavior. With no target specified, survey the agent's exposed actions.

1. **Establish the contract.** Identify the caller's intent, starting state, expected outcome and forbidden effects. Locate the graph entry point, installed runner, tool mode and applicable tests. Start with risks to consent or duplicate writes.
2. **Trace what actually happens.** Follow the effective prompt and tool schema, first raw model decision, host and runner checks, executor result, committed state and caller-visible reply. Use existing traces or isolated checks to identify the earliest divergence. Record which parts you observed.
3. **Assign the decision.** Use the shared criteria to identify who knows the deciding fact and when. Check instructions that govern the same trigger across the prompt, tool, field and verdict. Check deterministic transitions against the actual execution path. [Decision ownership and progression](references/decision-ownership.md)
4. **Classify the result.** A reproduced contract violation is a defect. A passing flow with avoidable model work is a simplification. Mark unverified behavior and unresolved product choices explicitly. Give the benefit and tradeoff of the proposed placement. Call out correct caller waits or other controls a repair must preserve.

## Handoff

Give each finding a short, stable identifier so the user can select it. Include the following information once per finding.

| Field | What to record |
| --- | --- |
| Behavior | Trigger and starting state, expected versus observed result, and any forbidden effect. |
| Evidence | Classification, source location, relevant revision or tool mode, and reproduction or trace. Include failed and unrun checks. |
| Ownership | Where the decision lives now, its proposed owner, the benefit and tradeoff, and any business decision still open. |
| Acceptance | An observable success condition, the nearest case that must behave differently, and the consent or side-effect boundary to preserve. |

Finish with the findings and evidence, including when the reviewed behavior is already correct. A selected finding is ready for [heal-agent-fix](../heal-agent-fix/SKILL.md).
