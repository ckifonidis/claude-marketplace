// FILE: src/observability/redaction.ts
//
// Redacts sensitive fields before any observability payload is serialized.
// Pure, recursive, no dependency on the rest of the module — usable in
// isolation and unit-testable without a producer/broker.

const SENSITIVE_KEY_PATTERN =
  /(authorization|api[_-]?key|password|token|secret|credential|connection[_-]?string)/i;

/** LLM usage containers, exempt from the sensitive-key match: they collide
 *  with it only through the "token" substring (tokenUsage, prompt_tokens_details,
 *  input_token_details, …) yet hold cost/usage counters, not credentials —
 *  masking them silently killed all token analytics downstream (found live in
 *  QA: 400+ redacted usage fields in one verified thread). Anchored to the
 *  known container/counter spellings — deliberately NOT a generic `_tokens?$`
 *  suffix rule, which would also exempt access_token-style credentials. Their
 *  CONTENTS still pass through full recursive redaction, so a string secret
 *  inside a usage object stays masked. */
const USAGE_KEY_PATTERN =
  /^((prompt|completion|input|output|total)_tokens?(_details)?|(estimated_?)?token_?usage|usage(_metadata)?)$/i;

const CONNECTION_STRING_PASSWORD_PATTERN = /password=[^;&\s]+/gi;

const REDACTED = "***REDACTED***";

function redactString(value: string): string {
  // .replace() is a no-op on a non-matching string, so this needs no separate
  // .test() guard — avoids relying on a shared /g regex's stateful lastIndex.
  return value.replace(CONNECTION_STRING_PASSWORD_PATTERN, `password=${REDACTED}`);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redact(value as Record<string, unknown>);
  return value;
}

/** True when a value could physically carry a secret: strings (the credential
 *  itself), and objects/arrays (which may contain one). Numbers, booleans,
 *  null, and undefined cannot — masking those under a sensitive-substring key
 *  is what redacted every `prompt_tokens: 1450`-style counter (including the
 *  provider-specific ones inside details objects: cached_tokens,
 *  reasoning_tokens, audio_tokens, camelCase promptTokens, …). */
function canCarrySecret(value: unknown): boolean {
  return typeof value === "string" || (typeof value === "object" && value !== null);
}

/** Recursively redacts sensitive keys (case-insensitive substring match) and
 *  `password=`-shaped connection-string fragments inside string values.
 *  A sensitive-keyed STRING is masked; a sensitive-keyed object/array is
 *  masked whole (fail-safe: `credentials: {…}` never leaks unmatched inner
 *  keys) — except the usage containers above, which recurse normally. Scalars
 *  that cannot carry a secret pass verbatim whatever their key. Generic so
 *  callers keep their concrete type (e.g. `EventData`) instead of widening to
 *  `Record<string, unknown>` and casting back. */
export function redact<T extends Record<string, unknown>>(data: T): T {
  const out = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    const sensitive =
      !USAGE_KEY_PATTERN.test(key) && SENSITIVE_KEY_PATTERN.test(key) && canCarrySecret(value);
    out[key] = sensitive ? REDACTED : redactValue(value);
  }
  return out as T;
}
