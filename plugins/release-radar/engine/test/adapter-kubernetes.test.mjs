// kubernetes adapter (spec requirement 26). Fixture shapes model research §5 (Deployment and Pod
// JSON, MODELLED); all data synthetic. Every call must pin --context/--namespace (except the
// client-only version check) and be read-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKubernetesAdapter, discoverKubernetes, labelSelector, parseImageId } from "../dist/adapters/kubernetes.js";
import { READ_ONLY, assertReadOnly, digestOf, rejectsWith, shimHarness } from "./fixtures/cli-shims.mjs";

const SETTINGS = { timeoutSeconds: 10 };
const TARGET = { name: "api-internal", adapter: "kubernetes", context: "stage-1", namespace: "acme", deployment: "acme-api" };
const req = (target = TARGET) => ({ key: `acme-api/stage-1/${target.name}`, stage: "stage-1", target });
const IMG = "registry.example.com/acme/api:3f2a9c1";

function deployment({ image = IMG, generation = 5, observed = 5, replicas = 2, updated = 2, available = 2, ready = 2, progressReason = "NewReplicaSetAvailable", availableStatus = "True", extraContainers = [] } = {}) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "acme-api", namespace: "acme", generation },
    spec: {
      replicas,
      selector: { matchLabels: { app: "acme-api", tier: "web" } },
      template: { spec: { containers: [{ name: "api", image }, ...extraContainers] } },
    },
    status: {
      observedGeneration: observed,
      replicas,
      updatedReplicas: updated,
      readyReplicas: ready,
      availableReplicas: available,
      conditions: [
        { type: "Available", status: availableStatus },
        { type: "Progressing", status: "True", reason: progressReason, lastUpdateTime: "2026-11-12T08:01:00Z" },
      ],
    },
  };
}

function pod(name, { image = IMG, imageID = `registry.example.com/acme/api@${digestOf("1")}`, terminating = false } = {}) {
  const metadata = { name, labels: { app: "acme-api", tier: "web" } };
  if (terminating) metadata.deletionTimestamp = "2026-11-12T08:05:00Z";
  return {
    metadata,
    status: {
      phase: "Running",
      containerStatuses: [{ name: "api", ready: true, restartCount: 0, image, imageID, state: { running: { startedAt: "2026-11-12T08:00:30Z" } } }],
    },
  };
}

function install(h, { dep = deployment(), pods = [pod("acme-api-6d9f-abcde"), pod("acme-api-6d9f-fghij")], extra = [] } = {}) {
  h.install("kubectl", [
    ...extra,
    { match: ["version", "--client"], stdout: { clientVersion: { major: "1", minor: "31", gitVersion: "v1.31.0" } } },
    { match: ["config", "get-contexts", "stage-1"], stdout: "stage-1\n" },
    { match: ["auth", "can-i", "get", "deployments.apps"], flags: { "--context": "stage-1", "--namespace": "acme" }, stdout: "yes\n" },
    { match: ["get", "deployment", "acme-api"], flags: { "--context": "stage-1", "--namespace": "acme" }, stdout: dep },
    { match: ["get", "pods"], flags: { "--context": "stage-1", "--namespace": "acme", "-l": "app=acme-api,tier=web" }, stdout: { apiVersion: "v1", kind: "List", items: pods } },
  ]);
}

/** Read-only, and every call except `version --client` / `config get-contexts` pins context + namespace first. */
function done(h) {
  const calls = h.calls();
  assertReadOnly(assert, calls, READ_ONLY.kubectl);
  for (const call of calls) {
    if (call.args[0] === "version" || call.args[0] === "config") continue;
    assert.deepEqual(call.args.slice(0, 4), ["--context", "stage-1", "--namespace", "acme"], call.args.join(" "));
    assert.equal(call.env.LC_ALL, "C");
  }
}

test("26: imageID forms — containerd digest, docker-pullable prefix, bare config id, empty", () => {
  assert.deepEqual(parseImageId(`registry.example.com/acme/api@${digestOf("a")}`), { digest: digestOf("a"), imageId: null });
  assert.deepEqual(parseImageId(`docker-pullable://registry.example.com/acme/api@${digestOf("b")}`), { digest: digestOf("b"), imageId: null });
  assert.deepEqual(parseImageId(digestOf("c")), { digest: null, imageId: digestOf("c") }, "a bare sha256 is an image config id, never a registry digest");
  assert.deepEqual(parseImageId(""), { digest: null, imageId: null });
  assert.deepEqual(parseImageId(null), { digest: null, imageId: null });
  assert.equal(labelSelector({ spec: { selector: { matchLabels: { tier: "web", app: "acme-api" } } } }), "app=acme-api,tier=web");
  assert.equal(labelSelector({ spec: { selector: { matchExpressions: [] } } }), null);
});

