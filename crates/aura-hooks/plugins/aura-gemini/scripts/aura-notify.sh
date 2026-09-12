#!/bin/bash
# Aura Shell notification utility using OSC escape sequences
# Usage: aura-notify.sh <title> <body>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

TITLE="${1:-Notification}"
BODY="${2:-}"

printf '\033]777;notify;%s;%s\007' "$TITLE" "$BODY" > /dev/tty 2>/dev/null || true

# Backup HTTP channel — see aura-claude/aura-notify.sh for rationale.
if [ -n "${AURA_HOOK_NOTIFY_URL:-}" ] && [ "$TITLE" = "aura://cli-agent" ]; then
    curl -sS \
        --connect-timeout 1 \
        --max-time 2 \
        -H 'Content-Type: application/json' \
        -X POST \
        --data "$BODY" \
        "$AURA_HOOK_NOTIFY_URL" \
        > /dev/null 2>&1 || true
fi
