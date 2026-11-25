/**
 * Strict command-line parsing (spec requirements 12-14, 19; exit 64 for every problem).
 *
 * - Flags are `--name` (boolean), `--name <value>` (one value), `--name <value>` repeatable
 *   (each occurrence adds one value, e.g. `--select a=1 --select b=2`) or `--name [value...]` (a
 *   boolean that also takes the following tokens accepted by a predicate, e.g. the `a:b` pairs
 *   of `--fail-on-drift`). `--name=value` is not a supported spelling.
 * - Unknown flags, duplicate non-repeatable flags, a value flag without a value, and surplus
 *   positionals → 64.
 * - `--config` is rejected everywhere with a pointer to `--workspace` (spec requirement 13).
 * - Nothing is defaulted: a required flag that is absent → 64 naming it.
 */

import { EXIT, EngineError } from "./errors.js";

/** How one flag takes values. */
export type FlagKind =
  | { readonly kind: "boolean" }
  | { readonly kind: "value" }
  /** A value flag that may be given several times; values are collected in order into `lists`. */
  | { readonly kind: "repeatable" }
  /** Present-or-absent, plus every directly following token that `accepts` (possibly none). */
  | { readonly kind: "optional-values"; readonly accepts: (token: string) => boolean };

/** The flags and positionals one command accepts. */
export interface CommandSpec {
  readonly flags: Readonly<Record<string, FlagKind>>;
  /** Maximum positional count (`Infinity` for any number). */
  readonly maxPositionals: number;
}

/** Parsed arguments of one command. */
export interface ParsedArgs {
  readonly positionals: readonly string[];
  /** Boolean flags present. */
  readonly booleans: ReadonlySet<string>;
  /** Value flags present → value. */
  readonly values: ReadonlyMap<string, string>;
  /** Optional-values flags present → the values taken (may be empty); repeatable flags → every value given. */
  readonly lists: ReadonlyMap<string, readonly string[]>;
}

/** An argument error (exit 64, phase `arguments`). */
export function argumentError(message: string): EngineError {
  return new EngineError(EXIT.ARGS, "arguments", message);
}

/** Parses `argv` (the tokens after the command name) against `spec`. @throws EngineError 64. */
export function parseCommandArgs(command: string, argv: readonly string[], spec: CommandSpec): ParsedArgs {
  const positionals: string[] = [];
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === "config" || name.startsWith("config=")) {
      throw argumentError("--config is not supported: pass the workspace explicitly with --workspace <path> (the directory holding .release-radar/workspace.json)");
    }
    const kind = spec.flags[name];
    if (kind === undefined || name.includes("=")) {
      const known = Object.keys(spec.flags).map((flag) => `--${flag}`).join(", ");
      throw argumentError(`unknown flag "${token}" for "${command}" (accepted: ${known === "" ? "none" : known})`);
    }
    if (kind.kind === "repeatable") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw argumentError(`--${name} needs a value`);
      lists.set(name, [...(lists.get(name) ?? []), value]);
      index++;
      continue;
    }
    if (seen.has(name)) throw argumentError(`duplicate flag --${name}`);
    seen.add(name);
    if (kind.kind === "boolean") booleans.add(name);
    else if (kind.kind === "value") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw argumentError(`--${name} needs a value`);
      values.set(name, value);
      index++;
    } else {
      const taken: string[] = [];
      while (index + 1 < argv.length && kind.accepts(argv[index + 1] as string)) taken.push(argv[++index] as string);
      lists.set(name, taken);
    }
  }
  if (positionals.length > spec.maxPositionals) {
    throw argumentError(`"${command}" takes at most ${spec.maxPositionals} positional argument(s); got ${positionals.map((p) => JSON.stringify(p)).join(" ")}`);
  }
  return { positionals, booleans, values, lists };
}

/** The value of a required value flag. @throws EngineError 64 naming the flag. */
export function requireValue(args: ParsedArgs, command: string, flag: string, what: string): string {
  const value = args.values.get(flag);
  if (value === undefined) throw argumentError(`"${command}" requires --${flag} <${what}>`);
  return value;
}
