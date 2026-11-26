/**
 * `verify` — real-world verification only (spec requirements 12, 14-16, 18, 40-45; plan D3, D5,
 * Phase 5).
 *
 * `verify --workspace <path> <component>... --stage <name> [--target <name>]
 *         [--expect <sha|tag>] [--check <name>[,<name>...]] [--json]`
 *
 * - `--stage` is REQUIRED: verification blocks are declared per stage, `--expect` names one
 *   version, and `promote`'s landed proof always concerns one stage. (`status --verify` covers
 *   every stage in its scope.)
 * - `--target`, `--expect` and `--check` each require exactly ONE component (target and check
 *   names belong to that component's `component.json`; one expected version fits one build).
 * - `--target <t>` selects the checks declared for target `t` plus the stage-wide checks (no
 *   `target`). `--check` selects checks by name and is the EXPLICIT request of spec 40a: naming a
 *   smoke check on a stage the operator's team does not own → exit 26 before anything runs.
 *
 * Order (each step only after every earlier one succeeded):
 * 1. arguments (64); 2. workspace skeleton (24) → component and stage names (64);
 * 3. full load with the canonical gate (24, 29; a requested unavailable member → 24);
 * 4. plan: target and check names (64), `--expect` shape (64);
 * 5. header env-var preflight over the selected runnable checks (20) — before ANY call;
 * 6. explicit smoke on a non-owned stage (26) — 20 wins over 26 by running first (precedence);
 * 7. when a runnable version check needs an expected version and `--expect` is absent: the live
 *    status read of the stage (adapter preflight 20/21 — fail-whole-run — then read and git);
 * 8. run the checks → exit 0 (all PASS / nothing ran), 28 (any FAIL), 30 (UNREACHABLE or
 *    INCONCLUSIVE and no FAIL).
 *
 * `verify` writes no snapshot (spec 50 assigns snapshots to `status`; `status --verify` writes
 * one holding the verification results). It is read-only: GET/HEAD to applications, read-only
 * adapter and git calls, and smoke argv commands whose read-only-ness is the config author's
 * responsibility.
 */
