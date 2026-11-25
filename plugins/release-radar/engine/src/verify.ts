/**
 * Real-world verification (spec requirements 15, 16, 21, 40-45, 71, 73; plan decisions D3, D5,
 * Phase 5).
 *
 * Each component declares, per stage, a `verification` block (`config.ts`): a required block
 * `timeoutSeconds` and `checks[]` of three types.
 *
 * - **http**: one request, method `GET` or `HEAD` ONLY (asserted again here, any other method is
 *   an internal error, exit 1), redirects NOT followed (`redirect: "manual"`: a 3xx is just a
 *   status), the answer's status compared with `expectStatus`.
 * - **version**: one `GET`; the value is extracted from the body by a JSON path (the body must
 *   be JSON) or by a regex with the named group `version`; it is compared with the expected
 *   version: `compare: "tag"` exact string equality, `compare: "commit"` equal when one value is
 *   a prefix of the other and the shorter has at least 7 characters, both hex (case-insensitive).
 *   A non-2xx answer, a non-JSON body, an extraction miss, or a body over
 *   {@link MAX_VERSION_BODY_BYTES} is FAIL (the application answered and did not report a version).
 * - **smoke**: an argv run without a shell; exit 0 = PASS. Smoke checks run ONLY on stages owned
 *   by `operatorTeam` (D3, requirement 40a); elsewhere they are `NOT-RUN` with the reason
 *   "not run (stage not owned)", and an EXPLICIT request to run one there is refused with exit 26
 *   before any check runs. Its output is discarded unread; only the exit code is recorded.
 *
 * **Timeout semantics (documented, not a fallback):** a check's own `timeoutSeconds` applies when
 * set; otherwise the block's required `timeoutSeconds` applies. It bounds the whole check (for
 * HTTP: connect, headers and — for version checks — the body).
 *
 * **Outcomes.** `PASS` (expectation met); `FAIL` (answered, expectation not met); `UNREACHABLE`
 * (no answer: DNS failure, connection refused or reset, TLS failure, timeout, command not
 * found); `INCONCLUSIVE` (a version check whose endpoint answered with a version, but the
 * expected version could not be determined — reason starts "expected version unknown");
 * `NOT-RUN` (a smoke check on a stage not owned). UNREACHABLE is never FAIL.
 * Exit: any FAIL → 28; else any UNREACHABLE or INCONCLUSIVE → 30; else 0. NOT-RUN never counts.
 *
 * **Expected version.** `--expect <sha|tag>` when given, applied to every version check in scope;
 * otherwise the commit (compare `commit`) or image tag (compare `tag`) the check's target is
 * reported to run by a live status read in the same run. A check without `target` considers every
 * target of the stage: they must agree on one value. A missing target, an unresolved commit, a
 * digest-pinned image or targets that disagree make the expected version unknown → INCONCLUSIVE.
 *
 * **Headers.** Values come ONLY from the environment variables a check names. Every variable the
 * selected scope needs is checked first: one absent, empty or not a valid header value → exit 20
 * before ANY check runs. Header values are read at request time and never stored, printed or
 * placed in an error message — only variable and header NAMES are.
 *
 * **Recorded per check** ({@link CheckResult}): component, stage, name, type, target, outcome,
 * HTTP status or exit code, latency, the extracted version value (version checks only, at most
 * {@link MAX_EXTRACTED_LENGTH} characters), the expected value and its source, and a reason.
 * NEVER a response body, a header value, a URL query or a command's output.
 *
 * Zero dependencies: HTTP through Node's built-in `fetch`.
 */

import { runCli } from "./adapters/spawn.js";
import type { Component, Stage, VerificationCheck, Workspace } from "./config.js";
import { NAME_PATTERN, isOwnedByOperator } from "./config.js";
import { engineVersion } from "./engine-info.js";
import { EXIT, EngineError } from "./errors.js";
import { evaluateJsonPath } from "./json-path.js";
import type { ObservedTarget } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Constants and contract types

