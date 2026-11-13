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

/// Brain ids that were once offered and no longer are. A setting that
/// still names one — the active brain, a per-provider entry, a session's
/// override — is treated as "nothing chosen", so the next turn runs on the
/// first agent or key the user has actually set up.
///
/// `aura_pro` was a managed brain that answered through Aura's cloud on
/// Aura's own key. People now pick a real model from the agents and keys
/// they have connected.
pub const RETIRED_PROVIDERS: &[&str] = &["aura_pro"];

/// Whether `provider_id` names a brain this build no longer offers.
pub fn is_retired(provider_id: &str) -> bool {
    RETIRED_PROVIDERS.contains(&provider_id)
}

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

/// The settings exactly as the file has them, or `None` when the file is
/// missing or unparseable.
fn read_raw() -> Option<BrainSettings> {
    let path = settings_path().ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Drop every mention of a retired brain. Returns whether anything went.
fn forget_retired(settings: &mut BrainSettings) -> bool {
    let mut changed = false;
    if settings.active_provider_id.as_deref().is_some_and(is_retired) {
        settings.active_provider_id = None;
        changed = true;
    }
    let before = settings.providers.len();
    settings.providers.retain(|id, _| !is_retired(id));
    changed || settings.providers.len() != before
}

/// Load settings from disk. Returns defaults if the file is missing
/// or unparseable — never errors on first-launch. A retired brain never
/// comes back as the active one: it reads as "nothing chosen", and the
/// manager runs the first agent or key the user has set up.
pub fn load() -> BrainSettings {
    let mut settings = read_raw().unwrap_or_default();
    forget_retired(&mut settings);
    settings
}

/// Rewrite the settings file once without any retired brain in it, so the
/// file on disk says what the app does. Leaves a missing or unparseable
/// file alone — there is nothing to migrate, and writing defaults over a
/// file a person might still fix by hand would lose it. Returns whether
/// the file was rewritten.
pub fn migrate_retired_providers() -> Result<bool, BrainError> {
    let Some(mut settings) = read_raw() else {
        return Ok(false);
    };
    if !forget_retired(&mut settings) {
        return Ok(false);
    }
    save(&settings)?;
    Ok(true)
}

/// Atomically write settings to disk (tempfile + rename).
pub fn save(settings: &BrainSettings) -> Result<(), BrainError> {
    let path = settings_path()?;
    crate::fs_atomic::write_json_pretty(&path, settings)
        .map_err(|message| BrainError::Other { message })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(active: Option<&str>, providers: &[&str]) -> BrainSettings {
        BrainSettings {
            active_provider_id: active.map(str::to_string),
            providers: providers
                .iter()
                .map(|id| (id.to_string(), ProviderConfig::default()))
                .collect(),
            auto_route: true,
        }
    }

    #[test]
    fn a_retired_active_brain_reads_as_nothing_chosen() {
        let mut s = with(Some("aura_pro"), &["aura_pro", "anthropic_native"]);
        assert!(forget_retired(&mut s));
        assert_eq!(s.active_provider_id, None);
        assert!(!s.providers.contains_key("aura_pro"));
        assert!(s.providers.contains_key("anthropic_native"));
    }

    #[test]
    fn a_real_choice_is_left_alone() {
        let mut s = with(Some("cli_wrapper:claude_code"), &["anthropic_native"]);
        assert!(!forget_retired(&mut s));
        assert_eq!(s.active_provider_id.as_deref(), Some("cli_wrapper:claude_code"));
        assert_eq!(s.providers.len(), 1);
    }

    #[test]
    fn a_leftover_entry_alone_still_counts_as_a_change() {
        // Active already moved on, but the old brain's entry is still there.
        let mut s = with(Some("gemini_native"), &["aura_pro"]);
        assert!(forget_retired(&mut s));
        assert_eq!(s.active_provider_id.as_deref(), Some("gemini_native"));
        assert!(s.providers.is_empty());
    }

    #[test]
    fn only_the_retired_ids_are_retired() {
        assert!(is_retired("aura_pro"));
        assert!(!is_retired("anthropic_native"));
        assert!(!is_retired("cli_wrapper:claude_code"));
        assert!(!is_retired(""));
    }
}
