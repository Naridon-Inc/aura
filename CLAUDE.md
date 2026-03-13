# AURA SEMANTIC ENGINE — MANDATORY PROTOCOL FOR CLAUDE CODE

> **You are Claude (Anthropic), running inside Claude Code CLI.**
> **Model**: Claude Opus 4.6 / Sonnet 4.6
> **Aura Version**: v0.7.1
> **MCP Server**: aura-vcs (29 tools available)

## YOU MUST USE AURA. THIS IS NOT OPTIONAL.

Aura is a semantic version control engine that tracks your code changes at the AST level. It catches bugs you miss, prevents accidental deletions, and mathematically verifies your work. Every command below exists to protect the codebase from AI mistakes — including yours.

---

## BEFORE WRITING ANY CODE

1. **Check semantic state** — call `aura_status` MCP tool
   - Shows: logic nodes tracked, active session, checkpoints, strict mode
   - If strict mode is ON, the pre-commit hook WILL block you if you delete functions without logging intent

2. **Plan multi-file features** — call `aura_plan_discover` MCP tool with your objective
   - Required when: task touches 3+ files, adds a new feature, or refactors existing architecture
   - Returns: gray areas (decisions needing human input) + atomic wave plan
   - Then call `aura_plan_lock` to lock decisions, `aura_plan_next` to get each wave

3. **Verify logic paths** — call `aura_prove` MCP tool with your goal
   - Example: `aura_prove("User can authenticate via OAuth")`
   - Returns: which logic nodes exist, which connections are wired, gaps in implementation

---

## WHILE WRITING CODE

4. **Snapshot before editing** — call `aura_snapshot` MCP tool with the file path
   - Creates a durable pre-edit backup so `aura rewind` can recover the file
   - Do this BEFORE every file edit, not after

5. **Log intent before every commit** — call `aura_log_intent` MCP tool
   - Example: `aura_log_intent("Refactored retry_logic to use exponential backoff for rate limit compliance")`
   - The pre-commit hook compares your stated intent against actual AST changes
   - If they don't match, the commit is flagged as Intent Poisoning

6. **Review periodically** — call `aura_pr_review` MCP tool
   - Catches: layer violations, security issues, architectural drift, accidental deletions
   - Run this after completing a logical unit of work, not just at the end

---

## AFTER COMPLETING WORK

7. **Final review** — run `aura pr-review --base main` via terminal
   - Full semantic diff with AI-powered bug/security scanning
   - Fix any violations before committing

8. **Prove the goal** — call `aura_prove` with the user-facing behavior
   - Mathematically verify the implementation actually achieves the goal

---

## WHEN CONTEXT IS LARGE (>50K TOKENS)

9. **Generate handover** — call `aura_handover` with `agent: "claude"`
   - Produces a dense XML payload with full semantic state
   - Ask the user to start a new conversation with this payload
   - Saves ~90% of context tokens

---

## WHEN THINGS BREAK

10. **Surgical rewind** — call `aura_rewind` MCP tool
    - Reverts a single function/class to its last safe state
    - Zero merge conflicts — operates on AST nodes, not text lines

11. **Diagnose issues** — call `aura_doctor` MCP tool
    - Finds: stuck sessions, orphaned snapshots, missing hooks, shadow branch issues

---

## MCP TOOLS AVAILABLE TO YOU

| Tool | When to Use |
|------|-------------|
| `aura_status` | Start of session, before planning |
| `aura_log_intent` | Before EVERY commit — describe WHY you made changes |
| `aura_plan_discover` | Before multi-file features — get wave plan |
| `aura_plan_lock` | After reviewing gray areas — lock the plan |
| `aura_plan_next` | Get next wave to execute |
| `aura_prove` | Verify a behavioral goal is met |
| `aura_pr_review` | Catch bugs, security issues, violations |
| `aura_rewind` | Surgically revert a function |
| `aura_handover` | Compress context for agent handoff |
| `aura_snapshot` | Backup a file before editing |
| `aura_snapshot_list` | List available snapshots |
| `aura_doctor` | Diagnose repo health issues |
| `aura_suggest_edit` | Get AI-suggested fixes for violations |
| `aura_orchestrate_status` | Check multi-agent orchestration progress |
| `aura_session_resume` | Resume a previous session |
| `aura_session_summarize` | Summarize a session's work |

## WHAT YOU MUST NEVER DO

- Never commit without calling `aura_log_intent` first
- Never delete functions without explaining why in intent
- Never skip `aura_plan_discover` for features touching 3+ files
- Never ignore `aura_pr_review` findings — fix them
- Never edit a file without `aura_snapshot` first
- Never keep working past 50K tokens — use `aura_handover` instead
