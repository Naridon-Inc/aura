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
//! [linear]
//! client_id     = "..."
//! client_secret = "..."  # optional (Linear supports PKCE-only)
//! redirect_uri  = "http://127.0.0.1:42422/callback"
//! scopes        = ["read", "write", "issues:create"]
//!
//! [vercel]                        # deploy status on PR checks
//! token       = "..."            # personal / team access token
//! project_id  = "prj_..."        # optional — narrows the query
//! team_id     = "team_..."       # optional — required for team projects
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
    pub linear: Option<LinearConfig>,
    #[serde(default)]
    pub vercel: Option<VercelConfig>,
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

/// Linear OAuth 2.0 app credentials. Registered at
/// <https://linear.app/settings/api/applications>. `client_secret` is
/// modelled as `Option` only so the TOML schema tolerates a public-app
/// block that omits it — the adapter itself requires a secret at flow
/// time (Linear's authorization-code grant is a confidential flow) and
/// errors clearly if it's absent.
#[derive(Debug, Clone, Deserialize)]
pub struct LinearConfig {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    /// Loopback callback URL. Must match a redirect URI registered on
    /// the Linear application EXACTLY (Linear rejects mismatches). The
    /// port is extracted at flow start to bind the local listener.
    pub redirect_uri: String,
    /// Scope list — drives the `scope=` query parameter (Linear expects
    /// a comma-separated list, e.g. `read,write,issues:create`).
    pub scopes: Vec<String>,
}

/// Vercel deploy-status credentials. Unlike Jira/Linear this is not an
/// OAuth flow — Vercel issues a long-lived personal or team access token
/// (created at <https://vercel.com/account/tokens>), which we send as a
/// Bearer on the REST API. No redirect, no callback, no keychain OAuth
/// dance: the token is the whole credential and lives in this TOML block.
#[derive(Debug, Clone, Deserialize)]
pub struct VercelConfig {
    /// Personal or team access token. Sent as `Authorization: Bearer`.
    pub token: String,
    /// Optional project id (`prj_…`) to narrow the deployments query to a
    /// single project. When absent we query across the token's scope and
    /// match on the commit sha, which is unique enough on its own.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Optional team id (`team_…`). Required for projects that live under
    /// a Vercel team rather than the token owner's personal account —
    /// Vercel scopes the deployments listing by team.
    #[serde(default)]
    pub team_id: Option<String>,
}

impl LinearConfig {
    /// Pull the loopback port out of `redirect_uri` so the adapter can
    /// bind it. Same `127.0.0.1`-only rule as Jira — Linear registers
    /// the redirect as an exact string, so a wildcard port is invalid.
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
                "redirect_uri must specify an explicit port (Linear registers it exactly)".into(),
            )
        })
    }
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

/// Pull the Linear block, with a friendly error when it's absent.
pub fn linear() -> Result<LinearConfig, IntegrationError> {
    load()?.linear.ok_or_else(|| {
        IntegrationError::NotConfigured(
            "missing [linear] block in ~/.aura/integrations.toml — \
             add client_id + client_secret from https://linear.app/settings/api/applications \
             (suggested redirect_uri http://127.0.0.1:42422/callback)"
                .into(),
        )
    })
}

/// Pull the Vercel block. Absent → `Ok(None)` rather than an error, because
/// the PR deploy card is optional enrichment: an unconfigured Vercel simply
/// shows no deploy chip instead of surfacing a scary "not configured" state.
pub fn vercel() -> Result<Option<VercelConfig>, IntegrationError> {
    Ok(load()?.vercel)
}
