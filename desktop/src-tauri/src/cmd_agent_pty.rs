//! Interactive agent PTY sessions.
//!
//! `cmd_agents.rs` spawns agents non-interactively (`-p` / `exec`) via
//! tokio::process for one-shot replies. This module is the opposite: it
//! launches the agent CLI bare (`claude`, `gemini`, `codex`, `cursor-agent`)
//! inside a real PTY so the user can hold a long-running conversation,
//! send Ctrl-C, switch between a raw xterm view and a chat-bubble UI
//! view — and have a follow-up "send" in the Composer just write a new
//! line into the same live REPL instead of spinning up a fresh process.
//!
//! By default `agent_pty_open` re-attaches to a live `(agent_id, repo_root)`
//! session so restored tabs don't lose context. Callers can pass
//! `force_new = true` when the user explicitly launches another Claude /
//! Codex / Gemini / Cursor instance in the same workspace.
//!
//! Block envelopes are accumulated on the read thread:
//!
//!   - `send_prompt` synthetically frames a closed Prompt block and opens
//!     a fresh Output block; the read loop appends streamed bytes to it.
//!   - The vte-based OSC 133 watcher honors `\x1b]133;D` if the agent
//!     emits it (most don't), closing the Output block as Exit with the
//!     reported exit code.
//!   - The next `send_prompt` closes any still-open Output block, so the
//!     UI view always renders a clean stack of (prompt, output) pairs
//!     even without a real ;D marker.
//!
//! Two events fire per session:
//!   - `agent-pty:<id>` — raw bytes (`Vec<u8>`); xterm.js consumes them
//!     directly to render the Terminal view.
//!   - `agent-block:<id>` — `BlockUpdate { op: open|append|close, ... }`
//!     deltas; the AgentBlocksView store applies them in order.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

/// Per-PTY scrollback ring buffer, capped so a long-running session
/// doesn't grow unbounded. Phone clients fetch this on join so they
/// see the same screen the desktop xterm has.
const PTY_HISTORY_CAP: usize = 4 * 1024 * 1024;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
// One contract for "start something here", wherever here is — the same seam
// the chat's tools and the session list already run on.
use crate::manager::brain::place::Place;
use crate::manager::brain::place_contract::Open;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;
use uuid::Uuid;
use vte::{Parser, Perform};

// ── types ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Prompt,
    Output,
    Exit,
}

#[derive(Serialize, Clone, Debug)]
pub struct BlockEnvelope {
    pub id: String,
    pub kind: BlockKind,
    pub session_id: String,
    pub agent_id: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    /// Printable text only — ANSI/CSI sequences are dropped on the way
    /// in. The Terminal view renders the raw byte stream separately, so
    /// this field only needs to be readable, not faithful to the wire.
    pub text: String,
    pub exit_code: Option<i32>,
}

#[derive(Serialize, Clone)]
pub struct AgentSessionHandle {
    pub id: String,
    pub agent_id: String,
    pub repo_root: String,
    pub resumed: bool,
}

/// One live coding-agent PTY session in a repo, as surfaced to the
/// "Start in agent" picker so a task can be handed to an *already
/// running* agent (an ongoing Claude Code / Gemini / Codex session)
/// instead of always spawning a fresh one. Sorted most-recently-active
/// first by `last_byte_ms`.
#[derive(Serialize, Clone)]
pub struct LiveAgentSession {
    pub session_id: String,
    pub agent_id: String,
    pub repo_root: String,
    /// ms-since-epoch of the last byte the agent wrote — drives the
    /// "active 12s ago" hint and the most-recent-first ordering.
    pub last_byte_ms: u64,
    /// Latest OSC window title the agent set, when known — a human-ish
    /// label ("claude — fixing auth") the picker can show beside the id.
    pub title: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum BlockUpdate {
    Open {
        block: BlockEnvelope,
    },
    /// Rewrite the tail of a block: drop its last `drop_lines` lines, then put
    /// `lines` in their place.
    ///
    /// This replaces a plain append because a terminal is not append-only. A
    /// CLI's spinner, its progress bar and its status footer are all drawn by
    /// returning to a line already on screen and painting over it, so an
    /// append-only stream turns one spinner into a copy of itself per frame —
    /// which is exactly what the agent chat used to show. `drop_lines` is 0
    /// for ordinary streaming output, which is the overwhelming majority of
    /// updates, so the common case is still a pure append by another name.
    Reframe {
        block_id: String,
        drop_lines: usize,
        lines: Vec<String>,
    },
    Close {
        block: BlockEnvelope,
    },
}

/// What changed between the transcript we last mirrored and the one the
/// terminal holds now, in whole lines.
#[derive(Debug, PartialEq, Eq)]
struct TranscriptDelta {
    /// Lines the terminal dropped off the top of its scrollback since we last
    /// looked. Callers holding a line-index anchor shift it down by this much.
    evicted: usize,
    /// Trailing mirrored lines the terminal has since painted over.
    rewrote: usize,
    /// What goes in their place.
    added: Vec<String>,
}

fn common_prefix(a: &[String], b: &[String]) -> usize {
    let mut i = 0;
    while i < a.len() && i < b.len() && a[i] == b[i] {
        i += 1;
    }
    i
}

/// Diff two transcripts by line.
///
/// A terminal only ever changes its text in two ways: it drops lines off the
/// top when scrollback fills, and it rewrites some suffix of what is on
/// screen. So the whole diff is (how many fell off the top, how many of mine
/// are stale, what replaces them) — no general edit-distance needed, and the
/// usual answer is (0, 0, the new lines).
fn transcript_delta(prev: &[String], next: &[String]) -> TranscriptDelta {
    let mut evicted = 0;
    let mut keep = common_prefix(prev, next);
    // A grid at its scrollback limit loses a line off the top for every line
    // it gains at the bottom, so the two transcripts stop starting at the same
    // place and a naive prefix match reports that everything changed.
    // Realign before believing that.
    if keep == 0 && !prev.is_empty() && !next.is_empty() {
        for shift in 1..prev.len() {
            let k = common_prefix(&prev[shift..], next);
            // One line in common is a coincidence — blank lines and repeated
            // prompts match all over a transcript. A run of two is an
            // alignment. The single-line case is only trusted when it is the
            // whole of what we had left.
            if k >= 2 || (k == 1 && prev.len() - shift == 1) {
                evicted = shift;
                keep = k;
                break;
            }
        }
    }
    TranscriptDelta {
        evicted,
        rewrote: prev.len() - evicted - keep,
        added: next[keep..].to_vec(),
    }
}

/// Apply a [`BlockUpdate::Reframe`] to a block's text: drop its last
/// `drop_lines` lines, then put `lines` in their place.
///
/// The frontend's block store implements the same contract against the same
/// event, so this is deliberately the simplest statement of it — the two have
/// to agree line for line or a repaint desyncs the copy the user is reading
/// from the copy `agent_pty_blocks` replays after a remount.
fn reframe_text(text: &mut String, drop_lines: usize, lines: &[String]) {
    for _ in 0..drop_lines {
        match text.rfind('\n') {
            Some(at) => text.truncate(at),
            None => {
                text.clear();
                break;
            }
        }
    }
    for line in lines {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(line);
    }
}

/// Structured event emitted by an agent's plugin scripts (claude-code,
/// gemini-cli, …) over OSC 777. We keep the schema mirror-imageable to
/// the bash plugin's `build_payload`: every field is optional so older
/// or partial emitters round-trip cleanly, and any future field lands
/// in `extra` without recompiling.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CliAgentEvent {
    /// Protocol version negotiated between Aura and the plugin. Today
    /// always `1`; future bumps land here so the renderer can branch
    /// before applying.
    pub v: u32,
    /// Agent id emitting the event (`"claude"`, `"gemini"`, …).
    pub agent: String,
    /// Event name. Known: `session_start`, `prompt_submit`, `stop`,
    /// `permission_request`, `tool_complete`, `idle_prompt`. Unknown
    /// strings ride through verbatim — the frontend decides what to do.
    pub event: String,
    /// Agent's own session id (claude UUID, gemini session string, …),
    /// not Aura's PTY session id. Use to correlate with stream-json
    /// captures or `aura_session_resume`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Last user prompt (truncated by plugin to ~200 chars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Last assistant response (truncated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
    /// Human-readable summary used for the `Blocked` chip ("Wants to run
    /// Bash: rm -rf …", "Input needed", …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    /// Catch-all for forward-compat fields. Anything we haven't named
    /// above lands here so the frontend can still surface it.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Wraps a parsed event with the Aura PTY session id so the frontend
/// can route it back to the right agent tab without a per-session
/// listener spammer.
#[derive(Serialize, Clone, Debug)]
pub struct CliAgentEventEnvelope {
    pub session_id: String,
    pub event: CliAgentEvent,
}

/// Protocol version Aura advertises to plugin scripts via
/// `AURA_CLI_AGENT_PROTOCOL_VERSION`. Bump together with the bash
/// plugin's `PLUGIN_CURRENT_PROTOCOL_VERSION` whenever the wire schema
/// adds a non-trivial field.
const AURA_CLI_AGENT_PROTOCOL_VERSION: u32 = 1;

pub struct AgentPtySession {
    /// Shared so the write commands can clone it and release the
    /// registry lock before the (blocking) write — see `crate::pty_io`.
    /// Holding `sessions` across that write let one wedged agent freeze
    /// every terminal in the app.
    writer: crate::pty_io::SharedPtyWriter,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    blocks: Mutex<Vec<BlockEnvelope>>,
    /// A shadow terminal fed the same bytes the child writes, so a block's
    /// text can be *what the screen showed* rather than every byte that
    /// produced it.
    ///
    /// This is the difference between a transcript and a byte log. A CLI
    /// paints its spinner by returning to the start of a line and drawing
    /// over it, and paints a menu by moving the cursor to each row rather
    /// than emitting newlines. Keeping the printable characters and dropping
    /// the cursor moves — which is all a stripper can do — turns the first
    /// into one copy of the spinner per frame and the second into a single
    /// run-on paragraph. Both were plainly visible in the chat view for every
    /// agent without a protocol adapter. A grid resolves them the way the
    /// user's own terminal does, because it is the same engine the terminal
    /// pane renders.
    grid: Mutex<aura_term_core::GridTerminal>,
    /// Our copy of `grid`'s transcript, as of the last chunk — the baseline
    /// each chunk's [`transcript_delta`] is measured against.
    grid_lines: Mutex<Vec<String>>,
    /// How many lines at the end of that transcript belong to
    /// `current_block_id`. Bounds how far back a repaint is allowed to reach:
    /// a block may rewrite its own tail, never a finished block's.
    block_lines: Mutex<usize>,
    /// Id of the currently-open block, if any. Set when send_prompt
    /// opens an Output block; cleared when a ;D marker or a new prompt
    /// closes it.
    current_block_id: Mutex<Option<String>>,
    agent_id: String,
    repo_root: String,
    /// Key under which this session is registered in `by_key`. Stored
    /// so close() can look it up without re-deriving (the resume_session_id
    /// suffix would otherwise be lost).
    key: String,
    /// Ring of recent raw PTY bytes the child has written. Used by
    /// `agent_pty_replay_bytes` so a freshly-mounted xterm sees the
    /// agent's welcome screen even if it attached after spawn AND so
    /// the scrollback overlay can re-render the full sanitized history.
    /// Capped at BYTE_REPLAY_CAP (4 MiB ≈ 60k lines of dense TUI
    /// output) so a long-running session doesn't grow unbounded but
    /// the user can still scroll back through a meaningful chunk of
    /// the conversation — matches Warp / native Terminal expectations.
    raw_bytes: Mutex<Vec<u8>>,
    /// ms-since-epoch of the last text append into the current Output
    /// block. Used by the idle-timeout closer in the read loop so
    /// blocks auto-finalize when the agent stops streaming, even when
    /// it never emits an OSC 133 ;D marker (claude/gemini/codex/cursor
    /// don't, today).
    last_append_ms: Mutex<Option<u64>>,
    /// ms-since-epoch of the last `agent-attention` event we emitted
    /// for this session. Throttles BEL-driven notifications so a
    /// chatty agent doesn't fire dozens of pings.
    last_attention_ms: Mutex<Option<u64>>,
    /// ms-since-epoch of the last OS notification (more aggressive
    /// throttle than the in-app dot — the dot is cheap, an OS toast is
    /// loud).
    last_notify_ms: Mutex<Option<u64>>,
    /// ms-since-epoch of the last byte the child wrote to the PTY.
    /// Set on session creation and bumped every time a chunk arrives
    /// from the reader thread. The frontend polls `agent_pty_idle_status`
    /// to render a "Stale · Reconnect | Stop" chip when the child goes
    /// silent for too long (Anthropic API hang, claude-code-cli's
    /// dead-input bug, network stalls, etc.) — without this counter
    /// the user has no signal a long wait is actually a freeze.
    last_byte_ms: Mutex<u64>,
    /// Latest window title the agent set via OSC 0 / OSC 2. Kept so the
    /// read loop can suppress duplicate emits and so a late-mounting
    /// frontend can pull the current title via `agent_pty_title`.
    last_title: Mutex<Option<String>>,
}

const BYTE_REPLAY_CAP: usize = 4 * 1024 * 1024;

/// Bookkeeping for sessions whose PTY child is owned by
/// `aura-pty-daemon` instead of this process. When
/// `AURA_USE_PTY_DAEMON=1` is set, agent_pty_open routes here and
/// the four mutating commands check this map before falling back to
/// the in-process registry.
struct DaemonSession {
    agent_id: String,
    repo_root: String,
    key: String,
    /// JoinHandle for the per-session subscribe loop. Aborted on
    /// close() to drop the daemon-side broadcast receiver.
    subscribe_handle: tokio::task::JoinHandle<()>,
    /// Same role as `AgentPtySession::last_byte_ms` — populated by the
    /// daemon subscribe loop every time a `Event::Bytes` lands. Used by
    /// `agent_pty_idle_status` so daemon-backed sessions get the same
    /// stale-watchdog UX as in-process ones.
    last_byte_ms: Arc<Mutex<u64>>,
}

#[derive(Default)]
pub struct AgentPtyRegistry {
    /// "{agent_id}@{repo_root}" -> session_id, so a second open() on the
    /// same key returns the existing session.
    by_key: Mutex<HashMap<String, String>>,
    /// One in-flight `agent_pty_open` per key. The "is there already a
    /// session for this key" check and the `by_key` insert that publishes
    /// the answer sit far apart, with a CLI spawn in between — so two opens
    /// racing on the same key both saw nothing, both spawned a child, and
    /// the second insert overwrote the first's mapping. The first child was
    /// then orphaned on a PTY nobody reads, which the user experiences as a
    /// terminal that never prints. Holding this across check-and-insert
    /// makes the second caller wait and then resume the first's session.
    ///
    /// The gate is only ever held for the duration of one open: a registry
    /// lookup, a config-repair `spawn_blocking`, and the spawn itself. It
    /// never awaits on the child's output, so it can't turn a quiet agent
    /// into a hung second tab.
    open_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    sessions: Mutex<HashMap<String, AgentPtySession>>,
    /// Parallel map for daemon-backed sessions. Looked up first by
    /// every mutating command — when present, route to daemon
    /// client; otherwise fall through to the in-process path.
    daemon_sessions: Mutex<HashMap<String, DaemonSession>>,
    /// Rolling output buffer per session_id (last PTY_HISTORY_CAP bytes).
    /// Populated by both the in-process and daemon read loops; consumed
    /// by `agent_pty_history` so a phone joining mid-session can replay
    /// the visible screen plus recent scrollback.
    pub history: Arc<Mutex<HashMap<String, VecDeque<u8>>>>,
}

/// Minimal per-session info the cloud session-sync heartbeat needs to
/// publish a live agent session to the phone's Workspaces feed.
pub struct AgentSyncInfo {
    pub session_id: String,
    pub agent_id: String,
    pub repo_root: String,
}

impl AgentPtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// The open gate for `key`, created on first use. Callers hold the
    /// returned `Arc` while they wait, which is what keeps
    /// [`Self::release_open_gate`] from pruning an entry someone is queued on.
    fn open_gate(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut gates = self.open_gates.lock().unwrap();
        Arc::clone(gates.entry(key.to_string()).or_default())
    }

