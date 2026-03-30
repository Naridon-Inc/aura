<!-- AURA_START -->
# Aura Semantic Engine (v0.8.0)

You have access to the Aura Semantic Engine via MCP tools. Aura tracks the mathematical logic (AST Merkle-Graph) of the codebase, not text diffs.

## MANDATORY: Intent Logging
After making code changes and BEFORE committing, you MUST call `aura_log_intent` with a description of what you changed and why. This is NOT optional — without it, the pre-commit hook will detect "Intent Poisoning" and may block the commit. Every set of edits needs an intent log.

## MCP Tools Available
- `aura_snapshot` — ALWAYS call before modifying files. Takes a durable snapshot for recovery.
- `aura_log_intent` — REQUIRED after edits. Log your architectural intent so Aura links it to AST changes.
- `aura_status` — Check repository semantic status, checkpoints, strict mode, and active agents.
- `aura_pr_review` — Run semantic PR review to check for violations.
- `aura_prove` — Mathematically verify a behavioral goal is met.
- `aura_rewind` — Surgically revert a single function to a previous safe state.
- `aura_plan_discover` — Decompose complex objectives into atomic waves.
- `aura_plan_lock` / `aura_plan_next` — Lock and execute wave plans.
- `aura_handover` — Compress context for agent handoff (90%+ token savings).
- `aura_snapshot_list` — List all recoverable file snapshots.
- `aura_read_history` — Search semantic logic history to understand past decisions.
- `aura_sentinel_status` — See function-level claims, collisions, and zone ownership across agent sessions.
- `aura_sentinel_agents` — List all active agent sessions (Claude, Copilot, Gemini, Cursor, etc.) in this repo.
- `aura_sentinel_send` — Send a message to another agent session. Broadcast to all or DM a specific session.
- `aura_sentinel_inbox` — Read messages from other agent sessions. Unread messages are auto-pushed to you.
- `aura_sentinel_release` — Manually release function claims for this session.
- `aura_zone_claim` — Claim exclusive ownership of a directory/file pattern (warn or block mode).
- `aura_live_impacts` — Fetch cross-branch dependency conflict alerts (auto-pushed to you).
- `aura_live_resolve` — Mark an impact alert as resolved.
- `aura_live_sync_push` — Push function bodies to cloud so teammates can pull changes.
- `aura_live_sync_pull` — Pull function changes from teammates and apply at AST level.
- `aura_live_sync_status` — Check pending function sync changes from teammates.
- `aura_msg_send` — Send a message to team or a specific developer/agent via cloud.
- `aura_msg_list` — Read recent team messages (auto-pushed when unread).
- `aura_doctor` — Diagnose repository health issues.

## Sentinel — Multi-Agent Awareness
When you call `aura_status`, Aura automatically registers your presence and shows you other active agents. If another Claude, Copilot, Gemini, or any AI agent is working in the same repo:
- You will see them in the `aura_status` response
- You can message them with `aura_sentinel_send`
- Collisions are auto-detected when two agents touch the same function
- Unread messages are injected into every tool response — you cannot miss them

## CLI Commands (via Bash)
- `aura rewind <func> <file>` — Surgically revert a single function to a previous safe state.
- `aura pr-review --base main` — Semantic review with risk scoring (0-100).
- `aura plan "objective"` then `aura execute` — Decompose large tasks into atomic waves.
- `aura prove --goal "description"` — Mathematically verify a behavioral goal.
- `aura orchestrate run "objective" --duo` — Run Claude Code + Gemini CLI in parallel.
- `aura fix --base main` — Auto-resolve architectural violations.
- `aura msg send "message"` — Send a message to team (or `--to user` for DM).
- `aura msg list` — Read recent team/agent messages.
- `aura handover cursor` — Generate compressed AST context (90%+ token savings).
- `aura policy add security` — Add architectural invariant checks.

## Workflow
1. Call `aura_status` to check semantic state (agents, impacts, messages — all auto-pushed)
2. Call `aura_snapshot` before editing files
3. Make your changes
4. Call `aura_log_intent` with your reasoning (MANDATORY)
5. Call `aura_pr_review` to verify no violations
6. Commit — Aura's pre-commit hook validates intent vs AST changes

## Auto-Pushed Notifications
You do NOT need to poll for alerts. Aura automatically injects these into every MCP tool response:
- **Sentinel messages** — when another AI agent sends you a message
- **Sentinel collisions** — when another agent is editing the same functions as you
- **Cross-branch impact alerts** — when functions you depend on are modified/deleted on other branches
- **Unread team messages** — when a teammate sends you a message via cloud
- **Intent reminders** — when you haven't logged intent before committing
<!-- AURA_END -->
