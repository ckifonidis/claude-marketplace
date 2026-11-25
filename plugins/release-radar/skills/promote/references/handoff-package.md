# Handoff package

For a stage whose mode is `handoff`, another team deploys. `promote` triggers nothing there. It assembles a **handoff package**: the exact artefacts the receiving team needs, written to disk in the workspace repository, plus the context the skill adds in its answer. This file describes the package, its manifest, the settings diff, the secret checks and the blocking findings. Engine commands are described in the `SKILL.md` "Engine invocation" section. This file never shows an invocation.

## When and from what

- The stage must be a `handoff` stage. Any other mode is refused with exit **26** before anything is read from a deployment source.
- The **promoted commit is always named explicitly** (`--commit <sha>`, 7–40 hex characters, a commit in the member's local clone). The engine never defaults it. The skill passes the commit the user confirmed — normally what the stage *before* the handoff stage runs, taken from a fresh `deployment-status` — and the engine proves it with a live read (see "Image" below).
- The settings files come from the member's `component.json` **at the promoted commit** (`stages.<stage>.handoff.settingsFiles`, paths relative to the component root). A `component.json` missing or invalid at that commit is exit **24** ("<file> invalid at <sha>: <location>"); one that declares the stage `null` (not deployed) is exit **26**.
- The workspace files must be valid (24) and canonical (29) first, like for every command.

## Layout

```
<workspace>/.release-radar/handoff/<component>-<stage>-<YYYY>-<MM>-<DD>T<hh>-<mm>-<ss>-<mmm>Z[-<n>]/
  manifest.json
  files/<declared settings path>      one per declared file that exists at the promoted commit
```

The timestamp is UTC (`:` is not portable in file names); `-<n>` only appears when two packages are created in the same millisecond. Package directories are created exclusively and never overwritten. The copies are written first and the manifest last, so a directory without a manifest is an interrupted write (`format` quarantines it).

## Manifest

`manifest.json` is canonical (key order in `deployment-status/references/file-formats.md`) and passes `format --check` straight after it is written.

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `engineVersion` | the engine that wrote it |
| `createdAt` | ISO-8601 UTC, milliseconds |
| `component`, `stage` | the member and the handoff stage |
| `receivingOwner` | the stage's `promotion.owner`: the team that deploys it |
| `promotedCommit` | the full sha the package was built from |
| `complete` | `false` when there is any blocking finding |
| `blocking[]` | the blocking findings (below), sorted |
| `image` | `null` (see `blocking`), or `sourceStage`, `reference` (exactly as the source reported it), `repository` (the reference without tag and digest, as written), `tag` (or `null`), `digest` (`<algorithm>:<hex>` or the literal `digest unknown`), `targets[]` |
| `files[]` | per verbatim copy: `path` (as declared), `sourceCommit`, `sha256`, `bytes` |
| `settingsDiff` | `status` (`compared` / `not-compared`), `deployedCommit` (what the handoff stage runs now, or `null`), `reason` (why not compared, or `null`), `files[]` (one diff per declared file) |
| `beforePromote` | `workspace` (`workspace.json` `beforePromote[<stage>]`) and `component` (`handoff.beforePromote` at the promoted commit), each or `null`. Neither overrides the other; both are shown |
| `literalSecretWarnings[]` | `{ file, key }` — the file path and the JSON pointer of each value that looks like a literal secret. Never the value |

## Verbatim copies and their hashes

Each declared settings file is copied **byte for byte** from `git cat-file blob <promoted commit>:<path>`: nothing is decoded, re-encoded, re-formatted or redacted, because the file is the artefact the receiving team deploys. The manifest records each copy's sha256, byte length and source commit.

The copies are on the never-rewrite list. `format --check` verifies every copy against the manifest; a missing copy or one whose length or sha256 differs is `invalid` ("copy differs from <commit>", exit 24), and `format` never touches it. The remedy is to run `handoff-package` again.

File contents are **never printed** — not by the engine, not by the skill. The engine's output names the files and their sizes only (no hashes in the printed report).

## Image

The image is what the **upstream stage** (the stage before the handoff stage in the lifecycle) runs, from a live, read-only read of that stage. It is recorded only when:

- the upstream stage's declared targets are all found and all resolve to **the promoted commit**, and
- they agree on one image reference (repository and tag), and on one digest when digests are known.

The digest is the registry digest when the source reports one, else the reference's own `@sha256:…`, else `digest unknown`. Otherwise `image` is `null` and the reason is a blocking finding.

## Settings diff

The package carries a key-level diff of each declared settings file between the commit the handoff stage **runs now** (live read; the `deployed` side) and the **promoted** commit. When the handoff stage's commit cannot be resolved (not deployed yet, a missing target, an unresolvable tag, inconsistent targets), the diff is `not-compared` with the reason; that is not blocking. The same comparison is available on its own through the read-only `settings-diff` command, whose `--from` is the promoted side (a stage, `local` for the clone's HEAD commit, or a sha) and whose `--to` is the destination (a stage, or a sha together with `--stage`); a stage resolves to the single commit its targets run, from a live read, or the command says why it cannot (exit 23 for a missing target, 21 otherwise).

