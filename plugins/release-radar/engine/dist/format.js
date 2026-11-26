/**
 * Canonical JSON (spec requirements 79, 81, 85).
 *
 * - {@link validate}: schema check, first problem → EngineError 24 with a JSON pointer.
 * - {@link canonicalize}: schema key order, sorted unordered arrays and records,
 *   identical duplicates removed (each removal recorded).
 * - {@link render}: 2-space indent, LF, single trailing newline, no trailing spaces.
 * - {@link classify}: canonical / non-canonical (with a change summary) / invalid.
 * - {@link canonicalHash}: sha256 over a key-sorted compact form, for fingerprints and tokens.
 *
 * This module is the public entry point for the JSON format: it re-exports the parser
 * and the schema DSL.
 */
import { createHash } from "node:crypto";
import { EXIT, EngineError } from "./errors.js";
import { parseJsonWithPositions } from "./json-parse.js";
import { childPointer, getKeyPath, keyPathToPointer, setOwn } from "./pointer.js";
import { SORT_BY_VALUE, isIndexLikeKey, } from "./schema.js";
import { describeEncodingChanges, normalizeLineEndings, stripBom } from "./text.js";
export { parseJsonStrict, parseJsonWithPositions } from "./json-parse.js";
export * from "./schema.js";
// ---------------------------------------------------------------------------
// Validation
function typeName(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (typeof value === "number")
        return Number.isInteger(value) ? "integer" : "number";
    return typeof value;
}
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function quoteList(values) {
    return values.map((value) => JSON.stringify(value)).join(", ");
}
class Validator {
    file;
    constructor(file) {
        this.file = file;
    }
    fail(pointer, message) {
        throw new EngineError(EXIT.INVALID, "validate", message, { file: this.file, pointer });
    }
    expectType(value, pointer, expected) {
        return this.fail(pointer, `expected ${expected}, got ${typeName(value)}`);
    }
    check(value, schema, pointer) {
        switch (schema.kind) {
            case "string":
                if (typeof value !== "string")
                    this.expectType(value, pointer, "string");
                if (schema.minLength !== undefined && value.length < schema.minLength) {
                    this.fail(pointer, `string is shorter than ${schema.minLength} character(s)`);
                }
                if (schema.pattern && !schema.pattern.test(value)) {
                    this.fail(pointer, `${JSON.stringify(value)} does not match ${String(schema.pattern)}`);
                }
                return;
            case "integer":
            case "number":
                if (typeof value !== "number" || !Number.isFinite(value))
                    this.expectType(value, pointer, schema.kind);
                if (schema.kind === "integer" && !Number.isSafeInteger(value))
                    this.expectType(value, pointer, "integer");
                if (schema.positive && !(value > 0))
                    this.fail(pointer, `expected a positive ${schema.kind}, got ${value}`);
                if (schema.min !== undefined && value < schema.min)
                    this.fail(pointer, `expected >= ${schema.min}, got ${value}`);
                return;
            case "boolean":
                if (typeof value !== "boolean")
                    this.expectType(value, pointer, "boolean");
                return;
            case "enum":
                if (typeof value !== "string" || !schema.values.includes(value)) {
                    this.fail(pointer, `${JSON.stringify(value)} is not one of: ${quoteList(schema.values)}`);
                }
                return;
            case "literal":
                if (value !== schema.value)
                    this.fail(pointer, `expected ${JSON.stringify(schema.value)}, got ${JSON.stringify(value)}`);
                return;
            case "nullable":
                if (value !== null)
                    this.check(value, schema.inner, pointer);
                return;
            case "schemaVersion":
                if (typeof value !== "number" || !Number.isSafeInteger(value))
                    this.expectType(value, pointer, "integer schemaVersion");
                if (!schema.supported.includes(value)) {
                    this.fail(pointer, `unsupported schemaVersion ${value} (supported: ${schema.supported.join(", ")})`);
                }
                return;
            case "array":
                return this.checkArray(value, schema, pointer);
            case "record":
                return this.checkRecord(value, schema, pointer);
            case "object":
                return this.checkObject(value, schema, pointer);
            case "union":
                return this.checkUnion(value, schema, pointer);
            case "json":
                return this.checkJson(value, pointer);
        }
    }
    checkJson(value, pointer) {
        if (value === null || typeof value === "string" || typeof value === "boolean")
            return;
        if (typeof value === "number") {
            if (!Number.isFinite(value))
                this.expectType(value, pointer, "finite number");
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => this.checkJson(item, childPointer(pointer, index)));
            return;
        }
        if (!isPlainObject(value))
            this.expectType(value, pointer, "JSON data");
        for (const key of Object.keys(value)) {
            const child = childPointer(pointer, key);
            if (isIndexLikeKey(key))
                this.fail(child, `numeric key ${JSON.stringify(key)} is not supported`);
            this.checkJson(value[key], child);
        }
    }
    checkObject(value, schema, pointer) {
        if (!isPlainObject(value))
            this.expectType(value, pointer, "object");
        const known = new Set(schema.fields.map((field) => field.name));
        // schemaVersion first: a version we do not support makes every other message misleading.
        for (const field of schema.fields) {
            if (field.schema.kind === "schemaVersion" && Object.hasOwn(value, field.name)) {
                this.check(value[field.name], field.schema, childPointer(pointer, field.name));
            }
        }
        for (const key of Object.keys(value)) {
            if (!known.has(key))
                this.fail(childPointer(pointer, key), `unknown key ${JSON.stringify(key)}`);
        }
        for (const field of schema.fields) {
            const child = childPointer(pointer, field.name);
            if (!Object.hasOwn(value, field.name)) {
                if (!field.optional)
                    this.fail(child, `missing required key ${JSON.stringify(field.name)}`);
                continue;
            }
            this.check(value[field.name], field.schema, child);
        }
    }
    checkUnion(value, schema, pointer) {
        if (!isPlainObject(value))
            this.expectType(value, pointer, "object");
        const tagPointer = childPointer(pointer, schema.discriminator);
        if (!Object.hasOwn(value, schema.discriminator)) {
            this.fail(tagPointer, `missing required key ${JSON.stringify(schema.discriminator)}`);
        }
        const tag = value[schema.discriminator];
        const variant = typeof tag === "string" && Object.hasOwn(schema.variants, tag) ? schema.variants[tag] : undefined;
        if (!variant)
            this.fail(tagPointer, `${JSON.stringify(tag)} is not one of: ${quoteList(Object.keys(schema.variants))}`);
        this.checkObject(value, variant, pointer);
    }
    checkRecord(value, schema, pointer) {
        if (!isPlainObject(value))
            this.expectType(value, pointer, "object");
        for (const key of Object.keys(value)) {
            const child = childPointer(pointer, key);
            if (isIndexLikeKey(key))
                this.fail(child, `numeric key ${JSON.stringify(key)} is not supported`);
            if (schema.keyPattern && !schema.keyPattern.test(key)) {
                this.fail(child, `key ${JSON.stringify(key)} does not match ${String(schema.keyPattern)}`);
            }
            this.check(value[key], schema.values, child);
        }
    }
    checkArray(value, schema, pointer) {
        if (!Array.isArray(value))
            this.expectType(value, pointer, "array");
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            this.fail(pointer, `expected at least ${schema.minItems} item(s), got ${value.length}`);
        }
        value.forEach((item, index) => this.check(item, schema.items, childPointer(pointer, index)));
        if (schema.identity !== undefined)
            this.checkIdentities(value, schema, schema.identity, pointer);
    }
    checkIdentities(items, schema, identity, pointer) {
        const seen = new Map();
        items.forEach((item, index) => {
            const id = getKeyPath(item, identity);
            if (id === undefined)
                return;
            const key = canonicalStringify(id);
            const content = canonicalStringify(canonicalizeUntyped(item, schema.items).value);
            const first = seen.get(key);
            if (!first) {
                seen.set(key, { index, content });
            }
            else if (first.content !== content) {
                this.fail(childPointer(pointer, index) + keyPathToPointer(identity), `duplicate ${identity} ${key} with different content (first at ${childPointer(pointer, first.index)})`);
            }
        });
    }
}
/**
 * Validates `value` against `schema` and returns it typed. Never modifies or defaults anything.
 * @throws EngineError (exit 24, phase `validate`) at the first problem, with a JSON pointer
 *   naming the exact key: missing required key, unknown key, wrong type, enum miss,
 *   unsupported schemaVersion, or two entries with the same identity and different content.
 */
