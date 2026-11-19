// FILE: src/agent-step/capture.ts
//
// Caller-digit capture primitives. Pure, domain-agnostic schema helpers for
// tool param authoring — the runner does not call them; they exist because the
// runner's own contract dictates how a caller-dictated digit param MUST be
// shaped, and every voice host was re-deriving (or missing) the same rules:
//
//   1. THE SHAPE RULE IS A REFINEMENT, NEVER `.regex()`. A `.regex()` is
//      emitted into the MODEL-FACING JSON Schema as a `pattern` keyword,
//      turning the tool's validation rule into a precondition the model must
//      satisfy BEFORE it may emit the call — the exact inversion of "the tool
//      is the validator". The model then counts digits itself (unreliable on
//      grouped STT captures) and either withholds the call or pads an invented
//      digit to fit. A refinement is invisible to JSON Schema: the model sees
//      `type: "string"` and sends what it extracted; the runner's propose-path
//      parse bounces a bad shape as recoverable `invalid_params` — before any
//      read-back and without spending a confirmation attempt.
//   2. REFINEMENT MESSAGES CARRY NO DIGIT COUNT. The runner surfaces zod issue
//      messages through the StepResult's `_debug`. The tool binding keeps
//      `_debug` off the model's wire (it rides the ToolMessage `artifact`),
//      but `runSteps` returns it and a host is free to log or relay it — and
//      "must be exactly 9 digits", once it reaches a model by any route,
//      re-introduces through the error path the very constraint the
//      refinement keeps out of the schema, precisely on the turn where the
//      model is about to re-ask. Say WHAT failed, never HOW MANY DIGITS. The rule is about the VALUE's
//      length; a count of something else (e.g. how many alternative readings
//      `maxCandidates` allows) says nothing about the digits and is fine.
//   3. REPRESENTATION FLIPS MUST NOT READ AS DRIFT. The confirmation gate
//      compares schema-PARSED params, so `["7070"]` and `"7070"` (or a value
//      re-sent with STT separators stripped differently) must normalize
//      identically — otherwise a caller's plain yes re-proposes instead of
//      executing. Hence the separator strip and the singleton-array collapse
//      live in the preprocess, BEFORE the compare.
//   4. THE DECLARED TYPE IS THE HONEST WIRE UNION. When a field accepts digit
//      GROUPS (an array) as well as a single string, the union must be in the
//      TYPE, not only tolerated by the preprocess: the wire schema is what the
//      model AND any shape-only wrapper validation see, and a preprocess is
//      invisible to both — with a bare string type a group-array call bounces
//      at the wrapper as a raw schema error instead of reaching the runner's
//      voice-safe `invalid_params`.
//   5. OMISSION IS THE ONLY SPELLING OF "ABSENT". Both builders are optional,
//      and an omitted field is the host's channel for "consume the carried /
//      collected value". `null` is deliberately NOT a second spelling: it is
//      not in the declared union, so a shape-only wrapper rejects it before the
//      preprocess ever runs (rule 4 cuts both ways — what the preprocess
//      tolerates but the type does not declare is unreachable anyway). Both
//      builders therefore reject it identically; do not "helpfully" special-
//      case it in one of them, which is exactly the asymmetry this rule exists
//      to prevent.
//
// The model-facing `describe` text is deliberately REQUIRED and has NO
// default: field wording is live prompt surface, tuned and QA-gated per host —
// the library never injects caller-facing or model-facing wording silently.
// See the toolkit's agent-step-api.md `<caller_digit_capture>` for the
// authoring doctrine and a proven description template to copy and adapt
// (including WHY the field should stay semantically neutral — naming the
// domain entity, e.g. "the AFM", re-activates the model's length world-
// knowledge that rule 1 exists to keep out).

import { z } from "zod";

// ── FIELD KINDS ─────────────────────────────────────────────────────────────
//
// The builders below register a MACHINE-READABLE kind for the schema they
// return, so the engine can ASK what a param is instead of inferring it from
// which builder the author happened to call. The kind exists exactly ONCE
// (here) — never as authoring convention, and never as an `expects` copy on
// every ask.
//
// What the kind buys, all of it enforced at construction (compile/validate.ts):
//   - an ask may only target a CAPTURE field ("you cannot dictate a
//     judgement"), with two distinct errors behind it — a param that is not
//     declared at all, versus one that is declared but not dictatable;
//   - an ask may omit `param` when its target declares exactly ONE capture,
//     and MUST name it when the target declares several;
//   - `digits` vs `text` is derived from the kind, so `expects` is gone and
//     the two can never disagree with the field they describe.
//
// Escalation is NOT among them: bounded patience is universal — its numbers
// are deployment-level tolerances (tolerances.ts), never a per-field or
// per-action setting — so a capture field declares nothing about it.
//
// A `WeakMap` keyed on the schema object, NOT a `.brand()`: brands are
// type-level only, and every consumer here asks at RUNTIME. Registration is
// identity-based, so a builder's result must be passed on unchanged — a host
// wrapper that appends `.optional()` after the fact would produce a NEW schema
// object and lose the kind (`digitCaptureField` in the reference host returns
// the builder's schema untouched, which is why it inherits `digits`).

