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
//   3. ONE AUTHORITY — no library source file outside engine-text.ts assigns
//      a string LITERAL to a result entry's `summary`/`instruction`: engine
//      emissions route through ENGINE_TEXT, host bytes arrive as values. This
//      is the lock that keeps the F5 drift class (hard-coded literals
//      bypassing the catalog) from ever re-forming.

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

test("no library source assigns a string literal to summary/instruction (engine-text.ts is the one authority)", () => {
  // Matches `summary:` / `instruction:` followed (across whitespace/newlines)
  // by a quoted or template literal. Values (ENGINE_TEXT.*, host bytes,
  // composed strings) don't match; literals do — including the historical
  // multi-line `summary:\n  "…" + "…"` form.
  const strayLiteral = /\b(summary|instruction):\s*["'`]/;
  for (const path of libSources(SRC_DIR)) {
    const source = readFileSync(path, "utf8");
    const hit = strayLiteral.exec(source);
    if (hit) {
      const line = source.slice(0, hit.index).split("\n").length;
      assert.fail(
        `${path}:${line} assigns a string literal to summary/instruction — ` +
          "route it through ENGINE_TEXT (engine text) or a host seam (host bytes).",
      );
    }
  }
});
