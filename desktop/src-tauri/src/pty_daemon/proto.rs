//! Wire types for the PTY daemon. Shared by the daemon binary
//! (`bin/aura_pty_daemon.rs`) and the shell-side client.
//!
//! Length-prefixed JSON over a UNIX socket. Request → Response is
//! synchronous on a dedicated control connection; per-session byte
//! events flow on a separate Subscribe connection so output bytes
//! never block control RPCs.

use serde::{Deserialize, Serialize};

/// What flavor of child a daemon session wraps. The daemon hosts both
/// interactive agent CLIs (claude/gemini/codex) and — since terminal
/// parity — plain login shells. The discriminator keeps the two restore
/// paths from cross-claiming each other's sessions: the agent-resume
/// picker must never offer a bare `zsh`, and the terminal restore must
/// never grab a live `claude`. Defaults to `Agent` so an older daemon
/// (pre-`kind`) or any legacy caller still deserializes cleanly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    #[default]
    Agent,
    Plain,
}

/// Server socket path under `~/.aura/run/`. Per-user; multi-user
/// boxes get their own daemon (HOME differs).
pub fn socket_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = std::path::PathBuf::from(home);
    p.push(".aura");
    p.push("run");
    p.push("pty-daemon.sock");
    Some(p)
}

/// PID file alongside the socket so the shell can decide whether to
/// fork a fresh daemon. We don't lock — multiple daemons listening on
/// the same socket would error out at bind() anyway.
pub fn pid_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = std::path::PathBuf::from(home);
    p.push(".aura");
    p.push("run");
    p.push("pty-daemon.pid");
    Some(p)
}

