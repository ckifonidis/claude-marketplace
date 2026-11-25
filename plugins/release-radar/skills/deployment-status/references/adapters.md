# Deployment-source adapters

An adapter answers one question for each configured target: **what image is this target actually running, and in what state?** There are five adapters. Four drive a well-known CLI (`az`, `kubectl`, `docker`). The fifth, `command`, runs a command you configure yourself.

Every adapter has the same two operations:

- **preflight**: checks that the CLI is present and that its login or context works for the targets about to be read. When it fails, the run exits **20** and no partial report is printed.
- **read**: returns one reading per target, in the order the targets were requested.

## What every adapter guarantees

- **Read-only.** Adapters issue only the read commands listed below. They never deploy, restart, scale, pull, delete or change a context. They never install an extension or plugin.
- **No credentials read.** Adapters read no environment variable. Each CLI authenticates through its own login or context. The engine passes its environment to the CLI unchanged. Some adapters add fixed, non-credential variables, and each section below lists them.
- **No shell.** Every command runs from an argv array with an explicit timeout, the adapter's `timeoutSeconds`, and a capped output buffer of 64 MiB per stream.
- **Auth failures are never reported as "missing".** An error is first matched against one shared table of error-text patterns. The table is modelled from documented and commonly seen CLI messages; it was not captured from live sessions. Patterns are checked in this order:
  1. **Auth patterns** (not logged in, expired or revoked grant, access denied, no such context, daemon unreachable): exit **20**.
  2. **Missing-capability patterns** (an absent `containerapp` extension, an absent Compose plugin): exit **20**.
  3. **"Not found" patterns**: the target's status is **missing**.
  4. **Anything else**: exit **21**.

  Text that matches no pattern is never treated as "missing".
- **Timeouts.** A call that exceeds `timeoutSeconds` is killed and maps to exit **21**. The only exception is when the error output captured so far already shows an auth problem: that is exit **20**.
- **A missing CLI exits 20 and names the binary,** with an install hint.

### What a reading contains

| Field | Meaning |
|---|---|
| `status` | `found` or `missing`. `missing` means the source answered and the target does not exist there. |
| `image` | The primary running image as a parsed reference: `registry`, `repository`, `tag`, `digest` and `raw`. Its `kind` can also be `non-container`, `multi-container`, `sidecar` or `invalid`. |
| `containers` | Every image observed on the target (containers, pods, revisions), with its source and, where available, its runtime digest, image id and traffic weight. |
| `state` | The source's own state word, for example `Running`, `Stopped`, `Available` or `running`. |
| `lastModified` | An ISO-8601 UTC time taken from the source's last-change field. This field moves on **any** change to the resource, so the report always labels it an **upper bound**, never a deploy time. |
| `digest` / `digestStatus` | The registry digest of what runs, when the runtime exposes it. `digestStatus` is one of:<br>• `available`: the digest is present.<br>• `unavailable`: this source can expose a digest but did not for this target.<br>• `not-exposed`: this source never exposes runtime digests.<br>A digest written in the configured reference itself stays in `image.digest`. |
| `imageId` | The local image id (Compose), or a pod's image config id. It is **never** used as cross-stage proof. |
| `mixed` | `true` when the target runs more than one image for the same role, for example pods or revisions that disagree. The notes name each one. |
| `rollout` | `complete` or `in-progress`, when the source states it (Kubernetes only). |
| `notes` | Human-readable explanations: stopped, non-container, latest revision not ready, mixed pods, digest unavailable, and so on. |

Only equal `sha256` digests prove that two stages run the same build. Tags alone prove nothing.

---

## `azure-appservice`

**Config.**
- Component target: `{ "name", "adapter": "azure-appservice", "webapp" }`.
- Workspace: `adapters.azure-appservice`:
  - `timeoutSeconds`
  - `stageSubscriptions`, which maps each stage to the subscription ids to search, for example `{ "stage-1": ["00000000-0000-0000-0000-000000000001"] }`. A stage used by an App Service target must be listed.

