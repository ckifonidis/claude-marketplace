# Generic checks

The **generic layer** of every change-risk review: five categories that apply to any component, whatever its stack, before the fleet and component checklists are applied. This file states, for each category, the signals to look for in the range, the severity to give, what to prepare, and synthetic examples. `stack-signals.md` lists the concrete files and code patterns per stack. Engine commands are described in the `SKILL.md` "Engine invocation" section; this file never shows an invocation — "run the engine's `settings-diff` command" means the form given there.

All evidence comes from read-only git in the member's clone (`git log --stat`, `git show`, `git diff`) over the range `<deployed commit>..<promoted commit>`, and from the engine's `settings-diff` report. Values are never quoted: a finding names keys, JSON pointers, secret-reference names, file paths and versions only.

## Severity scale

The same five levels as the checklist grammar (`checklist-format.md`), so that generic, fleet and component findings sort together.

| Severity | Meaning | Effect on the verdict |
|---|---|---|
| `blocker` | The promotion breaks the destination unless something is done first (it will not start, it loses data, it removes commits, or a config file at the promoted commit is invalid). | *do not promote until X* |
| `high` | Likely breakage for consumers or operators, or a HIGH-or-above advisory. | *needs preparation* |
| `medium` | Needs coordination or a check before promoting, including any "unverified" dependency. | *needs preparation* |
| `low` | Worth knowing; no action required. | none |
| `info` | Context only. | none |

The highest severity in a category is not automatic: judge each finding from its evidence. Two rules are fixed: **(a) boot-blocking configuration is always `blocker`** when the destination is not known to provide it, and **an undeterminable advisory status is never better than `medium`**.

## (a) New or renamed required configuration — boot-blocking, highest severity

**Why it breaks.** Applications that fail fast on missing configuration do not start when the destination lacks a key, so the deployment goes down at boot, not at first use. A renamed key is a removed key plus a new required one.

**Signals.**