test("26: preflight — client version, the context exists, can-i get deployments; never use-context", async (t) => {
  const h = shimHarness(t);
  install(h);
  const result = await createKubernetesAdapter(SETTINGS, h.runtime).preflight([req(), req({ ...TARGET, name: "other" })]);
  assert.deepEqual(result.commands, [
    "kubectl version --client -o json",
    "kubectl config get-contexts stage-1 -o name",
    "kubectl --context stage-1 --namespace acme auth can-i get deployments.apps",
  ]);
  done(h);
});

test("26: normal read — desired image from the Deployment, actual digest from pods, rollout complete", async (t) => {
  const h = shimHarness(t);
  install(h);
  const [reading] = await createKubernetesAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.status, "found");
  assert.equal(reading.image.raw, IMG);
  assert.equal(reading.digest, digestOf("1"));
  assert.equal(reading.digestStatus, "available");
  assert.equal(reading.rollout, "complete");
  assert.equal(reading.state, "Available");
  assert.equal(reading.mixed, false);
  assert.equal(reading.lastModified, "2026-11-12T08:01:00.000Z");
  assert.equal(reading.details.readyReplicas, 2);
  assert.deepEqual(reading.containers.map((c) => c.source), ["pod acme-api-6d9f-abcde", "pod acme-api-6d9f-fghij"]);
  assert.deepEqual(
    h.calls().map((c) => c.args.slice(4)),
    [["get", "deployment", "acme-api", "-o", "json"], ["get", "pods", "-l", "app=acme-api,tier=web", "-o", "json"]],
  );
  done(h);
});

test("26: the docker-pullable:// form yields the same registry digest", async (t) => {
  const h = shimHarness(t);
  install(h, { pods: [pod("p1", { imageID: `docker-pullable://registry.example.com/acme/api@${digestOf("1")}` })] });
  const [reading] = await createKubernetesAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.digest, digestOf("1"));
  done(h);
});

test("26: a bare sha256 imageID is never used as a registry digest (unavailable)", async (t) => {
  const h = shimHarness(t);
  install(h, { pods: [pod("p1", { imageID: digestOf("c") }), pod("p2", { imageID: digestOf("c") })] });
  const [reading] = await createKubernetesAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.digest, null);
  assert.equal(reading.imageId, digestOf("c"));
  assert.equal(reading.digestStatus, "unavailable");
  assert.match(reading.notes.join("\n"), /no registry digest/);
  done(h);
});

test("26: pods running different images are flagged mixed and named; rollout in progress from JSON", async (t) => {
  const h = shimHarness(t);
  install(h, {
    dep: deployment({ image: "registry.example.com/acme/api:9e8d7c6", generation: 6, observed: 6, updated: 1, available: 1, progressReason: "ReplicaSetUpdated" }),
    pods: [
      pod("acme-api-old-aaaaa", { imageID: `registry.example.com/acme/api@${digestOf("1")}` }),
      pod("acme-api-new-bbbbb", { image: "registry.example.com/acme/api:9e8d7c6", imageID: `registry.example.com/acme/api@${digestOf("2")}` }),
    ],
  });
  const [reading] = await createKubernetesAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.mixed, true);
  assert.equal(reading.digest, null, "no single digest while pods disagree");
  assert.equal(reading.digestStatus, "unavailable");
  assert.equal(reading.rollout, "in-progress");
  assert.equal(reading.image.tag, "9e8d7c6", "the image shown is the desired one");
  const notes = reading.notes.join("\n");
  assert.match(notes, /acme-api-old-aaaaa .*3f2a9c1/);
  assert.match(notes, /acme-api-new-bbbbb .*9e8d7c6/);
  assert.match(notes, /rollout in progress \(1\/2 updated, 1\/2 available\)/);
  done(h);
});

test("26: terminating pods are excluded from the digest and the mixed check", async (t) => {
  const h = shimHarness(t);
  install(h, {
    pods: [
      pod("acme-api-new-1"),
      pod("acme-api-new-2"),
      pod("acme-api-old-1", { image: "registry.example.com/acme/api:old", imageID: `registry.example.com/acme/api@${digestOf("9")}`, terminating: true }),
    ],
  });
  const [reading] = await createKubernetesAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.mixed, false);
  assert.equal(reading.digest, digestOf("1"));
  assert.ok(!reading.containers.some((c) => c.source === "pod acme-api-old-1"));
  assert.match(reading.notes.join("\n"), /1 terminating pod\(s\) excluded/);
  done(h);
});

