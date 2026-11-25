/**
 * The Azure DevOps personal access token (spec requirements 16, 17, 73; research §3.9).
 *
 * - `AZURE_DEVOPS_EXT_PAT` is read ONLY when a pipeline feature is in use (callers decide; this
 *   module is never imported for its side effects). Absent, empty or whitespace-only → exit 20
 *   before any REST call. A value with characters that cannot travel in an HTTP header → 20 too
 *   (otherwise `fetch` would reject the header with a message that could echo it).
 * - `AZURE_DEVOPS_PAT_EXPIRES` (optional, ISO-8601: `YYYY-MM-DD` or a date-time with `Z` or a
 *   `±HH:MM` offset) gives the days remaining and a warning inside `patExpiryWarningDays`. An
 *   expired or unparseable value → 20. A date-only value means 00:00 UTC of that day
 *   (conservative: never later than the token's real expiry on that day).
 *
 * The token itself is held in a {@link PatCredential} whose only state is a private field, so
 * `JSON.stringify`, `util.inspect` and string interpolation of the object never expose it. No
 * message here ever contains either variable's value.
 */
import { EXIT, EngineError } from "../errors.js";
/** The PAT variable (spec requirement 16). */
export const PAT_ENV = "AZURE_DEVOPS_EXT_PAT";
/** The optional expiry variable (spec requirement 16). */
export const PAT_EXPIRES_ENV = "AZURE_DEVOPS_PAT_EXPIRES";
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Visible ASCII only: what an HTTP Basic credential can carry without escaping. */
const HEADER_SAFE = /^[\x21-\x7e]+$/;
/** An opaque holder of the Basic `Authorization` header value. */
export class PatCredential {
    #authorization;
    constructor(pat) {
        this.#authorization = `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`;
    }
    /** The `Authorization` header value. Callers put it in a request header and nowhere else. */
    authorization() {
        return this.#authorization;
    }
    /** Never the token. */
    toJSON() {
        return "[credential]";
    }
    /** Never the token. */
    toString() {
        return "[credential]";
    }
}
function authError(message) {
    return new EngineError(EXIT.AUTH, "preflight", message);
}
/** Parses an ISO-8601 date or date-time; `null` when it is not one. */
export function parseIsoInstant(value) {
    const date = ISO_DATE.exec(value);
    if (date !== null) {
        const [, y, m, d] = date;
        const time = Date.UTC(Number(y), Number(m) - 1, Number(d));
        const parsed = new Date(time);
        // Reject calendar overflow such as 2026-02-31.
        if (parsed.getUTCFullYear() !== Number(y) || parsed.getUTCMonth() !== Number(m) - 1 || parsed.getUTCDate() !== Number(d))
            return null;
        return parsed;
    }
    if (!ISO_DATE_TIME.test(value))
        return null;
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : new Date(time);
}
/**
 * Expiry facts from `AZURE_DEVOPS_PAT_EXPIRES`.
 * @throws EngineError 20 when the value is unparseable or the instant has passed.
 */
export function patExpiry(env, warningDays, now) {
    const raw = env[PAT_EXPIRES_ENV];
    if (raw === undefined) {
        return { declared: false, expires: null, daysRemaining: null, warning: false, detail: `expiry not declared (set ${PAT_EXPIRES_ENV} to an ISO-8601 date to get renewal warnings)` };
    }
    const instant = parseIsoInstant(raw.trim());
    if (instant === null) {
        throw authError(`${PAT_EXPIRES_ENV} is not an ISO-8601 date or date-time (e.g. 2027-01-31 or 2027-01-31T00:00:00Z); fix or unset it`);
    }
    const remainingMs = instant.getTime() - now.getTime();
    if (remainingMs <= 0) {
        throw authError(`the Azure DevOps PAT expired on ${instant.toISOString()} (${PAT_EXPIRES_ENV}); create a new token, update ${PAT_ENV} and ${PAT_EXPIRES_ENV}, and run again`);
    }
    const daysRemaining = Math.floor(remainingMs / DAY_MS);
    const warning = daysRemaining <= warningDays;
    const detail = warning
        ? `PAT expires ${instant.toISOString()} — ${daysRemaining} day(s) remaining, within the ${warningDays}-day warning window: renew it soon`
        : `PAT expires ${instant.toISOString()} — ${daysRemaining} day(s) remaining`;
    return { declared: true, expires: instant.toISOString(), daysRemaining, warning, detail };
}
/** What the PAT-absent message says by default (the read features of `status` / `pipeline-runs`). */
export const DEFAULT_PAT_NEED = "the pipeline sections need an Azure DevOps PAT with Build (Read) and Code (Read); no request was sent. Set it, or pass --no-pipelines to omit the pipeline sections";
/**
 * Reads the PAT and its expiry (the local half of the Azure DevOps preflight; no request).
 * `need` is the rest of the PAT-absent message (the scopes the calling command needs).
 * @throws EngineError 20 when the PAT is absent, empty or not header-safe, or the expiry is
 *   unparseable or past.
 */
export function readPat(env, warningDays, now, need = DEFAULT_PAT_NEED) {
    const raw = env[PAT_ENV];
    if (raw === undefined || raw.trim() === "") {
        throw authError(`${PAT_ENV} is ${raw === undefined ? "not set" : "empty"} — ${need}`);
    }
    const pat = raw.trim();
    if (!HEADER_SAFE.test(pat))
        throw authError(`${PAT_ENV} contains characters a PAT cannot contain (whitespace or non-ASCII); no request was sent`);
    const expiry = patExpiry(env, warningDays, now);
    return { credential: new PatCredential(pat), expiry };
}
