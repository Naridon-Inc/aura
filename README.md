# Aura Core (Rust Engine)
**Version: v0.2.0-alpha**

This is the core engine of the Aura ecosystem, written in Rust for performance and safety. It provides the command-line interface (CLI) for managing semantic version control, parsing Abstract Syntax Trees (ASTs), and enforcing architectural sovereignty.

## 🛠️ Installation

```bash
# From source
cd aura
cargo build --release
cargo install --path . --force
```

## 🚀 Key Commands

### `aura init`
Initializes a new semantic repository and installs the native Git hooks.

### `aura plan "<objective>"`
Synthesizes atomic execution waves.
*   **XML Generation**: Creates `.aura/plans/ACTIVE_MILESTONE.xml` for the `execute` command.
*   **Markdown Roadmap**: Generates a human-readable `PLAN.md` roadmap.

### `aura rewind <node_id> <file_path> [--amnesia]`
Surgically restores a logic node (function/class) from history.
*   **--amnesia**: Injects a System Override into local AI context to wipe the agent's memory of the mistake.

### `aura status`
Displays live metrics for the Merkle-Graph and the current security posture.

### `aura ask "<query>"`
Performs a natural language search against your codebase's history.
*   **DX Update**: Provides clear configuration instructions if the `GEMINI_API_KEY` is missing.

### `aura audit`
Scans the local Git repository for commits that bypassed the Aura Semantic Gatekeeper (e.g., using `git commit --no-verify`).
*   **Security Insight**: Instantly identifies which developers or agents are skipping the semantic verification checks.

### `aura request-access <identifier>`
Requests an override for a logic node (function or class) that was flagged by the **Semantic Sentinel** as containing a secret.
*   **Use Case**: Essential for allowlisting legitimate headers (e.g., `Authorization: Bearer`) or configuration logic that uses high-entropy strings.

### `aura verify-env [--target] <env>`
Checks for architectural violations in your AST against environment constraints.
*   **Flexible Syntax**: Supports both positional and `--target` flags.

### `aura secure-init [--dev]`
Initializes the Sovereign Vault. Use `--dev` for a fast, lightweight local setup.

### `aura config [set <key> <value>]`
Manages global configuration. Supports non-interactive `set` subcommand for AI agents.

### `aura generate-stubs`
Creates logic stubs for proprietary code. Auto-generates a default `rbac.json` if missing.

### `aura daemon`
Starts the background file watcher for continuous semantic tracking.

### `aura dashboard`
Starts the local web dashboard at http://127.0.0.1:8090.

## 🏗️ Architecture

### 1. The Parser (`src/parser.rs`)
Uses `tree-sitter` for Rust, Python, TypeScript, and JavaScript parsing.

### 2. The Checkpoint System (`src/checkpoint.rs`)
Manages semantic states stored via Git Notes.

### 3. The Local Server (`src/server.rs`)
Axum-based API and dashboard host.

## 🔒 Security

*   **Local Encryption**: AES-256-GCM.
*   **Sovereign Vault**: 100% offline metadata storage option.

## License

Apache License 2.0 Copyright (c) 2026 Naridon, Inc.
