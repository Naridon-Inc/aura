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
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    by_root: Arc<Mutex<HashMap<String, LiveProcess>>>,
    last_exit: Arc<Mutex<HashMap<String, LiveExit>>>,
}

impl AuraLiveRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reap a dead child: snapshot its exit code + stderr tail into
    /// `last_exit` so status polls can explain the death.
    fn record_exit(
        last_exit: &Mutex<HashMap<String, LiveExit>>,
        repo_root: &str,
        status: std::process::ExitStatus,
        proc: &LiveProcess,
    ) {
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
        if let Ok(mut m) = last_exit.lock() {
            m.insert(repo_root.to_string(), exit);
        }
    }

    fn take_exit(last_exit: &Mutex<HashMap<String, LiveExit>>, repo_root: &str) -> LiveExit {
        last_exit
            .lock()
            .ok()
            .and_then(|m| m.get(repo_root).cloned())
            .unwrap_or_default()
    }

    fn clear_exit(last_exit: &Mutex<HashMap<String, LiveExit>>, repo_root: &str) {
        if let Ok(mut m) = last_exit.lock() {
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
    crate::blocking::run(move || {
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
                    format!("{}…", crate::text::clip(&summary, 240))
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
    })
    .await
}

/// How long a passthrough CLI call may run before we stop waiting for
/// it. Long enough for a real scan on a big repo, short enough that a
/// wedged helper doesn't leave the surface that called it spinning.
const AURA_CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// The Aura verbs worth a product event: the ones that mean somebody used
/// what makes Aura *Aura*. Everything else the app shells out for — status
/// probes, version checks, list reads it refreshes on every mount — is
/// polling, and counting it would bury the signal this is here to carry.
/// Adding a verb is a one-line change; that is the point of the list.
const TRACKED_VERBS: &[&str] = &[
    "prove",
    "pr-review",
    "rewind",
    "log-intent",
    "sign-intent",
    "plan",
    "crew",
    "handover",
    "atlas",
    "bundle",
    "work",
    "intent-vs-actual",
    "attest",
];

/// Record that an Aura verb ran. The verb alone — never the arguments,
/// which carry symbol names, goals and paths.
fn track_aura_verb(verb: Option<&str>) {
    let Some(verb) = verb.and_then(crate::telemetry_guard::safe_token) else {
        return;
    };
    if !TRACKED_VERBS.contains(&verb.as_str()) {
        return;
    }
    crate::telemetry::track("aura_command", Some(serde_json::json!({ "verb": verb })));
}

/// Generic CLI passthrough. The frontend invokes Aura subcommands by
/// name; we run them in the project root and ferry stdout/stderr back.
/// Times out after 30s so a hung process can't block the IPC channel.
#[tauri::command]
pub async fn aura_cli(repo_root: String, args: Vec<String>) -> Result<CliResult, String> {
    track_aura_verb(args.first().map(String::as_str));
    let cwd = PathBuf::from(&repo_root);
    // tokio's Command rather than std's: waiting on the child parks this
    // task instead of holding one of the runtime's worker threads. The
    // whole app shares that pool, so a helper that never returns used to
    // take a worker with it — enough of those and every other command in
    // the app stops being served too. `kill_on_drop` is what makes the
    // timeout below real: on expiry the child is reaped, not orphaned.
    let run = tokio::process::Command::new(crate::agent_event_listener::resolve_aura_bin())
        .args(&args)
        .current_dir(&cwd)
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(AURA_CLI_TIMEOUT, run).await {
        Ok(res) => res.map_err(|e| format!("failed to spawn aura: {}", e))?,
        Err(_) => {
            return Err(
                "That took longer than 30 seconds, so Aura stopped waiting. Try again in a moment."
                    .to_string(),
            )
        }
    };
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
    let by_root = Arc::clone(&state.by_root);
    let last_exit = Arc::clone(&state.last_exit);
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        if !cwd.is_dir() {
            return Err(format!("repo root does not exist: {}", repo_root));
        }

        let mut by_root = by_root
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
                        AuraLiveRegistry::record_exit(&last_exit, &repo_root, status, &dead);
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
        let mut child = Command::new(crate::agent_event_listener::resolve_aura_bin())
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
        AuraLiveRegistry::clear_exit(&last_exit, &repo_root);
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
    })
    .await
}

