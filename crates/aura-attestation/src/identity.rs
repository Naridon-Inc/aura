//! Per-actor cryptographic identity (NID), Radicle-style.
//!
//! Every actor that can author work — a human or an autonomous agent —
//! gets its own ed25519 keypair. The public half is encoded as a
//! self-certifying **NID** (Node IDentity) in the W3C `did:key` form
//! Radicle popularised:
//!
//! ```text
//! did:key:z6Mk…
//! ```
//!
//! The tail is the multibase-base58btc encoding (`z` prefix) of the
//! ed25519 multicodec marker (`0xed 0x01`) followed by the 32 raw public
//! key bytes. Because the identity *is* the public key, anyone holding a
//! NID can verify a signature without consulting a registry — that
//! self-certification is what makes downstream agent attribution
//! tamper-evident and what later sovereign canonical refs hang off of.
//!
//! Humans and agents are cryptographically identical (both are ed25519
//! nodes). [`ActorKind`] is *attribution* metadata so the supervisor and
//! UI can tell "a person did this" from "an autonomous agent did this".
//!
//! Secret material lives in [`LocalIdentity`] (holds the [`SigningKey`]);
//! the shareable public record is [`ActorRef`] (kind + label + NID, no
//! secret). Persist a `LocalIdentity` to the OS keychain via the
//! [`crate::keychain`] module (the `keychain` feature, on by default).

use serde::{Deserialize, Serialize};

use crate::error::AttestationError;
use crate::keys::{SigningKey, VerifyingKey};
use crate::signature::SignatureBytes;

/// Unsigned-varint multicodec marker for an ed25519 public key (`0xed`
/// encodes to the two-byte varint `[0xed, 0x01]`). Prepended to the raw
/// pubkey before base58 so the resulting NID is a standard `did:key`
/// ed25519 identifier, interoperable with Radicle and other did:key
/// consumers.
const MULTICODEC_ED25519_PUB: [u8; 2] = [0xed, 0x01];

/// What kind of actor an identity belongs to. Purely attribution
/// metadata — both variants are the same ed25519 primitive underneath.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    /// A person.
    Human,
    /// An autonomous agent (Claude Code, a crew worker, a bot).
    Agent,
}

impl ActorKind {
    /// Lowercase tag used in keychain account names and the legacy
    /// `did:aura:<kind>/…` form.
    pub fn as_str(self) -> &'static str {
        match self {
            ActorKind::Human => "human",
            ActorKind::Agent => "agent",
        }
    }

    /// Method segment used by the existing `AgentRef` DIDs sprinkled
    /// through the block store (`did:aura:user/…` for humans,
    /// `did:aura:agent/…` for agents).
    pub fn did_aura_method(self) -> &'static str {
        match self {
            ActorKind::Human => "user",
            ActorKind::Agent => "agent",
        }
    }
}

/// Radicle-style Node IDentity. The identity *is* the public key:
/// `did:key:z6Mk…`. Self-certifying — `to_verifying_key` recovers the
/// pubkey with no external lookup, so a signature can be checked against
/// the NID alone.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Nid(pub String);

impl Nid {
    /// The fixed `did:key:` + base58btc-multibase (`z`) prefix every NID
    /// shares.
    pub const PREFIX: &'static str = "did:key:z";

    /// Derive the NID from a public key. Pure function of the key bytes,
    /// so it is stable across machines and survives seed re-derivation.
    pub fn from_verifying_key(vk: &VerifyingKey) -> Self {
        let mut payload = Vec::with_capacity(2 + 32);
        payload.extend_from_slice(&MULTICODEC_ED25519_PUB);
        payload.extend_from_slice(&vk.to_bytes());
        let mb = bs58::encode(payload).into_string();
        Nid(format!("{}{mb}", Self::PREFIX))
    }

    /// Recover the ed25519 public key this NID encodes. Validates the
    /// `did:key:z` prefix, the multicodec marker, and the key length.
    pub fn to_verifying_key(&self) -> Result<VerifyingKey, AttestationError> {
        let mb = self
            .0
            .strip_prefix(Self::PREFIX)
            .ok_or_else(|| AttestationError::Identity(format!("not a did:key ed25519 NID: {}", self.0)))?;
        let decoded = bs58::decode(mb)
            .into_vec()
            .map_err(|e| AttestationError::Identity(format!("base58: {e}")))?;
        if decoded.len() != MULTICODEC_ED25519_PUB.len() + 32 {
            return Err(AttestationError::Identity(format!(
                "decoded NID is {} bytes, expected {}",
                decoded.len(),
                MULTICODEC_ED25519_PUB.len() + 32
            )));
        }
        if decoded[..2] != MULTICODEC_ED25519_PUB {
            return Err(AttestationError::Identity(format!(
                "unexpected multicodec marker {:02x?}, expected ed25519 [ed, 01]",
                &decoded[..2]
            )));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&decoded[2..]);
        VerifyingKey::from_bytes(&key)
    }

