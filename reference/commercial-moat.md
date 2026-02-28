# Aura: The Proprietary Perimeter (Commercial Moat)

This document codifies the "Partly Closed" architecture of Aura. It defines the "Open Core" (Trojan Horse) versus the "Proprietary Perimeter" (The Monetization & IP Moat), ensuring that while we earn developer trust, a competitor cannot simply fork the project and kill our business.

## 1. The Strategy: "Open for Trust, Closed for Scale"
We acknowledge the "Vercel Model": You build a massive open-source ecosystem (Next.js) that developers love, but you maintain 100% control over the *multiplayer coordination layer* and the *enterprise governance* (Vercel Cloud).

## 2. The Open Core (Apache 2.0)
The following components are published on public GitHub. This allows for security audits, community parsers, and viral adoption.
*   **The CLI Binary (`aura`):** The local terminal interaction layer.
*   **The AST Engine (`tree-sitter` bindings):** The fundamental logic hashing.
*   **The DVR Daemon:** Local filesystem watching and Git Notes staging.
*   **Local RAG:** Local vector generation and `aura ask` search.
*   **Local Rewind:** The surgical AST node replacement logic.
*   **Standard GSD Planner:** The base XML meta-prompting framework.

## 3. The Proprietary Perimeter (Closed Source / Private)
The following components are **NOT** open source. They reside in a private repository and are served as a Managed SaaS or an Enterprise Virtual Appliance.

### A. The "Team Brain" Aggregator
While individual developers have local Git Notes, the logic for **Merging Distributed Merkle-Graphs** without conflicts is proprietary. 
*   *Why it's a moat:* If a team has 500 microservices, the cloud backend that resolves dependencies between Repo A and Repo B is a complex, high-concurrency graph database. We do not release the code for this "Global Brain."

### B. The Sovereign Vault (Control Plane)
The code we wrote for the AWS EC2 deployment, Nginx automation, and auto-provisioning is proprietary.
*   *Why it's a moat:* Setting up "Zero-Trust Stubs" for a 100-person team is a massive DevOps burden. We sell the "One-Click Deploy" and "Managed Keychain" as a service.

### C. The Advanced Arbitrator (The "Golden Prompts")
While the basic Arbitrator exists in the CLI, the **highly tuned, chain-of-thought XML protocols** and the **automated debugging loops** (which we've spent weeks perfecting) are hidden in our cloud API.
*   *Why it's a moat:* The CLI sends the code to our API; our API performs the "Advanced Reasoning" and returns the patch. A competitor can fork the CLI, but they don't have our reasoning templates or our "Fix-Pass-Fail" training data.

### D. Policy Packs & Compliance
The `production.aura.json` rules for SOC2, HIPAA, and GDPR compliance are proprietary logic.
*   *Why it's a moat:* Companies don't want to write security rules; they want to buy them. We sell "Certified Policy Packs" that only work with the Aura Cloud.

## 4. Technical Safeguards Against Forking
To prevent a competitor from simply forking the CLI and removing our cloud links, we implement **Protocol Interdependence**:

1.  **The "Key Exchange" Handshake:** The most advanced features (Cross-Repo Tracing and RBAC Stubs) require a periodic "Attestation" from our `api.auravcs.com`. If the CLI doesn't receive a cryptographically signed "Policy Token" from our server, it defaults to "Solo Mode," disabling the enterprise-level graph features.
2.  **The Metadata Shroud:** We open-source the *format* of the Git Notes, but we do not open-source the *indexer*. If a competitor wants to build a dashboard that rivals ours, they have to rewrite the entire graph-traversal engine from scratch.

## 5. Summary Table
| Feature | Open Source? | License | Role |
| :--- | :--- | :--- | :--- |
| AST Parser | ✅ Yes | Apache 2.0 | Trust |
| Local Rewind | ✅ Yes | Apache 2.0 | Value |
| GSD Planning | ✅ Yes | Apache 2.0 | Habit |
| Team Sync | ❌ No | Proprietary | Revenue |
| Cross-Repo Graph | ❌ No | Proprietary | Moat |
| Stub Synthesizer | ❌ No | Proprietary | IP Protection |
| Team Dashboard | ❌ No | Proprietary | Control |

---
**The Bottom Line:** You give the individual developer a superpower for free. You charge the company for the ability to manage that superpower at scale.