    /// Drop `key`'s gate once the releasing caller is the last reference.
    /// A long-lived app opens an unbounded number of distinct keys — every
    /// `force_new` open mints a fresh UUID one — so the map has to shed
    /// finished entries or it grows for the life of the process. A strong
    /// count above two means someone else is holding or queued on the gate,
    /// and removing it would let them race against a caller who then made a
    /// second, unrelated gate for the same key.
    fn release_open_gate(&self, key: &str) {
        let mut gates = self.open_gates.lock().unwrap();
        let idle = gates
            .get(key)
            .is_some_and(|g| Arc::strong_count(g) <= 2);
        if idle {
            gates.remove(key);
        }
    }

    /// Snapshot of every *live* agent session (in-process + daemon-backed)
    /// for `cloud_session_sync::spawn_session_heartbeat`. In-process sessions
    /// whose child has exited, and daemon sessions whose subscribe loop has
    /// ended, are skipped so the heartbeat never publishes a corpse.
    pub fn live_sessions_for_sync(&self) -> Vec<AgentSyncInfo> {
        let mut out = Vec::new();
        {
            let sessions = self.sessions.lock().unwrap();
            for (sid, s) in sessions.iter() {
                let alive = s
                    .child
                    .lock()
                    .unwrap()
                    .try_wait()
                    .ok()
                    .flatten()
                    .is_none();
                if alive {
                    out.push(AgentSyncInfo {
                        session_id: sid.clone(),
                        agent_id: s.agent_id.clone(),
                        repo_root: s.repo_root.clone(),
                    });
                }
            }
        }
        {
            let daemon = self.daemon_sessions.lock().unwrap();
            for (sid, s) in daemon.iter() {
                if !s.subscribe_handle.is_finished() {
                    out.push(AgentSyncInfo {
                        session_id: sid.clone(),
                        agent_id: s.agent_id.clone(),
                        repo_root: s.repo_root.clone(),
                    });
                }
            }
        }
        out
    }

    /// Kill every PTY child this registry owns. Called from the app's
    /// run-event hook on shutdown so coding-agent CLIs don't outlive the
    /// shell — without this the user's `claude` / `gemini` / `codex`
    /// process keeps writing to stdout into a now-disconnected PTY,
    /// eating CPU and leaking sessions until they `pkill` it manually.
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, sess) in sessions.drain() {
            // Group hangup, not a bare SIGKILL of the CLI: a coding agent
            // spawns its own tool subprocesses, and those are what carry on
            // writing into a disconnected PTY when only their parent dies.
            crate::pty_reap::hangup_and_reap(&mut **sess.child.lock().unwrap());
        }
        self.by_key.lock().unwrap().clear();
        // Drop every per-session history ring too. The read loops tee up
        // to PTY_HISTORY_CAP bytes per session into this map; clearing
        // `sessions`/`by_key` without it would still pin all that memory.
        self.history.lock().unwrap().clear();
    }

    /// Evict history rings whose session no longer exists in either the
    /// in-process or daemon-backed map. The history map is filled by the
    /// read loops but only the explicit `agent_pty_close` path prunes a
    /// single key; this GC reclaims any ring orphaned by a different
    /// removal path (e.g. the open-failure rollback) so the map can't
    /// grow without bound across a long shell session. Cheap — bounded by
    /// the live session count, no I/O. Called on each `agent_pty_open`.
    pub fn gc_orphan_history(&self) {
        let live: std::collections::HashSet<String> = {
            let mut set = std::collections::HashSet::new();
            if let Ok(map) = self.sessions.lock() {
                set.extend(map.keys().cloned());
            }
            if let Ok(map) = self.daemon_sessions.lock() {
                set.extend(map.keys().cloned());
            }
            set
        };
        if let Ok(mut hist) = self.history.lock() {
            hist.retain(|sid, _| live.contains(sid));
        }
    }

    /// Read-only accessor used by `agent_mutation_guard`. Returns the
    /// `agent_id` of every live session (in-process + daemon-backed)
    /// whose `repo_root` matches `root`. Cheap — bounded by session
    /// count, no I/O. The guard uses this to decide whether to credit a
    /// filesystem mutation to an agent vs. ignore it as a plain-shell /
    /// human edit.
    pub fn active_agents_in(&self, root: &str) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(map) = self.sessions.lock() {
            for sess in map.values() {
                if sess.repo_root == root {
                    out.push(sess.agent_id.clone());
                }
            }
        }
        if let Ok(map) = self.daemon_sessions.lock() {
            for sess in map.values() {
                if sess.repo_root == root {
                    out.push(sess.agent_id.clone());
                }
            }
        }
        out
    }

    /// Pick the most-recently-active session in this repo across both
    /// the in-process and daemon-backed maps. "Most recent" = highest
    /// `last_byte_ms`. Returns `(session_id, agent_id)` of the chosen
    /// session, or `None` if no live agent is in this repo.
    ///
    /// Used by the mutation-guard self-heal path so the Manager can
    /// pick a sane single session to nudge when an agent (or several)
    /// have touched files without logging intent.
    pub fn latest_session_for_repo(&self, root: &str) -> Option<(String, String)> {
        let mut best: Option<(String, String, u64)> = None;
        if let Ok(map) = self.sessions.lock() {
            for (sid, sess) in map.iter() {
                if sess.repo_root != root {
                    continue;
                }
                let ts = *sess.last_byte_ms.lock().unwrap();
                if best.as_ref().is_none_or(|(_, _, t)| ts > *t) {
                    best = Some((sid.clone(), sess.agent_id.clone(), ts));
                }
            }
        }
        if let Ok(map) = self.daemon_sessions.lock() {
            for (sid, sess) in map.iter() {
                if sess.repo_root != root {
                    continue;
                }
                let ts = *sess.last_byte_ms.lock().unwrap();
                if best.as_ref().is_none_or(|(_, _, t)| ts > *t) {
                    best = Some((sid.clone(), sess.agent_id.clone(), ts));
                }
            }
        }
        best.map(|(s, a, _)| (s, a))
    }

    /// Every live session in `root`, most-recently-active first. Backs
    /// the "Start in agent → hand to a running session" picker. Cheap —
    /// bounded by session count, no I/O.
    pub fn list_in(&self, root: &str) -> Vec<LiveAgentSession> {
        let mut out = Vec::new();
        if let Ok(map) = self.sessions.lock() {
            for (sid, sess) in map.iter() {
                if sess.repo_root != root {
                    continue;
                }
                out.push(LiveAgentSession {
                    session_id: sid.clone(),
                    agent_id: sess.agent_id.clone(),
                    repo_root: sess.repo_root.clone(),
                    last_byte_ms: *sess.last_byte_ms.lock().unwrap(),
                    title: sess.last_title.lock().unwrap().clone(),
                });
            }
        }
        if let Ok(map) = self.daemon_sessions.lock() {
            for (sid, sess) in map.iter() {
                if sess.repo_root != root {
                    continue;
                }
                out.push(LiveAgentSession {
                    session_id: sid.clone(),
                    agent_id: sess.agent_id.clone(),
                    repo_root: sess.repo_root.clone(),
                    last_byte_ms: *sess.last_byte_ms.lock().unwrap(),
                    title: None,
                });
            }
        }
        out.sort_by(|a, b| b.last_byte_ms.cmp(&a.last_byte_ms));
        out
    }
}

/// Holds one key's open gate for the length of a single `agent_pty_open`,
/// and prunes the registry entry on the way out. Written as a guard rather
/// than a pair of calls because `agent_pty_open` returns from a dozen places
/// — every `?` on a spawn failure is an exit that must still release.
struct OpenGate<'a> {
    registry: &'a AgentPtyRegistry,
    key: String,
    // Field order matters only for the lock, not the prune: `Drop::drop`
    // runs before fields drop, so the count check below sees this guard's
    // own reference. By then the caller has already published its session,
    // so a newcomer that mints a fresh gate finds the session and resumes.
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl<'a> OpenGate<'a> {
    async fn acquire(registry: &'a AgentPtyRegistry, key: &str) -> OpenGate<'a> {
        let gate = registry.open_gate(key);
        let guard = gate.lock_owned().await;
        OpenGate {
            registry,
            key: key.to_string(),
            _guard: guard,
        }
    }
}

impl Drop for OpenGate<'_> {
    fn drop(&mut self) {
        self.registry.release_open_gate(&self.key);
    }
}

/// The name a machine holds this agent's session under.
///
/// Derived from the same ingredients as the dedup key rather than from a fresh
/// id, because `tmux new -A` is what makes an agent on a box outlive its
/// connection: start the same agent on the same project again — after a reload,
/// after a flight, tomorrow, from another computer — and this name lands back
/// in the session still running there instead of starting a second one beside
/// it. A random name would leave the first one orphaned, still burning the
/// machine's time, invisible to the tab that started it.
fn tmux_nonce(agent_id: &str, resume: Option<&str>, force_new: bool, fresh: &str) -> String {
    let mut out = agent_id.to_string();
    // Resuming a different conversation is a different session, exactly as it
    // is in the key.
    if let Some(sid) = resume {
        out.push('-');
        out.push_str(&short(sid));
    }
    // And an explicit second Claude on one project is a second session, which
    // must not attach to the first one's tmux and type into its buffer.
    if force_new {
        out.push('-');
        out.push_str(&short(fresh));
    }
    out
}

