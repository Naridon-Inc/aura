# Aura terminal shell integration (bash) — OSC 133 semantic prompt marks.
#
# Emits the public OSC 133 prompt-marking sequences so the Aura terminal
# can offer "scroll to previous / next command", command-aware
# selection, and a recent-command list. No network, no writes to your
# files — this block is sourced from a throwaway --rcfile that
# re-sources your ~/.bashrc first.
#
#   OSC 133;A      before each prompt        (PROMPT_COMMAND)
#   OSC 133;B      end of the prompt string  (PS1 tail)
#   OSC 133;C      command pre-exec          (DEBUG trap)
#   OSC 133;D;$?   command end + exit code   (next PROMPT_COMMAND)

__aura_osc133() { printf '\033]133;%s\007' "$1"; }

__aura_precmd() {
  local __aura_status=$?
  if [[ -n ${__aura_cmd_active:-} ]]; then
    __aura_osc133 "D;${__aura_status}"
    __aura_cmd_active=
  fi
  __aura_osc133 "A"
}

# bash has no preexec; the DEBUG trap fires before each simple command.
# Mark only the first command of an input line, and skip the prompt
# bookkeeping command itself + completion-time invocations.
__aura_preexec() {
  [[ -n ${COMP_LINE:-} ]] && return
  [[ "${BASH_COMMAND}" == "__aura_precmd" ]] && return
  if [[ -z ${__aura_cmd_active:-} ]]; then
    __aura_osc133 "C"
    __aura_cmd_active=1
  fi
}

case "${PROMPT_COMMAND:-}" in
  *__aura_precmd*) : ;;
  "") PROMPT_COMMAND="__aura_precmd" ;;
  *) PROMPT_COMMAND="__aura_precmd;${PROMPT_COMMAND}" ;;
esac

# Mark prompt-end (B) at the tail of PS1, wrapped in \[ \] so readline
# counts it as zero-width. Guard against double-add on re-source.
case "${PS1:-}" in
  *'133;B'*) : ;;
  *) PS1="${PS1}"'\[\033]133;B\007\]' ;;
esac

trap '__aura_preexec' DEBUG
