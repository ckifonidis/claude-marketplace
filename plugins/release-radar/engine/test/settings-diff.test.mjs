// settings-diff (spec requirements 56, 73, 76 "settings-diff (no values in the output)", acceptance
// criterion 10): added / removed / renamed / changed keys, secret-reference names added / removed /
// renamed, unparseable files as line counts, files added and removed, endpoint resolution — and
// no value from either side ever reaches stdout, stderr or --json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  SECRET_REFERENCE_DETECTORS,
  analyzeSettings,
  diffSettingsFile,
  isSecretKeyName,
  lineCount,
  literalSecretPointers,
  secretReferenceNames,
} from "../dist/settings-diff.js";
import { runCli } from "./fixtures/cli-harness.mjs";
import { SETTINGS_V1, SETTINGS_V2, assertNoValues, handoffFleet } from "./fixtures/handoff-fixtures.mjs";
import { commitAll, git } from "./fixtures/workspace-fixtures.mjs";

const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

test("56: key-level diff — added, removed, changed (no value), probable rename, secret-reference names", () => {
  const diff = diffSettingsFile("config/appsettings.json", analyzeSettings(json(SETTINGS_V1)), analyzeSettings(json(SETTINGS_V2)));
  assert.equal(diff.status, "changed");
  assert.deepEqual(diff.parse, { deployed: "json", promoted: "json" });
  assert.deepEqual(diff.addedKeys, ["/Cache/Size", "/Payments/ClientSecret", "/Storage"]);
  assert.deepEqual(diff.removedKeys, ["/Queue/Conn", "/Removed"]);
  assert.deepEqual(diff.changedKeys, ["/Database/Password", "/Logging/Level"]);
  assert.deepEqual(diff.renamedKeys, [{ from: "/Old/FeatureFlag", to: "/New/FeatureFlag" }]);
  assert.deepEqual(diff.secretReferences, {
    added: ["azure-keyvault:acme-kv/storage-key"],
    removed: ["azure-keyvault:acme-kv/queue-conn"],
    renamed: [{ pointer: "/Database/Password", from: "azure-keyvault:acme-kv/db-password", to: "azure-keyvault:acme-kv/db-password-v2" }],
  });
  assertNoValues(assert, JSON.stringify(diff), "diff object");
});

test("56: renames need a unique value hash on both sides; ambiguous hashes pair nothing", () => {
  const deployed = analyzeSettings(json({ a: "same", b: "same", c: "unique-1" }));
  const promoted = analyzeSettings(json({ x: "same", y: "same", z: "unique-1" }));
  const diff = diffSettingsFile("s.json", deployed, promoted);
  assert.deepEqual(diff.renamedKeys, [{ from: "/c", to: "/z" }]);
  assert.deepEqual(diff.addedKeys, ["/x", "/y"]);
  assert.deepEqual(diff.removedKeys, ["/a", "/b"]);
});

test("56: arrays are compared whole; empty objects are leaves; key reformatting alone is unchanged", () => {
  const diff = diffSettingsFile("s.json", analyzeSettings(json({ hosts: ["a", "b"], empty: {} })), analyzeSettings(json({ empty: {}, hosts: ["a", "c"] })));
  assert.deepEqual(diff.changedKeys, ["/hosts"]);
  assert.deepEqual([diff.addedKeys, diff.removedKeys], [[], []]);
  const same = diffSettingsFile("s.json", analyzeSettings(Buffer.from('{"b":1,"a":{"c":[1,2]}}')), analyzeSettings(json({ a: { c: [1, 2] }, b: 1 })));
  assert.equal(same.status, "unchanged");
});

