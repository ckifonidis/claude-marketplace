/**
 * The single place where configuration files are read from disk, so every read can be
 * observed (spec requirement 76a: a read-tracking fixture proves that non-member repositories
 * and worktree-like sibling folders are never read).
 */
import { readFileSync } from "node:fs";
/** Reads a UTF-8 text file, reporting the read to `observer` first when one is given. */
export function readTextFile(absolutePath, observer) {
    observer?.(absolutePath);
    return readFileSync(absolutePath, "utf8");
}
