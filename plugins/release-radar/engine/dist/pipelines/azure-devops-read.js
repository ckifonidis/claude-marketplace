/**
 * Azure DevOps REST — the READ side (spec requirements 17, 29, 48, 66, 69, 73; plan D2, D8, D9;
 * research `azure-devops-pipelines-rest.md` §2-§3.10).
 *
 * ## The mutation boundary
 * This module can only send GET. Its single network function, {@link AzureDevOpsReader}'s private
 * `#send`, hands `fetch` the literal method "GET" and takes no method argument; the class
 * exposes only read helpers. The one write (queueing a run) lives in `azure-devops-write.ts`, which
 * only the `run-pipeline` command module imports (plan Phase 7). A test scans every compiled
 * module for non-GET method literals and for importers of the write module.
 *
 * ## Every request
 * `GET {organizationUrl}/{project}/_apis/...?api-version=7.1`, with
 * `Authorization: Basic base64(":" + PAT)` (never logged, never in a message),
 * `Accept: application/json;api-version=7.1`, `X-TFS-FedAuthRedirect: Suppress`,
 * `redirect: "manual"` and the configured `requestTimeoutSeconds` (`AbortSignal.timeout`, covering
 * the body too).
 *
 * ## Classification, in this order, before any JSON is parsed (research §3.9)
 * 1. 401, 403, 203 or any 3xx → auth (exit 20) — a bad/expired PAT is often a 203 sign-in page or
 *    a redirect to a login URL; it is NEVER read as "no runs" or "not found" (spec 17, 21);
 * 2. a 2xx (other than 204) whose content-type is not JSON → auth (20) (an HTML sign-in page);
 * 3. 404 with a JSON body → not found (exit 23; callers name what was not found);
 * 4. 404 without a JSON body → auth (20): a wrong URL or a sign-in page, never "not found";
 * 5. 429 → after the `Retry-After` wait (capped at {@link MAX_RETRY_AFTER_MS}; 1 s when the header
 *    is absent) ONE retry; a second 429 → exit 21 (rate-blocked, TF400733);
 * 6. any other non-2xx, a timeout, DNS or connection failure → exit 21;
 * 7. a 2xx JSON body that does not parse, or has an unexpected shape → exit 21 (never "no runs").
 * A `Retry-After` on ANY answer (Azure DevOps sends it on 200 while throttling) delays the NEXT
 * request (capped likewise).
 *
 * ## Paging
 * List calls follow the `x-ms-continuationtoken` response header with a `continuationToken` query
 * parameter, up to {@link MAX_PAGES} pages. A list that still has more pages after the cap is a
 * source error (21): a partial list never supports a "not found" or "no runs" conclusion.
 */
