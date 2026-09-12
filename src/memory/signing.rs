// AUDIT-CTX-05 — entry-level signatures for SHARED memory.
//
// A memory entry travels: it syncs to teammates through git and the live
// plane, gets pushed org-wide via `aura memory-cloud push`, and is read
// back by agents that will act on it. Until now nothing bound a fact to
// the identity that wrote it — `signer_key_id` only *copies* the key id
// off the latest intent-log row, it signs nothing — so a tampered
// memory.json (or a spoofed push) was indistinguishable from a truthful
// one. This module signs the entry itself.
//
// ── Signed payload (byte-for-byte) ─────────────────────────────────────
// The Ed25519 signature covers the UTF-8 bytes of EXACTLY:
//
//   "aura-memory-sig\n<id>\n<section>\n<sha256hex(content)>\n<added_at>"
//
// where <section> is the canonical section name the entry lives in,
// <sha256hex(content)> is the hex sha256 of the entry's EXACT stored
// content bytes (not the reconcile-normalized form — we sign what is on
// disk), and <added_at> is the decimal unix-seconds write time. No
// trailing newline. Domain-separated from `aura refs sign` payloads by
// the tag line.
//
// ── Fields on MemoryEntry ──────────────────────────────────────────────
//   sig        — base64 (std, no pad) 64-byte Ed25519 signature
//   sig_pubkey — base64url (no pad) full 32-byte verifying key; makes the
//                entry self-certifying, same scheme as refs_sign.rs
//   sig_key_id — `did:aura:key/…` derived from the pubkey's first 8 bytes
//
// ── Identity ───────────────────────────────────────────────────────────
// Signing reuses the repo-local awareness identity (the same keypair that
// signs radar events and ref endorsements): `.aura/awareness/identity.key`.
// Load is graceful — no identity means the entry is written UNSIGNED, so
// memory keeps working on a box that never ran `aura identity`.

use aura_attestation::{SignatureBytes, VerifyingKey};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use sha2::{Digest, Sha256};

use super::MemoryEntry;

/// Domain-separation tag — first line of every signed memory payload.
pub const PAYLOAD_TAG: &str = "aura-memory-sig";

/// The EXACT byte string an entry signature covers. Verifiers reproduce
/// this byte-for-byte.
pub fn signing_payload(id: &str, section: &str, content: &str, added_at: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!(
        "{}\n{}\n{}\n{}\n{}",
        PAYLOAD_TAG,
        id,
        section,
        hex::encode(hasher.finalize()),
        added_at
    )
}

/// Sign `entry` in place with the repo-local awareness identity, when one
/// exists. No identity (or an unreadable keystore) leaves the entry
/// unsigned — memory must never fail closed on a box without a key.
pub fn stamp(entry: &mut MemoryEntry, section: &str) {
    let Some(sk) = crate::awareness::identity::load() else {
        return;
    };
    let payload = signing_payload(&entry.id, section, &entry.content, entry.added_at);
    entry.sig = Some(sk.sign(payload.as_bytes()).to_b64());
    entry.sig_pubkey = Some(B64URL.encode(sk.verifying_key().to_bytes()));
    entry.sig_key_id = Some(sk.key_id());
}

/// Read-time verdict on one entry's signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SigVerdict {
    /// No signature fields at all (pre-CTX-05 entry, or no identity at
    /// write time). Not an error — just unattested.
    Unsigned,
    /// The embedded pubkey derives the claimed key_id AND the signature
    /// verifies over the canonical payload. Carries the key_id.
    Valid(String),
    /// Signature fields present but wrong — tampered content, a spoofed
    /// key_id, or a malformed field. Carries the reason.
    Invalid(String),
}

impl SigVerdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            SigVerdict::Unsigned => "unsigned",
            SigVerdict::Valid(_) => "valid",
            SigVerdict::Invalid(_) => "invalid",
        }
    }
}

