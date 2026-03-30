<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.3-white?style=flat-square" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/lang-Rust-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/agents-Claude%20Code%20%2B%20Gemini%20CLI-green?style=flat-square" />
</p>

<h1 align="center">Aura</h1>
<p align="center"><strong>Git tracks files. Aura tracks logic.</strong></p>

<p align="center">
Block AI drift. Catch architectural leaks. Rewind one function, not the whole commit.
</p>

---

Aura is a semantic layer on top of Git. It builds an **AST Merkle-Graph** of your codebase — tracking functions, classes, and their relationships instead of text diffs. This gives you capabilities that Git alone cannot provide.

## The 5 Things That Matter

### 1. Function-Level Rewind

Revert one function from 3 days ago without touching the rest of the file.

```bash
# AI hallucinated calculate_tax — rewind just that function
aura rewind calculate_tax src/billing.rs

# Tests green. Everything else untouched.
```

Everyone has been forced to revert entire commits because one small function was wrong. Aura searches durable snapshots first, then walks 50 commits of git history. Auto-snapshots before rewind for safety.

### 2. Intent Gatekeeper

Commit says "fix login" but code touched billing? Aura flags it. In strict mode, it blocks the commit entirely.

```bash
# Enable strict mode
aura config set gatekeeper strict

# Try to commit with mismatched intent
git commit -m "fix login bug"
# → [Aura] ✗ Intent mismatch: commit touches billing.rs but intent mentions login only.
# → Commit blocked.
```

Reviewers are tired of AI making side changes nobody asked for. The gatekeeper matches your stated intent against the AST diff. If they don't align, the commit is physically blocked.

### 3. Semantic PR Review

PR review that tells you: 12 logic nodes changed, 2 undocumented, violates layer policy, impacts 8 downstream nodes.

```bash
aura pr-review --base main
```

```
Risk Score: 72/100 (MODERATE)

Changed Nodes:
  ✗ calculate_tax (billing.rs) — UNDOCUMENTED, touches 3 downstream callers
  ✗ UserService.create (user.rs) → calls db.query() directly — LAYER VIOLATION
  ✓ format_receipt (receipt.rs) — safe, leaf node

Blast Radius: 8 nodes affected across 4 files
```

Normal PR review tools don't give architectural risk deterministically. Aura walks the graph and reports what actually changed at the logic level.

### 4. Multi-Hop Boundary Detection

UI → service → DB leak detected in 2 hops. Lint rules catch direct imports, but not transitive architectural leaks.

```bash
aura pr-review --base main --verbose
```

```
CRITICAL: Layer violation detected (2-hop path)
  components/Dashboard.tsx → services/UserService.ts → db/queries.ts
  ↳ Frontend component reaches database layer through service bridge
```

Aura's graph walks the full call chain, not just direct imports.

### 5. Ask "Why" Months Later

AI-generated code becomes archaeology after 2 weeks. Aura remembers.

```bash
aura ask "why did we add retry logic to the payment handler?"
```

```
Found in checkpoint 3a7f2c1 (2026-01-15):
  Intent: "Add retry with exponential backoff for Stripe timeouts"
  Functions: payment_handler::process_payment, payment_handler::retry_with_backoff
  Session: Claude Code session #47, 12 turns
```

Semantic search over your checkpoint history using embeddings. Local-first; optional cloud embeddings via Gemini API.

---

## Quick Start

```bash
# Install from source
cargo install --git https://github.com/Naridon-Inc/aura.git

# Or build locally
git clone https://github.com/Naridon-Inc/aura.git
cd aura
cargo build --release
cp target/release/aura ~/.cargo/bin/

# Initialize in any git repo
cd your-project
aura init
```

## How It Works

Aura installs Git hooks (pre-commit, commit-msg, post-commit, pre-push) that run automatically. On every commit:

1. **Pre-commit** — Parses staged files into AST nodes, captures semantic context
2. **Commit-msg** — Injects an Aura trailer linking the commit to its Merkle-Graph state
3. **Post-commit** — Persists the semantic checkpoint to a hidden branch
4. **Pre-push** — Auto-syncs semantic metadata to the remote

Aura chains with existing hooks (Husky, Lefthook, Overcommit, pre-commit) — it appends, never overwrites.

## Core Commands

| Command | What it does |
|---------|-------------|
| `aura init` | Initialize Aura in a git repo (installs hooks, baselines AST) |
| `aura status` | Show semantic status — logic nodes, checkpoints, active session |
| `aura rewind <fn> <file>` | Surgically revert a single function to a previous safe state |
| `aura pr-review --base main` | Semantic PR review with risk score and blast radius |
| `aura ask "<question>"` | Search semantic history with natural language |
| `aura snapshot "<label>"` | Take a named snapshot of current state |
| `aura map` | Visualize the logic graph |
| `aura audit` | Detect commits that bypassed hooks (`--no-verify`) |
| `aura doctor` | Health check — hooks, config, session status |
| `aura explain <fn> <file>` | Trace the provenance of a function |
| `aura sessions` | List tracked AI agent sessions |
| `aura resume <branch>` | Resume a previous session (detects squash-merges) |
| `aura handover` | Generate compressed AST context for another agent (90%+ token reduction) |

