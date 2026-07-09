//! Shell-side PTY daemon client.
//!
//! When `AURA_USE_PTY_DAEMON=1` is set in the shell's env, the
//! `cmd_agent_pty::agent_pty_open` path delegates here instead of
//! spawning portable-pty in-process. The wire format mirrors
//! `proto::Request` / `proto::Response`: length-prefixed JSON over a
//! UNIX socket.
//!
//! Auto-spawn: if the daemon socket isn't reachable, we fork
//! `aura-pty-daemon` (sibling binary in the bundle) and retry the
//! connect for up to 2s. After that we surface a clear error so the
//! shell can fall back to in-process — the env-var opt-in means the
//! user has accepted that this might be flaky early on.

use crate::pty_daemon::proto::{Event, OpenReq, Request, Response, SessionInfo, SessionKind};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

#[derive(Debug)]
pub enum DaemonError {
    Io(std::io::Error),
    Protocol(String),
    Server(String),
}

impl std::fmt::Display for DaemonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Protocol(s) => write!(f, "protocol: {s}"),
            Self::Server(s) => write!(f, "server: {s}"),
        }
    }
}

impl std::error::Error for DaemonError {}

impl From<std::io::Error> for DaemonError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Returns true when AURA_USE_PTY_DAEMON is set to a truthy value.
/// Read at the call site so a runtime config-flip is honored without
/// a shell restart (we don't restart anyway, but the flag is cheap).
pub fn enabled() -> bool {
    matches!(
        std::env::var("AURA_USE_PTY_DAEMON")
            .unwrap_or_default()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Connect to the daemon socket, auto-spawning the daemon binary if
/// needed. Returns a fresh stream on the connect side; the caller
/// owns framing.
pub async fn connect_or_spawn() -> Result<UnixStream, DaemonError> {
    let path = crate::pty_daemon::proto::socket_path()
        .ok_or_else(|| DaemonError::Protocol("no HOME".into()))?;
    if let Ok(s) = UnixStream::connect(&path).await {
        return Ok(s);
    }
    spawn_daemon_binary()?;
    // Connect retry — give the daemon up to ~2s to bind.
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Ok(s) = UnixStream::connect(&path).await {
            return Ok(s);
        }
    }
    Err(DaemonError::Protocol(format!(
        "daemon failed to bind {}",
        path.display()
    )))
}

fn spawn_daemon_binary() -> std::io::Result<()> {
    let bin = locate_daemon_binary().ok_or_else(|| {
        std::io::Error::other("aura-pty-daemon binary not found alongside aura-shell")
    })?;
    // Fully detached: stdout/stderr to a log file so a daemon panic
    // is recoverable. Don't wait — the daemon is meant to outlive us.
    let log_path = log_file_path();
    let log_file = log_path.and_then(|p| {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .ok()
    });
    let mut cmd = std::process::Command::new(&bin);
    if let Some(f) = log_file {
        if let Ok(f2) = f.try_clone() {
            cmd.stdout(Stdio::from(f));
            cmd.stderr(Stdio::from(f2));
        }
    } else {
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
    }
    cmd.stdin(Stdio::null());
    cmd.spawn()?;
    Ok(())
}

fn locate_daemon_binary() -> Option<PathBuf> {
    // 1. Sibling of the running shell exe (production install).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("aura-pty-daemon");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // 2. PATH fallback (dev: `cargo install` puts both bins on PATH).
    if let Ok(out) = std::process::Command::new("which")
        .arg("aura-pty-daemon")
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(PathBuf::from(s));
            }
        }
    }
    None
}

fn log_file_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("logs");
    p.push("pty-daemon.log");
    Some(p)
}

// ── framing helpers ──

pub async fn send(stream: &mut UnixStream, req: &Request) -> Result<(), DaemonError> {
    let body = serde_json::to_vec(req).map_err(|e| DaemonError::Protocol(e.to_string()))?;
    let len = (body.len() as u32).to_be_bytes();
    stream.write_all(&len).await?;
    stream.write_all(&body).await?;
    stream.flush().await?;
    Ok(())
}

pub async fn recv_response(stream: &mut UnixStream) -> Result<Response, DaemonError> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 16 * 1024 * 1024 {
        return Err(DaemonError::Protocol("frame too large".into()));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map_err(|e| DaemonError::Protocol(e.to_string()))
}

pub async fn recv_event(stream: &mut UnixStream) -> Result<Event, DaemonError> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 16 * 1024 * 1024 {
        return Err(DaemonError::Protocol("frame too large".into()));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map_err(|e| DaemonError::Protocol(e.to_string()))
}

