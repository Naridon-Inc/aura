//! Two-process PTY hosting (T3.1).
//!
//! In-process portable-pty children die when the shell process dies —
//! a React-side reload, a Tauri panic, the user `kill`-ing the wrong
//! Aura window all kill every running coding-agent CLI in their
//! tabs. That's the wrong default: claude / gemini sessions can be
//! mid-task and losing them costs the user real work.
//!
//! This module sets up an opt-in two-process arch:
//!
//!   1. `aura-pty-daemon` binary (src/bin/aura_pty_daemon.rs) — long-
//!      lived child of the user's session, owns the PTY masters /
//!      child processes, listens on a UNIX socket.
//!
//!   2. Shell-side client (`client::DaemonClient`) — when the env var
//!      `AURA_USE_PTY_DAEMON=1` is set at shell startup, every
//!      `agent_pty_open` proxies through the daemon instead of
//!      spawning portable-pty in-process. Restarting the shell
//!      reattaches to the same sessions.
//!
//! Default remains in-process portable-pty so we don't regress the
//! existing path. Flip the env var to opt in.
//!
//! Wire format: length-prefixed JSON. Each message is a 4-byte BE
//! u32 length + that many bytes of UTF-8 JSON. Cheap; the message
//! rate is human-typing-bounded, so JSON overhead is fine.

pub mod client;
pub mod proto;
pub mod server;

/// Tauri command — surfaces daemon health to the React side. Returns
/// an Ok envelope when the daemon is reachable, Err with the
/// transport error message otherwise. Used by the Settings UI's
/// "Two-process PTY" toggle to confirm the daemon binary is reachable
/// before flipping `AURA_USE_PTY_DAEMON=1` for the next shell launch.
#[tauri::command]
pub async fn pty_daemon_ping() -> Result<client::DaemonHealth, String> {
    client::ping().await.map_err(|e| e.to_string())
}

/// Tauri command — returns whether daemon mode is currently active
/// for this shell process. Read once from the env on call so the
/// renderer can show the live state without restart hints.
#[tauri::command]
pub fn pty_daemon_enabled() -> bool {
    client::enabled()
}