/** The per-check outcomes. */
export const CHECK_OUTCOMES = ["PASS", "FAIL", "UNREACHABLE", "INCONCLUSIVE", "NOT-RUN"] as const;
/** One check outcome. */
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Reason of a smoke check on a stage the operator's team does not own (spec 40a). */
export const NOT_RUN_STAGE_NOT_OWNED = "not run (stage not owned)";
/** What the report says for a component/stage without a verification block (spec 44). */
export const NO_VERIFICATION_CONFIGURED = "no real-world verification configured";
/** Prefix of the reason of an INCONCLUSIVE version check. */
export const EXPECTED_VERSION_UNKNOWN = "expected version unknown";

/** Largest version response body read (1 MiB); larger → FAIL. */
export const MAX_VERSION_BODY_BYTES = 1024 * 1024;
/** Longest extracted version value accepted and recorded; longer → FAIL. */
export const MAX_EXTRACTED_LENGTH = 200;
/** Output cap per stream for smoke commands (output is discarded; the cap bounds memory). */
export const SMOKE_OUTPUT_CAP_BYTES = 1024 * 1024;

/** The only HTTP methods an application request may use (spec requirement 15). */
export const READ_ONLY_METHODS: readonly string[] = ["GET", "HEAD"];

/** The expected version of a version check. */
export type ExpectedVersion =
  | { readonly kind: "known"; readonly value: string; readonly source: "expect" | "status" }
  | { readonly kind: "unknown"; readonly reason: string };

/** One check's recorded result. */
export interface CheckResult {
  readonly component: string;
  readonly stage: string;
  readonly name: string;
  readonly type: VerificationCheck["type"];
  readonly target: string | null;
  readonly outcome: CheckOutcome;
  /** HTTP status of the answer (http/version checks that got one), else null. */
  readonly httpStatus: number | null;
  /** Exit code of a smoke command that exited, else null. */
  readonly exitCode: number | null;
  /** Milliseconds from the start of the check to its answer (or to giving up); null when not run. */
  readonly latencyMs: number | null;
  /** The extracted version value (version checks that extracted one), else null. */
  readonly extracted: string | null;
  /** The expected version and where it came from (version checks with a known one), else null. */
  readonly expected: { readonly value: string; readonly source: "expect" | "status" } | null;
  readonly reason: string;
}

/** Whether, and how, one component/stage pair is verified. */
export interface VerificationBlockReport {
  readonly component: string;
  readonly stage: string;
  /** `not-deployed`: the stage is `null` in component.json; `not-configured`: no `verification` block. */
  readonly status: "configured" | "not-configured" | "not-deployed";
  readonly detail: string;
  /** Smoke disposition on this stage (D3); null when no block. */
  readonly smoke: "run" | "not-run-stage-not-owned" | null;
  /** Checks selected in this block (after `--target` / `--check`). */
  readonly selected: number;
}

/** One check selected to be reported. */
export interface PlannedCheck {
  readonly component: string;
  readonly stage: Stage;
  readonly check: VerificationCheck;
  /** Effective timeout: the check's own `timeoutSeconds`, else the block's. */
  readonly timeoutMs: number;
  /** `false` only for a smoke check on a stage not owned by `operatorTeam`. */
  readonly runnable: boolean;
  /** True when the operator named this check explicitly (`verify --check`). */
  readonly explicit: boolean;
}

/** The selected verification scope. */
export interface VerificationPlan {
  readonly blocks: readonly VerificationBlockReport[];
  readonly checks: readonly PlannedCheck[];
}

/** One component/stage pair to plan. */
export interface PlanScope {
  readonly component: string;
  readonly config: Component;
  readonly stage: Stage;
}

/** Narrowing of the scope (`verify` only; `status --verify` selects everything). */
export interface PlanSelection {
  /** Only checks for this target, plus the stage-wide checks (no `target`). */
  readonly target: string | null;
  /** Only these check names (explicit request); null = every check. */
  readonly checks: readonly string[] | null;
}

function argsError(message: string): EngineError {
  return new EngineError(EXIT.ARGS, "arguments", message);
}

// ---------------------------------------------------------------------------
// Planning and the pre-checks (all before any request)

/**
 * Plans the checks of every scope pair.
 * @throws EngineError 64 when `selection` names a target that is not declared on the stage, or a
 *   check that is not declared in the stage's block (valid names listed) — before any call.
 */
