# Azure DevOps Pipelines REST (api-version 7.1) — read facts, queue a run, pin a commit

Researched 2026-11-25 for `release-radar-docs/refined-request-release-radar-plugin.md` (sections E, I, J).
Legend: **[V]** verified on the cited page 2026-11-25; **[M]** modelled — confirm with the sandbox checklist (section 6).
Names in examples are synthetic.

## 1. Sources (all 7.1)
- Run Pipeline: https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/run-pipeline?view=azure-devops-rest-7.1
- Runs List: https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/list?view=azure-devops-rest-7.1
- Runs Get: https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/get?view=azure-devops-rest-7.1
- Pipelines Get / List: https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/pipelines/get?view=azure-devops-rest-7.1 · .../pipelines/list?view=azure-devops-rest-7.1
- Logs List: https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/logs/list?view=azure-devops-rest-7.1
- Builds List / Queue: https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1 · .../build/builds/queue?view=azure-devops-rest-7.1
- Approvals Query: https://learn.microsoft.com/en-us/rest/api/azure/devops/approvalsandchecks/approvals/query?view=azure-devops-rest-7.1
- Git Refs List: https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/list?view=azure-devops-rest-7.1
- Rate limits: https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rate-limits?view=azure-devops
- PAT usage: https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops

## 2. Endpoints (base `https://dev.azure.com/{org}` or the configured `organizationUrl`)

| Purpose | Request | Scope |
|---|---|---|
| List pipelines | `GET {base}/{project}/_apis/pipelines?api-version=7.1[&$top&continuationToken&orderBy]` | `vso.build` |
| Get pipeline | `GET .../_apis/pipelines/{id}?api-version=7.1` | `vso.build` |
| List runs | `GET .../_apis/pipelines/{id}/runs?api-version=7.1` (up to 10000; no paging params documented) | `vso.build` |
| Get run | `GET .../_apis/pipelines/{id}/runs/{runId}?api-version=7.1` | `vso.build` |
| Queue run | `POST .../_apis/pipelines/{id}/runs?api-version=7.1` | `vso.build_execute` |
| Logs list | `GET .../_apis/pipelines/{id}/runs/{runId}/logs?api-version=7.1[&$expand=signedContent]` | `vso.build` |
| Build list | `GET {base}/{project}/_apis/build/builds?definitions=ID&$top=N&queryOrder=queueTimeDescending&api-version=7.1` | `vso.build` |
| Pending approvals | `GET .../_apis/pipelines/approvals?state=pending&$expand=steps&api-version=7.1` | `vso.build` |
| Remote branch head | `GET .../_apis/git/repositories/{repo}/refs?filter=heads/main&api-version=7.1` | `vso.code` |

PAT UI names: Build (Read), Build (Read & execute), Code (Read). Queueing also needs "Queue builds" permission on the pipeline.

## 3. Facts that shape the design

### 3.1 Pipelines Get cannot validate parameters [V]
Its schema is `id, name, folder, revision, url, _links, configuration.type` — **no declared YAML `parameters:`**.
Spec requirement 48 ("get the pipeline definition including its declared parameters") cannot be met from it. Options:
- (a) `previewRun: true` with the `templateParameters`: the server expands the YAML, returns `finalYaml`, and
  rejects undeclared parameters or invalid choice values with HTTP 400 (exact text **[M]**). **But it is a POST
  with scope `vso.build_execute`** — it breaks "read commands issue zero non-GET requests" (AC 6a) and the
  read-only-PAT story.
- (b) Read the YAML from the repo (Git Items API, `vso.code`) and parse `parameters:` — read-only but fragile with templates.
- (c) No remote validation: validate only against the config's declared actions; a bad parameter makes the queue call fail with 400 and no run is created.

**Recommendation:** `pipeline-preview` is local and GET-only by default; remote validation is a separate
opt-in flag (e.g. `--remote-validate`), whitelisted in the fake server as the single allowed POST body shape
(`previewRun === true`) and reported as its own request class.

### 3.2 Run request and response [V]
Body fields: `previewRun`, `resources`, `stagesToSkip`, `templateParameters`, `variables`, `yamlOverride`.
`resources.repositories.<alias>` = `RepositoryResourceParameters {refName, token, tokenType, version}`;
`version` is a string with undocumented semantics. `Run` fields: `id, name, state, result, createdDate,
finishedDate, pipeline{id,name,folder,revision,url}, resources, templateParameters, variables, finalYaml, url,
_links`; `Run.resources.repositories.<alias>` = `{refName, version, repository{type}}`.
**No `startTime` or `queueTime` on a Run** — only `createdDate`/`finishedDate`.