test("56: file added / removed / absent, and unparseable files as line counts only", () => {
  const promoted = analyzeSettings(json({ Brand: { Name: "brand-name-value-ii9" } }));
  const added = diffSettingsFile("new.json", analyzeSettings(null), promoted);
  assert.equal(added.status, "added");
  assert.deepEqual(added.addedKeys, ["/Brand/Name"]);
  assert.equal(diffSettingsFile("old.json", promoted, analyzeSettings(null)).status, "removed");
  assert.equal(diffSettingsFile("none.json", analyzeSettings(null), analyzeSettings(null)).status, "absent");
  const env = diffSettingsFile("x.env", analyzeSettings(Buffer.from("A=1\nB=2\n")), analyzeSettings(Buffer.from("A=1\nB=3\nC=4")));
  assert.equal(env.status, "unparseable");
  assert.deepEqual(env.parse, { deployed: "unparseable", promoted: "unparseable" });
  assert.deepEqual(env.lines, { deployed: 2, promoted: 3 });
  assert.deepEqual([env.addedKeys, env.removedKeys, env.changedKeys, env.secretReferences.added], [[], [], [], []]);
  // JSON with comments is not strict JSON: unparseable, and the parser message (which could quote content) is dropped.
  const commented = analyzeSettings(Buffer.from('{\n  // comment-value-secret\n  "a": 1\n}\n'));
  assert.equal(commented.parse, "unparseable");
  assert.equal(commented.lines, 4);
  assert.equal(lineCount(Buffer.from("")), 0);
});

test("56: the documented secret-reference detector set", () => {
  assert.deepEqual(
    SECRET_REFERENCE_DETECTORS.map((detector) => detector.id),
    ["azure-keyvault", "azure-keyvault-uri", "ci-secret", "aws-secretsmanager", "aws-ssm-secure", "gcp-secretmanager", "hashicorp-vault"],
  );
  const cases = [
    ["@Microsoft.KeyVault(VaultName=Acme-KV;SecretName=db-pass;SecretVersion=abc)", ["azure-keyvault:acme-kv/db-pass"]],
    ["@Microsoft.KeyVault(SecretUri=https://acme-kv.vault.azure.net/secrets/db-pass/0123abcd)", ["azure-keyvault:acme-kv/db-pass"]],
    ["https://acme-kv.vault.azure.net/secrets/plain-ref", ["azure-keyvault-uri:acme-kv/plain-ref"]],
    ["Bearer ${{ secrets.API_TOKEN }} and ${{secrets.OTHER}}", ["ci-secret:API_TOKEN", "ci-secret:OTHER"]],
    ["{{resolve:secretsmanager:acme/db:SecretString:password}}", ["aws-secretsmanager:acme/db"]],
    ["arn:aws:secretsmanager:eu-west-1:123456789012:secret:acme-db-AbCdEf", ["aws-secretsmanager:acme-db-AbCdEf"]],
    ["{{resolve:ssm-secure:/acme/db/password:3}}", ["aws-ssm-secure:/acme/db/password"]],
    ["projects/acme-proj/secrets/db-pass/versions/latest", ["gcp-secretmanager:acme-proj/db-pass"]],
    ["sm://acme-proj/db-pass", ["gcp-secretmanager:acme-proj/db-pass"]],
    ["vault:secret/data/acme/db#password", ["hashicorp-vault:secret/data/acme/db#password"]],
    ["a plain value", []],
    ["$(DB_PASSWORD)", []],
  ];
  for (const [value, names] of cases) assert.deepEqual(secretReferenceNames(value), names, value);
});