Per file, `status` is one of:

| Status | Meaning |
|---|---|
| `added` | absent at the deployed commit, present at the promoted commit |
| `removed` | present at the deployed commit, absent at the promoted commit |
| `absent` | absent at both |
| `unparseable` | a side is not strict JSON (YAML, `.env`, JSON with comments, …): only its **line count** is reported, per side |
| `changed` | both sides are JSON and some key-level difference exists |
| `unchanged` | both sides are JSON with no key-level difference (formatting changes only) |

For JSON files:

- Keys are **JSON pointers** (RFC 6901, e.g. `/Database/Password`). Objects are walked key by key; every other value — a scalar, an array, an empty object — is one leaf. Arrays are compared whole, so an element change reports the array's key as changed.
- `addedKeys` / `removedKeys`: leaves present on one side only. An added file lists all its keys as added, a removed file all as removed.
- `changedKeys`: leaves on both sides whose **value differs — the value is never shown**. Values are compared by hash in memory only; no value and no hash is ever output.
- `renamedKeys`: a **probable rename** pairs one removed key with one added key whose values are identical, when that value occurs on exactly one removed and one added key. The pair leaves the added/removed lists. A rename is evidence, not proof.
- `secretReferences`: the **names** of secret references (detectors below) referenced only on the promoted side (`added`), only on the deployed side (`removed`), or `renamed` at the same key (the old name no longer referenced anywhere in the promoted file and the new name not referenced anywhere in the deployed file).

### Secret-reference detectors

Every string value — array elements included — is searched. Each reference is reported as `<detector>:<name>`; a string may hold several. Detectors run in this order and a matched span is not searched again by later detectors.

| Detector | Recognises | Name reported |
|---|---|---|
| `azure-keyvault` | `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>[/<version>])` or `@Microsoft.KeyVault(VaultName=<vault>;SecretName=<name>[;SecretVersion=<v>])` (sovereign-cloud vault hosts included) | `<vault>/<name>` (vault lower-cased) |
| `azure-keyvault-uri` | a bare Key Vault secret URI `https://<vault>.vault.azure.net/secrets/<name>[/<version>]`, e.g. an App Configuration Key Vault reference | `<vault>/<name>` |
| `ci-secret` | a CI secret expression `${{ secrets.<NAME> }}` | `<NAME>` |
| `aws-secretsmanager` | `{{resolve:secretsmanager:<id>[:…]}}` or a Secrets Manager ARN `arn:aws:secretsmanager:<region>:<account>:secret:<name>` | `<id>` / `<name>` |
| `aws-ssm-secure` | `{{resolve:ssm-secure:<name>[:<version>]}}` | `<name>` |
| `gcp-secretmanager` | `projects/<project>/secrets/<name>[/versions/<v>]` or `sm://<project>/<name>` | `<project>/<name>` |
| `hashicorp-vault` | a Vault injector reference `vault:<path>#<key>` | `<path>#<key>` |

