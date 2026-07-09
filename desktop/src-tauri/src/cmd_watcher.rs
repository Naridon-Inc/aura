//! Workspace file watcher. One recursive `notify` watcher per
//! `(window, root)` pair — when the user switches projects we tear the
//! old watcher down and rebuild against the new root. Events are
//! debounced ~200 ms (multi-write saves from editors / formatters
//! collapse into one tick) and emitted to the React side as
//! `fs:changed { path, kind }`. The frontend consumes this to refresh
//! open buffers when an external editor (VS Code, Zed, nvim) writes the
//! same file aura-shell has open.
//!
//! We deliberately use a *thread* + `std::sync::mpsc` instead of a
//! tokio task: notify ships its own thread and a sync sender, and
//! bridging that into tokio without an extra wrapper requires
//! `tokio::sync::mpsc` + `try_send` calls that the notify crate doesn't
//! emit. The thread-based bridge is short, correct, and matches the
//! pattern already used by `cmd_pty.rs`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatcherRegistry {
    /// Owns the live watcher per repo root. Dropping the entry stops
    /// the OS-level watch — we rely on that when switching workspaces.
    by_root: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl WatcherRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize, Clone)]
struct FsChanged {
    /// Absolute path (whatever notify reports — already absolute on
    /// macOS/Linux for the recursive watch case we use).
    path: String,
    /// "create" | "modify" | "remove" | "rename" | "other" — the React
    /// side keys behaviour off this rather than parsing notify's enum.
    kind: &'static str,
}

#[tauri::command]
pub async fn watch_repo(
    repo_root: String,
    app: AppHandle,
    state: State<'_, WatcherRegistry>,
) -> Result<(), String> {
    // If a watcher already exists for this root, no-op. Switching to a
    // *different* root is the caller's job (call unwatch_repo on the
    // old one first); we don't second-guess that here because a
    // double-call should be idempotent without reshuffling watchers.
    {
        let map = state.by_root.lock().unwrap();
        if map.contains_key(&repo_root) {
            return Ok(());
        }
    }

    let root_path = PathBuf::from(&repo_root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {repo_root}"));
    }

    // Debounce table: path → last-emit instant. notify can fire 3-5
    // events per save (editor writes a temp, renames, touches mtime),
    // so we suppress duplicates within 200 ms. This also prevents the
    // `.aura/sentinel/heartbeat.json` write loop from drowning the UI.
    let last_emit: Mutex<HashMap<PathBuf, Instant>> = Mutex::new(HashMap::new());
    let app_for_cb = app.clone();

    // Channel inside the closure — notify wants Send + 'static and the
    // AppHandle is already Send + Clone.
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |res: Result<Event, notify::Error>| {
            let Ok(ev) = res else { return };
            let kind = classify(&ev.kind);
            // Skip the temp/lock files editors leave around — they're
            // noise, not user-visible saves.
            for raw in ev.paths {
                if is_ignored(&raw) {
                    continue;
                }
                {
                    let mut map = last_emit.lock().unwrap();
                    let now = Instant::now();
                    if let Some(prev) = map.get(&raw) {
                        if now.duration_since(*prev) < Duration::from_millis(200) {
                            continue;
                        }
                    }
                    map.insert(raw.clone(), now);
                }
                let payload = FsChanged {
                    path: raw.to_string_lossy().into_owned(),
                    kind,
                };
                // Best-effort emit; if the window is gone we drop the
                // event silently (the watcher will be torn down soon
                // after anyway).
                let _ = app_for_cb.emit("fs:changed", payload);
            }
        },
    )
    .map_err(|e| format!("watcher init failed: {e}"))?;

    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("watch failed: {e}"))?;

    state.by_root.lock().unwrap().insert(repo_root, watcher);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_repo(
    repo_root: String,
    state: State<'_, WatcherRegistry>,
) -> Result<(), String> {
    // Dropping the watcher unregisters the OS-level watch.
    state.by_root.lock().unwrap().remove(&repo_root);
    Ok(())
}

fn classify(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        EventKind::Access(_) => "other",
        EventKind::Other => "other",
        EventKind::Any => "other",
    }
}

// Filter out the noise: VCS internals, OS metadata, editor temps, and
// our own .aura/sentinel writes that fire constantly via the heartbeat
// loop. Keep this list deliberately tight — over-filtering makes the
// UI feel stale.
fn is_ignored(path: &PathBuf) -> bool {
    let s = path.to_string_lossy();
    s.contains("/.git/")
        || s.contains("/node_modules/")
        || s.contains("/target/")
        || s.contains("/.aura/sentinel/")
        || s.contains("/.aura/intent_log.jsonl")
        || s.ends_with(".swp")
        || s.ends_with("~")
        || s.ends_with(".DS_Store")
}
