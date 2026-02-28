# AURA: THE MASTER PLAN (Version 4.0)
## The Ultimate AI-Native Semantic Infrastructure

This document outlines the complete architectural roadmap for evolving Aura from a semantic version control prototype into the definitive, undisputed operating system for Agentic Software Engineering. It encompasses every stage from local code tracking to production deployment orchestration.

---

### PHASE 1: THE FOUNDATION (The "Deeper State")
*Status: Complete*

1.  **Semantic AST Parsing**
    *   Replaced line-based text diffing with mathematical Abstract Syntax Tree (AST) hashing using `tree-sitter`.
    *   Tracks logic block changes (functions, classes, structs) independently of formatting.
2.  **Git-Native Storage Architecture**
    *   Bypassed standalone local databases to use standard Git infrastructure.
    *   Created the hidden `aura/checkpoints/v1` branch to store JSON payloads of semantic states.
    *   Implemented `Aura-Checkpoint: <uuid>` Git Trailers to cryptographically link human commits to AI intent.
3.  **The DVR (Continuous Tracker)**
    *   Built a background OS-level file watcher (`notify` crate).
    *   Automatically hashes ASTs and stages micro-checkpoints on every file save, decoupled from manual Git commits.
4.  **Surgical Semantic Rewind**
    *   Created `aura rewind <identifier>`, allowing the extraction and restoration of isolated past AST nodes into current files without merge conflicts.
5.  **Hybrid Sledgehammer Restore**
    *   Created `aura snapshot` and `aura restore` using Git stashing and hard resets to provide project-wide safety nets against catastrophic AI hallucinations.

---

### PHASE 2: CONTEXT & COLLABORATION
*Status: Complete*

6.  **Forensic Context Scrapers**
    *   Built aggressive local filesystem scanners to steal intent from oblivious AI agents.
    *   Integrated SQLite querying to extract internal chat logs from Cursor (`state.vscdb`).
    *   Integrated Markdown parsing to extract history from Aider (`.aider.chat.history.md`).
7.  **The MCP Native Protocol**
    *   Transitioned Aura from a "scraper" to a First-Class API using the Model Context Protocol (MCP).
    *   Exposed `aura_read_history` and `aura_log_intent` tools over a JSON-RPC stdio server for native integration with Claude Desktop, Cursor, and Zed.
8.  **True Vector Logic Search (Semantic RAG)**
    *   Integrated the Gemini Embedding API to generate 768-dimensional mathematical vectors representing AI intent.
    *   Implemented Cosine Similarity scoring in `aura ask` to allow natural language queries of the codebase's history.
9.  **Multi-Agent Handover**
    *   Created `aura handover <agent>` to synthesize the Semantic RAG database into dense, token-optimized XML context blocks.
    *   Enables agents (e.g., Aider) to pass their exact architectural intent directly into the prompt of another agent (e.g., Cursor).
10. **Zero-Trust GitHub Team Dashboard**
    *   Built a standalone React SPA (`aura-team-dashboard.html`) powered by Tailwind CSS.
    *   Uses the GitHub REST API to fetch and visualize the `aura/checkpoints/v1` branch directly in the browser, providing enterprise-grade collaboration with 100% data privacy.

---

### PHASE 3: THE GLOBAL BRAIN (Cross-Repo & Security)
*Status: Complete*

11. **The Logic Merkle-Graph (`petgraph`)**
    *   *Status: Implemented.* AST parser extracts `dependencies` (function calls). `aura map` renders DOT graphs. Upgraded the engine to actively traverse the graph during commits, implementing Proactive Blast Radius Detection.
    *   *Goal:* If a core module is modified, automatically flag downstream functions as "Tainted".
12. **Cross-Repo Tracing (Dependency URIs)**
    *   *Status: Implemented.* Added `aura sync` command to fetch remote metadata. Established URI format (`global://module/api`) within the AST parser to resolve external dependencies.
    *   *Goal:* Query the semantic intent of upstream microservices.
