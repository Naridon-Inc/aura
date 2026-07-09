//! Aura engine commands — thin wrappers over the existing crates and a
//! generic CLI passthrough. The CLI passthrough is here on purpose: most
//! Aura operations already render rich human-readable output, and the
//! review panel can show that verbatim while we incrementally lift each
//! one to a typed structured command in later waves.
//!
//! Direct-from-engine commands (preferred):
//!   - aura_recent_blocks — pulls from BlockStore, no shell
//!
//! Shell passthroughs (transitional):
//!   - aura_cli         — `aura <args>` in repo cwd
//!   - aura_doctor_text — `aura doctor`
//!   - aura_impacts_text — `aura impacts list`

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use aura_blockstore::{BlockFilter, BlockStore};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct AuraBlock {
    pub id: String,
    pub kind: String,
    pub timestamp: i64,
    pub summary: String,
}

#[derive(Serialize)]
pub struct CliResult {
    pub stdout: String,
    pub stderr: String,
    pub status: i32,
}

#[derive(Serialize, Clone)]
pub struct AuraLiveProcessStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    /// Exit code of the last daemon that died on its own (not an explicit
    /// stop). `None` while running or after a clean user-initiated stop.
    pub exit_code: Option<i32>,
    /// Tail of the dead daemon's stderr — the actual reason the Go Live
    /// toggle flipped off, surfaced instead of swallowed. Cleared by an
    /// explicit stop or a successful restart.
    pub last_error: Option<String>,
}

/// How many trailing stderr lines we keep per live daemon. The daemon is
/// quiet in steady state; on a crash the useful context is the last few
/// lines (panic message, network error, watcher failure).
const LIVE_STDERR_TAIL_LINES: usize = 50;

struct LiveProcess {
    child: Child,
    started_at: u64,
    /// Ring of the daemon's most recent stderr lines, fed by a reader
    /// thread so the pipe never backs up. Read when `try_wait` discovers
    /// the child died, to explain *why* to the UI.
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

/// Why the last daemon for a repo died — kept after the child is reaped so
/// the next `aura_live_status` poll can carry the reason to the frontend.
#[derive(Clone, Default)]
struct LiveExit {
    exit_code: Option<i32>,
    last_error: Option<String>,
}

#[derive(Default)]
pub struct AuraLiveRegistry {
    by_root: Mutex<HashMap<String, LiveProcess>>,
    last_exit: Mutex<HashMap<String, LiveExit>>,
}

impl AuraLiveRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reap a dead child: snapshot its exit code + stderr tail into
    /// `last_exit` so status polls can explain the death.
    fn record_exit(&self, repo_root: &str, status: std::process::ExitStatus, proc: &LiveProcess) {
        let lines: Vec<String> = proc
            .stderr_tail
            .lock()
            .map(|t| t.iter().filter(|l| !l.trim().is_empty()).cloned().collect())
            .unwrap_or_default();
        let start = lines.len().saturating_sub(4);
        let msg = lines[start..].join("\n");
        let exit = LiveExit {
            exit_code: status.code(),
            last_error: if msg.is_empty() {
                Some(format!(
                    "aura live exited unexpectedly ({})",
                    status.code().map_or("killed by signal".to_string(), |c| format!("code {c}"))
                ))
            } else {
                Some(msg)
            },
        };
        if let Ok(mut m) = self.last_exit.lock() {
            m.insert(repo_root.to_string(), exit);
        }
    }

    fn take_exit(&self, repo_root: &str) -> LiveExit {
        self.last_exit
            .lock()
            .ok()
            .and_then(|m| m.get(repo_root).cloned())
            .unwrap_or_default()
    }

    fn clear_exit(&self, repo_root: &str) {
        if let Ok(mut m) = self.last_exit.lock() {
            m.remove(repo_root);
        }
    }
}

impl Drop for AuraLiveRegistry {
    fn drop(&mut self) {
        if let Ok(mut by_root) = self.by_root.lock() {
            for (_, mut proc) in by_root.drain() {
                let _ = proc.child.kill();
                let _ = proc.child.wait();
            }
        }
    }
}

/// Recent blocks from the workspace BlockStore. `limit` caps the list;
/// the React side typically asks for 20 to populate the timeline pane.
#[tauri::command]
pub async fn aura_recent_blocks(limit: usize) -> Result<Vec<AuraBlock>, String> {
    let db = home_db_path();
    if !db.exists() {
        return Ok(vec![]);
    }
    let store = BlockStore::open(&db).map_err(|e| e.to_string())?;
    let blocks = store
        .list_blocks(&BlockFilter::default())
        .map_err(|e| e.to_string())?;

    // Newest first — BlockStore order is insertion; reverse so the
    // pane shows the most recent activity at the top.
    let mut out: Vec<AuraBlock> = blocks
        .into_iter()
        .rev()
        .take(limit)
        .map(|b| {
            // Block layout varies across kinds; we surface enough to
            // identify the entry without copying massive payloads.
            // Use Debug for a stable, terse summary regardless of variant.
            let summary = format!("{:?}", b);
            // Truncate so the JSON IPC payload stays small.
            let summary = if summary.len() > 240 {
                format!("{}…", &summary[..240])
            } else {
                summary
            };
            AuraBlock {
                id: format!("{}", uuid::Uuid::new_v4()),
                kind: "block".to_string(),
                timestamp: 0,
                summary,
            }
        })
        .collect();
    out.shrink_to_fit();
    Ok(out)
}

/// Generic CLI passthrough. The frontend invokes Aura subcommands by
/// name; we run them in the project root and ferry stdout/stderr back.
/// Times out after 30s so a hung process can't block the IPC channel.
#[tauri::command]
pub async fn aura_cli(repo_root: String, args: Vec<String>) -> Result<CliResult, String> {
    let cwd = PathBuf::from(&repo_root);
    let out = Command::new("aura")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to spawn aura: {}", e))?;
    Ok(CliResult {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        status: out.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
pub async fn aura_live_start(
    repo_root: String,
    // collab=true → `aura live start --collab`: the CLI flips the
    // `.aura/live/crdt_enabled` marker so the whole-file CRDT daemon is the
    // sole disk writer (M1). The desktop "Go Live" always passes true; the
    // plain (function-body) live-sync mode stays reachable from the CLI.
    collab: bool,
    state: tauri::State<'_, AuraLiveRegistry>,
) -> Result<AuraLiveProcessStatus, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }

    let mut by_root = state
        .by_root
        .lock()
        .map_err(|_| "live registry lock poisoned".to_string())?;
    if let Some(proc) = by_root.get_mut(&repo_root) {
        match proc.child.try_wait() {
            Ok(None) => {
                return Ok(AuraLiveProcessStatus {
                    running: true,
                    pid: Some(proc.child.id()),
                    started_at: Some(proc.started_at),
                    exit_code: None,
                    last_error: None,
                });
            }
            Ok(Some(status)) => {
                if let Some(dead) = by_root.remove(&repo_root) {
                    state.record_exit(&repo_root, status, &dead);
                }
            }
            Err(e) => return Err(format!("failed to inspect aura live: {}", e)),
        }
    }

    let mut live_args: Vec<&str> = vec!["live", "start"];
    if collab {
        live_args.push("--collab");
    }
    // stderr is piped (NOT nulled) — when the daemon dies on launch (parser
    // init, watcher failure, relay auth), its last words are the only clue
    // the user gets. A reader thread drains the pipe into a small ring.
    let mut child = Command::new("aura")
        .args(&live_args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn aura live: {}", e))?;
    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut t) = tail.lock() {
                    if t.len() >= LIVE_STDERR_TAIL_LINES {
                        t.pop_front();
                    }
                    t.push_back(line);
                }
            }
        });
    }
    let pid = child.id();
    let started_at = now_unix_secs();
    // A fresh successful start supersedes any stale death report.
    state.clear_exit(&repo_root);
    by_root.insert(
        repo_root,
        LiveProcess {
            child,
            started_at,
            stderr_tail,
        },
    );
    Ok(AuraLiveProcessStatus {
        running: true,
        pid: Some(pid),
        started_at: Some(started_at),
        exit_code: None,
        last_error: None,
    })
}

