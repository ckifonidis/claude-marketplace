/**
 * `run-pipeline` — the engine's ONLY remote mutation: one queued pipeline run (spec requirements
 * 20, 60-62, 66-69, 72, 73; Assumption 13; plan D2, D8, D9, D12, Phase 7).
 *
 * ```
 * run-pipeline --workspace <path> <component> --stage <name> [--target <name>] [--action <name>]
 *              [--select <parameter>=<value>]... --confirm <token> [--follow] [--json]
 * ```
 *
 * This is the only module that imports `pipelines/azure-devops-write.ts`, and `cli.ts` loads this
 * module only when `run-pipeline` is dispatched. The skill never pre-allows it (D12): the
 * permission prompt is a second gate after the human confirmation of the verbatim preview.
 *
 * ## Gates — each a hard stop, and NOTHING is written before every one has passed
 * 1. arguments (64) → canonical workspace load (24/29) → names (64);
 * 2. triggerability (mode `pipeline` AND owner = operatorTeam), mapping, declared action,
 *    renderable parameters (26); userSelectable choices (64);
 * 3. PAT (20, before any request);
 * 4. token present, decodable, not expired and not claiming more than the TTL (27, no request);
 * 5. the preview recomputed FROM SCRATCH with GETs only (Pipelines Get, Git Refs, read-only git);
 *    any blocker → its exit (26 / 23);
 * 6. the token's commit equals the recomputed remote head, and its digest equals the digest of
 *    the recomputed binding (27);
 * 7. the builds of the pipeline are listed (GET) — the baseline that lets an unknown outcome be
 *    detected later;
 * 8. the remote ref head is re-read through Git Refs IMMEDIATELY before queueing; a moved head
 *    → 27;
 * 9. exactly ONE POST (the Runs API, pinned to the commit; D8). It is never retried.
 *
 * ## After the POST
 * - `rejected` (the server answered; no run was created) → its exit (20 / 21 / 23), reported.
 * - `unknown` (no answer, timeout, 5xx, unreadable 2xx; D9) → the builds are listed again
 *   (read-only) and any run that appeared since the baseline is reported with its id and link;
 *   exit 21 (phase `unknown-outcome`) whether or not one was found. NEVER re-POSTed.
 * - `queued` → the pin check (D8): the echoed `resources.repositories.self.version`
 *   - equals the previewed commit → `matched`;
 *   - is absent → `unconfirmed` (warning only, exit unaffected: the Git Refs check passed
 *     immediately before the POST, so the ref head WAS the previewed commit);
 *   - differs → `mismatch`: a loud report "pipeline built <echoed> instead of <sha>" and exit 21
 *     (phase `pin-mismatch`) — the run exists and cannot be undone, but the confirmed commit is
 *     not what was queued, so the engine never reports success and the skill must not continue
 *     to landed proof as if it had been.
 * - `--follow` (read-only, the Phase 6 loop): a finished non-`succeeded` run → 25; still running
 *   past `followTimeoutMinutes` or waiting at an approval/check → 0 (phases `still-running` /
 *   `waiting`); never approves; never queues again. A failing follow read keeps the report (the
 *   run id is never lost) and exits with the read's code.
 * Exit codes combine by precedence (`pickExitCode`).
 */
