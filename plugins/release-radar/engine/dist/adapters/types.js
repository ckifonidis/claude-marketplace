/**
 * The deployment-source adapter contract (spec requirements 16, 18, 21, 23-30; plan Phase 3).
 *
 * Every adapter offers two operations:
 * - {@link Adapter.preflight}: the CLI is present and its login / context is usable for the
 *   scope about to be read. Failure throws {@link AuthError} (exit 20) — never "missing".
 * - {@link Adapter.read}: one {@link TargetReading} per requested target. A target the
 *   source does not know is `status: "missing"` (a fact, not an error); anything the
 *   adapter cannot interpret throws {@link SourceError} (exit 21).
 *
 * Adapters read NO environment variable. Authentication is delegated to each CLI's own login
 * or context; the environment the engine received is passed to the child process unchanged
 * (adapters may add documented, fixed, non-credential variables such as `LC_ALL=C`).
 */
import { EXIT, EngineError } from "../errors.js";
/**
 * Exit 20: the source CLI is missing, lacks a required capability (extension / plugin), is not
 * logged in, has no usable context, or rejected the credentials. Never reported as "missing".
 */
export class AuthError extends EngineError {
    kind;
    /** The binary concerned (`az`, `kubectl`, `docker`, or a command's argv[0]). */
    binary;
    /** The exact next step for the operator (re-login command, install hint). */
    hint;
    constructor(kind, binary, message, hint) {
        super(EXIT.AUTH, "preflight", `${message} — ${hint}`);
        this.name = "AuthError";
        this.kind = kind;
        this.binary = binary;
        this.hint = hint;
    }
}
/** Exit 21: a source failure that is not an auth problem (timeout, unknown error, unparseable output, ambiguity). */
export class SourceError extends EngineError {
    /** The binary concerned. */
    binary;
    constructor(binary, message) {
        super(EXIT.SOURCE, "source", message);
        this.name = "SourceError";
        this.binary = binary;
    }
}
// ---------------------------------------------------------------------------
// Small shared helpers
/**
 * Normalises a source timestamp to ISO-8601 UTC (`toISOString`). A value without a zone
 * designator is read as UTC only when `zoneless` is `"utc"` (the field is documented as UTC,
 * e.g. App Service `lastModifiedTimeUtc`); otherwise it is rejected. Returns `null` for an
 * absent, empty or unparseable value.
 */
export function toIsoUtc(value, zoneless) {
    if (typeof value !== "string" || value.trim() === "")
        return null;
    const text = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text))
        return null;
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    if (!hasZone && zoneless === "reject")
        return null;
    const parsed = new Date(hasZone ? text : `${text}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
/** A reading for a target the source does not have. */
export function missingReading(request, note, details = {}) {
    return {
        key: request.key,
        stage: request.stage,
        target: request.target.name,
        adapter: request.target.adapter,
        status: "missing",
        image: null,
        containers: [],
        state: null,
        lastModified: null,
        lastModifiedSource: null,
        digest: null,
        imageId: null,
        digestStatus: "not-exposed",
        mixed: false,
        rollout: null,
        details,
        notes: [note],
    };
}
/** Renders an argv for display (`bin arg arg`); arguments with spaces are JSON-quoted. */
export function renderCommand(bin, args) {
    return [bin, ...args].map((part) => (/^[^\s"'\\]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}
/** True for a plain JSON object (not an array, not null). */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Reads `value[key]` when `value` is a record; `undefined` otherwise. */
export function field(value, ...path) {
    let current = value;
    for (const key of path) {
        if (!isRecord(current) || !Object.hasOwn(current, key))
            return undefined;
        current = current[key];
    }
    return current;
}
/** `field(...)` narrowed to a string; `null` when absent or not a string. */
export function stringField(value, ...path) {
    const found = field(value, ...path);
    return typeof found === "string" ? found : null;
}
/** `field(...)` narrowed to a finite number; `null` when absent or not a number. */
export function numberField(value, ...path) {
    const found = field(value, ...path);
    return typeof found === "number" && Number.isFinite(found) ? found : null;
}
/** `field(...)` narrowed to an array; `[]` when absent or not an array. */
export function arrayField(value, ...path) {
    const found = field(value, ...path);
    return Array.isArray(found) ? found : [];
}
