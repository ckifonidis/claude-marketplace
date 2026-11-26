// command adapter (spec requirement 28): a configured argv executed without a shell, the image
// reference extracted through the JSON path subset or a regex with a named group `image`, then
// parsed by image.ts. `acme-ctl` is a fake shim; the argv log proves exactly what ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandAdapter, discoverCommand, extractImageReference } from "../dist/adapters/command.js";
import { assertReadOnly, digestOf, rejectsWith, shimHarness } from "./fixtures/cli-shims.mjs";

const SETTINGS = { timeoutSeconds: 5 };
const JSON_TARGET = {
  name: "api",
  adapter: "command",
  argv: ["acme-ctl", "describe", "api", "--output", "json"],
  extract: { type: "json-path", path: "$.spec.containers[0].image" },
  preflightArgv: ["acme-ctl", "whoami"],
};
const REGEX_TARGET = {
  name: "api-edge",
  adapter: "command",
  argv: ["acme-ctl", "describe", "api-edge"],
  extract: { type: "regex", pattern: "image:\\s+(?<image>\\S+)" },
};
const req = (target) => ({ key: `acme-api/stage-1/${target.name}`, stage: "stage-1", target });
const IMG = "registry.example.com/acme/api:3f2a9c1";

function install(h, extra = []) {
  h.install("acme-ctl", [
    ...extra,
    { match: ["whoami"], stdout: "operator\n" },
    { match: ["describe", "api", "--output", "json"], stdout: { name: "api", spec: { containers: [{ image: IMG }] } } },
    { match: ["describe", "api-edge"], stdout: `name: api-edge\nimage: registry.example.com/acme/edge@${digestOf("e")}\nstate: up\n` },
  ]);
}

const done = (h) => assertReadOnly(assert, h.calls());

test("28: JSON-path extraction — the reference is parsed by the shared parser", async (t) => {
  const h = shimHarness(t);
  install(h);
  const [reading] = await createCommandAdapter(SETTINGS, h.runtime).read([req(JSON_TARGET)]);
  assert.equal(reading.status, "found");
  assert.equal(reading.image.kind, "image");
  assert.equal(reading.image.repository, "acme/api");
  assert.equal(reading.image.tag, "3f2a9c1");
  assert.equal(reading.state, null);
  assert.equal(reading.lastModified, null);
  assert.equal(reading.digestStatus, "not-exposed");
  assert.equal(reading.details.command, "acme-ctl describe api --output json");
  assert.deepEqual(h.calls().map((c) => c.args), [["describe", "api", "--output", "json"]], "argv passed exactly; preflight not run by read");
  done(h);
});

test("28: regex extraction with the named group `image` (multiline output, digest-pinned reference)", async (t) => {
  const h = shimHarness(t);
  install(h);
  const [reading] = await createCommandAdapter(SETTINGS, h.runtime).read([req(REGEX_TARGET)]);
  assert.equal(reading.image.digest, digestOf("e"));
  assert.equal(reading.image.repository, "acme/edge");
  done(h);
});

test("28: preflightArgv runs once per distinct argv; exit 0 = ready", async (t) => {
  const h = shimHarness(t);
  install(h);
  const result = await createCommandAdapter(SETTINGS, h.runtime).preflight([req(JSON_TARGET), req({ ...JSON_TARGET, name: "api-2" }), req(REGEX_TARGET)]);
  assert.deepEqual(result.commands, ["acme-ctl whoami"]);
  assert.deepEqual(h.calls().map((c) => c.args), [["whoami"]]);
  done(h);
});

test("20: a failing preflightArgv is a preflight failure (20)", async (t) => {
  const h = shimHarness(t);
  install(h, [{ match: ["whoami"], stderr: "not signed in\n", exit: 4 }]);
  const error = await rejectsWith(assert, createCommandAdapter(SETTINGS, h.runtime).preflight([req(JSON_TARGET)]), { exitCode: 20, name: "AuthError", message: /preflight `acme-ctl whoami` exited 4/ });
  assert.equal(error.binary, "acme-ctl");
  done(h);
});

test("20: a missing binary is AuthError naming argv[0]", async (t) => {
  const h = shimHarness(t);
  const error = await rejectsWith(assert, createCommandAdapter(SETTINGS, h.missingRuntime).read([req(JSON_TARGET)]), { exitCode: 20, message: /`acme-ctl` is not found on PATH/ });
  assert.equal(error.kind, "cli-missing");
  assert.equal(error.binary, "acme-ctl");
});

