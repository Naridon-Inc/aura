//! Secure API-key storage for the Brain abstraction.
//!
//! Routed through `crate::secret_store`, which delegates to:
//!
//!   - macOS Keychain / Windows Credential Manager / Linux Secret Service
//!     (release builds), or
//!   - a `0600` file under `~/.aura/dev-secrets` (debug builds, to dodge
//!     the per-rebuild keychain re-prompt — see `crate::secret_store`).
//!
//! Keys are stored under the service name `aura-shell` with the brain
//! provider_id as the account, so in a release build `keyring show
//! aura-shell` still lists everything Aura has put there and the user can
//! inspect/revoke independently of the app.

use super::types::BrainError;

const SERVICE: &str = "aura-shell";

fn wrap(provider_id: &str, op: &str, message: String) -> BrainError {
    BrainError::Keychain {
        message: format!("{op}({provider_id}): {message}"),
    }
}

/// Store an API key for `provider_id`. Overwrites any existing value.
pub fn set_api_key(provider_id: &str, key: &str) -> Result<(), BrainError> {
    crate::secret_store::set(SERVICE, provider_id, key)
        .map_err(|m| wrap(provider_id, "set", m))
}

/// Retrieve the API key for `provider_id`. Returns `Ok(None)` if no
/// entry exists (caller decides whether that's fatal); returns `Err`
/// only for store access failures (locked, permission denied, …).
pub fn get_api_key(provider_id: &str) -> Result<Option<String>, BrainError> {
    crate::secret_store::get(SERVICE, provider_id).map_err(|m| wrap(provider_id, "get", m))
}

/// Delete the API key for `provider_id`. No-op (Ok) if no entry exists.
pub fn delete_api_key(provider_id: &str) -> Result<(), BrainError> {
    crate::secret_store::delete(SERVICE, provider_id)
        .map_err(|m| wrap(provider_id, "delete", m))
}

/// Test whether a key is currently stored. Useful for the Settings UI
/// to render "API key set ✓" without exposing the value.
pub fn has_api_key(provider_id: &str) -> bool {
    matches!(get_api_key(provider_id), Ok(Some(_)))
}
