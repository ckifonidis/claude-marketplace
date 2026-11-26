/**
 * Read-only local git inspection (spec requirements 46, 53, 31d, 84).
 *
 * Only inspection commands are run (`rev-parse`, `show`, `cat-file`, `merge-base`, `rev-list`,
 * `log`); nothing fetches, writes, or checks anything out. Every call takes an explicit
 * timeout — callers pass the configured `gitTimeoutSeconds` (no default exists).
 *
 * `git -C <clone>` runs with `GIT_CEILING_DIRECTORIES` set to the clone's parent, so a mapped
 * path that is not itself a repository is reported as such instead of silently resolving to an
 * enclosing checkout. `GIT_OPTIONAL_LOCKS=0` keeps even index refreshes from writing.
 *
 * Functions here never throw for git outcomes: "could not resolve" is an explicit result.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { TagConvention, CommitResolver } from "./config.js";

/** Outcome of one git invocation. */
export type GitResult =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      readonly kind: "timeout" | "spawn-error" | "exit";
      readonly code: number | null;
      readonly stderr: string;
    };

/** Relation of a commit to the clone's HEAD. */
export type HeadRelation =
  | { readonly relation: "at-head" }
  | { readonly relation: "behind"; readonly commits: number }
  | { readonly relation: "not-ancestor" };

/** One commit as reported in deltas and resolutions. */
export interface CommitSummary {
  readonly sha: string;
  /** Committer date, ISO 8601. */
  readonly date: string;
  /** First line of the message. */
  readonly subject: string;
}

/** Result of {@link resolveDeployedCommit} (spec requirement 46). */
export type CommitResolution =
  | ({ readonly status: "resolved"; readonly headRelation: HeadRelation } & CommitSummary)
  | { readonly status: "no-clone"; readonly detail: string }
  | { readonly status: "tag-not-found"; readonly detail: string }
  | { readonly status: "digest-pinned"; readonly detail: string }
  | { readonly status: "no-convention"; readonly detail: string }
  | { readonly status: "git-error"; readonly detail: string };

/** Ancestry verdict between a downstream and an upstream commit (spec requirement 53). */
export type DeltaVerdict = "equal" | "behind" | "ahead" | "diverged" | "unknown";

/** Result of {@link compareCommits}. */
export interface CommitDelta {
  readonly verdict: DeltaVerdict;
  /**
   * `behind`: commits the downstream lacks (= `pending.length`); `ahead`: commits the
   * downstream has beyond upstream (= `extra.length`); absent otherwise.
   */
  readonly count?: number;
  /** The `downstream..upstream` range, newest first: what a promotion would bring. */
  readonly pending: readonly CommitSummary[];
  /** The `upstream..downstream` range, newest first: what the downstream has that upstream lacks. */
  readonly extra: readonly CommitSummary[];
  /** Why the verdict is `unknown`. */
  readonly reason?: string;
}

/** Result of {@link resolveCommit}. */
export type CommitLookup =
  | ({ readonly status: "resolved" } & CommitSummary)
  | { readonly status: "not-found"; readonly detail: string }
  | { readonly status: "git-error"; readonly detail: string };

/** Result of {@link showFileBytesAtCommit}: the blob's exact bytes. */
export type FileBytesAtCommit =
  | { readonly status: "ok"; readonly bytes: Buffer }
  | { readonly status: "missing"; readonly detail: string }
  | { readonly status: "git-error"; readonly detail: string };

/** Result of {@link showFileAtCommit}. */
export type FileAtCommit =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing"; readonly detail: string }
  | { readonly status: "git-error"; readonly detail: string };

const SHA_LIKE = /^[0-9a-f]{7,40}$/i;
const MAX_BUFFER = 64 * 1024 * 1024;

function assertTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`git: timeout must be a positive number of milliseconds, got ${timeoutMs}`);
  }
}

function ceilingFor(repo: string): string {
  try {
    return dirname(realpathSync(repo));
  } catch {
    return dirname(repo);
  }
}

/**
 * Runs `git -C <repo> <args>` with a timeout, never through a shell.
 * @param timeoutMs required; callers pass the configured value.
 */
export function runGit(repo: string, args: readonly string[], timeoutMs: number): GitResult {
  const result = spawnGit(repo, args, timeoutMs, "utf8");
  return "stdout" in result ? { ok: true, stdout: result.stdout as string } : result;
}

/** {@link runGit}, returning stdout as raw bytes (verbatim file copies: nothing is decoded). */
function runGitBytes(repo: string, args: readonly string[], timeoutMs: number): { readonly ok: true; readonly bytes: Buffer } | Extract<GitResult, { ok: false }> {
  const result = spawnGit(repo, args, timeoutMs, "buffer");
  return "stdout" in result ? { ok: true, bytes: result.stdout as Buffer } : result;
}

