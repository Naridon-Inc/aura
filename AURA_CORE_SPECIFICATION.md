# Aura: The Sovereign Semantic Core Specification
## A Deep Dive into the Architecture of AI-Native Version Control
**Company**: Naridon, Inc. (Delaware)
**Date**: February 28, 2026
**Status**: Feature Complete (v0.2.0-alpha Release)

---

## 1. The Philosophical Genesis: Why Aura?

### The Death of the Line-Based Diff
For 50 years, version control has treated code as a sequence of text lines. This was sufficient when humans were the primary writers of software. However, we have entered the **Agentic Era**. AI agents (Cursor, Aider, Claude) do not think in lines; they think in **Logic Nodes** and **Architectural Intent**. 

When an AI refactors a 500-line class, a standard Git diff shows a chaotic wall of red and green that is impossible for a human to review. Aura was born to solve this. It shifts the "unit of truth" from the file to the **Abstract Syntax Tree (AST)**.

### The "Black Box" Problem
AI agents often perform "shadow work"—making subtle changes to logic that standard tools ignore. Aura provides a **High-Fidelity Flight Recorder** for the development process. It captures not just what the code is, but the "Why" (the intent) by scraping the AI's internal reasoning logs.

---

## 2. Technical Architecture: The Three Pillars

Aura is built on three fundamental technological pillars that differentiate it from every legacy tool.

### Pillar I: Semantic AST Identity
Aura doesn't see `src/auth.rs`. It sees `Function: validate_session` and `Struct: UserProfile`.
*   **Tree-Sitter Integration**: We use native Rust bindings for `tree-sitter` to parse code in real-time.
*   **Deterministic Hashing**: Every logic node is assigned a unique, immutable ID based on its structural signature, not its name or location. This allows Aura to track a function even if it is renamed, moved to a different file, or refactored into a different language.
*   **The Merkle-Graph**: Aura constructs a directed acyclic graph (DAG) of the entire codebase's dependencies. This allows for **Blast Radius Detection**—if a core logic node changes, Aura knows every downstream node that is impacted.

### Pillar II: Neural Intent RAG
Aura is the first version control system with a "Memory."
*   **Gemini Embedding Pipeline**: We use 768-dimensional vectors to represent the **Intent** behind every change.
*   **Forensic Scraping**: Aura's background daemon actively monitors the local filesystem. It queries Cursor's internal SQLite database (`state.vscdb`) and Aider's markdown logs to extract the natural language reasoning of the AI.
*   **Semantic Search**: You can query your codebase history using natural language: *"Find the time we changed the database timeout logic because of the AWS outage."*

### Pillar III: The Sovereign Vault (Zero-Trust)
In a world of cloud-based AI, code privacy is the ultimate currency.
*   **Zero-Knowledge Encryption**: All architectural metadata is encrypted locally using AES-256-GCM. The cloud (GitHub) only sees encrypted blobs.
*   **Logic-Level RBAC**: Aura allows for **Surgical Access Control**. You can grant a contractor access to the repository but use `aura generate-stubs` to physically remove proprietary logic from their local machine, replacing it with compiler-safe "Logic Stubs."

---

## 3. The Feature Deep Dive: Minute Advancements

### 3.1 The Continuous DVR (Background Daemon)
Most developers forget to commit frequently. Aura's `notify`-based daemon stages "micro-checkpoints" on every file save. These are stored in a hidden `aura/checkpoints/v1` branch, creating a seamless, undo-able history of every single thought the AI had.

### 3.2 Surgical Semantic Rewind
Legacy Git allows you to revert a file. Aura allows you to revert a **Symbol**.
*   **Command**: `aura rewind <node_id>`
*   **Mechanism**: Aura extracts the specific AST subtree from a past checkpoint and performs a "Semantic Patch" into your current working directory. It doesn't touch the rest of the file, avoiding 99% of merge conflicts.

### 3.3 The Autonomous Arbitrator
Merge conflicts are the bane of AI-assisted development.
*   **Mechanism**: When a semantic conflict is detected, Aura spawns an isolated "Shadow Branch." It passes the conflicting logic and the high-level architectural intent to a local LLM (or Gemini Pro).
*   **Resolution**: The Arbitrator synthesizes a third way—a patch that satisfies both sets of logic constraints—and verifies it by running local unit tests before presenting it to the user.

### 3.4 Semantic Compaction (Garbage Collection)
The downside of continuous checkpointing is repo bloat.
*   **Advancement**: `aura gc` uses a "Meaning-First" pruning algorithm. It keeps checkpoints that represent major architectural shifts (detected by AST change thresholds) while discarding high-frequency "typing noise."

### 3.5 Neural Intent Redaction
Before any metadata is sent to an embedding API, Aura's `redact.rs` module performs a multi-pass scrub.
*   **Regex Pass**: Removes IPs, Emails, and API Keys.
*   **Information Theory Pass**: Calculates the Shannon Entropy of every string. If a string has high entropy (indicating a cryptographic key or secret), it is automatically replaced with `[REDACTED_HIGH_ENTROPY]`.

