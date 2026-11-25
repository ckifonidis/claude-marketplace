// Fake CLI shims for the adapter tests (spec requirements 75, 77; scan §6.3 technique).
//
// Each shim is an executable script whose shebang is the ABSOLUTE Node binary running the tests
// (`#!${process.execPath}`), so no PATH lookup of node is needed. The child PATH given to the
// adapters contains ONLY the shim directory: a real `az` / `kubectl` / `docker` can never be
// reached, and an uninstalled shim is an ENOENT ("CLI missing").
//
// The scenario (an ordered rule list) is embedded in the script. Every invocation appends
// `{ bin, args, env }` to an NDJSON argv log BEFORE answering, so tests can assert exactly which
// commands ran and that every one of them was read-only. An invocation no rule matches writes
// "unexpected fake <bin>: <args>" and exits 90, so an unplanned call fails the test.
//
// All data is synthetic. Nothing here contacts a network, cloud, cluster or daemon.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Environment variables the shim records (fixed, non-credential markers only). */
const RECORDED_ENV = ["LC_ALL", "AZURE_CORE_ONLY_SHOW_ERRORS", "AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "RR_TEST_MARKER"];

function shimSource(name, rules, logPath) {
  return `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const NAME = ${JSON.stringify(name)};
const RULES = ${JSON.stringify(rules)};
const LOG = ${JSON.stringify(logPath)};
const RECORDED = ${JSON.stringify(RECORDED_ENV)};
const args = process.argv.slice(2);
const env = {};
for (const key of RECORDED) env[key] = process.env[key] ?? null;
fs.appendFileSync(LOG, JSON.stringify({ bin: NAME, args, env }) + "\\n");

function hasSequence(list, seq) {
  if (seq.length === 0) return true;
  for (let i = 0; i + seq.length <= list.length; i += 1) {
    if (seq.every((token, j) => list[i + j] === token)) return true;
  }
  return false;
}
function flagsMatch(list, flags) {
  return Object.entries(flags).every(([flag, value]) => {
    const i = list.indexOf(flag);
    return i >= 0 && list[i + 1] === value;
  });
}
function lookup(value, path) {
  return path.split(".").reduce((o, k) => (o === null || o === undefined ? null : o[k] === undefined ? null : o[k]), value);
}
// Minimal JMESPath used by the az adapter: "[].{alias:path,...}" or a plain dotted path.
function project(value, query) {
  const multi = /^\\[\\]\\.\\{(.*)\\}$/.exec(query);
  if (multi) {
    const pairs = multi[1].split(",").map((pair) => pair.split(":"));
    return value.map((item) => Object.fromEntries(pairs.map(([alias, path]) => [alias, lookup(item, path)])));
  }
  return lookup(value, query);
}

const rule = RULES.find((r) => hasSequence(args, r.match || []) && flagsMatch(args, r.flags || {}));
if (!rule) {
  process.stderr.write("unexpected fake " + NAME + ": " + args.join(" ") + "\\n");
  process.exitCode = 90;
} else {
  const answer = () => {
    let out = rule.stdout;
    if (rule.query && out !== undefined) out = project(out, args[args.indexOf("--query") + 1]);
    if (out !== undefined) process.stdout.write(typeof out === "string" && !rule.query ? out : JSON.stringify(out));
    if (rule.stderr) process.stderr.write(rule.stderr);
    process.exitCode = rule.exit || 0;
  };
  if (rule.sleepMs) setTimeout(answer, rule.sleepMs);
  else answer();
}
`;
}

/**
 * Creates a shim workspace for one test.
 * - `install(name, rules)`: writes the executable shim `name`. A rule is
 *   `{ match?: string[] (contiguous tokens), flags?: {flag: value}, stdout?: string|json,
 *      query?: true (apply the --query projection), stderr?: string, exit?: number, sleepMs?: number }`.
 * - `env`: the child environment (PATH = shim dir only; RR_TEST_MARKER set).
 * - `missingEnv`: PATH = an empty directory (every CLI is missing).
 * - `calls(bin?)`: the argv log, optionally filtered by binary.
 */
export function shimHarness(t) {
  const root = mkdtempSync(join(tmpdir(), "release-radar-shims-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const empty = join(root, "empty");
  mkdirSync(bin);
  mkdirSync(empty);
  const logPath = join(root, "calls.ndjson");
  const base = { ...process.env, RR_TEST_MARKER: "passed-through" };
  // Never let a real Azure DevOps credential from the developer's shell reach an engine under
  // test: pipeline tests set the synthetic PAT explicitly.
  delete base.AZURE_DEVOPS_EXT_PAT;
  delete base.AZURE_DEVOPS_PAT_EXPIRES;
  return {
    bin,
    logPath,
    env: { ...base, PATH: bin },
    missingEnv: { ...base, PATH: empty },
    runtime: { env: { ...base, PATH: bin } },
    missingRuntime: { env: { ...base, PATH: empty } },
    install(name, rules) {
      const path = join(bin, name);
      writeFileSync(path, shimSource(name, rules, logPath), { mode: 0o700 });
      chmodSync(path, 0o700);
      return path;
    },
    calls(name) {
      if (!existsSync(logPath)) return [];
      const all = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
      return name === undefined ? all : all.filter((call) => call.bin === name);
    },
  };
}

/** Verbs and flags that would mutate a source. None may appear as an argv token of any adapter call. */
export const FORBIDDEN_TOKENS = [
  "delete", "apply", "up", "down", "restart", "pull", "push", "use-context", "set-context", "use",
  "scale", "set", "create", "update", "start", "stop", "rm", "kill", "patch", "edit", "replace",
  "rollout", "login", "logout", "add", "remove", "install", "exec", "deploy", "drain", "cordon",
  "label", "annotate", "activate", "deactivate", "--yes",
];

const PINNED_FLAGS = new Set(["--context", "--namespace", "--project-name", "--file"]);

/** argv without the pinned `--flag value` pairs, for prefix comparison. */
export function normalizedArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (PINNED_FLAGS.has(args[i])) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * Asserts that every logged call was read-only: no forbidden token, and (when `allowed` is
 * given) its normalised argv starts with one of the allowed read-only prefixes.
 */
export function assertReadOnly(assert, calls, allowed) {
  for (const call of calls) {
    for (const token of call.args) {
      assert.ok(!FORBIDDEN_TOKENS.includes(token.toLowerCase()), `mutating token "${token}" in: ${call.bin} ${call.args.join(" ")}`);
    }
    if (allowed !== undefined) {
      const args = normalizedArgs(call.args);
      const ok = allowed.some((prefix) => prefix.every((token, i) => args[i] === token));
      assert.ok(ok, `call outside the read-only allowlist: ${call.bin} ${call.args.join(" ")}`);
    }
  }
}

/** The read-only allowlists per CLI. */
export const READ_ONLY = {
  az: [
    ["account", "show"],
    ["webapp", "list"],
    ["webapp", "config", "show"],
    ["containerapp", "--help"],
    ["containerapp", "show"],
    ["containerapp", "list"],
    ["containerapp", "revision", "list"],
  ],
  kubectl: [
    ["version", "--client"],
    ["config", "get-contexts"],
    ["auth", "can-i", "get"],
    ["get", "deployment"],
    ["get", "deployments"],
    ["get", "pods"],
  ],
  docker: [
    ["version"],
    ["compose", "version"],
    ["compose", "ps"],
    ["compose", "ls"],
    ["container", "inspect"],
    ["image", "inspect"],
  ],
};

/** Awaits a promise expected to reject with an EngineError subclass; returns the error. */
export async function rejectsWith(assert, promise, { exitCode, name, message }) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected a rejection");
  assert.equal(caught.exitCode, exitCode, `exit code (${caught.message})`);
  if (name !== undefined) assert.equal(caught.name, name);
  if (message !== undefined) assert.match(caught.message, message);
  return caught;
}

/** Synthetic subscription ids. */
export const SUB = {
  one: "00000000-0000-0000-0000-000000000001",
  two: "00000000-0000-0000-0000-000000000002",
  three: "00000000-0000-0000-0000-000000000003",
};

/** A synthetic sha256 digest made of one repeated hex digit. */
export function digestOf(hexDigit) {
  return `sha256:${hexDigit.repeat(64)}`;
}