function spawnGit(
  repo: string,
  args: readonly string[],
  timeoutMs: number,
  encoding: "utf8" | "buffer",
): { readonly stdout: string | Buffer } | Extract<GitResult, { ok: false }> {
  assertTimeout(timeoutMs);
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: ceilingFor(repo),
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const kind = code === "ETIMEDOUT" ? "timeout" : "spawn-error";
    return { ok: false, kind, code: null, stderr: result.error.message };
  }
  if (result.signal !== null) return { ok: false, kind: "timeout", code: null, stderr: `killed by ${result.signal}` };
  if (result.status !== 0) return { ok: false, kind: "exit", code: result.status, stderr: String(result.stderr).trim() };
  return { stdout: result.stdout };
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

function failureDetail(what: string, result: Extract<GitResult, { ok: false }>): string {
  if (result.kind === "timeout") return `${what}: git timed out`;
  const stderr = firstLine(result.stderr);
  return stderr === "" ? `${what}: git failed (${result.kind}${result.code === null ? "" : ` ${result.code}`})` : `${what}: ${stderr}`;
}

/** Checks that `clone` exists and is a repository root; returns an error detail or `null`. */
function checkClone(clone: string, timeoutMs: number): string | null {
  const result = runGit(clone, ["rev-parse", "--git-dir"], timeoutMs);
  if (!result.ok) return result.kind === "exit" ? `${clone} exists but is not a git repository` : failureDetail(clone, result);
  return null;
}

/**
 * Resolves a revision to a full commit SHA. `undefined` = not found (git answered "no such
 * revision"); a string detail = git itself failed.
 */
