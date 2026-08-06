// FILE: src/observability/registry.ts
//
// Module-level singletons holding the shared RunEventEmitter and the optional
// RunFilter. Needed because the global callback hook (registerConfigureHook
// in index.ts) constructs a fresh KafkaRunTracer per configured invocation —
// the tracer instances are cheap and stateless-ish, but the producer/emitter
// (and the once-validated filter) must be one per process. Kept in its own
// module so run-tracer.ts and index.ts can both import it without a circular
// dependency.

import type { RunEventEmitter } from "./event-emitter.js";
import type { RunFilter } from "./run-filter.js";

let emitter: RunEventEmitter | null = null;
let runFilter: RunFilter | null = null;

export function setEmitter(value: RunEventEmitter | null): void {
  emitter = value;
}

export function getEmitter(): RunEventEmitter | null {
  return emitter;
}

export function setRunFilter(value: RunFilter | null): void {
  runFilter = value;
}

export function getRunFilter(): RunFilter | null {
  return runFilter;
}
