# Aura: The Operational Doctrine & Deployment Wedge

This document defines the final operational strategy for Aura, addressing the "Success Risk" and establishing the strict guardrails required for enterprise adoption.

## 1. The Git Notes Tooling Mandate
Git Notes are the perfect architectural backbone, but they suffer from "tooling blindness." If CI/CD pipelines do not fetch them, Aura appears to lose data.

**The Solution (`aura doctor`):**
Aura must aggressively configure the host repository upon initialization and actively police its environment.
*   During `aura init`, the CLI automatically executes:
    `git config --add remote.origin.fetch "+refs/notes/*:refs/notes/*"`
    `git config notes.displayRef "refs/notes/aura"`
*   We introduce `aura doctor` (run automatically on post-commit). It checks if `notesRef` is correctly configured and pings the remote to ensure notes are successfully pushing. If not, it throws a loud, actionable warning.

## 2. The Ancestry Spaghetti Guardrail
Soft-linking derived logic nodes (Rename/Refactor) prevents false continuity, but deeply nested chains (`A -> B -> C -> D`) will eventually degrade search performance and cognitive clarity.

**The Solution (Epoch Consolidation):**
During the weekly `aura gc` compaction cycle, Aura performs a "Lineage Flattening." If node `A` has evolved into `D` over 10 consecutive derivations with high confidence, Aura permanently updates the database to treat `D` as the canonical continuation of `A`, severing the intermediate soft-links and replacing them with a single `canonical_root` pointer.

## 3. Brutal Performance Enforcement (The Kill Switch)
If an AI agent dumps a 10,000-line minified JSON or raw data array into a `.py` file, `tree-sitter` might stall, causing the pre-commit hook to hang and infuriating the developer.

**The Solution (The 50ms Hard Timeout):**
The parsing logic must run inside a strict `tokio::time::timeout`. 
```rust
if let Err(_) = timeout(Duration::from_millis(50), parser.parse_file(...)).await {
    log::warn!("AST parsing exceeded 50ms budget. Aborting semantic tracking for this commit to preserve workflow.");
    return Ok(()); // Fails open. Never block the human.
}
```

## 4. The Product Wedge (The "One Core Flow")
The most dangerous thing we can do is sell "7 AI Enterprise Features." It causes cognitive overload. The user will turn everything on, get confused, and uninstall.

**The Strategy:**
Aura is marketed, positioned, and sold on ONE core workflow. Everything else is a dormant, silent background process until an enterprise explicitly activates it.

**The Pitch:** "Aura is a Semantic Time Machine for AI-generated code."
**The Flow:**
1.  *AI breaks production.*
2.  Developer runs `aura ask "Why did the AI change the auth logic?"`
3.  Aura returns the exact prompt, the verified intent, and the specific function.
4.  Developer runs `aura rewind secure_login` to instantly revert that specific logic block without merge conflicts.

*The Gatekeeper, the Vault, and the Arbitrator are not mentioned until the team upgrades to the Enterprise tier. They are retention mechanics, not acquisition wedges.*

---
**Status:** The system is philosophically aligned, mathematically bounded, and ready for market deployment.