    /// Full `did:key:…` string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The bare multibase token (`z6Mk…`) without the `did:key:` prefix —
    /// the form Radicle prints in its UI / refs.
    pub fn multibase(&self) -> &str {
        // Every well-formed NID starts with `did:key:`; strip just that,
        // keeping the `z` so the token is a valid multibase string.
        self.0.strip_prefix("did:key:").unwrap_or(&self.0)
    }
}

impl std::fmt::Display for Nid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Public attribution record for an actor: kind + human-readable label +
/// the self-certifying NID. Carries no secret material, so it is safe to
/// embed in blocks, ship to peers, or log. This is the unit of
/// tamper-evident attribution — the NID lets any verifier check that a
/// signature really came from this actor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActorRef {
    pub kind: ActorKind,
    /// Human-readable handle, e.g. `"muhammed"` or `"claude-code"`.
    pub label: String,
    pub nid: Nid,
}

impl ActorRef {
    /// Recover the public key from the embedded NID.
    pub fn verifying_key(&self) -> Result<VerifyingKey, AttestationError> {
        self.nid.to_verifying_key()
    }

    /// Verify a detached signature over `message` against this actor's
    /// NID. Convenience over `verifying_key()?.verify(...)`.
    pub fn verify(&self, message: &[u8], sig: &SignatureBytes) -> Result<(), AttestationError> {
        self.verifying_key()?
            .verify(message, sig)
            .map_err(|e| AttestationError::Identity(e.to_string()))
    }

    /// The legacy `did:aura:<method>/<label>` form used by
    /// `aura_blocks::AgentRef` in existing provenance fields
    /// (`did:aura:user/muhammed`, `did:aura:agent/claude-code`). Lets new
    /// crypto identities bridge into the logical-actor strings already
    /// threaded through the block store.
    pub fn did_aura(&self) -> String {
        format!("did:aura:{}/{}", self.kind.did_aura_method(), self.label)
    }
}

/// A full local identity: an actor's secret [`SigningKey`] plus its
/// attribution metadata. Produced by `generate`, persisted via
/// [`crate::keychain`], and the thing you actually sign with.
#[derive(Debug, Clone)]
pub struct LocalIdentity {
    kind: ActorKind,
    label: String,
    key: SigningKey,
}

impl LocalIdentity {
    /// Mint a fresh identity for `kind`/`label` from the OS CSPRNG.
    pub fn generate(kind: ActorKind, label: impl Into<String>) -> Self {
        Self {
            kind,
            label: label.into(),
            key: SigningKey::generate(),
        }
    }

    /// Reconstruct an identity from an existing signing key (e.g. loaded
    /// from the keychain or a keyfile).
    pub fn from_key(kind: ActorKind, label: impl Into<String>, key: SigningKey) -> Self {
        Self {
            kind,
            label: label.into(),
            key,
        }
    }

    /// Reconstruct from a raw 32-byte seed.
    pub fn from_seed(kind: ActorKind, label: impl Into<String>, seed: [u8; 32]) -> Self {
        Self::from_key(kind, label, SigningKey::from_seed(seed))
    }

    pub fn kind(&self) -> ActorKind {
        self.kind
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// The secret signing key. Borrow only — callers should not clone the
    /// seed around.
    pub fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.key.verifying_key()
    }

    /// This identity's self-certifying NID.
    pub fn nid(&self) -> Nid {
        Nid::from_verifying_key(&self.verifying_key())
    }

    /// The short signature key reference (`did:aura:key/…`) used in
    /// `aura_blocks::Signature.key_id`. Distinct from the NID: the NID is
    /// the full self-certifying identity, this is the compact reference a
    /// signature carries.
    pub fn key_id(&self) -> String {
        self.key.key_id()
    }

    /// The shareable public record for this identity.
    pub fn actor_ref(&self) -> ActorRef {
        ActorRef {
            kind: self.kind,
            label: self.label.clone(),
            nid: self.nid(),
        }
    }