**Prerequisites and authentication.**
- The Azure CLI (`az`).
- Sign in with `az login`. When Microsoft Entra asks for a specific tenant, use `az login --tenant "<tenant id>"`; the engine echoes the tenant id from the error.
- The signed-in identity needs read access to the web apps in every configured subscription.

**Commands issued.**
- Preflight: `az account show --output json`.

  This only proves that a cached sign-in exists. The first list call proves the credentials still work. An expired grant at that point is exit 20, never "missing".
- Read: one call per subscription per run, deduplicated across stages and targets:

  `az webapp list --subscription <id> --query "[].{name:name,resourceGroup:resourceGroup,state:state,kind:kind,linuxFxVersion:siteConfig.linuxFxVersion,lastModifiedTimeUtc:lastModifiedTimeUtc}" --output json`
- Read, only for a listed app whose `linuxFxVersion` came back `null` (the list did not fill it in), and only for that one app:

  `az webapp config show --resource-group <rg> --name <app> --subscription <id> --query linuxFxVersion --output json`

**Fixed environment additions.**
- `AZURE_CORE_ONLY_SHOW_ERRORS=true`
- `AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no` (az may never install anything on its own).

**What is reported.**
- Names match without regard to case.
- `image` is parsed from `linuxFxVersion`:

  | `linuxFxVersion` value | Reported as |
  |---|---|
  | `DOCKER\|<ref>` | The parsed reference. Registry ports, Docker Hub namespaces, nested repositories, implicit `latest` and digest-pinned references are all handled. |
  | `COMPOSE\|…` or `KUBE\|…` | `multi-container`, with no single image. |
  | `SITECONTAINERS` | `sidecar`. The main container's image is not read in this version. |
  | A runtime stack (for example `NODE\|20-lts`), blank, or `DOCKER\|` with nothing after it | `non-container`, flagged. |

- `state` is `Running` or `Stopped`. A stopped app keeps its image, and the note says it is not serving.
- `lastModified` comes from `lastModifiedTimeUtc`. A value with no timezone is read as UTC.
- `digestStatus` is `not-exposed`.

**Failure mapping.**

| Situation | Result |
|---|---|
| The web app is not in any of the stage's subscriptions | **missing** |
| The **same requested name** exists in two subscriptions of one stage | exit **21**: refused as ambiguous, and both subscriptions are named. An unrelated duplicate name does not block the read. |
| Not signed in, an `AADSTS…` error, an expired token, `AuthorizationFailed`, or a subscription the account cannot see | exit **20** |
| `az` exits 0 but prints a login prompt instead of JSON | exit **20** |
| Output that is not JSON, or any other error | exit **21** |

**Discover.** Lists every web app in each stage's subscriptions, using one list call per subscription. Each candidate shows its name, state, image and resource group. A name that appears in two subscriptions of the same stage is flagged `ambiguous`. No name is inferred or grouped.

---

## `azure-containerapp`

**Config.**
- Component target: `{ "name", "adapter": "azure-containerapp", "subscription", "resourceGroup", "app" }`.
- Workspace: `adapters.azure-containerapp.timeoutSeconds`.

**Prerequisites and authentication.**
- `az`, with the `containerapp` command group available.
- If the command group is missing, run `az extension add --name containerapp` yourself. release-radar only reports that it is missing; it never installs it.
- Sign in with `az login`. The identity needs read access to the app.

**Commands issued.**
- Preflight:
  - `az account show --output json`
  - `az containerapp --help`
- Read, per target:
  - `az containerapp show --name <app> --resource-group <rg> --subscription <id> --output json`
  - Then, when the app exists: `az containerapp revision list --name <app> --resource-group <rg> --subscription <id> --output json`

**Fixed environment additions.** The same as `azure-appservice`.

