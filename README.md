<p align="center">
  <img src="https://img.shields.io/badge/version-0.5.0-white?style=flat-square" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/lang-Rust-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/agents-Claude%20Code%20%2B%20Gemini%20CLI-green?style=flat-square" />
</p>

<h1 align="center">Aura</h1>
<p align="center"><strong>Semantic Version Control for AI-Native Engineering</strong></p>

<p align="center">
Track logic, not lines. Run Claude Code and Gemini CLI in parallel.<br/>
Surgically rewind AI hallucinations. Mathematically prove architectural goals.
</p>

---

Aura is a meta-layer on top of Git. It tracks the **mathematical logic** of your codebase (AST Merkle-Graph) instead of text diffs, giving you:

- **Duo Mode** — Run Claude Code and Gemini CLI simultaneously on the same codebase
- **Surgical Rewind** — Swap a single hallucinated function without touching the rest of the file
- **Semantic PR Review** — Detect logical renames, layer violations, and blast radius
- **Durable Snapshots** — Every file change is captured. Your work is never lost.
- **TOON Encoder** — 30-60% fewer tokens on MCP responses to LLMs

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

## Duo Mode — Multi-Agent Orchestration

Run **Claude Code** and **Gemini CLI** in parallel. Aura coordinates task assignment, relays context between agents, and validates every wave with semantic PR review.

```bash
# Sequential wave execution
aura orchestrate run "add user authentication and write tests"

# Parallel dual-agent relay
aura orchestrate run "refactor database layer and update API docs" --duo
```

**How it works:**
1. Decomposes your objective into tasks (both agents contribute to planning)
2. Smart assignment — complex refactors go to Claude, everything else to Gemini (free tier)
3. Agents run in parallel threads, each with compressed AST context via `aura handover`
4. After each round, agents receive relay messages showing what the other did
5. `aura pr-review` validates every wave. Failures auto-retry with agent swapping.

```
Session controls:
  aura orchestrate status    # Check progress
  aura orchestrate pause     # Pause execution
  aura orchestrate resume    # Resume from where you left off
  aura orchestrate cancel    # Abort the session
  aura orchestrate list      # View all sessions
```

## Symphony — Linear-Driven AI Workflows

Connect Linear issues directly to AI agent execution.

```bash
aura symphony run --team ENG
aura symphony status
```

Pull issues, decompose PRDs into atomic tasks, execute with Duo Mode, and push status updates back to Linear. Configure via `.aura/WORKFLOW.md`.

## Core Commands

### Surgical Rewind

```bash
# Revert a single function to its previous safe state
aura rewind calculate_tax src/billing.rs

# Also wipe the AI's memory of the bad code
aura rewind calculate_tax src/billing.rs --amnesia
```

Searches durable snapshots first, then walks 50 commits of git history. Auto-snapshots before rewind for safety.

### Semantic PR Review

```bash
aura pr-review --base main
aura pr-review --base main --json    # Machine-readable output
aura pr-review --base main --verbose # Full node details
```

Detects: logical renames, layer violations, forbidden calls, undocumented nodes, cross-branch conflicts. Outputs risk score 0-100.

### Plan & Execute

```bash
aura plan "migrate from REST to GraphQL"
aura execute
```

Decomposes objectives into atomic waves with AST-verified execution.

### Mathematical Proof

```bash
aura prove --goal "users can log in via Google"
```

Traces logic paths in the AST to mathematically verify behavioral goals.

### Autonomous Fix

```bash
aura fix --base main
```

Shadow-branch loop that auto-resolves architectural invariant violations.

### Handover — Context Compression

```bash
aura handover cursor    # Generate compressed context for another agent
```

Produces a dense XML summary of the AST Merkle-Graph. 90%+ token reduction vs reading raw files.

### Policy Packs

```bash
aura policy add security    # No plaintext secrets, no eval()
aura policy add payments    # PCI-DSS patterns
aura policy add web-app     # XSS, CSRF, injection prevention
```

## MCP Server (AI Agent Integration)

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

**Available MCP Tools:**

| Tool | Description |
|------|-------------|
| `aura_read_history` | Search semantic logic history |
| `aura_log_intent` | Log architectural intent before commits |
| `aura_pr_review` | Run semantic PR review |
| `aura_status` | Check repository semantic status |
| `aura_snapshot` | Snapshot a file before editing (safety net) |
| `aura_snapshot_list` | List all recoverable file snapshots |

MCP responses use **TOON (Token-Oriented Object Notation)** — 30-60% fewer tokens than JSON for structured data.

## Dashboard

```bash
aura dashboard
# Opens at http://127.0.0.1:8090
```

Visualize checkpoints, orchestration sessions, PR reviews, logic graphs, and rewind history. A standalone React dashboard is also included in `dashboard/`.

## Durable File Snapshots

Every file change is automatically captured to `.aura/snapshots/`. This means:

- **AI edits a file** — snapshot is taken before the edit via MCP `aura_snapshot`
- **Watcher daemon running** — every save is captured automatically
- **Rewind fails to find commits** — snapshots are searched first
- **Auto-prune** — 50 per file, 500 total (~2.5MB max)

Your work is never lost, even if the AI destroys it and no git commit exists.

## Architecture

```
src/
  parser.rs       — Tree-sitter AST parsing (Rust, Python, TypeScript, JavaScript)
  checkpoint.rs   — Semantic checkpoints + durable file snapshots
  mcp.rs          — MCP server (JSON-RPC 2.0 over stdio)
  orchestrate.rs  — Duo Mode multi-agent orchestration engine
  symphony.rs     — Linear-driven AI workflow engine
  linear.rs       — Linear API client
  pr.rs           — Semantic PR review engine
  gsd.rs          — GSD Orchestrator (plan/execute waves)
  toon.rs         — TOON encoder for token-efficient responses
  watcher.rs      — Continuous file watcher daemon
  server.rs       — Local Axum API + dashboard server
  hook.rs         — Git hook installer
  arbitrator.rs   — Multi-agent conflict resolution
  config.rs       — Global configuration manager
  models.rs       — Core data models (AstNode, etc.)
dashboard/        — React + Vite dev metrics dashboard
```

## Supported Languages

| Language | Parser | Status |
|----------|--------|--------|
| Rust | tree-sitter-rust | Full support |
| Python | tree-sitter-python | Full support |
| TypeScript | tree-sitter-typescript | Full support |
| JavaScript | tree-sitter-javascript | Full support |

## Requirements

- Rust 1.75+ (for building from source)
- Git
- **For Duo Mode:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **For Symphony:** Linear API key (`aura config set api-key linear:<key>`)

## License

Apache License 2.0 — Copyright (c) 2026 Naridon, Inc.

Built by [Naridon](https://naridon.com) in Switzerland.
