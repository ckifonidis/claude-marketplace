/**
 * Container image references (spec requirements 23-28, 51-52; plan decision D16).
 *
 * Grammar (distribution/reference): `[registry[:port]/]repo-path[:tag][@digest]`, optionally
 * behind an Azure App Service prefix (`DOCKER|`, `COMPOSE|`, `KUBE|`, `SITECONTAINERS`).
 * Research: `release-radar-docs/research/image-reference-parsing.md`.
 *
 * - {@link parseImage}: the generic parser every adapter uses (prefix-aware).
 * - {@link parseLinuxFxVersion}: App Service `linuxFxVersion` semantics, where a value without a
 *   `KIND|` prefix, or an empty `DOCKER|`, is "not a container" (parity with the original engine).
 * - {@link sameBuild}: only equal `sha256` digests prove the same build; tags prove nothing.
 *
 * Display rule: print `raw`, never the `library/`-normalised form.
 */

/** A parsed image reference, or the reason there is none. */
export type ImageInfo =
  | {
      readonly kind: "image";
      /** The input exactly as given (untrimmed). */
      readonly raw: string;
      /** Registry host (lower-cased, `:port` kept). Docker Hub aliases normalise to `docker.io`. */
      readonly registry: string;
      /** True when no registry was written (Docker Hub implied). */
      readonly implicitRegistry: boolean;
      /** Repository path; single-name Docker Hub repositories carry `library/`. */
      readonly repository: string;
      /** Tag; `null` for a digest-only reference; `"latest"` when implicit. */
      readonly tag: string | null;
      /** True when neither a tag nor a digest was written (`latest` implied). */
      readonly implicitTag: boolean;
      /** `algorithm:hex`, or `null`. */
      readonly digest: string | null;
      /** True when a path component was accepted only by lenient-case parsing (uppercase). */
      readonly nonCanonical: boolean;
    }
  | { readonly kind: "multi-container" | "sidecar" | "non-container"; readonly raw: string }
  | { readonly kind: "invalid"; readonly raw: string; readonly reason: string };

/** The `kind: "image"` member of {@link ImageInfo}. */
export type ParsedImageRef = Extract<ImageInfo, { kind: "image" }>;

/** Parser options. `strictCase` rejects uppercase repository components instead of flagging them. */
export interface ParseImageOptions {
  readonly strictCase?: boolean;
}

/** Result of {@link sameBuild}. */
export type SameBuild = "proven" | "different" | "unproven";

const DIGEST = /^[A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}$/;
const TAG = /^[\w][\w.-]{0,127}$/;
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const HUB = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
const PREFIX = /^(DOCKER|COMPOSE|KUBE)\|/i;
const RUNTIME_PREFIX = /^[A-Za-z]+\|/;
const MAX_REPOSITORY = 255;

function invalid(raw: string, reason: string): ImageInfo {
  return { kind: "invalid", raw, reason };
}

/**
 * Parses an image reference (lenient case by default: uppercase repository components are
 * accepted and flagged `nonCanonical`).
 *
 * - blank / `null` / `undefined` → `non-container`; `SITECONTAINERS` → `sidecar`;
 *   `COMPOSE|…`, `KUBE|…` → `multi-container`; runtime stacks (`NODE|20-lts`) → `non-container`.
 * - `DOCKER|<ref>` (prefix case-insensitive) → the reference is parsed; `DOCKER|` alone is invalid.
 * - Anything that breaks the grammar → `invalid` with a reason. Never throws.
 */
export function parseImage(input: string | null | undefined, options: ParseImageOptions = {}): ImageInfo {
  const raw = input ?? "";
  const s = raw.trim();
  if (s === "") return { kind: "non-container", raw };
  if (/\s/.test(s)) return invalid(raw, "whitespace inside the reference");
  if (s.toUpperCase() === "SITECONTAINERS") return { kind: "sidecar", raw };

  let ref = s;
  const prefix = PREFIX.exec(s);
  if (prefix) {
    if ((prefix[1] ?? "").toUpperCase() !== "DOCKER") return { kind: "multi-container", raw };
    ref = s.slice(prefix[0].length);
    if (ref === "") return invalid(raw, "empty after DOCKER|");
  } else if (RUNTIME_PREFIX.test(s)) {
    return { kind: "non-container", raw };
  }
  return parseReference(raw, ref, options.strictCase === true);
}

