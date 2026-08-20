//! Daemon-side server: owns the registry of PTY children and serves
//! Request/Response over a UNIX socket. The `aura-pty-daemon` binary
//! is just `tokio::main` + `serve_forever`.
//!
//! Concurrency model:
//!   * A single accept loop hands each connection off to its own
//!     tokio task.
//!   * Sessions live in `Arc<Mutex<HashMap<String, Session>>>`.
//!     The Mutex guards the HashMap mutation; per-session writes go
//!     through the session's own `Mutex<Box<dyn Write>>` so two
//!     control connections can interleave Write calls without
//!     ordering surprises.
//!   * A subscribe connection blocks on its session's broadcast
//!     channel and forwards `Event::Bytes` / `Event::Exit`. One
//!     `tokio::sync::broadcast` per session lets multiple shells (or
//!     a fresh shell after a restart) tail the same session.

use crate::pty_daemon::proto::{Event, OpenReq, Request, Response, SessionInfo, SessionKind};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;

/// How much per-session output the daemon keeps so a shell that reattaches
/// after an app restart sees its scrollback instead of a blank pane until
/// the next byte. We trim lazily (only once the buffer passes 2× this) so
/// the head-drop memmove amortizes to O(1) per byte under heavy output;
/// the replay sent on subscribe is the last `HISTORY_CAP` bytes.
const HISTORY_CAP: usize = 1024 * 1024;

/// One PTY child the daemon owns. The fields are intentionally
/// blocking-`Mutex` — portable-pty's writer is `Box<dyn Write>` (not
/// `Send`-friendly across `.await`), so we keep the lock-and-write
/// dance synchronous. The async tasks that touch this only do so
/// briefly between awaits.
struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Fan-out for subscribers. Bounded to avoid a slow shell
    /// stalling other consumers; on lag we drop oldest events.
    bytes_tx: tokio::sync::broadcast::Sender<Event>,
    /// Rolling scrollback ring (raw child output bytes). The reader
    /// appends here and broadcasts under the same lock, so a fresh
    /// `Subscribe` can snapshot it and replay history without ever
    /// double-delivering or dropping a byte that lands in the gap.
    history: Arc<Mutex<Vec<u8>>>,
    /// Last seen agent id / repo root, returned to the shell on
    /// reattach via `Request::ListDetailed`.
    agent_id: String,
    repo_root: String,
    /// Agent vs plain-shell — lets `ListByKind` answer each restore
    /// path with only its own flavor of session.
    kind: SessionKind,
    /// Friendly label + working dir, echoed back so the terminal
    /// restore UI can show "Terminal — ~/proj" without a side lookup.
    label: Option<String>,
    cwd: Option<String>,
}

#[derive(Default)]
pub struct Registry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Registry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

/// Bind the UNIX socket and serve forever. Caller drives the runtime.
pub async fn serve_forever(reg: Arc<Registry>) -> std::io::Result<()> {
    let socket = crate::pty_daemon::proto::socket_path()
        .ok_or_else(|| std::io::Error::other("no HOME"))?;
    if let Some(parent) = socket.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Stale socket from a prior daemon run — bind() refuses to
    // overwrite. This is the standard daemon idiom; if a real daemon
    // is still running it'll reclaim the socket on its own restart
    // anyway.
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    eprintln!("[pty-daemon] listening at {}", socket.display());

    if let Some(p) = crate::pty_daemon::proto::pid_path() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&p, std::process::id().to_string());
    }

    loop {
        let (sock, _addr) = listener.accept().await?;
        let reg2 = reg.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(sock, reg2).await {
                eprintln!("[pty-daemon] conn: {e}");
            }
        });
    }
}

