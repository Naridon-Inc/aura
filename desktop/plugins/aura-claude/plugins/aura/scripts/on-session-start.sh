#!/bin/bash
# Hook script for Claude Code SessionStart event
# Emits a structured Aura notification with the plugin version so Aura
# Shell knows we're in the loop.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

if ! command -v jq &>/dev/null; then
    cat << 'EOF'
{
  "systemMessage": "🚨 Aura notifications require jq! Install it with your system package manager (e.g. brew install jq, apt install jq) 🚨"
}
EOF
    exit 0
fi
source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

# Read plugin version from plugin.json
PLUGIN_VERSION=$(jq -r '.version // "unknown"' "$SCRIPT_DIR/../.claude-plugin/plugin.json" 2>/dev/null)

BODY=$(build_payload "$INPUT" "session_start" \
    --arg plugin_version "$PLUGIN_VERSION")

# Notify (fire-and-forget) keeps the existing OSC + loopback behavior, then
# POST-and-capture the reply so Aura can inject guidance as additionalContext.
"$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"

# Best-effort RPC: empty / non-JSON reply → no-op (we still exit 0).
REPLY=$("$SCRIPT_DIR/aura-notify-rpc.sh" "aura://cli-agent" "$BODY" 2>/dev/null)
if [ -n "$REPLY" ] && echo "$REPLY" | jq -e 'has("additionalContext")' >/dev/null 2>&1; then
    CONTEXT=$(echo "$REPLY" | jq -r '.additionalContext // empty' 2>/dev/null)
    jq -nc \
        --arg context "$CONTEXT" \
        '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$context}}'
fi

exit 0