/// Enough of an id to tell two sessions apart, short enough to read in a
/// `tmux ls`.
///
/// A digest of the WHOLE id rather than a slice of the front of it. Session ids
/// are not required to differ early — two claude conversations recorded in the
/// same run can share a leading field — and two ids that collided here would
/// name one tmux session, which means the second conversation opens into the
/// first one's screen and types into its buffer.
///
/// FNV-1a written out rather than `DefaultHasher` because this name has to be
/// the same string tomorrow, and after an upgrade: the standard hasher's
/// algorithm is explicitly not promised across Rust releases, so a bump would
/// silently orphan every session running on every machine.
fn short(id: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in id.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // Folded to 32 bits: eight hex characters, always a name tmux will take.
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

// ── tauri commands ──────────────────────────────────────────────────────

/// `resume_session_id`, when set and `agent_id == "claude"`, spawns the
/// REPL as `claude --resume <id>` so flipping from the bubble UI to the
/// terminal view continues the same conversation instead of starting fresh.
#[tauri::command]
pub async fn agent_pty_open(
    app: AppHandle,
    state: State<'_, AgentPtyRegistry>,
    agent_id: String,
    repo_root: String,
    cols: u16,
    rows: u16,
    resume_session_id: Option<String>,
    force_new: Option<bool>,
    // Optional named agent profile (~/.aura/agent-profiles/<name>/) to
    // swap as HOME for the child. When set, the spawned CLI sees a
    // fresh login state — `claude` logs into a different account,
    // `gemini` uses a different ~/.gemini/, etc. Independent of the
    // per-workspace binding (this is the "Isolated session…" picker
    // flow); if both this and a workspace binding name a profile,
    // the explicit arg wins.
    profile_name: Option<String>,
    // Cross-agent permission / autonomy mode for the interactive REPL —
    // mirrors the composer's Approvals chip (the same values the
    // non-interactive `agent_stream_send` path forwards). Maps onto each
    // CLI's real flag via `ApprovalPolicy` (claude `--permission-mode`,
    // gemini `--approval-mode`, codex sandbox) so a wrapped agent launched
    // on "Bypass" runs with full autonomy instead of stopping to ask the
    // user to run every command by hand. `None`/"default" → no flag, so the
    // spawn stays byte-identical to the pre-feature behaviour.
    permission_mode: Option<String>,
    // Per-turn model override for the interactive REPL — the same id the
    // composer/launch model picker holds (`claude-opus-4-8`, `gemini-3-pro`,
    // …). Mapped onto each CLI's real selector (`claude --model`, `gemini -m`,
    // `codex -c model=`) inside `build_invocation`. `None` → the CLI stays on
    // whatever model it's configured for (no flag added).
    model: Option<String>,
    // Cross-agent reasoning effort for the REPL — the launch composer's effort
    // chip. `None` → provider default (byte-identical to pre-feature). Mapped
    // to each CLI's real mechanism inside `build_invocation`.
    effort: Option<String>,
    // The place this agent's hands are: a connected machine's id, or `None` for
    // this laptop. A named machine runs the CLI over there — same flags, held
    // under tmux so it outlives the connection — while `repo_root` stays this
    // laptop's path, because that is the project the tab is filed under and
    // where the record of the work belongs whichever machine holds the code.
    machine_id: Option<String>,
) -> Result<AgentSessionHandle, String> {
    // Reclaim any history ring left behind by a session that vanished
    // without a clean close (open-failure rollback, etc.) so the map
    // can't accumulate dead 4 MiB rings across a long shell session.
    state.gc_orphan_history();

    // Resolve effective profile env up front so the dedup key can
    // include the agent profile name — same (agent, repo) under
    // profile=alice must not re-attach to profile=bob's session.
    let profile_env =
        crate::cmd_profiles::build_profile_env(&repo_root, profile_name.as_deref());
    // What this member holds for this project, on its way to the child's
    // environment and nowhere else. Read here, one call before the spawn, so the
    // values exist in this function and in the process that needs them — never
    // in the prompt, the invocation, or anything that is written down. See
    // `manager::brain::place_secrets`: a model cannot echo a secret it never saw.
    let brokered = crate::manager::brain::place_secrets::boot_here(&repo_root);
    let effective_profile = profile_env
        .iter()
        .find(|(k, _)| k == "AURA_AGENT_PROFILE")
        .map(|(_, v)| v.clone());
    // Key includes the resume id when present so resuming a *different*
    // session for the same (agent, root) pair doesn't re-attach the
    // previous one. Same idea for the profile slot.
    let base_key = match (&resume_session_id, &effective_profile) {
        (Some(sid), Some(p)) => format!("{agent_id}@{repo_root}#{sid}~{p}"),
        (Some(sid), None) => format!("{agent_id}@{repo_root}#{sid}"),
        (None, Some(p)) => format!("{agent_id}@{repo_root}~{p}"),
        (None, None) => format!("{agent_id}@{repo_root}"),
    };
    // The place is part of what a session IS, so it is part of the key. Same
    // agent, same project, one on the box and one here are two sessions with
    // two sets of hands; without this the second open would re-attach to the
    // first and the user would be typing into the wrong computer.
    let machine = machine_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let base_key = match &machine {
        Some(m) => format!("{base_key}@@{m}"),
        None => base_key,
    };
    let force_new = force_new.unwrap_or(false);
    // One nonce for both names below. The tmux session over there is named
    // deterministically from the same ingredients as the key, so re-opening the
    // same agent on the same project lands back in the session that is already
    // running — after an app restart, after losing wifi, tomorrow.
    let fresh = Uuid::new_v4().to_string();
    let key = if force_new {
        format!("{base_key}#{fresh}")
    } else {
        base_key
    };

    // Serialize opens on this key from here to the insert below. A
    // `force_new` key carries a fresh UUID and so can never collide, but it
    // still takes its gate — that costs one uncontended lock and keeps the
    // acquire/release pairing free of a special case.
    let _open_gate = OpenGate::acquire(state.inner(), &key).await;

    // Resume if there's a live session for this key.
    let existing = if force_new {
        None
    } else {
        state.by_key.lock().unwrap().get(&key).cloned()
    };
    if let Some(sid) = existing {
        // Only resume a daemon session whose subscribe loop is still
        // running. `daemon_session_live` purges the entry (and its by_key
        // mapping) when the loop has exited, so a key that pointed at a
        // dead daemon child falls through to a fresh spawn instead of
        // handing back a corpse the frontend would reattach to as a blank,
        // unresponsive terminal.
        let daemon = if daemon_session_live(&state, &sid) {
            let daemon_sessions = state.daemon_sessions.lock().unwrap();
            daemon_sessions.get(&sid).map(|s| {
                (
                    s.agent_id.clone(),
                    s.repo_root.clone(),
                    s.key.clone(),
                )
            })
        } else {
            None
        };
        if let Some((agent_id, repo_root, _key)) = daemon {
            return Ok(AgentSessionHandle {
                id: sid,
                agent_id,
                repo_root,
                resumed: true,
            });
        }
        // One lock, one lookup. Testing liveness under one guard and then
        // re-locking to read the fields left a window where another thread
        // — `agent_pty_close`, `kill_all`, or the daemon purge — removed
        // `sid`, and the second lookup's `.unwrap()` panicked inside a Tauri
        // command. Take everything needed while the guard is held.
        let live = {
            let sessions = state.sessions.lock().unwrap();
            sessions.get(&sid).and_then(|s| {
                let running = s.child.lock().unwrap().try_wait().ok().flatten().is_none();
                running.then(|| (s.agent_id.clone(), s.repo_root.clone()))
            })
        };
        if let Some((sess_agent_id, sess_repo_root)) = live {
            return Ok(AgentSessionHandle {
                id: sid.clone(),
                agent_id: sess_agent_id,
                repo_root: sess_repo_root,
                resumed: true,
            });
        }
        // Stale — purge before respawning.
        state.sessions.lock().unwrap().remove(&sid);
        state.by_key.lock().unwrap().remove(&key);
    }

    // Look up the provider in the agent registry. Adding a new agent
    // CLI lands as one new file in `aura-agents` plus a registry entry
    // — no patches to this dispatch site. `build_invocation(PtyRepl)`
    // returns bin + any args (e.g. claude's `--resume <sid>`).
    let reg = aura_agents::registry();
    let provider = reg
        .get(&agent_id)
        .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
    if !provider.capabilities().pty {
        return Err(format!("agent {agent_id} doesn't support PTY mode"));
    }
    // Composer Approvals chip → portable `ApprovalPolicy`. The provider turns
    // it into the right per-CLI flag inside `build_invocation` (and bakes it
    // into `inv.args`, so the daemon-hosted path inherits it too). "default"
    // and any unknown value map to `None` → no flag added.
    let approval = match permission_mode.as_deref() {
        Some("plan") => Some(aura_agents::ApprovalPolicy::Plan),
        Some("acceptEdits") => Some(aura_agents::ApprovalPolicy::AcceptEdits),
        Some("bypassPermissions") => Some(aura_agents::ApprovalPolicy::Bypass),
        _ => None,
    };
    // Launch composer effort chip → portable `ReasoningEffort`. Unknown /
    // unset → `None` (provider default), so the spawn stays byte-identical to
    // the pre-feature build.
    let effort = match effort.as_deref() {
        Some("low") => Some(aura_agents::ReasoningEffort::Low),
        Some("medium") => Some(aura_agents::ReasoningEffort::Medium),
        Some("high") => Some(aura_agents::ReasoningEffort::High),
        Some("max") => Some(aura_agents::ReasoningEffort::Max),
        _ => None,
    };
    let mut inv = provider
        .build_invocation(&aura_agents::InvokeRequest {
            prompt: "",
            mode: aura_agents::InvokeMode::PtyRepl,
            resume_session_id: resume_session_id.as_deref(),
            attachments_via_stdin: false,
            effort,
            fast: false,
            model: model.as_deref(),
            approval,
        })
        .map_err(|e| format!("build invocation for {agent_id}: {e}"))?;
    // Enforce the fleet agent-CLI config policy on the just-built invocation
    // (e.g. repair codex `service_tier` for this spawn). No-op for agents with
    // no rules or no wired channel.
    crate::agent_policy::apply_to_invocation(&agent_id, &mut inv);

    // Where this agent's hands are.
    //
    // A named machine is insisted upon rather than resolved. `Place::resolve`
    // degrades a machine it can no longer find to this laptop, which is the
    // right bargain for a conversation — better to keep answering than to end
    // the chat over a forgotten box — and the wrong one for a spawn: the user
    // asked for an agent over there, and quietly starting one here would set it
    // loose on this disk while the tab still says the machine's name.
    let place = match machine.as_deref() {
        Some(id) => Some(Place::at_machine(id)?),
        None => None,
    };

    // What to spawn. On this laptop that is the CLI and its argv, unchanged. On
    // a machine it is `ssh` and the argv that gets us there — the CLI, the same
    // flags, held under a named tmux session so the work outlives the
    // connection, built by the one place contract rather than a second ssh line
    // written here.
    let (bin, args) = match &place {
        None => (inv.bin.clone(), inv.args.clone()),
        Some(p) => {
            if profile_name.is_some() {
                // An isolated session is a HOME swap on this disk. Over there it
                // would silently do nothing and the agent would run as whoever
                // the box logs in as — a wrong account is not something to find
                // out from a commit.
                return Err(format!(
                    "An isolated session swaps the login on this laptop, so it can't be applied to {}. \
                     That machine signs in as itself — start the agent on it without a profile, or start this one here.",
                    p.label()
                ));
            }
            let shell = p.open(&Open::Agent {
                bin: inv.bin.clone(),
                args: inv.args.clone(),
                // The opening message is typed into the pty afterwards by
                // `agent_pty_send_prompt`, exactly as it is locally. What the
                // place decides is how the CLI is started, not how it's spoken
                // to.
                prompt: None,
                session: Some(crate::cloudbox::script::session_name(
                    "agent",
                    &repo_root,
                    &tmux_nonce(&agent_id, resume_session_id.as_deref(), force_new, &fresh),
                )),
            })?;
            (shell.program, shell.args)
        }
    };

    // Starting an agent is the product's core action, and until now nothing
    // counted it — so "does anyone actually use this?" had no answer. Fires
    // once the invocation is built and before either spawn path, so a real
    // start is counted exactly once whichever path serves it, and a failed
    // build isn't counted at all. Agent id and the two flags only; no repo,
    // no path, no prompt.
    let resumed = resume_session_id.is_some();
    crate::telemetry::track(
        "agent_started",
        Some(serde_json::json!({
            "agent": agent_id.as_str(),
            "resumed": resumed,
            "isolated_profile": effective_profile.is_some(),
        })),
    );
    crate::telemetry::track_activation("agent_started");

    // T3.1 opt-in path: when AURA_USE_PTY_DAEMON=1, the PTY child
    // lives in the long-running aura-pty-daemon process (so it
    // survives shell crash/reload). Spawn there + register in
    // daemon_sessions; bytes/exit are pumped into the same
    // `agent-pty:<id>` / `agent-pty-exit:<id>` channels the
    // in-process path uses, so the renderer is none the wiser.
    if crate::pty_daemon::client::enabled() {
        // Merge profile env into the daemon's env_extras list so the
        // daemon's CommandBuilder picks up HOME + GIT_AUTHOR_* the same
        // way the in-process path does below.
        //
        // A remote spawn takes none of it: the child here is `ssh`, and an
        // environment set on this side of the wire is not the agent's — it
        // reaches the box only if that box's sshd was configured to accept it,
        // which is not something to quietly rely on. The agent over there runs
        // under the machine's own login and its own config, and a HOME pointing
        // at a directory on this laptop would be a path that doesn't exist.
        // The member's brokered secrets are held back for the same reason and a
        // sharper one: `boot_here` read them out of THIS laptop's vault, and
        // pushing a secret into an ssh process that will not carry it is spend
        // with no delivery. A place's own secrets reach it through the place.
        //
        // The one variable that does cross is `TERM`: ssh carries it to the far
        // side, and without it the agent over there degrades to plain output and
        // no line editing.
        let env_extras = if place.is_some() {
            vec![("TERM".to_string(), "xterm-256color".to_string())]
        } else {
            let mut env = inv.env.clone();
            // Same order as the in-process path below: the member's brokered
            // secrets, then the profile, which has the last word on HOME.
            for (k, v) in brokered.pairs().iter().cloned() {
                env.push((k, v));
            }
            for (k, v) in profile_env.iter().cloned() {
                env.push((k, v));
            }
            env
        };
        return open_via_daemon(
            &app,
            state,
            agent_id,
            repo_root,
            cols,
            rows,
            key,
            bin,
            args,
            env_extras,
        )
        .await;
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Pre-generate session id so we can thread it as
    // AURA_MANAGER_SESSION_ID into the spawned agent's env. That env is
    // what `aura subagent spawn` reads to record fan-out into a session
    // JSON — so a user running claude PTY directly (no Manager UI tab)
    // still gets every subagent dispatch they trigger captured to
    // `~/.aura/manager-sessions/<id>.json`. Lazy-creates on first
    // record_dispatch — no JSON written if the user never fans out.
    let id = Uuid::new_v4().to_string();

    let mut cmd = CommandBuilder::new(&bin);
    // Route through `safe_spawn_dir` like the streaming (`cmd_agent_stream`)
    // and daemon (`pty_daemon::server`) spawn paths — this in-process path was
    // the only one passing the root raw, so an empty/invalid `repo_root` here
    // made the child INHERIT the app's launch cwd (Aura's own tree in dev)
    // instead of landing in an inert place.
    //
    // On a remote spawn the child here is `ssh`, so this is where the *dial*
    // runs, not where the agent does — the box's directory is already inside
    // the command the place built. This laptop's project is still the right
    // place to dial from: it is where the key path and the ssh config that
    // reach that machine are written.
    cmd.cwd(crate::spawn_dir::safe_spawn_dir(&repo_root));
    // Without TERM most CLIs degrade to plain output and disable line
    // editing. Match what cmd_pty.rs sends to the regular shell.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("AURA_MANAGER_SESSION_ID", &id);
    cmd.env("AURA_REPO_ROOT", &repo_root);
    cmd.env("AURA_AGENT_ID", &agent_id);
    // Pin the session to THIS shell's socket. Without it `aura ask-user`
    // falls back to the well-known path, which belongs to whichever
    // shell bound it first — so on a machine running two (the installed
    // app beside a dev build) a question could be posed to the wrong
    // window, or to a socket file with nobody behind it.
    cmd.env(
        "AURA_SHELL_SOCKET",
        crate::cmd_permission_socket::socket_path()
            .to_string_lossy()
            .as_ref(),
    );
    // Negotiate the OSC 777 cli-agent protocol with the agent's plugin
    // scripts (aura-claude / aura-gemini / …). The plugin no-ops when
    // these env vars are missing, so non-Aura terminals never see the
    // sequences. Bumping the version here without bumping the bash side
    // is fine — the plugin uses min(plugin_v, aura_v).
    cmd.env(
        "AURA_CLI_AGENT_PROTOCOL_VERSION",
        AURA_CLI_AGENT_PROTOCOL_VERSION.to_string(),
    );
    cmd.env("AURA_CLIENT_VERSION", env!("CARGO_PKG_VERSION"));
    // Point Claude Code at THIS Aura as its editor. Naming the port does two
    // things at once: it turns auto-connect on, and it tells the CLI to trust
    // that specific lock file without first proving Aura is one of its parent
    // processes. Both matter here — an agent Aura launched is not always a
    // child of the window it belongs to, and the tab it runs in may be
    // pointed at a directory that isn't the lock file's workspace.
    if let Some(bridge) = app.try_state::<std::sync::Arc<crate::ide_bridge::IdeBridgeState>>() {
        if let Some(running) = bridge.running() {
            cmd.env("CLAUDE_CODE_SSE_PORT", running.port.to_string());
        }
    }
    // Backup-channel URL for the agent's hook scripts (T2.3). The
    // listener binds on a random loopback port at startup and stashes
    // its base URL on managed state; we look it up here and inject
    // `AURA_HOOK_NOTIFY_URL=http://127.0.0.1:<port>/agent-event/<sid>`
    // so aura-notify.sh can `curl` events to us in addition to writing
    // OSC 777 to /dev/tty. Catches the case where the OSC parser
    // missed a sequence under bursty output, and is the ONLY channel
    // when the user runs the agent in their own terminal outside Aura.
    if let Some(state) =
        app.try_state::<std::sync::Arc<crate::agent_event_listener::AgentEventListenerState>>()
    {
        if let Some(url) = state.url_for_session(&id) {
            cmd.env("AURA_HOOK_NOTIFY_URL", url);
        }
    }
    for arg in &args {
        cmd.arg(arg);
    }
    eprintln!(
        "[agent_pty_open] spawning {} {:?} (repo={}, place={}, resume_session_id={:?})",
        bin,
        args,
        repo_root,
        place.as_ref().map(Place::label).unwrap_or("this laptop"),
        resume_session_id,
    );

    // The rest of the spawn wires the child into THIS laptop: a config file at
    // a path on this disk, hook scripts stamped into this checkout, the version
    // of the binary sitting here, an environment this process owns.
    //
    // None of it describes a process on a machine. The paths don't exist over
    // there, the binary whose version we'd be recording is `ssh`, and the
    // environment doesn't cross the wire. A box brings its own Aura wiring or
    // hasn't got any yet — what we must not do is stamp this laptop's and let
    // the tab imply the agent over there has tools it can't reach.
    if place.is_none() {
        // Pin the agent CLI version (T3.2). Records `<bin> --version` on
        // first spawn into ~/.aura/agent-versions.json; on subsequent
        // spawns, mismatch fires `agent-version-changed` so the UI can
        // surface a banner — our hook scripts are version-tied to a
        // specific claude/gemini surface and a breaking bump silently
        // breaks the OSC 777 channel otherwise. Best-effort, never fatal.
        if let Some(store) = app.try_state::<crate::cmd_agent_versions::AgentVersionStore>() {
            store.record_and_check(&app, &agent_id, &bin);
        }

        let wiring_agent = agent_id.clone();
        let wiring_root = repo_root.clone();
        let mcp_config = crate::blocking::run(move || {
            if wiring_agent == "claude" {
                let config = ensure_aura_mcp_config();
                // Stamp the per-repo `.claude/settings.local.json` so claude
                // wires our six hook scripts (SessionStart/Stop/Notification/
                // PermissionRequest/UserPromptSubmit/PostToolUse) on its own.
                // Idempotent — re-staging overwrites the script bodies but the
                // settings merge de-dupes hook entries by exact path match.
                let _ = ensure_aura_claude_hooks_stamped(&wiring_root);
                config
            } else if wiring_agent == "gemini" {
                // Gemini uses its own extension system (not settings hooks);
                // staging into ~/.gemini/extensions/aura-gemini/ is enough for
                // the CLI to auto-load the extension at startup.
                let _ = ensure_aura_gemini_extension_stamped();
                None
            } else {
                None
            }
        })
        .await;
        // Inject the aura MCP server config for claude PTY tabs so the user
        // gets all 50+ aura tools (`aura_log_intent`, `aura_snapshot`,
        // `aura_pr_review`, `aura_prove`, `aura_rewind`, …) in claude's tool
        // palette by default — without us touching their global ~/.claude.json
        // or their repo's .mcp.json. Passed as a non-strict --mcp-config so
        // the user's existing servers still load. Only claude supports this
        // flag today; gemini / codex / cursor route MCP differently and are
        // skipped here (they pick up aura tools via their own config paths if
        // the user has wired them).
        if agent_id == "claude" {
            if let Some(cfg_path) = mcp_config {
                cmd.arg("--mcp-config");
                cmd.arg(cfg_path);
            }
        }
        for (k, v) in &inv.env {
            cmd.env(k, v);
        }
        // Profile env (HOME swap + GIT_AUTHOR_*/COMMITTER_*) goes last so it
        // overrides anything inherited from the shell or set above.
        for (k, v) in &profile_env {
            cmd.env(k, v);
        }
    }
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    // The member's brokered secrets. This is the only place their values are
    // spent: onto the child, before it starts. Nothing above this line has seen
    // one and nothing below it keeps one.
    for (k, v) in brokered.pairs() {
        cmd.env(k, v);
    }
    // Profile env (HOME swap + GIT_AUTHOR_*/COMMITTER_*) goes last so it
    // overrides anything inherited from the shell or set above.
    for (k, v) in &profile_env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let pty_event = format!("agent-pty:{id}");
    let block_event = format!("agent-block:{id}");
    let exit_event = format!("agent-pty-exit:{id}");

    let session = AgentPtySession {
        writer: crate::pty_io::shared_writer(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        blocks: Mutex::new(Vec::new()),
        // Same dimensions the child was handed, so the shadow terminal wraps
        // where the real one wraps and a repaint lands on the cell the agent
        // aimed at.
        grid: Mutex::new(aura_term_core::GridTerminal::with_size(cols, rows)),
        grid_lines: Mutex::new(Vec::new()),
        block_lines: Mutex::new(0),
        raw_bytes: Mutex::new(Vec::with_capacity(BYTE_REPLAY_CAP)),
        current_block_id: Mutex::new(None),
        agent_id: agent_id.clone(),
        repo_root: repo_root.clone(),
        key: key.clone(),
        last_append_ms: Mutex::new(None),
        last_attention_ms: Mutex::new(None),
        last_notify_ms: Mutex::new(None),
        // Seed with spawn time — the welcome screen usually lands
        // within the first second, but if a network-mode agent stalls
        // on its API handshake the idle clock should already be
        // counting against it.
        last_byte_ms: Mutex::new(now_ms()),
        last_title: Mutex::new(None),
    };
    state.sessions.lock().unwrap().insert(id.clone(), session);
    state.by_key.lock().unwrap().insert(key, id.clone());

    // Sync portable-pty reader → mpsc → tokio task. Same shape cmd_pty
    // uses; the extra work this task does is the vte parse pass.
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
    let app_for_thread = app.clone();
    let exit_event_for_thread = exit_event.clone();
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
        let _ = app_for_thread.emit(&exit_event_for_thread, ());
    });

    let app_for_emit = app.clone();
    let id_for_task = id.clone();
    let agent_id_for_task = agent_id.clone();
    tauri::async_runtime::spawn(async move {
        // Single Parser per session — vte holds state across chunks for
        // OSC sequences that span reads.
        let mut parser = Parser::new();
        // Idle timeout: if the read channel stays silent for IDLE_MS
        // and we still have an open Output block whose last append was
        // older than IDLE_MS, synthesize a clean close. Mirrors what
        // OSC 133 ;D would do — but agents that don't speak the
        // standard (claude/gemini/codex/cursor) get the same UX.
        const IDLE_MS: u64 = 2_500;
        loop {
            let recv = tokio::time::timeout(
                std::time::Duration::from_millis(IDLE_MS),
                rx.recv(),
            )
            .await;
            let bytes = match recv {
                Ok(Some(b)) => b,
                Ok(None) => break, // channel closed → child died
                Err(_) => {
                    // Idle tick — try to close a stale Output block.
                    maybe_close_idle_output(
                        &app_for_emit,
                        &id_for_task,
                        &agent_id_for_task,
                        &block_event,
                        IDLE_MS,
                    );
                    continue;
                }
            };
            // Forward raw bytes to xterm verbatim — the Terminal view
            // wants a faithful render of every escape code.
            let _ = app_for_emit.emit(&pty_event, bytes.clone());

            // Attention detector: agent CLIs emit BEL (`\x07`) when they
            // need the user's eyes — claude-code on permission prompts,
            // gemini on tool approval, codex on stop. We don't fire on
            // every BEL (some TUIs ding on every keystroke); per-session
            // throttle keeps the tab dot + OS toast sane.
            if bytes.contains(&0x07) {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let registry = app_for_emit.state::<AgentPtyRegistry>();
                let mut should_emit = false;
                let mut should_notify = false;
                let mut attention_repo_root = None;
                if let Some(sess) = registry.sessions.lock().unwrap().get(&id_for_task) {
                    attention_repo_root = Some(sess.repo_root.clone());
                    let mut last_att = sess.last_attention_ms.lock().unwrap();
                    // saturating_sub: `now` falls back to 0 when SystemTime
                    // fails, and a clock step can leave `t > now` — a raw
                    // `now - t` would underflow (panic in debug, wrap to a
                    // huge value in release, suppressing the next ding).
                    if last_att.map(|t| now.saturating_sub(t) > 3_000).unwrap_or(true) {
                        *last_att = Some(now);
                        should_emit = true;
                    }
                    let mut last_notif = sess.last_notify_ms.lock().unwrap();
                    if last_notif.map(|t| now.saturating_sub(t) > 15_000).unwrap_or(true) {
                        *last_notif = Some(now);
                        should_notify = true;
                    }
                }
                if should_emit {
                    let _ = app_for_emit.emit(
                        "agent-attention",
                        serde_json::json!({
                            "session_id": id_for_task,
                            "agent_id": agent_id_for_task,
                            "repo_root": attention_repo_root,
                        }),
                    );
                }
                if should_notify {
                    let title = format!("{} needs your input", agent_id_for_task);
                    let _ = app_for_emit
                        .notification()
                        .builder()
                        .title(title)
                        .body("Aura — click the tab to respond")
                        .show();
                }
            }

            let registry = app_for_emit.state::<AgentPtyRegistry>();
            // Tee into the registry-level history map so phone clients
            // can replay this output via `agent_pty_history` regardless
            // of whether the session is in-process or daemon-backed.
            {
                let mut all = registry.history.lock().unwrap();
                let buf = all.entry(id_for_task.clone()).or_default();
                buf.extend(bytes.iter().copied());
                while buf.len() > PTY_HISTORY_CAP {
                    buf.pop_front();
                }
            }
            let sessions_guard = registry.sessions.lock().unwrap();
            let Some(sess) = sessions_guard.get(&id_for_task) else {
                continue;
            };
            // Keep a tail of recent bytes so a late-mounting xterm can
            // replay the agent's welcome screen. Drop oldest bytes once
            // we exceed the cap — the welcome screen redraws on resize
            // anyway, this is just enough to bridge the spawn→listen race.
            {
                let mut buf = sess.raw_bytes.lock().unwrap();
                buf.extend_from_slice(&bytes);
                if buf.len() > BYTE_REPLAY_CAP {
                    let drop_n = buf.len() - BYTE_REPLAY_CAP;
                    buf.drain(..drop_n);
                }
            }
            // Mark the session as having received bytes right now —
            // the idle watchdog (agent_pty_idle_status) compares this
            // against the wall clock to surface a "Stale · Reconnect"
            // chip when the agent goes silent for ≥45s while alive.
            *sess.last_byte_ms.lock().unwrap() = now_ms();
            let cur_id = sess.current_block_id.lock().unwrap().clone();

            // Feed the shadow terminal before anything reads a block's text.
            // It is the only thing here that sees the bytes as a *screen*
            // rather than as a stream, and every repaint the agent performs
            // has to have landed before we ask what the screen says.
            sess.grid.lock().unwrap().apply_output(&bytes);

            let mut perf = OscPerf::default();
            for b in &bytes {
                parser.advance(&mut perf, *b);
            }

            // OSC 133;A — agent-emitted prompt-start. Close any open
            // Output as Exit (no exit code), then open a fresh Prompt
            // block. The text the agent prints between ;A and ;B is
            // its own prompt redraw, which we accept into the Prompt
            // block.
            if perf.osc133_prompt_start {
                if let Some(bid) = &cur_id {
                    let mut blocks = sess.blocks.lock().unwrap();
                    if let Some(b) = blocks.iter_mut().find(|b| &b.id == bid) {
                        b.kind = BlockKind::Exit;
                        b.finished_at = Some(now_ms());
                        let snap = b.clone();
                        drop(blocks);
                        let _ = app_for_emit
                            .emit(&block_event, BlockUpdate::Close { block: snap });
                    }
                }
                let now = now_ms();
                let pid = Uuid::new_v4().to_string();
                let prompt_block = BlockEnvelope {
                    id: pid.clone(),
                    kind: BlockKind::Prompt,
                    session_id: id_for_task.clone(),
                    agent_id: sess.agent_id.clone(),
                    started_at: now,
                    finished_at: None,
                    text: String::new(),
                    exit_code: None,
                };
                sess.blocks.lock().unwrap().push(prompt_block.clone());
                *sess.current_block_id.lock().unwrap() = Some(pid);
                // A fresh block owns none of the transcript yet, so nothing a
                // repaint does can reach into what came before it.
                *sess.block_lines.lock().unwrap() = 0;
                *sess.last_append_ms.lock().unwrap() = Some(now);
                let _ = app_for_emit.emit(
                    &block_event,
                    BlockUpdate::Open {
                        block: prompt_block,
                    },
                );
            }

            // Refresh cur_id since ;A may have rotated it.
            let cur_id = sess.current_block_id.lock().unwrap().clone();

            // Stream what the screen now says into the open Output (or
            // Prompt, when ;A has just opened one) block.
            //
            // Read off the shadow terminal rather than off the byte stream.
            // The two disagree exactly where it matters: a spinner, a
            // progress bar or a status footer is drawn by painting over a
            // line that is already there, and the byte stream carries every
            // frame while the screen carries only the last one.
            let next_lines = sess.grid.lock().unwrap().transcript_lines();
            let delta = {
                let mut mirror = sess.grid_lines.lock().unwrap();
                let d = transcript_delta(&mirror, &next_lines);
                let prev_len = mirror.len();
                *mirror = next_lines;
                (d, prev_len)
            };
            let (delta, prev_len) = delta;
            if !delta.added.is_empty() || delta.rewrote > 0 {
                if let Some(bid) = &cur_id {
                    let mut owned = sess.block_lines.lock().unwrap();
                    // Eviction takes lines off the *top* of the transcript,
                    // which belong to the oldest blocks first. Only what it
                    // ate past those is this block's loss.
                    let older = prev_len.saturating_sub(*owned);
                    *owned = owned.saturating_sub(delta.evicted.saturating_sub(older));
                    // A repaint may rewrite this block's own tail; it may not
                    // reach back into a block that has already been closed and
                    // read. Clamping here is what keeps a full-screen redraw
                    // from rewriting the answer to the previous question.
                    let drop_lines = delta.rewrote.min(*owned);
                    *owned = *owned - drop_lines + delta.added.len();
                    drop(owned);

                    let mut blocks = sess.blocks.lock().unwrap();
                    if let Some(b) = blocks.iter_mut().find(|b| &b.id == bid) {
                        reframe_text(&mut b.text, drop_lines, &delta.added);
                        // Cap per-block retained text. Replay sends the
                        // full block list to a remounting frontend, so
                        // a single long run could otherwise serialize
                        // hundreds of MB through Tauri's IPC. When we
                        // overflow, drop the head and prepend a marker
                        // so the user can see we trimmed.
                        const BLOCK_TEXT_CAP: usize = 256 * 1024;
                        if b.text.len() > BLOCK_TEXT_CAP {
                            let keep = BLOCK_TEXT_CAP / 2;
                            // Step back to a UTF-8 char boundary so we
                            // never slice mid-codepoint.
                            let mut start = b.text.len() - keep;
                            while start < b.text.len() && !b.text.is_char_boundary(start) {
                                start += 1;
                            }
                            let tail = b.text[start..].to_string();
                            b.text.clear();
                            b.text.push_str("[…earlier output trimmed…]\n");
                            b.text.push_str(&tail);
                        }
                    }
                    drop(blocks);
                    *sess.last_append_ms.lock().unwrap() = Some(now_ms());
                    let _ = app_for_emit.emit(
                        &block_event,
                        BlockUpdate::Reframe {
                            block_id: bid.clone(),
                            drop_lines,
                            lines: delta.added,
                        },
                    );
                }
            }

            // OSC 133;B — prompt-end / output-start. Close the open
            // Prompt (if any), then open a fresh Output block.
            if perf.osc133_output_start {
                if let Some(bid) = &cur_id {
                    let mut blocks = sess.blocks.lock().unwrap();
                    if let Some(b) = blocks.iter_mut().find(|b| &b.id == bid) {
                        b.finished_at = Some(now_ms());
                        let snap = b.clone();
                        drop(blocks);
                        let _ = app_for_emit
                            .emit(&block_event, BlockUpdate::Close { block: snap });
                    }
                }
                let now = now_ms();
                let oid = Uuid::new_v4().to_string();
                let output_block = BlockEnvelope {
                    id: oid.clone(),
                    kind: BlockKind::Output,
                    session_id: id_for_task.clone(),
                    agent_id: sess.agent_id.clone(),
                    started_at: now,
                    finished_at: None,
                    text: String::new(),
                    exit_code: None,
                };
                sess.blocks.lock().unwrap().push(output_block.clone());
                *sess.current_block_id.lock().unwrap() = Some(oid);
                *sess.block_lines.lock().unwrap() = 0;
                *sess.last_append_ms.lock().unwrap() = Some(now);
                let _ = app_for_emit.emit(
                    &block_event,
                    BlockUpdate::Open {
                        block: output_block,
                    },
                );
            }

            // Refresh cur_id again — ;B may have rotated it.
            let cur_id = sess.current_block_id.lock().unwrap().clone();

            // OSC 777 cli-agent events — emit each parsed event with
            // the Aura PTY session id so the renderer can route them
            // to the right tab. The frontend stores them in the agent
            // session state machine (Blocked / InProgress / Success).
            if !perf.cli_agent_events.is_empty() {
                let event_channel = format!("agent-event:{id_for_task}");
                for ev in perf.cli_agent_events.drain(..) {
                    let env = CliAgentEventEnvelope {
                        session_id: id_for_task.clone(),
                        event: ev,
                    };
                    let _ = app_for_emit.emit(&event_channel, env);
                }
            }

            // Native window title (OSC 0 / OSC 2) — the agent's own
            // "what I'm doing now" string, à la Warp's auto-titled rows.
            // Stash the latest on the session for replay to a
            // late-mounting frontend, then emit the delta. Skip no-op
            // repeats so we don't spam identical titles every chunk.
            if let Some(title) = perf.osc_title.take() {
                let changed = {
                    let mut last = sess.last_title.lock().unwrap();
                    if last.as_deref() == Some(title.as_str()) {
                        false
                    } else {
                        *last = Some(title.clone());
                        true
                    }
                };
                if changed {
                    let _ = app_for_emit.emit(
                        &format!("agent-title:{id_for_task}"),
                        serde_json::json!({
                            "session_id": id_for_task,
                            "title": title,
                        }),
                    );
                }
            }

            // OSC 133;D — agent-emitted exit. Close the Output as Exit.
            if let Some(exit) = perf.osc133_exit {
                if let Some(bid) = cur_id {
                    let mut blocks = sess.blocks.lock().unwrap();
                    if let Some(b) = blocks.iter_mut().find(|b| b.id == bid) {
                        b.kind = BlockKind::Exit;
                        b.exit_code = Some(exit);
                        b.finished_at = Some(now_ms());
                        let snap = b.clone();
                        drop(blocks);
                        let _ = app_for_emit
                            .emit(&block_event, BlockUpdate::Close { block: snap });
                    }
                    *sess.current_block_id.lock().unwrap() = None;
                    *sess.block_lines.lock().unwrap() = 0;
                }
            }
        }
    });

    Ok(AgentSessionHandle {
        id,
        agent_id,
        repo_root,
        resumed: false,
    })
}

/// List live coding-agent PTY sessions in `repo_root`, most-recently
/// active first. Powers the "Start in agent → hand to a running
/// session" submenu so a task can be routed into an ongoing Claude
/// Code / Gemini / Codex session via `agent_pty_send_prompt` instead of
/// always spawning a fresh PTY.
#[tauri::command]
pub async fn agent_pty_list(
    state: State<'_, AgentPtyRegistry>,
    repo_root: String,
) -> Result<Vec<LiveAgentSession>, String> {
    Ok(state.list_in(&repo_root))
}

#[tauri::command]
pub async fn agent_pty_send_prompt(
    app: AppHandle,
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
    prompt: String,
) -> Result<(), String> {
    // Daemon-backed session: skip block synthesis (state lives in
    // AgentPtySession, which doesn't exist for daemon-backed
    // sessions) and just push the bracketed-paste bytes through the
    // daemon. The Terminal view still renders correctly because the
    // subscribe loop pumps daemon bytes to the same `agent-pty:<sid>`
    // channel; the "ui" / blocks view is empty in daemon mode for v1.
    let is_daemon = state
        .daemon_sessions
        .lock()
        .unwrap()
        .contains_key(&session_id);
    if is_daemon {
        let bytes = bracketed_prompt_bytes(&prompt);
        return crate::pty_daemon::client::write_session(&session_id, &bytes)
            .await
            .map_err(|e| e.to_string());
    }
    let block_event = format!("agent-block:{session_id}");

    // Synthesize the blocks under the registry lock, then hand back just
    // the writer handle so the lock is released before the PTY write
    // below. That write can park for as long as the agent takes to read
    // its input, and no other terminal may wait on the map for that.
    let writer = {
        let sessions = state.sessions.lock().unwrap();
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;

        // Close any currently-open Output block so the UI never shows two
        // open answers stacked. Exit code unknown — leave `exit_code: None`
        // so the UI can render "ended" rather than "exit 0".
        {
            let mut cur = sess.current_block_id.lock().unwrap();
            if let Some(bid) = cur.take() {
                let mut blocks = sess.blocks.lock().unwrap();
                if let Some(b) = blocks.iter_mut().find(|b| b.id == bid) {
                    b.finished_at = Some(now_ms());
                    let snap = b.clone();
                    drop(blocks);
                    let _ = app.emit(&block_event, BlockUpdate::Close { block: snap });
                }
            }
        }

        // Synthetic Prompt block: opens and closes immediately because the
        // user already typed the whole thing — there's no streaming half.
        let now = now_ms();
        let prompt_block = BlockEnvelope {
            id: Uuid::new_v4().to_string(),
            kind: BlockKind::Prompt,
            session_id: session_id.clone(),
            agent_id: sess.agent_id.clone(),
            started_at: now,
            finished_at: Some(now),
            text: prompt.clone(),
            exit_code: None,
        };
        sess.blocks.lock().unwrap().push(prompt_block.clone());
        let _ = app.emit(
            &block_event,
            BlockUpdate::Open {
                block: prompt_block.clone(),
            },
        );
        let _ = app.emit(
            &block_event,
            BlockUpdate::Close {
                block: prompt_block,
            },
        );

        // Open the Output block; the read loop fills it as the agent replies.
        let output_block = BlockEnvelope {
            id: Uuid::new_v4().to_string(),
            kind: BlockKind::Output,
            session_id: session_id.clone(),
            agent_id: sess.agent_id.clone(),
            started_at: now,
            finished_at: None,
            text: String::new(),
            exit_code: None,
        };
        sess.blocks.lock().unwrap().push(output_block.clone());
        *sess.current_block_id.lock().unwrap() = Some(output_block.id.clone());
        *sess.block_lines.lock().unwrap() = 0;
        let _ = app.emit(
            &block_event,
            BlockUpdate::Open {
                block: output_block,
            },
        );
        sess.writer.clone()
    };

    // Push the prompt into the PTY using bracketed-paste semantics
    // (DEC mode 2004). All four agent CLIs we ship — claude, gemini,
    // codex, cursor-agent — are full TUIs that handle the
    // `ESC[200~ … ESC[201~` envelope correctly: no readline expansion,
    // no history pollution, no truncation at the line discipline's
    // ~4KB cooked-mode buffer. This is the same trick Warp / Superset
    // use to inject prompts safely into hosted REPLs.
    //
    // Chunked at 4KB to play nice with line-discipline buffers; the
    // PTY reader on the child side coalesces these back into one paste
    // event because of the wrapping markers.
    write_prompt_bracketed(&writer, &prompt)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Daemon-backed analogue of agent_pty_open's tail. Calls the
/// pty_daemon client to spawn a session in the daemon process,
/// registers it in `daemon_sessions`, and starts a tokio task that
/// holds the subscribe stream open and forwards each `Event::Bytes`
/// as an `agent-pty:<id>` Tauri event (matching what the in-process
/// path emits).
#[allow(clippy::too_many_arguments)]
async fn open_via_daemon(
    app: &AppHandle,
    state: State<'_, AgentPtyRegistry>,
    agent_id: String,
    repo_root: String,
    cols: u16,
    rows: u16,
    key: String,
    bin: String,
    args: Vec<String>,
    env_extras: Vec<(String, String)>,
) -> Result<AgentSessionHandle, String> {
    // The daemon doesn't see Tauri-managed state, so the vars that come
    // from it get assembled here and passed across the wire; the daemon's
    // open_session forwards them to portable-pty verbatim. Everything
    // *ambient* — PATH, HOME, the keys a login shell exports — is layered
    // in underneath by `client::open_session`, because the daemon's own
    // environment is launchd's and is stale by construction. Between the
    // two the daemon child sees what the in-process child below sees.
    let mut env: Vec<(String, String)> = Vec::with_capacity(8 + env_extras.len());
    let session_id_pre = Uuid::new_v4().to_string();
    env.push(("AURA_MANAGER_SESSION_ID".into(), session_id_pre.clone()));
    env.push(("AURA_REPO_ROOT".into(), repo_root.clone()));
    env.push(("AURA_AGENT_ID".into(), agent_id.clone()));
    env.push((
        "AURA_CLI_AGENT_PROTOCOL_VERSION".into(),
        AURA_CLI_AGENT_PROTOCOL_VERSION.to_string(),
    ));
    env.push(("AURA_CLIENT_VERSION".into(), env!("CARGO_PKG_VERSION").into()));
    // Editor control plane, same as the in-process path. The daemon child
    // reaches the socket over loopback, so a daemon-backed agent gets tab
    // control on equal terms with one Aura spawned itself.
    if let Some(bridge) = app.try_state::<std::sync::Arc<crate::ide_bridge::IdeBridgeState>>() {
        if let Some(running) = bridge.running() {
            env.push(("CLAUDE_CODE_SSE_PORT".into(), running.port.to_string()));
        }
    }
    // Same reason as the in-process path: the daemon is a separate
    // process and would otherwise resolve the well-known socket, which
    // may belong to a different shell entirely.
    env.push((
        "AURA_SHELL_SOCKET".into(),
        crate::cmd_permission_socket::socket_path()
            .to_string_lossy()
            .into_owned(),
    ));
    if let Some(listener) = app
        .try_state::<std::sync::Arc<crate::agent_event_listener::AgentEventListenerState>>()
    {
        if let Some(url) = listener.url_for_session(&session_id_pre) {
            env.push(("AURA_HOOK_NOTIFY_URL".into(), url));
        }
    }
    for (k, v) in env_extras {
        env.push((k, v));
    }

    let session_id = crate::pty_daemon::client::open_session(
        crate::pty_daemon::proto::OpenReq {
            agent_id: agent_id.clone(),
            repo_root: repo_root.clone(),
            bin,
            args,
            env,
            cols,
            rows,
            kind: crate::pty_daemon::proto::SessionKind::Agent,
            label: None,
            cwd: None,
        },
    )
    .await
    .map_err(|e| format!("daemon open_session: {e}"))?;

    // Subscribe loop — each Bytes event re-emits as `agent-pty:<sid>`,
    // Exit as `agent-pty-exit:<sid>`. Lives until the session exits
    // or the abort signal fires from close().
    let app_for_loop = app.clone();
    let sid_for_loop = session_id.clone();
    let pty_event = format!("agent-pty:{session_id}");
    let exit_event = format!("agent-pty-exit:{session_id}");
    let history_for_loop = state.history.clone();
    let sid_for_history = session_id.clone();
    // Shared with the DaemonSession entry below so the loop bumps the
    // same counter the idle-status command reads. Seeded with the
    // spawn time so a daemon child that wedges before printing its
    // welcome screen still trips the watchdog.
    let last_byte_ms = Arc::new(Mutex::new(now_ms()));
    let last_byte_for_loop = last_byte_ms.clone();
    let handle = tokio::spawn(async move {
        let mut sub = match crate::pty_daemon::client::subscribe(&sid_for_loop).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[daemon] subscribe failed: {e}");
                // Mirror the recv-error branch below: surface the failure so
                // the frontend swaps in the Restart card. Without this the
                // session stays registered (idle-status reports alive), so
                // the stale watchdog wouldn't trip for 45s — leaving a blank
                // terminal with no signal for a failure that won't recover.
                let _ = app_for_loop.emit(&exit_event, ());
                return;
            }
        };
        loop {
            match crate::pty_daemon::client::recv_event(&mut sub).await {
                Ok(crate::pty_daemon::proto::Event::Bytes { data, .. }) => {
                    // Tee into the per-session ring buffer so a phone
                    // joining mid-session can replay this output.
                    {
                        let mut all = history_for_loop.lock().unwrap();
                        let buf = all.entry(sid_for_history.clone()).or_default();
                        buf.extend(data.iter().copied());
                        while buf.len() > PTY_HISTORY_CAP {
                            buf.pop_front();
                        }
                    }
                    *last_byte_for_loop.lock().unwrap() = now_ms();
                    let _ = app_for_loop.emit(&pty_event, data);
                }
                Ok(crate::pty_daemon::proto::Event::Exit { .. }) => {
                    let _ = app_for_loop.emit(&exit_event, ());
                    break;
                }
                Err(e) => {
                    eprintln!("[daemon] subscribe recv: {e}");
                    let _ = app_for_loop.emit(&exit_event, ());
                    break;
                }
            }
        }
    });

    state.daemon_sessions.lock().unwrap().insert(
        session_id.clone(),
        DaemonSession {
            agent_id: agent_id.clone(),
            repo_root: repo_root.clone(),
            key: key.clone(),
            subscribe_handle: handle,
            last_byte_ms,
        },
    );
    state.by_key.lock().unwrap().insert(key, session_id.clone());

    Ok(AgentSessionHandle {
        id: session_id,
        agent_id,
        repo_root,
        resumed: false,
    })
}

