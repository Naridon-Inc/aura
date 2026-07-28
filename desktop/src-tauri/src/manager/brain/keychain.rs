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
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "aura-shell";

/// Process-lifetime memo of resolved keys, keyed by `provider_id`.
///
/// The underlying `secret_store::get` is a macOS Keychain read that costs
/// ~100ms, and it runs on *every* chat send: a fresh `BrainManager` is built
/// per send (see `cmd_brain_chat::brain_chat_turn`), so the manager-level
/// `Arc<dyn Brain>` cache never survives across sends and the key is re-read
/// each time. Memoizing the successful read here is what closes that TTFT gap.
///
/// Correctness: this module is the single writer of the store during a run, so
/// every mutation (`set`/`delete`) updates the cache in lockstep — a rotated
/// key is never served stale. Only successful reads are cached; store-access
/// errors (locked, permission denied) fall through uncached so they retry.
/// A key rotated *outside* the app mid-session is the one accepted staleness
/// tradeoff; it resolves on next launch.
fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn wrap(provider_id: &str, op: &str, message: String) -> BrainError {
    BrainError::Keychain {
        message: format!("{op}({provider_id}): {message}"),
    }
}

/// Store an API key for `provider_id`. Overwrites any existing value.
pub fn set_api_key(provider_id: &str, key: &str) -> Result<(), BrainError> {
    crate::secret_store::set(SERVICE, provider_id, key)
        .map_err(|m| wrap(provider_id, "set", m))?;
    cache()
        .lock()
        .unwrap()
        .insert(provider_id.to_string(), Some(key.to_string()));
    Ok(())
}

/// Retrieve the API key for `provider_id`. Returns `Ok(None)` if no
/// entry exists (caller decides whether that's fatal); returns `Err`
/// only for store access failures (locked, permission denied, …).
pub fn get_api_key(provider_id: &str) -> Result<Option<String>, BrainError> {
    if let Some(hit) = cache().lock().unwrap().get(provider_id) {
        return Ok(hit.clone());
    }
    let value =
        crate::secret_store::get(SERVICE, provider_id).map_err(|m| wrap(provider_id, "get", m))?;
    cache()
        .lock()
        .unwrap()
        .insert(provider_id.to_string(), value.clone());
    Ok(value)
}

/// Delete the API key for `provider_id`. No-op (Ok) if no entry exists.
pub fn delete_api_key(provider_id: &str) -> Result<(), BrainError> {
    crate::secret_store::delete(SERVICE, provider_id)
        .map_err(|m| wrap(provider_id, "delete", m))?;
    cache()
        .lock()
        .unwrap()
        .insert(provider_id.to_string(), None);
    Ok(())
}

/// Test whether a key is currently stored. Useful for the Settings UI
/// to render "API key set ✓" without exposing the value.
pub fn has_api_key(provider_id: &str) -> bool {
    matches!(get_api_key(provider_id), Ok(Some(_)))
}
