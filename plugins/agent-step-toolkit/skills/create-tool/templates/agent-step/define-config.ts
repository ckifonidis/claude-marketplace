import type { AgentStepConfig } from "./types.js";

/** Identity helper — purpose is type inference (callers get autocomplete on
 *  action names, prereq names) and a stable import surface. */
export function defineConfig<A extends string, P extends string>(
  cfg: AgentStepConfig<A, P>,
): AgentStepConfig<A, P> {
  return cfg;
}