- A new read of a setting or environment variable **without a default**, or a new entry in a required-settings schema (validation library, options class with a required attribute, `required` list).
- A key renamed in code while the settings files or the deployment still carry the old name.
- A new secret reference (a Key Vault reference, a CI secret expression, a secrets-manager path) in a settings file, or a new key in a declared handoff settings file (the engine's `settings-diff` "added keys" and "added secret references").
- A removed default (`?? "x"`, `os.getenv("X", "y")` → `os.environ["X"]`), or a setting made required by a stricter validator.
- A new required value in an example or template env file (`.env.example`, `values.yaml` with no default, an IaC variable without a default).

**Severity.** `blocker` when nothing in the range or the destination's settings provides the key; `high` when it is provided only in a settings file another team must apply; `low` when a default exists and the change is additive.

**What to prepare.** Name each key (and each secret-reference name) and who provides it in the destination stage: the operator's team for its own stages, the receiving team for a `handoff` stage ("ops-team must configure `/Payments/Endpoint` and the secret reference `acme-kv/payments-api-key` in production"). For a rename, both names and the cut-over order.

**Examples.**

- `src/config.ts:41` reads `PAYMENTS_ENDPOINT` through a schema with no default → `blocker`.
- `settings.production.json` gains `/Payments/ApiKey` as a Key Vault reference `acme-kv/payments-api-key` → `blocker` for a handoff destination: "receiving team must provide".
- `CACHE_TTL_SECONDS` read with a default of 300 → `low`.

## (b) Contract changes

**Why it breaks.** Other components, clients or teams depend on the shape of what this component exposes or consumes. A change that is safe inside the repository can break a consumer that is promoted on a different schedule.

**Signals.**

- HTTP routes, methods, status codes, request or response fields removed, renamed or retyped; OpenAPI / protobuf / GraphQL / JSON-schema files changed.
- Event, queue or topic names, message schemas, or serialisation formats changed.
- Shared types or client packages published from this repository changed incompatibly.
- CLI flags, exit codes or output formats relied on by scripts changed.
- A registry or routing entry other components resolve this component by (an agent or service name, a route key) renamed.

**Severity.** `high` for a removed or retyped field, route, event or name that a consumer uses; `medium` for an additive change that a strict consumer may reject; `low` for documented additive fields.

**What to prepare.** Identify consumers from the repository, contract tests and documentation. Make a new field or route available on the provider before deploying consumers that require it. For a removal, migrate consumers before the provider drops the old contract. For a rename, support both names through the transition.

**Examples.**

- `api/openapi.yaml` removes `GET /v1/orders/{id}/items` → `high`: confirm no consumer calls it.
- An event field `amount` becomes `amountMinor` → `high`: publish both during one release.

## (c) Dependency changes

**Why it breaks.** A new major version changes behaviour; a vulnerable version reaches the destination; a lockfile drift builds something other than what was tested.

**Signals.** Every added, removed or bumped dependency in a manifest or lockfile in the range. List each with its **old and new version, taken from `git diff`** of the manifest and lockfile (the lockfile's resolved version, when there is one). Note major bumps, pre-release versions, git or path dependencies, removed lockfiles, and runtime/toolchain version changes (`engines`, SDK pins, language version files).

**Advisories.** Look them up only through **read-only means that do not modify the working tree**: an audit that reads a lockfile without installing, or an advisory lookup for an explicit package and version. Use the working tree's lockfile only when it is identical to the promoted commit's (`git diff --quiet <sha> -- <lockfile>`); never check the commit out to get one. A lookup that contacts the network is announced as a **network read** before it runs.

| Outcome | Report |
|---|---|
| Lookup done, no advisory | "no known advisory (source, date)" |
| Advisory at HIGH or above | `high` finding naming the advisory id and the fixed version |
| Advisory below HIGH | `low` or `medium`, by exposure |
| Lookup not possible (offline, no tool, lockfile differs, unsupported ecosystem) | **"unverified"** — a `medium` finding; never "clean" |

**What to prepare.** For a major bump, the breaking-change notes to read; for an advisory, the fixed version; for "unverified", the exact package and version to check.

**Examples.**

- `acme-utils 1.3.0 → 2.0.0` (major) → `medium`: read the changelog.
- `acme-http 4.1.2 → 4.1.3`, lookup impossible offline → `medium`, "unverified".

## (d) Build, Dockerfile, base-image and build-context changes

**Why it breaks.** The image that reaches the destination is built differently from the one that was tested, or it no longer builds at all in the pipeline's environment.

**Signals.**

- Dockerfile `FROM` changed, its digest pin removed or changed, or a `:latest` tag introduced.
- `ARG` / `ENV` defaults, `USER`, `EXPOSE`, `ENTRYPOINT` / `CMD`, `HEALTHCHECK`, working directory or copied paths changed.
- The build context changed: `.dockerignore` loosened (more files, possibly secrets, enter the image) or tightened (a needed file is missing at build time).
- Pipeline definitions, build scripts, compiler or bundler settings, or target runtime changed.
- The listening port, health path or start command changed while the destination's probes or settings stay the same.

**Severity.** `high` when the image's start command, port, user or health check changes against unchanged destination settings; `medium` for a base-image change or a context change; `low` for a digest re-pin within the same tag line.

**What to prepare.** The destination settings that must change with the image (port, probe path, start command), and an approved base image pinned by digest.

**Examples.**

- `EXPOSE 8080` → `EXPOSE 3000` with the destination still probing 8080 → `high`.
- `.dockerignore` drops `.env*` → `high`: a local env file may enter the image.

## (e) Data, migration and cache-key changes

**Why it breaks.** Data changes are the hardest to roll back: a migration that drops or renames a column breaks the previous release still running elsewhere, and a changed cache key or serialisation format makes existing cached or stored data unreadable.

**Signals.**

- New or changed migration files; schema changes in an ORM model; a migration that drops, renames or retypes a column or table, or adds a non-nullable column without a default.
- Changed cache key formats, TTLs, namespaces or database indexes; a changed serialisation of stored or cached objects.
- Changed retention, partitioning or backfill jobs; data seeded at start-up.
- A changed message or state-store schema (persisted workflow state, checkpoints, sessions).

**Severity.** `blocker` for a destructive migration while an older release still reads the schema, or a migration that must run before the image starts and has no runner in the destination; `high` for an irreversible or long-running migration; `medium` for a cache-key change (a cold cache) or an additive migration.

**What to prepare.** The order (expand first, contract in a later release), who runs the migration in the destination, a backup or restore point, and the expected cold-cache effect.

**Examples.**

- `migrations/0042_drop_legacy_status.sql` drops a column the deployed release still reads → `blocker`.
- Cache key prefix `orders:v1:` → `orders:v2:` → `medium`: cold cache on deploy.

## Findings that are not code

These are generic findings too, raised by the skill itself:

- **Commits would be removed.** The deployed commit is not an ancestor of the promoted one (`ahead` or `diverged`): promoting replaces commits the destination has with an older or different line. `blocker`, listing those commits.
- **Config file invalid at the promoted commit.** `component.json` or the component checklist is invalid at that commit: `blocker` ("<file> invalid at <sha>: <location>"). Valid but non-canonical: `info` ("non-canonical at <sha>"), used as is.
- **Working tree differs from the promoted commit's `component.json`.** `info`, naming the differing JSON pointers; `medium` when the difference touches the destination stage's targets, handoff artefacts or verification.
