//! aura-attestation — ed25519 signing and verification for Aura.
//!
//! Tier 1. Depends on `aura-blocks` for the Block envelope shape and its
//! `jcs-rfc8785-v1` canonicalization; pairs them with the ed25519
//! primitive in [`block`] so supervisors don't have to reimplement the
//! signing protocol.
//!
//! Scope:
//!   - generate / load / save an ed25519 keypair (seed at 0600)
//!   - sign arbitrary bytes; produce a detached 64-byte signature
//!   - verify with a public key
//!   - deterministic `key_id` derivation (`did:aura:key/<b64url-first-8>`)
//!   - per-actor identity: a Radicle-style NID (`did:key:z6Mk…`) for each
//!     human and agent, with OS-keychain persistence (see [`identity`] and
//!     [`keychain`])
//!   - sign/verify a [`aura_blocks::Block`] against its JCS canonical form
//!
//! Out of scope:
//!   - signature suites other than ed25519 (multi-algo pluggability is
//!     deferred until there's a concrete second algorithm to support)

pub mod block;
pub mod chain;
pub mod error;
pub mod identity;
#[cfg(feature = "keychain")]
pub mod keychain;
pub mod keyfile;
pub mod keys;
pub mod signature;
pub mod team_keys;

pub use block::{
    canonicalization_tag, sign_block, sign_block_in_place, verify_block, BlockSignError,
    BlockVerifyError, ED25519_ALGO,
};
pub use chain::{walk_chain, ChainError, ChainHop, ChainResult};
pub use error::{AttestationError, VerifyError};
pub use identity::{ActorKind, ActorRef, LocalIdentity, Nid};
pub use keyfile::{load_or_create, load_signing_key, rotate_key, save_signing_key};
pub use keys::{SigningKey, VerifyingKey};
pub use signature::SignatureBytes;
