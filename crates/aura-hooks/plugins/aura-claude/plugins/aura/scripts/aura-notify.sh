#!/bin/bash
# Aura Shell notification utility using OSC escape sequences
# Usage: aura-notify.sh <title> <body>
#
# For structured Aura notifications, title should be "aura://cli-agent"
# and body should be a JSON string matching the cli-agent notification schema.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# Only emit when Aura has advertised protocol support.
if ! should_use_structured; then
    exit 0
fi

TITLE="${1:-Notification}"
BODY="${2:-}"

# OSC 777 format: \033]777;notify;<title>;<body>\007
# Write directly to /dev/tty so the sequence reaches Aura's PTY parser
# even when stdout is captured by Claude Code.
printf '\033]777;notify;%s;%s\007' "$TITLE" "$BODY" > /dev/tty 2>/dev/null || true

# Backup channel: when AURA_HOOK_NOTIFY_URL is set (Aura Shell injects
# this for PTY children spawned in-app), POST the body to the shell's
# loopback listener too. This catches the case where the PTY parser
# missed the OSC sequence (rare but possible — vte parser race during
# bursty output) and is the ONLY channel for claude/gemini sessions
# the user runs in their own terminal outside Aura Shell.
#
# Body is already JSON (aura://cli-agent envelope) when TITLE matches.
# Best-effort: 0.3s connect timeout, 1s total — never block the agent.
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
