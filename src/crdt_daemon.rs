//! Background CRDT push (FS watcher) + pull (polling) loops (plan W4.4).
//!
//! Spawned from `live_sync::LiveSync::start` when the current repo is
//! cloud-routed. One global `CrdtSession` shared across threads.
//!
//! - Push: notify-based watcher over the repo root. Debounces 500ms per
//!   path. On change, reads the file, passes through `is_crdt_eligible`,
//!   then `CrdtSession::ingest_disk` → `push_update`.
//! - Pull: every 3 seconds (or sooner if the WS marker flips), calls
//!   `pull_ops(branch, cursor)`. For each op, applies to the local doc
//!   and writes the resulting text back to disk atomically.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::crdt::{load_cursors, save_cursors, CrdtSession};
use crate::crdt_kind::is_crdt_eligible;
use crate::live_transport::active as active_transport;

/// Marker the desktop "Go Live" toggle (and tests) write to force whole-file
/// CRDT on for a repo that isn't cloud-routed yet. Lives under `.aura/live` so
/// it's per-checkout and disappears on "Go Live → off".
fn crdt_enable_marker() -> PathBuf {
    PathBuf::from(".aura/live/crdt_enabled")
}

/// Whole-file CRDT is the sole disk writer for this repo when it is active.
///
/// True when the repo is cloud-routed (the legacy trigger) OR Go Live has
/// explicitly enabled it (marker / `AURA_LIVE_CRDT=1`). This is the single
/// predicate that both (a) gates spawning the push/pull daemon and (b) demotes
/// the function-body splice path to detection-only — so wherever the daemon
/// writes whole files, nothing else writes the same bytes. Keeping the two
/// decisions on one predicate is what prevents the two-writer clobber.
pub fn live_crdt_enabled() -> bool {
    crate::cloud_zones::cloud_routed_for_current_repo()
        || crdt_enable_marker().exists()
        || std::env::var("AURA_LIVE_CRDT").map(|v| v == "1").unwrap_or(false)
}

/// Turn the explicit Go Live CRDT marker on/off. Cloud-routed repos don't need
/// it (they're already enabled), but it lets the desktop flip CRDT for any repo.
pub fn set_crdt_enabled(on: bool) {
    let marker = crdt_enable_marker();
    if on {
        if let Some(p) = marker.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let _ = std::fs::write(&marker, "1");
    } else {
        let _ = std::fs::remove_file(&marker);
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) {
    let tmp_name = format!(
        ".{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("crdt")
    );
    let tmp = match path.parent() {
        Some(p) => p.join(tmp_name),
        None => PathBuf::from(tmp_name),
    };
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn current_branch() -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "main".to_string())
}

pub fn spawn(stop: Arc<AtomicBool>) -> thread::JoinHandle<()> {
    let session = Arc::new(CrdtSession::new());
    let session_pull = session.clone();
    let stop_pull = stop.clone();

    // Pull loop.
    thread::spawn(move || pull_loop(session_pull, stop_pull));

    // Push (watcher) loop.
    thread::spawn(move || push_loop(session, stop))
}

fn push_loop(session: Arc<CrdtSession>, stop: Arc<AtomicBool>) {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(_) => return,
    };
    if watcher.watch(Path::new("."), RecursiveMode::Recursive).is_err() {
        return;
    }

    let transport = active_transport();

    // Debounce per-path.
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    let debounce = Duration::from_millis(500);

    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }

        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Ok(ev)) => {
                if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    for p in ev.paths {
                        if let Ok(rel) = p.strip_prefix(std::env::current_dir().unwrap_or_default()) {
                            if is_crdt_eligible(rel) {
                                pending.insert(rel.to_path_buf(), Instant::now());
                            }
                        } else if is_crdt_eligible(&p) {
                            pending.insert(p, Instant::now());
                        }
                    }
                }
            }
            Ok(Err(_)) => {}
            Err(_) => {}
        }

        // Flush debounced.
        let now = Instant::now();
        let due: Vec<PathBuf> = pending
            .iter()
            .filter(|(_, t)| now.duration_since(**t) >= debounce)
            .map(|(p, _)| p.clone())
            .collect();
        for p in due {
            pending.remove(&p);
            if !p.exists() {
                continue;
            }
            let disk = match std::fs::read_to_string(&p) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let branch = current_branch();
            let path_str = p.to_string_lossy().to_string();
            if let Some(update) = session.ingest_disk(&branch, &path_str, &disk) {
                let _ = transport.push_crdt(&branch, &update);
            }
        }
    }
}

fn pull_loop(session: Arc<CrdtSession>, stop: Arc<AtomicBool>) {
    let cursors = Arc::new(Mutex::new(load_cursors()));
    let transport = active_transport();

    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }

        let branch = current_branch();
        let since = {
            let c = cursors.lock().unwrap();
            *c.by_branch.get(&branch).unwrap_or(&0)
        };

        match transport.pull_crdt(&branch, since) {
            Ok((ops, cursor)) => {
                for op in &ops {
                    if op.file_path.is_empty() {
                        continue;
                    }
                    if let Some(new_text) =
                        session.apply_inbound(&branch, &op.file_path, &op.update_b64)
                    {
                        atomic_write(Path::new(&op.file_path), new_text.as_bytes());
                    }
                }
                if cursor > since {
                    let mut c = cursors.lock().unwrap();
                    c.by_branch.insert(branch, cursor);
                    save_cursors(&c);
                }
            }
            Err(_) => {}
        }

        // Flip the WS-signalled marker if present.
        let marker = Path::new(".aura/live/crdt_pending");
        if marker.exists() {
            let _ = std::fs::remove_file(marker);
        }

        thread::sleep(Duration::from_secs(3));
    }
}
