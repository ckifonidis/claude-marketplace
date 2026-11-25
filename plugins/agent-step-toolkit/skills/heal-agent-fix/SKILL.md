---
name: heal-agent-fix
description: Implement and verify a focused repair in an existing agent-step agent. Use when the user selects an audit finding or directly requests a fix to instruction placement, tool routing or workflow progression.
---

# Fix an agent-step finding

Start from the selected audit finding or a directly reported defect. Use the current conversation when the user refers to an earlier finding. If no target can be identified, ask which behavior to fix. A direct report can supply the contract without a prior audit. Work one cause at a time within the requested scope.

1. **Confirm the target.** Check the current revision, installed runner, tool mode and graph entry point. Recover any missing facts about the trigger, expected behavior, proposed owner and acceptance condition. Resolve a genuine product ambiguity with the user before changing that behavior. [Decision ownership and progression](../heal-agent-audit/references/decision-ownership.md)
2. **Capture the baseline.** Reproduce the target and nearest control before editing. Preserve a control outside tuning and include affected languages. For a measured simplification, record the routing calls and actual effects. For a model decision, fix the deployment, settings, histories, sample count and pass condition up front. Follow the project's plan or use three independent runs per case for quick feedback.
3. **Repair the earliest cause.** Change the owning instruction or guarded code path and remove competing wording or dispatch for that decision. Preserve unrelated instructions and caller choices. Prefer the downstream integration when the installed runner already provides the mechanism. Inspect the actual assembled surface after the change.
4. **Prove the behavior at the owning layer.** Use the smallest checks that expose the failure through the normal entry point. [Agent-step test methodology](../test-agent-step/SKILL.md)
   - Unit-test affected guards and state transitions. For automatic dispatch, enter the normal graph or host with only the initiating request and make the test fail on an intervening model routing call.
   - In the sandbox, check committed state and count observable writes on success, denial, replay and partial failure. Confirm that recovery preserves the original request, gates and counters.
   - Where the model chooses or speaks, test the first raw call and arguments or the spoken reply on the selected deployment. Count host corrections separately. Check host-rendered wording at delivery.
5. **Verify and report.** Rerun the predeclared cases and held-out control, then run the applicable build and broader regressions. Report the finding identifier or direct target, owning change, before/after counts and observed effects. Name failed or unrun checks and distinguish independently reproduced baseline failures. Close the repair when the target and controls pass and any new regressions are resolved.