/// Request from shell → daemon over the control connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Request {
    /// Health check — daemon answers with `Response::Pong`.
    Ping,
    /// Spawn a new PTY child. The daemon inherits the env from the
    /// shell's request, plus its own TERM/COLORTERM defaults.
    Open(OpenReq),
    /// Push bytes into an existing session's PTY stdin.
    Write { session_id: String, data: Vec<u8> },
    /// Resize PTY's window dimensions.
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Kill the child + drop the master.
    Close { session_id: String },
    /// List currently-attached session ids — used by the shell on
    /// startup to discover what's already running.
    List,
    /// Richer variant of `List`: returns each session's id +
    /// `(agent_id, repo_root)` so the shell can render a resumable
    /// list without a follow-up RPC per session. The simpler `List`
    /// is kept for legacy callers.
    ListDetailed,
    /// Filtered variant of `ListDetailed` — returns only sessions whose
    /// `kind` matches. The plain-terminal restore path and the agent
    /// resume picker each query just their own flavor so they never
    /// surface (or have to filter out) the other's sessions. Response:
    /// `Response::SessionsDetailed`. The field is `session_kind` (not
    /// `kind`) because the enum is internally tagged on `"kind"` — a
    /// variant field literally named `kind` would collide with the tag.
    ListByKind { session_kind: SessionKind },
    /// Pre-relaunch handshake. The shell calls this immediately
    /// before invoking tauri-plugin-process `relaunch()` after an
    /// auto-update. Today this is informational — daemon-owned
    /// children already survive the shell exit because we never
    /// signal them — but the RPC gives us a clean extension point
    /// for future bookkeeping (e.g. flushing in-flight bytes to disk,
    /// pinning the daemon against an opportunistic systemd-cleanup).
    /// Response: `Response::Ok` with the count of sessions still alive.
    PreRelaunch,
    /// Open a byte-stream subscription. After a successful Subscribe,
    /// the connection switches modes: the daemon sends
    /// `Event::Bytes` / `Event::Exit` until the session closes.
    Subscribe { session_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenReq {
    pub agent_id: String,
    pub repo_root: String,
    pub bin: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    /// Agent vs plain-shell. `#[serde(default)]` → `Agent` keeps the
    /// existing agent callers (and any in-flight pre-`kind` daemon)
    /// valid without a coordinated upgrade.
    ///
    /// On the wire it is `session_kind`, matching `ListByKind`. `Request`
    /// is internally tagged on `kind`, and this is a newtype variant, so
    /// its fields land in the SAME object as the tag: named `kind` here,
    /// every Open frame carried the key twice and the daemon rejected it
    /// with `duplicate field 'kind'` before it ever spawned a PTY. An
    /// older daemon reads this as a missing field and falls back to
    /// `Agent` — which is what it did before session kinds existed.
    #[serde(default, rename = "session_kind")]
    pub kind: SessionKind,
    /// Friendly label for the reattach/restore UI (e.g. a terminal tab
    /// name). Agents leave this `None` and derive their own title.
    #[serde(default)]
    pub label: Option<String>,
    /// Working directory for the child. Plain shells set this to the
    /// terminal's cwd; when `None` the daemon falls back to `repo_root`
    /// (the agent default), preserving prior behavior exactly.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Response sent on the control connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Pong,
    /// Acknowledgment + the freshly-allocated session id.
    Opened { session_id: String },
    /// Bare-ack for Write / Resize / Close.
    Ok,
    /// Sessions listing.
    Sessions { ids: Vec<String> },
    /// Richer listing — id + (agent_id, repo_root) per session.
    SessionsDetailed { sessions: Vec<SessionInfo> },
    /// Pre-relaunch ack. `count` is the number of sessions the
    /// daemon will keep alive across the shell restart.
    PreRelaunchAck { count: usize },
    /// Subscription accepted — subsequent reads are framed events.
    Subscribed { session_id: String },
    /// Any error path comes back as this; the shell client surfaces
    /// the message verbatim.
    Err { message: String },
}

/// One entry in `Response::SessionsDetailed`. Keeps the wire shape
/// close to what `AgentSessionHandle` exposes on the frontend so the
/// renderer can reattach without an extra translation step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub repo_root: String,
    #[serde(default)]
    pub kind: SessionKind,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Events pushed from daemon → shell on a Subscribe connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Bytes { session_id: String, data: Vec<u8> },
    Exit { session_id: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_req_without_kind_defaults_to_agent() {
        // A pre-`kind` OpenReq (older shell talking to a newer daemon, or
        // vice versa) must still deserialize — `kind`/`label`/`cwd` all
        // default so the agent path is byte-identical to before.
        let legacy = r#"{
            "agent_id": "claude",
            "repo_root": "/r",
            "bin": "claude",
            "args": [],
            "env": [],
            "cols": 80,
            "rows": 24
        }"#;
        let req: OpenReq = serde_json::from_str(legacy).unwrap();
        assert_eq!(req.kind, SessionKind::Agent);
        assert!(req.label.is_none());
        assert!(req.cwd.is_none());
    }

    #[test]
    fn session_kind_round_trips_snake_case() {
        assert_eq!(
            serde_json::to_string(&SessionKind::Plain).unwrap(),
            "\"plain\""
        );
        let k: SessionKind = serde_json::from_str("\"agent\"").unwrap();
        assert_eq!(k, SessionKind::Agent);
    }

    #[test]
    fn an_open_request_survives_its_own_wire() {
        // `Open` is a newtype variant, so `OpenReq`'s fields share the
        // object with the `"kind"` tag. When the session kind was also
        // named `kind`, serde happily wrote the key twice and the daemon
        // answered every Open with `duplicate field 'kind'` — no PTY, no
        // terminal, just an early EOF at the client. Encoding is not the
        // test; decoding what we encoded is.
        let req = Request::Open(OpenReq {
            agent_id: "test".into(),
            repo_root: "/r".into(),
            bin: "/bin/cat".into(),
            args: vec![],
            env: vec![],
            cols: 80,
            rows: 24,
            kind: SessionKind::Plain,
            label: None,
            cwd: None,
        });
        let json = serde_json::to_string(&req).unwrap();
        assert_eq!(
            json.matches("\"kind\":").count(),
            1,
            "the envelope tag must be the only `kind` on an Open frame: {json}"
        );
        assert!(json.contains("\"session_kind\":\"plain\""));

        let back: Request = serde_json::from_str(&json).expect("daemon must decode its own Open");
        match back {
            Request::Open(r) => {
                assert_eq!(r.kind, SessionKind::Plain);
                assert_eq!(r.bin, "/bin/cat");
            }
            other => panic!("expected Open, got {other:?}"),
        }
    }

    #[test]
    fn list_by_kind_tag_does_not_collide() {
        // The variant field is `session_kind` precisely so the internal
        // `"kind"` tag stays unambiguous on the wire.
        let req = Request::ListByKind {
            session_kind: SessionKind::Plain,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"kind\":\"list_by_kind\""));
        assert!(json.contains("\"session_kind\":\"plain\""));
    }
}
