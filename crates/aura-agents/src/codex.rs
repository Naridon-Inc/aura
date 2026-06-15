//! Codex provider — OpenAI's `codex` CLI.
//!
//! Argv shapes:
//!   * OneShot / StreamJson: `codex exec <prompt>` (raw stdout, not stream-json)
//!   * PtyRepl:              `codex` (interactive REPL)
//!
//! Codex doesn't yet emit Anthropic-style stream-json, so the caller
//! renders its stdout as a single `AssistantText` block, same as gemini.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};

pub struct Codex;

const PREFS: &[(&str, i32)] = &[
    ("test", 2),
    ("python", 2),
    ("script", 2),
    ("type", 1),
    ("typing", 1),
    ("snippet", 1),
];

impl AgentProvider for Codex {
    fn id(&self) -> &str {
        "codex"
    }

    fn label(&self) -> &str {
        "Codex"
    }

    fn bin_name(&self) -> &str {
        "codex"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            stream: false,
            pty: true,
            resume: false,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        // GPT-4o-class pricing as a placeholder; codex CLI uses whatever
        // model it's configured against. Real cost should come from the
        // CLI's own usage report when available.
        Some(CostPer1k {
            input_usd: 0.0025,
            output_usd: 0.010,
        })
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => {
                let mut args: Vec<String> = vec![];
                // Per-turn model from the composer picker — a `-c model=`
                // config override, same `-c` channel as the reasoning knob.
                if let Some(model) = req.model {
                    args.push("-c".into());
                    args.push(format!("model={model}"));
                }
                // Codex's real reasoning knob is a `-c` config override that
                // precedes the `exec` subcommand. `fast` collapses to the
                // "minimal" tier. (verified: codex -c model_reasoning_effort)
                let effort_value = match (req.effort, req.fast) {
                    (Some(e), _) => Some(e.codex_value(req.fast)),
                    (None, true) => Some("minimal"),
                    (None, false) => None,
                };
                if let Some(value) = effort_value {
                    args.push("-c".into());
                    args.push(format!("model_reasoning_effort={value}"));
                }
                // Cross-agent permission mode → codex sandbox flags, placed
                // before `exec` (top-level, same as `-c`). Empty when unset.
                if let Some(policy) = req.approval {
                    args.extend(policy.codex_args());
                }
                args.push("exec".into());
                args.push(req.prompt.into());
                Ok(Invocation {
                    bin: "codex".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
            InvokeMode::PtyRepl => Ok(Invocation {
                bin: "codex".into(),
                args: vec![],
                env: vec![],
                stdout_is_stream_json: false,
            }),
        }
    }
}