/// Idle-timeout block close. Called from the read loop's tokio
/// timeout branch — when no PTY bytes have arrived for IDLE_MS and
/// the open Output block hasn't been appended-to in IDLE_MS, close
/// it cleanly. Mirrors what an OSC 133 ;D would do; agents that
/// don't speak the standard (claude/gemini/codex/cursor today) get
/// the same UX.
fn maybe_close_idle_output(
    app: &AppHandle,
    session_id: &str,
    _agent_id: &str,
    block_event: &str,
    idle_ms: u64,
) {
    let registry = app.state::<AgentPtyRegistry>();
    let sessions = registry.sessions.lock().unwrap();
    let Some(sess) = sessions.get(session_id) else {
        return;
    };
    let cur_id = sess.current_block_id.lock().unwrap().clone();
    let Some(bid) = cur_id else { return };
    let last = *sess.last_append_ms.lock().unwrap();
    let Some(last_ms) = last else { return };
    if now_ms().saturating_sub(last_ms) < idle_ms {
        return;
    }
    let mut blocks = sess.blocks.lock().unwrap();
    let Some(b) = blocks.iter_mut().find(|b| b.id == bid) else {
        return;
    };
    // Only auto-close Output blocks. Prompt blocks shouldn't time
    // out — the agent owns when its prompt is complete.
    if b.kind != BlockKind::Output {
        return;
    }
    b.finished_at = Some(now_ms());
    let snap = b.clone();
    drop(blocks);
    let _ = app.emit(block_event, BlockUpdate::Close { block: snap });
    *sess.current_block_id.lock().unwrap() = None;
    *sess.block_lines.lock().unwrap() = 0;
    *sess.last_append_ms.lock().unwrap() = None;
}

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
/// Conservative chunk size — under the typical termios cooked-mode
/// buffer (4096 on Linux, 1024 on macOS) so even worst-case kernels
/// don't drop bytes. Bracketed-paste markers wrap the whole sequence
/// so the agent reassembles them as one paste, regardless of chunking.
const PROMPT_CHUNK: usize = 1024;

