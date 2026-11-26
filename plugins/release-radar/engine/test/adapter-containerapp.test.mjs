// azure-containerapp adapter (spec requirement 25). Fixture shapes model research §4 (field paths
// MODELLED, not captured); all data synthetic. Every test asserts read-only az calls from the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAzureContainerAppAdapter, discoverAzureContainerApps } from "../dist/adapters/azure-containerapp.js";
import { READ_ONLY, SUB, assertReadOnly, rejectsWith, shimHarness } from "./fixtures/cli-shims.mjs";

const SETTINGS = { timeoutSeconds: 10 };
const TARGET = { name: "api", adapter: "azure-containerapp", subscription: SUB.one, resourceGroup: "rg-acme-stage1", app: "acme-api" };
const req = (target = TARGET) => ({ key: `acme-api/stage-1/${target.name}`, stage: "stage-1", target });
const IMG = (tag) => `registry.example.com/acme/api:${tag}`;

function app({ mode = "Single", latest = "acme-api--0000007", ready = "acme-api--0000007", provisioning = "Succeeded", running, image = IMG("3f2a9c1") } = {}) {
  const value = {
    name: "acme-api",
    systemData: { lastModifiedAt: "2026-11-12T08:00:00Z" },
    properties: {
      provisioningState: provisioning,
      latestRevisionName: latest,
      latestReadyRevisionName: ready,
      configuration: { activeRevisionsMode: mode },
      template: { containers: [{ name: "api", image }] },
    },
  };
  if (running !== undefined) value.properties.runningStatus = { runningState: running };
  return value;
}

function revision(name, { active = true, weight = 100, image = IMG("3f2a9c1"), running = "Running", extra = [] } = {}) {
  return {
    name,
    properties: {
      active,
      trafficWeight: weight,
      runningState: running,
      healthState: "Healthy",
      provisioningState: "Provisioned",
      replicas: 2,
      createdTime: "2026-11-12T07:58:11+00:00",
      template: { containers: [{ name: "api", image }, ...extra] },
    },
  };
}

function install(h, { show = app(), revisions = [revision("acme-api--0000007")], extra = [] } = {}) {
  h.install("az", [
    ...extra,
    { match: ["account", "show"], stdout: { name: "acme-subscription", user: { name: "operator@example.com" } } },
    { match: ["containerapp", "--help"], stdout: "Group\n    az containerapp : Manage Azure Container Apps.\n" },
    { match: ["containerapp", "show"], flags: { "--name": "acme-api", "--resource-group": "rg-acme-stage1", "--subscription": SUB.one }, stdout: show },
    { match: ["containerapp", "revision", "list"], flags: { "--name": "acme-api" }, stdout: revisions },
  ]);
}

const done = (h) => assertReadOnly(assert, h.calls(), READ_ONLY.az);

test("25: preflight runs `az account show` and `az containerapp --help`, with dynamic install disabled", async (t) => {
  const h = shimHarness(t);
  install(h);
  const result = await createAzureContainerAppAdapter(SETTINGS, h.runtime).preflight([req()]);
  assert.deepEqual(result.commands, ["az account show --output json", "az containerapp --help"]);
  for (const call of h.calls()) assert.equal(call.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
  done(h);
});

test("25: Single revision mode — the active revision's image, state and last-modified", async (t) => {
  const h = shimHarness(t);
  install(h, { show: app({ running: "Running" }), revisions: [revision("acme-api--0000007"), revision("acme-api--0000006", { active: false, weight: 0, image: IMG("aa11bb2") })] });
  const [reading] = await createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.status, "found");
  assert.equal(reading.image.tag, "3f2a9c1");
  assert.equal(reading.state, "Running");
  assert.equal(reading.lastModified, "2026-11-12T08:00:00.000Z");
  assert.equal(reading.lastModifiedSource, "systemData.lastModifiedAt");
  assert.equal(reading.digestStatus, "not-exposed");
  assert.equal(reading.mixed, false);
  assert.equal(reading.details.revisionMode, "Single");
  assert.equal(reading.details.servingRevisions, "acme-api--0000007");
  assert.deepEqual(reading.containers.map((c) => c.source), ["revision acme-api--0000007"], "inactive revisions are not reported");
  const calls = h.calls().map((c) => c.args.slice(0, 3).join(" "));
  assert.deepEqual(calls, ["containerapp show --name", "containerapp revision list"]);
  done(h);
});

test("25: Multiple revision mode — every revision with traffic is reported, weights kept, split images flagged", async (t) => {
  const h = shimHarness(t);
  install(h, {
    show: app({ mode: "Multiple", latest: "acme-api--0000008", ready: "acme-api--0000008" }),
    revisions: [
      revision("acme-api--0000007", { weight: 80, image: IMG("3f2a9c1") }),
      revision("acme-api--0000008", { weight: 20, image: IMG("9e8d7c6") }),
      revision("acme-api--0000005", { weight: 0, image: IMG("0000001") }),
    ],
  });
  const [reading] = await createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.image.tag, "3f2a9c1", "the highest-weighted revision is primary");
  assert.equal(reading.mixed, true);
  assert.deepEqual(reading.containers.map((c) => [c.source, c.trafficWeight, c.image.tag]), [
    ["revision acme-api--0000007", 80, "3f2a9c1"],
    ["revision acme-api--0000008", 20, "9e8d7c6"],
  ]);
  assert.match(reading.notes.join("\n"), /traffic is split .*0000007 80% .*0000008 20%/);
  done(h);
});

