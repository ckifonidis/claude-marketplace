/**
 * Schema descriptors: plain data describing a structured JSON file — key order,
 * required/optional keys, closed sets, and the ordering kind of every array.
 *
 * Descriptors are built with the {@link t} helpers and consumed by `format.ts`
 * (validate, canonicalize, classify). `Infer<S>` gives the TypeScript type of a
 * value that validated against `S`.
 */

/** A string, optionally constrained by a pattern (tested as given — anchor it) and a minimum length. */
export interface StringSchema {
  readonly kind: "string";
  readonly pattern?: RegExp;
  readonly minLength?: number;
}

/** A safe integer, optionally `> 0` (`positive`) and/or `>= min`. */
export interface IntegerSchema {
  readonly kind: "integer";
  readonly positive?: boolean;
  readonly min?: number;
}

/** A finite number, optionally `> 0` (`positive`) and/or `>= min`. */
export interface NumberSchema {
  readonly kind: "number";
  readonly positive?: boolean;
  readonly min?: number;
}

/** `true` or `false`. */
export interface BooleanSchema {
  readonly kind: "boolean";
}

/** A string from a closed set. */
export interface EnumSchema<V extends string = string> {
  readonly kind: "enum";
  readonly values: readonly V[];
}

/** Values allowed by {@link LiteralSchema}. */
export type LiteralValue = string | number | boolean | null;

/** Exactly one value (used e.g. for union discriminators). */
export interface LiteralSchema<V extends LiteralValue = LiteralValue> {
  readonly kind: "literal";
  readonly value: V;
}

/** `null` or a value of the inner schema. */
export interface NullableSchema<I extends Schema = Schema> {
  readonly kind: "nullable";
  readonly inner: I;
}

/**
 * Array ordering kind.
 * - `"ordered"`: order carries meaning and is preserved (stages, argv).
 * - `{ sorted: keyPath }`: order carries no meaning; canonical order is ascending by the
 *   dotted key path (`"name"`, `"meta.name"`), or by the element itself with `"$value"`.
 *   Ties are broken by the element's canonical form, so the order is total.
 */
export type ArrayOrder = "ordered" | { readonly sorted: string };

/** The sort-key name meaning "sort by the element itself" (arrays of scalars). */
export const SORT_BY_VALUE = "$value";

/**
 * An array. `identity` (a dotted key path) names the key that identifies an entry: two
 * entries with the same identity must be identical (the duplicate is then removed) or the
 * file is invalid. Arrays that are `sorted` or declare an `identity` drop identical
 * duplicates; plain `ordered` arrays keep every entry (e.g. argv may repeat a token).
 */
export interface ArraySchema<I extends Schema = Schema> {
  readonly kind: "array";
  readonly items: I;
  readonly order: ArrayOrder;
  readonly identity?: string;
  readonly minItems?: number;
}

/**
 * A map with free string keys; canonical key order is ascending by UTF-16 code unit.
 * Keys that look like array indices (`"0"`, `"12"`) are rejected, because JavaScript
 * objects cannot keep them in canonical order.
 */
export interface RecordSchema<V extends Schema = Schema> {
  readonly kind: "record";
  readonly values: V;
  readonly keyPattern?: RegExp;
}

/** One object field. Optional fields are omitted when absent — never defaulted. */
export interface FieldSpec<N extends string = string, S extends Schema = Schema, O extends boolean = boolean> {
  readonly name: N;
  readonly schema: S;
  readonly optional: O;
}

/** An object with a closed, ordered list of fields; canonical key order is the field order. */
export interface ObjectSchema<F extends readonly FieldSpec[] = readonly FieldSpec[]> {
  readonly kind: "object";
  readonly fields: F;
}

/** A discriminated union of object schemas, selected by the string value of `discriminator`. */
export interface UnionSchema<
  D extends string = string,
  V extends Readonly<Record<string, ObjectSchema>> = Readonly<Record<string, ObjectSchema>>,
> {
  readonly kind: "union";
  readonly discriminator: D;
  readonly variants: V;
}

/** The `schemaVersion` integer: must be one of the supported versions. Checked before any other key. */
export interface SchemaVersionSchema {
  readonly kind: "schemaVersion";
  readonly supported: readonly number[];
}

/**
 * Opaque JSON data whose shape is owned by another contract (e.g. the `--json` report embedded
 * in a snapshot). Any JSON value is valid except objects with array-index-like keys (they cannot
 * be kept in canonical order). Canonical form: every object's keys sorted by UTF-16 code unit,
 * recursively; array order is kept (it may carry meaning).
 */
export interface JsonSchema {
  readonly kind: "json";
}

/** Any schema descriptor. */
export type Schema =
  | StringSchema
  | IntegerSchema
  | NumberSchema
  | BooleanSchema
  | EnumSchema
  | LiteralSchema
  | NullableSchema
  | ArraySchema
  | RecordSchema
  | ObjectSchema
  | UnionSchema
  | SchemaVersionSchema
  | JsonSchema;

type Prettify<T> = { [K in keyof T]: T[K] } & {};

type InferFields<F extends readonly FieldSpec[]> = Prettify<
  { -readonly [P in Extract<F[number], { readonly optional: false }> as P["name"]]: Infer<P["schema"]> } & {
    -readonly [P in Extract<F[number], { readonly optional: true }> as P["name"]]?: Infer<P["schema"]>;
  }