#[tauri::command]
pub async fn aura_live_stop(
    repo_root: String,
    state: tauri::State<'_, AuraLiveRegistry>,
) -> Result<AuraLiveProcessStatus, String> {
    let mut by_root = state
        .by_root
        .lock()
        .map_err(|_| "live registry lock poisoned".to_string())?;
    if let Some(mut proc) = by_root.remove(&repo_root) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    // Killing the child stops the daemon but leaves the collab marker on
    // disk; clear it so Live-off cleanly reverts to plain git (the M1
    // `live_crdt_enabled()` gate would otherwise stay true). Mirrors what
    // `aura live stop` does via `set_crdt_enabled(false)`.
    let marker = PathBuf::from(&repo_root)
        .join(".aura")
        .join("live")
        .join("crdt_enabled");
    let _ = std::fs::remove_file(marker);
    // Explicit user stop — any prior death report is no longer interesting.
    state.clear_exit(&repo_root);
    Ok(AuraLiveProcessStatus {
        running: false,
        pid: None,
        started_at: None,
        exit_code: None,
        last_error: None,
    })
}

#[tauri::command]
pub async fn aura_live_status(
    repo_root: String,
    state: tauri::State<'_, AuraLiveRegistry>,
) -> Result<AuraLiveProcessStatus, String> {
    let mut by_root = state
        .by_root
        .lock()
        .map_err(|_| "live registry lock poisoned".to_string())?;
    if let Some(proc) = by_root.get_mut(&repo_root) {
        match proc.child.try_wait() {
            Ok(None) => {
                return Ok(AuraLiveProcessStatus {
                    running: true,
                    pid: Some(proc.child.id()),
                    started_at: Some(proc.started_at),
                    exit_code: None,
                    last_error: None,
                });
            }
            Ok(Some(status)) => {
                if let Some(dead) = by_root.remove(&repo_root) {
                    state.record_exit(&repo_root, status, &dead);
                }
            }
            Err(e) => return Err(format!("failed to inspect aura live: {}", e)),
        }
    }
    // Not running — if the daemon died on its own, carry the reason so the
    // frontend can explain the toggle flipping off instead of going mute.
    let exit = state.take_exit(&repo_root);
    Ok(AuraLiveProcessStatus {
        running: false,
        pid: None,
        started_at: None,
        exit_code: exit.exit_code,
        last_error: exit.last_error,
    })
}

/// Read the Team Radar (awareness plane) for a repo by shelling the `aura`
/// CLI's JSON surface. Returns the ambient feed plus reasoned collisions scored
/// against the caller's own in-flight work — the CLI does all the scoring and
/// noise-damping (self-skip, recency window, supersession, dedup), so the
/// desktop just renders. `include_possible` swaps in the fuller conflict list
/// that also carries the weak callgraph-ripple tier (off by default, mirroring
/// `aura radar conflicts --all`).
///
/// Best-effort: a repo with no awareness events — or an older bundled CLI that
/// predates the `radar` subcommand — yields an empty view rather than an error,
/// so the panel degrades quietly instead of throwing.
#[tauri::command]
pub async fn aura_radar(
    repo_root: String,
    include_possible: bool,
) -> Result<serde_json::Value, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }

    let empty = || {
        serde_json::json!({
            "repo": "",
            "branch": "",
            "events": [],
            "conflicts": [],
            "focus": { "files": [], "symbols": [] },
        })
    };

    // The feed + default (quiet) conflicts come from one call.
    let show = Command::new("aura")
        .args(["radar", "show", "--json"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to spawn aura radar: {}", e))?;
    if !show.status.success() {
        return Ok(empty());
    }
    let mut view: serde_json::Value = match serde_json::from_slice(&show.stdout) {
        Ok(v) => v,
        Err(_) => return Ok(empty()),
    };

    // Stamp the caller's own identity into the view so the frontend can
    // exclude self-authored events from presence pips. Mirrors the CLI's
    // conflict self-exclusion (`focus_from_repo` uses git user.name).
    if let Some(obj) = view.as_object_mut() {
        let me = Command::new("git")
            .args(["config", "user.name"])
            .current_dir(&cwd)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        obj.insert("me".into(), serde_json::json!(me));
    }

    // When the panel asks for ripples, swap in the fuller conflict list (the
    // ambient feed deliberately hides the Possible tier).
    if include_possible {
        if let Ok(conf) = Command::new("aura")
            .args(["radar", "conflicts", "--all", "--json"])
            .current_dir(&cwd)
            .output()
        {
            if conf.status.success() {
                if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&conf.stdout) {
                    if let Some(list) = parsed.get("conflicts").cloned() {
                        view["conflicts"] = list;
                    }
                }
            }
        }
    }

    Ok(view)
}

/// Read aura strict-mode posture from `~/.aura/credentials.json`. Returns
/// `"off"` when the flag is absent/false, `"on"` when set, `"locked"` when
/// a passcode hash is present (only a human with the passcode can flip
/// it back). The desktop pill in `StatusBar` and `SessionInfoCard` reads
/// this. We poll on a long cadence (120s) — the field rarely changes.
#[derive(Serialize)]
pub struct StrictMode {
    pub mode: String, // "off" | "on" | "locked"
}

#[tauri::command]
pub async fn aura_strict_mode() -> Result<StrictMode, String> {
    let creds = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h).join(".aura").join("credentials.json"),
        None => return Ok(StrictMode { mode: "off".into() }),
    };
    if !creds.exists() {
        return Ok(StrictMode { mode: "off".into() });
    }
    let raw = fs::read_to_string(&creds).map_err(|e| format!("read credentials: {}", e))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse credentials: {}", e))?;
    let on = v
        .get("strict_gatekeeper_mode")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let locked = v
        .get("strict_mode_passcode_hash")
        .map(|x| !x.is_null() && x.as_str().map(|s| !s.is_empty()).unwrap_or(false))
        .unwrap_or(false);
    let mode = match (on, locked) {
        (true, true) => "locked",
        (true, false) => "on",
        _ => "off",
    };
    Ok(StrictMode { mode: mode.into() })
}