/** What a declared param IS, from the caller's point of view. `digits`/`text`
 *  are caller-DICTATED captures (the model transcribes); `judged` is the
 *  model's classification of what the caller meant (never transcribed);
 *  `relay` is the caller's exact words passed through for the SYSTEM to
 *  classify. Only the first two are ask targets. */
export type FieldKind = "digits" | "text" | "judged" | "relay";

/** Registered facts about one declared param. `wire` is what the model sends;
 *  `values` carries a judged enum's domain (used by describes and tests). */
export interface FieldMeta {
  kind: FieldKind;
  wire: "string" | "boolean";
  values?: readonly string[];
}

const FIELD_META = new WeakMap<z.ZodTypeAny, FieldMeta>();

/** Tag a builder's schema with its kind and hand it straight back. */
const registerField = <T extends z.ZodTypeAny>(schema: T, meta: FieldMeta): T => {
  FIELD_META.set(schema, meta);
  return schema;
};

/** The registered facts for a schema, or `undefined` for a param declared with
 *  plain zod (the library never guesses a kind it was not told). */
export const fieldMetaOf = (schema: z.ZodTypeAny): FieldMeta | undefined =>
  FIELD_META.get(schema);

/** The registered kind for a schema, or `undefined` — see `fieldMetaOf`. */
export const fieldKindOf = (schema: z.ZodTypeAny): FieldKind | undefined =>
  FIELD_META.get(schema)?.kind;

/** Strip everything but digits from a string; pass non-strings through
 *  untouched (they fail the type check downstream, as they should). STT
 *  captures arrive with separators — "70,76", "12 34", "48/65" — which are
 *  transcription artifacts: stripping removes only separators (never adds or
 *  reorders), so shape rules still apply to the real digits afterwards. */
export const digitsOnly = (v: unknown): unknown =>
  typeof v === "string" ? v.replace(/\D/g, "") : v;

/** `digitsOnly`, but reaching inside an array branch (candidate strings). A
 *  SINGLETON array collapses to its one string so `["7070"]` and `"7070"`
 *  normalize identically — the confirmation gate compares parsed params, and a
 *  representation flip between propose and execute must never read as drift. */
export const digitsOnlyDeep = (v: unknown): unknown => {
  if (!Array.isArray(v)) return digitsOnly(v);
  const cleaned = v.map(digitsOnly);
  return cleaned.length === 1 ? cleaned[0] : cleaned;
};

/** A caller-dictated digit string (a tax number, a card-number tail). The
 *  shape check is a REFINEMENT and never a `.regex()` — see header rule 1 —
 *  and the `message` must stay COUNT-FREE — see header rule 2. */
