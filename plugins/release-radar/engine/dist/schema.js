/**
 * Schema descriptors: plain data describing a structured JSON file — key order,
 * required/optional keys, closed sets, and the ordering kind of every array.
 *
 * Descriptors are built with the {@link t} helpers and consumed by `format.ts`
 * (validate, canonicalize, classify). `Infer<S>` gives the TypeScript type of a
 * value that validated against `S`.
 */
/** The sort-key name meaning "sort by the element itself" (arrays of scalars). */
export const SORT_BY_VALUE = "$value";
const INDEX_LIKE = /^(?:0|[1-9][0-9]*)$/;
/** True for keys JavaScript would enumerate before all others (array-index-like strings). */
export function isIndexLikeKey(key) {
    return INDEX_LIKE.test(key) && Number(key) < 4294967295;
}
function checkFields(fields) {
    const seen = new Set();
    for (const field of fields) {
        if (seen.has(field.name))
            throw new Error(`schema: duplicate field "${field.name}"`);
        if (isIndexLikeKey(field.name) || field.name === "__proto__" || field.name === "") {
            throw new Error(`schema: field name "${field.name}" cannot be kept in canonical order`);
        }
        seen.add(field.name);
    }
}
function checkVariants(discriminator, variants) {
    const names = Object.keys(variants);
    if (names.length === 0)
        throw new Error("schema: a union needs at least one variant");
    for (const name of names) {
        const tag = variants[name]?.fields.find((field) => field.name === discriminator);
        if (!tag || tag.optional || tag.schema.kind !== "literal" || tag.schema.value !== name) {
            throw new Error(`schema: union variant "${name}" must declare required field "${discriminator}" as literal "${name}"`);
        }
    }
}
/** Builders for schema descriptors. */
export const t = {
    /** A string field value. */
    string(options = {}) {
        return { kind: "string", ...options };
    },
    /** A safe integer. */
    integer(options = {}) {
        return { kind: "integer", ...options };
    },
    /** A finite number. */
    number(options = {}) {
        return { kind: "number", ...options };
    },
    /** A boolean. */
    boolean() {
        return { kind: "boolean" };
    },
    /** A string from a closed set (non-empty, no repeats). */
    enum(values) {
        if (values.length === 0 || new Set(values).size !== values.length) {
            throw new Error("schema: an enum needs distinct values");
        }
        return { kind: "enum", values };
    },
    /** Exactly `value`. */
    literal(value) {
        return { kind: "literal", value };
    },
    /** `null` or `inner`. */
    nullable(inner) {
        return { kind: "nullable", inner };
    },
    /** An array of `items` with an explicit ordering kind (see {@link ArrayOrder}). */
    array(items, options) {
        if (typeof options.order === "object" && options.order.sorted === "")
            throw new Error("schema: empty sort key");
        if (options.identity === "")
            throw new Error("schema: empty identity key");
        return { kind: "array", items, ...options };
    },
    /** A string-keyed map whose canonical key order is sorted. */
    record(values, options = {}) {
        return { kind: "record", values, ...options };
    },
    /** An object with exactly these fields, in this canonical order. */
    object(fields) {
        checkFields(fields);
        return { kind: "object", fields };
    },
    /** A required field. */
    required(name, schema) {
        return { name, schema, optional: false };
    },
    /** An optional field: omitted when absent, never defaulted. */
    optional(name, schema) {
        return { name, schema, optional: true };
    },
    /**
     * A discriminated union. Each variant must declare the discriminator as a required
     * literal field equal to its variant name.
     */
    oneOf(discriminator, variants) {
        checkVariants(discriminator, variants);
        return { kind: "union", discriminator, variants };
    },
    /** Opaque JSON data (see {@link JsonSchema}). */
    json() {
        return { kind: "json" };
    },
    /** The `schemaVersion` field type with the set of versions this engine supports. */
    schemaVersion(supported) {
        if (supported.length === 0)
            throw new Error("schema: schemaVersion needs at least one supported version");
        return { kind: "schemaVersion", supported };
    },
};
