//! OpenCode provider — open-source agent CLI with ACP JSON-RPC and a
//! model-bridge that exposes the user's configured providers (including
//! local LLMs).
//!
//! Argv shapes:
//!   * OneShot: `opencode run <prompt>` (non-interactive; prints final
//!     assistant message). OpenCode also supports `--print` and `--json`
//!     for stream-json-like output but the call sites that need stream
//!     parsing should use `claude` or `gemini` until OpenCode stabilises.
//!   * PtyRepl: `opencode` (bare REPL — drops the user into the TUI).
//!
//! No resume protocol exposed yet — the CLI persists session state
//! itself under `~/.opencode/sessions/` but the resume flag varies
//! between versions. Capabilities advertise `resume: false` and the
//! restored-tab path just spawns a fresh REPL.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};

pub struct OpenCode;

const PREFS: &[(&str, i32)] = &[
    ("research", 2),
    ("explore", 2),
    ("review", 1),
    ("implement", 1),
    ("refactor", 1),
    ("test", 1),
];

impl AgentProvider for OpenCode {
    fn id(&self) -> &str {
        "opencode"
    }

    fn label(&self) -> &str {
        "OpenCode"
    }

    fn bin_name(&self) -> &str {
        "opencode"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            stream: false,
            pty: true,
            resume: false,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        // OpenCode bridges to user-configured providers; cost depends on
        // the active model, not the CLI. Returning None defers to the
        // model-pricing table the shell already maintains.
        None
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => Ok(Invocation {
                bin: "opencode".into(),
                args: vec!["run".into(), req.plan_steered_prompt()],
                env: vec![],
                stdout_is_stream_json: false,
            }),
            InvokeMode::PtyRepl => Ok(Invocation {
                bin: "opencode".into(),
                args: vec![],
                env: vec![],
                stdout_is_stream_json: false,
            }),
        }
    }
}
