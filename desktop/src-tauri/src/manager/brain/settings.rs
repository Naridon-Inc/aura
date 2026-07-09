//! Persistent brain-picker configuration.
//!
//! Lives at `~/.aura/brain_settings.json` (per-user, not per-repo) so
//! the user's "I prefer Claude Code CLI" preference follows them
//! across projects. API keys never land here — those go to the OS
//! keychain via `keychain.rs`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::types::BrainError;

const SETTINGS_FILE: &str = "brain_settings.json";

/// Per-provider configuration the user has stored. Anything that
/// must NOT be in plaintext (API keys, tokens) stays out of this
/// struct — it lives in the OS keychain instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Optional model override. None → brain's default.
    #[serde(default)]
    pub model: Option<String>,
    /// Provider-specific knobs (base_url, region, project_id, …).
    /// Serde-flat so each provider can read the keys it understands.
    #[serde(default)]
    pub extra: serde_json::Value,
}

/// Default for [`BrainSettings::auto_route`] — on. New users get
/// ledger-driven routing out of the box; opting out is a deliberate
/// toggle, not the cold-boot state.
fn default_auto_route() -> bool {
    true
}

/// Root settings doc. Picker UI reads + writes this.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainSettings {
    /// `provider_id` of the brain the manager should use this session.
    /// None → first-launch / cold-boot, caller picks a sensible default
    /// (typically `anthropic_native` if a key is in keychain, else the
    /// first installed CLI).
    #[serde(default)]
    pub active_provider_id: Option<String>,
    /// Stored per-provider config keyed by provider_id.
    #[serde(default)]
    pub providers: std::collections::HashMap<String, ProviderConfig>,
    /// When true, the orchestrator/dispatcher consults the Agent Skill
    /// Ledger (`aura skill suggest`) to auto-bind each unoverridden lane
    /// to the historically best provider for its taxonomy cell. A manual
    /// `brain_override` always wins; off → every lane uses the active
    /// brain. Defaults to true (see [`default_auto_route`]).
    #[serde(default = "default_auto_route")]
    pub auto_route: bool,
}

impl Default for BrainSettings {
    fn default() -> Self {
        Self {
            active_provider_id: None,
            providers: std::collections::HashMap::new(),
            auto_route: default_auto_route(),
        }
    }
}

fn settings_path() -> Result<PathBuf, BrainError> {
    let home = dirs::home_dir().ok_or_else(|| BrainError::Other {
        message: "no home directory".into(),
    })?;
    Ok(home.join(".aura").join(SETTINGS_FILE))
}

/// Load settings from disk. Returns defaults if the file is missing
/// or unparseable — never errors on first-launch.
pub fn load() -> BrainSettings {
    let Ok(path) = settings_path() else {
        return BrainSettings::default();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return BrainSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Atomically write settings to disk (tempfile + rename).
pub fn save(settings: &BrainSettings) -> Result<(), BrainError> {
    let path = settings_path()?;
    crate::fs_atomic::write_json_pretty(&path, settings)
        .map_err(|message| BrainError::Other { message })
}