export const callerDigits = (shape: RegExp, message: string) =>
  registerField(
    z.string().superRefine((v, ctx) => {
      if (!shape.test(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    }),
    // A caller-dictated digit string BY DEFINITION — the kind rides the
    // primitive itself, so a host that composes its own preprocess/union
    // around it (rather than using `digitGroupsParam`) still declares a
    // capture the engine can see.
    { kind: "digits", wire: "string" },
  );

/** Options for `digitGroupsParam`. */
export interface DigitGroupsParamOpts {
  /** Shape of the JOINED capture (e.g. `/^\d{9}$/u`). Never surfaces in the
   *  model-facing JSON Schema (refinement, header rule 1). */
  shape: RegExp;
  /** COUNT-FREE refinement message (header rule 2), e.g.
   *  `"spokenDigits is not a usable capture"`. */
  message: string;
  /** REQUIRED model-facing field description — the library ships no wording
   *  (see header). Copy the doctrine template from agent-step-api.md
   *  `<caller_digit_capture>` and adapt it to the host. */
  describe: string;
  /** Per-group canonicaliser, applied to every array entry (and to a single
   *  string) BEFORE the join. Defaults to stripping every non-digit. A host
   *  whose capture legitimately carries LETTERS — a foreign tax number such as
   *  `SK479482C` — supplies its own, and `shape` then judges the joined
   *  canonical value. It must only strip separators and canonicalise what was
   *  spoken (spelled letter names → the letter); it must never add, reorder
   *  or drop content, and an unreadable token should become a character
   *  outside `shape` so the capture bounces instead of silently shortening. */
  normalize?: (raw: string) => string;
}

/** A "transcription field" for a caller-dictated digit sequence spoken in
 *  GROUPS («δεκαεπτά, είκοσι ένα, πενήντα δύο, δύο, ογδόντα δύο» →
 *  `["17","21","52","2","82"]`): the model transcribes one array entry per
 *  spoken group — or a single string — and the JOIN happens HERE, in the
 *  preprocess, never in the model (models regroup, drop repeated groups, and
 *  lose the zero of round tens when asked to concatenate). The joined value
 *  validates via `callerDigits`. The field is OPTIONAL by construction:
 *  omission is the host's channel for "consume a carried/collected value". */
export const digitGroupsParam = (opts: DigitGroupsParamOpts) => {
  const normalize = opts.normalize ?? ((s: string) => s.replace(/\D/g, ""));
  const field = z
    .preprocess(
      (v) => {
        if (v === undefined) return undefined;
        // Entries are COERCED, not type-checked: they get joined, so a
        // non-string entry dropped to "" would silently SHORTEN the capture
        // (["17", 21] → "17") and could pass the shape rule as a wrong value.
        // Coercing keeps every spoken group in the result. (Contrast the
        // candidates builder, where each entry stays a separate value and a
        // non-string fails loudly instead — nothing can be silently lost.)
        if (Array.isArray(v)) return v.map((x) => normalize(String(x))).join("");
        return typeof v === "string" ? normalize(v) : v;
      },
      z
        .union([
          callerDigits(opts.shape, opts.message),
          // Honest wire union (header rule 4): the array branch is what the
          // model and shape-only wrappers see; the preprocess joins it away
          // before validation, so the string branch is what actually parses.
          z.array(z.string()),
        ])
        .optional(),
    )
    .describe(opts.describe);
  return registerField(field, { kind: "digits", wire: "string" });
};

/** Options for `callerTextParam`. */
export interface CallerTextParamOpts {
  /** Minimum/maximum TRIMMED length. Bounds are a refinement — header rule 1
   *  applies to text exactly as to digits: `.min`/`.max` would surface to the
   *  model as `minLength`/`maxLength`, a precondition for CALLING a value the
   *  tool already judges itself. */
  min: number;
  max: number;
  /** COUNT-FREE refinement messages (header rule 2). */
  shortMessage: string;
  longMessage: string;
  /** REQUIRED model-facing description — see `DigitGroupsParamOpts`. */
  describe: string;
}

/** A caller-dictated TEXT capture (a spoken name, a free-form answer): the
 *  text analogue of `callerDigits`. Trim + bounded length as a REFINEMENT
 *  with count-free messages — every voice host was re-deriving this rule by
 *  hand next to the digit builders. */
export const callerTextParam = (opts: CallerTextParamOpts) => {
  const field = z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      if (v.length < opts.min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: opts.shortMessage,
        });
      } else if (v.length > opts.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: opts.longMessage });
      }
    })
    .describe(opts.describe);
  return registerField(field, { kind: "text", wire: "string" });
};

/** A relay-only transcription field: the caller's exact words, OPTIONAL,
 *  passed through for the SYSTEM to classify — the model never translates,
 *  normalizes, or invents them. Mechanically just a described optional
 *  string; the builder exists so the authoring surface NAMES the intent
 *  (stenographer field) instead of each host re-deriving it. */
export const relayParam = (describe: string) =>
  registerField(z.string().optional().describe(describe), {
    kind: "relay",
    wire: "string",
  });

/** A JUDGED enum: the model's classification of what the caller meant, in the
 *  system's own vocabulary («και χρεωστική και πιστωτική» → `dual`). NOT a
 *  transcription — the caller never says `dual` — so it is never an ask target
 *  and never gets a read-back: there are no caller bytes to speak back. The
 *  `describe` must tell the model to OMIT the field when the caller's words do
 *  not clearly name one of the values; an unclear description is not a guess,
 *  and omitting simply asks them. Only safe where being wrong is a cheap,
 *  recoverable detour — nothing can validate a judgement. */
export const judgedEnum = <const T extends readonly [string, ...string[]]>(
  values: T,
  describe: string,
) =>
  registerField(z.enum(values).optional().describe(describe), {
    kind: "judged",
    wire: "string",
    values,
  });

/** A JUDGED boolean: a conversation-level fact the model concludes rather than
 *  transcribes (e.g. "the caller VOLUNTEERED a theft"). The same licence and
 *  the same limits as `judgedEnum`. */
export const judgedFlag = (describe: string) =>
  registerField(z.boolean().optional().describe(describe), {
    kind: "judged",
    wire: "boolean",
  });