async fn write_prompt_bracketed(
    writer: &crate::pty_io::SharedPtyWriter,
    prompt: &str,
) -> Result<(), crate::pty_io::PtyWriteError> {
    let bytes = prompt.as_bytes().to_vec();
    // Runs on the blocking pool under a deadline (see `crate::pty_io`):
    // a whole prompt is far more likely than a keystroke to fill the
    // agent's input buffer and park in the kernel.
    crate::pty_io::write_with(writer, move |w| {
        w.write_all(PASTE_START)?;
        let mut off = 0;
        while off < bytes.len() {
            let end = (off + PROMPT_CHUNK).min(bytes.len());
            w.write_all(&bytes[off..end])?;
            off = end;
        }
        w.write_all(PASTE_END)?;
        // \r mirrors what pressing Enter at the REPL would do; the agent
        // sees: paste-start, body, paste-end, then submit.
        w.write_all(b"\r")
    })
    .await
}

/// Same envelope as `write_prompt_bracketed` but returns the bytes
/// to be written rather than acting on a writer. Used by the
/// daemon-mode send path which doesn't hold the PTY writer locally.
fn bracketed_prompt_bytes(prompt: &str) -> Vec<u8> {
    let body = prompt.as_bytes();
    let mut out = Vec::with_capacity(PASTE_START.len() + body.len() + PASTE_END.len() + 1);
    out.extend_from_slice(PASTE_START);
    out.extend_from_slice(body);
    out.extend_from_slice(PASTE_END);
    out.push(b'\r');
    out
}

