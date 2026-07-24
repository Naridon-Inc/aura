# OpenCode + Aura

Aura is a Git-native layer that records the *meaning* of every change — the
intent (why), a semantic checkpoint (what changed at the function/class level),
an AST-level diff, and which agent made it — straight into Git. This guide wires
it up so an OpenCode session leaves that trail behind automatically.

> New to Aura? Install it first — see the
> [Installation](../README.md#install) section in the README. This guide
> assumes `aura` is already on your PATH.

## How OpenCode connects

There are two ways an agent can talk to Aura, and OpenCode works with either:

1. **Git-hook capture (recommended, zero config).** `aura enable` installs
   Aura's Git hooks in your repo. From then on, every commit — whoever or
   whatever authored it, including OpenCode — records a semantic checkpoint. No
   MCP, no agent wiring. This is the reliable path and the one this guide uses.
2. **MCP tools (optional, richer).** Aura ships a native MCP server (`aura-vcs`)
   that exposes its tools (`aura_status`, `aura_log_intent`, `aura_pr_review`, …)
   to MCP-capable agents. If your OpenCode setup supports MCP servers, register
   Aura there — `aura init` can wire supported agents for you. When MCP isn't
   available, the git-hook path above already gives you full provenance from the
   CLI.

## Quickstart

Turn on capture — one command in your repo:

```bash
cd my-project
aura enable
```

Now run OpenCode as usual. Below is a minimal end-to-end example you can follow
locally: OpenCode edits a function, you commit, and Aura records the trail.

```bash
# 1. Let OpenCode make a change (e.g. fix a bug in one function),
#    then stage it as you normally would:
git add -A

# 2. (Optional) Bind the "why" before committing, so intent is explicit:
aura log-intent "Fix off-by-one in paginate() so the last page isn't dropped"

# 3. Commit. Aura's hook records the semantic checkpoint on this commit.
git commit -m "fix: off-by-one in pagination"

# 4. Inspect what Aura recorded:
aura status                 # checkpoints, tracked logic nodes, session info
aura explain paginate       # trace the function back to its intent + agent
```

Before opening a PR, run the semantic review:

```bash
aura pr-review --base main
```

If OpenCode broke a single function, revert just that node — no merge conflict:

```bash
aura rewind paginate
```

## What Aura tracks during this workflow

At commit time, Aura records — locally, as Git Notes in your `.git` folder:

- **Intent** — the "why", from `aura log-intent` (or inferred from the commit).
- **Semantic checkpoint** — the functions/classes that changed, with
  rename-proof content hashes.
- **AST-level diff** — structural change, not text lines, so a rename or a move
  isn't mistaken for a rewrite.
- **Which agent** — the authoring agent/session, when it's identifiable.

## Known limitations

- **Capture happens at commit.** Uncommitted OpenCode edits aren't checkpointed
  until you commit. Run `aura status` to see pending changes before then.
- **MCP is optional and setup-dependent.** Live MCP tool access from OpenCode
  depends on your OpenCode version's MCP support. Without it you still get full
  provenance via the CLI + git-hook path.
- **Language coverage.** Aura parses supported languages via tree-sitter (Rust,
  TypeScript, JavaScript, Python, Go, and more). Files in other languages commit
  fine but won't get AST-level logic nodes.
- **Agent attribution is best-effort.** If OpenCode doesn't announce a session,
  the checkpoint still captures what changed and why; the agent field may be
  generic.
- **Fails open.** If AST parsing exceeds its budget, Aura steps aside and lets
  the commit through — it will never block a hotfix.

## Troubleshooting

- `aura` not found? See [Troubleshooting](../README.md#troubleshooting) in the
  README.
- Repo acting up (stuck session, missing hooks)? Run `aura doctor`.

## See also

- [Installation](../README.md#install)
- [Cursor integration](cursor.md)
