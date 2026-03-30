#!/bin/bash
# Aura Intelligent Status Line for Claude Code
# Tracks per-message usage deltas, detects anomalies, exposes silent drains.
#
# Install: Add to ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "~/.claude/aura-statusline.sh" }
#
# Every observation logged to ~/.aura/usage/statusline.jsonl

set +e

INPUT=$(cat)
AURA_LOG_DIR="$HOME/.aura/usage"
AURA_LOG="$AURA_LOG_DIR/statusline.jsonl"
mkdir -p "$AURA_LOG_DIR"

# ── Extract fields ──
MODEL=$(echo "$INPUT" | jq -r '.model.display_name // "?"')
COST=$(echo "$INPUT" | jq -r '.cost.total_cost_usd // 0')
CONTEXT_PCT=$(echo "$INPUT" | jq -r '.context_window.used_percentage // 0')
INPUT_TOK=$(echo "$INPUT" | jq -r '.context_window.total_input_tokens // 0')
OUTPUT_TOK=$(echo "$INPUT" | jq -r '.context_window.total_output_tokens // 0')
LINES_ADDED=$(echo "$INPUT" | jq -r '.cost.total_lines_added // 0')
LINES_REMOVED=$(echo "$INPUT" | jq -r '.cost.total_lines_removed // 0')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
DURATION_MS=$(echo "$INPUT" | jq -r '.cost.total_duration_ms // 0')

# Rate limits — round to integers
FIVE_H_RAW=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
FIVE_H_RESET=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)
SEVEN_D_RAW=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)
SEVEN_D_RESET=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.resets_at // empty' 2>/dev/null)

FIVE_H=""
[ -n "$FIVE_H_RAW" ] && [ "$FIVE_H_RAW" != "null" ] && FIVE_H=$(awk "BEGIN{printf \"%d\", $FIVE_H_RAW + 0.5}")
SEVEN_D=""
[ -n "$SEVEN_D_RAW" ] && [ "$SEVEN_D_RAW" != "null" ] && SEVEN_D=$(awk "BEGIN{printf \"%d\", $SEVEN_D_RAW + 0.5}")

NOW=$(date +%s)
HOUR_UTC=$(date -u +%H)
DAY_OF_WEEK=$(date -u +%u)

# ── Colors ──
RED='\033[31m'; YEL='\033[33m'; GRN='\033[32m'; CYN='\033[36m'
MAG='\033[35m'; DIM='\033[2m'; BLD='\033[1m'; RST='\033[0m'
BG_RED='\033[41m'

# ── Read previous observation for delta tracking ──
PREV_5H="" ; PREV_7D="" ; PREV_COST="" ; PREV_TS="" ; PREV_OUT=""
if [ -f "$AURA_LOG" ] && [ -n "$SESSION_ID" ]; then
    # Get last line for this session
    PREV_LINE=$(grep "\"sid\":\"$SESSION_ID\"" "$AURA_LOG" 2>/dev/null | tail -1)
    if [ -n "$PREV_LINE" ]; then
        PREV_5H=$(echo "$PREV_LINE" | jq -r '.["5h"] // empty' 2>/dev/null)
        PREV_7D=$(echo "$PREV_LINE" | jq -r '.["7d"] // empty' 2>/dev/null)
        PREV_COST=$(echo "$PREV_LINE" | jq -r '.cost // 0' 2>/dev/null)
        PREV_TS=$(echo "$PREV_LINE" | jq -r '.ts // 0' 2>/dev/null)
        PREV_OUT=$(echo "$PREV_LINE" | jq -r '.out // 0' 2>/dev/null)
    fi
fi

# ── Log this observation ──
echo "{\"ts\":$NOW,\"5h\":${FIVE_H:-null},\"7d\":${SEVEN_D:-null},\"cost\":$COST,\"ctx\":$CONTEXT_PCT,\"in\":$INPUT_TOK,\"out\":$OUTPUT_TOK,\"model\":\"$MODEL\",\"sid\":\"$SESSION_ID\",\"peak\":$([ "$DAY_OF_WEEK" -le 5 ] && [ "$HOUR_UTC" -ge 12 ] && [ "$HOUR_UTC" -lt 18 ] && echo "true" || echo "false")}" >> "$AURA_LOG" 2>/dev/null

