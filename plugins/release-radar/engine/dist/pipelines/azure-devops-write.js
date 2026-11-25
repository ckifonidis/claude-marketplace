/**
 * Azure DevOps REST — the ONE write (spec requirements 66, 69, 72; plan D8, D9; research §3.2,
 * §3.3, §3.9, §3.10).
 *
 * ## The mutation boundary
 * This is the only engine module that can send a request other than GET to Azure DevOps. It
 * exports exactly one function, {@link queueRun}, which sends exactly ONE
 * `POST {organizationUrl}/{project}/_apis/pipelines/{id}/runs?api-version=7.1` and never retries.
 * Only the `run-pipeline` command module imports it (a test scans the compiled `dist/` for every
 * non-GET method literal and every importer of this module), and `cli.ts` loads that command
 * module only when the `run-pipeline` command is dispatched.
 *
 * ## Body (D8)
 * `{ resources: { repositories: { self: { refName, version: <commit> } } }, templateParameters }`
 * — exactly what the preview showed; this module adds nothing.
 *
 * ## Outcomes — never thrown, always returned, so the caller can report the run id
 * - `queued`: a 2xx JSON answer with an integer `id` (the run id = build id [M]); the echoed
 *   `resources.repositories.self.version` is returned for the pin check (D8).
 * - `rejected` (the server answered and no run was created): 401/403/203/3xx or a 2xx/404 without
 *   JSON → 20 (403 = the PAT lacks Build (Read & execute)); 404 JSON → 23 (the pipeline does not
 *   exist); 429 → 21 (rate-blocked; NOT retried); any other 4xx (e.g. 400, a parameter the
 *   pipeline does not declare) → 21.
 * - `unknown` (D9): no answer (timeout, connection reset, DNS), a 5xx, or a 2xx whose body does
 *   not parse or carries no run id. The run MAY exist. The caller lists runs read-only to detect
 *   it and never re-POSTs.
 *
 * The `Authorization` header value never appears in any outcome or message.
 */
import { describeNoAnswer } from "../verify.js";
import { API_VERSION } from "./azure-devops-read.js";
/** The HTTP method of the queue request — the only non-GET method literal in the engine. */
export const QUEUE_METHOD = "POST";
/** Largest response body read from the queue answer. */
export const MAX_QUEUE_BODY_BYTES = 4 * 1024 * 1024;
function asObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function str(value) {
    return typeof value === "string" ? value : null;
}
function isJsonType(contentType) {
    return contentType !== null && /^application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType.trim());
}
/** The first line of a JSON error answer's `message`, capped (parameter names may appear; never a credential). */
function serverMessage(text) {
    try {
        const object = asObject(JSON.parse(text));
        const message = object === null ? null : str(object["message"]);
        if (message !== null && message.trim() !== "") {
            const line = message.trim().split("\n")[0] ?? "";
            return `: ${line.length > 300 ? `${line.slice(0, 299)}…` : line}`;
        }
    }
    catch {
        // not JSON: no message
    }
    return "";
}
/**
 * Sends the single queue request. Never retries, never throws for a network or HTTP outcome.
 * @returns the classified outcome (see the module comment).
 */
