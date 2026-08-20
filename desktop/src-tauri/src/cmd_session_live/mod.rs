//! Session Live — the desktop half of the multiplayer coding session.
//!
//! One WebSocket per session to `/api/v2/sessions/{external_id}/live/ws`. The
//! host is the desktop that actually runs the agent; it publishes the agent's
//! transcript and is the only machine that can inject anything into the running
//! process. Guests join the same socket, see history plus live frames, and can
//! address a message at a person or at an agent.
//!
//! The full contract lives in `docs/collab/SESSION_LIVE_PROTOCOL.md` and is
//! shared with aura-cloud and the React surfaces. `protocol.rs` mirrors it
//! field for field; anything this module adds on top is marked EXTENSION there
//! with the reason.
//!
//! Layout:
//!   • `protocol.rs` — wire types.
//!   • `ctx.rs`      — per-session state, and the two gates that decide whether
//!                     someone else's text runs here: `hosts_agent` + `may_drive`.
//!   • `conn.rs`     — dial / hello / pump / reconnect / inbound dispatch.
//!   • `http.rs`     — share, unshare, preview, access, tunnel listing.
//!   • `identity.rs` — who this desktop and its agent say they are.
//!   • `target.rs`   — reading a pasted id / code / link, and access levels.
//!   • `session.rs`  — share / join / leave / access commands.
//!   • `frames.rs`   — msg / impact / state / typing / cursor commands.
//!   • `host.rs`     — transcript publisher + impact watcher (host only).
//!   • `tunnel.rs`   — serving `tunnel_req` from loopback (host only).
//!
//! ### Access
//!
//! `watch` sees everything and sends nothing but `typing` and `state`; `drive`
//! may also send `msg` and open tunnels. The cloud enforces this, and so does
//! this module — see `ConnCtx::may_drive` and the gate in `conn::handle_msg`.
//! The desktop is the machine that would actually execute a guest's text, so it
//! does not delegate that check.
//!
//! ### Frontend events
//!
//! Every event below fires on a single global channel and carries
//! `session_id`, so one listener can serve every open session. Payload fields
//! are snake_case, matching the wire protocol rather than the renderer's
//! camelCase — the frames are re-emitted close to verbatim on purpose, so the
//! React types can be generated from the protocol doc.
//!
//! | event | payload |
//! | --- | --- |
//! | `session-live:status`        | `{session_id, role, requested_role, connected, share_url, share_code, default_access, my_access, participant_id, host_online, state, error}` |
//! | `session-live:ready`         | `{session_id, you, host_online, your_agents, role, share_url, share_code, default_access, my_access}` |
//! | `session-live:presence`      | `{session_id, participants: Participant[], my_access}` |
//! | `session-live:transcript`    | `{session_id, seq, entry: Entry}` |
//! | `session-live:msg`           | `{session_id, seq, from, to, text, intent, refs, reply_to, at, from_participant, from_access, injected}` |
//! | `session-live:impact`        | `{session_id, from, symbol, file, severity, at, …}` |
//! | `session-live:typing`        | `{session_id, from, on}` |
//! | `session-live:cursor`        | `{session_id, from, file, line}` |
//! | `session-live:host`          | `{session_id, online}` |
//! | `session-live:tunnel-closed` | `{session_id, code, port, reason?}` |
//! | `session-live:error`         | `{session_id, message, fatal}` |
//!
//! Plus two raw-frame channels the renderer's transport listens on directly —
//! see `EV_FRAME_PREFIX` and `EV_STATUS_PREFIX` below.

pub mod conn;
pub mod ctx;
pub mod frames;
pub mod host;
pub mod http;
pub mod identity;
pub mod protocol;
pub mod session;
pub mod target;
pub mod tunnel;

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{oneshot, Mutex};

use ctx::ConnCtx;
use protocol::Participant;
use tunnel::TunnelInfo;

// Re-exported so `identity::local_identity` and friends stay reachable as
// `super::…` from the sibling modules that emit authors.
pub use identity::{agent_author, local_author, local_identity};
pub use session::shutdown_all;

