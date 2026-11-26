// compose adapter (spec requirement 27). Fixture shapes model research §6 (`docker compose ps
// --format json` NDJSON and array forms, `docker inspect`, `docker image inspect`; MODELLED); all
// data synthetic. Never `up`, `pull` or `restart` — asserted from the argv log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposeAdapter, discoverCompose, matchRepoDigest, parseComposePs } from "../dist/adapters/compose.js";
import { parseImage } from "../dist/image.js";
import { READ_ONLY, assertReadOnly, digestOf, rejectsWith, shimHarness } from "./fixtures/cli-shims.mjs";

const SETTINGS = { timeoutSeconds: 10 };
const TARGET = { name: "api", adapter: "compose", project: "acme", service: "api" };
const req = (target = TARGET) => ({ key: `acme-api/stage-1/${target.name}`, stage: "stage-1", target });
const API = "registry.example.com/acme/api:3f2a9c1";
const WORKER = "registry.example.com/acme/worker:3f2a9c1";

const PS_ROWS = [
  { ID: "c0ffee000001", Name: "acme-api-1", Service: "api", Image: API, State: "running", Status: "Up 3 hours (healthy)", Health: "healthy", ExitCode: 0 },
  { ID: "c0ffee000002", Name: "acme-worker-1", Service: "worker", Image: WORKER, State: "exited", Status: "Exited (1) 2 minutes ago", Health: "", ExitCode: 1 },
];
const ndjson = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function inspect(id, { image = API, imageId = `sha256:${"1".repeat(64)}`, status = "running", created = "2026-11-12T08:00:10.123456789Z" } = {}) {
  return {
    Id: `${id}${"0".repeat(52)}`,
    Created: created,
    Image: imageId,
    Config: { Image: image },
    State: { Status: status, Running: status === "running", StartedAt: "2026-11-12T08:00:30Z", Health: { Status: "healthy" } },
  };
}

function install(h, { ps = ndjson(PS_ROWS), containers = [inspect("c0ffee000001")], images = [{ Id: `sha256:${"1".repeat(64)}`, RepoTags: [API], RepoDigests: [`registry.example.com/acme/api@${digestOf("a")}`] }], extra = [] } = {}) {
  h.install("docker", [
    ...extra,
    { match: ["version", "--format"], stdout: "27.3.1\n" },
    { match: ["compose", "version"], stdout: "Docker Compose version v2.29.7\n" },
    { match: ["compose", "--project-name", "acme", "ps", "--all", "--format", "json"], stdout: ps },
    { match: ["container", "inspect"], stdout: containers },
    { match: ["image", "inspect"], stdout: images },
  ]);
}

const done = (h) => {
  assertReadOnly(assert, h.calls(), READ_ONLY.docker);
  for (const call of h.calls()) assert.equal(call.env.LC_ALL, "C");
};

test("27: ps output parses in both shapes (NDJSON and one JSON array) and empty output is empty", () => {
  assert.deepEqual(parseComposePs(ndjson(PS_ROWS)).map((r) => r.service), ["api", "worker"]);
  assert.deepEqual(parseComposePs(JSON.stringify(PS_ROWS)).map((r) => r.service), ["api", "worker"]);
  assert.deepEqual(parseComposePs(JSON.stringify(PS_ROWS[0])).map((r) => r.id), ["c0ffee000001"], "a single NDJSON line");
  assert.deepEqual(parseComposePs(""), []);
  assert.deepEqual(parseComposePs("[]"), []);
  assert.equal(parseComposePs(ndjson(PS_ROWS))[1].health, null, "empty Health is no health");
  assert.throws(() => parseComposePs('{"ID":"x","Service":"a"}\nnot json\n'), (e) => e.exitCode === 21);
});