# ── Calculate deltas ──
DELTA_5H=""
DELTA_7D=""
DELTA_COST=""
MSG_COST=""

if [ -n "$FIVE_H" ] && [ -n "$PREV_5H" ] && [ "$PREV_5H" != "null" ]; then
    DELTA_5H=$(awk "BEGIN{printf \"%d\", $FIVE_H - $PREV_5H}")
fi
if [ -n "$SEVEN_D" ] && [ -n "$PREV_7D" ] && [ "$PREV_7D" != "null" ]; then
    DELTA_7D=$(awk "BEGIN{printf \"%d\", $SEVEN_D - $PREV_7D}")
fi
if [ -n "$PREV_COST" ] && [ "$PREV_COST" != "null" ]; then
    DELTA_COST=$(awk "BEGIN{printf \"%.2f\", $COST - $PREV_COST}")
    MSG_COST=$(awk "BEGIN{v=$COST - $PREV_COST; if(v>0) printf \"%.2f\", v; else printf \"0\"}")
fi

# ── Session totals from log ──
SESSION_START_5H=""
if [ -n "$SESSION_ID" ] && [ -f "$AURA_LOG" ]; then
    SESSION_START_5H=$(grep "\"sid\":\"$SESSION_ID\"" "$AURA_LOG" 2>/dev/null | head -1 | jq -r '.["5h"] // empty' 2>/dev/null)
fi
SESSION_DRAIN=""
if [ -n "$SESSION_START_5H" ] && [ "$SESSION_START_5H" != "null" ] && [ -n "$FIVE_H" ]; then
    SESSION_DRAIN=$(awk "BEGIN{printf \"%d\", $FIVE_H - $SESSION_START_5H}")
    [ "$SESSION_DRAIN" -lt 0 ] 2>/dev/null && SESSION_DRAIN="0"  # reset happened mid-session
fi

# ── Helpers ──
pbar() {
    local p=$1 w=8
    local f=$(awk "BEGIN{printf \"%d\", ($p/100)*$w}")
    local e=$((w - f))
    local c=$GRN
    (( $(awk "BEGIN{print ($p>80)}") )) && c=$RED
    (( $(awk "BEGIN{print ($p>50) && ($p<=80)}") )) && c=$YEL
    printf "${c}"; for ((i=0;i<f;i++)); do printf "█"; done
    printf "${DIM}"; for ((i=0;i<e;i++)); do printf "░"; done
    printf "${RST}"
}

tuntil() {
    local d=$(($1 - NOW))
    [ "$d" -le 0 ] && echo "now" && return
    local h=$((d/3600)) m=$(((d%3600)/60))
    [ "$h" -gt 0 ] && echo "${h}h${m}m" || echo "${m}m"
}

# ── Anomaly Detection ──
ALERTS=""

# Context bloat: reading way more than writing
if [ "$INPUT_TOK" -gt 0 ] && [ "$OUTPUT_TOK" -gt 0 ]; then
    if (( $(awk "BEGIN{print (($INPUT_TOK/$OUTPUT_TOK) > 20)}") )); then
        R=$(awk "BEGIN{printf \"%.0f\", $INPUT_TOK/$OUTPUT_TOK}")
        ALERTS="${ALERTS} ${YEL}⚠bloat(${R}:1)${RST}"
    fi
fi

# Cost per line too high
TOTAL_LINES=$((LINES_ADDED + LINES_REMOVED))
if [ "$TOTAL_LINES" -gt 0 ] && (( $(awk "BEGIN{print ($COST > 1.0)}") )); then
    CPL=$(awk "BEGIN{printf \"%.2f\", $COST/$TOTAL_LINES}")
    if (( $(awk "BEGIN{print (($COST/$TOTAL_LINES) > 0.10)}") )); then
        ALERTS="${ALERTS} ${YEL}⚠\$${CPL}/line${RST}"
    fi