```json
POST {base}/{project}/_apis/pipelines/{id}/runs?api-version=7.1
Content-Type: application/json

{
  "resources": { "repositories": { "self": {
      "refName": "refs/heads/main",
      "version": "0123456789abcdef0123456789abcdef01234567" } } },
  "templateParameters": { "action": "build-and-push", "imageTag": "0123456" }
}
```

### 3.3 Commit pinning [partly V, mostly M]
- `resources.repositories.self.version = <40-hex sha>` with `refName` is the widely used way to run a specific
  commit, but the official page does not state the semantics → **[M] until sandbox-confirmed.**
- Documented alternative: Build Queue with explicit `sourceVersion`:
  `POST .../_apis/build/builds?api-version=7.1` `{"definition":{"id":N},"sourceBranch":"refs/heads/main","sourceVersion":"<sha>","templateParameters":{...}}` (same scope).
- Run id = build id for YAML pipelines in one project **[M]** — lets a run be followed through either API.
- After queueing, check the response `resources.repositories.self.version` echoes the pinned sha; if not, report loudly (the run exists and cannot be undone).
- Whether a pinned sha must be reachable from `refName` is **[uncertain]**. Hence Open Question 12's remote check
  before queueing: `GET refs?filter=heads/main` → compare `value[0].objectId` with the previewed sha (`vso.code`),
  or `git ls-remote <url> refs/heads/main`. If `run.resources.repositories.self.repository.type` is `gitHub`, the Azure Repos refs endpoint does not apply.
- Without a pin: refuse with exit 27 if the remote head moved since the preview.

### 3.4 State/result enums [V]
- Runs `state`: `unknown | inProgress | canceling | completed`; `result`: `unknown | succeeded | failed | canceled` (absent while running).
- Build `status`: `none | inProgress | completed | cancelling | postponed | notStarted | all`; `result`: `none | succeeded | partiallySucceeded | failed | canceled`.
- **Gap:** Runs has no `partiallySucceeded`. Terminal = `state === "completed"` (or Build `status === "completed"`);
  any result other than exactly `succeeded` → exit 25. For the result of record, `--follow` reads
  `GET _apis/build/builds/{runId}` (can return `partiallySucceeded`). Whether Runs `Get` returns it in practice: **[M]**.
- A queued, not-started run may show `inProgress`. Unknown state strings = non-terminal; keep polling until timeout.

### 3.5 Listing recent runs
- Runs List: no `$top`/order/continuation documented; up to 10000; items may omit `resources`/`templateParameters` **[M]** → N+1 `Get`s.
- Builds List: `$top`, `queryOrder`, `definitions`, `branchName`, `statusFilter`, `resultFilter`, `continuationToken`;
  a Build carries `sourceVersion`, `sourceBranch`, `queueTime`, `startTime`, `finishTime`, `status`, `result`,
  `templateParameters` (object), `parameters` (string), `triggerInfo`, `reason`, `repository`, `_links`.
- **Recommendation:** Build list for read facts (one call gives commit, times, parameters); Runs API for queueing
  and optionally for `Get` while following. If Runs List is used, sort client-side by `createdDate` desc and take `runHistoryCount`.
- Continuation: Build list returns a token (header `x-ms-continuationtoken` **[M]**); Pipelines List uses a
  `continuationToken` query param. Loop until absent, with a hard page cap.

### 3.6 Source commit of a run
- Runs: `run.resources.repositories.self.version` (+ `refName`), only when the repo resource is `self`; with multiple repositories select the configured alias, else `undetermined`.
- Builds: `build.sourceVersion` / `build.sourceBranch` (better).
- Accept only `/^[0-9a-f]{40}$/i` (64-char for SHA-256 repos); otherwise `undetermined`.

### 3.7 Image tag a build pushed — generally not determinable [V/M]
Nothing in Runs/Builds records pushed tags. Sources, in order:
1. The run's `templateParameters`, when the config declares which parameter carries the tag (deterministic, best).
2. The stage tag convention (e.g. "tag = first 7 chars of the source commit"), only when the config states the pipeline follows it.
3. Logs (`GET .../runs/{id}/logs` → `{logs:[{id,lineCount,createdOn,lastChangedOn,url,signedContent?}]}`): parsing "docker push" lines is fragile, secret-masked and task-dependent — **not in v1**.
4. Artifacts/timeline — only if the pipeline publishes tag metadata (custom).
Rule: determined only from (1) or (2), else the literal `undetermined` (spec requirement 33). CI-triggered runs carry no `templateParameters` → `undetermined` unless (2) applies.

