/**
 * `status` (spec requirements 12-14, 18, 46-55; plan Phase 4).
 *
 * Order of operations (each step only runs when every earlier one succeeded):
 * 1. arguments (64) — done by the CLI;
 * 2. workspace skeleton (24) → requested component / stage / drift-pair names (64), BEFORE any
 *    adapter or git call;
 * 3. full load with the canonical gate (24, 29);
 * 3a. with `--verify`: plan the verification checks of the scope and run the header env-var
 *    preflight (missing → 20 before ANY adapter call or check; values never read into output);
 * 3b. unless `--no-pipelines`, when pipeline-mapped targets are in scope: the Azure DevOps
 *    preflight — the PAT and its expiry from the environment (absent/empty/expired/unparseable →
 *    20 before ANY request), then Pipelines Get for every declared pipeline (an auth failure → 20,
 *    any other REST failure → 21, both with NO partial report; a pipeline that does not exist is
 *    recorded and becomes exit 23 with the full report);
 * 4. preflight of every adapter the selected scope needs — any failure ends the whole run
 *    (20, or 21 for a non-auth source failure) with NO partial report and NO snapshot;
 * 5. read every target (an auth failure mid-read is 20, never "missing");
 * 6. read-only git resolution (deployed commits, local HEAD);
 * 6b. the latest `runHistoryCount` runs of every found pipeline (Build list, GET only);
 * 7. lifecycle judgements (consistency, cross-stage, deltas, drift — including pipeline/target
 *    drift: the latest succeeded build-kind run built X but the target runs Y, by ancestry);
 * 7a. with `--verify`: run the checks (GET/HEAD only; smoke only on owned stages, never
 *    explicitly requested here so a non-owned smoke is NOT-RUN), the expected version of each
 *    version check coming from THIS run's readings → exit 28 / 30 joins the precedence set;
 * 8. report → snapshot (exits 0/22/23/28/30 only) → exit by precedence
 *    (23 > 28 > 30 > 22).
 *
 * Every Azure DevOps request is a GET through `pipelines/azure-devops-read.ts`; `status` cannot
 * reach a write.
 */
import { EngineError } from "../errors.js";
import { listRuns, mappedTargets, openSession, resolvePipelines } from "../pipelines/collect.js";
import { readSection } from "../pipelines/section.js";
import { effectiveTagConvention } from "../config.js";
import { EXIT, pickExitCode } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { headCommit } from "../git.js";
import { observeStage, planTargets, preflightAndRead } from "../observe.js";
import { LOCAL_LINK, compareStages, computeDeltas, driftFindings, judgeConsistency, localLink, stageLink, stageTriggerability, } from "../lifecycle.js";
import { REPORT_SCHEMA_VERSION, colours, fleetRows, renderHuman, targetReport, useColour, pipelinesNotRead, verificationNotRequested, verificationRan, } from "../report.js";
import { expectedFromObserved, headerPreflight, planVerification, runVerification } from "../verify.js";
import { SNAPSHOT_EXIT_CODES, nextSnapshotFile, writeSnapshot } from "../snapshot.js";
import { configFingerprint, loadWorkspace, loadWorkspaceSkeleton } from "../workspace.js";
import { argumentError } from "../args.js";
import { sleeper } from "./types.js";
/** The token shape of a `--fail-on-drift` pair. */
export const DRIFT_PAIR_TOKEN = /^[^-:][^:]*:[^:]+$/;
function validateNames(options, stages, members) {
    if (options.components !== "all") {
        const duplicates = options.components.filter((name, index) => options.components.indexOf(name) !== index);
        if (duplicates.length > 0)
            throw argumentError(`component named twice: ${[...new Set(duplicates)].join(", ")}`);
        const unknown = options.components.filter((name) => !members.includes(name));
        if (unknown.length > 0) {
            throw argumentError(`unknown component${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")} (members: ${members.join(", ")})`);
        }
    }
    const stageNames = stages.map((stage) => stage.name);
    let scopeStages = [...stages];
    if (options.stage !== null) {
        const stage = stages.find((candidate) => candidate.name === options.stage);
        if (stage === undefined)
            throw argumentError(`unknown stage "${options.stage}" (stages: ${stageNames.join(", ")})`);
        scopeStages = [stage];
    }
    const chain = [LOCAL_LINK, ...scopeStages.map((stage) => stage.name)];
    const pairs = [];
    for (const token of options.failOnDrift.pairs) {
        const [upstream = "", downstream = ""] = token.split(":");
        for (const name of [upstream, downstream]) {
            if (name !== LOCAL_LINK && !stageNames.includes(name)) {
                throw argumentError(`--fail-on-drift ${token}: unknown stage "${name}" (stages: ${LOCAL_LINK}, ${stageNames.join(", ")})`);
            }
            if (!chain.includes(name))
                throw argumentError(`--fail-on-drift ${token}: stage "${name}" is outside the selected --stage`);
        }
        if (chain.indexOf(upstream) >= chain.indexOf(downstream)) {
            throw argumentError(`--fail-on-drift ${token}: "${upstream}" must come before "${downstream}" in the lifecycle (${chain.join(" → ")})`);
        }
        // Deltas exist only for neighbouring pairs (requirement 53); a pair that skips a stage would
        // match no delta and could never trip, so it is refused rather than silently ignored.
        if (chain.indexOf(downstream) !== chain.indexOf(upstream) + 1) {
            throw argumentError(`--fail-on-drift ${token}: "${upstream}" and "${downstream}" are not neighbouring stages (${chain.join(" → ")})`);
        }
        if (pairs.some((pair) => pair.upstream === upstream && pair.downstream === downstream))
            throw argumentError(`--fail-on-drift pair ${token} given twice`);
        pairs.push({ upstream, downstream });
    }
    return { pairs, scopeStages };
}
/**
 * Rewraps an Azure DevOps preflight failure (20 / 21) as a whole-run preflight failure: no
 * partial report is produced (spec requirement 18).
 */
