# Real-world verification

A deployment report says which image a target runs. Real-world verification asks the application itself whether it works and which version it reports. Each component declares how it is proven to work, per stage, in its own `component.json`. Nothing is inferred: a component or stage without a `verification` block is reported as **"no real-world verification configured"**.

Verification runs only when someone asks for it: the `verify` command, `status --verify`, the skill's `--verify` form, or a natural-language request. It also runs automatically, once, as part of `promote`'s landed proof. Engine commands are described in the `SKILL.md` "Engine invocation" section. This file never shows an invocation.

## The `verification` block

The block sits inside a stage entry of `component.json`, next to `targets`:

| Key | Required | Meaning |
|---|---|---|
| `timeoutSeconds` | yes | Positive integer. Every check in the block uses this timeout, unless the check sets its own `timeoutSeconds`. This is documented semantics, not a fallback: the block value is required, so a timeout is never invented. It bounds the whole check: connect, headers and, for version checks, the body. |
| `checks` | yes | One or more checks, **sorted by `name`** in canonical form. Names are unique within the block. |

Keys shared by every check:

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | A lower-case name (`a-z 0-9 . _ -`) that is unique in the block. Results are reported under it, and the `verify` command's check selection uses it. |
| `type` | yes | `http`, `version` or `smoke`. |
| `target` | no | Narrows the check to one target of this stage. It must name a declared target. Without it, the check is **stage-wide**. |
| `timeoutSeconds` | no | Overrides the block's `timeoutSeconds` for this check only. |

### `http` check

