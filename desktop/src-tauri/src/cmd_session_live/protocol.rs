//! Wire types for the session-live plane.
//!
//! This is the desktop half of `docs/collab/SESSION_LIVE_PROTOCOL.md` — the
//! single WebSocket per session that lets two people (and their agents) occupy
//! the same coding session. Frame names and field names are copied from that
//! document verbatim; the cloud and the React surfaces are reading the same
//! contract, so a rename here is a silent break there.
//!
//! Two shapes deliberately differ from a naive port:
//!
//!  * Outbound frames are a typed enum, because we control every one we send
//!    and a typo should be a compile error.
//!  * Inbound frames are dispatched from a `serde_json::Value` on the `type`
//!    discriminator, then deserialised per-arm. The protocol requires unknown
//!    `type` values to be ignored rather than to close the socket, and a single
//!    `#[serde(deny_unknown…)]`-ish enum would fail the whole frame on a field
//!    the cloud added after us.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// How the local participant describes itself in `hello.as` (and, for the
/// agent this desktop runs, in the `hello.agents` extension).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Identity {
    pub name: String,
    pub avatar: Option<String>,
    /// "human" | "agent"
    pub kind: String,
    /// "claude" | "gemini" | "codex" | … — only meaningful when `kind` is
    /// "agent"; omitted otherwise so the frame stays close to the doc.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent_kind: Option<String>,
}

/// A symbol a message is *about*. Carried on `msg.refs` so the sidebar can
/// render "…about `retry_logic`" without parsing prose.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SymbolRef {
    pub symbol: String,
    pub file: String,
}

/// Who produced a transcript entry. The whole reason a shared session is
/// legible: a `role: "user"` entry is no longer implicitly *you*.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Author {
    pub id: String,
    pub name: String,
    /// "human" | "agent"
    pub kind: String,
}

/// One item of session transcript.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Entry {
    pub id: String,
    /// Server-assigned and monotonic. Absent on the way up (we do not get to
    /// choose it), present on the way down.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub seq: Option<u64>,
    /// "user" | "assistant" | "tool" | "system"
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub author: Option<Author>,
    pub text: String,
    pub at: i64,
}

/// A participant as the server reports it in `ready.you` / `presence`.
///
/// Every field is `#[serde(default)]` because this record is the one piece of
/// the protocol most likely to grow, and a missing field must not cost us the
/// whole presence frame.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Participant {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar: Option<String>,
    /// "human" | "agent"
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub agent_kind: Option<String>,
    /// "host" | "guest"
    #[serde(default)]
    pub role: String,
    /// "watch" | "drive". Empty when the server has not stamped it — see
    /// `ctx::resolve_access_inbound`, which resolves that case rather than guessing
    /// "drive".
    #[serde(default)]
    pub access: String,
    /// "coding" | "instructing" | "talking" | "watching" | "idle"
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub since: i64,
}

/// May see everything, may act on nothing.
pub const ACCESS_WATCH: &str = "watch";
/// May additionally send `msg` and open tunnels — and therefore may cause text
/// to be executed by an agent on somebody else's machine.
pub const ACCESS_DRIVE: &str = "drive";
pub const ACCESS_LEVELS: &[&str] = &[ACCESS_WATCH, ACCESS_DRIVE];

/// The access level a participant record *states*, or `None` when the field is
/// absent or unrecognised. Kept separate from any fallback so the fallback is a
/// deliberate decision at the call site rather than a silent default here.
pub fn declared_access(p: &Participant) -> Option<&'static str> {
    match p.access.as_str() {
        ACCESS_WATCH => Some(ACCESS_WATCH),
        ACCESS_DRIVE => Some(ACCESS_DRIVE),
        _ => None,
    }
}

