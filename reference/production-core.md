# The Final Crucible: Locking the Production-Grade Core

This document addresses the final layer of architectural scrutiny. By answering these five questions, we transition the Aura Semantic Engine from a "structurally sound product" into a "production-grade core" capable of handling enterprise realities, Git mechanics, and AI unpredictability.

## 1. How do you prevent ref explosion with segmented branches?
**The Threat:** If we use `refs/aura/segments/<user>/<machine>/<epoch>`, a team of 50 developers over 2 years will generate 5,200 branches. `git fetch --all` will crawl to a halt, and GitHub will penalize the repository.
**The Retention/Rotation Strategy:** 
We do not use standard Git branches (`refs/heads/*`). We use **Git Notes and Orphaned Blob References**.
*   Instead of creating a branch for every user/epoch, the Daemon writes the micro-checkpoints as floating blobs directly into the Git object database and maintains a single, local SQLite index (`.git/aura_index.db`).
*   During a *human* `git commit`, Aura squashes the local segment of blobs into a single JSON artifact, attaches it to the human commit via a `git notes add` operation (under the namespace `refs/notes/aura`), and prunes the floating blobs. 
*   **Why this wins:** Git Notes are designed specifically for attaching metadata to commits without altering the commit hash or exploding branch counts. `git fetch origin "refs/notes/*:refs/notes/*"` pulls the data efficiently. There are zero branch explosions.

## 2. How do you avoid wrong rename inheritance during an AI "rename + refactor"?
**The Threat:** An AI renames `calculate_tax` to `compute_regional_tax` AND changes 40% of the internal logic in a single commit. A rigid 90% body-hash threshold fails. An adaptive threshold might falsely link it to a different, structurally similar function.
**The Heuristic Solution (Two-Stage Confidence):**
We move from binary inheritance to a **Confidence-Scored Soft-Link**.
1.  **Stage 1 (Fast Histogram):** Calculate a multiset histogram of AST node kinds (e.g., 4 `if_statements`, 2 `call_expressions`). Filter the pool to functions with >80% histogram overlap.
2.  **Stage 2 (Normalized Subtree):** Strip identifiers and literals. Hash the raw structural skeleton. 
3.  **The Rule:** If the match is >95%, inherit the `node_id` silently. If the match is between 70%-94%, assign a *new* `node_id` but embed a `derived_from: <old_node_id>` field in the JSON with a `confidence_score`. 
4.  **The UI Result:** When a developer looks at `compute_regional_tax` in the dashboard, it says: *"New logic block. 82% structural match to deleted block `calculate_tax`."* The human truth boundary is preserved. We do not lie to the user.

## 3. What is the performance budget for hooks vs daemon?
**The Threat:** If hooks are slow, devs use `--no-verify`. If the daemon is heavy, devs kill the process. We need hard numbers, not vibes.
**The Budgets:**
*   **The Pre-Commit Hook Budget: 50ms MAX.**
    *   *Task:* Identify staged files (2ms). Parse AST using `tree-sitter` (15ms for 5k lines). Check Gatekeeper constraints (5ms). Stage text intent (2ms). Exit. 
    *   *Rule:* No network calls. No embeddings. No deep SCC graph traversals. If the hook exceeds 50ms, it must abort the semantic tracking and allow the Git commit to proceed to save the user's workflow.
*   **The Daemon Budget: 200ms MAX (Asynchronous).**
    *   *Task:* The daemon operates entirely off the main thread. When the 50ms hook finishes, the daemon wakes up, calls the LLM API for embeddings (150ms network latency), calculates the deep Merkle-Graph (30ms), and writes the Git Note (5ms). 
    *   *Rule:* CPU utilization must never exceed 2% over a 5-second window. 

## 4. How do you pause/resume the daemon safely during Git operations?
**The Threat:** Running `git checkout main` alters 2,000 files instantly. If the `aura daemon` attempts to incrementally parse 2,000 files while Git is actively mutating them, it will corrupt the index and DOS the machine.
**The Repo-State Awareness Architecture:**
The daemon must be completely subservient to Git's locking mechanisms.
*   **The Lockfile Trap:** Before processing *any* file watcher event, the daemon checks for the existence of `.git/index.lock`, `.git/rebase-merge/`, or `.git/CHERRY_PICK_HEAD`. 
*   **The Pause:** If any of these exist, Git is mutating the repository. The daemon immediately drops all filesystem events and enters a `PAUSED` state.
*   **The Resumption:** Once the lockfiles disappear, the daemon does *not* try to process the backlog of 2,000 events. It drops the queue, performs a clean sweep of the current `HEAD`, and resumes tracking from the new baseline. 

## 5. What is the "Truth Model" in the UI?
**The Threat:** If the UI presents scraped Aider logs and deeply verified MCP intents as equal, developers will lose trust when a scraped log turns out to be a hallucination.
**The Truth Model (Provenance and Confidence):**
The Aura UI is fundamentally a dashboard of **Epistemic Certainty**. Every piece of data must display its provenance.
*   **Intent Provenance:** Intents captured via the native MCP protocol get a solid blue `[VERIFIED]` badge. Intents parsed via the `.aider.chat.history.md` scraper get a yellow `[HEURISTIC_SCRAPE]` badge.
*   **Blast Radius Confidence:** When showing the impact graph, the UI must not say "Tainted." It must say: *"Impact Candidates: 14 nodes. Traversal budget hit at depth 5."*
*   **Arbitration Audit:** If a patch was generated by the LLM, the UI marks the commit as `[AI_SYNTHESIZED]`. 

By surfacing uncertainty, the tool becomes a trusted advisor rather than a flawed oracle.
