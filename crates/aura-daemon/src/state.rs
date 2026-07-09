//! Shared daemon state held across connections.
//!
//! Composition of the `BlockStore` (authoritative block/op storage) with
//! an in-memory session registry. Sessions are ephemeral in W4.5 —
//! persistence across daemon restarts lands in W6.5 alongside PTY
//! lifecycle work.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aura_blockstore::BlockStore;
use time::OffsetDateTime;
use tokio::sync::broadcast;

use aura_daemon_client::error::{ProtocolError, ProtocolErrorKind};
use aura_daemon_client::protocol::{EventBody, SessionId};

use crate::input::InputRouter;

/// Capacity of the daemon-owned event bus that carries `EventBody`s which
/// don't originate from a `BlockStore` write (e.g. agent-lifecycle
/// transitions published by the shell). Sized to match the blockstore's
/// own broadcast capacity so the Lagged backpressure threshold is uniform
/// across both buses a subscriber rides.
const DAEMON_EVENT_BUS_CAPACITY: usize = 1024;

/// In-memory session record. PTY spawn, cwd tracking, etc. join this
/// struct in W6.5 (per-tab PTY via daemon).
#[derive(Debug, Clone)]
pub struct Session {
    pub id: SessionId,
    pub workspace: PathBuf,
    pub agent: Option<String>,
    pub created_at: OffsetDateTime,
}

impl Session {
    pub fn new(workspace: PathBuf, agent: Option<String>) -> Self {
        Self {
            id: SessionId::new(),
            workspace,
            agent,
            created_at: OffsetDateTime::now_utc(),
        }
    }
}

pub struct ServerState {
    pub store: Arc<BlockStore>,
    /// Root directory that the Sentinel mailbox writes messages under.
    /// Resolves to `<root>/messages/` and `<root>/unread_pending` — the
    /// exact layout aura-cli expects, so send_message from a daemon
    /// client is indistinguishable from send_message from the CLI.
    pub sentinel_root: PathBuf,
    /// Per-session input pipe. PTY owners (aura-term) register sinks
    /// here; the `SubmitInput` RPC dispatcher submits through this.
    /// Shared as `Arc` because the PTY owner holds a separate handle
    /// outside `ServerState` — see `aura-term/src/daemon.rs`.
    pub input_router: Arc<InputRouter>,
    /// Daemon-owned event bus for `EventBody`s that don't come from a
    /// `BlockStore` write. The `BlockStore` broadcasts `StoreEvent`s; this
    /// channel carries already-shaped `EventBody`s (currently
    /// `AgentLifecycle`) so the same lossless broadcast + Lagged semantics
    /// the store subscribers rely on extend to lifecycle events. Held as a
    /// `Sender`; subscribers call `event_bus_subscribe()`.
    event_bus: broadcast::Sender<EventBody>,
    sessions: Mutex<HashMap<SessionId, Session>>,
}

impl ServerState {
    pub fn new(
        store: Arc<BlockStore>,
        sentinel_root: PathBuf,
        input_router: Arc<InputRouter>,
    ) -> Self {
        let (event_bus, _rx) = broadcast::channel(DAEMON_EVENT_BUS_CAPACITY);
        Self {
            store,
            sentinel_root,
            input_router,
            event_bus,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Subscribe to the daemon-owned event bus (non-store `EventBody`s).
    /// Like `BlockStore::subscribe`, the returned receiver is lossless from
    /// the point of subscription and emits `Lagged` if it falls behind.
    pub fn event_bus_subscribe(&self) -> broadcast::Receiver<EventBody> {
        self.event_bus.subscribe()
    }

    /// Publish an already-shaped `EventBody` onto the daemon event bus.
    /// Returns the number of live receivers the event reached (0 when no
    /// monitor is subscribed — not an error, the event is simply dropped,
    /// mirroring `broadcast::Sender::send`'s contract and the
    /// `let _ = self.tx.send(...)` pattern the store uses).
    pub fn publish_event(&self, event: EventBody) -> usize {
        self.event_bus.send(event).unwrap_or(0)
    }

    pub fn open_session(
        &self,
        workspace: PathBuf,
        agent: Option<String>,
    ) -> Result<SessionId, ProtocolError> {
        let s = Session::new(workspace, agent);
        let id = s.id;
        self.sessions
            .lock()
            .map_err(|e| poisoned("sessions", e.to_string()))?
            .insert(id, s);
        Ok(id)
    }

    pub fn close_session(&self, id: SessionId) -> Result<(), ProtocolError> {
        let mut g = self
            .sessions
            .lock()
            .map_err(|e| poisoned("sessions", e.to_string()))?;
        match g.remove(&id) {
            Some(_) => Ok(()),
            None => Err(ProtocolError::new(
                ProtocolErrorKind::NotFound,
                format!("session {} not found", id.0),
            )),
        }
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionId>, ProtocolError> {
        let g = self
            .sessions
            .lock()
            .map_err(|e| poisoned("sessions", e.to_string()))?;
        let mut ids: Vec<SessionId> = g.keys().copied().collect();
        // Deterministic ordering so clients can cache+compare. Sort by
        // UUIDv7 bytes — timestamp-ordered because v7 front-loads ms.
        ids.sort_by_key(|s| s.0.as_u128());
        Ok(ids)
    }

    /// Clone the full session records out of the mutex. Used by the
    /// Handover RPC, which needs workspace + agent + created_at — not
    /// just the ids. Returned in arbitrary order; the caller sorts.
    pub fn all_sessions(&self) -> Result<Vec<Session>, ProtocolError> {
        let g = self
            .sessions
            .lock()
            .map_err(|e| poisoned("sessions", e.to_string()))?;
        Ok(g.values().cloned().collect())
    }
}

fn poisoned(what: &str, msg: String) -> ProtocolError {
    ProtocolError::new(
        ProtocolErrorKind::Unavailable,
        format!("{what} mutex poisoned: {msg}"),
    )
}
