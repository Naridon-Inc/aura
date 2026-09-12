<!-- AURA_START -->
# Aura Semantic Engine — Agent Protocol

This repository is tracked by [Aura](https://auravcs.com), a semantic version
control engine. It records the logic of the codebase (ASTs), links every
commit to a stated intent, and can surgically rewind single functions. Git
hooks installed by Aura capture a semantic checkpoint on every commit.

## Before you commit — log your intent

Aura's pre-commit hook compares what you SAY you changed against what the AST
actually changed. Log intent first, every time:

```sh
aura log-intent "Refactored retry_logic to exponential backoff for rate-limit compliance" --type Refactor
```

Types: `FeatureAdd`, `BugFix`, `Refactor`, `Revert`, `Performance`, `Docs`, `Deps`.
Committing without a logged intent is flagged as Intent Poisoning and may be
blocked in strict mode.

## Useful commands

- `aura status` — semantic state: tracked logic nodes, session, strict mode.
- `aura snapshot <file>` — durable pre-edit backup; `aura rewind` recovers a
  single function without merge conflicts.
- `aura prove "<behavioral goal>"` — verify the implementation achieves a goal.
- `aura pr-review --base main` — semantic diff with bug/security scanning.
- `aura crew ready` / `aura crew claim <id>` — pick up planned work from the
  team's dependency graph; complete with the commit sha.

## Rules

- Never delete functions without explaining why in your logged intent.
- Never bypass a failing Aura pre-commit check by amending the message —
  fix the intent or the change.
<!-- AURA_END -->