/// Quick health check — `Ping → Pong` plus the daemon's PID read
/// from `pid_path`. Returns Err with the underlying transport error
/// when the daemon isn't reachable. Auto-spawns a daemon if needed
/// (matches the `connect_or_spawn` semantics used elsewhere).
pub async fn ping() -> Result<DaemonHealth, DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(&mut sock, &Request::Ping).await?;
    match recv_response(&mut sock).await? {
        Response::Pong => {
            let pid = crate::pty_daemon::proto::pid_path()
                .and_then(|p| std::fs::read_to_string(&p).ok())
                .and_then(|s| s.trim().parse::<u32>().ok());
            Ok(DaemonHealth {
                ok: true,
                pid,
                socket: crate::pty_daemon::proto::socket_path()
                    .map(|p| p.to_string_lossy().into_owned()),
                version: env!("CARGO_PKG_VERSION").to_string(),
            })
        }
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DaemonHealth {
    pub ok: bool,
    pub pid: Option<u32>,
    pub socket: Option<String>,
    pub version: String,
}

/// Convenience: open a session via the daemon. Each call uses a
/// fresh control connection (cheap; a UNIX socket connect is
/// microseconds) so we don't have to share one across tasks.
pub async fn open_session(o: OpenReq) -> Result<String, DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(&mut sock, &Request::Open(o)).await?;
    match recv_response(&mut sock).await? {
        Response::Opened { session_id } => Ok(session_id),
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

pub async fn write_session(session_id: &str, data: &[u8]) -> Result<(), DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(
        &mut sock,
        &Request::Write {
            session_id: session_id.to_string(),
            data: data.to_vec(),
        },
    )
    .await?;
    match recv_response(&mut sock).await? {
        Response::Ok => Ok(()),
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

pub async fn resize_session(
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(
        &mut sock,
        &Request::Resize {
            session_id: session_id.to_string(),
            cols,
            rows,
        },
    )
    .await?;
    match recv_response(&mut sock).await? {
        Response::Ok => Ok(()),
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

pub async fn close_session(session_id: &str) -> Result<(), DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(
        &mut sock,
        &Request::Close {
            session_id: session_id.to_string(),
        },
    )
    .await?;
    match recv_response(&mut sock).await? {
        Response::Ok => Ok(()),
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

/// Ask the daemon to enumerate every PTY child it currently owns
/// along with the `(agent_id, repo_root)` pair from when it was
/// opened. Used by `pty_list_alive` on shell startup to surface
/// daemon-backed sessions that survived an auto-update relaunch so
/// the user can reattach.
pub async fn list_detailed() -> Result<Vec<SessionInfo>, DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(&mut sock, &Request::ListDetailed).await?;
    match recv_response(&mut sock).await? {
        Response::SessionsDetailed { sessions } => Ok(sessions),
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

/// Like `list_detailed` but only the sessions whose `kind` matches.
/// `pty_list_alive` (agents) and `pty_list_alive_plain` (terminals)
/// each call this so neither has to see — or filter out — the other's
/// sessions when deciding what to reattach after a relaunch.
pub async fn list_by_kind(kind: SessionKind) -> Result<Vec<SessionInfo>, DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(&mut sock, &Request::ListByKind { session_kind: kind }).await?;
    match recv_response(&mut sock).await? {
        Response::SessionsDetailed { sessions } => Ok(sessions),
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

/// Pre-relaunch handshake — call from `pty_pre_relaunch` right
/// before the frontend invokes the updater plugin's `relaunch()`.
/// Returns the number of sessions the daemon will keep alive.
/// `Ok(0)` is a valid response (no live sessions, but the daemon is
/// reachable); `Err(_)` means the daemon is down and the shell
/// should warn the user that nothing will survive the restart.
pub async fn pre_relaunch() -> Result<usize, DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(&mut sock, &Request::PreRelaunch).await?;
    match recv_response(&mut sock).await? {
        Response::PreRelaunchAck { count } => Ok(count),
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

/// Hold a long-lived subscribe stream open and yield events. The
/// caller drives it from a tokio task that re-emits each event as a
/// Tauri event on `agent-pty:<sid>`.
pub async fn subscribe(session_id: &str) -> Result<UnixStream, DaemonError> {
    let mut sock = connect_or_spawn().await?;
    send(
        &mut sock,
        &Request::Subscribe {
            session_id: session_id.to_string(),
        },
    )
    .await?;
    match recv_response(&mut sock).await? {
        Response::Subscribed { .. } => Ok(sock),
        Response::Err { message } => Err(DaemonError::Server(message)),
        other => Err(DaemonError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}
