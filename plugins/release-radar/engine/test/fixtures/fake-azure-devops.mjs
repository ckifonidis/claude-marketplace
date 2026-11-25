// Fake Azure DevOps REST server (spec requirements 75-77; research §5). Bound to 127.0.0.1 on a
// random port; no real organisation is ever contacted. All names and data are synthetic
// (organisation `acme-org`, project `acme-project`, pipeline ids like 101).
//
// Every request is recorded BEFORE it is answered: { method, path, query (URLSearchParams
// entries), auth: Authorization header present, authOk: it decodes to the expected PAT, body:
// the parsed JSON body of a non-GET (else null) }. The header VALUE is never stored.
//
// Routes (under /<org>/<project>/_apis/):
//   GET pipelines                       Pipelines List (paged by `pageSize`)
//   GET pipelines/approvals             Approvals Query (state=pending, approvalIds filter)
//   GET pipelines/{id}                  Pipelines Get
//   GET pipelines/{id}/runs[/{rid}]     Runs List / Get (Phase 7 needs them; not used by reads)
//   POST pipelines/{id}/runs            Runs API queue (Phase 7): the body is recorded; with
//                                       `state.post.create` (default true) a build is created AT
//                                       ONCE — before any failure mode applies, so "slow"/"500"/
//                                       "reset" model an unknown outcome whose run exists — with
//                                       id `state.post.nextRunId++` (default 900); the answer echoes
//                                       `resources.repositories.self.version` per `state.post.echo`
//                                       ("pinned" = the requested commit, null = omitted, or a sha)
//   GET build/builds                    Build list (definitions, $top, queryOrder, continuationToken)
//   GET build/builds/{id}               Build get (a per-build answer sequence drives --follow)
//   GET build/builds/{id}/timeline      Build timeline
//   GET git/repositories/{repo}/refs    Git Refs (filter prefix)
// A wrong or missing PAT gets the 203 HTML sign-in page (research §5).
//
// Failure modes for any route (`fail(pattern, mode, { times, retryAfter })`):
//   "401", "403", "203-html", "200-html", "302", "404-json", "404-html", "429", "500",
//   "slow" (answers normally after `slowMs`), "invalid-json", "reset" (the connection is destroyed
//   without an answer — a network error).
// Pipelines may carry `repository: { id, type }`, answered as Pipelines Get `configuration.repository`.

import { createServer } from "node:http";

/** The synthetic PAT the fake accepts. Never a real token. */
export const PAT = "rr-pat-synthetic-0f3e9a7c1d5b2e84";
export const ORG = "acme-org";
export const PROJECT = "acme-project";

const SIGN_IN_PAGE = "<!DOCTYPE html><html><head><title>Sign in to your account</title></head><body>Sign in</body></html>";

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8; api-version=7.1", ...headers });
  res.end(JSON.stringify(value));
}

function html(res, status, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(SIGN_IN_PAGE);
}

/** `2026-11-20T10:00:<id % 60>Z`-ish times that sort by id (newest = highest id). */
export function timeOf(id, offsetSeconds = 0) {
  return new Date(Date.UTC(2026, 10, 20, 10, 0, 0) + id * 60_000 + offsetSeconds * 1000).toISOString();
}

/**
 * A Build-API build. `params` = templateParameters (omit for a CI-triggered run).
 * `status` "completed" gets a result (default succeeded); other statuses get none.
 */
export function build({ id, definition = 101, status = "completed", result, commit, branch = "refs/heads/main", params, reason = params === undefined ? "individualCI" : "manual" }) {
  const finished = status === "completed";
  return {
    id,
    buildNumber: `20261120.${id}`,
    status,
    ...(finished ? { result: result ?? "succeeded" } : {}),
    queueTime: timeOf(id),
    startTime: timeOf(id, 5),
    ...(finished ? { finishTime: timeOf(id, 50) } : {}),
    sourceBranch: branch,
    ...(commit === undefined ? {} : { sourceVersion: commit }),
    ...(params === undefined ? {} : { templateParameters: params }),
    definition: { id: definition, name: `pipeline-${definition}` },
    reason,
    _links: { web: { href: `https://dev.azure.example/${ORG}/${PROJECT}/_build/results?buildId=${id}` } },
  };
}

/**
 * Starts the fake and registers its shutdown with `t.after`.
 * @param options.pipelines [{ id, name, folder? }]
 * @param options.builds    [build(...)] newest first (any definition)
 */
