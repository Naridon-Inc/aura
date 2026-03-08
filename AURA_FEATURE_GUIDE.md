# Aura Feature Guide

> A complete reference for every Aura feature — what it does, how to use it, why it matters, and what was impossible before it existed.

---

## Table of Contents

1. [Semantic Checkpoints & Merkle-Graph](#1-semantic-checkpoints--merkle-graph)
2. [Intent Verification (Gatekeeper)](#2-intent-verification-gatekeeper)
3. [Semantic Ask (Vector Search)](#3-semantic-ask-vector-search)
4. [Surgical Rewind](#4-surgical-rewind)
5. [Session Lifecycle Tracking](#5-session-lifecycle-tracking)
6. [Turn-Level & Subagent Tracking](#6-turn-level--subagent-tracking)
7. [Cost Calculation](#7-cost-calculation)
8. [Explain (Code Provenance)](#8-explain-code-provenance)
9. [PR Review (Semantic)](#9-pr-review-semantic)
10. [Auto-Fix](#10-auto-fix)
11. [GSD Orchestrator (Plan & Execute)](#11-gsd-orchestrator-plan--execute)
12. [Handover (Context Transfer)](#12-handover-context-transfer)
13. [Plugin System](#13-plugin-system)
14. [Snapshot & Restore](#14-snapshot--restore)
15. [Session Resume (Squash-Merge Aware)](#15-session-resume-squash-merge-aware)
16. [Prove (Behavioral Verification)](#16-prove-behavioral-verification)
17. [Audit (Bypass Detection)](#17-audit-bypass-detection)
18. [Doctor (Health Diagnostics)](#18-doctor-health-diagnostics)
19. [Continuous Tracker Daemon](#19-continuous-tracker-daemon)
20. [Semantic Arbitrator (Conflict Resolution)](#20-semantic-arbitrator-conflict-resolution)
21. [RBAC Stubs (Sovereign Vault)](#21-rbac-stubs-sovereign-vault)
22. [Redaction Engine](#22-redaction-engine)
23. [MCP Server (29 Tools)](#23-mcp-server-29-tools)
24. [Multi-Agent Support](#24-multi-agent-support)
25. [OpenCode Integration](#25-opencode-integration)
26. [Hook Chaining](#26-hook-chaining)
27. [Pre-Push Sync](#27-pre-push-sync)
28. [Cloud Sync (Sovereign Vault)](#28-cloud-sync-sovereign-vault)
29. [Map (Graph Visualization)](#29-map-graph-visualization)
30. [Ecosystem Detection](#30-ecosystem-detection)
31. [Telemetry (Privacy-First)](#31-telemetry-privacy-first)

---

## 1. Semantic Checkpoints & Merkle-Graph

### What it does
Every `git commit` triggers Aura to parse all staged files into Abstract Syntax Trees (ASTs), extract every function, class, struct, and method, compute content hashes for each, and store the resulting **Merkle-Graph** as a Git note attached to the commit.

### Usage
```bash
# Automatic — happens on every git commit via hooks
git commit -m "Add billing module"

# Manual — force a checkpoint without committing
aura persist-checkpoint

# View the graph
aura status
# Output: "623 logic nodes tracked"
```

### Benefit
- **Rename-proof identity**: Renaming `calculateTotal` to `computeSum` doesn't break tracking — Aura uses structural identity (AST skeleton), not text matching.
- **Dependency edges**: Knows that `billing.process()` calls `auth.verify()`, so changes to auth are flagged as impacting billing.
- **Environment fingerprint**: Each checkpoint records a hash of your lockfiles (Cargo.lock, package-lock.json), so you can detect when the same code behaves differently due to dependency changes.

### What was impossible before
Git tracks text diffs. It has zero understanding of what a "function" is. Before Aura, there was no way to ask "which functions changed?" or "what depends on this function?" — you had to manually read diffs and mentally model dependencies. Refactoring (renames, moves) broke all traceability.

---

## 2. Intent Verification (Gatekeeper)

### What it does
Before every commit, Aura compares the developer's stated intent (commit message or `aura_log_intent`) against the actual AST changes. If the intent says "fix login bug" but the changes modify the billing module, the commit is flagged.

### Usage
```bash
# Enable strict mode (blocks misaligned commits)
aura config set strict-mode true

# Log intent before committing (MCP agents do this automatically)
# Then commit normally — Aura intercepts via pre-commit hook

# Warn mode (default) — shows warning but allows commit
aura config set strict-mode false
```

### Benefit
- **Prevents AI hallucinations from reaching production**: If an AI agent says it's "fixing auth" but silently modifies unrelated files, the commit is blocked.
- **Blast radius detection**: Shows downstream functions affected by the change.
- **Audit trail**: Every intent is logged to `.aura/intent_log.jsonl` for compliance.

### What was impossible before
There was no mechanism to verify that what a developer (or AI) *said* they changed matches what they *actually* changed. Code review catches some of this, but it's manual, slow, and misses transitive dependencies. AI agents could make sweeping unrelated changes and the commit message would simply lie.

---

## 3. Semantic Ask (Vector Search)

### What it does
Converts your natural language query into a 768-dimensional vector embedding (via Gemini API) and performs cosine similarity search against all checkpoint intent vectors in the repository's history.

### Usage
```bash
# Search by meaning, not keywords
aura ask "how does authentication work?"
aura ask "what changed in the billing module last week?"
aura ask "who refactored the session manager?"

# Show recent checkpoints (no embedding needed)
aura ask "recent"
```

### Benefit
- **Semantic, not lexical**: "login bug" matches a checkpoint about "authentication failure on expired tokens" — the words don't overlap but the meaning does.
- **Cross-agent history**: Searches across all AI agents (Claude, Gemini, Cursor, Aider) and human commits.
- **Instant archeology**: Find why code was built a specific way months after the fact.

### What was impossible before
`git log --grep` only matches exact text. You could never ask "why was this built this way?" and get an answer from version control. The reasoning behind code decisions lived only in Slack threads, PR comments, and developers' memories — all of which are ephemeral and unsearchable.

---

## 4. Surgical Rewind

### What it does
Reverts a **single function or class** to its previous state without touching the rest of the file. Uses tree-sitter byte-range precision to identify the exact boundaries of the target identifier.

### Usage
```bash
# Revert just the `processPayment` function in billing.rs
aura rewind processPayment billing.rs

# Revert with amnesia — also wipe AI chat history mentioning this function
aura rewind processPayment billing.rs --amnesia
```

### Benefit
- **Surgical precision**: `git revert` reverts an entire commit. `git checkout -- file` reverts an entire file. Aura reverts a single function.
- **Amnesia protocol**: When an AI hallucinates a bad implementation, amnesia mode injects a system override into the agent's chat history so it doesn't repeat the same mistake.

### What was impossible before
If an AI agent wrote 5 functions in one session and 1 was wrong, you had to manually identify the bad function's boundaries and hand-edit it. There was no tool that could surgically extract "just this function from the previous commit" — you'd `git diff`, find the boundaries, copy-paste. With amnesia, you'd have to manually clear the AI's context window.

---

## 5. Session Lifecycle Tracking

### What it does
Tracks every AI agent interaction as a **session** — recording which agent, which branch, which files were touched, the first prompt, token usage, and the conversation transcript.

### Usage
```bash
# View all sessions
aura sessions

# Output:
# ● 2026-03-21-40c23838 [ACTIVE] — MCP Agent on feat/billing (12 files, 3 checkpoints | 44k tokens)
#   ↳ model: claude-opus-4-6
#   ↳ prompt: "Implement the billing webhook handler"
#   ↳ subagents: Explore(done), Explore(done)
```

### Benefit
- **Full visibility**: Know exactly what every AI agent is doing in your repo at any moment.
- **Worktree isolation**: Sessions in different git worktrees don't collide.
- **Transcript preservation**: The full conversation (user prompts + AI responses) is saved, so you can replay the reasoning later.

### What was impossible before
AI agents were black boxes. You'd invoke Claude or Gemini, they'd modify files, and the only record was the git diff. There was no way to know: How many turns did the conversation take? What was the first prompt? How many tokens were consumed? What subagents were spawned? All of this was lost when the terminal session closed.

---

## 6. Turn-Level & Subagent Tracking

### What it does
Counts conversation turns (user prompts), tracks spawned subagents (e.g., Claude Code's Task tool), and surfaces all of this in `aura status` and the MCP `aura_status` tool.

### Usage
```bash
aura status
# Output:
# 📊 Active Session
#   ↳ Turns: 6
#   ↳ Subagents: 2 (Explore)
#   ↳ Tokens: 503 in / 43050 out (179 API calls)
#   ↳ Cache: 13405009 read / 493726 created
```

### Benefit
- **Conversation depth awareness**: Know how complex a task was (6 turns vs 60 turns).
- **Subagent visibility**: Claude Code spawns background agents via its Task tool — Aura tracks each one with start/end times and result summaries.
- **Cache efficiency**: See how much prompt caching is saving you.

### What was impossible before
No tool tracked the granularity of AI interactions. You knew "Claude touched 5 files" but not "it took 23 turns, spawned 3 subagents, and consumed 150k tokens doing it." This made it impossible to estimate AI costs, detect runaway agents, or compare efficiency across models.

---

## 7. Cost Calculation

### What it does
Estimates the dollar cost of each session using model-aware pricing tables. Supports Claude (Opus/Sonnet/Haiku), GPT-4/3.5, and Gemini (2.5-Pro/2.0-Flash).

### Usage
```bash
# Shown automatically in aura status
aura status
# ↳ Cost: ~$3.2363 (503 in/43050 out tokens, claude-opus-4-6)

# Also shown in aura doctor
aura doctor
# 💰 Active session cost: ~$3.2363
```

### Benefit
- **Real-time cost awareness**: Know what each AI session is costing before the monthly bill arrives.
- **Model comparison**: Switch from Opus to Sonnet and see the cost drop in real-time.
- **Cache savings**: Shows how much prompt caching is saving you.

### What was impossible before
You had to wait for your API bill to know what AI coding cost you. There was no per-session, per-model cost tracking. If one agent spent $50 on a task that should have cost $2, you'd only find out 30 days later.

---

## 8. Explain (Code Provenance)

### What it does
Traces any function back to the AI session that created or last modified it, using `git blame` → checkpoint → session → transcript correlation.

### Usage
```bash
# Who wrote this function and why?
aura explain processPayment billing.rs

# Output:
# Agent: Claude Code (session 2026-03-21-40c23838)
# Commit: 7cfe7d4e
# Files touched: billing.rs, auth.rs, models.rs
# Conversation transcript (12 entries):
#   YOU: "Implement Stripe webhook handling"
#   AI: "I'll create a processPayment function that..."
```

### Benefit
- **Code-to-conversation tracing**: Click on any function and see the full AI conversation that produced it.
- **Accountability**: Know which agent and which prompt led to each piece of code.

### What was impossible before
`git blame` shows who committed a line and when — but not *why* or *what conversation led to it*. The reasoning behind code was scattered across chat windows that were already closed. Aura creates a permanent, searchable link from code → conversation.

---

## 9. PR Review (Semantic)

### What it does
Performs a semantic code review by diffing the AST Merkle-Graph between branches, detecting layer violations (UI calling DB directly), invariant breaks, and architectural drift.

### Usage
```bash
# Review changes against main
aura pr-review --base main

# JSON output for CI integration
aura pr-review --base main --json

# Verbose mode with full node-level diff
aura pr-review --base main --verbose
```

### Benefit
- **Catches what compilers miss**: A function in `ui/` importing from `db/` is a layer violation — compilers don't care, but your architecture does.
- **Invariant checking**: Detects when a previously pure function gains side effects.
- **CI-friendly**: JSON output for automated pipeline gates.

### What was impossible before
Architectural enforcement required manual code review discipline or custom lint rules per-project. No tool could compare the semantic structure of two branches at the function level and flag violations automatically. ESLint catches syntax, but not "this controller shouldn't be calling the database directly."

---

## 10. Auto-Fix

### What it does
Takes the JSON output from `aura pr-review` and uses an AI agent (Gemini) to automatically generate fixes for detected violations.

### Usage
```bash
# Fix all violations detected against main
aura fix --base main
```

### Benefit
- **Closed-loop governance**: Detect violation → auto-fix → re-review → commit.
- **No human bottleneck**: Architectural violations are fixed immediately, not queued for code review.

### What was impossible before
When a linter found violations, a human had to manually fix each one. There was no tool that could understand architectural intent ("move this database call to the service layer") and generate the correct fix automatically.

---

## 11. GSD Orchestrator (Plan & Execute)

### What it does
The "Get Shit Done" engine breaks massive objectives into atomic XML-bounded execution waves. Uses Gemini 2.5-Pro with RAG context from the existing Merkle-Graph to prevent dependency breaks.

### Usage
```bash
# Plan a complex feature
aura plan "Implement multi-tenant billing with Stripe webhooks"

# Execute the next wave
aura execute

# Check orchestration status
aura orchestrate status
```

### Benefit
- **Massive task decomposition**: "Build a billing system" becomes 5 atomic waves, each with specific actions and verification steps.
- **RAG-aware**: The planner sees your existing AST graph, so it won't plan changes that break existing dependencies.
- **Atomic verification**: Each wave is verified before the next begins.

### What was impossible before
Complex features required manual decomposition by a senior engineer. AI agents given large tasks would often make sweeping changes that broke existing code because they didn't understand the dependency graph. GSD prevents this by feeding the agent a mathematically accurate picture of all existing dependencies before it plans.

---

## 12. Handover (Context Transfer)

### What it does
Generates a dense XML summary of the entire AST Merkle-Graph, optimized for AI token consumption. Allows context transfer between agents without losing semantic understanding.

### Usage
```bash
# Generate handover payload for Claude
aura handover claude

# Use with any agent
aura handover gemini
```

### Benefit
- **90%+ token savings**: Instead of keeping 50 files in the AI's context window, pass a single dense XML summary.
- **Agent-agnostic**: Transfer context from Gemini to Claude or vice versa without losing the semantic picture.
- **Resumable**: After clearing context, the new agent can resume with full architectural understanding.

### What was impossible before
Switching between AI agents (or restarting a session) meant losing all context. You'd have to re-explain the entire codebase, costing thousands of tokens and losing nuance. There was no standardized format for "here's everything this agent knows about the codebase."

---

## 13. Plugin System

### What it does
Trait-based extensibility with both compile-time (built-in) and runtime (dynamic `.so`/`.dylib`) plugin loading. Plugins receive lifecycle events (checkpoint, review, session start/end) and can provide custom commands.

### Usage
```toml
# .aura/plugins.toml
[plugins]
enabled = ["cost-reporter"]
custom_paths = ["~/.aura/plugins/my-custom-plugin.dylib"]
```

```bash
# Plugins are loaded automatically
aura status
# Output: 🔌 1 plugin(s) loaded: cost-reporter v1.0.0
```

### Benefit
- **Extensible without forking**: Third parties can write plugins that hook into Aura's lifecycle.
- **Runtime loading**: No recompilation needed — drop a `.dylib` in the config path.
- **Built-in plugins**: `cost-reporter` ships out of the box.

### What was impossible before
Every Git tool was monolithic. Want to add cost tracking? Fork the tool. Want to add custom reporting? Write a separate script and glue it together with shell scripts. There was no trait-based plugin system for Git semantic tooling.

---

## 14. Snapshot & Restore

### What it does
Creates safety snapshots of files on a hidden Git branch before risky operations. Independent of commits — works even with uncommitted changes.

### Usage
```bash
# Snapshot before a risky refactor
aura snapshot "Before billing rewrite"

# List snapshots
aura snapshot-list

# Restore (sledgehammer — full file restore)
aura restore <snapshot-id>
```

### Benefit
- **Pre-edit safety net**: MCP agents automatically snapshot files before editing them.
- **Commit-independent**: Works on uncommitted changes, unlike `git stash`.
- **Per-file granularity**: Restore a single file without affecting others.

### What was impossible before
`git stash` saves everything at once. `git checkout -- file` only works for committed state. There was no per-file, pre-edit snapshot system that an AI agent could invoke before making changes — so if the agent broke a file, recovery meant manually reconstructing the previous state.

---

## 15. Session Resume (Squash-Merge Aware)

### What it does
Resumes work on a branch by switching to it, finding previous sessions, and displaying condensed context. Now detects squash-merged branches — if a branch was previously merged and deleted, Aura identifies the merge and links the new session to the old one.

### Usage
```bash
aura resume feat/billing

# Output:
# ℹ Branch 'feat/billing' was previously squash-merged:
#   ↳ "Implement billing module (#42)"
#   ↳ This session will be linked to the previous merge.
#
# Found 2 previous session(s) on this branch:
#   ● 2026-03-20-abc12345 — Claude Code (12 files, 3 checkpoints)
#     ↳ "Implement Stripe webhook handling"
```

### Benefit
- **Squash-merge awareness**: When a team uses squash-merge PRs (common in GitHub Flow), the branch is deleted after merge. Aura detects this and preserves the session linkage.
- **Full context recovery**: Shows previous prompts, session summaries, and open items.

### What was impossible before
After a squash-merge, the branch is deleted and all session context is orphaned. `git log` shows a single squash commit with no link to the original development sessions. Aura maintains continuity across merge boundaries.

---

## 16. Prove (Behavioral Verification)

### What it does
Mathematically verifies that a behavioral goal is met by tracing logic paths through the AST Merkle-Graph. Uses AI-powered analysis against the actual code structure.

### Usage
```bash
# Verify a goal against the codebase
aura prove --goal "User can login with OAuth"
```

### Benefit
- **Formal-ish verification**: Not theorem proving, but AI + AST analysis to trace whether a goal is structurally achievable.
- **Goal-oriented testing**: Complements unit tests with higher-level behavioral assertions.

### What was impossible before
You could write unit tests for individual functions, but there was no tool that could take a natural language goal ("User can login with OAuth") and trace the code paths to verify it's structurally possible. This required manual architecture review.

---

## 17. Audit (Bypass Detection)

### What it does
Scans the last 50 commits for those that bypassed Aura's gatekeeper (committed with `--no-verify`), identifying unverified changes.

### Usage
```bash
aura audit

# Output:
# 🚨 UNVERIFIED COMMITS DETECTED
#   ✗ abc1234 by Developer — "quick fix" (bypassed gatekeeper)
#
# ⚠ Found 3 unverified commits out of the last 50.
```

### Benefit
- **Compliance enforcement**: In regulated environments, every commit must have semantic verification.
- **Trust-but-verify**: Even if developers bypass hooks for speed, the audit trail catches it.

### What was impossible before
There was no way to retrospectively detect which commits bypassed pre-commit hooks. Once committed, a `--no-verify` commit looked identical to a verified one in `git log`.

---

## 18. Doctor (Health Diagnostics)

### What it does
Comprehensive health check: stuck sessions, orphaned snapshots, disk usage, hook installation, shadow branch health, stale session cleanup, cost summary, and plugin status.

### Usage
```bash
aura doctor

# Output:
# ✓ No stuck sessions found.
# ✓ No orphaned snapshots.
# ✓ 59 snapshots using ~2628 KB on disk.
# ✓ Git hooks installed.
# ✓ Shadow branch healthy (1 checkpoints archived).
# 💰 Active session cost: ~$3.24
# ✓ 0 plugin(s) loaded.
# ✓ Doctor complete. 0 issue(s) found.
```

### Benefit
- **Self-healing**: Automatically fixes stuck sessions and prunes stale data.
- **Disk awareness**: Warns when snapshot storage exceeds thresholds.
- **One-command diagnostics**: Instead of manually checking 7 different subsystems.

### What was impossible before
When things went wrong with Git hooks or tracking tools, diagnosis was manual — check if hooks exist, check if branches are corrupted, check if sessions are stuck. Each subsystem required separate investigation.

---

## 19. Continuous Tracker Daemon

### What it does
A file system watcher that runs in the background, parsing modified files in real-time and creating implicit micro-checkpoints without requiring a git commit.

### Usage
```bash
# Start in a separate terminal
aura daemon

# The daemon watches for file changes and auto-tracks AST mutations
```

### Benefit
- **Real-time tracking**: Don't wait for commits — track every save.
- **Git-aware pausing**: Automatically pauses during rebase, merge, or other Git operations.
- **Implicit safety net**: Even if you never commit, the daemon has been tracking your logic changes.

### What was impossible before
Semantic tracking was commit-gated. If you wrote code for 2 hours without committing and then lost power, the semantic history was lost. The daemon provides continuous protection.

---

## 20. Semantic Arbitrator (Conflict Resolution)

### What it does
Autonomous merge conflict resolution using LLM synthesis with full AST context. Understands function boundaries and dependencies, not just text lines.

### Usage
```bash
# Resolve conflicts in a specific file
aura arbitrate src/billing.rs

# Generates .aura.patch for review (never auto-merges)
```

### Benefit
- **Context-aware merging**: Knows that your version added a parameter to `process()` and their version added error handling — merges both correctly.
- **Safe by design**: Generates a patch file for human review, never auto-applies.

### What was impossible before
`git merge` works on text lines. When two branches modify the same function differently, Git throws a conflict marker and gives up. A human must manually read both versions and synthesize. The arbitrator understands the AST structure of both versions and can intelligently merge them.

---

## 21. RBAC Stubs (Sovereign Vault)

### What it does
Generates role-based access control stubs — replacing proprietary business logic with language-appropriate stubs (Rust `unimplemented!()`, Python `pass`) while preserving the public API surface.

### Usage
```bash
# Define restricted nodes in rbac.json
# Then generate stubs
aura generate-stubs
```

### Benefit
- **Share safely with contractors**: Give them the full codebase with proprietary algorithms replaced by stubs.
- **API-preserving**: Stubs maintain the same function signatures, so the codebase still compiles.

### What was impossible before
Sharing a codebase with external contractors meant either trusting them with everything or manually redacting sensitive code file-by-file. There was no automated tool that could surgically replace business logic while preserving compile-ability.

---

## 22. Redaction Engine

### What it does
Two-pass sensitive data scrubbing: (1) regex patterns for known formats (emails, IPs, API keys with `sk-`, `ghp_`, `xoxb-`, `AIza` prefixes) and (2) Shannon entropy analysis for unknown high-entropy strings (>4.5 bits/char = likely a secret).

### Usage
```bash
# Automatic — runs on transcripts before external API calls
# Also used internally by pr-review and handover
```

### Benefit
- **Defense in depth**: Even if you accidentally paste an API key in a prompt, Aura redacts it before sending to external APIs.
- **Information-theoretic detection**: Catches secrets that don't match known patterns by analyzing their randomness.

### What was impossible before
Secret detection tools (gitleaks, trufflehog) scan committed code. None of them scan AI conversation transcripts before they're sent to external APIs. A developer could paste a secret in a prompt, and it would be sent to Claude/Gemini with no interception.

---

## 23. MCP Server (29 Tools)

### What it does
A full Model Context Protocol server exposing 29 tools over stdio JSON-RPC 2.0. Allows any MCP-compatible AI agent (Claude Desktop, Cursor, etc.) to interact with Aura programmatically.

### Key Tools
| Tool | Purpose |
|------|---------|
| `aura_status` | Repo status with session, turn, cost data |
| `aura_log_intent` | Pre-commit intent logging |
| `aura_pr_review` | Semantic code review |
| `aura_snapshot` / `aura_snapshot_list` | File safety snapshots |
| `aura_handover` | Dense context transfer |
| `aura_prove` | Behavioral goal verification |
| `aura_rewind` | Surgical function revert |
| `aura_plan_discover` / `aura_plan_lock` / `aura_plan_next` | GSD orchestration |
| `aura_session_resume` / `aura_session_summarize` | Session management |
| `aura_doctor` | Health diagnostics |
| `aura_suggest_edit` | AI-powered edit suggestions |
| `aura_gemini_skim` / `aura_gemini_read` / `aura_gemini_batch` | Multi-model AI analysis |
| `aura_context_budget` | Token usage tracking |

### Benefit
- **Any AI agent can use Aura**: Not limited to CLI — Claude Desktop, Cursor, and any MCP-compatible tool can invoke all 29 tools.
- **Standardized protocol**: JSON-RPC 2.0 with typed schemas.

### What was impossible before
AI agents could read/write files and run shell commands, but they had no semantic understanding of the repository. MCP gives them structured access to the Merkle-Graph, session state, and governance tools — turning "file-editing assistants" into "architecturally-aware collaborators."

---

## 24. Multi-Agent Support

### What it does
Tracks and manages sessions across 5+ AI agents: Claude Code, Gemini CLI, Cursor, Aider, and OpenCode. Each agent's sessions are tracked independently with agent-specific transcript parsing.

### Supported Agents
| Agent | Integration Method |
|-------|-------------------|
| Claude Code | MCP server + hooks (UserPromptSubmit, Stop, SubagentStart/Stop) |
| Gemini CLI | Global skills + project hooks |
| Cursor | MCP injection + .cursorrules |
| Aider | Chat history integration |
| OpenCode | Process detection + session bridging |

### Benefit
- **Agent-agnostic governance**: The same rules (intent verification, checkpointing) apply regardless of which AI agent you use.
- **Cross-agent history**: `aura ask` searches across all agents' sessions.

### What was impossible before
Each AI agent was its own silo. Claude's sessions were invisible to Gemini's history. There was no unified view of "what has AI done in this repo?" across agents.

---

## 25. OpenCode Integration

### What it does
Detects OpenCode via environment variables (`OPENCODE_SESSION`, `OPENCODE_PROJECT`), process scanning, or config file detection. Bridges OpenCode sessions into Aura's tracking system.

### Usage
```bash
# Automatic detection when OpenCode is running
aura status
# Output: 🔗 OpenCode detected (via env_var)

# Manual wrapper for environments without native hook support
aura wrap opencode [args...]
```

### Benefit
- **No manual setup**: Aura auto-detects OpenCode and starts tracking.
- **Wrapper fallback**: If OpenCode doesn't support hooks natively, the wrapper script provides session tracking.

---

## 26. Hook Chaining

### What it does
Detects existing hook managers (Husky, Lefthook, Overcommit, pre-commit, custom `core.hooksPath`) and chains Aura's hooks alongside them instead of overwriting.

### Usage
```bash
aura init
# Output:
# ℹ Detected external hook manager(s): Husky (npm)
# ↳ Aura will chain alongside existing hooks (non-destructive).
# ✓ Chained with: Husky (npm)
```

### Benefit
- **Non-destructive**: Existing CI/lint hooks continue to work.
- **Compatible with any hook manager**: Husky, Lefthook, Overcommit, pre-commit (Python), or custom paths.

### What was impossible before
Most Git hook tools overwrite existing hooks on installation. If you had Husky running ESLint and installed another hook tool, one would break. Aura appends instead of replacing.

---

## 27. Pre-Push Sync

### What it does
A pre-push Git hook that automatically pushes `refs/notes/aura` (semantic checkpoints) and `aura/checkpoints` (shadow branch) to the remote alongside the user's push.

### Usage
```bash
# Automatic — happens on every git push
git push origin main
# Aura silently syncs refs/notes/aura and aura/checkpoints to origin
```

### Benefit
- **Semantic metadata travels with code**: When you push code, the semantic history is pushed too.
- **Team visibility**: Other developers can run `aura ask` and see the full semantic history including your sessions.

### What was impossible before
Git notes and custom branches required manual push (`git push origin refs/notes/aura`). Developers would push code but forget to push the metadata, leading to incomplete semantic history on the remote.

---

## 28. Cloud Sync (Sovereign Vault)

### What it does
Synchronizes the Merkle-Graph to Aura Cloud for cross-repository semantic search and backup.

### Usage
```bash
# Configure cloud sync
aura config set cloud-url https://auravcs.com
aura login <token>

# Sync
aura sync
```

### Benefit
- **Cross-repo search**: Find how a pattern is used across all your organization's repositories.
- **Sovereign storage**: Your semantic metadata is yours — stored on your infrastructure.

---

## 29. Map (Graph Visualization)

### What it does
Outputs the Merkle-Graph in DOT format for visualization. Shows all tracked logic nodes (functions, classes, structs) and their dependency edges.

### Usage
```bash
# Print DOT graph to stdout
aura map

# Pipe to Graphviz for visualization
aura map | dot -Tpng -o graph.png
```

### Benefit
- **Visual architecture**: See your entire codebase's logical structure at a glance.
- **Dependency visualization**: Identify tightly coupled modules.

### What was impossible before
Dependency visualization required specialized tools per language (madge for JS, cargo-depgraph for Rust). There was no language-agnostic tool that could visualize function-level dependencies across 13 languages from a single command.

---

## 30. Ecosystem Detection

### What it does
Automatically detects the project's primary language and ecosystem (Python, Node.js, Rust) by examining manifest files. Generates an environment fingerprint by hashing lockfiles.

### Benefit
- **Reproducibility tracking**: If a test fails after a dependency update, the environment fingerprint changes — making it detectable.
- **Zero configuration**: Aura figures out your stack automatically.

---

## 31. Telemetry (Privacy-First)

### What it does
Anonymous usage analytics with multiple opt-out mechanisms. Uses a hashed machine ID (not PII). Respects `AURA_TELEMETRY_OPTOUT`, `DO_NOT_TRACK` environment variables, and the config setting.

### Usage
```bash
# Opt out via environment variable
export AURA_TELEMETRY_OPTOUT=1

# Or via config
aura config set telemetry false

# Or use the universal standard
export DO_NOT_TRACK=1
```

### Benefit
- **Privacy-first**: Three independent opt-out mechanisms.
- **Anonymous machine ID**: Hashed hostname + username — never sent in cleartext.
- **Non-blocking**: Telemetry runs in a detached background thread — never slows down commands.

### What was impossible before
Most developer tools either had no opt-out (phone home silently) or required editing config files. The `DO_NOT_TRACK` standard exists but most tools ignore it.

---

## Summary: The Aura Advantage

| Capability | Before Aura | With Aura |
|-----------|-------------|-----------|
| What changed? | Text diffs | AST-level semantic diffs across 13 languages |
| Why did it change? | Lost when terminal closed | Permanently linked via intent vectors |
| Who decided this? | Git blame (person only) | Full AI agent + session + conversation trace |
| Is the intent aligned? | Trust-based | Mathematically verified (gatekeeper) |
| Can I undo one function? | Revert entire commit | Surgical function-level rewind |
| Cross-agent visibility | Zero | Unified session tracking across 5+ agents |
| Cost tracking | Monthly API bill | Real-time per-session cost by model |
| Semantic search | `git log --grep` (exact text) | Vector embedding cosine similarity |
| Plugin extensibility | Fork the tool | Drop in a `.dylib` |
| Hook compatibility | Overwrite existing hooks | Chain alongside Husky/Lefthook/etc. |

Aura doesn't replace Git — it makes Git understand *logic* instead of just *text*.