### 3.6 High-Fidelity DX & UX (Autonomous Interaction)
Aura recognizes that "Developer Experience" for an AI agent is different than for a human.
*   **Non-Interactive Configuration**: Added the `aura config set <key> <value>` protocol. This allows AI agents to configure Aura’s security posture (Strict Mode, Dev Mode) autonomously without being blocked by TTY/Interactive terminal menus.
*   **Semantic Error Diagnostics**: The "Intent Poisoning" error was upgraded from a generic alert to a proactive debugging tool. It now explicitly lists the missing logic nodes and provides an example commit message to resolve the block instantly.
*   **Flexible CLI Parsing**: The command parser was rewritten to be more resilient, supporting both positional and flag-based arguments (e.g., `verify-env --target production`) to reduce "human-error" crashes.
*   **Lightweight Development Mode**: Introduced a `--dev` flag for `secure-init`. For solo developers, this bypasses the enterprise-grade 2-of-3 Multi-Sig protocols and socket listeners, generating a fast local AES key instead to reduce setup friction.
*   **Sovereign Allowlist (Request Access)**: To solve the "Semantic Sentinel" false-positive problem (e.g., flagging legitimate `Authorization` headers), a node-level allowlist was implemented. Developers can now use the `aura request-access <identifier>` protocol to explicitly authorize specific logic nodes to contain high-entropy strings, maintaining security without blocking production workflows.

---

## 4. The Development Timeline: Phases of Evolution

### Phase 1-2: Foundational Tracking
*   **The Goal**: Stop tracking text, start tracking nodes.
*   **Key Achievement**: The implementation of the hidden Git-native storage layer. We proved we could store complex AST data directly inside Git's object database without breaking standard Git workflows.

### Phase 3-4: The Global Brain & Production
*   **The Goal**: Scale logic tracking across repos and enforce safety.
*   **Key Achievement**: The **Production Gatekeeper**. We built `aura verify-env`, which allows developers to simulate a deployment by projecting the new logic graph against a target environment's constraints (e.g., "Does this code use any library not allowed in the PCI-compliant cluster?").

### Phase 5-6: The Sovereign Vault & Hardening
*   **The Goal**: Enterprise-grade security and platform stability.
*   **Key Achievement**: **Logic-Level RBAC**. We moved beyond repository-level permissions. We can now lock down a single sensitive function (like `decrypt_master_key`) while allowing free modification of the rest of the file.

---

## 5. Minute Design Thoughts & Philosophical Nuances

### On Human Readability
Aura acknowledges that code is increasingly written by machines for machines. However, it prioritizes **Human Oversight**. The dashboard visualization (The Logic Graph) is designed to give humans a "God View" of the architecture, allowing them to spot structural rot that is invisible in a 2D text editor.

### On the MCP Protocol Shift
We moved away from "forensic scraping" toward a native **Model Context Protocol (MCP)** server. This represents a fundamental shift in our thinking: we no longer want to "spy" on the IDE; we want to be the IDE's **Semantic Memory**.

### On the "Seatbelt" Layer
Aura is designed with "Sovereign Defaults." Every feature—from encryption to the Unix Domain Socket for key exchange—is built to assume the local machine is untrusted and the network is hostile.

---

## 6. The Verdict: Aura vs. The Competition

| Dimension | Legacy Git | Entire CLI | **Aura** |
| :--- | :--- | :--- | :--- |
| **Unit of Change** | Text Line | Chat Session | **AST Logic Node** |
| **Orchestration** | None | 0/100 | **85/100 (Native GSD)** |
| **Rewind Mechanic**| Manual Diff | 100/100 (Session Memory) | **90/100 (Surgical Project)** |
| **Understanding** | Zero | Metadata | **Deep Semantic Meaning** |
| **Review Process** | Manual Diff | Audit Log | **Blast Radius Visualization** |
| **Privacy** | Public/Cloud | SaaS Silo | **Sovereign Local Vault** |

### The "Rewind" Nuance: Project vs. Session
While Aura is the ultimate architectural "God Tool," there is a nuanced distinction between Aura and tools like **Entire CLI** when it comes to the "Rewind" mechanic.

*   **Entire CLI (The Session Time Machine)**: Entire is obsessively focused on the *AI's conversational context*. When an AI hallucinates for 20 minutes, `entire rewind` not only restores the filesystem but physically wipes the AI's internal chat history (`.entire/metadata/`). It erases the AI's memory of the mistake, scoring a 100/100 for immediate, localized session recovery.
*   **Aura (The Project Time Machine)**: Aura tracks the *Codebase's Logic Structure*. `aura snapshot` and `aura rewind` guarantee the AST (Abstract Syntax Tree) is perfectly sound when rolling back massive, multi-file structural changes. While it scores a 90/100 for rewind because it doesn't aggressively wipe the host AI's conversational transcript in the exact same way Entire does, it excels at surgical, long-term codebase recovery (e.g., reverting a single function 3 months later without touching surrounding code).

If a team must choose a single foundational layer, **Aura is the victor** because it combines the orchestration of GSD with robust snapshot mechanics, powered by a deterministic semantic engine.

---

## 7. Conclusion: The Infrastructure for Tomorrow

Aura is not just a tool; it is a declaration. It is the first piece of software that treats AI as a first-class citizen in the development process while ensuring humans retain absolute control over the logic and intent of their creations.

By bridging the gap between natural language intent and mathematical AST reality, Aura ensures that as software grows in complexity, it remains understandable, secure, and—most importantly—sovereign.

---
**Naridon, Inc. Delaware, USA**
*Building the Foundational Infrastructure for the Autonomous Agent Era.*
