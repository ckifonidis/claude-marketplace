// Unit tests for redact() (src/observability/redaction.ts). Pure — no I/O.
// Run after build: node --test dist/observability/redaction.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redaction.js";

describe("redact — sensitive key detection", () => {
  test("redacts an exact sensitive key", () => {
    assert.deepEqual(redact({ password: "hunter2" }), { password: "***REDACTED***" });
  });

  test("is case-insensitive", () => {
    assert.deepEqual(redact({ Password: "x", API_KEY: "y" }), {
      Password: "***REDACTED***",
      API_KEY: "***REDACTED***",
    });
  });

  test("matches snake_case, kebab-case, and camelCase variants (edge case)", () => {
    assert.deepEqual(
      redact({ api_key: "a", "api-key": "b", apiKey: "c" }),
      { api_key: "***REDACTED***", "api-key": "***REDACTED***", apiKey: "***REDACTED***" },
    );
  });

  test("matches every documented sensitive key kind", () => {
    const input: Record<string, string> = {
      authorization: "Bearer x",
      token: "t",
      secret: "s",
      credential: "c",
      connection_string: "Server=...;Password=p",
    };
    const out = redact(input);
    for (const key of Object.keys(input)) {
      assert.equal(out[key], "***REDACTED***", `expected ${key} to be redacted`);
    }
  });

  test("substring match redacts a STRING under a key merely containing a sensitive word (edge case, by design)", () => {
    // Documented behavior: substring match, not exact — "tokenizer" contains "token".
    assert.deepEqual(redact({ tokenizer_name: "cl100k_base" }), { tokenizer_name: "***REDACTED***" });
  });

  test("a numeric value survives even under a sensitive-substring key (1.4.0 — a number cannot be a credential)", () => {
    // Pre-1.4.0 this was redacted; the type guard is what un-masks every
    // *_tokens counter without loosening the key pattern.
    assert.deepEqual(redact({ tokenized_count: 3, token: 42, has_token: false }), {
      tokenized_count: 3,
      token: 42,
      has_token: false,
    });
  });

  test("leaves non-sensitive keys untouched", () => {
    assert.deepEqual(redact({ step_name: "route", latency_ms: 12 }), {
      step_name: "route",
      latency_ms: 12,
    });
  });
});

describe("redact — nested structures", () => {
  test("recurses into nested objects", () => {
    assert.deepEqual(redact({ outer: { password: "x", ok: true } }), {
      outer: { password: "***REDACTED***", ok: true },
    });
  });

  test("recurses into arrays of objects", () => {
    assert.deepEqual(redact({ items: [{ token: "a" }, { token: "b" }] }), {
      items: [{ token: "***REDACTED***" }, { token: "***REDACTED***" }],
    });
  });

  test("leaves arrays of primitives untouched", () => {
    assert.deepEqual(redact({ tags: ["a", "b", 1] }), { tags: ["a", "b", 1] });
  });

  test("handles null and undefined values without throwing (edge case)", () => {
    // password: null passes through since 1.4.0 — null cannot carry a secret
    // (pre-1.4.0 it was masked to the redaction marker).
    assert.deepEqual(redact({ a: null, b: undefined, password: null }), {
      a: null,
      b: undefined,
      password: null,
    });
  });

  test("handles an empty object (edge case)", () => {
    assert.deepEqual(redact({}), {});
  });
});