Placeholders substituted at deploy time (`$(NAME)`, `${NAME}`, `#{NAME}#`, …) are not secret references; they are simply not literal secrets.

## Literal-secret warnings

When a settings value looks like a **literal secret** rather than a reference, the engine warns **by file and key pointer** (in the manifest and on stderr), and the skill repeats the warning by key name. The value is never shown. A string value is warned about when it is **not** a secret reference (any detector, or anything containing `@Microsoft.KeyVault(`) and **not** a placeholder (empty, `${…}`, `$(…)`, `#{…}#`, `{{…}}`, `__NAME__`, `<…>`, `%NAME%`, `@@NAME@@`, or only mask characters such as `****`), and either:

- **its key name says it holds a credential**: the key is split into words (camelCase, `_`, `-`, `.`, `:`) and its last word is one of `password(s)`, `passwd`, `pwd`, `passphrase`, `secret(s)`, `token(s)`, `credential(s)`, `apikey(s)`, `connectionstring`, or its last two words are one of `api key`, `access key`, `account key`, `secret key`, `private key`, `signing key`, `encryption key`, `master key`, `shared key`, `subscription key`, `connection string`, `client secret`, `sas token`, or its last three are `shared access key` / `shared access signature` — so `dbPassword`, `CLIENT_SECRET` and `StorageAccountKey` qualify while `PasswordPolicy`, `TokenEndpoint` and `SecretName` do not. A `Key=Value;…` connection string under such a key is judged by its credential parameters only (next point); or
- **the value has a credential shape**, whatever the key: a PEM private key block, a JWT, a URL with a non-placeholder password (`scheme://user:password@host`), or a connection string whose `Password`, `Pwd`, `AccountKey`, `SharedAccessKey` or `SharedSecret` parameter is not a placeholder.

Numbers and booleans are never warned about. Only JSON files are checked; an unparseable file is not.

## Blocking findings and exit codes

A blocking finding means the package must **not** be handed over as it is. The package is still written — `complete: false`, the findings in `blocking[]` — so the evidence is on disk, and the run exits **23** with the full report:

- a declared settings path does not exist at the promoted commit ("settings file <path> does not exist at <sha>"); it is a blocking finding, not a configuration error, and has no copy;
- no image can be determined for the promoted commit: there is no upstream stage, the upstream stage does not deploy the component, a target is missing or unresolved, its targets disagree, or it runs a **different** commit than the promoted one.

| Exit | Meaning |
|---|---|
| 0 | complete package written |
| 23 | package written but **incomplete** (blocking findings) |
| 24 | invalid input, including `component.json` missing or invalid at the promoted commit |
| 26 | not a `handoff` stage, or the component declares the stage not deployed |
| 29 | non-canonical input (run `format` first) |
| 20 / 21 | the live read's preflight or source failed; nothing written |
| 64 | bad arguments: unknown component or stage, `--commit` missing, not a sha, or not in the local clone |

## What the receiving team gets

From the engine, in the package directory:

- the image reference and digest (or "digest unknown") to deploy;
- each declared settings file exactly as committed at the promoted commit;
- the manifest: hashes and source commit per file, the settings diff against what they run now (keys and secret-reference names only), literal-secret warnings by key, both `beforePromote` pointers, and themselves named as `receivingOwner`.

From the skill, in its answer: the fresh change-risk report for this promotion, the `beforePromote` pointer(s), the receiving owner, and any literal-secret warning by key name. Nothing is sent to anyone and nothing is triggered; handing the package over is the user's action.

## Retention and gitignore

After writing, the engine keeps the newest `handoffRetention` valid packages **for that component and stage** and deletes older valid ones; `format` applies the same rule to every (component, stage) pair. Packages that are invalid (e.g. a modified copy) are never deleted. Packages live in the workspace repository but are never committed: `.release-radar/handoff/` must be gitignored, together with `.release-radar/snapshots/`, `.release-radar/quarantine/` and `.release-radar/repos.local.json` (the `init-workspace` workflow proposes the lines and adds them only after the user confirms).