**What is reported.**
- **What runs** is the set of active revisions:
  - **Multiple revision mode:** only active revisions with `trafficWeight > 0`.
  - **Single mode:** normally the one active revision. If several are active mid-switch, the ones carrying traffic.
- **The latest revision may not be running yet.** The app's template describes the latest revision, which may not be ready. When `latestRevisionName` differs from `latestReadyRevisionName`, the latest revision is left out and a note says so. It is never reported as running.
- **Split traffic.** When traffic is split across revisions with different images, the target is `mixed` and every revision's weight and image are listed. The primary `image` is the first container of the revision with the most traffic.
- **`state`:** `runningStatus.runningState` when present. Otherwise the serving revision's running state. Otherwise `provisioningState`.
- **`lastModified`:** `systemData.lastModifiedAt`.
- **Digest:** Container Apps exposes tags only, so `digestStatus` is `not-exposed`.

**Failure mapping.**

| Situation | Result |
|---|---|
| `ResourceNotFound`, or "was not found" / "could not be found" from `show` | **missing**, and the revision list is not read |
| The extension or command group is missing | exit **20** (capability) |
| Auth patterns (as for App Service) | exit **20** |
| Any other error | exit **21** |

**Discover.** Lists the container apps in a subscription, optionally narrowed to one resource group:

`az containerapp list --subscription <id> [--resource-group <rg>] --output json`

The workspace has no subscription list for this adapter, so the caller supplies the scope.

---

## `kubernetes`

**Config.**
- Component target: `{ "name", "adapter": "kubernetes", "context", "namespace", "deployment" }`.
- Workspace: `adapters.kubernetes.timeoutSeconds`.

**Prerequisites and authentication.**
- `kubectl`, and a kubeconfig that contains the configured context.
- The context's credentials must be current. Re-run your cluster's own login or get-credentials command when they expire.
- The identity needs to `get` deployments and `list` pods in the namespace.

**Commands issued.** Every call except the client-only version check and the context lookup starts with `--context <ctx> --namespace <ns>`. The ambient context is never used, and the engine never runs `config use-context` (that would write to your kubeconfig).
- Preflight:
  - `kubectl version --client -o json`, once.
  - `kubectl config get-contexts <ctx> -o name`, once per context.
  - `kubectl --context <ctx> --namespace <ns> auth can-i get deployments.apps`, once per context and namespace.
- Read, per target:
  - `kubectl --context <ctx> --namespace <ns> get deployment <name> -o json`
  - Then `kubectl --context <ctx> --namespace <ns> get pods -l <matchLabels as k=v,...> -o json`

**Fixed environment additions.** `LC_ALL=C`.

**What is reported.**
- **Desired image:** the first container of the Deployment's pod template. A note lists any additional containers.
- **Running digest:** read from each pod's `containerStatuses[].imageID` for that container. Terminating pods (those with `metadata.deletionTimestamp`) are excluded. `imageID` comes in three forms:

  | `imageID` form | Meaning |
  |---|---|
  | `<repo>@sha256:<hex>` (containerd) | A registry digest. |
  | `docker-pullable://<repo>@sha256:<hex>` (older Docker shim) | The prefix is stripped, leaving a registry digest. |
  | `sha256:<hex>` alone, or empty | An image config id or unknown. **Never** used as a registry digest; `digestStatus` is `unavailable`. |

- **Mixed pods:** pods that disagree on image or digest make the target `mixed`, and each pod is named ("rollout in progress or inconsistent").
- **`rollout`:** computed from the Deployment JSON, with no blocking `rollout status` call. It is `complete` when `observedGeneration >= generation`, `updatedReplicas == replicas` and `availableReplicas == replicas`; otherwise `in-progress`.
- **`state`:** one of `Available`, `Unavailable`, `ScaledToZero` or `ProgressDeadlineExceeded`.
- **`lastModified`:** the `Progressing` condition's `lastUpdateTime`, when present.
- **No `matchLabels`:** when the selector has no `matchLabels`, pods are not read and the digest is `unavailable`.

