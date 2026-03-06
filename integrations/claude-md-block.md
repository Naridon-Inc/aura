<!-- AURA_START -->
# Aura Semantic Engine (v0.5.0)

You have access to the Aura Semantic Engine via MCP tools. Aura tracks the mathematical logic (AST Merkle-Graph) of the codebase, not text diffs.

## MCP Tools Available
- `aura_snapshot` — ALWAYS call before modifying files. Takes a durable snapshot for recovery.
- `aura_snapshot_list` — List all recoverable file snapshots.
- `aura_read_history` — Search semantic logic history to understand past decisions.
- `aura_log_intent` — Log your architectural intent BEFORE making commits.
- `aura_pr_review` — Run semantic PR review to check for violations.
- `aura_status` — Check repository semantic status and checkpoints.

## CLI Commands (via Bash)
- `aura rewind <func> <file>` — Surgically revert a single function to a previous safe state.
- `aura pr-review --base main` — Semantic review with risk scoring (0-100).
- `aura plan "objective"` then `aura execute` — Decompose large tasks into atomic waves.
- `aura prove --goal "description"` — Mathematically verify a behavioral goal.
- `aura orchestrate run "objective" --duo` — Run Claude Code + Gemini CLI in parallel.
- `aura fix --base main` — Auto-resolve architectural violations.
- `aura handover cursor` — Generate compressed AST context (90%+ token savings).
- `aura policy add security` — Add architectural invariant checks.

## Workflow
1. Call `aura_snapshot` before editing files
2. Make your changes
3. Call `aura_log_intent` with your reasoning
4. Call `aura_pr_review` to verify no violations
5. Commit — Aura's pre-commit hook validates intent vs AST changes
<!-- AURA_END -->
