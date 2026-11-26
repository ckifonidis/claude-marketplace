// Shared adapter foundation (spec requirements 16, 21, 23, 29): the stderr-pattern table, the spawn
// helper and its error mapping, timestamps, the JSON path subset, the registry, and the optional
// `adapters.command.discoverArgv` workspace key. All CLIs are fake shims; nothing real is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STDERR_PATTERNS, classifyStderr, tenantHintFrom } from "../dist/adapters/stderr-patterns.js";
import { excerpt, invokeCli, runCli } from "../dist/adapters/spawn.js";
import { AuthError, SourceError, missingReading, renderCommand, toIsoUtc } from "../dist/adapters/types.js";
import { ADAPTER_BINARIES, createAdapter } from "../dist/adapters/index.js";
import { evaluateJsonPath, parseJsonPath } from "../dist/json-path.js";
import { WORKSPACE_SCHEMA, checkWorkspace } from "../dist/config.js";
import { classify, validate } from "../dist/format.js";
import { rejectsWith, shimHarness } from "./fixtures/cli-shims.mjs";
import { expectEngineError, text, workspaceValue } from "./fixtures/workspace-fixtures.mjs";

const HINTS = { install: "install it", auth: () => "log in", capability: "add the plugin" };

// --- stderr-pattern table ------------------------------------------------------------------------

test("21: the stderr table classifies modelled az messages", () => {
  const cases = [
    ["ERROR: AADSTS50173: The provided grant has expired due to it being revoked.", "auth"],
    ["ERROR: Please run 'az login' to setup account.", "auth"],
    ["The refresh token has expired due to inactivity.", "auth"],
    ["(AuthorizationFailed) The client does not have authorization to perform action", "auth"],
    ["ERROR: Subscription '00000000-0000-0000-0000-000000000009' not found.", "auth"],
    ["ERROR: The command requires the extension containerapp. It will be installed first.", "capability-missing"],
    ["ERROR: (ResourceNotFound) The Resource 'Microsoft.App/containerApps/acme-api' under resource group 'rg-acme-stage1' was not found.", "not-found"],
    ["ERROR: The containerapp 'acme-api' does not exist / could not be found", "not-found"],
  ];
  for (const [message, kind] of cases) assert.equal(classifyStderr("az", message).kind, kind, message);
});

