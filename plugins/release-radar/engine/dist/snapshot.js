/**
 * Status snapshots (spec requirements 38, 39, 50, 78, 86; plan Phase 4).
 *
 * Every `status` run that produces a report — exit 0, 22, 23, 28 or 30 — writes
 * `<workspace>/.release-radar/snapshots/<timestamp>.json` in canonical form. Runs ending in 20,
 * 21, 24, 29 or 64 (or 1) write none. Snapshots are engine-owned files: written canonically,
 * never holding a secret value (the report holds none).
 *
 * File name: `<YYYY>-<MM>-<DD>T<hh>-<mm>-<ss>-<mmm>Z.json` (UTC; `:` is not portable in file
 * names), or `…Z-<n>.json` when several runs share one millisecond. Ordering is by the parsed
 * (timestamp, n), never by raw string order.
 *
 * ## Canonical key order (schemaVersion 1)
 * ```
 * schemaVersion
 * engineVersion        engine/VERSION of the writing engine
 * time                 ISO-8601 UTC (= report.generatedAt)
 * exitCode             0 | 22 | 23 | 28 | 30
 * fingerprint          sha256 hex over the canonical workspace + each component.json used
 * components[]         SORTED: names of the components the report covers
 * members[]            SORTED by name: { name, availability, reason|null, revision|null }
 *                      availability "available" | "unavailable"; reason "no-local-clone" |
 *                      "no-component-config" (unavailable only); revision "working-tree" or a
 *                      commit sha (the component.json revision used), null when unavailable
 * report               the full `--json` report (opaque here; its contract is report.ts),
 *                      object keys sorted recursively, array order kept
 * ```
 *
 * Retention (39): {@link pruneSnapshots} keeps the newest `snapshotRetention` snapshots and
 * deletes only older files that match the naming pattern AND parse as a snapshot with a
 * supported schemaVersion. Requirement 39 makes retention part of cleanup (requirement 81),
 * which `format` performs; `status` therefore never prunes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SCHEMA_VERSIONS, RELEASE_RADAR_DIR } from "./config.js";
import { EXIT, EngineError } from "./errors.js";
import { canonicalize, classify, render, t, validate } from "./format.js";
/** The snapshots directory name inside `.release-radar/`. */
export const SNAPSHOTS_DIR = "snapshots";
/** Exit codes after which `status` writes a snapshot (spec requirement 50). */
export const SNAPSHOT_EXIT_CODES = [EXIT.OK, EXIT.DRIFT, EXIT.MISSING, EXIT.VERIFY_FAILED, EXIT.VERIFY_INCONCLUSIVE];
/** Engine-written snapshot names. */
export const SNAPSHOT_NAME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-([1-9]\d*))?\.json$/;
const MEMBER = t.object([
    t.required("name", t.string({ minLength: 1 })),
    t.required("availability", t.enum(["available", "unavailable"])),
    t.required("reason", t.nullable(t.enum(["no-local-clone", "no-component-config"]))),
    t.required("revision", t.nullable(t.string({ minLength: 1 }))),
]);
/** Schema of a snapshot file. */
export const SNAPSHOT_SCHEMA = t.object([
    t.required("schemaVersion", t.schemaVersion(CONFIG_SCHEMA_VERSIONS)),
    t.required("engineVersion", t.string({ minLength: 1 })),
    t.required("time", t.string({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ })),
    t.required("exitCode", t.integer({ min: 0 })),
    t.required("fingerprint", t.string({ pattern: /^[0-9a-f]{64}$/ })),
    t.required("components", t.array(t.string({ minLength: 1 }), { order: { sorted: "$value" } })),
    t.required("members", t.array(MEMBER, { order: { sorted: "name" }, identity: "name" })),
    t.required("report", t.json()),
]);
/** Absolute snapshots directory of a workspace root. */
export function snapshotsDir(workspaceRoot) {
    return join(workspaceRoot, RELEASE_RADAR_DIR, SNAPSHOTS_DIR);
}
/** `2026-11-25T10:15:30.123Z` → `2026-11-25T10-15-30-123Z`. */
function stampOf(time) {
    return time.replace(/:/g, "-").replace(".", "-");
}
/** Parsed order key of a snapshot file name, or `null` when the name is not engine-written. */
export function snapshotOrderKey(name) {
    const match = SNAPSHOT_NAME_PATTERN.exec(name);
    if (match === null)
        return null;
    const [, y, mo, d, h, mi, s, ms, seq] = match;
    const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
    if (Number.isNaN(time))
        return null;
    return { time, sequence: seq === undefined ? 0 : Number(seq) };
}
/**
 * The file a snapshot taken at `time` will be written to: the first free name of
 * `<stamp>.json`, `<stamp>-1.json`, … (nothing is created).
 */