export function pipelinePreflightError(error) {
    if (!(error instanceof EngineError) || (error.exitCode !== EXIT.AUTH && error.exitCode !== EXIT.SOURCE))
        return error;
    const lead = error.exitCode === EXIT.AUTH
        ? "Azure DevOps preflight failed — an authentication problem, NOT \"no runs\" or a missing pipeline; no report was produced (pass --no-pipelines to omit the pipeline sections):"
        : "Azure DevOps preflight failed — no report was produced (pass --no-pipelines to omit the pipeline sections):";
    return new EngineError(error.exitCode, "preflight", `${lead}\n  - ${error.describe()}`);
}
/** The verification plan of the whole scope (every check of every available member's in-scope stage). */
function verificationPlan(ws, available, scopeStages) {
    const scopes = available.flatMap((member) => scopeStages.map((stage) => ({ component: member.member.name, config: member.component, stage })));
    return planVerification(ws, scopes, { target: null, checks: null });
}
function headOf(head) {
    if ("error" in head)
        return { status: "error", detail: head.error };
    return { status: "resolved", sha: head.sha, shortSha: head.sha.slice(0, 7), date: head.date, subject: head.subject };
}
/** Runs `status`. @throws EngineError for every exit that produces no report (64, 24, 29, 20, 21, 1). */
export async function runStatus(options, context) {
    // 2. Names before any adapter or git call.
    const skeleton = loadWorkspaceSkeleton(options.workspace);
    const ws = skeleton.workspace;
    const { pairs, scopeStages } = validateNames(options, ws.stages, ws.members.map((member) => member.name));
    // 3. Full load; non-canonical input → 29.
    const loaded = loadWorkspace(options.workspace, { members: options.components, canonical: "require" });
    const available = loaded.members.filter((resolution) => resolution.status === "available");
    const unavailable = loaded.members.flatMap((resolution) => resolution.status === "unavailable" ? [{ name: resolution.member.name, reason: resolution.reason, detail: resolution.detail }] : []);
    const planned = planTargets(available, scopeStages);
    // 3a. Verification plan + header env-var preflight, before any adapter call or check.
    const plan = options.verify ? verificationPlan(ws, available, scopeStages) : null;
    if (plan !== null)
        headerPreflight(plan, context.env);
    // 3b. Azure DevOps preflight (PAT from the environment, then Pipelines Get), only when needed.
    const mapped = options.noPipelines ? [] : mappedTargets(ws, available, scopeStages);
    let session = null;
    let resolved = new Map();
    if (mapped.length > 0) {
        session = openSession(ws, context.env, { now: context.now, sleep: sleeper(context) });
        try {
            resolved = await resolvePipelines(session.reader, mapped);
        }
        catch (error) {
            throw pipelinePreflightError(error);
        }
    }
    // 4-5. Preflight every adapter needed (any failure ends the run with no partial report), then read.
    const { preflight, readings } = await preflightAndRead(ws, planned, context.env);
    // 6-7. Git and lifecycle, per component.
    const timeoutMs = ws.gitTimeoutSeconds * 1000;
    const components = [];
    const findings = [];
    const missing = [];
    const usedComponents = {};
    /** `<component>/<stage>` → the observed targets of that stage (expected versions for verification). */
    const observedByStage = new Map();
    for (const member of available) {
        const name = member.member.name;
        usedComponents[name] = member.component;
        const head = headCommit(member.clone, timeoutMs);
        const stagesOut = [];
        const deployed = [];
        for (const stage of scopeStages) {
            const convention = effectiveTagConvention(ws, member.component, stage.name);
            const promotion = stageTriggerability(ws, stage);
            const tagConvention = { type: convention.convention.type, source: convention.source };
            const entry = member.component.stages[stage.name];
            if (entry === null || entry === undefined) {
                stagesOut.push({ name: stage.name, status: "not-deployed", tagConvention, promotion, targets: [], consistency: null });
                continue;
            }
            const observed = observeStage(ws, member, stage, entry.targets, readings, timeoutMs);
            for (const target of observed) {
                if (target.reading.status === "missing")
                    missing.push({ component: name, stage: stage.name, target: target.name, detail: target.reading.notes[0] ?? "not found at the source" });
            }
            observedByStage.set(`${name}/${stage.name}`, observed);
            const consistency = judgeConsistency(observed);
            deployed.push({ stage: stage.name, targets: observed, consistency, link: stageLink(stage.name, observed, consistency) });
            stagesOut.push({
                name: stage.name,
                status: "deployed",
                tagConvention,
                promotion,
                targets: observed.map((target, index) => targetReport(target.reading, target.commit, entry.targets[index]?.pipeline !== undefined)),
                consistency,
            });
        }
        const crossStage = [];
        for (let index = 1; index < deployed.length; index++) {
            const up = deployed[index - 1];
            const down = deployed[index];
            crossStage.push(compareStages({ stage: up.stage, targets: up.targets }, { stage: down.stage, targets: down.targets }));
        }
        const deltas = computeDeltas(member.clone, [localLink(head), ...deployed.map((entry) => entry.link)], timeoutMs);
        findings.push(...driftFindings(name, deployed, deltas, pairs));
        components.push({
            name,
            repoKey: member.member.repoKey,
            repoSubdir: member.member.repoSubdir,
            clone: member.clone,
            componentFile: member.componentFile,
            configRevision: "working-tree",
            local: headOf(head),
            stages: stagesOut,
            crossStage,
            deltas,
        });
    }
    // 6b-7. Pipeline-run facts and pipeline/target drift (they join the drift gate).
    let pipelines;
    if (options.noPipelines)
        pipelines = pipelinesNotRead("omitted", "pipelines omitted (--no-pipelines)");
    else if (session === null)
        pipelines = pipelinesNotRead("not-configured", "no pipeline mapping in scope");
    else {
        const settings = ws.azureDevOps;
        if (settings === undefined)
            throw new EngineError(EXIT.INTERNAL, "pipelines", "internal: pipeline mappings without an azureDevOps block");
        let builds;
        try {
            builds = await listRuns(session.reader, resolved, settings.runHistoryCount);
        }
        catch (error) {
            throw pipelinePreflightError(error);
        }
        const read = readSection({
            mapped,
            resolved,
            builds,
            session,
            runHistoryCount: settings.runHistoryCount,
            observed: (component, stage, target) => observedByStage.get(`${component}/${stage}`)?.find((entry) => entry.name === target),
            gitTimeoutMs: timeoutMs,
        });
        pipelines = read.section;
        findings.push(...read.findings);
    }
    // 7a. Verification, with the expected versions from this run's readings.
    let verification = verificationNotRequested();
    if (plan !== null) {
        const results = await runVerification(plan, context.env, (entry) => entry.check.type === "version" ? expectedFromObserved(entry.check, observedByStage.get(`${entry.component}/${entry.stage.name}`) ?? []) : null);
        verification = verificationRan(plan.blocks, results);
    }
    // 8. Exit by precedence, then snapshot, then output.
    const codes = [];
    if (missing.length > 0 || pipelines.missing.length > 0)
        codes.push(EXIT.MISSING);
    const tripped = options.failOnDrift.enabled && findings.length > 0;
    if (tripped)
        codes.push(EXIT.DRIFT);
    if (verification.exitCode !== null)
        codes.push(verification.exitCode);
    const exitCode = pickExitCode(codes);
    const phase = exitCode === EXIT.MISSING
        ? "missing"
        : exitCode === EXIT.VERIFY_FAILED || exitCode === EXIT.VERIFY_INCONCLUSIVE
            ? "verification"
            : exitCode === EXIT.DRIFT
                ? "drift"
                : "complete";
    const generatedAt = context.now().toISOString();
    const scopeStageNames = scopeStages.map((stage) => stage.name);
    let snapshot = null;
    let snapshotFile = null;
    if (SNAPSHOT_EXIT_CODES.includes(exitCode)) {
        snapshotFile = nextSnapshotFile(loaded.root, generatedAt);
        snapshot = { file: snapshotFile, fingerprint: configFingerprint(ws, usedComponents) };
    }
    const report = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        engineVersion: engineVersion(),
        command: "status",
        generatedAt,
        workspace: { root: loaded.root, file: loaded.file, operatorTeam: ws.operatorTeam ?? null },
        scope: { all: options.components === "all", components: loaded.members.map((resolution) => resolution.member.name), stages: scopeStageNames },
        stages: scopeStages.map((stage) => ({ name: stage.name, tagConvention: stage.tagConvention.type, promotion: stageTriggerability(ws, stage) })),
        components,
        unavailable,
        fleet: options.components === "all" ? fleetRows(components, unavailable, scopeStageNames, verification, pipelines) : null,
        preflight,
        pipelines,
        verification,
        drift: { gate: { enabled: options.failOnDrift.enabled, pairs: pairs.map((pair) => `${pair.upstream}:${pair.downstream}`) }, findings, tripped },
        missing,
        outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
        snapshot,
    };
    if (snapshot !== null && snapshotFile !== null) {
        const members = loaded.members.map((resolution) => resolution.status === "available"
            ? { name: resolution.member.name, availability: "available", reason: null, revision: "working-tree" }
            : { name: resolution.member.name, availability: "unavailable", reason: resolution.reason, revision: null });
        writeSnapshot(snapshotFile, {
            schemaVersion: 1,
            engineVersion: report.engineVersion,
            time: generatedAt,
            exitCode,
            fingerprint: snapshot.fingerprint,
            components: components.map((component) => component.name),
            members,
            report: JSON.parse(JSON.stringify(report)),
        });
    }
    const stderr = [];
    if (missing.length > 0)
        stderr.push(`release-radar: ${missing.length} declared target(s) do not exist at the source (exit 23; the report above is complete for everything else)`);
    if (pipelines.missing.length > 0) {
        stderr.push(`release-radar: ${pipelines.missing.length} pipeline-mapped target(s) name a pipeline that does not exist (exit 23; the report above is complete for everything else)`);
    }
    if (pipelines.pat?.warning === true)
        stderr.push(`release-radar: warning — ${pipelines.pat.detail}`);
    if (tripped)
        stderr.push(`release-radar: drift gate tripped (${findings.length} finding(s))`);
    if (verification.exitCode === EXIT.VERIFY_FAILED)
        stderr.push(`release-radar: real-world verification FAILED (${verification.summary?.fail ?? 0} check(s); exit 28 unless an earlier phase wins)`);
    if (verification.exitCode === EXIT.VERIFY_INCONCLUSIVE) {
        stderr.push(`release-radar: real-world verification inconclusive (${(verification.summary?.unreachable ?? 0) + (verification.summary?.inconclusive ?? 0)} check(s) UNREACHABLE or INCONCLUSIVE, none FAILED; exit 30 unless an earlier phase wins)`);
    }
    const stdout = options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderHuman(report, colours(useColour(false, context.stdout, context.env))).join("\n")}\n`;
    return { exitCode, phase, stdout, stderr, json: options.json };
}
