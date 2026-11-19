// FILE: src/agent-step/engine-text.test.ts
//
// The engine-text invariants (4.0.0):
//
//   1. REGISTER — every entry is instruction register: engine text may not
//      contain caller-register apology/courtesy openers (the 1.x–3.x defaults'
//      "I'm sorry…", "Okay, …", "Please …" forms), because nothing in this
//      module is ever spoken.
//   2. COUNT-FREE — no entry carries a numeral or digit vocabulary, and the
//      capture-path entries additionally ban attempt/try vocabulary: a count
//      in a capture message measurably makes the model pad digits
//      (capture-bounce.test.ts pins the same rule on the wire). The composed
//      ask-contract FRAME is deliberately exempt from the attempt/digit-word
//      ban — its measured closing clause ("…its length, or its digits")
//      instructs the model NOT to speak such things and never rides a bounce
//      summary; rewording measured bytes demands a live re-measurement.
//   3. ONE AUTHORITY — no library source file outside engine-text.ts puts a
//      string LITERAL in a result entry's `summary`/`instruction` value,
//      whether assigned directly or reached through a ternary, a fallback or
//      a concatenation: engine emissions route through ENGINE_TEXT, host bytes
//      arrive as values. This is the lock that keeps the F5 drift class
//      (hard-coded literals bypassing the catalog) from ever re-forming.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINE_TEXT } from "./engine-text.js";

// ── 1. Register ────────────────────────────────────────────────────────────

test("engine text never opens in caller register", () => {
  const callerRegister = /\b(I'm sorry|Okay,|Please try again|Could you)\b/i;
  for (const [key, text] of Object.entries(ENGINE_TEXT)) {
    assert.doesNotMatch(text, callerRegister, `${key} reads as a caller line`);
  }
});

// ── 2. Count-free ──────────────────────────────────────────────────────────

// The wire-level regex from capture-bounce.test.ts, split into its two bans.
const NUMERAL_OR_DIGIT_WORD = /\d|\b(digits?|ψηφί(?:o|ο|α|ων))\b/iu;
const ATTEMPT_WORD = /\b(attempts?|tries)\b/iu;

// Entries that can ride a capture bounce / capture-adjacent turn: the full
// count-free discipline applies.
const CAPTURE_PATH_KEYS = ["invalid_params"] as const;

test("no engine-text entry carries a numeral or digit vocabulary", () => {
  for (const [key, text] of Object.entries(ENGINE_TEXT)) {
    assert.doesNotMatch(text, NUMERAL_OR_DIGIT_WORD, `${key} carries digit vocabulary`);
  }
});

test("capture-path entries also ban attempt/try vocabulary", () => {
  for (const key of CAPTURE_PATH_KEYS) {
    assert.doesNotMatch(
      ENGINE_TEXT[key],
      ATTEMPT_WORD,
      `${key} rides capture bounces and must stay fully count-free`,
    );
  }
});

// ── 3. One authority: no stray summary/instruction literals in source ─────

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled tests run from dist/agent-step/, sources live in src/agent-step/.
const SRC_DIR = join(__dirname, "..", "..", "src", "agent-step");

function libSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...libSources(path));
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    if (name === "engine-text.ts") continue;
    out.push(path);
  }
  return out;
}

/** Comments blanked (newlines kept, so offsets still map to source lines):
 *  prose such as `instruction: "…"` inside a doc comment is not an assignment. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

// `summary:` / `instruction:` followed by a quoted or template literal
// ANYWHERE in the value expression — the value runs to the first `,` `;` `{`
// or `}`. A literal directly after the colon matches, and so does one behind
// a condition (`instruction: mode === "x" ? "literal" : …`, the form that hid
// two engine strings from the direct-assignment check). The right-hand
// operand of an equality test is consumed whole — it is compared, not emitted
// — and the lookahead keeps backtracking from splitting such an operator to
// reach its quote. Values (ENGINE_TEXT.*, formatMessage(…), host bytes) and
// type annotations don't match.
const COMPARED = /[=!]==?\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`]*`)/.source;
const STRAY_LITERAL = new RegExp(
  `\\b(summary|instruction):(?:${COMPARED}|(?![=!]==?\\s*["'\`])[^,;{}"'\`])*["'\`]`,
);

/** 1-based line of the first stray literal, or null. */
function strayLiteralLine(source: string): number | null {
  const code = withoutComments(source);
  const hit = STRAY_LITERAL.exec(code);
  return hit ? code.slice(0, hit.index).split("\n").length : null;
}

test("the stray-literal check sees through conditions and ignores non-values", () => {
  const flagged = [
    'return { instruction: "Do this." };',
    "return { summary: `Did ${name}.` };",
    'return {\n  instruction:\n    "Do this." + tail,\n};',
    'return { instruction: mode === "wait" ? "Wait." : other };',
    'return { instruction: mode === "wait"\n  ? ENGINE_TEXT.a\n  : `Use ${name}.` };',
    'return { summary: given ?? "Nothing." };',
  ];
  for (const source of flagged) {
    assert.notEqual(strayLiteralLine(source), null, `missed: ${source}`);
  }
  const clean = [
    "return { instruction: ENGINE_TEXT.abort_done };",
    "return { instruction: formatMessage(ENGINE_TEXT.repeat_done, { action: name }) };",
    'return { instruction: mode === "wait" ? ENGINE_TEXT.a : ENGINE_TEXT.b };',
    'const body = { summary: typeof row.summary === "function" ? row.summary(state) : row.summary };',
    "interface Denial { instruction: string; error: string }",
    'type Row = { summary: string | ((state: unknown) => string); kind: "a" | "b" };',
    '// instruction: "a literal quoted in a comment"\nconst x = 1;',
    '/** e.g. `{ instruction: "…" }` */\nconst y = 2;',
  ];
  for (const source of clean) {
    assert.equal(strayLiteralLine(source), null, `false positive: ${source}`);
  }
});

test("no library source puts a string literal in a summary/instruction value (engine-text.ts is the one authority)", () => {
  for (const path of libSources(SRC_DIR)) {
    const line = strayLiteralLine(readFileSync(path, "utf8"));
    if (line !== null) {
      assert.fail(
        `${path}:${line} puts a string literal in a summary/instruction value — ` +
          "route it through ENGINE_TEXT (engine text) or a host seam (host bytes).",
      );
    }
  }
});
