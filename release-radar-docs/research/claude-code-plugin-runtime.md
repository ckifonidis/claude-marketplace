# Claude Code plugin runtime — how `release-radar` skills reach their engine

Researched 2026-11-25 for `release-radar-docs/refined-request-release-radar-plugin.md` (Open Question 1).
Legend: **[V]** verified against the cited page on 2026-11-25; **[M]** modelled (prior knowledge or
secondary source) — confirm with the probe in section 4.

## 1. Sources
- Plugins reference — "Environment variables", "Where each variable resolves": https://code.claude.com/docs/en/plugins-reference
- Skills reference — "String substitutions", "Bundled scripts", "Same-name conflicts": https://code.claude.com/docs/en/skills
- Plugin loading (cache location, version roots): https://code.claude.com/docs/en/plugins/loading.md (not fetched → cache paths **[M]**)

## 2. Verified facts

**`${CLAUDE_PLUGIN_ROOT}` resolution [V].** The plugins reference table "Where each variable resolves" lists:
hook `command`/`args`, monitor commands, MCP stdio `command`/`args`/`env`, MCP http URL and headers, LSP
fields, and **"Skill, command, and agent content: anywhere in the Markdown body"**. Quote: "The variables
aren't present in the environment of commands Claude runs through the Bash tool, in the main session or in a
subagent. In skill, command, and agent content, write the `${...}` reference in the Markdown body instead, and
Claude Code substitutes the path inline when it loads the content." The skills page: `${CLAUDE_PLUGIN_ROOT}`
is "Substituted only in plugin skills."

Consequences:
- `node "$CLAUDE_PLUGIN_ROOT/..."` typed as a shell variable fails — it is unset in Bash.
- A literal `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" status ...` in the SKILL.md **body** is rewritten
  to the absolute path before the model sees it; the model copies the resolved path into Bash. Requirement 7
  of the spec works as written, provided the `${...}` text sits in the SKILL.md body.

**`${CLAUDE_SKILL_DIR}` [V]:** "The directory containing the skill's SKILL.md file. For plugin skills, this is
the skill's subdirectory within the plugin, not the plugin root." Also substituted in the body and in
`allowed-tools` rules. It resolves to `<root>/skills/<skill>`, so the engine is
`${CLAUDE_SKILL_DIR}/../../engine/dist/cli.js` — the documented fallback for Open Question 1.
`${CLAUDE_PLUGIN_ROOT}` inside `allowed-tools`: no statement found **[M]**.

**`${CLAUDE_PLUGIN_DATA}` [V]:** `~/.claude/plugins/data/<id>/`, persists across updates — the place for
caches. `${CLAUDE_PLUGIN_ROOT}` changes on every plugin update: never write state there.

**`bin/` [V]:** "Files here are on the Bash tool's `PATH` while the plugin is enabled, so Claude runs them as
bare commands." claude.ai and Cowork do not install a plugin that has `bin/`.

**Base directory [not documented]:** a "Base directory for this skill: <path>" line is commonly observed
**[M]** but not documented — do not depend on it.

**Path containment [V]:** component paths must resolve inside the plugin root. The engine must be fully
self-contained under `plugins/release-radar/` (no `../shared` imports).

**Namespacing [V]:** plugin skills are `/plugin-name:skill-name` → `/release-radar:promote`. Frontmatter
`name` replaces the directory name in the last segment; a `name` already starting with `<plugin>:` is not
doubled (v2.1.246+) — keep `name: promote` plain. Same-name rule: "A plugin skill and a skill at any of the
locations above: Both load, because plugin skills are namespaced." Bare `/deployment-status` "also invokes
the skill unless another command already uses that name"; **which plugin wins a bare name between two
plugins is not documented [uncertain]** — always document the namespaced form.

