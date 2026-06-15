//! `aura/manifest` signature envelope — sign & verify per the S1-S protocol
//! agreed with feat+aura-terminal (see `.aura/handover-s1-coordination.md`).
//!
//! Protocol:
//!   1. Set `m["signature"] = Value::Null`
//!   2. `canon = aura_blocks::canonicalize(&m)` (RFC 8785 JCS)
//!   3. `sig = SigningKey::sign(&canon)`
//!   4. `m["signature"] = { algo, key_id, sig_b64, canonicalization }`
//!
//! Verify runs the same sequence in reverse: null the signature field before
//! re-canonicalizing so signer and verifier compute identical bytes.
//!
//! The manifest-envelope is 4-field; `aura_blocks::Signature` is 3-field
//! (no `canonicalization` tag) because a Block carries `schema_version` on
//! the outer envelope and a manifest does not. Asymmetry is intentional for
//! v1; when jcs-rfc8785-v2 lands, Block's Signature grows the field.

use aura_attestation::{SignatureBytes, SigningKey, VerifyingKey};
use aura_blocks::canonicalize;
use serde_json::{json, Value};

pub const CANON_TAG: &str = "jcs-rfc8785-v1";
pub const SIG_ALGO: &str = "ed25519";

#[derive(Debug)]
pub enum ManifestSigError {
    NoSignatureField,
    SignatureIsNull,
    MissingEnvelopeField(&'static str),
    UnsupportedAlgo(String),
    UnsupportedCanonTag(String),
    KeyIdMismatch { claimed: String, supplied: String },
    BadSignatureB64(String),
    Canonicalize(String),
    Verify(String),
}

impl std::fmt::Display for ManifestSigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSignatureField => write!(f, "no signature field"),
            Self::SignatureIsNull => write!(f, "signature field is null"),
            Self::MissingEnvelopeField(k) => write!(f, "missing envelope field: {}", k),
            Self::UnsupportedAlgo(a) => write!(f, "unsupported algo: {}", a),
            Self::UnsupportedCanonTag(t) => write!(f, "unsupported canonicalization tag: {}", t),
            Self::KeyIdMismatch { claimed, supplied } => {
                write!(f, "key_id mismatch: claimed {} supplied {}", claimed, supplied)
            }
            Self::BadSignatureB64(e) => write!(f, "sig b64: {}", e),
            Self::Canonicalize(e) => write!(f, "canonicalize: {}", e),
            Self::Verify(e) => write!(f, "verify: {}", e),
        }
    }
}

impl std::error::Error for ManifestSigError {}

pub fn sign_manifest(mut m: Value, key: &SigningKey) -> Result<Value, ManifestSigError> {
    m["signature"] = Value::Null;
    let canon = canonicalize(&m).map_err(|e| ManifestSigError::Canonicalize(e.to_string()))?;
    let sig = key.sign(&canon);
    m["signature"] = json!({
        "algo": SIG_ALGO,
        "key_id": key.key_id(),
        "sig_b64": sig.to_b64(),
        "canonicalization": CANON_TAG,
    });
    Ok(m)
}