### Experimental Commands

These are powerful but come with caveats — treat their output as suggestions, not guarantees.

| Command | What it does | Caveat |
|---------|-------------|--------|
| `aura goal-trace --goal "..."` | Trace if a behavioral goal is reachable in the AST | Checks path existence, not runtime correctness |
| `aura suggest-fix --base main` | Generate patch suggestions for invariant violations | Suggestions, not guaranteed fixes |
| `aura orchestrate run "..."` | Multi-agent orchestration (Claude + Gemini in parallel) | Requires both agents installed |

## Multi-Agent Support

Aura detects and tracks sessions from multiple AI agents:

- **Claude Code** — via hooks (`SubagentStart`, `UserPromptSubmit`, `Stop`)
- **Gemini CLI** — via hooks and process detection
- **Cursor** — via workspace detection
- **OpenCode** — via env vars and config files

Session data includes turn count, token usage (input/output/cache), and estimated cost. Cost is estimated from transcript token counts, not from API billing.

## MCP Server

Aura exposes an MCP server (JSON-RPC 2.0 over stdio) for direct AI agent integration:

```json
{
  "mcpServers": {
    "aura-vcs": {
      "command": "aura",
      "args": ["mcp"]
    }
  }
}
```

| Tool | Description |
|------|-------------|
| `aura_read_history` | Search semantic logic history |
| `aura_log_intent` | Log architectural intent before commits |
| `aura_pr_review` | Run semantic PR review |
| `aura_status` | Check repository semantic status |
| `aura_snapshot` | Snapshot a file before editing |
| `aura_snapshot_list` | List all recoverable file snapshots |

MCP responses use **TOON (Token-Oriented Object Notation)** — 30-60% fewer tokens than JSON.

## Plugin System

Aura supports a trait-based plugin system with dynamic loading:

```toml
# .aura/plugins.toml
[plugins]
enabled = ["cost-reporter"]
# custom_paths = ["~/.aura/plugins/my-plugin.dylib"]
```

Built-in plugins: `cost-reporter` (session cost estimation). Custom plugins implement the `AuraPlugin` trait and are loaded at runtime via shared libraries.

## Durable File Snapshots

Every file change is automatically captured to `.aura/snapshots/`:

- AI edits a file → snapshot taken before the edit via MCP
- Watcher daemon running → every save captured
- Rewind fails to find commits → snapshots searched first
- Auto-prune: 50 per file, 500 total (~2.5MB max)

Your work is never lost, even if the AI destroys it and no git commit exists.

## Architecture

```
src/
  parser.rs       — Tree-sitter AST parsing (Rust, Python, TypeScript, JavaScript)
  checkpoint.rs   — Semantic checkpoints + durable file snapshots
  mcp.rs          — MCP server (JSON-RPC 2.0 over stdio)
  pr.rs           — Semantic PR review engine
  session.rs      — Session lifecycle + turn tracking
  hook.rs         — Git hook installer (chains with Husky/Lefthook/etc.)
  plugin.rs       — Trait-based plugin system with dynamic loading
  orchestrate.rs  — Multi-agent orchestration engine
  gsd.rs          — Goal tracing + plan execution
  toon.rs         — TOON encoder for token-efficient responses
  watcher.rs      — Continuous file watcher daemon
  server.rs       — Local API + dashboard server
  config.rs       — Global configuration manager
  models.rs       — Core data models (AstNode, etc.)
```

## Supported Languages

| Language | Extensions | Status |
|----------|-----------|--------|
| Rust | `.rs` | Full support |
| Python | `.py` | Full support |
| TypeScript | `.ts`, `.tsx` | Full support |
| JavaScript | `.js`, `.jsx` | Full support |
| Go | `.go` | Full support |
| Java | `.java` | Full support |
| C# | `.cs` | Full support |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp` | Full support |
| C | `.c`, `.h` | Full support |
| Ruby | `.rb` | Full support |
| PHP | `.php` | Full support |
| Swift | `.swift` | Full support |
| Kotlin | `.kt`, `.kts` | Full support |

## Privacy

- All semantic data stored locally by default (`.aura/` directory + git notes)
- Telemetry is opt-in. Set `AURA_TELEMETRY_OPTOUT=1` or `DO_NOT_TRACK=1` to disable
- No data leaves your machine unless you explicitly configure cloud sync
- Semantic Ask uses Gemini API for embeddings only if configured — fully optional

## Requirements

- Rust 1.75+ (for building from source)
- Git
- **For multi-agent orchestration:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Gemini CLI](https://github.com/google-gemini/gemini-cli)

## License

Apache License 2.0 — Copyright (c) 2026 Naridon, Inc.

Built by [Naridon](https://naridon.com) in Switzerland.