fi

# Burn rate spike: 5h usage ahead of linear expectation
if [ -n "$FIVE_H" ] && [ -n "$FIVE_H_RESET" ] && [ "$FIVE_H_RESET" != "null" ]; then
    EL=$((18000 - (FIVE_H_RESET - NOW)))
    if [ "$EL" -gt 0 ] && [ "$EL" -lt 18000 ]; then
        EXP=$(awk "BEGIN{printf \"%.0f\", ($EL/18000)*100}")
        OVER=$(awk "BEGIN{printf \"%d\", $FIVE_H - $EXP}")
        [ "$OVER" -gt 20 ] && ALERTS="${ALERTS} ${RED}${BLD}🔥burn+${OVER}%${RST}"
    fi
fi

# Per-message spike: single message ate >5% of 5h window
if [ -n "$DELTA_5H" ] && [ "$DELTA_5H" -gt 5 ] 2>/dev/null; then
    ALERTS="${ALERTS} ${RED}${BLD}⚠msg-${DELTA_5H}%${RST}"
fi

# Silent drain: usage jumped but you barely got output tokens
if [ -n "$DELTA_5H" ] && [ "$DELTA_5H" -gt 3 ] 2>/dev/null; then
    D_OUT=$((OUTPUT_TOK - ${PREV_OUT:-0}))
    if [ "$D_OUT" -lt 500 ] && [ "$D_OUT" -ge 0 ]; then
        ALERTS="${ALERTS} ${MAG}⚠silent-drain${RST}"
    fi
fi

# Context approaching compaction
[ "$CONTEXT_PCT" -gt 85 ] 2>/dev/null && ALERTS="${ALERTS} ${RED}${BLD}⚠compact${RST}"

# Weekly danger
if [ -n "$SEVEN_D" ]; then
    (( $(awk "BEGIN{print ($SEVEN_D > 90)}") )) && ALERTS="${ALERTS} ${BG_RED}${BLD} WALL ${RST}"
    (( $(awk "BEGIN{print ($SEVEN_D > 75) && ($SEVEN_D <= 90)}") )) && ALERTS="${ALERTS} ${RED}⚠week${RST}"
fi

# Idle burn: expensive session, barely any code output
if (( $(awk "BEGIN{print ($COST > 2.0)}") )) && [ "$TOTAL_LINES" -lt 20 ]; then
    ALERTS="${ALERTS} ${MAG}⚠idle-burn${RST}"
fi

# Off-peak drain same as peak: compare delta rate to what peak should look like
# If we're off-peak but the 5h% is jumping fast, that's suspicious
IS_PEAK=""
if [ "$DAY_OF_WEEK" -le 5 ] && [ "$HOUR_UTC" -ge 12 ] && [ "$HOUR_UTC" -lt 18 ]; then
    IS_PEAK="1"
fi
if [ -z "$IS_PEAK" ] && [ -n "$DELTA_5H" ] && [ "$DELTA_5H" -gt 4 ] 2>/dev/null; then
    ALERTS="${ALERTS} ${MAG}⚠off-peak-drain${RST}"
fi

# ── Build status line ──
L=""

# 5h bar with delta
if [ -n "$FIVE_H" ]; then
    B=$(pbar "$FIVE_H")
    R=""
    [ -n "$FIVE_H_RESET" ] && [ "$FIVE_H_RESET" != "null" ] && R="${DIM}↻$(tuntil "$FIVE_H_RESET")${RST}"
    DELTA_STR=""
    if [ -n "$DELTA_5H" ] && [ "$DELTA_5H" -gt 0 ] 2>/dev/null; then
        DELTA_STR="${RED}+${DELTA_5H}%${RST}"
    fi
    L="${BLD}5h${RST}${B}${FIVE_H}%${DELTA_STR} ${R}"
fi

