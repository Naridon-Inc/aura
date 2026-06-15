//! Block signing and verification against the JCS-canonicalized envelope.
//!
//! This module is the one place where the raw ed25519 primitive meets the
//! `Block` envelope shape. It exists so callers (supervisor, sentinel,
//! audit tooling) don't have to know the canonicalization tag, the zeroing
//! convention for the self-referential `provenance.signature` slot, or
//! base64 encoding details.
//!
//! Protocol:
//!
//! 1. Canonicalize the block via
//!    [`aura_blocks::canonicalize_for_signing`] — this serializes the
//!    block to JSON, sets `provenance.signature` to `null`, then runs
//!    RFC 8785 JCS. The canonicalization tag is
//!    [`aura_blocks::CANONICALIZATION`] (`"jcs-rfc8785-v1"`).
//! 2. Sign the canonicalized bytes with ed25519. Produce an
//!    [`aura_blocks::Signature`] tuple of (algo, key_id, base64 sig).
//! 3. Writers attach that signature to `block.provenance.signature`.
//!    Verifiers recompute step 1 (the zeroing is idempotent: existing
//!    signature is overwritten with null before canonicalizing) and check
//!    the signature against the supplied public key.

use aura_blocks::{
    canonicalize_for_signing, Block, CanonError, Signature as BlockSignature, CANONICALIZATION,
};

use crate::error::VerifyError;
use crate::keys::{SigningKey, VerifyingKey};
use crate::signature::SignatureBytes;

pub const ED25519_ALGO: &str = "ed25519";

