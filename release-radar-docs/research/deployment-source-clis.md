# Deployment-source CLIs — read the running image, state and last change, read-only

Researched 2026-11-25 for `release-radar-docs/refined-request-release-radar-plugin.md` (section D).
Legend: **[V]** verified on the cited page 2026-11-25; **[M]** modelled — capture real output once and replace
the fixtures. Names are synthetic.

## 1. Sources
- App Service custom containers (`DOCKER|`, Compose retirement, sidecars): https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container?pivots=container-linux **[V]**
- `az containerapp` group: https://learn.microsoft.com/en-us/cli/azure/containerapp — only the command list verified; field paths **[M]**
- kubectl and Docker CLI behaviour, `az` exit codes: prior knowledge **[M]**

## 2. Common conventions
- Spawn with argv (no shell), a timeout, `windowsHide`, and a capped buffer (e.g. 64 MiB).
- `LC_ALL=C`; for `az`, `AZURE_CORE_ONLY_SHOW_ERRORS=true`. Pass the existing environment through unchanged and
  read nothing from it (setting a fixed variable is not "reading credential env vars").
- Failure kinds from the spawn result:
  - **CLI missing:** spawn error `code === "ENOENT"` → exit 20, naming the binary.
  - **Timeout:** killed → exit 21 unless stderr identifies auth.
  - **Not logged in / no context:** stderr pattern (below) → exit 20.
  - **Resource absent:** stderr pattern or empty result → target `missing` (exit 23 if declared).
  - **Anything else:** exit 21.
- Match stderr case-insensitively from ONE pattern table with unit tests; no match → "other error (21)", never "missing".

```ts
import { spawn } from "node:child_process";

export type Outcome =
  | { kind: "ok"; stdout: string }
  | { kind: "cli-missing"; bin: string }
  | { kind: "timeout" }
  | { kind: "exit"; code: number | null; stderr: string; stdout: string };

export function run(bin: string, args: string[], timeoutMs: number): Promise<Outcome> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", done = false;
    const finish = (o: Outcome) => { if (!done) { done = true; clearTimeout(t); resolve(o); } };
    const t = setTimeout(() => { child.kill("SIGKILL"); finish({ kind: "timeout" }); }, timeoutMs);
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(e.code === "ENOENT" ? { kind: "cli-missing", bin } : { kind: "exit", code: null, stderr: e.message, stdout: out }));
    child.on("close", code => finish(code === 0 ? { kind: "ok", stdout: out }
                                               : { kind: "exit", code, stderr: err, stdout: out }));
  });
}
```

## 3. Azure App Service (Linux containers)

**Preflight:** `az account show --output json` → `{id, name, tenantId, state, user}`.
- Not logged in: exit 1, stderr contains `az login` ("Please run 'az login' to setup account.") **[M]**.
- Wrong/expired token: stderr contains `AADSTS`, `Interactive authentication is needed`, or `refresh token has expired` → auth (20) **[M]**.
- Unknown subscription: `az account show --subscription <id>` → "Subscription '<id>' not found".

**Read (once per subscription — parity requirement):** `az webapp list --subscription <id> --output json`.
Fields: `name`, `resourceGroup`, `state` (`Running`/`Stopped`), `kind` (contains `app,linux,container`),
`lastModifiedTimeUtc`, `siteConfig.linuxFxVersion`. Whether `list` always populates `linuxFxVersion` is **[M]**
(the existing engine relies on it); if null for a container app, read that one target with
`az webapp config show -g <rg> -n <name> --subscription <id> --query linuxFxVersion -o tsv`.
Slots are not in `list` (`az webapp deployment slot list`) — out of v1.

**`linuxFxVersion` prefixes:**

