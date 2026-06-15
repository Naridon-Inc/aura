//! Publisher trust store — which ed25519 public keys this machine
//! accepts plugin signatures from.
//!
//! Lives OUTSIDE the plugin install root (`~/.aura/plugin-trust.json`,
//! not `~/.aura/plugins/…`) so a malicious bundle install can never
//! smuggle a key into the store it is judged against.
//!
//! `aura plugin keygen` adds your own dev key here automatically;
//! `aura plugin trust --publisher X --public-key <b64>` adds a
//! teammate's. There is deliberately no remote-fetch path in this crate
//! — distribution of keys is a human/marketplace decision, not a
//! library one.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use aura_attestation::VerifyingKey;
use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedKey {
    /// `did:aura:key/<b64url-first-8>` — derived from the public key,
    /// matches `Signature.publisher_key_id` in plugin manifests.
    pub key_id: String,
    /// Human label shown next to the verified badge ("aura", "acme").
    pub publisher: String,
    /// Standard-base64 32-byte ed25519 public key.
    pub public_key_b64: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrustStore {
    #[serde(default)]
    pub keys: Vec<TrustedKey>,
}

impl TrustStore {
    /// `~/.aura/plugin-trust.json`. Falls back to a relative path when
    /// `$HOME` is undiscoverable (CI sandboxes) — same convention as
    /// the plugin registry's install root.
    pub fn default_path() -> PathBuf {
        match std::env::var_os("HOME").map(PathBuf::from) {
            Some(home) => home.join(".aura").join("plugin-trust.json"),
            None => PathBuf::from(".aura").join("plugin-trust.json"),
        }
    }

    /// Missing file = empty store (first run). A malformed file is an
    /// error — silently treating a corrupt trust store as empty would
    /// downgrade every verified plugin to "unknown key" without a word.
    pub fn load(path: &Path) -> Result<Self, io::Error> {
        let raw = match fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e),
        };
        serde_json::from_slice(&raw)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("{}: {e}", path.display())))
    }

    pub fn save(&self, path: &Path) -> Result<(), io::Error> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_vec_pretty(self).expect("trust store serializes");
        fs::write(path, body)
    }

    /// Add (or relabel) a key. Dedupes by key id, so re-running
    /// `aura plugin keygen` is idempotent.
    pub fn add_key(&mut self, key: &VerifyingKey, publisher: &str) -> TrustedKey {
        let entry = TrustedKey {
            key_id: key.key_id(),
            publisher: publisher.to_string(),
            public_key_b64: base64::engine::general_purpose::STANDARD.encode(key.to_bytes()),
        };
        if let Some(existing) = self.keys.iter_mut().find(|k| k.key_id == entry.key_id) {
            existing.publisher = entry.publisher.clone();
            existing.public_key_b64 = entry.public_key_b64.clone();
        } else {
            self.keys.push(entry.clone());
        }
        entry
    }

    /// Look up a verifying key by id. Returns the parsed key plus the
    /// publisher label for display.
    pub fn find(&self, key_id: &str) -> Option<(VerifyingKey, String)> {
        let entry = self.keys.iter().find(|k| k.key_id == key_id)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&entry.public_key_b64)
            .ok()?;
        let arr: [u8; 32] = bytes.try_into().ok()?;
        let key = VerifyingKey::from_bytes(&arr).ok()?;
        Some((key, entry.publisher.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_attestation::SigningKey;

    #[test]
    fn roundtrips_through_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("trust.json");
        let key = SigningKey::generate();
        let mut store = TrustStore::default();
        store.add_key(&key.verifying_key(), "acme");
        store.save(&path).unwrap();

        let loaded = TrustStore::load(&path).unwrap();
        let (vk, publisher) = loaded.find(&key.key_id()).expect("key present");
        assert_eq!(publisher, "acme");
        assert_eq!(vk.to_bytes(), key.verifying_key().to_bytes());
    }

    #[test]
    fn missing_file_is_empty_store() {
        let store = TrustStore::load(Path::new("/nonexistent/trust.json")).unwrap();
        assert!(store.keys.is_empty());
    }

    #[test]
    fn malformed_file_is_an_error_not_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("trust.json");
        std::fs::write(&path, "{not json").unwrap();
        assert!(TrustStore::load(&path).is_err());
    }

    #[test]
    fn add_key_is_idempotent_and_relabels() {
        let key = SigningKey::generate();
        let mut store = TrustStore::default();
        store.add_key(&key.verifying_key(), "old");
        store.add_key(&key.verifying_key(), "new");
        assert_eq!(store.keys.len(), 1);
        assert_eq!(store.keys[0].publisher, "new");
    }
}
