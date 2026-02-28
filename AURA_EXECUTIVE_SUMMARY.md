# Aura: Sovereign Semantic Infrastructure
## Executive Summary & Technical Manifesto
**Version**: 1.0 (March 2026)
**Company**: Naridon, Inc. (Delaware)
**Product State**: Alpha (v0.1.0)

---

## 1. The Core Vision
Aura was built on a single, undeniable premise: **The age of software engineering as "text manipulation" is over.** 

As AI agents (Cursor, Aider, Claude Code) become the primary writers of code, standard Version Control Systems (Git) are failing. They track line-level diffs, but they are blind to **Architectural Intent**. Aura is the first version control system designed for a world where AI writes the code and humans manage the logic.

> *"Aura doesn't just track what changed. It understands why it changed and what it breaks."*

---

## Technical Breakthroughs

### A. Semantic Logic Nodes (The End of the Diff)
Standard Git sees code as a series of text lines. Aura uses `tree-sitter` to parse code into an **Abstract Syntax Tree (AST)**. We track **Logic Nodes** (functions, classes, methods) rather than files. 
*   **Renaming?** Aura knows it's the same logic.
*   **Moving files?** Aura maintains the historical thread.
*   **Refactoring?** Aura tracks the functional transformation, not the whitespace.

### B. Neural Intent RAG (The "Why" Layer)
Aura captures the reasoning behind every change. By integrating with the Gemini Embedding API, Aura generates 768-dimensional vectors for every commit.
*   **Natural Language Search**: "Why did we add the retry logic?" finds the exact logic node even if the words don't match.
*   **Forensic Scraping**: Aura "spies" on AI agent transcripts (Cursor SQLite, Aider Markdown) to extract intent automatically.

### C. The Merkle-Graph (Logic Awareness)
Aura builds a directed graph of your software's dependencies using `petgraph`. 
*   **Blast Radius Detection**: If an AI changes a core auth function, Aura instantly calculates every downstream module that is now "tainted."
*   **Cross-Repo Tracing**: Semantic URIs (`global://module/api`) allow tracking logic dependencies across microservices.

### D. Autonomous Arbitrator & Logic RBAC
Aura is the only system capable of autonomously resolving semantic conflicts and enforcing logic-level permissions.
*   **Autonomous Arbitrator**: Automatically synthesizes patches to resolve merge conflicts using local LLMs or Gemini.
*   **Sovereign Vault (RBAC)**: Strips proprietary code and generates "Virtual Workspaces" with logic stubs for secure third-party collaboration.

---

## 3. The Ecosystem Architecture

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Aura Core** | Rust (Axum, Tokio) | High-performance CLI, daemon, and AST parsing engine. |
| **Sovereign Dashboard** | React 18, Tailwind, Vite | Local-first UI for logic graph visualization and team management. |
| **Cursor Extension** | Node.js / VS Code API | Native IDE integration to capture developer intent on every file save. |
| **Sovereign Vault** | AES-256-GCM | Zero-knowledge local encryption for all architectural IP. |
| **Autonomous Arbitrator** | LLM / Gemini API | Self-healing code conflict resolution engine. |

---

## 4. Key Functional Capabilities

### 1. Surgical Semantic Rewind
The most powerful tool for AI development. `aura rewind <node_id>` allows you to extract a specific function from 3 months ago and patch it into your current file without losing any of your other work. It is "Git Revert" at the level of a single function.

### 2. Production Gatekeeper
`aura verify-env <target>` projects your code's logic graph against production constraints. If an AI introduces a forbidden dependency or a security bypass, the commit is physically blocked.

### 3. Semantic Compaction (GC)
Aura's `daemon` captures "micro-checkpoints" every time you save a file. To prevent repo bloat, `aura gc` prunes the noise, keeping only the meaningful architectural shifts.

### 4. Neural Intent Redaction
`src/redact.rs` uses Information Theory (Shannon Entropy) to scrub PII and secrets before they ever leave the local machine, ensuring absolute privacy when using cloud embeddings.

---

## 5. Comparative Advantage: Aura vs. Entire.io

| Feature | Entire.io (The VCR) | **Aura (The Brain)** |
| :--- | :--- | :--- |
| **Primary Unit** | AI Chat Session | **Logic Node (AST)** |
| **User Base** | HR / Audit / Juniors | **Senior Engineers / AI Agents** |
| **Data Privacy** | Cloud SaaS (Siloed) | **Sovereign Vault (Local-First)** |
| **Search** | Keyword / Metadata | **Neural RAG (Meaning)** |
| **Conflict Resolution** | Manual Merge | **Autonomous Arbitrator** |
| **Security** | Repo-Level RBAC | **Logic-Node RBAC** |

---

## 6. The V4.0 Milestone (Mission Accomplished)

Aura has successfully completed all six phases of its initial master plan. From local semantic tracking and forensic intent scraping to autonomous conflict resolution and zero-trust logic stubs, Aura stands as the definitive infrastructure for the AI-native development era.

---

**Copyright © 2026 Naridon, Inc.**
*Naridon, Inc. is a Delaware-based company dedicated to building the foundational infrastructure for the Autonomous Agent era.*
