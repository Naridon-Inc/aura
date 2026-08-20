//! The Rust↔React half of the control plane.
//!
//! Tabs are frontend state — there is no Rust-side tab list to mutate — so
//! every tool that touches a tab has to cross into the webview and, for the
//! blocking ones, come back. That's the same shape `cli_bridge.rs` uses for
//! `ask-user`: register a oneshot, push an event at React, await the reply
//! a Tauri command fires back.
//!
//!   agent CLI ──ws/MCP──▶ server.rs
//!                             │ register oneshot, keyed by request id
//!                             ├─emit `ide-bridge:request`──▶ React
//!                             │                                │
//!                             └─await oneshot ◀────────────────┘
//!                                        `ide_bridge_respond`
//!
//! The await is deliberately patient: `openDiff` is a human decision and the
//! CLI sets no idle timeout on it. But it is not unbounded — an agent that
//! walked away must not pin a slot forever, so every wait has a ceiling and
//! a timeout resolves to "we don't know", never to a fabricated verdict.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// Event React listens on. One event for every tool that needs the UI.
pub const REQUEST_EVENT: &str = "ide-bridge:request";

/// Ceiling on a human decision (`openDiff`). Long enough that stepping away
/// for lunch mid-review doesn't lose the change; short enough that a
/// forgotten tab doesn't hold a socket open across days.
pub const HUMAN_WAIT: Duration = Duration::from_secs(60 * 60 * 4);

/// Ceiling on a question React answers by itself — "what's open", "what's
/// selected". These only take a render tick; anything past this means the
/// webview is wedged and waiting longer won't help.
pub const UI_WAIT: Duration = Duration::from_secs(10);

/// Everything the running control plane knows about itself. Managed by
/// Tauri so both the socket task and the `#[tauri::command]` handlers can
/// reach the same pending map.
pub struct IdeBridgeState {
    /// `None` until the listener binds — every accessor tolerates that so a
    /// spawn racing startup reads "not up yet" instead of panicking.
    running: Mutex<Option<Running>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    /// `tab_name` → request id of the `openDiff` still waiting on it. Lets
    /// `close_tab` resolve a diff the CLI gave up on instead of stranding it.
    diff_tabs: Mutex<HashMap<String, String>>,
}

#[derive(Clone)]
pub struct Running {
    pub port: u16,
    pub auth_token: String,
    pub lock_path: PathBuf,
}

impl IdeBridgeState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            diff_tabs: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_running(&self, running: Running) {
        *self.running.lock().unwrap() = Some(running);
    }

    pub fn running(&self) -> Option<Running> {
        self.running.lock().unwrap().clone()
    }

    /// Constant-time-ish equality against the token in the lock file. The
    /// port is loopback-only, but any local process can read the directory,
    /// so the token is what separates "an agent Aura vouches for" from
    /// "anything that can open a socket".
    pub fn token_matches(&self, presented: Option<&str>) -> bool {
        let Some(running) = self.running() else {
            return false;
        };
        match presented {
            Some(t) => constant_time_eq(t.as_bytes(), running.auth_token.as_bytes()),
            None => false,
        }
    }

    /// Register a waiter. The returned receiver is what the socket task
    /// awaits; `ide_bridge_respond` fires the matching sender.
    pub fn register(&self, request_id: String) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(request_id, tx);
        rx
    }

    /// Resolve a waiter. False when no such id is registered — already
    /// answered, or timed out and cleaned up.
    pub fn resolve(&self, request_id: &str, reply: Value) -> bool {
        let mut map = self.pending.lock().unwrap();
        match map.remove(request_id) {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    /// Drop a waiter without answering it. Called when the wait times out,
    /// so a late reply doesn't resolve a request nobody is listening to.
    pub fn forget(&self, request_id: &str) {
        self.pending.lock().unwrap().remove(request_id);
    }

    pub fn bind_diff_tab(&self, tab_name: String, request_id: String) {
        self.diff_tabs.lock().unwrap().insert(tab_name, request_id);
    }

    pub fn take_diff_tab(&self, tab_name: &str) -> Option<String> {
        self.diff_tabs.lock().unwrap().remove(tab_name)
    }

    pub fn take_all_diff_tabs(&self) -> Vec<(String, String)> {
        self.diff_tabs.lock().unwrap().drain().collect()
    }
}

impl Default for IdeBridgeState {
    fn default() -> Self {
        Self::new()
    }
}

/// Push one request at React and wait for its reply.
///
/// `Err` means the UI never answered — the caller turns that into an honest
/// "couldn't do it" for the model, never into a made-up success.
pub async fn ask_ui(
    app: &AppHandle,
    state: &IdeBridgeState,
    method: &str,
    params: Value,
    wait: Duration,
) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = state.register(request_id.clone());

    if let Err(e) = app.emit(
        REQUEST_EVENT,
        serde_json::json!({
            "requestId": request_id,
            "method": method,
            "params": params,
        }),
    ) {
        state.forget(&request_id);
        return Err(format!("could not reach the Aura window: {e}"));
    }

    match tokio::time::timeout(wait, rx).await {
        Ok(Ok(reply)) => Ok(reply),
        // Sender dropped without sending — the slot was cleared out from
        // under us. Same user-visible meaning as a timeout.
        Ok(Err(_)) => Err(format!("Aura stopped waiting on {method}")),
        Err(_) => {
            state.forget(&request_id);
            Err(format!("nobody answered {method} in time"))
        }
    }
}

