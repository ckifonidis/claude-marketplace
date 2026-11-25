# Configuration schema

release-radar is configured by four files. This reference lists **every key** of each one: its type, when it is required, what it means, where it sits in the canonical key order, and an example. The engine validates all of them strictly: a missing required key, an unknown key, a wrong type or a broken rule is **exit 24**, with the file and the JSON pointer of the key. **Nothing is ever defaulted.** Where an optional key may be absent, its absence has one documented meaning, stated at the key; that is semantics, not a fallback.

| File | Lives in | Committed? | Owner |
|---|---|---|---|
| `.release-radar/workspace.json` | the workspace (orchestration) repository, or the one repository of a single-repo project | yes | workspace repo |
| `.release-radar/repos.local.json` | next to `workspace.json` | **no** — gitignored, one per machine | workspace repo |
| `<clone>[/<repoSubdir>]/.release-radar/component.json` | each member's **own** repository | yes, by the user | member repo |
| workspace index | the per-user plugin data directory (the skill passes the path) | never | per user |

How these files relate — members located only through the repos file, monorepos, unavailable vs invalid members, which `component.json` revision each skill reads, single-repo projects, and the workspace resolution order with the per-user index — is [workspace-model.md](workspace-model.md). The checklists (`checks.md`), snapshots and handoff manifests are described in [file-formats.md](file-formats.md), together with the canonical JSON rules (key order, 2-space indentation, sorted and ordered arrays, identities). Verification checks are described in full in [verification.md](verification.md), adapters in [adapters.md](adapters.md), exit codes in [exit-codes.md](exit-codes.md). Engine commands are described in the `SKILL.md` "Engine invocation" section; this file never shows an invocation.

Conventions used below:
- **Pos.** is the key's position in the canonical key order of its object. `format` puts keys in this order; any other order is "non-canonical (hand-edited)", never invalid.
- **name** means a lower-case name matching `^[a-z0-9][a-z0-9._-]{0,62}$`. Stage, member, target, action and check names are names.
- **positive** means an integer greater than zero. Zero, negatives and fractions are exit 24.
- Record maps (`{ <key>: … }`) are always rendered with their keys sorted.
- Paths in `workspace.json` are relative to the **workspace root** (the directory holding `.release-radar/`), use `/`, and may not contain empty or `.` segments. `..` is allowed only in `reposFile.path`.

---

## `workspace.json` (schemaVersion 1)

The workspace declares the fleet: the ordered stages and their lifecycle, the operator's team, the member list and the fleet-wide settings. It **never** contains a component definition (targets, mappings, artefacts, verification); those live only in each member's `component.json`.

### Top level

