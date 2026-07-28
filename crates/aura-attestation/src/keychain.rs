//! OS keychain persistence for per-actor identities.
//!
//! Backed by the `keyring` crate — the same backend the desktop app uses
//! for MCP OAuth tokens and Brain API keys (`mcp_oauth.rs`,
//! `manager/brain/keychain.rs`). It delegates to:
//!
//!   - macOS Keychain
//!   - Windows Credential Manager
//!   - the Linux kernel keyring (keyutils — no secret-service / dbus, so
//!     it works on headless servers and in CI)
//!
//! Identities are stored under the service name `aura-identity` with the
//! account `"<kind>:<label>"` (e.g. `human:muhammed`, `agent:claude-code`),
//! so `keyring show aura-identity` lists everything Aura has minted and the
//! user can inspect or revoke independently of the app. The stored blob is
//! the JSON [`StoredIdentity`] — the 32-byte seed plus enough metadata that
//! a load reconstructs the full [`LocalIdentity`] without any side table.
//!
//! Gated behind the `keychain` feature (on by default). Builds that want
//! to avoid the OS-keyring dependency entirely (a pure verifier, say) can
//! depend on `aura-attestation` with `default-features = false`.

use base64::{engine::general_purpose::STANDARD_NO_PAD as B64, Engine};
use serde::{Deserialize, Serialize};

use crate::error::AttestationError;
use crate::identity::{ActorKind, LocalIdentity, Nid};
use crate::keys::SigningKey;

const SERVICE: &str = "aura-identity";

/// The JSON blob stored in the keychain for one identity. Self-describing:
/// it carries the kind/label and the NID alongside the seed so a load both
/// reconstructs the identity AND integrity-checks the recovered key against
/// the recorded NID.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredIdentity {
    /// Schema version for forward-compatible migrations.
    version: u32,
    kind: ActorKind,
    label: String,
    /// 32-byte ed25519 seed, base64 (standard, no pad).
    seed_b64: String,
    /// The NID derived from the seed at store time. Verified on load.
    nid: Nid,
}

const STORED_VERSION: u32 = 1;

/// Account key: `"<kind>:<label>"`.
fn account(kind: ActorKind, label: &str) -> String {
    format!("{}:{}", kind.as_str(), label)
}

fn entry(kind: ActorKind, label: &str) -> Result<keyring::Entry, AttestationError> {
    let acct = account(kind, label);
    keyring::Entry::new(SERVICE, &acct)
        .map_err(|e| AttestationError::Keychain(format!("entry({acct}): {e}")))
}

/// Persist `identity` to the OS keychain, overwriting any existing entry
/// for the same kind+label.
pub fn store(identity: &LocalIdentity) -> Result<(), AttestationError> {
    let stored = StoredIdentity {
        version: STORED_VERSION,
        kind: identity.kind(),
        label: identity.label().to_string(),
        seed_b64: B64.encode(identity.signing_key().seed_bytes()),
        nid: identity.nid(),
    };
    let blob = serde_json::to_string(&stored)
        .map_err(|e| AttestationError::Keychain(format!("encode: {e}")))?;
    entry(identity.kind(), identity.label())?
        .set_password(&blob)
        .map_err(|e| AttestationError::Keychain(format!("set: {e}")))
}

/// Load the identity for `kind`/`label`. `Ok(None)` if no entry exists;
/// `Err` only for keychain access failures or a corrupt blob.
pub fn load(kind: ActorKind, label: &str) -> Result<Option<LocalIdentity>, AttestationError> {
    let blob = match entry(kind, label)?.get_password() {
        Ok(b) => b,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(AttestationError::Keychain(format!("get: {e}"))),
    };
    let stored: StoredIdentity = serde_json::from_str(&blob)
        .map_err(|e| AttestationError::Keychain(format!("decode: {e}")))?;

    let raw = B64
        .decode(stored.seed_b64.as_bytes())
        .map_err(|e| AttestationError::Keychain(format!("seed b64: {e}")))?;
    let seed: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| AttestationError::Keychain(format!("seed is {} bytes, expected 32", raw.len())))?;

    let identity = LocalIdentity::from_key(stored.kind, stored.label, SigningKey::from_seed(seed));

    // Integrity check: the seed must reproduce the NID we wrote. A
    // mismatch means the blob was tampered with or corrupted in storage.
    if identity.nid() != stored.nid {
        return Err(AttestationError::Keychain(format!(
            "stored NID {} does not match seed-derived NID {}",
            stored.nid.as_str(),
            identity.nid().as_str()
        )));
    }
    Ok(Some(identity))
}