**Failure mapping.**

| Situation | Result |
|---|---|
| `Error from server (NotFound)` | **missing**, and pods are not read |
| `Forbidden`, `Unauthorized`, "You must be logged in", an unknown context, `Unable to connect to the server`, a failing credential plugin, or `auth can-i` answering `no` | exit **20** |
| Any other error | exit **21** |

**Discover.** Lists the Deployments in a context and namespace that the caller supplies:

`kubectl --context <ctx> --namespace <ns> get deployments -o json`

---

## `compose`

**Config.**
- Component target: `{ "name", "adapter": "compose", "project", "service" }`.
- Workspace: `adapters.compose.timeoutSeconds`.

**Prerequisites and authentication.**
- The Docker CLI with the Compose v2 plugin (`docker compose`).
- A running Docker daemon, and the right docker context or `DOCKER_HOST`.
- There is no login concept: an unreachable daemon is the "auth" failure.

**Commands issued.** The engine never runs `docker compose up`, `pull` or `restart`, and never runs `docker pull` to learn a digest.
- Preflight:
  - `docker version --format {{.Server.Version}}`
  - `docker compose version`
- Read:
  - `docker compose --project-name <project> ps --all --format json`, once per project.
  - Then `docker container inspect <id>...` for the service's containers.
  - Then `docker image inspect <imageId>...` for their images.

**Fixed environment additions.** `LC_ALL=C`.

**What is reported.**
- **`ps` output in either shape:** NDJSON (one object per line, newer Compose v2) or one JSON array (older Compose v2) are both parsed.
- **`image`:** the container's configured reference, `Config.Image`.
- **`imageId`:** the local image id, the container's `Image` field.
- **Digest:** the `RepoDigests` entry whose repository matches the reference. An image that was never pushed has no such entry, so `digestStatus` is `unavailable` and only the image id is kept.
- **Scaled services:** when a service's containers disagree, the target is `mixed`.
- **`state`:** the container state (`running`, `exited`, …); `mixed` when containers differ. Health is listed in the details.
- **`lastModified`:** the container's `Created` time, when Compose (re)created it; an upper bound.
- **`State.StartedAt`:** only a detail. It means "running since", not a deploy time.

**Failure mapping.**

| Situation | Result |
|---|---|
| Empty `ps` output (an unknown project), or no container for the service | **missing** |
| `Cannot connect to the Docker daemon`, `error during connect`, or permission denied on the socket | exit **20** |
| `'compose' is not a docker command` | exit **20** (capability) |
| Any other error, or a line that is not JSON | exit **21** |

**Discover.** Lists services that have containers. When the caller names a project, that project's `ps` is read. Otherwise the engine first lists projects with `docker compose ls --all --format json`, then reads each project's `ps`.

---

## `command`

**Config.**
- Component target: `{ "name", "adapter": "command", "argv": [...], "extract": {...}, "preflightArgv"?: [...] }`.
- Workspace: `adapters.command`:
  - `timeoutSeconds`
  - optional `discoverArgv`

**The engine cannot verify that a configured command is read-only. That responsibility lies with whoever writes the config.** The engine's `validate-config` command prints every configured command, and the `deployment-status` skill shows them to the user the first time it uses a config.

**How commands run.**
- `argv[0]` is the program and the rest are its arguments, passed literally with no shell. Pipes, `$(...)` and `;` are not interpreted.
- The child gets the engine's environment exactly as it is; no variables are added.
- `preflightArgv`, when set, runs once per distinct argv at preflight. Exit 0 means ready.
- `argv` runs once per distinct argv per read.

**Extraction.** Choose one of two forms:

- **`{ "type": "json-path", "path": "$..." }`.** The output must be JSON. The path syntax is deliberately tiny, and a path selects at most one value:

  | Step | Meaning |
  |---|---|
  | `$` | The root; it must come first. |
  | `.key` | An object member. The key is letters, digits, `_`, `$` and `-`, and does not start with a digit. |
  | `[n]` | An array element. `n` is a non-negative integer with no leading zeros. |

  For example: `$.image`, `$.spec.containers[0].image`. There are no wildcards, filters, quoted keys or negative indexes.

