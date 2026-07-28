//! Aura-native repo identity — the signed manifest stored at `.aura/repo.json`.
//!
//! Today a repo's cloud identity (its `room_id`) is derived from the GitHub
//! origin URL (`sha256("https://github.com/{owner}/{name}")`). That anchors
//! every repo to a GitHub name: rename the repo, move it between orgs, mirror
//! it to GitLab, or host it with no forge at all, and the identity breaks or
//! forks. It also means a repo has no identity until GitHub mints one.
//!
//! The sovereign substrate flips this: a repo owns a stable, self-minted
//! **UUID** that is signed by the repo's own Ed25519 identity key. The UUID is
//! the durable primary key; the `room_id` is derived from it (a 64-hex digest,
//! same shape the cloud already accepts) so nothing downstream needs to learn a
//! new id format. Because the signature covers the UUID *and* the derived
//! `room_id` together, neither can be swapped without re-signing with the repo
//! key — the manifest is tamper-evident and independently verifiable by anyone
//! holding only this file.
//!
//! Backward compatibility: the legacy `.aura/repo.json` carried a single
//! `{"room_id": "..."}` field, honored as an override that wins over the
//! URL-derived id. That field is kept and stays first, so a pre-UUID client
//! reads the `room_id` verbatim and a whole team still converges on one room
//! while new clients additionally verify the signed UUID.
//!
//! This module stays deliberately dependency-light: it does not generate UUIDs
//! (needs the `uuid` crate) nor hash the `room_id` (needs `sha2`). Callers that
//! already carry those crates (the CLI, the desktop shell) mint the values and
//! hand them in; this module only signs, verifies, reads, and writes.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::keys::{SigningKey, VerifyingKey};
use crate::signature::SignatureBytes;

/// Current manifest schema version. Bump when the signed payload layout
/// changes so `verify` can reject or migrate older shapes deliberately.
pub const REPO_MANIFEST_VERSION: u32 = 1;

/// Domain-separation prefix for deriving a repo's `room_id` from its UUID.
/// Callers compute `room_id = hex(sha256(ROOM_ID_DOMAIN + uuid))`. Exposed
/// here so the CLI (minting) and the shell (re-checking) derive it identically.
pub const ROOM_ID_DOMAIN: &str = "aura://repo/";

/// Relative path of the manifest inside a repo working tree.
pub const MANIFEST_REL_PATH: &[&str] = &[".aura", "repo.json"];

#[derive(Debug, Error)]
pub enum RepoIdentityError {
    #[error("manifest carries no signed repo_uuid (legacy room_id-only override)")]
    Unsigned,
    #[error("embedded pubkey is not valid base64url / not 32 bytes: {0}")]
    BadPubkey(String),
    #[error("signer key_id {claimed} does not match the embedded pubkey {derived}")]
    KeyIdMismatch { claimed: String, derived: String },
    #[error("signature is malformed: {0}")]
    BadSignature(String),
    #[error("signature does not verify against the signed payload")]
    InvalidSignature,
    #[error("io: {0}")]
    Io(String),
    #[error("json: {0}")]
    Json(String),
}

/// The `.aura/repo.json` manifest. Serialized with `room_id` first so any
/// legacy reader that only understands that one field keeps working.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepoIdentityManifest {
    /// Legacy + derived field. A pre-UUID client reads only this. For a signed
    /// manifest this equals `hex(sha256(ROOM_ID_DOMAIN + repo_uuid))`.
    #[serde(default)]
    pub room_id: String,

    /// Manifest schema version (0 for a legacy room_id-only file).
    #[serde(default)]
    pub schema_version: u32,

    /// The durable Aura-native repo identity. Canonical hyphenated UUID string.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub repo_uuid: String,

    /// `did:aura:key/…` id of the key that signed this manifest.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub signer: String,

    /// base64url (no pad) of the 32-byte Ed25519 verifying key — makes the
    /// manifest self-certifying (no key server needed to verify it).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pubkey: String,

    /// base64 (standard, no pad) of the 64-byte detached signature over
    /// [`RepoIdentityManifest::signing_payload`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sig: String,

    /// RFC3339 timestamp the manifest was minted (bound into the signature).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub created_at: String,
}

