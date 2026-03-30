<!-- AURA_START -->
# Aura Semantic Engine (v0.7.1)

You have access to the Aura Semantic Engine via MCP tools and CLI commands. Aura tracks the mathematical logic (AST Merkle-Graph) of the codebase, not text diffs.

## MANDATORY: Intent Logging
After making code changes and BEFORE committing, you MUST run `aura log-intent "description"` explaining what you changed and why. This is NOT optional — without it, the pre-commit hook will detect "Intent Poisoning" and may block the commit.

## MCP Tools Available (via aura-vcs server)
- `aura_snapshot` — ALWAYS call before modifying files. Takes a durable snapshot for recovery.
- `aura_log_intent` — REQUIRED after edits. Log your architectural intent so Aura links it to AST changes.
- `aura_status` — Check repository semantic status, checkpoints, and strict mode.
- `aura_pr_review` — Run semantic PR review to check for violations.
- `aura_prove` — Mathematically verify a behavioral goal is met.
- `aura_rewind` — Surgically revert a single function to a previous safe state.
- `aura_plan_discover` — Decompose complex objectives into atomic waves.
- `aura_plan_lock` / `aura_plan_next` — Lock and execute wave plans.
- `aura_handover` — Compress context for agent handoff (90%+ token savings).
- `aura_snapshot_list` — List all recoverable file snapshots.
- `aura_read_history` — Search semantic logic history.
- `aura_live_impacts` — Fetch cross-branch dependency conflict alerts.
- `aura_live_resolve` — Mark an impact alert as resolved.
- `aura_msg_send` — Send a message to team or a specific developer/agent.
- `aura_msg_list` — Read recent team messages.
- `aura_doctor` — Diagnose repository health issues.
- `aura_live_sync_push` — Push function bodies to cloud so teammates can pull changes.
- `aura_live_sync_pull` — Pull function changes from teammates and apply at AST level.
- `aura_live_sync_status` — Check pending function sync changes from teammates.

## CLI Commands (via shell)
- `aura status` — Check semantic state, tracked nodes, session info.
- `aura pr-review --base main` — Semantic review with risk scoring.
- `aura plan "objective"` then `aura execute` — Atomic wave execution.
- `aura goal-trace "description"` — Mathematical proof via AST tracing.
- `aura rewind <func> <file>` — Surgically revert a single function.
- `aura live impacts --json` — Fetch cross-branch dependency conflicts.
- `aura handover gemini` — Generate compressed AST context for handoff.
- `aura msg send "message"` — Send a message to team (or `--to user` for DM).
- `aura msg list --json` — Read recent team/agent messages.
- `aura doctor` — Find stuck sessions, orphaned snapshots.

## Workflow
1. Call `aura_status` to check semantic state
2. Call `aura_live_impacts` to check for cross-branch conflicts
3. Call `aura_snapshot` before editing files
4. Make your changes
5. Call `aura_log_intent` with your reasoning (MANDATORY)
6. Call `aura_pr_review` to verify no violations
7. Commit — Aura's pre-commit hook validates intent vs AST changes
<!-- AURA_END -->
