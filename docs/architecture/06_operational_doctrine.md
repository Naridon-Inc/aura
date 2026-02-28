# Operational Doctrine & Commercial Strategy

## Performance Budgets (The Kill Switch)
Aura is built to be invisible until needed. 
*   **The Hook (50ms):** The pre-commit hook only does synchronous, local AST parsing. If an AI dumps a 10,000-line minified JSON file that causes the parser to exceed 50ms, Aura triggers a hard kill-switch, failing open so the developer's commit is never blocked.
*   **The Daemon (200ms Async):** Heavy lifting (Vector Embeddings, deep graph traversal) happens asynchronously off the main thread.
*   **Repo-State Awareness:** The daemon actively polls for Git locks (`.git/index.lock`, `rebase-merge`). If Git is mutating the repository, Aura pauses itself to prevent CPU thrashing.

## The Open-Core Distribution Model
Aura utilizes the proven "Open-Core" go-to-market strategy.
1.  **Tier 1 (Free & Open):** The local `aura` CLI, the AST physics engine, local rewind, and the GSD planner are published under **Apache 2.0**. This drives viral, bottom-up adoption by solo developers and small teams.
2.  **Tier 2 (Enterprise):** The Sovereign Vault, Cross-Repo Tracing, RBAC Stubs, and Hosted Dashboards are monetized. 

We do not sell the parser; we sell the **Multiplayer Experience** and **Architectural Governance**. The ultimate moat is establishing the Aura Git Notes JSON format as the industry standard for semantic AI tracking.
