//! Typed request / response / event bodies for aura-ipc v1.
//!
//! Only the bootstrap-critical variants carry real payloads today. The
//! remaining variants from docs/plan/04-architecture.md are declared as
//! placeholders (unit variants) so the dispatcher matching is exhaustive
//! from day one — downstream waves fill the payloads in without churning
//! the tag set. This follows the annex design rule "keep door open for
//! protocol growth" without adding v1 scope.
//!
//! ACP is deliberately absent. It is a subprocess protocol — the client
//! spawns the agent and speaks JSON-RPC over its stdin and stdout — so no
//! ACP client would go looking for an agent on a Unix socket. Aura's agent
//! surface is `aura acp-serve`, and the verbs it answers (`prove`,
//! `review`, `impacts`) are the CLI's semantic engine; serving them from
//! here would mean the daemon taking a dependency on that entire engine to
//! answer a prompt, inverting which crate is the lightweight one. There
//! were `AcpMessage` variants on all three bodies once. Nothing ever sent
//! one.

use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use uuid::Uuid;

/// Session identifier. UUIDv7 so the timestamp is recoverable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub Uuid);

impl SessionId {
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

/// Client → daemon request bodies. Envelope.kind == Request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RequestBody {
    Handshake(HandshakeRequest),
    ListSessions,
    OpenSession {
        workspace: String,
        agent: Option<String>,
    },
    CloseSession {
        id: SessionId,
    },
    GetBlock {
        id: Uuid,
    },
    ListBlocks {
        filter: BlockFilter,
    },
    SubmitInput {
        session_id: SessionId,
        input: String,
    },
    ApplyOp {
        /// Opaque CBOR-encoded BlockOp (decoded by daemon using aura-blocks).
        op: ByteBuf,
    },
    ClaimZone {
        path: String,
    },
    SendMessage {
        target: String,
        body: String,
    },
    Handover {
        agent: String,
    },
    Subscribe {
        filter: SubscribeFilter,
    },
    GetFleetData {
        active_only: bool,
    },
    /// Publish a headless-observable agent-lifecycle transition onto the
    /// daemon event bus. The shell (today's only authority on agent
    /// lifecycle) emits these so a headless monitor subscribed to the
    /// daemon can observe live agents without a Tauri window. `state` is a
    /// free string — one of session_start|prompt|pre_tool|tool_complete|
    /// idle|blocked|stop — kept open so the shell can add phases without a
    /// wire-format bump. `tool` carries the tool name on pre_tool /
    /// tool_complete; `detail` is an optional human-readable note.
    PublishAgentLifecycle {
        session_id: String,
        state: String,
        tool: Option<String>,
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeRequest {
    /// 32-byte secret read from `daemon.key`. Proves local filesystem access.
    pub secret: ByteBuf,
    /// Client-declared protocol version. Daemon negotiates the minimum.
    pub protocol_version: u16,
    /// Human-readable client identifier (e.g. "aura-term/0.1.0" or "aura-cli").
    pub client: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlockFilter {
    pub session_id: Option<SessionId>,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub states: Vec<String>,
    pub limit: Option<u32>,
    /// Filter by `provenance.actor`. Matches the AgentRef wire form
    /// exactly (e.g. `did:aura:agent/claude-foo`).
    #[serde(default)]
    pub actor: Option<String>,
    /// Anchor kind discriminant — `function`, `file`, `pr`, `zone`,
    /// `build`, `block`, `none`.
    #[serde(default)]
    pub anchor_kind: Option<String>,
    /// Anchor value — only consulted when `anchor_kind` is also set.
    #[serde(default)]
    pub anchor_value: Option<String>,
    /// `updated_at >= since_ms` (epoch ms).
    #[serde(default)]
    pub since_ms: Option<i64>,
    /// `updated_at <= until_ms` (epoch ms).
    #[serde(default)]
    pub until_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubscribeFilter {
    pub kinds: Vec<String>,
    pub session_ids: Vec<SessionId>,
}

/// Daemon → client response bodies. Envelope.kind == Response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseBody {
    HandshakeAck(HandshakeAck),
    SessionList {
        sessions: Vec<SessionId>,
    },
    SessionOpened {
        id: SessionId,
    },
    Ack,
    Block {
        /// Opaque CBOR-encoded Block (see aura-blocks).
        block: ByteBuf,
    },
    BlockList {
        /// Opaque CBOR-encoded Vec<Block>.
        blocks: ByteBuf,
    },
    BlockUpdated {
        id: Uuid,
        new_state: String,
    },
    ZoneClaimed {
        path: String,
    },
    /// Reply to a SendMessage RPC — carries the generated message id so
    /// the client can echo it into logs / reference it in a follow-up.
    MessageSent {
        id: String,
    },
    HandoverXml {
        xml: String,
    },
    FleetData {
        json_payload: String,
    },
    /// Acknowledges a Subscribe; subsequent events flow as Envelope.kind=Event.
    SubscribeAck,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeAck {
    /// Version the daemon agreed to serve on this connection.
    pub accepted_version: u16,
    /// Daemon build identifier (semver + git short hash).
    pub daemon_build: String,
    /// Per-connection identifier (useful for logs + multi-connection scopes).
    pub connection_id: Uuid,
}

/// Daemon → client asynchronous events. Envelope.kind == Event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventBody {
    BlockCreated {
        block_id: Uuid,
        /// None until blocks carry session origin — arrives with W6.5
        /// (per-tab PTY via daemon) when PTY spawn assigns a session.
        session_id: Option<SessionId>,
    },
    OpApplied {
        block_id: Uuid,
        op_id: Uuid,
        new_state: String,
    },
    OutputChunk {
        block_id: Uuid,
        bytes: ByteBuf,
        lamport: u64,
    },
    SidebarCardUpdated {
        block_id: Uuid,
        score: f64,
        bucket: u8,
    },
    Lagged {
        since_lamport: u64,
    },
    PeerJoined {
        peer_id: String,
    },
    PeerLeft {
        peer_id: String,
    },
    /// An agent-lifecycle transition broadcast for headless observers.
    /// Mirrors `RequestBody::PublishAgentLifecycle`: the daemon re-emits
    /// the published payload verbatim onto the event bus so every
    /// subscriber on the lossless stream sees the live agent's phase.
    /// `state` is a free string — one of session_start|prompt|pre_tool|
    /// tool_complete|idle|blocked|stop. Like `PeerJoined` / `PeerLeft`
    /// this variant carries no `lamport`: lifecycle phases are
    /// session-scoped status, not block-output ordering, so there is no
    /// per-block clock to attach.
    AgentLifecycle {
        session_id: String,
        state: String,
        tool: Option<String>,
        detail: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{decode_body, encode_body};

    #[test]
    fn handshake_roundtrip() {
        let req = RequestBody::Handshake(HandshakeRequest {
            secret: ByteBuf::from(vec![0xAB; 32]),
            protocol_version: 1,
            client: "test".into(),
        });
        let bytes = encode_body(&req).unwrap();
        let back: RequestBody = decode_body(&bytes).unwrap();
        match back {
            RequestBody::Handshake(h) => {
                assert_eq!(h.secret.as_ref(), &[0xAB; 32]);
                assert_eq!(h.protocol_version, 1);
                assert_eq!(h.client, "test");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn response_variants_tag_correctly() {
        let ack = ResponseBody::HandshakeAck(HandshakeAck {
            accepted_version: 1,
            daemon_build: "aura-daemon/0.1.0".into(),
            connection_id: Uuid::now_v7(),
        });
        let bytes = encode_body(&ack).unwrap();
        let back: ResponseBody = decode_body(&bytes).unwrap();
        assert!(matches!(back, ResponseBody::HandshakeAck(_)));
    }
}
