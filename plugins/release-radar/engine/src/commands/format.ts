/**
 * `format` and `format --check` (spec requirements 39, 78-86; plan decisions D6, D20; Phase 8).
 *
 * `format [--check] --workspace <path> [--include-members] [--index <file>] [--json]`
 * `format [--check] --index <file> [--json]` — INDEX-ONLY mode: no workspace is read; only the
 *   per-user workspace index is classified (and, without `--check`, rewritten when valid and
 *   non-canonical). `report.workspace` is `null`, and quarantine and retention are reported as
 *   `skipped` ("index-only run"). This is how a hand-edited index — which `workspace-index list` /
 *   `resolve` refuse with 29 — is re-formatted when no workspace is at hand. `--workspace` and
 *   `--index` may be combined (both are then processed); neither → 64. `--include-members` needs
 *   `--workspace` (64 otherwise).
 *
 * ## Files in scope (each classified independently: one invalid file never hides another)
 * | kind                  | file                                               | owner          | rewritten by `format`            |
 * |-----------------------|----------------------------------------------------|----------------|----------------------------------|
 * | `workspace`           | `.release-radar/workspace.json`                    | workspace repo | yes                              |
 * | `repos-file`          | `.release-radar/repos.local.json` (owned)          | workspace repo | yes                              |
 * | `external-repos-file` | the external repos file `workspace.json` names     | external       | NEVER (82b)                      |
 * | `fleet-checklist`     | `workspace.json` `checklist`                       | workspace repo | yes                              |
 * | `component`           | each located member's working-tree `component.json`| member repo¹   | only with `--include-members`¹   |
 * | `component-checklist` | each located member's `.release-radar/checks.md`   | member repo¹   | only with `--include-members`¹   |
 * | `snapshot`            | `.release-radar/snapshots/<engine name>.json`      | engine         | yes                              |
 * | `handoff-manifest`    | `.release-radar/handoff/<package>/manifest.json`   | engine         | yes                              |
 * | `handoff-copy`        | `.release-radar/handoff/<package>/files/**`        | engine         | NEVER — checked against sha256 (82a) |
 * | `workspace-index`     | `--index <file>` (the per-user index)              | per-user       | yes                              |
 *
 * ¹ In a single-repo project the member's clone IS the workspace repository, so its files are
 *   workspace-repo files and are rewritten without the flag (83a). `component.json` and checklists
 *   read at a commit are never read here — history is never rewritten (82c).
 *
 * ## States and exit codes
 * Each file is `canonical`, `non-canonical` (with a change summary) or `invalid` (exact location:
 * file + JSON pointer, or file + line:column). `--check` writes nothing and exits 24 if any file is
 * invalid, else 29 if any counted file is non-canonical, else 0. Without `--check`, valid
 * non-canonical files are rewritten in place (losslessly; temp file + rename), invalid files are
 * left untouched, then the exit is 24 if any file is invalid, else 29 if a non-canonical file was
 * left (a member-repo file without `--include-members`), else 0. An external repos file is
 * reported "externally owned — not re-formatted" and never counts toward 29.
 *
 * ## Cleanup (without `--check`; `--check` reports what it would do)
 * - de-duplication of byte-identical list entries is part of the canonical rewrite, and each
 *   removal is reported;
 * - ORPHANS — files in `snapshots/` or `handoff/` that do not match the engine's naming pattern,
 *   engine files whose `schemaVersion` is absent or unsupported, package directories without a
 *   manifest, and files inside a package that its manifest does not list — are MOVED to
 *   `.release-radar/quarantine/<run timestamp>/<same relative path>` and reported; never deleted;
 * - retention: the newest `snapshotRetention` valid snapshots and, per (component, stage), the
 *   newest `handoffRetention` valid packages are kept; older VALID ones are deleted. Retention
 *   needs a valid `workspace.json` (it holds the counts) and is skipped, with the reason, otherwise;
 * - stale workspace-index entries are only reported (removed by `workspace-index unregister`).
 * Nothing else is ever deleted.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { classifyChecklist, type ChecklistLayer } from "../checklist.js";
import {
  COMPONENT_CHECKLIST_FILE,
  COMPONENT_SCHEMA,
  OWNED_REPOS_FILE,
  RELEASE_RADAR_DIR,
  WORKSPACE_SCHEMA,
  checkComponent,
  checkWorkspace,
  type Workspace,
} from "../config.js";
import { argumentError } from "../args.js";
import { EXIT, EngineError, formatLocation, pickExitCode, type ErrorLocation } from "../errors.js";
import { engineVersion } from "../engine-info.js";
import { readTextFile } from "../files.js";
import { classify, type Classification, type FileState, type Schema, type Infer } from "../format.js";
import { inspectHandoff, pruneHandoffPackages, stampOf, unsupportedSchemaVersion, type Orphan } from "../handoff.js";
import { EXTERNAL_REPOS_FILE_SCHEMA, REPOS_FILE_SCHEMA, loadRepoPaths } from "../repo-paths.js";
import { SNAPSHOTS_DIR, SNAPSHOT_NAME_PATTERN, SNAPSHOT_SCHEMA, pruneSnapshots, snapshotsDir } from "../snapshot.js";
import { WORKSPACE_INDEX_SCHEMA, listIndex } from "../workspace-index.js";
import { locateMember, workspaceFileOf, workspaceRootOf } from "../workspace.js";
import type { CommandContext, CommandOutput } from "./types.js";

/** Parsed `format` options. */
export interface FormatOptions {
  /** `null` in index-only mode (then `index` is required). */
  readonly workspace: string | null;
  readonly check: boolean;
  readonly includeMembers: boolean;
  readonly index: string | null;
  readonly json: boolean;
}

