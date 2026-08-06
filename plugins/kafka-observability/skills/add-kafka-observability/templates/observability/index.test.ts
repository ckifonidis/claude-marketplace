// Unit tests for the observability composition root (src/observability/index.ts):
// disabled-by-default no-op, fail-fast on missing config when enabled, idempotent
// startup, bounded shutdown. Uses __resetForTests() since module state is a
// singleton. NOTE: the registerConfigureHook registration is global and cannot
// be unregistered — these tests never run a graph, so it stays inert.
//
// Run after build: node --test dist/observability/index.test.js

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startup, shutdown, __resetForTests } from "./index.js";

const ENV_KEYS = [
  "KAFKA_ENABLED",
  "APPLICATION_NAME",
  "KAFKA_BOOTSTRAP_SERVERS",
  "KAFKA_OBSERVABILITY_TOPIC",
  "KAFKA_ATTACH_MODE",
  "KAFKA_RUN_FILTER_MODE",
  "KAFKA_RUN_FILTER_PATTERNS",
];

function clearKafkaEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

// Always leave the module state clean AND the queue/producer (if any) drained
// for the next test — a leftover producer's drain loop would otherwise keep
// hitting an unreachable broker across unrelated tests.
afterEach(async () => {
  await shutdown();
  __resetForTests();
  clearKafkaEnv();
});

describe("startup() — disabled by default", () => {
  test("KAFKA_ENABLED unset is a no-op — no env vars required, no throw", () => {
    clearKafkaEnv();
    assert.doesNotThrow(() => startup());
  });

  test("KAFKA_ENABLED=false is equally a no-op (edge case — explicit false, not just unset)", () => {
    clearKafkaEnv();
    process.env.KAFKA_ENABLED = "false";
    assert.doesNotThrow(() => startup());
  });

  test('KAFKA_ENABLED="TRUE" does NOT enable (strict lowercase "true" — must agree with the global hook)', () => {
    clearKafkaEnv();
    process.env.KAFKA_ENABLED = "TRUE";
    // Would throw on missing APPLICATION_NAME if the gate opened.
    assert.doesNotThrow(() => startup());
  });

  test("shutdown() with nothing ever started resolves immediately (edge case)", async () => {
    clearKafkaEnv();
    startup();
    await assert.doesNotReject(() => shutdown());
  });
});

describe("startup() — enabled, fail-fast on missing required config", () => {
  test("throws when APPLICATION_NAME/KAFKA_BOOTSTRAP_SERVERS/KAFKA_OBSERVABILITY_TOPIC are all missing", () => {
    clearKafkaEnv();
    process.env.KAFKA_ENABLED = "true";
    assert.throws(() => startup(), /environment variable is required/);
  });

  test("throws when only APPLICATION_NAME is missing (edge case — partially configured)", () => {
    clearKafkaEnv();
    process.env.KAFKA_ENABLED = "true";
    process.env.KAFKA_BOOTSTRAP_SERVERS = "localhost:19999";
    process.env.KAFKA_OBSERVABILITY_TOPIC = "observability-events";
    assert.throws(() => startup(), /APPLICATION_NAME/);
  });
});

describe("startup() — enabled with complete config", () => {
  test("constructs without throwing against an unreachable broker (fire-and-forget wiring)", async () => {
    clearKafkaEnv();
    process.env.KAFKA_ENABLED = "true";
    process.env.APPLICATION_NAME = "test";
    // Unreachable on purpose — this only proves the wiring doesn't throw;
    // actual delivery is covered by live verification, not unit tests.
    process.env.KAFKA_BOOTSTRAP_SERVERS = "localhost:19999";
    process.env.KAFKA_OBSERVABILITY_TOPIC = "observability-events";

    assert.doesNotThrow(() => startup());
    await shutdown();
  });

  test("startup() is idempotent — a second call does not re-throw or duplicate init", () => {
    clearKafkaEnv();
    process.env.KAFKA_ENABLED = "true";
    process.env.APPLICATION_NAME = "test";
    process.env.KAFKA_BOOTSTRAP_SERVERS = "localhost:19999";
    process.env.KAFKA_OBSERVABILITY_TOPIC = "observability-events";

    startup();
    assert.doesNotThrow(() => startup());
  });
});

function setCompleteEnv(): void {
  clearKafkaEnv();
  process.env.KAFKA_ENABLED = "true";
  process.env.APPLICATION_NAME = "test";
  process.env.KAFKA_BOOTSTRAP_SERVERS = "localhost:19999";
  process.env.KAFKA_OBSERVABILITY_TOPIC = "observability-events";
}

describe("startup() — KAFKA_ATTACH_MODE", () => {

  test("invalid value fails fast (no-config-fallback rule)", () => {
    setCompleteEnv();
    process.env.KAFKA_ATTACH_MODE = "global";
    assert.throws(() => startup(), /KAFKA_ATTACH_MODE/);
  });

  test('each supported mode ("hook" | "patch" | "both") starts cleanly', async () => {
    for (const mode of ["hook", "patch", "both"]) {
      setCompleteEnv();
      process.env.KAFKA_ATTACH_MODE = mode;
      assert.doesNotThrow(() => startup(), `mode=${mode}`);
      await shutdown();
      __resetForTests();
    }
  });
});

describe("startup() — KAFKA_RUN_FILTER_* (opt-in run filtering)", () => {
  test("invalid mode fails fast (no-config-fallback rule)", () => {
    setCompleteEnv();
    process.env.KAFKA_RUN_FILTER_MODE = "denylist";
    process.env.KAFKA_RUN_FILTER_PATTERNS = "chain:__*";
    assert.throws(() => startup(), /KAFKA_RUN_FILTER_MODE/);
  });

  test("patterns without a mode fail fast (edge case — half-configured opt-in)", () => {
    setCompleteEnv();
    process.env.KAFKA_RUN_FILTER_PATTERNS = "chain:__*";
    assert.throws(() => startup(), /KAFKA_RUN_FILTER_PATTERNS/);
  });

  test("mode without patterns fails fast", () => {
    setCompleteEnv();
    process.env.KAFKA_RUN_FILTER_MODE = "deny";
    assert.throws(() => startup(), /KAFKA_RUN_FILTER_PATTERNS/);
  });

  test("a valid filter config starts cleanly", async () => {
    setCompleteEnv();
    process.env.KAFKA_RUN_FILTER_MODE = "deny";
    process.env.KAFKA_RUN_FILTER_PATTERNS = "chain:__*";
    assert.doesNotThrow(() => startup());
    await shutdown();
  });
});
