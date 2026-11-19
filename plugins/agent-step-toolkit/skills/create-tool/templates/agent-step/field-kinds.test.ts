// FILE: src/agent-step/field-kinds.test.ts
//
// The FIELD-KIND registry: the machine-readable answer to "what is this param,
// from the caller's point of view". Everything the validator enforces about
// asks and escalation reads through these accessors, so the vectors here are
// the contract:
//
//   1. every builder registers its kind, and plain zod registers NOTHING (the
//      library never guesses a kind it was not told);
//   2. the kind survives the way hosts actually author fields (a host wrapper
//      that passes the builder's schema through unchanged inherits it);
//   3. `objectShapeOf` reaches the shape THROUGH a refinement — reading
//      `.shape` directly is how the ask-param check silently skipped every
//      refined action;
//   4. `captureFieldsOf` counts caller-DICTATED fields only, so a judged enum
//      can never present itself as an ask target;
//   5. registering a kind changes no model-facing byte.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  callerTextParam,
  captureFieldsOf,
  digitCandidatesParam,
  digitGroupsParam,
  exactlyOneOf,
  fieldKindOf,
  fieldMetaOf,
  judgedEnum,
  judgedFlag,
  objectShapeOf,
  relayParam,
} from "./capture.js";

const digits = () =>
  digitGroupsParam({
    shape: /^\d{9}$/u,
    message: "not a usable capture",
    describe: "spoken digits",
  });

const text = () =>
  callerTextParam({
    min: 2,
    max: 120,
    shortMessage: "too short",
    longMessage: "too long",
    describe: "the name as spoken",
  });

test("every builder registers its kind; plain zod registers nothing", () => {
  assert.equal(fieldKindOf(digits()), "digits");
  assert.equal(fieldKindOf(text()), "text");
  assert.equal(fieldKindOf(relayParam("exact words")), "relay");
  assert.equal(fieldKindOf(judgedEnum(["debit", "credit"], "which kind")), "judged");
  assert.equal(fieldKindOf(judgedFlag("volunteered theft")), "judged");
  assert.equal(
    fieldKindOf(digitCandidatesParam({ shape: /^\d{4}$/u, message: "m", describe: "d" })),
    "digits",
  );
  // The library never infers: a hand-rolled param has no kind, which is what
  // makes "declare it" enforceable rather than guessable.
  assert.equal(fieldKindOf(z.string().optional()), undefined);
  assert.equal(fieldKindOf(z.enum(["a", "b"]).optional()), undefined);
});

test("field meta carries the wire type, and a judged enum carries its domain", () => {
  assert.deepEqual(fieldMetaOf(digits()), { kind: "digits", wire: "string" });
  assert.deepEqual(fieldMetaOf(judgedFlag("f")), { kind: "judged", wire: "boolean" });
  const meta = fieldMetaOf(judgedEnum(["debit", "credit", "prepaid", "dual"], "k"));
  assert.equal(meta?.wire, "string");
  assert.deepEqual([...(meta?.values ?? [])], ["debit", "credit", "prepaid", "dual"]);
});

test("a host wrapper that passes the schema through inherits the kind", () => {
  // This is exactly `shared/fields.ts`'s `digitCaptureField`: it composes the
  // describe and hands the builder's schema back untouched. Identity-keyed
  // registration is what makes that work — and what would silently DROP the
  // kind if a wrapper appended `.optional()` after the fact.
  const hostField = (tail: string) =>
    digitGroupsParam({ shape: /^\d{4,19}$/u, message: "m", describe: `prefix ${tail}` });
  assert.equal(fieldKindOf(hostField("examples")), "digits");
});

test("objectShapeOf reaches the shape through a refinement (the skipped-check bug)", () => {
  const plain = z.object({ spokenDigits: digits() });
  const refined = z
    .object({ spokenDigits: digits(), cardKind: judgedEnum(["debit", "credit"], "k") })
    .superRefine(exactlyOneOf(["spokenDigits", "cardKind"], "exactly one"));

  assert.deepEqual(Object.keys(objectShapeOf(plain) ?? {}), ["spokenDigits"]);
  // `.shape` is undefined on the ZodEffects wrapper — reading it directly
  // returned undefined and the caller treated that as "nothing to check".
  assert.equal((refined as { shape?: unknown }).shape, undefined);
  assert.deepEqual(Object.keys(objectShapeOf(refined) ?? {}), ["spokenDigits", "cardKind"]);
});

test("objectShapeOf returns undefined only when no object is reachable", () => {
  assert.equal(objectShapeOf(z.string()), undefined);
  assert.equal(objectShapeOf(undefined), undefined);
});

test("captureFieldsOf counts caller-dictated fields only", () => {
  const params = z
    .object({
      spokenDigits: digits(),
      cardKind: judgedEnum(["debit", "credit"], "k"),
      spokenKindWords: relayParam("exact words"),
      stolen: judgedFlag("theft"),
    })
    .superRefine(exactlyOneOf(["spokenDigits", "cardKind"], "one"));

  assert.deepEqual(captureFieldsOf(params), [{ name: "spokenDigits", kind: "digits" }]);

  // A text capture counts too; a params object with no capture at all is the
  // shape that legitimately declares no escalation.
  assert.deepEqual(captureFieldsOf(z.object({ fullName: text() })), [
    { name: "fullName", kind: "text" },
  ]);
  assert.deepEqual(captureFieldsOf(z.object({ stolen: judgedFlag("t") })), []);
  assert.deepEqual(captureFieldsOf(z.object({})), []);
});

test("registering a kind changes no model-facing byte and no parse behaviour", () => {
  const field = digits();
  // The describe is still the host's, verbatim (capture.ts header rule: the
  // library ships no wording).
  assert.equal(field.description, "spoken digits");
  // Grouped capture still joins in the preprocess, and the shape rule is still
  // a refinement — a bad shape parses to a failure, not a schema keyword.
  assert.equal(field.safeParse(["17", "21", "52", "2", "82"]).data, "172152282");
  assert.equal(field.safeParse("12345678").success, false);
  assert.equal(field.safeParse(undefined).success, true);
  // Judged fields stay optional enums/booleans on the wire.
  assert.equal(judgedEnum(["debit"], "k").safeParse(undefined).success, true);
  assert.equal(judgedEnum(["debit"], "k").safeParse("credit").success, false);
  assert.equal(judgedFlag("f").safeParse(true).success, true);
});
