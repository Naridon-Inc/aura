//! Capability-token auth for the Aura node (P2b).
//!
//! A capability token is a small, signed grant that says "the bearer may
//! `read` and/or `push` repo `<id>` on the node whose key is `<issuer>`, until
//! `<exp>`." The node **issues** tokens with its own identity key (the same
//! Ed25519 key that signs the ref-log) and **verifies** them with the matching
//! public key, so the trust anchor is entirely self-contained — no external
//! auth server, no shared secret to leak.
//!
//! Wire format is three URL-safe base64 segments so the token drops cleanly
//! into either an `Authorization` header or a URL's userinfo:
//!
//! ```text
//! auracap1.<b64url(payload-json)>.<b64url(64-byte-signature)>
//! ```
//!
//! The signature covers the exact payload bytes that are transmitted (the
//! decoded middle segment), so verification never depends on re-serializing the
//! JSON identically.
//!
//! Client side, the token rides standard git auth: put it in the URL
//! (`aura://x-access-token:<token>@host/<id>`) or supply it when git prompts —
//! git sends it as HTTP Basic auth, exactly like a GitHub PAT. `Authorization:
//! Bearer <token>` is accepted too.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use aura_attestation::{SignatureBytes, SigningKey, VerifyingKey};

/// Token wire-format version tag / first segment.
pub const TOKEN_PREFIX: &str = "auracap1";
/// Capability: clone/fetch (git upload-pack).
pub const CAP_READ: &str = "read";
/// Capability: push (git receive-pack). A push grant implies read.
pub const CAP_PUSH: &str = "push";
/// Repo scope that matches every repo hosted on the node.
pub const SCOPE_ALL: &str = "*";

/// The signed body of a capability token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityToken {
    /// Schema version (currently 1).
    pub schema_version: u32,
    /// Repo id this token is scoped to, or `*` for any repo on the node.
    pub repo_id: String,
    /// Granted capabilities (`read`, `push`).
    pub caps: Vec<String>,
    /// Issued-at (unix seconds).
    pub iat: i64,
    /// Expiry (unix seconds); `0` means the token never expires.
    pub exp: i64,
    /// `did:aura:key/…` id of the node key that signed this token.
    pub issuer: String,
}

impl CapabilityToken {
    /// Build a token granting `caps` on `repo_id` (`*` for all repos), issued
    /// now and valid for `ttl_secs` seconds (`0` = no expiry).
    pub fn new(repo_id: impl Into<String>, caps: Vec<String>, now: i64, ttl_secs: i64) -> Self {
        let exp = if ttl_secs <= 0 { 0 } else { now + ttl_secs };
        CapabilityToken {
            schema_version: 1,
            repo_id: repo_id.into(),
            caps,
            iat: now,
            exp,
            issuer: String::new(),
        }
    }

    /// Sign this token with the node key and encode it to its wire form. The
    /// issuer is stamped from the key id.
    pub fn issue(mut self, key: &SigningKey) -> Result<String, String> {
        self.issuer = key.key_id();
        let payload =
            serde_json::to_vec(&self).map_err(|e| format!("encode token payload: {e}"))?;
        let sig = key.sign(&payload);
        Ok(format!(
            "{TOKEN_PREFIX}.{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            URL_SAFE_NO_PAD.encode(sig.as_bytes())
        ))
    }

    /// Parse a wire token and verify its signature against `vkey`, additionally
    /// requiring the embedded issuer to match `vkey`'s id. Does **not** check
    /// expiry or scope — call [`CapabilityToken::authorizes`] for that.
    pub fn parse_and_verify(token: &str, vkey: &VerifyingKey) -> Result<CapabilityToken, String> {
        let mut parts = token.trim().splitn(3, '.');
        let prefix = parts.next().unwrap_or("");
        if prefix != TOKEN_PREFIX {
            return Err(format!("not an Aura capability token (bad prefix '{prefix}')"));
        }
        let payload_b64 = parts.next().ok_or("token missing payload segment")?;
        let sig_b64 = parts.next().ok_or("token missing signature segment")?;

        let payload = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|e| format!("token payload not base64url: {e}"))?;
        let sig_bytes = URL_SAFE_NO_PAD
            .decode(sig_b64)
            .map_err(|e| format!("token signature not base64url: {e}"))?;
        let sig_arr: [u8; 64] = sig_bytes
            .as_slice()
            .try_into()
            .map_err(|_| "token signature is not 64 bytes".to_string())?;

        vkey.verify(&payload, &SignatureBytes(sig_arr))
            .map_err(|_| "token signature does not verify".to_string())?;

        let tok: CapabilityToken =
            serde_json::from_slice(&payload).map_err(|e| format!("decode token payload: {e}"))?;
        if tok.issuer != vkey.key_id() {
            return Err(format!(
                "token issuer {} does not match node key {}",
                tok.issuer,
                vkey.key_id()
            ));
        }
        Ok(tok)
    }

    /// True if this token grants `cap` on `repo` and is not expired at `now`.
    pub fn authorizes(&self, repo: &str, cap: &str, now: i64) -> bool {
        if self.is_expired(now) {
            return false;
        }
        if self.repo_id != SCOPE_ALL && self.repo_id != repo {
            return false;
        }
        self.has_cap(cap)
    }

    pub fn is_expired(&self, now: i64) -> bool {
        self.exp != 0 && now >= self.exp
    }

    pub fn has_cap(&self, cap: &str) -> bool {
        self.caps.iter().any(|c| c == cap)
    }
}