/** An exactly-one-of selector for a params object (XOR over optional
 *  fields), as a REFINEMENT so the model-facing JSON Schema stays a plain
 *  object (header rule 1) and a bad shape bounces as recoverable
 *  `invalid_params` on the propose path. Apply as
 *  `z.object({...}).superRefine(exactlyOneOf(["a", "b"], message))`. */
export const exactlyOneOf =
  (fields: readonly string[], message: string) =>
  (value: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    const present = fields.filter((f) => value[f] !== undefined).length;
    if (present !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  };

/** Options for `digitCandidatesParam`. */
export interface DigitCandidatesParamOpts {
  /** Shape of ONE candidate digit string (e.g. `/^\d{4,19}$/u`). */
  shape: RegExp;
  /** COUNT-FREE refinement message for the single-string branch. */
  message: string;
  /** Per-candidate refinement message for the array branch; defaults to
   *  `message`. */
  candidateMessage?: string;
  /** Upper bound on simultaneous candidate readings (default 3). */
  maxCandidates?: number;
  /** REQUIRED model-facing field description — see `DigitGroupsParamOpts`. */
  describe: string;
}

/** An ambiguous-reading digit field: a single digit string, or an ARRAY of
 *  every plausible reading of one utterance («χίλια τρία» → `["1003","10003"]`)
 *  for the EXECUTOR to try — the model never picks one reading itself.
 *  Separators are stripped and a singleton array collapses to its string
 *  (`digitsOnlyDeep`), so the confirm gate's parsed-params compare never reads
 *  a representation flip as drift. The field is OPTIONAL (hosts pair it with a
 *  mutually exclusive alternative selector or a carried-value channel). */
export const digitCandidatesParam = (opts: DigitCandidatesParamOpts) => {
  const max = opts.maxCandidates ?? 3;
  const field = z
    .preprocess(
      digitsOnlyDeep,
      z
        .union([
          callerDigits(opts.shape, opts.message),
          z
            .array(callerDigits(opts.shape, opts.candidateMessage ?? opts.message))
            .superRefine((values, ctx) => {
              if (values.length < 1) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at least one candidate" });
              } else if (values.length > max) {
                // A count of READINGS, not of digits — see header rule 2.
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${max} candidates` });
              }
            }),
        ])
        // Optional INSIDE the preprocess, matching `digitGroupsParam`: with it
        // outside, `undefined` short-circuits before the preprocess but `null`
        // does not, so the two builders answered `null` differently (header
        // rule 5). Same wire schema either way — `required` is unaffected.
        .optional(),
    )
    .describe(opts.describe);
  return registerField(field, { kind: "digits", wire: "string" });
};

// ── READING A PARAMS SCHEMA ─────────────────────────────────────────────────

/** The `z.object` underneath a params schema, unwrapping the refinement /
 *  optional / default layers a host may have applied — `.shape` is `undefined`
 *  on a `ZodEffects`, and reading it directly is how the ask-param check
 *  silently skipped every action whose schema carried an `exactlyOneOf`
 *  refinement. Returns `undefined` only when no object is reachable at all,
 *  which callers must treat as an ERROR rather than as "nothing to check". */
export const objectShapeOf = (
  schema: unknown,
): Record<string, z.ZodTypeAny> | undefined => {
  let current = schema as { _def?: { typeName?: string; schema?: unknown; innerType?: unknown }; shape?: unknown };
  // Bounded walk: a hand-built schema could in principle nest deeply, and an
  // unbounded loop here would hang construction instead of failing it.
  for (let depth = 0; depth < 10 && current; depth += 1) {
    const shape = (current as { shape?: unknown }).shape;
    if (shape && typeof shape === "object") {
      return shape as Record<string, z.ZodTypeAny>;
    }
    const def = current._def;
    const inner = def?.schema ?? def?.innerType;
    if (!inner) return undefined;
    current = inner as typeof current;
  }
  return undefined;
};

/** The CAPTURE fields of a params schema — the caller-dictated ones only, so a
 *  `judged` enum or a `relay` passthrough is excluded by construction. This is
 *  the predicate behind "an ask targets a capture", "the ask may omit `param`
 *  when there is exactly one", and "a capture action must declare its
 *  escalation". */
export const captureFieldsOf = (
  schema: unknown,
): { name: string; kind: "digits" | "text" }[] => {
  const shape = objectShapeOf(schema);
  if (!shape) return [];
  const out: { name: string; kind: "digits" | "text" }[] = [];
  for (const [name, field] of Object.entries(shape)) {
    const kind = fieldKindOf(field);
    if (kind === "digits" || kind === "text") out.push({ name, kind });
  }
  return out;
};