### 3.8 Approval/check waits
The Approvals Query response (`id, status, steps[], createdOn, instructions, minRequiredApprovers, permissions`)
has **no documented field linking it to a run/pipeline**; `steps[].assignedApprover.displayName` gives approvers.
Linking is **[M]**: `GET _apis/build/builds/{id}/timeline` → records whose `type`/`name` start with `Checkpoint`
(`Checkpoint.Approval`, `Checkpoint.TaskCheck`) in pending/in-progress state; then report approver NAMES from
the Approvals API. Never approve (no PATCH/POST). Run `state` stays `inProgress` while waiting, so `--follow`
needs the timeline to distinguish "building" from "waiting".

### 3.9 Auth failures
- Header `Authorization: Basic base64(":" + PAT)` — empty username fine [V].
- Bad/expired PAT: commonly **HTTP 203** with an HTML sign-in page, a 302 to a login URL, or 401 **[M]**; 403 for valid-but-forbidden.
- Send `Accept: application/json;api-version=7.1`, `redirect: 'manual'`, and `X-TFS-FedAuthRedirect: Suppress` (401 instead of redirect **[M]**).
- Classify in this order, before parsing JSON:
  1. 401, 403, 203, any 3xx → auth (exit 20).
  2. 200 with non-JSON content-type (HTML sign-in) → auth (exit 20).
  3. 404 with JSON body (`typeKey`/`message`) → not found (exit 23 for a declared pipeline).
  4. 404 with HTML/non-JSON → auth or wrong URL, never "not found".
  5. 429 → rate-blocked (exit 21, message from `TF400733`).
  6. 5xx, timeout, DNS → source error (exit 21).
  A 200 JSON body that fails to parse → exit 21, not "no runs".
- Expiry: expired PATs are rejected on the next request; for Entra-backed orgs an old PAT may become inactive
  unless the user signs in within 90 days. The PAT page gives **two different global-PAT retirement dates**
  (January 27, 2027 and December 1, 2026) **[uncertain]**. Document organisation-scoped PATs; Entra tokens are Microsoft's preferred path (out of scope for v1).
- A PAT is 84 characters. Never log the header or credential-bearing URLs.

### 3.10 Rate limits [V]
200 TSTUs per user per sliding 5 minutes; delays from milliseconds to 30 s; blocked requests → **429** with
`TF400733`. Headers: `Retry-After` (seconds), `X-RateLimit-Delay`, `-Limit`, `-Remaining`, `-Reset`, `-Cost`,
`-Resource`. "Retry-After ... The response still returns HTTP 200" → honour it even on 2xx before the next request.
Engine rules: sleep on `Retry-After`; reads get at most one bounded retry on 429; **never retry the queue POST** —
a timeout on the POST is "unknown outcome": list runs read-only to detect whether it was created, report, never re-POST.
`--follow` at `followPollSeconds` stays well under the limit.

## 4. TypeScript client skeleton (no deps, Node ≥ 20)

```ts
import { createHash } from "node:crypto";

export class AuthError extends Error {}      // exit 20
export class NotFoundError extends Error {}  // exit 23
export class SourceError extends Error {}    // exit 21

export interface AzdoConfig { organizationUrl: string; project: string; timeoutMs: number; }

function authHeader(pat: string): string {
  return "Basic " + Buffer.from(":" + pat).toString("base64");
}

async function request(cfg: AzdoConfig, pat: string, method: "GET" | "POST",
                       path: string, body?: unknown): Promise<unknown> {
  const url = `${cfg.organizationUrl.replace(/\/+$/, "")}/${encodeURIComponent(cfg.project)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(cfg.timeoutMs),
      headers: {
        Authorization: authHeader(pat),
        Accept: "application/json;api-version=7.1",
        "X-TFS-FedAuthRedirect": "Suppress",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new SourceError(`request failed: ${(e as Error).name}`); // never include headers
  }
  const ct = res.headers.get("content-type") ?? "";
  const isJson = ct.toLowerCase().includes("application/json");
  if ([401, 403, 203].includes(res.status) || (res.status >= 300 && res.status < 400))
    throw new AuthError(`HTTP ${res.status} (not authenticated JSON)`);
  if (res.status === 200 && !isJson) throw new AuthError("HTTP 200 with non-JSON body (sign-in page)");
  if (res.status === 404) {
    if (isJson) throw new NotFoundError("HTTP 404 (JSON)");
    throw new AuthError("HTTP 404 with non-JSON body");
  }
  if (res.status === 429) throw new SourceError("HTTP 429 rate-blocked");
  if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    await new Promise(r => setTimeout(r, Math.min(retryAfter, 30) * 1000));
  try { return await res.json(); }
  catch { throw new SourceError("200 but body is not valid JSON"); }
}

