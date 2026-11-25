import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKLIST_HEADER, classifyChecklist, parseChecklist, renderChecklist } from "../dist/checklist.js";

const FILE = "checks.md";

const CANONICAL = `# release-radar checklist

schemaVersion: 1

## db-migrations
- layer: fleet
- severity: blocker
- paths: migrations/**, src/db/schema.ts
- signal: A new or changed migration file.
- prepare: Run the migration against a copy of stage-1 data.
    Confirm the rollback script exists:
      - forward and back on an empty database
      - forward and back on a seeded database

## env-vars
- layer: fleet
- severity: high
- paths: .env.example
- signal: A new required environment variable.
- prepare: Add the setting to every stage before promoting.
`;

/** Asserts the text is invalid (exit 24) at line/column with a message matching `pattern`. */
function assertInvalid(text, line, column, pattern, layer = "fleet") {
  const result = classifyChecklist(text, FILE, layer);
  assert.equal(result.state, "invalid", `expected invalid: ${pattern}`);
  assert.equal(result.error.exitCode, 24);
  assert.deepEqual(result.error.location, { file: FILE, line, column }, result.error.message);
  assert.match(result.error.message, pattern);
  assert.throws(() => parseChecklist(text, FILE, layer), (error) => error.exitCode === 24);
}

/** Asserts the text is non-canonical, normalises to CANONICAL, with exactly `changes`. */
function assertNormalises(text, changes) {
  const result = classifyChecklist(text, FILE, "fleet");
  assert.equal(result.state, "non-canonical");
  assert.equal(result.rendered, CANONICAL);
  assert.deepEqual(result.changes, changes);
  assert.deepEqual(result.value, parseChecklist(CANONICAL, FILE, "fleet"));
}

test("canonical checklist parses to the expected model and classifies canonical", () => {
  const model = parseChecklist(CANONICAL, FILE, "fleet");
  assert.deepEqual(model, {
    schemaVersion: 1,
    items: [
      {
        id: "db-migrations",
        layer: "fleet",
        severity: "blocker",
        paths: ["migrations/**", "src/db/schema.ts"],
        signal: "A new or changed migration file.",
        prepare:
          "Run the migration against a copy of stage-1 data.\nConfirm the rollback script exists:\n  - forward and back on an empty database\n  - forward and back on a seeded database",
      },
      {
        id: "env-vars",
        layer: "fleet",
        severity: "high",
        paths: [".env.example"],
        signal: "A new required environment variable.",
        prepare: "Add the setting to every stage before promoting.",
      },
    ],
  });
  const result = classifyChecklist(CANONICAL, FILE, "fleet");
  assert.equal(result.state, "canonical");
  assert.equal(result.rendered, CANONICAL);
  assert.deepEqual(result.changes, []);
  assert.equal(CANONICAL.split("\n")[0], CHECKLIST_HEADER);
});

test("round trip: render(parse(x)) == x and format(format(x)) == format(x)", () => {
  assert.equal(renderChecklist(parseChecklist(CANONICAL, FILE, "fleet")), CANONICAL);
  const once = classifyChecklist(CANONICAL.replace("- layer: fleet\n- severity: high", "- severity: high\n- layer: fleet"), FILE, "fleet").rendered;
  assert.equal(classifyChecklist(once, FILE, "fleet").rendered, once);
  assert.equal(classifyChecklist(once, FILE, "fleet").state, "canonical");
});

test("an empty checklist (no items) is valid and canonical", () => {
  const text = `${CHECKLIST_HEADER}\n\nschemaVersion: 1\n`;
  assert.deepEqual(parseChecklist(text, FILE, "component"), { schemaVersion: 1, items: [] });
  assert.equal(classifyChecklist(text, FILE, "component").state, "canonical");
});

test("renderChecklist sorts items by id regardless of model order", () => {
  const model = parseChecklist(CANONICAL, FILE, "fleet");
  assert.equal(renderChecklist({ ...model, items: [...model.items].reverse() }), CANONICAL);
});

test("field-order variation → normalised", () => {
  const text = CANONICAL.replace(
    "- layer: fleet\n- severity: high\n- paths: .env.example\n- signal: A new required environment variable.\n",
    "- signal: A new required environment variable.\n- paths: .env.example\n- severity: high\n- layer: fleet\n",
  );
  assertNormalises(text, ['field order normalised in item "env-vars" (line 15)']);
});

