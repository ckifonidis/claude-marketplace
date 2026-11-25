// azure-appservice adapter (spec requirement 24; parity with the original engine's App Service
// behaviour, re-expressed synthetically — scan §6.3). A fake `az` sits alone on the child PATH;
// every test asserts from its argv log that only read-only calls were made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAzureAppServiceAdapter, discoverAzureAppService, WEBAPP_LIST_QUERY } from "../dist/adapters/azure-appservice.js";
import { READ_ONLY, SUB, assertReadOnly, digestOf, rejectsWith, shimHarness } from "./fixtures/cli-shims.mjs";

const SETTINGS = {
  timeoutSeconds: 10,
  stageSubscriptions: { "stage-1": [SUB.one], "stage-2": [SUB.two, SUB.three] },
};

const ACCOUNT = { id: SUB.one, name: "acme-subscription", tenantId: "00000000-0000-0000-0000-00000000000a", state: "Enabled", user: { name: "operator@example.com", type: "user" } };

/** A web app in the documented `az webapp list` shape (research §3); the shim applies --query. */
function webapp(name, { rg = "rg-acme-stage1", state = "Running", kind = "app,linux,container", fx = `DOCKER|registry.example.com/acme/api:3f2a9c1`, modified = "2026-11-10T09:12:44.123Z" } = {}) {
  return { name, resourceGroup: rg, state, kind, lastModifiedTimeUtc: modified, siteConfig: { linuxFxVersion: fx, alwaysOn: true } };
}

function install(h, lists, extra = []) {
  h.install("az", [
    ...extra,
    { match: ["account", "show"], stdout: ACCOUNT },
    ...Object.entries(lists).map(([sub, apps]) => ({ match: ["webapp", "list"], flags: { "--subscription": sub }, stdout: apps, query: true })),
  ]);
}

const req = (stage, webappName, name = "api") => ({ key: `acme-api/${stage}/${name}`, stage, target: { name, adapter: "azure-appservice", webapp: webappName } });

function done(t, h) {
  assertReadOnly(assert, h.calls(), READ_ONLY.az);
}

test("24: preflight is `az account show` and returns the cached identity", async (t) => {
  const h = shimHarness(t);
  install(h, {});
  const adapter = createAzureAppServiceAdapter(SETTINGS, h.runtime);
  const result = await adapter.preflight([req("stage-1", "acme-api-stage1")]);
  assert.equal(result.identity, "operator@example.com (acme-subscription)");
  assert.deepEqual(result.commands, ["az account show --output json"]);
  assert.deepEqual(h.calls().map((c) => c.args), [["account", "show", "--output", "json"]]);
  done(t, h);
});

