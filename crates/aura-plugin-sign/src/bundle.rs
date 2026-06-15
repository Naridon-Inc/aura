//! Sign + verify whole bundles, and the status enum consumers render.

use std::fs;
use std::io;
use std::path::Path;

use aura_attestation::{SignatureBytes, SigningKey};
use serde_json::Value;

use crate::digest::{bundle_digest, PLUGIN_MANIFEST};
use crate::trust::TrustStore;

/// The only algorithm v1 supports. Mirrors aura-attestation's choice
/// for block provenance.
pub const ED25519_ALGORITHM: &str = "ed25519";

/// What verification concluded about a bundle. `Invalid` is the only
/// state callers must fail closed on — the bundle claims a known
/// publisher but the bytes don't match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureStatus {
    /// No `signature` field in the manifest (or no plugin manifest in
    /// the bundle at all). Loads with an "unsigned" badge.
    Unsigned,
    /// Signature verifies against a key in the trust store.
    Verified { publisher_key_id: String, publisher: String },
    /// Signature present but the key id isn't in this machine's trust
    /// store — we cannot check it either way. Loads with an
    /// "unverified publisher" badge.
    UnknownKey { publisher_key_id: String },
    /// Signature present, key known, bytes DON'T match — tampered or
    /// corrupted. Callers must refuse to load the bundle.
    Invalid { reason: String },
}

#[derive(Debug)]
pub enum SignError {
    Io(io::Error),
    /// The manifest is missing or not a JSON object.
    Manifest(String),
}

impl std::fmt::Display for SignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SignError::Io(e) => write!(f, "io: {e}"),
            SignError::Manifest(s) => write!(f, "manifest: {s}"),
        }
    }
}

impl std::error::Error for SignError {}

impl From<io::Error> for SignError {
    fn from(e: io::Error) -> Self {
        SignError::Io(e)
    }
}

/// Sign the bundle at `dir` and embed the signature into its
/// `aura.plugin.json` (pretty-printed, trailing newline). The digest
/// excludes the `signature` field, so embedding it doesn't invalidate
/// what was just signed.
///
/// Works on `serde_json::Value`, not the typed manifest — signing must
/// never silently drop fields this crate doesn't know about.
pub fn sign_bundle(dir: &Path, key: &SigningKey) -> Result<SignatureStatus, SignError> {
    let manifest_path = dir.join(PLUGIN_MANIFEST);
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| SignError::Manifest(format!("{}: {e}", manifest_path.display())))?;
    let mut manifest: Value =
        serde_json::from_str(&raw).map_err(|e| SignError::Manifest(e.to_string()))?;
    let Some(obj) = manifest.as_object_mut() else {
        return Err(SignError::Manifest("aura.plugin.json must be a JSON object".into()));
    };
    // Strip any stale signature before digesting (digest ignores the
    // field anyway, but a half-replaced object would be confusing on
    // disk if the write below fails midway).
    obj.remove("signature");

    let digest = bundle_digest(dir)?;
    let sig = key.sign(&digest);
    let key_id = key.key_id();

    obj.insert(
        "signature".to_string(),
        serde_json::json!({
            "algorithm": ED25519_ALGORITHM,
            "publisher_key_id": key_id,
            "signature": sig.to_b64(),
        }),
    );
    let body = serde_json::to_string_pretty(&manifest).expect("manifest serializes");
    fs::write(&manifest_path, format!("{body}\n"))?;

    Ok(SignatureStatus::Verified {
        publisher_key_id: key_id,
        publisher: "(self)".to_string(),
    })
}

