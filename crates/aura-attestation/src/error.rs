use thiserror::Error;

#[derive(Debug, Error)]
pub enum AttestationError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("keyfile has wrong length: expected 32 bytes, got {0}")]
    KeyfileLength(usize),

    #[error("ed25519 key error: {0}")]
    Key(String),

    #[error("base64 decode: {0}")]
    Base64(String),

    #[error("identity: {0}")]
    Identity(String),

    #[error("keychain: {0}")]
    Keychain(String),
}

/// Dedicated enum for verification failures so callers can distinguish a
/// tampered payload (`Invalid`) from an operational error (`Malformed`).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum VerifyError {
    #[error("signature did not verify — payload tampered or key mismatch")]
    Invalid,

    #[error("signature bytes malformed: {0}")]
    Malformed(String),
}
