//! Secret-store wrapper for integration tokens.
//!
//! Layout: `service = "aura-integrations"`, `account = "<provider-slug>"`
//! (e.g. `"jira"`). The blob is the JSON-encoded `ProviderTokens`
//! (re-exported from `mcp_oauth::OAuthTokens` — same shape).
//!
//! Kept tiny on purpose: the only real value over calling
//! `crate::secret_store` directly is centralising the service name + JSON
//! discipline. The store itself is the keychain in release and a dev file
//! fallback in debug (see `crate::secret_store`).

use super::types::{IntegrationError, IntegrationKind, ProviderTokens};

/// Secret-store service name. Distinct from `mcp_oauth::KEYCHAIN_SERVICE`
/// so disconnecting an MCP server can never delete an integration's
/// tokens.
const KEYCHAIN_SERVICE: &str = "aura-integrations";

pub fn store(kind: IntegrationKind, tokens: &ProviderTokens) -> Result<(), IntegrationError> {
    let blob = serde_json::to_string(tokens)?;
    crate::secret_store::set(KEYCHAIN_SERVICE, kind.slug(), &blob)
        .map_err(IntegrationError::Keychain)
}

pub fn load(kind: IntegrationKind) -> Result<Option<ProviderTokens>, IntegrationError> {
    // `None` is the success path for "user never connected"; any error is
    // a real store failure worth surfacing.
    match crate::secret_store::get(KEYCHAIN_SERVICE, kind.slug())
        .map_err(IntegrationError::Keychain)?
    {
        Some(blob) => Ok(Some(serde_json::from_str::<ProviderTokens>(&blob)?)),
        None => Ok(None),
    }
}

pub fn delete(kind: IntegrationKind) -> Result<(), IntegrationError> {
    // Idempotent disconnect — `secret_store::delete` no-ops on an absent slot.
    crate::secret_store::delete(KEYCHAIN_SERVICE, kind.slug()).map_err(IntegrationError::Keychain)
}
