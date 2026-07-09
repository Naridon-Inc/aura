//! Client-side entry point. Opens the daemon socket, reads the keyfile,
//! performs Handshake, and exposes a simple request/response API.
//!
//! For W4 the API is deliberately minimal: `connect` + `handshake`. W4.5
//! adds typed helpers (`list_sessions`, `get_block`, …) and W4.6 adds
//! `subscribe`. All three layers share this underlying framed-envelope
//! transport.

use std::path::Path;
use std::time::Duration;

use serde_bytes::ByteBuf;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::envelope::{read_frame, write_frame, Envelope, MessageKind, PROTOCOL_VERSION};
use crate::error::{ProtocolError, ProtocolErrorKind, WireError};
use crate::paths::DaemonPaths;
use crate::protocol::{BlockFilter, HandshakeAck, HandshakeRequest, RequestBody, ResponseBody};

/// Minimum supported protocol version the client will agree to.
pub const MIN_SUPPORTED_VERSION: u16 = 1;

/// Default handshake timeout. Intentionally short — a healthy daemon
/// answers in single-digit ms.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Client {
    stream: Mutex<UnixStream>,
    next_msg_id: Mutex<u64>,
    ack: HandshakeAck,
}

impl Client {
    /// Open a connection using the platform-default socket + keyfile.
    pub async fn connect_default(client_name: impl Into<String>) -> Result<Self, ProtocolError> {
        let paths = DaemonPaths::platform_default()?;
        Self::connect(&paths, client_name).await
    }

    /// Open a connection using explicit paths (tests, alt installs).
    pub async fn connect(
        paths: &DaemonPaths,
        client_name: impl Into<String>,
    ) -> Result<Self, ProtocolError> {
        let secret = read_keyfile(paths.keyfile()).await?;
        let stream = UnixStream::connect(paths.socket())
            .await
            .map_err(ProtocolError::from_io)?;
        Self::handshake_on(stream, secret, client_name.into()).await
    }

    /// Handshake on an already-connected stream. Used by tests that inject
    /// a duplex pair, and by future multiplexers.
    pub async fn handshake_on(
        stream: UnixStream,
        secret: Vec<u8>,
        client_name: String,
    ) -> Result<Self, ProtocolError> {
        let stream = Mutex::new(stream);
        let next = Mutex::new(1u64);
        let client = Self {
            stream,
            next_msg_id: next,
            ack: HandshakeAck {
                accepted_version: 0,
                daemon_build: String::new(),
                connection_id: uuid::Uuid::nil(),
            },
        };

        let req = RequestBody::Handshake(HandshakeRequest {
            secret: ByteBuf::from(secret),
            protocol_version: PROTOCOL_VERSION,
            client: client_name,
        });

        let fut = async {
            let env = client.send_request_inner(&req).await?;
            parse_response::<HandshakeAck, _>(env, |r| match r {
                ResponseBody::HandshakeAck(a) => Some(a),
                _ => None,
            })
        };

        let ack = timeout(DEFAULT_HANDSHAKE_TIMEOUT, fut)
            .await
            .map_err(|_| {
                ProtocolError::new(ProtocolErrorKind::Handshake, "handshake timed out")
            })??;

        if ack.accepted_version < MIN_SUPPORTED_VERSION {
            return Err(ProtocolError::new(
                ProtocolErrorKind::UnsupportedVersion,
                format!(
                    "daemon offered v{}, client requires >= v{}",
                    ack.accepted_version, MIN_SUPPORTED_VERSION
                ),
            ));
        }

        Ok(Self { ack, ..client })
    }

    /// Handshake result (version + daemon build id).
    pub fn handshake_ack(&self) -> &HandshakeAck {
        &self.ack
    }

    async fn send_request_inner(&self, body: &RequestBody) -> Result<Envelope, ProtocolError> {
        let msg_id = {
            let mut g = self.next_msg_id.lock().await;
            let id = *g;
            *g = g.wrapping_add(1);
            id
        };
        let env = Envelope::new_request(msg_id, body)?;
        let mut stream = self.stream.lock().await;
        write_frame(&mut *stream, &env).await?;
        read_frame(&mut *stream).await
    }

    /// Low-level escape hatch — send any RequestBody and get the raw Envelope
    /// back. W4.5 adds typed wrappers on top.
    pub async fn request(&self, body: &RequestBody) -> Result<Envelope, ProtocolError> {
        self.send_request_inner(body).await
    }

    // ── Typed wrappers (W4.5) ──────────────────────────────────────────────

    /// Open a new session on the daemon. Returns the server-assigned id.
    pub async fn open_session(
        &self,
        workspace: impl Into<String>,
        agent: Option<String>,
    ) -> Result<crate::protocol::SessionId, ProtocolError> {
        let env = self
            .request(&RequestBody::OpenSession {
                workspace: workspace.into(),
                agent,
            })
            .await?;
        parse_response(env, |r| match r {
            ResponseBody::SessionOpened { id } => Some(id),
            _ => None,
        })
    }

    /// List the ids of all sessions currently open on the daemon.
    pub async fn list_sessions(
        &self,
    ) -> Result<Vec<crate::protocol::SessionId>, ProtocolError> {
        let env = self.request(&RequestBody::ListSessions).await?;
        parse_response(env, |r| match r {
            ResponseBody::SessionList { sessions } => Some(sessions),
            _ => None,
        })
    }

    /// Close a previously-opened session. Returns `NotFound` if the id is unknown.
    pub async fn close_session(
        &self,
        id: crate::protocol::SessionId,
    ) -> Result<(), ProtocolError> {
        let env = self.request(&RequestBody::CloseSession { id }).await?;
        parse_response(env, |r| match r {
            ResponseBody::Ack => Some(()),
            _ => None,
        })
    }