export function planVerification(workspace: Workspace, scopes: readonly PlanScope[], selection: PlanSelection): VerificationPlan {
  const blocks: VerificationBlockReport[] = [];
  const checks: PlannedCheck[] = [];
  for (const scope of scopes) {
    const entry = scope.config.stages[scope.stage.name];
    const where = `${scope.component} / ${scope.stage.name}`;
    if (selection.target !== null) {
      const names = entry === null || entry === undefined ? [] : entry.targets.map((target) => target.name);
      if (!names.includes(selection.target)) {
        throw argsError(`unknown target "${selection.target}" for ${where} (targets: ${names.length === 0 ? "none — the stage is not deployed" : names.join(", ")})`);
      }
    }
    const block = entry === null || entry === undefined ? undefined : entry.verification;
    if (selection.checks !== null) {
      const names = block === undefined ? [] : block.checks.map((check) => check.name);
      const unknown = selection.checks.filter((name) => !names.includes(name));
      if (unknown.length > 0) {
        throw argsError(`unknown check${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")} for ${where} (checks: ${names.length === 0 ? `none — ${NO_VERIFICATION_CONFIGURED}` : names.join(", ")})`);
      }
    }
    if (entry === null || entry === undefined) {
      blocks.push({ component: scope.component, stage: scope.stage.name, status: "not-deployed", detail: `not deployed on this stage; ${NO_VERIFICATION_CONFIGURED}`, smoke: null, selected: 0 });
      continue;
    }
    if (block === undefined) {
      blocks.push({ component: scope.component, stage: scope.stage.name, status: "not-configured", detail: NO_VERIFICATION_CONFIGURED, smoke: null, selected: 0 });
      continue;
    }
    const owned = isOwnedByOperator(workspace, scope.stage);
    const selected = block.checks.filter(
      (check) =>
        (selection.checks === null || selection.checks.includes(check.name)) &&
        (selection.target === null || check.target === undefined || check.target === selection.target),
    );
    for (const check of selected) {
      checks.push({
        component: scope.component,
        stage: scope.stage,
        check,
        timeoutMs: (check.timeoutSeconds ?? block.timeoutSeconds) * 1000,
        runnable: check.type !== "smoke" || owned,
        explicit: selection.checks !== null,
      });
    }
    const narrowed = selection.target !== null || selection.checks !== null ? ` (${selected.length} of ${block.checks.length} selected)` : "";
    blocks.push({
      component: scope.component,
      stage: scope.stage.name,
      status: "configured",
      detail: `${block.checks.length} check(s) configured${narrowed}; timeout ${block.timeoutSeconds}s unless a check sets its own`,
      smoke: owned ? "run" : "not-run-stage-not-owned",
      selected: selected.length,
    });
  }
  return { blocks, checks };
}

/** True when `value` can be sent as an HTTP header value (no CR, LF or NUL; visible ASCII/obs-text). */
export function isValidHeaderValue(value: string): boolean {
  return /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}

/**
 * Verification-credential preflight (spec requirements 16, 18): every environment variable named
 * by a header of a RUNNABLE check in `plan` must be set to a non-empty valid header value.
 * Reads the variables only to test them; never returns, stores or prints a value.
 * @throws EngineError 20 naming each variable (and the checks needing it) — before any check runs.
 */
export function headerPreflight(plan: VerificationPlan, env: NodeJS.ProcessEnv): void {
  const problems = new Map<string, { problem: string; uses: string[] }>();
  for (const planned of plan.checks) {
    if (!planned.runnable || planned.check.type === "smoke") continue;
    for (const [header, source] of Object.entries(planned.check.headers ?? {})) {
      const value = env[source.env];
      let problem: string | null = null;
      if (value === undefined) problem = "is not set";
      else if (value === "") problem = "is empty";
      else if (!isValidHeaderValue(value)) problem = "does not hold a valid HTTP header value (control characters)";
      if (problem === null) continue;
      const use = `${planned.component}/${planned.stage.name}/${planned.check.name} header ${header}`;
      const known = problems.get(source.env);
      if (known === undefined) problems.set(source.env, { problem, uses: [use] });
      else known.uses.push(use);
    }
  }
  if (problems.size === 0) return;
  const lines = [...problems.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, entry]) => `  - ${name} ${entry.problem} (needed by ${entry.uses.join(", ")})`);
  throw new EngineError(
    EXIT.AUTH,
    "preflight",
    [
      "verification header preflight failed — a credential problem, NOT a verification failure; no check ran and no report was produced. Set the named environment variable(s) and run again (values are never shown):",
      ...lines,
    ].join("\n"),
  );
}