/// Frames this desktop sends. `type` + snake_case variant names match the doc.
#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Hello {
        token: String,
        /// "host" | "guest"
        role: &'static str,
        #[serde(rename = "as")]
        as_who: Identity,
        /// EXTENSION (not yet in the doc): the agents this desktop hosts, so
        /// the server can mint an agent `Participant` for each and other
        /// people can address them by id. Without it there is nothing for a
        /// peer's `msg.to` to point at, and agent→agent is unreachable.
        /// A server that ignores the field degrades to "humans only", which is
        /// why it is additive rather than a new frame.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        agents: Vec<Identity>,
        /// Catch-up cursor on reconnect — the last `seq` we saw. Mirrors the
        /// `?since=<seq>` the doc specifies for the URL; sent in the frame too
        /// because the reconnect may race the server's own bookkeeping.
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<u64>,
    },

    /// THE addressable message. One frame for human→agent, human→human,
    /// agent→agent, agent→human and broadcast. `from`, `seq` and `at` are
    /// stamped by the server, so they are absent here.
    Msg {
        /// `None` = broadcast to the room. Broadcast never instructs an agent.
        to: Option<String>,
        text: String,
        /// "instruct" | "ask" | "tell" | "handoff" | "chat"
        intent: String,
        refs: Vec<SymbolRef>,
        reply_to: Option<String>,
    },

    /// Host-only: agent output as it streams.
    Transcript {
        entry: Entry,
    },

    Typing {
        on: bool,
    },

    Cursor {
        file: String,
        line: u64,
    },

    /// EXTENSION (not yet in the doc's client→server list): `Participant.state`
    /// is documented as "set by the client and echoed by the server", but no
    /// frame carries it. This is that frame. Safe to send at any time — the doc
    /// requires unknown `type` values to be ignored, so a server without it
    /// drops the frame instead of dropping us.
    State {
        /// "coding" | "instructing" | "talking" | "watching" | "idle"
        state: String,
    },

    /// EXTENSION (the doc lists `impact` server→client only): the desktop is
    /// where a collision is *noticed* — `.aura/impacts.jsonl` is written
    /// locally — so the client has to be able to originate one. The server
    /// stamps `from` and `at` and fans it out unchanged.
    Impact {
        symbol: String,
        file: String,
        /// "direct" | "likely"
        severity: String,
    },

    /// Host-only: the answer to a `tunnel_req`.
    TunnelRes {
        id: String,
        status: u16,
        headers: BTreeMap<String, String>,
        body_b64: Option<String>,
    },

    /// Host-only: a tunnel this session was reaching has gone. The doc lists
    /// `tunnel_closed` server→client, but the host is where a tunnel actually
    /// dies — the cloud only learns of it because we say so. Without this a
    /// guest keeps showing a live-looking link to a port that closed minutes
    /// ago.
    TunnelClosed {
        code: String,
        port: u16,
    },

    Bye {},
}

/// `{"type":"ready", …}` — first frame the server sends after `hello`.
#[derive(Deserialize, Debug, Clone, Default)]
pub struct ReadyFrame {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub you: Option<Participant>,
    #[serde(default)]
    pub host_online: bool,
    /// EXTENSION, paired with `hello.agents`: the participant ids the server
    /// minted for the agents we declared. Authoritative answer to "which agent
    /// participants live on this desktop", which is what decides whether an
    /// inbound `msg` gets injected. When absent we fall back to the
    /// `Participant.role == "host"` reading — see `ConnCtx::hosts_agent`.
    #[serde(default)]
    pub your_agents: Vec<String>,
}

/// `{"type":"presence", "participants":[…]}`
#[derive(Deserialize, Debug, Clone, Default)]
pub struct PresenceFrame {
    #[serde(default)]
    pub participants: Vec<Participant>,
}

/// `{"type":"transcript", "seq":128, "entry":{…}}`
#[derive(Deserialize, Debug, Clone)]
pub struct TranscriptFrame {
    #[serde(default)]
    pub seq: Option<u64>,
    pub entry: Entry,
}

/// `{"type":"msg", "seq":129, "from":"p_…", …}` — the server-stamped form.
#[derive(Deserialize, Debug, Clone)]
pub struct MsgFrame {
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_intent")]
    pub intent: String,
    #[serde(default)]
    pub refs: Vec<SymbolRef>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub at: Option<i64>,
}

fn default_intent() -> String {
    "chat".to_string()
}

/// `{"type":"error", "message":"…", "fatal":false}`
#[derive(Deserialize, Debug, Clone, Default)]
pub struct ErrorFrame {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub fatal: bool,
}

/// `{"type":"tunnel_req", …}` — a request the cloud received on `/t/{code}/…`
/// and is asking this desktop to serve from loopback.
#[derive(Deserialize, Debug, Clone)]
pub struct TunnelReqFrame {
    pub id: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body_b64: Option<String>,
    /// EXTENSION: which tunnel this request belongs to. The doc's `tunnel_req`
    /// carries neither, which leaves the host guessing when more than one port
    /// is open. We accept either, prefer `port`, and refuse to guess when both
    /// are missing and the answer is ambiguous — guessing is how a proxy ends
    /// up serving the wrong service.
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub code: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
}

/// `{"type":"tunnel_closed", "code":"k3f9qa", "port":3000}` — fanned out by the
/// cloud so a guest can retire a link whose port is gone.
#[derive(Deserialize, Debug, Clone, Default)]
pub struct TunnelClosedFrame {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub port: Option<u16>,
}

/// One row of `GET /api/v2/sessions/{external_id}/tunnels`. The cloud owns that
/// endpoint; this desktop owns keeping it truthful, which means reconciling
/// against it rather than assuming local state is the whole picture.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
pub struct TunnelSummary {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub url: String,
}

/// The set of presence states the sidebar renders. Anything else is rejected
/// at the command boundary so a typo cannot make a participant invisible.
pub const PRESENCE_STATES: &[&str] = &[
    "coding",
    "instructing",
    "talking",
    "watching",
    "idle",
];

/// The `intent` values the doc defines. Unknown intents are rejected locally
/// rather than sent, because `intent` drives rendering on every surface.
pub const INTENTS: &[&str] = &["instruct", "ask", "tell", "handoff", "chat"];

/// Seconds since the Unix epoch — the `at` unit everywhere in this protocol.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
