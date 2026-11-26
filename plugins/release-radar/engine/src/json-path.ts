/**
 * The tiny JSON path subset used by `extract: { type: "json-path", path }` (the `command`
 * adapter, and the verification `version` check).
 *
 * Syntax ({@link JSON_PATH_PATTERN} in `config.ts`, validated at load time):
 * - `$` is the document root and must come first;
 * - `.key` steps into an object member; `key` is `[A-Za-z_$][A-Za-z0-9_$-]*`;
 * - `[n]` steps into an array element; `n` is a non-negative integer without leading zeros.
 *
 * Examples: `$`, `$.image`, `$.spec.containers[0].image`, `$[2].name`.
 * No wildcards, filters, quoted keys or negative indexes — a path selects at most one value.
 * Zero dependencies.
 */

import { JSON_PATH_PATTERN } from "./config.js";

/** One parsed step. */
export type JsonPathStep = { readonly kind: "key"; readonly key: string } | { readonly kind: "index"; readonly index: number };

/** Result of {@link evaluateJsonPath}. */
export type JsonPathResult =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false; readonly reason: string };

/**
 * Parses a path into steps.
 * @throws TypeError when the path is not in the supported syntax (config validation prevents this).
 */
export function parseJsonPath(path: string): JsonPathStep[] {
  if (!JSON_PATH_PATTERN.test(path)) throw new TypeError(`${JSON.stringify(path)} is not a supported JSON path ($, .key, [index])`);
  const steps: JsonPathStep[] = [];
  const step = /\.([A-Za-z_$][A-Za-z0-9_$-]*)|\[(0|[1-9][0-9]*)\]/g;
  for (const match of path.slice(1).matchAll(step)) {
    if (match[1] !== undefined) steps.push({ kind: "key", key: match[1] });
    else steps.push({ kind: "index", index: Number(match[2]) });
  }
  return steps;
}

/** Renders steps back to the path syntax (for messages). */
export function renderJsonPath(steps: readonly JsonPathStep[]): string {
  return `$${steps.map((s) => (s.kind === "key" ? `.${s.key}` : `[${s.index}]`)).join("")}`;
}

/**
 * Selects the value at `path` in a parsed JSON document. A step that does not exist (missing
 * member, index out of range, stepping into a scalar) is `found: false` with the reason; a
 * present JSON `null` is `found: true, value: null`.
 */
export function evaluateJsonPath(document: unknown, path: string): JsonPathResult {
  const steps = parseJsonPath(path);
  let current: unknown = document;
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i] as JsonPathStep;
    const at = renderJsonPath(steps.slice(0, i));
    if (s.kind === "key") {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return { found: false, reason: `${at} is not an object` };
      }
      if (!Object.hasOwn(current, s.key)) return { found: false, reason: `${at} has no member "${s.key}"` };
      current = (current as Record<string, unknown>)[s.key];
    } else {
      if (!Array.isArray(current)) return { found: false, reason: `${at} is not an array` };
      if (s.index >= current.length) return { found: false, reason: `${at} has no element ${s.index}` };
      current = current[s.index];
    }
  }
  return { found: true, value: current };
}