test("27: RepoDigests are matched to the reference's repository only", () => {
  const ref = parseImage(API);
  const digests = [`registry.example.com/acme/other@${digestOf("b")}`, `registry.example.com/acme/api@${digestOf("a")}`];
  assert.equal(matchRepoDigest(digests, ref), digestOf("a"));
  assert.equal(matchRepoDigest([`registry.example.com/acme/other@${digestOf("b")}`], ref), null);
  assert.equal(matchRepoDigest([], ref), null);
});

test("27: preflight checks the daemon and the Compose v2 plugin", async (t) => {
  const h = shimHarness(t);
  install(h);
  const result = await createComposeAdapter(SETTINGS, h.runtime).preflight([req()]);
  assert.deepEqual(result.commands, ["docker version --format {{.Server.Version}}", "docker compose version"]);
  done(h);
});

test("27: normal read (NDJSON) — configured image, image id, registry digest, state, created time", async (t) => {
  const h = shimHarness(t);
  install(h);
  const [reading] = await createComposeAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.status, "found");
  assert.equal(reading.image.raw, API);
  assert.equal(reading.imageId, `sha256:${"1".repeat(64)}`);
  assert.equal(reading.digest, digestOf("a"));
  assert.equal(reading.digestStatus, "available");
  assert.equal(reading.state, "running");
  assert.equal(reading.lastModified, "2026-11-12T08:00:10.123Z");
  assert.equal(reading.lastModifiedSource, "container Created");
  assert.equal(reading.details.health, "healthy");
  assert.equal(reading.details.startedAt, "2026-11-12T08:00:30Z");
  assert.deepEqual(
    h.calls().map((c) => c.args),
    [
      ["compose", "--project-name", "acme", "ps", "--all", "--format", "json"],
      ["container", "inspect", "c0ffee000001"],
      ["image", "inspect", `sha256:${"1".repeat(64)}`],
    ],
  );
  done(h);
});

test("27: the older array-shaped ps output reads identically; one ps per project", async (t) => {
  const h = shimHarness(t);
  install(h, {
    ps: JSON.stringify(PS_ROWS),
    containers: [inspect("c0ffee000001"), inspect("c0ffee000002", { image: WORKER, imageId: `sha256:${"2".repeat(64)}`, status: "exited" })],
    images: [
      { Id: `sha256:${"1".repeat(64)}`, RepoDigests: [`registry.example.com/acme/api@${digestOf("a")}`] },
      { Id: `sha256:${"2".repeat(64)}`, RepoDigests: [`registry.example.com/acme/worker@${digestOf("b")}`] },
    ],
  });
  const readings = await createComposeAdapter(SETTINGS, h.runtime).read([req(), req({ ...TARGET, name: "worker", service: "worker" })]);
  assert.equal(readings[0].digest, digestOf("a"));
  assert.equal(readings[1].image.raw, WORKER);
  assert.equal(readings[1].state, "exited");
  assert.match(readings[1].notes.join("\n"), /state exited/);
  assert.equal(h.calls().filter((c) => c.args.includes("ps")).length, 1);
  done(h);
});

test("27: a never-pushed local image has no RepoDigests → digest unavailable, image id kept", async (t) => {
  const h = shimHarness(t);
  install(h, { containers: [inspect("c0ffee000001", { image: "acme/api:dev" })], images: [{ Id: `sha256:${"1".repeat(64)}`, RepoTags: ["acme/api:dev"], RepoDigests: [] }] });
  const [reading] = await createComposeAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.digest, null);
  assert.equal(reading.digestStatus, "unavailable");
  assert.equal(reading.imageId, `sha256:${"1".repeat(64)}`);
  assert.match(reading.notes.join("\n"), /never pushed/);
  done(h);
});

