// FILE: src/observability/run-tracer.ts
//
// The LangSmith-parity tracer. BaseTracer (the same base class LangSmith's
// LangChainTracer extends) receives every traced run — graph invocation,
// LangGraph node, LLM call, tool run — and calls onRunCreate when a run
// starts and onRunUpdate when it ends (or errors). LangSmith itself performs
// exactly one POST (create, with inputs) and one PATCH (end, with outputs)
// per run from these same hooks, so emitting one Kafka event from each hook
// captures everything the application sends to LangSmith.
//
// Fire-and-forget: emission failures are logged, never thrown into the run —
// a Kafka/serialization problem must never break the conversation.

import { BaseTracer, type Run } from "@langchain/core/tracers/base";
import type { BaseCallbackHandlerInput } from "@langchain/core/callbacks/base";
import type { RunEventEmitter } from "./event-emitter.js";
import type { RunFilter } from "./run-filter.js";
import { getEmitter, getRunFilter } from "./registry.js";

const NO_THREAD = "no-thread"; // envelope thread_id is required non-empty; direct/test invokes have no thread

export interface KafkaRunTracerFields extends BaseCallbackHandlerInput {
  /** TEST SEAM: inject an emitter directly. Production instances (constructed
   *  with no args by the configure hook or the configure-slot wrap) resolve
   *  the shared emitter from registry.ts at emit time. */
  emitter?: RunEventEmitter;
  /** TEST SEAM: inject a run filter directly. Production instances resolve the
   *  shared filter (if any) from registry.ts at emit time. */
  filter?: RunFilter;
}

export class KafkaRunTracer extends BaseTracer {
  name = "kafka_run_tracer";

  private readonly explicitEmitter?: RunEventEmitter;
  private readonly explicitFilter?: RunFilter;

  /** trace_id → thread_id, learned from runs whose metadata carries it.
   *  LangGraph injects `configurable.thread_id` into run metadata, but a child
   *  run created with local (non-inherited) config may lack it — the map lets
   *  every event in a trace share the thread the root run declared. Entries
   *  are dropped when their root run ends. */
  private readonly threadByTrace = new Map<string, string>();

  constructor(fields?: KafkaRunTracerFields) {
    super(fields);
    this.explicitEmitter = fields?.emitter;
    this.explicitFilter = fields?.filter;
  }

  /** BaseTracer requires this (called once per completed ROOT run). Events are
   *  emitted per run from onRunCreate/onRunUpdate instead — nothing to do here. */
  protected async persistRun(_run: Run): Promise<void> {}

  onRunCreate(run: Run): void {
    this.safeEmit(run, "request");
  }

  onRunUpdate(run: Run): void {
    this.safeEmit(run, "response");
    if (!run.parent_run_id) this.threadByTrace.delete(run.trace_id ?? run.id);
  }

  private safeEmit(run: Run, direction: "request" | "response"): void {
    try {
      const emitter = this.explicitEmitter ?? getEmitter();
      if (!emitter) return; // startup() not run or disabled — silently drop
      const filter = this.explicitFilter ?? getRunFilter();
      // Filtered runs skip the emit only — the run itself (and its children,
      // which are matched independently) is traced as before. The root run
      // always passes (see run-filter.ts), so the thread map below still
      // learns every trace's thread_id.
      if (filter && !filter.shouldEmit(run)) return;
      emitter.emitRun(this.resolveThreadId(run), run, direction);
    } catch (err) {
      console.error(`[observability] failed to emit run ${direction} event:`, err);
    }
  }

  private resolveThreadId(run: Run): string {
    const traceKey = run.trace_id ?? run.id;
    const metadata = (run.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    const fromMetadata = metadata?.thread_id;
    if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
      this.threadByTrace.set(traceKey, fromMetadata);
      return fromMetadata;
    }
    return this.threadByTrace.get(traceKey) ?? NO_THREAD;
  }
}
