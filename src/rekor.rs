//! Rekor v1 transparency-log publisher + verifier for signed manifests.
//!
//! S1 sigstore-live gate: every signed `aura/manifest` (and later, every
//! signed Block / intent entry) gets a `hashedrekord` v0.0.1 entry posted
//! to a Rekor instance. We store the returned UUID + log index alongside
//! the manifest so a third party can later fetch the entry and reconstruct
//! the signature chain without trusting Aura.
//!
//! Rekor entry contract for our use (hashedrekord v0.0.1):
//!   {
//!     "kind": "hashedrekord",
//!     "apiVersion": "0.0.1",
//!     "spec": {
//!       "data": { "hash": { "algorithm": "sha256", "value": "<hex>" } },
//!       "signature": {
//!         "content": "<base64 ed25519 sig over the hash bytes>",
//!         "publicKey": { "content": "<base64 PEM-encoded ed25519 pubkey>" }
//!       }
//!     }
//!   }
//!
//! Note Rekor canonicalizes the spec server-side and computes its own
//! integrated hash; we don't precompute that. We only POST and store the
//! returned envelope.
//!
//! This module deliberately speaks raw HTTP (via reqwest::blocking) rather
//! than depending on the `sigstore-rs` crate. Reasons:
//!   - sigstore-rs pulls cosign, fulcio, OIDC dance, OpenSSL — heavy.
//!   - Our keys are ed25519 from `aura-attestation`, not OIDC-issued.
//!   - We need to support on-prem Rekor with no Fulcio (per bet doc 06).
//! When OIDC keyless signing lands (Phase B), we'll layer that on top.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub enum RekorError {
    Hash(String),
    Build(String),
    Network(String),
    Status { code: u16, body: String },
    Parse(String),
    Mismatch(String),
}

impl std::fmt::Display for RekorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Hash(e) => write!(f, "hash: {}", e),
            Self::Build(e) => write!(f, "build entry: {}", e),
            Self::Network(e) => write!(f, "network: {}", e),
            Self::Status { code, body } => write!(f, "rekor {}: {}", code, body),
            Self::Parse(e) => write!(f, "parse rekor response: {}", e),
            Self::Mismatch(e) => write!(f, "rekor entry does not match expected: {}", e),
        }
    }
}

impl std::error::Error for RekorError {}

/// What we keep alongside a signed manifest after publishing. Returned by
/// `publish_hashedrekord`; callers store this on `block.attestations` or
/// in a sidecar `manifest.rekor.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RekorEntryRef {
    /// Server-assigned UUID — primary lookup key.
    pub uuid: String,
    /// Monotonic log index (0-based). Lets verifiers spot tampering with
    /// the UUID itself.
    pub log_index: i64,
    /// Rekor base URL the entry lives in (so verify can find it later
    /// without a separate config lookup).
    pub rekor_url: String,
    /// SHA-256 hex of the canonical bytes that were hashed + signed. Lets
    /// `verify_inclusion` detect any drift between the local manifest and
    /// what was logged.
    pub sha256_hex: String,
}

/// Build the JSON body Rekor expects for a hashedrekord v0.0.1 entry.
/// Pure — no network, no I/O. Extracted so tests can assert the wire
/// shape.
pub fn build_hashedrekord_body(
    sha256_hex: &str,
    sig_b64: &str,
    pubkey_pem_b64: &str,
) -> Value {
    serde_json::json!({
        "kind": "hashedrekord",
        "apiVersion": "0.0.1",
        "spec": {
            "data": {
                "hash": {
                    "algorithm": "sha256",
                    "value": sha256_hex,
                }
            },
            "signature": {
                "content": sig_b64,
                "publicKey": {
                    "content": pubkey_pem_b64,
                }
            }
        }
    })
}

/// Compute the sha256 of the canonical bytes that we sign. Rekor stores
/// the hash, not the payload, so this is what `data.hash.value` carries.
pub fn sha256_hex(canon_bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canon_bytes);
    let digest = hasher.finalize();
    hex_lower(&digest)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Wrap the 32-byte ed25519 raw pubkey in a minimal PEM envelope. Rekor