/// Normalize requested capabilities: a `push` grant implies `read`, and
/// duplicates are removed while preserving a stable `read`-before-`push` order.
pub fn normalize_caps(push: bool, read: bool) -> Vec<String> {
    let mut caps = Vec::new();
    if read || push {
        caps.push(CAP_READ.to_string());
    }
    if push {
        caps.push(CAP_PUSH.to_string());
    }
    caps
}

/// Extract a bearer token from an `Authorization` header value. Accepts
/// `Bearer <token>` verbatim and `Basic <b64(user:pass)>` (git's native auth),
/// taking the password field — or the username if the password is empty, since
/// some clients put the token in either.
pub fn token_from_authorization(header: &str) -> Option<String> {
    let header = header.trim();
    if let Some(rest) = strip_ci_prefix(header, "bearer ") {
        let t = rest.trim();
        return (!t.is_empty()).then(|| t.to_string());
    }
    if let Some(rest) = strip_ci_prefix(header, "basic ") {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(rest.trim())
            .ok()?;
        let text = String::from_utf8(decoded).ok()?;
        let (user, pass) = text.split_once(':').unwrap_or((text.as_str(), ""));
        if !pass.is_empty() {
            return Some(pass.to_string());
        }
        if !user.is_empty() {
            return Some(user.to_string());
        }
    }
    None
}

/// Case-insensitive prefix strip for the auth scheme keyword.
fn strip_ci_prefix<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_attestation::SigningKey;

    fn key() -> SigningKey {
        // Deterministic-enough for tests: generate a fresh key each run.
        SigningKey::generate()
    }

    #[test]
    fn issue_then_verify_roundtrips() {
        let k = key();
        let tok = CapabilityToken::new("repo-a", normalize_caps(true, false), 1_000, 3_600);
        let wire = tok.issue(&k).unwrap();
        assert!(wire.starts_with("auracap1."));
        let parsed = CapabilityToken::parse_and_verify(&wire, &k.verifying_key()).unwrap();
        assert_eq!(parsed.repo_id, "repo-a");
        assert_eq!(parsed.caps, vec!["read", "push"]);
        assert_eq!(parsed.issuer, k.key_id());
    }

    #[test]
    fn push_implies_read() {
        assert_eq!(normalize_caps(true, false), vec!["read", "push"]);
        assert_eq!(normalize_caps(false, true), vec!["read"]);
        assert_eq!(normalize_caps(true, true), vec!["read", "push"]);
        assert!(normalize_caps(false, false).is_empty());
    }

    #[test]
    fn wrong_key_is_rejected() {
        let k = key();
        let other = key();
        let wire = CapabilityToken::new("repo-a", normalize_caps(false, true), 1_000, 3_600)
            .issue(&k)
            .unwrap();
        let err = CapabilityToken::parse_and_verify(&wire, &other.verifying_key()).unwrap_err();
        assert!(err.contains("does not verify") || err.contains("issuer"));
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let k = key();
        let wire = CapabilityToken::new("repo-a", normalize_caps(false, true), 1_000, 3_600)
            .issue(&k)
            .unwrap();
        // Forge a payload that grants push, keep the original signature.
        let mut parts: Vec<&str> = wire.split('.').collect();
        let forged = CapabilityToken {
            schema_version: 1,
            repo_id: "repo-a".into(),
            caps: vec![CAP_READ.into(), CAP_PUSH.into()],
            iat: 1_000,
            exp: 0,
            issuer: k.key_id(),
        };
        let forged_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
        parts[1] = &forged_b64;
        let tampered = parts.join(".");
        assert!(CapabilityToken::parse_and_verify(&tampered, &k.verifying_key()).is_err());
    }

    #[test]
    fn scope_and_expiry_are_enforced() {
        let k = key();
        // Read-only, scoped to repo-a, valid [1000, 2000).
        let wire = CapabilityToken::new("repo-a", normalize_caps(false, true), 1_000, 1_000)
            .issue(&k)
            .unwrap();
        let tok = CapabilityToken::parse_and_verify(&wire, &k.verifying_key()).unwrap();

        assert!(tok.authorizes("repo-a", CAP_READ, 1_500));
        assert!(!tok.authorizes("repo-a", CAP_PUSH, 1_500)); // no push cap
        assert!(!tok.authorizes("repo-b", CAP_READ, 1_500)); // wrong repo
        assert!(!tok.authorizes("repo-a", CAP_READ, 2_000)); // expired (>= exp)
        assert!(tok.authorizes("repo-a", CAP_READ, 1_999)); // still valid
    }

    #[test]
    fn wildcard_scope_matches_any_repo() {
        let k = key();
        let wire = CapabilityToken::new(SCOPE_ALL, normalize_caps(true, false), 1_000, 0)
            .issue(&k)
            .unwrap();
        let tok = CapabilityToken::parse_and_verify(&wire, &k.verifying_key()).unwrap();
        assert!(tok.authorizes("anything", CAP_PUSH, 9_999_999)); // no expiry
        assert!(tok.authorizes("other", CAP_READ, 9_999_999));
    }

    #[test]
    fn parses_basic_and_bearer() {
        assert_eq!(
            token_from_authorization("Bearer auracap1.abc.def"),
            Some("auracap1.abc.def".to_string())
        );
        // Basic base64("x-access-token:tok123")
        let b64 = base64::engine::general_purpose::STANDARD.encode("x-access-token:tok123");
        assert_eq!(
            token_from_authorization(&format!("Basic {b64}")),
            Some("tok123".to_string())
        );
        // token as username, empty password
        let b64u = base64::engine::general_purpose::STANDARD.encode("tokAAA:");
        assert_eq!(
            token_from_authorization(&format!("basic {b64u}")),
            Some("tokAAA".to_string())
        );
        assert_eq!(token_from_authorization("Negotiate xyz"), None);
    }
}
