/**
 * Handoff packages (spec requirements 35, 38, 39, 64, 73, 78, 81, 82a; plan Phase 8).
 *
 * A package is written by `handoff-package` for a `handoff` stage — another team deploys it —
 * into the WORKSPACE repository:
 *
 * ```
 * .release-radar/handoff/<component>-<stage>-<YYYY>-<MM>-<DD>T<hh>-<mm>-<ss>-<mmm>Z[-<n>]/
 *   manifest.json                     canonical (schemaVersion 1, key order below)
 *   files/<declared settings path>    each declared settings file, VERBATIM: the exact bytes of
 *                                     `git cat-file blob <promoted commit>:<path>`
 * ```
 * The time is UTC; `-<n>` disambiguates packages created in the same millisecond. Ordering is by
 * the parsed (time, n), never by raw string order. Package directories are created exclusively
 * (never overwritten); the manifest is written LAST, so a directory without a manifest is an
 * interrupted write (an orphan for `format` to quarantine).
 *
 * ## Manifest — canonical key order (schemaVersion 1)
 * ```
 * schemaVersion
 * engineVersion           engine/VERSION of the writing engine
 * createdAt               ISO-8601 UTC with milliseconds
 * component               the member name
 * stage                   the handoff stage
 * receivingOwner          the stage's promotion.owner (the team that deploys it)
 * promotedCommit          full sha the package was built from
 * complete                false when `blocking` is not empty
 * blocking[]     SORTED   blocking findings (e.g. a settings path missing at the commit)
 * image                   null (why: see blocking) or
 *   sourceStage           the stage before the handoff stage, whose live read gave the image
 *   reference             the image reference exactly as the source reported it
 *   repository            the reference without tag and digest, as written
 *   tag                   or null (digest-only reference)
 *   digest                "<algorithm>:<hex>", or the literal "digest unknown"
 *   targets[]  SORTED     the upstream targets running it
 * files[]        SORTED by path, identity path
 *   path                  as declared in component.json (relative to the component root)
 *   sourceCommit          the commit the bytes were read at (= promotedCommit)
 *   sha256                hex sha256 of the copy's bytes
 *   bytes                 byte length of the copy
 * settingsDiff
 *   status                compared | not-compared
 *   deployedCommit        the commit the handoff stage runs now, or null when not compared
 *   reason                why not compared, or null
 *   files[]  SORTED by path   one diff per declared settings file (settings-diff.ts schema)
 * beforePromote
 *   workspace             workspace.json beforePromote[<stage>], or null
 *   component             component.json (at the promoted commit) handoff.beforePromote, or null
 * literalSecretWarnings[] SORTED by file   { file, key } — KEY POINTERS only, never a value
 * ```
 *
 * ## Never rewritten (82a)
 * The copies are validated against the manifest — existence, byte length and sha256 — and are
 * never re-formatted, re-encoded or deleted by `format`. A mismatch makes the package `invalid`
 * ("copy differs from <commit>"); the remedy is to re-run `handoff-package`.
 *
 * ## Retention (39)
 * {@link pruneHandoffPackages} keeps, PER (component, stage), the newest `handoffRetention`
 * VALID packages (engine-named directory, valid manifest with a supported schemaVersion, copies
 * verbatim) and deletes only the older valid ones. Invalid packages and anything not matching the
 * naming pattern are never deleted (format quarantines orphans instead).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_SCHEMA_VERSIONS, NAME_PATTERN, RELEASE_RADAR_DIR, relativePathProblem } from "./config.js";
import { EXIT, EngineError } from "./errors.js";
import { canonicalize, classify, parseJsonStrict, parseJsonWithPositions, render, t, validate, type FileState, type Infer } from "./format.js";
import { SETTINGS_FILE_DIFF_SCHEMA } from "./settings-diff.js";

/** The handoff directory name inside `.release-radar/`. */
export const HANDOFF_DIR = "handoff";
/** The manifest file name inside a package. */
export const MANIFEST_FILE = "manifest.json";
/** The directory of the verbatim copies inside a package. */
export const COPIES_DIR = "files";
/** The literal recorded when the image digest is not known (spec requirement 64). */
export const DIGEST_UNKNOWN = "digest unknown";

/** Engine-written package directory names: `<component>-<stage>-<stamp>[-<n>]`. */
export const HANDOFF_NAME_PATTERN = /^(.+)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-([1-9]\d*))?$/;

const SHA = t.string({ pattern: /^[0-9a-f]{40}$/ });
const NAME = t.string({ pattern: NAME_PATTERN });
const TEXT = t.string({ minLength: 1 });

