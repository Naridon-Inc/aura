//! Pi provider — the `pi` coding agent (@earendil-works/pi-coding-agent),
//! a minimal, provider-agnostic terminal coding harness. Pi runs the same
//! agent loop against Claude / GPT / Gemini / Grok / local models, picking
//! the backend from the user's own `pi` config — so it's bring-your-own-key
//! and we don't attribute a fixed per-token cost.
//!
//! Argv shapes:
//!   * OneShot / StreamJson: `pi -p <prompt>`   (print response and exit;
//!                            Pi's print output is plain text, NOT
//!                            Anthropic stream-json, so we never set
//!                            stdout_is_stream_json)
//!   * PtyRepl:              `pi`                (bare interactive TUI)
//!                            `pi --session <id>` to resume a saved session
//!                            (sessions live in `~/.pi/agent/sessions/`)

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};

pub struct Pi;

const PREFS: &[(&str, i32)] = &[
    ("local model", 2),
    ("offline", 2),
    ("byok", 1),
    ("terminal", 1),
];

impl AgentProvider for Pi {
    fn id(&self) -> &str {
        "pi"
    }

    fn label(&self) -> &str {
        "Pi"
    }

    fn bin_name(&self) -> &str {
        "pi"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // Pi's print/JSON output isn't Anthropic stream-json, so the
            // shell parses one-shot output as raw text — not a stream
            // provider.
            stream: false,
            pty: true,
            // `pi --session <id>` (and `pi -c`/`--continue`) resume saved
            // sessions, so the PTY path can rehydrate a prior run.
            resume: true,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        // Provider-agnostic / BYO-key — cost depends entirely on the model
        // the user points Pi at, so we can't attribute a fixed rate.
        None
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => Ok(Invocation {
                // `-p/--print` runs the prompt and exits. One-shot callers
                // don't carry a session path, so resume is handled by the
                // PtyRepl arm below, not here.
                bin: "pi".into(),
                args: vec!["-p".into(), req.plan_steered_prompt()],
                env: vec![],
                stdout_is_stream_json: false,
            }),
            InvokeMode::PtyRepl => {
                let mut args: Vec<String> = vec![];
                if let Some(sid) = req.resume_session_id {
                    args.extend(["--session".into(), sid.into()]);
                }
                Ok(Invocation {
                    bin: "pi".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
        }
    }
}