test("24: normal read — one list per subscription, images parsed, last-modified as ISO", async (t) => {
  const h = shimHarness(t);
  install(h, {
    [SUB.one]: [webapp("acme-api-stage1"), webapp("acme-api-internal-stage1", { fx: "DOCKER|registry.example.com:5000/acme/api:3f2a9c1" })],
    [SUB.two]: [webapp("acme-api-stage2", { rg: "rg-acme-stage2", fx: "DOCKER|registry.example.com/acme/api:1.4.0", modified: "2026-08-12T09:30:00" })],
    [SUB.three]: [],
  });
  const adapter = createAzureAppServiceAdapter(SETTINGS, h.runtime);
  const readings = await adapter.read([
    req("stage-1", "acme-api-stage1"),
    req("stage-1", "acme-api-internal-stage1", "api-internal"),
    req("stage-2", "acme-api-stage2"),
  ]);
  assert.deepEqual(readings.map((r) => r.status), ["found", "found", "found"]);
  const [api, internal, prod] = readings;
  assert.equal(api.key, "acme-api/stage-1/api");
  assert.equal(api.image.registry, "registry.example.com");
  assert.equal(api.image.repository, "acme/api");
  assert.equal(api.image.tag, "3f2a9c1");
  assert.equal(api.state, "Running");
  assert.equal(api.lastModified, "2026-11-10T09:12:44.123Z");
  assert.equal(api.lastModifiedSource, "lastModifiedTimeUtc");
  assert.equal(api.digestStatus, "not-exposed");
  assert.deepEqual(api.details, { subscription: SUB.one, resourceGroup: "rg-acme-stage1", kind: "app,linux,container", linuxFxVersionSource: "list" });
  assert.deepEqual(api.notes, []);
  assert.equal(internal.image.registry, "registry.example.com:5000", "a registry port is not a tag");
  assert.equal(internal.image.tag, "3f2a9c1");
  assert.equal(prod.lastModified, "2026-08-12T09:30:00.000Z", "zone-less lastModifiedTimeUtc is UTC");
  assert.equal(prod.details.resourceGroup, "rg-acme-stage2");

  const lists = h.calls().filter((c) => c.args[0] === "webapp");
  assert.deepEqual(lists.map((c) => c.args[c.args.indexOf("--subscription") + 1]), [SUB.one, SUB.two, SUB.three], "exactly one list call per subscription");
  for (const call of lists) {
    assert.deepEqual(call.args, ["webapp", "list", "--subscription", call.args[3], "--query", WEBAPP_LIST_QUERY, "--output", "json"]);
    assert.equal(call.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
    assert.equal(call.env.RR_TEST_MARKER, "passed-through");
  }
  done(t, h);
});

test("24: names match case-insensitively and a subscription shared by two stages is listed once", async (t) => {
  const h = shimHarness(t);
  install(h, { [SUB.one]: [webapp("Acme-Api-Stage1")] });
  const adapter = createAzureAppServiceAdapter({ timeoutSeconds: 10, stageSubscriptions: { "stage-1": [SUB.one], "stage-2": [SUB.one] } }, h.runtime);
  const readings = await adapter.read([req("stage-1", "acme-api-stage1"), req("stage-2", "ACME-API-STAGE1")]);
  assert.deepEqual(readings.map((r) => r.status), ["found", "found"]);
  assert.equal(h.calls().filter((c) => c.args[0] === "webapp").length, 1);
  done(t, h);
});

test("24/21: a declared webapp absent from the stage's subscriptions is `missing`, not an error", async (t) => {
  const h = shimHarness(t);
  install(h, { [SUB.two]: [webapp("someone-else")], [SUB.three]: [] });
  const [reading] = await createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-2", "acme-api-stage2")]);
  assert.equal(reading.status, "missing");
  assert.equal(reading.image, null);
  assert.match(reading.notes[0], /not found in subscription\(s\) \S+0002, \S+0003 of stage "stage-2"/);
  done(t, h);
});

test("24: a webapp name present in TWO subscriptions of one stage is refused as ambiguous (21)", async (t) => {
  const h = shimHarness(t);
  install(h, {
    [SUB.two]: [webapp("acme-dup", { rg: "rg-a", fx: "DOCKER|registry.example.com/acme/api:1" })],
    [SUB.three]: [webapp("acme-dup", { rg: "rg-b", fx: "DOCKER|registry.example.com/acme/api:2" })],
  });
  await rejectsWith(assert, createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-2", "acme-dup")]), {
    exitCode: 21,
    name: "SourceError",
    message: /exists in BOTH .*0002 and .*0003.*ambiguous/,
  });
  done(t, h);
});

test("24: an unrelated duplicate name does not block reading the requested webapp", async (t) => {
  const h = shimHarness(t);
  install(h, { [SUB.two]: [webapp("other-dup"), webapp("acme-api-stage2")], [SUB.three]: [webapp("other-dup")] });
  const [reading] = await createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-2", "acme-api-stage2")]);
  assert.equal(reading.status, "found");
  done(t, h);
});

test("24: a stopped webapp keeps its image and reports its state", async (t) => {
  const h = shimHarness(t);
  install(h, { [SUB.one]: [webapp("acme-api-stage1", { state: "Stopped", fx: "DOCKER|registry.example.com/acme/api:1.0.0" })] });
  const [reading] = await createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-1", "acme-api-stage1")]);
  assert.equal(reading.status, "found");
  assert.equal(reading.state, "Stopped");
  assert.equal(reading.image.tag, "1.0.0");
  assert.match(reading.notes.join("\n"), /state Stopped/);
  done(t, h);
});

