/**
 * Structured Markdown checklists (spec requirement 80), schemaVersion 1.
 *
 * Canonical form (LF, single trailing newline, no trailing spaces):
 *
 * ```
 * # release-radar checklist
 *
 * schemaVersion: 1
 *
 * ## <id>
 * - layer: fleet | component
 * - severity: blocker | high | medium | low | info
 * - paths: <glob>, <glob>
 * - signal: <first line>
 *     <continuation line>
 * - prepare: <first line>
 * ```
 *
 * Grammar rules:
 * - Structural lines (header, `schemaVersion:`, `## <id>`, `- <field>: <value>`) may be indented
 *   by 0–3 columns on input; canonical indentation is 0.
 * - A continuation line belongs to the field above it. Any line indented by 4+ columns (a tab
 *   counts as 4) is a continuation; so is a line indented 1–3 columns that is not a structural
 *   line. Canonically every continuation line is indented by exactly 4 spaces; deeper
 *   indentation relative to the value's least-indented continuation line is preserved.
 * - Blank lines only separate; they are never part of a value.
 * - `paths` is a comma-separated glob list (order preserved, canonical separator `", "`,
 *   continuation lines are joined with a space). Commas inside `{...}` (brace alternation, e.g.
 *   `src/{api,worker}/**`) or `[...]` (character classes) belong to the glob and do not separate
 *   entries; an unbalanced bracket is invalid. `layer` and `severity` are single-line.
 * - Items are sorted by id; fields appear in the fixed order; an item identical to an earlier
 *   item with the same id is removed (reported); a different item with the same id is invalid.
 */