- **`{ "type": "regex", "pattern": "..." }`.** The pattern is compiled with the Unicode flag and must contain a named group **`image`**, for example `image:\s+(?<image>\S+)`. Without a multiline flag, `^` and `$` match the start and end of the whole output, so prefer unanchored patterns.

**What is reported.**

| Output | Result |
|---|---|
| Exit 0, extraction yields a string | **found**. The string goes through the same reference parser as every other adapter. An invalid reference is reported as found, with an `invalid` image and a note. |
| Exit 0 with empty or whitespace-only output | **missing** |
| A JSON `null` at the path | **missing** |
| A non-zero exit, a timeout, or over-sized output | exit **21**. The command's error output is never interpreted, so it is never read as "missing" or "auth". |
| Output that is not JSON, a path that does not exist, a value that is not a string, or a regex with no match | exit **21** |
| `argv[0]` not found | exit **20**, naming the binary |
| A `preflightArgv` that exits non-zero | exit **20** |

`state` and `lastModified` are not reported, and `digestStatus` is `not-exposed`.

**Discover.** Works only when `adapters.command.discoverArgv` is configured. Each non-empty line of its output is one candidate. Without it, the command adapter cannot discover.

---

## Fixture provenance

The adapters are developed and tested against **fixtures only**. Fake `az`, `kubectl`, `docker` and arbitrary-command executables are placed alone on the test `PATH`, so no real CLI, cloud, cluster or daemon is ever reached. Every fake records each call it receives, and every test asserts from that record that only read-only commands were issued. **All fixture data is synthetic**: names like `acme-api`, `stage-1` and `rg-acme-stage1`, the registry `registry.example.com`, subscription ids like `00000000-0000-0000-0000-000000000001`, and digests made of one repeated hex digit. No real CLI output was captured.

Research status in the tables below:
- **[V]** means the shape was checked on the cited page.
- **[M]** means the shape is modelled from the cited documentation and general CLI knowledge, not captured from a live session.

| Adapter | Verification level |
|---|---|
| `azure-appservice` | **Parity-proven port.** Behaviour matches an earlier engine that ran in production. The fixtures re-express its test suite synthetically. |
| `azure-containerapp` | **Fixture-only, modelled.** |
| `kubernetes` | **Fixture-only, modelled.** These are widely known shapes. |
| `compose` | **Fixture-only, modelled.** |
| `command` | **Caller-defined.** The output shape is whatever the configured command prints; the fixtures exercise the extraction rules. |
| Azure DevOps client | **Fixture-only, modelled [M].** Documented REST shapes (api-version 7.1) served by a local fake server; never contacted a real organisation. Some API assumptions still need a sandbox check (below). |