/// Raw-frame channels the renderer's transport listens on: every inbound
/// server frame, verbatim, wrapped as `{session_id, frame}`. The prefixed form
/// is suffixed with `ConnCtx::topic()` (the session id with anything outside
/// `[A-Za-z0-9_-]` folded to `_`, matching the renderer's `sessionLiveTopic`);
/// the un-suffixed form is the global fallback.
pub const EV_FRAME_PREFIX: &str = "session-live:";
pub const EV_FRAME_ANY: &str = "session-live";
/// Transport state: `{session_id, status, detail}` where `status` is
/// connecting | live | reconnecting | closed | error.
pub const EV_STATUS_PREFIX: &str = "session-live-status:";
pub const EV_STATUS_ANY: &str = "session-live-status";

pub const EV_STATUS: &str = "session-live:status";
pub const EV_READY: &str = "session-live:ready";
pub const EV_PRESENCE: &str = "session-live:presence";
pub const EV_TRANSCRIPT: &str = "session-live:transcript";
pub const EV_MSG: &str = "session-live:msg";
pub const EV_IMPACT: &str = "session-live:impact";
pub const EV_TYPING: &str = "session-live:typing";
pub const EV_CURSOR: &str = "session-live:cursor";
pub const EV_HOST: &str = "session-live:host";
pub const EV_TUNNEL_CLOSED: &str = "session-live:tunnel-closed";
pub const EV_ERROR: &str = "session-live:error";

/// Tauri-managed singleton: every session this desktop is hosting or watching,
/// keyed by the cloud's `external_id`.
#[derive(Default)]
pub struct SessionLiveState {
    conns: Mutex<HashMap<String, LiveEntry>>,
}

struct LiveEntry {
    ctx: Arc<ConnCtx>,
    /// Drop or fire to ask the connection task to close.
    shutdown: Option<oneshot::Sender<()>>,
}

impl SessionLiveState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// What every lifecycle command hands back.
#[derive(Serialize, Clone, Debug)]
pub struct SessionLiveInfo {
    pub session_id: String,
    /// The role the server actually granted — a host that lost the race to
    /// another desktop reports "guest" here even though it asked for "host".
    pub role: String,
    pub requested_role: String,
    pub connected: bool,
    /// The link to hand to the other person. Minted by the cloud's `share`
    /// endpoint when it answers; an in-app deep link otherwise.
    pub share_url: String,
    /// The share code behind that link. `None` when the cloud has not minted
    /// one — the session is still joinable by id from inside the app, but there
    /// is no public link to paste.
    pub share_code: Option<String>,
    /// The level a new joiner gets: "watch" | "drive".
    pub default_access: String,
    /// What *this* desktop may do — "drive" for a host, whatever the host
    /// granted for a guest. The composer hangs off this.
    pub my_access: String,
    pub participant_id: Option<String>,
    pub host_online: bool,
    pub state: String,
    pub participants: Vec<Participant>,
    /// The local agent session this share is wired to, when there is one.
    /// `None` means messages addressed at an agent have nowhere to land.
    pub agent_session_id: Option<String>,
    pub tunnels: Vec<TunnelInfo>,
}

pub(crate) fn info_of(ctx: &Arc<ConnCtx>) -> SessionLiveInfo {
    SessionLiveInfo {
        session_id: ctx.external_id.clone(),
        role: ctx.effective_role().to_string(),
        requested_role: ctx.role.as_str().to_string(),
        connected: ctx.connected(),
        share_url: ctx.share_url(),
        share_code: ctx.share_code(),
        default_access: ctx.default_access(),
        my_access: ctx.my_access().to_string(),
        participant_id: ctx.participant_id(),
        host_online: ctx.host_online(),
        state: ctx.presence_state(),
        participants: ctx.participants(),
        agent_session_id: ctx.agent_session_id.clone(),
        tunnels: tunnel::list(ctx),
    }
}