/** What kind of file an entry is. */
export type FormatFileKind =
  | "workspace"
  | "repos-file"
  | "external-repos-file"
  | "fleet-checklist"
  | "component"
  | "component-checklist"
  | "snapshot"
  | "handoff-manifest"
  | "handoff-copy"
  | "workspace-index";

/** Who owns a file, which decides whether `format` may rewrite it. */
export type FormatOwner = "workspace-repo" | "member-repo" | "external" | "engine" | "per-user";

/** What `format` did (or, with `--check`, would do) to a file. */
export type FormatAction =
  | "none"
  | "rewritten"
  | "would-rewrite"
  | "needs-include-members"
  | "never-rewritten"
  | "left-invalid"
  | "pruned"
  | "would-prune";

/** One file of the report. */
export interface FormatFileEntry {
  readonly file: string;
  readonly kind: FormatFileKind;
  readonly owner: FormatOwner;
  readonly state: FileState;
  readonly action: FormatAction;
  readonly note: string | null;
  readonly changes: readonly string[];
  readonly error: { readonly message: string; readonly location: ErrorLocation | null; readonly describe: string } | null;
}

interface Pending {
  file: string;
  kind: FormatFileKind;
  owner: FormatOwner;
  state: FileState;
  changes: string[];
  rendered?: string;
  error?: EngineError;
  /** Set for files that can never be rewritten. */
  never?: string;
  /** The package directory a manifest/copy belongs to (retention). */
  packageDir?: string;
}

const MEMBER_NOTE = "re-format requires --include-members (member repository)";

function errorEntry(error: EngineError | undefined): FormatFileEntry["error"] {
  if (error === undefined) return null;
  return { message: error.message, location: error.location ?? null, describe: error.describe() };
}

function invalidPending(file: string, kind: FormatFileKind, owner: FormatOwner, message: string, location?: ErrorLocation): Pending {
  return { file, kind, owner, state: "invalid", changes: [], error: new EngineError(EXIT.INVALID, "validate", message, location ?? { file }) };
}