/// Verify the bundle at `dir` against a trust store. IO/parse problems
/// on a bundle that *claims* a signature are `Invalid` (fail closed);
/// a missing plugin manifest or absent signature field is `Unsigned`.
pub fn verify_bundle(dir: &Path, trust: &TrustStore) -> SignatureStatus {
    let manifest_path = dir.join(PLUGIN_MANIFEST);
    let raw = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        // No plugin manifest in this bundle (skill/MCP-only) — nothing
        // can carry a signature yet.
        Err(e) if e.kind() == io::ErrorKind::NotFound => return SignatureStatus::Unsigned,
        Err(e) => return SignatureStatus::Invalid { reason: format!("read manifest: {e}") },
    };
    let manifest: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return SignatureStatus::Invalid { reason: format!("parse manifest: {e}") },
    };
    let Some(sig_obj) = manifest.get("signature") else {
        return SignatureStatus::Unsigned;
    };

    let algorithm = sig_obj.get("algorithm").and_then(Value::as_str).unwrap_or("");
    let key_id = sig_obj
        .get("publisher_key_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let sig_b64 = sig_obj.get("signature").and_then(Value::as_str).unwrap_or("");

    if algorithm != ED25519_ALGORITHM {
        return SignatureStatus::Invalid {
            reason: format!("unsupported signature algorithm `{algorithm}`"),
        };
    }
    if key_id.is_empty() || sig_b64.is_empty() {
        return SignatureStatus::Invalid {
            reason: "signature object is missing publisher_key_id or signature".into(),
        };
    }

    let Some((verifying_key, publisher)) = trust.find(&key_id) else {
        return SignatureStatus::UnknownKey { publisher_key_id: key_id };
    };

    let sig = match SignatureBytes::from_b64(sig_b64) {
        Ok(s) => s,
        Err(e) => return SignatureStatus::Invalid { reason: format!("signature encoding: {e}") },
    };
    let digest = match bundle_digest(dir) {
        Ok(d) => d,
        Err(e) => return SignatureStatus::Invalid { reason: format!("digest: {e}") },
    };
    match verifying_key.verify(&digest, &sig) {
        Ok(()) => SignatureStatus::Verified { publisher_key_id: key_id, publisher },
        Err(_) => SignatureStatus::Invalid {
            reason: "bundle contents do not match the publisher signature".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trust::TrustStore;

    fn write_bundle(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join(PLUGIN_MANIFEST),
            r#"{"id": "@t/x", "version": "0.1.0", "entry": "worker.js", "capabilities": ["ui:toast"]}"#,
        )
        .unwrap();
        fs::write(dir.join("worker.js"), "console.log('hi')\n").unwrap();
    }

    fn trusted(key: &SigningKey, publisher: &str) -> TrustStore {
        let mut store = TrustStore::default();
        store.add_key(&key.verifying_key(), publisher);
        store
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let key = SigningKey::generate();
        sign_bundle(tmp.path(), &key).unwrap();

        let status = verify_bundle(tmp.path(), &trusted(&key, "acme"));
        assert_eq!(
            status,
            SignatureStatus::Verified {
                publisher_key_id: key.key_id(),
                publisher: "acme".to_string()
            }
        );
    }

    #[test]
    fn unsigned_bundle_reports_unsigned() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        assert_eq!(verify_bundle(tmp.path(), &TrustStore::default()), SignatureStatus::Unsigned);
    }

    #[test]
    fn unknown_key_is_not_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let key = SigningKey::generate();
        sign_bundle(tmp.path(), &key).unwrap();
        // Empty trust store — signature can't be checked either way.
        match verify_bundle(tmp.path(), &TrustStore::default()) {
            SignatureStatus::UnknownKey { publisher_key_id } => {
                assert_eq!(publisher_key_id, key.key_id())
            }
            other => panic!("expected UnknownKey, got {other:?}"),
        }
    }

    #[test]
    fn tampered_file_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let key = SigningKey::generate();
        sign_bundle(tmp.path(), &key).unwrap();
        fs::write(tmp.path().join("worker.js"), "console.log('evil')\n").unwrap();
        assert!(matches!(
            verify_bundle(tmp.path(), &trusted(&key, "acme")),
            SignatureStatus::Invalid { .. }
        ));
    }

    #[test]
    fn tampered_capabilities_are_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let key = SigningKey::generate();
        sign_bundle(tmp.path(), &key).unwrap();
        // Escalate capabilities post-signing, preserving the signature.
        let raw = fs::read_to_string(tmp.path().join(PLUGIN_MANIFEST)).unwrap();
        let escalated = raw.replace("ui:toast", "fs:read:**");
        fs::write(tmp.path().join(PLUGIN_MANIFEST), escalated).unwrap();
        assert!(matches!(
            verify_bundle(tmp.path(), &trusted(&key, "acme")),
            SignatureStatus::Invalid { .. }
        ));
    }

    #[test]
    fn resigning_after_edit_re_verifies() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let key = SigningKey::generate();
        sign_bundle(tmp.path(), &key).unwrap();
        fs::write(tmp.path().join("worker.js"), "console.log('v2')\n").unwrap();
        sign_bundle(tmp.path(), &key).unwrap();
        assert!(matches!(
            verify_bundle(tmp.path(), &trusted(&key, "acme")),
            SignatureStatus::Verified { .. }
        ));
    }

    #[test]
    fn wrong_algorithm_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let key = SigningKey::generate();
        sign_bundle(tmp.path(), &key).unwrap();
        let raw = fs::read_to_string(tmp.path().join(PLUGIN_MANIFEST)).unwrap();
        let swapped = raw.replace("ed25519", "rsa-pss");
        fs::write(tmp.path().join(PLUGIN_MANIFEST), swapped).unwrap();
        assert!(matches!(
            verify_bundle(tmp.path(), &trusted(&key, "acme")),
            SignatureStatus::Invalid { .. }
        ));
    }
}