export function validate(value, schema, file) {
    new Validator(file).check(value, schema, "");
    return value;
}
// ---------------------------------------------------------------------------
// Canonical stringify and hashing
/**
 * Compact, recursive, key-sorted (UTF-16 code unit order) JSON. Object properties whose
 * value is `undefined` are omitted; anything that is not JSON data throws.
 * Array order is kept — canonicalize first when unordered arrays may be shuffled.
 */
export function canonicalStringify(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new TypeError("canonicalStringify: non-finite number");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
    if (isPlainObject(value)) {
        const parts = [];
        for (const key of Object.keys(value).sort()) {
            if (value[key] !== undefined)
                parts.push(`${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
        }
        return `{${parts.join(",")}}`;
    }
    throw new TypeError(`canonicalStringify: unsupported value of type ${typeof value}`);
}
/**
 * sha256 (hex) of the canonical form of `value`. With a schema, the value is canonicalized
 * first (unordered arrays sorted, identical duplicates removed), so the hash is stable under
 * any reformatting a hand edit can produce. Used for snapshot fingerprints and tokens.
 */
export function canonicalHash(value, schema) {
    const canonical = schema ? canonicalizeUntyped(value, schema).value : value;
    return createHash("sha256").update(canonicalStringify(canonical), "utf8").digest("hex");
}
// ---------------------------------------------------------------------------
// Canonicalization
function compareScalars(a, b) {
    if (a === b)
        return 0;
    if (a === undefined)
        return -1;
    if (b === undefined)
        return 1;
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    const left = typeof a === "string" ? a : canonicalStringify(a);
    const right = typeof b === "string" ? b : canonicalStringify(b);
    if (typeof a === typeof b)
        return left < right ? -1 : left > right ? 1 : 0;
    return typeof a < typeof b ? -1 : 1;
}
class Canonicalizer {
    changes = [];
    run(value, schema, pointer) {
        switch (schema.kind) {
            case "nullable":
                return value === null ? null : this.run(value, schema.inner, pointer);
            case "object":
                return this.object(value, schema, pointer);
            case "union": {
                const tag = value[schema.discriminator];
                const variant = schema.variants[tag];
                if (!variant)
                    throw new TypeError(`canonicalize: value at ${pointer || "(root)"} was not validated`);
                return this.object(value, variant, pointer);
            }
            case "record":
                return this.record(value, schema, pointer);
            case "array":
                return this.array(value, schema, pointer);
            case "json":
                return this.json(value, pointer);
            default:
                return value;
        }
    }
    json(value, pointer) {
        if (Array.isArray(value))
            return value.map((item, index) => this.json(item, childPointer(pointer, index)));
        if (!isPlainObject(value))
            return value;
        const keys = Object.keys(value);
        const sorted = [...keys].sort();
        if (keys.join("\u0000") !== sorted.join("\u0000"))
            this.changes.push(`keys sorted at ${pointer || "(root)"}`);
        const result = {};
        for (const key of sorted)
            setOwn(result, key, this.json(value[key], childPointer(pointer, key)));
        return result;
    }
    object(value, schema, pointer) {
        const present = schema.fields.filter((field) => Object.hasOwn(value, field.name)).map((field) => field.name);
        if (Object.keys(value).join("\u0000") !== present.join("\u0000")) {
            this.changes.push(`keys reordered at ${pointer || "(root)"}`);
        }
        const result = {};
        for (const field of schema.fields) {
            if (Object.hasOwn(value, field.name)) {
                setOwn(result, field.name, this.run(value[field.name], field.schema, childPointer(pointer, field.name)));
            }
        }
        return result;
    }
    record(value, schema, pointer) {
        const keys = Object.keys(value);
        const sorted = [...keys].sort();
        if (keys.join("\u0000") !== sorted.join("\u0000"))
            this.changes.push(`keys sorted at ${pointer || "(root)"}`);
        const result = {};
        for (const key of sorted)
            setOwn(result, key, this.run(value[key], schema.values, childPointer(pointer, key)));
        return result;
    }
    array(value, schema, pointer) {
        let entries = value.map((item, index) => {
            const canonical = this.run(item, schema.items, childPointer(pointer, index));
            return { value: canonical, index, content: canonicalStringify(canonical) };
        });
        const sortKey = typeof schema.order === "object" ? schema.order.sorted : undefined;
        if (sortKey !== undefined || schema.identity !== undefined)
            entries = this.dedupe(entries, pointer);
        if (sortKey !== undefined) {
            const sorted = [...entries].sort((a, b) => {
                const byKey = sortKey === SORT_BY_VALUE ? compareScalars(a.value, b.value) : compareScalars(getKeyPath(a.value, sortKey), getKeyPath(b.value, sortKey));
                return byKey !== 0 ? byKey : compareScalars(a.content, b.content);
            });
            if (sorted.some((entry, position) => entry !== entries[position]))
                this.changes.push(`array sorted at ${pointer || "(root)"}`);
            entries = sorted;
        }
        return entries.map((entry) => entry.value);
    }
    dedupe(entries, pointer) {
        const firstByContent = new Map();
        const kept = [];
        for (const entry of entries) {
            const first = firstByContent.get(entry.content);
            if (first !== undefined) {
                this.changes.push(`duplicate entry removed at ${childPointer(pointer, entry.index)} (identical to ${childPointer(pointer, first)})`);
                continue;
            }
            firstByContent.set(entry.content, entry.index);
            kept.push(entry);
        }
        return kept;
    }
}
/**
 * Canonicalizes a value that already passed {@link validate}: object keys in schema order,
 * record keys sorted, `sorted` arrays sorted, identical duplicates removed from `sorted` and
 * identity-keyed arrays. Returns the new value and a summary of every change; pointers in
 * the summary refer to positions in the input.
 */
export function canonicalizeDetailed(value, schema) {
    const { value: result, changes } = canonicalizeUntyped(value, schema);
    return { value: result, changes };
}
function canonicalizeUntyped(value, schema) {
    const canonicalizer = new Canonicalizer();
    return { value: canonicalizer.run(value, schema, ""), changes: canonicalizer.changes };
}
/** Canonical form of a validated value (see {@link canonicalizeDetailed}). */
export function canonicalize(value, schema) {
    return canonicalizeUntyped(value, schema).value;
}
// ---------------------------------------------------------------------------
// Rendering and classification
/**
 * Renders a value exactly as it is ordered: 2-space indentation, LF line endings, a single
 * trailing newline, no trailing spaces. Pass a canonicalized value to get canonical bytes.
 */
export function render(value) {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined)
        throw new TypeError("render: value is not JSON data");
    return `${text}\n`;
}
/** Removes JSON whitespace outside strings (used to tell whitespace-only differences apart). */
function stripInsignificantWhitespace(text) {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === "\\")
                out += text[++i] ?? "";
            else if (c === '"')
                inString = false;
        }
        else if (c === '"') {
            inString = true;
            out += c;
        }
        else if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") {
            out += c;
        }
    }
    return out;
}
function invalid(error) {
    if (error instanceof EngineError)
        return { state: "invalid", changes: [], error };
    throw error;
}
/**
 * Classifies the text of one structured JSON file (spec requirement 81).
 * - `canonical`: the text is byte-identical to its canonical rendering.
 * - `non-canonical`: valid, but `format` would rewrite it; `changes` says why
 *   (encoding, whitespace, keys reordered, arrays sorted, duplicates removed).
 * - `invalid`: `error` is an EngineError 24 with file, pointer and, where known, line/column.
 */
export function classify(text, schema, file) {
    let parsed;
    try {
        parsed = parseJsonWithPositions(text, file);
    }
    catch (error) {
        return invalid(error);
    }
    try {
        new Validator(file).check(parsed.value, schema, "");
    }
    catch (error) {
        if (error instanceof EngineError && error.location?.pointer !== undefined) {
            const { line, column } = parsed.locate(error.location.pointer);
            return invalid(error.withLocation({ ...error.location, line, column }));
        }
        return invalid(error);
    }
    const { value: canonical, changes: structural } = canonicalizeDetailed(parsed.value, schema);
    const rendered = render(canonical);
    if (rendered === text)
        return { state: "canonical", rendered, changes: [], value: canonical };
    const changes = describeEncodingChanges(text);
    const normalized = normalizeLineEndings(stripBom(text));
    const inInputOrder = render(parsed.value);
    if (normalized !== inInputOrder) {
        const whitespaceOnly = stripInsignificantWhitespace(normalized) === stripInsignificantWhitespace(inInputOrder);
        changes.push(whitespaceOnly ? "whitespace normalised" : "formatting normalised (whitespace, number or string-escape spelling)");
    }
    changes.push(...structural);
    if (changes.length === 0)
        changes.push("content normalised");
    return { state: "non-canonical", rendered, changes, value: canonical };
}
/**
 * Returns the canonical text for `text` (what `format` writes).
 * @throws EngineError (exit 24) when the text is invalid.
 */
export function formatText(text, schema, file) {
    const result = classify(text, schema, file);
    if (result.error)
        throw result.error;
    return result.rendered;
}