function fromClassification<T>(file: string, kind: FormatFileKind, owner: FormatOwner, result: Classification<T>): Pending {
  if (result.state === "invalid") return { file, kind, owner, state: "invalid", changes: [], ...(result.error === undefined ? {} : { error: result.error }) };
  return { file, kind, owner, state: result.state, changes: [...result.changes], ...(result.rendered === undefined ? {} : { rendered: result.rendered }) };
}

/** Classifies a JSON file against `schema`, then runs the semantic `check` on the canonical value. */
function classifyJsonFile<S extends Schema>(
  file: string,
  kind: FormatFileKind,
  owner: FormatOwner,
  schema: S,
  check?: (value: Infer<S>) => void,
): { pending: Pending; value?: Infer<S> } {
  const result = classify(readTextFile(file, undefined), schema, file);
  if (result.state !== "invalid" && result.value !== undefined && check !== undefined) {
    try {
      check(result.value);
    } catch (error) {
      if (error instanceof EngineError) return { pending: { file, kind, owner, state: "invalid", changes: [], error } };
      throw error;
    }
  }
  const pending = fromClassification(file, kind, owner, result);
  return result.state === "invalid" || result.value === undefined ? { pending } : { pending, value: result.value };
}

function classifyChecklistFile(file: string, kind: FormatFileKind, owner: FormatOwner, layer: ChecklistLayer): Pending {
  return fromClassification(file, kind, owner, classifyChecklist(readTextFile(file, undefined), file, layer));
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Snapshots: engine-named files are classified; everything else in the directory is an orphan. */
function scanSnapshots(root: string, files: Pending[], orphans: Orphan[]): void {
  const dir = snapshotsDir(root);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (!entry.isFile() || !SNAPSHOT_NAME_PATTERN.test(entry.name)) {
      orphans.push({ path, reason: entry.isFile() ? "file name does not match the snapshot naming pattern" : "not a snapshot file" });
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (unsupportedSchemaVersion(text)) {
      orphans.push({ path, reason: "snapshot with an unknown or unsupported schemaVersion" });
      continue;
    }
    files.push(fromClassification(path, "snapshot", "engine", classify(text, SNAPSHOT_SCHEMA, path)));
  }
}

/** Writes `text` to `file` atomically (temp file in the same directory + rename). */
function rewrite(file: string, text: string): void {
  const temporary = join(dirname(file), `.${basename(file)}.release-radar-${process.pid}.tmp`);
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, file);
}

/** The run's quarantine directory: `quarantine/<stamp>[-n]` (never reused). */
function quarantineDir(root: string, now: Date): string {
  const base = join(root, RELEASE_RADAR_DIR, "quarantine", stampOf(now.toISOString()));
  for (let sequence = 0; ; sequence++) {
    const dir = sequence === 0 ? base : `${base}-${sequence}`;
    if (!existsSync(dir)) return dir;
  }
}

/** The `format --json` document (schemaVersion 1, additive). */
export interface FormatReport {
  readonly schemaVersion: 1;
  readonly engineVersion: string;
  readonly command: "format";
  readonly mode: "check" | "write";
  /** `null` in index-only mode (`format --index <file>` without `--workspace`). */
  readonly workspace: { readonly root: string; readonly file: string } | null;
  readonly includeMembers: boolean;
  readonly index: { readonly file: string; readonly exists: boolean } | null;
  readonly files: readonly FormatFileEntry[];
  readonly members: readonly { readonly name: string; readonly status: "located" | "unavailable" | "not-checked"; readonly detail: string | null }[];
  readonly cleanup: {
    readonly deduplicated: readonly { readonly file: string; readonly change: string }[];
    readonly quarantine: {
      readonly status: "applied" | "planned" | "skipped";
      /** Why quarantine was skipped (`"index-only run"`), else `null`. */
      readonly reason: string | null;
      readonly dir: string | null;
      readonly moved: readonly { readonly from: string; readonly to: string; readonly reason: string }[];
    };
    readonly retention: {
      readonly status: "applied" | "planned" | "skipped";
      readonly reason: string | null;
      readonly snapshots: { readonly keep: number; readonly deleted: readonly string[] } | null;
      readonly handoff: { readonly keep: number; readonly deleted: readonly string[] } | null;
    };
    readonly staleIndexEntries: readonly { readonly path: string; readonly reason: string }[];
  };
  readonly summary: { readonly files: number; readonly canonical: number; readonly nonCanonical: number; readonly invalid: number; readonly rewritten: number };
  readonly outcome: { readonly exitCode: number; readonly result: "OK" | "FAIL"; readonly phase: string };
}