test("21: a non-zero exit is SourceError (21); its stderr is never interpreted as missing or auth", async (t) => {
  const h = shimHarness(t);
  install(h, [{ match: ["describe", "api", "--output", "json"], stderr: "Error from server (NotFound): api not found\nPlease run 'az login'\n", exit: 1 }]);
  await rejectsWith(assert, createCommandAdapter(SETTINGS, h.runtime).read([req(JSON_TARGET)]), { exitCode: 21, name: "SourceError" });
  done(h);
});

test("21: unparseable output is SourceError (21): not JSON, path absent, wrong type, regex no match", async (t) => {
  const h = shimHarness(t);
  install(h, [
    { match: ["describe", "api", "--output", "json"], stdout: "<html>not json</html>" },
    { match: ["describe", "api-edge"], stdout: "name: api-edge\nstate: up\n" },
  ]);
  const adapter = createCommandAdapter(SETTINGS, h.runtime);
  await rejectsWith(assert, adapter.read([req(JSON_TARGET)]), { exitCode: 21, message: /did not print JSON/ });
  await rejectsWith(assert, adapter.read([req(REGEX_TARGET)]), { exitCode: 21, message: /does not match the extract pattern/ });
  assert.throws(() => extractImageReference('{"spec":{}}', JSON_TARGET.extract, "x"), (e) => e.exitCode === 21 && /no member "containers"/.test(e.message));
  assert.throws(() => extractImageReference('{"spec":{"containers":[{"image":7}]}}', JSON_TARGET.extract, "x"), (e) => e.exitCode === 21 && /not a non-empty string/.test(e.message));
  done(h);
});

test("28: empty output or a JSON null at the path is `missing`, not an error", async (t) => {
  const h = shimHarness(t);
  install(h, [
    { match: ["describe", "api", "--output", "json"], stdout: { name: "api", spec: { containers: [{ image: null }] } } },
    { match: ["describe", "api-edge"], stdout: "\n" },
  ]);
  const readings = await createCommandAdapter(SETTINGS, h.runtime).read([req(JSON_TARGET), req(REGEX_TARGET)]);
  assert.deepEqual(readings.map((r) => r.status), ["missing", "missing"]);
  assert.match(readings[0].notes[0], /reported null at \$\.spec\.containers\[0\]\.image/);
  assert.match(readings[1].notes[0], /printed nothing/);
  done(h);
});

test("28: an invalid reference is reported as found with an invalid image and a note", async (t) => {
  const h = shimHarness(t);
  install(h, [{ match: ["describe", "api-edge"], stdout: "image: registry.example.com/acme/edge:bad:tag:\n" }]);
  const [reading] = await createCommandAdapter(SETTINGS, h.runtime).read([req(REGEX_TARGET)]);
  assert.equal(reading.status, "found");
  assert.equal(reading.image.kind, "invalid");
  assert.match(reading.notes[0], /invalid image reference/);
  done(h);
});

test("29: a command exceeding the configured timeout is exit 21", async (t) => {
  const h = shimHarness(t);
  install(h, [{ match: ["describe"], sleepMs: 4000, stdout: "late" }]);
  await rejectsWith(assert, createCommandAdapter({ timeoutSeconds: 1 }, h.runtime).read([req(JSON_TARGET)]), { exitCode: 21, message: /timed out after 1s/ });
  done(h);
});

test("16: the environment reaches the command unchanged (no variable added or removed)", async (t) => {
  const h = shimHarness(t);
  install(h);
  await createCommandAdapter(SETTINGS, h.runtime).read([req(JSON_TARGET)]);
  const [call] = h.calls();
  assert.equal(call.env.RR_TEST_MARKER, "passed-through");
  assert.equal(call.env.LC_ALL, process.env.LC_ALL ?? null, "LC_ALL is not overridden for configured commands");
});

test("identical argv across targets run once per read", async (t) => {
  const h = shimHarness(t);
  install(h);
  const readings = await createCommandAdapter(SETTINGS, h.runtime).read([req(JSON_TARGET), req({ ...JSON_TARGET, name: "api-copy" })]);
  assert.equal(readings.length, 2);
  assert.equal(h.calls().length, 1);
  done(h);
});

test("Assumption 6: discover runs adapters.command.discoverArgv (one candidate per line) or reports it cannot", async (t) => {
  const h = shimHarness(t);
  h.install("acme-ctl", [{ match: ["list", "--names"], stdout: "api\n\n  api-edge  \nworker\n" }]);
  assert.equal(await discoverCommand(SETTINGS, h.runtime), null);
  const candidates = await discoverCommand({ ...SETTINGS, discoverArgv: ["acme-ctl", "list", "--names"] }, h.runtime);
  assert.deepEqual(candidates.map((c) => c.fields.candidate), ["api", "api-edge", "worker"]);
  assert.deepEqual(h.calls().map((c) => c.args), [["list", "--names"]]);
  done(h);
});
