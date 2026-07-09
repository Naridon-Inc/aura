//! `EventStream` — dedicated subscription connection.
//!
//! v1 uses one connection per client role: a `Client` for request / reply
//! RPC, an `EventStream` for server-pushed events. The alternative —
//! multiplexing requests + events on a single connection — is a v2 track
//! (annex-daemon-cross-editor.md). Keeping the surfaces separate avoids
//! the reader-task + demux state machine and lets `Client::request`
//! stay a simple `write; read`.
//!
//! Lifecycle:
//!   1. Read keyfile.
//!   2. Connect socket.
//!   3. Send `Handshake` request, receive `HandshakeAck`.
//!   4. Send `Subscribe` request, receive `SubscribeAck`.
//!   5. Loop `recv()` → `EventBody` until the daemon closes or an error
//!      surfaces (Lagged / Codec / Io).

use std::time::Duration;

use serde_bytes::ByteBuf;
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;
use tokio::time::timeout;

use crate::client::{read_keyfile, DEFAULT_HANDSHAKE_TIMEOUT, MIN_SUPPORTED_VERSION};
use crate::envelope::{read_frame, write_frame, Envelope, MessageKind, PROTOCOL_VERSION};
use crate::error::{ProtocolError, ProtocolErrorKind, WireError};
use crate::paths::DaemonPaths;
use crate::protocol::{
    EventBody, HandshakeAck, HandshakeRequest, RequestBody, ResponseBody, SubscribeFilter,
};

pub struct EventStream {
    stream: UnixStream,
    ack: HandshakeAck,
}

impl EventStream {
    /// Open a subscription connection and negotiate Handshake + Subscribe.
    /// The empty filter passes every event; caller-side filtering lives on
    /// the matching `recv` arm.
    pub async fn connect(
        paths: &DaemonPaths,
        client_name: impl Into<String>,
    ) -> Result<Self, ProtocolError> {
        Self::connect_with_filter(paths, client_name, SubscribeFilter::default()).await
    }

    pub async fn connect_with_filter(
        paths: &DaemonPaths,
        client_name: impl Into<String>,
        filter: SubscribeFilter,
    ) -> Result<Self, ProtocolError> {
        let secret = read_keyfile(paths.keyfile()).await?;
        let mut stream = UnixStream::connect(paths.socket())
            .await
            .map_err(ProtocolError::from_io)?;

        // ── Handshake ────────────────────────────────────────────────────
        let handshake = RequestBody::Handshake(HandshakeRequest {
            secret: ByteBuf::from(secret),
            protocol_version: PROTOCOL_VERSION,
            client: client_name.into(),
        });
        let ack = timeout(
            DEFAULT_HANDSHAKE_TIMEOUT,
            handshake_on_stream(&mut stream, &handshake),
        )
        .await
        .map_err(|_| ProtocolError::new(ProtocolErrorKind::Handshake, "handshake timed out"))??;

        if ack.accepted_version < MIN_SUPPORTED_VERSION {
            return Err(ProtocolError::new(
                ProtocolErrorKind::UnsupportedVersion,
                format!("daemon offered v{}", ack.accepted_version),
            ));
        }

        // ── Subscribe ────────────────────────────────────────────────────
        let sub = Envelope::new_request(2, &RequestBody::Subscribe { filter })?;
        write_frame(&mut stream, &sub).await?;
        let ack_env = read_frame(&mut stream).await?;
        match ack_env.kind {
            MessageKind::Response => {
                let body: ResponseBody = ack_env.decode_body()?;
                match body {
                    ResponseBody::SubscribeAck => {}
                    other => {
                        return Err(ProtocolError::new(
                            ProtocolErrorKind::Domain,
                            format!("expected SubscribeAck, got {other:?}"),
                        ))
                    }
                }
            }
            MessageKind::Error => {
                let w: WireError = ack_env.decode_body()?;
                return Err(w.into());
            }
            other => {
                return Err(ProtocolError::new(
                    ProtocolErrorKind::Domain,
                    format!("expected Response, got {other:?}"),
                ))
            }
        }

        Ok(Self { stream, ack })
    }

    pub fn handshake_ack(&self) -> &HandshakeAck {
        &self.ack
    }

    /// Await the next event on this subscription. Returns `None` when the
    /// daemon closes the stream cleanly; returns `Some(Err(_))` for codec
    /// or protocol errors; returns `Some(Ok(EventBody))` otherwise.
    pub async fn recv(&mut self) -> Option<Result<EventBody, ProtocolError>> {
        match read_frame(&mut self.stream).await {
            Ok(env) => Some(decode_event(env)),
            Err(e) if e.kind == ProtocolErrorKind::Io => None,
            Err(e) => Some(Err(e)),
        }
    }

    /// Same as `recv` but fails after `dur` without the daemon producing
    /// a frame. Returns `Ok(None)` on timeout so the caller can loop.
    pub async fn recv_with_timeout(
        &mut self,
        dur: Duration,
    ) -> Result<Option<EventBody>, ProtocolError> {
        match timeout(dur, self.recv()).await {
            Ok(Some(Ok(ev))) => Ok(Some(ev)),
            Ok(Some(Err(e))) => Err(e),
            Ok(None) => Ok(None),
            Err(_) => Ok(None),
        }
    }
}

fn decode_event(env: Envelope) -> Result<EventBody, ProtocolError> {
    match env.kind {
        MessageKind::Event => env.decode_body(),
        MessageKind::Error => {
            let w: WireError = env.decode_body()?;
            Err(w.into())
        }
        other => Err(ProtocolError::new(
            ProtocolErrorKind::Domain,
            format!("expected Event, got {other:?}"),
        )),
    }
}

async fn handshake_on_stream(
    stream: &mut UnixStream,
    handshake: &RequestBody,
) -> Result<HandshakeAck, ProtocolError> {
    let env = Envelope::new_request(1, handshake)?;
    write_frame(stream, &env).await?;
    let resp = read_frame(stream).await?;
    match resp.kind {
        MessageKind::Response => {
            let body: ResponseBody = resp.decode_body()?;
            match body {
                ResponseBody::HandshakeAck(a) => Ok(a),
                other => Err(ProtocolError::new(
                    ProtocolErrorKind::Handshake,
                    format!("expected HandshakeAck, got {other:?}"),
                )),
            }
        }
        MessageKind::Error => {
            let w: WireError = resp.decode_body()?;
            Err(w.into())
        }
        other => Err(ProtocolError::new(
            ProtocolErrorKind::Handshake,
            format!("expected Response, got {other:?}"),
        )),
    }
}

/// Silence the unused-warning if `AsyncReadExt` gets tree-shaken by a
/// feature change in the future — we rely on it implicitly via `read_frame`
/// today but keep the binding explicit for intent.
#[allow(dead_code)]
fn _trait_bound() {
    fn _requires<T: AsyncReadExt>() {}
}
