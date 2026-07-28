//! AuraWatch — background tap on the Claude stream that nags (or
//! autonomously logs) when an Edit/Write tool_use lands without a
//! matching intent log entry. Wave C of the deep-aura plan.
//!
//! Architecture summary:
//!   - The cmd_agent_stream worker calls `WatchRegistry::observe` for
//!     every StreamEvent it emits. We filter for Edit/Write/MultiEdit
//!     tool_uses and feed them into a per-repo `WatchSession`.
//!   - Each session runs a small state machine:
//!       IDLE → COALESCING (3s edit window) → INFERRING → NUDGED|LOGGED
//!     with a 60s per-file dedup so a chatty agent doesn't flood the
//!     user with bubbles.
//!   - On INFERRING: call out to the configured backend (ollama or
//!     cloud key) via `aurawatch_inference`. If autonomous mode, write
//!     the inferred sentence directly to `.aura/intent_log.jsonl`. If
//!     nudge mode, emit a synthetic event the AuraWatchBubble renders
//!     in-stream with a one-click "Send to Claude" button.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::aurawatch_inference::{
    self, BackendDetection, InferContext, InferenceBackend, InferenceBackendKind,
};

/// Wave-A2 mode set. Off = the registry is alive but observe() drops
/// every event on the floor (no inference, no log, no nudge). Nudge =
/// the user-facing bubble path. Autonomous = AuraWatch writes intent
/// straight to the log on the user's behalf.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WatchMode {
    Off,
    Nudge,
    Autonomous,
}

impl Default for WatchMode {
    fn default() -> Self {
        WatchMode::Nudge
    }
}

/// Snapshot of the registry state for a repo. Returned by the
/// `aurawatch_status` command so the UI can render the chip + the
/// detection panel in the settings dialog.
#[derive(Debug, Clone, Serialize)]
pub struct WatchStatus {
    pub mode: WatchMode,
    pub backend: InferenceBackendKind,
    pub detection: BackendDetection,
    pub pending: usize,
    pub nudged_total: usize,
    pub logged_total: usize,
}

