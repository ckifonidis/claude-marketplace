# Workflow: Add (or upgrade) Kafka observability

Install or upgrade the vendored `src/observability/` library in the current repo and wire
it. Follow the steps in order; the approval gate is Step 3.

## Step 1: Detect

1. Resolve the plugin directory and read `templates/observability/VERSION` (the shipped
   library version).
2. Qualify the repo: `package.json` must depend on `@langchain/core` or
   `@langchain/langgraph`. If neither, stop and tell the user why.
3. Mode:
   - `src/observability/VERSION` absent → **first install**.
   - Present and older than shipped → **upgrade**: collect the applicable
     `<plugin>/migrations/<from>-to-<to>.md` files (in version order). Their
     `<transforms>` cover project-level integration edits only — the library files are
     always replaced wholesale.
   - Present and equal → report "already current: <version>" and STOP.
4. Locate the integration points:
   - **Graph entry module**: the module `langgraph.json` points at (e.g. `src/graph.ts`),
     falling back to the module that builds/exports the compiled graph.
   - **Env example**: `.env.example` (or equivalent).
   - **Deployment settings**: `configuration/**/settings.*.json` if present.
   - **Docker**: `Dockerfile` if present (native-module check, Step 7).
   - **Existing LangSmith config**: note `LANGSMITH_*` usage for the parallel-run report.

## Step 2: Gather inputs

Per the SKILL.md intake: `APPLICATION_NAME` (propose snake_cased package name), brokers +
topic (per environment where deployment settings exist), security mode (PLAINTEXT vs SASL
+ Key Vault secret name for the password), enable-now-or-ship-disabled (default disabled),
and which settings files to touch.

For brokers/topic/security defaults, first scan sibling repos in the parent directory for
an existing install (`src/observability/VERSION` present) and read their `.env.example` +
`configuration/**/settings.*.json` `KAFKA_*` values; propose those as per-environment
defaults for the user to confirm. Read-only — never write outside the target repo.

## Step 3: Plan + approval gate (mandatory before any project-file write)

Present:

```
# Kafka observability — <install|upgrade to> <version>: <repo name>

## Vendored (replaced wholesale, safe)
- src/observability/  (24 files: library + tests + README + VERSION)

## Project edits (need your OK)
- package.json         + "@confluentinc/kafka-javascript", + "test:observability" script
                       (+ fold into "test:all" if the repo has one)
- <graph entry module> + import + startup() call at module load
- .env.example         + KAFKA_* block (disabled by default)
- configuration/<app>/settings.<ENV>.json   + KAFKA_* entries (SASL password as
                       @Microsoft.KeyVault(...) reference), KAFKA_ENABLED "<false|true>"
- [upgrade only] transforms from migrations/: <list>

## Values
APPLICATION_NAME=<...>  brokers/topic per env: <...>  security: <...>
```

Wait for approval. On rejection, adjust or stop.

## Step 4: Vendor the library

Copy every file from `templates/observability/` into `src/observability/`, replacing
existing library files on upgrade. Never merge — the library is vendored, local edits are
not expected (if a diff against the old vendored copy shows hand-edits, STOP and surface
them to the user before overwriting).

## Step 5: Wire

1. `npm install @confluentinc/kafka-javascript` (let npm pick the compatible version;
   `zod` and `@langchain/core` are already agent dependencies — verify, don't duplicate).
2. In the graph entry module, immediately after env/dotenv initialization and before the
   graph is built/exported:

   ```ts
   import { startup as startupObservability } from "./observability/index.js";
   startupObservability();
   ```

   Do NOT wrap the graph export and do NOT add per-node/tool instrumentation — the global
   attachment (configure hook + configure-slot wrap, both installed by `startup()`)
   covers every run.
3. If the repo has a CLI with a quit path, add a best-effort
   `await shutdown()` there (import from the same module). Do NOT install process signal
   handlers — an added SIGTERM handler would suppress the default terminate in processes
   that don't otherwise handle it.
4. `package.json`: add `"test:observability": "tsc && node --test dist/observability/*.test.js"`;
   fold into `test:all` when one exists.

## Step 6: Configure

1. `.env.example` — append (values from intake; keep the disabled default unless the user
   chose otherwise):

   ```
   # Kafka observability (LangSmith-parity run events; see src/observability/README.md)
   # KAFKA_ENABLED must be exactly "true" to activate.
   KAFKA_ENABLED=false
   APPLICATION_NAME=<application_name>
   KAFKA_BOOTSTRAP_SERVERS=<brokers>
   KAFKA_OBSERVABILITY_TOPIC=<topic>
   # KAFKA_SECURITY_PROTOCOL=SASL_SSL
   # KAFKA_SASL_MECHANISM=PLAIN
   # KAFKA_SASL_USERNAME=
   # KAFKA_SASL_PASSWORD=
   # Tracer attachment path: hook | patch | both (default both; see src/observability/README.md "Attachment")
   # KAFKA_ATTACH_MODE=both
   # Opt-in run filtering: off | allow | deny (default off = every run emitted; see src/observability/README.md "Run filtering")
   # KAFKA_RUN_FILTER_MODE=off
   # KAFKA_RUN_FILTER_PATTERNS=
   ```

2. Each approved `configuration/**/settings.<ENV>.json` — add the same keys with that
   environment's values; SASL password as
   `@Microsoft.KeyVault(VaultName=<vault>;SecretName=<secret>)`. `KAFKA_ENABLED` per the
   intake decision (default `"false"`).
3. [Upgrade only] Apply each migration's `<transforms>` in version order; they are
   idempotent. Surface anything that cannot be applied cleanly as an explicit manual
   follow-up with file:line.

## Step 7: Docker / native module check

`@confluentinc/kafka-javascript` wraps librdkafka (native). If the repo has a Dockerfile:
confirm the base image is covered by a node-pre-gyp prebuild (glibc and musl are) or that
a C/C++ toolchain is present during `npm ci` for the source-build fallback. Report the
finding; only edit the Dockerfile with explicit approval.

## Step 8: Verify

```bash
npm run typecheck || npx tsc --noEmit   # whole project still compiles
npm run test:observability              # library suite (no broker needed)
npm test                                # existing suites still green
```

Optional (offer, don't assume): live smoke against a local broker — set
`KAFKA_ENABLED=true` + local broker values in `.env`, run one conversation (project CLI or
dev server), consume the topic with `kafka-console-consumer` and confirm request/response
events per run arrive with the right `thread_id`.

## Step 9: Report

- Mode + library version installed; files vendored/edited; verification results (exact
  test counts).
- **Parallel-run note**: LangSmith is untouched; with both enabled the team can diff the
  sinks, then unset `LANGSMITH_*`/set `LANGSMITH_TRACING=false` to unplug — no code change.
- **Data note**: events carry full prompts/transcripts (incl. caller identifiers);
  redaction masks secrets, not PII. The topic/sink must be treated with the same
  confidentiality as the LangSmith instance it replaces.
- **Ops note**: fire-and-forget — sustained broker unavailability or queue saturation
  drops events (logged with running counts); size events/retention for roughly 10–20
  events per caller turn, KBs each (LLM run events repeat the full prompt).
