#!/bin/bash
# Hook script for Gemini CLI AfterTool event
# Sends a structured Aura notification after a tool call completes.

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

# Stage 10D — same auto-intent-log as the Claude hook. Gemini's tool
# names map slightly differently (write_file / replace) so the case
# matches both common shapes plus generic Edit/Write.
case "$TOOL_NAME" in
    write_file|replace|Edit|MultiEdit|Write|NotebookEdit)
        FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .path // .absolute_path // empty' 2>/dev/null)
        if [ -n "$FILE_PATH" ] && command -v aura >/dev/null 2>&1; then
            REL_PATH=${FILE_PATH#"$PWD/"}
            aura log-intent "Gemini $TOOL_NAME on $REL_PATH" >/dev/null 2>&1 &
        fi
        ;;
    run_shell_command|Bash)
        BASH_CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null | head -c 400)
        if echo "$BASH_CMD" | grep -qE "^(rm |mv |sed -i|cp .* .*|git (commit|reset|push|rebase|merge)|npm install|yarn add|bun add)"; then
            if command -v aura >/dev/null 2>&1; then
                aura log-intent "Gemini Bash: $BASH_CMD" >/dev/null 2>&1 &
            fi
        fi
        ;;
esac

echo '{}'