/** Schema of a package's `manifest.json`. */
export const HANDOFF_MANIFEST_SCHEMA = t.object([
  t.required("schemaVersion", t.schemaVersion(CONFIG_SCHEMA_VERSIONS)),
  t.required("engineVersion", TEXT),
  t.required("createdAt", t.string({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ })),
  t.required("component", NAME),
  t.required("stage", NAME),
  t.required("receivingOwner", TEXT),
  t.required("promotedCommit", SHA),
  t.required("complete", t.boolean()),
  t.required("blocking", t.array(TEXT, { order: { sorted: "$value" } })),
  t.required(
    "image",
    t.nullable(
      t.object([
        t.required("sourceStage", NAME),
        t.required("reference", TEXT),
        t.required("repository", TEXT),
        t.required("tag", t.nullable(TEXT)),
        t.required("digest", t.string({ pattern: /^(?:digest unknown|[A-Za-z][A-Za-z0-9+._-]*:[0-9a-fA-F]{32,})$/ })),
        t.required("targets", t.array(NAME, { order: { sorted: "$value" }, minItems: 1 })),
      ]),
    ),
  ),
  t.required(
    "files",
    t.array(
      t.object([
        t.required("path", TEXT),
        t.required("sourceCommit", SHA),
        t.required("sha256", t.string({ pattern: /^[0-9a-f]{64}$/ })),
        t.required("bytes", t.integer({ min: 0 })),
      ]),
      { order: { sorted: "path" }, identity: "path" },
    ),
  ),
  t.required(
    "settingsDiff",
    t.object([
      t.required("status", t.enum(["compared", "not-compared"])),
      t.required("deployedCommit", t.nullable(SHA)),
      t.required("reason", t.nullable(TEXT)),
      t.required("files", t.array(SETTINGS_FILE_DIFF_SCHEMA, { order: { sorted: "path" }, identity: "path" })),
    ]),
  ),
  t.required("beforePromote", t.object([t.required("workspace", t.nullable(TEXT)), t.required("component", t.nullable(TEXT))])),
  t.required(
    "literalSecretWarnings",
    t.array(t.object([t.required("file", TEXT), t.required("key", t.string())]), { order: { sorted: "file" } }),
  ),
]);

/** A validated handoff manifest. */
export type HandoffManifest = Infer<typeof HANDOFF_MANIFEST_SCHEMA>;

/** Absolute handoff directory of a workspace root. */
export function handoffDir(workspaceRoot: string): string {
  return join(workspaceRoot, RELEASE_RADAR_DIR, HANDOFF_DIR);
}

/** sha256 hex of bytes. */
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `2026-11-25T10:15:30.123Z` → `2026-11-25T10-15-30-123Z`. */
export function stampOf(time: string): string {
  return time.replace(/:/g, "-").replace(".", "-");
}

/** Parsed name of a package directory, or `null` when the name is not engine-written. */
export function handoffOrderKey(name: string): { readonly prefix: string; readonly time: number; readonly sequence: number } | null {
  const match = HANDOFF_NAME_PATTERN.exec(name);
  if (match === null) return null;
  const [, prefix, y, mo, d, h, mi, s, ms, seq] = match;
  const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
  if (Number.isNaN(time)) return null;
  return { prefix: prefix as string, time, sequence: seq === undefined ? 0 : Number(seq) };
}

/** The first free package directory for `component`/`stage` at `time` (nothing is created). */
export function nextPackageDir(workspaceRoot: string, component: string, stage: string, time: string): string {
  const base = `${component}-${stage}-${stampOf(time)}`;
  for (let sequence = 0; ; sequence++) {
    const dir = join(handoffDir(workspaceRoot), sequence === 0 ? base : `${base}-${sequence}`);
    if (!existsSync(dir)) return dir;
  }
}

/** Canonical bytes of a manifest. @throws EngineError 1 when the value breaks the schema (an engine bug). */
export function renderManifest(value: HandoffManifest): string {
  try {
    validate(value, HANDOFF_MANIFEST_SCHEMA, MANIFEST_FILE);
  } catch (error) {
    if (error instanceof EngineError) throw new EngineError(EXIT.INTERNAL, "handoff", `engine produced an invalid manifest: ${error.describe()}`);
    throw error;
  }
  return render(canonicalize(value, HANDOFF_MANIFEST_SCHEMA));
}

/** One verbatim copy to write. */
export interface PackageCopy {
  readonly path: string;
  readonly bytes: Buffer;
}

/**
 * Writes a package: the verbatim copies first, the canonical manifest last. The directory must
 * not exist (never overwrites). @throws EngineError 1 when anything cannot be written.
 */