#[derive(Debug, thiserror::Error)]
pub enum BlockSignError {
    #[error("canonicalization: {0}")]
    Canon(#[from] CanonError),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BlockVerifyError {
    #[error("canonicalization: {0}")]
    Canon(String),
    #[error("block has no signature to verify")]
    NoSignature,
    #[error("unsupported signature algo: expected 'ed25519', got '{0}'")]
    UnsupportedAlgo(String),
    #[error("unsupported canonicalization tag: expected '{expected}', got '{got}'")]
    UnsupportedCanonicalization { expected: &'static str, got: String },
    #[error("key_id mismatch: signature claims {claimed}, supplied key is {supplied}")]
    KeyIdMismatch { claimed: String, supplied: String },
    #[error(transparent)]
    Verify(#[from] VerifyError),
    #[error("malformed signature in block: {0}")]
    MalformedSignature(String),
}

/// Sign `block` with `key`. Returns an [`aura_blocks::Signature`] suitable
/// for assignment to `block.provenance.signature`. Does NOT mutate the
/// block — the caller decides when to attach.
///
/// The signature covers the block canonicalized with `provenance.signature`
/// set to `null`, so signing is idempotent: signing an already-signed
/// block produces the same bytes as signing the unsigned version.
pub fn sign_block(block: &Block, key: &SigningKey) -> Result<BlockSignature, BlockSignError> {
    let bytes = canonicalize_for_signing(block)?;
    let sig: SignatureBytes = key.sign(&bytes);
    Ok(BlockSignature {
        algo: ED25519_ALGO.to_string(),
        key_id: key.key_id(),
        sig_b64: sig.to_b64(),
    })
}

/// Attach a freshly-computed signature to `block.provenance.signature`,
/// mutating in place. Convenience wrapper around [`sign_block`].
pub fn sign_block_in_place(block: &mut Block, key: &SigningKey) -> Result<(), BlockSignError> {
    let sig = sign_block(block, key)?;
    block.provenance.signature = Some(sig);
    Ok(())
}

/// Verify the signature embedded in `block.provenance.signature` against
/// `pubkey`. Rejects algo/canonicalization mismatches eagerly so an
/// attacker cannot downgrade by flipping tags.
///
/// Note: the canonicalization tag for the current scheme is implicit —
/// we have exactly one scheme (`"jcs-rfc8785-v1"`), so the signature
/// struct does not carry it. If a second scheme is ever added, the
/// `Signature` struct grows a `canonicalization` field and this function
/// consults it; until then we assert the one scheme we support.
pub fn verify_block(block: &Block, pubkey: &VerifyingKey) -> Result<(), BlockVerifyError> {
    let sig = block
        .provenance
        .signature
        .as_ref()
        .ok_or(BlockVerifyError::NoSignature)?;

    if sig.algo != ED25519_ALGO {
        return Err(BlockVerifyError::UnsupportedAlgo(sig.algo.clone()));
    }
    let supplied_id = pubkey.key_id();
    if sig.key_id != supplied_id {
        return Err(BlockVerifyError::KeyIdMismatch {
            claimed: sig.key_id.clone(),
            supplied: supplied_id,
        });
    }

    let raw = SignatureBytes::from_b64(&sig.sig_b64)
        .map_err(|e| BlockVerifyError::MalformedSignature(e.to_string()))?;

    let bytes = canonicalize_for_signing(block).map_err(|e| BlockVerifyError::Canon(e.to_string()))?;
    pubkey.verify(&bytes, &raw)?;
    Ok(())
}

/// Expose the canonicalization tag in scope of attestation for tooling
/// that wants to log it alongside audit records. Re-exported verbatim
/// from aura-blocks.
pub fn canonicalization_tag() -> &'static str {
    CANONICALIZATION
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_blocks::{
        AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload,
        BlockState, DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
    };
    use std::collections::BTreeMap;
    use time::OffsetDateTime;

    fn sample_block() -> Block {
        Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::None,
            intent: Intent {
                summary: "install rust toolchain".into(),
                detail: Some("needed for ci worker".into()),
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "rustup install stable".into(),
                shell: Some("bash".into()),
                cwd: "/repo".into(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:user/muhammed".into()),
                on_behalf_of: None,
                origin_host: "laptop".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            extensions: BTreeMap::new(),
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
        }
    }

    #[test]
    fn sign_then_verify_round_trip() {
        let key = SigningKey::from_seed([9u8; 32]);
        let vk = key.verifying_key();
        let mut block = sample_block();
        sign_block_in_place(&mut block, &key).unwrap();
        verify_block(&block, &vk).expect("freshly signed block must verify");
    }

    #[test]
    fn unsigned_block_rejected() {
        let key = SigningKey::from_seed([1u8; 32]);
        let block = sample_block();
        assert_eq!(
            verify_block(&block, &key.verifying_key()).unwrap_err(),
            BlockVerifyError::NoSignature
        );
    }

    #[test]
    fn signature_is_idempotent_over_existing_signature() {
        // sign_block must produce the same signature regardless of whether
        // provenance.signature already holds a (stale) value, because the
        // canonicalization zeros that slot before hashing. Without this
        // guarantee, re-signing a block would drift.
        let key = SigningKey::from_seed([2u8; 32]);
        let mut block = sample_block();

        let sig_a = sign_block(&block, &key).unwrap();
        block.provenance.signature = Some(BlockSignature {
            algo: ED25519_ALGO.to_string(),
            key_id: "did:aura:key/junk-stale".into(),
            sig_b64: "AAAA".into(),
        });
        let sig_b = sign_block(&block, &key).unwrap();
        assert_eq!(sig_a.sig_b64, sig_b.sig_b64);
    }

    #[test]
    fn tampered_intent_rejected() {
        let key = SigningKey::from_seed([3u8; 32]);
        let vk = key.verifying_key();
        let mut block = sample_block();
        sign_block_in_place(&mut block, &key).unwrap();
        block.intent.summary = "install evil toolchain".into();
        assert_eq!(
            verify_block(&block, &vk).unwrap_err(),
            BlockVerifyError::Verify(VerifyError::Invalid)
        );
    }

    #[test]
    fn tampered_command_rejected() {
        let key = SigningKey::from_seed([4u8; 32]);
        let vk = key.verifying_key();
        let mut block = sample_block();
        sign_block_in_place(&mut block, &key).unwrap();
        if let BlockPayload::Command { command, .. } = &mut block.payload {
            *command = "rm -rf /".into();
        } else {
            unreachable!();
        }
        assert_eq!(
            verify_block(&block, &vk).unwrap_err(),
            BlockVerifyError::Verify(VerifyError::Invalid)
        );
    }

    #[test]
    fn wrong_key_rejected_via_key_id_check() {
        // With an unrelated pubkey, the key_id check fires first — we
        // reject before even parsing the signature bytes. This is a
        // feature: it lets callers distinguish "not for me" from
        // "tampered".
        let signer = SigningKey::from_seed([5u8; 32]);
        let other = SigningKey::from_seed([6u8; 32]);
        let mut block = sample_block();
        sign_block_in_place(&mut block, &signer).unwrap();
        match verify_block(&block, &other.verifying_key()).unwrap_err() {
            BlockVerifyError::KeyIdMismatch { claimed, supplied } => {
                assert_eq!(claimed, signer.key_id());
                assert_eq!(supplied, other.key_id());
            }
            other => panic!("expected KeyIdMismatch, got {other:?}"),
        }
    }

    #[test]
    fn algo_downgrade_rejected() {
        let key = SigningKey::from_seed([7u8; 32]);
        let vk = key.verifying_key();
        let mut block = sample_block();
        sign_block_in_place(&mut block, &key).unwrap();
        block.provenance.signature.as_mut().unwrap().algo = "rsa-md5".into();
        match verify_block(&block, &vk).unwrap_err() {
            BlockVerifyError::UnsupportedAlgo(a) => assert_eq!(a, "rsa-md5"),
            other => panic!("expected UnsupportedAlgo, got {other:?}"),
        }
    }

    #[test]
    fn malformed_sig_b64_rejected() {
        let key = SigningKey::from_seed([8u8; 32]);
        let vk = key.verifying_key();
        let mut block = sample_block();
        sign_block_in_place(&mut block, &key).unwrap();
        block.provenance.signature.as_mut().unwrap().sig_b64 = "not-base64!!!".into();
        match verify_block(&block, &vk).unwrap_err() {
            BlockVerifyError::MalformedSignature(_) => {}
            other => panic!("expected MalformedSignature, got {other:?}"),
        }
    }

    #[test]
    fn canonicalization_tag_is_jcs_rfc8785_v1() {
        assert_eq!(canonicalization_tag(), "jcs-rfc8785-v1");
    }

    #[test]
    fn signature_survives_state_transition() {
        // The whole point of the narrowed canonicalization: a block signed
        // at proposal time must still verify after the reducer has walked
        // it through Proposed → Gated → Running → Completed, attached a
        // policy decision, and bumped updated_at. If this regresses, every
        // terminal-minted Block becomes unverifiable the moment it starts
        // executing.
        use aura_blocks::{BlockState, CapabilityGrade, PolicyDecision};
        use time::OffsetDateTime;

        let key = SigningKey::from_seed([11u8; 32]);
        let vk = key.verifying_key();
        let mut block = sample_block();
        sign_block_in_place(&mut block, &key).unwrap();

        // Simulate what the reducer does to a block as it progresses.
        block.state = BlockState::Completed;
        block.updated_at = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        block.policy = Some(PolicyDecision {
            verdict: CapabilityGrade::Auto,
            rules_fired: vec!["policy.auto".into()],
            reason: "allowed".into(),
            decided_by: aura_blocks::AgentRef("did:aura:policy-engine".into()),
            decided_at: block.created_at,
            gate_reviewer: None,
        });

        verify_block(&block, &vk).expect("signature must survive reducer mutations");
    }

    #[test]
    fn tampered_created_at_still_rejected() {
        // created_at IS part of the signed envelope — tampering with it
        // must still break the signature. Counter-balance to the
        // survives_state_transition test: the narrowing is targeted, not
        // a blanket loosening.
        use time::OffsetDateTime;

        let key = SigningKey::from_seed([12u8; 32]);
        let vk = key.verifying_key();
        let mut block = sample_block();
        sign_block_in_place(&mut block, &key).unwrap();
        block.created_at = OffsetDateTime::from_unix_timestamp(999_999).unwrap();
        assert_eq!(
            verify_block(&block, &vk).unwrap_err(),
            BlockVerifyError::Verify(VerifyError::Invalid)
        );
    }
}
