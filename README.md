<div align="center">

# Aura
**The Semantic Version Control Engine for AI-Generated Code.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Website](https://img.shields.io/badge/Website-auravcs.com-10b981)](https://auravcs.com)
[![GitHub Release](https://img.shields.io/github/v/release/MHASK/aura-sovereign)](https://github.com/MHASK/aura-sovereign/releases)

**Git tracks text lines. Aura tracks mathematical logic.**

Built in Rust. Works with Claude Code, Cursor, Gemini CLI, Aider, and OpenCode.

</div>

---

## The Problem

AI agents write code faster than humans can review. When an AI refactors 8 files in 14 seconds and introduces a subtle bug on minute 12, `git revert` creates a massive merge conflict. The AI's reasoning is lost when the session ends.

## The Solution

Aura is a **semantic layer on top of Git**. It parses your codebase into an Abstract Syntax Tree (AST), assigns cryptographic IDs to every function and class, and attaches the AI's intent to each change via Git Notes.

This gives you:
- **Surgical rewind** — revert a single function without merge conflicts
- **Intent verification** — know *why* the AI wrote every line of code
- **Deletion guard** — block AI agents from accidentally removing working features
- **Semantic PR review** — catch bugs, security issues, and architectural violations using AST diffing + AI

---

## Installation

```bash
curl -fsSL https://auravcs.com/install.sh | bash
```

Then inside any Git repository:

```bash
aura init
```

Aura hooks into your Git workflow. You `git commit` as always — Aura handles the rest.

---

## Commands

### Core

| Command | Description |
|---------|-------------|
| `aura init` | Initialize Aura in a repository with setup wizard |
| `aura status` | View checkpoints, tracked nodes, session info, and config |
| `aura config` | Manage configuration (API keys, strict mode, telemetry) |
| `aura doctor` | Diagnose and repair stuck sessions, orphaned data |

### AI Safety

| Command | Description |
|---------|-------------|
| `aura rewind <identifier>` | Surgically revert a function/class to a previous safe state |
| `aura explain <identifier>` | Trace code back to the AI conversation that created it |
| `aura audit` | Scan Git history for code pushed without intent verification |
| `aura request-access <id>` | Whitelist a node for high-entropy secrets |

### Code Review

| Command | Description |
|---------|-------------|
| `aura pr-review --base <branch>` | Semantic PR review with AI bug/security scanning |
| `aura suggest-fix` | Generate patches for architectural violations (experimental) |
| `aura policy` | Manage Architectural Invariant Policy Packs |
| `aura goal-trace <goal>` | Verify if codebase supports a behavioral goal (experimental) |

### Planning & Orchestration

| Command | Description |
|---------|-------------|
| `aura plan <objective>` | Decompose an objective into atomic execution waves |
| `aura execute` | Execute the current plan wave-by-wave with AST verification |
| `aura orchestrate` | Multi-agent orchestration — Claude + Gemini in parallel |
| `aura symphony` | Linear-driven development workflows with AI agents |

### Context & Sessions

| Command | Description |
|---------|-------------|
| `aura handover` | Generate token-optimized XML context for another AI agent |
| `aura sessions` | List and manage agent sessions |
| `aura resume` | Resume a previous session with full context |
| `aura completions` | Generate shell completions (bash, zsh, fish) |

---

## Key Features

### Semantic Checkpoints
Every `git commit` triggers AST parsing. Aura extracts every function, class, and struct, computes content hashes, and stores the Merkle-Graph as Git Notes.

### Surgical Rewind
Revert a single function to its state from any previous checkpoint — without touching the rest of the codebase. Zero merge conflicts.

```bash
aura rewind retry_logic
```

### Deletion Guard
In strict mode, Aura blocks commits that delete logic nodes unless the developer logs intent explaining why. Prevents AI agents from accidentally removing working features.

```bash
# Log intent before deleting code
aura log-intent "Removed legacy auth module — replaced by OAuth2 in auth_v2.rs"
git commit -m "refactor: remove legacy auth"
```

### Intent Verification
Aura captures the AI agent's reasoning and binds it to AST changes. If intent doesn't align with code changes, the commit is flagged.

### Semantic PR Review
Diff against AST structure, not text. AI-powered scanning for bugs, security issues, and architectural violations with blast radius analysis.

```bash
aura pr-review --base main --json
```

### GSD Orchestrator
Break complex objectives into atomic waves. Each wave is verified against the Merkle-Graph before proceeding.

```bash
aura plan "Add WebSocket support for real-time updates"
aura execute
```

### Handover (Context Transfer)
Generate a dense XML summary of the entire codebase's semantic state. Pass it to another AI agent to resume work with ~90% fewer tokens.

```bash
aura handover --agent claude
```

### Multi-Agent Orchestration
Run Claude Code and Gemini CLI in parallel on different waves of the same plan. Aura coordinates, detects conflicts, and merges results.

```bash
aura orchestrate --objective "Implement auth + billing" --strategy smart
```

---

## MCP Server

Aura exposes 29 tools via the Model Context Protocol for direct integration with Claude Code, Cursor, and other MCP-compatible editors. Key tools:

- `aura_status` — check semantic state
- `aura_log_intent` — log reasoning before commits
- `aura_handover` — context transfer between agents
- `aura_plan_discover` / `aura_plan_lock` / `aura_plan_next` — GSD orchestration
- `aura_prove` — behavioral verification
- `aura_rewind` — surgical rollback
- `aura_pr_review` — semantic code review
- `aura_doctor` — health diagnostics
- `aura_snapshot` / `aura_snapshot_list` — snapshot management

---

## Configuration

```bash
# Enable strict mode (blocks suspicious deletions, enforces intent)
aura config set strict-mode true

# Set AI provider for PR reviews and planning
aura config set ai-provider gemini
aura config set gemini-api-key <key>

# Dev mode (relaxed checks for solo development)
aura config set dev-mode true
```

---

## How It Works

1. **Parse** — On every commit, Aura parses staged files into ASTs using tree-sitter (Rust, TypeScript, JavaScript, Python, Go, and more)
2. **Hash** — Each function/class gets a deterministic content hash (rename-proof)
3. **Store** — The Merkle-Graph is attached to the commit via Git Notes
4. **Guard** — Pre-commit hook verifies intent, checks for secrets, and prevents accidental deletions
5. **Review** — PR reviews diff against AST structure with AI-powered analysis

Everything stays local in your `.git` folder. No cloud required.

---

## License

Apache 2.0. See [LICENSE](LICENSE).

Aura **fails open** — if AST parsing exceeds budget, Aura steps aside and lets the commit through. It will never block a hotfix.
