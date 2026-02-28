# Aura v0.2.0-alpha: The Definitive Feature Audit
**Release Date:** March 1, 2026
**Architecture:** Sovereign Semantic Version Control (Git-Native)
**Philosophy:** Logic is the Asset. Text is the Noise.

---

## 🏗️ 1. Core Semantic Engine (The Merkle-Graph)
Aura treats your codebase as a mathematical directed acyclic graph (DAG) of logic nodes, not a flat collection of text files.
- **AST Logic Tracking**: Natively parses Rust, Python, TypeScript, and JavaScript using `tree-sitter`.
- **Logic Node Identity**: Functions and classes are tracked via persistent IDs that survive renames, moves, and massive refactors.
- **Deterministic Hashing**: Content hashes are immune to whitespace and comment changes, tracking only the *functional math* of your code.
- **Continuous State Tracker (`aura daemon`)**: A background process that captures granular micro-checkpoints on every file save, providing a high-fidelity "DVR" for your development process.

## 🧠 2. Intelligent Orchestration (The GSD Engine)
Aura integrates the "Get Shit Done" methodology directly into the Rust core, powered by the local Merkle-Graph.
- **X-Ray Planning (`aura plan`)**: Generates execution roadmaps by querying the local AST dependency graph. The AI sees the "blast radius" of changes before writing a single wave.
- **Dual-Output Logic**: Synthesizes machine-readable XML waves for the executor and human-readable `PLAN.md` roadmaps for the architect.
- **Interactive Questioning**: Halts execution to ask clarifying questions, ensuring the plan aligns with human intent before proceeding.
- **Atomic Waves (`aura execute`)**: Executes implementation plans in isolated contexts, preventing context rot and ensuring each "wave" passes AST verification.

## ⏪ 3. The Semantic Time Machine (The Scalpel)
Version control with surgical precision, designed to break the AI hallucination loop.
- **Surgical Rewind (`aura rewind`)**: Reverts a single specific function or class to a previous state without touching the rest of the file or the project.
- **Amnesia Protocol (`--amnesia`)**: Surgically reverts code AND programmatically injects a System Override into AI chat logs (Aider, Gemini, Claude), forcing the agent to forget its mistake and stop the loop.
- **Project Snapshots (`aura snapshot`)**: Captures a project-wide safety baseline (including environment fingerprint) before risky AI refactorings.

## 🛡️ 4. Security & Sovereign Governance
Aura acts as a "Parasitic Gatekeeper" that mathematically enforces your architectural doctrine.
- **Intent Poisoning Detection**: Blocks `git commit` if the textual intent (.gemini.intent) does not mathematically align with the AST nodes modified.
- **Deployment Gatekeeper (`verify-env`)**: Simulates production deployments and hard-blocks code that introduces forbidden dependencies (e.g., untrusted libs in sensitive handlers).
- **Sovereign Allowlist (`request-access`)**: A node-level protocol to authorize legitimate high-entropy logic (like Auth headers) without compromising global security rules.
- **Semantic Audit (`aura audit`)**: Scans Git history to identify commits that bypassed the gatekeeper using `--no-verify`.
- **Logic RBAC (`generate-stubs`)**: Automatically generates a "Virtual Workspace" where sensitive logic nodes are replaced with unimplemented stubs, safe for external contractor or untrusted agent access.

## ⚙️ 5. AI-Native Developer Experience (DX)
Built for a future where AIs and Humans collaborate in the same terminal.
- **Zero-Friction Configuration**: Supports non-interactive `aura config set` commands for automated agent setup.
- **Lightweight Dev Mode (`--dev`)**: Bypasses enterprise-grade 2-of-3 Multi-Sig protocols for instantaneous local prototyping.
- **Natural Language Search (`aura ask`)**: Query your codebase's semantic history using high-dimensional vector embeddings (local RAG).
- **Self-Healing State**: Dynamically rebuilds its semantic brain from Git metadata if local state files are deleted.

---
**Naridon, Inc. Delaware, USA**
*Building the Foundational Infrastructure for the Autonomous Agent Era.*
