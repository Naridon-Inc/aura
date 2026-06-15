//! Gemini CLI provider — Google's `gemini` binary.
//!
//! Argv shapes:
//!   * OneShot / StreamJson: `gemini -p <prompt> --yolo` (gemini doesn't
//!     yet emit Anthropic stream-json; the caller renders raw stdout)
//!   * PtyRepl:              `gemini` (bare REPL)
//!
//! Forwards `GEMINI_API_KEY` from the Aura config when the env var is
//! unset — that pull was previously hardcoded inside orchestrate.rs's
//! `invoke_agent`. Provider-side keeps the Aura-config dependency local.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};

pub struct GeminiCli;

const PREFS: &[(&str, i32)] = &[
    ("research", 3),
    ("test", 3),
    ("document", 3),
    ("analyze", 2),
    ("review", 2),
    ("implement", 1),
    ("add endpoint", 1),
    ("add feature", 1),
    ("write code", 1),
    ("build", 1),
    ("create", 1),
    ("add", 1),
    ("set up", 1),
    ("configure", 1),
];

impl AgentProvider for GeminiCli {
    fn id(&self) -> &str {
        "gemini"
    }

    fn label(&self) -> &str {
        "Gemini CLI"
    }

    fn bin_name(&self) -> &str {
        "gemini"
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
            input_usd: 0.00125,
            output_usd: 0.010,
        })
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        PREFS
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        // Forward API key from Aura's config only when the env var
        // isn't already set. The provider has no opinion about *where*
        // the key comes from — that's a runtime concern resolved here
        // as a fallback.
        let env = if std::env::var("GEMINI_API_KEY").is_err() {
            api_key_from_aura_config()
                .map(|k| vec![("GEMINI_API_KEY".to_string(), k)])
                .unwrap_or_default()
        } else {
            vec![]
        };

        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => {
                // Gemini CLI has no command-line thinking flag (only the
                // interactive /model menu), so effort rides as a one-line
                // prompt-steer prefix — safe and provider-agnostic.
                let mut args: Vec<String> = vec![];
                // Per-turn model from the composer picker. `gemini -m`
                // accepts the full model id; omitted when none selected.
                if let Some(model) = req.model {
                    args.extend(["-m".into(), model.into()]);
                }
                args.extend(["-p".into(), req.steered_prompt(false)]);
                // Cross-agent permission mode → `--approval-mode <…>`. When no
                // policy is set we keep gemini's existing non-interactive
                // `--yolo` default (byte-identical to the pre-feature build).
                match req.approval.and_then(|a| a.gemini_args()) {
                    Some(mode_args) => args.extend(mode_args),
                    None => args.push("--yolo".into()),
                }
                Ok(Invocation {
                    bin: "gemini".into(),
                    args,
                    env,
                    stdout_is_stream_json: false,
                })
            }
            InvokeMode::PtyRepl => {
                // Gemini's `-r / --resume <id>` accepts a UUID, an index
                // (e.g. "5"), or the literal "latest". The shell's
                // restored-tab respawn passes "latest" so a desktop
                // restart picks up the user's most recent conversation
                // for this project without needing the prior session id.
                let mut args: Vec<String> = vec![];
                // Pin the REPL to the picked model so the spawned Gemini
                // tab opens where the composer picker pointed.
                if let Some(model) = req.model {
                    args.extend(["-m".into(), model.into()]);
                }
                // Pin the interactive REPL to the chosen permission mode too;
                // no-op when no policy is set (the REPL keeps its own default).
                if let Some(mode_args) = req.approval.and_then(|a| a.gemini_args()) {
                    args.extend(mode_args);
                }
                if let Some(sid) = req.resume_session_id {
                    args.push("--resume".into());
                    args.push(sid.into());
                }
                Ok(Invocation {
                    bin: "gemini".into(),
                    args,
                    env,
                    stdout_is_stream_json: false,
                })
            },
        }
    }
}

/// Reads the Gemini API key from `~/.aura/config.json` if present.
/// Mirrors the previous `crate::config::ConfigManager::get_api_key("gemini")`
/// behavior in aura-cli — duplicated here to keep this crate free of an
/// aura-cli dependency. Cheap (one file read, only on dispatch).
fn api_key_from_aura_config() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let mut path = std::path::PathBuf::from(home);
    path.push(".aura");
    path.push("config.json");
    let bytes = std::fs::read(&path).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("api_keys")
        .and_then(|v| v.get("gemini"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}