/// Verify one entry against the section it lives in. Self-certifying:
/// the embedded pubkey must derive the claimed `sig_key_id`, then the
/// signature must verify — no key server involved. WHO owns the key_id
/// stays anchored out-of-band (`aura identity`), same as refs_sign.
pub fn verify(entry: &MemoryEntry, section: &str) -> SigVerdict {
    let (Some(sig_b64), Some(pub_b64), Some(key_id)) =
        (&entry.sig, &entry.sig_pubkey, &entry.sig_key_id)
    else {
        // Partial fields = someone stripped or half-wrote them; only the
        // fully-absent case is honest "unsigned".
        if entry.sig.is_none() && entry.sig_pubkey.is_none() && entry.sig_key_id.is_none() {
            return SigVerdict::Unsigned;
        }
        return SigVerdict::Invalid("incomplete signature fields".to_string());
    };

    let raw = match B64URL.decode(pub_b64) {
        Ok(r) => r,
        Err(e) => return SigVerdict::Invalid(format!("malformed pubkey: {}", e)),
    };
    let buf: [u8; 32] = match raw.try_into() {
        Ok(b) => b,
        Err(_) => return SigVerdict::Invalid("pubkey is not 32 bytes".to_string()),
    };
    let vk = match VerifyingKey::from_bytes(&buf) {
        Ok(v) => v,
        Err(e) => return SigVerdict::Invalid(format!("invalid pubkey: {}", e)),
    };
    if &vk.key_id() != key_id {
        return SigVerdict::Invalid(format!(
            "embedded pubkey derives {} but the entry claims {}",
            vk.key_id(),
            key_id
        ));
    }
    let sig = match SignatureBytes::from_b64(sig_b64) {
        Ok(s) => s,
        Err(e) => return SigVerdict::Invalid(format!("malformed signature: {}", e)),
    };
    let payload = signing_payload(&entry.id, section, &entry.content, entry.added_at);
    match vk.verify(payload.as_bytes(), &sig) {
        Ok(()) => SigVerdict::Valid(key_id.clone()),
        Err(_) => SigVerdict::Invalid(
            "signature does not verify over the canonical payload".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_attestation::SigningKey;

    fn signed_entry(section: &str) -> MemoryEntry {
        let sk = SigningKey::generate();
        let mut e = MemoryEntry {
            id: "mem-test0001".to_string(),
            content: "verify_token rejects expired JWTs".to_string(),
            added_at: 1_765_000_000,
            ..Default::default()
        };
        let payload = signing_payload(&e.id, section, &e.content, e.added_at);
        e.sig = Some(sk.sign(payload.as_bytes()).to_b64());
        e.sig_pubkey = Some(B64URL.encode(sk.verifying_key().to_bytes()));
        e.sig_key_id = Some(sk.key_id());
        e
    }

    #[test]
    fn roundtrip_signs_and_verifies() {
        let e = signed_entry("gotchas");
        match verify(&e, "gotchas") {
            SigVerdict::Valid(kid) => assert_eq!(Some(kid), e.sig_key_id),
            other => panic!("expected Valid, got {:?}", other),
        }
    }

    #[test]
    fn tampered_content_is_invalid() {
        let mut e = signed_entry("gotchas");
        e.content = "verify_token accepts expired JWTs".to_string();
        assert!(matches!(verify(&e, "gotchas"), SigVerdict::Invalid(_)));
    }

    #[test]
    fn moved_section_is_invalid() {
        // The section is part of the payload: re-filing a signed fact under
        // a different heading changes its meaning, so it must not verify.
        let e = signed_entry("gotchas");
        assert!(matches!(verify(&e, "context"), SigVerdict::Invalid(_)));
    }

    #[test]
    fn recording_that_a_fact_was_shared_does_not_break_who_wrote_it() {
        // AURA-1372 — `shared_at` / `shared_signature` are written AFTER the
        // entry is signed, by the push that sent it. They sit outside the
        // payload (tag, id, section, content hash, added_at) on purpose: a
        // fact whose signature stopped verifying the moment you shared it
        // would tell your team it had been tampered with.
        let mut e = signed_entry("gotchas");
        e.shared_at = Some("2026-09-09T11:02:00+00:00".to_string());
        e.shared_signature = Some("signed".to_string());
        assert!(matches!(verify(&e, "gotchas"), SigVerdict::Valid(_)));

        // And withdrawing it — shared_at cleared, the retraction stamped —
        // still does.
        e.shared_at = None;
        e.shared_signature = None;
        e.shared_retracted_at = Some("2026-09-10T09:30:00+00:00".to_string());
        assert!(matches!(verify(&e, "gotchas"), SigVerdict::Valid(_)));
    }

    #[test]
    fn spoofed_key_id_is_invalid() {
        let mut e = signed_entry("gotchas");
        e.sig_key_id = Some("did:aura:key/someoneelse0".to_string());
        match verify(&e, "gotchas") {
            SigVerdict::Invalid(reason) => {
                assert!(reason.contains("claims"), "reason names the mismatch: {reason}")
            }
            other => panic!("expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn absent_fields_are_unsigned_but_partial_fields_are_invalid() {
        let bare = MemoryEntry {
            id: "mem-test0002".to_string(),
            content: "no signature here".to_string(),
            ..Default::default()
        };
        assert_eq!(verify(&bare, "context"), SigVerdict::Unsigned);

        let mut half = bare.clone();
        half.sig = Some("AAAA".to_string());
        assert!(matches!(verify(&half, "context"), SigVerdict::Invalid(_)));
    }

    #[test]
    fn the_payload_is_pinned_to_an_exact_string() {
        // An entry now travels: `aura memory-cloud push --entry-id` sends it
        // org-wide and aura-cloud rebuilds this payload to check the
        // signature. The two definitions are in different crates and cannot
        // share code, so they are held together by both pinning the same
        // literal — this assertion and
        // `memory::signature::the_payload_matches_the_cli_definition_byte_for_byte`
        // in aura-cloud. Changing the layout here without changing it there
        // makes every honestly-signed entry in the org read as a forgery, and
        // one of these two tests will say so first.
        let expected = format!(
            "aura-memory-sig\nmem-abc123\ngotchas\n{}\n1757030400",
            // sha256("hello"), spelled out rather than computed, so a change
            // to the hashing fails the test instead of moving with it.
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            signing_payload("mem-abc123", "gotchas", "hello", 1_757_030_400),
            expected
        );
    }
}
