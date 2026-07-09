//! Typed error enum. Per the cross-editor annex design rules, error
//! responses on the wire must be typed — not free-text — so future SDKs
//! can code-gen against them.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProtocolErrorKind {
    /// CBOR encode / decode failure.
    Codec,
    /// Frame exceeded `FRAME_MAX_BYTES` on read or write.
    FrameTooLarge,
    /// Underlying socket / I/O failure.
    Io,
    /// Handshake was rejected (bad secret, incompatible version, not-first).
    Handshake,
    /// Request references a session / block / resource that does not exist.
    NotFound,
    /// Caller is not authorized for this request.
    Unauthorized,
    /// Schema version on the envelope is unsupported.
    UnsupportedVersion,
    /// Something the daemon cannot currently satisfy (temporary).
    Unavailable,
    /// Catch-all for well-formed requests the daemon rejects for
    /// domain reasons (e.g. illegal state transition).
    Domain,
}

#[derive(Debug, Error)]
#[error("{kind:?}: {message}")]
pub struct ProtocolError {
    pub kind: ProtocolErrorKind,
    pub message: String,
}

impl ProtocolError {
    pub fn new(kind: ProtocolErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn from_io(err: std::io::Error) -> Self {
        Self {
            kind: ProtocolErrorKind::Io,
            message: err.to_string(),
        }
    }
}

/// Wire-compatible error body (sent inside Envelope when kind=Error).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireError {
    pub kind: ProtocolErrorKind,
    pub message: String,
}

impl From<&ProtocolError> for WireError {
    fn from(e: &ProtocolError) -> Self {
        Self {
            kind: e.kind,
            message: e.message.clone(),
        }
    }
}

impl From<WireError> for ProtocolError {
    fn from(w: WireError) -> Self {
        Self {
            kind: w.kind,
            message: w.message,
        }
    }
}