/// Length-aware equality that doesn't short-circuit on the first differing
/// byte. Tokens are compared on every frame's upgrade, so the cheap version
/// leaks their prefix to a local attacker who can time it.
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
    use serde_json::json;

    #[test]
    fn a_registered_waiter_resolves_once_and_only_once() {
        let s = IdeBridgeState::new();
        let mut rx = s.register("r1".into());
        assert!(s.resolve("r1", json!({ "outcome": "rejected" })));
        assert_eq!(
            rx.try_recv().unwrap(),
            json!({ "outcome": "rejected" })
        );
        // A second reply for the same id must not resurrect the slot — a
        // double-fire from a re-rendering component would otherwise answer
        // whatever request happened to reuse the id.
        assert!(!s.resolve("r1", json!({ "outcome": "saved" })));
    }

    #[test]
    fn resolving_an_unknown_id_is_a_no_op() {
        let s = IdeBridgeState::new();
        assert!(!s.resolve("never-registered", json!({})));
    }

    #[test]
    fn forget_drops_the_slot_so_a_late_reply_lands_nowhere() {
        let s = IdeBridgeState::new();
        let _rx = s.register("r2".into());
        s.forget("r2");
        assert!(!s.resolve("r2", json!({ "outcome": "saved" })));
    }

    #[test]
    fn diff_tab_binding_is_taken_exactly_once() {
        let s = IdeBridgeState::new();
        s.bind_diff_tab("tab a".into(), "req-1".into());
        assert_eq!(s.take_diff_tab("tab a").as_deref(), Some("req-1"));
        assert_eq!(s.take_diff_tab("tab a"), None);
    }

    #[test]
    fn take_all_diff_tabs_drains() {
        let s = IdeBridgeState::new();
        s.bind_diff_tab("a".into(), "1".into());
        s.bind_diff_tab("b".into(), "2".into());
        let mut all = s.take_all_diff_tabs();
        all.sort();
        assert_eq!(all.len(), 2);
        assert!(s.take_all_diff_tabs().is_empty());
    }

    #[test]
    fn no_token_is_accepted_before_the_listener_binds() {
        let s = IdeBridgeState::new();
        assert!(!s.token_matches(Some("anything")));
        assert!(!s.token_matches(None));
    }

    #[test]
    fn only_the_exact_token_opens_the_socket() {
        let s = IdeBridgeState::new();
        s.set_running(Running {
            port: 1234,
            auth_token: "s3cret".into(),
            lock_path: PathBuf::from("/tmp/1234.lock"),
        });
        assert!(s.token_matches(Some("s3cret")));
        assert!(!s.token_matches(Some("s3cre")));
        assert!(!s.token_matches(Some("s3cret ")));
        assert!(!s.token_matches(Some("")));
        assert!(!s.token_matches(None));
    }

    #[test]
    fn constant_time_eq_agrees_with_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }
}