export async function startAzureDevOps(t, { pipelines = [{ id: 101, name: "acme-api-ci", folder: "\\acme" }], builds = [], pageSize = null, slowMs = 3000 } = {}) {
  const requests = [];
  const state = {
    pipelines: [...pipelines],
    builds: [...builds],
    /** build id → array of build objects answered in turn by GET build/builds/{id} (last one repeats). */
    sequences: new Map(),
    /** build id → timeline records. */
    timelines: new Map(),
    approvals: [],
    /** repository → [{ name, objectId, peeledObjectId? }]. */
    refs: new Map(),
    /** POST behaviour (see the header). */
    post: { create: true, echo: "pinned", nextRunId: 900, status: "inProgress" },
    /** Called with each authenticated request's record before it is answered (tests mutate state here). */
    onRequest: null,
    failures: [],
    pageSize,
  };
  const timers = new Set();
  const expected = `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`;
  const prefix = `/${ORG}/${PROJECT}/_apis/`;

  function page(res, items, query) {
    const size = state.pageSize ?? items.length;
    const offset = Number(query.get("continuationToken") ?? "0");
    const slice = items.slice(offset, offset + Math.max(size, 1));
    const next = offset + slice.length;
    const headers = next < items.length ? { "x-ms-continuationtoken": String(next) } : {};
    json(res, 200, { count: slice.length, value: slice }, headers);
  }

  /** Creates the build a queue request starts (the run id = the build id). */
  function createRun(definition, body) {
    const self = body?.resources?.repositories?.self ?? {};
    const echo = state.post.echo === "pinned" ? (self.version ?? null) : state.post.echo;
    const id = state.post.nextRunId++;
    const now = new Date().toISOString();
    const created = {
      id,
      buildNumber: `20261125.${id}`,
      status: state.post.status,
      queueTime: now,
      startTime: now,
      sourceBranch: self.refName ?? null,
      sourceVersion: echo ?? self.version ?? null,
      templateParameters: body?.templateParameters ?? {},
      definition: { id: definition, name: `pipeline-${definition}` },
      reason: "manual",
      _links: { web: { href: `https://dev.azure.example/${ORG}/${PROJECT}/_build/results?buildId=${id}` } },
    };
    state.builds.unshift(created);
    return { build: created, echo };
  }

  function route(req, res, path, query) {
    if (!path.startsWith(prefix)) return json(res, 404, { message: "TF200016: The following project does not exist", typeKey: "ProjectDoesNotExistException" });
    const rest = path.slice(prefix.length);
    let m;
    if (req.method === "POST" && (m = /^pipelines\/(\d+)\/runs$/.exec(rest))) {
      const created = req.created;
      if (created === undefined || created === null) return json(res, 400, { message: "VS402881: the fake was told not to create this run", typeKey: "PipelineValidationException" });
      const self = { refName: created.build.sourceBranch, ...(created.echo === null ? {} : { version: created.echo }), repository: { type: "azureReposGit" } };
      return json(res, 200, {
        id: created.build.id,
        name: created.build.buildNumber,
        state: "inProgress",
        pipeline: { id: Number(m[1]), name: `pipeline-${m[1]}` },
        resources: { repositories: { self } },
        templateParameters: created.build.templateParameters,
        createdDate: created.build.queueTime,
        _links: { web: { href: created.build._links.web.href } },
      });
    }
    if (req.method !== "GET") return json(res, 405, { message: "method not allowed" });
    if (rest === "pipelines") return page(res, state.pipelines.map((p) => ({ id: p.id, name: p.name, folder: p.folder ?? "\\", revision: 1 })), query);
    if (rest === "pipelines/approvals") {
      const ids = query.get("approvalIds")?.split(",") ?? null;
      const list = state.approvals.filter((a) => (query.get("state") === null || a.status === query.get("state")) && (ids === null || ids.includes(a.id)));
      return json(res, 200, { count: list.length, value: list });
    }
    if ((m = /^pipelines\/(\d+)$/.exec(rest))) {
      const p = state.pipelines.find((candidate) => candidate.id === Number(m[1]));
      if (p === undefined) return json(res, 404, { $id: "1", message: `Pipeline with id ${m[1]} not found.`, typeKey: "PipelineNotFoundException" });
      return json(res, 200, { id: p.id, name: p.name, folder: p.folder ?? "\\", revision: 3, url: `https://dev.azure.example/${ORG}/${PROJECT}/_apis/pipelines/${p.id}`, _links: { web: { href: `https://dev.azure.example/${ORG}/${PROJECT}/_build/definition?definitionId=${p.id}` } }, configuration: { type: "yaml", ...(p.repository === undefined ? {} : { repository: p.repository }) } });
    }
    if (rest === "build/builds") {
      const definitions = query.get("definitions")?.split(",").map(Number) ?? null;
      const top = query.get("$top") === null ? Infinity : Number(query.get("$top"));
      const list = state.builds.filter((b) => definitions === null || definitions.includes(b.definition.id)).sort((a, b) => (a.queueTime < b.queueTime ? 1 : -1)).slice(0, top);
      return page(res, list, query);
    }
    if ((m = /^build\/builds\/(\d+)\/timeline$/.exec(rest))) {
      const records = state.timelines.get(Number(m[1]));
      if (records === undefined) return json(res, 200, { records: [] });
      return json(res, 200, { records });
    }
    if ((m = /^build\/builds\/(\d+)$/.exec(rest))) {
      const id = Number(m[1]);
      const sequence = state.sequences.get(id);
      if (sequence !== undefined && sequence.length > 0) return json(res, 200, sequence.length > 1 ? sequence.shift() : sequence[0]);
      const b = state.builds.find((candidate) => candidate.id === id);
      if (b === undefined) return json(res, 404, { $id: "1", message: `TF215016: The requested build ${id} could not be found.`, typeKey: "BuildNotFoundException" });
      return json(res, 200, b);
    }
    if ((m = /^git\/repositories\/([^/]+)\/refs$/.exec(rest))) {
      const refs = state.refs.get(decodeURIComponent(m[1]));
      if (refs === undefined) return json(res, 404, { message: "TF401019: The Git repository does not exist", typeKey: "GitRepositoryNotFoundException" });
      const filter = `refs/${query.get("filter") ?? ""}`;
      const list = refs.filter((ref) => ref.name.startsWith(filter));
      return json(res, 200, { count: list.length, value: list });
    }
    return json(res, 404, { message: `no route ${rest}`, typeKey: "NoRoute" });
  }

  function failure(res, mode, retryAfter, port) {
    switch (mode) {
      case "401":
        res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Basic realm=\"https://dev.azure.example/\"" });
        return res.end("Unauthorized");
      case "403":
        return json(res, 403, { message: "TF400813: The user is not authorized to access this resource.", typeKey: "UnauthorizedRequestException" });
      case "203-html":
        return html(res, 203);
      case "200-html":
        return html(res, 200);
      case "302":
        res.writeHead(302, { location: `http://127.0.0.1:${port}/login?reason=signin`, "content-type": "text/html" });
        return res.end(SIGN_IN_PAGE);
      case "404-json":
        return json(res, 404, { $id: "1", message: "TF400898: not found", typeKey: "NotFoundException" });
      case "404-html":
        return html(res, 404);
      case "429":
        return json(res, 429, { message: "TF400733: The request has been canceled: Request was blocked due to exceeding usage of resource.", typeKey: "RequestBlockedException" }, retryAfter === null ? {} : { "retry-after": String(retryAfter) });
      case "500":
        return json(res, 500, { message: "VS402371: internal error", typeKey: "InternalServerError" });
      case "reset":
        return res.socket?.destroy();
      case "invalid-json":
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        return res.end('{"count": 2, "value": [ {"id": 1,');
      default:
        throw new Error(`unknown fake mode ${mode}`);
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorization = req.headers.authorization;
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      auth: authorization !== undefined,
      authOk: authorization === expected,
      accept: req.headers.accept ?? null,
      fedAuth: req.headers["x-tfs-fedauthredirect"] ?? null,
    };
    record.body = null;
    requests.push(record);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "GET" && chunks.length > 0) {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          record.body = JSON.parse(text);
        } catch {
          record.body = text;
        }
      }
      answer();
    });
    const answer = () => {
      const index = state.failures.findIndex((f) => f.pattern.test(url.pathname) && f.times > 0);
      const active = index === -1 ? null : state.failures[index];
      if (url.pathname === "/login") return html(res, 200);
      if (record.authOk !== true) return html(res, 203);
      if (typeof state.onRequest === "function") state.onRequest(record);
      const queue = req.method === "POST" ? /\/_apis\/pipelines\/(\d+)\/runs$/.exec(url.pathname) : null;
      if (queue !== null) req.created = state.post.create ? createRun(Number(queue[1]), record.body) : null;
      if (active !== null) active.times--;
      if (active !== null && active.mode === "slow") {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!res.writableEnded && !res.destroyed) route(req, res, url.pathname, url.searchParams);
        }, slowMs);
        timers.add(timer);
        return;
      }
      if (active !== null) return failure(res, active.mode, active.retryAfter, server.address().port);
      return route(req, res, url.pathname, url.searchParams);
    };
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const close = async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(close);
  return {
    port,
    /** The organizationUrl to configure. */
    base: `http://127.0.0.1:${port}/${ORG}`,
    requests,
    state,
    /** Requests per method, e.g. { GET: 3 }. */
    counts() {
      const out = {};
      for (const r of requests) out[r.method] = (out[r.method] ?? 0) + 1;
      return out;
    },
    /** The recorded POST requests (each with its parsed `body`). */
    posts() {
      return requests.filter((r) => r.method === "POST");
    },
    /** Requests whose path ends with `suffix`. */
    hits(suffix) {
      return requests.filter((r) => r.path.endsWith(suffix));
    },
    /** Makes requests whose path matches `pattern` answer `mode` (`times` times; default always). */
    fail(pattern, mode, { times = Infinity, retryAfter = null } = {}) {
      state.failures.push({ pattern, mode, times, retryAfter });
    },
    /** Answers GET build/builds/{id} with each of `answers` in turn (the last one repeats). */
    sequence(id, answers) {
      state.sequences.set(id, [...answers]);
    },
    close,
  };
}

/** Asserts every request the fake received was a GET (spec requirement 76: read-only commands). */
export function assertOnlyGets(assert, ado) {
  for (const r of ado.requests) assert.equal(r.method, "GET", `non-GET request to Azure DevOps: ${r.method} ${r.path}`);
  assert.deepEqual(Object.keys(ado.counts()).filter((method) => method !== "GET"), [], "zero non-GET requests");
}