| Value | Meaning | Handling |
|---|---|---|
| `DOCKER\|registry.example.com/acme/api:1.2.3` | single container | parse the image |
| `COMPOSE\|<base64>` | multi-container (Compose), **retiring 2027-03-31** [V] | `kind: multi-container`, no single image |
| `KUBE\|<base64>` | legacy Kubernetes config | as COMPOSE |
| `SITECONTAINERS` | sidecar model (newer) **[M]** | `kind: sidecar`, image read separately |
| `NODE\|20-lts`, `PYTHON\|3.11`, `DOTNETCORE\|8.0` | built-in runtime stack | `kind: non-container` |
| empty / null | unset or Windows app | `kind: non-container` |

**Sidecars [M]:** `az webapp sitecontainers list --resource-group <rg> --name <app>` → containers with `isMain`
and `image` (ARM `Microsoft.Web/sites/sitecontainers`); CLI command name not confirmed. v1: report
`kind: sidecar`, image `undetermined`; full support is a v1.1 extension.

**Last-modified:** `lastModifiedTimeUtc` changes on any site change (setting, restart, config) → an upper bound on deployment time (spec requirement 32).

**Absent:** missing from `list` → `missing`; `az webapp show` exits non-zero with `ResourceNotFound` (exit code 3 in recent CLIs **[M]**).

```json
[
  { "name": "acme-api-stage1", "resourceGroup": "rg-acme-stage1", "state": "Running",
    "kind": "app,linux,container", "lastModifiedTimeUtc": "2026-11-10T09:12:44.123Z",
    "siteConfig": { "linuxFxVersion": "DOCKER|registry.example.com/acme/api:3f2a9c1" } },
  { "name": "acme-web-stage1", "resourceGroup": "rg-acme-stage1", "state": "Stopped",
    "kind": "app,linux", "lastModifiedTimeUtc": "2026-10-01T00:00:00Z",
    "siteConfig": { "linuxFxVersion": "NODE|20-lts" } }
]
```

## 4. Azure Container Apps

**Preflight:** `az account show`, then `az containerapp --help`. A missing extension prints a message containing
`containerapp` and `extension` (e.g. "The command requires the extension containerapp...") and fails
non-interactively → preflight failure naming the capability, hint `az extension add --name containerapp` **[M]**.
Never auto-install (a write).

**Read:** `az containerapp show --name <app> --resource-group <rg> --subscription <id> --output json` and
`az containerapp revision list --name <app> --resource-group <rg> --subscription <id> --output json`.

| Fact | Path **[M]** |
|---|---|
| Revision mode | `properties.configuration.activeRevisionsMode` (`Single`/`Multiple`) |
| Template images (latest revision) | `properties.template.containers[].image` (+ `initContainers[]`) |
| Latest revision | `properties.latestRevisionName` |
| Latest ready revision | `properties.latestReadyRevisionName` |
| Provisioning state | `properties.provisioningState` (`Succeeded`, `InProgress`, `Failed`, `Canceled`, `Deleting`) |
| Running state | `properties.runningStatus.runningState` (newer API versions; may be absent) |
| Last modified | `systemData.lastModifiedAt` |
| Revision active / image / traffic | `revision list[].properties.active` / `.template.containers[].image` / `.trafficWeight` |
| Revision health | `.healthState`, `.runningState`, `.provisioningState`, `.replicas` |

Logic: what runs is the active revision(s) with `trafficWeight > 0` (Multiple) or the single active revision.
`properties.template` describes the LATEST revision, which may not be serving yet when
`latestReadyRevisionName !== latestRevisionName` → prefer the `latestReadyRevisionName` revision's image from
`revision list`. With split traffic, report each active revision's image and weight and flag within-target
inconsistency. No digest is exposed (tags only) — state this in `adapters.md`. Absent: stderr `ResourceNotFound`
or `could not be found` → `missing`.

```json
{
  "name": "acme-api",
  "systemData": { "lastModifiedAt": "2026-11-12T08:00:00Z" },
  "properties": {
    "provisioningState": "Succeeded",
    "latestRevisionName": "acme-api--0000007",
    "latestReadyRevisionName": "acme-api--0000007",
    "configuration": { "activeRevisionsMode": "Single" },
    "template": { "containers": [ { "name": "api", "image": "registry.example.com/acme/api:3f2a9c1" } ] }
  }
}
```

