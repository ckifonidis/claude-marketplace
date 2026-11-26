import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, t, validate } from "../dist/format.js";
import { CANONICAL, fleetSchema } from "./fixtures/sample-schema.mjs";

const FILE = "fleet.json";

/** Applies `edit` to the canonical fixture's value and returns the edited value. */
function edited(edit) {
  const value = JSON.parse(CANONICAL);
  edit(value);
  return value;
}

/** Asserts validate() throws EngineError 24 at `pointer` with a message matching `pattern`. */
function assertInvalid(value, pointer, pattern) {
  assert.throws(
    () => validate(value, fleetSchema, FILE),
    (error) => {
      assert.equal(error.name, "EngineError");
      assert.equal(error.exitCode, 24);
      assert.equal(error.phase, "validate");
      assert.deepEqual(error.location, { file: FILE, pointer });
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test("the canonical fixture validates and is returned unchanged", () => {
  const value = JSON.parse(CANONICAL);
  assert.equal(validate(value, fleetSchema, FILE), value);
});

test("unknown key → 24 at the key's pointer", () => {
  assertInvalid(edited((v) => (v.extra = 1)), "/extra", /unknown key "extra"/);
  assertInvalid(edited((v) => (v.components[1].port = 80)), "/components/1/port", /unknown key "port"/);
});

test("missing required key → 24 naming the missing key", () => {
  assertInvalid(edited((v) => delete v.mode), "/mode", /missing required key "mode"/);
  assertInvalid(edited((v) => delete v.components[0].image), "/components/0/image", /missing required key "image"/);
});

test("wrong type → 24 with expected and actual types", () => {
  assertInvalid(edited((v) => (v.name = 7)), "/name", /expected string, got integer/);
  assertInvalid(edited((v) => (v.components[0].replicas = "2")), "/components/0/replicas", /expected integer, got string/);
  assertInvalid(edited((v) => (v.components[0].replicas = 2.5)), "/components/0/replicas", /expected integer, got number/);
  assertInvalid(edited((v) => (v.stages = {})), "/stages", /expected array, got object/);
  assertInvalid(edited((v) => (v.enabled = "yes")), "/enabled", /expected boolean/);
  assertInvalid(edited((v) => (v.labels = [])), "/labels", /expected object, got array/);
  assertInvalid(edited((v) => (v.weight = null)), "/weight", /expected number, got null/);
});

test("enum miss and constraint violations → 24", () => {
  assertInvalid(edited((v) => (v.mode = "manual")), "/mode", /"manual" is not one of: "pipeline", "handoff"/);
  assertInvalid(edited((v) => (v.stages[0].owner = "qa")), "/stages/0/owner", /not one of/);
  assertInvalid(edited((v) => (v.stages[1].name = "Stage 1")), "/stages/1/name", /does not match/);
  assertInvalid(edited((v) => (v.components[0].replicas = 0)), "/components/0/replicas", /positive/);
  assertInvalid(edited((v) => (v.components[0].name = "")), "/components/0/name", /shorter than 1/);
  assertInvalid(edited((v) => (v.weight = -1)), "/weight", />= 0/);
  assertInvalid(edited((v) => (v.checks[1].argv = [])), "/checks/1/argv", /at least 1 item/);
  assertInvalid(edited((v) => (v.labels["Bad Key"] = "x")), "/labels/Bad Key", /does not match/);
});

test("discriminated union: unknown discriminator, missing discriminator, variant keys", () => {
  assertInvalid(edited((v) => (v.checks[0].kind = "tcp")), "/checks/0/kind", /"tcp" is not one of: "http", "smoke"/);
  assertInvalid(edited((v) => delete v.checks[0].kind), "/checks/0/kind", /missing required key "kind"/);
  assertInvalid(edited((v) => (v.checks[1].url = "x")), "/checks/1/url", /unknown key "url"/);
});

test("unsupported schemaVersion → 24, reported before any other problem", () => {
  assertInvalid(edited((v) => (v.schemaVersion = 2)), "/schemaVersion", /unsupported schemaVersion 2 \(supported: 1\)/);
  assertInvalid(
    edited((v) => {
      v.schemaVersion = 3;
      v.extra = true;
    }),
    "/schemaVersion",
    /unsupported schemaVersion 3/,
  );
  assertInvalid(edited((v) => (v.schemaVersion = "1")), "/schemaVersion", /expected integer schemaVersion/);
  assertInvalid(edited((v) => delete v.schemaVersion), "/schemaVersion", /missing required key "schemaVersion"/);
});

test("same identity with different content → 24 at the duplicate's identity key", () => {
  assertInvalid(
    edited((v) => v.components.push({ name: "acme-api", image: "registry.example.com/other" })),
    "/components/2/name",
    /duplicate name "acme-api" with different content \(first at \/components\/0\)/,
  );
  assertInvalid(
    edited((v) => v.stages.push({ name: "stage-2", owner: "ops" })),
    "/stages/2/name",
    /duplicate name "stage-2" with different content/,
  );
});

test("same identity with the same content in a different key order is a duplicate, not a conflict", () => {
  const value = edited((v) => v.components.push({ image: "registry.example.com/acme-web", name: "acme-web" }));
  assert.equal(validate(value, fleetSchema, FILE), value);
});

test("numeric record keys are rejected (they cannot be kept in canonical order)", () => {
  assertInvalid(edited((v) => (v.labels["10"] = "x")), "/labels/10", /numeric key "10" is not supported/);
});

test("optional keys are never defaulted; nullable accepts null", () => {
  const value = edited((v) => {
    delete v.description;
    delete v.checks;
    delete v.weight;
    delete v.enabled;
  });
  const result = validate(value, fleetSchema, FILE);
  assert.equal(Object.hasOwn(result, "checks"), false);
  assert.equal(Object.hasOwn(result, "description"), false);
  validate(edited((v) => (v.description = "text")), fleetSchema, FILE);
});

test("classify: invalid files carry the pointer plus the line and column of the offending key", () => {
  const unknownKey = CANONICAL.replace('"mode": "pipeline",', '"mode": "pipeline",\n  "colour": "blue",');
  const result = classify(unknownKey, fleetSchema, FILE);
  assert.equal(result.state, "invalid");
  assert.equal(result.rendered, undefined);
  assert.deepEqual(result.changes, []);
  assert.equal(result.error.exitCode, 24);
  assert.deepEqual(result.error.location, { file: FILE, pointer: "/colour", line: 5, column: 3 });

  const enumMiss = classify(CANONICAL.replace('"owner": "dev"', '"owner": "qa"'), fleetSchema, FILE);
  assert.deepEqual(enumMiss.error.location, { file: FILE, pointer: "/stages/0/owner", line: 9, column: 7 });

  const missing = classify(CANONICAL.replace('      "image": "registry.example.com/acme-web"\n', "").replace('"name": "acme-web",', '"name": "acme-web"'), fleetSchema, FILE);
  assert.equal(missing.state, "invalid");
  assert.equal(missing.error.location.pointer, "/components/1/image");
  assert.equal(missing.error.location.line, 25); // the object that lacks the key
});

test("classify: the identity conflict is located at the duplicate's key line", () => {
  const text = CANONICAL.replace(
    '      "image": "registry.example.com/acme-web"\n    }\n  ],',
    '      "image": "registry.example.com/acme-web"\n    },\n    {\n      "name": "acme-api",\n      "image": "registry.example.com/x"\n    }\n  ],',
  );
  const result = classify(text, fleetSchema, FILE);
  assert.equal(result.state, "invalid");
  assert.deepEqual(result.error.location, { file: FILE, pointer: "/components/2/name", line: 30, column: 7 });
});

test("classify: comments, syntax errors and unsupported schemaVersion are invalid with location", () => {
  const comment = classify(CANONICAL.replace('  "mode": "pipeline",', '  // the mode\n  "mode": "pipeline",'), fleetSchema, FILE);
  assert.equal(comment.state, "invalid");
  assert.equal(comment.error.exitCode, 24);
  assert.deepEqual(comment.error.location, { file: FILE, line: 4, column: 3 });

  const syntax = classify(CANONICAL.replace('"mode": "pipeline",', '"mode": "pipeline"'), fleetSchema, FILE);
  assert.deepEqual(syntax.error.location, { file: FILE, line: 5, column: 3 });

  const version = classify(CANONICAL.replace('"schemaVersion": 1', '"schemaVersion": 9'), fleetSchema, FILE);
  assert.deepEqual(version.error.location, { file: FILE, pointer: "/schemaVersion", line: 2, column: 3 });
  assert.match(version.error.message, /unsupported schemaVersion 9/);
});

test("schema builders reject descriptors that cannot be canonical", () => {
  assert.throws(() => t.object([t.required("a", t.string()), t.optional("a", t.string())]), /duplicate field/);
  assert.throws(() => t.object([t.required("0", t.string())]), /canonical order/);
  assert.throws(() => t.enum([]), /distinct/);
  assert.throws(() => t.enum(["a", "a"]), /distinct/);
  assert.throws(() => t.oneOf("kind", { a: t.object([t.required("x", t.string())]) }), /must declare required field "kind"/);
  assert.throws(() => t.oneOf("kind", { a: t.object([t.required("kind", t.literal("b"))]) }), /literal "a"/);
  assert.throws(() => t.schemaVersion([]), /at least one/);
});
