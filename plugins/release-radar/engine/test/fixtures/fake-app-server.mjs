// Fake HTTP APPLICATION server for the verification tests (spec requirements 75, 76, 77).
//
// Bound to 127.0.0.1 on a random port; nothing else is ever contacted. Every request is recorded
// BEFORE it is answered: { method, path, headerNames (lower-case, sorted), headers }. The full
// header map stays in the test process memory only so a test can prove an env-var header value
// arrived; it is never written anywhere.
//
// A route answers `{ status, json?, text?, headers?, delayMs?, reset? }`:
// - `json` / `text`: the body (JSON with content-type application/json, or text/plain);
// - `delayMs`: wait before answering (drives timeouts);
// - `reset: true`: destroy the socket without an HTTP answer (connection reset).
// An unknown path answers 404 `{"error":"no route"}`. All data is synthetic.

import { createServer } from "node:http";

/**
 * Starts the server and registers its shutdown with `t.after`.
 * @param routes `{ "<path>": route }` — matched on the path without the query string.
 */
export async function startApp(t, routes = {}) {
  const requests = [];
  const table = new Map(Object.entries(routes));
  const timers = new Set();
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    requests.push({ method: req.method, path, headerNames: Object.keys(req.headers).sort(), headers: { ...req.headers } });
    const route = table.get(path) ?? { status: 404, json: { error: "no route" } };
    const answer = () => {
      timers.delete(timer);
      if (route.reset) {
        req.socket.destroy();
        return;
      }
      const headers = { ...(route.headers ?? {}) };
      let body = "";
      if (route.json !== undefined) {
        body = JSON.stringify(route.json);
        headers["content-type"] = "application/json";
      } else if (route.text !== undefined) {
        body = route.text;
        headers["content-type"] = "text/plain";
      }
      res.writeHead(route.status ?? 200, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const timer = setTimeout(answer, route.delayMs ?? 0);
    timers.add(timer);
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
    requests,
    /** `http://127.0.0.1:<port><path>`. */
    url: (path) => `http://127.0.0.1:${port}${path}`,
    /** Replaces (or adds) one route. */
    route: (path, value) => table.set(path, value),
    close,
  };
}

/** A port on 127.0.0.1 that refuses connections (bound once, then released). */
export async function refusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Asserts every request the server received was GET or HEAD (spec requirements 15, 71). */
export function assertOnlyReadMethods(assert, app) {
  for (const request of app.requests) assert.ok(["GET", "HEAD"].includes(request.method), `non-GET/HEAD request to the application: ${request.method} ${request.path}`);
}
