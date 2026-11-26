# Image-reference parsing — grammar, App Service prefixes, comparison rules

Researched 2026-11-25 for `release-radar-docs/refined-request-release-radar-plugin.md` (sections D, F).
Legend: **[V]** verified on the cited source 2026-11-25; **[M]** modelled.

## 1. Sources
- distribution/reference grammar: https://raw.githubusercontent.com/distribution/reference/main/reference.go **[V]** —
  `reference := name [ ":" tag ] [ "@" digest ]`; `name := [domain '/'] remote-name`;
  `domain := host [':' port-number]` (domain name, IPv4, or bracketed IPv6); `tag := /[\w][\w.-]{0,127}/`;
  `digest := algorithm ":" hex`, `hex := /[0-9a-fA-F]{32,}/`; repository name ≤ 255 characters.
- Registry detection ("is the first segment a host?") follows Docker's normalisation
  (`ParseNormalizedNamed` / `splitDockerDomain` in the same project's `normalize.go`) — from memory **[M]**; confirm before release.
- App Service prefixes: https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container?pivots=container-linux **[V]** (Compose retirement 2027-03-31).

## 2. Rules

Whole reference: `[registry[:port]/]repo-path[:tag][@digest]`.

1. **App Service prefix** — `^(DOCKER|COMPOSE|KUBE)\|` case-insensitive. `DOCKER|` → image reference follows;
   `COMPOSE|`/`KUBE|` → `kind: "multi-container"`; exact `SITECONTAINERS` → `kind: "sidecar"`; empty, null, or a
   runtime stack (`NODE|20-lts`) → `kind: "non-container"`.
2. **Digest** — split at the first `@`; right side must match
   `^[A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}$`; `sha256` hex must be exactly 64.
3. **Tag** — a `:` after the LAST `/` separates the tag; a `:` before it is a registry port. `app:5000` = repo
   `app`, **tag `5000`**. Tag must match `^[\w][\w.-]{0,127}$`.
4. **Registry** — `first` = text before the first `/` (none → no registry). It is a registry if it contains `.` or
   `:`, equals `localhost`, or contains an uppercase letter; otherwise a Docker Hub namespace with implicit
   `docker.io`. IPv6: `first` starts with `[` → through `]` plus optional `:port`. `index.docker.io` and
   `registry-1.docker.io` normalise to `docker.io`. Single-component Hub repos get `library/`
   (`nginx` → `docker.io/library/nginx`). `registry:5000/` with no repository is invalid.
5. **Repository path** — components split by `/`, each matching `^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$`;
   total ≤ 255. Uppercase is invalid in strict mode; lenient mode accepts it and flags `nonCanonical: true`
   (Azure may preserve case in `linuxFxVersion`).
6. **Implicit tag** — no tag and no digest → `tag = "latest"`, `implicitTag: true`; digest without tag → `tag = null`.
7. **Tag + digest** (`repo:1.2@sha256:...`) is valid: the digest is authoritative, the tag informational; record both.

**Comparison (spec requirements 36, 37):** both digests present → equal = same build, different = different
builds regardless of tag. Otherwise compare `registry + repository + tag`; a match is "same reference,
**unproven**" — never proof of the same build. Registry host case-insensitive; repository and tag case-sensitive.

## 3. TypeScript implementation

```ts
export type ImageInfo =
  | { kind: "image"; raw: string; registry: string; implicitRegistry: boolean;
      repository: string; tag: string | null; implicitTag: boolean; digest: string | null;
      nonCanonical: boolean }
  | { kind: "multi-container" | "sidecar" | "non-container"; raw: string }
  | { kind: "invalid"; raw: string; reason: string };

const DIGEST = /^[A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}$/;
const TAG = /^[\w][\w.-]{0,127}$/;
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const HUB = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

export function parseImage(input: string | null | undefined, opts = { lenientCase: true }): ImageInfo {
  const raw = input ?? "";
  const s = raw.trim();
  if (s === "") return { kind: "non-container", raw };
  if (/\s/.test(s)) return { kind: "invalid", raw, reason: "whitespace" };
  if (s.toUpperCase() === "SITECONTAINERS") return { kind: "sidecar", raw };

  let ref = s;
  const prefix = /^(DOCKER|COMPOSE|KUBE)\|/i.exec(s);
  if (prefix) {
    const p = prefix[1].toUpperCase();
    if (p !== "DOCKER") return { kind: "multi-container", raw };
    ref = s.slice(prefix[0].length);
    if (ref === "") return { kind: "invalid", raw, reason: "empty after DOCKER|" };
  } else if (/^[A-Za-z]+\|/.test(s)) {
    return { kind: "non-container", raw }; // NODE|20-lts, PYTHON|3.11, DOTNETCORE|8.0, ...
  }

  // digest
  let digest: string | null = null;
  const at = ref.indexOf("@");
  if (at >= 0) {
    digest = ref.slice(at + 1);
    ref = ref.slice(0, at);
    if (!DIGEST.test(digest)) return { kind: "invalid", raw, reason: "bad digest" };
    const [algo, hex] = digest.split(":");
    if (algo.toLowerCase() === "sha256" && hex.length !== 64)
      return { kind: "invalid", raw, reason: "sha256 digest must be 64 hex chars" };
    if (ref.includes("@")) return { kind: "invalid", raw, reason: "multiple @" };
  }
  if (ref === "") return { kind: "invalid", raw, reason: "empty name" };

  // tag: colon after the last slash
  let tag: string | null = null;
  const lastSlash = ref.lastIndexOf("/");
  const colon = ref.indexOf(":", lastSlash + 1);
  if (colon >= 0) {
    tag = ref.slice(colon + 1);
    ref = ref.slice(0, colon);
    if (!TAG.test(tag)) return { kind: "invalid", raw, reason: "bad tag" };
  }

  // registry
  let registry: string;
  let implicitRegistry = false;
  let path: string;
  const slash = ref.indexOf("/");
  let first = slash >= 0 ? ref.slice(0, slash) : "";
  let firstEnd = slash;
  if (ref.startsWith("[")) {            // bracketed IPv6 host
    const close = ref.indexOf("]");
    if (close < 0) return { kind: "invalid", raw, reason: "unterminated [" };
    const after = ref.indexOf("/", close);
    if (after < 0) return { kind: "invalid", raw, reason: "registry without repository" };
    first = ref.slice(0, after); firstEnd = after;
  }
  const looksLikeHost = first !== "" &&
    (first.startsWith("[") || /[.:]/.test(first) || first === "localhost" || first !== first.toLowerCase());
  if (looksLikeHost) {
    registry = first; path = ref.slice(firstEnd + 1);
    if (path === "") return { kind: "invalid", raw, reason: "registry without repository" };
    const portMatch = /:(\d+)$/.exec(first.replace(/^\[[^\]]*\]/, ""));
    if (/:/.test(first.replace(/^\[[^\]]*\]/, "")) && !portMatch)
      return { kind: "invalid", raw, reason: "bad registry port" };
    if (HUB.has(registry.toLowerCase())) registry = "docker.io";
    else registry = registry.toLowerCase();
  } else {
    registry = "docker.io"; implicitRegistry = true; path = ref;
  }
  if (registry === "docker.io" && !path.includes("/")) path = `library/${path}`;

  if (path.length > 255) return { kind: "invalid", raw, reason: "repository too long" };
  let nonCanonical = false;
  for (const c of path.split("/")) {
    if (!COMPONENT.test(c)) {
      if (opts.lenientCase && COMPONENT.test(c.toLowerCase())) nonCanonical = true;
      else return { kind: "invalid", raw, reason: `bad path component "${c}"` };
    }
  }

  const implicitTag = tag === null && digest === null;
  if (implicitTag) tag = "latest";
  return { kind: "image", raw, registry, implicitRegistry, repository: path, tag, implicitTag, digest, nonCanonical };
}

export function sameBuild(a: ImageInfo, b: ImageInfo): "proven" | "different" | "unproven" {
  if (a.kind !== "image" || b.kind !== "image") return "unproven";
  if (a.digest && b.digest) return a.digest.toLowerCase() === b.digest.toLowerCase() ? "proven" : "different";
  const same = a.registry === b.registry && a.repository === b.repository && a.tag === b.tag;
  return same ? "unproven" : "different";
}
```

Behaviour notes: an implicit Hub image has `registry: "docker.io"`, `implicitRegistry: true` (print `raw`, not the
normalised form). Hub single-name repos carry `library/`; App Service parity output may expect it stripped — keep a
`displayRepository` without `library/` if parity requires it (design choice). The uppercase-registry rule is why
`Registry.Example.com/app` is a host; the host is lowercased.

## 4. Edge cases (unit tests)

| # | Input | Expected |
|---|---|---|
| 1 | `DOCKER\|registry.example.com/acme/api:1.2.3` | image; registry `registry.example.com`, repo `acme/api`, tag `1.2.3` |
| 2 | `registry.example.com:5000/acme/api:1.2.3` | registry `registry.example.com:5000` |
| 3 | `registry.example.com:5000/acme/api` | tag `latest`, implicit |
| 4 | `localhost:5000/app` | registry `localhost:5000` |
| 5 | `localhost/app:2` | registry `localhost` |
| 6 | `app:5000` | docker.io, repo `library/app`, tag `5000` |
| 7 | `acme/api` | docker.io implicit, repo `acme/api`, tag `latest` |
| 8 | `nginx` | repo `library/nginx`, tag `latest` |
| 9 | `acme/api:1.0@sha256:<64hex>` | tag `1.0`, digest present, `implicitTag: false` |
| 10 | `acme/api@sha256:<64hex>` | tag `null`, digest present |
| 11 | `registry.example.com/a/b/c/d:1` | repo `a/b/c/d` |
| 12 | `[::1]:5000/app:1` | registry `[::1]:5000` |
| 13 | `Registry.Example.com/app` | registry detected (uppercase), host lowercased |
| 14 | `registry.example.com/Acme/Api` | `nonCanonical: true` lenient; invalid strict |
| 15 | `index.docker.io/acme/api` and `docker.io/acme/api` | both registry `docker.io` |
| 16 | `registry.example.com/` | invalid — registry without repository |
| 17 | `acme/api:` | invalid — empty tag |
| 18 | `acme/api:-bad` | invalid tag (leading `-`) |
| 19 | 129-char tag / 128-char tag | invalid / valid |
| 20 | `acme/api@sha256:abc` | invalid — short digest |
| 21 | `acme/api@md5:<32hex>` | valid digest form per grammar — policy decision (only `sha256` comparable) |
| 22 | `acme//api` | invalid — empty path component |
| 23 | `acme/api:1:2` | invalid tag |
| 24 | `acme/api@sha256:<64hex>@sha256:<64hex>` | invalid — multiple `@` |
| 25 | surrounding whitespace / inner whitespace | trimmed / invalid |
| 26 | `docker\|acme/api:1` | accepted (case-insensitive prefix) |
| 27 | `DOCKER\|` | invalid — empty after prefix |
| 28 | `COMPOSE\|<base64>`, `KUBE\|<base64>` | `multi-container` |
| 29 | `SITECONTAINERS` | `sidecar` |
| 30 | `NODE\|20-lts`, `PYTHON\|3.11`, `DOTNETCORE\|8.0` | `non-container` |
| 31 | `""`, `null`, `undefined` | `non-container` |
| 32 | `registry.example.com:443/acme/api:1` vs `registry.example.com/acme/api:1` | different registries (port significant; never auto-merge) |
| 33 | `a.b` | repo `library/a.b` (a dot marks a host only before `/`) |
| 34 | `a.b/c` | registry `a.b` |
| 35 | `my_registry/app` | Hub namespace `my_registry` |
| 36 | `acme/api:1.2.3` vs `acme/api:1.2.3` | `unproven` |
| 37 | same digest, different tags | `proven` |
| 38 | different digest, same tag | `different` |

## 5. Uncertainties
- Registry-detection rules come from Docker's normalisation code, not the fetched grammar file **[M]** —
  confidence HIGH (long-stable); verify against `normalize.go`.
- Whether `linuxFxVersion` ever carries an uppercase repository or trailing whitespace — covered by lenient mode.
- Non-sha256 digest algorithms (case 21): accept per grammar, compare only `sha256`.
