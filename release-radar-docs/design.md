# release-radar — design record

Plan: `plan-001-release-radar-plugin.md`. Specification: `refined-request-release-radar-plugin.md`.
This file records design facts established during implementation; the decisions table (D1–D16) lives in the plan.

## How a request reaches a deployment

The three skills resolve the operator's request into a workspace, component and stage. The shipped Node.js engine validates the local files, determines the selected component's clone and reads its adapter. Status uses the working-tree configuration. A promotion or handoff also reads the component configuration at the commit being promoted. The [workspace model](../plugins/release-radar/skills/deployment-status/references/workspace-model.md) explains how those revisions are chosen.

The engine resolves each observed image to a local Git revision when the configured tag convention allows it. A status snapshot records the scope, application check results, pipeline facts and configuration fingerprint. Change risk can reuse that snapshot when its scope, age and fingerprint satisfy the request. The [feature register](functions.md) maps these operations to the skills and engine commands.

An owned pipeline stage has one remote write. The preview reads the mapped Azure DevOps pipeline and Git ref. After the operator confirms that preview, the engine resolves the request again, checks the revision and sends the queue request once. The skill follows the run and then checks what actually reached the target. A handoff stage takes a separate path that writes a local package from the promoted commit for the receiving team. The [design decisions](plan-001-release-radar-plugin.md#1-decisions-taken-after-the-specification) record the choices behind lookup, freshness, confirmation, permission scopes and verification.

## Plugin runtime probe (Phase 0, 2026-11-25) — closes Open Question 1

Method: a throw-away plugin named `release-radar` (outside this repository) with one skill `probe`, a stub
`engine/dist/cli.js` that prints its own root from `import.meta.url`, and a `references/x.md` file containing
`${CLAUDE_PLUGIN_ROOT}`. Run non-interactively with Claude Code 2.1.332:
`claude -p --plugin-dir <scratch> --model haiku --permission-mode default --allowedTools 'Bash(echo *)' 'Read' -- '/release-radar:probe alpha "beta gamma"'`.
The skill's frontmatter carried `allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js where *), Read`.

| Question | Result |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` in the SKILL.md body | substituted with the absolute plugin root |
| `${CLAUDE_SKILL_DIR}` in the body | substituted with `<root>/skills/probe` |
| `${CLAUDE_PLUGIN_DATA}` in the body | substituted with `~/.claude/plugins/data/<plugin>-<source>` (`release-radar-inline` for `--plugin-dir`) |
| `$CLAUDE_PLUGIN_ROOT` inside a Bash command | unset (empty); with default permissions the command is even blocked ("A variable in this command can't be checked before it runs") |
| `${CLAUDE_PLUGIN_ROOT}` in a file read later via Read (`references/x.md`) | NOT substituted — literal text |
| `${CLAUDE_PLUGIN_ROOT}` in frontmatter `allowed-tools` | expanded: in `--permission-mode default` the engine call ran without approval while a control command (`node -e ...`) outside the rule was denied ("This command requires approval") |
| Positional arguments | quote-aware: `alpha "beta gamma"` → `$0=alpha`, `$1=beta gamma`; named `arguments:` map the same way |
| Engine self-location | `import.meta.url` resolves the plugin root correctly; the env variable is not needed |

Consequences (implemented in Phase 9):
1. Every engine invocation is written literally in each SKILL.md body as
   `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" <command> ...` (decision D11). References and workflows never
   contain the invocation; they point to the SKILL.md "Engine invocation" section.
2. `allowed-tools` pre-allows only the read-only engine subcommands, one rule each (decision D12, now proven
   to work). `run-pipeline`, `format` (write mode) and `workspace-index register|unregister` are never pre-allowed,
   so the normal permission prompt is a second gate behind the confirmation token.
3. Never write `$CLAUDE_PLUGIN_ROOT` as a shell variable in a skill.
4. The per-user workspace index lives under `${CLAUDE_PLUGIN_DATA}`. Its directory name depends on the install
   source, so the skill passes the substituted path to the engine explicitly (`--index <path>`); the engine never
   derives it.
5. `$ARGUMENTS` / positionals are safe to quote in prose; they are still never spliced into a shell line (D15).
