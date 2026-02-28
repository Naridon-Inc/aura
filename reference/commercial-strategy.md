# Aura Commercial Strategy: The Open-Core Doctrine

To win developer mindshare while maintaining enterprise control and a path to a $100M+ valuation, Aura cannot be a closed-source SaaS (developers won't trust it with their code) and it cannot be 100% MIT Open Source (Amazon or Microsoft will fork it and sell it as a service).

The winning strategy is the **Open-Core (Source-Available) Model**, famously executed by companies like Tailscale, Sentry, and HashiCorp.

## Tier 1: Aura Core (MIT / Apache 2.0)
**The Goal:** Viral developer adoption. The Trojan Horse.
**What is included:**
*   The Rust CLI (`aura init`, `aura daemon`, `aura commit`).
*   Local AST Parsing (`tree-sitter` integration).
*   Local Neural RAG (`aura ask` using local embeddings).
*   Surgical Rewind (`aura rewind`).
*   The `aura-team-dashboard.html` (Local viewing only).

**Why Open Source the Core?**
Developers will not install a closed-source background daemon that watches every keystroke. By making the physics engine open-source, we invite security audits, build trust, and allow the community to build parsers for obscure languages (e.g., Elixir, Zig) for free. We win the developer's laptop.

## Tier 2: Aura Enterprise (Source-Available / BSL / Commercial License)
**The Goal:** Monetization and Control.
**What is included:**
*   **The Sovereign Vault:** The actual AWS EC2 deployment code, the `aura-cloud` sync backend, and the Zero-Knowledge encryption layer.
*   **Agentic RBAC & Stubs:** The `aura generate-stubs` engine that uses LLMs to create Virtual Workspaces.
*   **Cross-Repo Tracing:** The ability to map Merkle-Graphs across different microservices in an enterprise environment.
*   **The Autonomous Arbitrator:** The `aura arbitrate` pipeline for resolving multi-file architectural conflicts.
*   **SAML/SSO Integration:** For the remote team dashboard.

**The License (Business Source License - BSL):**
The code for the Enterprise features is published on GitHub. Anyone can read it. Anyone can compile it for local testing. But the license explicitly states: *You may not use this code in a production environment with more than 5 users without paying for an Aura Enterprise License. You may not offer this software as a competitive SaaS.* 
After 3 or 4 years, the BSL automatically converts to an open-source license (like Apache), ensuring the community that the code will eventually be free.

## The Go-To-Market Wedge
1.  **The Hook:** A single developer discovers `aura.vcs` on Hacker News. They run `curl -fsSL https://auravcs.com/install.sh | bash`. They use the free, open-source Semantic Time Machine locally. They love it.
2.  **The Viral Loop:** They tell their team: *"Hey, I never get Git conflicts with Cursor anymore. Just install Aura."* The whole team adopts the free tier.
3.  **The Sale:** The Engineering Manager realizes they have 50 developers generating AI code. They need Cross-Repo Tracing, SSO, and Sovereign Vaults to prevent IP leaks. They go to `auravcs.com/enterprise` and pay $30/user/month for the Enterprise License Keys. 