#[tauri::command]
pub async fn aura_live_stop(
    repo_root: String,
    state: tauri::State<'_, AuraLiveRegistry>,
) -> Result<AuraLiveProcessStatus, String> {
    let by_root = Arc::clone(&state.by_root);
    let last_exit = Arc::clone(&state.last_exit);
    crate::blocking::run(move || {
        let mut by_root = by_root
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
        AuraLiveRegistry::clear_exit(&last_exit, &repo_root);
        Ok(AuraLiveProcessStatus {
            running: false,
            pid: None,
            started_at: None,
            exit_code: None,
            last_error: None,
        })
    })
    .await
}

#[tauri::command]
pub async fn aura_live_status(
    repo_root: String,
    state: tauri::State<'_, AuraLiveRegistry>,
) -> Result<AuraLiveProcessStatus, String> {
    let by_root = Arc::clone(&state.by_root);
    let last_exit = Arc::clone(&state.last_exit);
    crate::blocking::run(move || {
        let mut by_root = by_root
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
                        AuraLiveRegistry::record_exit(&last_exit, &repo_root, status, &dead);
                    }
                }
                Err(e) => return Err(format!("failed to inspect aura live: {}", e)),
            }
        }
        // Not running — if the daemon died on its own, carry the reason so the
        // frontend can explain the toggle flipping off instead of going mute.
        let exit = AuraLiveRegistry::take_exit(&last_exit, &repo_root);
        Ok(AuraLiveProcessStatus {
            running: false,
            pid: None,
            started_at: None,
            exit_code: exit.exit_code,
            last_error: exit.last_error,
        })
    })
    .await
}

/// Hard wall-clock bound for a single radar shell-out. Must stay BELOW the
/// panel's poll interval (`POLL_MS = 6000` in `useTeamRadar.ts`) so a slow run
/// is abandoned before the next tick starts and polls can never overlap.
const RADAR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Run a short-lived query with a hard timeout, killing the child if it
/// overruns, and return its stdout only on a clean exit.
///
/// `Command::output()` waits forever. The Team Radar polls every 6 seconds, so
/// when `aura radar` got slow, every tick left another process behind: 13 live
/// `aura radar show --json` processes holding ~20 GB resident were observed on a
/// developer machine, none of them ever returning an answer. Bounding the wait
/// makes a bad run cost one timeout instead of an unbounded pile of processes.
///
/// stdout is drained on a side thread so a child that outgrows the pipe buffer
/// can never deadlock against our exit polling.
fn run_bounded(cmd: &mut Command, timeout: std::time::Duration) -> Option<Vec<u8>> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    let buf = reader.join().unwrap_or_default();
    match status {
        Some(s) if s.success() => Some(buf),
        _ => None,
    }
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
    crate::blocking::run(move || {
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
        let mut show_cmd = Command::new(crate::agent_event_listener::resolve_aura_bin());
        show_cmd.args(["radar", "show", "--json"]).current_dir(&cwd);
        let Some(stdout) = run_bounded(&mut show_cmd, RADAR_TIMEOUT) else {
            return Ok(empty());
        };
        let mut view: serde_json::Value = match serde_json::from_slice(&stdout) {
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
            let mut conf_cmd = Command::new(crate::agent_event_listener::resolve_aura_bin());
            conf_cmd
                .args(["radar", "conflicts", "--all", "--json"])
                .current_dir(&cwd);
            if let Some(out) = run_bounded(&mut conf_cmd, RADAR_TIMEOUT) {
                if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&out) {
                    if let Some(list) = parsed.get("conflicts").cloned() {
                        view["conflicts"] = list;
                    }
                }
            }
        }

        Ok(view)
    })
    .await
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
    crate::blocking::run(move || {
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
    })
    .await
}

