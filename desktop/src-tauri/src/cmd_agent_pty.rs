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
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

/// Per-PTY scrollback ring buffer, capped so a long-running session
/// doesn't grow unbounded. Phone clients fetch this on join so they
/// see the same screen the desktop xterm has.
const PTY_HISTORY_CAP: usize = 4 * 1024 * 1024;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
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
    Open { block: BlockEnvelope },
    Append { block_id: String, text: String },
    Close { block: BlockEnvelope },
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
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    blocks: Mutex<Vec<BlockEnvelope>>,
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

impl AgentPtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kill every PTY child this registry owns. Called from the app's
    /// run-event hook on shutdown so coding-agent CLIs don't outlive the
    /// shell — without this the user's `claude` / `gemini` / `codex`
    /// process keeps writing to stdout into a now-disconnected PTY,
    /// eating CPU and leaking sessions until they `pkill` it manually.
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, sess) in sessions.drain() {
            let _ = sess.child.lock().unwrap().kill();
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
    let force_new = force_new.unwrap_or(false);
    let key = if force_new {
        format!("{base_key}#{}", Uuid::new_v4())
    } else {
        base_key
    };

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
        let alive = {
            let sessions = state.sessions.lock().unwrap();
            sessions
                .get(&sid)
                .map(|s| s.child.lock().unwrap().try_wait().ok().flatten().is_none())
                .unwrap_or(false)
        };
        if alive {
            let sessions = state.sessions.lock().unwrap();
            let sess = sessions.get(&sid).unwrap();
            return Ok(AgentSessionHandle {
                id: sid.clone(),
                agent_id: sess.agent_id.clone(),
                repo_root: sess.repo_root.clone(),
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
    let inv = provider
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
    let bin = inv.bin;

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
        let mut env_extras = inv.env.clone();
        for (k, v) in profile_env.iter().cloned() {
            env_extras.push((k, v));
        }
        return open_via_daemon(
            &app,
            state,
            agent_id,
            repo_root,
            cols,
            rows,
            key,
            bin,
            inv.args,
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
    cmd.cwd(crate::spawn_dir::safe_spawn_dir(&repo_root));
    // Without TERM most CLIs degrade to plain output and disable line
    // editing. Match what cmd_pty.rs sends to the regular shell.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("AURA_MANAGER_SESSION_ID", &id);
    cmd.env("AURA_REPO_ROOT", &repo_root);
    cmd.env("AURA_AGENT_ID", &agent_id);
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
    for arg in &inv.args {
        cmd.arg(arg);
    }
    eprintln!(
        "[agent_pty_open] spawning {} {:?} (repo={}, resume_session_id={:?})",
        bin, inv.args, repo_root, resume_session_id,
    );
    // Inject the aura MCP server config for claude PTY tabs so the user
    // gets all 50+ aura tools (`aura_log_intent`, `aura_snapshot`,
    // `aura_pr_review`, `aura_prove`, `aura_rewind`, …) in claude's tool
    // palette by default — without us touching their global ~/.claude.json
    // or their repo's .mcp.json. Passed as a non-strict --mcp-config so
    // the user's existing servers still load. Only claude supports this
    // flag today; gemini / codex / cursor route MCP differently and are
    // skipped here (they pick up aura tools via their own config paths if
    // the user has wired them).
    // Pin the agent CLI version (T3.2). Records `<bin> --version` on
    // first spawn into ~/.aura/agent-versions.json; on subsequent
    // spawns, mismatch fires `agent-version-changed` so the UI can
    // surface a banner — our hook scripts are version-tied to a
    // specific claude/gemini surface and a breaking bump silently
    // breaks the OSC 777 channel otherwise. Best-effort, never fatal.
    if let Some(store) = app.try_state::<crate::cmd_agent_versions::AgentVersionStore>() {
        store.record_and_check(&app, &agent_id, &bin);
    }

    if agent_id == "claude" {
        if let Some(cfg_path) = ensure_aura_mcp_config() {
            cmd.arg("--mcp-config");
            cmd.arg(cfg_path);
        }
        // Stamp the per-repo `.claude/settings.local.json` so claude
        // wires our six hook scripts (SessionStart/Stop/Notification/
        // PermissionRequest/UserPromptSubmit/PostToolUse) on its own.
        // Idempotent — re-staging overwrites the script bodies but the
        // settings merge de-dupes hook entries by exact path match.
        let _ = ensure_aura_claude_hooks_stamped(&repo_root);
    } else if agent_id == "gemini" {
        // Gemini uses its own extension system (not settings hooks);
        // staging into ~/.gemini/extensions/aura-gemini/ is enough for
        // the CLI to auto-load the extension at startup.
        let _ = ensure_aura_gemini_extension_stamped();
    }
    for (k, v) in &inv.env {
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
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        blocks: Mutex::new(Vec::new()),
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
                if let Some(sess) = registry.sessions.lock().unwrap().get(&id_for_task) {
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

            // Stream printable text into the open Output (or Prompt
            // when ;A has just opened one) block.
            if !perf.pending_text.is_empty() {
                if let Some(bid) = &cur_id {
                    let mut blocks = sess.blocks.lock().unwrap();
                    if let Some(b) = blocks.iter_mut().find(|b| &b.id == bid) {
                        b.text.push_str(&perf.pending_text);
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
                        BlockUpdate::Append {
                            block_id: bid.clone(),
                            text: perf.pending_text,
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
    let sessions = state.sessions.lock().unwrap();
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))?;
    let block_event = format!("agent-block:{session_id}");

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
    let _ = app.emit(
        &block_event,
        BlockUpdate::Open {
            block: output_block,
        },
    );

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
    write_prompt_bracketed(&sess.writer, &prompt).map_err(|e| e.to_string())?;
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
    // The daemon doesn't see Tauri-managed state, so we have to
    // assemble the env here and pass it across the wire. This is
    // the same set of vars `cmd.env(...)` would set on the in-process
    // child; the daemon's open_session forwards them to portable-pty
    // verbatim.
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
    *sess.last_append_ms.lock().unwrap() = None;
}

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
/// Conservative chunk size — under the typical termios cooked-mode
/// buffer (4096 on Linux, 1024 on macOS) so even worst-case kernels
/// don't drop bytes. Bracketed-paste markers wrap the whole sequence
/// so the agent reassembles them as one paste, regardless of chunking.
const PROMPT_CHUNK: usize = 1024;

fn write_prompt_bracketed(
    writer: &Mutex<Box<dyn Write + Send>>,
    prompt: &str,
) -> std::io::Result<()> {
    let bytes = prompt.as_bytes();
    let mut w = writer.lock().unwrap();
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
    w.write_all(b"\r")?;
    Ok(())
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
    let sessions = state.sessions.lock().unwrap();
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))?;
    let res = sess
        .writer
        .lock()
        .unwrap()
        .write_all(&data)
        .map_err(|e| e.to_string());
    res
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
        let _ = sess.child.lock().unwrap().kill();
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

/// vte Performer that strips ANSI/CSI down to printable text and
/// watches for two OSC families:
///   * OSC 133;D  — command-end with optional exit code (clean-room
///     reuse of the open prompt-marking standard).
///   * OSC 777;notify;aura://cli-agent;<json> — the structured
///     cli-agent notification protocol forked from Warp's MIT plugin
///     scripts (see `aura-shell/plugins/aura-claude/`). Only ;D is
///     honored for 133 — ;A and ;B are synthesized by `send_prompt` so
///     we never double-bracket if the agent echoes the prompt back.
#[derive(Default)]
struct OscPerf {
    pending_text: String,
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
    fn print(&mut self, c: char) {
        self.pending_text.push(c);
    }
    fn execute(&mut self, byte: u8) {
        // Keep the line-shaping bytes — without them the UI view collapses
        // multi-line answers into one wall of text. CSI/SGR/etc. are
        // handled in csi_dispatch (dropped) so we don't keep ESC junk.
        if byte == b'\n' || byte == b'\r' || byte == b'\t' {
            self.pending_text.push(byte as char);
        }
    }
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
