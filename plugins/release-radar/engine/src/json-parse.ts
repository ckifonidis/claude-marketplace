/**
 * Strict JSON parser with exact positions.
 *
 * Structure is scanned by hand so every syntax problem gets an exact line and column,
 * comments (`//`, `/* *\/` outside strings) are reported as such, duplicate keys are
 * rejected (JSON.parse would silently keep the last one), and every value's position is
 * remembered by JSON pointer so schema errors can be located too. Scalar tokens are
 * decoded with JSON.parse, so string and number semantics are exactly JSON's.
 *
 * A leading byte-order mark and CRLF line endings are accepted (they are formatting).
 */

import { EXIT, EngineError } from "./errors.js";
import { childPointer, parentPointer, setOwn } from "./pointer.js";
import { hasBom, lineColumnAt } from "./text.js";

/** Result of {@link parseJsonWithPositions}. */
export interface ParsedJson {
  /** The parsed value; objects keep the input key order. */
  readonly value: unknown;
  /**
   * 1-based line/column of the value at `pointer` — for an object member, of its key.
   * When the pointer does not exist (e.g. a missing key), the nearest existing ancestor is used.
   */
  locate(pointer: string): { line: number; column: number };
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const HEX4 = /^[0-9a-fA-F]{4}$/;

class JsonScanner {
  pos: number;
  readonly offsets = new Map<string, number>();

  constructor(
    private readonly text: string,
    private readonly file: string,
  ) {
    this.pos = hasBom(text) ? 1 : 0;
  }

  fail(offset: number, message: string, pointer?: string): never {
    const { line, column } = lineColumnAt(this.text, offset);
    const location = pointer === undefined ? { file: this.file, line, column } : { file: this.file, pointer, line, column };
    throw new EngineError(EXIT.INVALID, "parse", message, location);
  }

  parseDocument(): unknown {
    const value = this.parseValue("");
    this.skipWhitespace();
    if (this.pos < this.text.length) this.fail(this.pos, "unexpected content after the JSON value");
    return value;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.pos++;
        continue;
      }
      if (c === "/") {
        const next = this.text[this.pos + 1];
        if (next === "/") this.fail(this.pos, "comments are not allowed in JSON (line comment)");
        if (next === "*") this.fail(this.pos, "comments are not allowed in JSON (block comment)");
      }
      return;
    }
  }

  private parseValue(pointer: string): unknown {
    this.skipWhitespace();
    if (this.pos >= this.text.length) this.fail(this.pos, "unexpected end of input");
    if (!this.offsets.has(pointer)) this.offsets.set(pointer, this.pos);
    const c = this.text[this.pos];
    if (c === "{") return this.parseObject(pointer);
    if (c === "[") return this.parseArray(pointer);
    if (c === '"') return this.parseString();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.parseNumber();
    if (this.text.startsWith("true", this.pos)) return this.literal(4, true);
    if (this.text.startsWith("false", this.pos)) return this.literal(5, false);
    if (this.text.startsWith("null", this.pos)) return this.literal(4, null);
    return this.fail(this.pos, `unexpected character ${JSON.stringify(c)}`);
  }

  private literal(length: number, value: boolean | null): boolean | null {
    this.pos += length;
    return value;
  }

  private parseObject(pointer: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.pos++; // {
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') this.fail(this.pos, "expected a string key");
      const keyOffset = this.pos;
      const key = this.parseString();
      const member = childPointer(pointer, key);
      if (Object.hasOwn(result, key)) this.fail(keyOffset, `duplicate key ${JSON.stringify(key)}`, member);
      this.offsets.set(member, keyOffset);
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") this.fail(this.pos, "expected ':' after the key");
      this.pos++;
      setOwn(result, key, this.parseValue(member));
      this.skipWhitespace();
      const c = this.text[this.pos];
      if (c === "}") {
        this.pos++;
        return result;
      }
      if (c !== ",") this.fail(this.pos, "expected ',' or '}'");
      this.pos++;
      this.skipWhitespace();
      if (this.text[this.pos] === "}") this.fail(this.pos, "trailing comma is not allowed");
    }
  }

  private parseArray(pointer: string): unknown[] {
    const result: unknown[] = [];
    this.pos++; // [
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return result;
    }
    for (;;) {
      result.push(this.parseValue(childPointer(pointer, result.length)));
      this.skipWhitespace();
      const c = this.text[this.pos];
      if (c === "]") {
        this.pos++;
        return result;
      }
      if (c !== ",") this.fail(this.pos, "expected ',' or ']'");
      this.pos++;
      this.skipWhitespace();
      if (this.text[this.pos] === "]") this.fail(this.pos, "trailing comma is not allowed");
    }
  }

  private parseString(): string {
    const start = this.pos;
    this.pos++; // opening quote
    for (;;) {
      if (this.pos >= this.text.length) this.fail(start, "unterminated string");
      const code = this.text.charCodeAt(this.pos);
      if (code === 0x22) break;
      if (code < 0x20) this.fail(this.pos, "control character in string (must be escaped)");
      if (code === 0x5c) {
        const escape = this.text[this.pos + 1] ?? "";
        if (escape === "u") {
          if (!HEX4.test(this.text.slice(this.pos + 2, this.pos + 6))) this.fail(this.pos, "invalid \\u escape");
          this.pos += 6;
        } else if (SIMPLE_ESCAPES.has(escape)) {
          this.pos += 2;
        } else {
          this.fail(this.pos, "invalid escape sequence");
        }
        continue;
      }
      this.pos++;
    }
    this.pos++; // closing quote
    return JSON.parse(this.text.slice(start, this.pos)) as string;
  }

  private parseNumber(): number {
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (match === null) return this.fail(this.pos, "invalid number");
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail(this.pos, "number is out of range");
    this.pos += match[0].length;
    return value;
  }
}

/**
 * Parses JSON strictly and remembers where every value is.
 * @throws EngineError (exit 24, phase `parse`) with line and column on any syntax problem,
 *   comment, duplicate key or non-finite number.
 */
export function parseJsonWithPositions(text: string, file: string): ParsedJson {
  const scanner = new JsonScanner(text, file);
  const value = scanner.parseDocument();
  const offsets = scanner.offsets;
  return {
    value,
    locate(pointer: string) {
      let current = pointer;
      while (!offsets.has(current) && current !== "") current = parentPointer(current);
      return lineColumnAt(text, offsets.get(current) ?? 0);
    },
  };
}

/**
 * Parses JSON strictly (see {@link parseJsonWithPositions}) and returns the value.
 * @throws EngineError (exit 24) with exact line and column.
 */
export function parseJsonStrict(text: string, file: string): unknown {
  return parseJsonWithPositions(text, file).value;
}