#[tauri::command]
pub async fn agent_pty_write(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // Daemon-backed session — proxy via the client. Read the flag
    // without holding the lock across the await.
    let is_daemon = state
        .daemon_sessions
        .lock()
        .unwrap()
        .contains_key(&session_id);
    if is_daemon {
        return crate::pty_daemon::client::write_session(&session_id, &data)
            .await
            .map_err(|e| e.to_string());
    }
    // Clone the writer handle and let go of the registry map BEFORE the
    // write — see the note on `AgentPtySession::writer`. A wedged agent
    // must not take the other terminals (or the runtime) down with it.
    let writer = {
        let sessions = state.sessions.lock().unwrap();
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        sess.writer.clone()
    };
    crate::pty_io::write_bytes(&writer, data)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_pty_resize(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let is_daemon = state
        .daemon_sessions
        .lock()
        .unwrap()
        .contains_key(&session_id);
    if is_daemon {
        return crate::pty_daemon::client::resize_session(&session_id, cols, rows)
            .await
            .map_err(|e| e.to_string());
    }
    let sessions = state.sessions.lock().unwrap();
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))?;
    let res = sess
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
    // Keep the shadow terminal the same shape as the real one. A grid that
    // still thinks it is 80 columns wide wraps text the agent placed at
    // column 100, and every subsequent cursor move lands a row out.
    sess.grid.lock().unwrap().resize(cols, rows);
    res
}

#[tauri::command]
pub fn agent_pty_replay(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
) -> Result<Vec<BlockEnvelope>, String> {
    let sessions = state.sessions.lock().unwrap();
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))?;
    let snap = sess.blocks.lock().unwrap().clone();
    Ok(snap)
}

/// Snapshot of recent raw PTY bytes for a session — used by xterm on
/// mount to backfill the agent's welcome screen when the listener
/// attaches after the child has already written. Returns an empty Vec
/// when the session is unknown rather than erroring; the terminal view
/// is otherwise blank-on-startup which is worse than a missing replay.
#[tauri::command]
pub fn agent_pty_replay_bytes(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
) -> Result<Vec<u8>, String> {
    let sessions = state.sessions.lock().unwrap();
    let Some(sess) = sessions.get(&session_id) else {
        return Ok(Vec::new());
    };
    let snap = sess.raw_bytes.lock().unwrap().clone();
    Ok(snap)
}

/// Current native window title (OSC 0 / OSC 2) for a session, or null
/// if the agent hasn't set one yet. The frontend calls this once on
/// mount so a row that subscribed after the title was set still shows
/// it — the live `agent-title:<sid>` event stream carries deltas after.
#[tauri::command]
pub fn agent_pty_title(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
) -> Result<Option<String>, String> {
    let sessions = state.sessions.lock().unwrap();
    let Some(sess) = sessions.get(&session_id) else {
        return Ok(None);
    };
    let title = sess.last_title.lock().unwrap().clone();
    Ok(title)
}

/// Mid-session scrollback for a PTY agent — works for both in-process
/// and daemon-backed sessions. The phone client calls this on join so
/// it sees the same TUI screen the desktop xterm does.
#[tauri::command]
pub fn agent_pty_history(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
) -> Result<Vec<u8>, String> {
    let all = state.history.lock().unwrap();
    Ok(all
        .get(&session_id)
        .map(|q| q.iter().copied().collect::<Vec<u8>>())
        .unwrap_or_default())
}

/// Whether a daemon-backed session is still being serviced by its
/// subscribe loop. A `DaemonSession` entry alone isn't proof of life: the
/// loop exits (and emits `agent-pty-exit:<sid>`) when the daemon child
/// sends `Exit`, when the stream errors, or when the initial `subscribe()`
/// fails — but it can't safely purge its own bookkeeping during open()'s
/// spawn-then-insert window. So liveness keys off the JoinHandle instead:
/// once it's finished, nothing will ever pump bytes to this sid again
/// (write/resize would proxy to a child whose output goes nowhere), so we
/// purge the phantom entry here and report dead. This is the single place
/// natural-exit cleanup for daemon sessions happens — `is_alive`,
/// `idle_status`, and the resume path in `agent_pty_open` all route
/// through it so they can't disagree about whether a session is live.
/// Returns `false` for an unknown sid (not daemon-backed, or already
/// purged); the caller then falls through to the in-process check.
fn daemon_session_live(state: &AgentPtyRegistry, session_id: &str) -> bool {
    let finished_key = {
        let map = state.daemon_sessions.lock().unwrap();
        match map.get(session_id) {
            None => return false,
            Some(d) if d.subscribe_handle.is_finished() => Some(d.key.clone()),
            Some(_) => return true,
        }
    };
    // Subscribe loop has exited — drop the phantom so resume respawns and
    // the watchdog stops reporting it alive. Locks taken one at a time
    // (never both held at once) to match `agent_pty_close`'s order.
    if let Some(key) = finished_key {
        state.daemon_sessions.lock().unwrap().remove(session_id);
        state.by_key.lock().unwrap().remove(&key);
    }
    false
}

#[tauri::command]
pub fn agent_pty_is_alive(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
) -> Result<bool, String> {
    if daemon_session_live(&state, &session_id) {
        return Ok(true);
    }
    let sessions = state.sessions.lock().unwrap();
    let Some(sess) = sessions.get(&session_id) else {
        return Ok(false);
    };
    let alive = sess
        .child
        .lock()
        .unwrap()
        .try_wait()
        .map_err(|e| e.to_string())?
        .is_none();
    Ok(alive)
}

/// Snapshot of a PTY session's idleness for the stale-watchdog UI.
/// `idle_ms` is wall-clock time since the last byte the child wrote
/// landed in our read loop; `alive` is the same `try_wait()` check
/// `agent_pty_is_alive` does. Frontend polls this every few seconds
/// and renders a "Stale · Reconnect | Stop" chip when `alive &&
/// idle_ms >= 45_000` — that's the signal that the agent process is
/// up but the upstream API / token cache / claude-code-cli has hung
/// without giving the user any feedback.
///
/// Returns `idle_ms: 0, alive: false` for unknown session ids rather
/// than erroring, mirroring the rest of the idle/replay surface — a
/// stale tab id shouldn't pop a console error.
#[tauri::command]
pub fn agent_pty_idle_status(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
) -> Result<IdleStatus, String> {
    let now = now_ms();
    // Daemon-backed session: read the shared counter populated by the
    // subscribe loop. `daemon_session_live` is the gate — a session whose
    // subscribe loop has exited (child gone / stream broke) is purged
    // there and reported dead, so we fall through to the in-process branch
    // and return `alive: false` instead of a phantom-alive `true` that
    // would leave the stale-watchdog chip up forever on an exited child.
    if daemon_session_live(&state, &session_id) {
        let daemon_sessions = state.daemon_sessions.lock().unwrap();
        if let Some(d) = daemon_sessions.get(&session_id) {
            let last = *d.last_byte_ms.lock().unwrap();
            return Ok(IdleStatus {
                idle_ms: now.saturating_sub(last),
                alive: true,
            });
        }
    }
    let sessions = state.sessions.lock().unwrap();
    let Some(sess) = sessions.get(&session_id) else {
        return Ok(IdleStatus {
            idle_ms: 0,
            alive: false,
        });
    };
    let alive = sess
        .child
        .lock()
        .unwrap()
        .try_wait()
        .map_err(|e| e.to_string())?
        .is_none();
    let last = *sess.last_byte_ms.lock().unwrap();
    Ok(IdleStatus {
        idle_ms: now.saturating_sub(last),
        alive,
    })
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct IdleStatus {
    /// Milliseconds since the child last wrote a byte to the PTY.
    /// Capped only by u64; in practice the frontend cares about the
    /// `>= 45_000` threshold.
    pub idle_ms: u64,
    /// Whether the child process is still up. False after `/exit`,
    /// SIGTERM, etc. — the stale chip should be hidden in that case
    /// and the existing "exited" UX takes over.
    pub alive: bool,
}

#[tauri::command]
pub async fn agent_pty_close(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
) -> Result<(), String> {
    // Free the per-session history ring (up to PTY_HISTORY_CAP bytes).
    // The read loops fill this map for both in-process and daemon-backed
    // sessions but nothing here pruned it, so every closed agent session
    // leaked its full scrollback for the life of the process. Drop it on
    // the explicit teardown, before either branch returns.
    state.history.lock().unwrap().remove(&session_id);

    // Daemon-backed first: drop subscribe loop, ask daemon to kill
    // the child, purge our bookkeeping. Best-effort — errors here
    // shouldn't fail close (the user just wants the session gone).
    let daemon_proxy = state
        .daemon_sessions
        .lock()
        .unwrap()
        .remove(&session_id);
    if let Some(proxy) = daemon_proxy {
        proxy.subscribe_handle.abort();
        let _ = crate::pty_daemon::client::close_session(&session_id).await;
        state.by_key.lock().unwrap().remove(&proxy.key);
        return Ok(());
    }
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(sess) = sessions.remove(&session_id) {
        // See `pty_reap` — closing an agent tab has to stop the tools that
        // agent launched, not just the CLI process holding the PTY.
        crate::pty_reap::hangup_and_reap(&mut **sess.child.lock().unwrap());
        state.by_key.lock().unwrap().remove(&sess.key);
    }
    Ok(())
}

/// Live PTY session row — combines in-process and daemon-backed
/// sessions into one resumable listing the frontend can show after
/// an auto-update relaunch. `kind` lets the renderer pick the right
/// reattach affordance (daemon = "Resume", in-process = "Closed by
/// restart, start a new one").
#[derive(Serialize, Clone, Debug)]
pub struct LivePtySession {
    pub session_id: String,
    pub agent_id: String,
    pub repo_root: String,
    pub kind: LivePtyKind,
    /// Milliseconds since the child last wrote a byte we observed.
    /// `None` when the source is the daemon and we haven't subscribed
    /// to it from this shell process yet (a freshly-launched shell
    /// reading `pty_list_alive` for the first time).
    pub idle_ms: Option<u64>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LivePtyKind {
    /// PTY child owned by aura-pty-daemon — survives shell restart.
    Daemon,
    /// PTY child owned by this shell process — dies with us. After a
    /// relaunch these will never show up (we restart from a clean
    /// registry); they're here so the listing is symmetric in the
    /// pre-relaunch window when the frontend is still bookkeeping.
    InProcess,
}

/// Enumerate every live agent PTY session the shell can resume.
/// Combines this process's in-memory registry with whatever the
/// aura-pty-daemon (when running) reports owning. Called on shell
/// startup after an auto-update relaunch so the frontend can surface
/// a "Reattach to your Claude / Codex / Gemini session?" prompt.
///
/// Errors talking to the daemon are not fatal — we still return the
/// in-process slice so this command never hides whatever we do have.
#[tauri::command]
pub async fn pty_list_alive(
    state: State<'_, AgentPtyRegistry>,
) -> Result<Vec<LivePtySession>, String> {
    let mut out: Vec<LivePtySession> = Vec::new();
    let now = now_ms();

    // 1. In-process sessions. Liveness is the same try_wait check
    // `agent_pty_is_alive` does; dead ones are skipped because they
    // can't be reattached to in any meaningful sense.
    {
        let sessions = state.sessions.lock().unwrap();
        for (sid, sess) in sessions.iter() {
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
            out.push(LivePtySession {
                session_id: sid.clone(),
                agent_id: sess.agent_id.clone(),
                repo_root: sess.repo_root.clone(),
                kind: LivePtyKind::InProcess,
                idle_ms: Some(now.saturating_sub(last)),
            });
        }
    }

    // 2. Daemon-backed sessions already reattached in this shell
    // process. We have the same idleness counter for these, so
    // include it — the daemon listing below would otherwise show
    // them with `idle_ms: None`.
    let mut already_known: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    {
        let daemon_sessions = state.daemon_sessions.lock().unwrap();
        for (sid, sess) in daemon_sessions.iter() {
            let last = *sess.last_byte_ms.lock().unwrap();
            out.push(LivePtySession {
                session_id: sid.clone(),
                agent_id: sess.agent_id.clone(),
                repo_root: sess.repo_root.clone(),
                kind: LivePtyKind::Daemon,
                idle_ms: Some(now.saturating_sub(last)),
            });
            already_known.insert(sid.clone());
        }
    }

    // 3. Daemon-owned sessions NOT yet reattached by this process.
    // These are the survivors of an auto-update relaunch — the
    // daemon kept the child alive, but our fresh shell process
    // doesn't have a subscribe loop pumping bytes for them yet.
    // The frontend uses these to render the "Reattach" prompts.
    //
    // Filter to Agent kind: the daemon now also hosts Plain terminal
    // shells, and `list_detailed()` would mix those into this agent
    // reattach listing — surfacing a bare shell as a phantom
    // "Reattach to your Claude session?" card. The plain-shell restore
    // path lists its own kind separately.
    match crate::pty_daemon::client::list_by_kind(
        crate::pty_daemon::proto::SessionKind::Agent,
    )
    .await
    {
        Ok(daemon_listing) => {
            for info in daemon_listing {
                if already_known.contains(&info.session_id) {
                    continue;
                }
                out.push(LivePtySession {
                    session_id: info.session_id,
                    agent_id: info.agent_id,
                    repo_root: info.repo_root,
                    kind: LivePtyKind::Daemon,
                    idle_ms: None,
                });
            }
        }
        Err(_) => {
            // Daemon unreachable — either it isn't running (no
            // AURA_USE_PTY_DAEMON in env) or it crashed. Either
            // way the in-process slice is still useful; surface
            // nothing extra.
        }
    }

    Ok(out)
}

/// Pre-relaunch handshake invoked by the renderer right before
/// calling tauri-plugin-process `relaunch()` after an auto-update.
///
/// Sends a `Request::PreRelaunch` to the daemon (auto-spawns it if
/// AURA_USE_PTY_DAEMON is set but the daemon isn't up yet) and
/// returns the count of sessions the daemon promises to keep alive.
/// The frontend can use this number to decide whether to warn the
/// user — `Ok(n)` with `n > 0` means "n agent sessions will survive
/// the restart"; `Err(_)` means "no daemon, in-process sessions
/// will die when relaunch fires".
///
/// Safe to call when daemon mode is off — we still attempt the
/// connect (which auto-spawns the daemon binary) so a user who
/// flipped the env var mid-session still gets the handshake.
#[tauri::command]
pub async fn pty_pre_relaunch_signal() -> Result<usize, String> {
    crate::pty_daemon::client::pre_relaunch()
        .await
        .map_err(|e| e.to_string())
}

// ── helpers ─────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ensure `~/.aura/shell-mcp-config.json` exists with an entry that
/// wires the `aura mcp` stdio server. Idempotent — overwrites every
/// time so the config tracks any changes to the bin path or args. The
/// path is returned for use as claude's `--mcp-config` argument so the
/// user's claude PTY tabs ship with all aura MCP tools wired by
/// default. Returns None on filesystem failure (in which case the
/// spawn falls back to whatever the user has configured globally).
fn ensure_aura_mcp_config() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let mut path = std::path::PathBuf::from(home);
    path.push(".aura");
    let _ = std::fs::create_dir_all(&path);
    path.push("shell-mcp-config.json");

    // Resolve the aura bin path. Prefer an absolute path so claude
    // doesn't depend on PATH being right under whatever shell init it
    // inherits. Falls back to bare `aura` if `which` fails.
    let aura_bin = which_aura().unwrap_or_else(|| "aura".to_string());

    let body = serde_json::json!({
        "mcpServers": {
            "aura": {
                "command": aura_bin,
                "args": ["mcp"],
            }
        }
    });
    let serialized = serde_json::to_string_pretty(&body).ok()?;
    std::fs::write(&path, serialized).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Embedded copies of the aura-claude plugin scripts. Compiled into
/// the binary so we don't depend on the bundle layout to find them at
/// runtime — `include_str!` reads at compile time relative to this
/// file. On first launch we stage them under
/// `~/.aura/plugins/aura-claude/scripts/` and point Claude's hooks at
/// the staged paths. Mirrors the stamping pattern from `ensure_aura_mcp_config`.
const AURA_CLAUDE_SCRIPTS: &[(&str, &str)] = &[
    (
        "should-use-structured.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/should-use-structured.sh"),
    ),
    (
        "aura-notify.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/aura-notify.sh"),
    ),
    (
        "aura-notify-rpc.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/aura-notify-rpc.sh"),
    ),
    (
        "build-payload.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/build-payload.sh"),
    ),
    (
        "on-session-start.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/on-session-start.sh"),
    ),
    (
        "on-stop.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/on-stop.sh"),
    ),
    (
        "on-prompt-submit.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/on-prompt-submit.sh"),
    ),
    (
        "on-permission-request.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/on-permission-request.sh"),
    ),
    (
        "on-post-tool-use.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/on-post-tool-use.sh"),
    ),
    (
        "on-pre-tool-use.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/on-pre-tool-use.sh"),
    ),
    (
        "on-notification.sh",
        include_str!("../../plugins/aura-claude/plugins/aura/scripts/on-notification.sh"),
    ),
];

