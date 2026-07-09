//! Per-session input router.
//!
//! Why this exists: the daemon does not own the PTY. In aura-term the
//! PTY lives in the terminal process, and the embedded daemon ships on
//! the same `Arc<BlockStore>` that the bridge uses. External clients —
//! MCP agents, sibling CLIs, IDE plugins — push keystrokes at a session
//! over IPC by calling `SubmitInput { session_id, input }`. Those bytes
//! need to reach the PTY's write side.
//!
//! The router is the pipe. A PTY owner registers a sink keyed by
//! session id; the `SubmitInput` dispatcher looks up the sink and
//! forwards. If no one is registered for that session yet, the caller
//! gets `NotFound` — better than silently swallowing a keystroke.
//!
//! v1 uses an `mpsc::UnboundedSender`. Unbounded because the forwarder
//! on the PTY side drains as fast as `write(2)` accepts — bounding here
//! would shift the "slow PTY" failure mode into the RPC response path
//! where it's less actionable. If throughput becomes a problem we grow
//! a bounded variant + `try_send` with a typed `Busy` error.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::mpsc;

use aura_daemon_client::error::{ProtocolError, ProtocolErrorKind};
use aura_daemon_client::protocol::SessionId;

/// Shared-state input dispatcher. Construct once per `ServerState`;
/// `register` / `unregister` from the session owner side, `submit` from
/// the RPC dispatch side.
#[derive(Default)]
pub struct InputRouter {
    sinks: Mutex<HashMap<SessionId, mpsc::UnboundedSender<Vec<u8>>>>,
}

impl std::fmt::Debug for InputRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n = self.sinks.lock().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("InputRouter")
            .field("registered_sinks", &n)
            .finish()
    }
}

impl InputRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a sink for `session_id` and return the paired receiver.
    /// If a sink is already registered for this id, it is replaced —
    /// the previous owner's receiver goes inert on the next `submit`.
    /// That's deliberate: the more common case is a terminal re-spawning
    /// its PTY after a crash, and we want the latest owner to win.
    pub fn register(&self, session_id: SessionId) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut g) = self.sinks.lock() {
            g.insert(session_id, tx);
        }
        rx
    }

    /// Remove the sink for `session_id`. Idempotent — unregistering an
    /// unknown id is a no-op.
    pub fn unregister(&self, session_id: SessionId) {
        if let Ok(mut g) = self.sinks.lock() {
            g.remove(&session_id);
        }
    }

    /// Forward `bytes` to the registered sink for `session_id`. Returns
    /// `NotFound` if nothing is registered, `Unavailable` if the sink
    /// was dropped mid-send (receiver closed). The caller's `SubmitInput`
    /// surfaces these to the wire.
    pub fn submit(&self, session_id: SessionId, bytes: Vec<u8>) -> Result<(), ProtocolError> {
        let tx = {
            let g = self.sinks.lock().map_err(|e| {
                ProtocolError::new(
                    ProtocolErrorKind::Unavailable,
                    format!("input router mutex poisoned: {e}"),
                )
            })?;
            g.get(&session_id).cloned()
        };
        match tx {
            None => Err(ProtocolError::new(
                ProtocolErrorKind::NotFound,
                format!("no input sink registered for session {}", session_id.0),
            )),
            Some(tx) => tx.send(bytes).map_err(|_| {
                ProtocolError::new(
                    ProtocolErrorKind::Unavailable,
                    format!("input sink for session {} closed", session_id.0),
                )
            }),
        }
    }

    /// Count of registered sinks. Used by tests and the Handover payload
    /// to report "N active input sinks" without exposing the full map.
    pub fn sink_count(&self) -> usize {
        self.sinks.lock().map(|g| g.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_then_submit_delivers_bytes() {
        let router = InputRouter::new();
        let sid = SessionId::new();
        let mut rx = router.register(sid);

        router.submit(sid, b"hello".to_vec()).unwrap();
        let got = rx.recv().await.expect("sink delivered");
        assert_eq!(got, b"hello");
    }

    #[tokio::test]
    async fn submit_without_register_is_not_found() {
        let router = InputRouter::new();
        let err = router
            .submit(SessionId::new(), b"x".to_vec())
            .expect_err("no sink");
        assert_eq!(err.kind, ProtocolErrorKind::NotFound);
    }

    #[tokio::test]
    async fn unregister_disconnects_the_sink() {
        let router = InputRouter::new();
        let sid = SessionId::new();
        let _rx = router.register(sid);
        router.unregister(sid);
        let err = router.submit(sid, b"x".to_vec()).expect_err("unregistered");
        assert_eq!(err.kind, ProtocolErrorKind::NotFound);
    }

    #[tokio::test]
    async fn register_twice_replaces_previous_sink() {
        let router = InputRouter::new();
        let sid = SessionId::new();
        let mut rx1 = router.register(sid);
        let mut rx2 = router.register(sid);

        router.submit(sid, b"one".to_vec()).unwrap();
        // Latest registration wins; earlier receiver sees nothing.
        let got2 = rx2.recv().await.expect("latest sink delivered");
        assert_eq!(got2, b"one");
        assert!(rx1.try_recv().is_err(), "previous sink got no bytes");
    }

    #[tokio::test]
    async fn sink_count_tracks_registrations() {
        let router = InputRouter::new();
        assert_eq!(router.sink_count(), 0);
        let a = SessionId::new();
        let b = SessionId::new();
        let _ra = router.register(a);
        let _rb = router.register(b);
        assert_eq!(router.sink_count(), 2);
        router.unregister(a);
        assert_eq!(router.sink_count(), 1);
    }
}