    /// Fetch a block by id as the canonical JSON-encoded bytes. Tier-0
    /// clients decode with `serde_json::from_slice` using their own
    /// `aura-blocks` dep; keeping the aura-blocks type off this crate's
    /// surface preserves the tier 0 → tier 1 dependency direction.
    pub async fn get_block_raw(
        &self,
        id: uuid::Uuid,
    ) -> Result<Vec<u8>, ProtocolError> {
        let env = self.request(&RequestBody::GetBlock { id }).await?;
        parse_response(env, |r| match r {
            ResponseBody::Block { block } => Some(block.into_vec()),
            _ => None,
        })
    }

    /// Fetch a list of blocks as the canonical JSON-encoded bytes of a
    /// `Vec<Block>`. Tier-0 clients decode with `serde_json::from_slice`.
    /// Pass `BlockFilter::default()` for an unfiltered listing.
    pub async fn list_blocks_raw(
        &self,
        filter: BlockFilter,
    ) -> Result<Vec<u8>, ProtocolError> {
        let env = self.request(&RequestBody::ListBlocks { filter }).await?;
        parse_response(env, |r| match r {
            ResponseBody::BlockList { blocks } => Some(blocks.into_vec()),
            _ => None,
        })
    }

    /// Export a dense XML snapshot of daemon-known state for agent
    /// handover. `agent` is echoed back in the root element so the
    /// recipient can tell whose handover this is. The XML covers open
    /// sessions, the most recent ~50 blocks with intent + anchor +
    /// policy, and kind/state count totals over the full store.
    pub async fn handover(&self, agent: impl Into<String>) -> Result<String, ProtocolError> {
        let env = self
            .request(&RequestBody::Handover {
                agent: agent.into(),
            })
            .await?;
        parse_response(env, |r| match r {
            ResponseBody::HandoverXml { xml } => Some(xml),
            _ => None,
        })
    }

    /// Claim a Sentinel zone. `path` becomes a single pattern under the
    /// connection's session id with Warn-mode semantics. Returns the
    /// server's echoed `path` (includes the generated zone id) so
    /// callers can correlate with zone-file contents on disk.
    pub async fn claim_zone(
        &self,
        path: impl Into<String>,
    ) -> Result<String, ProtocolError> {
        let env = self
            .request(&RequestBody::ClaimZone {
                path: path.into(),
            })
            .await?;
        parse_response(env, |r| match r {
            ResponseBody::ZoneClaimed { path } => Some(path),
            _ => None,
        })
    }

    /// Send a Sentinel mailbox message. `target` is either a session id
    /// for a direct message or `""` / `"*"` for a broadcast. Returns the
    /// generated message id so the caller can reference or log it.
    pub async fn send_message(
        &self,
        target: impl Into<String>,
        body: impl Into<String>,
    ) -> Result<String, ProtocolError> {
        let env = self
            .request(&RequestBody::SendMessage {
                target: target.into(),
                body: body.into(),
            })
            .await?;
        parse_response(env, |r| match r {
            ResponseBody::MessageSent { id } => Some(id),
            _ => None,
        })
    }

    /// Apply a single BlockOp. `op_json` must be a canonical JSON-encoded
    /// `aura_blocks::BlockOp`. Returns the reduced block's id and its
    /// post-fold state as the wire-form snake_case name (matches the
    /// `#[serde(rename_all = "snake_case")]` repr on `BlockState`, e.g.
    /// `"running"` / `"gated"`). Same form `BlockFilter.states` accepts.
    pub async fn apply_op_raw(
        &self,
        op_json: Vec<u8>,
    ) -> Result<(uuid::Uuid, String), ProtocolError> {
        let env = self
            .request(&RequestBody::ApplyOp {
                op: ByteBuf::from(op_json),
            })
            .await?;
        parse_response(env, |r| match r {
            ResponseBody::BlockUpdated { id, new_state } => Some((id, new_state)),
            _ => None,
        })
    }
}

fn parse_response<T, F>(env: Envelope, pick: F) -> Result<T, ProtocolError>
where
    F: FnOnce(ResponseBody) -> Option<T>,
{
    match env.kind {
        MessageKind::Response => {
            let body: ResponseBody = env.decode_body()?;
            pick(body).ok_or_else(|| {
                ProtocolError::new(
                    ProtocolErrorKind::Domain,
                    "daemon returned unexpected response variant",
                )
            })
        }
        MessageKind::Error => {
            let w: WireError = env.decode_body()?;
            Err(w.into())
        }
        other => Err(ProtocolError::new(
            ProtocolErrorKind::Domain,
            format!("expected Response, got {other:?}"),
        )),
    }
}

/// Read the 32-byte secret from `daemon.key`. Rejects any other size so the
/// handshake fails fast instead of with a cryptic mismatch later. Exported
/// so both `Client` and `EventStream` share one implementation.
pub async fn read_keyfile(path: &Path) -> Result<Vec<u8>, ProtocolError> {
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(ProtocolError::from_io)?;
    let mut buf = Vec::with_capacity(32);
    f.read_to_end(&mut buf)
        .await
        .map_err(ProtocolError::from_io)?;
    if buf.len() != 32 {
        return Err(ProtocolError::new(
            ProtocolErrorKind::Handshake,
            format!("daemon.key must be exactly 32 bytes (got {})", buf.len()),
        ));
    }
    Ok(buf)
}

/// Quick access on the raw read/write halves of a client stream — reserved
/// for internal transports that already split the connection. Kept here so
/// the trait bounds match the future multi-RPC state machine.
#[allow(dead_code)]
async fn _bounds_check<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>() {}
