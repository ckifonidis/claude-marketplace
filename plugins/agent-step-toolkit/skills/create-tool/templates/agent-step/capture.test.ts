// FILE: src/agent-step/capture.test.ts
//
// Unit tests for the caller-digit capture primitives. Pure functions — no
// runner, no backend, no LLM. Mirrors the paginate.test.ts convention
// (node:test). The group/candidate vectors are the exact renderings the
// authoring doctrine documents (agent-step-api.md <caller_digit_capture>),
// proven against live STT captures in the host that developed the pattern.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import {
  digitsOnly,
  digitsOnlyDeep,
  callerDigits,
  callerTextParam,
  relayParam,
  exactlyOneOf,
  digitGroupsParam,
  digitCandidatesParam,
  fieldKindOf,
} from "./capture.js";

// ─── digitsOnly ──────────────────────────────────────────────────────────────
test("digitsOnly: strips separators, keeps digit order", () => {
  assert.equal(digitsOnly("70,76"), "7076");
  assert.equal(digitsOnly("12 34"), "1234");
  assert.equal(digitsOnly("48/65"), "4865");
  assert.equal(digitsOnly("012.345-678"), "012345678");
});
test("digitsOnly: passes non-strings through untouched", () => {
  assert.equal(digitsOnly(4865), 4865);
  assert.equal(digitsOnly(undefined), undefined);
  assert.equal(digitsOnly(null), null);
});

// ─── digitsOnlyDeep ──────────────────────────────────────────────────────────
test("digitsOnlyDeep: cleans every array entry", () => {
  assert.deepEqual(digitsOnlyDeep(["10,03", "100 03"]), ["1003", "10003"]);
});
test("digitsOnlyDeep: a SINGLETON array collapses to its string (['7070'] ≡ '7070')", () => {
  assert.equal(digitsOnlyDeep(["7070"]), "7070");
  assert.equal(digitsOnlyDeep(["70,70"]), "7070");
});
test("digitsOnlyDeep: non-arrays defer to digitsOnly", () => {
  assert.equal(digitsOnlyDeep("70,76"), "7076");
});

// ─── callerDigits ────────────────────────────────────────────────────────────
test("callerDigits: shape holds → value passes through", () => {
  const schema = callerDigits(/^\d{9}$/u, "not a usable capture");
  assert.equal(schema.parse("012345678"), "012345678");
});
test("callerDigits: shape fails → the COUNT-FREE message, via a refinement (no JSON-Schema pattern)", () => {
  const schema = callerDigits(/^\d{9}$/u, "not a usable capture");
  const r = schema.safeParse("0123");
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues[0]?.message, "not a usable capture");
  }
  // The refinement must be invisible to the model-facing wire schema: the
  // underlying type is a PLAIN string, carrying no pattern/length checks.
  const inner = schema._def.schema;
  assert.ok(inner instanceof z.ZodString);
  assert.equal(inner._def.checks.length, 0, "no string checks leak into the wire schema");
});

// ─── digitGroupsParam ────────────────────────────────────────────────────────
const groups = digitGroupsParam({
  shape: /^\d{9}$/u,
  message: "not a usable capture",
  describe: "test field",
});

test("digitGroupsParam: doctrine vector — number-word groups join to the nine digits", () => {
  // «δεκαεπτά, είκοσι ένα, πενήντα δύο, δύο, ογδόντα δύο» → ["17","21","52","2","82"]
  assert.equal(groups.parse(["17", "21", "52", "2", "82"]), "172152282");
});
test("digitGroupsParam: doctrine vector — «10, 2, 22. 8078» keeps EVERY group (the regroup bug)", () => {
  assert.equal(groups.parse(["10", "2", "22", "8078"]), "102228078");
});
test("digitGroupsParam: separator-carrying groups are cleaned before the join", () => {
  assert.equal(groups.parse(["102", "228,", " 078"]), "102228078");
});
test("digitGroupsParam: a NUMERIC entry is coerced, never dropped to an empty group", () => {
  // Dropping it to "" would silently SHORTEN the capture (["17", 21] → "17")
  // and could pass the shape rule as a wrong value.
  assert.equal(groups.parse(["17", 21, "52", "2", "82"]), "172152282");
});
test("digitGroupsParam: a single string with separators parses too", () => {
  assert.equal(groups.parse("012,345,678"), "012345678");
});
test("digitGroupsParam: omission stays undefined (the carried-value channel)", () => {
  assert.equal(groups.parse(undefined), undefined);
});
test("digitGroupsParam: an unusable JOINED capture fails with the count-free message", () => {
  const r = groups.safeParse(["10", "2", "22"]); // joins to 6 digits
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues[0]?.message, "not a usable capture");
  }
});
test("digitGroupsParam: the description is the host's, verbatim", () => {
  assert.equal(groups.description, "test field");
});

// `normalize`: a host canonicaliser for captures that carry
// letters. The default must stay byte-identical to the digit strip above.
const lettered = digitGroupsParam({
  shape: /^(?=[A-Z0-9]*\d)[A-Z0-9]{8,18}$/u,
  message: "not a usable capture",
  describe: "lettered field",
  normalize: (raw) => raw.toUpperCase().replace(/[^A-Z0-9]/g, ""),
});