test("26: a scaled-to-zero Deployment reports the desired image with digest unavailable", async (t) => {
  const h = shimHarness(t);
  install(h, { dep: deployment({ replicas: 0, updated: 0, available: 0, ready: 0, availableStatus: "True" }), pods: [] });
  const [reading] = await createKubernetesAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.state, "ScaledToZero");
  assert.equal(reading.image.raw, IMG);
  assert.equal(reading.digestStatus, "unavailable");
  assert.match(reading.notes.join("\n"), /no running pods/);
  done(h);
});

test("26: a stalled rollout reports ProgressDeadlineExceeded", async (t) => {
  const h = shimHarness(t);
  install(h, { dep: deployment({ updated: 1, available: 1, progressReason: "ProgressDeadlineExceeded", availableStatus: "False" }) });
  const [reading] = await createKubernetesAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.state, "ProgressDeadlineExceeded");
  assert.equal(reading.rollout, "in-progress");
  done(h);
});

test("21: NotFound is `missing` and no pods are listed", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["get", "deployment"], stderr: 'Error from server (NotFound): deployments.apps "acme-api" not found\n', exit: 1 }] });
  const [reading] = await createKubernetesAdapter(SETTINGS, h.runtime).read([req()]);
  assert.equal(reading.status, "missing");
  assert.equal(h.calls().filter((c) => c.args.includes("pods")).length, 0);
  done(h);
});

test("20: Forbidden on the read is auth (20), never missing", async (t) => {
  const h = shimHarness(t);
  install(h, {
    extra: [{ match: ["get", "deployment"], stderr: 'Error from server (Forbidden): deployments.apps "acme-api" is forbidden: User "acme-reader" cannot get resource "deployments"\n', exit: 1 }],
  });
  const error = await rejectsWith(assert, createKubernetesAdapter(SETTINGS, h.runtime).read([req()]), { exitCode: 20, name: "AuthError" });
  assert.match(error.hint, /never switches or edits contexts/);
  done(h);
});

test("20: Unauthorized is auth (20)", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["get", "deployment"], stderr: "error: You must be logged in to the server (Unauthorized)\n", exit: 1 }] });
  await rejectsWith(assert, createKubernetesAdapter(SETTINGS, h.runtime).read([req()]), { exitCode: 20 });
  done(h);
});

test("20: an unconfigured context fails preflight (20) without touching the cluster", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["config", "get-contexts"], stderr: 'error: context "stage-1" does not exist\n', exit: 1 }] });
  await rejectsWith(assert, createKubernetesAdapter(SETTINGS, h.runtime).preflight([req()]), { exitCode: 20, message: /context/ });
  assert.equal(h.calls().filter((c) => c.args[0] === "--context").length, 0);
  done(h);
});

test("20: `auth can-i` answering no (exit 1) is a preflight auth failure", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["auth", "can-i"], stdout: "no\n", exit: 1 }] });
  await rejectsWith(assert, createKubernetesAdapter(SETTINGS, h.runtime).preflight([req()]), { exitCode: 20, message: /may not get deployments in namespace "acme"/ });
  done(h);
});

test("20: kubectl missing is AuthError naming `kubectl`", async (t) => {
  const h = shimHarness(t);
  const error = await rejectsWith(assert, createKubernetesAdapter(SETTINGS, h.missingRuntime).preflight([req()]), { exitCode: 20, message: /`kubectl` is not found on PATH/ });
  assert.equal(error.binary, "kubectl");
});

test("21: an unknown kubectl error is SourceError (21), never missing", async (t) => {
  const h = shimHarness(t);
  install(h, { extra: [{ match: ["get", "deployment"], stderr: 'error: the server doesn\'t have a resource type "deployment"\n', exit: 1 }] });
  await rejectsWith(assert, createKubernetesAdapter(SETTINGS, h.runtime).read([req()]), { exitCode: 21, name: "SourceError" });
  done(h);
});

test("discover lists the Deployments of a caller-supplied context + namespace", async (t) => {
  const h = shimHarness(t);
  h.install("kubectl", [
    {
      match: ["get", "deployments"],
      flags: { "--context": "stage-1", "--namespace": "acme" },
      stdout: { items: [deployment(), { ...deployment({ image: "registry.example.com/acme/worker:1" }), metadata: { name: "acme-worker" } }] },
    },
  ]);
  const candidates = await discoverKubernetes(SETTINGS, h.runtime, { context: "stage-1", namespace: "acme" });
  assert.deepEqual(candidates.map((c) => c.fields.deployment), ["acme-api", "acme-worker"]);
  assert.deepEqual(candidates[0].fields, { context: "stage-1", namespace: "acme", deployment: "acme-api" });
  assert.equal(candidates[1].image, "registry.example.com/acme/worker:1");
  done(h);
});
