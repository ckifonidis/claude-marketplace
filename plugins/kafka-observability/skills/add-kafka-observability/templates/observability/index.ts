// FILE: src/observability/index.ts
//
// Public API + composition root. startup() builds the singleton Kafka
// producer + emitter and attaches a KafkaRunTracer to every LangChain/
// LangGraph invocation in the process through TWO redundant paths (default —
// see KAFKA_ATTACH_MODE in settings.ts):
//
//   1. registerConfigureHook — the upstream mechanism LangSmith-adjacent
//      tracers are offered. Its registry lives in AsyncLocalStorage, so it
//      only reaches runs whose async context descends from this startup()
//      call — which platform harnesses that create their run-dispatch channel
//      before importing the graph do NOT satisfy (INC-2026-0045).
//   2. The configure slot (configure-slot.ts) — a wrap of our core copy's
//      CallbackManager._configureSync, the same attachment point LangSmith's
//      own tracer occupies. Independent of async ancestry; also detects and
//      loudly logs when path 1 was registered but did not fire.
//
// Both paths dedupe by handler name, so together they attach exactly one
// tracer per run tree. No graph export, node function, or tool signature
// changes either way.
//
// Disabled by default (KAFKA_ENABLED !== "true"): startup() is a no-op, no
// Kafka env var is read or required, and the tracer is never attached. When
// enabled, all required settings are validated together and fail fast — no
// fallbacks, per the team's configuration rule.
//
// Wiring (done by /add-kafka-observability): the module that builds/exports
// the graph calls startup() once at module load:
//
//   import { startup as startupObservability } from "./observability/index.js";
//   startupObservability();

import { registerConfigureHook } from "@langchain/core/context";
import { isKafkaEnabled, readAttachMode, readKafkaSettings } from "./settings.js";
import { KafkaEventProducer } from "./kafka-producer.js";
import { RunEventEmitter } from "./event-emitter.js";
import { KafkaRunTracer } from "./run-tracer.js";
import { readRunFilterFromEnv } from "./run-filter.js";
import { setEmitter, setRunFilter } from "./registry.js";
import {
  installConfigureSlot,
  logAttachmentDiagnostics,
  __resetConfigureSlotForTests,
} from "./configure-slot.js";

export { KafkaRunTracer } from "./run-tracer.js";
export type { KafkaRunTracerFields } from "./run-tracer.js";
export { RunFilter, readRunFilterFromEnv } from "./run-filter.js";
export type { RunFilterMode } from "./run-filter.js";
export { RunEventEmitter, runToEventData } from "./event-emitter.js";
export type { ObservabilityEvent, RunEventData } from "./schemas.js";
export { getAttachDiagnostics } from "./configure-slot.js";
export type { AttachDiagnostics } from "./configure-slot.js";

let producer: KafkaEventProducer | null = null;
let started = false;

/** Call once at module load (the graph entry module). Idempotent. Validates
 *  all required Kafka settings fail-fast when KAFKA_ENABLED=true. */
export function startup(): void {
  if (started) return;
  started = true;
  if (!isKafkaEnabled()) {
    console.log('[observability] Kafka run tracing disabled (KAFKA_ENABLED !== "true") — skipping init');
    return;
  }
  // Read ALL config before any side effect, so an invalid var fails startup
  // without leaving a half-built producer behind.
  const settings = readKafkaSettings();
  const attachMode = readAttachMode();
  const runFilter = readRunFilterFromEnv();
  producer = new KafkaEventProducer(settings);
  setEmitter(new RunEventEmitter(producer, settings.applicationName, settings.topic));
  setRunFilter(runFilter);
  if (attachMode !== "patch") {
    // Every callback-manager configure() in a context descending from here
    // gets a KafkaRunTracer (deduped by handler name within a run tree;
    // inheritable so child runs — nodes, LLM calls, tools — report to the
    // same instance).
    registerConfigureHook({ handlerClass: KafkaRunTracer, envVar: "KAFKA_ENABLED", inheritable: true });
  }
  if (attachMode !== "hook") {
    installConfigureSlot({ hookAlsoRegistered: attachMode === "both" });
  }
  // "initialized", NOT "ready": the broker/SASL handshake is still in flight
  // here. The producer logs "Kafka producer connected" when it completes, and
  // warns if it never does — claiming readiness at this point sent a real QA
  // incident down the wrong path (events silently queued, log said "ready").
  console.log(
    `[observability] Kafka run tracing initialized (producer connecting in background): ` +
      `app=${settings.applicationName} topic=${settings.topic} ` +
      `brokers=${settings.bootstrapServers} retries=${settings.retries} ` +
      `delivery_timeout_ms=${settings.deliveryTimeoutMs}`,
  );
  if (runFilter) {
    console.log(
      `[observability] run filter active: ${runFilter.describe()} (root run always emitted)`,
    );
  }
  logAttachmentDiagnostics(attachMode);
}

/** Drain the queue and flush the broker connection. Call at process shutdown
 *  where a hook exists (e.g. the CLI's quit path). Bounded — never hangs on an
 *  unreachable broker. No-op when disabled or never started. */
export async function shutdown(): Promise<void> {
  if (producer) await producer.shutdown();
}

/** TEST SEAM: resets module-level singleton state so tests can exercise
 *  startup()/shutdown() transitions independently. Callers MUST await
 *  shutdown() first if a real producer was constructed, or its drain loop
 *  leaks across tests. NOTE: an already-registered configure hook cannot be
 *  unregistered — tests relying on hook absence must run before any enabled
 *  startup(). The configure-slot wrap IS reversible and is restored here. */
export function __resetForTests(): void {
  producer = null;
  setEmitter(null);
  setRunFilter(null);
  started = false;
  __resetConfigureSlotForTests();
}