/// Read length-prefixed JSON until EOF. The first request determines
/// the connection's mode: a Subscribe transitions into push-events,
/// anything else is a one-shot Request → Response.
async fn handle_conn(
    mut sock: UnixStream,
    reg: Arc<Registry>,
) -> std::io::Result<()> {
    loop {
        let req = match read_msg::<Request>(&mut sock).await {
            Ok(Some(r)) => r,
            Ok(None) => return Ok(()), // peer closed
            Err(e) => return Err(e),
        };
        match req {
            Request::Subscribe { session_id } => {
                // Subscribe to the live stream AND snapshot the scrollback
                // ring in one critical section (hold `history` across the
                // `subscribe()` call). The reader appends-and-broadcasts
                // under the same lock, so every byte is either in this
                // snapshot or delivered live via `rx` — never both, never
                // neither — even if it lands in the subscribe/snapshot gap.
                let sub = {
                    let sess = reg.sessions.lock().unwrap().get(&session_id).cloned();
                    sess.map(|s| {
                        let hist = s.history.lock().unwrap();
                        let rx = s.bytes_tx.subscribe();
                        let start = hist.len().saturating_sub(HISTORY_CAP);
                        (rx, hist[start..].to_vec())
                    })
                };
                let resp = match &sub {
                    Some(_) => Response::Subscribed { session_id: session_id.clone() },
                    None => Response::Err { message: format!("unknown session: {session_id}") },
                };
                write_msg(&mut sock, &resp).await?;
                if let Some((mut rx, replay)) = sub {
                    use tokio::sync::broadcast::error::RecvError;
                    // Replay the scrollback so a reattached shell sees its
                    // history, not a blank pane. Empty on a fresh open.
                    if !replay.is_empty() {
                        write_msg(
                            &mut sock,
                            &Event::Bytes { session_id: session_id.clone(), data: replay },
                        )
                        .await?;
                    }
                    loop {
                        match rx.recv().await {
                            Ok(ev) => {
                                write_msg(&mut sock, &ev).await?;
                                if let Event::Exit { session_id: ref sid } = ev {
                                    if sid == &session_id {
                                        return Ok(());
                                    }
                                }
                            }
                            // Subscriber fell behind a burst and the channel
                            // dropped the oldest events. Recoverable — the PTY
                            // is still live and the ring still has the latest
                            // bytes — so note the gap and keep tailing. The old
                            // `while let Ok` form treated this like EOF and
                            // killed the stream, leaving the terminal dead
                            // while its child kept running.
                            Err(RecvError::Lagged(n)) => {
                                eprintln!(
                                    "[pty-daemon] subscriber lagged, dropped {n} events for {session_id}"
                                );
                            }
                            // Sender gone (session torn down) — nothing more
                            // will ever arrive, so end the subscribe stream.
                            Err(RecvError::Closed) => return Ok(()),
                        }
                    }
                }
                return Ok(());
            }
            other => {
                let resp = handle_request(&reg, other).await;
                write_msg(&mut sock, &resp).await?;
            }
        }
    }
}

async fn handle_request(reg: &Arc<Registry>, req: Request) -> Response {
    match req {
        Request::Ping => Response::Pong,
        Request::List => {
            let ids: Vec<String> = reg.sessions.lock().unwrap().keys().cloned().collect();
            Response::Sessions { ids }
        }
        Request::ListDetailed => {
            let sessions = reg.sessions.lock().unwrap();
            let info: Vec<SessionInfo> = sessions
                .iter()
                .map(|(id, sess)| session_info(id, sess))
                .collect();
            Response::SessionsDetailed { sessions: info }
        }
        Request::ListByKind { session_kind } => {
            let sessions = reg.sessions.lock().unwrap();
            let info: Vec<SessionInfo> = sessions
                .iter()
                .filter(|(_, sess)| sess.kind == session_kind)
                .map(|(id, sess)| session_info(id, sess))
                .collect();
            Response::SessionsDetailed { sessions: info }
        }
        Request::PreRelaunch => {
            // No-op on the daemon side today — children already
            // outlive the shell because we never propagate a
            // shell-exit signal to them. The ack lets the shell
            // confirm the daemon is reachable + healthy before
            // calling `relaunch()`, so if the daemon is dead the
            // shell can warn the user that in-flight sessions
            // won't actually survive.
            let count = reg.sessions.lock().unwrap().len();
            Response::PreRelaunchAck { count }
        }
        Request::Open(o) => match open_session(reg, o).await {
            Ok(sid) => Response::Opened { session_id: sid },
            Err(e) => Response::Err { message: e },
        },
        Request::Write { session_id, data } => {
            let sessions = reg.sessions.lock().unwrap();
            let Some(sess) = sessions.get(&session_id).cloned() else {
                return Response::Err { message: format!("unknown session: {session_id}") };
            };
            drop(sessions);
            let res = sess.writer.lock().unwrap().write_all(&data);
            match res {
                Ok(()) => Response::Ok,
                Err(e) => Response::Err { message: e.to_string() },
            }
        }
        Request::Resize { session_id, cols, rows } => {
            let sessions = reg.sessions.lock().unwrap();
            let Some(sess) = sessions.get(&session_id).cloned() else {
                return Response::Err { message: format!("unknown session: {session_id}") };
            };
            drop(sessions);
            let res = sess.master.lock().unwrap().resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            });
            match res {
                Ok(()) => Response::Ok,
                Err(e) => Response::Err { message: e.to_string() },
            }
        }
        Request::Close { session_id } => {
            let mut sessions = reg.sessions.lock().unwrap();
            if let Some(sess) = sessions.remove(&session_id) {
                // Same hangup the in-process path uses. The daemon owns the
                // child precisely so it can outlive the app, which makes an
                // orphan here permanent — nothing is left to reap it.
                crate::pty_reap::hangup_and_reap(&mut **sess.child.lock().unwrap());
                Response::Ok
            } else {
                Response::Err { message: format!("unknown session: {session_id}") }
            }
        }
        Request::Subscribe { .. } => unreachable!("handled above"),
    }
}

/// Project a live `Session` to the wire `SessionInfo`. One place so
/// `ListDetailed` and `ListByKind` can't drift apart.
fn session_info(id: &str, sess: &Session) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        agent_id: sess.agent_id.clone(),
        repo_root: sess.repo_root.clone(),
        kind: sess.kind,
        label: sess.label.clone(),
        cwd: sess.cwd.clone(),
    }
}