/**
 * Refuses an explicit request to run a smoke check on a stage not owned by `operatorTeam`
 * (spec requirement 40a; D3 — there is no per-run override).
 * @throws EngineError 26 naming the checks and the stage owner — before any check runs.
 */
export function refuseExplicitSmoke(plan: VerificationPlan): void {
  const refused = plan.checks.filter((planned) => planned.explicit && !planned.runnable);
  if (refused.length === 0) return;
  const lines = refused.map(
    (planned) => `  - ${planned.component}/${planned.stage.name}/${planned.check.name}: stage "${planned.stage.name}" is owned by "${planned.stage.promotion.owner ?? "(no owner)"}", not by the operator's team`,
  );
  throw new EngineError(
    EXIT.REFUSED,
    "refused",
    ["refused: smoke commands run only on stages owned by the operator's team (no override); nothing was run:", ...lines].join("\n"),
  );
}

/** True for 7-40 hex characters (a full or abbreviated commit sha). */
export function isCommitLike(value: string): boolean {
  return /^[0-9a-fA-F]{7,40}$/.test(value);
}

/**
 * Validates `--expect` against the version checks it will be compared with.
 * @throws EngineError 64 when a selected commit-compare check would receive a value that is not
 *   7-40 hex characters.
 */
export function validateExpect(plan: VerificationPlan, expect: string): void {
  if (expect === "" || /\s/.test(expect)) throw argsError(`--expect must be a commit sha or a tag without whitespace`);
  for (const planned of plan.checks) {
    if (planned.check.type === "version" && planned.check.compare === "commit" && !isCommitLike(expect)) {
      throw argsError(`--expect "${expect}" is not a commit sha (7-40 hex characters), but check "${planned.check.name}" compares commits`);
    }
  }
}

// ---------------------------------------------------------------------------
// Expected version and comparison

/**
 * The version a check's target(s) are reported to run, from the live status read: the resolved
 * commit sha (`compare: "commit"`) or the image tag (`compare: "tag"`). A check without `target`
 * considers every target of the stage, which must agree on one value.
 */
export function expectedFromObserved(check: Extract<VerificationCheck, { type: "version" }>, observed: readonly ObservedTarget[]): ExpectedVersion {
  const considered = check.target === undefined ? observed : observed.filter((target) => target.name === check.target);
  if (considered.length === 0) return { kind: "unknown", reason: `${EXPECTED_VERSION_UNKNOWN}: no target was read for this stage` };
  const values = new Map<string, string[]>();
  for (const target of considered) {
    if (target.reading.status === "missing") return { kind: "unknown", reason: `${EXPECTED_VERSION_UNKNOWN}: target ${target.name} is missing at the source` };
    let value: string;
    if (check.compare === "commit") {
      if (target.commit === null) return { kind: "unknown", reason: `${EXPECTED_VERSION_UNKNOWN}: target ${target.name} runs no single container image whose commit can be resolved` };
      if (target.commit.status !== "resolved") return { kind: "unknown", reason: `${EXPECTED_VERSION_UNKNOWN}: the commit of target ${target.name} is not resolved (${target.commit.status})` };
      value = target.commit.sha;
    } else {
      const image = target.reading.image;
      if (image === null || image.kind !== "image") return { kind: "unknown", reason: `${EXPECTED_VERSION_UNKNOWN}: target ${target.name} runs no single container image` };
      if (image.tag === null) return { kind: "unknown", reason: `${EXPECTED_VERSION_UNKNOWN}: target ${target.name} is pinned by digest (no tag)` };
      value = image.tag;
    }
    values.set(value, [...(values.get(value) ?? []), target.name]);
  }
  if (values.size > 1) {
    const listed = [...values.entries()].map(([value, names]) => `${names.join(", ")} → ${check.compare === "commit" ? value.slice(0, 7) : value}`).join("; ");
    return { kind: "unknown", reason: `${EXPECTED_VERSION_UNKNOWN}: the stage's targets run different versions (${listed}); name a target in the check or pass --expect` };
  }
  return { kind: "known", value: [...values.keys()][0] as string, source: "status" };
}