function revParseCommit(clone: string, revision: string, timeoutMs: number): { sha: string } | { notFound: true } | { error: string } {
  const result = runGit(clone, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`], timeoutMs);
  if (result.ok) {
    const sha = result.stdout.trim();
    return sha === "" ? { notFound: true } : { sha };
  }
  if (result.kind === "exit" && result.code === 1) return { notFound: true };
  return { error: failureDetail(`rev-parse ${revision}`, result) };
}

/** Reads sha, committer date and subject of one commit. */
export function commitSummary(clone: string, sha: string, timeoutMs: number): CommitSummary | { error: string } {
  const result = runGit(clone, ["show", "-s", "--format=%H%x00%cI%x00%s", sha, "--"], timeoutMs);
  if (!result.ok) return { error: failureDetail(`git show ${sha}`, result) };
  const [full = "", date = "", subject = ""] = result.stdout.replace(/\n$/, "").split("\u0000");
  return { sha: full, date, subject };
}

/** HEAD of the clone as a commit summary, or an error detail. */
export function headCommit(clone: string, timeoutMs: number): CommitSummary | { error: string } {
  if (!existsSync(clone)) return { error: `${clone} does not exist` };
  const problem = checkClone(clone, timeoutMs);
  if (problem !== null) return { error: problem };
  const head = revParseCommit(clone, "HEAD", timeoutMs);
  if ("error" in head) return { error: head.error };
  if ("notFound" in head) return { error: `${clone} has no HEAD commit` };
  return commitSummary(clone, head.sha, timeoutMs);
}

/** Relation of `sha` to the clone's HEAD: at-head / behind N / not-ancestor. */
export function headRelation(clone: string, sha: string, timeoutMs: number): HeadRelation | { error: string } {
  const ancestor = runGit(clone, ["merge-base", "--is-ancestor", sha, "HEAD"], timeoutMs);
  if (!ancestor.ok) {
    if (ancestor.kind === "exit" && ancestor.code === 1) return { relation: "not-ancestor" };
    return { error: failureDetail("merge-base", ancestor) };
  }
  const count = runGit(clone, ["rev-list", "--count", `${sha}..HEAD`], timeoutMs);
  if (!count.ok) return { error: failureDetail("rev-list", count) };
  const commits = Number.parseInt(count.stdout.trim(), 10);
  if (!Number.isSafeInteger(commits)) return { error: `rev-list returned ${JSON.stringify(count.stdout.trim())}` };
  return commits === 0 ? { relation: "at-head" } : { relation: "behind", commits };
}

/** The revision a resolver maps `value` to (`sha` → the value itself; `git-tag` → `refs/tags/<prefix><value>`). */
function revisionFor(resolver: CommitResolver, value: string): { revision: string } | { mismatch: string } {
  if (resolver.type === "sha") {
    return SHA_LIKE.test(value) ? { revision: value } : { mismatch: `"${value}" is not a commit sha (7-40 hex characters)` };
  }
  return { revision: `refs/tags/${resolver.gitTagPrefix}${value}` };
}

/** Inputs of {@link resolveDeployedCommit}. */
export interface ResolveInput {
  /** Absolute path of the mapped clone, or `null` when the member has no clone. */
  readonly clone: string | null;
  /** The deployed image tag; `null` when the reference is pinned by digest only. */
  readonly tag: string | null;
  /** The effective tag convention (stage convention or the component's override). */
  readonly convention: TagConvention;
  /** Required timeout per git call, in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * Resolves a deployed image tag to a commit in the local clone under a tag convention:
 * - `none` → `no-convention`; a digest-only reference → `digest-pinned`;
 * - missing clone → `no-clone`; not a repository or git failure → `git-error`;
 * - `sha`: the tag must look like a sha and resolve as a revision;
 * - `git-tag`: `refs/tags/<gitTagPrefix><tag>` (exactly one candidate, nothing guessed);
 * - `regex`: the pattern must match the tag; its `ref` group is resolved as `sha` or `git-tag`;
 * - anything that does not resolve → `tag-not-found` (never a guess).
 * A resolved commit carries date, subject and its relation to HEAD.
 */
export function resolveDeployedCommit(input: ResolveInput): CommitResolution {
  const { clone, tag, convention, timeoutMs } = input;
  assertTimeout(timeoutMs);
  if (convention.type === "none") return { status: "no-convention", detail: "the stage declares no tag convention" };
  if (tag === null) return { status: "digest-pinned", detail: "the image is pinned by digest; no tag to resolve" };
  if (clone === null) return { status: "no-clone", detail: "no local clone is mapped" };
  if (!existsSync(clone)) return { status: "no-clone", detail: `${clone} does not exist` };
  if (!statSync(clone).isDirectory()) return { status: "git-error", detail: `${clone} is not a directory` };
  const problem = checkClone(clone, timeoutMs);
  if (problem !== null) return { status: "git-error", detail: problem };

  let resolver: CommitResolver;
  let value = tag;
  if (convention.type === "regex") {
    const match = new RegExp(convention.pattern, "u").exec(tag);
    const ref = match?.groups?.["ref"];
    if (ref === undefined || ref === "") {
      return { status: "tag-not-found", detail: `tag "${tag}" does not match the convention pattern ${convention.pattern}` };
    }
    resolver = convention.resolveAs;
    value = ref;
  } else {
    resolver = convention;
  }
  const target = revisionFor(resolver, value);
  if ("mismatch" in target) return { status: "tag-not-found", detail: target.mismatch };
  const found = revParseCommit(clone, target.revision, timeoutMs);
  if ("error" in found) return { status: "git-error", detail: found.error };
  if ("notFound" in found) return { status: "tag-not-found", detail: `${target.revision} is not in the local clone (it may need a fetch)` };

  const summary = commitSummary(clone, found.sha, timeoutMs);
  if ("error" in summary) return { status: "git-error", detail: summary.error };
  const relation = headRelation(clone, summary.sha, timeoutMs);
  if ("error" in relation) return { status: "git-error", detail: relation.error };
  return { status: "resolved", ...summary, headRelation: relation };
}

/** Lists the commits of `range` (`a..b`), newest first. */
export function listCommits(clone: string, range: string, timeoutMs: number): CommitSummary[] | { error: string } {
  const result = runGit(clone, ["log", "--format=%H%x00%cI%x00%s", range, "--"], timeoutMs);
  if (!result.ok) return { error: failureDetail(`git log ${range}`, result) };
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", date = "", subject = ""] = line.split("\u0000");
      return { sha, date, subject };
    });
}

function unknown(reason: string): CommitDelta {
  return { verdict: "unknown", pending: [], extra: [], reason };
}

/**
 * Ancestry verdict for a neighbouring stage pair (spec requirement 53). `upstream` is the
 * side closer to local HEAD; `downstream` the later stage.
 * - `equal`: same commit; `behind`: downstream is an ancestor of upstream (`count` pending);
 * - `ahead`: upstream is an ancestor of downstream; `diverged`: neither;
 * - `unknown` with a reason: no clone, an unresolved side, or a commit absent locally.
 */
export function compareCommits(
  clone: string | null,
  downstream: string | null,
  upstream: string | null,
  timeoutMs: number,
): CommitDelta {
  assertTimeout(timeoutMs);
  if (clone === null || !existsSync(clone)) return unknown("no local clone");
  if (downstream === null) return unknown("the downstream commit is not resolved");
  if (upstream === null) return unknown("the upstream commit is not resolved");
  const problem = checkClone(clone, timeoutMs);
  if (problem !== null) return unknown(problem);
  const shas: string[] = [];
  for (const [side, revision] of [
    ["downstream", downstream],
    ["upstream", upstream],
  ] as const) {
    const found = revParseCommit(clone, revision, timeoutMs);
    if ("error" in found) return unknown(found.error);
    if ("notFound" in found) return unknown(`${side} commit ${revision} is not in the local clone (it may need a fetch)`);
    shas.push(found.sha);
  }
  const [down = "", up = ""] = shas;
  if (down === up) return { verdict: "equal", pending: [], extra: [] };
  const pending = listCommits(clone, `${down}..${up}`, timeoutMs);
  if ("error" in pending) return unknown(pending.error);
  const extra = listCommits(clone, `${up}..${down}`, timeoutMs);
  if ("error" in extra) return unknown(extra.error);
  if (extra.length === 0) return { verdict: "behind", count: pending.length, pending, extra };
  if (pending.length === 0) return { verdict: "ahead", count: extra.length, pending, extra };
  return { verdict: "diverged", pending, extra };
}

/**
 * Reads `path` (relative to the repository root, `/`-separated) at commit `sha` with
 * `git show <sha>:<path>`. `missing` when the commit exists but the path does not.
 */
export function showFileAtCommit(clone: string, sha: string, path: string, timeoutMs: number): FileAtCommit {
  assertTimeout(timeoutMs);
  if (!existsSync(clone)) return { status: "git-error", detail: `${clone} does not exist` };
  const problem = checkClone(clone, timeoutMs);
  if (problem !== null) return { status: "git-error", detail: problem };
  const commit = revParseCommit(clone, sha, timeoutMs);
  if ("error" in commit) return { status: "git-error", detail: commit.error };
  if ("notFound" in commit) return { status: "git-error", detail: `commit ${sha} is not in the local clone` };
  const spec = `${commit.sha}:${path}`;
  const exists = runGit(clone, ["cat-file", "-e", spec], timeoutMs);
  if (!exists.ok) {
    if (exists.kind === "exit") return { status: "missing", detail: `${path} does not exist at ${commit.sha}` };
    return { status: "git-error", detail: failureDetail(`cat-file ${spec}`, exists) };
  }
  const shown = runGit(clone, ["show", spec], timeoutMs);
  if (!shown.ok) return { status: "git-error", detail: failureDetail(`git show ${spec}`, shown) };
  return { status: "ok", text: shown.stdout };
}

/**
 * Resolves `revision` (a sha, `HEAD`, …) to a commit of the clone, read-only. `not-found` when git
 * answers that no such commit exists locally (it may need a fetch); nothing is guessed.
 */
export function resolveCommit(clone: string, revision: string, timeoutMs: number): CommitLookup {
  assertTimeout(timeoutMs);
  if (!existsSync(clone)) return { status: "git-error", detail: `${clone} does not exist` };
  const problem = checkClone(clone, timeoutMs);
  if (problem !== null) return { status: "git-error", detail: problem };
  const found = revParseCommit(clone, revision, timeoutMs);
  if ("error" in found) return { status: "git-error", detail: found.error };
  if ("notFound" in found) return { status: "not-found", detail: `${revision} is not a commit in the local clone (it may need a fetch)` };
  const summary = commitSummary(clone, found.sha, timeoutMs);
  if ("error" in summary) return { status: "git-error", detail: summary.error };
  return { status: "resolved", ...summary };
}

/**
 * Reads `path` (relative to the repository root, `/`-separated) at the FULL commit sha `sha` as
 * raw bytes — `git cat-file blob <sha>:<path>`, never decoded or re-encoded, so a copy written from
 * it is byte-identical to the committed file (spec requirement 82a). `missing` when the commit
 * exists but the path does not (or is not a file).
 */
export function showFileBytesAtCommit(clone: string, sha: string, path: string, timeoutMs: number): FileBytesAtCommit {
  assertTimeout(timeoutMs);
  if (!existsSync(clone)) return { status: "git-error", detail: `${clone} does not exist` };
  const spec = `${sha}:${path}`;
  const type = runGit(clone, ["cat-file", "-t", spec], timeoutMs);
  if (!type.ok) {
    if (type.kind === "exit") return { status: "missing", detail: `${path} does not exist at ${sha}` };
    return { status: "git-error", detail: failureDetail(`cat-file ${spec}`, type) };
  }
  if (type.stdout.trim() !== "blob") return { status: "missing", detail: `${path} is not a file at ${sha}` };
  const shown = runGitBytes(clone, ["cat-file", "blob", spec], timeoutMs);
  if (!shown.ok) return { status: "git-error", detail: failureDetail(`cat-file blob ${spec}`, shown) };
  return { status: "ok", bytes: shown.bytes };
}