**Arguments [V]:** `$ARGUMENTS` = whole string; `$ARGUMENTS[N]` / `$N` = 0-based positionals; `$name` = named
argument declared in an `arguments:` frontmatter list. With no placeholder in the body, Claude Code appends
`ARGUMENTS: <value>`. Escape a literal `$` with `\$`; an argument value containing `$1` is inserted literally.
A missing indexed placeholder stays unchanged; a missing named placeholder becomes empty. **Not verified:**
whether positional splitting is shell-style (quoted `"two words"` = one argument).

## 3. Recommendation for SKILL.md

```markdown
## Engine invocation
All engine calls use exactly this prefix (the path is resolved by Claude Code when this skill loads):

    node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" <command> --config "<path>" [flags]

Do not construct the path any other way. Do not use $CLAUDE_PLUGIN_ROOT as a shell variable
(it is not set for Bash). If the path above still shows a literal `${`, stop and report
"plugin root was not substituted".
```

Rules:
1. **Literal invocation only in SKILL.md.** `references/*.md` and `workflows/*.md` are read later via Read;
   substitution there is not documented — assume it does not happen. In those files write "run the engine
   command defined in SKILL.md, section Engine invocation".
2. **Quote the path** (install paths may contain spaces).
3. **Fail loudly on an unsubstituted path** (sentinel above). Also give `cli.js` a `where` command that prints
   its own root from `import.meta.url`, so the engine self-reports and tests assert no env dependency.
4. **Fallback form** if a probe shows plugin-root substitution missing: `node "${CLAUDE_SKILL_DIR}/../../engine/dist/cli.js"`.
5. **Optional `bin/release-radar` launcher** (`#!/usr/bin/env node`, `import '../engine/dist/cli.js'`, mode
   755) — absent on claude.ai/Cowork and not in the spec layout; would be a layout addition.
6. **Never persist absolute plugin paths** in config, snapshots or handoff packages.
7. **Permissions:** pre-allow only read-only subcommands, one rule each, e.g.
   `allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js status *)`; never pre-allow
   `run-pipeline` (the normal permission prompt is a second gate behind the confirmation token); no bare
   `node *`. Expansion of `${CLAUDE_PLUGIN_ROOT}` inside `allowed-tools` is **[M]** — test it.

**Arguments:** reference `$ARGUMENTS` in prose only ("The user asked for: $ARGUMENTS"); never splice it into a
shell line (injection risk). The skill resolves names; the engine validates them exactly (exit 64).

## 4. Probe skill (settles the open items)

Scratch plugin, `skills/probe/SKILL.md`:

```markdown
---
name: probe
description: Diagnostic. Prints substitutions. Use only when asked to run the probe.
disable-model-invocation: true
arguments: [first, second]
---
ROOT=${CLAUDE_PLUGIN_ROOT}
SKILLDIR=${CLAUDE_SKILL_DIR}
DATA=${CLAUDE_PLUGIN_DATA}
ALL=$ARGUMENTS
ARG0=$0 ARG1=$1 NAMED1=$first NAMED2=$second
Run via Bash and report verbatim: `echo "[$CLAUDE_PLUGIN_ROOT]"; node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli.js" where`
Then read references/x.md and report whether it contains an unexpanded ${CLAUDE_PLUGIN_ROOT}.
```

Run `claude --plugin-dir ./plugins/release-radar`, then `/release-radar:probe a "b c"`. Record: ROOT and
SKILLDIR expanded or not; the Bash `echo` empty (expected); `$1` = `b c` or `b`; whether `references/x.md` was
substituted; any difference between the marketplace-installed copy and `--plugin-dir`.

## 5. Uncertainties

| Item | Confidence | Impact |
|---|---|---|
| Substitution in SKILL.md body for plugin skills | HIGH [V] | none |
| Substitution in files read via Read | LOW — assume no | invocation lives only in SKILL.md |
| `${CLAUDE_PLUGIN_ROOT}` in `allowed-tools` | MEDIUM | fall back to `CLAUDE_SKILL_DIR`, or leave the prompt on |
| Bare `/name` collision between two plugins | unknown | always document the namespaced form |
| Quote-aware positional args | unknown | use `$ARGUMENTS` in prose only |
