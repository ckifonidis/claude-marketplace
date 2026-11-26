// handoff-package (spec requirements 35, 39, 64, 73, 76 "Handoff", 82a, 86): package layout,
// verbatim copies whose manifest hashes match, the image from the upstream stage's live read,
// literal-secret warnings by key name with the value absent from all output, blocking findings,
// the handoff-mode refusal, retention, and `format --check` on the freshly written package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../dist/format.js";
import { HANDOFF_MANIFEST_SCHEMA } from "../dist/handoff.js";
import { ref, runCli } from "./fixtures/cli-harness.mjs";
import { assertNoValues, handoffFleet } from "./fixtures/handoff-fixtures.mjs";

const DIGEST = `sha256:${"ab12".repeat(16)}`;

function packages(platform) {
  const dir = join(platform, ".release-radar", "handoff");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function gitBytes(repo, spec) {
  return execFileSync("git", ["-C", repo, "cat-file", "blob", spec], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

test("64/35/82a: the package — canonical manifest, verbatim copies with matching sha256, image, diff, pointers, owner", (t) => {
  const fx = handoffFleet(t);
  const r = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", "--stage", "stage-3", "--commit", fx.short.c3, "--json"]);
  assert.equal(r.status, 0, r.out);
  const names = packages(fx.platform);
  assert.equal(names.length, 1);
  assert.match(names[0], /^acme-api-stage-3-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  const dir = join(fx.platform, ".release-radar", "handoff", names[0]);
  assert.equal(r.json.package.dir, dir);
  assert.deepEqual(readdirSync(dir).sort(), ["files", "manifest.json"]);

  const text = readFileSync(join(dir, "manifest.json"), "utf8");
  assert.equal(classify(text, HANDOFF_MANIFEST_SCHEMA, "manifest.json").state, "canonical", "written canonically");
  const manifest = JSON.parse(text);
  assert.deepEqual(Object.keys(manifest), [
    "schemaVersion", "engineVersion", "createdAt", "component", "stage", "receivingOwner", "promotedCommit", "complete",
    "blocking", "image", "files", "settingsDiff", "beforePromote", "literalSecretWarnings",
  ]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.component, "acme-api");
  assert.equal(manifest.stage, "stage-3");
  assert.equal(manifest.receivingOwner, "ops-team");
  assert.equal(manifest.promotedCommit, fx.commits.c3, "the short --commit is recorded as the full sha");
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.blocking, []);
  assert.deepEqual(manifest.image, { sourceStage: "stage-2", reference: ref("api", fx.short.c3), repository: "registry.example.com/acme/api", tag: fx.short.c3, digest: "digest unknown", targets: ["api"] });
  assert.deepEqual(manifest.beforePromote, { workspace: "acme-release-review", component: "acme-api-ops-notes" });

  // Verbatim copies: byte-identical to git at the promoted commit, hashes and lengths recorded.
  assert.deepEqual(manifest.files.map((file) => file.path), ["config/appsettings.json", "config/extra.env", "config/new.json"]);
  for (const file of manifest.files) {
    const copy = readFileSync(join(dir, "files", ...file.path.split("/")));
    assert.ok(copy.equals(gitBytes(fx.api, `${fx.commits.c3}:${file.path}`)), `${file.path} is byte-identical to the commit`);
    assert.equal(file.sha256, createHash("sha256").update(copy).digest("hex"));
    assert.equal(file.bytes, copy.length);
    assert.equal(file.sourceCommit, fx.commits.c3);
  }

  // Settings diff against what stage-3 runs (c1), names only.
  assert.equal(manifest.settingsDiff.status, "compared");
  assert.equal(manifest.settingsDiff.deployedCommit, fx.commits.c1);
  assert.deepEqual(manifest.settingsDiff.files.map((file) => [file.path, file.status]), [
    ["config/appsettings.json", "changed"],
    ["config/extra.env", "unparseable"],
    ["config/new.json", "added"],
  ]);
  assert.deepEqual(manifest.literalSecretWarnings, [{ file: "config/appsettings.json", key: "/Payments/ClientSecret" }]);

  // The literal secret is warned about BY KEY; no value from the files appears in any output or in the manifest.
  assert.match(r.stderr, /config\/appsettings\.json \/Payments\/ClientSecret looks like a literal secret, not a secret reference \(value not shown\)/);
  assertNoValues(assert, r.out, "handoff --json output");
  assertNoValues(assert, text, "manifest");
  const human = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", "--stage", "stage-3", "--commit", fx.commits.c3]);
  assert.equal(human.status, 0, human.out);
  assert.match(human.stdout, /receiving owner: ops-team; nothing was sent or triggered/);
  assert.match(human.stdout, /beforePromote: workspace acme-release-review; component acme-api-ops-notes/);
  assertNoValues(assert, human.out, "handoff human output");

  // Straight after writing, format --check sees the manifest canonical and the copies verbatim.
  const check = runCli(assert, fx.h, ["format", "--check", ...fx.ws, "--include-members", "--json"]);
  assert.equal(check.status, 0, check.out);
  const handoffFiles = check.json.files.filter((file) => file.kind.startsWith("handoff"));
  assert.equal(handoffFiles.length, 8, "two packages: a manifest and three copies each");
  for (const file of handoffFiles) assert.equal(file.state, "canonical", file.file);
  assert.ok(handoffFiles.filter((file) => file.kind === "handoff-copy").every((file) => file.action === "never-rewritten"));
});

test("64: the digest is recorded when the upstream source reports one", (t) => {
  const fx = handoffFleet(t);
  fx.h.install("acme-deploy", [
    { match: ["show", "stage-2", "api"], stdout: { image: `${ref("api", fx.short.c3)}@${DIGEST}` } },
    { match: ["show", "stage-3", "api"], stdout: { image: ref("api", "1.0.0") } },
  ]);
  const r = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", "--stage", "stage-3", "--commit", fx.commits.c3, "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.image.digest, DIGEST);
  assert.equal(r.json.image.repository, "registry.example.com/acme/api");
});

test("35/64: a settings path missing at the promoted commit is a BLOCKING finding — package written incomplete, exit 23", (t) => {
  const fx = handoffFleet(t);
  // c2 declares config/legacy.json, which c2 deleted; stage-2 runs c3, not c2.
  const r = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", "--stage", "stage-3", "--commit", fx.commits.c2, "--json"]);
  assert.equal(r.status, 23, r.out);
  assert.equal(r.phase, "blocking");
  assert.equal(r.json.complete, false);
  assert.deepEqual(r.json.blocking, [
    `image unknown: upstream stage "stage-2" runs ${fx.short.c3}, not the promoted commit ${fx.short.c2}`,
    `settings file config/legacy.json does not exist at ${fx.commits.c2}`,
  ]);
  assert.equal(r.json.image, null);
  assert.match(r.stderr, /the package is INCOMPLETE — 2 blocking finding\(s\); do not hand it over/);
  const manifest = JSON.parse(readFileSync(r.json.package.manifest, "utf8"));
  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.files.map((file) => file.path), ["config/appsettings.json", "config/extra.env", "config/new.json"], "the missing file has no copy");
  assert.ok(!existsSync(join(r.json.package.dir, "files", "config", "legacy.json")));
  assertNoValues(assert, r.out, "blocking run");
  // A blocking package is still a valid engine file.
  const check = runCli(assert, fx.h, ["format", "--check", ...fx.ws, "--json"]);
  assert.equal(check.status, 0, check.out);
});

test("26/64: refusals — a non-handoff stage, a stage the component does not deploy; 64 for a commit outside the clone", (t) => {
  const fx = handoffFleet(t);
  const pipeline = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", "--stage", "stage-2", "--commit", fx.commits.c3]);
  assert.equal(pipeline.status, 26, pipeline.out);
  assert.match(pipeline.stderr, /stage "stage-2" is a "pipeline" stage: handoff packages are assembled only for "handoff" stages/);
  const worker = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-worker", "--stage", "stage-3", "--commit", fx.commits.w1]);
  assert.equal(worker.status, 26, worker.out);
  assert.match(worker.stderr, /declares stage "stage-3" as not deployed \(null\)/);
  for (const [args, pattern] of [
    [["--stage", "stage-3", "--commit", "0123456789abcdef"], /not a commit in the local clone/],
    [["--stage", "stage-3", "--commit", "local"], /not a commit sha \(7-40 hex characters\); the promoted commit is never defaulted/],
    [["--stage", "stage-3"], /requires --commit <sha>/],
    [["--stage", "nope", "--commit", fx.commits.c3], /unknown stage "nope"/],
  ]) {
    const r = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", ...args]);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, pattern);
  }
  assert.deepEqual(packages(fx.platform), [], "no refusal writes anything");
  assert.equal(fx.h.calls("acme-deploy").length, 0, "refusals happen before any adapter call");
});

test("39: handoff retention keeps exactly handoffRetention packages per component and stage", (t) => {
  const fx = handoffFleet(t); // handoffRetention 2
  for (let run = 0; run < 4; run++) {
    const r = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", "--stage", "stage-3", "--commit", fx.commits.c3, "--json"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.json.retention.keep, 2);
    assert.equal(r.json.retention.deleted.length, run >= 2 ? 1 : 0);
  }
  const kept = packages(fx.platform);
  assert.equal(kept.length, 2);
});

test("82a/86: a modified verbatim copy is invalid ('copy differs from <commit>') and format never rewrites it", (t) => {
  const fx = handoffFleet(t);
  const r = runCli(assert, fx.h, ["handoff-package", ...fx.ws, "acme-api", "--stage", "stage-3", "--commit", fx.commits.c3, "--json"]);
  assert.equal(r.status, 0, r.out);
  const copy = join(r.json.package.dir, "files", "config", "new.json");
  const edited = '{ "Brand": {"Name": "edited"} }';
  writeFileSync(copy, edited);
  for (const args of [["format", "--check"], ["format"]]) {
    const f = runCli(assert, fx.h, [...args, ...fx.ws, "--json"]);
    assert.equal(f.status, 24, f.out);
    const entry = f.json.files.find((file) => file.file === copy);
    assert.equal(entry.state, "invalid");
    assert.equal(entry.action, "left-invalid");
    assert.match(entry.error.message, new RegExp(`copy differs from ${fx.commits.c3}`));
    assert.equal(readFileSync(copy, "utf8"), edited, "the copy is never re-formatted");
    assert.ok(existsSync(copy), "and never deleted");
  }
});
