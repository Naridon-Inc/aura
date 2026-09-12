#!/bin/bash
# Hook script for Claude Code SubagentStop event.
#
# Fires when one Task-tool worker finishes — not when the session does. It is
# the only moment anything is told that a worker existed at all: the Stop hook
# is handed the *session's* transcript_path, and a worker's own transcript
# lives in a `<session-id>/subagents/` directory nobody ever opened. So a
# sub-agent's words never left the machine, and its edits reached the console
# filed under the parent with nothing saying which worker made them.
#
# Everything here is best-effort and backgrounded. A worker finishing must not
# wait on the network, and this hook must exit 0 whatever happens.

INPUT=$(cat)

command -v aura >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# The session the worker ran inside. Every row in a worker's transcript carries
# the *parent's* session id, which is exactly right: the work belongs to the
# session, and `agent_id` says which worker inside it did the work.
SESSION=$(echo "$INPUT" | jq -r '.session_id // .conversation_id // empty' 2>/dev/null)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null)
AGENT_TRANSCRIPT=$(echo "$INPUT" | jq -r '.agent_transcript_path // empty' 2>/dev/null)

[ -n "$SESSION" ] || exit 0
[ -n "$AGENT_ID" ] || exit 0

# Say a worker ran, and what its parent asked it for. The description is read
# from Claude's own sidecar rather than guessed, so the console shows the chain
# of command the way the agent actually built it.
if [ -f "$AGENT_TRANSCRIPT" ]; then
    (aura subagents \
        --session "$SESSION" \
        --transcript "$AGENT_TRANSCRIPT" \
        --push >/dev/null 2>&1 &) </dev/null
fi

# Send what the worker actually said, attributed to it. Same opt-in as the
# session's own transcript sync: a transcript is the person's conversation and
# nothing uploads it unless they asked.
if [ "${AURA_SYNC_TRANSCRIPT:-0}" = "1" ] && [ -f "$AGENT_TRANSCRIPT" ]; then
    set -- transcript-sync --session "$SESSION" --transcript "$AGENT_TRANSCRIPT" --agent-id "$AGENT_ID"
    [ -n "$AGENT_TYPE" ] && set -- "$@" --agent-type "$AGENT_TYPE"
    (aura "$@" >/dev/null 2>&1 &) </dev/null
fi

# The session is still alive — a worker finishing is the middle of the work,
# not the end of it. Without this a session that spends an hour fanning out to
# workers reads as idle for that hour, because the parent thread makes no tool
# calls of its own while it waits.
printf '%s' "$INPUT" | aura beat --session "$SESSION" --agent Claude >/dev/null 2>&1 &

exit 0
