# Aura: The Dual-Face Architecture (SaaS + Local)

To dominate the market, Aura cannot be *just* a local CLI or *just* a cloud SaaS. It must be both, seamlessly interacting. This document outlines the architecture for the "Dual-Face" deployment model.

## 1. The Local Face (Aura Core)
The Rust engine we have built so far. It acts as the "Edge Node" in the network.
*   **Target Audience:** Solo developers, open-source hackers, security-obsessed teams.
*   **Features:** AST parsing, local SQLite RAG, continuous background DVR, surgical rewinds, local web dashboard (`localhost:8090`).
*   **Business Model:** 100% Free and Open Source.

## 2. The SaaS Face (Aura Cloud)
A centralized cloud platform that provides enterprise features, cross-repo syncing, and managed AI compute.
*   **Target Audience:** Enterprise engineering teams, engineering managers.
*   **Features:** Cross-repo Merkle graphs, Sovereign Vault (Logic RBAC), cloud-hosted Autonomous Arbitrator, web-based code review dashboard.
*   **Business Model:** $20/user/month or Enterprise Contracts.

## 3. The Synchronization Protocol (The Bridge)
How does the Local Face talk to the SaaS Face?
*   **The Command:** `aura login`
*   **The Mechanism:** When a user logs in, the local Aura Daemon establishes a secure WebSocket connection (or standard REST API polling) to `api.aura.vcs`.
*   **Data Flow:**
    *   *Upstream:* The local daemon asynchronously pushes the `CheckpointData` JSONs (containing the AST hashes and scrubbed intents) to the cloud.
    *   *Downstream:* The local daemon fetches `DependencyURIs` from the cloud to understand if an external microservice (owned by another team) has changed.

## 4. Why This Wins
1.  **Zero Lock-In:** If a team decides to stop paying for the SaaS, their codebase doesn't break. They still have the Local CLI and the Git-native hidden branches.
2.  **Trojan Horse Growth:** Developers use the free Local CLI because it's the best tool for managing AI agents. Once the team reaches 5 developers, they naturally upgrade to the SaaS to get the Cross-Repo graphs.
3.  **Compute Offloading:** Running local LLMs for the Autonomous Arbitrator requires a powerful GPU. By offering the SaaS, Aura Cloud can run massive models (like Gemini 1.5 Pro) on behalf of the developer to resolve complex merge conflicts instantly.
