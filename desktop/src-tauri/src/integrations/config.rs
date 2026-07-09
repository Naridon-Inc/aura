//! TOML-on-disk config loader for integration provider credentials.
//!
//! Lives at `$AURA_HOME/integrations.toml` (default `~/.aura/integrations.toml`).
//! Credentials never touch the repo. Aura reads this file lazily —
//! every `connect` / `status` call re-reads from disk so a user can
//! drop in a new client_secret without restarting (although a running
//! OAuth flow with a stale secret will still need to be cancelled).
//!
//! Shape:
//! ```toml
//! [jira]
//! client_id     = "..."
//! client_secret = "..."
//! redirect_uri  = "http://127.0.0.1:42421/callback"
//! scopes        = ["read:jira-work", "write:jira-work", ...]
//!
//! [linear]            # reserved for W2 — not consumed yet.
//! client_id     = "..."
//! client_secret = "..."  # optional (Linear supports PKCE-only)
//! redirect_uri  = "http://127.0.0.1:42422/callback"
//! scopes        = ["read", "write", "issues:create"]
//! ```

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

use super::types::IntegrationError;

/// Top-level TOML document — all provider blocks are optional so we
/// can ship the file empty before anyone configures anything.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct IntegrationsConfig {
    #[serde(default)]
    pub jira: Option<JiraConfig>,
    #[serde(default)]
    #[allow(dead_code)]
    pub linear: Option<LinearConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JiraConfig {
    pub client_id: String,
    pub client_secret: String,
    /// Loopback callback URL. Must match EXACTLY what's registered on
    /// the Atlassian developer console (Atlassian rejects port
    /// mismatch). Port is extracted at flow start to bind our local
    /// listener; the full string is forwarded to the token endpoint.
    pub redirect_uri: String,
    /// Scope list — also drives the `scope=` query parameter on the
    /// authorize URL. Order matters for display only.
    pub scopes: Vec<String>,
}

// W2 reservation — Linear adapter lands in the next wave. Parsed at
// load time so a user's existing `[linear]` block doesn't break the
// TOML schema, but no consumer reads it yet.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct LinearConfig {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
}

impl JiraConfig {
    /// Parse `redirect_uri` and pull the loopback port out so the
    /// adapter can bind it. Returns an error if the URL is malformed
    /// or points anywhere other than `127.0.0.1`.
    pub fn loopback_port(&self) -> Result<u16, IntegrationError> {
        let parsed = url::Url::parse(&self.redirect_uri)?;
        if parsed.host_str() != Some("127.0.0.1") {
            return Err(IntegrationError::NotConfigured(format!(
                "redirect_uri must use 127.0.0.1 (got {})",
                parsed.host_str().unwrap_or("?")
            )));
        }
        parsed.port().ok_or_else(|| {
            IntegrationError::NotConfigured(
                "redirect_uri must specify an explicit port (Atlassian rejects wildcards)".into(),
            )
        })
    }
}

/// Resolve the TOML path. Honours `$AURA_HOME` so multi-environment
/// setups (CI, sandbox profiles) can isolate their credentials.
fn config_path() -> Result<PathBuf, IntegrationError> {
    if let Ok(home) = std::env::var("AURA_HOME") {
        return Ok(PathBuf::from(home).join("integrations.toml"));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| IntegrationError::NotConfigured("no HOME / USERPROFILE".into()))?;
    Ok(PathBuf::from(home).join(".aura").join("integrations.toml"))
}

/// Read + parse the whole config. Returns an empty config (rather than
/// erroring) when the file doesn't exist, so the first-run UX is
/// "settings → integrations → not configured" rather than a hard error.
pub fn load() -> Result<IntegrationsConfig, IntegrationError> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(IntegrationsConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| {
        IntegrationError::Other(format!("read {}: {e}", path.display()))
    })?;
    toml::from_str::<IntegrationsConfig>(&raw)
        .map_err(|e| IntegrationError::NotConfigured(format!("parse {}: {e}", path.display())))
}

/// Pull the Jira block specifically, with a friendly error for the
/// "no jira section at all" case.
pub fn jira() -> Result<JiraConfig, IntegrationError> {
    load()?.jira.ok_or_else(|| {
        IntegrationError::NotConfigured(
            "missing [jira] block in ~/.aura/integrations.toml — \
             add client_id + client_secret from the Atlassian developer console".into(),
        )
    })
}