    /// Sign arbitrary message bytes with this actor's key.
    pub fn sign(&self, message: &[u8]) -> SignatureBytes {
        self.key.sign(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nid_round_trips_through_verifying_key() {
        let sk = SigningKey::from_seed([3u8; 32]);
        let vk = sk.verifying_key();
        let nid = Nid::from_verifying_key(&vk);
        let recovered = nid.to_verifying_key().expect("NID must decode");
        assert_eq!(recovered, vk);
    }

    #[test]
    fn nid_has_did_key_ed25519_shape() {
        // The well-known ed25519 multicodec prefix forces every NID to
        // start with `did:key:z6Mk`. If this ever changes we've broken
        // interop with the wider did:key ecosystem.
        let sk = SigningKey::from_seed([0u8; 32]);
        let nid = Nid::from_verifying_key(&sk.verifying_key());
        assert!(
            nid.as_str().starts_with("did:key:z6Mk"),
            "got {}",
            nid.as_str()
        );
        assert!(nid.multibase().starts_with("z6Mk"));
    }

    #[test]
    fn nid_is_deterministic_from_seed() {
        let a = LocalIdentity::from_seed(ActorKind::Agent, "claude", [7u8; 32]);
        let b = LocalIdentity::from_seed(ActorKind::Agent, "claude", [7u8; 32]);
        assert_eq!(a.nid(), b.nid());
    }

    #[test]
    fn distinct_seeds_yield_distinct_nids() {
        let a = LocalIdentity::generate(ActorKind::Human, "alice");
        let b = LocalIdentity::generate(ActorKind::Human, "bob");
        assert_ne!(a.nid(), b.nid());
    }

    #[test]
    fn malformed_nid_rejected() {
        assert!(Nid("did:aura:user/muhammed".into()).to_verifying_key().is_err());
        assert!(Nid("did:key:zNotBase58!!".into()).to_verifying_key().is_err());
        // Valid base58 but wrong length / marker.
        let short = format!("{}{}", Nid::PREFIX, bs58::encode([0xed, 0x01, 0x00]).into_string());
        assert!(Nid(short).to_verifying_key().is_err());
    }

    #[test]
    fn wrong_multicodec_marker_rejected() {
        // base58 of a 34-byte payload whose marker is NOT ed25519.
        let mut payload = vec![0x12, 0x00]; // sha2-256 multicodec, not a key
        payload.extend_from_slice(&[9u8; 32]);
        let bad = format!("{}{}", Nid::PREFIX, bs58::encode(payload).into_string());
        let err = Nid(bad).to_verifying_key().unwrap_err();
        assert!(matches!(err, AttestationError::Identity(_)));
    }

    #[test]
    fn actor_ref_carries_no_secret_and_verifies() {
        let id = LocalIdentity::generate(ActorKind::Agent, "crew-worker-1");
        let actor = id.actor_ref();
        let msg = b"refactor retry_logic to exponential backoff";
        let sig = id.sign(msg);
        actor.verify(msg, &sig).expect("ActorRef recovers the key and verifies");
    }

    #[test]
    fn actor_ref_verify_rejects_tamper() {
        let id = LocalIdentity::generate(ActorKind::Agent, "crew-worker-1");
        let actor = id.actor_ref();
        let sig = id.sign(b"original");
        assert!(actor.verify(b"tampered", &sig).is_err());
    }

    #[test]
    fn actor_ref_serde_round_trip() {
        let id = LocalIdentity::from_seed(ActorKind::Human, "muhammed", [5u8; 32]);
        let actor = id.actor_ref();
        let json = serde_json::to_string(&actor).unwrap();
        let back: ActorRef = serde_json::from_str(&json).unwrap();
        assert_eq!(actor, back);
    }

    #[test]
    fn did_aura_bridges_to_legacy_form() {
        let human = LocalIdentity::from_seed(ActorKind::Human, "muhammed", [1u8; 32]);
        assert_eq!(human.actor_ref().did_aura(), "did:aura:user/muhammed");
        let agent = LocalIdentity::from_seed(ActorKind::Agent, "claude-code", [2u8; 32]);
        assert_eq!(agent.actor_ref().did_aura(), "did:aura:agent/claude-code");
    }

    #[test]
    fn local_identity_sign_verifies_against_its_nid() {
        let id = LocalIdentity::generate(ActorKind::Human, "alice");
        let nid = id.nid();
        let msg = b"deploy to staging";
        let sig = id.sign(msg);
        nid.to_verifying_key()
            .unwrap()
            .verify(msg, &sig)
            .expect("signature verifies against the NID-recovered key");
    }
}
