import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalHash,
  canonicalStringify,
  canonicalize,
  canonicalizeDetailed,
  classify,
  formatText,
  render,
  t,
  validate,
} from "../dist/format.js";
import { CANONICAL, HAND_EDITED, HAND_EDITED_CHANGES, fleetSchema } from "./fixtures/sample-schema.mjs";

const FILE = "fleet.json";
const format = (text) => formatText(text, fleetSchema, FILE);

/** A deterministic pseudo-random generator (mulberry32) so shuffles are reproducible. */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, next) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Recursively shuffles object key order and the order of the given unordered arrays. */
function scramble(value, next, unorderedPaths, path = "") {
  if (Array.isArray(value)) {
    const items = value.map((item, i) => scramble(item, next, unorderedPaths, `${path}/*`));
    return unorderedPaths.includes(path) ? shuffle(items, next) : items;
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of shuffle(Object.keys(value), next)) out[key] = scramble(value[key], next, unorderedPaths, `${path}/${key}`);
    return out;
  }
  return value;
}

test("the canonical fixture classifies as canonical with no changes", () => {
  const result = classify(CANONICAL, fleetSchema, FILE);
  assert.equal(result.state, "canonical");
  assert.equal(result.rendered, CANONICAL);
  assert.deepEqual(result.changes, []);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, JSON.parse(CANONICAL));
});

test("hand-edited fixture normalises to the exact canonical bytes with the expected change summary", () => {
  const result = classify(HAND_EDITED, fleetSchema, FILE);
  assert.equal(result.state, "non-canonical");
  assert.equal(result.rendered, CANONICAL);
  assert.deepEqual(result.changes, HAND_EDITED_CHANGES);
});

test("normalisation is lossless: no semantic diff beyond unordered-array order and identical duplicates", () => {
  const before = validate(JSON.parse(HAND_EDITED), fleetSchema, FILE);
  const after = JSON.parse(format(HAND_EDITED));
  assert.deepEqual(after, canonicalize(before, fleetSchema));
  assert.deepEqual(after, JSON.parse(CANONICAL));
  // Every ordered array kept its input order exactly.
  assert.deepEqual(after.checks[0].expectStatus, [204, 200]);
  assert.deepEqual(after.checks[1].argv, ["acme-cli", "--flag", "--flag"]);
  assert.deepEqual(after.stages.map((stage) => stage.name), ["stage-2", "stage-1"]);
});

test("round-trip idempotence: format(format(x)) == format(x) and the output classifies canonical", () => {
  for (const text of [CANONICAL, HAND_EDITED]) {
    const once = format(text);
    assert.equal(format(once), once);
    assert.equal(classify(once, fleetSchema, FILE).state, "canonical");
    const value = JSON.parse(once);
    assert.equal(render(canonicalize(value, fleetSchema)), once);
  }
});

test("CRLF line endings only → non-canonical, 'line endings normalised'", () => {
  const result = classify(CANONICAL.replace(/\n/g, "\r\n"), fleetSchema, FILE);
  assert.equal(result.state, "non-canonical");
  assert.equal(result.rendered, CANONICAL);
  assert.deepEqual(result.changes, ["line endings normalised (CRLF to LF)"]);
});

test("BOM only → non-canonical, 'byte-order mark removed'", () => {
  const result = classify(`﻿${CANONICAL}`, fleetSchema, FILE);
  assert.equal(result.state, "non-canonical");
  assert.equal(result.rendered, CANONICAL);
  assert.deepEqual(result.changes, ["byte-order mark removed"]);
});

test("BOM + CRLF + tabs → all three reported", () => {
  const text = `﻿${CANONICAL.replace(/ {2}/g, "\t").replace(/\n/g, "\r\n")}`;
  const result = classify(text, fleetSchema, FILE);
  assert.equal(result.rendered, CANONICAL);
  assert.deepEqual(result.changes, ["byte-order mark removed", "line endings normalised (CRLF to LF)", "whitespace normalised"]);
});

test("whitespace-only variations (missing final newline, extra blank lines, trailing spaces)", () => {
  for (const text of [CANONICAL.trimEnd(), `${CANONICAL}\n\n`, CANONICAL.replace('"acme-fleet",', '"acme-fleet",   '), `\n${CANONICAL}`]) {
    const result = classify(text, fleetSchema, FILE);
    assert.equal(result.state, "non-canonical");
    assert.equal(result.rendered, CANONICAL);
    assert.deepEqual(result.changes, ["whitespace normalised"]);
  }
});

test("number and string-escape spelling is normalised and reported as formatting", () => {
  const text = CANONICAL.replace('"weight": 1.5', '"weight": 15e-1').replace('"acme-fleet"', '"acme\\u002dfleet"');
  const result = classify(text, fleetSchema, FILE);
  assert.equal(result.rendered, CANONICAL);
  assert.deepEqual(result.changes, ["formatting normalised (whitespace, number or string-escape spelling)"]);
});

test("each structural change alone is reported precisely", () => {
  const value = () => JSON.parse(CANONICAL);
  const cases = [
    [
      (v) => ({ name: v.name, ...v }),
      ["keys reordered at (root)"],
    ],
    [
      (v) => ({ ...v, components: [...v.components].reverse() }),
      ["array sorted at /components"],
    ],
    [
      (v) => ({ ...v, components: [...v.components, v.components[1]] }),
      ["duplicate entry removed at /components/2 (identical to /components/1)"],
    ],
    [
      (v) => ({ ...v, stages: [v.stages[0], v.stages[1], v.stages[0]] }),
      ["duplicate entry removed at /stages/2 (identical to /stages/0)"],
    ],
    [
      (v) => ({ ...v, labels: { tier: "gold", owner: "team-a" } }),
      ["keys sorted at /labels"],
    ],
  ];
  for (const [edit, expected] of cases) {
    const result = classify(JSON.stringify(edit(value()), null, 2) + "\n", fleetSchema, FILE);
    assert.equal(result.state, "non-canonical");
    assert.equal(result.rendered, CANONICAL);
    assert.deepEqual(result.changes, expected);
  }
});