test("64: the literal-secret heuristic — secret-named keys and credential-shaped values, never references or placeholders", () => {
  for (const key of ["Password", "dbPassword", "CLIENT_SECRET", "ClientSecret", "api-key", "ApiKey", "AccessToken", "ConnectionString", "StorageAccountKey", "SharedAccessKey", "SasToken"]) {
    assert.ok(isSecretKeyName(key), key);
  }
  for (const key of ["PasswordPolicy", "TokenEndpoint", "SecretName", "KeyVaultName", "CacheKey", "Host", "TokenLifetimeMinutes"]) assert.ok(!isSecretKeyName(key), key);
  const pointers = literalSecretPointers({
    Db: { Password: "literal-pass-1", ConnectionString: "Server=x;Password=${DB_PASS}" },
    Kv: { Password: "@Microsoft.KeyVault(VaultName=acme-kv;SecretName=db)" },
    Placeholders: { Password: "#{DB_PASSWORD}#", ApiKey: "__API_KEY__", Token: "", Secret: "<your-secret>", Pwd: "********" },
    Ci: { ApiKey: "${{ secrets.API_KEY }}" },
    ConnectionStrings: { Main: "Server=db;User Id=app;Password=hunter22;" },
    Urls: { Broker: "amqp://app:pa55word@broker.example:5672", Plain: "https://api.example" },
    Pem: { Cert: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----" },
    Numbers: { TokenTtl: 30, Password: 1234 },
    List: { Tokens: ["literal-in-array"] },
  });
  assert.deepEqual(pointers, ["/ConnectionStrings/Main", "/Db/Password", "/List/Tokens/0", "/Pem/Cert", "/Urls/Broker"].sort());
});

test("56/73/76: settings-diff CLI — stage to stage, every category, and no value anywhere in the output", (t) => {
  const fx = handoffFleet(t);
  const r = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", fx.commits.c2, "--to", "stage-3", "--json"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.promoted.sha, fx.commits.c2);
  assert.equal(r.json.promoted.kind, "commit");
  assert.equal(r.json.deployed.sha, fx.commits.c1, "stage-3 runs v1.0.0 = c1, from a live read");
  assert.equal(r.json.deployed.stage, "stage-3");
  assert.equal(r.json.stage, "stage-3");
  assert.equal(r.json.componentConfig.revision, fx.commits.c2, "the file list comes from component.json at the promoted commit");
  assert.deepEqual(r.json.componentConfig.differencesFromWorkingTree, ["/stages/stage-3/handoff/settingsFiles"]);
  assert.deepEqual(r.json.declared, ["config/appsettings.json", "config/extra.env", "config/legacy.json", "config/new.json"]);
  const byPath = Object.fromEntries(r.json.files.map((file) => [file.path, file]));
  assert.equal(byPath["config/appsettings.json"].status, "changed");
  assert.deepEqual(byPath["config/appsettings.json"].renamedKeys, [{ from: "/Old/FeatureFlag", to: "/New/FeatureFlag" }]);
  assert.equal(byPath["config/extra.env"].status, "unparseable");
  assert.deepEqual(byPath["config/extra.env"].lines, { deployed: 2, promoted: 3 });
  assert.equal(byPath["config/legacy.json"].status, "removed");
  assert.equal(byPath["config/new.json"].status, "added");
  assertNoValues(assert, r.out, "--json run");

  const human = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", fx.commits.c2, "--to", "stage-3"]);
  assert.equal(human.status, 0, human.out);
  assert.match(human.stdout, /config\/legacy\.json: file REMOVED/);
  assert.match(human.stdout, /config\/new\.json: file ADDED/);
  assert.match(human.stdout, /config\/extra\.env: unparseable .*\n\s+deployed: 2 lines, unparseable; promoted: 3 lines, unparseable/);
  assert.match(human.stdout, /~ probable rename \/Old\/FeatureFlag → \/New\/FeatureFlag \(same value\)/);
  assert.match(human.stdout, /\* value changed at \/Logging\/Level \(value not shown\)/);
  assert.match(human.stdout, /~ secret reference at \/Database\/Password: azure-keyvault:acme-kv\/db-password → azure-keyvault:acme-kv\/db-password-v2/);
  assert.match(human.stdout, /- secret reference azure-keyvault:acme-kv\/queue-conn/);
  assertNoValues(assert, human.out, "human run");
});

test("56: --from <stage> / local resolve through the live read and HEAD; the stage's list comes from that commit", (t) => {
  const fx = handoffFleet(t);
  const fromStage = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", "stage-2", "--to", "stage-3", "--json"]);
  assert.equal(fromStage.status, 0, fromStage.out);
  assert.equal(fromStage.json.promoted.sha, fx.commits.c3);
  assert.deepEqual(fromStage.json.promoted.targets, ["api"]);
  assert.deepEqual(fromStage.json.declared, ["config/appsettings.json", "config/extra.env", "config/new.json"]);
  assert.deepEqual(fromStage.json.componentConfig.differencesFromWorkingTree, []);
  const local = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", "local", "--to", fx.short.c1, "--stage", "stage-3", "--json"]);
  assert.equal(local.status, 0, local.out);
  assert.equal(local.json.promoted.kind, "local");
  assert.equal(local.json.promoted.sha, fx.commits.c3);
  assert.equal(local.json.deployed.kind, "commit");
  assert.equal(local.json.deployed.sha, fx.commits.c1);
  assert.deepEqual(local.json.preflight, [], "no stage endpoint → no adapter call at all");
  assertNoValues(assert, local.out, "local run");
});

test("56: a destination without handoff artefacts says so (exit 0); argument and resolution failures", (t) => {
  const fx = handoffFleet(t);
  const none = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", "local", "--to", "stage-2", "--json"]);
  assert.equal(none.status, 0, none.out);
  assert.match(none.json.note, /stage "stage-2" is a "pipeline" stage/);
  assert.deepEqual(none.json.files, []);
  const cases = [
    [["--from", "local", "--to", "stage-3", "--stage", "stage-2"], /disagrees with --to/],
    [["--from", "local", "--to", fx.short.c1], /--stage <name>/],
    [["--from", "local", "--to", "local"], /"local" is not accepted here/],
    [["--from", "nope", "--to", "stage-3"], /not a stage \(stage-1, stage-2, stage-3\), local, a commit sha/],
    [["--from", "stage-3", "--to", "stage-3"], /the same stage/],
    [["--from", "abcdef0123", "--to", "stage-3"], /not a commit in the local clone/],
    [["--to", "stage-3"], /requires --from/],
  ];
  for (const [args, pattern] of cases) {
    const r = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", ...args]);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.out}`);
    assert.match(r.stderr, pattern);
  }
  // A stage whose target does not exist: 23 with the report; nothing substituted.
  installMissing(fx);
  const missing = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", "local", "--to", "stage-3", "--json"]);
  assert.equal(missing.status, 23, missing.out);
  assert.equal(missing.json.deployed.status, "missing");
  assert.deepEqual(missing.json.files, []);
});

function installMissing(fx) {
  fx.h.install("acme-deploy", [
    { match: ["show", "stage-2", "api"], stdout: { image: `registry.example.com/acme/api:${fx.short.c3}` } },
    { match: ["show", "stage-3", "api"], stdout: { image: null } },
  ]);
}

test("84: component.json missing or invalid at the promoted commit → 24 naming the commit; non-canonical input → 29", (t) => {
  const fx = handoffFleet(t);
  const root = git(fx.api, "rev-list", "--max-parents=0", "HEAD");
  const missing = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", root, "--to", "stage-3"]);
  assert.equal(missing.status, 24, missing.out);
  assert.match(missing.stderr, new RegExp(`no component config at ${root}`));
  git(fx.api, "checkout", "-q", "-b", "broken");
  const broken = { ...JSON.parse(readFileSync(fx.apiComponent, "utf8")), surplus: true };
  writeFileSync(fx.apiComponent, `${JSON.stringify(broken, null, 2)}\n`);
  const bad = commitAll(fx.api, "chore: broken component.json");
  git(fx.api, "checkout", "-q", "main");
  const invalid = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", bad, "--to", "stage-3"]);
  assert.equal(invalid.status, 24, invalid.out);
  assert.match(invalid.stderr, new RegExp(`invalid at ${bad}: .*unknown key "surplus"`));
  const reordered = Object.fromEntries(Object.entries(JSON.parse(readFileSync(fx.workspaceFile, "utf8"))).reverse());
  writeFileSync(fx.workspaceFile, `${JSON.stringify(reordered, null, 2)}\n`);
  const nonCanonical = runCli(assert, fx.h, ["settings-diff", ...fx.ws, "acme-api", "--from", "local", "--to", "stage-3"]);
  assert.equal(nonCanonical.status, 29, nonCanonical.out);
  assert.match(nonCanonical.stderr, /non-canonical input \(run format first\)/);
});
