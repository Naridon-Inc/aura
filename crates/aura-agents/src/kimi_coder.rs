//! Kimi-Coder provider — Moonshot AI's `kimi` CLI.
//!
//! Argv shapes (best-known as of 2026-04):
//!   * OneShot / StreamJson: `kimi -p <prompt>`
//!   * PtyRepl:              `kimi`
//!
//! Discovery is multi-name because the Kimi CLI ships under several
//! different binary names (`kimi`, `kimi-cli`, `kimi-coder`, `moonshot`)
//! depending on install method. The extended-PATH half — GUI apps inherit
//! launchd's slim PATH, which misses `~/.local/bin` and friends — is not
//! Kimi's problem alone and lives in [`crate::bin_resolve`], which every
//! agent goes through. The first candidate that resolves wins, and the
//! answer is cached for the process lifetime.
//!
//! If your Kimi install lives somewhere we don't probe, override via
//! `~/.aura/agents.toml` — that's exactly what the TOML loader is for.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};
use std::sync::OnceLock;

pub struct KimiCoder;

const PREFS: &[(&str, i32)] = &[
    ("chinese", 3),
    ("中文", 3),
    ("long context", 2),
    ("long-context", 2),
    ("large file", 2),
    ("translate", 2),
];

const CANDIDATES: &[&str] = &["kimi", "kimi-cli", "kimi-coder", "moonshot"];

/// Resolve the Kimi binary lazily — the multi-name half is Kimi's own, the
/// extended-PATH half is shared with every other agent (see
/// [`crate::bin_resolve`]). Cached for the process lifetime.
fn resolve_bin() -> Option<&'static str> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| crate::bin_resolve::resolve(CANDIDATES))
        .as_deref()
}

impl AgentProvider for KimiCoder {
    fn id(&self) -> &str {
        "kimi"
    }

    fn label(&self) -> &str {
        "Kimi-Coder"
    }

    fn bin_name(&self) -> &str {
        // Reports the resolved name (or absolute path) when known so the
        // Settings → Agents pane shows the user where Aura found it.
        resolve_bin().unwrap_or("kimi")
    }

    fn is_available(&self) -> bool {
        resolve_bin().is_some()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            stream: false,
            pty: true,
            resume: false,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        Some(CostPer1k {
            input_usd: 0.0006,
            output_usd: 0.0024,
        })
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        let bin = resolve_bin().unwrap_or("kimi").to_string();
        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => {
                let mut args: Vec<String> = vec![];
                // Per-turn model from the composer picker → `kimi -m <id>`
                // (verified: `kimi --help` shows `-m/--model TEXT`). `None`
                // leaves kimi on its configured `default_model`, so the
                // invocation stays byte-identical to the pre-picker build.
                if let Some(model) = req.model {
                    args.push("-m".into());
                    args.push(model.into());
                }
                args.push("-p".into());
                args.push(req.plan_steered_prompt());
                Ok(Invocation {
                    bin,
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
            InvokeMode::PtyRepl => Ok(Invocation {
                bin,
                args: vec![],
                env: vec![],
                stdout_is_stream_json: false,
            }),
        }
    }
}
