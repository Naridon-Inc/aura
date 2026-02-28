# Aura v4.0: The Complete Feature Inventory
## Every Advancement, Thought, and "Minute" Feature Explored

This document provides a comprehensive audit of the Aura system as of February 27, 2026. It incorporates the core "Physics Engine" concepts, the operational doctrine for senior engineers, and the commercial strategy for enterprise scale.

---

## 1. Core "Physics" & AST Layer (The Foundation)

### 1.1 Deep AST Traversal (vs. Grep)
*   **The Feature**: Aura uses `tree-sitter` to recursively walk the syntax tree of code.
*   **The Advancement**: Unlike linters that use regex, Aura only targets `call_expression` and `import_statement` nodes. 
*   **The Result**: Zero false positives. Aura ignores comments, strings, and docblocks, mathematically proving whether forbidden logic exists in the executable path.

### 1.2 Immutable Logic Identity (`node_id`)
*   **The Feature**: Every function/struct is assigned a unique ID based on its **Structural Skeleton Hash**.
*   **The Thought**: Standard Git ties history to file paths. Aura ties it to the *shape* of the logic.
*   **The Advancement**: If you rename a function and move it across files, Aura detects the >95% structural match and maintains the historical thread. The history survives the "Renaming Death Spiral."

### 1.3 Epistemic Truth Model
*   **The Feature**: Every refactor link in the dashboard is assigned a `confidence` score (e.g., 0.85).
*   **The Thought**: Senior engineers hate "magic." Aura explicitly surfaces uncertainty, showing exactly how much of the original logic survived a refactor.

---

## 2. Neural Context & Discovery (The Memory)

### 2.1 Forensic Intent Scraping
*   **The Feature**: A background daemon monitors `.vscdb` (Cursor) and `.aider.chat.history.md` (Aider).
*   **The Advancement**: It "spies" on the AI's internal reasoning logs to capture the **Why** behind a change, even if the developer forgot to write a commit message.

### 2.2 Semantic RAG Search
*   **The Feature**: Natural language query interface (Gemini-powered embeddings).
*   **The Result**: Ask *"Why did we switch to exponential backoff?"* and Aura finds the exact moment in the AI's reasoning, bypassing the need to remember commit hashes.

### 2.3 Shannon Entropy Redaction
*   **The Feature**: Local scrub of all high-entropy strings before embedding generation.
*   **The Advancement**: It detects API keys and secrets using information theory mathematics, ensuring proprietary data never hits a cloud embedding API.

---

## 3. Surgical Governance & Safety (The Shield)

### 3.1 Surgical Semantic Rewind
*   **The Feature**: `aura rewind <identifier>`
*   **The Advancement**: Extracts the AST subtree of a single function from a past state and patches it into the current file. 
*   **The Result**: No merge conflicts. You only revert the broken logic, not the entire file.

### 3.2 The Autonomous Arbitrator
*   **The Feature**: LLM-powered merge resolution in isolated "Shadow Branches."
*   **The Advancement**: Synthesizes a third-way patch that satisfies both sets of logic constraints and verifies it via unit tests before presenting it to the human.

### 3.3 Semantic Compaction (GC)
*   **The Feature**: `aura gc`
*   **The Thought**: Prevent "Repo Bloat" from continuous daemon saves.
*   **The Advancement**: A "Meaning-First" pruning algorithm that keeps architectural shifts but discards "typing noise."

### 3.4 Blast Radius Detection
*   **The Feature**: Directed Merkle-Graph of the entire repository.
*   **The Advancement**: If a core auth function changes, Aura calculates every downstream module that is now "tainted."

---

## 4. Orchestration & Performance (The Doctrine)

### 4.1 Native GSD Wave Execution
*   **The Feature**: `aura plan` & `aura execute`
*   **The Advancement**: Combats "Context Rot" by breaking massive tasks into atomic, constrained XML plans. It clears the AI's memory between "waves" to prevent hallucinations.

### 4.2 Performance Budgets (Fail-Open)
*   **The Hook Budget**: Synchronous parsing is capped at **50ms**. If exceeded, it triggers a hard kill-switch to ensure Aura never slows down a developer's workflow.
*   **Repo-State Awareness**: The daemon pauses itself during `git rebase` or `checkout` storms to prevent CPU thrashing.

### 4.3 Virtual Workspace Stubs
*   **The Feature**: `aura generate-stubs`
*   **The Advancement**: Generates a compiling codebase for contractors where restricted logic is replaced with **Type-Safe Semantic Mocks**. IP stays in the vault; the code still runs.

---

## 5. Commercial & Strategic Insights

### 5.1 Open-Core Strategy
*   **Tier 1 (Free)**: CLI, Physics Engine, GSD Planner. (Drives bottom-up adoption).
*   **Tier 2 (Enterprise)**: Sovereign Vault, RBAC, Team Dashboard, P2P Sync.

### 5.2 The Git Notes Standard
*   **The Vision**: Aura doesn't create hidden branches by default; it uses **Git Notes** (`refs/notes/aura`). 
*   **The Thought**: This makes semantic metadata invisible, conflict-free, and standardizable across the industry.

---

## Summary Comparison

| Metric | Standard Git | Entire.io | **Aura (Naridon)** |
| :--- | :--- | :--- | :--- |
| **Logic Unit** | Line | Session | **AST Node** |
| **History** | Path-Based | Session-Based | **Identity-Based** |
| **Security** | Repo-Level | SaaS/Cloud | **Logic-Level / Local** |
| **Merging** | Textual | Dashboard | **Mathematical (AST)** |
| **Context** | Zero | Metadata | **Neural (Intent)** |

**Naridon, Inc. (Delaware)**
*Building the Foundational Infrastructure for the Autonomous Agent Era.*