test("digitGroupsParam normalize: letters survive the host canonicaliser, groups still join", () => {
  assert.equal(lettered.parse(["sk", "479 482", "c"]), "SK479482C");
  assert.equal(lettered.parse("sk-479-482-c"), "SK479482C");
});
test("digitGroupsParam normalize: the shape still judges the JOINED canonical value", () => {
  assert.equal(lettered.safeParse(["AB", "12"]).success, false);
});
test("digitGroupsParam normalize: omission stays undefined, and the kind is still a capture", () => {
  assert.equal(lettered.parse(undefined), undefined);
  assert.equal(fieldKindOf(lettered), "digits");
});

// ─── digitCandidatesParam ────────────────────────────────────────────────────
const candidates = digitCandidatesParam({
  shape: /^\d{4,19}$/u,
  message: "not a usable card-digit capture",
  candidateMessage: "not a usable card-digit candidate",
  describe: "test candidates",
});

test("digitCandidatesParam: a single string cleans and parses", () => {
  assert.equal(candidates.parse("70,76"), "7076");
});
test("digitCandidatesParam: a singleton array collapses — propose/execute representation flips are not drift", () => {
  assert.equal(candidates.parse(["7070"]), "7070");
});
test("digitCandidatesParam: an ambiguous set stays an array for the executor to try", () => {
  assert.deepEqual(candidates.parse(["1003", "10003"]), ["1003", "10003"]);
});
test("digitCandidatesParam: candidate cap holds (default 3)", () => {
  const r = candidates.safeParse(["1111", "2222", "3333", "4444"]);
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues[0]?.message, "at most 3 candidates");
  }
});
test("digitCandidatesParam: a bad candidate fails with the per-candidate message", () => {
  const r = candidates.safeParse(["1234", "12"]);
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues[0]?.message, "not a usable card-digit candidate");
  }
});
test("digitCandidatesParam: omission stays undefined", () => {
  assert.equal(candidates.parse(undefined), undefined);
});
// ─── Cross-builder symmetry ──────────────────────────────────────────────────
// Both builders are optional and both reject `null`: omission is the ONE
// spelling of "absent" (header rule 5). A host driving `runSteps` directly must
// not hit a builder-dependent trap, so these are asserted side by side.
test("both builders treat omission identically — undefined passes through", () => {
  assert.equal(groups.parse(undefined), undefined);
  assert.equal(candidates.parse(undefined), undefined);
});
test("both builders reject null identically — it is not a second spelling of absent", () => {
  assert.equal(groups.safeParse(null).success, false);
  assert.equal(candidates.safeParse(null).success, false);
});

test("digitCandidatesParam: maxCandidates is honored when overridden", () => {
  const wide = digitCandidatesParam({
    shape: /^\d{4}$/u,
    message: "unusable",
    maxCandidates: 5,
    describe: "wide",
  });
  assert.deepEqual(wide.parse(["1111", "2222", "3333", "4444", "5555"]), [
    "1111",
    "2222",
    "3333",
    "4444",
    "5555",
  ]);
});

// ── The field kinds added 2026-08-15 (owner declarative-authoring pass):
// callerTextParam (the missing text analogue), relayParam, exactlyOneOf ────

test("callerTextParam: trim + bounded length as a refinement with count-free messages", () => {
  const field = callerTextParam({
    min: 2,
    max: 10,
    shortMessage: "too short capture",
    longMessage: "too long capture",
    describe: "a spoken name",
  });
  assert.equal(field.parse("  Νίκος  "), "Νίκος");
  assert.equal(field.safeParse("a").error?.issues[0].message, "too short capture");
  assert.equal(
    field.safeParse("abcdefghijk").error?.issues[0].message,
    "too long capture",
  );
  const json = JSON.stringify(toJsonSchema(field));
  assert.doesNotMatch(json, /minLength|maxLength/, "bounds must stay refinements");
  assert.match(json, /a spoken name/);
});

test("relayParam: optional described passthrough string", () => {
  const field = relayParam("exact caller words");
  assert.equal(field.parse(undefined), undefined);
  assert.equal(field.parse("την πιστωτική"), "την πιστωτική");
  assert.equal(field.safeParse(3).success, false);
  assert.match(JSON.stringify(toJsonSchema(field)), /exact caller words/);
});

test("exactlyOneOf: XOR refinement invisible to the JSON schema", () => {
  const schema = z
    .object({ a: z.string().optional(), b: z.string().optional() })
    .superRefine(exactlyOneOf(["a", "b"], "pass exactly one of a / b"));
  assert.equal(schema.safeParse({ a: "x" }).success, true);
  assert.equal(schema.safeParse({ b: "y" }).success, true);
  assert.equal(schema.safeParse({}).error?.issues[0].message, "pass exactly one of a / b");
  assert.equal(
    schema.safeParse({ a: "x", b: "y" }).error?.issues[0].message,
    "pass exactly one of a / b",
  );
  const json = JSON.stringify(toJsonSchema(schema));
  assert.doesNotMatch(json, /oneOf|anyOf.*required/, "the XOR stays out of the model schema");
});