/// What we tell the React side about each nudge. `id` lets the user
/// dismiss or accept it via dedicated commands; `text` is the inferred
/// intent or generic copy.
#[derive(Debug, Clone, Serialize)]
pub struct Nudge {
    pub id: String,
    pub repo_root: String,
    pub channel: String,
    pub files: Vec<String>,
    pub text: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppliedIntent {
    pub repo_root: String,
    pub text: String,
    pub files: Vec<String>,
    pub at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowStatus {
    Coalescing,
    Inferring,
    Nudged,
}

#[derive(Debug)]
struct EditWindow {
    files: HashSet<String>,
    first_seen: tokio::time::Instant,
    last_seen: tokio::time::Instant,
    tool_uses: u32,
    status: WindowStatus,
}

const COALESCE_WINDOW: Duration = Duration::from_secs(3);
const FILE_DEDUP_WINDOW: Duration = Duration::from_secs(60);
const NUDGE_GRACE: Duration = Duration::from_secs(15);

struct WatchSession {
    mode: WatchMode,
    backend: InferenceBackend,
    /// Explicit user pick of which AI fills in reasons, persisted by the
    /// settings UI and passed back on start. `"agent:<kind>"` for an
    /// installed coding-agent CLI, or a plain backend kind string; None
    /// means "use auto-detected precedence". When the pick isn't
    /// reachable we silently fall back to auto — never a dead choice.
    preferred: Option<String>,
    /// Live edit window — None when idle. We only track one at a time
    /// per repo; multiple concurrent agents would each hit observe()
    /// for the same window.
    window: Option<EditWindow>,
    /// (file, last_logged_at) — anything younger than FILE_DEDUP_WINDOW
    /// is considered already covered, so a chatty agent that re-edits
    /// the same file doesn't re-trigger the nudge path.
    recent_files: VecDeque<(String, tokio::time::Instant)>,
    nudged_total: usize,
    logged_total: usize,
}

impl WatchSession {
    fn new(mode: WatchMode, backend: InferenceBackend, preferred: Option<String>) -> Self {
        Self {
            mode,
            backend,
            preferred,
            window: None,
            recent_files: VecDeque::new(),
            nudged_total: 0,
            logged_total: 0,
        }
    }

    fn pending_count(&self) -> usize {
        self.window
            .as_ref()
            .map(|w| w.tool_uses as usize)
            .unwrap_or(0)
    }
}

#[derive(Default)]
pub struct WatchRegistry {
    by_root: Arc<Mutex<HashMap<String, Arc<Mutex<WatchSession>>>>>,
}

impl WatchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Tap point called from cmd_agent_stream's emit loop. Cheap O(1)
    /// lookup — we drop the event on the floor if the repo isn't being
    /// watched, which is the common case before the user opens the
    /// agent surface.
    pub async fn observe(
        &self,
        app: &AppHandle,
        repo_root: &str,
        channel: &str,
        tool_name: &str,
        file_path: Option<&str>,
    ) {
        // Only file-touching tools — the rest is noise for this path.
        if !matches!(tool_name, "Edit" | "Write" | "MultiEdit") {
            return;
        }
        let Some(file) = file_path else {
            return;
        };
        let session = {
            let map = self.by_root.lock().await;
            match map.get(repo_root) {
                Some(s) => s.clone(),
                None => return, // not watched
            }
        };
        // Schedule a timer that closes the coalesce window. We do it
        // here because each new edit extends the window — the
        // most-recent edit owns the timer, earlier scheduled
        // closures wake up early and find the window already moved.
        let now = tokio::time::Instant::now();
        let mut s = session.lock().await;
        if s.mode == WatchMode::Off {
            return;
        }
        if recent_dedup_hit(&s.recent_files, file, now) {
            return; // covered by an earlier window/log within 60s
        }

        match &mut s.window {
            Some(w) => {
                w.files.insert(file.to_string());
                w.last_seen = now;
                w.tool_uses += 1;
            }
            None => {
                let mut files = HashSet::new();
                files.insert(file.to_string());
                s.window = Some(EditWindow {
                    files,
                    first_seen: now,
                    last_seen: now,
                    tool_uses: 1,
                    status: WindowStatus::Coalescing,
                });
            }
        }
        drop(s);

        // Spawn the closer. Multiple inflight closers are fine — only
        // the one that finds last_seen unchanged after COALESCE_WINDOW
        // does anything.
        let session_clone = session.clone();
        let app_clone = app.clone();
        let repo = repo_root.to_string();
        let chan = channel.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(COALESCE_WINDOW).await;
            close_window_if_quiet(&app_clone, &repo, &chan, session_clone).await;
        });
    }

    /// Ensure a session exists for the repo. `preferred` is the user's
    /// explicit AI pick (`Some`) — when supplied we (re)resolve the
    /// backend to honor it; `None` keeps whatever's already selected
    /// (or, on first create, auto-detected precedence).
    async fn ensure_session(
        &self,
        repo_root: &str,
        mode: WatchMode,
        preferred: Option<String>,
    ) -> Arc<Mutex<WatchSession>> {
        let mut map = self.by_root.lock().await;
        if let Some(s) = map.get(repo_root) {
            // Hot-update the mode if the user toggled.
            let mut sess = s.lock().await;
            sess.mode = mode;
            // If the user passed a new explicit pick, re-resolve the
            // backend to honor it (falls back to auto if unreachable).
            if let Some(pref) = preferred {
                sess.preferred = Some(pref.clone());
                sess.backend =
                    aurawatch_inference::select_backend_preferred(Some(&pref)).await;
            }
            drop(sess);
            return s.clone();
        }
        let backend =
            aurawatch_inference::select_backend_preferred(preferred.as_deref()).await;
        let s = Arc::new(Mutex::new(WatchSession::new(mode, backend, preferred)));
        map.insert(repo_root.to_string(), s.clone());
        s
    }

    async fn snapshot(&self, repo_root: &str) -> Option<WatchStatus> {
        let detection = aurawatch_inference::detect_backends().await;
        let map = self.by_root.lock().await;
        let s = map.get(repo_root)?;
        let sess = s.lock().await;
        Some(WatchStatus {
            mode: sess.mode,
            backend: sess.backend.kind(),
            detection,
            pending: sess.pending_count(),
            nudged_total: sess.nudged_total,
            logged_total: sess.logged_total,
        })
    }
}

fn recent_dedup_hit(
    recent: &VecDeque<(String, tokio::time::Instant)>,
    file: &str,
    now: tokio::time::Instant,
) -> bool {
    recent
        .iter()
        .any(|(f, t)| f == file && now.duration_since(*t) < FILE_DEDUP_WINDOW)
}