# 7d bar with delta
if [ -n "$SEVEN_D" ]; then
    B=$(pbar "$SEVEN_D")
    R=""
    [ -n "$SEVEN_D_RESET" ] && [ "$SEVEN_D_RESET" != "null" ] && R="${DIM}↻$(tuntil "$SEVEN_D_RESET")${RST}"
    DELTA_STR=""
    if [ -n "$DELTA_7D" ] && [ "$DELTA_7D" -gt 0 ] 2>/dev/null; then
        DELTA_STR="${RED}+${DELTA_7D}%${RST}"
    fi
    L="${L} ${BLD}7d${RST}${B}${SEVEN_D}%${DELTA_STR} ${R}"
fi

# Session drain total
if [ -n "$SESSION_DRAIN" ] && [ "$SESSION_DRAIN" -gt 0 ] 2>/dev/null; then
    DC=$GRN
    [ "$SESSION_DRAIN" -gt 30 ] 2>/dev/null && DC=$YEL
    [ "$SESSION_DRAIN" -gt 60 ] 2>/dev/null && DC=$RED
    L="${L} ${DIM}session${RST}${DC}${SESSION_DRAIN}%${RST}"
fi

# Cost (session total + per-message delta)
if (( $(awk "BEGIN{print ($COST > 0)}") )); then
    CC=$GRN
    (( $(awk "BEGIN{print ($COST > 2)}") )) && CC=$YEL
    (( $(awk "BEGIN{print ($COST > 5)}") )) && CC=$RED
    COST_STR="${CC}\$$(printf '%.2f' $COST)${RST}"
    if [ -n "$MSG_COST" ] && (( $(awk "BEGIN{print ($MSG_COST > 0.01)}") )); then
        COST_STR="${COST_STR}${DIM}(+\$${MSG_COST})${RST}"
    fi
    L="${L} ${COST_STR}"
fi

# Context %
if [ "$CONTEXT_PCT" -gt 0 ] 2>/dev/null; then
    CC=$GRN
    [ "$CONTEXT_PCT" -gt 80 ] 2>/dev/null && CC=$RED
    [ "$CONTEXT_PCT" -gt 50 ] 2>/dev/null && [ "$CONTEXT_PCT" -le 80 ] 2>/dev/null && CC=$YEL
    L="${L} ${DIM}ctx${RST}${CC}${CONTEXT_PCT}%${RST}"
fi

# Peak indicator
[ -n "$IS_PEAK" ] && L="${L} ${RED}${BLD}⚡PEAK${RST}${DIM}(2x)${RST}"

# Alerts
[ -n "$ALERTS" ] && L="${L}${ALERTS}"

# ── Tip line ──
TIP=""
if [ -n "$ALERTS" ]; then
    if echo "$ALERTS" | grep -q "WALL"; then
        TIP="${DIM}↳ near wall → ${CYN}aura usage --plan${RST}"
    elif echo "$ALERTS" | grep -q "silent-drain"; then
        TIP="${DIM}↳ usage jumped, barely any output → system overhead?${RST}"
    elif echo "$ALERTS" | grep -q "off-peak-drain"; then
        TIP="${DIM}↳ draining fast even off-peak → ${CYN}aura usage --plan${RST}${DIM} to investigate${RST}"
    elif echo "$ALERTS" | grep -q "msg-"; then
        TIP="${DIM}↳ that message was expensive → large context or tool calls?${RST}"
    elif echo "$ALERTS" | grep -q "burn+"; then
        TIP="${DIM}↳ burning ahead of pace → consider pausing${RST}"
    elif echo "$ALERTS" | grep -q "bloat"; then
        TIP="${DIM}↳ reading >> writing → ${CYN}aura handover${RST}"
    elif echo "$ALERTS" | grep -q "idle-burn"; then
        TIP="${DIM}↳ high cost, few lines → break into smaller tasks${RST}"
    elif echo "$ALERTS" | grep -q "compact"; then
        TIP="${DIM}↳ context full → ${CYN}aura handover${RST}"
    fi
fi

# ── Output ──
[ -n "$L" ] && echo -e "🌌${L}"
[ -n "$TIP" ] && echo -e "  ${TIP}"

exit 0