interface ScannedWorkspace {
  readonly root: string;
  readonly workspaceFile: string;
  /** The validated workspace, or `undefined` when `workspace.json` is invalid. */
  readonly workspace: Workspace | undefined;
  readonly handoff: ReturnType<typeof inspectHandoff>;
}

/** Classifies every workspace-side file (workspace repo, members, engine files) into `files`. */
function scanWorkspace(path: string, files: Pending[], orphans: Orphan[], members: FormatReport["members"][number][]): ScannedWorkspace {
  const root = workspaceRootOf(path);
  const workspaceFile = workspaceFileOf(root);
  if (!existsSync(workspaceFile)) throw new EngineError(EXIT.INVALID, "load", `workspace file not found: ${workspaceFile}`, { file: workspaceFile });

  // Workspace repository files.
  const ws = classifyJsonFile(workspaceFile, "workspace", "workspace-repo", WORKSPACE_SCHEMA, (value) => checkWorkspace(value, workspaceFile));
  files.push(ws.pending);
  const workspace: Workspace | undefined = ws.value;
  if (workspace !== undefined) {
    const external = workspace.reposFile.kind === "external";
    const reposFile = workspace.reposFile.kind === "owned" ? join(root, RELEASE_RADAR_DIR, OWNED_REPOS_FILE) : resolve(root, workspace.reposFile.path);
    const kind: FormatFileKind = external ? "external-repos-file" : "repos-file";
    const owner: FormatOwner = external ? "external" : "workspace-repo";
    let reposValid = false;
    if (!existsSync(reposFile)) files.push(invalidPending(reposFile, kind, owner, `repos file not found: ${reposFile}`));
    else {
      const repos = classifyJsonFile(reposFile, kind, owner, external ? EXTERNAL_REPOS_FILE_SCHEMA : REPOS_FILE_SCHEMA);
      if (external) repos.pending.never = "externally owned — not re-formatted";
      files.push(repos.pending);
      reposValid = repos.value !== undefined;
    }
    if (workspace.checklist !== null) {
      const checklist = join(root, ...workspace.checklist.split("/"));
      if (!isRegularFile(checklist)) {
        files.push(invalidPending(checklist, "fleet-checklist", "workspace-repo", `configured checklist ${checklist} does not exist`, { file: workspaceFile, pointer: "/checklist" }));
      } else files.push(classifyChecklistFile(checklist, "fleet-checklist", "workspace-repo", "fleet"));
    }
    if (reposValid) {
      const repoPaths = loadRepoPaths(reposFile, workspace.reposFile.kind);
      for (const member of workspace.members) {
        const located = locateMember({ root, repoPaths }, member);
        if (located.status === "unavailable") {
          members.push({ name: member.name, status: "unavailable", detail: `${located.reason === "no-local-clone" ? "no local clone" : "no component config"}: ${located.detail}` });
          continue;
        }
        members.push({ name: member.name, status: "located", detail: null });
        const component = classifyJsonFile(located.componentFile, "component", located.owner, COMPONENT_SCHEMA, (value) =>
          checkComponent(value, workspace, member.name, located.componentFile, workspaceFile),
        );
        files.push(component.pending);
        const checklist = join(located.componentRoot, RELEASE_RADAR_DIR, COMPONENT_CHECKLIST_FILE);
        if (isRegularFile(checklist)) files.push(classifyChecklistFile(checklist, "component-checklist", located.owner, "component"));
      }
    } else for (const member of workspace.members) members.push({ name: member.name, status: "not-checked", detail: "the repos file is invalid or missing" });
  }

  // Engine-owned files.
  scanSnapshots(root, files, orphans);
  const handoff = inspectHandoff(root);
  orphans.push(...handoff.orphans);
  for (const pkg of handoff.packages) {
    const manifest: Pending = {
      file: pkg.manifestFile,
      kind: "handoff-manifest",
      owner: "engine",
      state: pkg.state,
      changes: [...pkg.changes],
      packageDir: pkg.dir,
      ...(pkg.rendered === undefined ? {} : { rendered: pkg.rendered }),
      ...(pkg.error === undefined ? {} : { error: pkg.error }),
    };
    files.push(manifest);
    for (const copy of pkg.copies) {
      files.push({
        file: copy.file,
        kind: "handoff-copy",
        owner: "engine",
        state: copy.state === "verbatim" ? "canonical" : "invalid",
        changes: [],
        packageDir: pkg.dir,
        never: `verbatim copy of ${copy.path} at ${copy.sourceCommit} (sha256 matches the manifest) — never re-formatted`,
        ...(copy.error === undefined ? {} : { error: copy.error }),
      });
    }
    orphans.push(...pkg.strays);
  }

  return { root, workspaceFile, workspace, handoff };
}