async fn close_window_if_quiet(
    app: &AppHandle,
    repo_root: &str,
    channel: &str,
    session: Arc<Mutex<WatchSession>>,
) {
    let now = tokio::time::Instant::now();
    let (window, mode, backend) = {
        let mut s = session.lock().await;
        let Some(w) = &mut s.window else { return };
        if w.status != WindowStatus::Coalescing {
            return;
        }
        if now.duration_since(w.last_seen) < COALESCE_WINDOW {
            return; // a newer edit landed; let its timer close us
        }
        w.status = WindowStatus::Inferring;
        (
            EditWindow {
                files: w.files.clone(),
                first_seen: w.first_seen,
                last_seen: w.last_seen,
                tool_uses: w.tool_uses,
                status: WindowStatus::Inferring,
            },
            s.mode,
            s.backend.clone(),
        )
    };

    // Build the inference context. Diff excerpt is best-effort — if
    // git is unavailable or the file is untracked we just leave it
    // empty; the model will lean on the file list.
    let files_vec: Vec<String> = window.files.iter().cloned().collect();
    let diff_excerpt = best_effort_diff(repo_root, &files_vec).await;
    let ctx = InferContext {
        files: files_vec.clone(),
        diff_excerpt,
        assistant_tail: String::new(),
        task: aurawatch_inference::InferTask::Why,
    };

    let text = match aurawatch_inference::infer(&backend, &ctx).await {
        Ok(s) => s,
        Err(_) => aurawatch_inference::generic_copy(&ctx),
    };

    // Apply per chosen mode.
    match mode {
        WatchMode::Off => {
            // Mode flipped while we were inferring — drop result.
            let mut s = session.lock().await;
            s.window = None;
        }
        WatchMode::Autonomous => {
            apply_intent(repo_root, &text).await;
            let mut s = session.lock().await;
            s.window = None;
            s.logged_total += 1;
            mark_files_recent(&mut s.recent_files, &files_vec, now);
            let _ = app.emit(
                &format!("aurawatch:applied:{channel}"),
                AppliedIntent {
                    repo_root: repo_root.to_string(),
                    text: text.clone(),
                    files: files_vec.clone(),
                    at: chrono_now(),
                },
            );
        }
        WatchMode::Nudge => {
            let id = format!("nudge-{}", uuid::Uuid::new_v4());
            let nudge = Nudge {
                id,
                repo_root: repo_root.to_string(),
                channel: channel.to_string(),
                files: files_vec.clone(),
                text: text.clone(),
                created_at: chrono_now(),
            };
            let _ = app.emit(&format!("aurawatch:nudge:{channel}"), nudge.clone());
            let mut s = session.lock().await;
            if let Some(w) = &mut s.window {
                w.status = WindowStatus::Nudged;
            }
            s.nudged_total += 1;
            mark_files_recent(&mut s.recent_files, &files_vec, now);
            // Schedule the grace timer — after NUDGE_GRACE, scan the
            // intent log and clear the window so it doesn't go stale.
            let session_clone = session.clone();
            tokio::spawn(async move {
                tokio::time::sleep(NUDGE_GRACE).await;
                let mut s = session_clone.lock().await;
                if let Some(w) = &s.window {
                    if w.status == WindowStatus::Nudged {
                        s.window = None;
                    }
                }
            });
        }
    }
}

