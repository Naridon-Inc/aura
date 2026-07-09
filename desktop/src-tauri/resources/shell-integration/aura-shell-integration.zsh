# Aura terminal shell integration (zsh) — OSC 133 semantic prompt marks.
#
# Emits the public OSC 133 prompt-marking sequences (the same contract
# iTerm2 / VS Code / WezTerm use) so the Aura terminal can offer
# "scroll to previous / next command", command-aware selection, and a
# recent-command list. No network, no writes to your files — this block
# is sourced from a throwaway ZDOTDIR that re-sources your real config
# first (see the generated .zshrc).
#
#   OSC 133;A      before each prompt        (precmd)
#   OSC 133;B      end of the prompt string  (PS1 tail)
#   OSC 133;C      command pre-exec          (preexec)
#   OSC 133;D;$?   command end + exit code   (next precmd)

__aura_osc133() { printf '\033]133;%s\007' "$1" }

__aura_precmd() {
  local __aura_status=$?
  # Close the previous command (if one ran) with its exit code, then
  # mark the start of a fresh prompt.
  if [[ -n ${__aura_cmd_active:-} ]]; then
    __aura_osc133 "D;${__aura_status}"
    unset __aura_cmd_active
  fi
  __aura_osc133 "A"
}

__aura_preexec() {
  __aura_osc133 "C"
  __aura_cmd_active=1
}

# Mark prompt-end (B) at the tail of PS1, wrapped in %{ %} so zsh counts
# it as zero-width. Guarded so re-sourcing .zshrc doesn't stack copies.
if [[ -z ${__aura_ps1_marked:-} ]]; then
  PS1="${PS1}"$'%{\033]133;B\007%}'
  __aura_ps1_marked=1
fi

autoload -Uz add-zsh-hook 2>/dev/null
if (( ${+functions[add-zsh-hook]} )); then
  add-zsh-hook precmd __aura_precmd
  add-zsh-hook preexec __aura_preexec
else
  precmd_functions+=(__aura_precmd)
  preexec_functions+=(__aura_preexec)
fi
