//! Verify awareness events. An event is *verified* when the self-certifying
//! public key it carries (a) re-derives the `key_id` it claims — so no signer
//! can borrow another's identity — and (b) validates the Ed25519 signature over
//! the canonical [`AwarenessEvent::signing_bytes`]. The 32-byte pubkey travels
//! WITH the event, so verification needs no key registry and works the instant a
//! teammate's event arrives. Mirrors the self-certifying line check in
//! `refs_sign.rs`.

use aura_attestation::{SignatureBytes, VerifyingKey};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};

use super::model::AwarenessEvent;

/// True when the event carries a key id, signature, and pubkey that all agree:
/// the embedded pubkey re-derives the claimed key id AND validates the
/// signature over the event's canonical bytes. Unsigned events (older CLIs) and
/// any tamper — a swapped field, a borrowed key id, a mangled signature — are
/// `false`.
pub fn verify_event(ev: &AwarenessEvent) -> bool {
    let (Some(pub_b64), Some(sig_b64), Some(claimed_kid)) =
        (ev.pubkey.as_deref(), ev.sig.as_deref(), ev.key_id.as_deref())
    else {
        return false;
    };

    // Decode the 32-byte public key that rides on the event.
    let Ok(pub_bytes) = B64URL.decode(pub_b64) else {
        return false;
    };
    let Ok(pub_arr) = <[u8; 32]>::try_from(pub_bytes.as_slice()) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pub_arr) else {
        return false;
    };

    // Reject a forged binding: the embedded key MUST be the one the event names,
    // or an attacker could sign with their own key while claiming a teammate's
    // id. `key_id` is derived from the pubkey, so this pins them together.
    if vk.key_id() != claimed_kid {
        return false;
    }

    // Validate the detached signature over the exact bytes that were signed.
    let Ok(sig) = SignatureBytes::from_b64(sig_b64) else {
        return false;
    };
    vk.verify(&ev.signing_bytes(), &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::awareness::model::{AwarenessEvent, AwarenessKind};
    use aura_attestation::SigningKey;

    /// Build a signed event exactly the way `emit` does, so the test exercises
    /// the real sign→verify contract.
    fn signed(key: &SigningKey) -> AwarenessEvent {
        let mut ev = AwarenessEvent {
            id: "id-1".into(),
            actor: "priya".into(),
            is_agent: false,
            kind: AwarenessKind::Intent,
            repo: "MHASK/notely".into(),
            branch: "feat/x".into(),
            file: Some("src/auth/session.ts".into()),
            symbol: Some("requestReset".into()),
            intent: Some("rate-limit reset requests".into()),
            impact: None,
            ts: 1_785_000_000_000,
            key_id: None,
            sig: None,
            pubkey: None,
            worktree: None,
        };
        ev.sig = Some(key.sign(&ev.signing_bytes()).to_b64());
        ev.key_id = Some(key.key_id());
        ev.pubkey = Some(B64URL.encode(key.verifying_key().to_bytes()));
        ev
    }

    #[test]
    fn genuine_event_verifies() {
        let key = SigningKey::generate();
        assert!(verify_event(&signed(&key)));
    }

    #[test]
    fn unsigned_event_is_unverified() {
        let mut ev = signed(&SigningKey::generate());
        ev.sig = None;
        ev.key_id = None;
        ev.pubkey = None;
        assert!(!verify_event(&ev));
    }

    #[test]
    fn tampered_field_fails() {
        let key = SigningKey::generate();
        let mut ev = signed(&key);
        // Flip a signed field after signing — the signature no longer matches.
        ev.intent = Some("do something else entirely".into());
        assert!(!verify_event(&ev));
    }

    #[test]
    fn borrowed_key_id_fails() {
        // Sign with our own key but claim someone else's id: the pubkey no
        // longer derives the claimed key_id, so the binding is rejected.
        let mine = SigningKey::generate();
        let other = SigningKey::generate();
        let mut ev = signed(&mine);
        ev.key_id = Some(other.key_id());
        assert!(!verify_event(&ev));
    }

    #[test]
    fn swapped_pubkey_fails() {
        // Attach a different pubkey than the one that signed: it won't validate
        // the signature (and won't match the key_id either).
        let signer = SigningKey::generate();
        let imposter = SigningKey::generate();
        let mut ev = signed(&signer);
        ev.pubkey = Some(B64URL.encode(imposter.verifying_key().to_bytes()));
        assert!(!verify_event(&ev));
    }
}
