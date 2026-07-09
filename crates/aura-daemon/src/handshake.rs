//! First-message Handshake validation + ack construction.
//!
//! The client proves local filesystem access by echoing the 32 bytes from
//! `daemon.key`. Constant-time comparison keeps us out of timing-oracle
//! territory even though the socket is 0600 (defense in depth).

use uuid::Uuid;

use aura_daemon_client::envelope::PROTOCOL_VERSION;
use aura_daemon_client::error::{ProtocolError, ProtocolErrorKind};
use aura_daemon_client::protocol::{HandshakeAck, HandshakeRequest};

pub const MIN_SUPPORTED_VERSION: u16 = 1;

/// Validate the handshake against the daemon's copy of the secret.
pub fn validate(req: &HandshakeRequest, expected_secret: &[u8]) -> Result<(), ProtocolError> {
    if req.protocol_version < MIN_SUPPORTED_VERSION {
        return Err(ProtocolError::new(
            ProtocolErrorKind::UnsupportedVersion,
            format!(
                "client protocol v{} < min v{}",
                req.protocol_version, MIN_SUPPORTED_VERSION
            ),
        ));
    }
    if !constant_time_eq(req.secret.as_ref(), expected_secret) {
        return Err(ProtocolError::new(
            ProtocolErrorKind::Handshake,
            "handshake secret mismatch",
        ));
    }
    Ok(())
}

/// Build the ack the daemon will send on a successful handshake.
pub fn build_ack(daemon_build: &str) -> HandshakeAck {
    HandshakeAck {
        accepted_version: PROTOCOL_VERSION,
        daemon_build: daemon_build.to_string(),
        connection_id: Uuid::now_v7(),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_bytes::ByteBuf;

    fn req_with(secret: Vec<u8>, version: u16) -> HandshakeRequest {
        HandshakeRequest {
            secret: ByteBuf::from(secret),
            protocol_version: version,
            client: "test".into(),
        }
    }

    #[test]
    fn accepts_matching_secret_current_version() {
        let secret = vec![0xAA; 32];
        let req = req_with(secret.clone(), 1);
        validate(&req, &secret).unwrap();
    }

    #[test]
    fn rejects_wrong_secret() {
        let req = req_with(vec![0xAA; 32], 1);
        let err = validate(&req, &vec![0xBB; 32]).unwrap_err();
        assert!(matches!(err.kind, ProtocolErrorKind::Handshake));
    }

    #[test]
    fn rejects_unsupported_version() {
        let req = req_with(vec![0xAA; 32], 0);
        let err = validate(&req, &vec![0xAA; 32]).unwrap_err();
        assert!(matches!(err.kind, ProtocolErrorKind::UnsupportedVersion));
    }

    #[test]
    fn constant_time_eq_length_sensitive() {
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
    }
}