/// Stage the plugin scripts under `~/.aura/plugins/aura-claude/scripts/`
/// and stamp `<repo_root>/.claude/settings.local.json` to wire Claude's
/// hooks at the staged scripts. Idempotent: re-staging overwrites
/// (so a shell upgrade picks up new script bodies); merge-edits the
/// JSON so user customizations under other keys survive.
///
/// `settings.local.json` was chosen over `settings.json` because it
/// is git-ignored by Claude convention — Aura's per-repo plumbing
/// shouldn't show up in `git status`.
fn ensure_aura_claude_hooks_stamped(repo_root: &str) -> Option<()> {
    use std::os::unix::fs::PermissionsExt;

    // 1. Stage embedded scripts under ~/.aura/plugins/aura-claude/scripts/
    let home = std::env::var_os("HOME")?;
    let mut script_dir = std::path::PathBuf::from(&home);
    script_dir.push(".aura");
    script_dir.push("plugins");
    script_dir.push("aura-claude");
    script_dir.push("scripts");
    std::fs::create_dir_all(&script_dir).ok()?;
    for (name, body) in AURA_CLAUDE_SCRIPTS {
        let p = script_dir.join(name);
        std::fs::write(&p, body).ok()?;
        // chmod +x — bash hooks run via portable-pty's fork+exec, no
        // shell wrapper, so the executable bit must be set.
        if let Ok(meta) = std::fs::metadata(&p) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&p, perms);
        }
    }

    // 2. Read or initialize <repo_root>/.claude/settings.local.json
    let mut settings_path = std::path::PathBuf::from(repo_root);
    settings_path.push(".claude");
    std::fs::create_dir_all(&settings_path).ok()?;
    settings_path.push("settings.local.json");
    let existing = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let mut root = match existing {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };

    // 3. Build our hook entries pointing at staged scripts.
    let make_entry = |script: &str, matcher: Option<&str>| -> serde_json::Value {
        let cmd = script_dir.join(script).to_string_lossy().into_owned();
        let inner = serde_json::json!({
            "hooks": [{ "type": "command", "command": cmd }]
        });
        let mut obj = match inner {
            serde_json::Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        if let Some(m) = matcher {
            obj.insert("matcher".into(), serde_json::Value::String(m.into()));
        }
        serde_json::Value::Object(obj)
    };

    let aura_entries: &[(&str, &str, Option<&str>)] = &[
        ("SessionStart", "on-session-start.sh", Some("startup|resume")),
        ("Stop", "on-stop.sh", None),
        ("Notification", "on-notification.sh", Some("idle_prompt")),
        ("PermissionRequest", "on-permission-request.sh", None),
        ("UserPromptSubmit", "on-prompt-submit.sh", None),
        ("PreToolUse", "on-pre-tool-use.sh", Some("*")),
        ("PostToolUse", "on-post-tool-use.sh", None),
    ];

    let hooks_val = root
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let serde_json::Value::Object(hooks_map) = hooks_val else {
        // Existing `hooks` key is non-object — refuse to merge to avoid
        // corrupting it. User has hand-edited; leave their file alone.
        return None;
    };

    for (event, script, matcher) in aura_entries {
        let entry = make_entry(script, *matcher);
        let arr = hooks_map
            .entry(event.to_string())
            .or_insert_with(|| serde_json::Value::Array(vec![]));
        let serde_json::Value::Array(items) = arr else {
            continue;
        };
        // De-dupe by exact-match (re-stamp may have rotated paths but
        // our staged dir is stable under HOME, so this is exact).
        if !items.contains(&entry) {
            items.push(entry);
        }
    }

    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(root)).ok()?;
    std::fs::write(&settings_path, serialized).ok()?;
    Some(())
}

/// Embedded copies of the aura-gemini extension. Same pattern as the
/// claude scripts above — staged on first launch under
/// `~/.gemini/extensions/aura-gemini/` (gemini's native extension dir),
/// after which gemini auto-discovers the extension at startup. No
/// settings.json edit needed; gemini reads its `extensions/` dir
/// directly.
const AURA_GEMINI_FILES: &[(&str, &str)] = &[
    (
        "gemini-extension.json",
        include_str!("../../plugins/aura-gemini/gemini-extension.json"),
    ),
    (
        "hooks/hooks.json",
        include_str!("../../plugins/aura-gemini/hooks/hooks.json"),
    ),
    (
        "scripts/should-use-structured.sh",
        include_str!("../../plugins/aura-gemini/scripts/should-use-structured.sh"),
    ),
    (
        "scripts/aura-notify.sh",
        include_str!("../../plugins/aura-gemini/scripts/aura-notify.sh"),
    ),
    (
        "scripts/build-payload.sh",
        include_str!("../../plugins/aura-gemini/scripts/build-payload.sh"),
    ),
    (
        "scripts/on-session-start.sh",
        include_str!("../../plugins/aura-gemini/scripts/on-session-start.sh"),
    ),
    (
        "scripts/on-stop.sh",
        include_str!("../../plugins/aura-gemini/scripts/on-stop.sh"),
    ),
    (
        "scripts/on-prompt-submit.sh",
        include_str!("../../plugins/aura-gemini/scripts/on-prompt-submit.sh"),
    ),
    (
        "scripts/on-post-tool-use.sh",
        include_str!("../../plugins/aura-gemini/scripts/on-post-tool-use.sh"),
    ),
    (
        "scripts/on-notification.sh",
        include_str!("../../plugins/aura-gemini/scripts/on-notification.sh"),
    ),
];

fn ensure_aura_gemini_extension_stamped() -> Option<()> {
    use std::os::unix::fs::PermissionsExt;
    let home = std::env::var_os("HOME")?;
    let mut ext_root = std::path::PathBuf::from(home);
    ext_root.push(".gemini");
    ext_root.push("extensions");
    ext_root.push("aura-gemini");
    std::fs::create_dir_all(&ext_root).ok()?;
    for (rel, body) in AURA_GEMINI_FILES {
        let p = ext_root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).ok()?;
        }
        std::fs::write(&p, body).ok()?;
        if rel.ends_with(".sh") {
            if let Ok(meta) = std::fs::metadata(&p) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&p, perms);
            }
        }
    }
    Some(())
}

fn which_aura() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/which")
        .arg("aura")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Ensure the repo's `.mcp.json` declares the aura MCP server so ANY claude
/// session opened in this repo — including one launched from a plain
/// terminal rather than our in-app PTY — loads aura's tools
/// (`aura_log_intent`, `aura_snapshot`, …). Merge-safe: preserves any
/// servers the user already declared, only adds/refreshes the `aura` entry.
/// The file is kept out of `git status` via `.git/info/exclude` (written by
/// cmd_aura_track on the same repo-open pass).
fn ensure_repo_mcp_json(repo_root: &str) -> bool {
    let path = std::path::Path::new(repo_root).join(".mcp.json");
    let aura_bin = which_aura().unwrap_or_else(|| "aura".to_string());

    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();

    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let serde_json::Value::Object(servers_map) = servers else {
        // Existing `mcpServers` is a non-object — refuse to corrupt a file
        // the user hand-wrote.
        return false;
    };
    servers_map.insert(
        "aura".to_string(),
        serde_json::json!({ "command": aura_bin, "args": ["mcp"] }),
    );

    match serde_json::to_string_pretty(&serde_json::Value::Object(root)) {
        Ok(s) => std::fs::write(&path, s).is_ok(),
        Err(_) => false,
    }
}

/// Wire every agent CLI so edits in this repo log intent through Aura,
/// regardless of which agent — or how it was launched. Idempotent; called
/// on repo-open (see `cmd_aura_track::aura_ensure_tracked`) as well as at
/// in-app PTY spawn. Returns whether the core wiring landed.
pub(crate) fn wire_agents_for_repo(repo_root: &str) -> bool {
    // (a) Global MCP config claude reads via `--mcp-config` for in-app PTYs.
    let mcp_cfg = ensure_aura_mcp_config().is_some();
    // (b) Repo-level `.mcp.json` so external claude sessions here also get
    //     aura's tools.
    let repo_mcp = ensure_repo_mcp_json(repo_root);
    // (c) Claude's per-repo hook scripts (PreToolUse → live intent capture).
    let claude_hooks = ensure_aura_claude_hooks_stamped(repo_root).is_some();
    // (d) Gemini extension (user-global; harmless if gemini isn't installed).
    let _ = ensure_aura_gemini_extension_stamped();
    mcp_cfg || repo_mcp || claude_hooks
}