/// Take a durable snapshot of `file_path` so `aura rewind` can recover
/// it later. Wraps the `aura snapshot create <file>` CLI. Wave B1 fires
/// this from `agentStreamStore.applyEvent` whenever Claude is about to
/// run an Edit/Write/MultiEdit tool — non-blocking, errors are logged
/// only, since a missed snapshot must never stall the live stream.
#[tauri::command]
pub async fn aura_snapshot(repo_root: String, file_path: String) -> Result<(), String> {
    let cwd = PathBuf::from(&repo_root);
    // Capture the snapshots dir listing before so we can find the new
    // entry afterwards and record it as the undo target.
    let snap_dir = cwd.join(".aura").join("snapshots");
    let before: std::collections::HashSet<PathBuf> = walk_files(&snap_dir);
    let out = Command::new("aura")
        .args(["snapshot", "create", &file_path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to spawn aura snapshot: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let after: std::collections::HashSet<PathBuf> = walk_files(&snap_dir);
    let new_files: Vec<PathBuf> = after.difference(&before).cloned().collect();
    // Most snapshot ops produce a single new blob; record each.
    for nf in &new_files {
        let rel = nf.strip_prefix(&cwd).unwrap_or(nf);
        let _ = crate::op_log::record_op(
            &repo_root,
            "snapshot",
            &format!("Snapshotted {}", file_path),
            "aura-shell",
            serde_json::json!({ "snapshot_path": rel.to_string_lossy() }),
        );
    }
    Ok(())
}

fn walk_files(root: &Path) -> std::collections::HashSet<PathBuf> {
    let mut out = std::collections::HashSet::new();
    if !root.is_dir() {
        return out;
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.insert(p);
            }
        }
    }
    out
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One file claimed by an intent. `status` mirrors git porcelain
/// (`M`, `A`, `D`, `R`, `?`). `additions`/`deletions` are optional —
/// callers that don't run numstat just leave them None.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IntentChangesetFile {
    pub path: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub additions: Option<u64>,
    #[serde(default)]
    pub deletions: Option<u64>,
    /// Commit sha that contributed this file, when the changeset was
    /// back-filled from git history. Lets the diff view show the real
    /// committed change (`git show <commit> -- <path>`) instead of an empty
    /// working-tree diff once the run has landed. None for live/manual claims
    /// where the change is still in the working tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// Diff-against baseline sha for a session whose work never landed as its
    /// own commit — a native Aura chat edits the working tree directly and
    /// keeps a per-turn `tree_commit` baseline rather than committing. When
    /// set, the diff view renders `git diff <base> -- <path>` (the file's net
    /// change from the session's first baseline to its current state), which
    /// stays correct whether the work is still uncommitted OR was later
    /// committed (a commit doesn't move the working tree). Mutually exclusive
    /// with `commit`; the Claude/back-filled path leaves it None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

/// Bound changeset claim attached to an intent log entry. `source`
/// distinguishes how the claim was made so the UI can render the right
/// affordances (e.g. agent-prompt intents show the originating prompt
/// block; manual ones show the user-typed text only).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct IntentChangeset {
    #[serde(default)]
    pub files: Vec<IntentChangesetFile>,
    #[serde(default)]
    pub block_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>, // "manual" | "agent_prompt" | "save_sync_gate"
    #[serde(default)]
    pub captured_at: Option<u64>,
}

/// Append an intent entry to `<repo>/.aura/intent_log.jsonl` and drop the
/// `.aura/.intent_logged` marker the pre-commit hook checks. Mirrors the
/// MCP `aura_log_intent` tool so the shell can satisfy the hook without
/// going through the daemon. `agent_id` defaults to "aura-shell".
///
/// `changeset` (optional) binds a set of file paths to this intent so the
/// UI can answer "which intent owns the change to file X?" without
/// guessing by timestamp. Two writers populate it today: the LogIntentDialog
/// (claim-on-changeset, source = "manual" or "save_sync_gate") and the
/// agent prompt path (source = "agent_prompt", carries `block_id`).
#[tauri::command]
pub async fn aura_log_intent(
    repo_root: String,
    intent: String,
    agent_id: Option<String>,
    changeset: Option<IntentChangeset>,
    claude_session_id: Option<String>,
) -> Result<u64, String> {
    let trimmed = intent.trim();
    if trimmed.is_empty() {
        return Err("intent is empty".into());
    }
    let aura_dir = PathBuf::from(&repo_root).join(".aura");
    fs::create_dir_all(&aura_dir).map_err(|e| format!("create .aura: {}", e))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut entry = serde_json::json!({
        "agent_id": agent_id.unwrap_or_else(|| "aura-shell".into()),
        "intent": trimmed,
        "timestamp": ts,
    });
    // Durable session↔intent link: stamp the active Claude session id when the
    // caller resolved one (the mutation-guard auto-stub does). Empty → skip, so
    // we never write a junk "" that the frontend would try to exact-match.
    if let Some(sid) = claude_session_id.as_deref().filter(|s| !s.is_empty()) {
        entry["claude_session_id"] = serde_json::json!(sid);
    }
    if let Some(mut cs) = changeset {
        if cs.captured_at.is_none() {
            cs.captured_at = Some(ts);
        }
        entry["changeset"] =
            serde_json::to_value(&cs).map_err(|e| format!("serialize changeset: {}", e))?;
    }

    let log_path = aura_dir.join("intent_log.jsonl");
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open intent_log: {}", e))?;
    writeln!(f, "{}", entry).map_err(|e| format!("write intent_log: {}", e))?;
    fs::write(aura_dir.join(".intent_logged"), "1").map_err(|e| format!("write marker: {}", e))?;
    let _ = crate::op_log::record_op(
        &repo_root,
        "log_intent",
        &format!("Logged intent: {}", &trimmed.chars().take(60).collect::<String>()),
        "aura-shell",
        serde_json::json!({ "intent_ts": ts }),
    );
    Ok(ts)
}

/// One row from `.aura/intent_log.jsonl` returned to the frontend. Mirrors
/// the on-disk JSON shape, with the freshness/coverage helpers below.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IntentRow {
    pub timestamp: u64,
    #[serde(default)]
    pub agent_id: String,
    pub intent: String,
    #[serde(default)]
    pub intent_type: Option<String>,
    #[serde(default)]
    pub signed_block_id: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub changeset: Option<IntentChangeset>,
    /// Claude Code session id (jsonl stem) stamped at log-intent time, when the
    /// writer could resolve the active session. Gives the Trace Session detail
    /// a durable link to the live transcript instead of guessing by timestamp.
    /// Absent on rows written before stamping shipped (those fall back to the
    /// time heuristic).
    #[serde(default)]
    pub claude_session_id: Option<String>,
    /// The human teammate this row is attributed to, resolved at read time by
    /// joining the row's signing `key_id` to `.aura/team/keys.jsonl` (and the
    /// friendlier roster name in `team/team.json`). NOT stored on disk — the
    /// JSONL only carries `agent_id` (which AI did the work) and `key_id`
    /// (whose key sealed it). The Team activity feed leads with this so every
    /// listing shows the *person* behind the AI, not just the AI. `None` when
    /// the row carries no `key_id` or no registered key matches it.
    #[serde(default)]
    pub developer: Option<String>,
    /// The teammate's git/commit email, when resolvable from the key registry.
    #[serde(default)]
    pub developer_email: Option<String>,
    /// The teammate's short handle (email local-part), for compact surfaces.
    #[serde(default)]
    pub developer_handle: Option<String>,
}

/// mtime-gated cache for the parsed intent log, keyed by repo_root →
/// (mtime_nanos, file_len, rows). The log is append-only and re-parsed in full
/// on every `aura_intent_recent` call (the Sessions/Trace pane drives several
/// per open); for a large log that JSONL parse is the dominant cost. Gating on
/// (mtime, len) instead of a TTL means a repeat open with an unchanged log is a
/// pure clone (no disk read, no parse), yet a freshly logged intent or a new
/// commit — which both append to the file, moving mtime AND len — invalidates
/// immediately. No staleness window, unlike the commit-index TTL above.
#[allow(clippy::type_complexity)]
fn intent_rows_cache() -> &'static Mutex<HashMap<String, (u128, u64, Vec<IntentRow>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u128, u64, Vec<IntentRow>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// File identity (mtime as unix-epoch nanos, byte length) used to validate the
/// intent-rows cache. Returns None when the file is absent or unstattable.
fn intent_log_stamp(path: &Path) -> Option<(u128, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((mtime, meta.len()))
}

/// Parse `.aura/intent_log.jsonl` into rows, served from an mtime-gated cache so
/// repeated Trace/Sessions opens against an unchanged log skip the disk parse.
fn read_intent_rows(repo_root: &str) -> Result<Vec<IntentRow>, String> {
    let path = PathBuf::from(repo_root).join(".aura").join("intent_log.jsonl");
    let stamp = match intent_log_stamp(&path) {
        Some(s) => s,
        None => return Ok(vec![]), // missing/unstattable → no rows
    };
    if let Ok(cache) = intent_rows_cache().lock() {
        if let Some((mtime, len, rows)) = cache.get(repo_root) {
            if (*mtime, *len) == stamp {
                return Ok(rows.clone());
            }
        }
    }
    let rows = parse_intent_rows(&path)?;
    if let Ok(mut cache) = intent_rows_cache().lock() {
        cache.insert(repo_root.to_string(), (stamp.0, stamp.1, rows.clone()));
    }
    Ok(rows)
}