/**
 * Commit equality (spec requirement 42): both values hex, one a prefix of the other
 * (case-insensitive), and the shorter at least 7 characters long.
 */
export function commitsMatch(a: string, b: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return false;
  const [shorter, longer] = a.length <= b.length ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
  return shorter.length >= 7 && longer.startsWith(shorter);
}

/** `tag`: exact string equality; `commit`: {@link commitsMatch}. */
export function versionsMatch(compare: "commit" | "tag", extracted: string, expected: string): boolean {
  return compare === "tag" ? extracted === expected : commitsMatch(extracted, expected);
}

/**
 * Extracts the version from a response body.
 * - `json-path`: the body must parse as JSON; the value at the path must be a non-empty string or
 *   a finite number;
 * - `regex`: the first match's named group `version` (required by config validation), non-empty.
 */
export function extractVersion(extract: Extract<VerificationCheck, { type: "version" }>["extract"], body: string): { value: string } | { problem: string } {
  let value: string;
  if (extract.type === "json-path") {
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      return { problem: "the response body is not JSON" };
    }
    const found = evaluateJsonPath(document, extract.path);
    if (!found.found) return { problem: `nothing at ${extract.path}: ${found.reason}` };
    if (typeof found.value === "string") value = found.value;
    else if (typeof found.value === "number" && Number.isFinite(found.value)) value = String(found.value);
    else return { problem: `the value at ${extract.path} is not a string or a number` };
  } else {
    const match = new RegExp(extract.pattern, "u").exec(body);
    if (match === null) return { problem: "the version pattern matched nothing in the response" };
    value = match.groups?.["version"] ?? "";
  }
  if (value === "") return { problem: "the extracted version is empty" };
  if (value.length > MAX_EXTRACTED_LENGTH) return { problem: `the extracted value is longer than ${MAX_EXTRACTED_LENGTH} characters (not recorded)` };
  return { value };
}

// ---------------------------------------------------------------------------
// HTTP

/** How one HTTP request ended. */
export type HttpProbe =
  | { readonly kind: "answered"; readonly status: number; readonly latencyMs: number; readonly body: string | null }
  | { readonly kind: "too-large"; readonly status: number; readonly latencyMs: number }
  | { readonly kind: "no-answer"; readonly reason: string; readonly latencyMs: number };

/** Asserts the read-only method rule (spec requirement 15). @throws EngineError 1 for any other method. */
export function assertReadOnlyMethod(method: string): void {
  if (!READ_ONLY_METHODS.includes(method)) {
    throw new EngineError(EXIT.INTERNAL, "verification", `internal error: refusing to send an HTTP ${method} to an application (only GET and HEAD are ever sent)`);
  }
}

const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_OSSL|HOSTNAME_MISMATCH)/;

function errorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  const name = error !== null && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || (signal.aborted && name === "AbortError") || (signal.aborted && (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError");
}

/**
 * Names why no answer was obtained, from the error CODE only — never from a message, so no
 * header value or body can leak into a reason.
 */
export function describeNoAnswer(error: unknown, signal: AbortSignal, timeoutMs: number): string {
  if (isTimeout(error, signal)) return `no answer within ${timeoutMs / 1000}s (timeout)`;
  const code = errorCode(error);
  if (code === null) return "no answer (network error)";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return `DNS lookup failed (${code})`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE" || code === "UND_ERR_CLOSED") return `connection closed before an answer (${code})`;
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return `connection timed out (${code})`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EHOSTDOWN") return `host unreachable (${code})`;
  if (TLS_CODE.test(code)) return `TLS failure (${code})`;
  return `no answer (${code})`;
}

function since(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

/**
 * Sends ONE read-only request. Redirects are not followed. With `readBody`, reads at most
 * `maxBodyBytes` of the body (decoded as UTF-8); otherwise the body is discarded unread.
 * The latency is measured to the response headers (`readBody: false`) or to the end of the body.
 */
export async function httpProbe(input: {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly readBody: boolean;
  readonly maxBodyBytes: number;
}): Promise<HttpProbe> {
  assertReadOnlyMethod(input.method);
  const signal = AbortSignal.timeout(input.timeoutMs);
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: input.method,
      // A configured User-Agent (any case) replaces the engine's own; the two are never combined.
      headers: Object.keys(input.headers).some((name) => name.toLowerCase() === "user-agent")
        ? { ...input.headers }
        : { "user-agent": `release-radar/${engineVersion()}`, ...input.headers },
      redirect: "manual",
      signal,
    });
  } catch (error) {
    return { kind: "no-answer", reason: describeNoAnswer(error, signal, input.timeoutMs), latencyMs: since(started) };
  }
  if (!input.readBody || response.body === null) {
    const latencyMs = since(started);
    await response.body?.cancel().catch(() => undefined);
    return { kind: "answered", status: response.status, latencyMs, body: input.readBody ? "" : null };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > input.maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large", status: response.status, latencyMs: since(started) };
      }
      chunks.push(value);
    }
  } catch (error) {
    const reason = describeNoAnswer(error, signal, input.timeoutMs);
    return { kind: "no-answer", reason: `${reason} while reading the response`, latencyMs: since(started) };
  }
  const body = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  return { kind: "answered", status: response.status, latencyMs: since(started), body };
}

