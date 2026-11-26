import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT, EXIT_PRECEDENCE, EngineError, formatLocation, pickExitCode } from "../dist/errors.js";

test("exit-code constants match the contract", () => {
  assert.deepEqual(EXIT, {
    OK: 0,
    INTERNAL: 1,
    AUTH: 20,
    SOURCE: 21,
    DRIFT: 22,
    MISSING: 23,
    INVALID: 24,
    PIPELINE_FAILED: 25,
    REFUSED: 26,
    TOKEN: 27,
    VERIFY_FAILED: 28,
    NON_CANONICAL: 29,
    VERIFY_INCONCLUSIVE: 30,
    ARGS: 64,
  });
  assert.deepEqual(EXIT_PRECEDENCE, [64, 24, 29, 20, 26, 27, 21, 25, 23, 28, 30, 22]);
});

test("pickExitCode: every adjacent pair in the precedence order resolves to the earlier code", () => {
  for (let i = 0; i + 1 < EXIT_PRECEDENCE.length; i++) {
    const higher = EXIT_PRECEDENCE[i];
    const lower = EXIT_PRECEDENCE[i + 1];
    assert.equal(pickExitCode([lower, higher]), higher, `${higher} must beat ${lower}`);
    assert.equal(pickExitCode([higher, lower]), higher, `${higher} must beat ${lower}`);
  }
});

test("pickExitCode: full set, reversed, picks 64; examples from the spec", () => {
  assert.equal(pickExitCode([...EXIT_PRECEDENCE].reverse()), 64);
  assert.equal(pickExitCode([22, 28, 30]), 28);
  assert.equal(pickExitCode([30, 22]), 30);
  assert.equal(pickExitCode([21, 23, 25]), 21);
  assert.equal(pickExitCode(new Set([29, 20])), 29);
});

test("pickExitCode: empty or all-zero is OK; internal and unknown codes outrank everything", () => {
  assert.equal(pickExitCode([]), 0);
  assert.equal(pickExitCode([0, 0]), 0);
  assert.equal(pickExitCode([0, 22]), 22);
  assert.equal(pickExitCode([64, 1]), 1);
  assert.equal(pickExitCode([24, 99]), 1);
});

test("EngineError carries exit code, phase and location", () => {
  const error = new EngineError(24, "validate", "unknown key \"x\"", { file: "a.json", pointer: "/x", line: 3, column: 5 });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "EngineError");
  assert.equal(error.exitCode, 24);
  assert.equal(error.phase, "validate");
  assert.equal(error.message, "unknown key \"x\"");
  assert.deepEqual(error.location, { file: "a.json", pointer: "/x", line: 3, column: 5 });
  assert.equal(error.describe(), "a.json:3:5 (at /x): unknown key \"x\"");
  const moved = error.withLocation({ file: "b.json", pointer: "" });
  assert.equal(moved.exitCode, 24);
  assert.equal(moved.describe(), "b.json (at (root)): unknown key \"x\"");
  assert.equal(new EngineError(20, "preflight", "az not found").describe(), "az not found");
});

test("formatLocation renders only the known parts", () => {
  assert.equal(formatLocation({ file: "f" }), "f");
  assert.equal(formatLocation({ file: "f", line: 2 }), "f:2");
  assert.equal(formatLocation({ file: "f", line: 2, column: 9 }), "f:2:9");
  assert.equal(formatLocation({ file: "f", pointer: "/a/0" }), "f (at /a/0)");
});