```json
[
  { "name": "acme-api--0000007",
    "properties": { "active": true, "trafficWeight": 100, "runningState": "Running",
      "healthState": "Healthy", "provisioningState": "Provisioned", "replicas": 2,
      "createdTime": "2026-11-12T07:58:11+00:00",
      "template": { "containers": [ { "image": "registry.example.com/acme/api:3f2a9c1" } ] } } },
  { "name": "acme-api--0000006",
    "properties": { "active": false, "trafficWeight": 0,
      "template": { "containers": [ { "image": "registry.example.com/acme/api:aa11bb2" } ] } } }
]
```

## 5. Kubernetes

**Preflight [M]:**
1. `kubectl version --client -o json` — ENOENT → CLI missing (20).
2. `kubectl config get-contexts <ctx> -o name` — unconfigured: `error: context "<ctx>" does not exist` (exit 1) → 20.
3. `kubectl --context <ctx> --namespace <ns> auth can-i get deployments` → `yes`/`no` (exit 0/1); `no` → 20.
   `Unable to connect to the server`, `You must be logged in to the server (Unauthorized)`, `Error from server (Forbidden)` → 20.
- Always pin `--context` and `--namespace`; never use the ambient context; never `kubectl config use-context` (a kubeconfig write).

**Read:** `kubectl --context C -n NS get deployment NAME -o json`
- Desired images: `spec.template.spec.containers[].image` (+ `initContainers`); selector `spec.selector.matchLabels`.
- Rollout: `metadata.generation`, `status.observedGeneration`, `spec.replicas`, `status.updatedReplicas`,
  `readyReplicas`, `availableReplicas`, `unavailableReplicas`, `status.conditions[]` (types `Available`,
  `Progressing`; reasons `NewReplicaSetAvailable`, `ReplicaSetUpdated`, `ProgressDeadlineExceeded`).
- Last change: no clean field; `status.conditions[type=Progressing].lastUpdateTime` as an upper bound, or omit.
- Absent: `Error from server (NotFound): deployments.apps "NAME" not found` (exit 1) → `missing`.

**Actual running digests:** `kubectl --context C -n NS get pods -l <k=v,...> -o json`
→ `items[].status.containerStatuses[]`: `name`, `image`, `imageID`, `ready`, `restartCount`, `state`
(`running`; `waiting.reason` e.g. `ImagePullBackOff`/`CrashLoopBackOff`; `terminated`). `imageID` forms **[M]**:
- `registry.example.com/acme/api@sha256:<64hex>` (containerd, typical);
- `docker-pullable://registry.example.com/acme/api@sha256:<64hex>` (older docker shim) — strip the prefix;
- `sha256:<64hex>` alone or empty — an image config id or unknown, **not** a registry digest; never use it as cross-stage proof; digest `unavailable`.
Filter pods to the Deployment's current ReplicaSet (`metadata.ownerReferences`; RS annotation
`deployment.kubernetes.io/revision`). Safe approximation: selector-matched pods, excluding terminating ones
(`metadata.deletionTimestamp`); flag mixed images/digests as "rollout in progress or inconsistent" and name them.
Rollout complete (from JSON, no blocking `rollout status`):
`observedGeneration >= generation && updatedReplicas === replicas && availableReplicas === replicas`.

```json
{
  "metadata": { "name": "acme-api", "namespace": "stage-1", "generation": 5 },
  "spec": { "replicas": 2,
    "selector": { "matchLabels": { "app": "acme-api" } },
    "template": { "spec": { "containers": [ { "name": "api", "image": "registry.example.com/acme/api:3f2a9c1" } ] } } },
  "status": { "observedGeneration": 5, "replicas": 2, "updatedReplicas": 2, "readyReplicas": 2, "availableReplicas": 2,
    "conditions": [ { "type": "Available", "status": "True" },
      { "type": "Progressing", "status": "True", "reason": "NewReplicaSetAvailable", "lastUpdateTime": "2026-11-12T08:01:00Z" } ] }
}
```