pub fn verify_manifest(m: &Value, pubkey: &VerifyingKey) -> Result<(), ManifestSigError> {
    let sig_env = m.get("signature").ok_or(ManifestSigError::NoSignatureField)?;
    if sig_env.is_null() {
        return Err(ManifestSigError::SignatureIsNull);
    }
    let algo = sig_env
        .get("algo")
        .and_then(|v| v.as_str())
        .ok_or(ManifestSigError::MissingEnvelopeField("algo"))?;
    if algo != SIG_ALGO {
        return Err(ManifestSigError::UnsupportedAlgo(algo.to_string()));
    }
    let canon_tag = sig_env
        .get("canonicalization")
        .and_then(|v| v.as_str())
        .ok_or(ManifestSigError::MissingEnvelopeField("canonicalization"))?;
    if canon_tag != CANON_TAG {
        return Err(ManifestSigError::UnsupportedCanonTag(canon_tag.to_string()));
    }
    let claimed_key_id = sig_env
        .get("key_id")
        .and_then(|v| v.as_str())
        .ok_or(ManifestSigError::MissingEnvelopeField("key_id"))?;
    if claimed_key_id != pubkey.key_id() {
        return Err(ManifestSigError::KeyIdMismatch {
            claimed: claimed_key_id.to_string(),
            supplied: pubkey.key_id(),
        });
    }
    let sig_b64 = sig_env
        .get("sig_b64")
        .and_then(|v| v.as_str())
        .ok_or(ManifestSigError::MissingEnvelopeField("sig_b64"))?;
    let sig_bytes = SignatureBytes::from_b64(sig_b64)
        .map_err(|e| ManifestSigError::BadSignatureB64(e.to_string()))?;

    let mut probe = m.clone();
    probe["signature"] = Value::Null;
    let canon = canonicalize(&probe).map_err(|e| ManifestSigError::Canonicalize(e.to_string()))?;

    pubkey
        .verify(&canon, &sig_bytes)
        .map_err(|e| ManifestSigError::Verify(e.to_string()))
}

/// Resolve the local signing key path. Matches aura-term's resolver via
/// `directories::ProjectDirs` so blocks and manifests sign under the same
/// did:aura identity — one private key per machine.
/// - macOS → `~/Library/Application Support/aura/signing.key`
/// - Linux → XDG `data_dir` / `signing.key`
pub fn default_signing_key_path() -> Result<std::path::PathBuf, String> {
    let dirs = directories::ProjectDirs::from("", "", "aura")
        .ok_or_else(|| "failed to resolve aura ProjectDirs".to_string())?;
    std::fs::create_dir_all(dirs.data_dir()).map_err(|e| format!("mkdir data_dir: {}", e))?;
    Ok(dirs.data_dir().join("signing.key"))
}

/// Read-only health probe for the local signing key. Single source of truth
/// shared by the MCP `aura_status` `signing` block, the `aura doctor`
/// "Signing key" line, and the `aura keys sigstore-status` CLI subcommand —
/// so all three surfaces report the same diagnosis from the same code.
///
/// Strictly read-only: uses `aura_attestation::load_signing_key` (NOT
/// `load_or_create`) so observation never side-effects key creation.
/// Only an explicit sign-bearing operation (`aura_log_intent`, manifest
/// sign, etc.) is allowed to mint a key.
///
/// Returns one of:
///   { status: "ok",         key_id: "did:aura:key/<b64>", key_path: "..." }
///   { status: "missing",    key_path: "...", hint: "..." }
///   { status: "unreadable", key_path: "...", error: "...", hint: "..." }
///   { status: "no_path",    error: "...", hint: "..." }
pub fn signing_health() -> Value {
    let key_path = match default_signing_key_path() {
        Ok(p) => p,
        Err(e) => {
            return json!({
                "status": "no_path",
                "error": e,
                "hint": "Set $HOME or pass --key-path explicitly to sign-bearing commands.",
            });
        }
    };
    if !key_path.exists() {
        return json!({
            "status": "missing",
            "key_path": key_path.display().to_string(),
            "hint": "No signing key on disk yet. The next aura_log_intent or manifest sign will mint one.",
        });
    }
    match aura_attestation::load_signing_key(&key_path) {
        Ok(key) => json!({
            "status": "ok",
            "key_id": key.key_id(),
            "key_path": key_path.display().to_string(),
        }),
        Err(e) => json!({
            "status": "unreadable",
            "key_path": key_path.display().to_string(),
            "error": format!("{e}"),
            "hint": "Keyfile exists but can't be parsed. Inspect permissions or rotate via `aura keys sigstore-rotate`.",
        }),
    }
}

