//! Envelope + framed CBOR codec over tokio AsyncRead/AsyncWrite.
//!
//! Frame layout on the wire:
//!   [4-byte big-endian length N] [N bytes of CBOR-encoded Envelope]
//!
//! The envelope body is itself CBOR-encoded into an opaque byte vec so that
//! routing (by `kind`) can happen before a downstream dispatcher parses the
//! typed payload. This matches the "RawCbor" shape in docs/plan/04.

use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{ProtocolError, ProtocolErrorKind};

/// Current aura-ipc wire version. Bumped when the envelope or framing changes.
pub const PROTOCOL_VERSION: u16 = 1;

/// Maximum single-frame size (4 MiB). Guards against pathological inputs and
/// aligns with the output-ring tier ceiling in aura-blockstore.
pub const FRAME_MAX_BYTES: u32 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageKind {
    Request,
    Response,
    Event,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub msg_id: u64,
    pub in_reply_to: Option<u64>,
    pub kind: MessageKind,
    /// Opaque CBOR payload. Decoded by dispatcher based on `kind` + routing
    /// context (e.g. the matching Request for a Response, or the typed
    /// Request enum variant).
    pub body: ByteBuf,
    pub schema_version: u16,
}

impl Envelope {
    pub fn new_request<T: Serialize>(msg_id: u64, body: &T) -> Result<Self, ProtocolError> {
        Ok(Self {
            msg_id,
            in_reply_to: None,
            kind: MessageKind::Request,
            body: ByteBuf::from(encode_body(body)?),
            schema_version: PROTOCOL_VERSION,
        })
    }

    pub fn new_response<T: Serialize>(
        msg_id: u64,
        in_reply_to: u64,
        body: &T,
    ) -> Result<Self, ProtocolError> {
        Ok(Self {
            msg_id,
            in_reply_to: Some(in_reply_to),
            kind: MessageKind::Response,
            body: ByteBuf::from(encode_body(body)?),
            schema_version: PROTOCOL_VERSION,
        })
    }

    pub fn new_event<T: Serialize>(msg_id: u64, body: &T) -> Result<Self, ProtocolError> {
        Ok(Self {
            msg_id,
            in_reply_to: None,
            kind: MessageKind::Event,
            body: ByteBuf::from(encode_body(body)?),
            schema_version: PROTOCOL_VERSION,
        })
    }

    pub fn new_error<T: Serialize>(
        msg_id: u64,
        in_reply_to: Option<u64>,
        body: &T,
    ) -> Result<Self, ProtocolError> {
        Ok(Self {
            msg_id,
            in_reply_to,
            kind: MessageKind::Error,
            body: ByteBuf::from(encode_body(body)?),
            schema_version: PROTOCOL_VERSION,
        })
    }

    pub fn decode_body<T: for<'de> Deserialize<'de>>(&self) -> Result<T, ProtocolError> {
        decode_body(self.body.as_ref())
    }
}

pub fn encode_body<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    let mut buf = Vec::new();
    ciborium::into_writer(value, &mut buf)
        .map_err(|e| ProtocolError::new(ProtocolErrorKind::Codec, e.to_string()))?;
    Ok(buf)
}

pub fn decode_body<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, ProtocolError> {
    ciborium::from_reader(bytes)
        .map_err(|e| ProtocolError::new(ProtocolErrorKind::Codec, e.to_string()))
}

/// Write a single framed envelope to the stream.
pub async fn write_frame<W>(w: &mut W, env: &Envelope) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
{
    let mut buf = Vec::with_capacity(256);
    ciborium::into_writer(env, &mut buf)
        .map_err(|e| ProtocolError::new(ProtocolErrorKind::Codec, e.to_string()))?;
    let len = buf.len();
    if len as u64 > FRAME_MAX_BYTES as u64 {
        return Err(ProtocolError::new(
            ProtocolErrorKind::FrameTooLarge,
            format!("frame {} exceeds max {}", len, FRAME_MAX_BYTES),
        ));
    }
    let len_be = (len as u32).to_be_bytes();
    w.write_all(&len_be).await.map_err(ProtocolError::from_io)?;
    w.write_all(&buf).await.map_err(ProtocolError::from_io)?;
    w.flush().await.map_err(ProtocolError::from_io)?;
    Ok(())
}

/// Read a single framed envelope from the stream.
pub async fn read_frame<R>(r: &mut R) -> Result<Envelope, ProtocolError>
where
    R: AsyncRead + Unpin,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)
        .await
        .map_err(ProtocolError::from_io)?;
    let len = u32::from_be_bytes(len_buf);
    if len > FRAME_MAX_BYTES {
        return Err(ProtocolError::new(
            ProtocolErrorKind::FrameTooLarge,
            format!("incoming frame {} exceeds max {}", len, FRAME_MAX_BYTES),
        ));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)
        .await
        .map_err(ProtocolError::from_io)?;
    let env: Envelope = ciborium::from_reader(body.as_slice())
        .map_err(|e| ProtocolError::new(ProtocolErrorKind::Codec, e.to_string()))?;
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
    struct TinyBody {
        label: String,
        n: u32,
    }

    #[tokio::test]
    async fn frame_roundtrip() {
        let (mut a, mut b) = duplex(1024);
        let body = TinyBody {
            label: "hi".into(),
            n: 7,
        };
        let out = Envelope::new_request(1, &body).unwrap();
        write_frame(&mut a, &out).await.unwrap();
        let got = read_frame(&mut b).await.unwrap();
        assert_eq!(got.msg_id, 1);
        assert_eq!(got.kind, MessageKind::Request);
        assert_eq!(got.schema_version, PROTOCOL_VERSION);
        let decoded: TinyBody = got.decode_body().unwrap();
        assert_eq!(decoded, body);
    }

    #[tokio::test]
    async fn oversized_frame_rejected() {
        let (mut a, _b) = duplex(8);
        let big = vec![0u8; (FRAME_MAX_BYTES as usize) + 1];
        let env = Envelope {
            msg_id: 1,
            in_reply_to: None,
            kind: MessageKind::Request,
            body: ByteBuf::from(big),
            schema_version: PROTOCOL_VERSION,
        };
        let err = write_frame(&mut a, &env).await.unwrap_err();
        assert!(matches!(err.kind, ProtocolErrorKind::FrameTooLarge));
    }
}
