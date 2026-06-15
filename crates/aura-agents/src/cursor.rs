//! Cursor agent provider — Cursor's `cursor-agent` CLI (their headless
//! agent mode shipped alongside the editor).
//!
//! Argv shapes:
//!   * OneShot / StreamJson: `cursor-agent -p <prompt>`
//!   * PtyRepl:              `cursor-agent`

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};

pub struct Cursor;

const PREFS: &[(&str, i32)] = &[
    ("ui", 2),
    ("style", 2),
    ("css", 2),
    ("component", 2),
    ("frontend", 2),
    ("tsx", 1),
    ("react", 1),
];

impl AgentProvider for Cursor {
    fn id(&self) -> &str {
        "cursor"
    }

    fn label(&self) -> &str {
        "Cursor Agent"
    }

    fn bin_name(&self) -> &str {
        "cursor-agent"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            stream: false,
            pty: true,
            resume: false,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        // Cursor agent runs against the user's Cursor Pro subscription;
        // there's no per-token cost for them. We surface 0/0 so the
        // orchestrator's cost rollup doesn't over-attribute spend.
        Some(CostPer1k {
            input_usd: 0.0,
            output_usd: 0.0,
        })
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => Ok(Invocation {
                bin: "cursor-agent".into(),
                args: vec!["-p".into(), req.plan_steered_prompt()],
                env: vec![],
                stdout_is_stream_json: false,
            }),
            InvokeMode::PtyRepl => Ok(Invocation {
                bin: "cursor-agent".into(),
                args: vec![],
                env: vec![],
                stdout_is_stream_json: false,
            }),
        }
    }
}
