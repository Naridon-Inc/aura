//! State for plain shell PTYs. Mirrors the agent registry
//! (`cmd_agent_pty::AgentPtyRegistry`) but for login shells: a map of
//! in-process sessions, a parallel map of daemon-backed ones (when
//! `AURA_USE_PTY_DAEMON=1` the daemon owns the child so it survives an
//! app restart), a per-session scrollback ring for live tab-switch
//! backfill, and a per-session recent-command ring fed by the OSC-133
//! shell-integration marks.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex};

use portable_pty::MasterPty;
use serde::Serialize;

/// Same 4 MiB cap the agent ring uses — enough to bridge the
/// spawn→listen race and give a remounting xterm a screenful of
/// scrollback without unbounded growth.
pub const PTY_HISTORY_CAP: usize = 4 * 1024 * 1024;

/// How many recent commands we retain per session for "Run Recent
/// Command". VS Code keeps a comparable shell-history window.
pub const RECENT_COMMANDS_CAP: usize = 50;

/// One in-process plain PTY. The three locked handles match
/// `cmd_agent_pty::AgentPtySession`'s shape so the write/resize/close
/// dance is identical; `last_byte_ms` backs idle reporting and the
/// daemon-vs-inprocess listings.
pub struct PtySession {
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub cwd: Option<String>,
    pub label: Option<String>,
    pub last_byte_ms: Arc<Mutex<u64>>,
}

/// A plain PTY whose child is owned by `aura-pty-daemon`. The four
/// mutating commands check this map first and proxy to the daemon
/// client; the subscribe loop (held by `subscribe_handle`) re-emits
/// daemon bytes as the same `pty:<id>` events the in-process path uses.
pub struct DaemonPtySession {
    pub cwd: Option<String>,
    pub label: Option<String>,
    pub subscribe_handle: tokio::task::JoinHandle<()>,
    pub last_byte_ms: Arc<Mutex<u64>>,
}

#[derive(Default)]
pub struct PtyRegistry {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    /// Daemon-backed plain sessions reattached in this shell process.
    pub daemon_sessions: Mutex<HashMap<String, DaemonPtySession>>,
    /// Per-session scrollback ring (last `PTY_HISTORY_CAP` bytes),
    /// populated by both read loops; consumed by `pty_replay_bytes`.
    pub history: Arc<Mutex<HashMap<String, VecDeque<u8>>>>,
    /// Per-session recent-command ring, fed by the OSC-133 marks the
    /// shell-integration rc emits. Consumed by `pty_recent_commands`.
    pub recent_commands: Arc<Mutex<HashMap<String, VecDeque<RecentCommand>>>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kill every IN-PROCESS plain PTY child. Daemon-backed sessions
    /// are intentionally left alone — surviving an app restart is the
    /// whole reason they're daemon-hosted. Called from the app's
    /// shutdown hook alongside the agent registry's `kill_all`.
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, sess) in sessions.drain() {
            let _ = sess.child.lock().unwrap().kill();
        }
    }

    /// Snapshot a session's recent commands, newest last.
    pub fn recent_commands_for(&self, session_id: &str) -> Vec<RecentCommand> {
        self.recent_commands
            .lock()
            .unwrap()
            .get(session_id)
            .map(|r| r.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Drop all per-session state for a closed/exited session so the
    /// rings don't leak across the app's lifetime.
    pub fn forget(&self, session_id: &str) {
        self.history.lock().unwrap().remove(session_id);
        self.recent_commands.lock().unwrap().remove(session_id);
    }
}

/// Returned by `pty_open`. `reconnected` is true when we re-attached
/// to a daemon-owned survivor instead of spawning a fresh child — the
/// frontend uses it to skip the cold scrollback replay (the live
/// process already has the screen).
#[derive(Serialize)]
pub struct PtyHandle {
    pub id: String,
    pub reconnected: bool,
}

/// One live plain session in `pty_list_alive_plain`. The frontend
/// cross-references `session_id` against each persisted tab's
/// `daemonSessionId` to decide reconnect-vs-cold-replay on boot.
#[derive(Serialize, Clone)]
pub struct LivePlainPtySession {
    pub session_id: String,
    pub cwd: Option<String>,
    pub label: Option<String>,
    pub idle_ms: Option<u64>,
}

/// One entry in a session's recent-command ring.
#[derive(Serialize, Clone)]
pub struct RecentCommand {
    pub text: String,
    pub exit_code: Option<i32>,
    pub ts_ms: u64,
}

/// Which OSC-133 boundary a `CommandMark` event marks.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum MarkKind {
    PromptStart,
    CommandStart,
    CommandEnd,
}

/// Emitted on `pty-command:<id>` as the shell crosses an OSC-133
/// boundary. `seq` is monotonic per session so the frontend can map a
/// mark to the xterm buffer line it registered and drive ⌘↑/⌘↓
/// "scroll to previous/next command".
#[derive(Serialize, Clone)]
pub struct CommandMark {
    pub kind: MarkKind,
    pub exit_code: Option<i32>,
    pub seq: u64,
}