impl RepoIdentityManifest {
    /// The exact byte string covered by the signature. Newline-delimited and
    /// versioned so the layout is unambiguous and greppable. Binding both
    /// `repo_uuid` and the derived `room_id` means a tampered `room_id` (e.g.
    /// pointing a repo at someone else's room) breaks verification.
    pub fn signing_payload(&self) -> String {
        format!(
            "aura-repo-id\nv{}\n{}\n{}\n{}",
            self.schema_version, self.repo_uuid, self.room_id, self.created_at
        )
    }

    /// Build and sign a fresh manifest. `repo_uuid` and `room_id` are minted by
    /// the caller (the caller is responsible for `room_id ==
    /// hex(sha256(ROOM_ID_DOMAIN + repo_uuid))`).
    pub fn sign_new(
        repo_uuid: impl Into<String>,
        room_id: impl Into<String>,
        created_at: impl Into<String>,
        key: &SigningKey,
    ) -> Self {
        let mut m = RepoIdentityManifest {
            room_id: room_id.into(),
            schema_version: REPO_MANIFEST_VERSION,
            repo_uuid: repo_uuid.into(),
            signer: key.key_id(),
            pubkey: B64URL.encode(key.verifying_key().to_bytes()),
            sig: String::new(),
            created_at: created_at.into(),
        };
        let sig = key.sign(m.signing_payload().as_bytes());
        m.sig = sig.to_b64();
        m
    }

    /// True when the manifest carries a signed Aura-native UUID (as opposed to
    /// a legacy `room_id`-only override).
    pub fn is_signed(&self) -> bool {
        !self.repo_uuid.is_empty() && !self.sig.is_empty() && !self.pubkey.is_empty()
    }

