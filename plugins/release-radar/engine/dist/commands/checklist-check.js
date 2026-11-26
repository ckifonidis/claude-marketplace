/**
 * `checklist-check` (spec requirements 58 step 8, 80, 82c, 84) — READ-ONLY classification of a
 * component checklist AT A COMMIT.
 *
 * `checklist-check --workspace <path> <component> --commit <sha> [--json]`
 *
 * Reads `<repoSubdir>/.release-radar/checks.md` (or `.release-radar/checks.md` without a
 * `repoSubdir`) at the commit with `git cat-file blob <sha>:<path>`, classifies it against the
 * checklist grammar for the `component` layer, and reports one state:
 * - `canonical`;
 * - `non-canonical` — used as is and reported "non-canonical at <sha>", with the change summary
 *   (the skill offers to re-format the WORKING-TREE copy; the file at the commit is never
 *   rewritten, 82c);
 * - `invalid` — with the exact location (line:column): a blocking finding for change-risk/promote;
 * - `absent` — no component checklist at that commit.
 * Valid checklists also carry their parsed items, so the skill applies them without re-parsing.
 * The working-tree copy is compared with the commit's copy (byte-identical / same canonical content
 * / differs / absent); it is NOT classified here (the canonical-file gate does that).
 *
 * Order: workspace skeleton (24) → component name (64) → sha shape (64) → canonical load of the
 * workspace, repos file and component (24, 29; unavailable requested member → 24) → the commit in
 * the member's clone (not found → 64; git failure → 21) → read and classify.
 *
 * Exit 0 for canonical / non-canonical / absent (non-canonical at a commit is information, not an
 * engine refusal); 24 for invalid, WITH the report printed (stdout) so the location is available.
 * Nothing is ever written.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argumentError } from "../args.js";
import { classifyChecklist, renderChecklist } from "../checklist.js";
import { COMPONENT_CHECKLIST_FILE, RELEASE_RADAR_DIR, memberSubdir } from "../config.js";
import { EXIT, EngineError, formatLocation } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { showFileBytesAtCommit } from "../git.js";
import { resolveLocalEndpoint } from "../stage-commit.js";
import { loadWorkspace, loadWorkspaceSkeleton, requireAvailableMember } from "../workspace.js";
/** Runs `checklist-check`. @throws EngineError 64 / 24 / 29 / 21 for exits without a report. */
export function runChecklistCheck(options, _context) {
    const skeleton = loadWorkspaceSkeleton(options.workspace);
    const memberNames = skeleton.workspace.members.map((member) => member.name);
    if (!memberNames.includes(options.component)) {
        throw argumentError(`unknown component "${options.component}" (members: ${memberNames.join(", ")})`);
    }
    if (!/^[0-9a-f]{7,40}$/i.test(options.commit))
        throw argumentError(`--commit ${options.commit}: not a commit sha (7-40 hex characters)`);
    const loaded = loadWorkspace(options.workspace, { members: [options.component], canonical: "require" });
    const member = requireAvailableMember(loaded, options.component);
    const timeoutMs = loaded.workspace.gitTimeoutSeconds * 1000;
    const commit = resolveLocalEndpoint(member, { kind: "commit", token: options.commit }, "commit", timeoutMs);
    if (commit.status !== "resolved")
        throw new EngineError(EXIT.INTERNAL, "resolve", "the commit did not resolve");
    const subdir = memberSubdir(member.member);
    const local = `${RELEASE_RADAR_DIR}/${COMPONENT_CHECKLIST_FILE}`;
    const path = subdir === null ? local : `${subdir}/${local}`;
    const label = `${commit.sha}:${path}`;
    const shown = showFileBytesAtCommit(member.clone, commit.sha, path, timeoutMs);
    if (shown.status === "git-error")
        throw new EngineError(EXIT.SOURCE, "git", `${label}: ${shown.detail}`);
    let state = "absent";
    let changes = [];
    let error;
    let items = null;
    let canonicalAtCommit = null;
    const atCommitBytes = shown.status === "ok" ? shown.bytes : null;
    if (atCommitBytes !== null) {
        const classified = classifyChecklist(atCommitBytes.toString("utf8"), label, "component");
        state = classified.state;
        if (classified.state === "invalid")
            error = classified.error;
        else {
            changes = [...classified.changes];
            items = classified.value?.items ?? [];
            canonicalAtCommit = classified.rendered ?? null;
        }
    }
    const workingFile = join(member.componentRoot, RELEASE_RADAR_DIR, COMPONENT_CHECKLIST_FILE);
    let comparison;
    if (!existsSync(workingFile))
        comparison = "absent";
    else if (atCommitBytes === null || state === "invalid") {
        comparison = atCommitBytes !== null && readFileSync(workingFile).equals(atCommitBytes) ? "identical" : "not-compared";
    }
    else {
        const working = readFileSync(workingFile);
        if (working.equals(atCommitBytes))
            comparison = "identical";
        else {
            const classified = classifyChecklist(working.toString("utf8"), workingFile, "component");
            comparison = classified.state !== "invalid" && classified.value !== undefined && renderChecklist(classified.value) === canonicalAtCommit ? "same-content" : "differs";
        }
    }
    const exitCode = state === "invalid" ? EXIT.INVALID : EXIT.OK;
    const phase = state === "invalid" ? "validate" : "complete";
    const report = {
        schemaVersion: 1,
        engineVersion: engineVersion(),
        command: "checklist-check",
        workspace: { root: loaded.root, file: loaded.file },
        component: options.component,
        commit: { sha: commit.sha, shortSha: commit.sha.slice(0, 7), subject: commit.subject },
        path,
        label,
        state,
        changes,
        error: error === undefined ? null : { message: error.message, location: error.location ?? null, describe: error.describe() },
        items,
        workingTree: { file: workingFile, comparison },
        rewritten: false,
        outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
    };
    const stderr = error === undefined ? [] : [`release-radar: ${path} invalid at ${commit.sha.slice(0, 7)}: ${error.describe()}`];
    return { exitCode, phase, stdout: options.json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report), stderr, json: options.json };
}
const STATE_TEXT = {
    canonical: "canonical",
    "non-canonical": "non-canonical at the commit (used as is; never rewritten)",
    invalid: "INVALID at the commit (a blocking finding)",
    absent: "absent — no component checklist at the commit",
};
const COMPARISON_TEXT = {
    identical: "identical to the commit's copy",
    "same-content": "same content as the commit's copy, different formatting",
    differs: "DIFFERS from the commit's copy",
    absent: "absent",
    "not-compared": "present (not compared: the commit's copy is absent or invalid)",
};
function renderHuman(report) {
    const lines = [
        `release-radar checklist-check ${report.component} at ${report.commit.shortSha} "${report.commit.subject}" — workspace ${report.workspace.root} (read-only)`,
        "",
        `  ${report.path}: ${STATE_TEXT[report.state]}`,
    ];
    if (report.error !== null)
        lines.push(`      ${report.error.location === null ? report.error.message : `${formatLocation(report.error.location)}: ${report.error.message}`}`);
    for (const change of report.changes)
        lines.push(`      - ${change}`);
    if (report.items !== null) {
        lines.push(`  ${report.items.length} item(s):`);
        for (const item of report.items)
            lines.push(`    ${item.id} [${item.severity}] paths ${item.paths.join(", ")}`);
    }
    lines.push(`  working-tree copy ${report.workingTree.file}: ${COMPARISON_TEXT[report.workingTree.comparison]}`);
    return `${lines.join("\n")}\n`;
}
