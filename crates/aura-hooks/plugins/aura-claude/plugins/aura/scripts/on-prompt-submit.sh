#!/bin/bash
# Hook script for Claude Code UserPromptSubmit event
# Sends a structured Aura notification when the user submits a prompt,
# transitioning the session status from idle/blocked back to running.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

QUERY=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
if [ -n "$QUERY" ] && [ ${#QUERY} -gt 200 ]; then
    QUERY="${QUERY:0:197}..."
fi

BODY=$(build_payload "$INPUT" "prompt_submit" \
    --arg query "$QUERY")

# Notify (fire-and-forget) keeps the existing OSC + loopback behavior, then
# POST-and-capture the reply so Aura can inject guidance as additionalContext.
"$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"

# Best-effort RPC: empty / non-JSON reply → no-op (we still exit 0).
REPLY=$("$SCRIPT_DIR/aura-notify-rpc.sh" "aura://cli-agent" "$BODY" 2>/dev/null)
if [ -n "$REPLY" ] && echo "$REPLY" | jq -e 'has("additionalContext")' >/dev/null 2>&1; then
    CONTEXT=$(echo "$REPLY" | jq -r '.additionalContext // empty' 2>/dev/null)
    jq -nc \
        --arg context "$CONTEXT" \
        '{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:$context}}'
fi

exit 0