/// Raw line-by-line JSONL parse — the cache miss path of `read_intent_rows`.
fn parse_intent_rows(path: &Path) -> Result<Vec<IntentRow>, String> {
    let f = fs::File::open(path).map_err(|e| format!("open intent_log: {}", e))?;
    let reader = BufReader::new(f);
    let mut rows: Vec<IntentRow> = Vec::new();
    for line in reader.lines().flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<IntentRow>(trimmed) {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// TTL cache for the per-branch blob union, keyed by `(repo_root, rel_path)`.
/// Branch tips change far less often than the Trace view polls, so a few
/// seconds of staleness is harmless and spares us re-shelling git for every
/// `aura_intent_recent` call.
fn branch_blob_cache() -> &'static Mutex<HashMap<(String, String), (u64, Vec<String>)>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), (u64, Vec<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const BRANCH_BLOB_TTL_SECS: u64 = 8;

/// Union the lines of a repo-relative file across EVERY branch tip (local +
/// remote refs), deduped by exact line. This is how the team-wide reads work
/// without checking out or merging each branch: a teammate on their own branch
/// commits `.aura` ledger rows into THAT branch's copy of the file, but the
/// shared git object store already holds every pushed branch's blobs, so we can
/// read them in place. Safe for append-only ledgers (intent log, key registry):
/// each branch tip is a superset of its own history, and identical rows across
/// branches are byte-identical (shared base) so they collapse on the line
/// dedupe. Served from a short TTL cache. Refs that lack the file are skipped.
fn union_branch_blob_lines(repo_root: &str, rel_path: &str) -> Vec<String> {
    let cache_key = (repo_root.to_string(), rel_path.to_string());
    let now = now_unix_secs();
    if let Ok(cache) = branch_blob_cache().lock() {
        if let Some((built_at, lines)) = cache.get(&cache_key) {
            if now.saturating_sub(*built_at) < BRANCH_BLOB_TTL_SECS {
                return lines.clone();
            }
        }
    }
    let refnames: Vec<String> = match Command::new("git")
        .args(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
        .current_dir(repo_root)
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for rf in refnames {
        // `origin/HEAD` is a symbolic alias for another ref we already read.
        if rf.ends_with("/HEAD") {
            continue;
        }
        let spec = format!("{}:{}", rf, rel_path);
        let show = Command::new("git")
            .args(["show", &spec])
            .current_dir(repo_root)
            .output();
        if let Ok(o) = show {
            if o.status.success() {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    let t = line.trim();
                    if t.is_empty() {
                        continue;
                    }
                    if seen.insert(t.to_string()) {
                        out.push(t.to_string());
                    }
                }
            }
        }
    }
    if let Ok(mut cache) = branch_blob_cache().lock() {
        cache.insert(cache_key, (now, out.clone()));
    }
    out
}

/// A stable fingerprint for de-duplicating an intent row seen on more than one
/// branch. Prefers the signed block id (globally unique per sealed block);
/// falls back to the natural key for unsigned rows.
fn intent_fingerprint(r: &IntentRow) -> String {
    if let Some(id) = r.signed_block_id.as_deref() {
        if !id.is_empty() {
            return format!("blk:{id}");
        }
    }
    let intent_head: String = r.intent.chars().take(80).collect();
    format!("{}|{}|{}", r.timestamp, r.agent_id, intent_head)
}

/// A text-based de-dup key for merging cloud-pulled intents against the local
/// ledger. The signed-block fingerprint can't be used across the cloud boundary
/// — a cloud row carries no `signed_block_id`, and its `timestamp` (server
/// insert time) and attribution differ from the local copy that produced it —
/// so we collapse on the normalized intent prose. This drops a teammate-pull
/// that echoes your own local row, at the cost of merging two genuinely-distinct
/// rows that happen to share the same opening 80 chars (rare, and they read as
/// the same "why" anyway).
fn intent_text_key(r: &IntentRow) -> String {
    r.intent
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect::<String>()
        .to_lowercase()
}

/// Map one cloud `/api/v2/intents` object to an `IntentRow`. The person is the
/// authenticated pusher the server stamped (`user` = github login), since cloud
/// rows carry no local signing `key_id`; the feed leads with that. Returns
/// `None` for a row with no usable intent text.
fn cloud_intent_to_row(it: &serde_json::Value) -> Option<IntentRow> {
    let intent = it
        .get("intent")
        .and_then(|v| v.as_str())
        .or_else(|| it.get("rationale").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    if intent.is_empty() {
        return None;
    }
    let timestamp = it
        .get("created_at")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp().max(0) as u64)
        .unwrap_or(0);
    let user = it
        .get("user")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty());
    Some(IntentRow {
        timestamp,
        // Which AI did it isn't carried over the cloud plane; the feed shows the
        // person (developer) for these, not an agent badge.
        agent_id: String::new(),
        intent,
        intent_type: None,
        signed_block_id: None,
        key_id: None,
        changeset: None,
        claude_session_id: None,
        developer: user.clone(),
        developer_email: None,
        developer_handle: user,
    })
}

/// Every intent row visible to this clone — the checked-out branch's working
/// tree (so uncommitted rows still show) PLUS every other branch's committed
/// log, unioned and de-duplicated. This is what makes a teammate's work on
/// their own branch appear in Team activity without first merging it: the
/// intent log is a per-branch file, but their rows live in the shared object
/// store the moment they push. Working-tree rows win ties (freshest copy).
fn read_intent_rows_all_branches(repo_root: &str) -> Vec<IntentRow> {
    let mut by_fp: HashMap<String, IntentRow> = HashMap::new();
    // Working tree first → its copy wins for any row also present on a branch.
    for r in read_intent_rows(repo_root).unwrap_or_default() {
        by_fp.entry(intent_fingerprint(&r)).or_insert(r);
    }
    for line in union_branch_blob_lines(repo_root, ".aura/intent_log.jsonl") {
        if let Ok(r) = serde_json::from_str::<IntentRow>(&line) {
            by_fp.entry(intent_fingerprint(&r)).or_insert(r);
        }
    }
    by_fp.into_values().collect()
}

/// One commit's diff summary, used to back-fill an intent row's changeset
/// from real git history when the on-disk entry bound no files. The file list
/// comes from a fast `git log --all --name-status` (no line-diffing); the
/// per-file +/- counts are filled in lazily, per contributing commit, by
/// `commit_numstat`. Cloned out of the TTL cache on each call.
#[derive(Clone)]
struct CommitDiff {
    sha: String,
    ts: u64,
    files: Vec<IntentChangesetFile>,
}

/// TTL cache for the commit index, keyed by repo_root → (built_at, commits).
/// The index is a `git log --all --name-status` snapshot; a few seconds of
/// staleness is harmless (the Trace view re-fetches on navigation and a fresh
/// commit lands on the next window), and the cache spares us re-shelling the
/// full `git log` on every `aura_intent_recent` call.
fn commit_index_cache() -> &'static Mutex<HashMap<String, (u64, Vec<CommitDiff>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, Vec<CommitDiff>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-commit numstat cache, keyed by `repo_root\0sha` → path → (adds, dels).
/// A commit's diff is immutable, so this is cached for the process lifetime.
fn commit_numstat_cache() -> &'static Mutex<HashMap<String, HashMap<String, (u64, u64)>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, HashMap<String, (u64, u64)>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const COMMIT_INDEX_TTL_SECS: u64 = 4;

/// The timestamp-ascending commit list, served from a short TTL cache. On a
/// cold/stale entry it rebuilds via `git log --all --name-status` — a name
/// list only, never line-diffing — which is two orders of magnitude faster
/// than the old `--numstat` index (~0.12s vs ~18.7s here). The +/- counts are
/// filled in lazily, per contributing commit, by `commit_numstat`.
fn commit_diff_index(repo_root: &str) -> Vec<CommitDiff> {
    let now = now_unix_secs();
    if let Ok(cache) = commit_index_cache().lock() {
        if let Some((built_at, commits)) = cache.get(repo_root) {
            if now.saturating_sub(*built_at) < COMMIT_INDEX_TTL_SECS {
                return commits.clone();
            }
        }
    }
    let commits = build_commit_index(repo_root);
    if let Ok(mut cache) = commit_index_cache().lock() {
        cache.insert(repo_root.to_string(), (now, commits.clone()));
    }
    commits
}

/// Parse `git log --all --name-status` into a timestamp-ascending commit list.
/// `--all` is deliberate: agent commits frequently live on a feature branch or
/// worktree HEAD that isn't reachable from the main repo's HEAD, but the object
/// store is shared so they still resolve here. `--no-renames` keeps each row a
/// plain `<STATUS>\t<path>` (no `a => b`) so parsing stays a simple tab split.
/// No `--numstat`: the whole point is to avoid line-diffing 2000 commits.
fn build_commit_index(repo_root: &str) -> Vec<CommitDiff> {
    let out = match Command::new("git")
        .args([
            "log",
            "--all",
            "--no-color",
            "--no-renames",
            "--format=@@C@@%H %ct",
            "--name-status",
            "-n",
            "2000",
        ])
        .current_dir(repo_root)
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut commits: Vec<CommitDiff> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("@@C@@") {
            let mut it = rest.splitn(2, ' ');
            let sha = it.next().unwrap_or("").to_string();
            let ts = it.next().unwrap_or("0").trim().parse::<u64>().unwrap_or(0);
            commits.push(CommitDiff { sha, ts, files: Vec::new() });
        } else if !line.trim().is_empty() {
            // name-status row: "<STATUS>\t<path>" — status is A/M/D/T (renames
            // are off), so we keep just the leading letter.
            let mut cols = line.splitn(2, '\t');
            let status = cols.next().unwrap_or("M").trim();
            let path = cols.next().unwrap_or("").trim();
            if path.is_empty() {
                continue;
            }
            let status = status
                .chars()
                .next()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "M".to_string());
            if let Some(c) = commits.last_mut() {
                c.files.push(IntentChangesetFile {
                    path: path.to_string(),
                    status,
                    additions: None,
                    deletions: None,
                    commit: None,
                    base: None,
                });
            }
        }
    }
    commits.sort_by(|a, b| a.ts.cmp(&b.ts));
    commits
}

