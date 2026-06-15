//! Claude Code provider — Anthropic's `claude` CLI.
//!
//! Three argv shapes:
//!   * OneShot:    `claude -p <prompt> --allowedTools Bash Edit Write Read Glob Grep`
//!   * StreamJson: `claude -p <prompt> --output-format stream-json --verbose [--resume <sid>]`
//!                 (with `--input-format stream-json` when stdin attachments are used)
//!   * PtyRepl:    `claude` (bare, drops the user into the REPL)
//!
//! Permission-prompt MCP wiring is layered on top of the StreamJson
//! invocation by the desktop shell — that's a shell-side concern (it
//! owns the shim binary path), not a provider concern, so it's not
//! emitted here.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};

pub struct ClaudeCode;

const PREFS: &[(&str, i32)] = &[
    ("refactor", 3),
    ("migrate", 3),
    ("rewrite", 3),
    ("complex logic", 3),
    ("fix bug", 2),
    ("debug", 2),
    ("architect", 2),
];

impl AgentProvider for ClaudeCode {
    fn id(&self) -> &str {
        "claude"
    }

    fn label(&self) -> &str {
        "Claude Code"
    }

    fn bin_name(&self) -> &str {
        "claude"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            stream: true,
            pty: true,
            resume: true,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        // Claude 3.5 Sonnet pricing per 1K tokens (March 2026 rates).
        Some(CostPer1k {
            input_usd: 0.003,
            output_usd: 0.015,
        })
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        // Claude has no reasoning-effort flag; its thinking is triggered by
        // a keyword in the prompt ("think" → "ultrathink"). `steered_prompt`
        // prepends it when the caller set an effort (no-op when unset/fast).
        let prompt = req.steered_prompt(true);
        // Cross-agent permission mode → `--permission-mode <…>`. Empty when
        // no policy is set, so the invocation stays byte-identical.
        let approval_args = req.approval.map(|a| a.claude_args()).unwrap_or_default();
        match req.mode {
            InvokeMode::OneShot => {
                let mut args: Vec<String> = vec![];
                // Per-turn model from the composer picker. `claude --model`
                // accepts the full id; omitted when no model is selected.
                if let Some(model) = req.model {
                    args.extend(["--model".into(), model.into()]);
                }
                args.extend(approval_args.iter().cloned());
                if let Some(sid) = req.resume_session_id {
                    args.extend([
                        "--resume".into(),
                        sid.into(),
                        "-p".into(),
                        prompt.clone(),
                    ]);
                } else {
                    args.extend(["-p".into(), prompt.clone()]);
                }
                args.extend([
                    "--allowedTools".into(),
                    "Bash Edit Write Read Glob Grep".into(),
                ]);
                Ok(Invocation {
                    bin: "claude".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
            InvokeMode::StreamJson => {
                let mut args: Vec<String> = vec![];
                if let Some(model) = req.model {
                    args.extend(["--model".into(), model.into()]);
                }
                args.extend(approval_args.iter().cloned());
                if req.attachments_via_stdin {
                    args.extend([
                        "-p".into(),
                        "--input-format".into(),
                        "stream-json".into(),
                        "--output-format".into(),
                        "stream-json".into(),
                        "--verbose".into(),
                    ]);
                } else {
                    args.extend([
                        "-p".into(),
                        prompt.clone(),
                        "--output-format".into(),
                        "stream-json".into(),
                        "--verbose".into(),
                    ]);
                }
                if let Some(sid) = req.resume_session_id {
                    args.extend(["--resume".into(), sid.into()]);
                }
                Ok(Invocation {
                    bin: "claude".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: true,
                })
            }
            InvokeMode::PtyRepl => {
                let mut args: Vec<String> = vec![];
                // Launch the interactive REPL pinned to the chosen model so
                // the spawned Claude tab starts where the picker pointed.
                if let Some(model) = req.model {
                    args.extend(["--model".into(), model.into()]);
                }
                args.extend(approval_args.iter().cloned());
                if let Some(sid) = req.resume_session_id {
                    args.extend(["--resume".into(), sid.into()]);
                }
                Ok(Invocation {
                    bin: "claude".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
        }
    }
}
