use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey as DalekSigning, Verifier, VerifyingKey as DalekVerifying};
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{AttestationError, VerifyError};
use crate::signature::SignatureBytes;

/// Ed25519 signing key. The 32-byte seed is zeroized on drop.
#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct SigningKey {
    // Keep the seed separate from the dalek handle so zeroize works
    // cleanly and so we can re-export a stable representation.
    seed: [u8; 32],
    #[zeroize(skip)]
    inner: DalekSigning,
}

impl SigningKey {
    /// Generate a fresh keypair from the OS CSPRNG.
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        Self::from_seed(seed)
    }

    /// Re-derive a keypair from its 32-byte seed. Seed is the durable
    /// representation — losing it loses the key.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        let inner = DalekSigning::from_bytes(&seed);
        Self { seed, inner }
    }

    pub fn seed_bytes(&self) -> &[u8; 32] {
        &self.seed
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        VerifyingKey {
            inner: self.inner.verifying_key(),
        }
    }

    /// Deterministic, human-readable key identifier. Derives from the
    /// public key so it survives seed re-derivation and is stable
    /// across machines. Format matches the `did:aura:key/` prefix used
    /// in `aura_blocks::Signature.key_id`.
    pub fn key_id(&self) -> String {
        self.verifying_key().key_id()
    }

    /// Sign arbitrary message bytes. Callers pre-canonicalize anything
    /// structured (Block, BlockOp) themselves — ed25519 has no opinion
    /// on what the bytes mean.
    pub fn sign(&self, message: &[u8]) -> SignatureBytes {
        let s: Signature = self.inner.sign(message);
        SignatureBytes(s.to_bytes())
    }
}

impl PartialEq for SigningKey {
    fn eq(&self, other: &Self) -> bool {
        // Constant-time compare on the seed; verifying-key compare would
        // work too but seed is the source of truth.
        let mut diff = 0u8;
        for (a, b) in self.seed.iter().zip(other.seed.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}
impl Eq for SigningKey {}

/// Public verifying key. 32 bytes on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifyingKey {
    inner: DalekVerifying,
}

impl VerifyingKey {
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self, AttestationError> {
        DalekVerifying::from_bytes(bytes)
            .map(|inner| Self { inner })
            .map_err(|e| AttestationError::Key(e.to_string()))
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        self.inner.to_bytes()
    }

    /// See [`SigningKey::key_id`]. Derived from the public key bytes so
    /// anyone with the pubkey (including verifiers) produces the same id.
    pub fn key_id(&self) -> String {
        let bytes = self.inner.to_bytes();
        let short = B64URL.encode(&bytes[..8]);
        format!("did:aura:key/{short}")
    }

    /// Verify a detached signature over `message`. `Ok(())` on success,
    /// `VerifyError::Invalid` on any mismatch (tamper or wrong key),
    /// `VerifyError::Malformed` if the raw bytes can't be parsed as a
    /// valid ed25519 signature.
    pub fn verify(&self, message: &[u8], sig: &SignatureBytes) -> Result<(), VerifyError> {
        let parsed = Signature::from_bytes(sig.as_bytes());
        self.inner
            .verify(message, &parsed)
            .map_err(|_| VerifyError::Invalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_sign_verify() {
        let sk = SigningKey::generate();
        let vk = sk.verifying_key();
        let msg = b"block:deadbeef:proposal";
        let sig = sk.sign(msg);
        vk.verify(msg, &sig).expect("signature must verify");
    }

    #[test]
    fn tamper_detected() {
        let sk = SigningKey::generate();
        let vk = sk.verifying_key();
        let msg = b"kubectl apply -f staging/";
        let sig = sk.sign(msg);
        let tampered = b"kubectl apply -f production/";
        assert_eq!(
            vk.verify(tampered, &sig).unwrap_err(),
            VerifyError::Invalid
        );
    }

    #[test]
    fn wrong_public_key_fails() {
        let sk1 = SigningKey::generate();
        let sk2 = SigningKey::generate();
        let msg = b"same message";
        let sig = sk1.sign(msg);
        assert_eq!(
            sk2.verifying_key().verify(msg, &sig).unwrap_err(),
            VerifyError::Invalid
        );
    }

    #[test]
    fn deterministic_from_seed() {
        let seed = [7u8; 32];
        let a = SigningKey::from_seed(seed);
        let b = SigningKey::from_seed(seed);
        assert_eq!(a.key_id(), b.key_id());
        let msg = b"deterministic test";
        let sa = a.sign(msg);
        // ed25519 signatures are deterministic given the same key + message,
        // so two independently-derived keys from the same seed must produce
        // identical signatures.
        let sb = b.sign(msg);
        assert_eq!(sa, sb);
    }

    #[test]
    fn key_id_shape() {
        let sk = SigningKey::from_seed([0u8; 32]);
        let id = sk.key_id();
        assert!(id.starts_with("did:aura:key/"));
        // 8 bytes → ceil(8 * 8 / 6) = 11 chars in url-safe-no-pad base64.
        let tail = id.strip_prefix("did:aura:key/").unwrap();
        assert_eq!(tail.len(), 11);
    }

    #[test]
    fn verifying_key_roundtrip_bytes() {
        let sk = SigningKey::generate();
        let vk = sk.verifying_key();
        let bytes = vk.to_bytes();
        let vk2 = VerifyingKey::from_bytes(&bytes).unwrap();
        assert_eq!(vk, vk2);
    }

    #[test]
    fn signature_b64_roundtrip() {
        let sk = SigningKey::generate();
        let sig = sk.sign(b"payload");
        let b = sig.to_b64();
        let sig2 = SignatureBytes::from_b64(&b).unwrap();
        assert_eq!(sig, sig2);
    }

    #[test]
    fn malformed_b64_rejected() {
        assert!(SignatureBytes::from_b64("not-base64!!!").is_err());
        assert!(SignatureBytes::from_b64("aGVsbG8").is_err()); // valid b64, wrong length
    }
}
