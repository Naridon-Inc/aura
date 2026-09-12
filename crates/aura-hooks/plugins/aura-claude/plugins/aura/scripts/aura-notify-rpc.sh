#!/bin/bash
# Aura Shell notification utility — RPC (request/reply) variant.
# Usage: aura-notify-rpc.sh <title> <body> [max_time]
#
# <max_time> (optional, default 2) is curl's --max-time in seconds. The
# common auto-allow reply returns in milliseconds (curl returns the moment
# the server replies), so a large value here is free for that path; only a
# real HUMAN gate holds the connection open, and the gate path passes a long
# value (e.g. 600) so the agent waits for confirmation instead of timing out.
#
# This is the request/reply sibling of aura-notify.sh. It performs the SAME
# OSC 777 notify (for observability) AND the SAME loopback POST, but instead
# of discarding the loopback reply it echoes the response BODY to stdout so
# callers can act on it (gate tool calls, inject additionalContext, etc).
#
# The loopback reply is a JSON object — any field may be absent:
#   {
#     "additionalContext":        "<text>"?,
#     "permissionDecision":       "allow" | "deny" | "ask"?,
#     "permissionDecisionReason": "<text>"?
#   }
#
# Best-effort: if Aura has not advertised protocol support, or the loopback
# URL is unset/unreachable, this prints nothing and exits 0. Callers MUST
# treat empty stdout as "no opinion" and default to allow / no-op — a hook
# must never block the agent on an RPC failure.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# Only emit when Aura has advertised protocol support.
if ! should_use_structured; then
    exit 0
fi

TITLE="${1:-Notification}"
BODY="${2:-}"
MAX_TIME="${3:-2}"

# OSC 777 notify — same observability channel as aura-notify.sh. Write
# directly to /dev/tty so the sequence reaches Aura's PTY parser even when
# stdout is captured by Claude Code (which it is here — we use stdout for the
# RPC reply).
printf '\033]777;notify;%s;%s\007' "$TITLE" "$BODY" > /dev/tty 2>/dev/null || true

# POST the body to the shell's loopback listener and capture the reply.
# Reuses aura-notify.sh's URL/curl conventions exactly (same timeouts, same
# headers). On any failure we print nothing and exit 0.
if [ -n "${AURA_HOOK_NOTIFY_URL:-}" ] && [ "$TITLE" = "aura://cli-agent" ]; then
    curl -sS \
        --connect-timeout 1 \
        --max-time "$MAX_TIME" \
        -H 'Content-Type: application/json' \
        -X POST \
        --data "$BODY" \
        "$AURA_HOOK_NOTIFY_URL" \
        2>/dev/null || true
fi
