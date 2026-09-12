#!/bin/bash
# The post-tool-use hook body every agent CLI that is not Claude Code runs.
#
# WHAT IT IS FOR. `aura log-intent` writes the row that makes a repo look
# worked-in rather than idle — first locally, then on the team's console. It
# is the whole difference between "somebody is editing this right now" and a
# console showing nothing, and it must not depend on the agent having been
# started from the Aura desktop app.
#
# WHY ONE SCRIPT FOR FOUR CLIS. codex, kimi, opencode and pi disagree about
# what a tool is called, what its arguments are called, and whether the keys
# are snake_case or camelCase. They agree about everything else: this tool
# changed a file, so record it. Written once per CLI that decision would exist
# four times, and the first time one of them learned about a new editing tool
# the other three would quietly stop noticing it.
#
# (cursor is the fifth non-Claude CLI and does not run this script: it reads
# Claude's own settings.local.json, so Aura's Claude hook already covers it.)
#
# CONTRACT. One tool-call payload as JSON on stdin. `AURA_HOOK_AGENT` names
# the agent in the intent text. Always exits 0 and never writes to stdout: a
# post-tool hook that fails or chatters is a hook that disrupts the tool it
# was only supposed to be watching.
#
# THE SESSION ID IS THE POINT, not a detail. A row without one is a change
# nobody can attribute to a piece of work, and the console builds its Sessions
# feed by grouping rows that share one. Every CLI here sends it — under four
# different spellings, and for the two module hosts from somewhere other than
# the event — so all four spellings are read and the shims pass theirs in.

set -u

INPUT=$(cat 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

# No aura, or no jq to read the payload with, means nothing to record and
# nothing to complain about — this hook is stamped on machines that may not
# have either.
command -v aura >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

AGENT="${AURA_HOOK_AGENT:-Agent}"

read_json() { printf '%s' "$INPUT" | jq -r "$1" 2>/dev/null; }

TOOL=$(read_json '.tool_name // .toolName // .tool // ""')
ARGS=$(printf '%s' "$INPUT" | jq -c '.tool_input // .toolInput // .args // .input // {}' 2>/dev/null)
[ -n "$ARGS" ] || ARGS='{}'

# Run where the work happened. A hook's cwd is the agent's cwd for some CLIs
# and the CLI's own for others, and `aura log-intent` records against the repo
# it is standing in — so the payload's own idea of the workspace wins where it
# has one.
# Four spellings of one thing: codex and claude send `session_id`, kimi
# `sessionId`, opencode `sessionID`, cursor `conversation_id`. (Cursor's
# `generation_id` is per-turn and would make every edit its own session.)
SESSION=$(read_json '.session_id // .sessionId // .sessionID // .conversation_id // ""')

CWD=$(read_json '.cwd // (.workspace_roots // [])[0] // .directory // ""')
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
    cd "$CWD" || true
fi

# Backgrounded and silent, because this runs between the agent's tool call and
# the agent seeing its result. Anything slow here is latency the person feels
# on every edit.
#
# `AURA_AGENT` is what `aura log-intent` files the row under. Without it every
# row from every CLI reads `hook_auto`, and the console cannot say who was
# working — only that somebody was.
log_intent() {
    local text=$1
    local file=${2:-}
    [ -n "$text" ] || return 0

    set -- log-intent "$text" --tool "$TOOL"
    [ -n "$file" ] && set -- "$@" --file "$file"
    [ -n "$SESSION" ] && set -- "$@" --session "$SESSION"

    AURA_AGENT="$AGENT" aura "$@" >/dev/null 2>&1 &
}

# A path as the repository names it, not as this shell happens to see it.
#
# Both the intent log and `aura why` key on repo-relative paths, so stripping
# only $PWD writes rows nothing can match the moment an agent works from a
# subdirectory. Falls back to the $PWD form when git cannot answer.
relative_to_cwd() {
    local root
    root=$(git -C "$(dirname "$1")" rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$root" ]; then
        printf '%s' "${1#"$root"/}"
    else
        printf '%s' "${1#"$PWD"/}"
    fi
}

case "$TOOL" in
    # Patch tools carry their file names inside the patch text rather than in
    # an argument. Two spellings show up: codex's `*** Update File: path`
    # envelope, and an ordinary unified diff.
    apply_patch | patch | Patch)
        PATCH=$(printf '%s' "$ARGS" | jq -r '.input // .patch // .diff // .content // empty' 2>/dev/null)
        # `sed -E`, not plain BRE: BSD sed — which is the sed on every Mac —
        # has no `\|` alternation, so a BRE version of this matches nothing at
        # all and silently reports no files on the platform most of these CLIs
        # run on. In ERE `+` is a quantifier, hence the escapes in `\+\+\+`.
        FILES=$(printf '%s\n' "$PATCH" \
            | sed -n -E -e 's/^\*\*\* (Add|Update|Delete) File: //p' -e 's|^\+\+\+ b/||p' \
            | head -20)
        if [ -n "$FILES" ]; then
            while IFS= read -r f; do
                if [ -n "$f" ]; then
                    REL=$(relative_to_cwd "$f")
                    log_intent "$AGENT patch on $REL" "$REL"
                fi
            done <<EOF
$FILES
EOF
        fi
        ;;

    # Every CLI's write and edit tools. Claude's own capitalised names are in
    # the list as well — several of these CLIs borrowed pieces of Claude's tool
    # vocabulary, and matching a name nobody sends costs nothing next to
    # missing one somebody does.
    write | edit | multi_edit | multiedit | str_replace | create_file \
        | Write | Edit | MultiEdit | NotebookEdit)
        FILE=$(printf '%s' "$ARGS" \
            | jq -r '.file_path // .filePath // .path // .notebook_path // .absolute_path // empty' 2>/dev/null)
        if [ -n "$FILE" ]; then
            REL=$(relative_to_cwd "$FILE")
            log_intent "$AGENT $TOOL on $REL" "$REL"
        fi
        ;;

    # Shell tools, filtered down to commands that plausibly changed something.
    # Read-only ones (ls, cat, grep) are most of what an agent runs, and
    # logging those would bury the edits they surround.
    bash | shell | Bash | Shell | run_terminal_cmd)
        CMD=$(printf '%s' "$ARGS" | jq -r '.command // .cmd // empty' 2>/dev/null | head -c 400)
        if printf '%s' "$CMD" | grep -qE "^(rm |mv |sed -i|cp .* .*|git (commit|reset|push|rebase|merge)|npm install|yarn add|bun add)"; then
            log_intent "$AGENT shell: $CMD"
        fi
        ;;
esac

exit 0