function parseReference(raw: string, input: string, strictCase: boolean): ImageInfo {
  let ref = input;
  let digest: string | null = null;
  const at = ref.indexOf("@");
  if (at >= 0) {
    digest = ref.slice(at + 1);
    ref = ref.slice(0, at);
    if (digest.includes("@")) return invalid(raw, "multiple @");
    if (!DIGEST.test(digest)) return invalid(raw, "bad digest");
    const [algorithm = "", hex = ""] = digest.split(":");
    if (algorithm.toLowerCase() === "sha256" && hex.length !== 64) {
      return invalid(raw, "sha256 digest must be 64 hex characters");
    }
  }
  if (ref === "") return invalid(raw, "empty name");

  // Tag: only a colon after the last slash; a colon before it is a registry port.
  let tag: string | null = null;
  const lastSlash = ref.lastIndexOf("/");
  const colon = ref.indexOf(":", lastSlash + 1);
  if (colon >= 0 && !(ref.startsWith("[") && lastSlash < 0)) {
    tag = ref.slice(colon + 1);
    ref = ref.slice(0, colon);
    if (!TAG.test(tag)) return invalid(raw, "bad tag");
  }

  // Registry: the first segment, when it looks like a host.
  const slash = ref.indexOf("/");
  let first = slash >= 0 ? ref.slice(0, slash) : "";
  let firstEnd = slash;
  if (ref.startsWith("[")) {
    const close = ref.indexOf("]");
    if (close < 0) return invalid(raw, "unterminated [");
    const after = ref.indexOf("/", close);
    if (after < 0) return invalid(raw, "registry without repository");
    first = ref.slice(0, after);
    firstEnd = after;
  }
  const looksLikeHost =
    first !== "" && (first.startsWith("[") || /[.:]/.test(first) || first === "localhost" || first !== first.toLowerCase());

  let registry: string;
  let implicitRegistry = false;
  let path: string;
  if (looksLikeHost) {
    path = ref.slice(firstEnd + 1);
    if (path === "") return invalid(raw, "registry without repository");
    const hostPart = first.replace(/^\[[^\]]*\]/, "");
    if (hostPart.includes(":") && !/^[^:]*:\d+$/.test(hostPart)) return invalid(raw, "bad registry port");
    registry = HUB.has(first.toLowerCase()) ? "docker.io" : first.toLowerCase();
  } else {
    registry = "docker.io";
    implicitRegistry = true;
    path = ref;
  }
  if (registry === "docker.io" && !path.includes("/")) path = `library/${path}`;
  if (path.length > MAX_REPOSITORY) return invalid(raw, "repository too long");

  let nonCanonical = false;
  for (const component of path.split("/")) {
    if (COMPONENT.test(component)) continue;
    if (!strictCase && COMPONENT.test(component.toLowerCase())) nonCanonical = true;
    else return invalid(raw, `bad path component "${component}"`);
  }

  const implicitTag = tag === null && digest === null;
  return {
    kind: "image",
    raw,
    registry,
    implicitRegistry,
    repository: path,
    tag: implicitTag ? "latest" : tag,
    implicitTag,
    digest,
    nonCanonical,
  };
}

/**
 * Parses an Azure App Service `linuxFxVersion` value (parity with the original engine):
 * - blank, `null`, or a value with no `KIND|` prefix → `non-container`;
 * - `DOCKER|` with an empty or blank reference → `non-container` (nothing is configured);
 * - every other value → {@link parseImage}.
 */
export function parseLinuxFxVersion(value: string | null | undefined, options: ParseImageOptions = {}): ImageInfo {
  const raw = value ?? "";
  const s = raw.trim();
  if (s === "") return { kind: "non-container", raw };
  if (s.toUpperCase() === "SITECONTAINERS") return { kind: "sidecar", raw };
  const bar = s.indexOf("|");
  if (bar < 0) return { kind: "non-container", raw };
  if (s.slice(0, bar).toUpperCase() === "DOCKER" && s.slice(bar + 1).trim() === "") return { kind: "non-container", raw };
  return parseImage(raw, options);
}

/** True when `digest` is a `sha256` digest — the only algorithm release-radar compares. */
export function isComparableDigest(digest: string | null): digest is string {
  return digest !== null && /^sha256:[0-9a-fA-F]{64}$/.test(digest);
}

/**
 * Compares two parsed references (spec requirement 52):
 * - both carry a `sha256` digest → `proven` when equal, `different` otherwise (tags ignored);
 * - otherwise registry + repository + tag equal → `unproven` (same reference, not proof of
 *   the same build); any difference → `different`;
 * - either side not an image → `unproven`.
 * Registry hosts are already lower-cased; repository and tag compare case-sensitively.
 */
export function sameBuild(a: ImageInfo, b: ImageInfo): SameBuild {
  if (a.kind !== "image" || b.kind !== "image") return "unproven";
  if (isComparableDigest(a.digest) && isComparableDigest(b.digest)) {
    return a.digest.toLowerCase() === b.digest.toLowerCase() ? "proven" : "different";
  }
  const same = a.registry === b.registry && a.repository === b.repository && a.tag === b.tag;
  return same ? "unproven" : "different";
}
