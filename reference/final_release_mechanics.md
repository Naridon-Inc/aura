# Aura v0.1.0-alpha: Final Release Mechanics

This document outlines the final architectural polishes implemented during the terminal phase of the v0.1.0-alpha sprint. These features transform Aura from an aggressive security prototype into a highly configurable, developer-friendly enterprise tool.

## 1. The Global Configuration Plane (`aura config`)
To solve friction around hardcoded security behaviors, we implemented a native configuration menu. The settings are stored securely in the host OS's global application data directory (e.g., `~/.config/AuraLabs/Aura/credentials.json`), ensuring preferences persist across all local repositories.

### Toggle 1: Gatekeeper Strict Mode
*   **The Problem:** Hard-blocking a commit due to a forbidden dependency (e.g., using `sqlite3` in production) causes "uninstall moments" for developers rushing to ship hotfixes.
*   **The Solution:** Aura's Deployment Gatekeeper (`verify-env`) now defaults to **Warn-Only Mode**. It prints the violation and its blast radius but allows the `git commit` to proceed. 
*   **The Config:** Teams requiring absolute architectural enforcement can run `aura config` and toggle `Strict Mode: ON`, which reactivates the hard Git block (`exit 1`).

### Toggle 2: The Sovereign Embeddings Engine
*   **The Problem:** The MVP generated vector embeddings for the Semantic RAG by sending the scrubbed intent to the Gemini API (`text-embedding-004`). Regulated industries (defense, healthcare) cannot transmit any metadata off-device.
*   **The Solution:** Added a toggle in `aura config` to switch the Embeddings Engine from **Cloud (Gemini)** to **Local (Offline)**. When engaged, Aura respects the true sovereign boundary, ensuring zero data leaves the developer's machine.

## 2. Advanced Intent Diagnostics (Proactive UX)
*   **The Problem:** The Semantic Sentinel previously threw a generic "Intent Poisoning Detected" error when the AI's textual intent failed to mathematically align with the AST nodes modified. This left the AI (or human) guessing what Aura wanted.
*   **The Solution:** The error handler was rewritten to dump the precise AST context into the terminal. It explicitly lists the missing node identifiers (`[UserAuth, get_total]`) and provides a formatted string suggestion to resolve the error instantly.

## 3. High-Magic Gemini CLI Integration
*   **The Problem:** Manual hook configuration for AI agents is brittle.
*   **The Solution:** `aura init` now autonomously scaffolds the `.gemini/settings.json` and `.gemini/hooks/` architecture. It utilizes the strict Gemini CLI `SessionStart` and `AfterAgent` JSON-RPC protocols to inject a native "Powered by Aura" status header and silently capture intent without user intervention.

---
*These modifications satisfy the "Crusty Senior Engineer" requirements: The tool defaults to non-blocking, explains its reasoning proactively, and offers an offline-only security posture.*