/// Load the identity for `kind`/`label`, minting and persisting a fresh
/// one if none exists. The idempotent entrypoint most callers want.
pub fn load_or_create(kind: ActorKind, label: &str) -> Result<LocalIdentity, AttestationError> {
    if let Some(found) = load(kind, label)? {
        return Ok(found);
    }
    let fresh = LocalIdentity::generate(kind, label);
    store(&fresh)?;
    Ok(fresh)
}

/// Delete the stored identity for `kind`/`label`. No-op (`Ok`) if none
/// exists. Does NOT chain a key-rotation block — that is the caller's job
/// when revoking a still-trusted identity.
pub fn delete(kind: ActorKind, label: &str) -> Result<(), AttestationError> {
    match entry(kind, label)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AttestationError::Keychain(format!("delete: {e}"))),
    }
}

/// Whether an identity is currently stored for `kind`/`label`. Useful for
/// a Settings UI to render "identity provisioned ✓" without loading the
/// secret.
pub fn exists(kind: ActorKind, label: &str) -> bool {
    matches!(load(kind, label), Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The keyring crate ships a `mock` backend, but the default-credential
    // store is process-global and not reset between tests, which makes
    // round-trip assertions against a real backend flaky in CI sandboxes
    // (no Keychain access on headless macOS runners, locked keyrings,
    // etc.). We therefore exercise the encode/decode + integrity logic
    // directly against StoredIdentity, which is the part with real
    // branching; the thin keyring get/set wrappers are covered by the
    // shared pattern in mcp_oauth.rs / brain/keychain.rs.

    fn blob_for(id: &LocalIdentity) -> String {
        let stored = StoredIdentity {
            version: STORED_VERSION,
            kind: id.kind(),
            label: id.label().to_string(),
            seed_b64: B64.encode(id.signing_key().seed_bytes()),
            nid: id.nid(),
        };
        serde_json::to_string(&stored).unwrap()
    }

    fn decode(blob: &str) -> Result<LocalIdentity, AttestationError> {
        let stored: StoredIdentity = serde_json::from_str(blob)
            .map_err(|e| AttestationError::Keychain(format!("decode: {e}")))?;
        let raw = B64
            .decode(stored.seed_b64.as_bytes())
            .map_err(|e| AttestationError::Keychain(format!("seed b64: {e}")))?;
        let seed: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
            AttestationError::Keychain(format!("seed is {} bytes, expected 32", raw.len()))
        })?;
        let id = LocalIdentity::from_key(stored.kind, stored.label, SigningKey::from_seed(seed));
        if id.nid() != stored.nid {
            return Err(AttestationError::Keychain("nid mismatch".into()));
        }
        Ok(id)
    }

    #[test]
    fn account_naming_is_kind_qualified() {
        assert_eq!(account(ActorKind::Human, "muhammed"), "human:muhammed");
        assert_eq!(account(ActorKind::Agent, "claude-code"), "agent:claude-code");
    }

    #[test]
    fn blob_round_trips_identity() {
        let id = LocalIdentity::from_seed(ActorKind::Agent, "claude-code", [9u8; 32]);
        let restored = decode(&blob_for(&id)).expect("blob decodes");
        assert_eq!(restored.kind(), id.kind());
        assert_eq!(restored.label(), id.label());
        assert_eq!(restored.nid(), id.nid());
        assert_eq!(restored.signing_key().seed_bytes(), id.signing_key().seed_bytes());
    }

    #[test]
    fn tampered_seed_fails_nid_integrity_check() {
        let id = LocalIdentity::from_seed(ActorKind::Human, "muhammed", [1u8; 32]);
        let blob = blob_for(&id);
        let mut stored: StoredIdentity = serde_json::from_str(&blob).unwrap();
        // Swap the seed for a different one but keep the original NID —
        // exactly what a tamper or storage-corruption would look like.
        stored.seed_b64 = B64.encode([2u8; 32]);
        let tampered = serde_json::to_string(&stored).unwrap();
        let err = decode(&tampered).unwrap_err();
        assert!(matches!(err, AttestationError::Keychain(_)));
    }

    #[test]
    fn wrong_length_seed_rejected() {
        let id = LocalIdentity::from_seed(ActorKind::Human, "x", [4u8; 32]);
        let mut stored: StoredIdentity = serde_json::from_str(&blob_for(&id)).unwrap();
        stored.seed_b64 = B64.encode([0u8; 16]); // too short
        let blob = serde_json::to_string(&stored).unwrap();
        assert!(decode(&blob).is_err());
    }
}
