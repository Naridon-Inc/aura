# The Semantic Time Machine

## The Core Concept
For 50 years, Version Control Systems (VCS) like Git have tracked changes using line-by-line text diffs. This was perfect for humans typing sequentially. 

However, in the era of Autonomous AI Agents (Cursor, Aider, Claude Code), code is generated non-linearly. An AI might write 4,000 lines, alter a database schema, and update 14 files in 10 seconds. If the AI hallucinates on minute 12, a human cannot simply `git revert`—the text diffs will result in catastrophic merge conflicts.

**Aura is the Semantic Time Machine.** It abandons text diffs. Instead, it compiles your codebase into an Abstract Syntax Tree (AST) locally and hashes the *mathematical logic* of functions and classes.

## The Problem It Solves
When an AI breaks production, standard Git cannot easily untangle the web of changes. 
Aura allows developers to ask: *"Why did the AI change the authentication logic?"*
Aura retrieves the exact cryptographic intent from the AI, and then allows the developer to execute a **Surgical Rewind**—replacing just that specific broken logic block without touching the surrounding 4,000 lines of valid code.

## The Architecture
Aura is built as a "Parasitic Gatekeeper" on top of standard Git. It does not replace your Git hosting (GitHub/GitLab). It runs silently in the background (via a `tokio` daemon) and intercepts standard `git commit` actions.

Instead of creating "Ref Explosions" by generating thousands of hidden branches, Aura stores its semantic checkpoints (JSON AST arrays) directly into **Git Notes** (`refs/notes/aura`). This allows for invisible, conflict-free synchronization across large enterprise teams.