test("25: Multiple mode with all traffic on one image is not mixed", async (t) => {
  const h = shimHarness(t);
  install(h, { show: app({ mode: "Multiple" }), revisions: [revision("acme-api--0000007", { weight: 100 }), revision("acme-api--0000006", { weight: 0, image: IMG("old") })] });
  const [reading] = await createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.mixed, false);
  assert.equal(reading.containers.length, 1);
  done(h);
});

test("25: a latest revision that is not ready is not reported as running", async (t) => {
  const h = shimHarness(t);
  install(h, {
    show: app({ latest: "acme-api--0000008", ready: "acme-api--0000007", provisioning: "InProgress", image: IMG("9e8d7c6") }),
    revisions: [revision("acme-api--0000007"), revision("acme-api--0000008", { weight: 0, image: IMG("9e8d7c6"), running: "Activating" })],
  });
  const [reading] = await createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.image.tag, "3f2a9c1", "the template (latest) image is NOT what runs");
  assert.ok(!reading.containers.some((c) => c.image.tag === "9e8d7c6"));
  assert.match(reading.notes.join("\n"), /latest revision acme-api--0000008 is not ready/);
  assert.equal(reading.details.latestReadyRevision, "acme-api--0000007");
  done(h);
});

test("25: no serving revision → found with no running image, explained", async (t) => {
  const h = shimHarness(t);
  install(h, { revisions: [] });
  const [reading] = await createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.status, "found");
  assert.equal(reading.image, null);
  assert.match(reading.notes.join("\n"), /no active revision is serving traffic/);
  done(h);
});

test("25: several containers in the serving revision — the first is primary, all are listed", async (t) => {
  const h = shimHarness(t);
  install(h, { revisions: [revision("acme-api--0000007", { extra: [{ name: "sidecar", image: "registry.example.com/acme/proxy:1.0" }] })] });
  const [reading] = await createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.image.repository, "acme/api");
  assert.deepEqual(reading.containers.map((c) => c.name), ["api", "sidecar"]);
  assert.equal(reading.mixed, false, "a sidecar is not a mixed rollout");
  assert.match(reading.notes.join("\n"), /runs 2 containers/);
  done(h);
});

test("21: an app that does not exist is `missing`, and the revision list is not called", async (t) => {
  const h = shimHarness(t);
  install(h, {
    extra: [
      {
        match: ["containerapp", "show"],
        stderr: "ERROR: (ResourceNotFound) The Resource 'Microsoft.App/containerApps/acme-api' under resource group 'rg-acme-stage1' was not found.\n",
        exit: 3,
      },
    ],
  });
  const [reading] = await createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.status, "missing");
  assert.equal(h.calls().filter((c) => c.args[1] === "revision").length, 0);
  done(h);
});

test("20: a missing containerapp extension is a preflight failure with the add-extension hint (never installed)", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["containerapp", "--help"], stderr: "ERROR: The command requires the extension containerapp. Unable to prompt for extension install confirmation as no tty available.\n", exit: 2 }] });
  const error = await rejectsWith(assert, createAzureContainerAppAdapter(SETTINGS, h.runtime).preflight([req()]), { exitCode: 20, name: "AuthError" });
  assert.equal(error.kind, "capability-missing");
  assert.match(error.hint, /az extension add --name containerapp/);
  done(h);
});

test("20: an expired login during the read is auth (20), never missing", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["containerapp", "show"], stderr: "ERROR: AADSTS700082: The refresh token has expired due to inactivity.\n", exit: 1 }] });
  await rejectsWith(assert, createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]), { exitCode: 20, name: "AuthError" });
  done(h);
});

test("20: az missing is AuthError naming `az`", async (t) => {
  const h = shimHarness(t);
  const error = await rejectsWith(assert, createAzureContainerAppAdapter(SETTINGS, h.missingRuntime).preflight([req()]), { exitCode: 20 });
  assert.equal(error.binary, "az");
  assert.equal(error.kind, "cli-missing");
});

test("21: an unknown failure of the revision list is SourceError (21)", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["containerapp", "revision", "list"], stderr: "ERROR: Operation returned an invalid status 'Bad Gateway'\n", exit: 1 }] });
  await rejectsWith(assert, createAzureContainerAppAdapter(SETTINGS, h.runtime).read([req()]), { exitCode: 21, name: "SourceError" });
  done(h);
});

test("discover lists the apps of a caller-supplied subscription / resource group", async (t) => {
  const h = shimHarness(t);
  h.install("az", [
    {
      match: ["containerapp", "list"],
      flags: { "--subscription": SUB.one, "--resource-group": "rg-acme-stage1" },
      stdout: [
        { name: "acme-worker", resourceGroup: "rg-acme-stage1", properties: { provisioningState: "Succeeded", configuration: { activeRevisionsMode: "Single" }, template: { containers: [{ image: IMG("w1") }] } } },
        { name: "acme-api", resourceGroup: "rg-acme-stage1", properties: { provisioningState: "Succeeded", configuration: { activeRevisionsMode: "Multiple" }, template: { containers: [{ image: IMG("a1") }] } } },
      ],
    },
  ]);
  const candidates = await discoverAzureContainerApps(SETTINGS, h.runtime, { subscription: SUB.one, resourceGroup: "rg-acme-stage1" });
  assert.deepEqual(candidates.map((c) => c.fields), [
    { subscription: SUB.one, resourceGroup: "rg-acme-stage1", app: "acme-api" },
    { subscription: SUB.one, resourceGroup: "rg-acme-stage1", app: "acme-worker" },
  ]);
  assert.equal(candidates[0].image, IMG("a1"));
  assert.equal(candidates[0].details.revisionMode, "Multiple");
  done(h);
});