import { EXIT, EngineError } from "../errors.js";
import { describeNoAnswer } from "../verify.js";
/** The REST API version of every call. */
export const API_VERSION = "7.1";
/** Hard cap on continuation pages per list call. */
export const MAX_PAGES = 20;
/** Cap on any `Retry-After` wait (research §3.10: delays reach 30 s). */
export const MAX_RETRY_AFTER_MS = 30_000;
/** The wait before the single 429 retry when the answer carries no `Retry-After`. */
export const RETRY_WITHOUT_HEADER_MS = 1_000;
/** Largest response body read. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** The continuation header (research §3.5 [M]; matched case-insensitively). */
export const CONTINUATION_HEADER = "x-ms-continuationtoken";
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
function sourceError(message) {
    return new EngineError(EXIT.SOURCE, "pipelines", message);
}
function authError(message) {
    return new EngineError(EXIT.AUTH, "pipelines", `Azure DevOps authentication failed — ${message}. This is NOT "no runs" or "not found": check that AZURE_DEVOPS_EXT_PAT is valid, unexpired and has Build (Read) and Code (Read)`);
}
function isJsonType(contentType) {
    return contentType !== null && /^application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType.trim());
}
/** Milliseconds a `Retry-After` value asks for (seconds or an HTTP date), capped; `null` when absent/invalid. */
export function retryAfterMs(value, nowMs) {
    if (value === null || value.trim() === "")
        return null;
    const trimmed = value.trim();
    let ms;
    if (/^\d+(?:\.\d+)?$/.test(trimmed))
        ms = Number(trimmed) * 1000;
    else {
        const date = Date.parse(trimmed);
        if (Number.isNaN(date))
            return null;
        ms = date - nowMs;
    }
    if (!Number.isFinite(ms) || ms < 0)
        return 0;
    return Math.min(ms, MAX_RETRY_AFTER_MS);
}
function asObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function str(value) {
    return typeof value === "string" ? value : null;
}
function int(value) {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function webLink(value) {
    const links = asObject(value["_links"] ?? null);
    const web = links === null ? null : asObject(links["web"] ?? null);
    return web === null ? null : str(web["href"] ?? null);
}
/** Reduces a Pipelines Get / List entry. @throws EngineError 21 on an unexpected shape. */
export function parsePipeline(value, what) {
    const object = asObject(value);
    const id = object === null ? null : int(object["id"] ?? null);
    const name = object === null ? null : str(object["name"] ?? null);
    if (object === null || id === null || name === null)
        throw sourceError(`${what}: unexpected response shape (no id/name)`);
    const configuration = asObject(object["configuration"] ?? null);
    const repo = configuration === null ? null : asObject(configuration["repository"] ?? null);
    const repoId = repo === null ? null : str(repo["id"] ?? null);
    const repoType = repo === null ? null : str(repo["type"] ?? null);
    const repository = repoId !== null && repoId.trim() !== "" && repoType !== null ? { id: repoId, type: repoType } : null;
    return { id, name, folder: str(object["folder"] ?? null), revision: int(object["revision"] ?? null), link: webLink(object), repository };
}
/** Reduces a Build API build. @throws EngineError 21 on an unexpected shape. */
export function parseBuild(value, what) {
    const object = asObject(value);
    const id = object === null ? null : int(object["id"] ?? null);
    const status = object === null ? null : str(object["status"] ?? null);
    if (object === null || id === null || status === null)
        throw sourceError(`${what}: unexpected response shape (no id/status)`);
    let templateParameters = null;
    const raw = asObject(object["templateParameters"] ?? null);
    if (raw !== null) {
        templateParameters = {};
        for (const [key, entry] of Object.entries(raw)) {
            if (typeof entry === "string")
                templateParameters[key] = entry;
            else if ((typeof entry === "number" && Number.isFinite(entry)) || typeof entry === "boolean")
                templateParameters[key] = String(entry);
        }
    }
    const definition = asObject(object["definition"] ?? null);
    const result = str(object["result"] ?? null);
    return {
        id,
        buildNumber: str(object["buildNumber"] ?? null),
        status,
        result: result === "" ? null : result,
        queueTime: str(object["queueTime"] ?? null),
        startTime: str(object["startTime"] ?? null),
        finishTime: str(object["finishTime"] ?? null),
        sourceBranch: str(object["sourceBranch"] ?? null),
        sourceVersion: str(object["sourceVersion"] ?? null),
        templateParameters,
        definitionId: definition === null ? null : int(definition["id"] ?? null),
        reason: str(object["reason"] ?? null),
        link: webLink(object),
    };
}
function listOf(body, key, what) {
    const object = asObject(body);
    const list = object === null ? undefined : object[key];
    if (!Array.isArray(list))
        throw sourceError(`${what}: unexpected response shape (no "${key}" array)`);
    return list;
}
/** Query string with literal keys (`$top` stays `$top`) and encoded values. */
function queryString(query) {
    return Object.entries({ ...query, "api-version": API_VERSION })
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
        .join("&");
}
/**
 * The read-only Azure DevOps client. Construct it only after the PAT preflight passed.
 * Counts every request it sends (all GET by construction) for the report.
 */
export class AzureDevOpsReader {
    #options;
    #base;
    #nextAllowedAt = 0;
    #requests = 0;
    constructor(options) {
        this.#options = options;
        this.#base = options.organizationUrl.replace(/\/+$/, "");
    }
    /** How many requests this client sent (every one a GET). */
    get requestCount() {
        return this.#requests;
    }
    /** The organization URL requests go to (configuration, not a secret). */
    get organizationUrl() {
        return this.#base;
    }
    async #wait() {
        const delay = this.#nextAllowedAt - this.#options.clock();
        if (delay > 0)
            await this.#options.sleep(delay);
    }
    /** The ONLY network call of this module: always GET. */
    async #send(url, what) {
        await this.#wait();
        const signal = AbortSignal.timeout(this.#options.timeoutMs);
        this.#requests++;
        try {
            const response = await fetch(url, {
                method: "GET",
                redirect: "manual",
                signal,
                headers: {
                    Authorization: this.#options.credential.authorization(),
                    Accept: `application/json;api-version=${API_VERSION}`,
                    "X-TFS-FedAuthRedirect": "Suppress",
                    "User-Agent": "release-radar",
                },
            });
            return { response, signal };
        }
        catch (error) {
            // Only the error CODE is described — never a header or the URL's credential (there is none).
            throw sourceError(`${what}: ${describeNoAnswer(error, signal, this.#options.timeoutMs)}`);
        }
    }
    async #readText(response, signal, what) {
        let text;
        try {
            text = await response.text();
        }
        catch (error) {
            throw sourceError(`${what}: the response body could not be read (${describeNoAnswer(error, signal, this.#options.timeoutMs)})`);
        }
        if (text.length > MAX_BODY_BYTES)
            throw sourceError(`${what}: response body larger than ${MAX_BODY_BYTES} bytes`);
        return text;
    }
    /** GET `{base}/{project}/_apis/{path}?{query}`, classified (see the module comment). */
    async #get(project, path, query, what) {
        const url = `${this.#base}/${encodeURIComponent(project)}/_apis/${path}?${queryString(query)}`;
        for (let attempt = 0;; attempt++) {
            const { response, signal } = await this.#send(url, what);
            const status = response.status;
            const after = retryAfterMs(response.headers.get("retry-after"), this.#options.clock());
            if (after !== null && after > 0)
                this.#nextAllowedAt = Math.max(this.#nextAllowedAt, this.#options.clock() + after);
            const contentType = response.headers.get("content-type");
            const json = isJsonType(contentType);
            if (status === 401 || status === 403 || status === 203 || (status >= 300 && status < 400)) {
                await response.body?.cancel();
                const why = status >= 300 && status < 400 ? `HTTP ${status} redirect (to a sign-in page)` : status === 203 ? "HTTP 203 (a sign-in page instead of data)" : `HTTP ${status}`;
                throw authError(`${what}: ${why}`);
            }
            if (status === 429) {
                await response.body?.cancel();
                if (attempt === 0) {
                    await this.#options.sleep(after ?? RETRY_WITHOUT_HEADER_MS);
                    continue;
                }
                throw sourceError(`${what}: rate-blocked by Azure DevOps (HTTP 429, TF400733) after one retry; wait and run again`);
            }
            if (status === 404) {
                if (!json) {
                    await response.body?.cancel();
                    throw authError(`${what}: HTTP 404 without a JSON body (a wrong organization URL or a sign-in page — never read as "not found")`);
                }
                const text = await this.#readText(response, signal, what);
                let message = "not found";
                try {
                    const object = asObject(JSON.parse(text));
                    const value = object === null ? null : str(object["message"] ?? null);
                    if (value !== null && value.trim() !== "")
                        message = value.trim().split("\n")[0] ?? message;
                }
                catch {
                    // a 404 whose JSON body does not parse is still a JSON-typed not-found
                }
                return { kind: "not-found", message };
            }
            if (status < 200 || status > 299) {
                await response.body?.cancel();
                throw sourceError(`${what}: HTTP ${status}`);
            }
            if (status === 204) {
                await response.body?.cancel();
                return { kind: "no-content" };
            }
            if (!json) {
                await response.body?.cancel();
                throw authError(`${what}: HTTP ${status} with a non-JSON body (a sign-in page)`);
            }
            const text = await this.#readText(response, signal, what);
            let body;
            try {
                body = JSON.parse(text);
            }
            catch {
                throw sourceError(`${what}: HTTP ${status} but the body is not valid JSON (never read as "no runs")`);
            }
            return { kind: "json", body, continuation: response.headers.get(CONTINUATION_HEADER) };
        }
    }
    async #getJson(project, path, query, what, notFound) {
        const result = await this.#get(project, path, query, what);
        if (result.kind === "not-found")
            throw new EngineError(EXIT.MISSING, "pipelines", `${notFound} (Azure DevOps: ${result.message})`);
        if (result.kind === "no-content")
            throw sourceError(`${what}: HTTP 204 (no content) where data was expected`);
        return result.body;
    }
    /** Every `value[]` item across continuation pages; stops early once `wanted` items are held. */
    async #pages(project, path, query, what, notFound, wanted) {
        const items = [];
        let token = null;
        for (let page = 1;; page++) {
            const result = await this.#get(project, path, token === null ? query : { ...query, continuationToken: token }, `${what} (page ${page})`);
            if (result.kind === "not-found")
                throw new EngineError(EXIT.MISSING, "pipelines", `${notFound} (Azure DevOps: ${result.message})`);
            if (result.kind === "no-content")
                break;
            items.push(...listOf(result.body, "value", what));
            token = result.continuation === null || result.continuation.trim() === "" ? null : result.continuation.trim();
            if (wanted !== null && items.length >= wanted)
                return items.slice(0, wanted);
            if (token === null)
                break;
            if (page >= MAX_PAGES)
                throw sourceError(`${what}: more than ${MAX_PAGES} pages — the list is incomplete, so nothing is concluded from it`);
        }
        return wanted === null ? items : items.slice(0, wanted);
    }
    /**
     * Pipelines Get: proves the pipeline exists and identifies it (spec 66; D7 — it carries no
     * declared parameters). @throws EngineError 23 when it does not exist (404 JSON), 20, 21.
     */
    async getPipeline(project, id) {
        const what = `GET pipeline ${id} in project "${project}"`;
        return parsePipeline(await this.#getJson(project, `pipelines/${id}`, {}, what, `pipeline ${id} does not exist in project "${project}"`), what);
    }
    /** Every pipeline of the project named exactly `name` (Pipelines List, paged; 0, 1 or several). */
    async findPipelinesByName(project, name) {
        const what = `GET pipelines of project "${project}"`;
        const all = await this.#pages(project, "pipelines", { $top: 1000 }, what, `project "${project}" does not exist`, null);
        return all.map((entry) => parsePipeline(entry, what)).filter((pipeline) => pipeline.name === name);
    }
    /**
     * The latest `top` builds of a definition, newest first (Build list: commit, times and
     * parameters in one call — plan D8). For a YAML pipeline the build definition id is the
     * pipeline id (research §3.3 [M]).
     */
    async listBuilds(project, definitionId, top) {
        const what = `GET builds of pipeline ${definitionId} in project "${project}"`;
        const items = await this.#pages(project, "build/builds", { definitions: definitionId, $top: top, queryOrder: "queueTimeDescending" }, what, `project "${project}" or pipeline ${definitionId} does not exist`, top);
        return items.map((item) => parseBuild(item, what));
    }
    /** One build (the result of record — it carries `partiallySucceeded`; D8). @throws EngineError 23 when absent. */
    async getBuild(project, id) {
        const what = `GET run ${id} in project "${project}"`;
        return parseBuild(await this.#getJson(project, `build/builds/${id}`, {}, what, `run ${id} does not exist in project "${project}"`), what);
    }
    /** A build's timeline records (checkpoint waits — research §3.8 [M]); `[]` when it has none yet. */
    async getBuildTimeline(project, id) {
        const what = `GET timeline of run ${id} in project "${project}"`;
        const result = await this.#get(project, `build/builds/${id}/timeline`, {}, what);
        if (result.kind === "not-found")
            throw new EngineError(EXIT.MISSING, "pipelines", `run ${id} does not exist in project "${project}" (Azure DevOps: ${result.message})`);
        if (result.kind === "no-content" || result.body === null)
            return [];
        const records = listOf(result.body, "records", what);
        return records.flatMap((record) => {
            const object = asObject(record);
            if (object === null)
                return [];
            const id = str(object["id"] ?? null);
            const type = str(object["type"] ?? null);
            if (id === null || type === null)
                return [];
            return [{ id, parentId: str(object["parentId"] ?? null), type, name: str(object["name"] ?? null) ?? type, state: str(object["state"] ?? null), result: str(object["result"] ?? null) }];
        });
    }
    /**
     * Pending approvals of the project (Approvals Query, `$expand=steps`), narrowed to `ids` when
     * given (both server-side via `approvalIds` and client-side). Approver display names only.
     */
    async listPendingApprovals(project, ids) {
        const what = `GET pending approvals of project "${project}"`;
        const query = { state: "pending", $expand: "steps" };
        if (ids !== null && ids.length > 0)
            query["approvalIds"] = ids.join(",");
        const items = await this.#pages(project, "pipelines/approvals", query, what, `project "${project}" does not exist`, null);
        const approvals = [];
        for (const item of items) {
            const object = asObject(item);
            const id = object === null ? null : str(object["id"] ?? null);
            if (object === null || id === null)
                continue;
            if (ids !== null && !ids.includes(id))
                continue;
            const steps = Array.isArray(object["steps"]) ? object["steps"] : [];
            const approvers = [];
            for (const step of steps) {
                const stepObject = asObject(step);
                const approver = stepObject === null ? null : asObject(stepObject["assignedApprover"] ?? null);
                const name = approver === null ? null : str(approver["displayName"] ?? null);
                if (name !== null && name.trim() !== "" && !approvers.includes(name))
                    approvers.push(name);
            }
            approvals.push({ id, status: str(object["status"] ?? null) ?? "pending", approvers, minRequiredApprovers: int(object["minRequiredApprovers"] ?? null) });
        }
        return approvals;
    }
    /**
     * The commit a Git ref points at (Git Refs, `filter=heads/...`; plan D2 — Phase 7's remote-head
     * check). A tag ref is read with `peelTags=true` and an annotated tag resolves to its
     * `peeledObjectId` (the commit), never the tag object. `null` when the repository has no such
     * ref. @throws EngineError 23 when the repository does not exist, 20, 21.
     */
    async getRefHead(project, repository, refName) {
        const what = `GET ref ${refName} of repository "${repository}"`;
        const filter = refName.replace(/^refs\//, "");
        const tag = refName.startsWith("refs/tags/");
        const query = tag ? { filter, peelTags: "true" } : { filter };
        const items = await this.#pages(project, `git/repositories/${encodeURIComponent(repository)}/refs`, query, what, `repository "${repository}" does not exist in project "${project}"`, null);
        for (const item of items) {
            const object = asObject(item);
            if (object === null || str(object["name"] ?? null) !== refName)
                continue;
            const peeled = tag ? str(object["peeledObjectId"] ?? null) : null;
            const objectId = peeled !== null && peeled.trim() !== "" ? peeled : str(object["objectId"] ?? null);
            if (objectId === null || !COMMIT.test(objectId))
                throw sourceError(`${what}: the ref has no commit object id`);
            return { name: refName, objectId: objectId.toLowerCase() };
        }
        return null;
    }
}
