// FILE: src/agent-step/tolerances.ts
//
// ENGINE TOLERANCES — the four numbers that bound the engine's patience, and
// the ONE place they are resolved.
//
//   bounceTolerance        consecutive unusable captures answered with the
//                          plain rejection before the engine explains itself.
//   freeExplanations       in-place explanations a run gets before the engine
//                          escalates into the configured handoff.
//   maliciousLimit         the `note_refusal` `malicious_intent` attempt that
//                          ends the task (cumulative within the task).
//   errorHandoffThreshold  consecutive backend-failure batches before the
//                          automatic handoff.
//
// They are PROCESS-WIDE, not per action and not per tool: bounded patience is
// universal (see interaction/escalation.ts for why a per-action budget was
// removed), so there is still nothing to declare in a config and nothing to
// name in a prompt. What a DEPLOYMENT may do is move the numbers, through the
// environment:
//
//   AGENT_STEP_BOUNCE_TOLERANCE          integer >= 0   default 2
//   AGENT_STEP_FREE_EXPLANATIONS         integer >= 0   default 1
//   AGENT_STEP_MALICIOUS_LIMIT           integer >= 1   default 3
//   AGENT_STEP_ERROR_HANDOFF_THRESHOLD   integer >= 1   default 3
//
// RULES
//   1. Read ONCE per compile: `buildAgentStepTool` resolves them at
//      construction and closes over the result, so a running tool never
//      changes its bounds mid-conversation. (`runSteps`, the test seam,
//      compiles per call and therefore re-reads per call.)
//   2. FAIL LOUDLY: a value that is set but is not a plain base-10 integer
//      within range throws at construction, naming the variable. An unset or
//      blank variable means the default — a tolerance is never guessed from a
//      malformed value.
//   3. An EXPLICIT `BuildAgentStepToolOptions.errorHandoffThreshold` wins over
//      its variable: a host that pinned the threshold in code keeps it.
//   4. MODEL-INVISIBLE: no engine text carries a count (engine-text.ts rule
//      2), so moving a tolerance moves no model-facing byte — goldens hold.
//
// The defaults are MEASURED (see the constants below). A deployment that moves
// them is running values nobody measured; a very large value effectively
// switches that bound off.
//
// This is the only module in the library that reads the environment. It
// imports nothing from the library (a leaf), so both `compile/plan.ts` and
// `interaction/escalation.ts` may depend on it.

/** Consecutive unusable captures tolerated before the engine explains itself
 *  instead of bouncing plainly. DEFAULT — measured (2026-08-19 → 3 was too
 *  patient: the model was seen improvising on the third identical failure).
 *  Overridable per deployment: `AGENT_STEP_BOUNCE_TOLERANCE`. */
export const BOUNCE_TOLERANCE = 2;

/** Free in-place explanations per run. DEFAULT one: explain, re-ask, and if
 *  the next turn is still not a delivery, get a human. Overridable per
 *  deployment: `AGENT_STEP_FREE_EXPLANATIONS`. */
export const FREE_EXPLANATIONS = 1;

/** The `malicious_intent` attempt that ends the task. DEFAULT three (owner
 *  decision 2026-11-18). Overridable per deployment:
 *  `AGENT_STEP_MALICIOUS_LIMIT`. */
export const MALICIOUS_LIMIT = 3;

/** DEFAULT number of consecutive backend-failure batches before the runner
 *  triggers an automatic handoff. Overridable via
 *  `BuildAgentStepToolOptions.errorHandoffThreshold`, or per deployment via
 *  `AGENT_STEP_ERROR_HANDOFF_THRESHOLD` (the explicit option wins). */
export const ERROR_HANDOFF_THRESHOLD = 3;

/** The resolved tolerances a compiled plan carries. */
export interface EngineTolerances {
  bounceTolerance: number;
  freeExplanations: number;
  maliciousLimit: number;
  errorHandoffThreshold: number;
}

/** The measured defaults, as one frozen bundle. */
export const DEFAULT_TOLERANCES: Readonly<EngineTolerances> = Object.freeze({
  bounceTolerance: BOUNCE_TOLERANCE,
  freeExplanations: FREE_EXPLANATIONS,
  maliciousLimit: MALICIOUS_LIMIT,
  errorHandoffThreshold: ERROR_HANDOFF_THRESHOLD,
});

/** The environment variable behind each tolerance. */
export const TOLERANCE_ENV = Object.freeze({
  bounceTolerance: "AGENT_STEP_BOUNCE_TOLERANCE",
  freeExplanations: "AGENT_STEP_FREE_EXPLANATIONS",
  maliciousLimit: "AGENT_STEP_MALICIOUS_LIMIT",
  errorHandoffThreshold: "AGENT_STEP_ERROR_HANDOFF_THRESHOLD",
} as const satisfies Record<keyof EngineTolerances, string>);

/** The smallest value each tolerance accepts. Zero is meaningful for the two
 *  patience counters (explain on the first unusable capture / escalate on the
 *  first climb); the two limits count the attempt that TRIGGERS, so they start
 *  at one. */
const TOLERANCE_MIN: Readonly<EngineTolerances> = Object.freeze({
  bounceTolerance: 0,
  freeExplanations: 0,
  maliciousLimit: 1,
  errorHandoffThreshold: 1,
});

/** A bag of environment variables — `process.env`, or a plain object in tests. */
export type ToleranceEnv = Record<string, string | undefined>;

/** The process environment, or an empty bag on a runtime without `process`. */
function processEnv(): ToleranceEnv {
  const proc = (globalThis as { process?: { env?: ToleranceEnv } }).process;
  return proc?.env ?? {};
}

function readTolerance(env: ToleranceEnv, key: keyof EngineTolerances): number | undefined {
  const name = TOLERANCE_ENV[key];
  const raw = env[name];
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === "") return undefined; // `NAME=` in a .env file: unset, not zero.
  const min = TOLERANCE_MIN[key];
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(
      `agent-step: ${name} must be an integer >= ${min} (got ${JSON.stringify(raw)}). ` +
        `Unset it to use the default (${DEFAULT_TOLERANCES[key]}).`,
    );
  }
  return value;
}

/** Resolve the engine tolerances: an explicit `errorHandoffThreshold` first,
 *  then the `AGENT_STEP_*` environment variables, then the measured defaults.
 *  Throws on a malformed or out-of-range variable. Pure over its arguments —
 *  `env` defaults to the process environment. */
export function resolveTolerances(
  env: ToleranceEnv = processEnv(),
  explicit: { errorHandoffThreshold?: number } = {},
): EngineTolerances {
  // Every variable is validated even when an explicit option outranks it: a
  // malformed value is a deployment mistake whether or not it would be used.
  const errorHandoffFromEnv = readTolerance(env, "errorHandoffThreshold");
  return {
    bounceTolerance: readTolerance(env, "bounceTolerance") ?? BOUNCE_TOLERANCE,
    freeExplanations: readTolerance(env, "freeExplanations") ?? FREE_EXPLANATIONS,
    maliciousLimit: readTolerance(env, "maliciousLimit") ?? MALICIOUS_LIMIT,
    errorHandoffThreshold:
      explicit.errorHandoffThreshold ?? errorHandoffFromEnv ?? ERROR_HANDOFF_THRESHOLD,
  };
}