/** Builds the request headers from the named variables (validated by {@link headerPreflight}). */
function requestHeaders(check: Extract<VerificationCheck, { type: "http" | "version" }>, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, source] of Object.entries(check.headers ?? {})) {
    const value = env[source.env];
    // headerPreflight ran first; reaching this is an engine bug, reported by NAME only.
    if (value === undefined || value === "") throw new EngineError(EXIT.INTERNAL, "verification", `header variable ${source.env} vanished after preflight`);
    headers[name] = value;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Running the checks

function baseResult(planned: PlannedCheck): Pick<CheckResult, "component" | "stage" | "name" | "type" | "target"> {
  return { component: planned.component, stage: planned.stage.name, name: planned.check.name, type: planned.check.type, target: planned.check.target ?? null };
}

function result(planned: PlannedCheck, fields: Partial<Omit<CheckResult, "component" | "stage" | "name" | "type" | "target">> & Pick<CheckResult, "outcome" | "reason">): CheckResult {
  // Built key by key so the JSON key order is the documented contract order.
  return {
    ...baseResult(planned),
    outcome: fields.outcome,
    httpStatus: fields.httpStatus ?? null,
    exitCode: fields.exitCode ?? null,
    latencyMs: fields.latencyMs ?? null,
    extracted: fields.extracted ?? null,
    expected: fields.expected ?? null,
    reason: fields.reason,
  };
}

function statusList(statuses: readonly number[]): string {
  return statuses.length === 1 ? String(statuses[0]) : `${statuses.slice(0, -1).join(", ")} or ${statuses[statuses.length - 1]}`;
}

async function runHttp(planned: PlannedCheck, check: Extract<VerificationCheck, { type: "http" }>, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const probe = await httpProbe({ url: check.url, method: check.method, headers: requestHeaders(check, env), timeoutMs: planned.timeoutMs, readBody: false, maxBodyBytes: 0 });
  if (probe.kind === "no-answer") return result(planned, { outcome: "UNREACHABLE", latencyMs: probe.latencyMs, reason: probe.reason });
  const pass = check.expectStatus.includes(probe.status);
  return result(planned, {
    outcome: pass ? "PASS" : "FAIL",
    httpStatus: probe.status,
    latencyMs: probe.latencyMs,
    reason: pass ? `${check.method} answered HTTP ${probe.status}` : `${check.method} answered HTTP ${probe.status}, expected ${statusList(check.expectStatus)}${probe.status >= 300 && probe.status < 400 ? " (redirects are not followed)" : ""}`,
  });
}

async function runVersion(planned: PlannedCheck, check: Extract<VerificationCheck, { type: "version" }>, env: NodeJS.ProcessEnv, expected: ExpectedVersion): Promise<CheckResult> {
  const probe = await httpProbe({ url: check.url, method: "GET", headers: requestHeaders(check, env), timeoutMs: planned.timeoutMs, readBody: true, maxBodyBytes: MAX_VERSION_BODY_BYTES });
  const expectedField = expected.kind === "known" ? { value: expected.value, source: expected.source } : null;
  if (probe.kind === "no-answer") return result(planned, { outcome: "UNREACHABLE", latencyMs: probe.latencyMs, expected: expectedField, reason: probe.reason });
  if (probe.kind === "too-large") {
    return result(planned, { outcome: "FAIL", httpStatus: probe.status, latencyMs: probe.latencyMs, expected: expectedField, reason: `the version response is larger than ${MAX_VERSION_BODY_BYTES} bytes` });
  }
  if (probe.status < 200 || probe.status > 299) {
    return result(planned, {
      outcome: "FAIL",
      httpStatus: probe.status,
      latencyMs: probe.latencyMs,
      expected: expectedField,
      reason: `GET answered HTTP ${probe.status}, expected a 2xx carrying the version${probe.status >= 300 && probe.status < 400 ? " (redirects are not followed)" : ""}`,
    });
  }
  const extracted = extractVersion(check.extract, probe.body ?? "");
  if ("problem" in extracted) {
    return result(planned, { outcome: "FAIL", httpStatus: probe.status, latencyMs: probe.latencyMs, expected: expectedField, reason: `answered HTTP ${probe.status} but reported no version: ${extracted.problem}` });
  }
  const base = { httpStatus: probe.status, latencyMs: probe.latencyMs, extracted: extracted.value };
  if (expected.kind === "unknown") return result(planned, { ...base, outcome: "INCONCLUSIVE", reason: expected.reason });
  const pass = versionsMatch(check.compare, extracted.value, expected.value);
  const from = expected.source === "expect" ? "--expect" : "the live status read";
  return result(planned, {
    ...base,
    outcome: pass ? "PASS" : "FAIL",
    expected: { value: expected.value, source: expected.source },
    reason: pass
      ? `reports ${extracted.value}, matching ${expected.value} from ${from} (compare ${check.compare})`
      : `version mismatch: reports ${extracted.value}, expected ${expected.value} from ${from} (compare ${check.compare}${check.compare === "commit" ? ": one must be a hex prefix of the other, at least 7 characters" : ": exact equality"})`,
  });
}

async function runSmoke(planned: PlannedCheck, check: Extract<VerificationCheck, { type: "smoke" }>, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const [bin, ...args] = check.argv as [string, ...string[]];
  const started = performance.now();
  const outcome = await runCli({ bin, args, timeoutMs: planned.timeoutMs, env, maxOutputBytes: SMOKE_OUTPUT_CAP_BYTES });
  const latencyMs = since(started);
  // The command's stdout and stderr are discarded here, unread: only the exit code is recorded.
  switch (outcome.kind) {
    case "ok":
      return result(planned, { outcome: "PASS", exitCode: 0, latencyMs, reason: "exited 0" });
    case "exit":
      return outcome.code === null
        ? result(planned, { outcome: "FAIL", latencyMs, reason: `terminated by signal ${outcome.signal ?? "?"} (no exit 0)` })
        : result(planned, { outcome: "FAIL", exitCode: outcome.code, latencyMs, reason: `exited ${outcome.code}, expected 0` });
    case "cli-missing":
      return result(planned, { outcome: "UNREACHABLE", latencyMs, reason: `command not found: \`${outcome.bin}\` is ${outcome.reason}` });
    case "timeout":
      return result(planned, { outcome: "UNREACHABLE", latencyMs, reason: `no exit within ${planned.timeoutMs / 1000}s (timeout; the command was killed)` });
    case "overflow":
      return result(planned, { outcome: "UNREACHABLE", latencyMs, reason: `killed after writing more than ${outcome.limit} bytes to ${outcome.stream}; no exit code obtained` });
    case "spawn-error":
      return result(planned, { outcome: "UNREACHABLE", latencyMs, reason: `the command could not be started` });
  }
}

/**
 * Runs one planned check. A non-runnable smoke check is `NOT-RUN` without starting anything.
 * `expected` is consulted only for version checks.
 */
export async function runCheck(planned: PlannedCheck, env: NodeJS.ProcessEnv, expected: ExpectedVersion | null): Promise<CheckResult> {
  const check = planned.check;
  if (!planned.runnable) return result(planned, { outcome: "NOT-RUN", reason: NOT_RUN_STAGE_NOT_OWNED });
  switch (check.type) {
    case "http":
      return runHttp(planned, check, env);
    case "version":
      return runVersion(planned, check, env, expected ?? { kind: "unknown", reason: `${EXPECTED_VERSION_UNKNOWN}: no expected version was supplied` });
    case "smoke":
      return runSmoke(planned, check, env);
  }
}

/**
 * Runs every planned check, one after another in plan order (component, stage, check name).
 * Callers run {@link headerPreflight} and {@link refuseExplicitSmoke} first.
 */
export async function runVerification(plan: VerificationPlan, env: NodeJS.ProcessEnv, expectedFor: (planned: PlannedCheck) => ExpectedVersion | null): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const planned of plan.checks) {
    results.push(await runCheck(planned, env, planned.check.type === "version" && planned.runnable ? expectedFor(planned) : null));
  }
  return results;
}