test("ordered arrays keep order and duplicates; identity-less sorted arrays drop identical duplicates", () => {
  const schema = t.object([
    t.required("argv", t.array(t.string(), { order: "ordered" })),
    t.required("set", t.array(t.integer(), { order: { sorted: "$value" } })),
  ]);
  const { value, changes } = canonicalizeDetailed({ argv: ["b", "a", "b"], set: [3, 1, 3, 2, 10] }, schema);
  assert.deepEqual(value, { argv: ["b", "a", "b"], set: [1, 2, 3, 10] });
  assert.deepEqual(changes, ["duplicate entry removed at /set/2 (identical to /set/0)", "array sorted at /set"]);
});

test("sort keys: dotted key paths, numeric order, deterministic tie-break on full content", () => {
  const schema = t.array(
    t.object([t.required("meta", t.object([t.required("rank", t.integer())])), t.required("note", t.string())]),
    { order: { sorted: "meta.rank" } },
  );
  const input = [
    { meta: { rank: 10 }, note: "b" },
    { meta: { rank: 2 }, note: "z" },
    { meta: { rank: 10 }, note: "a" },
  ];
  const expected = [
    { meta: { rank: 2 }, note: "z" },
    { meta: { rank: 10 }, note: "a" },
    { meta: { rank: 10 }, note: "b" },
  ];
  assert.deepEqual(canonicalize(input, schema), expected);
  assert.deepEqual(canonicalize([input[2], input[1], input[0]], schema), expected);
});

test("string sort order is by UTF-16 code unit, independent of locale", () => {
  const schema = t.array(t.string(), { order: { sorted: "$value" } });
  assert.deepEqual(canonicalize(["b", "B", "a", "Z", "é", "10", "9"], schema), ["10", "9", "B", "Z", "a", "b", "é"]);
});

test("determinism: 50 scrambled variants of the same content render to identical bytes", () => {
  const next = rng(20261125);
  const base = JSON.parse(CANONICAL);
  const unordered = ["/components", "/components/*/tags", "/checks"];
  for (let i = 0; i < 50; i++) {
    const variant = scramble(base, next, unordered);
    const indent = i % 3 === 0 ? 0 : i % 3 === 1 ? "\t" : 4;
    const text = JSON.stringify(variant, null, indent);
    assert.equal(format(text), CANONICAL, `variant ${i}`);
  }
});

test("rendering: 2-space indent, LF only, single trailing newline, no trailing spaces", () => {
  const text = render({ a: [1, { b: "x" }], c: {}, d: [] });
  assert.equal(text, '{\n  "a": [\n    1,\n    {\n      "b": "x"\n    }\n  ],\n  "c": {},\n  "d": []\n}\n');
  assert.ok(!text.includes("\r"));
  assert.ok(!/ \n/.test(text));
  assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"));
});

test("canonicalStringify: compact, keys sorted recursively, array order kept, undefined properties omitted", () => {
  assert.equal(canonicalStringify({ b: 1, a: { d: [3, 1], c: null }, u: undefined }), '{"a":{"c":null,"d":[3,1]},"b":1}');
  assert.throws(() => canonicalStringify({ a: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalStringify([undefined]), /unsupported/);
});

test("canonicalHash: sha256 of the canonical form; stable under any reformatting; sensitive to content", () => {
  const canonicalValue = JSON.parse(CANONICAL);
  const hash = canonicalHash(canonicalValue, fleetSchema);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, createHash("sha256").update(canonicalStringify(canonicalValue)).digest("hex"));
  // Hand-edited (reordered, unsorted, duplicated) content hashes the same.
  assert.equal(canonicalHash(JSON.parse(HAND_EDITED), fleetSchema), hash);
  assert.equal(canonicalHash(JSON.parse(format(HAND_EDITED)), fleetSchema), hash);
  // Without a schema, key order still never matters.
  assert.equal(canonicalHash({ b: 1, a: 2 }), canonicalHash({ a: 2, b: 1 }));
  // A semantic change, or reordering an ordered array, changes the hash.
  assert.notEqual(canonicalHash({ ...canonicalValue, name: "acme-fleet-2" }, fleetSchema), hash);
  assert.notEqual(canonicalHash({ ...canonicalValue, stages: [...canonicalValue.stages].reverse() }, fleetSchema), hash);
});

test("canonicalize never adds or defaults optional keys", () => {
  const value = JSON.parse(CANONICAL);
  delete value.checks;
  delete value.description;
  const result = canonicalize(validate(value, fleetSchema, FILE), fleetSchema);
  assert.equal(Object.hasOwn(result, "checks"), false);
  assert.equal(Object.hasOwn(result, "description"), false);
  assert.equal(Object.hasOwn(result.components[1], "replicas"), false);
});

test("formatText throws the EngineError for invalid input", () => {
  assert.throws(
    () => formatText('{"schemaVersion": 1, // x\n}', fleetSchema, FILE),
    (error) => error.exitCode === 24 && error.location.line === 1 && error.location.column === 22,
  );
});
