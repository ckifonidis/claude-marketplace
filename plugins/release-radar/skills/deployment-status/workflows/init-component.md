# Workflow: initialise a component

Creates `.release-radar/component.json` — and optionally a component `checks.md` skeleton — in **one member's own repository**, at `<clone>[/<repoSubdir>]/.release-radar/`. The member must already be listed in the workspace's `members`. Every key is documented in [../references/config-schema.md](../references/config-schema.md); verification checks in [../references/verification.md](../references/verification.md); adapters and their `discover` scopes in [../references/adapters.md](../references/adapters.md).

Engine commands are named here by command only; run each one exactly as shown in the `SKILL.md` "Engine invocation" section. This file never shows an invocation.

## Ground rules

- **Draft only from three sources:** the engine's `discover` output (what a deployment source actually lists), read-only Azure DevOps lookups through the engine (`pipeline-runs`), and the user's answers — including files in the member repository the user points at (for example a pipeline definition, to read its parameter names). Every value is confirmed by the user before it is written.
- **Copy names exactly.** A web app, container app, Deployment, Compose service, pipeline or parameter name is written exactly as `discover`, Azure DevOps or the user gave it — never shortened, paired, pluralised or inferred from a pattern. Target names (`api`, `api-internal`) are the user's choice.
- **No directory scanning.** The member's location comes from the workspace and the repos file only.
- **Write only after explicit confirmation, only in the member's working tree, and never commit.** The user manages git in member repositories.
- **Skills never hand-write a final structured file:** write a draft, then the engine's `format` makes it canonical and `validate-config` proves it.
- **Names only.** Verification headers name an **environment variable**, never a value. If the user pastes a secret, do not write it; ask for the variable name instead, and do not repeat the value.

## Step 1: Locate the member

1. Run the engine's `validate-config` command on the workspace. The member must be listed; if it is not, adding it is a workspace change: draft the new `members` entry (`name`, `repoKey`, `repoSubdir`), confirm, edit `workspace.json`, then run `format` and `validate-config` again.
2. The member must be `unavailable (no component config)`: its clone exists, the file does not. `unavailable (no local clone)` → fix the repos file first (map the key to the clone path the user gives). If the file already exists, this is not an initialisation: offer to change it through the same draft → `format` → `validate-config` cycle instead.
3. State the component root and the file that will be created (`<clone>[/<repoSubdir>]/.release-radar/component.json`). In a **single-repo project** this is the workspace repository itself.

## Step 2: Stages and targets

Go through the workspace's stages **in lifecycle order**. Every stage must appear in the file.