/// validates the PEM and rejects the entry if the algo OID doesn't match
/// the signature algo. ed25519 SPKI prefix is fixed:
///   30 2a 30 05 06 03 2b 65 70 03 21 00  (12 bytes)
/// followed by the 32-byte raw key.
pub fn ed25519_pubkey_to_pem(raw: &[u8; 32]) -> String {
    use base64::Engine as _;
    let prefix: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    let mut spki = Vec::with_capacity(44);
    spki.extend_from_slice(&prefix);
    spki.extend_from_slice(raw);
    let body = base64::engine::general_purpose::STANDARD.encode(&spki);
    let mut out = String::from("-----BEGIN PUBLIC KEY-----\n");
    for chunk in body.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    out.push_str("-----END PUBLIC KEY-----\n");
    out
}

/// Base64 the raw PEM string itself for embedding in the Rekor spec.
/// Rekor wants the PEM bytes b64'd a second time inside the JSON.
pub fn pem_to_inline_b64(pem: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(pem.as_bytes())
}

/// Parse Rekor's POST /api/v1/log/entries response. The shape is:
///   { "<uuid>": { "logIndex": <int>, ... other fields ... } }
/// We pluck the first key+logIndex; spec requires exactly one entry.
pub fn parse_post_response(body: &str) -> Result<(String, i64), RekorError> {
    let v: Value = serde_json::from_str(body).map_err(|e| RekorError::Parse(e.to_string()))?;
    let obj = v
        .as_object()
        .ok_or_else(|| RekorError::Parse("response is not an object".into()))?;
    let (uuid, entry) = obj
        .iter()
        .next()
        .ok_or_else(|| RekorError::Parse("response object is empty".into()))?;
    let log_index = entry
        .get("logIndex")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| RekorError::Parse("missing logIndex".into()))?;
    Ok((uuid.clone(), log_index))
}

/// POST a signed manifest's hash + signature to Rekor's
/// `/api/v1/log/entries` endpoint. Returns the assigned UUID + log index.
///
/// This is the live path. Tests should use the lower-level
/// `build_hashedrekord_body` / `parse_post_response` helpers and a mock
/// HTTP client — see the rekor_offline tests below.
pub fn publish_hashedrekord(
    rekor_url: &str,
    canon_bytes: &[u8],
    sig_b64: &str,
    pubkey_raw: &[u8; 32],
) -> Result<RekorEntryRef, RekorError> {
    let sha = sha256_hex(canon_bytes);
    let pem = ed25519_pubkey_to_pem(pubkey_raw);
    let inline = pem_to_inline_b64(&pem);
    let body = build_hashedrekord_body(&sha, sig_b64, &inline);

    let endpoint = format!("{}/api/v1/log/entries", rekor_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| RekorError::Build(e.to_string()))?;
    let resp = client
        .post(&endpoint)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| RekorError::Build(e.to_string()))?)
        .send()
        .map_err(|e| RekorError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    let txt = resp.text().map_err(|e| RekorError::Network(e.to_string()))?;
    if !(200..300).contains(&status) {
        return Err(RekorError::Status { code: status, body: txt });
    }
    let (uuid, log_index) = parse_post_response(&txt)?;
    Ok(RekorEntryRef {
        uuid,
        log_index,
        rekor_url: rekor_url.to_string(),
        sha256_hex: sha,
    })
}

/// Fetch a Rekor entry by UUID and verify it matches what we expect.
///
/// Checks:
///   - HTTP 200
///   - response body contains the UUID we asked for
///   - logIndex matches `expected.log_index`
///   - the entry's `body.spec.data.hash.value` (after b64-decoding) matches
///     `expected.sha256_hex`
///   - the entry's `body.spec.signature.content` matches `expected_sig_b64`
///
/// Any mismatch → `RekorError::Mismatch`.
pub fn verify_inclusion(
    expected: &RekorEntryRef,
    expected_sig_b64: &str,
) -> Result<(), RekorError> {
    let endpoint = format!(
        "{}/api/v1/log/entries/{}",
        expected.rekor_url.trim_end_matches('/'),
        expected.uuid
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| RekorError::Build(e.to_string()))?;
    let resp = client
        .get(&endpoint)
        .send()
        .map_err(|e| RekorError::Network(e.to_string()))?;
    let status = resp.status().as_u16();
    let txt = resp.text().map_err(|e| RekorError::Network(e.to_string()))?;
    if !(200..300).contains(&status) {
        return Err(RekorError::Status { code: status, body: txt });
    }
    verify_fetched_entry(&txt, expected, expected_sig_b64)
}

