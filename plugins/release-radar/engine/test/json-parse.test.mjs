import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonStrict, parseJsonWithPositions } from "../dist/format.js";

/** Asserts that parsing `text` throws EngineError 24 at the given line/column. */
function assertSyntaxError(text, line, column, messagePart) {
  assert.throws(
    () => parseJsonStrict(text, "sample.json"),
    (error) => {
      assert.equal(error.name, "EngineError");
      assert.equal(error.exitCode, 24);
      assert.equal(error.phase, "parse");
      assert.equal(error.location.file, "sample.json");
      assert.equal(error.location.line, line, `line for: ${error.message}`);
      assert.equal(error.location.column, column, `column for: ${error.message}`);
      assert.match(error.message, messagePart);
      return true;
    },
  );
}

test("parses valid JSON and keeps input key order", () => {
  const value = parseJsonStrict('{"b": 1, "a": [true, false, null, "x", -1.5e2]}', "f");
  assert.deepEqual(value, { b: 1, a: [true, false, null, "x", -150] });
  assert.deepEqual(Object.keys(value), ["b", "a"]);
});

test("a '__proto__' key is an ordinary own key, never a prototype change", () => {
  const value = parseJsonStrict('{"__proto__": {"polluted": true}}', "f");
  assert.ok(Object.hasOwn(value, "__proto__"));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test("syntax errors report the exact line and column", () => {
  assertSyntaxError('{\n  "a": 1\n  "b": 2\n}', 3, 3, /expected ',' or '}'/);
  assertSyntaxError('{\n  "a": [1, 2,]\n}', 2, 14, /trailing comma/);
  assertSyntaxError('{"a": 1,}', 1, 9, /trailing comma/);
  assertSyntaxError('{"a" 1}', 1, 6, /expected ':'/);
  assertSyntaxError("{'a': 1}", 1, 2, /expected a string key/);
  assertSyntaxError('{"a": tru}', 1, 7, /unexpected character "t"/);
  assertSyntaxError('{\n  "a": "unterminated\n}', 2, 21, /control character in string/);
  assertSyntaxError('"abc', 1, 1, /unterminated string/);
  assertSyntaxError('"a\\x"', 1, 3, /invalid escape/);
  assertSyntaxError("", 1, 1, /unexpected end of input/);
  assertSyntaxError("  \n", 2, 1, /unexpected end of input/);
  assertSyntaxError('{"a": 1}\n{"b": 2}', 2, 1, /unexpected content after the JSON value/);
  assertSyntaxError('{"a": 1e400}', 1, 7, /out of range/);
});

test("comments outside strings are invalid with their location", () => {
  assertSyntaxError('{\n  // note\n  "a": 1\n}', 2, 3, /comments are not allowed.*line comment/);
  assertSyntaxError('{\n  "a": 1, /* note */\n  "b": 2\n}', 2, 11, /comments are not allowed.*block comment/);
  assertSyntaxError('{"a": 1} // trailing', 1, 10, /comments are not allowed/);
});

test("comment-like text inside strings is content, not a comment", () => {
  assert.deepEqual(parseJsonStrict('{"url": "https://x.example.com/a/*b*/", "c": "//"}', "f"), {
    url: "https://x.example.com/a/*b*/",
    c: "//",
  });
});

test("duplicate keys are invalid (JSON.parse would silently keep the last)", () => {
  assert.throws(
    () => parseJsonStrict('{\n  "a": 1,\n  "a": 2\n}', "f"),
    (error) => error.exitCode === 24 && error.location.line === 3 && error.location.column === 3 && error.location.pointer === "/a",
  );
});

test("BOM and CRLF are accepted (formatting, not content); columns exclude the BOM", () => {
  assert.deepEqual(parseJsonStrict('﻿{"a": 1}', "f"), { a: 1 });
  assert.deepEqual(parseJsonStrict('{\r\n  "a": 1\r\n}\r\n', "f"), { a: 1 });
  assertSyntaxError('﻿{"a" 1}', 1, 6, /expected ':'/);
  assertSyntaxError('{\r\n  "a": 1\r\n  "b": 2\r\n}', 3, 3, /expected ','/);
});

test("locate maps pointers to positions, falling back to the nearest ancestor", () => {
  const parsed = parseJsonWithPositions('{\n  "list": [\n    {"name": "x"}\n  ]\n}\n', "f");
  assert.deepEqual(parsed.locate(""), { line: 1, column: 1 });
  assert.deepEqual(parsed.locate("/list"), { line: 2, column: 3 });
  assert.deepEqual(parsed.locate("/list/0"), { line: 3, column: 5 });
  assert.deepEqual(parsed.locate("/list/0/name"), { line: 3, column: 6 });
  assert.deepEqual(parsed.locate("/list/0/missing"), { line: 3, column: 5 });
});
