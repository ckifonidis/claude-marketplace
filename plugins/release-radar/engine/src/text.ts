/**
 * Byte-level text helpers shared by the JSON and checklist formats.
 * A byte-order mark and CRLF line endings are formatting, not content: they make a
 * file non-canonical, never invalid.
 */

const BOM = "﻿";

/** True when the text starts with a UTF-8 byte-order mark (decoded as U+FEFF). */
export function hasBom(text: string): boolean {
  return text.startsWith(BOM);
}

/** Removes a leading byte-order mark, if any. */
export function stripBom(text: string): string {
  return hasBom(text) ? text.slice(BOM.length) : text;
}

/** Converts CRLF line endings to LF. A lone CR is left alone (it is ordinary whitespace). */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Human summaries of the encoding-level normalisations `text` needs (BOM, CRLF). */
export function describeEncodingChanges(text: string): string[] {
  const changes: string[] = [];
  if (hasBom(text)) changes.push("byte-order mark removed");
  if (text.includes("\r\n")) changes.push("line endings normalised (CRLF to LF)");
  return changes;
}

/**
 * Returns 1-based line and column for a UTF-16 offset in `text`.
 * Lines are separated by LF (a CRLF counts as one break). A leading byte-order mark
 * is not counted as a column, matching what editors display.
 */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = hasBom(text) ? 1 : 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: Math.max(1, offset - lineStart + 1) };
}
