/**
 * Typed engine errors and the exit-code contract (spec requirements 19-20, plan decision D5).
 *
 * Every engine module throws {@link EngineError}; the CLI phase runner maps the
 * winning error to the process exit code with {@link pickExitCode}.
 */

/** Process exit codes. The numeric values are a public contract — never renumber. */
export const EXIT = {
  /** Success; no gate tripped. */
  OK: 0,
  /** Unexpected internal error only (never used for configuration problems). */
  INTERNAL: 1,
  /** Auth or preflight failed (CLI missing / not logged in, PAT problems, header env var missing). */
  AUTH: 20,
  /** Source or REST error other than auth. */
  SOURCE: 21,
  /** Drift gate tripped. */
  DRIFT: 22,
  /** A declared target or pipeline does not exist. */
  MISSING: 23,
  /** A structured file fails parsing or schema validation (exact location given). */
  INVALID: 24,
  /** A pipeline run finished with a result other than `succeeded`. */
  PIPELINE_FAILED: 25,
  /** Refused: not triggerable, no mapping, or undeclared action. */
  REFUSED: 26,
  /** Confirmation token missing, mismatched or expired. */
  TOKEN: 27,
  /** Real-world verification failed (at least one FAIL). */
  VERIFY_FAILED: 28,
  /** A file is valid but not in canonical form. */
  NON_CANONICAL: 29,
  /** Real-world verification inconclusive (at least one UNREACHABLE, no FAIL). */
  VERIFY_INCONCLUSIVE: 30,
  /** Bad command-line arguments. */
  ARGS: 64,
} as const;

/** One of the values of {@link EXIT}. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Precedence applied when several conditions occur in one run: the earliest entry wins.
 * `0` never wins over anything. `1` (internal error) and any code not listed here
 * outrank every listed code, because an internal failure means no other result can be trusted.
 */
export const EXIT_PRECEDENCE: readonly number[] = [
  EXIT.ARGS,
  EXIT.INVALID,
  EXIT.NON_CANONICAL,
  EXIT.AUTH,
  EXIT.REFUSED,
  EXIT.TOKEN,
  EXIT.SOURCE,
  EXIT.PIPELINE_FAILED,
  EXIT.MISSING,
  EXIT.VERIFY_FAILED,
  EXIT.VERIFY_INCONCLUSIVE,
  EXIT.DRIFT,
];

/**
 * Picks the exit code that wins under {@link EXIT_PRECEDENCE}.
 * Returns `0` for an empty set (or a set of zeros); returns `1` when the set contains
 * `1` or any code that is not part of the contract.
 */
export function pickExitCode(codes: Iterable<number>): number {
  let best: number = EXIT.OK;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const code of codes) {
    if (code === EXIT.OK) continue;
    const listed = EXIT_PRECEDENCE.indexOf(code);
    const rank = listed === -1 ? -1 : listed; // internal / unknown outranks everything
    if (rank < bestRank) {
      bestRank = rank;
      best = listed === -1 ? EXIT.INTERNAL : code;
    }
  }
  return best;
}

/** Where a problem was found: a file plus a JSON pointer and/or a 1-based line and column. */
export interface ErrorLocation {
  readonly file: string;
  /** RFC 6901 JSON pointer; `""` is the document root. */
  readonly pointer?: string;
  readonly line?: number;
  readonly column?: number;
}

/** Renders a location as `file:line:column (at /pointer)`, omitting the parts that are unknown. */
export function formatLocation(location: ErrorLocation): string {
  let text = location.file;
  if (location.line !== undefined) {
    text += `:${location.line}`;
    if (location.column !== undefined) text += `:${location.column}`;
  }
  if (location.pointer !== undefined) {
    text += ` (at ${location.pointer === "" ? "(root)" : location.pointer})`;
  }
  return text;
}

/** The single error type thrown by engine modules; carries the exit code it maps to. */
export class EngineError extends Error {
  /** Exit code this error maps to (one of {@link EXIT}). */
  readonly exitCode: number;
  /** Engine phase that raised it, e.g. `parse`, `validate`. Printed in the trailer line. */
  readonly phase: string;
  /** Exact location of the problem, when it concerns a file. */
  readonly location: ErrorLocation | undefined;

  constructor(exitCode: number, phase: string, message: string, location?: ErrorLocation) {
    super(message);
    this.name = "EngineError";
    this.exitCode = exitCode;
    this.phase = phase;
    this.location = location;
  }

  /** Returns a copy whose location is replaced by `location`. */
  withLocation(location: ErrorLocation): EngineError {
    return new EngineError(this.exitCode, this.phase, this.message, location);
  }

  /** Human one-liner: `<location>: <message>` (or just the message when there is no location). */
  describe(): string {
    return this.location ? `${formatLocation(this.location)}: ${this.message}` : this.message;
  }
}