/// CLI entry point for `aura keys sigstore-status [--json]`. Wraps the
/// shared `signing_health` probe with text-or-JSON rendering and an
/// exit-code contract: exits 0 on `ok`, 1 on missing/unreadable/no_path.
/// Scripted callers can use `--json` to get the same payload shape the
/// MCP `aura_status.signing` block returns; in JSON mode the payload is
/// the only thing on stdout (no trailing dispatch lines), so jq pipes
/// stay clean.
///
/// Returns `Result` to keep the dispatch signature in main.rs uniform,
/// but uses `std::process::exit` for non-ok statuses so the dispatch's
/// generic `✗ {e}` print never pollutes the JSON output. Always returns
/// `Ok(())` from the function body — non-ok paths exit before returning.
pub fn signing_status_cli(json: bool) -> Result<(), String> {
    let v = signing_health();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".into())
        );
    }
    let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
    let path = v.get("key_path").and_then(|s| s.as_str()).unwrap_or("");
    let hint = v.get("hint").and_then(|s| s.as_str()).unwrap_or("");
    match status {
        "ok" => {
            if !json {
                let key_id = v.get("key_id").and_then(|s| s.as_str()).unwrap_or("");
                println!("✓ signing key healthy");
                println!("  key_id:   {}", key_id);
                println!("  key_path: {}", path);
            }
            Ok(())
        }
        "missing" => {
            if !json {
                println!("ℹ no signing key on disk yet");
                println!("  key_path: {}", path);
                if !hint.is_empty() {
                    println!("  hint:     {}", hint);
                }
            }
            std::process::exit(1);
        }
        "unreadable" => {
            let err = v.get("error").and_then(|s| s.as_str()).unwrap_or("?");
            if !json {
                eprintln!("✗ signing key unreadable");
                eprintln!("  key_path: {}", path);
                eprintln!("  error:    {}", err);
                if !hint.is_empty() {
                    eprintln!("  hint:     {}", hint);
                }
            }
            std::process::exit(1);
        }
        "no_path" => {
            let err = v.get("error").and_then(|s| s.as_str()).unwrap_or("?");
            if !json {
                eprintln!("✗ signing key path unresolved");
                eprintln!("  error: {}", err);
                if !hint.is_empty() {
                    eprintln!("  hint:  {}", hint);
                }
            }
            std::process::exit(1);
        }
        other => {
            eprintln!("✗ unexpected signing_health status: {}", other);
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_manifest() -> Value {
        json!({
            "protocolVersion": "2024-11-05",
            "serverInfo": { "name": "aura-semantic-vcs", "version": "1.0.0" },
            "tools": [
                {
                    "name": "aura_status",
                    "description": "Check semantic status.",
                    "inputSchema": { "type": "object", "properties": {} }
                }
            ],
            "signature": null
        })
    }

    #[test]
    fn round_trip() {
        let key = SigningKey::generate();
        let signed = sign_manifest(sample_manifest(), &key).expect("sign");
        verify_manifest(&signed, &key.verifying_key()).expect("verify");
    }

    #[test]
    fn tool_body_tamper_fails() {
        let key = SigningKey::generate();
        let signed = sign_manifest(sample_manifest(), &key).expect("sign");
        let mut tampered = signed.clone();
        tampered["tools"][0]["description"] = json!("tampered");
        assert!(verify_manifest(&tampered, &key.verifying_key()).is_err());
    }

    #[test]
    fn sig_tamper_fails() {
        let key = SigningKey::generate();
        let signed = sign_manifest(sample_manifest(), &key).expect("sign");
        let mut tampered = signed.clone();
        let orig = tampered["signature"]["sig_b64"].as_str().unwrap().to_string();
        let mut bytes = orig.into_bytes();
        bytes[0] = if bytes[0] == b'A' { b'B' } else { b'A' };
        tampered["signature"]["sig_b64"] = json!(String::from_utf8(bytes).unwrap());
        assert!(verify_manifest(&tampered, &key.verifying_key()).is_err());
    }

    #[test]
    fn wrong_key_rejected() {
        let key1 = SigningKey::generate();
        let key2 = SigningKey::generate();
        let signed = sign_manifest(sample_manifest(), &key1).expect("sign");
        assert!(matches!(
            verify_manifest(&signed, &key2.verifying_key()),
            Err(ManifestSigError::KeyIdMismatch { .. })
        ));
    }

    #[test]
    fn null_signature_rejected() {
        let key = SigningKey::generate();
        let mut m = sample_manifest();
        m["signature"] = Value::Null;
        assert!(matches!(
            verify_manifest(&m, &key.verifying_key()),
            Err(ManifestSigError::SignatureIsNull)
        ));
    }

    #[test]
    fn wrong_algo_rejected() {
        let key = SigningKey::generate();
        let mut signed = sign_manifest(sample_manifest(), &key).expect("sign");
        signed["signature"]["algo"] = json!("rsa-pss");
        assert!(matches!(
            verify_manifest(&signed, &key.verifying_key()),
            Err(ManifestSigError::UnsupportedAlgo(_))
        ));
    }

    #[test]
    fn wrong_canon_tag_rejected() {
        let key = SigningKey::generate();
        let mut signed = sign_manifest(sample_manifest(), &key).expect("sign");
        signed["signature"]["canonicalization"] = json!("jcs-rfc8785-v99");
        assert!(matches!(
            verify_manifest(&signed, &key.verifying_key()),
            Err(ManifestSigError::UnsupportedCanonTag(_))
        ));
    }

    #[test]
    fn missing_sig_b64_rejected() {
        let key = SigningKey::generate();
        let mut signed = sign_manifest(sample_manifest(), &key).expect("sign");
        signed["signature"]
            .as_object_mut()
            .unwrap()
            .remove("sig_b64");
        assert!(matches!(
            verify_manifest(&signed, &key.verifying_key()),
            Err(ManifestSigError::MissingEnvelopeField("sig_b64"))
        ));
    }

    #[test]
    fn missing_key_id_rejected() {
        let key = SigningKey::generate();
        let mut signed = sign_manifest(sample_manifest(), &key).expect("sign");
        signed["signature"]
            .as_object_mut()
            .unwrap()
            .remove("key_id");
        assert!(matches!(
            verify_manifest(&signed, &key.verifying_key()),
            Err(ManifestSigError::MissingEnvelopeField("key_id"))
        ));
    }

    #[test]
    fn malformed_sig_b64_rejected() {
        let key = SigningKey::generate();
        let mut signed = sign_manifest(sample_manifest(), &key).expect("sign");
        signed["signature"]["sig_b64"] = json!("not@valid@base64!!");
        assert!(matches!(
            verify_manifest(&signed, &key.verifying_key()),
            Err(ManifestSigError::BadSignatureB64(_))
        ));
    }

    #[test]
    fn no_signature_field_rejected() {
        let key = SigningKey::generate();
        let m = json!({
            "protocolVersion": "2024-11-05",
            "tools": []
        });
        assert!(matches!(
            verify_manifest(&m, &key.verifying_key()),
            Err(ManifestSigError::NoSignatureField)
        ));
    }

    /// Canonical round-trip determinism: same manifest + same key must
    /// produce byte-identical signatures across calls. Proves the
    /// canonicalization step is pure and the signer is deterministic.
    #[test]
    fn sign_is_deterministic() {
        let key = SigningKey::generate();
        let signed_a = sign_manifest(sample_manifest(), &key).expect("sign a");
        let signed_b = sign_manifest(sample_manifest(), &key).expect("sign b");
        assert_eq!(
            signed_a["signature"]["sig_b64"], signed_b["signature"]["sig_b64"],
            "identical manifest + key must produce identical signatures"
        );
    }

    /// Manifest carrying extra top-level fields still verifies cleanly —
    /// proves the canonicalization doesn't depend on field-count
    /// assumptions.
    #[test]
    fn extra_fields_preserved_through_sign_verify() {
        let key = SigningKey::generate();
        let mut m = sample_manifest();
        m["x-aura-ext"] = json!({ "capability": "semantic-vcs", "ver": 1 });
        let signed = sign_manifest(m, &key).expect("sign");
        verify_manifest(&signed, &key.verifying_key()).expect("verify");
        assert_eq!(signed["x-aura-ext"]["ver"], json!(1));
    }
}
