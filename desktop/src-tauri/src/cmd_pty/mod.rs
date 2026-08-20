//! Plain (non-agent) terminal PTYs — the VS Code-style developer
//! terminal backend.
//!
//! Each `pty_open` returns a stable session id; the React side
//! `pty_write`s keystrokes in and listens to the per-session `pty:<id>`
//! event for bytes streaming back. `pty_resize` keeps the kernel-side
//! window size in sync with xterm's geometry; `pty_close` tears it down.
//!
//! Three layers, mirroring `cmd_agent_pty`'s split:
//!   * [`registry`] — managed state (in-process + daemon-backed maps,
//!     scrollback ring, recent-command ring).
//!   * [`daemon_route`] — when `AURA_USE_PTY_DAEMON=1`, the child lives
//!     in `aura-pty-daemon` and survives an app restart (live reconnect).
//!   * [`scrollback`] — cold restore: when there's no live process to
//!     reconnect to, replay serialized history as inert text.
//!   * [`shell_integration`] + [`marks`] — OSC-133 command marks that
//!     drive ⌘↑/⌘↓ navigation and the recent-command list.
//!
//! The original single-file `cmd_pty.rs` (sync reader thread → mpsc →
//! tauri emit) is preserved here as the in-process fallback path; the new
//! work is the daemon route, scrollback, profiles, and mark parsing.

pub mod registry;
pub mod scrollback;

mod daemon_route;
mod marks;
mod shell_integration;

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;
use vte::Parser;

pub use registry::{
    CommandMark, DaemonPtySession, LivePlainPtySession, MarkKind, PtyHandle, PtyRegistry,
    PtySession, RecentCommand, PTY_HISTORY_CAP, RECENT_COMMANDS_CAP,
};

use marks::MarkParser;

/// Upper bound on a single coalesced PTY→xterm emit. The reader hands the
/// consumer many small chunks during a TUI redraw (Claude Code, vim, htop);
/// we greedily merge whatever is already queued into ONE Tauri event to cut
/// per-event IPC + JSON overhead — the dominant typing-lag cost on slower
/// (Intel) machines — WITHOUT adding latency (we only combine bytes already
/// sitting in the channel). Capped so a sustained flood can't build one
/// pathologically large payload to serialize in a single hop. 64 KiB ≈ 8 of
/// the reader's 8 KiB reads.
const PTY_COALESCE_CAP: usize = 64 * 1024;