export async function queueRun(request) {
    const url = `${request.organizationUrl.replace(/\/+$/, "")}/${encodeURIComponent(request.project)}/_apis/pipelines/${request.pipelineId}/runs?api-version=${API_VERSION}`;
    const signal = AbortSignal.timeout(request.timeoutMs);
    let response;
    try {
        response = await fetch(url, {
            method: QUEUE_METHOD,
            redirect: "manual",
            signal,
            headers: {
                Authorization: request.credential.authorization(),
                Accept: `application/json;api-version=${API_VERSION}`,
                "Content-Type": "application/json",
                "X-TFS-FedAuthRedirect": "Suppress",
                "User-Agent": "release-radar",
            },
            body: JSON.stringify(request.body),
        });
    }
    catch (error) {
        return { status: "unknown", httpStatus: null, detail: `the queue request got no answer: ${describeNoAnswer(error, signal, request.timeoutMs)}` };
    }
    const status = response.status;
    const json = isJsonType(response.headers.get("content-type"));
    let text = "";
    try {
        text = await response.text();
    }
    catch (error) {
        if (status >= 200 && status <= 299)
            return { status: "unknown", httpStatus: status, detail: `HTTP ${status}, but the answer could not be read (${describeNoAnswer(error, signal, request.timeoutMs)})` };
    }
    if (status === 401 || status === 403 || status === 203 || (status >= 300 && status < 400)) {
        const why = status === 403 ? "HTTP 403 — the PAT is not allowed to queue runs (it needs Build (Read & execute))" : status === 203 ? "HTTP 203 (a sign-in page)" : status >= 300 && status < 400 ? `HTTP ${status} redirect (to a sign-in page)` : `HTTP ${status}`;
        return { status: "rejected", exitCode: 20, httpStatus: status, detail: `Azure DevOps authentication failed — ${why}; no run was created` };
    }
    if (status === 404) {
        if (!json)
            return { status: "rejected", exitCode: 20, httpStatus: status, detail: "HTTP 404 without a JSON body (a wrong organization URL or a sign-in page); no run was created" };
        return { status: "rejected", exitCode: 23, httpStatus: status, detail: `HTTP 404 — pipeline ${request.pipelineId} does not exist in project "${request.project}"${serverMessage(text)}; no run was created` };
    }
    if (status === 429)
        return { status: "rejected", exitCode: 21, httpStatus: status, detail: "HTTP 429 — rate-blocked by Azure DevOps (TF400733); no run was created and the request is NEVER retried: preview and confirm again later" };
    if (status >= 400 && status <= 499)
        return { status: "rejected", exitCode: 21, httpStatus: status, detail: `HTTP ${status} — Azure DevOps refused the request${serverMessage(text)}; no run was created` };
    if (status >= 500)
        return { status: "unknown", httpStatus: status, detail: `HTTP ${status} — a server error after the request was sent; a run may or may not have been created` };
    if (status < 200 || status > 299)
        return { status: "unknown", httpStatus: status, detail: `unexpected HTTP ${status}` };
    if (!json)
        return { status: "rejected", exitCode: 20, httpStatus: status, detail: `HTTP ${status} with a non-JSON body (a sign-in page); no run was created` };
    if (text.length > MAX_QUEUE_BODY_BYTES)
        return { status: "unknown", httpStatus: status, detail: `HTTP ${status}, but the answer is larger than ${MAX_QUEUE_BODY_BYTES} bytes` };
    let body;
    try {
        body = asObject(JSON.parse(text));
    }
    catch {
        return { status: "unknown", httpStatus: status, detail: `HTTP ${status}, but the body is not valid JSON` };
    }
    const runId = body === null ? null : body["id"];
    if (body === null || typeof runId !== "number" || !Number.isSafeInteger(runId) || runId <= 0) {
        return { status: "unknown", httpStatus: status, detail: `HTTP ${status}, but the answer carries no run id` };
    }
    const resources = asObject(body["resources"] ?? null);
    const repositories = resources === null ? null : asObject(resources["repositories"] ?? null);
    const self = repositories === null ? null : asObject(repositories["self"] ?? null);
    const links = asObject(body["_links"] ?? null);
    const web = links === null ? null : asObject(links["web"] ?? null);
    return {
        status: "queued",
        httpStatus: status,
        runId,
        name: str(body["name"] ?? null),
        state: str(body["state"] ?? null),
        echoedVersion: self === null ? null : str(self["version"] ?? null),
        echoedRef: self === null ? null : str(self["refName"] ?? null),
        link: web === null ? null : str(web["href"] ?? null),
    };
}