export function writeHandoffPackage(dir: string, manifest: HandoffManifest, copies: readonly PackageCopy[]): string {
  const text = renderManifest(manifest);
  try {
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(dir);
    for (const copy of copies) {
      const problem = relativePathProblem(copy.path, false);
      if (problem !== null) throw new Error(`settings path ${copy.path} ${problem}`);
      const file = join(dir, COPIES_DIR, ...copy.path.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, copy.bytes, { flag: "wx" });
    }
    const manifestFile = join(dir, MANIFEST_FILE);
    writeFileSync(manifestFile, text, { encoding: "utf8", flag: "wx" });
    return manifestFile;
  } catch (error) {
    throw new EngineError(EXIT.INTERNAL, "handoff", `could not write handoff package ${dir}: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Inspection (format, retention)

/** One verbatim copy as checked against the manifest. */
export interface CopyCheck {
  readonly file: string;
  readonly path: string;
  readonly sourceCommit: string;
  /** `verbatim`: present with the recorded length and sha256. */
  readonly state: "verbatim" | "invalid";
  readonly error?: EngineError;
}

/** An engine-directory entry that does not belong there (quarantined by `format`). */
export interface Orphan {
  /** Absolute path (file or directory). */
  readonly path: string;
  readonly reason: string;
}

/** A package directory as found on disk. */
export interface PackageCheck {
  readonly dir: string;
  readonly name: string;
  readonly order: { readonly prefix: string; readonly time: number; readonly sequence: number };
  readonly manifestFile: string;
  /** The manifest's canonical state (`invalid` also covers a directory name not matching it). */
  readonly state: FileState;
  readonly rendered?: string;
  readonly changes: readonly string[];
  readonly error?: EngineError;
  readonly manifest?: HandoffManifest;
  readonly copies: readonly CopyCheck[];
  /** Files inside the package that the manifest does not account for. */
  readonly strays: readonly Orphan[];
  /** True when the manifest is valid and every copy is verbatim. */
  readonly valid: boolean;
}

/** Result of {@link inspectHandoff}. */
export interface HandoffInspection {
  readonly packages: readonly PackageCheck[];
  readonly orphans: readonly Orphan[];
}

/** True when `text` is an object whose `schemaVersion` is absent or not supported (an orphan). */
export function unsupportedSchemaVersion(text: string): boolean {
  let value: unknown;
  try {
    value = parseJsonStrict(text, "probe");
  } catch {
    return false;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const version = (value as Record<string, unknown>)["schemaVersion"];
  return typeof version !== "number" || !CONFIG_SCHEMA_VERSIONS.includes(version);
}

function locatedError(text: string, file: string, pointer: string, message: string): EngineError {
  try {
    const { line, column } = parseJsonWithPositions(text, file).locate(pointer);
    return new EngineError(EXIT.INVALID, "validate", message, { file, pointer, line, column });
  } catch {
    return new EngineError(EXIT.INVALID, "validate", message, { file, pointer });
  }
}

function listFiles(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    const relative = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) listFiles(path, relative, out);
    else out.push(relative);
  }
}

function checkCopies(dir: string, manifest: HandoffManifest, manifestText: string, manifestFile: string): { copies: CopyCheck[]; pathError?: EngineError } {
  const copies: CopyCheck[] = [];
  for (const [index, entry] of manifest.files.entries()) {
    const problem = relativePathProblem(entry.path, false);
    if (problem !== null) return { copies: [], pathError: locatedError(manifestText, manifestFile, `/files/${index}/path`, `settings path ${JSON.stringify(entry.path)} ${problem}`) };
  }
  for (const entry of manifest.files) {
    const file = join(dir, COPIES_DIR, ...entry.path.split("/"));
    let bytes: Buffer | null = null;
    try {
      if (lstatSync(file).isFile()) bytes = readFileSync(file);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      copies.push({ file, path: entry.path, sourceCommit: entry.sourceCommit, state: "invalid", error: new EngineError(EXIT.INVALID, "validate", `copy missing (expected verbatim from ${entry.sourceCommit}); re-run handoff-package`, { file }) });
    } else if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      copies.push({ file, path: entry.path, sourceCommit: entry.sourceCommit, state: "invalid", error: new EngineError(EXIT.INVALID, "validate", `copy differs from ${entry.sourceCommit} (sha256 or length does not match the manifest); re-run handoff-package`, { file }) });
    } else {
      copies.push({ file, path: entry.path, sourceCommit: entry.sourceCommit, state: "verbatim" });
    }
  }
  return { copies };
}

/** Checks one engine-named package directory. Returns `null` when it is an orphan (reason given). */
function checkPackage(dir: string, name: string, order: PackageCheck["order"]): PackageCheck | Orphan {
  const manifestFile = join(dir, MANIFEST_FILE);
  let isFile = false;
  try {
    isFile = lstatSync(manifestFile).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return { path: dir, reason: `package directory without ${MANIFEST_FILE} (an interrupted write)` };
  const text = readFileSync(manifestFile, "utf8");
  if (unsupportedSchemaVersion(text)) return { path: dir, reason: "manifest with an unknown or unsupported schemaVersion" };
  const base = { dir, name, order, manifestFile, copies: [] as CopyCheck[], strays: [] as Orphan[] };
  const result = classify(text, HANDOFF_MANIFEST_SCHEMA, manifestFile);
  if (result.state === "invalid" || result.value === undefined) {
    return { ...base, state: "invalid", changes: [], ...(result.error === undefined ? {} : { error: result.error }), valid: false };
  }
  const manifest = result.value;
  if (order.prefix !== `${manifest.component}-${manifest.stage}`) {
    const error = locatedError(text, manifestFile, "/component", `package directory name "${name}" does not match the manifest's component "${manifest.component}" and stage "${manifest.stage}"`);
    return { ...base, state: "invalid", changes: [], error, manifest, valid: false };
  }
  const { copies, pathError } = checkCopies(dir, manifest, text, manifestFile);
  if (pathError !== undefined) return { ...base, state: "invalid", changes: [], error: pathError, manifest, valid: false };
  const expected = new Set([MANIFEST_FILE, ...manifest.files.map((entry) => `${COPIES_DIR}/${entry.path}`)]);
  const present: string[] = [];
  listFiles(dir, "", present);
  const strays = present.filter((relative) => !expected.has(relative)).map((relative) => ({ path: join(dir, ...relative.split("/")), reason: "file not listed in the package manifest" }));
  return {
    ...base,
    state: result.state,
    ...(result.rendered === undefined ? {} : { rendered: result.rendered }),
    changes: result.changes,
    manifest,
    copies,
    strays,
    valid: copies.every((copy) => copy.state === "verbatim"),
  };
}

/**
 * Inspects `.release-radar/handoff/`: every engine-named package directory is checked
 * (manifest, verbatim copies, stray files); every other entry is an orphan. Reads only.
 */
export function inspectHandoff(workspaceRoot: string): HandoffInspection {
  const dir = handoffDir(workspaceRoot);
  if (!existsSync(dir)) return { packages: [], orphans: [] };
  const packages: PackageCheck[] = [];
  const orphans: Orphan[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    const order = handoffOrderKey(entry.name);
    if (!entry.isDirectory() || order === null) {
      orphans.push({ path, reason: entry.isDirectory() ? "directory name does not match <component>-<stage>-<timestamp>" : "not a package directory" });
      continue;
    }
    const checked = checkPackage(path, entry.name, order);
    if ("reason" in checked) orphans.push(checked);
    else packages.push(checked);
  }
  return { packages, orphans };
}

/** Result of {@link pruneHandoffPackages}. */
export interface HandoffPruneResult {
  readonly kept: readonly string[];
  readonly deleted: readonly string[];
  /** Engine-named packages left alone because they are not valid. */
  readonly skipped: readonly string[];
}

/**
 * Retention (spec requirement 39): per (component, stage), keeps the newest `retention` valid
 * packages and deletes older valid ones. With `only`, just that pair is pruned (what
 * `handoff-package` does after writing). With `dryRun`, nothing is deleted.
 * @throws EngineError 1 for a non-positive retention (config validation forbids it).
 */
export function pruneHandoffPackages(
  workspaceRoot: string,
  retention: number,
  options: { readonly dryRun: boolean; readonly only?: { readonly component: string; readonly stage: string } },
  inspection: HandoffInspection = inspectHandoff(workspaceRoot),
): HandoffPruneResult {
  if (!Number.isSafeInteger(retention) || retention <= 0) throw new EngineError(EXIT.INTERNAL, "handoff", `retention must be a positive integer, got ${retention}`);
  const groups = new Map<string, PackageCheck[]>();
  const skipped: string[] = [];
  for (const entry of inspection.packages) {
    if (!entry.valid || entry.manifest === undefined) {
      skipped.push(entry.dir);
      continue;
    }
    if (options.only !== undefined && (entry.manifest.component !== options.only.component || entry.manifest.stage !== options.only.stage)) continue;
    const key = `${entry.manifest.component}\u0000${entry.manifest.stage}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const kept: string[] = [];
  const deleted: string[] = [];
  for (const key of [...groups.keys()].sort()) {
    const entries = (groups.get(key) ?? []).sort((a, b) => b.order.time - a.order.time || b.order.sequence - a.order.sequence);
    entries.forEach((entry, index) => {
      if (index < retention) kept.push(entry.dir);
      else {
        if (!options.dryRun) rmSync(entry.dir, { recursive: true });
        deleted.push(entry.dir);
      }
    });
  }
  return { kept, deleted, skipped };
}
