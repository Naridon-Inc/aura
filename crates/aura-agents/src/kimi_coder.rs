//! Kimi-Coder provider — Moonshot AI's `kimi` CLI.
//!
//! Argv shapes (best-known as of 2026-04):
//!   * OneShot / StreamJson: `kimi -p <prompt>`
//!   * PtyRepl:              `kimi`
//!
//! Discovery is multi-name + extended-PATH because the Kimi CLI ships
//! under several different binary names (`kimi`, `kimi-cli`, `kimi-coder`,
//! `moonshot`) depending on install method, and macOS GUI apps inherit
//! launchd's slim PATH that often misses `~/.local/bin` and `~/.npm-global/bin`.
//! We probe a candidate list against `which` first, then fall back to
//! direct existence checks under common per-user install dirs. The first
//! hit wins and is cached for the process lifetime.
//!
//! If your Kimi install lives somewhere we don't probe, override via
//! `~/.aura/agents.toml` — that's exactly what the TOML loader is for.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};
use std::path::PathBuf;
use std::process::Command;
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

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Extra directories to probe when `which` fails. macOS GUI apps don't
/// inherit the user's shell PATH, so binaries installed by Homebrew /
/// pipx / npm-global / cargo often need manual lookup.
fn extended_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join("bin"));
    }
    dirs
}

/// Resolve the Kimi binary path lazily. Returns `None` if no candidate
/// is found. Cached for the process lifetime.
fn resolve_bin() -> Option<&'static str> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            // 1) `which <candidate>` for each candidate name.
            for name in CANDIDATES {
                if Command::new("which")
                    .arg(name)
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
                {
                    return Some((*name).to_string());
                }
            }
            // 2) Fall back to direct existence under extended PATH dirs.
            //    Pin to the absolute path so spawn doesn't re-PATH-search
            //    (which would fail again under launchd PATH).
            for dir in extended_dirs() {
                for name in CANDIDATES {
                    let p = dir.join(name);
                    if p.exists() {
                        return Some(p.to_string_lossy().into_owned());
                    }
                }
            }
            None
        })
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
            InvokeMode::OneShot | InvokeMode::StreamJson => Ok(Invocation {
                bin,
                args: vec!["-p".into(), req.plan_steered_prompt()],
                env: vec![],
                stdout_is_stream_json: false,
            }),
            InvokeMode::PtyRepl => Ok(Invocation {
                bin,
                args: vec![],
                env: vec![],
                stdout_is_stream_json: false,
            }),
        }
    }
}