    /// Verify the manifest end-to-end: the embedded pubkey decodes, its derived
    /// `key_id` matches the claimed `signer`, and the signature covers the
    /// canonical payload. Returns the verified key on success so callers can
    /// pin identity (e.g. check it matches the repo's expected owner).
    pub fn verify(&self) -> Result<VerifyingKey, RepoIdentityError> {
        if !self.is_signed() {
            return Err(RepoIdentityError::Unsigned);
        }
        let raw = B64URL
            .decode(self.pubkey.as_bytes())
            .map_err(|e| RepoIdentityError::BadPubkey(e.to_string()))?;
        let arr: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| RepoIdentityError::BadPubkey(format!("{} bytes, expected 32", raw.len())))?;
        let vk = VerifyingKey::from_bytes(&arr)
            .map_err(|e| RepoIdentityError::BadPubkey(e.to_string()))?;
        let derived = vk.key_id();
        if derived != self.signer {
            return Err(RepoIdentityError::KeyIdMismatch {
                claimed: self.signer.clone(),
                derived,
            });
        }
        let sig = SignatureBytes::from_b64(&self.sig)
            .map_err(|e| RepoIdentityError::BadSignature(e.to_string()))?;
        vk.verify(self.signing_payload().as_bytes(), &sig)
            .map_err(|_| RepoIdentityError::InvalidSignature)?;
        Ok(vk)
    }

    /// Absolute path of the manifest for a given repo working tree.
    pub fn path_in(repo_root: &Path) -> PathBuf {
        let mut p = repo_root.to_path_buf();
        for seg in MANIFEST_REL_PATH {
            p.push(seg);
        }
        p
    }

    /// Read + parse the manifest (no verification). Returns `Ok(None)` when the
    /// file is absent — an un-initialized repo, not an error.
    pub fn read(repo_root: &Path) -> Result<Option<Self>, RepoIdentityError> {
        let path = Self::path_in(repo_root);
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(RepoIdentityError::Io(e.to_string())),
        };
        let m: Self =
            serde_json::from_str(&raw).map_err(|e| RepoIdentityError::Json(e.to_string()))?;
        Ok(Some(m))
    }

    /// Write the manifest to `.aura/repo.json`, creating `.aura/` if needed.
    /// Pretty-printed with a trailing newline so it reviews cleanly in a diff.
    pub fn write(&self, repo_root: &Path) -> Result<(), RepoIdentityError> {
        let path = Self::path_in(repo_root);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| RepoIdentityError::Io(e.to_string()))?;
        }
        let mut body =
            serde_json::to_string_pretty(self).map_err(|e| RepoIdentityError::Json(e.to_string()))?;
        body.push('\n');
        std::fs::write(&path, body).map_err(|e| RepoIdentityError::Io(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::SigningKey;

    fn room_id_for(uuid: &str) -> String {
        // Mirror the caller-side derivation using a tiny local sha256 so the
        // test does not add a crate dep. We only need determinism here.
        use sha2_stub::sha256_hex;
        sha256_hex(format!("{ROOM_ID_DOMAIN}{uuid}").as_bytes())
    }

    // Minimal SHA-256 so the attestation crate's tests stay dependency-free.
    mod sha2_stub {
        pub fn sha256_hex(data: &[u8]) -> String {
            // FIPS 180-4 SHA-256.
            const K: [u32; 64] = [
                0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
                0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
                0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
                0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
                0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
                0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
                0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
                0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
                0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
                0xc67178f2,
            ];
            let mut h: [u32; 8] = [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ];
            let mut msg = data.to_vec();
            let bitlen = (data.len() as u64) * 8;
            msg.push(0x80);
            while msg.len() % 64 != 56 {
                msg.push(0);
            }
            msg.extend_from_slice(&bitlen.to_be_bytes());
            for chunk in msg.chunks(64) {
                let mut w = [0u32; 64];
                for i in 0..16 {
                    w[i] = u32::from_be_bytes([
                        chunk[i * 4],
                        chunk[i * 4 + 1],
                        chunk[i * 4 + 2],
                        chunk[i * 4 + 3],
                    ]);
                }
                for i in 16..64 {
                    let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                    let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                    w[i] = w[i - 16]
                        .wrapping_add(s0)
                        .wrapping_add(w[i - 7])
                        .wrapping_add(s1);
                }
                let mut v = h;
                for i in 0..64 {
                    let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
                    let ch = (v[4] & v[5]) ^ ((!v[4]) & v[6]);
                    let t1 = v[7]
                        .wrapping_add(s1)
                        .wrapping_add(ch)
                        .wrapping_add(K[i])
                        .wrapping_add(w[i]);
                    let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
                    let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
                    let t2 = s0.wrapping_add(maj);
                    v[7] = v[6];
                    v[6] = v[5];
                    v[5] = v[4];
                    v[4] = v[3].wrapping_add(t1);
                    v[3] = v[2];
                    v[2] = v[1];
                    v[1] = v[0];
                    v[0] = t1.wrapping_add(t2);
                }
                for i in 0..8 {
                    h[i] = h[i].wrapping_add(v[i]);
                }
            }
            let mut out = String::with_capacity(64);
            for word in h {
                out.push_str(&format!("{word:08x}"));
            }
            out
        }
    }

    #[test]
    fn sign_and_verify_round_trip() {
        let key = SigningKey::generate();
        let uuid = "018f9c2a-7b3d-7c00-9e1a-0123456789ab";
        let room = room_id_for(uuid);
        let m = RepoIdentityManifest::sign_new(uuid, room.clone(), "2026-07-13T00:00:00Z", &key);
        assert!(m.is_signed());
        assert_eq!(m.room_id, room);
        assert_eq!(m.schema_version, REPO_MANIFEST_VERSION);
        let vk = m.verify().expect("fresh manifest must verify");
        assert_eq!(vk.key_id(), key.key_id());
    }

    #[test]
    fn tampered_room_id_fails() {
        let key = SigningKey::generate();
        let uuid = "018f9c2a-7b3d-7c00-9e1a-0123456789ab";
        let mut m =
            RepoIdentityManifest::sign_new(uuid, room_id_for(uuid), "2026-07-13T00:00:00Z", &key);
        // Repoint the repo at a different room without re-signing.
        m.room_id = room_id_for("deadbeef-0000-7000-8000-000000000000");
        assert!(matches!(m.verify(), Err(RepoIdentityError::InvalidSignature)));
    }

    #[test]
    fn forged_signer_key_id_fails() {
        let key = SigningKey::generate();
        let uuid = "018f9c2a-7b3d-7c00-9e1a-0123456789ab";
        let mut m =
            RepoIdentityManifest::sign_new(uuid, room_id_for(uuid), "2026-07-13T00:00:00Z", &key);
        // Claim a different signer than the embedded pubkey derives.
        m.signer = "did:aura:key/AAAAAAAAAAA".to_string();
        assert!(matches!(
            m.verify(),
            Err(RepoIdentityError::KeyIdMismatch { .. })
        ));
    }

    #[test]
    fn legacy_room_id_only_is_unsigned() {
        let m = RepoIdentityManifest {
            room_id: "9cd55691794cd647f9d052354a4a0c55f9b5da7706fd780b03b9acb8cb583d70".to_string(),
            ..Default::default()
        };
        assert!(!m.is_signed());
        assert!(matches!(m.verify(), Err(RepoIdentityError::Unsigned)));
    }
}
