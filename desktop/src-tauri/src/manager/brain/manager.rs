//! Brain manager — loads the active brain per `BrainSettings` and
//! caches it across turns. Cheap to clone (`Arc<dyn Brain>`).
//!
//! The manager is the single place where settings + keychain + registry
//! meet. Callers (the chat command, future dispatcher) ask for the
//! currently-active brain and don't care how it was constructed.

use std::sync::{Arc, RwLock};

use super::{
    Brain, registry,
    settings::{self, BrainSettings},
    types::BrainError,
};

/// Shared, mutable state holding the active brain. Wrapped in an
/// `RwLock` so the picker can swap brains live without restarting
/// in-flight conversations (they hold their own `Arc` snapshot).
#[derive(Clone)]
pub struct BrainManager {
    inner: Arc<RwLock<Inner>>,
}

struct Inner {
    settings: BrainSettings,
    active: Option<Arc<dyn Brain>>,
}

impl BrainManager {
    /// Build a manager from on-disk settings. Does not eagerly construct
    /// the active brain — that happens on the first `active()` call so
    /// startup doesn't pay for keychain access we may not need.
    pub fn from_disk() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Inner {
                settings: settings::load(),
                active: None,
            })),
        }
    }

    /// Return the currently-active brain, building it if necessary.
    pub fn active(&self) -> Result<Arc<dyn Brain>, BrainError> {
        if let Some(active) = self.inner.read().unwrap().active.clone() {
            return Ok(active);
        }
        let provider_id = self
            .inner
            .read()
            .unwrap()
            .settings
            .active_provider_id
            .clone()
            .or_else(default_provider_id)
            .ok_or_else(|| BrainError::Other {
                message: "no active brain configured and no default available".into(),
            })?;
        let brain = registry::build(&provider_id)?;
        self.inner.write().unwrap().active = Some(brain.clone());
        Ok(brain)
    }

    /// Build a specific brain by id WITHOUT changing the active one or
    /// persisting anything. WW-B1 — the chat-header BrainPicker's
    /// per-session override resolves through here so a mid-conversation
    /// swap applies to this turn only, leaving the global default and
    /// every other session untouched.
    pub fn resolve(&self, provider_id: &str) -> Result<Arc<dyn Brain>, BrainError> {
        registry::build(provider_id)
    }

    /// Switch the active brain. Persists to disk and clears the
    /// cached instance so the next `active()` rebuilds.
    pub fn set_active(&self, provider_id: &str) -> Result<(), BrainError> {
        let mut g = self.inner.write().unwrap();
        g.settings.active_provider_id = Some(provider_id.to_string());
        settings::save(&g.settings)?;
        g.active = None;
        Ok(())
    }

    /// Read-only snapshot of the persisted settings.
    pub fn settings(&self) -> BrainSettings {
        self.inner.read().unwrap().settings.clone()
    }
}

/// Pick a sensible default when the user hasn't configured anything.
/// Order (the registry's own availability walk): a native provider whose
/// key is actually in the keychain, then an installed coding-agent CLI,
/// then a configured `openai_compat` endpoint.
///
/// It delegates rather than deciding here because that walk only ever
/// returns ids `registry::build` has an arm for. The old code named the
/// *family* — `cli_wrapper` — instead of a member like
/// `cli_wrapper:claude_code`, so on a first launch with no API key stored
/// every single turn died with "unknown provider: cli_wrapper": the app
/// looked broken when the truth was just that nobody had picked a CLI.
fn default_provider_id() -> Option<String> {
    registry::first_available_fallback_excluding(&[])
}