test("indentation variation → normalised (structural lines indented, continuation by 2, by 6, by tab)", () => {
  const text = CANONICAL.replace("- severity: blocker", "  - severity: blocker")
    .replace("## env-vars", " ## env-vars")
    .replace(
      "    Confirm the rollback script exists:\n      - forward and back on an empty database\n      - forward and back on a seeded database",
      "  Confirm the rollback script exists:\n    - forward and back on an empty database\n    - forward and back on a seeded database",
    );
  assertNormalises(text, ["whitespace and indentation normalised"]);

  const deeper = CANONICAL.replace(
    "    Confirm the rollback script exists:\n      - forward and back on an empty database\n      - forward and back on a seeded database",
    "\tConfirm the rollback script exists:\n\t  - forward and back on an empty database\n          - forward and back on a seeded database",
  );
  // base indent = the least-indented continuation (tab = 4 columns); deeper lines keep their extra indent
  const deeperResult = classifyChecklist(deeper, FILE, "fleet");
  assert.equal(deeperResult.state, "non-canonical");
  assert.equal(
    deeperResult.rendered,
    CANONICAL.replace("      - forward and back on a seeded database", "          - forward and back on a seeded database"),
  );
});

test("whitespace variation → normalised (blank lines, trailing spaces, spacing around ':' and in paths)", () => {
  const text = `\n\n${CANONICAL}`
    .replace("schemaVersion: 1\n\n", "schemaVersion:1\n\n\n")
    .replace("- paths: migrations/**, src/db/schema.ts", "- paths:migrations/** ,src/db/schema.ts   ")
    .replace("- signal: A new or changed migration file.", "- signal:    A new or changed migration file.")
    .replace("\n## env-vars", "\n\n\n## env-vars")
    .replace("- layer: fleet\n- severity: high", "- layer: fleet\n\n- severity: high")
    .replace(/\n$/, "");
  assertNormalises(text, ["whitespace and indentation normalised"]);
});

test("CRLF and BOM → normalised and reported", () => {
  assertNormalises(`﻿${CANONICAL.replace(/\n/g, "\r\n")}`, ["byte-order mark removed", "line endings normalised (CRLF to LF)"]);
});