test("24: non-container, multi-container, sidecar and unparseable values are flagged, never an image", async (t) => {
  const h = shimHarness(t);
  install(h, {
    [SUB.one]: [
      webapp("acme-node", { kind: "app,linux", fx: "NODE|20-lts" }),
      webapp("acme-compose", { fx: "COMPOSE|dmVyc2lvbjogJzMn" }),
      webapp("acme-sidecar", { fx: "SITECONTAINERS" }),
      webapp("acme-blank", { fx: "" }),
      webapp("acme-bad", { fx: "DOCKER|registry.example.com/acme/API!!:1" }),
    ],
  });
  const readings = await createAzureAppServiceAdapter(SETTINGS, h.runtime).read(
    ["acme-node", "acme-compose", "acme-sidecar", "acme-blank", "acme-bad"].map((n, i) => req("stage-1", n, `t${i}`)),
  );
  assert.deepEqual(readings.map((r) => r.image.kind), ["non-container", "multi-container", "sidecar", "non-container", "invalid"]);
  assert.match(readings[0].notes[0], /not container-configured/);
  assert.match(readings[1].notes[0], /multi-container/);
  assert.match(readings[2].notes[0], /sidecar/);
  assert.match(readings[4].notes[0], /unparseable/);
  for (const r of readings) assert.deepEqual(r.containers, []);
  done(t, h);
});

test("24: digest-pinned, implicit-latest and Docker Hub references parse with full parity", async (t) => {
  const h = shimHarness(t);
  install(h, {
    [SUB.one]: [
      webapp("acme-pinned", { fx: `DOCKER|registry.example.com/acme/api@${digestOf("a")}` }),
      webapp("acme-latest", { fx: "DOCKER|registry.example.com/acme/team/api" }),
      webapp("acme-hub", { fx: "DOCKER|acme/api:2.0.0" }),
    ],
  });
  const [pinned, latest, hub] = await createAzureAppServiceAdapter(SETTINGS, h.runtime).read(
    ["acme-pinned", "acme-latest", "acme-hub"].map((n) => req("stage-1", n, n)),
  );
  assert.equal(pinned.image.digest, digestOf("a"));
  assert.equal(pinned.image.tag, null);
  assert.equal(latest.image.repository, "acme/team/api", "nested repository");
  assert.equal(latest.image.implicitTag, true);
  assert.equal(hub.image.registry, "docker.io");
  assert.equal(hub.image.implicitRegistry, true);
  assert.equal(pinned.digestStatus, "not-exposed", "no RUNTIME digest; the configured one stays in image");
  done(t, h);
});

test("24: linuxFxVersion null in the list → a single-target `az webapp config show` read", async (t) => {
  const h = shimHarness(t);
  const unpopulated = webapp("acme-api-stage1");
  unpopulated.siteConfig = { linuxFxVersion: null };
  install(h, { [SUB.one]: [unpopulated, webapp("acme-other-stage1")] }, [
    {
      match: ["webapp", "config", "show"],
      flags: { "--name": "acme-api-stage1", "--resource-group": "rg-acme-stage1", "--subscription": SUB.one },
      stdout: { linuxFxVersion: "DOCKER|registry.example.com/acme/api:9e8d7c6", numberOfWorkers: 1 },
      query: true,
    },
  ]);
  const readings = await createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-1", "acme-api-stage1"), req("stage-1", "acme-other-stage1", "other")]);
  assert.equal(readings[0].image.tag, "9e8d7c6");
  assert.equal(readings[0].details.linuxFxVersionSource, "config show");
  assert.equal(readings[1].details.linuxFxVersionSource, "list");
  const shows = h.calls().filter((c) => c.args[1] === "config");
  assert.equal(shows.length, 1, "only the unpopulated target is read individually");
  assert.deepEqual(shows[0].args, [
    "webapp", "config", "show", "--resource-group", "rg-acme-stage1", "--name", "acme-api-stage1",
    "--subscription", SUB.one, "--query", "linuxFxVersion", "--output", "json",
  ]);
  done(t, h);
});

test("20/21: not logged in at preflight is AuthError with the `az login` hint, never missing", async (t) => {
  const h = shimHarness(t);
  h.install("az", [{ match: ["account", "show"], stderr: "ERROR: Please run 'az login' to setup account.\n", exit: 1 }]);
  const error = await rejectsWith(assert, createAzureAppServiceAdapter(SETTINGS, h.runtime).preflight([req("stage-1", "x")]), { exitCode: 20, name: "AuthError" });
  assert.equal(error.kind, "not-authenticated");
  assert.match(error.hint, /az login/);
  done(t, h);
});