/// Take a durable snapshot of `file_path` so `aura rewind` can recover
/// it later. Wraps the `aura snapshot create <file>` CLI. Wave B1 fires
/// this from `agentStreamStore.applyEvent` whenever Claude is about to
/// run an Edit/Write/MultiEdit tool — non-blocking, errors are logged
/// only, since a missed snapshot must never stall the live stream.
#[tauri::command]
pub async fn aura_snapshot(repo_root: String, file_path: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        // Capture the snapshots dir listing before so we can find the new
        // entry afterwards and record it as the undo target.
        let snap_dir = cwd.join(".aura").join("snapshots");
        let before: std::collections::HashSet<PathBuf> = walk_files(&snap_dir);
        let out = Command::new(crate::agent_event_listener::resolve_aura_bin())
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
    })
    .await
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

/// A symbol that changed within a file, carried directly on a bound
/// changeset. The Time machine normally resolves changed symbols from a
/// commit's change-note (`aura change-note <sha>`); a changeset that embeds
/// its own symbols lets the surgical "Bring this back" affordance render
/// without a per-change sha — the case for the bundled sample, whose history
/// is squashed to a single commit. Minimal by design: identifier/kind/change
/// are everything the recovery UI reads.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChangesetSymbol {
    pub identifier: String,
    #[serde(default)]
    pub kind: String,
    /// "added" | "modified" | "deleted".
    #[serde(default)]
    pub change: String,
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
    /// Changed symbols carried directly on this file, for surfaces with no
    /// per-change commit sha to resolve them from (see `ChangesetSymbol`).
    /// Empty for the normal git-backed path, so it never appears on the wire
    /// unless a changeset deliberately seeds it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub symbols: Vec<ChangesetSymbol>,
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
    /// This file's change is known from the team plane, not from this clone —
    /// a teammate's intent pulled over the cloud, whose commit may not be
    /// fetched here (and whose `.aura/` ledger is gitignored on most repos, so
    /// it can't arrive by git either). We know WHICH file and WHICH symbols
    /// changed; we do not have the patch.
    ///
    /// The flag exists because the alternative is worse than silence. With no
    /// `commit` and no `base`, the diff view falls through to
    /// `git diff HEAD -- <path>` — the *viewer's own* uncommitted edits to that
    /// path — and prints them under the teammate's name. Set here, the view
    /// shows what actually changed and says the patch isn't in this clone.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remote_only: bool,
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

