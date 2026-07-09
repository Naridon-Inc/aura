//! Shared types across all integration providers.
//!
//! `ProviderTokens` is a re-export of `mcp_oauth::OAuthTokens` so the
//! existing keychain JSON shape (and the future `valid_access_token`
//! refresh logic) stays canonical across the codebase. The downside —
//! growing `mcp_oauth` to fit non-MCP needs — is acceptable for W1
//! because the OAuth 2.0 token model is identical; if integrations
//! ever need a richer shape (e.g. token_id_token for OIDC ID tokens),
//! we'll fork.

use serde::{Deserialize, Serialize};

pub use crate::mcp_oauth::OAuthTokens as ProviderTokens;

/// Discriminator for which third-party we're talking to. Future
/// adapters (Linear, GitHub Issues, Asana, …) extend this enum. Kept
/// as a string-tagged enum so the TS side can pattern-match it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntegrationKind {
    Jira,
    Linear,
}

impl IntegrationKind {
    /// Canonical short name — also the keychain account name so each
    /// provider gets its own slot under the `aura-integrations` service.
    pub fn slug(self) -> &'static str {
        match self {
            IntegrationKind::Jira => "jira",
            IntegrationKind::Linear => "linear",
        }
    }
}

/// User identity returned by the provider's "whoami" endpoint. We keep
/// just enough to render "Connected as Alice (alice@…)" in the
/// settings UI and to attribute outbound writes. Avatar URLs are
/// stored verbatim — provider CDNs vary, no client-side fetching here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalIdentity {
    /// Stable provider-side account id. Atlassian uses an opaque
    /// `accountId`, Linear uses a UUID. Used as the canonical
    /// reference when binding Aura tasks to external issues.
    pub account_id: String,
    pub display_name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// One Atlassian cloud site (instance). A single Atlassian account can
/// have access to multiple sites; the cloudid is the routing key for
/// every subsequent API call. Linear has no equivalent (one workspace
/// per token).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSite {
    /// Atlassian's `cloudid` — opaque UUID. Used in
    /// `https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3/...`.
    pub cloud_id: String,
    /// User-facing site URL (e.g. `https://acme.atlassian.net`).
    pub url: String,
    /// Site name.
    pub name: String,
    /// Scopes actually granted on this site. May be narrower than the
    /// scopes we requested if the user demoted any during consent.
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// W2 — one project ↔ local-repo binding for the pull-mirror. The pair
/// `(cloud_id, project_key)` is the unique key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorSummary {
    pub cloud_id: String,
    pub project_key: String,
    pub project_name: String,
    pub repo_root: String,
    #[serde(default)]
    pub last_synced_at: Option<u64>,
    #[serde(default)]
    pub last_sync_created: u32,
    #[serde(default)]
    pub last_sync_updated: u32,
    #[serde(default)]
    pub last_sync_errors: u32,
    /// JQL-format watermark of the last successful page sweep
    /// (`YYYY-MM-DD HH:MM`, Atlassian's expected shape). The next
    /// poll uses this as the `updated >= "…"` lower bound so we only
    /// pull issues that changed since. Cleared on first sync / on
    /// manual reset.
    #[serde(default)]
    pub last_sync_jql_stamp: Option<String>,
}

/// What the renderer sees for a single integration: are we connected,
/// who as, and (Jira-only) which sites are reachable. Kept small so
/// `integrations_list` can return the whole picture cheaply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStatus {
    pub kind: IntegrationKind,
    pub connected: bool,
    #[serde(default)]
    pub identity: Option<ExternalIdentity>,
    /// Populated for Jira (multi-site). Empty for Linear.
    #[serde(default)]
    pub sites: Vec<CloudSite>,
    /// Comma-joined scopes from the last token response. Useful for
    /// the UI to surface "needs reconnect" when we ask for a new scope.
    #[serde(default)]
    pub scopes: Option<String>,
    /// Unix-seconds expiry of the cached access token. The keychain
    /// blob also has this; surfacing it lets the UI show "expires in
    /// 50m" without a second IPC round-trip.
    #[serde(default)]
    pub expires_at: Option<u64>,
    /// W2 — configured pull-mirror bindings. One row per project the
    /// user has chosen to sync into a local repo.
    #[serde(default)]
    pub mirrors: Vec<MirrorSummary>,
    /// W2 — when set, the poller auto-discovers new projects across
    /// every site on each cycle and creates mirrors for them targeting
    /// the named repo. Disabling clears this but keeps existing mirrors
    /// so a manually curated list can survive a toggle-off.
    #[serde(default)]
    pub auto_mirror_repo_root: Option<String>,
}

impl ConnectionStatus {
    /// Shorthand for the "not connected" state used by `_status` calls
    /// that find no keychain entry.
    pub fn disconnected(kind: IntegrationKind) -> Self {
        Self {
            kind,
            connected: false,
            identity: None,
            sites: Vec::new(),
            scopes: None,
            expires_at: None,
            mirrors: Vec::new(),
            auto_mirror_repo_root: None,
        }
    }
}

/// Provider error envelope. `String`-typed in W1 because every error
/// surface eventually crosses the Tauri IPC boundary, which serialises
/// errors as strings anyway. Carrying a richer enum here would force a
/// `Display` impl + dual representations for no gain.
#[derive(Debug, thiserror::Error)]
pub enum IntegrationError {
    #[error("integration not configured: {0}")]
    NotConfigured(String),
    #[error("OAuth flow: {0}")]
    OAuth(String),
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("keychain: {0}")]
    Keychain(String),
    #[error("{0}")]
    Other(String),
}

impl IntegrationError {
    /// Tauri commands return `Result<T, String>` — this is the
    /// canonical conversion. We don't impl `From<IntegrationError>
    /// for String` because that would silently lose type info inside
    /// generic `?` paths in the adapter modules.
    pub fn into_string(self) -> String {
        self.to_string()
    }
}

impl From<reqwest::Error> for IntegrationError {
    fn from(e: reqwest::Error) -> Self {
        IntegrationError::Other(format!("reqwest: {e}"))
    }
}

impl From<serde_json::Error> for IntegrationError {
    fn from(e: serde_json::Error) -> Self {
        IntegrationError::Other(format!("json: {e}"))
    }
}

impl From<url::ParseError> for IntegrationError {
    fn from(e: url::ParseError) -> Self {
        IntegrationError::Other(format!("url: {e}"))
    }
}