test("20/21: expired auth during the list is AuthError (20) echoing the tenant, never missing", async (t) => {
  const h = shimHarness(t);
  install(h, {}, [
    {
      match: ["webapp", "list"],
      stderr: 'ERROR: AADSTS50173: The provided grant has expired due to it being revoked.\naz login --tenant "00000000-0000-0000-0000-00000000000a"\n',
      exit: 1,
    },
  ]);
  const error = await rejectsWith(assert, createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-1", "acme-api-stage1")]), { exitCode: 20, name: "AuthError" });
  assert.match(error.hint, /az login --tenant "00000000-0000-0000-0000-00000000000a"/);
  assert.doesNotMatch(error.message, /missing|not found/i);
  done(t, h);
});

test("20: az exiting 0 with a login prompt instead of JSON is still auth (parity)", async (t) => {
  const h = shimHarness(t);
  install(h, {}, [{ match: ["webapp", "list"], stdout: "Please run 'az login' to setup account.\n" }]);
  await rejectsWith(assert, createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-1", "acme-api-stage1")]), { exitCode: 20 });
  done(t, h);
});

test("20: az missing from PATH is AuthError naming `az`", async (t) => {
  const h = shimHarness(t);
  const error = await rejectsWith(assert, createAzureAppServiceAdapter(SETTINGS, h.missingRuntime).preflight([req("stage-1", "x")]), {
    exitCode: 20,
    message: /`az` is not found on PATH/,
  });
  assert.equal(error.kind, "cli-missing");
  assert.equal(error.binary, "az");
});

test("21: an unknown az failure is SourceError (21), never missing", async (t) => {
  const h = shimHarness(t);
  install(h, {}, [{ match: ["webapp", "list"], stderr: "ERROR: (InternalServerError) Encountered an internal server error.\n", exit: 1 }]);
  await rejectsWith(assert, createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-1", "acme-api-stage1")]), { exitCode: 21, message: /InternalServerError/ });
  done(t, h);
});

test("21: output that is not JSON is a source error", async (t) => {
  const h = shimHarness(t);
  install(h, {}, [{ match: ["webapp", "list"], stdout: "[{ not json" }]);
  await rejectsWith(assert, createAzureAppServiceAdapter(SETTINGS, h.runtime).read([req("stage-1", "acme-api-stage1")]), { exitCode: 21, message: /not JSON/ });
  done(t, h);
});

test("29: a list call exceeding the configured timeout is exit 21", async (t) => {
  const h = shimHarness(t);
  install(h, {}, [{ match: ["webapp", "list"], sleepMs: 4000, stdout: [] }]);
  await rejectsWith(assert, createAzureAppServiceAdapter({ ...SETTINGS, timeoutSeconds: 1 }, h.runtime).read([req("stage-1", "acme-api-stage1")]), {
    exitCode: 21,
    message: /timed out after 1s/,
  });
  done(t, h);
});

test("a stage with no subscriptions configured is refused before any call (24)", async (t) => {
  const h = shimHarness(t);
  install(h, {});
  await rejectsWith(assert, createAzureAppServiceAdapter(SETTINGS, h.runtime).preflight([req("stage-9", "x")]), { exitCode: 24 });
  assert.equal(h.calls().length, 0);
});

test("discover lists each stage's web apps (one list per subscription), flags duplicates, infers no names", async (t) => {
  const h = shimHarness(t);
  install(h, {
    [SUB.one]: [webapp("acme-web-stage1", { state: "Stopped", kind: "app,linux", fx: "NODE|20-lts" }), webapp("acme-api-stage1")],
    [SUB.two]: [webapp("acme-api-stage2"), webapp("acme-dup")],
    [SUB.three]: [webapp("acme-dup")],
  });
  const candidates = await discoverAzureAppService(SETTINGS, h.runtime, ["stage-1", "stage-2"]);
  assert.deepEqual(
    candidates.map((c) => [c.stage, c.fields.webapp, c.details.ambiguous]),
    [
      ["stage-1", "acme-api-stage1", false],
      ["stage-1", "acme-web-stage1", false],
      ["stage-2", "acme-api-stage2", false],
      ["stage-2", "acme-dup", true],
      ["stage-2", "acme-dup", true],
    ],
  );
  assert.equal(candidates[1].image, "NODE|20-lts");
  assert.equal(candidates[1].state, "Stopped");
  assert.equal(h.calls().filter((c) => c.args[0] === "webapp").length, 3);
  done(t, h);
});
