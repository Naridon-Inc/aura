# AURA: THE BRUTALLY HONEST ARCHITECTURAL TRUTH (Spec 1.0)

This document addresses the hard engineering realities of the Aura Semantic Engine (Product Version: `0.1.0-alpha`). It clarifies what is genuinely shipped, exposes the limitations of the current implementation, defines the product wedge, and cleans up the competitive positioning.

---

## 1. Reality Check: What is *Actually* Shipped Today?
**The Contradiction:** The Master Plan stated Phases 1-7 were "Complete", but the footer contained a legacy "parallelize" statement. 
**The Truth:** The footer was an artifact of an earlier sprint. However, "Complete" in the context of this 24-hour sprint means *Functional MVP Prototyped in Rust*. It does *not* mean production-ready.

**Genuinely Usable End-to-End Commands (Demoable Happy Path):**
*   ✅ `aura init`: Fully functional interactive onboarding with global credential vault.
*   ✅ `aura daemon`: Truly watches files and generates AST micro-checkpoints in the background.
*   ✅ `aura ask`: Works perfectly for semantic history retrieval (using text/Jaro-Winkler, or Gemini embeddings if key is present).
*   ✅ `aura rewind <ident>`: Functionally extracts past logic and splices it into current files (assuming the file hasn't undergone massive structural rewrites).
*   ✅ `aura gc`: Successfully prunes implicit micro-states from the Git tree.
*   ✅ `aura mcp`: A functioning stdio JSON-RPC server that connects to Cursor/Claude and logs intent.
*   ✅ `aura map`: Generates functional DOT graphs of dependencies.

**Commands that are "Simulations" or "Brittle MVPs":**
*   ⚠️ `aura verify-env`: Only runs a shallow string search for forbidden dependencies rather than deep AST traversal.
*   ⚠️ `aura arbitrate`: Hardcoded to use `gemini-2.5-pro` via `reqwest`. The test runner only assumes `pytest`. It is a brittle, happy-path MVP.
*   ⚠️ `aura sync`: Executes `git fetch` successfully, but the logic to stitch the remote JSON graphs into the local petgraph is incomplete.
*   ⚠️ `aura generate-stubs`: String-replacement based MVP. It will break on complex nested closures or multi-line signatures.

---

## 2. Unit of Truth: What exactly is a "node_id"?
**The Claim:** "Immutable Logic Identity."
**The Reality:** The current MVP implementation in `parser.rs` is **flawed for true immutability**. 
Currently, it generates the `node_id` via: `hash(kind + initial_identifier)`.
*   *Small Edits:* The `content_hash` changes, but the `node_id` stays the same. (Works correctly).
*   *Renaming:* If you rename `calculate_tax` to `compute_tax`, the current MVP generates a *new* `node_id`. It loses track.
*   *The Sound Implementation (Future Work):* To achieve true immutability, Aura must implement an AST-diffing algorithm (like GumTree). Upon a commit, it must map the new AST against the old AST. If a node has a high structural similarity (e.g., >80% body match) but a different identifier, it inherits the *old* `node_id` from the previous checkpoint. 

---

## 3. Semantic Rewind: Patching Safely
**The Question:** Are you doing AST-to-AST reconstruction or splicing original source slices?
**The Truth:** We are doing **Source Splicing** via byte-range replacement. `tree-sitter` gives us the exact byte range of the node. We extract those bytes from the old Git blob and splice them into the new file.
*   *The Danger:* If the target file has changed imports or the target function's signature type has changed, the splice will cause a compiler/runtime error.
*   *Validation:* Currently, `aura rewind` just performs the splice. It does *not* automatically run type-checks or tests afterward. This is a critical missing guardrail.

---

## 4. Merkle-Graph: "Call Graph" vs "Dependency Graph"
**The Question:** Is it an approximate blast radius or sound analysis?
**The Truth:** It is an **Approximate Syntactic Call Graph (Best-Effort)**.
Because Aura uses `tree-sitter` (which only understands syntax, not types or memory), it cannot resolve dynamic dispatch, trait implementations, or reflection. If `user.save()` is called, Aura only knows the identifier `save` was invoked; it doesn't know *which* `save` implementation it was. 
**The Promise:** Aura provides an "Approximate Blast Radius." It warns the developer of potential taint, but it is not a mathematically sound compiler graph.

---

## 5. Intent Capture: MCP vs "Forensic Scraping"
**The Product Stance:** **"We are the Unified Semantic Layer. MCP is the standard; Scrapers are the fallback for hostile agents."**
We strongly prefer MCP because it is explicit and standard. However, we maintain the scrapers (Aider logs, Cursor SQLite) as aggressive fallbacks to ensure the history is never lost if an agent is poorly configured or ignores its system prompt. The scrapers are brittle by nature, but they are a necessary evil for full coverage in today's fragmented ecosystem.

---

## 6. Real Vector RAG vs Offline AI
**The Question:** Does it require Gemini?
**The Truth:** No, but the MVP does. 
The code is written to use Gemini's `text-embedding-004` (which produces a 768-dimensional vector). 
*   *The Sovereign Weakness:* Sending intents to a cloud API inherently breaks the "100% Local Sovereign" promise.
*   *The Plan:* A production v1.0 must bundle the `candle` crate and a quantized `all-MiniLM-L6-v2` model (90MB). The `reqwest` API call is a placeholder because compiling `ort-sys` (C-bindings for ONNX) failed during this rapid sprint. 

---

## 7. Storage Model: Git Orphan Branch at Scale
**The Question:** How big does `.git` get after 10k micro-checkpoints?
**The Truth:** Git is incredibly efficient at zlib delta-compression, but 10k JSON files *will* cause index bloat and slow down `git fetch`.
*   *The Compaction Strategy:* The `aura gc` command currently prunes the files entirely. A production implementation would squash 10,000 micro-checkpoints into a single `Epoch Summary` JSON file (e.g., `summary_2026_02.json`), retaining only the major architectural shifts and the final state of the Merkle-Graph for that period, reducing 10k files to 1.

---

## 8. Autonomous Arbitrator: Guardrails
**The Reality:** This is the highest-risk feature and is currently a dangerous MVP.
*   *Threat Model:* It could hallucinate a "fix" that deletes business logic to make the compiler happy.
*   *Current Guardrail:* It runs `pytest` in the shadow branch. If tests fail, it warns the user.
*   *Missing Guardrails:* It currently auto-merges if tests pass. In a production system, it MUST propose a PR or a patch file (`.patch`) for human review. Furthermore, sending proprietary code to a cloud LLM to fix a conflict is a security risk; it must default to a local runner (Ollama) unless explicitly authorized otherwise.

---

## 9. Sovereign Vault: What is it?
**The Clarification:** The Sovereign Vault (Phase 5) is a real remote service (AWS EC2), not just local encryption.
*   *Why AWS vs True P2P?* True P2P requires developers' laptops to be online simultaneously to sync graphs. An EC2 instance acts as an always-online "Relay Server" and a central authority for RBAC enforcement.
*   *Stub Generation:* The current MVP `aura generate-stubs` only compiles. It replaces function bodies with `pass` (Python) or `unimplemented!()` (Rust). It does *not* preserve realistic mock data for unit tests. 

---

## 10. The Product Wedge (Who is the Buyer?)
**The Problem:** Trying to win on everything dilutes the message.
**The First Wedge:** **"Session unification and Semantic History (Ask/Why) for codebases."**
The primary buyer is the Lead Engineer who is terrified that junior devs are merging AI code without understanding it. Aura provides a unified RAG database that answers *"Why did the AI write this?"* long after the PR is closed. The surgical rewind and the gatekeeper are secondary retention features.

---

## 11. Competitive Truth (Positioning vs Entire)
**The Correction:** Calling Aura an "Entire Killer" was internal sprint hype. Publishing unverified claims about their architecture or fundraising is unprofessional and legally risky.
**The New Positioning:** Aura is a **"Logic Engine vs a Session Recorder."**
Entire focuses on the workflow (attaching chat transcripts to PRs). Aura focuses on the physics (hashing the AST and building a searchable RAG database). They are different tools for different philosophies. 

---

## 12. Versioning Cleanup
All references to "Master Plan v4.0" or "v3.0" have been purged from the conceptual framework.
*   **Product Semver:** `0.1.0-alpha` (The current executable).
*   **Architecture Spec:** `Spec 1.0` (This document).
*   **Roadmap:** Organized simply by `Phases 1-7`.

---
*This document supersedes all previous hype. It is the grounded, technical reality of the Aura Semantic Engine.*