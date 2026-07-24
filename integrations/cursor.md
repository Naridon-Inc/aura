# Cursor + Aura

Cursor writes the code. Git stores it. **Aura is the review and provenance layer
that sits alongside both** — it records *why* each change was made, *what*
changed at the function/class level, and *which agent* made it, then lets a human
inspect that semantic diff before it ships. Aura doesn't replace Cursor or Git;
it makes Cursor's output reviewable.

> New to Aura? Install it first — see the
> [Installation](../README.md#install) section in the README. This guide
> assumes `aura` is already on your PATH.

## Setup

Turn on capture — one command in your repo:

```bash
cd my-project
aura enable
```

Optionally drop Aura's Cursor rules file into your project so Cursor's agent uses
the CLI as it works — see `integrations/cursor-rules/gsd.mdc` in this repo.

## A concrete example: review a Cursor edit before it ships

Say you ask Cursor to *"make `parse_config` tolerate missing optional fields."*
Cursor edits the function. Here's the human review checkpoint **after the AI
edit**.

Work on a branch so you have a base to diff against:

```bash
git switch -c fix/config-optional-fields
```

**1. Bind the intent** (the "why") so it's recorded with the change:

```bash
aura log-intent "Let parse_config skip missing optional fields instead of erroring"
```

**2. Commit** — Aura's hook records the semantic checkpoint (what changed at the
AST level, the intent, and the agent):

```bash
git add -A
git commit -m "fix: tolerate missing optional fields in parse_config"
```

**3. Inspect the semantic diff** — the review checkpoint before you merge or open
a PR:

```bash
# AST-level diff + AI bug/security scan against your base branch:
aura pr-review --base main

# Trace one function back to the intent and the agent that wrote it:
aura explain parse_config
```

`aura pr-review` diffs against **AST structure**, not text — so you see which
logic nodes Cursor actually changed, plus flagged bugs, security issues, and
architectural violations, with blast-radius. `aura explain` gives you the
provenance: the intent behind a node and which agent authored it.

**4. If Cursor's change is wrong**, revert just that one function — Git and the
rest of your edits are untouched:

```bash
aura rewind parse_config
```

For a quick pre-commit peek without a base branch, `aura status` lists the logic
nodes currently changed and the active session.

## What Aura records at this checkpoint

- **What** — the functions/classes changed, as an AST-level (not textual) diff.
- **Why** — the intent bound via `aura log-intent`.
- **Which agent** — the authoring session (Cursor), when identifiable.

It's stored locally as Git Notes in `.git`. Your commits, branches, and PRs are
unchanged — Aura only adds the semantic layer on top.

## Where the boundaries are

- **Cursor** writes and edits code.
- **Git** stores commits, branches, and history.
- **Aura** records intent + AST checkpoints and runs the semantic review. It does
  not host your repo or replace `git` or Cursor — run `aura disable` and your
  history stays intact.
- `aura pr-review` compares your branch against a **base branch**, so it's most
  useful on a feature branch before you merge or open a PR. For an uncommitted
  peek, use `aura status`.

## See also

- [Installation](../README.md#install)
- [OpenCode integration](opencode.md)