/** The reason quarantine and retention are skipped in index-only mode. */
export const INDEX_ONLY_REASON = "index-only run";

/**
 * Runs `format` / `format --check`.
 * @throws EngineError 64 when neither `--workspace` nor `--index` is given (or `--include-members`
 *   without `--workspace`); 24 only when the workspace file itself does not exist.
 */
export function runFormat(options: FormatOptions, context: CommandContext): CommandOutput {
  if (options.workspace === null && options.index === null) throw argumentError(`"format" requires --workspace <path>, --index <file>, or both`);
  if (options.workspace === null && options.includeMembers) throw argumentError(`--include-members needs --workspace <path> (an index-only run has no members)`);
  const files: Pending[] = [];
  const orphans: Orphan[] = [];
  const members: FormatReport["members"][number][] = [];
  const scanned = options.workspace === null ? null : scanWorkspace(options.workspace, files, orphans, members);

  // The per-user index.
  let index: FormatReport["index"] = null;
  const staleIndexEntries: { path: string; reason: string }[] = [];
  if (options.index !== null) {
    const indexFile = resolve(options.index);
    index = { file: indexFile, exists: existsSync(indexFile) };
    if (index.exists) {
      const classified = classifyJsonFile(indexFile, "workspace-index", "per-user", WORKSPACE_INDEX_SCHEMA);
      files.push(classified.pending);
      if (classified.value !== undefined) {
        for (const entry of listIndex(indexFile, { canonical: "report" })) if (entry.status === "stale") staleIndexEntries.push({ path: entry.path, reason: entry.reason ?? "stale" });
      }
    }
  }

  // Cleanup 1: quarantine orphans (moved, never deleted).
  const moved: { from: string; to: string; reason: string }[] = [];
  let quarantine: string | null = null;
  if (scanned !== null && orphans.length > 0) {
    const root = scanned.root;
    quarantine = quarantineDir(root, context.now());
    const base = join(root, RELEASE_RADAR_DIR);
    for (const orphan of [...orphans].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const to = join(quarantine, relative(base, orphan.path));
      if (!options.check) {
        mkdirSync(dirname(to), { recursive: true });
        renameSync(orphan.path, to);
      }
      moved.push({ from: orphan.path, to, reason: orphan.reason });
    }
  }

  // Cleanup 2: retention (needs the counts from a valid workspace.json).
  const pruned = new Set<string>();
  let retention: FormatReport["cleanup"]["retention"];
  const workspace = scanned?.workspace;
  if (scanned === null) {
    retention = { status: "skipped", reason: INDEX_ONLY_REASON, snapshots: null, handoff: null };
  } else if (workspace === undefined) {
    retention = { status: "skipped", reason: "workspace.json is invalid: the retention counts are unknown", snapshots: null, handoff: null };
  } else {
    const { root, handoff } = scanned;
    const snapshotPrune = pruneSnapshots(root, workspace.snapshotRetention, { dryRun: options.check });
    const handoffPrune = pruneHandoffPackages(root, workspace.handoffRetention, { dryRun: options.check }, options.check ? handoff : inspectHandoff(root));
    for (const file of snapshotPrune.deleted) pruned.add(file);
    for (const dir of handoffPrune.deleted) pruned.add(dir);
    retention = {
      status: options.check ? "planned" : "applied",
      reason: null,
      snapshots: { keep: workspace.snapshotRetention, deleted: snapshotPrune.deleted },
      handoff: { keep: workspace.handoffRetention, deleted: handoffPrune.deleted },
    };
  }

  // Cleanup 3: canonical rewrites (dedupe included), never for invalid / never-rewrite / pruned files.
  const entries: FormatFileEntry[] = [];
  const deduplicated: { file: string; change: string }[] = [];
  let rewritten = 0;
  for (const pending of files) {
    const isPruned = pruned.has(pending.file) || (pending.packageDir !== undefined && pruned.has(pending.packageDir));
    let action: FormatAction;
    let note: string | null = pending.never ?? null;
    if (isPruned) action = options.check ? "would-prune" : "pruned";
    else if (pending.state === "invalid") action = "left-invalid";
    else if (pending.never !== undefined) action = "never-rewritten";
    else if (pending.state === "canonical") action = "none";
    else if (pending.owner === "member-repo" && !options.includeMembers) {
      action = "needs-include-members";
      note = MEMBER_NOTE;
    } else if (options.check) action = "would-rewrite";
    else {
      rewrite(pending.file, pending.rendered as string);
      rewritten++;
      action = "rewritten";
    }
    if (pending.state === "non-canonical" && pending.never === undefined && !isPruned) {
      for (const change of pending.changes) if (change.startsWith("duplicate")) deduplicated.push({ file: pending.file, change });
    }
    entries.push({ file: pending.file, kind: pending.kind, owner: pending.owner, state: pending.state, action, note, changes: pending.changes, error: errorEntry(pending.error) });
  }

  const live = entries.filter((entry) => entry.action !== "pruned" && entry.action !== "would-prune");
  const invalid = live.filter((entry) => entry.state === "invalid");
  const remaining = live.filter((entry) => entry.state === "non-canonical" && entry.owner !== "external" && entry.action !== "rewritten");
  const exitCode = pickExitCode([invalid.length > 0 ? EXIT.INVALID : EXIT.OK, remaining.length > 0 ? EXIT.NON_CANONICAL : EXIT.OK]);
  const phase = exitCode === EXIT.INVALID ? "validate" : exitCode === EXIT.NON_CANONICAL ? "canonical" : "complete";

  const report: FormatReport = {
    schemaVersion: 1,
    engineVersion: engineVersion(),
    command: "format",
    mode: options.check ? "check" : "write",
    workspace: scanned === null ? null : { root: scanned.root, file: scanned.workspaceFile },
    includeMembers: options.includeMembers,
    index,
    files: entries,
    members,
    cleanup: {
      deduplicated,
      quarantine:
        scanned === null
          ? { status: "skipped", reason: INDEX_ONLY_REASON, dir: null, moved: [] }
          : { status: options.check ? "planned" : "applied", reason: null, dir: quarantine, moved },
      retention,
      staleIndexEntries,
    },
    summary: {
      files: live.length,
      canonical: live.filter((entry) => entry.state === "canonical").length,
      nonCanonical: live.filter((entry) => entry.state === "non-canonical").length,
      invalid: invalid.length,
      rewritten,
    },
    outcome: { exitCode, result: exitCode === EXIT.OK ? "OK" : "FAIL", phase },
  };
  const stderr: string[] = [];
  for (const entry of invalid) stderr.push(`release-radar: invalid: ${entry.error?.describe ?? entry.file}`);
  if (remaining.length > 0) {
    stderr.push(
      options.check
        ? `release-radar: non-canonical (run format): ${remaining.map((entry) => entry.file).join(", ")}`
        : `release-radar: left non-canonical (member repositories; re-run with --include-members after the user confirms): ${remaining.map((entry) => entry.file).join(", ")}`,
    );
  }
  return { exitCode, phase, stdout: options.json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report), stderr, json: options.json };
}

