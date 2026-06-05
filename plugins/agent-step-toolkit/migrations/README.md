# Migration guides

One file per version jump of the agent-step library, named `<from>-to-<to>.md`
(e.g. `0.1.0-to-1.0.0.md`). Written by `/bump-version` when it refreshes the embedded library;
consumed by `/pull-library` when it upgrades a downstream project's vendored `src/agent-step/`.

A migration file is the **contract between the two skills**. It has two layers, and both are
mandatory for any release that changes the library's public surface or the tool-authoring contract:

- **Prose** — a human-readable upgrade narrative: what changed, why, and before/after snippets a
  maintainer can read top-to-bottom.
- **`<transforms>`** — an ordered, structured list of edit rules `/pull-library` executes against a
  consumer's own tools. These are structured natural-language instructions an LLM applies with
  judgment (NOT an executable codemod): each transform names a target (a glob or file role), the
  precise change, and a check to confirm it landed. Order matters — `/pull-library` applies them
  top to bottom, and chains multiple migration files in version order for multi-step jumps.

## File template

```markdown
# Migrate agent-step <from> → <to>

> Severity: <breaking | additive | internal>. Applied by `/pull-library`; readable standalone.

## What changed
<prose: the public-API / contract delta, with before/after code snippets>

## Why
<prose: the motivation, one short paragraph>

## Library replacement
The vendored `src/agent-step/*` is replaced wholesale by `/pull-library` (verbatim copy from the
toolkit). No per-file action needed — this section just records what moved in the library itself.

<transforms>
1. id: <short-slug>
   target: <glob or file role, e.g. "src/tools/*/actions/*/" or "each tool's index.ts">
   change: <imperative, specific edit — what to add/rewrite/remove>
   example: <optional before/after snippet>
   check: <how to confirm it landed, e.g. "tsc resolves the import" / "registry key present">

2. id: ...
   target: ...
   change: ...
   check: ...
</transforms>

## Manual follow-ups
<prose: anything the transforms can't safely automate — judgement calls, design choices the
maintainer must make by hand. `/pull-library` surfaces these after applying transforms.>
```

## Conventions

- **Additive-only** releases (new optional export, no signature change) may omit `<transforms>`
  and `Manual follow-ups`; the library replacement alone is the upgrade. Say so explicitly in prose.
- Keep transforms **idempotent** where possible — re-running `/pull-library` on an already-migrated
  project should be a no-op, not a double-edit.
- Reference the toolkit's own worked examples by role, not by absolute path (the consumer project
  has different tool names).
