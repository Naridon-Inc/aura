//! Daemon-backed plain-shell route.
//!
//! Near-verbatim analogue of `cmd_agent_pty::open_via_daemon`, but for
//! login shells and emitting the same `pty:<id>` / `pty-exit:<id>` events
//! the in-process path uses — so the frontend listener is identical
//! whether or not `AURA_USE_PTY_DAEMON` is set. The whole point: the
//! daemon owns the child, so a `tail -f` / `vim` survives an app restart
//! and a fresh shell process re-subscribes to the live stream.
//!
//! Two entry points share one subscribe loop:
//!   * `open_via_daemon_plain` — spawn a NEW session in the daemon.
//!   * `reattach_daemon_plain` — re-subscribe to an EXISTING survivor
//!     (the restart case) without spawning anything.
//!
//! Both hand `mod.rs` back `(session_id, last_byte_ms, subscribe_handle)`
//! so it can register the `DaemonPtySession` while it still holds the
//! managed `PtyRegistry` state.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use super::registry::RecentCommand;
use crate::pty_daemon::proto::{OpenReq, SessionKind};

type HistoryRing = Arc<Mutex<HashMap<String, VecDeque<u8>>>>;
type RecentRing = Arc<Mutex<HashMap<String, VecDeque<RecentCommand>>>>;

/// Spawn a brand-new plain shell inside the daemon and start tailing it.
#[allow(clippy::too_many_arguments)]
pub async fn open_via_daemon_plain(
    app: AppHandle,
    history: HistoryRing,
    recent: RecentRing,
    repo_root: String,
    cwd: Option<String>,
    label: Option<String>,
    shell: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
) -> Result<(String, Arc<Mutex<u64>>, tokio::task::JoinHandle<()>), String> {
    let session_id = crate::pty_daemon::client::open_session(OpenReq {
        // Plain shells don't have an agent id; reuse the field as a
        // human-ish tag so daemon logs aren't blank.
        agent_id: "terminal".to_string(),
        repo_root,
        bin: shell,
        args,
        env,
        cols,
        rows,
        kind: SessionKind::Plain,
        label,
        cwd,
    })
    .await
    .map_err(|e| format!("daemon open_session: {e}"))?;

    let (last_byte_ms, handle) = spawn_subscribe_loop(app, session_id.clone(), history, recent);
    Ok((session_id, last_byte_ms, handle))
}

/// Re-subscribe to a daemon-owned plain shell that outlived the app
/// (the auto-update / quit-relaunch survivor). No child is spawned — the
/// process is already running; we just reattach its byte stream.
pub fn reattach_daemon_plain(
    app: AppHandle,
    session_id: String,
    history: HistoryRing,
    recent: RecentRing,
) -> (Arc<Mutex<u64>>, tokio::task::JoinHandle<()>) {
    spawn_subscribe_loop(app, session_id, history, recent)
}

/// The shared tail: hold the daemon subscribe stream open and pump each
/// `Event::Bytes` through `super::pump_plain` (xterm emit + history tee +
/// OSC-133 marks), re-emitting `pty-exit:<id>` on `Event::Exit`.
fn spawn_subscribe_loop(
    app: AppHandle,
    session_id: String,
    history: HistoryRing,
    recent: RecentRing,
) -> (Arc<Mutex<u64>>, tokio::task::JoinHandle<()>) {
    let exit_event = format!("pty-exit:{session_id}");
    // Seed with now so a daemon child that wedges before printing still
    // counts against the idle clock the listing surfaces.
    let last_byte_ms = Arc::new(Mutex::new(super::now_ms()));
    let last_for_loop = last_byte_ms.clone();

    let handle = tokio::spawn(async move {
        let mut sub = match crate::pty_daemon::client::subscribe(&session_id).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[pty-daemon] plain subscribe failed: {e}");
                let _ = app.emit(&exit_event, ());
                return;
            }
        };
        let mut vte = vte::Parser::new();
        let mut marks = super::marks::MarkParser::default();
        let mut seq: u64 = 0;
        loop {
            match crate::pty_daemon::client::recv_event(&mut sub).await {
                Ok(crate::pty_daemon::proto::Event::Bytes { data, .. }) => {
                    super::pump_plain(
                        &app,
                        &session_id,
                        &data,
                        &mut vte,
                        &mut marks,
                        &mut seq,
                        &history,
                        &recent,
                        &last_for_loop,
                    );
                }
                Ok(crate::pty_daemon::proto::Event::Exit { .. }) => {
                    let _ = app.emit(&exit_event, ());
                    break;
                }
                Err(e) => {
                    eprintln!("[pty-daemon] plain subscribe recv: {e}");
                    let _ = app.emit(&exit_event, ());
                    break;
                }
            }
        }
    });

    (last_byte_ms, handle)
}