test("21: the stderr table classifies modelled kubectl and docker messages", () => {
  const cases = [
    ["kubectl", 'Error from server (NotFound): deployments.apps "acme-api" not found', "not-found"],
    ["kubectl", 'Error from server (Forbidden): deployments.apps "acme-api" is forbidden: User "x" cannot get resource', "auth"],
    ["kubectl", "error: You must be logged in to the server (Unauthorized)", "auth"],
    ["kubectl", 'error: context "stage-1" does not exist', "auth"],
    ["kubectl", "Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused", "auth"],
    ["docker", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", "auth"],
    ["docker", "error during connect: Get http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/version", "auth"],
    ["docker", "docker: 'compose' is not a docker command.", "capability-missing"],
    ["docker", "Error: No such object: c0ffee000001", "not-found"],
  ];
  for (const [family, message, kind] of cases) assert.equal(classifyStderr(family, message).kind, kind, message);
});

test("21: unknown stderr is `other` (exit 21), never not-found; the command family is never interpreted", () => {
  assert.equal(classifyStderr("az", "ERROR: something unexpected happened (500)").kind, "other");
  assert.equal(classifyStderr("kubectl", "error: the server doesn't have a resource type \"deployment\"").kind, "other");
  assert.equal(classifyStderr("docker", "unexpected EOF").kind, "other");
  assert.equal(classifyStderr("az", "").kind, "other");
  assert.equal(classifyStderr("command", "Error from server (NotFound): x not found").kind, "other");
  assert.equal(classifyStderr("command", "Please run 'az login'").kind, "other");
});

test("21: auth outranks not-found when both appear in one message", () => {
  const both = "ERROR: AADSTS700082 refresh token expired\n(ResourceNotFound) resource was not found";
  assert.equal(classifyStderr("az", both).kind, "auth");
  assert.equal(classifyStderr("kubectl", "Error from server (NotFound): x\nerror: You must be logged in to the server (Unauthorized)").kind, "auth");
});

test("the pattern table is one shared table covering az, kubectl and docker with every class", () => {
  for (const family of ["az", "kubectl", "docker"]) {
    for (const kind of ["auth", "not-found"]) {
      assert.ok(STDERR_PATTERNS.some((row) => row.family === family && row.kind === kind), `${family}/${kind}`);
    }
  }
  assert.equal(tenantHintFrom('az login --tenant "00000000-0000-0000-0000-00000000000a"'), "00000000-0000-0000-0000-00000000000a");
  assert.equal(tenantHintFrom("no tenant here"), null);
});

// --- spawn helper ---------------------------------------------------------------------------------

test("29: runCli runs argv without a shell (metacharacters arrive literally)", async (t) => {
  const h = shimHarness(t);
  h.install("echoer", [{ match: [], stdout: "ok" }]);
  const outcome = await runCli({ bin: "echoer", args: ["$(id)", "a;b", "|", "`x`"], timeoutMs: 5000, env: h.env });
  assert.equal(outcome.kind, "ok");
  assert.deepEqual(h.calls("echoer")[0].args, ["$(id)", "a;b", "|", "`x`"]);
});

test("29: ENOENT is cli-missing naming the binary; invokeCli maps it to AuthError 20", async (t) => {
  const h = shimHarness(t);
  const outcome = await runCli({ bin: "acme-cli", args: [], timeoutMs: 5000, env: h.missingEnv });
  assert.deepEqual(outcome, { kind: "cli-missing", bin: "acme-cli", reason: "not found on PATH" });
  const error = await rejectsWith(assert, invokeCli({ bin: "acme-cli", args: [], timeoutMs: 5000, env: h.missingEnv }, "command", HINTS), {
    exitCode: 20,
    name: "AuthError",
    message: /`acme-cli` is not found on PATH — install it/,
  });
  assert.ok(error instanceof AuthError);
  assert.equal(error.kind, "cli-missing");
  assert.equal(error.binary, "acme-cli");
});

test("29: a timeout kills the child and maps to SourceError 21", async (t) => {
  const h = shimHarness(t);
  h.install("slow", [{ match: [], sleepMs: 5000, stdout: "late" }]);
  const started = Date.now();
  const outcome = await runCli({ bin: "slow", args: [], timeoutMs: 300, env: h.env });
  assert.equal(outcome.kind, "timeout");
  assert.ok(Date.now() - started < 3000, "killed well before the shim would answer");
  await rejectsWith(assert, invokeCli({ bin: "slow", args: ["x"], timeoutMs: 300, env: h.env }, "kubectl", HINTS), {
    exitCode: 21,
    name: "SourceError",
    message: /timed out/,
  });
});

test("29: a timeout whose stderr already shows an auth prompt is exit 20", async (t) => {
  const h = shimHarness(t);
  const { mapOutcome } = await import("../dist/adapters/spawn.js");
  const spec = { bin: "kubectl", args: ["get", "pods"], timeoutMs: 200, env: h.env };
  assert.throws(
    () => mapOutcome(spec, { kind: "timeout", stdout: "", stderr: "error: You must be logged in to the server (Unauthorized)" }, "kubectl", HINTS),
    (error) => error instanceof AuthError && error.exitCode === 20,
  );
  assert.throws(() => mapOutcome(spec, { kind: "timeout", stdout: "", stderr: "" }, "kubectl", HINTS), (error) => error instanceof SourceError && error.exitCode === 21);
});

test("29: output beyond the cap is killed and reported as exit 21", async (t) => {
  const h = shimHarness(t);
  h.install("chatty", [{ match: [], stdout: "x".repeat(5000) }]);
  const outcome = await runCli({ bin: "chatty", args: [], timeoutMs: 5000, env: h.env, maxOutputBytes: 1000 });
  assert.equal(outcome.kind, "overflow");
  await rejectsWith(assert, invokeCli({ bin: "chatty", args: [], timeoutMs: 5000, env: h.env, maxOutputBytes: 1000 }, "command", HINTS), { exitCode: 21 });
});

test("21: invokeCli maps exit codes through the table: auth 20, capability 20, not-found returned, unknown 21", async (t) => {
  const h = shimHarness(t);
  h.install("az", [
    { match: ["auth"], stderr: "ERROR: AADSTS50173: grant expired\naz login --tenant \"00000000-0000-0000-0000-00000000000a\"\n", exit: 1 },
    { match: ["ext"], stderr: "ERROR: The command requires the extension containerapp.\n", exit: 1 },
    { match: ["gone"], stderr: "ERROR: (ResourceNotFound) was not found\n", exit: 3 },
    { match: ["boom"], stderr: "ERROR: internal server error\n", exit: 1 },
  ]);
  const run = (verb) => invokeCli({ bin: "az", args: [verb], timeoutMs: 5000, env: h.env }, "az", { ...HINTS, auth: (text) => `login ${tenantHintFrom(text)}` });
  const auth = await rejectsWith(assert, run("auth"), { exitCode: 20, name: "AuthError" });
  assert.equal(auth.kind, "not-authenticated");
  assert.match(auth.hint, /00000000-0000-0000-0000-00000000000a/);
  const capability = await rejectsWith(assert, run("ext"), { exitCode: 20, name: "AuthError" });
  assert.equal(capability.kind, "capability-missing");
  assert.equal((await run("gone")).kind, "not-found");
  await rejectsWith(assert, run("boom"), { exitCode: 21, name: "SourceError", message: /internal server error/ });
});

test("the environment is passed through unchanged (a marker variable reaches the child)", async (t) => {
  const h = shimHarness(t);
  h.install("probe", [{ match: [], stdout: "" }]);
  await runCli({ bin: "probe", args: [], timeoutMs: 5000, env: h.env });
  assert.equal(h.calls("probe")[0].env.RR_TEST_MARKER, "passed-through");
});

test("runCli refuses a non-positive timeout (no default exists)", async () => {
  await assert.rejects(runCli({ bin: "x", args: [], timeoutMs: 0, env: {} }), TypeError);
});

// --- helpers -------------------------------------------------------------------------------------

test("toIsoUtc: zone-less App Service times are UTC; others must carry a zone", () => {
  assert.equal(toIsoUtc("2026-11-10T09:12:44.123Z", "reject"), "2026-11-10T09:12:44.123Z");
  assert.equal(toIsoUtc("2026-08-12T09:30:00", "utc"), "2026-08-12T09:30:00.000Z");
  assert.equal(toIsoUtc("2026-08-12T09:30:00", "reject"), null);
  assert.equal(toIsoUtc("2026-11-12T07:58:11+00:00", "reject"), "2026-11-12T07:58:11.000Z");
  assert.equal(toIsoUtc("", "utc"), null);
  assert.equal(toIsoUtc(null, "utc"), null);
  assert.equal(toIsoUtc("yesterday", "utc"), null);
});

test("renderCommand quotes only arguments that need it; excerpt keeps three trimmed lines", () => {
  assert.equal(renderCommand("az", ["webapp", "list", "--query", "[].{name:name}"]), "az webapp list --query [].{name:name}");
  assert.equal(renderCommand("acme-ctl", ["show", "a b"]), 'acme-ctl show "a b"');
  assert.equal(excerpt("\n one \n\n two\nthree\nfour\n"), "one | two | three");
});

test("missingReading carries no image, no state and the note", () => {
  const reading = missingReading({ key: "k", stage: "stage-1", target: { name: "api", adapter: "compose", project: "acme", service: "api" } }, "gone");
  assert.equal(reading.status, "missing");
  assert.equal(reading.image, null);
  assert.deepEqual(reading.notes, ["gone"]);
});

// --- JSON path subset -----------------------------------------------------------------------------

test("json-path: $, .key and [index] select one value; absent steps say why; null is found", () => {
  const doc = { image: "registry.example.com/acme/api:1.2.3", spec: { containers: [{ image: "a" }, { image: "b" }] }, gone: null, "x-y": 1 };
  assert.deepEqual(evaluateJsonPath(doc, "$.image"), { found: true, value: doc.image });
  assert.deepEqual(evaluateJsonPath(doc, "$.spec.containers[1].image"), { found: true, value: "b" });
  assert.deepEqual(evaluateJsonPath(doc, "$.x-y"), { found: true, value: 1 });
  assert.deepEqual(evaluateJsonPath(doc, "$.gone"), { found: true, value: null });
  assert.deepEqual(evaluateJsonPath(doc, "$"), { found: true, value: doc });
  assert.equal(evaluateJsonPath(doc, "$.spec.containers[5]").found, false);
  assert.match(evaluateJsonPath(doc, "$.nope").reason, /no member "nope"/);
  assert.match(evaluateJsonPath(doc, "$.image.tag").reason, /not an object/);
  assert.match(evaluateJsonPath(doc, "$.image[0]").reason, /not an array/);
  assert.deepEqual(evaluateJsonPath(["a"], "$[0]"), { found: true, value: "a" });
});

test("json-path: anything outside the documented subset is rejected", () => {
  for (const bad of ["image", "$..image", "$.a[*]", "$['a']", "$.a[-1]", "$.a[01]", "$ .a"]) {
    assert.throws(() => parseJsonPath(bad), TypeError, bad);
  }
});

// --- registry ------------------------------------------------------------------------------------

test("createAdapter builds each adapter from its settings and refuses a missing block with 24", () => {
  const adapters = workspaceValue().adapters;
  const runtime = { env: {} };
  assert.equal(createAdapter("azure-appservice", adapters, runtime).name, "azure-appservice");
  assert.equal(createAdapter("kubernetes", adapters, runtime).name, "kubernetes");
  assert.equal(createAdapter("compose", adapters, runtime).name, "compose");
  expectEngineError(assert, () => createAdapter("command", adapters, runtime), { exitCode: 24, pointer: "/adapters/command" });
  expectEngineError(assert, () => createAdapter("azure-containerapp", adapters, runtime), { exitCode: 24, pointer: "/adapters/azure-containerapp" });
  assert.deepEqual(ADAPTER_BINARIES, { "azure-appservice": "az", "azure-containerapp": "az", kubernetes: "kubectl", compose: "docker", command: null });
});

// --- the optional adapters.command.discoverArgv key ----------------------------------------------

test("28/Assumption 6: adapters.command.discoverArgv is optional, ordered and validated", () => {
  const WS = "acme-platform/.release-radar/workspace.json";
  const plain = workspaceValue();
  plain.adapters.command = { timeoutSeconds: 5 };
  checkWorkspace(validate(plain, WORKSPACE_SCHEMA, WS), WS);

  const withList = workspaceValue();
  withList.adapters.command = { timeoutSeconds: 5, discoverArgv: ["acme-ctl", "list", "--names"] };
  const parsed = validate(withList, WORKSPACE_SCHEMA, WS);
  assert.deepEqual(parsed.adapters.command.discoverArgv, ["acme-ctl", "list", "--names"]);
  assert.equal(classify(text(withList), WORKSPACE_SCHEMA, WS).state, "canonical", "argv order is kept, not sorted");

  const empty = workspaceValue();
  empty.adapters.command = { timeoutSeconds: 5, discoverArgv: [] };
  expectEngineError(assert, () => validate(empty, WORKSPACE_SCHEMA, WS), { exitCode: 24, pointer: "/adapters/command/discoverArgv" });

  const blank = workspaceValue();
  blank.adapters.command = { timeoutSeconds: 5, discoverArgv: ["acme-ctl", ""] };
  expectEngineError(assert, () => validate(blank, WORKSPACE_SCHEMA, WS), { exitCode: 24, pointer: "/adapters/command/discoverArgv/1" });

  const unknown = workspaceValue();
  unknown.adapters.command = { timeoutSeconds: 5, listArgv: ["x"] };
  expectEngineError(assert, () => validate(unknown, WORKSPACE_SCHEMA, WS), { exitCode: 24, pointer: "/adapters/command/listArgv" });
});