>;

/**
 * The TypeScript type of a value that validated against schema `S`.
 * The wide `Schema` type itself infers to `unknown` (keeps generic code from recursing).
 */
export type Infer<S> = [Schema] extends [S] ? unknown : InferSpecific<S>;

type InferSpecific<S> = S extends StringSchema
  ? string
  : S extends IntegerSchema | NumberSchema | SchemaVersionSchema
    ? number
    : S extends BooleanSchema
      ? boolean
      : S extends EnumSchema<infer V>
        ? V
        : S extends LiteralSchema<infer V>
          ? V
          : S extends NullableSchema<infer I>
            ? Infer<I> | null
            : S extends ArraySchema<infer I>
              ? Infer<I>[]
              : S extends RecordSchema<infer V>
                ? { [key: string]: Infer<V> }
                : S extends ObjectSchema<infer F>
                  ? InferFields<F>
                  : S extends UnionSchema<string, infer V>
                    ? { [K in keyof V]: Infer<V[K]> }[keyof V]
                    : S extends JsonSchema
                      ? unknown
                      : never;

const INDEX_LIKE = /^(?:0|[1-9][0-9]*)$/;

/** True for keys JavaScript would enumerate before all others (array-index-like strings). */
export function isIndexLikeKey(key: string): boolean {
  return INDEX_LIKE.test(key) && Number(key) < 4294967295;
}

function checkFields(fields: readonly FieldSpec[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) throw new Error(`schema: duplicate field "${field.name}"`);
    if (isIndexLikeKey(field.name) || field.name === "__proto__" || field.name === "") {
      throw new Error(`schema: field name "${field.name}" cannot be kept in canonical order`);
    }
    seen.add(field.name);
  }
}

function checkVariants(discriminator: string, variants: Readonly<Record<string, ObjectSchema>>): void {
  const names = Object.keys(variants);
  if (names.length === 0) throw new Error("schema: a union needs at least one variant");
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
  string(options: { pattern?: RegExp; minLength?: number } = {}): StringSchema {
    return { kind: "string", ...options };
  },
  /** A safe integer. */
  integer(options: { positive?: boolean; min?: number } = {}): IntegerSchema {
    return { kind: "integer", ...options };
  },
  /** A finite number. */
  number(options: { positive?: boolean; min?: number } = {}): NumberSchema {
    return { kind: "number", ...options };
  },
  /** A boolean. */
  boolean(): BooleanSchema {
    return { kind: "boolean" };
  },
  /** A string from a closed set (non-empty, no repeats). */
  enum<const V extends string>(values: readonly V[]): EnumSchema<V> {
    if (values.length === 0 || new Set(values).size !== values.length) {
      throw new Error("schema: an enum needs distinct values");
    }
    return { kind: "enum", values };
  },
  /** Exactly `value`. */
  literal<const V extends LiteralValue>(value: V): LiteralSchema<V> {
    return { kind: "literal", value };
  },
  /** `null` or `inner`. */
  nullable<I extends Schema>(inner: I): NullableSchema<I> {
    return { kind: "nullable", inner };
  },
  /** An array of `items` with an explicit ordering kind (see {@link ArrayOrder}). */
  array<I extends Schema>(items: I, options: { order: ArrayOrder; identity?: string; minItems?: number }): ArraySchema<I> {
    if (typeof options.order === "object" && options.order.sorted === "") throw new Error("schema: empty sort key");
    if (options.identity === "") throw new Error("schema: empty identity key");
    return { kind: "array", items, ...options };
  },
  /** A string-keyed map whose canonical key order is sorted. */
  record<V extends Schema>(values: V, options: { keyPattern?: RegExp } = {}): RecordSchema<V> {
    return { kind: "record", values, ...options };
  },
  /** An object with exactly these fields, in this canonical order. */
  object<const F extends readonly FieldSpec[]>(fields: F): ObjectSchema<F> {
    checkFields(fields);
    return { kind: "object", fields };
  },
  /** A required field. */
  required<const N extends string, S extends Schema>(name: N, schema: S): FieldSpec<N, S, false> {
    return { name, schema, optional: false };
  },
  /** An optional field: omitted when absent, never defaulted. */
  optional<const N extends string, S extends Schema>(name: N, schema: S): FieldSpec<N, S, true> {
    return { name, schema, optional: true };
  },
  /**
   * A discriminated union. Each variant must declare the discriminator as a required
   * literal field equal to its variant name.
   */
  oneOf<const D extends string, const V extends Readonly<Record<string, ObjectSchema>>>(
    discriminator: D,
    variants: V,
  ): UnionSchema<D, V> {
    checkVariants(discriminator, variants);
    return { kind: "union", discriminator, variants };
  },
  /** Opaque JSON data (see {@link JsonSchema}). */
  json(): JsonSchema {
    return { kind: "json" };
  },
  /** The `schemaVersion` field type with the set of versions this engine supports. */
  schemaVersion(supported: readonly number[]): SchemaVersionSchema {
    if (supported.length === 0) throw new Error("schema: schemaVersion needs at least one supported version");
    return { kind: "schemaVersion", supported };
  },
};