/// Milliseconds since the epoch. Matches `cmd_agent_pty::now_ms`.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One pass over a chunk of plain-PTY output, shared by the in-process
/// read loop and the daemon subscribe loop so both behave identically:
///   1. forward raw bytes to xterm (`pty:<id>`),
///   2. tee into the per-session scrollback ring,
///   3. bump the idle clock,
///   4. run the bytes through the OSC-133 `MarkParser`, emitting
///      `pty-command:<id>` marks and pushing finished commands onto the
///      recent ring.
///
/// `seq` is a per-session monotonic counter the caller owns (one loop =
/// one counter) so each mark carries a stable ordinal the frontend maps
/// to an xterm buffer line.
#[allow(clippy::too_many_arguments)]
pub(super) fn pump_plain(
    app: &AppHandle,
    id: &str,
    bytes: &[u8],
    vte: &mut Parser,
    parser: &mut MarkParser,
    seq: &mut u64,
    history: &Arc<Mutex<HashMap<String, VecDeque<u8>>>>,
    recent: &Arc<Mutex<HashMap<String, VecDeque<RecentCommand>>>>,
    last_byte_ms: &Arc<Mutex<u64>>,
) {
    // 1. Raw bytes → xterm, verbatim.
    let _ = app.emit(&format!("pty:{id}"), bytes.to_vec());

    // 2. Tee into the scrollback ring (consumed by `pty_replay_bytes`
    //    on a remount, and as the live source for the serialized cold
    //    snapshot the frontend persists).
    {
        let mut all = history.lock().unwrap();
        let buf = all.entry(id.to_string()).or_default();
        buf.extend(bytes.iter().copied());
        while buf.len() > PTY_HISTORY_CAP {
            buf.pop_front();
        }
    }

    // 3. Idle clock for `pty_list_alive_plain`.
    *last_byte_ms.lock().unwrap() = now_ms();

    // 4. OSC-133 marks. The vte Parser holds state across chunks, so a
    //    sequence split over two reads still resolves.
    for b in bytes {
        vte.advance(parser, *b);
    }
    let parsed = parser.take_marks();
    if parsed.is_empty() {
        return;
    }
    for m in parsed {
        *seq += 1;
        // A finished command with captured text → push onto the recent
        // ring for ^⌥R "Run Recent Command".
        if m.kind == MarkKind::CommandEnd {
            if let Some(text) = m.command.clone() {
                if !text.is_empty() {
                    let mut all = recent.lock().unwrap();
                    let ring = all.entry(id.to_string()).or_default();
                    ring.push_back(RecentCommand {
                        text,
                        exit_code: m.exit_code,
                        ts_ms: now_ms(),
                    });
                    while ring.len() > RECENT_COMMANDS_CAP {
                        ring.pop_front();
                    }
                }
            }
        }
        let _ = app.emit(
            &format!("pty-command:{id}"),
            CommandMark {
                kind: m.kind,
                exit_code: m.exit_code,
                seq: *seq,
            },
        );
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    // Legacy direct-shell override (kept for older callers). When set it
    // wins over the resolved profile's shell.
    shell: Option<String>,
    // Terminal profile id (see `cmd_terminal_profiles`).
    profile: Option<String>,
    // Per-open OSC-133 override; `None` falls back to the profile + pref.
    shell_integration: Option<bool>,
    // When set and the daemon still owns a matching live `Plain` session,
    // reattach to it instead of spawning a fresh child.
    reconnect_id: Option<String>,
    // Friendly tab label, echoed back by the daemon restore listing.
    label: Option<String>,
    // Workspace root for profile env + scrollback keying (falls back to cwd).
    repo_root: Option<String>,
) -> Result<PtyHandle, String> {
    let repo = repo_root
        .clone()
        .or_else(|| cwd.clone())
        .unwrap_or_default();

    // ── Reconnect: re-attach to a daemon-owned survivor, no new child ──
    if let Some(rid) = reconnect_id.as_deref() {
        if crate::pty_daemon::client::enabled() {
            // Already attached in THIS process (e.g. a popout window
            // re-opening a tab the main window still owns, or a remount)?
            // Re-use the live subscribe loop rather than spawning a second
            // one — a duplicate loop would double every byte into xterm and
            // detach (leak) the prior task when we overwrite its entry.
            // Mirrors the agent path's resume guard in `cmd_agent_pty`.
            if state.daemon_sessions.lock().unwrap().contains_key(rid) {
                return Ok(PtyHandle {
                    id: rid.to_string(),
                    reconnected: true,
                });
            }
            let alive = crate::pty_daemon::client::list_by_kind(
                crate::pty_daemon::proto::SessionKind::Plain,
            )
            .await
            .map(|v| v.into_iter().any(|s| s.session_id == rid))
            .unwrap_or(false);
            if alive {
                let (last_byte_ms, handle) = daemon_route::reattach_daemon_plain(
                    app.clone(),
                    rid.to_string(),
                    state.history.clone(),
                    state.recent_commands.clone(),
                );
                state.daemon_sessions.lock().unwrap().insert(
                    rid.to_string(),
                    DaemonPtySession {
                        cwd: cwd.clone(),
                        label: label.clone(),
                        subscribe_handle: handle,
                        last_byte_ms,
                    },
                );
                return Ok(PtyHandle {
                    id: rid.to_string(),
                    reconnected: true,
                });
            }
        }
    }

    // ── Resolve the launch (shell + args + env + integration flag) ──
    let mut launch = crate::cmd_terminal_profiles::resolve_terminal_launch(&repo, profile.as_deref());
    if let Some(sh) = shell {
        launch.shell = sh;
    }
    if let Some(si) = shell_integration {
        launch.use_shell_integration = si;
    }

    // term id namespaces the per-session shell-integration ZDOTDIR/rcfile;
    // it also becomes the in-process session id.
    let term_id = Uuid::new_v4().to_string();
    let mut env = launch.env;
    let mut args = launch.args;
    if launch.use_shell_integration {
        if let Some(si) = shell_integration::prepare(&launch.shell, &term_id) {
            env.extend(si.env);
            // Integration args (e.g. `bash --rcfile X -i`) must precede
            // any profile args.
            let mut merged = si.args;
            merged.extend(args);
            args = merged;
        }
    }

    // ── Daemon route: child lives in aura-pty-daemon, survives restart ──
    if crate::pty_daemon::client::enabled() {
        let (sid, last_byte_ms, handle) = daemon_route::open_via_daemon_plain(
            app.clone(),
            state.history.clone(),
            state.recent_commands.clone(),
            repo.clone(),
            cwd.clone(),
            label.clone(),
            launch.shell.clone(),
            args.clone(),
            env.clone(),
            cols,
            rows,
        )
        .await?;
        state.daemon_sessions.lock().unwrap().insert(
            sid.clone(),
            DaemonPtySession {
                cwd,
                label,
                subscribe_handle: handle,
                last_byte_ms,
            },
        );
        return Ok(PtyHandle {
            id: sid,
            reconnected: false,
        });
    }

    // ── In-process fallback (default mode) ──
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&launch.shell);
    if let Some(d) = cwd.as_ref() {
        cmd.cwd(d);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for arg in &args {
        cmd.arg(arg);
    }
    for (k, v) in &env {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = term_id;
    let exit_event = format!("pty-exit:{id}");
    let last_byte_ms = Arc::new(Mutex::new(now_ms()));

    // Sync reader thread → tokio mpsc → tokio task. Same three-hop shape
    // the agent path uses; the tokio side runs the vte mark pass. Deeper
    // queue (was 64) so a redraw flood doesn't fill the channel and block the
    // reader's `blocking_send` — a stalled reader backs up the PTY and delays
    // the echo of what you just typed. The consumer coalesces on drain, so the
    // extra depth is absorbed into few emits, not many.
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(256);
    let app_for_thread = app.clone();
    let exit_for_thread = exit_event.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit(&exit_for_thread, ());
    });

    let app_for_task = app.clone();
    let id_for_task = id.clone();
    let history = state.history.clone();
    let recent = state.recent_commands.clone();
    let last_for_task = last_byte_ms.clone();
    tauri::async_runtime::spawn(async move {
        let mut vte = Parser::new();
        let mut parser = MarkParser::default();
        let mut seq: u64 = 0;
        while let Some(first) = rx.recv().await {
            // Coalesce a redraw burst into one emit. Everything already queued
            // behind `first` is drained and merged (bounded by PTY_COALESCE_CAP),
            // collapsing dozens of tiny per-read events into a single IPC hop.
            // This adds no latency — try_recv only takes what's already there —
            // and an idle single keystroke still flushes immediately as one
            // chunk. pump_plain's VTE pass is order-preserving over the merge.
            let mut batch = first;
            while batch.len() < PTY_COALESCE_CAP {
                match rx.try_recv() {
                    Ok(more) => batch.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            pump_plain(
                &app_for_task,
                &id_for_task,
                &batch,
                &mut vte,
                &mut parser,
                &mut seq,
                &history,
                &recent,
                &last_for_task,
            );
        }
    });

    state.sessions.lock().unwrap().insert(
        id.clone(),
        PtySession {
            writer: crate::pty_io::shared_writer(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            cwd: cwd.clone(),
            label: label.clone(),
            last_byte_ms,
        },
    );

    Ok(PtyHandle {
        id,
        reconnected: false,
    })
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, PtyRegistry>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // Daemon-backed first — proxy via the client. Read the flag without
    // holding the lock across the await.
    let is_daemon = state.daemon_sessions.lock().unwrap().contains_key(&id);
    if is_daemon {
        return crate::pty_daemon::client::write_session(&id, &data)
            .await
            .map_err(|e| e.to_string());
    }
    // Clone the writer handle and let go of the registry map BEFORE the
    // write. A PTY write blocks whenever the program in the terminal
    // stops reading its input; holding the map across it used to freeze
    // every other terminal too, and burn one runtime worker per
    // keystroke until the whole app stopped responding.
    let writer = {
        let sessions = state.sessions.lock().unwrap();
        let s = sessions.get(&id).ok_or_else(|| format!("unknown pty {id}"))?;
        s.writer.clone()
    };
    crate::pty_io::write_bytes(&writer, data)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let is_daemon = state.daemon_sessions.lock().unwrap().contains_key(&id);
    if is_daemon {
        return crate::pty_daemon::client::resize_session(&id, cols, rows)
            .await
            .map_err(|e| e.to_string());
    }
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or_else(|| format!("unknown pty {id}"))?;
    let res = s
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string());
    res
}

#[tauri::command]
pub async fn pty_close(state: State<'_, PtyRegistry>, id: String) -> Result<(), String> {
    // Daemon-backed: drop the subscribe loop + ask the daemon to kill
    // the child. Best-effort — the user just wants the tab gone.
    let daemon = state.daemon_sessions.lock().unwrap().remove(&id);
    if let Some(proxy) = daemon {
        proxy.subscribe_handle.abort();
        let _ = crate::pty_daemon::client::close_session(&id).await;
        state.forget(&id);
        return Ok(());
    }
    if let Some(sess) = state.sessions.lock().unwrap().remove(&id) {
        // Hang the line up rather than SIGKILL the shell, so whatever the
        // user was RUNNING in this tab stops too — see `pty_reap`. Dropping
        // `sess` right after also drops the master, which is the other half
        // of what closing a terminal window does.
        crate::pty_reap::hangup_and_reap(&mut **sess.child.lock().unwrap());
    }
    state.forget(&id);
    Ok(())
}

/// Recent raw scrollback for a session — xterm calls this on remount to
/// backfill the screen the live ring still holds (tab-switch, not a cold
/// restart). Empty on unknown id rather than erroring.
#[tauri::command]
pub fn pty_replay_bytes(state: State<'_, PtyRegistry>, id: String) -> Result<Vec<u8>, String> {
    let all = state.history.lock().unwrap();
    Ok(all
        .get(&id)
        .map(|q| q.iter().copied().collect::<Vec<u8>>())
        .unwrap_or_default())
}

/// The recent-command ring for a session, newest last — backs ^⌥R "Run
/// Recent Command". Empty on unknown id / no shell integration.
#[tauri::command]
pub fn pty_recent_commands(
    state: State<'_, PtyRegistry>,
    id: String,
) -> Result<Vec<RecentCommand>, String> {
    Ok(state.recent_commands_for(&id))
}

/// Every live plain PTY the shell can reattach: in-process sessions,
/// daemon-backed ones already tailed by this process, and daemon-owned
/// survivors not yet reattached (the restart case). The frontend
/// cross-references `session_id` against each persisted tab's
/// `daemonSessionId` to decide reconnect-vs-cold-replay on boot.
#[tauri::command]
pub async fn pty_list_alive_plain(
    state: State<'_, PtyRegistry>,
) -> Result<Vec<LivePlainPtySession>, String> {
    let now = now_ms();
    let mut out: Vec<LivePlainPtySession> = Vec::new();
    let mut known: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 1. In-process sessions (alive iff the child hasn't reaped).
    {
        let sessions = state.sessions.lock().unwrap();
        for (id, sess) in sessions.iter() {
            let alive = sess
                .child
                .lock()
                .unwrap()
                .try_wait()
                .ok()
                .flatten()
                .is_none();
            if !alive {
                continue;
            }
            let last = *sess.last_byte_ms.lock().unwrap();
            out.push(LivePlainPtySession {
                session_id: id.clone(),
                cwd: sess.cwd.clone(),
                label: sess.label.clone(),
                idle_ms: Some(now.saturating_sub(last)),
            });
            known.insert(id.clone());
        }
    }

    // 2. Daemon-backed sessions already reattached here.
    {
        let daemon = state.daemon_sessions.lock().unwrap();
        for (id, sess) in daemon.iter() {
            let last = *sess.last_byte_ms.lock().unwrap();
            out.push(LivePlainPtySession {
                session_id: id.clone(),
                cwd: sess.cwd.clone(),
                label: sess.label.clone(),
                idle_ms: Some(now.saturating_sub(last)),
            });
            known.insert(id.clone());
        }
    }

    // 3. Daemon-owned survivors not yet reattached (post-relaunch). Best
    //    effort — daemon down just means we return the slices above.
    if let Ok(listing) =
        crate::pty_daemon::client::list_by_kind(crate::pty_daemon::proto::SessionKind::Plain)
            .await
    {
        for info in listing {
            if known.contains(&info.session_id) {
                continue;
            }
            out.push(LivePlainPtySession {
                session_id: info.session_id,
                cwd: info.cwd,
                label: info.label,
                idle_ms: None,
            });
        }
    }

    Ok(out)
}