const ACTION_TEXT: Record<FormatAction, string> = {
  none: "",
  rewritten: "rewritten",
  "would-rewrite": "format would rewrite it",
  "needs-include-members": "not rewritten",
  "never-rewritten": "never rewritten",
  "left-invalid": "left untouched",
  pruned: "deleted (retention)",
  "would-prune": "format would delete it (retention)",
};

function renderHuman(report: FormatReport): string {
  const scope = report.workspace === null ? `index ${report.index?.file ?? ""} (index-only run)` : `workspace ${report.workspace.root}`;
  const lines = [`release-radar format${report.mode === "check" ? " --check" : ""} — ${scope}${report.mode === "check" ? " (writes nothing)" : ""}`, ""];
  for (const entry of report.files) {
    const label = entry.state === "non-canonical" ? "non-canonical (hand-edited)" : entry.state;
    const detail = [ACTION_TEXT[entry.action], entry.note].filter((part) => part !== null && part !== "").join("; ");
    lines.push(`  ${label.padEnd(27)} ${entry.kind.padEnd(19)} ${entry.file}${detail === "" ? "" : `  — ${detail}`}`);
    if (entry.error !== null) lines.push(`      ${entry.error.location === null ? entry.error.message : `${formatLocation(entry.error.location)}: ${entry.error.message}`}`);
    if (entry.state === "non-canonical") for (const change of entry.changes) lines.push(`      - ${change}`);
  }
  for (const member of report.members) if (member.status !== "located") lines.push(`  member ${member.name}: ${member.status}${member.detail === null ? "" : ` (${member.detail})`}`);
  if (report.index !== null && !report.index.exists) lines.push(`  workspace index ${report.index.file}: does not exist yet (the empty initial state)`);
  lines.push("", "cleanup:");
  const { cleanup } = report;
  lines.push(`  duplicates ${report.mode === "check" ? "to remove" : "removed"}: ${cleanup.deduplicated.length}`);
  for (const entry of cleanup.deduplicated) lines.push(`    ${entry.file}: ${entry.change}`);
  if (cleanup.quarantine.status === "skipped") lines.push(`  quarantine: skipped — ${cleanup.quarantine.reason ?? ""}`);
  else lines.push(`  orphans ${report.mode === "check" ? "to move" : "moved"} to quarantine: ${cleanup.quarantine.moved.length}${cleanup.quarantine.dir === null ? "" : ` (${cleanup.quarantine.dir})`}`);
  for (const entry of cleanup.quarantine.moved) lines.push(`    ${entry.from} → ${entry.to} (${entry.reason})`);
  if (cleanup.retention.status === "skipped") lines.push(`  retention: skipped — ${cleanup.retention.reason ?? ""}`);
  else {
    const verb = cleanup.retention.status === "planned" ? "would delete" : "deleted";
    lines.push(`  retention: snapshots keep ${cleanup.retention.snapshots?.keep ?? 0}, ${verb} ${cleanup.retention.snapshots?.deleted.length ?? 0}; handoff packages keep ${cleanup.retention.handoff?.keep ?? 0} per component and stage, ${verb} ${cleanup.retention.handoff?.deleted.length ?? 0}`);
  }
  for (const entry of cleanup.staleIndexEntries) lines.push(`  stale index entry (reported only; remove with workspace-index unregister after confirming): ${entry.path} (${entry.reason})`);
  const s = report.summary;
  lines.push("", `${s.files} file(s): ${s.canonical} canonical, ${s.nonCanonical} non-canonical, ${s.invalid} invalid; ${s.rewritten} rewritten`);
  return `${lines.join("\n")}\n`;
}
