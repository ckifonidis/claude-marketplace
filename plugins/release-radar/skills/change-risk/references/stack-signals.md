# Stack signals

Where to look, per stack, for the five generic categories of `generic-checks.md`: **(a)** required configuration, **(b)** contracts, **(c)** dependencies, **(d)** build and image, **(e)** data. Detect the stack **at the promoted commit** from the files present there (`git show <sha>:<dir>/` lists a directory; `git show <sha>:<path>` reads a file); a repository often has several stacks (an application plus a Dockerfile plus a chart). Paths are relative to the component root — the clone root, or the member's `repoSubdir`. Engine commands are described in the `SKILL.md` "Engine invocation" section; this file never shows an invocation.

These are **pointers for reading the diff**, not rules that decide a finding by themselves. A matching file means "read this change"; the evidence and the severity come from what the change does.

## Stack detection

| Stack | Present at the promoted commit |
|---|---|
| Node.js / TypeScript | `package.json`, with `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or `bun.lock*`; `tsconfig*.json` |
| .NET | `*.csproj`, `*.fsproj`, `*.sln`, `Directory.Packages.props`, `Directory.Build.props`, `global.json`, `appsettings*.json` |
| Python | `pyproject.toml`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `requirements*.txt`, `setup.cfg`, `setup.py` |
| Go | `go.mod`, `go.sum` |
| Docker | `Dockerfile`, `*.Dockerfile`, `.dockerignore`, `docker-compose*.y*ml`, `compose*.y*ml` |
| Helm / Kubernetes | `Chart.yaml`, `values*.yaml`, `templates/*.yaml`, `kustomization.yaml`, manifests with `apiVersion:` and `kind:` |
| IaC | `*.tf`, `*.tfvars`, `.terraform.lock.hcl`; `*.bicep`, `*.bicepparam`; ARM `azuredeploy*.json`; Pulumi `Pulumi*.yaml`; CloudFormation templates |
| Pipeline definitions | `azure-pipelines*.yml`, `.azure-pipelines/**`, `.github/workflows/*.yml`, other CI files |

## Node.js / TypeScript

- **(a) Config.** New `process.env.X` reads (especially `process.env.X!`, or reads passed straight into a validator); env schemas (`z.object({...})` with no `.default()` / `.optional()`, `envalid`, `@nestjs/config` validation schemas, `convict`); removed `?? "<default>"` / `|| "<default>"`; new keys in `.env.example` or `.env.template`; renamed keys in a config module.
- **(b) Contracts.** Route decorators and router definitions (`@Get(`, `router.post(`, `app.get(`), OpenAPI files, DTO classes and exported types of published packages (`exports` / `types` in `package.json`), GraphQL schemas, message/event type definitions, CLI argument parsers.
- **(c) Dependencies.** `dependencies`, `devDependencies`, `peerDependencies`, `overrides` / `resolutions` / `pnpm.overrides` in `package.json`; the lockfile's resolved versions; `engines.node`; `.nvmrc` / `.node-version`; `packageManager`.
- **(d) Build.** `scripts.build` / `scripts.start`, `tsconfig*.json` `target` / `module` / `outDir`, bundler config (`vite.config.*`, `webpack.config.*`, `esbuild` scripts), the Dockerfile's `node` base image.
- **(e) Data.** ORM migrations (`migrations/**`, `prisma/migrations/**`, `prisma/schema.prisma`, TypeORM / Knex / Sequelize migration folders), cache key builders, persisted state schemas.

## .NET

- **(a) Config.** `appsettings*.json` and `settings.*.json` — new or renamed keys, and **Key Vault references** in values (`@Microsoft.KeyVault(SecretUri=…)` / `@Microsoft.KeyVault(VaultName=…;SecretName=…)`, bare `https://<vault>.vault.azure.net/secrets/<name>` URIs) — report the reference name, never a value; `builder.Configuration["X"]`, `GetRequiredSection("X")`, `GetValue<T>("X")` without a default; options classes with `[Required]` and `ValidateDataAnnotations()` / `ValidateOnStart()`; `Environment.GetEnvironmentVariable("X")`; launch profiles only as context (`launchSettings.json` is not deployed).
- **(b) Contracts.** Controllers and minimal-API maps (`[HttpGet(`, `MapGet(`, `[Route(`), DTOs and records used in responses, generated OpenAPI (`swagger.json`), gRPC `*.proto`, message contracts, SignalR hubs.
- **(c) Dependencies.** `<PackageReference Include="…" Version="…">` in `*.csproj`, central versions in `Directory.Packages.props`, `packages.lock.json`, `<TargetFramework>` changes, `global.json` SDK version.
- **(d) Build.** `*.csproj` build properties (`<PublishTrimmed>`, `<InvariantGlobalization>`, `<RuntimeIdentifier>`), `Directory.Build.props`, the Dockerfile's `mcr.microsoft.com/dotnet/*` base images and their tags/digests, `ASPNETCORE_URLS` / `ASPNETCORE_HTTP_PORTS` changes.
- **(e) Data.** EF Core `Migrations/*.cs` and the model snapshot, `DbContext` model changes, Dapper SQL scripts, distributed-cache key formats.

## Python

- **(a) Config.** `os.environ["X"]` (no default), `os.getenv("X")` passed where `None` fails, `pydantic-settings` `BaseSettings` fields without defaults, `dynaconf` / `environs` required values, new keys in `.env.example`.
- **(b) Contracts.** FastAPI / Flask / Django route decorators and URL configs, Pydantic response models, OpenAPI exports, Celery task names and signatures, published package APIs (`__all__`, public modules).
- **(c) Dependencies.** `[project.dependencies]` / `[project.optional-dependencies]` and `[tool.poetry.dependencies]` in `pyproject.toml`, `uv.lock`, `poetry.lock`, `requirements*.txt` pins, `requires-python`, `.python-version`.
- **(d) Build.** Build backend (`[build-system]`), entry points (`[project.scripts]`), the start command (uvicorn / gunicorn arguments), the Dockerfile's `python` base image.
- **(e) Data.** Alembic `versions/*.py`, Django `migrations/*.py`, raw SQL migrations, cache key builders, pickled or serialised stored objects.

## Go

- **(a) Config.** `os.Getenv("X")` / `os.LookupEnv("X")` used without a fallback, struct tags of env libraries (`env:"X,required"`, `envconfig:"X" required:"true"`), flag definitions that became required, viper keys.
- **(b) Contracts.** HTTP handlers and routers (`http.HandleFunc`, `mux.Handle`, framework route tables), exported identifiers of packages imported by other modules, `*.proto` and generated code, JSON struct tags of response types.
- **(c) Dependencies.** `require` and `replace` directives in `go.mod`, `go.sum` changes, the `go` and `toolchain` directives.
- **(d) Build.** `-ldflags`, build tags, `CGO_ENABLED`, the Dockerfile's builder and runtime images (e.g. a switch to a distroless or scratch image changes what is available at run time).
- **(e) Data.** Migration directories (`migrations/*.sql`, golang-migrate / goose files), cache key formats, persisted encodings.

## Docker

- **(a) Config.** `ENV` lines that set or remove values the application requires; `ARG` used at run time by mistake; a `.env` file that was copied into the image and is no longer.
- **(b) Contracts.** `EXPOSE` port changes, `HEALTHCHECK` path changes, changed `ENTRYPOINT` / `CMD` arguments that scripts rely on.
- **(c) Dependencies.** OS packages installed in `RUN` lines (`apt-get install`, `apk add`) with or without pinned versions.
- **(d) Build.** `FROM` image, tag and `@sha256:` digest (a removed digest pin or a move to `:latest` is a finding); multi-stage targets; `USER`; `WORKDIR`; `COPY` / `ADD` sources; `.dockerignore` (a loosened rule can put secrets or local env files in the image; a tightened rule can drop files the build needs); compose files' `build.context`, `image`, `ports`, `healthcheck`.
- **(e) Data.** `VOLUME` changes, start-up scripts that migrate or seed data.

## Helm / Kubernetes manifests

- **(a) Config.** Container `env` entries with `valueFrom.secretKeyRef` / `configMapKeyRef` (new secret or config-map names and keys — report names only), `envFrom`, new required values in `values*.yaml` (`required` / `fail` in templates), values that are empty in `values.yaml` and must come from the destination's values file.
- **(b) Contracts.** `Service` ports and names, `Ingress` / `HTTPRoute` hosts and paths, probe paths, labels and selectors other resources depend on.
- **(c) Dependencies.** `dependencies:` in `Chart.yaml` and `Chart.lock`, chart `version` / `appVersion`, `apiVersion` of resources moved to a newer or removed API.
- **(d) Build.** `image.repository` / `image.tag` / digest in values, `imagePullPolicy`, `resources` limits, `securityContext` (`runAsNonRoot`, read-only root filesystem), replica and rollout strategy changes.
- **(e) Data.** `PersistentVolumeClaim` size or storage class changes, `StatefulSet` volume templates (often immutable), migration `Job`s and Helm hooks (`helm.sh/hook: pre-upgrade`).

## IaC

- **(a) Config.** Terraform `variable` blocks without `default` (a new required input), Bicep `param` without a default, ARM `parameters` without `defaultValue`, new app settings or Key Vault secret references created by the template, renamed outputs consumed by other stacks.
- **(b) Contracts.** Outputs other stacks or pipelines read, resource names and DNS names others resolve, network rules that open or close access.
- **(c) Dependencies.** `required_providers` versions and `.terraform.lock.hcl`, module `source` / `version`, Bicep module registry versions, API versions of resources.
- **(d) Build.** Changes that **replace** a resource (a changed immutable property such as a name, location, SKU tier or zone), `lifecycle` blocks (`prevent_destroy` removed, `ignore_changes` changed), `moved` / `removed` blocks, state backend changes.
- **(e) Data.** Database, storage-account and cache resources being replaced or deleted, retention and backup settings, encryption-key changes.

## Pipeline definitions

Changes to the pipeline that will build or deploy the promoted commit are build-category **(d)** findings: changed parameters, stages, environments, approval checks, variable groups (names only), service connections (names only), image tags pushed, and deployment targets. A changed parameter that the component's `component.json` mapping sets is also a configuration mismatch: the mapping and the pipeline must agree before a run is previewed.
