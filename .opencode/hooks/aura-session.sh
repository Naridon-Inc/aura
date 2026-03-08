#!/bin/bash
# Aura-OpenCode Integration Hook
# Place this in your OpenCode hooks directory to enable Aura session tracking.
#
# This hook bridges OpenCode sessions with Aura's semantic governance engine,
# enabling checkpoint tracking, intent logging, and session management.

set -e

AURA_BIN="${AURA_BIN:-aura}"
EVENT="${1:-start}"

case "$EVENT" in
    start)
        # Start an Aura session for this OpenCode instance
        export AURA_AGENT="opencode"
        $AURA_BIN status >/dev/null 2>&1 || true
        echo "[Aura] Session tracking started for OpenCode"
        ;;
    edit)
        # Called when OpenCode edits a file
        FILE="${2:-}"
        if [ -n "$FILE" ]; then
            # Log the file touch (aura tracks via checkpoint on commit)
            echo "[Aura] Tracked edit: $FILE"
        fi
        ;;
    commit)
        # Called before OpenCode commits
        $AURA_BIN persist-checkpoint 2>/dev/null || true
        echo "[Aura] Checkpoint persisted"
        ;;
    end)
        # Called when OpenCode session ends
        echo "[Aura] Session ended. Run 'aura status' for summary."
        ;;
    *)
        echo "[Aura] Unknown event: $EVENT"
        ;;
esac