| Key | Required | Meaning |
|---|---|---|
| `url` | yes | An absolute `http` or `https` URL. It must not carry credentials (`user:password@`). |
| `method` | yes | `GET` or `HEAD`. No other method exists, and the engine refuses to send one even if a file were altered to contain it. |
| `expectStatus` | yes | A list of one or more HTTP statuses (100–599), for example `[200]` or `[200, 204]`. |
| `headers` | no | A map from header name to `{ "env": "<ENV_VAR_NAME>" }`. See [Header values](#header-values-environment-variables-only). |

Redirects are **not followed**. A 3xx answer is just a status. It passes only when it is listed in `expectStatus`, and the `Location` is never requested.

### `version` check

| Key | Required | Meaning |
|---|---|---|
| `url` | yes | As for `http`. The request is always a `GET`. |
| `extract` | yes | How the version is taken from the response body. Use `{ "type": "json-path", "path": "$.build.commit" }` when the body is JSON; the path syntax is `$`, `.key` and `[n]`, and the value found must be a non-empty string or a number. Otherwise use `{ "type": "regex", "pattern": "..." }` with a **named group `version`**; the first match's group is the value. |
| `compare` | yes | `commit` or `tag`. See [Comparison rules](#comparison-rules). |
| `headers` | no | As for `http`. |

The application must answer with a 2xx status and a body of at most 1 MiB that yields a version of at most 200 characters. Anything else counts as **FAIL**, because the application answered but did not report its version.

### `smoke` check

| Key | Required | Meaning |
|---|---|---|
| `argv` | yes | The command as an argv array, for example `["acme-cli", "ping", "--stage", "stage-1"]`. It runs **without a shell**, with the engine's environment, and is killed at the timeout. Exit 0 passes. |

The engine cannot verify that a smoke command is read-only. That responsibility lies with the config author, as it does for the `command` adapter. Smoke commands run only on stages that the operator's team owns. See [Smoke commands and stage ownership](#smoke-commands-and-stage-ownership).

## Outcomes

| Outcome | When | Counts toward |
|---|---|---|
| **PASS** | The expectation is met: a listed status, a matching version, or exit 0. | — |
| **FAIL** | The application or command answered, but the expectation was not met. That covers an unlisted status (a 3xx included), a version mismatch, a version endpoint that answered non-2xx or without an extractable version, or a non-zero exit (or a termination by signal). | exit **28** |
| **UNREACHABLE** | No answer was obtained: a DNS failure, a refused or reset connection, a TLS failure, a timeout, or a smoke command that was not found or never exited. | exit **30** |
| **INCONCLUSIVE** | A version check whose endpoint answered with a version, but the **expected version could not be determined**. The reason starts with "expected version unknown", and the extracted value is still recorded. | exit **30** |
| **NOT-RUN** | A smoke check on a stage that the operator's team does not own. The reason is "not run (stage not owned)". | nothing |

**UNREACHABLE is never FAIL.** An unanswered check proves nothing about the application, so it can never produce exit 28.

Report the overall verdict as follows:

- **FAIL** when any check failed.
- Otherwise **INCONCLUSIVE** when any check is UNREACHABLE or INCONCLUSIVE.
- Otherwise **PASS** when at least one check passed.
- Otherwise **NO-CHECKS**: nothing ran, because no block was configured or only non-owned smoke checks were declared.

## Comparison rules

- **`tag`**: exact string equality. `v1.0.0` and `1.0.0` differ, and so do `RC1` and `rc1`.
- **`commit`**: the values are equal when both are hexadecimal, one is a prefix of the other (case-insensitive), and the shorter one has **at least 7 characters**. The rule works both ways: an application reporting `3f2a9c1` matches the full 40-character sha, and so does the reverse. A 6-character value never matches.

**The expected value** is one of two things:

- **`--expect <sha|tag>`**, when given. `promote` passes the commit or tag it has just built. The value applies to every version check in scope, and no deployment source is read. For a check that compares `commit`, it must be 7–40 hex characters, otherwise the run exits **64** before any request.
- **Otherwise**, the commit (for `compare: "commit"`) or the image tag (for `compare: "tag"`) that the target is reported to run. It comes from a live status read in the same run, which uses the same read-only adapter and git calls as `status`.

  A check with a `target` uses that target. A stage-wide check considers every target of the stage, and they must all agree on a single value.

The expected version is **unknown**, and the check is INCONCLUSIVE, when any of these holds:

- the target is missing at the source;
- its commit is not resolved (`tag-not-found`, `no-clone`, `no-convention`, `git-error`);
- the image is pinned by digest;
- the target runs no single container image;
- the targets of the stage run different versions. In that case, add a `target` to the check, or pass `--expect`.

## Header values: environment variables only

A header value is **never written in a file**. A check names an environment variable for each header:

```json
"headers": { "X-Acme-Health-Key": { "env": "ACME_HEALTH_KEY" } }
```

- The operator sets the variable in the shell that starts the engine, for example from a secret manager or a shell profile that is not committed. Only its **name** is ever shown, in error messages, reports and docs.
- Before **any** check runs, and before any deployment source is read, the engine checks every variable that the selected checks need. A variable that is absent or empty, or that holds control characters (not a valid header value), fails the run with **exit 20**. The message names each variable and the check that needs it, and no report or snapshot is written.
- Values are read only at the moment of the request. They never appear in output, logs, snapshots, error messages or handoff packages.

## Smoke commands and stage ownership

- On a stage owned by `operatorTeam`, smoke checks run like any other check.
- On a stage another team owns, **only HTTP and version checks run**. A declared smoke check is reported as **NOT-RUN, "not run (stage not owned)"**. It is never started and does not affect the exit code. Declaring one there is not a configuration error.
- An **explicit request** to run a smoke check on such a stage, by naming it in the `verify` command's check selection, is refused with **exit 26** before any check runs. No HTTP request is sent either. There is no per-run override.

## Selecting what runs (`verify`)

| Option | Meaning |
|---|---|
| stage (required) | Verification blocks are per stage, and one expected version fits one stage. To cover every stage, use `status --verify`. |
| target | Runs that target's checks **plus** the stage-wide checks. It must name a declared target, otherwise exit 64. |
| check selection | A comma-separated list of check names. This counts as the explicit request described above. An unknown name exits 64. |
| expected version | As described under [Comparison rules](#comparison-rules). |

The target, check-selection and expected-version options each require exactly one component. Unknown component, stage, target and check names exit **64** before any call, and the message lists the valid names.

`verify` writes no snapshot. `status --verify` adds the results to the status report, and its snapshot holds them (requirement 50). That snapshot is written on exits 0, 22, 23, 28 and 30.

## What is recorded, and what never is

For each check, the report and the `status --verify` snapshot record:

| Field | Meaning |
|---|---|
| `component`, `stage`, `name`, `type`, `target` | Which check this is. `target` is `null` for a stage-wide check. |
| `outcome` | `PASS`, `FAIL`, `UNREACHABLE`, `INCONCLUSIVE` or `NOT-RUN`. |
| `httpStatus` | The answer's status (HTTP and version checks that got one), otherwise `null`. |
| `exitCode` | The smoke command's exit code when it exited, otherwise `null`. |
| `latencyMs` | Milliseconds until the answer: the headers for `http`, the full body for `version`, the exit for `smoke`. On a timeout, the time until the engine gave up. `null` when not run. |
| `extracted` | The version value the application reported (version checks only), otherwise `null`. |
| `expected` | `{ value, source: "expect" | "status" }` for a version check with a known expected version, otherwise `null`. |
| `reason` | One human sentence explaining the outcome. |

The section also lists one `blocks[]` entry for each component/stage pair in scope:

- `status` is `configured`, `not-configured` ("no real-world verification configured") or `not-deployed`.
- `smoke` is `run` or `not-run-stage-not-owned`.
- `selected` is the number of checks selected.

The section also carries `summary` counts, the overall `outcome` and the `exitCode` (0, 28 or 30).

**Never recorded or printed:** response bodies, header values, URL queries, and command output beyond the exit code. Only GET and HEAD requests are ever sent to an application.

## Exit codes

| Code | Meaning here |
|---|---|
| **28** | At least one check FAILED. |
| **30** | Verification inconclusive: at least one check is UNREACHABLE or INCONCLUSIVE, and none FAILED. Say plainly that this is not a failure verdict. |
| **20** | A header environment variable is missing, empty or invalid. This is a credential problem, not a verification failure. No check ran. With `verify` and no `--expect`, an adapter preflight failure for the live status read is also 20 (or 21). |
| **26** | A smoke check was explicitly requested on a stage that the operator's team does not own. Nothing ran. |
| **64** | An unknown component, stage, target or check; a missing stage; an option that needs exactly one component; or an `--expect` that is not a sha for a commit comparison. |

When codes combine, for example in `status --verify`, the precedence is **64 > 24 > 29 > 20 > 26 > 27 > 21 > 25 > 23 > 28 > 30 > 22**. For example, a missing target together with a FAIL exits 23; a FAIL together with an UNREACHABLE exits 28; and an inconclusive verification together with a tripped drift gate exits 30. The report still carries every result.

## Example block (synthetic)

```json
"stage-1": {
  "targets": [
    { "name": "api", "adapter": "azure-appservice", "webapp": "acme-api-stage1" }
  ],
  "verification": {
    "timeoutSeconds": 10,
    "checks": [
      {
        "name": "health",
        "type": "http",
        "target": "api",
        "url": "https://acme-api.stage-1.example.com/health",
        "method": "GET",
        "expectStatus": [200, 204],
        "headers": { "X-Acme-Health-Key": { "env": "ACME_HEALTH_KEY" } }
      },
      {
        "name": "smoke-ping",
        "type": "smoke",
        "argv": ["acme-cli", "ping", "--stage", "stage-1"],
        "timeoutSeconds": 30
      },
      {
        "name": "version",
        "type": "version",
        "target": "api",
        "url": "https://acme-api.stage-1.example.com/version",
        "extract": { "type": "json-path", "path": "$.build.commit" },
        "compare": "commit",
        "timeoutSeconds": 5
      }
    ]
  }
}
```

In this example, `health` sends a GET with the `X-Acme-Health-Key` header taken from `ACME_HEALTH_KEY`, and passes on 200 or 204. `smoke-ping` runs only when `stage-1` is owned by the operator's team, and it has 30 seconds to exit 0. `version` compares the commit reported at `$.build.commit` with the commit that `api` is reported to run, or with `--expect`, within 5 seconds. Every other check uses the block's 10 seconds.