/// Append child output to a session's scrollback ring, trimming the
/// oldest bytes lazily so it stays bounded near `HISTORY_CAP`. We only
/// trim once the buffer passes 2× the cap (then back down to the cap),
/// so the head-drop memmove amortizes to O(1) per byte under sustained
/// output instead of running on every read.
fn push_history(buf: &mut Vec<u8>, data: &[u8]) {
    buf.extend_from_slice(data);
    if buf.len() > HISTORY_CAP * 2 {
        let cut = buf.len() - HISTORY_CAP;
        buf.drain(..cut);
    }
}

async fn open_session(reg: &Arc<Registry>, o: OpenReq) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols: o.cols,
            rows: o.rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&o.bin);
    // Plain shells carry their own cwd; agents (cwd=None) launch at the
    // repo root exactly as before. Guard the resolved dir so an empty or
    // missing root never inherits the daemon's own launch directory —
    // `safe_spawn_dir` keeps valid dirs verbatim and redirects empty/invalid
    // ones to the home dir.
    let resolved_cwd = o.cwd.clone().unwrap_or_else(|| o.repo_root.clone());
    cmd.cwd(crate::spawn_dir::safe_spawn_dir(&resolved_cwd));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for arg in &o.args {
        cmd.arg(arg);
    }
    for (k, v) in &o.env {
        cmd.env(k, v);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {}: {e}", o.bin))?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // Bounded channel — slow consumers don't stall the PTY reader.
    // 1024 frames * ~8KB each ~= 8MB worst-case; comfortably more
    // than any reasonable agent burst.
    let (bytes_tx, _) = tokio::sync::broadcast::channel::<Event>(1024);

    let id = Uuid::new_v4().to_string();
    let history = Arc::new(Mutex::new(Vec::<u8>::new()));
    let sess = Arc::new(Session {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        bytes_tx: bytes_tx.clone(),
        agent_id: o.agent_id.clone(),
        repo_root: o.repo_root.clone(),
        kind: o.kind,
        label: o.label.clone(),
        cwd: o.cwd.clone(),
        history: history.clone(),
    });
    reg.sessions.lock().unwrap().insert(id.clone(), sess.clone());

    // Reader thread — blocking I/O from portable-pty is bridged into
    // the broadcast channel. Each read appends to the scrollback ring
    // and broadcasts under the SAME lock so `Subscribe`'s snapshot can
    // never race the live stream. On EOF emit an Exit event and drop
    // the session from the registry.
    let id_for_reader = id.clone();
    let reg_for_reader = reg.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut h = history.lock().unwrap();
                    push_history(&mut h, &buf[..n]);
                    let _ = bytes_tx.send(Event::Bytes {
                        session_id: id_for_reader.clone(),
                        data: buf[..n].to_vec(),
                    });
                }
                Err(_) => break,
            }
        }
        let _ = bytes_tx.send(Event::Exit { session_id: id_for_reader.clone() });
        reg_for_reader.sessions.lock().unwrap().remove(&id_for_reader);
    });

    Ok(id)
}

// ── framing ──

async fn read_msg<T: serde::de::DeserializeOwned>(
    sock: &mut UnixStream,
) -> std::io::Result<Option<T>> {
    let mut len_buf = [0u8; 4];
    match sock.read_exact(&mut len_buf).await {
        Ok(_n) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 16 * 1024 * 1024 {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut body = vec![0u8; len];
    let _ = sock.read_exact(&mut body).await?;
    let v: T = serde_json::from_slice(&body).map_err(std::io::Error::other)?;
    Ok(Some(v))
}

async fn write_msg<T: serde::Serialize>(
    sock: &mut UnixStream,
    msg: &T,
) -> std::io::Result<()> {
    let body = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
    let len = (body.len() as u32).to_be_bytes();
    sock.write_all(&len).await?;
    sock.write_all(&body).await?;
    sock.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_starts_empty() {
        let r = Registry::new();
        assert!(r.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn push_history_keeps_recent_under_two_caps() {
        let mut buf = Vec::new();
        // Feed well past the cap in small chunks, like the reader does.
        let chunk = vec![b'x'; 8192];
        for _ in 0..((HISTORY_CAP * 3) / chunk.len()) {
            push_history(&mut buf, &chunk);
        }
        // Never exceeds the 2× trim trigger, and always retains at least
        // a full cap of the freshest bytes for replay.
        assert!(buf.len() <= HISTORY_CAP * 2, "len={}", buf.len());
        assert!(buf.len() >= HISTORY_CAP, "len={}", buf.len());
    }

    #[test]
    fn push_history_below_cap_is_untrimmed() {
        let mut buf = Vec::new();
        push_history(&mut buf, b"hello ");
        push_history(&mut buf, b"world");
        assert_eq!(buf, b"hello world");
    }
}