test("unsorted items → sorted by id", () => {
  const [head, first, second] = CANONICAL.split(/\n(?=## )/);
  assertNormalises(`${head}\n${second}\n${first}`, ["items sorted by id"]);
});

test("duplicate identical item → removed and reported (even with another field order)", () => {
  const envItem = CANONICAL.slice(CANONICAL.indexOf("## env-vars"));
  const reordered = envItem.replace("- layer: fleet\n- severity: high", "- severity: high\n- layer: fleet");
  assertNormalises(`${CANONICAL}\n${reordered}`, [
    'field order normalised in item "env-vars" (line 22)',
    'duplicate item "env-vars" removed (line 22, identical to line 15)',
  ]);
});

test("multi-line values: first line may start on a continuation line; paths may wrap", () => {
  const text = CANONICAL.replace("- signal: A new required environment variable.", "- signal:\n    A new required environment variable.").replace(
    "- paths: migrations/**, src/db/schema.ts",
    "- paths: migrations/**,\n    src/db/schema.ts",
  );
  assertNormalises(text, ["whitespace and indentation normalised"]);
});

test("invalid: unknown field", () => {
  assertInvalid(CANONICAL.replace("- signal: A new required", "- owner: team-a\n- signal: A new required"), 19, 3, /unknown field "owner"/);
});

test("invalid: missing field (located at the item heading)", () => {
  assertInvalid(CANONICAL.replace("- severity: high\n", ""), 15, 4, /item "env-vars" is missing field "severity"/);
});

test("invalid: duplicated field", () => {
  assertInvalid(CANONICAL.replace("- severity: high\n", "- severity: high\n- severity: low\n"), 18, 3, /duplicate field "severity"/);
});

test("invalid: prose outside the grammar", () => {
  assertInvalid(CANONICAL.replace("## env-vars", "Some notes for reviewers.\n\n## env-vars"), 15, 1, /outside the checklist grammar/);
  assertInvalid(CANONICAL.replace("schemaVersion: 1\n", "schemaVersion: 1\n\nIntro paragraph.\n"), 5, 1, /outside the checklist grammar/);
  assertInvalid(CANONICAL.replace("## env-vars", "### details\n\n## env-vars"), 15, 1, /malformed heading/);
  assertInvalid(CANONICAL.replace("## env-vars\n", "## env-vars\n    stray indented text\n"), 16, 5, /does not continue a field value/);
  assertInvalid(CANONICAL.replace("- severity: high", "-severity: high"), 17, 1, /malformed field line/);
});

test("invalid: bad severity and bad layer value", () => {
  assertInvalid(CANONICAL.replace("- severity: high", "- severity: urgent"), 17, 13, /severity "urgent" is not one of: blocker, high, medium, low, info/);
  assertInvalid(CANONICAL.replace("- layer: fleet\n- severity: high", "- layer: stage\n- severity: high"), 16, 10, /layer "stage" is not one of/);
  assertInvalid(CANONICAL.replace("- severity: high", "- severity: high\n    and more"), 17, 13, /must be a single line/);
});

test("invalid: layer does not match the file's location", () => {
  assertInvalid(CANONICAL, 6, 10, /layer "fleet" does not match this checklist's location \(expected "component"\)/, "component");
});

test("invalid: duplicate id with different content (located at the second heading)", () => {
  const envItem = CANONICAL.slice(CANONICAL.indexOf("## env-vars")).replace("severity: high", "severity: low");
  assertInvalid(`${CANONICAL}\n${envItem}`, 22, 4, /duplicate id "env-vars" with different content \(first at line 15\)/);
});

test("invalid: header, schemaVersion, ids and empty values", () => {
  assertInvalid(CANONICAL.replace(CHECKLIST_HEADER, "# Checklist"), 1, 1, /expected header line "# release-radar checklist"/);
  assertInvalid("", 1, 1, /missing header line/);
  assertInvalid(`${CHECKLIST_HEADER}\n`, 2, 1, /missing "schemaVersion/);
  assertInvalid(CANONICAL.replace("schemaVersion: 1", "schemaVersion: 2"), 3, 16, /unsupported schemaVersion 2 \(supported: 1\)/);
  assertInvalid(CANONICAL.replace("schemaVersion: 1", "schemaVersion: one"), 3, 16, /must be an integer/);
  assertInvalid(CANONICAL.replace("schemaVersion: 1\n", ""), 4, 1, /expected "schemaVersion/);
  assertInvalid(CANONICAL.replace("## env-vars", "## Env_Vars"), 15, 4, /invalid item id "Env_Vars"/);
  assertInvalid(CANONICAL.replace("- signal: A new required environment variable.", "- signal:"), 19, 10, /empty value for field "signal"/);
  assertInvalid(CANONICAL.replace("- paths: .env.example", "- paths: .env.example,"), 18, 10, /empty entry in paths/);
  assertInvalid("- layer: fleet\n", 1, 1, /expected header line/);
});

test("parse with CRLF reports the same line and column as with LF", () => {
  const text = CANONICAL.replace("- severity: high", "- severity: urgent").replace(/\n/g, "\r\n");
  assertInvalid(text, 17, 13, /severity "urgent"/);
});

test("paths: commas inside {…} and […] belong to the glob; unbalanced brackets are invalid", async () => {
  const { splitGlobList } = await import("../dist/checklist.js");
  assert.deepEqual(splitGlobList("src/{api,worker}/**, config/[a,b].json, docs/**"),
    ["src/{api,worker}/**", " config/[a,b].json", " docs/**"]);
  assert.match(String(splitGlobList("src/{api,worker/**")), /unclosed "\{"/);
  assert.match(String(splitGlobList("src/api}/**")), /unbalanced "\}"/);

  const text = CANONICAL.replace("- paths: migrations/**, src/db/schema.ts",
    "- paths: migrations/**,src/{db,cache}/schema.ts");
  const result = classifyChecklist(text, FILE, "fleet");
  assert.equal(result.state, "non-canonical");
  assert.ok(result.rendered.includes("- paths: migrations/**, src/{db,cache}/schema.ts\n"));

  const broken = CANONICAL.replace("- paths: migrations/**, src/db/schema.ts", "- paths: src/{db,cache/schema.ts");
  const bad = classifyChecklist(broken, FILE, "fleet");
  assert.equal(bad.state, "invalid");
  assert.equal(bad.error.exitCode, 24);
  assert.match(bad.error.message, /unclosed "\{" in paths/);
});