/// Lazily line-count one commit's diff, `path -> (additions, deletions)`,
/// cached forever (an immutable diff). Excludes `.aura/**` so a
/// checkpoint-heavy commit never pays numstat on its bookkeeping blobs — that
/// exclusion is what keeps each call ~7ms instead of seconds. Only commits
/// that actually fall in an empty intent's window are ever counted.
fn commit_numstat(repo_root: &str, sha: &str) -> HashMap<String, (u64, u64)> {
    let key = format!("{repo_root}\0{sha}");
    if let Ok(cache) = commit_numstat_cache().lock() {
        if let Some(map) = cache.get(&key) {
            return map.clone();
        }
    }
    let mut map: HashMap<String, (u64, u64)> = HashMap::new();
    if let Ok(out) = Command::new("git")
        .args([
            "show",
            sha,
            "--no-color",
            "--no-renames",
            "--numstat",
            "--format=format:",
            "--",
            ".",
            ":(exclude,glob).aura/**",
        ])
        .current_dir(repo_root)
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                // numstat row: "adds<TAB>dels<TAB>path" ("-" for binary files).
                let mut cols = line.splitn(3, '\t');
                let adds = cols.next().unwrap_or("-");
                let dels = cols.next().unwrap_or("-");
                let path = cols.next().unwrap_or("").trim();
                if path.is_empty() {
                    continue;
                }
                map.insert(
                    path.to_string(),
                    (adds.parse::<u64>().unwrap_or(0), dels.parse::<u64>().unwrap_or(0)),
                );
            }
        }
    }
    if let Ok(mut cache) = commit_numstat_cache().lock() {
        cache.insert(key, map.clone());
    }
    map
}