export function nextSnapshotFile(workspaceRoot, time) {
    const dir = snapshotsDir(workspaceRoot);
    const stamp = stampOf(time);
    for (let sequence = 0;; sequence++) {
        const file = join(dir, sequence === 0 ? `${stamp}.json` : `${stamp}-${sequence}.json`);
        if (!existsSync(file))
            return file;
    }
}
/** Canonical bytes of a snapshot value. @throws EngineError 1 when the value breaks the schema (an engine bug). */
export function renderSnapshot(value) {
    try {
        validate(value, SNAPSHOT_SCHEMA, "snapshot");
    }
    catch (error) {
        if (error instanceof EngineError)
            throw new EngineError(EXIT.INTERNAL, "snapshot", `engine produced an invalid snapshot: ${error.describe()}`);
        throw error;
    }
    return render(canonicalize(value, SNAPSHOT_SCHEMA));
}
/**
 * Writes a snapshot canonically to `file` (from {@link nextSnapshotFile}), creating the
 * directory. Never overwrites an existing file.
 * @throws EngineError 1 when the file cannot be written.
 */
export function writeSnapshot(file, value) {
    const text = renderSnapshot(value);
    try {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
    }
    catch (error) {
        throw new EngineError(EXIT.INTERNAL, "snapshot", `could not write snapshot ${file}: ${error.message}`);
    }
}
/**
 * Lists engine-named snapshot files, newest first. Files that do not match the naming pattern
 * are not listed (they are orphans for `format` to quarantine, never touched here).
 */
export function listSnapshots(workspaceRoot) {
    const dir = snapshotsDir(workspaceRoot);
    if (!existsSync(dir))
        return [];
    const files = [];
    for (const name of readdirSync(dir)) {
        const order = snapshotOrderKey(name);
        if (order === null)
            continue;
        const file = join(dir, name);
        const result = classify(readFileSync(file, "utf8"), SNAPSHOT_SCHEMA, file);
        if (result.state === "invalid" || result.value === undefined) {
            files.push({ file, name, order, state: "invalid", problem: result.error?.describe() ?? "invalid" });
        }
        else {
            files.push({ file, name, order, state: result.state, snapshot: result.value });
        }
    }
    return files.sort((a, b) => b.order.time - a.order.time || b.order.sequence - a.order.sequence);
}
/**
 * Retention (spec requirement 39): keeps the newest `retention` valid snapshots and deletes
 * the older valid ones. Invalid or unsupported-schemaVersion files and files outside the naming
 * pattern are never deleted. With `dryRun`, nothing is deleted.
 * @throws EngineError 1 for a non-positive retention (config validation forbids it).
 */
export function pruneSnapshots(workspaceRoot, retention, options) {
    if (!Number.isSafeInteger(retention) || retention <= 0)
        throw new EngineError(EXIT.INTERNAL, "snapshot", `retention must be a positive integer, got ${retention}`);
    const kept = [];
    const deleted = [];
    const skipped = [];
    for (const entry of listSnapshots(workspaceRoot)) {
        if (entry.state === "invalid") {
            skipped.push({ file: entry.file, problem: entry.problem ?? "invalid" });
            continue;
        }
        if (kept.length < retention) {
            kept.push(entry.file);
            continue;
        }
        if (!options.dryRun)
            rmSync(entry.file);
        deleted.push(entry.file);
    }
    return { kept, deleted, skipped };
}
/**
 * The newest valid snapshot (skipping invalid files and, with `component`, snapshots that do not
 * cover it), judged for freshness against `freshnessMinutes` and the current configuration
 * fingerprint; `null` when none qualifies.
 */
export function newestSnapshot(workspaceRoot, criteria) {
    for (const entry of listSnapshots(workspaceRoot)) {
        if (entry.state === "invalid" || entry.snapshot === undefined)
            continue;
        const snapshot = entry.snapshot;
        if (criteria.component !== undefined && !snapshot.components.includes(criteria.component))
            continue;
        const ageMinutes = (criteria.now.getTime() - Date.parse(snapshot.time)) / 60_000;
        const currentFingerprint = typeof criteria.fingerprint === "string" ? criteria.fingerprint : criteria.fingerprint(snapshot);
        const fingerprintMatches = currentFingerprint !== null && snapshot.fingerprint === currentFingerprint;
        return {
            file: entry.file,
            state: entry.state,
            time: snapshot.time,
            exitCode: snapshot.exitCode,
            fingerprint: snapshot.fingerprint,
            ageMinutes,
            currentFingerprint,
            fingerprintMatches,
            fresh: fingerprintMatches && ageMinutes >= 0 && ageMinutes <= criteria.freshnessMinutes,
            snapshot,
        };
    }
    return null;
}
