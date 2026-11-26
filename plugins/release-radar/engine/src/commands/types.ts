/** Shared shapes of the CLI commands. */

/** What a command receives from the CLI entry point. */
export interface CommandContext {
  /** The engine's own environment (handed unchanged to source CLIs; only `NO_COLOR` is read). */
  readonly env: NodeJS.ProcessEnv;
  /** The stdout stream's TTY flag (colour is only used at a terminal). */
  readonly stdout: { readonly isTTY?: boolean };
  /** The clock (report and snapshot times; `pipeline-run --follow` timing). */
  readonly now: () => Date;
  /**
   * Waits `ms` milliseconds (`pipeline-run --follow` polling, Azure DevOps `Retry-After`). The CLI
   * passes a real timer; in-process tests may pass one that advances a fake clock.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The context's sleep, or a real timer when the context supplies none. */
export function sleeper(context: CommandContext): (ms: number) => Promise<void> {
  return context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/** What a command returns when it ran to a reportable end (exit 0 or a reporting exit such as 22/23/29). */
export interface CommandOutput {
  readonly exitCode: number;
  /** Trailer phase. */
  readonly phase: string;
  /** Everything for stdout (the report, or one JSON document with `--json`). */
  readonly stdout: string;
  /** Messages for stderr, printed before the trailer. */
  readonly stderr: readonly string[];
  /** True when stdout is one JSON document: the trailer then goes to stderr to keep stdout parseable. */
  readonly json: boolean;
}