/// vte Performer that strips ANSI/CSI down to printable text and
/// watches for two OSC families:
///   * OSC 133;D  — command-end with optional exit code (clean-room
///     reuse of the open prompt-marking standard).
///   * OSC 777;notify;aura://cli-agent;<json> — the structured
///     cli-agent notification protocol forked from Warp's MIT plugin
///     scripts (see `aura-shell/plugins/aura-claude/`). Only ;D is
///     honored for 133 — ;A and ;B are synthesized by `send_prompt` so
///     we never double-bracket if the agent echoes the prompt back.
///
/// It no longer collects the printable text: a block's text comes off the
/// session's shadow grid, which is the only thing here that can tell a
/// repainted line from a new one. What survives is the part a grid throws
/// away — the out-of-band markers the agent addresses to us rather than to
/// the screen.
#[derive(Default)]
struct OscPerf {
    /// Set when the agent emits OSC 133 ;A — open a new Prompt block.
    osc133_prompt_start: bool,
    /// Set when the agent emits OSC 133 ;B — prompt-end / output-start.
    /// Closes the open Prompt block and opens a fresh Output block.
    osc133_output_start: bool,
    /// Set when the agent emits OSC 133 ;D — command-end with optional
    /// exit code. Closes the open Output block as Exit.
    osc133_exit: Option<i32>,
    /// Cli-agent events parsed during this PTY-byte chunk. The read
    /// loop drains and emits these per chunk so the renderer sees them
    /// in order.
    cli_agent_events: Vec<CliAgentEvent>,
    /// Latest window title the agent set via OSC 0 / OSC 2 during this
    /// chunk. Claude Code (and most modern CLIs) push a short status
    /// string here as they work — the same signal Warp reads to
    /// auto-title a session row. Captured out-of-band from the TUI
    /// redraw, so no alt-screen scraping. The read loop drains this and
    /// emits `agent-title:<sid>`.
    osc_title: Option<String>,
}

impl Perform for OscPerf {
    // print/execute: intentionally no-op. Text is the grid's job. This pass
    // used to keep every printable character and the three line-shaping
    // bytes, which is as close to a transcript as you can get without a
    // screen — and not close enough: it cannot tell a line being redrawn from
    // a line being written, so a spinner arrived as one copy per frame and a
    // menu painted by cursor address arrived as a single run-on line.
    fn osc_dispatch(&mut self, params: &[&[u8]], _bel_terminated: bool) {
        if params.is_empty() {
            return;
        }
        // OSC 133 prompt-marking — D is command-end with exit code.
        if params[0] == b"133" {
            self.handle_osc133(params);
            return;
        }
        // OSC 777 cli-agent notification.
        if params[0] == b"777" {
            self.handle_osc777(params);
            return;
        }
        // OSC 0 (icon + window title) / OSC 2 (window title) — the
        // native title the agent sets as it works. OSC 1 is icon-name
        // only, which never shows in a tab, so we skip it. The title
        // text is everything after the code; vte splits on `;`, so a
        // title containing `;` lands across params[2..] — rejoin it.
        if params[0] == b"0" || params[0] == b"2" {
            if params.len() < 2 {
                return;
            }
            let parts: Vec<String> = params[1..]
                .iter()
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .collect();
            let title = parts.join(";");
            let title = title.trim();
            // Ignore clears (`OSC 2 ; ST`) — don't blank a good title.
            if !title.is_empty() {
                self.osc_title = Some(title.to_string());
            }
        }
    }
    // hook/put/unhook/csi_dispatch/esc_dispatch: intentionally no-op.
    // We only want printable text + the two OSC families above.
}

impl OscPerf {
    fn handle_osc133(&mut self, params: &[&[u8]]) {
        if params.len() < 2 || params[1].is_empty() {
            return;
        }
        // OSC 133 prompt-marking standard. The four sub-types we honor:
        //   ;A — prompt-start  → open a new Prompt block
        //   ;B — prompt-end    → close Prompt, open Output
        //   ;C — command-start → ignored (output already streaming)
        //   ;D — command-end   → close Output as Exit
        match params[1][0] {
            b'A' => self.osc133_prompt_start = true,
            b'B' => self.osc133_output_start = true,
            b'C' => { /* no-op: streaming text already opens the Output */ }
            b'D' => {
                // Two emitter conventions:
                //   `\x1b]133;D;<exit>\x07`     → exit is params[2]
                //   `\x1b]133;D=<exit>\x07`     → exit is the tail of params[1]
                let exit = if params.len() >= 3 {
                    std::str::from_utf8(params[2])
                        .ok()
                        .and_then(|s| s.parse::<i32>().ok())
                } else {
                    let tail = &params[1][1..];
                    let tail = tail.strip_prefix(b"=").unwrap_or(tail);
                    std::str::from_utf8(tail)
                        .ok()
                        .and_then(|s| s.parse::<i32>().ok())
                };
                self.osc133_exit = Some(exit.unwrap_or(0));
            }
            _ => {}
        }
    }

    fn handle_osc777(&mut self, params: &[&[u8]]) {
        // Wire shape: `OSC 777;notify;<title>;<json>`.
        // vte splits on every `;` so JSON bodies that contain `;`
        // (rare but possible inside string values) end up across
        // params[3..]. Reassemble by re-joining with `;` so the JSON
        // parses cleanly.
        if params.len() < 4 {
            return;
        }
        if params[1] != b"notify" {
            return;
        }
        let Ok(title) = std::str::from_utf8(params[2]) else {
            return;
        };
        if title != "aura://cli-agent" {
            return;
        }

        let mut body = Vec::with_capacity(
            params[3..].iter().map(|p| p.len()).sum::<usize>() + params.len(),
        );
        for (i, part) in params[3..].iter().enumerate() {
            if i > 0 {
                body.push(b';');
            }
            body.extend_from_slice(part);
        }
        let Ok(text) = std::str::from_utf8(&body) else {
            return;
        };
        if let Ok(ev) = serde_json::from_str::<CliAgentEvent>(text) {
            self.cli_agent_events.push(ev);
        }
    }
}

#[cfg(test)]
mod place_tests {
    use super::*;
    use crate::cloudbox::script::{is_session_name, session_name};

    const FRESH: &str = "9f2c1e40-7b3a-4d51-8c6e-2a1b0d3f4e5a";

    fn name(agent: &str, resume: Option<&str>, force_new: bool) -> String {
        session_name("agent", "/Users/me/naridon", &tmux_nonce(agent, resume, force_new, FRESH))
    }

    #[test]
    fn the_same_agent_on_the_same_project_comes_back_to_the_same_session() {
        // The whole reason the name is derived rather than random: `tmux new -A`
        // attaches to a session of this name if it exists. Two opens a week
        // apart must produce the same string, or the second one starts a
        // parallel agent beside a running one nobody can see.
        assert_eq!(name("claude", None, false), name("claude", None, false));
        assert!(name("claude", None, false).contains("naridon"));
        assert!(name("claude", None, false).contains("claude"));
    }

    #[test]
    fn a_second_claude_on_one_project_is_a_second_session() {
        // "Start another one" is an explicit act. Attaching it to the first
        // would put two people's keystrokes into one buffer.
        assert_ne!(name("claude", None, true), name("claude", None, false));
    }

    #[test]
    fn resuming_a_different_conversation_is_a_different_session() {
        // Ids that agree for their first eight characters and differ later —
        // taking the front of the string put both conversations on one screen.
        assert_ne!(
            name("claude", Some("ffb0f2b0-1111-4c1e-9a2f-000000000001"), false),
            name("claude", Some("ffb0f2b0-2222-4c1e-9a2f-000000000002"), false),
        );
    }

    #[test]
    fn the_name_for_one_conversation_does_not_move() {
        // Written out as a literal on purpose: this string is what a machine
        // somewhere is holding a session under. A change to how it is derived
        // orphans that session — still running, still costing, invisible to the
        // tab that started it — so it has to be a deliberate act, not a
        // refactor.
        assert_eq!(
            name("claude", Some("ffb0f2b0-1111-4c1e-9a2f-000000000001"), false),
            "aura-agent-naridon-claude-739c4a6a",
        );
    }

    #[test]
    fn two_agents_on_one_project_do_not_share_a_session() {
        assert_ne!(name("claude", None, false), name("gemini", None, false));
    }

    #[test]
    fn every_name_this_produces_is_one_a_machine_will_take() {
        // The name is addressed BY NAME in every tmux command after this, on
        // someone else's computer. An id carrying a quote or a semicolon has to
        // come out the far end as a name, not as a second command.
        for (agent, resume) in [
            ("claude", None),
            ("cursor-agent", None),
            ("claude", Some("a'b; rm -rf ~")),
            ("claude", Some("../../etc/passwd")),
        ] {
            for force_new in [false, true] {
                let n = name(agent, resume, force_new);
                assert!(is_session_name(&n), "{n:?} is not a name tmux can hold");
            }
        }
    }
}

#[cfg(test)]
mod open_gate_tests {
    use super::*;
    use std::time::Duration;

    /// Long enough that a gate which is genuinely free is taken immediately,
    /// short enough that the blocked case doesn't slow the suite down.
    const BEAT: Duration = Duration::from_millis(50);

    fn gate_count(reg: &AgentPtyRegistry) -> usize {
        reg.open_gates.lock().unwrap().len()
    }

    #[tokio::test]
    async fn a_second_open_on_the_same_key_waits_for_the_first() {
        let reg = AgentPtyRegistry::new();
        let first = OpenGate::acquire(&reg, "claude@/repo").await;

        let blocked = tokio::time::timeout(BEAT, OpenGate::acquire(&reg, "claude@/repo")).await;
        assert!(
            blocked.is_err(),
            "a second open on a key already being opened must wait, not spawn a second child"
        );

        drop(first);
        let after = tokio::time::timeout(BEAT, OpenGate::acquire(&reg, "claude@/repo")).await;
        assert!(after.is_ok(), "the gate must be released when the first open returns");
    }

    #[tokio::test]
    async fn opens_on_different_keys_do_not_wait_on_each_other() {
        let reg = AgentPtyRegistry::new();
        let _claude = OpenGate::acquire(&reg, "claude@/repo").await;

        let other = tokio::time::timeout(BEAT, OpenGate::acquire(&reg, "gemini@/repo")).await;
        assert!(
            other.is_ok(),
            "the gate is per key — a different agent or repo must open concurrently"
        );
    }

    #[tokio::test]
    async fn a_finished_open_leaves_no_entry_behind() {
        let reg = AgentPtyRegistry::new();
        {
            let _held = OpenGate::acquire(&reg, "claude@/repo#one").await;
            assert_eq!(gate_count(&reg), 1);
        }
        assert_eq!(
            gate_count(&reg),
            0,
            "every force_new open mints a unique key; keeping them would grow forever"
        );
    }

    #[test]
    fn a_gate_someone_is_queued_on_survives_the_release() {
        let reg = AgentPtyRegistry::new();
        let queued = reg.open_gate("claude@/repo"); // a second opener, waiting
        let holder = reg.open_gate("claude@/repo"); // the one about to release

        reg.release_open_gate("claude@/repo");
        assert_eq!(
            gate_count(&reg),
            1,
            "pruning a gate someone is queued on would hand the next caller a fresh \
             gate and let the two race again"
        );

        drop(queued);
        reg.release_open_gate("claude@/repo");
        assert_eq!(gate_count(&reg), 0);
        drop(holder);
    }

}

/// What a block says, after the terminal has finished changing its mind.
///
/// [`transcript_delta`] and [`reframe_text`] carry that contract between
/// them, and the frontend's block store implements the second one again in
/// TypeScript — so these cases are the specification both sides are written
/// against. Every one of them is a shape the agent chat actually hit.
#[cfg(test)]
mod transcript_tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ordinary_streaming_is_a_pure_append() {
        let d = transcript_delta(&lines(&["one", "two"]), &lines(&["one", "two", "three"]));
        assert_eq!(d.evicted, 0);
        assert_eq!(d.rewrote, 0);
        assert_eq!(d.added, lines(&["three"]));
    }

    #[test]
    fn a_repainted_last_line_is_a_rewrite_of_exactly_that_line() {
        // The spinner case, seen from here: the transcript's last line is a
        // different string than it was, and nothing above it moved.
        let d = transcript_delta(
            &lines(&["Explain this codebase", "Working(3s)"]),
            &lines(&["Explain this codebase", "Working(4s)"]),
        );
        assert_eq!(d.rewrote, 1);
        assert_eq!(d.added, lines(&["Working(4s)"]));
    }

    #[test]
    fn a_full_screen_redraw_rewrites_only_the_screen() {
        let d = transcript_delta(
            &lines(&["scrolled", "a", "b", "c"]),
            &lines(&["scrolled", "x", "y", "z"]),
        );
        assert_eq!(d.evicted, 0);
        assert_eq!(d.rewrote, 3);
        assert_eq!(d.added, lines(&["x", "y", "z"]));
    }

    #[test]
    fn lines_falling_off_the_top_are_reported_as_eviction_not_as_change() {
        // A grid at its scrollback limit drops a line off the top for each
        // one it gains. Read naively that looks like "everything changed",
        // and the block would be rewritten with the whole session in it.
        let d = transcript_delta(
            &lines(&["gone", "a", "b", "c"]),
            &lines(&["a", "b", "c", "d"]),
        );
        assert_eq!(d.evicted, 1);
        assert_eq!(d.rewrote, 0);
        assert_eq!(d.added, lines(&["d"]));
    }

    #[test]
    fn a_single_line_in_common_is_not_mistaken_for_an_alignment() {
        // Blank lines and repeated prompts match all over a transcript, so a
        // one-line coincidence must not be read as a shift. Here nothing
        // genuinely lines up, and saying so is the honest answer.
        let d = transcript_delta(&lines(&["a", "", "b"]), &lines(&["", "q", "r"]));
        assert_eq!(d.evicted, 0);
        assert_eq!(d.rewrote, 3);
        assert_eq!(d.added, lines(&["", "q", "r"]));
    }

    #[test]
    fn the_first_output_of_a_block_is_all_addition() {
        let d = transcript_delta(&[], &lines(&["hello"]));
        assert_eq!(d.evicted, 0);
        assert_eq!(d.rewrote, 0);
        assert_eq!(d.added, lines(&["hello"]));
    }

    #[test]
    fn reframe_replaces_the_tail_it_was_told_to() {
        let mut text = String::from("one\ntwo\nthree");
        reframe_text(&mut text, 1, &lines(&["THREE"]));
        assert_eq!(text, "one\ntwo\nTHREE");
    }

    #[test]
    fn reframe_can_empty_a_block_and_refill_it() {
        let mut text = String::from("a\nb");
        reframe_text(&mut text, 5, &lines(&["fresh"]));
        assert_eq!(text, "fresh");
    }

    #[test]
    fn reframe_with_nothing_to_drop_is_an_append() {
        let mut text = String::from("a");
        reframe_text(&mut text, 0, &lines(&["b", "c"]));
        assert_eq!(text, "a\nb\nc");
    }

    #[test]
    fn a_spinner_never_grows_the_block_it_lives_in() {
        // The whole defect, end to end: ten repaints of one line leave one
        // line. Before the grid this produced ten.
        let mut text = String::new();
        let mut mirror: Vec<String> = Vec::new();
        for tick in 0..10 {
            let next = lines(&["Explain this codebase"])
                .into_iter()
                .chain(std::iter::once(format!("Working({tick}s)")))
                .collect::<Vec<_>>();
            let d = transcript_delta(&mirror, &next);
            reframe_text(&mut text, d.rewrote, &d.added);
            mirror = next;
        }
        assert_eq!(text, "Explain this codebase\nWorking(9s)");
    }
}