export interface RunFacts {
  id: number; state: string; result?: string;
  createdDate?: string; finishedDate?: string;
  refName?: string; commit?: string; templateParameters?: Record<string, unknown>;
}

export function toRunFacts(r: any): RunFacts {
  const self = r?.resources?.repositories?.self;
  const v = typeof self?.version === "string" && /^[0-9a-f]{40,64}$/i.test(self.version)
    ? self.version : undefined;
  return {
    id: r.id, state: r.state, result: r.result,
    createdDate: r.createdDate, finishedDate: r.finishedDate,
    refName: self?.refName, commit: v, templateParameters: r.templateParameters,
  };
}

export const isTerminal = (r: RunFacts) => r.state === "completed";
export const isSuccess  = (r: RunFacts) => r.state === "completed" && r.result === "succeeded";
// Everything terminal and not exactly "succeeded" => exit 25.

// Build-API listing (preferred for facts; has sourceVersion)
export async function listBuilds(cfg: AzdoConfig, pat: string, defId: number, top: number) {
  const q = `?definitions=${defId}&$top=${top}&queryOrder=queueTimeDescending&api-version=7.1`;
  return (await request(cfg, pat, "GET", `/_apis/build/builds${q}`) as any).value as any[];
}

// The ONLY write. Export it from a module that only run-pipeline imports.
export async function queueRun(cfg: AzdoConfig, pat: string, pipelineId: number, req: {
  refName: string; sha: string; templateParameters: Record<string, string>;
}) {
  const body = {
    resources: { repositories: { self: { refName: req.refName, version: req.sha } } },
    templateParameters: req.templateParameters,
  };
  const run = await request(cfg, pat, "POST", `/_apis/pipelines/${pipelineId}/runs?api-version=7.1`, body) as any;
  const echoed = run?.resources?.repositories?.self?.version;
  return { run, pinMatched: echoed === req.sha, echoed };
}

// Token bound to every request element (spec 49): hash a canonical form.
export function requestDigest(parts: Record<string, unknown>): string {
  const canon = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash("sha256").update(canon).digest("hex");
}
```

Notes: `templateParameters` values are sent as strings (native booleans/numbers **[M]**). The canonical JSON must
sort nested keys too — use a recursive stable stringify (the sketch sorts only the top level).

## 5. Fake REST server (tests)
- Routes: `GET pipelines`, `GET pipelines/{id}`, `GET pipelines/{id}/runs`, `GET pipelines/{id}/runs/{rid}`,
  `POST pipelines/{id}/runs`, `GET build/builds`, `GET build/builds/{id}/timeline`, `GET pipelines/approvals`.
- Count every non-GET request per test.
- Modes: 200 JSON; 401; 403; 203 + HTML; 200 + HTML; 302 to login; 404 JSON; 404 HTML; 429 + `Retry-After`; 500;
  slow response (timeout); invalid JSON.
- Decode Basic auth and compare to the expected PAT; a wrong PAT gets the 203 HTML page.
- Record the queued POST body so tests assert it equals the previewed parameters exactly.

## 6. Sandbox verification checklist (before the first real `promote`)
1. `resources.repositories.self.version` pins the commit and the response echoes it.
2. A sha not on the ref — what happens?
3. An undeclared `templateParameters` key → 400 with a clear message.
4. `partiallySucceeded` on Runs `Get`, or only on Builds.
5. Run id equals build id.
6. Build list returns `sourceVersion` and `templateParameters`.
7. 203 HTML page on a bad PAT.
8. The `x-ms-continuationtoken` header name.
9. Timeline `Checkpoint.*` records while an approval is pending.
