#!/bin/bash
# Hook script for Claude Code PostToolUse event
# Sends a structured Aura notification after a tool call completes,
# transitioning the session status from Blocked back to InProgress.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // .input // {}' 2>/dev/null)
if [ -z "$TOOL_INPUT" ]; then
    TOOL_INPUT="{}"
fi

BODY=$(build_payload "$INPUT" "tool_complete" \
    --arg tool_name "$TOOL_NAME" \
    --argjson tool_input "$TOOL_INPUT")

"$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"

# Stage 10D — auto-log intent on every code-mutating tool. Manager and
# the History sidebar then have a complete trail of what each agent
# touched without the agent having to call aura_log_intent itself. Best
# effort: failure here must not block the parent tool.
case "$TOOL_NAME" in
    Edit|MultiEdit|Write|NotebookEdit)
        FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .notebook_path // empty' 2>/dev/null)
        if [ -n "$FILE_PATH" ] && command -v aura >/dev/null 2>&1; then
            REL_PATH=${FILE_PATH#"$PWD/"}
            aura log-intent "Claude $TOOL_NAME on $REL_PATH" >/dev/null 2>&1 &
        fi
        ;;
    Bash)
        # Only log Bash invocations that look like code-mutating commands
        # (sed/awk-in-place, mv, rm). Read-only commands (ls, cat, grep)
        # would flood the intent log with no signal.
        BASH_CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null | head -c 400)
        if echo "$BASH_CMD" | grep -qE "^(rm |mv |sed -i|cp .* .*|git (commit|reset|push|rebase|merge)|npm install|yarn add|bun add)"; then
            if command -v aura >/dev/null 2>&1; then
                aura log-intent "Claude Bash: $BASH_CMD" >/dev/null 2>&1 &
            fi
        fi
        ;;
esac