/** True when some runnable version check in `plan` needs an expected version. */
export function needsExpectedVersion(plan: VerificationPlan): boolean {
  return plan.checks.some((planned) => planned.runnable && planned.check.type === "version");
}

// ---------------------------------------------------------------------------
// Aggregation

/** Counts per outcome. */
export interface VerificationSummary {
  readonly pass: number;
  readonly fail: number;
  readonly unreachable: number;
  readonly inconclusive: number;
  readonly notRun: number;
}

/** Counts the outcomes. */
export function summarize(results: readonly CheckResult[]): VerificationSummary {
  const count = (outcome: CheckOutcome) => results.filter((entry) => entry.outcome === outcome).length;
  return { pass: count("PASS"), fail: count("FAIL"), unreachable: count("UNREACHABLE"), inconclusive: count("INCONCLUSIVE"), notRun: count("NOT-RUN") };
}

/** Any FAIL → 28; else any UNREACHABLE or INCONCLUSIVE → 30; else 0 (spec 41, D5). */
export function verificationExitCode(results: readonly CheckResult[]): number {
  const summary = summarize(results);
  if (summary.fail > 0) return EXIT.VERIFY_FAILED;
  if (summary.unreachable > 0 || summary.inconclusive > 0) return EXIT.VERIFY_INCONCLUSIVE;
  return EXIT.OK;
}

/** Overall verdict of a set of results: FAIL, INCONCLUSIVE, PASS, or NO-CHECKS (nothing ran). */
export function overallOutcome(results: readonly CheckResult[]): "PASS" | "FAIL" | "INCONCLUSIVE" | "NO-CHECKS" {
  const summary = summarize(results);
  if (summary.fail > 0) return "FAIL";
  if (summary.unreachable > 0 || summary.inconclusive > 0) return "INCONCLUSIVE";
  return summary.pass > 0 ? "PASS" : "NO-CHECKS";
}

/** Human one-line summary of the counts. */
export function summaryText(summary: VerificationSummary): string {
  return `${summary.pass} PASS · ${summary.fail} FAIL · ${summary.unreachable} UNREACHABLE · ${summary.inconclusive} INCONCLUSIVE · ${summary.notRun} not run`;
}

/** Parses a `--check a,b` list. @throws EngineError 64 for an empty, malformed or repeated name. */
export function parseCheckList(value: string): string[] {
  const names = value.split(",");
  for (const name of names) {
    if (!NAME_PATTERN.test(name)) throw argsError(`--check: ${JSON.stringify(name)} is not a check name (comma-separated names, e.g. health,version)`);
  }
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length > 0) throw argsError(`--check names ${[...new Set(repeated)].join(", ")} more than once`);
  return names;
}
