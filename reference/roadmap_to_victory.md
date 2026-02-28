# Roadmap to Victory: Upgrading Aura to Production Grade

This document outlines the specific engineering sprints required to upgrade the five "shallow" MVP components of Aura into robust, enterprise-grade systems.

## Sprint 1: Dynamic Language Agnosticism
**Objective:** Fix hardcoded Python assumptions and "Anonymous" AST extraction flaws.
*   **1.1. Ecosystem Detection:** Write a module (`src/ecosystem.rs`) that scans the working directory for manifest files (`package.json`, `Cargo.toml`, `requirements.txt`).
*   **1.2. Dynamic Fingerprinting:** Update `capture_env_fingerprint()` to execute the correct package manager (`npm list`, `cargo tree`, `pip freeze`) based on the detected ecosystem.
*   **1.3. Advanced AST Identifiers:** Expand `parser.rs` to handle variable declarations. If `tree-sitter` encounters an anonymous arrow function assigned to a `const` or `let`, it must traverse up the AST to extract the variable name as the `identifier`.

## Sprint 2: Safe Semantic Compaction (Git Rebase)
**Objective:** Fix the destructive `aura gc` command so it doesn't break multiplayer `git pull`.
*   **2.1. Git Rebase Implementation:** Instead of creating a new orphaned root commit, update `src/checkpoint.rs` to use `git2` to perform an interactive rebase programmatically. 
*   **2.2. The "Epoch" Node:** Instead of just deleting daemon micro-states, squash them together. Combine their `ast_nodes` arrays and summarize their text intents into a single "Epoch Summary" checkpoint, preserving the continuity of the Merkle-Graph without the file bloat.

## Sprint 3: The Context Engine (Arbitrator Upgrade)
**Objective:** Give the LLM Arbitrator the massive context required to solve real merge conflicts.
*   **3.1. 3-Way AST Diffing:** When a conflict occurs, extract three ASTs: Base (the original file), Head (your changes), and Merge (the incoming changes).
*   **3.2. Test Runner Integration:** If a test fails, capture the `stderr` stack trace.
*   **3.3. XML Prompt Synthesis:** Combine the 3-Way AST, the test trace, and the RAG intents from both developers into a massive, highly structured XML payload before sending it to the Gemini/Ollama API.

## Sprint 4: True Symbol Resolution (LSP Integration)
**Objective:** Replace "fake" dot-notation `DependencyURIs` with actual cross-repo links.
*   **4.1. LSP Spawning:** Integrate the `tower-lsp` or similar crate. When Aura parses a file, it spins up the background language server (`rust-analyzer`, `tsserver`).
*   **4.2. Go-To-Definition Mapping:** When `tree-sitter` finds a `call_expression`, Aura asks the LSP for the exact file path and line number where that symbol is defined. If it resolves to a different repository, Aura maps the true `DependencyUri`.

---
*All 4 Sprints are now implemented. Aura v1.0 is finalized.*