1. **Deployed here?** If the component is not deployed on a stage by design, the stage entry is `null` (reported "not deployed", never "missing").
2. **Adapter and target(s).** Ask which adapter the stage uses for this component. Its block must exist in the workspace `adapters` (otherwise add it there first, as a confirmed workspace change). Then run the engine's `discover` command for that adapter, with the scope the user gives:
   - `azure-appservice`: optionally one stage (the stage's configured subscriptions are listed);
   - `azure-containerapp`: a subscription (required) and optionally a resource group;
   - `kubernetes`: a context and a namespace (both required);
   - `compose`: optionally a project;
   - `command`: none — only when the workspace declares `discoverArgv`; otherwise the user supplies the values.

   Show the candidates (name, state, image) and let the user pick. Candidates flagged `ambiguous` (an App Service name in two subscriptions of one stage) must be resolved by the user. Exit **20** means sign in or fix the context (it is not "nothing found"); exit **21** means the source failed — quote it. A component with several targets on one stage (e.g. `api`, `api-internal`) gets one entry each.
3. **Tag convention.** Compare the image tags `discover` showed with the stage's convention (for example a `sha` stage whose tags are `1.4.2` will never resolve). If this component tags differently on a stage, draft a `tagConventionOverrides` entry for that stage, confirmed by the user. No override = the stage's convention applies.
4. **Command adapter:** draft `argv`, `extract` (`json-path` or a regex with group `image`) and the optional `preflightArgv` from the user. Say clearly that the engine runs these without a shell and cannot verify that they are read-only.

## Step 3: Pipeline mappings (pipeline stages only)

Only on stages whose mode is `pipeline`; a mapping elsewhere is invalid. The workspace must have an `azureDevOps` block (otherwise add it there first, as a confirmed workspace change).

1. From the user (or the pipeline definition file in the member repository that the user points at): the pipeline id and/or name, the project when it differs from the workspace default, the `ref`, the Azure Repos repository when the pipeline's own repository is not the one holding `ref`, and **every parameter the run sends**, each as a literal or a template using only `{commit.sha}`, `{commit.shortSha}`, `{component}`, `{target}`, `{image.tag}` (needs `pushedTagTemplate`) — `{image.repository}` cannot be previewed in v1, so avoid it.
2. **Actions:** each declared action's name, `kind` (`build` or `configuration`) and the parameter values it sets (declared parameters only); the `primaryAction` (what `/promote <component> <stage>` runs); optional `userSelectable` parameters with their closed value lists (not also in `parameters`).
3. **Pushed tag:** `imageTagParameter` (the parameter whose value is the pushed tag) and/or `pushedTagTemplate` (how the pipeline derives the tag from the commit). With neither, the pushed tag of a run is reported `undetermined`, and that is fine — nothing is guessed.
4. **`landedWaitMinutes`:** how long `promote` should wait for the target to run the new version after a succeeded run.
5. No secret value ever goes into a parameter.

The read-only Azure DevOps check comes after the file is valid (Step 6).

## Step 4: Handoff artefacts (handoff stages only)

On stages whose mode is `handoff`: the `settingsFiles` that travel to the receiving team, relative to the component root, and an optional component `beforePromote` pointer. You may check with Glob that each path exists in the working tree, but say that it is read at the promoted commit when a package is built; a path missing there is a blocking finding then, not now.

## Step 5: Verification and checklist (optional)

1. **Verification** per stage, only from the user: HTTP checks (URL, `GET` or `HEAD`, expected statuses, header → environment variable **names**), an optional version check (URL, `json-path` or regex with group `version`, `compare` `commit` or `tag`), an optional smoke command (argv). Remind the user that on a stage the operator's team does not own, smoke checks are reported "not run (stage not owned)". No block = "no real-world verification configured", which is a valid answer.
2. **Component checklist**, only if the user wants one: the skeleton is the header and `schemaVersion: 1` lines plus only items the user dictates, each with `layer: component` (grammar in [../references/file-formats.md](../references/file-formats.md)).

## Step 6: Confirm, write, format, validate

1. Show the complete draft `component.json` (and checklist) in the key order of `config-schema.md`, the absolute path(s) in the member repository, and a summary per stage (targets, pipeline + actions, handoff files, checks). Ask for explicit confirmation. No confirmation → write nothing.
2. Write the draft(s) exactly as confirmed.
3. Run the engine's `format` command on the workspace **with `--include-members`** (the user's confirmation to create the file covers re-formatting it; in a single-repo project the flag is not needed). It prompts for permission; tell the user it re-renders the draft canonically without changing any value. Summarise the changes. Exit **24** → show the file and exact location, fix the draft with the user, format again.
4. Run the engine's `validate-config` command. Expect exit **0** with the member `available`. Show the configured commands it lists, if any.
5. **Read-only Azure DevOps check** (when a mapping was added and the user has `AZURE_DEVOPS_EXT_PAT` set): run the engine's `pipeline-runs` command for the component and stage. Exit **23** = the pipeline does not exist as declared — fix the id/name/project. Exit **20** = set or renew the PAT (never "no runs"). With runs listed, check that each recent run's action is identified; "action undetermined" on every run means the declared action parameter values do not match what the pipeline actually receives — review them with the user.
6. Offer a first `/deployment-status <component>` to see the new configuration at work.

## Step 7: Hand over

Tell the user which file(s) to commit **in the member repository** (`.release-radar/component.json`, and `checks.md` if created). Do not commit, stage or push anything.
