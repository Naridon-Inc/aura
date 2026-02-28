# Aura Licensing & Distribution Strategy (Open Core Engine)

This document finalizes the licensing and packaging strategy for the Aura Semantic Engine, establishing a defensible "Open Core" model that earns developer trust while protecting enterprise monetization.

## 1. The Core Repository License (Apache 2.0)
The local engine (`aura` CLI, `tree-sitter` integration, daemon, and local semantic RAG) is published under the **Apache License, Version 2.0**.
*   **Why Apache 2.0?** It provides an explicit patent grant, ensuring enterprise compliance teams feel safe adopting the technology. It prevents patent trolling while remaining highly permissive.
*   **Trademark Protection:** The "Aura Semantic Engine" name and logo are protected by a strict Trademark Policy. Competitors may fork the Apache 2.0 code, but they cannot legally call their product "Aura" or use the branding.

## 2. The Standard Protocol (The True Moat)
Aura's greatest moat is not the code, but the **Format**. 
The JSON schema used for storing AST hashes, intents, and dependency URIs inside **Git Notes** will be published as an open standard.
*   **The Goal:** We want other tools (IDEs, CI/CD pipelines, even competitors) to read and write to the `refs/notes/aura` namespace. If Aura's JSON structure becomes the industry standard for "Semantic Git," the ecosystem gravity makes Aura indispensable. 

## 3. The Feature Tiering Matrix

**Tier 1: Free & Open (The Time Machine)**
*License: Apache 2.0*
*   `aura daemon` (Local filesystem watching & Git Notes staging).
*   AST Parsing & Node Identity Generation.
*   `aura rewind` (Local surgical logic replacement).
*   `aura ask` (Local semantic search using local LLM/embedding models).
*   MCP Protocol integration (Local IDE bridge).
*   *The Promise:* A solo developer can run Aura 100% offline, forever, without paying a dime.

**Tier 2: Team (Aura Multiplayer)**
*License: Commercial SaaS / Hosted*
*   Automated Git Notes synchronization and conflict-free aggregation.
*   Hosted web dashboard for exploring the team's shared Merkle-Graph.
*   Centralized Vector RAG (search across all team members' intents instantly without local compilation).
*   *The Promise:* Seamless collaboration without managing local SQLite indexes or complex Git ref-specs.

**Tier 3: Enterprise (The Control Plane)**
*License: Commercial / Bring-Your-Own-Cloud (BYOC)*
*   The Sovereign Vault (Managed AWS EC2 deployment).
*   Zero-Trust RBAC & Virtual Workspace (Stub) generation.
*   Cross-Repo Tracing (Dependency resolution across 500+ microservices).
*   Policy Packs (Strict Gatekeeper enforcement for SOC2/Compliance).
*   The Autonomous Arbitrator (with secure execution sandboxing).
*   *The Promise:* Absolute IP protection and architectural governance at scale.

## 4. The Storage Commitment: Git Notes
We officially commit to **Git Notes (`refs/notes/aura`)** as the long-term storage architecture. 
*   We explicitly abandon hidden branches (`refs/heads/aura/checkpoints/v1`) due to multiplayer merge collisions and CI pipeline bloat. 
*   Git Notes guarantee that semantic history remains structurally tied to immutable human commits, ensuring perfect synchronization with standard Git hosting providers (GitHub, GitLab) without requiring proprietary databases.