/// Pure verification: given the JSON Rekor returned from
/// `GET /api/v1/log/entries/{uuid}`, check it matches `expected`. Split out
/// so tests can drive it offline.
pub fn verify_fetched_entry(
    fetch_body: &str,
    expected: &RekorEntryRef,
    expected_sig_b64: &str,
) -> Result<(), RekorError> {
    use base64::Engine as _;

    let v: Value = serde_json::from_str(fetch_body).map_err(|e| RekorError::Parse(e.to_string()))?;
    let obj = v
        .as_object()
        .ok_or_else(|| RekorError::Parse("response is not an object".into()))?;
    let entry = obj
        .get(&expected.uuid)
        .ok_or_else(|| RekorError::Mismatch(format!("uuid {} not in response", expected.uuid)))?;

    let log_index = entry
        .get("logIndex")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| RekorError::Parse("missing logIndex".into()))?;
    if log_index != expected.log_index {
        return Err(RekorError::Mismatch(format!(
            "logIndex {} != expected {}",
            log_index, expected.log_index
        )));
    }

    let body_b64 = entry
        .get("body")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RekorError::Parse("missing body".into()))?;
    let body_bytes = base64::engine::general_purpose::STANDARD
        .decode(body_b64)
        .map_err(|e| RekorError::Parse(format!("body b64: {}", e)))?;
    let body_json: Value = serde_json::from_slice(&body_bytes)
        .map_err(|e| RekorError::Parse(format!("body json: {}", e)))?;

    let logged_hash = body_json
        .pointer("/spec/data/hash/value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RekorError::Parse("body missing spec.data.hash.value".into()))?;
    if logged_hash != expected.sha256_hex {
        return Err(RekorError::Mismatch(format!(
            "logged hash {} != expected {}",
            logged_hash, expected.sha256_hex
        )));
    }
    let logged_sig = body_json
        .pointer("/spec/signature/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RekorError::Parse("body missing spec.signature.content".into()))?;
    if logged_sig != expected_sig_b64 {
        return Err(RekorError::Mismatch(format!(
            "logged signature differs from expected"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn sha256_hex_known_vector() {
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // sha256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn build_body_shape_matches_rekor_v0_0_1() {
        let body = build_hashedrekord_body("deadbeef", "AAAA", "PEMINLINE");
        assert_eq!(body["kind"], "hashedrekord");
        assert_eq!(body["apiVersion"], "0.0.1");
        assert_eq!(body["spec"]["data"]["hash"]["algorithm"], "sha256");
        assert_eq!(body["spec"]["data"]["hash"]["value"], "deadbeef");
        assert_eq!(body["spec"]["signature"]["content"], "AAAA");
        assert_eq!(body["spec"]["signature"]["publicKey"]["content"], "PEMINLINE");
    }

    #[test]
    fn ed25519_pem_has_correct_spki_prefix() {
        // All-zeros pubkey → known SPKI prefix bytes followed by 32 zero bytes.
        let raw = [0u8; 32];
        let pem = ed25519_pubkey_to_pem(&raw);
        assert!(pem.starts_with("-----BEGIN PUBLIC KEY-----"));
        assert!(pem.trim_end().ends_with("-----END PUBLIC KEY-----"));
        // Decode the body and check the SPKI prefix.
        let body: String = pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let decoded = base64::engine::general_purpose::STANDARD.decode(&body).unwrap();
        assert_eq!(decoded.len(), 44);
        assert_eq!(
            &decoded[0..12],
            &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]
        );
        assert_eq!(&decoded[12..], &raw);
    }

    #[test]
    fn parse_post_response_extracts_uuid_and_index() {
        let body = r#"{"24296fb24b8ad77a": {"logIndex": 42, "logID": "abc"}}"#;
        let (uuid, idx) = parse_post_response(body).unwrap();
        assert_eq!(uuid, "24296fb24b8ad77a");
        assert_eq!(idx, 42);
    }

    #[test]
    fn parse_post_response_rejects_empty_object() {
        let err = parse_post_response("{}").unwrap_err();
        assert!(matches!(err, RekorError::Parse(_)));
    }

    #[test]
    fn parse_post_response_rejects_missing_log_index() {
        let body = r#"{"abc123": {"logID": "x"}}"#;
        let err = parse_post_response(body).unwrap_err();
        assert!(matches!(err, RekorError::Parse(_)));
    }

    /// Build a fake "GET entry" response that mirrors what Rekor returns,
    /// then drive `verify_fetched_entry` through it.
    fn fake_get_response(
        uuid: &str,
        log_index: i64,
        sha256_hex_str: &str,
        sig_b64: &str,
    ) -> String {
        let inner_body = serde_json::json!({
            "kind": "hashedrekord",
            "apiVersion": "0.0.1",
            "spec": {
                "data": { "hash": { "algorithm": "sha256", "value": sha256_hex_str } },
                "signature": { "content": sig_b64, "publicKey": { "content": "PEMINLINE" } }
            }
        });
        let inner_str = serde_json::to_string(&inner_body).unwrap();
        let inner_b64 = base64::engine::general_purpose::STANDARD.encode(inner_str.as_bytes());
        serde_json::json!({
            uuid: { "logIndex": log_index, "body": inner_b64 }
        })
        .to_string()
    }

    #[test]
    fn verify_fetched_entry_accepts_matching_response() {
        let expected = RekorEntryRef {
            uuid: "u1".into(),
            log_index: 7,
            rekor_url: "http://x".into(),
            sha256_hex: "deadbeef".into(),
        };
        let body = fake_get_response("u1", 7, "deadbeef", "AAAA");
        verify_fetched_entry(&body, &expected, "AAAA").expect("matches");
    }

    #[test]
    fn verify_fetched_entry_rejects_uuid_drift() {
        let expected = RekorEntryRef {
            uuid: "u1".into(),
            log_index: 7,
            rekor_url: "http://x".into(),
            sha256_hex: "deadbeef".into(),
        };
        let body = fake_get_response("u2", 7, "deadbeef", "AAAA");
        let err = verify_fetched_entry(&body, &expected, "AAAA").unwrap_err();
        assert!(matches!(err, RekorError::Mismatch(_)));
    }

    #[test]
    fn verify_fetched_entry_rejects_log_index_drift() {
        let expected = RekorEntryRef {
            uuid: "u1".into(),
            log_index: 7,
            rekor_url: "http://x".into(),
            sha256_hex: "deadbeef".into(),
        };
        let body = fake_get_response("u1", 999, "deadbeef", "AAAA");
        let err = verify_fetched_entry(&body, &expected, "AAAA").unwrap_err();
        assert!(matches!(err, RekorError::Mismatch(_)));
    }

    #[test]
    fn verify_fetched_entry_rejects_hash_drift() {
        let expected = RekorEntryRef {
            uuid: "u1".into(),
            log_index: 7,
            rekor_url: "http://x".into(),
            sha256_hex: "deadbeef".into(),
        };
        let body = fake_get_response("u1", 7, "feedface", "AAAA");
        let err = verify_fetched_entry(&body, &expected, "AAAA").unwrap_err();
        assert!(matches!(err, RekorError::Mismatch(_)));
    }

    #[test]
    fn verify_fetched_entry_rejects_signature_drift() {
        let expected = RekorEntryRef {
            uuid: "u1".into(),
            log_index: 7,
            rekor_url: "http://x".into(),
            sha256_hex: "deadbeef".into(),
        };
        let body = fake_get_response("u1", 7, "deadbeef", "BBBB");
        let err = verify_fetched_entry(&body, &expected, "AAAA").unwrap_err();
        assert!(matches!(err, RekorError::Mismatch(_)));
    }

    #[test]
    fn pem_to_inline_b64_idempotent_decode() {
        let pem = ed25519_pubkey_to_pem(&[0u8; 32]);
        let inline = pem_to_inline_b64(&pem);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&inline)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), pem);
    }
}