13. **The Semantic Sentinel (Secret & Security Scanning)**
    *   *Status: Implemented.* AST parser actively scans for high-entropy secrets and halts commits.
    *   *Goal:* Autonomously rewrite the node to use environment variables (`os.getenv()`), shifting the secret to `.env`.
14. **Environment Fingerprinting**
    *   *Status: Implemented.* `capture_env_fingerprint` hashes the local environment and embeds it in the Checkpoint JSON.
    *   *Goal:* Eliminate "It works on my machine" errors.

---

### PHASE 4: PRODUCTION ORCHESTRATION (The Gatekeeper)
*Status: Complete*

15. **Environment-Aware ASTs (E-AST)**
    *   *Status: Implemented.* Taught Aura the concept of Deployment Targets. `aura verify-env` enforces Semantic Forks.
    *   *Goal:* Allow agents to write environment-specific AST logic.
16. **Pre-Flight Deployment Simulations**
    *   *Status: Implemented.* Built `aura verify-env <target>`. Projects the new AST against the constraints of the target environment.
    *   *Goal:* Halt CI/CD pipelines if the AI's logic will crash the target environment.
17. **Rollback to Safe Intent (Webhooks)**
    *   *Status: Implemented.* Added a `POST /api/webhook/rollback` endpoint to the local web dashboard that executes an autonomous `git reset --hard` to a specified snapshot ID when triggered by Datadog/Sentry alerts.
    *   *Goal:* Restore safety without taking the application offline.
18. **The Autonomous Arbitrator (Cost-Controlled Conflict Resolution)**
    *   *Status: Implemented.* Created `aura arbitrate`. Spawns an isolated shadow branch, parses the broken code, and invokes an LLM API (Gemini Pro) to autonomously synthesize a patch that satisfies the logic constraints, then runs tests to verify the fix.
    *   *Goal:* Resolve semantic merge conflicts automatically.

---

### PHASE 5: THE SOVEREIGN VAULT (Zero-Trust Logic RBAC)
*Status: Complete*

19. **The Sovereign Peer (AWS EC2)**
    *   *Status: Implemented.* Launched a hardened ARM64 EC2 instance (`AuraSovereignVault`). Acts as the primary P2P middle-layer server.
    *   *Goal:* Serve as the trusted authority for logic-node permissions.
20. **Zero-Knowledge Encryption Layer**
    *   *Status: Implemented.* Integrated AES-256-GCM encryption natively.
    *   *Goal:* The remote (GitHub) only sees encrypted blobs.
21. **Surgical RBAC (Logic-Node Permissions)**
    *   *Status: Implemented.* Established "Logic Node Keys". The Sovereign Vault rejects logic patches to restricted nodes if they aren't signed by an authorized key.
    *   *Goal:* Restrict developer access to specific functions or modules.
22. **The "Stub & Proxy" Build Engine**
    *   *Status: Implemented.* Added `aura generate-stubs`. Generates Virtual Workspaces by replacing restricted code with compiler-safe stubs.
    *   *Goal:* Allow restricted developers to work without possessing the full source code.
23. **Sovereign Web Dashboard (Remote)**
    *   *Status: Implemented.* Deployed the Aura Dashboard (`src/server.rs`) to the EC2 instance with encrypted tunnel access.
    *   *Goal:* Allow the team to visualize the global Merkle-Graph securely.

---

### PHASE 6: RESILIENCE & HARDENING (The "Seatbelt" Layer)
*Status: Complete*

24. **Asynchronous Neural Pipeline**
    *   *Status: Implemented.* The Git hook now exits instantly after staging text intent. The background `tokio` daemon watches the `.git/aura_queue/` and performs asynchronous "Ghost Patches" to append the 768-dimensional neural vector later.
    *   *Goal:* Fix the "Offline-Commit" issue. Decouple Gemini embedding generation from the pre-commit hook.