/// Aura's own committed bookkeeping — the intent log itself and the
/// shadow-checkpoint store (sharded `<2-hex>/<uuid>/<n>/checkpoint.json` and
/// friends, some hundreds of thousands of lines). It rides along in the same
/// commits as real edits but isn't the author's work, so it must never land
/// in a synthesized changeset (it would bury the real files and explode the
/// +/- churn). Normal source never sits under a two-hex-char top directory
/// ending in one of these names, so the match is precise.
fn is_noise_path(p: &str) -> bool {
    if p == ".aura" || p.starts_with(".aura/") {
        return true;
    }
    let first = p.split('/').next().unwrap_or("");
    let hex2 = first.len() == 2 && first.bytes().all(|b| b.is_ascii_hexdigit());
    if hex2
        && (p.ends_with("/checkpoint.json")
            || p.ends_with("/session.json")
            || p.ends_with("/transcript.jsonl")
            || p.ends_with("/metadata.json"))
    {
        return true;
    }
    // Content-addressed checkpoint blobs: a bare 40/64-hex filename (a SHA with
    // no extension), often committed at the repo root and hundreds of thousands
    // of lines long. Real source always has a name + extension, never a bare
    // object hash, so this can't catch a legitimate file.
    let base = p.rsplit('/').next().unwrap_or("");
    (base.len() == 40 || base.len() == 64) && base.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Back-fill empty changesets by correlating each intent to the commit(s)
/// that landed just after it (after this intent, before the next one, capped
/// to a horizon so a logged-but-never-committed intent can't absorb an
/// unrelated commit hours later). Every file comes from the `--name-status`
/// index and every +/- count from that commit's own `git show --numstat`, so
/// this invents nothing: rows that already bound a changeset are left
/// untouched, and an intent with no commit in its window stays empty. The
/// synthesized claim is tagged `source: "git_commit"` and
/// carries the first commit sha in `block_id` so the UI can tell a
/// git-derived changeset from an agent-captured one.
///
/// Why this is needed: MCP `aura_log_intent` records only the reasoning +
/// signature (no diff), and the agent file-capture watches the main repo
/// working tree — but agent edits frequently land in a separate git worktree.
/// So the bound changeset is empty even though the work is real and committed.
fn backfill_changesets_from_git(repo_root: &str, rows: &mut [IntentRow]) {
    let needs = rows
        .iter()
        .any(|r| r.changeset.as_ref().map(|c| c.files.is_empty()).unwrap_or(true));
    if !needs {
        return;
    }
    let commits = commit_diff_index(repo_root);
    if commits.is_empty() {
        return;
    }

    // Distinct intent timestamps (ascending) bound each row's window upper.
    let mut ts_sorted: Vec<u64> = rows.iter().map(|r| r.timestamp).collect();
    ts_sorted.sort_unstable();
    ts_sorted.dedup();

    // A commit normally lands within minutes of the intent that drove it, so a
    // tight horizon keeps a per-commit cadence exact while stopping a sparsely
    // logged intent (no follow-up intent for hours) from absorbing unrelated
    // later commits. The window also closes at the next intent, whichever comes
    // first — so dense logging self-bounds.
    const WINDOW_CAP: u64 = 1800; // 30 min max horizon for a dangling intent.
    const SKEW: u64 = 120; // commit clock may trail the logged intent slightly.

    for r in rows.iter_mut() {
        let has_files = r.changeset.as_ref().map(|c| !c.files.is_empty()).unwrap_or(false);
        if has_files {
            continue;
        }
        let t = r.timestamp;
        let next = ts_sorted.iter().copied().find(|&x| x > t).unwrap_or(u64::MAX);
        let upper = next.min(t.saturating_add(WINDOW_CAP));
        let lower = t.saturating_sub(SKEW);

        // Union files across every commit in [lower, upper).
        let mut by_path: HashMap<String, IntentChangesetFile> = HashMap::new();
        let mut first_sha: Option<String> = None;
        let mut first_ts: Option<u64> = None;
        for c in &commits {
            if c.ts < lower || c.ts >= upper {
                continue;
            }
            // Real (non-bookkeeping) files this commit touched. A commit whose
            // every file is noise neither contributes nor pays for numstat.
            let real: Vec<&IntentChangesetFile> =
                c.files.iter().filter(|f| !is_noise_path(&f.path)).collect();
            if real.is_empty() {
                continue;
            }
            // Line-count this contributing commit lazily (cached). Only the
            // handful of commits inside an empty intent's window are counted —
            // not all 2000 in the index.
            let counts = commit_numstat(repo_root, &c.sha);
            for f in real {
                let e = by_path.entry(f.path.clone()).or_insert_with(|| IntentChangesetFile {
                    path: f.path.clone(),
                    status: f.status.clone(),
                    additions: None,
                    deletions: None,
                    // First commit in the window that touched this path — the
                    // diff view shows exactly this commit's change for the file.
                    commit: Some(c.sha.clone()),
                    base: None,
                });
                if let Some(&(a, d)) = counts.get(&f.path) {
                    e.additions = Some(e.additions.unwrap_or(0) + a);
                    e.deletions = Some(e.deletions.unwrap_or(0) + d);
                }
            }
            // First real-source commit in the window becomes the bound sha — a
            // checkpoint-only commit must never claim the intent.
            if first_sha.is_none() {
                first_sha = Some(c.sha.clone());
                first_ts = Some(c.ts);
            }
        }
        if by_path.is_empty() {
            continue;
        }
        let mut files: Vec<IntentChangesetFile> = by_path.into_values().collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        r.changeset = Some(IntentChangeset {
            files,
            block_id: first_sha,
            source: Some("git_commit".to_string()),
            captured_at: first_ts,
        });
    }
}

/// Return the N most recent intent log rows, newest first. The shell uses
/// this to (a) drive the History sidebar's intent panel and (b) check
/// "is there a fresh intent covering my dirty files?" before Save & Sync.
/// Rows that bound no changeset on disk are back-filled from real git history
/// so an agent's own committed sessions show their files (see
/// `backfill_changesets_from_git`).
#[tauri::command]
pub async fn aura_intent_recent(
    repo_root: String,
    limit: Option<usize>,
) -> Result<Vec<IntentRow>, String> {
    // Team-wide: union this branch's working tree with every other branch's
    // committed log, so a teammate working on their own branch is visible here
    // without first merging it.
    let mut rows = read_intent_rows_all_branches(&repo_root);

    // Login-gated team sync: when signed in to Aura, fold in teammates' intents
    // pulled from the cloud activity plane. On real product repos `.aura/` is
    // gitignored, so a teammate's "why" can't reach the local ledger via git —
    // this is the path that carries it (over Aura's cloud, not git). Signed out
    // → the pull returns empty → the feed stays local-only, the privacy default.
    // A cloud error also returns empty, so the feed never breaks on a hiccup.
    let cloud = crate::cloud_session_sync::pull_intents(std::path::Path::new(&repo_root), 200).await;
    if !cloud.is_empty() {
        let mut seen: std::collections::HashSet<String> =
            rows.iter().map(intent_text_key).collect();
        for it in &cloud {
            if let Some(row) = cloud_intent_to_row(it) {
                if seen.insert(intent_text_key(&row)) {
                    rows.push(row);
                }
            }
        }
    }

    rows.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    let cap = limit.unwrap_or(50).min(500);
    rows.truncate(cap);
    backfill_changesets_from_git(&repo_root, &mut rows);
    resolve_developers(&repo_root, &mut rows);
    Ok(rows)
}

/// One teammate identity resolved from the signed key registry: enough to
/// label "who" behind a sealed change, no crypto material.
struct KeyIdentity {
    email: Option<String>,
    display_name: Option<String>,
}

/// Build `key_id -> identity` from `.aura/team/keys.jsonl`, trusting only
/// rows whose ed25519 self-signature verifies (`TeamKeyEntry::verify_self_sig`).
///
/// This is a spoof gate, not decoration. The registry is a plain JSONL file
/// anyone with repo-write access can append to; a forged row under a victim's
/// `key_id` carrying an attacker-chosen `display_name`/`email` would otherwise
/// be shown verbatim as the author of that victim's sealed changes. Requiring
/// a valid self-signature makes a tampered or fabricated row inert — it can't
/// bind a name/email to a key it doesn't actually control, and it can't file
/// under a fingerprint that doesn't derive from its own pubkey. A row that
/// fails the check is dropped and that intent stays honestly unattributed
/// rather than mislabelled. Malformed lines are skipped silently (mirrors the
/// registry's own tolerance), so one bad row never blinds the whole map.
fn load_key_identities(repo_root: &str) -> HashMap<String, KeyIdentity> {
    use aura_attestation::team_keys::TeamKeyEntry;
    let path = PathBuf::from(repo_root)
        .join(".aura")
        .join("team")
        .join("keys.jsonl");
    let mut map: HashMap<String, KeyIdentity> = HashMap::new();
    let mut ingest = |t: &str, map: &mut HashMap<String, KeyIdentity>| {
        if t.is_empty() {
            return;
        }
        let Ok(entry) = serde_json::from_str::<TeamKeyEntry>(t) else {
            return;
        };
        // Only a cryptographically self-verified row may claim an identity.
        if !entry.verify_self_sig() {
            return;
        }
        // Append-only, first-write-wins per key_id (matches the registry).
        map.entry(entry.key_id).or_insert(KeyIdentity {
            email: entry.email,
            display_name: entry.display_name,
        });
    };
    // Working-tree copy first (this branch).
    if let Ok(raw) = fs::read_to_string(&path) {
        for line in raw.lines() {
            ingest(line.trim(), &mut map);
        }
    }
    // Then every other branch's published keys, so a teammate who self-published
    // their signing key on their own branch resolves here too.
    for line in union_branch_blob_lines(repo_root, ".aura/team/keys.jsonl") {
        ingest(line.trim(), &mut map);
    }
    map
}

/// Build `lowercased-email -> friendly roster name` from `team/team.json`, so
/// a resolved key email can borrow the nicer display name the roster already
/// shows in the header faces.
fn load_roster_names(repo_root: &str) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Member {
        #[serde(default)]
        email: Option<String>,
        #[serde(default)]
        name: Option<String>,
    }
    #[derive(Deserialize)]
    struct Team {
        #[serde(default)]
        members: Vec<Member>,
    }
    let path = PathBuf::from(repo_root)
        .join(".aura")
        .join("team")
        .join("team.json");
    let mut map: HashMap<String, String> = HashMap::new();
    let Ok(raw) = fs::read_to_string(&path) else {
        return map;
    };
    if let Ok(team) = serde_json::from_str::<Team>(&raw) {
        for m in team.members {
            if let (Some(email), Some(name)) = (m.email, m.name) {
                let name = name.trim();
                if !name.is_empty() {
                    map.insert(email.trim().to_lowercase(), name.to_string());
                }
            }
        }
    }
    map
}