| Adapter | Fixture | Documented output shape it models | Reference | Status |
|---|---|---|---|---|
| `azure-appservice` | `az account show` account object | `{ id, name, tenantId, state, user }` | https://learn.microsoft.com/en-us/cli/azure/account#az-account-show | [M] |
| `azure-appservice` | `az webapp list` records | `name`, `resourceGroup`, `state`, `kind`, `lastModifiedTimeUtc`, `siteConfig.linuxFxVersion`, projected by the `--query` above | https://learn.microsoft.com/en-us/cli/azure/webapp#az-webapp-list | [M] (field set used by the parity engine) |
| `azure-appservice` | `linuxFxVersion` values (`DOCKER\|`, `COMPOSE\|`, `SITECONTAINERS`, runtime stacks) | The custom-container configuration value | https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container?pivots=container-linux | [V] |
| `azure-appservice` | `az webapp config show --query linuxFxVersion` | A JSON string or `null` | https://learn.microsoft.com/en-us/cli/azure/webapp/config#az-webapp-config-show | [M] |
| `azure-containerapp` | `az containerapp show` object | `properties.configuration.activeRevisionsMode`, `latestRevisionName`, `latestReadyRevisionName`, `provisioningState`, `runningStatus`, `template.containers[]`, `systemData.lastModifiedAt` | https://learn.microsoft.com/en-us/cli/azure/containerapp#az-containerapp-show | [M] (command list [V], field paths [M]) |
| `azure-containerapp` | `az containerapp revision list` array | `properties.active`, `trafficWeight`, `runningState`, `healthState`, `template.containers[].image` | https://learn.microsoft.com/en-us/cli/azure/containerapp/revision#az-containerapp-revision-list | [M] |
| `azure-containerapp` | Missing-extension message | "The command requires the extension containerapp" | https://learn.microsoft.com/en-us/cli/azure/azure-cli-extensions-overview | [M] |
| `kubernetes` | `get deployment -o json` | apps/v1 Deployment: `spec.selector.matchLabels`, `spec.template.spec.containers[]`, `status.{observedGeneration, updatedReplicas, readyReplicas, availableReplicas, conditions[]}` | https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/deployment-v1/ | [M] |
| `kubernetes` | `get pods -o json` | v1 Pod list: `metadata.deletionTimestamp`, `status.containerStatuses[].{name, image, imageID, ready, state}` | https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/ | [M] |
| `kubernetes` | Error texts | `Error from server (NotFound)`, `(Forbidden)`, `(Unauthorized)`, `context "…" does not exist`, `auth can-i` yes/no | https://kubernetes.io/docs/reference/kubectl/ | [M] |
| `compose` | `docker compose ps --format json` | NDJSON (Compose v2.21+) and JSON array (older v2): `ID`, `Name`, `Service`, `Image`, `State`, `Status`, `Health`, `ExitCode` | https://docs.docker.com/reference/cli/docker/compose/ps/ | [M] |
| `compose` | `docker container inspect` | `[{ Id, Created, Image, Config.Image, State.{Status, Running, StartedAt, Health.Status} }]` | https://docs.docker.com/reference/cli/docker/container/inspect/ | [M] |
| `compose` | `docker image inspect` | `[{ Id, RepoTags[], RepoDigests[] }]`; `RepoDigests` is empty for a never-pushed image | https://docs.docker.com/reference/cli/docker/image/inspect/ | [M] |
| `compose` | Error texts | `Cannot connect to the Docker daemon`, `error during connect`, `'compose' is not a docker command` | https://docs.docker.com/reference/cli/docker/ | [M] |
| `command` | Arbitrary output | Synthetic JSON documents and `key: value` text chosen to exercise the JSON path and regex rules | (caller-defined) | n/a |

### Azure DevOps client

The pipeline reads (`status`, `pipeline-runs`, `pipeline-run`, `pipeline-preview`) and the one write (`run-pipeline`) are tested against `engine/test/fixtures/fake-azure-devops.mjs`: an HTTP server bound to `127.0.0.1` on a random port that records every request (method, path, query, whether the PAT matched, the body of a non-GET — never the header value) before answering. It serves only synthetic data — organisation `acme-org`, project `acme-project`, pipeline ids like `101`, a synthetic PAT — and models the failure modes 401, 403, 203 + HTML sign-in page (wrong or missing PAT), 200 + HTML, 302 to sign-in, 404 JSON and HTML, 429 with `Retry-After`, 500, slow answers (timeouts), invalid JSON and connection resets. No real organisation, pipeline or run was used; no real response was captured.

