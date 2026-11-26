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

import type { AdapterName, Target } from "../config.js";
import { EXIT, EngineError } from "../errors.js";
import type { ImageInfo } from "../image.js";

// ---------------------------------------------------------------------------
// Requests and readings

/** The configured target shape of one adapter. */
export type TargetOf<N extends AdapterName> = Extract<Target, { adapter: N }>;

/** One target to preflight or read. */
export interface TargetRequest<T extends Target = Target> {
  /** Caller-chosen identity, echoed on the reading (e.g. `<component>/<stage>/<target>`). */
  readonly key: string;
  /** The workspace stage the target belongs to. */
  readonly stage: string;
  /** The target exactly as configured in `component.json`. */
  readonly target: T;
}

/**
 * Whether a registry digest of what actually RUNS was obtained:
 * - `available`: {@link TargetReading.digest} holds a `sha256:` registry digest from the runtime;
 * - `unavailable`: the source can expose one but did not for this target (e.g. a never-pushed
 *   local image, a pod `imageID` that is only an image config id, pods mixed);
 * - `not-exposed`: the source never exposes runtime digests (App Service, Container Apps,
 *   the `command` adapter). A digest written in the configured reference is still in `image`.
 */
export type DigestStatus = "available" | "unavailable" | "not-exposed";

/** One image observed on a target (a container, a pod container, a revision container). */
export interface ContainerReading {
  /** Container name when the source names containers. */
  readonly name: string | null;
  /** The parsed reference. */
  readonly image: ImageInfo;
  /** Where it was observed, e.g. `revision acme-api--0000007`, `pod acme-api-6d9f-abcde`. */
  readonly source: string;
  /** Registry digest observed at runtime for this container, when exposed. */
  readonly digest: string | null;
  /** Local image id / image config id (`sha256:...`); never cross-stage proof. */
  readonly imageId: string | null;
  /** Traffic weight (Container Apps revisions in Multiple mode); `null` elsewhere. */
  readonly trafficWeight: number | null;
}

/** Rollout progress, when the source states it (Kubernetes Deployments). */
export type RolloutState = "complete" | "in-progress";

/** Scalar adapter-specific facts carried into the report (resource group, revision mode, ...). */
export type ReadingDetails = Readonly<Record<string, string | number | boolean | null>>;

/** What a source says about one target (spec requirement 23). */
export interface TargetReading {
  /** The request's key. */
  readonly key: string;
  readonly stage: string;
  /** The target's configured name. */
  readonly target: string;
  readonly adapter: AdapterName;
  /** `missing` = the source answered and the target does not exist there. */
  readonly status: "found" | "missing";
  /** The primary running image (first container / serving revision); `null` when missing or undeterminable. */
  readonly image: ImageInfo | null;
  /** Every image observed, in source order (empty when missing). */
  readonly containers: readonly ContainerReading[];
  /** Source-specific state word (`Running`, `Stopped`, `Available`, `running`, ...). */
  readonly state: string | null;
  /**
   * ISO-8601 UTC timestamp of the source's last-change field. It moves on ANY change to the
   * resource (settings, restarts), so the report labels it an upper bound, never a deploy time.
   */
  readonly lastModified: string | null;
  /** Which source field `lastModified` came from. */
  readonly lastModifiedSource: string | null;
  /** Registry digest of what runs, when {@link digestStatus} is `available`. */
  readonly digest: string | null;
  /** Local image id when the source exposes one (Compose), else `null`. */
  readonly imageId: string | null;
  readonly digestStatus: DigestStatus;
  /** True when the target runs more than one distinct image for the same role (pods / revisions disagree). */
  readonly mixed: boolean;
  /** Rollout progress when the source states it; `null` otherwise. */
  readonly rollout: RolloutState | null;
  /** Adapter-specific scalar facts. */
  readonly details: ReadingDetails;
  /** Human notes (non-container, stopped, latest revision not ready, mixed pods, ...). */
  readonly notes: readonly string[];
}

