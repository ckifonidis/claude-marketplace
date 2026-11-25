/**
 * The single place where configuration files are read from disk, so every read can be
 * observed (spec requirement 76a: a read-tracking fixture proves that non-member repositories
 * and worktree-like sibling folders are never read).
 */

import { readFileSync } from "node:fs";

/** Called with the absolute path of every file read through {@link readTextFile}. */
export type ReadObserver = (absolutePath: string) => void;

/** Reads a UTF-8 text file, reporting the read to `observer` first when one is given. */
export function readTextFile(absolutePath: string, observer: ReadObserver | undefined): string {
  observer?.(absolutePath);
  return readFileSync(absolutePath, "utf8");
}