import { argumentError } from "../args.js";
import { EXIT } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { observeStage, planTargets, preflightAndRead } from "../observe.js";
import { REPORT_SCHEMA_VERSION, colours, renderVerification, useColour, verificationRan } from "../report.js";
import { expectedFromObserved, headerPreflight, needsExpectedVersion, planVerification, refuseExplicitSmoke, runVerification, validateExpect, } from "../verify.js";
import { loadWorkspace, loadWorkspaceSkeleton, requireAvailableMember } from "../workspace.js";
function validateNames(options, stages, members) {
    const duplicates = options.components.filter((name, index) => options.components.indexOf(name) !== index);
    if (duplicates.length > 0)
        throw argumentError(`component named twice: ${[...new Set(duplicates)].join(", ")}`);
    const unknown = options.components.filter((name) => !members.includes(name));
    if (unknown.length > 0) {
        throw argumentError(`unknown component${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")} (members: ${members.join(", ")})`);
    }
    const stage = stages.find((candidate) => candidate.name === options.stage);
    if (stage === undefined)
        throw argumentError(`unknown stage "${options.stage}" (stages: ${stages.map((s) => s.name).join(", ")})`);
    return stage;
}
/** Runs `verify`. @throws EngineError for every exit that produces no report (64, 24, 29, 20, 21, 26, 1). */
export async function runVerify(options, context) {
    if (options.components.length === 0)
        throw argumentError("verify needs a component name");
    if (options.components.length > 1) {
        for (const [flag, value] of [["target", options.target], ["expect", options.expect], ["check", options.checks]]) {
            if (value !== null)
                throw argumentError(`--${flag} needs exactly one component (got ${options.components.length})`);
        }
    }
    // 2. Names before any call.
    const skeleton = loadWorkspaceSkeleton(options.workspace);
    const ws = skeleton.workspace;
    const stage = validateNames(options, ws.stages, ws.members.map((member) => member.name));
    // 3. Full load; non-canonical input → 29; a requested unavailable member → 24.
    const loaded = loadWorkspace(options.workspace, { members: options.components, canonical: "require" });
    const members = options.components.map((name) => requireAvailableMember(loaded, name));
    // 4. Plan (unknown target / check → 64) and --expect shape (64).
    const plan = planVerification(ws, members.map((member) => ({ component: member.member.name, config: member.component, stage })), { target: options.target, checks: options.checks });
    if (options.expect !== null)
        validateExpect(plan, options.expect);
    // 5-6. Header preflight (20), then the explicit-smoke refusal (26) — both before any call.
    headerPreflight(plan, context.env);
    refuseExplicitSmoke(plan);
    // 7. The live status read, only when a version check needs it.
    let preflight = [];
    const observed = new Map();
    let expectedVersionSource = "not-needed";
    if (needsExpectedVersion(plan)) {
        if (options.expect !== null)
            expectedVersionSource = "expect";
        else {
            expectedVersionSource = "status";
            const planned = planTargets(members, [stage]);
            const read = await preflightAndRead(ws, planned, context.env);
            preflight = read.preflight;
            for (const member of members) {
                const entry = member.component.stages[stage.name];
                if (entry === null || entry === undefined)
                    continue;
                observed.set(member.member.name, observeStage(ws, member, stage, entry.targets, read.readings, ws.gitTimeoutSeconds * 1000));
            }
        }
    }
    // 8. Run.
    const expectFlag = options.expect;
    const results = await runVerification(plan, context.env, (entry) => {
        if (entry.check.type !== "version")
            return null;
        if (expectFlag !== null)
            return { kind: "known", value: expectFlag, source: "expect" };
        return expectedFromObserved(entry.check, observed.get(entry.component) ?? []);
    });
    const verification = verificationRan(plan.blocks, results);
    const exitCode = verification.exitCode ?? EXIT.OK;
    const phase = exitCode === EXIT.OK ? "complete" : "verification";
    const report = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        engineVersion: engineVersion(),
        command: "verify",
        generatedAt: context.now().toISOString(),
        workspace: { root: loaded.root, file: loaded.file, operatorTeam: ws.operatorTeam ?? null },
        scope: { components: [...options.components], stage: stage.name, target: options.target, checks: options.checks === null ? null : [...options.checks], expect: options.expect },
        expectedVersionSource,
        preflight,
        verification,
        outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
    };
    const stderr = [];
    if (exitCode === EXIT.VERIFY_FAILED)
        stderr.push(`release-radar: real-world verification FAILED (${verification.summary?.fail ?? 0} check(s) answered but did not meet the expectation)`);
    if (exitCode === EXIT.VERIFY_INCONCLUSIVE) {
        stderr.push("release-radar: real-world verification inconclusive — no check FAILED, but at least one got no answer (UNREACHABLE) or had no expected version (INCONCLUSIVE); this is NOT a failure verdict");
    }
    let stdout;
    if (options.json)
        stdout = `${JSON.stringify(report, null, 2)}\n`;
    else {
        const c = colours(useColour(false, context.stdout, context.env));
        const lines = [
            `release-radar verify — workspace ${loaded.root}, stage ${stage.name} (read-only)`,
            "",
            ...renderVerification(verification, c),
        ];
        if (expectedVersionSource === "expect")
            lines.push(c.dim(`  expected version: --expect ${options.expect ?? ""}`));
        if (expectedVersionSource === "status")
            lines.push(c.dim("  expected version: from a live status read of the stage in this run"));
        for (const entry of preflight)
            lines.push(c.dim(`  preflight ${entry.adapter}: ${entry.commands.join("; ") || "(no command)"}`));
        stdout = `${lines.join("\n")}\n`;
    }
    return { exitCode, phase, stdout, stderr, json: options.json };
}
