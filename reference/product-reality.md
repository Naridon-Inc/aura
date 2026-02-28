# Aura: Product Reality & Human Trust Architecture

This document outlines the final architectural principles governing Performance, Human Trust, and Explainability. These are the product differentiators that separate academic prototypes from beloved developer tools.

## 1. Performance Under Real Dev Load (The Monorepo Threat)
**The Threat:** If `aura daemon` parses a 20,000-line Python file on every single `CMD+S`, it will freeze the developer's machine, causing them to uninstall the tool immediately.

**The Architecture:** 
*   **Incremental Parsing:** `tree-sitter` is explicitly designed for text editors (it powers GitHub's syntax highlighting). It supports *incremental parsing*. When a developer edits line 500, Aura does not re-parse the whole file. It passes the byte-edit-range to `tree-sitter`, which updates only that specific node in microseconds.
*   **Debouncing:** The current `notify` watcher MVP fires instantly. In production, this must be debounced by ~500ms to prevent thrashing if an agent saves 5 times in 2 seconds.
*   **Monorepo Filters:** The watcher must respect `.gitignore` and `.auraignore` (already implemented via the `ignore` filter logic in our traversal) so it never attempts to parse `node_modules/` or massive data dumps.

## 2. The Human Trust Boundary (Auto-Modify Rules)
**The Threat:** Developers despise "magic" that rewrites their code without permission. If the Autonomous Arbitrator silently changes logic, trust drops to zero.

**The Architecture (Explicit Consent):**
Aura operates on a strict **"Propose, Never Force"** doctrine.
*   **Gatekeeper:** When a deployment is blocked, it halts. It *does not* auto-rewrite the code. 
*   **Arbitrator (`aura arbitrate`):** Currently, our MVP overwrites the file. In production, it must generate a `.patch` file or a Git Branch and output: 
    > *"Aura has synthesized a resolution in branch `aura/fix-123`. Run `git diff` to review, or `git merge aura/fix-123` to accept."*
*   **The Exception:** The *only* time Aura acts without human consent is during an autonomous Sledgehammer Restore triggered by a Datadog production crash, where downtime costs $10,000/minute.

## 3. Explainability (Computer Says "Here's Why")
**The Threat:** "Deployment Simulation Failed. Exit Code 1" is a terrible developer experience.

**The Architecture (Semantic Error Reporting):**
Because Aura tracks AST logic, it can provide hyper-specific, actionable error messages. Instead of regex failures, it provides stack-trace-level clarity.

*Example Output:*
```
🛡️ Aura Deployment Gatekeeper
✗ DEPLOYMENT BLOCKED: Production Environment Violation

Reason: The file `billing.py` contains forbidden logic.
Details: The function `process_payment` (Line 42) attempts to call `sqlite3.connect`. 
Policy: Production environments require Postgres. Local SQLite connections are strictly forbidden by `production.aura.json`.

How to fix: Use `db.get_connection()` from the shared pool instead.
```
