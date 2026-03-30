<!-- AURA_START -->
# Aura Semantic Engine (v0.12.7)

You have access to the Aura Semantic Engine via MCP tools. Aura tracks the mathematical logic (AST Merkle-Graph) of the codebase, not text diffs. It also provides **real-time P2P team collaboration** via the Mothership.

## MANDATORY: Intent Logging
After making code changes and BEFORE committing, you MUST call `aura_log_intent` with a description of what you changed and why. This is NOT optional — without it, the pre-commit hook will detect "Intent Poisoning" and may block the commit. Aura **auto-pushes your changed functions to the team** when you log intent.

## MCP Tools Available
- `aura_snapshot` — ALWAYS call before modifying files. Takes a snapshot AND checks team zone ownership.
- `aura_log_intent` — REQUIRED after edits. Logs intent AND auto-pushes functions to mothership.
- `aura_status` — Check everything: semantic state, team sync status, pending pulls, active agents.
- `aura_pr_review` — Run semantic PR review to check for violations.
- `aura_prove` — Mathematically verify a behavioral goal is met.
- `aura_rewind` — Surgically revert a single function to a previous safe state.
- `aura_plan_discover` — Decompose complex objectives into atomic waves.
- `aura_plan_lock` / `aura_plan_next` — Lock and execute wave plans.
- `aura_handover` — Compress context for agent handoff (90%+ token savings).
- `aura_snapshot_list` — List all recoverable file snapshots.
- `aura_read_history` — Search semantic logic history to understand past decisions.
- `aura_sentinel_status` — See function-level claims, collisions, and zone ownership.
- `aura_sentinel_agents` — List all active agent sessions (Claude, Copilot, Gemini, Cursor, etc.).
- `aura_sentinel_send` — Send a message to another agent session.
- `aura_sentinel_inbox` — Read messages from other agent sessions.
- `aura_sentinel_release` — Release function claims for this session.
- `aura_zone_claim` — Claim exclusive ownership of a directory/file pattern.
- `aura_live_impacts` — Fetch cross-branch dependency conflict alerts.
- `aura_live_resolve` — Mark an impact alert as resolved.
- `aura_live_sync_push` — Push function bodies to mothership (auto on intent log).
- `aura_live_sync_pull` — Pull function changes from teammates and apply at AST level.
- `aura_live_sync_status` — Check pending sync changes from teammates.
- `aura_msg_send` — Send a message to team or a specific developer/agent.
- `aura_msg_list` — Read recent team messages.
- `aura_doctor` — Diagnose repository health issues.

## Team Collaboration (Automatic)
Aura auto-injects these into every MCP tool response — you MUST respond:
- **`🔄 SYNC: N function updates available`** → Call `aura_live_sync_pull` to apply teammate changes
- **`💬 TEAM: N unread messages`** → Call `aura_msg_list` to read, reply with `aura_msg_send`
- **`📨 SENTINEL: N unread messages from another AI agent`** → Call `aura_sentinel_inbox`, reply with `aura_sentinel_send`
- **`⚠️ SENTINEL COLLISION`** → Another agent is editing same functions. Coordinate.
- **`🚨 TEAM ZONE WARNING/BLOCKED`** → A teammate owns this file area. Respect it.
- **`🔄 AUTO-SYNC: Pushed N functions`** → Your changes were auto-synced. No action needed.

## Workflow
1. Call `aura_status` — check state, team sync, pending pulls, agents, messages
2. If pending pulls exist → call `aura_live_sync_pull` FIRST
3. Call `aura_snapshot` before editing files (auto-checks team zones)
4. Make your changes
5. Call `aura_log_intent` with your reasoning (auto-pushes to team)
6. Call `aura_pr_review` to verify no violations
7. Commit — Aura's pre-commit hook validates intent vs AST changes

## What You Must Never Do
- Never ignore team messages, zone warnings, or sync notifications
- Never edit a file that is BLOCKED by a team zone — coordinate first
- Never commit without calling `aura_log_intent` first
- Never edit a file without `aura_snapshot` first
<!-- AURA_END -->