25. **Semantic Compaction (Garbage Collection)**
    *   *Status: Implemented.* The `aura gc` command actively rewrites the hidden Git tree to prune high-frequency "Implicit Auto-Save" nodes lacking explicit vectors, preventing repo bloat while maintaining major architectural checkpoints.
    *   *Goal:* Prevent "Repo Bloat" from AST JSON and Vector storage.
26. **The MCP Protocol Shift**
    *   *Status: Implemented.* Deprecated the fragile SQLite and Markdown forensic scrapers. Aura now relies strictly on the `.gemini.intent` native API payload provided by the local MCP server, ensuring it remains unbreakable regardless of IDE updates.
    *   *Goal:* Eliminate "Forensic Fragility". Stop relying on Cursor/Aider's private SQLite schemas.
27. **Multi-Sig Vault Recovery**
    *   *Status: Implemented.* Added `aura secure-init` to generate a 2-of-3 secret sharing scheme for the vault key.
    *   *Goal:* Prevent catastrophic data loss from a single lost `AuraVaultKey`.
28. **Intent Verification (Logic Alignment)**
    *   *Status: Implemented.* Added heuristic intent verification to the Git commit hook. Aura cross-references the natural language intent string against the exact AST node identifiers modified. If an agent tries to log a benign message for an unrelated code change, the commit is halted to prevent Intent Poisoning.
    *   *Goal:* Prevent "Intent Poisoning" where an agent logs a safe description for malicious code.
29. **Local API Hardening (CSRF/CORS Protection)**
    *   *Status: Implemented.* The local axum web server is now strictly bound to `127.0.0.1` instead of `0.0.0.0`, rendering network-based background scanning impossible.
    *   *Goal:* Prevent third-party websites from exfiltrating logic history via the local dashboard API.
30. **Neural Intent Redaction**
    *   *Status: Implemented.* The `src/redact.rs` module uses Regex and Shannon Entropy mathematics to scrub PII and secrets, replacing them with syntactically correct tokens (e.g., `[REDACTED_IP]`) before calling cloud APIs.
    *   *Goal:* Prevent proprietary secrets or PII in reasoning logs from being sent to external Embedding APIs (e.g., Gemini).
31. **Secure Key Exchange (Anti-Procfs Leak)**
    *   *Status: Implemented.* Transitioned to a Unix Domain Socket for passing master keys between the CLI and the Sovereign Vault (activated via `aura secure-init`).
    *   *Goal:* Prevent local malware from stealing the `AURA_VAULT_KEY` via `/proc/<pid>/environ`.
32. **Immutable Logic Identity**
    *   *Status: Implemented.* Deterministic hashing of node type and initial identifier generates persistent `node_id`s, allowing logic tracking regardless of future renaming.
    *   *Goal:* Prevent "Semantic Phishing" (hijacking an existing function's name with malicious logic).

---

### PHASE 7: UNIVERSAL OS SUPPORT (The "Everywhere" Layer)
*Status: Complete*

33. **Platform-Agnostic Hook Installation**
    *   *Status: Implemented.* Removed hardcoded `std::os::unix` dependencies and implemented `#[cfg(unix)]` conditional compilation to allow Windows builds to succeed.
    *   *Goal:* Fix the Windows compilation errors.
34. **Portable Hook Execution**
    *   *Status: Implemented.* Refactored Git hooks to use `std::env::current_exe()` to dynamically resolve the absolute path to the Aura binary, replacing hardcoded `~/.cargo/bin/aura` paths that break in non-standard or Windows shells.
    *   *Goal:* Support non-POSIX environments.
35. **Environment Resolver**
    *   *Status: Implemented.* The `capture_env_fingerprint` function now dynamically uses `python` on Windows and `python3` on POSIX systems to invoke the correct executable for tracking pip environments.
    *   *Goal:* Fix broken CLI calls (e.g., `python3` vs `python`).

---

**Execution Strategy:** We have completed Phases 1 and 2 and established the foundation for Phase 5. We will now parallelize the implementation of the Cross-Repo Merkle-Graph (Phase 3), the Resilience & Hardening (Phase 6), and Universal OS Support (Phase 7).
