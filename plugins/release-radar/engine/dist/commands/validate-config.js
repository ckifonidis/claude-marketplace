/**
 * `validate-config` (spec requirements 12, 28, 37, 31c): validates the workspace, its repos file,
 * every available member's working-tree `component.json`, the fleet checklist and every
 * available member's component checklist; reports unavailable members; and prints EVERY
 * configured command the engine would run on the user's behalf through the `command` adapter
 * (each target's `argv` and `preflightArgv`, and the workspace's `discoverArgv`) — the engine
 * cannot prove those are read-only, so the user must see them.
 *
 * Read-only: no adapter, git or network call. Exit 24 for the first invalid file (exact
 * location), 29 after the full report when any owned file is valid but non-canonical, else 0.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMPONENT_CHECKLIST_FILE, RELEASE_RADAR_DIR } from "../config.js";
import { classifyChecklist } from "../checklist.js";
import { renderCommand } from "../adapters/types.js";
import { EXIT } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { readTextFile } from "../files.js";
import { inspectWorkspace } from "../workspace.js";
function checklistReport(file, layer, owner) {
    const result = classifyChecklist(readTextFile(file, undefined), file, layer);
    if (result.state === "invalid")
        throw result.error;
    return { file, owner, state: result.state, changes: result.changes };
}
function display(argv) {
    const [bin = "", ...args] = argv;
    return renderCommand(bin, args);
}
/** Runs `validate-config`. @throws EngineError 64/24 (no report). */
export function runValidateConfig(options, _context) {
    const loaded = inspectWorkspace(options.workspace, { members: "all" });
    const ws = loaded.workspace;
    const files = [loaded.report, loaded.reposReport];
    if (loaded.checklistFile !== null)
        files.push(checklistReport(loaded.checklistFile, "fleet", "workspace-repo"));
    const commands = [];
    const members = loaded.members.map((resolution) => {
        if (resolution.status === "unavailable") {
            return { name: resolution.member.name, status: "unavailable", reason: resolution.reason, detail: resolution.detail };
        }
        files.push(resolution.report);
        const checklist = join(resolution.componentRoot, RELEASE_RADAR_DIR, COMPONENT_CHECKLIST_FILE);
        let checklistFile = null;
        if (existsSync(checklist)) {
            files.push(checklistReport(checklist, "component", resolution.report.owner));
            checklistFile = checklist;
        }
        for (const stage of ws.stages) {
            const entry = resolution.component.stages[stage.name];
            if (entry === null || entry === undefined)
                continue;
            for (const target of entry.targets) {
                if (target.adapter !== "command")
                    continue;
                const where = `${resolution.member.name}/${stage.name}/${target.name}`;
                commands.push({ role: "target-read", where, argv: target.argv, display: display(target.argv) });
                if (target.preflightArgv !== undefined)
                    commands.push({ role: "target-preflight", where, argv: target.preflightArgv, display: display(target.preflightArgv) });
            }
        }
        return { name: resolution.member.name, status: "available", componentFile: resolution.componentFile, checklist: checklistFile };
    });
    const discoverArgv = ws.adapters.command?.discoverArgv;
    if (discoverArgv !== undefined)
        commands.push({ role: "discover", where: "workspace", argv: discoverArgv, display: display(discoverArgv) });
    const nonCanonical = files.filter((file) => file.state === "non-canonical" && file.owner !== "external");
    const exitCode = nonCanonical.length > 0 ? EXIT.NON_CANONICAL : EXIT.OK;
    const phase = exitCode === EXIT.OK ? "complete" : "canonical";
    if (options.json) {
        const document = {
            schemaVersion: 1,
            engineVersion: engineVersion(),
            command: "validate-config",
            workspace: { root: loaded.root, file: loaded.file },
            valid: true,
            files: files.map((file) => ({ file: file.file, owner: file.owner, state: file.state, changes: file.changes })),
            members,
            commands,
            nonCanonical: nonCanonical.map((file) => file.file),
        };
        return { exitCode, phase, stdout: `${JSON.stringify(document, null, 2)}\n`, stderr: nonCanonical.length > 0 ? [`release-radar: non-canonical input (run format first): ${nonCanonical.map((f) => f.file).join(", ")}`] : [], json: true };
    }
    const lines = [`release-radar validate-config — workspace ${loaded.root}`, "", "files:"];
    for (const file of files) {
        const state = file.owner === "external" ? `${file.state} (externally owned — not re-formatted)` : file.state;
        lines.push(`  ${state.padEnd(14)}  ${file.file}`);
        for (const change of file.changes)
            lines.push(`                  - ${change}`);
    }
    lines.push("", "members:");
    for (const member of members) {
        if (member.status === "available")
            lines.push(`  ${member.name}: available (${member.componentFile})`);
        else
            lines.push(`  ${member.name}: unavailable (${member.reason === "no-local-clone" ? "no local clone" : "no component config"}) — ${member.detail}`);
    }
    lines.push("", "configured commands (run without a shell; the engine cannot verify they are read-only — check each one):");
    if (commands.length === 0)
        lines.push("  none");
    for (const command of commands)
        lines.push(`  ${command.role.padEnd(16)} ${command.where}: ${command.display}`);
    const stderr = nonCanonical.length > 0 ? [`release-radar: non-canonical input (run format first): ${nonCanonical.map((f) => f.file).join(", ")}`] : [];
    lines.push("", exitCode === EXIT.OK ? "valid: every available file is valid and canonical" : "valid, but non-canonical files need `format` (exit 29)");
    return { exitCode, phase, stdout: `${lines.join("\n")}\n`, stderr, json: false };
}