test("27: a scaled service with containers on different images is mixed", async (t) => {
  const h = shimHarness(t);
  const rows = [PS_ROWS[0], { ...PS_ROWS[0], ID: "c0ffee000003", Name: "acme-api-2", Image: "registry.example.com/acme/api:old" }];
  install(h, {
    ps: ndjson(rows),
    containers: [inspect("c0ffee000001"), inspect("c0ffee000003", { image: "registry.example.com/acme/api:old", imageId: `sha256:${"3".repeat(64)}` })],
    images: [{ Id: `sha256:${"1".repeat(64)}`, RepoDigests: [] }, { Id: `sha256:${"3".repeat(64)}`, RepoDigests: [] }],
  });
  const [reading] = await createComposeAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.mixed, true);
  assert.equal(reading.digest, null);
  assert.equal(reading.imageId, null);
  assert.match(reading.notes.join("\n"), /acme-api-1 .*3f2a9c1.*acme-api-2 .*old/);
  done(h);
});

test("21/27: an unknown project (empty ps, exit 0) and an absent service are `missing`", async (t) => {
  const h = shimHarness(t);
  install(h, { ps: "" });
  const [empty] = await createComposeAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(empty.status, "missing");

  const h2 = shimHarness(t);
  install(h2);
  const [absent] = await createComposeAdapter(SETTINGS, h2.runtime).read([req({ ...TARGET, service: "scheduler" })]);
  assert.equal(absent.status, "missing");
  assert.match(absent.notes[0], /no container for service "scheduler" in compose project "acme"/);
  assert.equal(h2.calls().filter((c) => c.args.includes("inspect")).length, 0);
  done(h);
  done(h2);
});

test("20: the daemon being down is auth/preflight (20), never missing", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["version"], stdout: "Client: 27.3.1\n", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n", exit: 1 }] });
  const error = await rejectsWith(assert, createComposeAdapter(SETTINGS, h.runtime).preflight([req()]), { exitCode: 20, name: "AuthError" });
  assert.match(error.hint, /start the Docker daemon/);
  done(h);
});

test("20: daemon down during ps is 20 as well (not an empty project)", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["ps"], stderr: "error during connect: Get \"http://docker.example/v1.47/containers/json\": EOF\n", exit: 1 }] });
  await rejectsWith(assert, createComposeAdapter(SETTINGS, h.runtime).read([req()]), { exitCode: 20 });
  done(h);
});

test("20: a missing Compose plugin is a capability failure naming docker compose", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["compose", "version"], stderr: "docker: 'compose' is not a docker command.\nSee 'docker --help'\n", exit: 1 }] });
  const error = await rejectsWith(assert, createComposeAdapter(SETTINGS, h.runtime).preflight([req()]), { exitCode: 20 });
  assert.equal(error.kind, "capability-missing");
  assert.match(error.hint, /Compose v2 plugin/);
  done(h);
});

test("20: docker missing is AuthError naming `docker`", async (t) => {
  const h = shimHarness(t);
  const error = await rejectsWith(assert, createComposeAdapter(SETTINGS, h.missingRuntime).preflight([req()]), { exitCode: 20, message: /`docker` is not found on PATH/ });
  assert.equal(error.binary, "docker");
});

test("21: an unknown docker error is SourceError (21)", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["container", "inspect"], stderr: "unexpected EOF\n", exit: 1 }] });
  await rejectsWith(assert, createComposeAdapter(SETTINGS, h.runtime).read([req()]), { exitCode: 21, name: "SourceError" });
  done(h);
});

test("discover lists projects (compose ls) and their services; a given project skips ls", async (t) => {
  const h = shimHarness(t);
  h.install("docker", [
    { match: ["compose", "ls"], stdout: [{ Name: "acme", Status: "running(1), exited(1)", ConfigFiles: "/srv/acme/compose.yaml" }] },
    { match: ["compose", "--project-name", "acme", "ps"], stdout: ndjson(PS_ROWS) },
  ]);
  const all = await discoverCompose(SETTINGS, h.runtime, {});
  assert.deepEqual(all.map((c) => c.fields), [{ project: "acme", service: "api" }, { project: "acme", service: "worker" }]);
  assert.equal(all[0].image, API);
  const before = h.calls().length;
  await discoverCompose(SETTINGS, h.runtime, { project: "acme" });
  assert.equal(h.calls().slice(before).filter((c) => c.args.includes("ls")).length, 0);
  done(h);
});