describe("redact — LLM usage counters survive (1.4.0, QA thread 019fdaef: 400+ over-redacted fields)", () => {
  test("OpenAI-shaped usage: prompt/completion/total_tokens and *_tokens_details survive verbatim", () => {
    const usage = {
      prompt_tokens: 1450,
      completion_tokens: 210,
      total_tokens: 1660,
      prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
    };
    assert.deepEqual(redact({ usage }), { usage });
  });

  test("LangChain-shaped usage: tokenUsage with camelCase counters survives verbatim", () => {
    const llmOutput = { tokenUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } };
    assert.deepEqual(redact({ llmOutput }), { llmOutput });
  });

  test("Anthropic/LangGraph-shaped usage: usage_metadata with input/output_token_details survives verbatim", () => {
    const usage_metadata = {
      input_tokens: 500,
      output_tokens: 80,
      total_tokens: 580,
      input_token_details: { cache_read: 0, cache_creation: 0 },
      output_token_details: { reasoning: 0 },
    };
    assert.deepEqual(redact({ usage_metadata }), { usage_metadata });
  });

  test("token_usage / estimated_token_usage container spellings survive too (edge case)", () => {
    const input = {
      token_usage: { prompt_tokens: 5 },
      estimated_token_usage: { total_tokens: 7 },
      estimatedTokenUsage: { totalTokens: 7 },
    };
    assert.deepEqual(redact(input), input);
  });

  test("a string secret INSIDE a usage container is still masked (exemption recurses, not exempts contents)", () => {
    assert.deepEqual(redact({ tokenUsage: { promptTokens: 20, api_key: "sk-live-123" } }), {
      tokenUsage: { promptTokens: 20, api_key: "***REDACTED***" },
    });
  });

  test("credential-shaped keys stay masked in the same payload as surviving counters (both directions)", () => {
    const out: Record<string, unknown> = redact({
      prompt_tokens: 1450,
      api_key: "sk-live-123",
      Authorization: "Bearer eyJ...",
      access_token: "at-123",
      refresh_token: "rt-456",
      client_secret: "cs-789",
      token: "opaque-credential",
      connection_string: "Server=x;Password=p",
    });
    assert.equal(out.prompt_tokens, 1450);
    for (const key of ["api_key", "Authorization", "access_token", "refresh_token", "client_secret", "token", "connection_string"]) {
      assert.equal(out[key], "***REDACTED***", `expected ${key} to stay masked`);
    }
  });

  test("a non-exempt OBJECT under a sensitive key is still masked whole (fail-safe: no recursion into credentials)", () => {
    // A generic `_tokens?$` exemption would have exempted access_token-shaped
    // keys; the anchored container list must not recurse into these.
    assert.deepEqual(redact({ credentials: { value: "hunter2", note: "not key-matched inside" } }), {
      credentials: "***REDACTED***",
    });
    assert.deepEqual(redact({ token_config: { endpoint: "https://x", private_key: "p" } }), {
      token_config: "***REDACTED***",
    });
  });

  test("streaming new_token kwargs.token (a string content chunk) stays masked — redundant, documented", () => {
    assert.deepEqual(redact({ events: [{ name: "new_token", kwargs: { token: "Hel" } }] }), {
      events: [{ name: "new_token", kwargs: { token: "***REDACTED***" } }],
    });
  });
});

describe("redact — connection-string password= detection", () => {
  test("redacts a password= fragment inside an otherwise non-sensitive-keyed string", () => {
    const out = redact({ db_summary: "Server=x;Database=y;Password=hunter2;Encrypt=true" });
    // Matched case-insensitively, but the replacement text itself is lowercase.
    assert.equal(out.db_summary, "Server=x;Database=y;password=***REDACTED***;Encrypt=true");
  });

  test("is case-insensitive on the password= fragment (normalizes the key to lowercase)", () => {
    const out = redact({ note: "PASSWORD=abc" });
    assert.equal(out.note, "password=***REDACTED***");
  });

  test("redacts every password= occurrence in a string, including as a substring (edge case)", () => {
    // The pattern isn't anchored to a word boundary, so "OtherPassword=b"
    // also matches on its "Password=" suffix — both fragments get redacted.
    const out = redact({ note: "Password=a;OtherPassword=b" });
    assert.equal(out.note, "password=***REDACTED***;Otherpassword=***REDACTED***");
  });

  test("leaves a string with no password= fragment untouched", () => {
    const out = redact({ note: "no secrets here" });
    assert.equal(out.note, "no secrets here");
  });
});