fn mark_files_recent(
    recent: &mut VecDeque<(String, tokio::time::Instant)>,
    files: &[String],
    now: tokio::time::Instant,
) {
    let cutoff = now - FILE_DEDUP_WINDOW;
    while let Some((_, t)) = recent.front() {
        if *t < cutoff {
            recent.pop_front();
        } else {
            break;
        }
    }
    for f in files {
        recent.push_back((f.clone(), now));
    }
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn best_effort_diff(repo_root: &str, files: &[String]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut args: Vec<String> = vec![
        "diff".into(),
        "--unified=2".into(),
        "--no-color".into(),
        "--".into(),
    ];
    args.extend(files.iter().cloned());
    let output = tokio::process::Command::new("git")
        .args(&args)
        .current_dir(repo_root)
        .output()
        .await;
    let Ok(out) = output else {
        return String::new();
    };
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines().take(40).collect::<Vec<_>>().join("\n")
}

async fn apply_intent(repo_root: &str, text: &str) {
    // Shell out to `aura log-intent` so we share the same JSONL format
    // + .intent_logged marker the rest of the toolchain expects. Tag
    // the agent_id as "aurawatch" so the user can grep for our
    // contributions.
    let _ = tokio::process::Command::new("aura")
        .args([
            "log-intent",
            text,
            "--agent",
            "aurawatch",
        ])
        .current_dir(repo_root)
        .output()
        .await;
}

// ----- Tauri commands -----

#[tauri::command]
pub async fn aurawatch_start(
    repo_root: String,
    mode: WatchMode,
    preferred: Option<String>,
    state: State<'_, WatchRegistry>,
) -> Result<WatchStatus, String> {
    state.ensure_session(&repo_root, mode, preferred).await;
    state
        .snapshot(&repo_root)
        .await
        .ok_or_else(|| "session missing after start".to_string())
}

#[tauri::command]
pub async fn aurawatch_stop(
    repo_root: String,
    state: State<'_, WatchRegistry>,
) -> Result<(), String> {
    let mut map = state.by_root.lock().await;
    map.remove(&repo_root);
    Ok(())
}

#[tauri::command]
pub async fn aurawatch_set_mode(
    repo_root: String,
    mode: WatchMode,
    state: State<'_, WatchRegistry>,
) -> Result<WatchStatus, String> {
    state.ensure_session(&repo_root, mode, None).await;
    state
        .snapshot(&repo_root)
        .await
        .ok_or_else(|| "no session".to_string())
}

/// Pick which AI fills in change reasons. `preferred` is the selector
/// the settings UI persists: `"agent:<kind>"` for an installed
/// coding-agent CLI (claude/gemini/codex), or a plain backend kind
/// (`"ollama"`/`"anthropic"`/`"openai"`/`"gemini"`/`"mercury"`). An
/// empty/None value clears the pick and reverts to auto-detection. If
/// the chosen source isn't reachable we silently fall back to auto, so
/// the user can never select a dead backend.
#[tauri::command]
pub async fn aurawatch_set_backend(
    repo_root: String,
    preferred: Option<String>,
    state: State<'_, WatchRegistry>,
) -> Result<WatchStatus, String> {
    // Keep the existing mode; only re-resolve the backend. We read the
    // current mode first so a backend switch doesn't disturb it.
    let mode = {
        let map = state.by_root.lock().await;
        match map.get(&repo_root) {
            Some(s) => s.lock().await.mode,
            None => WatchMode::default(),
        }
    };
    // Normalize an empty string to None (clear → auto).
    let pref = preferred.filter(|p| !p.trim().is_empty());
    state.ensure_session(&repo_root, mode, pref).await;
    state
        .snapshot(&repo_root)
        .await
        .ok_or_else(|| "no session".to_string())
}

#[tauri::command]
pub async fn aurawatch_status(
    repo_root: String,
    state: State<'_, WatchRegistry>,
) -> Result<Option<WatchStatus>, String> {
    Ok(state.snapshot(&repo_root).await)
}

#[tauri::command]
pub async fn aurawatch_detect() -> Result<BackendDetection, String> {
    Ok(aurawatch_inference::detect_backends().await)
}

#[tauri::command]
pub async fn aurawatch_nudge_accept(
    app: AppHandle,
    nudge_id: String,
    channel: String,
    text: String,
    repo_root: String,
    agent_id: String,
) -> Result<(), String> {
    // Emitting a staged-prompt event lets the AgentStreamView dispatch
    // it through the same path as a Composer "Send" — so the user's
    // turn shows up as a normal bubble + the Claude side runs the MCP
    // tool. Frontend listens for this and calls agentStreamSend.
    let payload = serde_json::json!({
        "nudge_id": nudge_id,
        "channel": channel,
        "repo_root": repo_root,
        "agent_id": agent_id,
        "prompt": format!(
            "Please call the aura_log_intent MCP tool now with the following one-sentence intent: {}",
            text.trim()
        ),
    });
    let _ = app.emit("aurawatch:stage-prompt", payload);
    Ok(())
}

#[tauri::command]
pub async fn aurawatch_nudge_dismiss(_nudge_id: String) -> Result<(), String> {
    // Nothing server-side: the React store removes the bubble locally.
    // We keep the command so the frontend has a clean RPC surface for
    // future telemetry without changing call sites.
    Ok(())
}