```json
{ "items": [ { "metadata": { "name": "acme-api-6d9f-abcde" },
  "status": { "phase": "Running", "containerStatuses": [ { "name": "api", "ready": true, "restartCount": 0,
    "image": "registry.example.com/acme/api:3f2a9c1",
    "imageID": "registry.example.com/acme/api@sha256:0000000000000000000000000000000000000000000000000000000000000001",
    "state": { "running": { "startedAt": "2026-11-12T08:00:30Z" } } } ] } } ] }
```

## 6. Docker Compose

**Preflight [M]:** `docker version --format '{{.Server.Version}}'` — ENOENT → CLI missing (20); daemon down
(`Cannot connect to the Docker daemon`, `error during connect`, exit 1) → 20 (no login concept locally).
`docker compose version` — absent plugin: `'compose' is not a docker command` → CLI missing for the capability (20).

**Read:** `docker compose --project-name <p> [--file <f>] ps --all --format json`
- Compose v2.21+ prints NDJSON (one object per line); older v2 printed one JSON array → **parse both**.
- Fields **[M]**: `ID`, `Name`, `Service`, `Image`, `State` (`running`, `exited`, `restarting`, `paused`, `created`, `dead`),
  `Status`, `Health` (`healthy`, `unhealthy`, `starting`, empty), `ExitCode`, `Publishers`, `CreatedAt`.
- Unknown project / no containers → empty output, exit 0 → `missing` (not an error).

Per container `docker inspect <ID> --format json` (array of one): `[0].Config.Image` (configured reference, tag
form); `[0].Image` = local **image id** (`sha256:...`), not a registry digest; `[0].State.Status`, `.Running`,
`.StartedAt`, `.Health.Status`; `[0].Created`.
Digest: `docker image inspect <imageId> --format json` → `[0].RepoDigests[]` and `[0].RepoTags[]`. A never-pushed
local image has empty `RepoDigests` → digest `unavailable` (image id only). With several `RepoDigests`, choose
the one matching `Config.Image`'s repository. `State.StartedAt` = "running since", not deploy time.
Never `docker compose up/pull/restart`, never `docker pull` to learn a digest.

```
{"ID":"c0ffee000001","Name":"acme-api-1","Service":"api","Image":"registry.example.com/acme/api:3f2a9c1","State":"running","Status":"Up 3 hours (healthy)","Health":"healthy","ExitCode":0}
{"ID":"c0ffee000002","Name":"acme-worker-1","Service":"worker","Image":"registry.example.com/acme/worker:3f2a9c1","State":"exited","Status":"Exited (1) 2 minutes ago","Health":"","ExitCode":1}
```

```json
[ { "Id": "c0ffee000001...", "Image": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "Config": { "Image": "registry.example.com/acme/api:3f2a9c1" },
    "State": { "Status": "running", "Running": true, "StartedAt": "2026-11-12T08:00:30Z", "Health": { "Status": "healthy" } } } ]
```

## 7. Fake CLI shims (tests)
- Executable `az`, `kubectl`, `docker` scripts first on `PATH` in a temp dir; fixture chosen by `SHIM_SCENARIO`;
  call log to `SHIM_LOG`. Assert read-only argv from the log (never `delete`, `apply`, `up`, `config use-context`).
- Scenarios per adapter: ok; cli-missing (PATH = empty dir → ENOENT); not-logged-in (exit 1 + stderr pattern);
  resource-absent; other-error (exit 1 + unknown stderr → must map to 21); timeout (sleep past the limit).
- The stderr pattern table lives in one module shared by shims and classifier, marked "modelled, not captured".

## 8. Verification level for `adapters.md`

| Adapter | Level |
|---|---|
| azure-appservice | parity-proven (port of the existing engine) |
| azure-containerapp | fixture-only, paths **[M]** |
| kubernetes | fixture-only, shapes well known **[M]** |
| compose | fixture-only **[M]** |
| command | caller-defined |
