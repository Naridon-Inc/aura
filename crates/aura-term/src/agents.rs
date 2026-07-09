//! Agent orchestration registry.
//!
//! Maps the composer's `Model` picker to a concrete CLI binary + prompt
//! delivery mode. When the user submits with a model that corresponds to an
//! agent, the Submit handler spawns that agent inside the live PTY rather
//! than running the prompt as a shell command.
//!
//! v1 supports one-shot invocation only: we spawn the agent with the prompt
//! as an argument (or piped via stdin) and let its output stream into the
//! block via the same OSC 133 wrapper used for regular commands.

use crate::ui::composer::Model;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptMode {
    /// Prompt passed as final positional arg.
    Arg,
    /// Prompt passed with `-p` flag (Claude Code, Cursor Agent).
    PFlag,
    /// Prompt written to the agent's stdin.
    Stdin,
}

#[derive(Debug, Clone)]
pub struct AgentSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub binary: &'static str,
    pub prompt_mode: PromptMode,
    pub extra_args: &'static [&'static str],
}

pub const CLAUDE_CODE: AgentSpec = AgentSpec {
    id: "claude-code",
    label: "Claude Code",
    binary: "claude",
    prompt_mode: PromptMode::PFlag,
    extra_args: &[],
};

pub const GEMINI_CLI: AgentSpec = AgentSpec {
    id: "gemini-cli",
    label: "Gemini CLI",
    binary: "gemini",
    prompt_mode: PromptMode::Arg,
    extra_args: &[],
};

pub const CURSOR_AGENT: AgentSpec = AgentSpec {
    id: "cursor-agent",
    label: "Cursor Agent",
    binary: "cursor-agent",
    prompt_mode: PromptMode::PFlag,
    extra_args: &[],
};

pub const CODEX: AgentSpec = AgentSpec {
    id: "codex",
    label: "Codex",
    binary: "codex",
    prompt_mode: PromptMode::Stdin,
    extra_args: &[],
};

pub const AIDER: AgentSpec = AgentSpec {
    id: "aider",
    label: "aider",
    binary: "aider",
    prompt_mode: PromptMode::Arg,
    extra_args: &["--no-auto-commit"],
};

pub const ALL: &[AgentSpec] = &[CLAUDE_CODE, GEMINI_CLI, CURSOR_AGENT, CODEX, AIDER];

/// Given the composer model picker value, return the agent it corresponds to
/// or `None` if the model is a plain "run as shell command" mode.
pub fn resolve_model(model: Model) -> Option<&'static AgentSpec> {
    match model {
        Model::Opus47 | Model::Sonnet46 => Some(&CLAUDE_CODE),
        Model::Gemini31Pro => Some(&GEMINI_CLI),
        Model::Gpt54 => Some(&CURSOR_AGENT),
        Model::Composer2Fast | Model::Composer15 => None,
    }
}

/// Build a shell-ready command line that spawns this agent with the given
/// prompt. Quoting is done with single-quote escaping that's safe for POSIX
/// shells. The caller writes this string to the PTY master.
pub fn build_invocation(spec: &AgentSpec, prompt: &str) -> String {
    let quoted = shell_single_quote(prompt);
    let extras = spec.extra_args.join(" ");
    let extras = if extras.is_empty() {
        String::new()
    } else {
        format!("{extras} ")
    };
    match spec.prompt_mode {
        PromptMode::Arg => format!("{} {}{}", spec.binary, extras, quoted),
        PromptMode::PFlag => format!("{} {}-p {}", spec.binary, extras, quoted),
        PromptMode::Stdin => {
            let extras_trimmed = extras.trim_end();
            if extras_trimmed.is_empty() {
                format!("printf %s {} | {}", quoted, spec.binary)
            } else {
                format!("printf %s {} | {} {}", quoted, spec.binary, extras_trimmed)
            }
        }
    }
}

/// Wrap `text` in POSIX single quotes, escaping embedded single quotes via
/// the standard `'\''` trick. Output is always safe to use as a single shell
/// token.
fn shell_single_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for ch in text.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_quote_escapes_embedded_quotes() {
        assert_eq!(shell_single_quote("hi"), "'hi'");
        assert_eq!(shell_single_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_single_quote(""), "''");
    }

    #[test]
    fn claude_code_emits_p_flag_invocation() {
        let cmd = build_invocation(&CLAUDE_CODE, "hello world");
        assert_eq!(cmd, "claude -p 'hello world'");
    }

    #[test]
    fn gemini_emits_positional_arg() {
        let cmd = build_invocation(&GEMINI_CLI, "hi");
        assert_eq!(cmd, "gemini 'hi'");
    }

    #[test]
    fn codex_emits_stdin_pipe() {
        let cmd = build_invocation(&CODEX, "prompt");
        assert_eq!(cmd, "printf %s 'prompt' | codex");
    }

    #[test]
    fn aider_includes_extra_args() {
        let cmd = build_invocation(&AIDER, "fix bug");
        assert_eq!(cmd, "aider --no-auto-commit 'fix bug'");
    }
}