/// Stamp each row's `developer*` fields by joining its signing `key_id` to the
/// key registry, preferring the roster's friendly name. Fills nothing when a
/// row has no `key_id` or no registered key matches — honest about unknown
/// authorship rather than guessing. Loads both small files once per call.
fn resolve_developers(repo_root: &str, rows: &mut [IntentRow]) {
    if rows.is_empty() {
        return;
    }
    let keys = load_key_identities(repo_root);
    if keys.is_empty() {
        return; // No published keys yet → no one to attribute to.
    }
    let roster = load_roster_names(repo_root);
    for row in rows.iter_mut() {
        let Some(key_id) = row.key_id.as_deref() else {
            continue;
        };
        let Some(ident) = keys.get(key_id) else {
            continue;
        };
        let email = ident.email.as_deref().map(|e| e.trim().to_lowercase());
        // Handle = email local-part, the same shape DevIdentity uses.
        let handle = email
            .as_deref()
            .and_then(|e| e.split('@').next())
            .map(|s| s.to_string());
        // Friendliest name available: roster name > registry display_name >
        // handle. Only the roster name is "nice"; the rest are honest fallbacks.
        let name = email
            .as_deref()
            .and_then(|e| roster.get(e).cloned())
            .or_else(|| {
                ident
                    .display_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
            .or_else(|| handle.clone());
        row.developer = name;
        row.developer_email = email;
        row.developer_handle = handle;
    }
}

/// Coverage summary: given the current dirty file set, return which paths
/// are claimed by some intent newer than the last commit, and which are
/// orphans. The Save & Sync gate uses this to decide whether to fire
/// directly or pop LogIntentDialog seeded with the orphans.
#[derive(Serialize, Debug)]
pub struct IntentCoverage {
    /// Paths claimed by at least one intent newer than the last commit.
    pub covered: Vec<String>,
    /// Paths with NO claim — Save & Sync should refuse for these.
    pub orphans: Vec<String>,
    /// Most recent intent timestamp, if any (so the UI can show "last
    /// intent at HH:MM" inline with the gate prompt).
    pub latest_intent_ts: Option<u64>,
    /// Unix timestamp of the most recent commit on HEAD; intents older
    /// than this are considered "already shipped" and don't count.
    pub last_commit_ts: Option<u64>,
}

fn last_commit_unix(repo_root: &str) -> Option<u64> {
    let out = Command::new("git")
        .args(["log", "-1", "--format=%ct"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().ok()
}

#[tauri::command]
pub async fn aura_intent_coverage(
    repo_root: String,
    dirty_paths: Vec<String>,
) -> Result<IntentCoverage, String> {
    let mut rows = read_intent_rows(&repo_root)?;
    rows.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    let last_commit_ts = last_commit_unix(&repo_root);
    let cutoff = last_commit_ts.unwrap_or(0);
    let fresh: Vec<&IntentRow> = rows.iter().filter(|r| r.timestamp > cutoff).collect();
    let latest_intent_ts = fresh.first().map(|r| r.timestamp);

    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in &fresh {
        if let Some(cs) = &r.changeset {
            for f in &cs.files {
                claimed.insert(f.path.clone());
            }
        }
    }
    let mut covered: Vec<String> = Vec::new();
    let mut orphans: Vec<String> = Vec::new();
    for p in dirty_paths {
        if claimed.contains(&p) {
            covered.push(p);
        } else {
            orphans.push(p);
        }
    }
    Ok(IntentCoverage { covered, orphans, latest_intent_ts, last_commit_ts })
}

/// Attribute additional file paths to an existing intent. Targets the
/// intent at `intent_ts` when set, otherwise the most recent row. Used by
/// option 2 (implicit-via-agent-prompt): when an agent's tool_use event
/// fires Edit/Write/MultiEdit, the resulting paths get appended to the
/// agent prompt's intent so the History sidebar can show "Gemini wrote
/// these 3 files for this prompt."
#[tauri::command]
pub async fn aura_intent_attribute(
    repo_root: String,
    file_paths: Vec<String>,
    intent_ts: Option<u64>,
) -> Result<u64, String> {
    if file_paths.is_empty() {
        return Err("file_paths is empty".into());
    }
    let path = PathBuf::from(&repo_root).join(".aura").join("intent_log.jsonl");
    if !path.exists() {
        return Err("intent_log.jsonl missing".into());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read log: {}", e))?;
    let mut rows: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if rows.is_empty() {
        return Err("intent log has no rows".into());
    }
    let target_idx = if let Some(ts) = intent_ts {
        rows.iter()
            .position(|r| r["timestamp"].as_u64() == Some(ts))
            .ok_or_else(|| format!("no intent at ts {}", ts))?
    } else {
        // Newest by timestamp — fallback to last-line if timestamps are
        // missing.
        let mut best: Option<(usize, u64)> = None;
        for (i, r) in rows.iter().enumerate() {
            let t = r["timestamp"].as_u64().unwrap_or(0);
            if best.map(|b| t >= b.1).unwrap_or(true) {
                best = Some((i, t));
            }
        }
        best.map(|b| b.0).ok_or_else(|| "no rows".to_string())?
    };
    let kept_ts = rows[target_idx]["timestamp"].as_u64().unwrap_or(0);

    // Merge: existing files + new paths, dedupe by path.
    let cs_val = rows[target_idx]
        .get("changeset")
        .cloned()
        .unwrap_or(serde_json::json!({"files": [], "source": "agent_prompt"}));
    let mut existing: Vec<IntentChangesetFile> = serde_json::from_value(
        cs_val.get("files").cloned().unwrap_or(serde_json::json!([])),
    )
    .unwrap_or_default();
    let attributed_paths = file_paths.clone();
    for p in file_paths {
        if !existing.iter().any(|f| f.path == p) {
            existing.push(IntentChangesetFile {
                path: p,
                status: "M".to_string(),
                additions: None,
                deletions: None,
                commit: None,
                base: None,
            });
        }
    }

    let mut new_cs = cs_val.clone();
    new_cs["files"] = serde_json::to_value(&existing).map_err(|e| e.to_string())?;
    if new_cs.get("source").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        new_cs["source"] = serde_json::json!("agent_prompt");
    }
    rows[target_idx]["changeset"] = new_cs;

    let mut out = String::new();
    for r in &rows {
        out.push_str(&r.to_string());
        out.push('\n');
    }
    fs::write(&path, out).map_err(|e| format!("write log: {}", e))?;
    let _ = crate::op_log::record_op(
        &repo_root,
        "intent_attribute",
        &format!("Attributed {} path(s) to intent #{}", attributed_paths.len(), kept_ts),
        "aura-shell",
        serde_json::json!({ "intent_ts": kept_ts, "file_paths": attributed_paths }),
    );
    Ok(kept_ts)
}

/// Split an intent into two by partitioning its changeset files. The
/// original row is rewritten in place with `keep_files`; a new row with a
/// fresh timestamp inherits the moved files + `new_intent` text.
#[tauri::command]
pub async fn aura_intent_split(
    repo_root: String,
    intent_ts: u64,
    keep_files: Vec<String>,
    move_files: Vec<String>,
    new_intent: String,
) -> Result<u64, String> {
    let path = PathBuf::from(&repo_root).join(".aura").join("intent_log.jsonl");
    if !path.exists() {
        return Err("intent_log.jsonl missing".into());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read log: {}", e))?;
    let mut rows: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    let target_idx = rows
        .iter()
        .position(|r| r["timestamp"].as_u64() == Some(intent_ts))
        .ok_or_else(|| format!("no intent at ts {}", intent_ts))?;

    let original = rows[target_idx].clone();
    let cs = original
        .get("changeset")
        .cloned()
        .unwrap_or(serde_json::json!({"files": []}));
    let files: Vec<IntentChangesetFile> = serde_json::from_value(
        cs.get("files").cloned().unwrap_or(serde_json::json!([])),
    )
    .map_err(|e| format!("parse files: {}", e))?;
    let original_files_json = serde_json::to_value(&files).unwrap_or(serde_json::json!([]));

    let keep: Vec<IntentChangesetFile> =
        files.iter().filter(|f| keep_files.contains(&f.path)).cloned().collect();
    let moved: Vec<IntentChangesetFile> =
        files.iter().filter(|f| move_files.contains(&f.path)).cloned().collect();

    rows[target_idx]["changeset"]["files"] =
        serde_json::to_value(&keep).map_err(|e| e.to_string())?;

    let new_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(intent_ts + 1);
    let new_ts = if new_ts <= intent_ts { intent_ts + 1 } else { new_ts };
    let mut new_row = serde_json::json!({
        "agent_id": original.get("agent_id").cloned().unwrap_or(serde_json::json!("aura-shell")),
        "intent": new_intent.trim(),
        "timestamp": new_ts,
        "changeset": {
            "files": moved,
            "source": "split",
            "captured_at": new_ts,
        },
    });
    if let Some(t) = original.get("intent_type").cloned() {
        new_row["intent_type"] = t;
    }
    rows.push(new_row);

    let mut out = String::new();
    for r in &rows {
        out.push_str(&r.to_string());
        out.push('\n');
    }
    fs::write(&path, out).map_err(|e| format!("write log: {}", e))?;
    let _ = crate::op_log::record_op(
        &repo_root,
        "intent_split",
        &format!("Split intent #{} → #{}", intent_ts, new_ts),
        "aura-shell",
        serde_json::json!({
            "kept_ts": intent_ts,
            "new_ts": new_ts,
            "original_files": original_files_json,
        }),
    );
    Ok(new_ts)
}

/// Merge two intents into one. The newer row is kept (timestamp + text),
/// receiving the union of both changesets; the older row is removed.
#[tauri::command]
pub async fn aura_intent_merge(
    repo_root: String,
    intent_ts_a: u64,
    intent_ts_b: u64,
) -> Result<u64, String> {
    let path = PathBuf::from(&repo_root).join(".aura").join("intent_log.jsonl");
    if !path.exists() {
        return Err("intent_log.jsonl missing".into());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read log: {}", e))?;
    let rows_in: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    let mut a = rows_in
        .iter()
        .find(|r| r["timestamp"].as_u64() == Some(intent_ts_a))
        .cloned()
        .ok_or_else(|| format!("no intent at ts {}", intent_ts_a))?;
    let b = rows_in
        .iter()
        .find(|r| r["timestamp"].as_u64() == Some(intent_ts_b))
        .cloned()
        .ok_or_else(|| format!("no intent at ts {}", intent_ts_b))?;

    let (newer, older) = if a["timestamp"].as_u64().unwrap_or(0)
        >= b["timestamp"].as_u64().unwrap_or(0)
    {
        (a.clone(), b.clone())
    } else {
        (b.clone(), a.clone())
    };
    let kept_ts = newer["timestamp"].as_u64().unwrap_or(0);
    let dropped_ts = older["timestamp"].as_u64().unwrap_or(0);
    // Capture pre-merge state for the op_log so undo can reverse this.
    let kept_text_pre = newer
        .get("intent")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let kept_files_pre = newer
        .get("changeset")
        .and_then(|c| c.get("files"))
        .cloned()
        .unwrap_or(serde_json::json!([]));
    let dropped_row_for_undo = older.clone();

    let mut files: Vec<IntentChangesetFile> = Vec::new();
    for src in [&newer, &older] {
        if let Some(cs) = src.get("changeset") {
            if let Some(arr) = cs.get("files").and_then(|v| v.as_array()) {
                for f in arr {
                    if let Ok(parsed) = serde_json::from_value::<IntentChangesetFile>(f.clone()) {
                        if !files.iter().any(|x| x.path == parsed.path) {
                            files.push(parsed);
                        }
                    }
                }
            }
        }
    }
    a = newer;
    a["intent"] = serde_json::json!(format!(
        "{}\n{}",
        a["intent"].as_str().unwrap_or(""),
        older["intent"].as_str().unwrap_or("")
    ).trim());
    a["changeset"] = serde_json::json!({
        "files": files,
        "source": "merge",
        "captured_at": kept_ts,
    });

    let mut out = String::new();
    for r in &rows_in {
        let ts = r["timestamp"].as_u64().unwrap_or(0);
        if ts == dropped_ts {
            continue;
        }
        if ts == kept_ts {
            out.push_str(&a.to_string());
        } else {
            out.push_str(&r.to_string());
        }
        out.push('\n');
    }
    fs::write(&path, out).map_err(|e| format!("write log: {}", e))?;
    let _ = crate::op_log::record_op(
        &repo_root,
        "intent_merge",
        &format!("Merged intent #{} into #{}", dropped_ts, kept_ts),
        "aura-shell",
        serde_json::json!({
            "kept_ts": kept_ts,
            "dropped_row": dropped_row_for_undo,
            "kept_text_pre": kept_text_pre,
            "kept_files_pre": kept_files_pre,
        }),
    );
    Ok(kept_ts)
}

fn home_db_path() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        let mut p = PathBuf::from(home);
        p.push(".aura");
        p.push("store.db");
        p
    } else {
        PathBuf::from(".aura/store.db")
    }
}

// ─── Live peers (cloud presence) ────────────────────────────────────────────
//
// The Go Live peers list used to read only LOCAL sentinel claims
// (`.aura/sentinel/claims/*.json`) — which an MCP agent on this machine
// writes. Another developer's laptop never appears there, so the panel sat
// on "waiting for peers…" forever even while both daemons were heartbeating
// happily. Cross-machine presence lives in Aura Cloud: the live daemon POSTs
// /api/v1/live/heartbeat every 30s and this query reads the assembled roster
// back. Same token file as the daemon (~/.aura/credentials.json), so one
// desktop sign-in lights up both halves.

#[derive(Serialize)]
pub struct AuraCloudPeer {
    pub username: String,
    pub avatar: Option<String>,
    pub branch: String,
    /// RFC3339 timestamp from the cloud — the frontend computes staleness.
    pub last_seen: String,
    pub active_functions: Vec<String>,
    /// This row is the signed-in user's own session (possibly this machine).
    pub is_self: bool,
}

#[derive(Serialize)]
pub struct AuraLivePeersResult {
    /// false → presence can't be queried at all; `reason` says why, so the
    /// UI can explain instead of showing an eternal "waiting for peers…".
    pub available: bool,
    pub reason: Option<String>,
    pub peers: Vec<AuraCloudPeer>,
}

#[tauri::command]
pub async fn aura_live_peers(repo_root: String) -> Result<AuraLivePeersResult, String> {
    let unavailable = |reason: String| AuraLivePeersResult {
        available: false,
        reason: Some(reason),
        peers: Vec::new(),
    };
    let creds = crate::cloud_session_sync::read_credentials().unwrap_or_default();
    let token = match crate::cloud_session_sync::cloud_token(&creds) {
        Some(t) => t,
        None => {
            return Ok(unavailable(
                "not signed in to Aura Cloud — peer presence needs a cloud account".into(),
            ))
        }
    };
    let repo = match crate::cloud_session_sync::resolve_repo_full_name(Path::new(&repo_root)) {
        Some(r) => r,
        None => {
            return Ok(unavailable(
                "no GitHub origin remote — presence is keyed by owner/repo".into(),
            ))
        }
    };
    let self_user = creds
        .get("cloud_user")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let origin = crate::cloud_session_sync::cloud_origin(&creds);
    let url = format!("{}/api/v1/live/presence?repo={}", origin, repo);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = match client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return Ok(unavailable(format!("cloud presence returned {}", r.status()))),
        Err(e) => return Ok(unavailable(format!("cloud unreachable: {e}"))),
    };
    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("presence parse: {e}"))?;
    let peers = data["developers"]
        .as_array()
        .map(|devs| {
            devs.iter()
                .map(|d| {
                    let username = d["username"].as_str().unwrap_or("?").to_string();
                    AuraCloudPeer {
                        is_self: !self_user.is_empty() && username == self_user,
                        avatar: d["avatar"].as_str().map(str::to_string),
                        branch: d["branch"].as_str().unwrap_or("").to_string(),
                        last_seen: d["last_seen"].as_str().unwrap_or("").to_string(),
                        active_functions: d["active_functions"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|f| {
                                        // Cloud stores either bare strings or
                                        // {name} objects depending on version.
                                        f["name"]
                                            .as_str()
                                            .or_else(|| f.as_str())
                                            .map(str::to_string)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        username,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(AuraLivePeersResult {
        available: true,
        reason: None,
        peers,
    })
}