| Client | Fixture | Documented REST shape it models (api-version 7.1) | Reference | Status |
|---|---|---|---|---|
| Azure DevOps client | Build list / Build get | `GET _apis/build/builds?definitions=&$top=&queryOrder=queueTimeDescending` (paged by `x-ms-continuationtoken`), `GET _apis/build/builds/{id}`: `id`, `buildNumber`, `status`, `result`, `sourceVersion`, `sourceBranch`, `templateParameters`, `definition.id`, `reason`, `queueTime`/`startTime`/`finishTime`, `_links.web` | https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1 | [M] (endpoint [V]) |
| Azure DevOps client | Build timeline | `GET _apis/build/builds/{id}/timeline`: `records[]` with `type`, `name`, `state`, `result`; pending `Checkpoint.Approval` / `Checkpoint.TaskCheck` records mark an approval or check wait | https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1 (Builds API family) | [M] |
| Azure DevOps client | Pipelines get | `GET _apis/pipelines/{id}`: `id`, `name`, `folder`, `revision`, `_links.web`, `configuration.repository` `{ id, type }`, used for existence only — it cannot validate parameters | https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/pipelines/get?view=azure-devops-rest-7.1 | [V] (the `configuration.repository` field [M]) |
| Azure DevOps client | Runs queue | `POST _apis/pipelines/{id}/runs` with `templateParameters` and `resources.repositories.self.{refName, version}`; the answer's `id`, `state`, and the echoed `resources.repositories.self.version` | https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/run-pipeline?view=azure-devops-rest-7.1 | [V] (request/response) / [M] (`version` pinning) |
| Azure DevOps client | Approvals query | `GET _apis/pipelines/approvals?state=pending&$expand=steps[&approvalIds=]`: `id`, `status`, `steps[].assignedApprover.displayName`, `instructions` — read only, never approved | https://learn.microsoft.com/en-us/rest/api/azure/devops/approvalsandchecks/approvals/query?view=azure-devops-rest-7.1 | [M] |
| Azure DevOps client | Git Refs | `GET _apis/git/repositories/{repo}/refs?filter=heads/<branch>`: `value[].{name, objectId}` — the remote-head check before queueing | https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/list?view=azure-devops-rest-7.1 | [V] |
| Azure DevOps client | Auth and rate limits | wrong or missing PAT → 203 with an HTML sign-in page (or 401/302); 429 with `Retry-After` | https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops · https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rate-limits?view=azure-devops | [M] (203 page) / [V] (rate limits) |

Build history uses **Build (Read)**. Resolving the
remote revision for a preview uses **Code (Read)**. Queuing the confirmed action needs
**Build (Read & execute)** and permission to queue the selected pipeline. The engine reads the
PAT from `AZURE_DEVOPS_EXT_PAT` and accepts its expiry through `AZURE_DEVOPS_PAT_EXPIRES`.
[Build history](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1) · [Git refs](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/list?view=azure-devops-rest-7.1) · [Queue a pipeline](https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/run-pipeline?view=azure-devops-rest-7.1)

**Still unconfirmed — check in a sandbox organisation before the first real `promote`:**

1. **Build definition id = pipeline id.** The reads list runs through the Build API with `definitions=<pipelineId>`, assuming a YAML pipeline's id is its build definition id (and a run id is its build id).
2. **Approval id = timeline record id.** A pending approval is linked to a run by matching the Approvals query `id` with the `Checkpoint.Approval` timeline record's id; the Approvals response itself carries no documented link to a run.
3. **Runs API `version` pinning semantics.** That `resources.repositories.self.version = <full sha>` (with `refName`) builds exactly that commit, whether the sha must be reachable from `refName`, and that the answer echoes it. The engine checks the echo after queueing and reports a mismatch as exit 21 (`pin-mismatch`), and checks the remote head with Git Refs before queueing.
4. **The `configuration.repository` field** of Pipelines Get (used when a mapping names no `repository`) — its presence and shape for Azure Repos Git pipelines.

The full research notes and the sandbox checklist are in the plugin's development documentation (`release-radar-docs/research/azure-devops-pipelines-rest.md`, sections 1, 3 and 6).

**Before relying on a modelled adapter in production,** capture its real output once from an environment you own, with names removed, and compare it with the shapes above.