| Pos. | Key | Type | Required | Meaning | Example |
|---|---|---|---|---|---|
| 1 | `schemaVersion` | integer | always | File-format version. Only `1` is supported; anything else is exit 24. | `1` |
| 2 | `operatorTeam` | non-empty string | when any stage declares `promotion.owner` (i.e. unless every stage is mode `none`) | The team that runs release-radar. A stage is **owned** when `promotion.owner` equals it, and **triggerable** when it is owned and its mode is `pipeline`. Free text, compared exactly. | `"dev-team"` |
| 3 | `stages` | array, **ordered**, identity `name`, ≥ 1 | always | The lifecycle, in promotion order (first stage = closest to development). Order carries meaning and is kept as written. | see [Stages](#stages) |
| 4 | `members` | array, **sorted by `name`**, identity `name`, ≥ 1 | always | The explicit member list. No other component exists for the engine. | see [Members](#members) |
| 5 | `reposFile` | object | always | Where the per-machine `repoKey` → clone-path mapping lives. | `{ "kind": "owned" }` |
| 6 | `gitTimeoutSeconds` | positive | always | Timeout of every read-only git call (there is no built-in value). | `30` |
| 7 | `freshnessMinutes` | positive | always | How old a snapshot may be for `change-risk` to reuse it instead of a fresh read. A snapshot is fresh only when it is at most this old **and** its configuration fingerprint matches. | `60` |
| 8 | `checklist` | path string, or `null` | always | The fleet checklist (`layer: fleet`), relative to the workspace root. `null` means the workspace has no fleet layer. A configured path that does not exist is exit 24. | `".release-radar/checks.md"` |
| 9 | `beforePromote` | record `{ <stage>: <pointer> }` | optional | A pointer (free text: a document path, a skill name, a URL) the operator must look at before promoting into that stage. Keys must be declared stages. Shown next to the component's own pointer; neither overrides the other. Hook skills are only pointed at, never invoked. Absent = no fleet pointer. | `{ "stage-3": "docs/runbooks/stage-3-release.md" }` |
| 10 | `snapshotRetention` | positive | always | `format`'s cleanup keeps the newest this-many valid snapshots and deletes older ones that the engine wrote. | `50` |
| 11 | `handoffRetention` | positive | always | Per (component, stage), `format`'s cleanup keeps the newest this-many valid handoff packages. | `5` |
| 12 | `adapters` | object | always (each block inside is required once a target uses that adapter) | Per-adapter settings. See [Adapter settings](#adapter-settings). | `{ "kubernetes": { "timeoutSeconds": 30 } }` |
| 13 | `azureDevOps` | object | when any member declares a pipeline mapping | Azure DevOps connection settings. See [Azure DevOps block](#azure-devops-block). Absent = no pipeline features. | see below |

### Stages

Each `stages[]` entry:

| Pos. | Key | Type | Required | Meaning |
|---|---|---|---|---|
| 1 | `name` | name | always | The stage name. `local` is **reserved** (it stands for the clone's HEAD) and is exit 24. |
| 2 | `tagConvention` | object | always | How a deployed image tag maps to a commit. See [Tag conventions](#tag-conventions). |
| 3 | `promotion` | object | always | How the stage is promoted into and by whom. See [Promotion](#promotion). |

#### Tag conventions

`tagConvention` (and each entry of a component's `tagConventionOverrides`) is one of four shapes, selected by `type`:

| Shape | Keys in order | Meaning |
|---|---|---|
| `{ "type": "sha" }` | `type` | The image tag **is** a commit sha (7–40 hex characters). It is resolved in the member's clone. |
| `{ "type": "git-tag", "gitTagPrefix": "v" }` | `type`, `gitTagPrefix` | The image tag names a git tag: the engine resolves exactly `refs/tags/<gitTagPrefix><tag>` — nothing else is tried (no `v` guessing). `gitTagPrefix` may be `""`; allowed characters `A-Z a-z 0-9 . _ / -`. |
| `{ "type": "regex", "pattern": "…", "resolveAs": { … } }` | `type`, `pattern`, `resolveAs` | For mixed tag schemes. `pattern` is a regular expression (Unicode flag) that must contain a **named group `ref`**. The tag must match; the `ref` capture is then resolved by `resolveAs`, which is `{ "type": "sha" }` or `{ "type": "git-tag", "gitTagPrefix": "…" }`. A tag that does not match is `tag-not-found`. |
| `{ "type": "none" }` | `type` | The stage declares no convention: deployed commits are reported `no-convention` (nothing is guessed). |

Example of a regex convention for tags such as `rc-3f2a9c1e`:

```json
{ "type": "regex", "pattern": "^rc-(?<ref>[0-9a-f]{7,40})$", "resolveAs": { "type": "sha" } }
```

Outcomes when a tag does not resolve: `tag-not-found` (the tag or commit is not in the local clone — it may need a `git fetch --tags`, which release-radar recommends and never runs), `digest-pinned` (the image is pinned by digest, there is no tag), `no-clone`, `git-error`, `no-convention`.

#### Promotion

| Pos. | Key | Type | Required | Meaning |
|---|---|---|---|---|
| 1 | `mode` | `pipeline` \| `handoff` \| `manual` \| `none` | always | `pipeline`: promoted by an Azure DevOps pipeline run. `handoff`: another team promotes from a package the operator prepares. `manual`: promoted by hand outside release-radar. `none`: not promoted (e.g. a stage nobody promotes into). |
| 2 | `owner` | non-empty string | unless `mode` is `none` | The team that owns the promotion, free text. Declaring an owner requires `operatorTeam`. |

**Triggerable rule:** a stage is triggerable only when `mode` is `pipeline` **and** `owner` equals `operatorTeam`. Only triggerable stages can ever get a pipeline run from `promote`. Pipeline mappings are allowed only on `pipeline` stages, handoff artefacts only on `handoff` stages. Smoke checks run only on owned stages (see [verification.md](verification.md)).

### Members

Each `members[]` entry, sorted by `name`:

| Pos. | Key | Type | Required | Meaning |
|---|---|---|---|---|
| 1 | `name` | name | always | The component name. The member's `component.json` `name` must equal it. |
| 2 | `repoKey` | string matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, or `null` | always (explicit) | The key looked up in the repos file. `null` means the member has no clone by design and is reported `unavailable (no local clone)`. An empty string is exit 24. |
| 3 | `repoSubdir` | relative path, or `null` | always (explicit) | `null` = the repository root. A relative path = a subdirectory of the clone that holds this member's `.release-radar/`. Must be `null` when `repoKey` is `null`. |

**Member resolution** is strict and never scans a directory:
- The clone is `repos[repoKey]` from the repos file, resolved against the repos file's own directory. The component file is `<clone>[/<repoSubdir>]/.release-radar/component.json`.
- `repoKey` `null` or unmapped, or the mapped path does not exist → `unavailable (no local clone)`. The clone exists but the file does not → `unavailable (no component config)`. Unavailable members are reported and excluded from a fleet run; asking for one by name is exit 24.
- **Monorepos (D22):** several members may share one `repoKey` when each has a different `repoSubdir`; each subdirectory holds its own `component.json` (and optionally its own `checks.md`). Locations are compared **after normalisation** — relative to the clone root, no `.` segments, no repeated or trailing `/` (`export`, `./export`, `export/` are the same location) — and two members at the same `repoKey` + location are exit 24, pointing at the later member's `repoSubdir`. Absolute paths, `\`, any `..`, and a value that normalises to the root (`.`) are exit 24 — write `null` for the root.
- Worktree copies, look-alike sibling folders and `component.json` files of non-members are never read.

```json
"members": [
  { "name": "acme-api", "repoKey": "acme-api", "repoSubdir": null },
  { "name": "acme-jobs-export", "repoKey": "acme-jobs", "repoSubdir": "export" },
  { "name": "acme-jobs-import", "repoKey": "acme-jobs", "repoSubdir": "import" }
]
```

### `reposFile`

| Shape | Keys in order | Meaning |
|---|---|---|
| `{ "kind": "owned" }` | `kind` | The mapping lives in `.release-radar/repos.local.json`, owned by release-radar (canonical, re-formatted by `format`, gitignored). |
| `{ "kind": "external", "path": "../shared/repos.json" }` | `kind`, `path` | A mapping file owned by other tooling, relative to the workspace root (`..` allowed). It is validated strictly but **never rewritten** and never counted as non-canonical ("externally owned — not re-formatted"). |

### Adapter settings

`adapters` holds one optional block per adapter. A block is **required** as soon as any member's target uses that adapter (otherwise exit 24 at the target's `adapter` key), and `discover` lists nothing for an adapter whose block is absent. Keys in this order:

| Pos. | Key | Keys in order | Meaning |
|---|---|---|---|
| 1 | `azure-appservice` | `timeoutSeconds` (positive), `stageSubscriptions` | `stageSubscriptions` maps each stage name to the subscription ids searched for that stage (array **sorted**, ≥ 1). Every stage used by an App Service target must be listed; keys must be declared stages. |
| 2 | `azure-containerapp` | `timeoutSeconds` | |
| 3 | `kubernetes` | `timeoutSeconds` | |
| 4 | `compose` | `timeoutSeconds` | |
| 5 | `command` | `timeoutSeconds`, `discoverArgv`? | `discoverArgv` (argv array, **ordered**, ≥ 1) is an optional list command for `discover`: one candidate per output line. Absent = the command adapter cannot discover. |

`timeoutSeconds` (positive) bounds every CLI call of that adapter. The commands each adapter issues, and what it reports, are in [adapters.md](adapters.md).

### Azure DevOps block

`azureDevOps`, required when any member declares a pipeline mapping. All keys required, in this order:

| Pos. | Key | Type | Meaning | Example |
|---|---|---|---|---|
| 1 | `organizationUrl` | absolute `http(s)` URL without credentials | The full organization base URL. | `"https://dev.azure.example/acme"` |
| 2 | `project` | non-empty string | The default project; a mapping's own `project` overrides it for that mapping. | `"acme-platform"` |
| 3 | `requestTimeoutSeconds` | positive | Timeout of every REST call. | `30` |
| 4 | `runHistoryCount` | positive | How many recent runs `status` and `pipeline-runs` read per mapped pipeline. | `5` |
| 5 | `followPollSeconds` | positive | Poll interval while following a run (and of `promote`'s landed proof). | `30` |
| 6 | `followTimeoutMinutes` | positive | How long a follow polls before reporting "still running" (never a failure). | `60` |
| 7 | `confirmTokenTtlMinutes` | positive | Lifetime of a `pipeline-preview` confirmation token. | `15` |
| 8 | `patExpiryWarningDays` | positive | Warn when `AZURE_DEVOPS_PAT_EXPIRES` is within this many days. | `14` |

**Credentials (environment variables, never in a file):**

| Variable | Required | Meaning |
|---|---|---|
| `AZURE_DEVOPS_EXT_PAT` | when a command reads pipelines (unless `--no-pipelines`) | The personal access token. Absent or empty → exit 20 before any request. It is never printed, logged or stored. |
| `AZURE_DEVOPS_PAT_EXPIRES` | optional | The PAT's expiry date, ISO-8601 (e.g. `2027-03-31`). Gives "PAT expires in N days" in reports, and a warning within `patExpiryWarningDays`. An expired or unparseable value → exit 20. Absent → the expiry is reported as unknown. Recommended, because tokens expire silently. |

**PAT scopes:** **Build (Read)** for run facts (`status`, `pipeline-runs`, `pipeline-run`, Pipelines Get); **Code (Read)** for the remote-head check through the Git Refs API (`pipeline-preview`, `run-pipeline`); **Build (Read & execute)** only for `run-pipeline`. A read-only operator needs Build (Read) and Code (Read).

---

## `component.json` (schemaVersion 1)

Committed in the component's **own** repository at `<clone>[/<repoSubdir>]/.release-radar/component.json`. `deployment-status` reads the working-tree file; `change-risk` and `promote` read it **at the promoted commit** (`git show`) and report keys that differ from the working tree.

### Top level

| Pos. | Key | Type | Required | Meaning |
|---|---|---|---|---|
| 1 | `schemaVersion` | integer | always | Only `1`. |
| 2 | `name` | name | always | Must equal the member name in `workspace.json`. |
| 3 | `tagConventionOverrides` | record `{ <stage>: <tagConvention> }` | optional | A per-stage override of the stage's tag convention, in the same four shapes. Keys must be declared stages. **Absent stage key = the stage's convention applies** (documented semantics). The report says which source applied (`stage` / `override`). |
| 4 | `stages` | record `{ <stage>: <entry> \| null }` | always | **Every** workspace stage must be listed, and no other. `null` means **not deployed by design** (reported "not deployed", never "missing"). An empty object or an empty `targets` array is exit 24 — write `null`. |

### Stage entry

| Pos. | Key | Type | Required | Meaning |
|---|---|---|---|---|
| 1 | `targets` | array, **sorted by `name`**, identity `name`, ≥ 1 | always | Where the component runs in this stage. Several targets (e.g. `api`, `api-internal`) are compared for within-stage consistency. |
| 2 | `handoff` | object | only on `handoff` stages (exit 24 elsewhere) | Artefacts for the receiving team. See [Handoff artefacts](#handoff-artefacts). |
| 3 | `verification` | object | optional | How this application proves it works on this stage. Absent = "no real-world verification configured". See [verification.md](verification.md). |

### Targets

Every target has `name` (pos. 1, a name) and `adapter` (pos. 2), then the adapter's own keys in the order shown, then the optional `pipeline` mapping last.

| `adapter` | Keys after `name`, `adapter` (in order) | Meaning |
|---|---|---|
| `azure-appservice` | `webapp`, `pipeline`? | The web app name, searched in the stage's `stageSubscriptions`. |
| `azure-containerapp` | `subscription`, `resourceGroup`, `app`, `pipeline`? | The container app. |
| `kubernetes` | `context`, `namespace`, `deployment`, `pipeline`? | The kube context, namespace and Deployment. |
| `compose` | `project`, `service`, `pipeline`? | The Compose project and service. |
| `command` | `argv`, `extract`, `preflightArgv`?, `pipeline`? | `argv` (ordered, ≥ 1, run without a shell) prints the image; `extract` is `{ "type": "json-path", "path": "$.image" }` or `{ "type": "regex", "pattern": "…(?<image>…)…" }` (named group `image`); `preflightArgv` is an optional readiness command. The engine cannot verify that these commands are read-only — `validate-config` prints every one so the user can check. |

All values are non-empty strings. The adapter block for each adapter used must exist in the workspace.

### Pipeline mapping

`pipeline` on a target, allowed only on a `pipeline` stage, and only when the workspace has an `azureDevOps` block. Both shapes are supported: several targets (or components) each with their own pipeline, and one pipeline whose actions are selected by a choice parameter. Keys in this order:

| Pos. | Key | Type | Required | Meaning |
|---|---|---|---|---|
| 1 | `provider` | `"azure-devops"` | always | The only provider in v1. |
| 2 | `project` | non-empty string | optional | The Azure DevOps project. **Absent = the workspace's `azureDevOps.project`.** |
| 3 | `pipelineId` | positive | at least one of `pipelineId` / `pipelineName` | The pipeline id. |
| 4 | `pipelineName` | non-empty string | (see above) | The pipeline name. A name matching several pipelines is exit 21. |
| 5 | `repository` | non-empty string | optional | The Azure Repos Git repository (name or id) that holds `ref`, used for the remote-head check. **Absent = taken from the pipeline's own repository** when it is an Azure Repos Git repository; neither → `pipeline-preview` / `run-pipeline` refuse (26). |
| 6 | `ref` | `refs/heads/…` or `refs/tags/…` | always | The ref the pipeline builds. Its remote head is the commit a run will build. |
| 7 | `parameters` | record `{ <name>: <template> }` | always (may be `{}`) | The **parameter template**: every parameter the run sends, each a literal string or a string containing placeholders from the closed set below. Parameter names match `^[A-Za-z_][A-Za-z0-9_.-]*$`. Never put a secret value here. |
| 8 | `userSelectable` | record `{ <name>: [values] }` (values **sorted**, ≥ 1) | optional | Parameters the operator chooses at preview time from a **closed list**; the choice is bound into the confirmation token. A userSelectable parameter is **not** listed in `parameters` and no action may set it (both exit 24). |
| 9 | `imageTagParameter` | parameter name | optional | Names a key of `parameters` whose value in a run **is** the pushed image tag. |
| 10 | `pushedTagTemplate` | non-empty string | optional | How the pipeline derives the tag it pushes from the run's source commit, written with `{commit.sha}`, `{commit.shortSha}`, `{component}`, `{target}` and literals (no `{image.*}`). Absent = no convention stated. |
| 11 | `actions` | record `{ <name>: { kind, parameters } }`, ≥ 1 | always | The **declared actions**. `kind` is `build` (a run that builds and deploys an image) or `configuration` (a run that changes configuration only — reported "configuration applied; image unchanged"). `parameters` holds the values that action sets; each must be a declared key of the template (an action's value replaces the template's for that run). Keys in order: `kind`, `parameters`. |
| 12 | `primaryAction` | name | always | The action `/promote <component> <stage>` uses when no action is named. Must be a declared action. |
| 13 | `landedWaitMinutes` | positive | always | How long `promote`'s landed proof polls the target, after a succeeded run, for the expected version before reporting "not landed". |

**Placeholders (closed set).** Anything else inside `{…}`, or an unmatched brace, is exit 24.

| Placeholder | Value in a run |
|---|---|
| `{commit.sha}` | The full sha of the commit to build (the remote head of `ref`). |
| `{commit.shortSha}` | Its first 7 characters. |
| `{component}` | The component name. |
| `{target}` | The target name. |
| `{image.tag}` | The tag the run will push: `pushedTagTemplate` rendered for the commit. Using it without `pushedTagTemplate` is refused at preview (26). |
| `{image.repository}` | Valid in the file, but no configuration declares where a pipeline pushes, so `pipeline-preview` refuses it in v1 (26). |

**Immutable parameters:** every value comes from the template, the declared action and the userSelectable choices; none can be edited at preview time. Changing a value means changing the committed `component.json`.

**How a run's facts are read:** a run's **action** is the single declared action whose parameter values all match the run's parameters; its **pushed tag** comes from `imageTagParameter` (status `parameter`), else from `pushedTagTemplate` (status `convention`), is `not-applicable` for a configuration action, and is otherwise `undetermined` — never guessed. Pipeline/target drift counts only finished, exactly-`succeeded`, identified **build**-kind runs.

### Handoff artefacts

`handoff` on a `handoff` stage. Keys in order:

| Pos. | Key | Type | Required | Meaning |
|---|---|---|---|---|
| 1 | `settingsFiles` | array of relative paths, **sorted**, ≥ 1 | always | The settings files that travel to the receiving team, relative to the component root (`<clone>[/<repoSubdir>]`). They are read **at the promoted commit** and copied verbatim into the package. A path missing at that commit is a blocking finding (the package is written incomplete, exit 23), not a config error. |
| 2 | `beforePromote` | non-empty string | optional | The component's own pointer for this stage, shown together with the workspace's `beforePromote` (neither overrides the other). |

The **image reference** is not configured: `handoff-package` reads it live from the upstream stage (repository, tag and digest when known). The package layout is in `promote/references/handoff-package.md`.

### Verification

`verification` on any stage entry: `timeoutSeconds` (positive, required; used by every check that sets none), then `checks` (sorted by `name`, identity `name`, ≥ 1). Check types `http`, `version` and `smoke`; per-check keys, outcomes, comparison rules, header environment variables and the smoke ownership rule are in [verification.md](verification.md). A check's optional `target` narrows it to one target of the stage (it must be declared there).

---

## `repos.local.json` (owned repos file, schemaVersion 1)

| Pos. | Key | Type | Required | Meaning |
|---|---|---|---|---|
| 1 | `schemaVersion` | integer | always | Only `1`. |
| 2 | `repos` | record `{ <repoKey>: <path> }` | always | Clone path per `repoKey`, **relative to the directory holding this file** (`.release-radar/`). |

```json
{
  "schemaVersion": 1,
  "repos": {
    "acme-api": "../../acme-api",
    "acme-jobs": "../../acme-jobs"
  }
}
```

In a **single-repo project** the one member maps to the repository root: `{ "acme-api": ".." }`.

An **external** repos file (`reposFile.kind: "external"`) has the same `repos` mapping, may omit `schemaVersion`, and may carry a `_comment` string; nothing else is tolerated. It is never rewritten.

## Workspace index (schemaVersion 1)

A per-user file under the plugin's data directory (the skill passes `…/workspace-index.json`). It persists across plugin updates, is never committed, and is written only by the engine.

| Pos. | Key | Type | Meaning |
|---|---|---|---|
| 1 | `schemaVersion` | integer | Only `1`. |
| 2 | `workspaces` | array, **sorted by `path`**, identity `path` | Registered workspaces. Each entry has one key, `path`: the absolute workspace root. |

A missing index file is the documented empty initial state; the first `register` creates it. Entries are added by `workspace-index register` and removed by `workspace-index unregister`, each only after the user confirms. Stale entries (the path is gone or no longer holds a valid workspace) are reported, never removed implicitly.

A hand-edited index is non-canonical: `workspace-index list` / `resolve` refuse it (exit 29), and `format --index <file>` re-formats it on its own, with no workspace needed (see [workspace-model.md](workspace-model.md)).

---

## Gitignore lines (workspace repository)

These must be ignored in the workspace repository. `init-workspace` proposes them and adds them only after the user confirms:

```
.release-radar/snapshots/
.release-radar/handoff/
.release-radar/quarantine/
.release-radar/repos.local.json
```

## Full synthetic example

This pair passes `validate-config` and `format --check` (exit 0) with an owned repos file mapping `acme-api` and `acme-jobs`, a fleet `checks.md`, and a second member `acme-jobs-export` (a monorepo subdirectory) whose `component.json` is shown after it.

### `acme-platform/.release-radar/workspace.json`

```json
{
  "schemaVersion": 1,
  "operatorTeam": "dev-team",
  "stages": [
    {
      "name": "stage-1",
      "tagConvention": {
        "type": "sha"
      },
      "promotion": {
        "mode": "pipeline",
        "owner": "dev-team"
      }
    },
    {
      "name": "stage-2",
      "tagConvention": {
        "type": "regex",
        "pattern": "^rc-(?<ref>[0-9a-f]{7,40})$",
        "resolveAs": {
          "type": "sha"
        }
      },
      "promotion": {
        "mode": "pipeline",
        "owner": "dev-team"
      }
    },
    {
      "name": "stage-3",
      "tagConvention": {
        "type": "git-tag",
        "gitTagPrefix": "v"
      },
      "promotion": {
        "mode": "handoff",
        "owner": "ops-team"
      }
    }
  ],
  "members": [
    {
      "name": "acme-api",
      "repoKey": "acme-api",
      "repoSubdir": null
    },
    {
      "name": "acme-jobs-export",
      "repoKey": "acme-jobs",
      "repoSubdir": "export"
    }
  ],
  "reposFile": {
    "kind": "owned"
  },
  "gitTimeoutSeconds": 30,
  "freshnessMinutes": 60,
  "checklist": ".release-radar/checks.md",
  "beforePromote": {
    "stage-3": "docs/runbooks/stage-3-release.md"
  },
  "snapshotRetention": 50,
  "handoffRetention": 5,
  "adapters": {
    "azure-appservice": {
      "timeoutSeconds": 60,
      "stageSubscriptions": {
        "stage-1": [
          "00000000-0000-0000-0000-000000000001"
        ],
        "stage-2": [
          "00000000-0000-0000-0000-000000000002"
        ]
      }
    },
    "kubernetes": {
      "timeoutSeconds": 30
    }
  },
  "azureDevOps": {
    "organizationUrl": "https://dev.azure.example/acme",
    "project": "acme-platform",
    "requestTimeoutSeconds": 30,
    "runHistoryCount": 5,
    "followPollSeconds": 30,
    "followTimeoutMinutes": 60,
    "confirmTokenTtlMinutes": 15,
    "patExpiryWarningDays": 14
  }
}
```

Here `stage-1` and `stage-2` are triggerable (pipeline stages owned by `dev-team`); `stage-3` is promoted by `ops-team` from a handoff package and is never triggerable.

### `acme-api/.release-radar/component.json`

```json
{
  "schemaVersion": 1,
  "name": "acme-api",
  "stages": {
    "stage-1": {
      "targets": [
        {
          "name": "api",
          "adapter": "azure-appservice",
          "webapp": "acme-api-stage1",
          "pipeline": {
            "provider": "azure-devops",
            "pipelineId": 42,
            "pipelineName": "acme-api-deploy",
            "repository": "acme-api",
            "ref": "refs/heads/main",
            "parameters": {
              "deployMode": "full",
              "environment": "stage-1",
              "imageTag": "{commit.shortSha}",
              "service": "{component}"
            },
            "userSelectable": {
              "region": [
                "region-a",
                "region-b"
              ]
            },
            "imageTagParameter": "imageTag",
            "actions": {
              "build": {
                "kind": "build",
                "parameters": {
                  "deployMode": "full"
                }
              },
              "config": {
                "kind": "configuration",
                "parameters": {
                  "deployMode": "settings-only"
                }
              }
            },
            "primaryAction": "build",
            "landedWaitMinutes": 15
          }
        }
      ],
      "verification": {
        "timeoutSeconds": 10,
        "checks": [
          {
            "name": "health",
            "type": "http",
            "url": "https://acme-api.stage-1.example.com/health",
            "method": "GET",
            "expectStatus": [
              200
            ],
            "headers": {
              "X-Acme-Health-Key": {
                "env": "ACME_HEALTH_KEY"
              }
            }
          },
          {
            "name": "smoke-ping",
            "type": "smoke",
            "argv": [
              "acme-cli",
              "ping",
              "--stage",
              "stage-1"
            ],
            "timeoutSeconds": 30
          },
          {
            "name": "version",
            "type": "version",
            "target": "api",
            "url": "https://acme-api.stage-1.example.com/version",
            "extract": {
              "type": "json-path",
              "path": "$.build.commit"
            },
            "compare": "commit"
          }
        ]
      }
    },
    "stage-2": {
      "targets": [
        {
          "name": "api",
          "adapter": "azure-appservice",
          "webapp": "acme-api-stage2",
          "pipeline": {
            "provider": "azure-devops",
            "pipelineName": "acme-api-release",
            "ref": "refs/heads/release",
            "parameters": {
              "environment": "stage-2",
              "imageTag": "rc-{commit.sha}"
            },
            "pushedTagTemplate": "rc-{commit.sha}",
            "actions": {
              "build": {
                "kind": "build",
                "parameters": {}
              }
            },
            "primaryAction": "build",
            "landedWaitMinutes": 20
          }
        },
        {
          "name": "api-internal",
          "adapter": "azure-appservice",
          "webapp": "acme-api-internal-stage2"
        }
      ]
    },
    "stage-3": {
      "targets": [
        {
          "name": "api",
          "adapter": "kubernetes",
          "context": "acme-stage3",
          "namespace": "acme",
          "deployment": "acme-api"
        }
      ],
      "handoff": {
        "settingsFiles": [
          "config/appsettings.stage-3.json"
        ],
        "beforePromote": "docs/stage-3-checklist.md"
      },
      "verification": {
        "timeoutSeconds": 10,
        "checks": [
          {
            "name": "health",
            "type": "http",
            "url": "https://acme-api.stage-3.example.com/health",
            "method": "HEAD",
            "expectStatus": [
              200,
              204
            ]
          },
          {
            "name": "smoke-ping",
            "type": "smoke",
            "argv": [
              "acme-cli",
              "ping",
              "--stage",
              "stage-3"
            ]
          }
        ]
      }
    }
  }
}
```

What this declares:
- **stage-1:** one App Service target with a pipeline. `/promote acme-api stage-1` runs `build` (the primary action, `deployMode=full`); `/promote acme-api stage-1 config` runs the configuration-only action (`deployMode=settings-only`). The operator picks `region` from its closed list before the preview. The pushed tag is read from the run's `imageTag` parameter. Verification: a health check with a header taken from `ACME_HEALTH_KEY`, a smoke command (runs: the stage is owned), and a version check on `api` that inherits the block's 10-second timeout.
- **stage-2:** two targets compared for consistency; only `api` has a pipeline (found by name), building `refs/heads/release` and pushing `rc-<sha>`, which the stage's regex convention resolves back to the commit. The project is the workspace default; the repository for the head check comes from the pipeline itself. No verification block → "no real-world verification configured".
- **stage-3:** a Kubernetes target promoted by `ops-team`. The handoff package carries `config/appsettings.stage-3.json` from the promoted commit; both before-promote pointers are shown. Only the HTTP check runs there; `smoke-ping` is reported "not run (stage not owned)".

### `acme-jobs/export/.release-radar/component.json` (monorepo member)

```json
{
  "schemaVersion": 1,
  "name": "acme-jobs-export",
  "stages": {
    "stage-1": {
      "targets": [
        {
          "name": "export",
          "adapter": "kubernetes",
          "context": "acme-stage1",
          "namespace": "acme-jobs",
          "deployment": "acme-jobs-export"
        }
      ]
    },
    "stage-2": null,
    "stage-3": null
  }
}
```

`stage-2` and `stage-3` are `null`: the job is not deployed there by design, and is reported "not deployed", never "missing".