/** Result of a successful {@link Adapter.preflight}. */
export interface PreflightResult {
  readonly adapter: AdapterName;
  /** Every command issued, rendered for display (argv joined by spaces). */
  readonly commands: readonly string[];
  /** Who/what the CLI is signed in as, when it says (e.g. the az account name); never a secret. */
  readonly identity: string | null;
}

/** One target candidate listed by `discover` (spec requirement 12, Assumption 6). */
export interface DiscoverCandidate {
  readonly adapter: AdapterName;
  /** The stage the candidate was listed for, when the scope is stage-keyed (App Service). */
  readonly stage: string | null;
  /** The configuration fields a target would carry (e.g. `{ webapp }`, `{ context, namespace, deployment }`). */
  readonly fields: Readonly<Record<string, string>>;
  /** Image reference as listed, raw, when the listing shows one. */
  readonly image: string | null;
  readonly state: string | null;
  readonly details: ReadingDetails;
}

/** A deployment-source adapter. */
export interface Adapter<N extends AdapterName = AdapterName> {
  readonly name: N;
  /**
   * Proves the CLI is present and usable for every target in `requests`.
   * @throws AuthError (exit 20) on a missing CLI, missing capability, no login or no context.
   * @throws SourceError (exit 21) on any other failure.
   */
  preflight(requests: readonly TargetRequest<TargetOf<N>>[]): Promise<PreflightResult>;
  /**
   * Reads every requested target; readings come back in request order.
   * @throws AuthError (exit 20) when the source rejects the credentials mid-read.
   * @throws SourceError (exit 21) for timeouts, unparseable output and unknown failures.
   */
  read(requests: readonly TargetRequest<TargetOf<N>>[]): Promise<TargetReading[]>;
}

/** What every adapter factory receives besides its workspace settings. */
export interface AdapterRuntime {
  /**
   * The environment handed to every child process, unchanged. The engine passes its own
   * `process.env`; tests pass a PATH that holds only fake CLIs. Adapters never read from it.
   */
  readonly env: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Errors

/** Why an {@link AuthError} was raised. */
export type AuthErrorKind = "cli-missing" | "capability-missing" | "not-authenticated";

/**
 * Exit 20: the source CLI is missing, lacks a required capability (extension / plugin), is not
 * logged in, has no usable context, or rejected the credentials. Never reported as "missing".
 */
export class AuthError extends EngineError {
  readonly kind: AuthErrorKind;
  /** The binary concerned (`az`, `kubectl`, `docker`, or a command's argv[0]). */
  readonly binary: string;
  /** The exact next step for the operator (re-login command, install hint). */
  readonly hint: string;

  constructor(kind: AuthErrorKind, binary: string, message: string, hint: string) {
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
  readonly binary: string;

  constructor(binary: string, message: string) {
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
export function toIsoUtc(value: unknown, zoneless: "utc" | "reject"): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  if (!hasZone && zoneless === "reject") return null;
  const parsed = new Date(hasZone ? text : `${text}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** A reading for a target the source does not have. */
export function missingReading(request: TargetRequest, note: string, details: ReadingDetails = {}): TargetReading {
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
export function renderCommand(bin: string, args: readonly string[]): string {
  return [bin, ...args].map((part) => (/^[^\s"'\\]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

/** True for a plain JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `value[key]` when `value` is a record; `undefined` otherwise. */
export function field(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** `field(...)` narrowed to a string; `null` when absent or not a string. */
export function stringField(value: unknown, ...path: string[]): string | null {
  const found = field(value, ...path);
  return typeof found === "string" ? found : null;
}

/** `field(...)` narrowed to a finite number; `null` when absent or not a number. */
export function numberField(value: unknown, ...path: string[]): number | null {
  const found = field(value, ...path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

/** `field(...)` narrowed to an array; `[]` when absent or not an array. */
export function arrayField(value: unknown, ...path: string[]): unknown[] {
  const found = field(value, ...path);
  return Array.isArray(found) ? found : [];
}