import { EXIT, EngineError, pickExitCode } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { QUEUE_METHOD, queueRun } from "../pipelines/azure-devops-write.js";
import { followRun, openSession } from "../pipelines/collect.js";
import { runFact } from "../pipelines/facts.js";
import { blockerExit, computePreview, decodeToken, resolvePreviewScope, verifyToken } from "../pipelines/preview.js";
import { REPORT_SCHEMA_VERSION, colours, runLine, useColour } from "../report.js";
import { previewReads, renderPreview } from "./pipeline-preview.js";
import { pipelineRunExit } from "./pipeline-runs.js";
import { sleeper } from "./types.js";
function shortOf(sha) {
    return sha.slice(0, 7);
}
function pinCheck(requested, echoed) {
    if (echoed === null || echoed.trim() === "") {
        return { requested, echoed: null, status: "unconfirmed", detail: `the answer did not echo resources.repositories.self.version, so the pin to ${shortOf(requested)} is unconfirmed (the Git Refs check passed immediately before queueing)` };
    }
    if (echoed.trim().toLowerCase() === requested)
        return { requested, echoed, status: "matched", detail: `the run is pinned to ${shortOf(requested)} (echoed by Azure DevOps)` };
    return { requested, echoed, status: "mismatch", detail: `PIN MISMATCH: the pipeline built ${echoed} instead of ${requested} — the run exists and cannot be undone; it is NOT the confirmed commit` };
}
function detected(builds, baseline, ref, sha) {
    return builds
        .filter((build) => !baseline.has(build.id))
        .map((build) => ({
        id: build.id,
        status: build.status,
        sourceBranch: build.sourceBranch,
        sourceVersion: build.sourceVersion,
        matchesRequest: build.sourceBranch === ref && (build.sourceVersion ?? "").toLowerCase() === sha,
        link: build.link,
    }));
}
/** Runs `run-pipeline`. @throws EngineError for every exit before the POST (64, 24, 29, 26, 20, 27, 21, 23, 1) — none of them sent a write. */
export async function runRunPipeline(options, context) {
    // Gates 1-2: no network.
    const scope = resolvePreviewScope(options);
    const settings = scope.settings;
    const sleep = sleeper(context);
    // Gate 3: PAT.
    const session = openSession(scope.ws, context.env, {
        now: context.now,
        sleep,
        patNeed: "run-pipeline needs an Azure DevOps PAT with Build (Read & execute), Build (Read) and Code (Read); no request was sent",
    });
    // Gate 4: token shape and expiry.
    const token = decodeToken(options.confirm, context.now().getTime(), settings.confirmTokenTtlMinutes);
    // Gate 5: recompute.
    const preview = await previewReads(() => computePreview(scope, session.reader));
    if (preview.blockers.length > 0 || preview.binding === null || preview.request === null) {
        const code = preview.blockers.length > 0 ? blockerExit(preview.blockers) : EXIT.INTERNAL;
        throw new EngineError(code, code === EXIT.MISSING ? "missing" : "refused", `the run is blocked; nothing was sent: ${preview.blockers.map((blocker) => blocker.detail).join("; ")}`);
    }
    const binding = preview.binding;
    const request = preview.request;
    // Gate 6: the token binds exactly this request.
    verifyToken(token, binding);
    // Gate 7: the baseline for unknown-outcome detection.
    const baseline = await previewReads(() => session.reader.listBuilds(binding.project, binding.pipelineId, settings.runHistoryCount));
    // Gate 8: the remote head, immediately before queueing.
    const head = await previewReads(() => session.reader.getRefHead(binding.project, binding.repository, binding.ref));
    if (head === null || head.objectId !== token.commit) {
        throw new EngineError(EXIT.TOKEN, "token", `the remote head of ${binding.ref} moved immediately before queueing: previewed ${shortOf(token.commit)}, now ${head === null ? "the ref does not exist" : shortOf(head.objectId)}; nothing was sent — run pipeline-preview again, show it, confirm, and pass its new token`);
    }
    // The ONE write.
    const sentAt = context.now().toISOString();
    const outcome = await queueRun({ organizationUrl: binding.organizationUrl, project: binding.project, pipelineId: binding.pipelineId, credential: session.credential, timeoutMs: settings.requestTimeoutSeconds * 1000, body: request.body });
    const codes = [];
    let phase = "queued";
    let pin = null;
    let detection = null;
    let run = null;
    let waits = [];
    let followOutcome = null;
    let polls = 0;
    let elapsedMs = 0;
    let followError = null;
    const stderr = [];
    if (outcome.status === "rejected") {
        codes.push(outcome.exitCode);
        phase = "rejected";
        stderr.push(`release-radar: the queue request was rejected — ${outcome.detail} (exit ${outcome.exitCode}); it is never retried`);
    }
    else if (outcome.status === "unknown") {
        codes.push(EXIT.SOURCE);
        phase = "unknown-outcome";
        const baselineIds = new Set(baseline.map((build) => build.id));
        try {
            const after = await session.reader.listBuilds(binding.project, binding.pipelineId, settings.runHistoryCount);
            const runs = detected(after, baselineIds, binding.ref, binding.commit);
            detection =
                runs.length > 0
                    ? { status: "found", runs, detail: `${runs.length} run(s) of pipeline ${binding.pipelineId} appeared after the request: ${runs.map((entry) => `#${entry.id}${entry.matchesRequest ? " (same ref and commit)" : ""}`).join(", ")} — follow it read-only with pipeline-run; do NOT queue again` }
                    : { status: "not-found", runs, detail: `no new run of pipeline ${binding.pipelineId} appeared among the latest ${settings.runHistoryCount}: the request was probably not accepted, but this cannot be proven — check the pipeline's runs before doing anything; never re-run blindly` };
        }
        catch (error) {
            detection = { status: "failed", runs: [], detail: `the read-only listing after the request failed (${error instanceof EngineError ? error.describe() : String(error)}): whether a run was created is unknown` };
        }
        stderr.push(`release-radar: UNKNOWN OUTCOME — ${outcome.detail}. ${detection.detail}. The request was sent once and is never retried (exit 21)`);
    }
    else {
        pin = pinCheck(binding.commit, outcome.echoedVersion);
        if (pin.status === "mismatch") {
            codes.push(EXIT.SOURCE);
            stderr.push(`release-radar: ${pin.detail} (exit 21)`);
        }
        else if (pin.status === "unconfirmed")
            stderr.push(`release-radar: warning — ${pin.detail}`);
        if (options.follow) {
            try {
                const followed = await followRun(session.reader, binding.project, outcome.runId, {
                    follow: true,
                    pollMs: settings.followPollSeconds * 1000,
                    timeoutMs: settings.followTimeoutMinutes * 60_000,
                    now: () => context.now().getTime(),
                    sleep,
                });
                run = runFact(scope.mapping, followed.build, { component: binding.component, target: binding.target });
                waits = followed.waits;
                followOutcome = followed.outcome;
                polls = followed.polls;
                elapsedMs = followed.elapsedMs;
                const exit = pipelineRunExit(followed.outcome, followed.build);
                codes.push(exit.exitCode);
                phase = exit.phase;
                if (exit.exitCode === EXIT.PIPELINE_FAILED)
                    stderr.push(`release-radar: run #${outcome.runId} finished "${followed.build.result ?? "no result"}" — not "succeeded" (exit 25); it is NOT retried${run.link === null ? "" : `: ${run.link}`}`);
                if (followed.outcome === "still-running")
                    stderr.push(`release-radar: run #${outcome.runId} is still running after ${settings.followTimeoutMinutes} minute(s) of following — not a failure; follow it with pipeline-run`);
                if (followed.outcome === "waiting")
                    stderr.push(`release-radar: run #${outcome.runId} is waiting: ${followed.waits.map((wait) => wait.detail).join("; ")}`);
            }
            catch (error) {
                if (!(error instanceof EngineError))
                    throw error;
                followError = error.describe();
                codes.push(error.exitCode);
                phase = "follow-failed";
                stderr.push(`release-radar: run #${outcome.runId} was queued, but following it failed (${followError}); follow it with pipeline-run`);
            }
        }
        if (pin.status === "mismatch")
            phase = "pin-mismatch";
    }
    const exitCode = pickExitCode(codes);
    const report = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        engineVersion: engineVersion(),
        command: "run-pipeline",
        generatedAt: context.now().toISOString(),
        workspace: { root: scope.loaded.root, file: scope.loaded.file },
        scope: { component: options.component, stage: options.stage, target: options.target, action: options.action, selections: options.selections, follow: options.follow },
        pat: session.expiry,
        preview,
        token: { verified: true, expiresAt: token.expiresAt },
        queue: {
            method: QUEUE_METHOD,
            path: request.path,
            count: 1,
            retried: false,
            sentAt,
            status: outcome.status,
            httpStatus: outcome.httpStatus,
            detail: outcome.status === "queued" ? `run #${outcome.runId} queued${outcome.state === null ? "" : ` (${outcome.state})`}` : outcome.detail,
            runId: outcome.status === "queued" ? outcome.runId : null,
            link: outcome.status === "queued" ? outcome.link : null,
            pin,
            detection,
        },
        run,
        waits,
        follow: { requested: options.follow, outcome: followOutcome, polls, elapsedSeconds: Math.round(elapsedMs / 1000), pollSeconds: settings.followPollSeconds, timeoutMinutes: settings.followTimeoutMinutes, error: followError },
        requests: { GET: session.reader.requestCount, queue: 1 },
        outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
    };
    if (session.expiry.warning)
        stderr.push(`release-radar: warning — ${session.expiry.detail}`);
    let stdout;
    if (options.json)
        stdout = `${JSON.stringify(report, null, 2)}\n`;
    else {
        const c = colours(useColour(false, context.stdout, context.env));
        const lines = [`release-radar run-pipeline — ${preview.component} / ${preview.stage.name} / ${preview.target} (ONE queued run)`, "", ...renderPreview(preview, c), ""];
        if (outcome.status === "queued") {
            lines.push(`  ${c.green(`queued run #${outcome.runId}`)}${outcome.link === null ? "" : c.dim(` ${outcome.link}`)}`);
            if (pin !== null)
                lines.push(`  ${pin.status === "mismatch" ? c.red(pin.detail) : pin.status === "unconfirmed" ? c.yellow(pin.detail) : pin.detail}`);
            if (run !== null)
                lines.push(`  ${runLine(run, c)}`);
            for (const wait of waits)
                lines.push(`  ${c.yellow(`⏸ ${wait.detail}`)}`);
            if (followOutcome === "still-running")
                lines.push(`  ${c.yellow(`still running after ${settings.followTimeoutMinutes} minute(s) (${polls} poll(s)) — not a failure`)}`);
            if (followError !== null)
                lines.push(`  ${c.red(`following failed: ${followError}`)}`);
            if (!options.follow)
                lines.push(c.dim(`  follow it read-only with pipeline-run ${preview.component} ${outcome.runId} --follow`));
        }
        else if (outcome.status === "rejected")
            lines.push(`  ${c.red(`rejected — ${outcome.detail}`)}`);
        else
            lines.push(`  ${c.red(`UNKNOWN OUTCOME — ${outcome.detail}`)}`, `  ${detection === null ? "" : detection.detail}`);
        lines.push(c.dim(`  ${session.expiry.detail}`));
        lines.push(c.dim(`  Azure DevOps requests: ${report.requests.GET} GET and exactly 1 queue request (never retried); nothing was approved.`));
        stdout = `${lines.join("\n")}\n`;
    }
    return { exitCode, phase, stdout, stderr, json: options.json };
}