import { EXIT, EngineError } from "./errors.js";
import { describeEncodingChanges, normalizeLineEndings, stripBom } from "./text.js";
/** The fixed first line of every checklist. */
export const CHECKLIST_HEADER = "# release-radar checklist";
/** Checklist schema versions this engine reads and writes. */
export const CHECKLIST_SCHEMA_VERSIONS = [1];
/** Item fields, in their canonical order. */
export const CHECKLIST_FIELDS = ["layer", "severity", "paths", "signal", "prepare"];
/** Canonical indentation of continuation lines. */
export const CHECKLIST_CONTINUATION_INDENT = "    ";
/** Pattern every item id must match. */
export const CHECKLIST_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Allowed `layer` values. */
export const CHECKLIST_LAYERS = ["fleet", "component"];
/** Allowed `severity` values. */
export const CHECKLIST_SEVERITIES = ["blocker", "high", "medium", "low", "info"];
/** Leading-whitespace width in columns (tab → next multiple of 4) and in characters. */
function measureIndent(line) {
    let columns = 0;
    let length = 0;
    for (const c of line) {
        if (c === " ")
            columns++;
        else if (c === "\t")
            columns += 4 - (columns % 4);
        else
            break;
        length++;
    }
    return { columns, length };
}
const FIELD_LINE = /^-[ \t]+([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const HEADING_LINE = /^##[ \t]+(\S+)$/;
const VERSION_LINE = /^schemaVersion:[ \t]*(.*)$/;
class ChecklistScanner {
    file;
    stage = "header";
    item;
    field;
    items = [];
    schemaVersion = 0;
    constructor(file) {
        this.file = file;
    }
    fail(line, column, message) {
        throw new EngineError(EXIT.INVALID, "parse", message, { file: this.file, line, column });
    }
    scan(text) {
        const lines = text.split("\n");
        lines.forEach((raw, index) => this.scanLine(raw.trimEnd(), index + 1));
        const last = lines.length;
        if (this.stage === "header")
            this.fail(last, 1, `missing header line "${CHECKLIST_HEADER}"`);
        if (this.stage === "version")
            this.fail(last, 1, `missing "schemaVersion: <n>" line`);
    }
    scanLine(content, line) {
        if (content.trim() === "")
            return;
        const indent = measureIndent(content);
        const body = content.slice(indent.length);
        const column = indent.length + 1;
        if (indent.columns >= 4)
            return this.continuation(indent.columns, body, line, column);
        if (this.stage === "header") {
            if (!/^#[ \t]+release-radar checklist$/.test(body))
                this.fail(line, column, `expected header line "${CHECKLIST_HEADER}"`);
            this.stage = "version";
            return;
        }
        if (this.stage === "version")
            return this.versionLine(body, line, column);
        if (body.startsWith("#"))
            return this.heading(body, line, column);
        const fieldMatch = FIELD_LINE.exec(body);
        if (fieldMatch)
            return this.fieldLine(fieldMatch, line, column);
        if (indent.columns > 0 && this.field)
            return this.continuation(indent.columns, body, line, column);
        if (body.startsWith("-"))
            this.fail(line, column, `malformed field line, expected "- <field>: <value>"`);
        this.fail(line, column, "text outside the checklist grammar (expected an item heading, a field line or a continuation line)");
    }
    versionLine(body, line, column) {
        const match = VERSION_LINE.exec(body);
        if (!match)
            this.fail(line, column, `expected "schemaVersion: <n>" after the header`);
        const raw = match[1] ?? "";
        const valueColumn = column + body.length - raw.length;
        if (!/^[0-9]+$/.test(raw))
            this.fail(line, valueColumn, `schemaVersion must be an integer, got ${JSON.stringify(raw)}`);
        const version = Number(raw);
        if (!CHECKLIST_SCHEMA_VERSIONS.includes(version)) {
            this.fail(line, valueColumn, `unsupported schemaVersion ${version} (supported: ${CHECKLIST_SCHEMA_VERSIONS.join(", ")})`);
        }
        this.schemaVersion = version;
        this.stage = "items";
    }
    heading(body, line, column) {
        const match = HEADING_LINE.exec(body);
        if (!match)
            this.fail(line, column, `malformed heading, expected "## <id>"`);
        const id = match[1];
        const idColumn = column + body.indexOf(id);
        if (!CHECKLIST_ID_PATTERN.test(id))
            this.fail(line, idColumn, `invalid item id ${JSON.stringify(id)} (must match ${CHECKLIST_ID_PATTERN.source})`);
        this.item = { id, line, column: idColumn, fields: [] };
        this.items.push(this.item);
        this.field = undefined;
    }
    fieldLine(match, line, column) {
        const name = match[1];
        const value = match[2] ?? "";
        const nameColumn = column + match[0].indexOf(name);
        if (!this.item)
            this.fail(line, column, "field line outside an item (add a \"## <id>\" heading first)");
        if (!CHECKLIST_FIELDS.includes(name)) {
            this.fail(line, nameColumn, `unknown field ${JSON.stringify(name)} (allowed: ${CHECKLIST_FIELDS.join(", ")})`);
        }
        if (this.item.fields.some((field) => field.name === name)) {
            this.fail(line, nameColumn, `duplicate field ${JSON.stringify(name)} in item ${JSON.stringify(this.item.id)}`);
        }
        const valueColumn = column + match[0].length - value.length;
        this.field = { name: name, line, valueColumn, first: value.trim(), continuations: [] };
        this.item.fields.push(this.field);
    }
    continuation(columns, body, line, column) {
        if (!this.field)
            this.fail(line, column, "indented line does not continue a field value");
        this.field.continuations.push({ columns, text: body });
    }
}
// ---------------------------------------------------------------------------
// Field values
/** The value lines of a field: first line, then continuation lines dedented to their minimum. */
function valueLines(field) {
    const base = Math.min(...field.continuations.map((entry) => entry.columns));
    const rest = field.continuations.map((entry) => " ".repeat(entry.columns - base) + entry.text);
    const lines = field.first === "" ? rest : [field.first, ...rest];
    if (lines.length > 0)
        lines[0] = lines[0].trimStart();
    return lines;
}
function buildItem(raw, file, expectedLayer) {
    const fail = (line, column, message) => {
        throw new EngineError(EXIT.INVALID, "parse", message, { file, line, column });
    };
    const values = new Map();
    for (const name of CHECKLIST_FIELDS) {
        const field = raw.fields.find((entry) => entry.name === name);
        if (!field)
            return fail(raw.line, raw.column, `item ${JSON.stringify(raw.id)} is missing field ${JSON.stringify(name)}`);
        const lines = valueLines(field);
        if (lines.length === 0)
            fail(field.line, field.valueColumn, `empty value for field ${JSON.stringify(name)}`);
        if ((name === "layer" || name === "severity") && lines.length > 1) {
            fail(field.line, field.valueColumn, `field ${JSON.stringify(name)} must be a single line`);
        }
        values.set(name, lines);
    }
    const single = (name) => {
        const field = raw.fields.find((entry) => entry.name === name);
        return { value: values.get(name)[0], line: field.line, column: field.valueColumn };
    };
    const layer = single("layer");
    if (!CHECKLIST_LAYERS.includes(layer.value)) {
        fail(layer.line, layer.column, `layer ${JSON.stringify(layer.value)} is not one of: ${CHECKLIST_LAYERS.join(", ")}`);
    }
    if (layer.value !== expectedLayer) {
        fail(layer.line, layer.column, `layer ${JSON.stringify(layer.value)} does not match this checklist's location (expected ${JSON.stringify(expectedLayer)})`);
    }
    const severity = single("severity");
    if (!CHECKLIST_SEVERITIES.includes(severity.value)) {
        fail(severity.line, severity.column, `severity ${JSON.stringify(severity.value)} is not one of: ${CHECKLIST_SEVERITIES.join(", ")}`);
    }
    const pathsField = single("paths");
    const split = splitGlobList(values.get("paths").join(" "));
    if (typeof split === "string")
        fail(pathsField.line, pathsField.column, split);
    const paths = split.map((entry) => entry.trim());
    if (paths.some((entry) => entry === ""))
        fail(pathsField.line, pathsField.column, "empty entry in paths (check for doubled or trailing commas)");
    return {
        id: raw.id,
        layer: layer.value,
        severity: severity.value,
        paths,
        signal: values.get("signal").join("\n"),
        prepare: values.get("prepare").join("\n"),
    };
}
// ---------------------------------------------------------------------------
// Rendering
function renderValue(name, value) {
    const [first, ...rest] = value.split("\n");
    return [`- ${name}: ${first ?? ""}`, ...rest.map((line) => CHECKLIST_CONTINUATION_INDENT + line)].join("\n");
}
function fieldValue(item, name) {
    return name === "paths" ? item.paths.join(", ") : item[name];
}
function renderItem(item, fieldOrder) {
    return [`## ${item.id}`, ...fieldOrder.map((name) => renderValue(name, fieldValue(item, name)))].join("\n") + "\n";
}
function renderDocument(schemaVersion, items) {
    return `${CHECKLIST_HEADER}\n\nschemaVersion: ${schemaVersion}\n${items.map((item) => `\n${item}`).join("")}`;
}
function compareIds(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** Renders a checklist canonically (items sorted by id, fixed field order, 4-space continuation). */
export function renderChecklist(model) {
    const items = [...model.items].sort(compareIds);
    return renderDocument(model.schemaVersion, items.map((item) => renderItem(item, CHECKLIST_FIELDS)));
}
function analyze(text, file, expectedLayer) {
    const scanner = new ChecklistScanner(file);
    scanner.scan(normalizeLineEndings(stripBom(text)));
    const built = scanner.items.map((raw) => ({ raw, item: buildItem(raw, file, expectedLayer) }));
    const changes = [];
    for (const { raw } of built) {
        const order = raw.fields.map((field) => field.name);
        if (order.join(",") !== CHECKLIST_FIELDS.join(",")) {
            changes.push(`field order normalised in item "${raw.id}" (line ${raw.line})`);
        }
    }
    const firstById = new Map();
    const unique = [];
    for (const { raw, item } of built) {
        const rendered = renderItem(item, CHECKLIST_FIELDS);
        const first = firstById.get(item.id);
        if (!first) {
            firstById.set(item.id, { line: raw.line, rendered });
            unique.push(item);
        }
        else if (first.rendered === rendered) {
            changes.push(`duplicate item "${item.id}" removed (line ${raw.line}, identical to line ${first.line})`);
        }
        else {
            throw new EngineError(EXIT.INVALID, "parse", `duplicate id ${JSON.stringify(item.id)} with different content (first at line ${first.line})`, {
                file,
                line: raw.line,
                column: raw.column,
            });
        }
    }
    if (unique.some((item, index) => index > 0 && compareIds(unique[index - 1], item) > 0)) {
        changes.push("items sorted by id");
    }
    const inInputOrder = renderDocument(scanner.schemaVersion, built.map(({ raw, item }) => renderItem(item, raw.fields.map((field) => field.name))));
    return { model: { schemaVersion: scanner.schemaVersion, items: [...unique].sort(compareIds) }, changes, inInputOrder };
}
/**
 * Parses a checklist and returns its canonical model.
 * @param expectedLayer the layer implied by the file's location; every item must declare it.
 * @throws EngineError (exit 24, phase `parse`) with line and column: prose outside the grammar,
 *   unknown/missing/duplicated field, bad enum value, wrong layer, malformed line,
 *   unsupported schemaVersion, or a duplicate id with different content.
 */
export function parseChecklist(text, file, expectedLayer) {
    return analyze(text, file, expectedLayer).model;
}
/**
 * Classifies a checklist's text: `canonical`, `non-canonical` (with a change summary) or
 * `invalid` (EngineError 24 with line and column). Same result shape as `classify` for JSON.
 */
export function classifyChecklist(text, file, expectedLayer) {
    let analysis;
    try {
        analysis = analyze(text, file, expectedLayer);
    }
    catch (error) {
        if (error instanceof EngineError)
            return { state: "invalid", changes: [], error };
        throw error;
    }
    const rendered = renderChecklist(analysis.model);
    if (rendered === text)
        return { state: "canonical", rendered, changes: [], value: analysis.model };
    const changes = describeEncodingChanges(text);
    if (normalizeLineEndings(stripBom(text)) !== analysis.inInputOrder)
        changes.push("whitespace and indentation normalised");
    changes.push(...analysis.changes);
    if (changes.length === 0)
        changes.push("content normalised");
    return { state: "non-canonical", rendered, changes, value: analysis.model };
}
/**
 * Split a `paths` value into glob entries at top-level commas only. Commas inside `{...}` brace
 * alternation or `[...]` character classes are part of the glob. Returns the entries, or an error
 * message when a bracket is unbalanced (the caller reports it with the field's location).
 */
export function splitGlobList(value) {
    const entries = [];
    const open = [];
    let current = "";
    for (const ch of value) {
        if (ch === "{" || ch === "[")
            open.push(ch);
        else if (ch === "}" || ch === "]") {
            const expected = ch === "}" ? "{" : "[";
            if (open.pop() !== expected)
                return `unbalanced "${ch}" in paths`;
        }
        else if (ch === "," && open.length === 0) {
            entries.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    if (open.length > 0)
        return `unclosed "${open[open.length - 1]}" in paths`;
    entries.push(current);
    return entries;
}