/// Seal an intent into a signed block by shelling out to `aura sign-intent`
/// in the repo root, returning `(signed_block_id, key_id)` on success.
///
/// This is how a native Aura-chat turn gets the SAME signed attestation the
/// MCP / Claude-Code capture path produces: one shared signing surface (the
/// `aura` CLI), identical block shape + `.aura/attest/` mirror + key registry.
/// Every failure mode — binary absent, non-zero exit, unparseable stdout, or
/// `{}` (no signing key) — collapses to `None`, so the caller's unsigned JSONL
/// path is never broken. The JSONL row itself is still written by the caller,
/// so there is exactly one intent row per capture regardless of the seal.
fn sign_intent_via_cli(
    repo_root: &str,
    intent: &str,
    writes: &[String],
) -> Option<(String, String)> {
    let mut args: Vec<String> = vec![
        "sign-intent".into(),
        intent.into(),
        "--agent".into(),
        "aura-shell".into(),
    ];
    for w in writes {
        args.push("--writes".into());
        args.push(w.clone());
    }
    let out = Command::new(crate::agent_event_listener::resolve_aura_bin())
        .args(&args)
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let block_id = parsed.get("signed_block_id")?.as_str()?.to_string();
    let key_id = parsed
        .get("key_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Some((block_id, key_id))
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
    crate::blocking::run(move || {
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
        let mut declared_writes: Vec<String> = Vec::new();
        if let Some(mut cs) = changeset {
            if cs.captured_at.is_none() {
                cs.captured_at = Some(ts);
            }
            // Files the agent claims it touched become the declared write-scope for
            // the signed block. Skip deletes (status "D") — the commit-time
            // reconciler measures actual writes as added/modified/renamed paths, so
            // a declared delete would never be "fulfilled" and only adds noise.
            declared_writes = cs
                .files
                .iter()
                .filter(|f| f.status != "D")
                .map(|f| f.path.clone())
                .filter(|p| !p.is_empty())
                .collect();
            entry["changeset"] =
                serde_json::to_value(&cs).map_err(|e| format!("serialize changeset: {}", e))?;
        }

        // Seal the intent into a signed block via the shared `aura sign-intent`
        // primitive so a native Aura-chat turn produces the SAME signed attestation
        // the MCP / Claude-Code capture path does. Stamp the returned ids into this
        // row so the Trace/Team surfaces show the seal and the commit-time
        // reconciler has a declared scope to check against. Best-effort — an
        // unsigned row (no key / no binary) is exactly the pre-existing behaviour.
        if let Some((block_id, key_id)) = sign_intent_via_cli(&repo_root, trimmed, &declared_writes) {
            entry["signed_block_id"] = serde_json::json!(block_id);
            if !key_id.is_empty() {
                entry["key_id"] = serde_json::json!(key_id);
            }
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
        // Intent is the thing Aura is *for*, and nothing counted it. Whether
        // the row was signed says whether the attestation path is actually
        // working in the field. The intent text itself never leaves the
        // machine.
        crate::telemetry::track(
            "intent_logged",
            Some(serde_json::json!({
                "signed": entry.get("signed_block_id").is_some(),
                "has_changeset": !declared_writes.is_empty(),
            })),
        );
        crate::telemetry::track_activation("intent_logged");
        Ok(ts)
    })
    .await
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

/// A cloud row's `file_path`, as this clone would name it.
///
/// The path was recorded on the teammate's machine, so an absolute one names
/// *their* checkout — `/Users/sam/code/aura/aura-shell/src/App.tsx` — and is
/// meaningless here. The repo-relative tail is the part every clone shares, so
/// we take the longest suffix that actually resolves under this repo root.
/// Longest-first matters: `src/App.tsx` may exist by coincidence when the real
/// file is `aura-shell/src/App.tsx`, and the longer match is the true one.
///
/// A path that resolves to nothing comes back unchanged. The file may simply
/// not be in this clone yet — a branch nobody here has fetched — and naming it
/// honestly beats silently naming a different file.
fn remote_repo_path(repo_root: &str, raw: &str) -> String {
    let cleaned = raw.trim().replace('\\', "/");
    let cleaned = cleaned.trim_start_matches("./").to_string();
    // Windows drive letters (`C:/…`) are absolute too.
    let absolute = cleaned.starts_with('/') || cleaned.as_bytes().get(1) == Some(&b':');
    if !absolute {
        return cleaned;
    }
    let root = PathBuf::from(repo_root);
    let segs: Vec<&str> = cleaned.split('/').filter(|s| !s.is_empty()).collect();
    for start in 0..segs.len() {
        let candidate = segs[start..].join("/");
        if root.join(&candidate).exists() {
            return candidate;
        }
    }
    cleaned
}

/// The one file a cloud intent object claims, with the symbols it moved.
///
/// `live_events` rows are per-file — the server stores the path and an array of
/// `{name, kind, change_type}` — which is exactly a changeset file minus the
/// line counts. Returns `None` when the row names no usable source file, so a
/// bookkeeping path never becomes a changeset entry.
fn cloud_intent_file(repo_root: &str, it: &serde_json::Value) -> Option<IntentChangesetFile> {
    let raw = it.get("file_path").and_then(|v| v.as_str())?.trim();
    if raw.is_empty() {
        return None;
    }
    let path = remote_repo_path(repo_root, raw);
    if path.is_empty() || is_noise_path(&path) {
        return None;
    }
    let mut symbols: Vec<ChangesetSymbol> = Vec::new();
    let (mut added, mut deleted, mut other) = (0usize, 0usize, 0usize);
    for c in it
        .get("changes")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let field = |k: &str| {
            c.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let change = field("change_type");
        match change.as_str() {
            "added" => added += 1,
            "deleted" => deleted += 1,
            _ => other += 1,
        }
        let identifier = field("name");
        if !identifier.is_empty() {
            symbols.push(ChangesetSymbol {
                identifier,
                kind: field("kind"),
                change,
            });
        }
    }
    // Porcelain status for the whole file: only a file whose every recorded
    // change is an add (or every one a delete) is an add (or delete) — anything
    // mixed, or unlabelled, is a modification.
    let status = if other == 0 && deleted == 0 && added > 0 {
        "A"
    } else if other == 0 && added == 0 && deleted > 0 {
        "D"
    } else {
        "M"
    };
    Some(IntentChangesetFile {
        path,
        status: status.to_string(),
        // The cloud plane records which symbols moved, never line counts.
        // Leaving these None is what keeps "+0 −0" off the row.
        additions: None,
        deletions: None,
        symbols,
        commit: None,
        base: None,
        remote_only: true,
    })
}

/// How far apart two cloud rows may sit and still be one intent. Matches the
/// back-fill horizon (`WINDOW_CAP`): a run's file saves land within minutes of
/// each other, and the same prose logged again the next day is a new session.
const CLOUD_GROUP_WINDOW_SECS: u64 = 1800;

/// Fold the cloud's per-file rows back into one row per intent, carrying the
/// changeset the plane already knows.
///
/// The server stores a *file save*, not a logged intent: one `aura log-intent`
/// across six files arrives as six objects sharing a rationale. Mapping them
/// one-to-one and de-duplicating on the prose (which `aura_intent_recent` does)
/// therefore kept the first file and dropped the other five — and since the
/// mapper set `changeset: None`, even that one never reached the Changes tab.
/// A teammate's session showed a summary and a transcript and nothing else, on
/// every session, forever.
///
/// Rows arrive newest-first, so a group's head is its newest member and the
/// window closes downward from there.
fn cloud_intents_to_rows(repo_root: &str, items: &[serde_json::Value]) -> Vec<IntentRow> {
    let mut out: Vec<IntentRow> = Vec::new();
    // (person, normalized prose) → index of the open group's row in `out`.
    let mut open: HashMap<(String, String), usize> = HashMap::new();

    for it in items {
        let Some(mut row) = cloud_intent_to_row(it) else {
            continue;
        };
        let file = cloud_intent_file(repo_root, it);
        let key = (
            row.developer_handle.clone().unwrap_or_default(),
            intent_text_key(&row),
        );

        if let Some(&idx) = open.get(&key) {
            let head = &mut out[idx];
            if head.timestamp.saturating_sub(row.timestamp) <= CLOUD_GROUP_WINDOW_SECS {
                if let Some(f) = file {
                    let cs = head.changeset.get_or_insert_with(|| IntentChangeset {
                        files: Vec::new(),
                        block_id: None,
                        source: Some("cloud_activity".to_string()),
                        captured_at: Some(head.timestamp),
                    });
                    // The same file saved twice in one run is one changed file.
                    match cs.files.iter_mut().find(|e| e.path == f.path) {
                        Some(existing) => {
                            for s in f.symbols {
                                if !existing.symbols.iter().any(|e| e.identifier == s.identifier) {
                                    existing.symbols.push(s);
                                }
                            }
                        }
                        None => cs.files.push(f),
                    }
                }
                continue;
            }
        }

        if let Some(f) = file {
            row.changeset = Some(IntentChangeset {
                files: vec![f],
                block_id: None,
                source: Some("cloud_activity".to_string()),
                captured_at: Some(row.timestamp),
            });
        }
        out.push(row);
        open.insert(key, out.len() - 1);
    }
    out
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
                    symbols: Vec::new(),
                    commit: None,
                    base: None,
                    remote_only: false,
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
                    symbols: Vec::new(),
                    // First commit in the window that touched this path — the
                    // diff view shows exactly this commit's change for the file.
                    commit: Some(c.sha.clone()),
                    base: None,
                    remote_only: false,
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
/// Hard ceiling on how many intent rows one read may return.
///
/// A ceiling has to exist — the log is append-only and a long-lived repo's is
/// unbounded, and every row returned is serialised across IPC. But it used to
/// be 500, which is below what the surfaces that want the whole history ask
/// for: the year-in-review and the overview both request 5000. They were
/// silently handed the newest 500 and had no way to know, so on any repo past
/// 500 intents the year picker only offered years that appear in the recent
/// tail and every "this year" number was really "the part of this year inside
/// the last 500 entries".
///
/// Raising it is close to free: the expensive work — unioning the log across
/// every branch tip, and the cloud pull — happens before the truncate and does
/// not depend on this number.
const INTENT_ROW_CEILING: usize = 5000;

/// How many rows to keep for a caller that asked for `limit`.
fn intent_row_cap(limit: Option<usize>) -> usize {
    limit.unwrap_or(50).min(INTENT_ROW_CEILING)
}

#[tauri::command]
pub async fn aura_intent_recent(
    repo_root: String,
    limit: Option<usize>,
) -> Result<Vec<IntentRow>, String> {
    // Team-wide: union this branch's working tree with every other branch's
    // committed log, so a teammate working on their own branch is visible here
    // without first merging it.
    let read_root = repo_root.clone();
    let mut rows =
        crate::blocking::run(move || read_intent_rows_all_branches(&read_root)).await;

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
        for row in cloud_intents_to_rows(&repo_root, &cloud) {
            if seen.insert(intent_text_key(&row)) {
                rows.push(row);
            }
        }
    }

    crate::blocking::run(move || {
        rows.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        rows.truncate(intent_row_cap(limit));
        backfill_changesets_from_git(&repo_root, &mut rows);
        resolve_developers(&repo_root, &mut rows);
        Ok(rows)
    })
    .await
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
    crate::blocking::run(move || {
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
    })
    .await
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
    crate::blocking::run(move || {
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
                    symbols: Vec::new(),
                    commit: None,
                    base: None,
                    remote_only: false,
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
    })
    .await
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
    crate::blocking::run(move || {
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
    })
    .await
}

/// Merge two intents into one. The newer row is kept (timestamp + text),
/// receiving the union of both changesets; the older row is removed.
#[tauri::command]
pub async fn aura_intent_merge(
    repo_root: String,
    intent_ts_a: u64,
    intent_ts_b: u64,
) -> Result<u64, String> {
    crate::blocking::run(move || {
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
    })
    .await
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

#[cfg(test)]
mod intent_cap_tests {
    use super::{intent_row_cap, INTENT_ROW_CEILING};

    #[test]
    fn a_caller_that_names_no_limit_gets_the_modest_default() {
        assert_eq!(intent_row_cap(None), 50);
    }

    #[test]
    fn a_caller_gets_the_number_of_rows_it_asked_for() {
        assert_eq!(intent_row_cap(Some(1)), 1);
        assert_eq!(intent_row_cap(Some(200)), 200);
        assert_eq!(intent_row_cap(Some(631)), 631);
    }

    #[test]
    fn the_surfaces_that_want_the_whole_history_are_not_cut_to_five_hundred() {
        // The year-in-review and the overview both ask for 5000. Handing them
        // 500 is what made a repo's older years disappear from the picker
        // entirely, with nothing on screen to say the answer was partial.
        assert_eq!(intent_row_cap(Some(5000)), 5000);
        assert!(intent_row_cap(Some(5000)) > 500);
    }

    #[test]
    fn an_unbounded_ask_is_still_bounded() {
        // The ceiling is the reason this function exists: the log is
        // append-only and every row crosses IPC.
        assert_eq!(intent_row_cap(Some(usize::MAX)), INTENT_ROW_CEILING);
        assert_eq!(intent_row_cap(Some(INTENT_ROW_CEILING + 1)), INTENT_ROW_CEILING);
    }
}

#[cfg(test)]
mod cloud_intent_tests {
    use super::{cloud_intents_to_rows, remote_repo_path};
    use serde_json::json;

    /// One `/api/v2/intents` object, shaped the way `intents.rs` serialises a
    /// `live_events` row: one file, its changed symbols, and the rationale the
    /// server promotes to the headline.
    fn cloud(user: &str, at: &str, intent: &str, file: &str, syms: &[(&str, &str)]) -> serde_json::Value {
        json!({
            "user": user,
            "created_at": at,
            "intent": intent,
            "file_path": file,
            "changes": syms
                .iter()
                .map(|(name, change)| json!({
                    "name": name,
                    "kind": "function",
                    "change_type": change,
                }))
                .collect::<Vec<_>>(),
        })
    }

    #[test]
    fn a_teammates_intent_arrives_with_the_files_it_touched() {
        // The whole bug in one assertion: this used to come back with
        // `changeset: None`, so the Changes tab had nothing to show and a
        // teammate's every session read as summary-and-transcript only.
        let rows = cloud_intents_to_rows(
            "/nonexistent",
            &[cloud(
                "sam",
                "2026-08-01T10:00:00Z",
                "Rate-limit the login endpoint",
                "api/auth.rs",
                &[("check_rate", "added")],
            )],
        );
        assert_eq!(rows.len(), 1);
        let files = &rows[0].changeset.as_ref().expect("changeset").files;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "api/auth.rs");
        assert_eq!(files[0].status, "A");
        assert_eq!(files[0].symbols[0].identifier, "check_rate");
        // Without this the diff view would render the VIEWER's uncommitted
        // edits to api/auth.rs under Sam's name.
        assert!(files[0].remote_only);
    }

    #[test]
    fn one_intent_across_six_files_is_one_session_with_six_files() {
        // `live_events` stores a file save, so one `log-intent` over six files
        // arrives as six objects sharing a rationale. Mapped one-to-one they
        // were de-duplicated on that prose down to a single row — and five
        // files vanished with the rows that carried them.
        let same = "Move retries onto exponential backoff";
        let rows = cloud_intents_to_rows(
            "/nonexistent",
            &[
                cloud("sam", "2026-08-01T10:04:00Z", same, "net/retry.rs", &[("backoff", "modified")]),
                cloud("sam", "2026-08-01T10:03:00Z", same, "net/client.rs", &[("send", "modified")]),
                cloud("sam", "2026-08-01T10:01:00Z", same, "net/mod.rs", &[]),
            ],
        );
        assert_eq!(rows.len(), 1);
        let files = &rows[0].changeset.as_ref().expect("changeset").files;
        assert_eq!(files.len(), 3);
        // Newest-first in, and the group keeps the newest row's timestamp.
        assert_eq!(rows[0].timestamp % 60, 0);
    }

    #[test]
    fn the_same_words_a_day_later_are_a_different_session() {
        let same = "Fix the flaky login test";
        let rows = cloud_intents_to_rows(
            "/nonexistent",
            &[
                cloud("sam", "2026-08-02T10:00:00Z", same, "tests/login.rs", &[]),
                cloud("sam", "2026-08-01T10:00:00Z", same, "tests/login.rs", &[]),
            ],
        );
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn two_people_who_wrote_the_same_words_stay_two_people() {
        let same = "Bump the client timeout";
        let rows = cloud_intents_to_rows(
            "/nonexistent",
            &[
                cloud("sam", "2026-08-01T10:02:00Z", same, "net/client.rs", &[]),
                cloud("ali", "2026-08-01T10:01:00Z", same, "net/server.rs", &[]),
            ],
        );
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn one_file_saved_twice_in_a_run_is_still_one_changed_file() {
        let same = "Tighten the parser";
        let rows = cloud_intents_to_rows(
            "/nonexistent",
            &[
                cloud("sam", "2026-08-01T10:02:00Z", same, "src/parse.rs", &[("lex", "modified")]),
                cloud("sam", "2026-08-01T10:01:00Z", same, "src/parse.rs", &[("emit", "modified")]),
            ],
        );
        let files = &rows[0].changeset.as_ref().expect("changeset").files;
        assert_eq!(files.len(), 1);
        // Both saves' symbols survive the merge — the file changed in two ways.
        let names: Vec<&str> = files[0].symbols.iter().map(|s| s.identifier.as_str()).collect();
        assert!(names.contains(&"lex") && names.contains(&"emit"));
    }

    #[test]
    fn aura_bookkeeping_never_becomes_a_changed_file() {
        let rows = cloud_intents_to_rows(
            "/nonexistent",
            &[cloud(
                "sam",
                "2026-08-01T10:00:00Z",
                "Log the intent",
                ".aura/intent_log.jsonl",
                &[],
            )],
        );
        // The "why" is still worth showing; the ledger file is not a change.
        assert_eq!(rows.len(), 1);
        assert!(rows[0].changeset.is_none());
    }

    #[test]
    fn a_mixed_file_is_a_modification_not_an_add() {
        let rows = cloud_intents_to_rows(
            "/nonexistent",
            &[cloud(
                "sam",
                "2026-08-01T10:00:00Z",
                "Swap the hasher",
                "src/hash.rs",
                &[("sha1", "deleted"), ("blake3", "added")],
            )],
        );
        let files = &rows[0].changeset.as_ref().expect("changeset").files;
        assert_eq!(files[0].status, "M");
    }

    #[test]
    fn a_teammates_absolute_path_resolves_to_this_clones_relative_one() {
        // The path was recorded in THEIR checkout. Only the tail is shared.
        let root = std::env::temp_dir().join(format!("aura-remote-path-{}", std::process::id()));
        let nested = root.join("aura-shell/src");
        std::fs::create_dir_all(&nested).expect("mkdir");
        std::fs::write(nested.join("App.tsx"), "").expect("write");

        let root_s = root.to_string_lossy().to_string();
        assert_eq!(
            remote_repo_path(&root_s, "/Users/sam/code/aura/aura-shell/src/App.tsx"),
            "aura-shell/src/App.tsx"
        );
        // Longest match wins: a bare `src/App.tsx` also exists nowhere here,
        // but were it to, the longer path is the real one.
        assert_eq!(
            remote_repo_path(&root_s, "C:\\work\\aura\\aura-shell\\src\\App.tsx"),
            "aura-shell/src/App.tsx"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_relative_path_is_left_exactly_as_it_came() {
        assert_eq!(remote_repo_path("/nonexistent", "src/main.rs"), "src/main.rs");
        assert_eq!(remote_repo_path("/nonexistent", "./src/main.rs"), "src/main.rs");
    }

    #[test]
    fn a_path_this_clone_has_never_seen_is_named_honestly() {
        // A branch nobody here has fetched. Naming the file we can't find beats
        // silently naming a different one that happens to share a suffix — and
        // it comes back absolute, which reads as "this is from their machine"
        // rather than as a path that should resolve here.
        assert_eq!(
            remote_repo_path("/nonexistent", "/Users/sam/code/aura/src/ghost.rs"),
            "/Users/sam/code/aura/src/ghost.rs"
        );
    }
}
