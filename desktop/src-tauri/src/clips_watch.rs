//! Auto-import system screenshots into the clipboard tray.
//!
//! Watches the user's screenshot output directory (macOS default is
//! `~/Desktop`, configurable via
//! `defaults write com.apple.screencapture location <path>`) and the
//! common `~/Pictures/Screenshots` fallback. When a new file lands
//! whose name matches the macOS screenshot pattern, it's copied into
//! `~/.aura/clips/` so the user can immediately drag it from the tray
//! into a chat field without a paste step.
//!
//! Spawned as a single OS thread from the Tauri `setup` hook — notify
//! gives us a blocking sync channel which is awkward to consume from a
//! tokio task, and the work here is rare enough that a thread is the
//! simpler answer. Holds the `Watcher` for its entire lifetime so the
//! filesystem subscription stays active.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::cmd_clips::import_external_file;

/// Squash duplicate fires from a single screenshot capture (Create
/// followed by Modify on most filesystems) by ignoring the same path
/// for this long after we first see it.
const DEDUP_WINDOW: Duration = Duration::from_secs(60);

/// Wait for the screenshot writer to release the file before we copy
/// it. The macOS screenshot tool writes atomically but some other
/// capture utilities (CleanShot, Snip) take a few hundred ms.
const SETTLE_DELAY: Duration = Duration::from_millis(300);

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let dirs = candidate_dirs();
        if dirs.is_empty() {
            return;
        }

        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("clips-watch: cannot create watcher: {e}");
                return;
            }
        };

        let mut watched: Vec<PathBuf> = Vec::new();
        for dir in &dirs {
            if dir.is_dir() && watcher.watch(dir, RecursiveMode::NonRecursive).is_ok() {
                watched.push(dir.clone());
            }
        }
        if watched.is_empty() {
            return;
        }
        tracing::info!(
            "clips-watch: monitoring {} dir(s) for screenshots",
            watched.len()
        );

        let mut recently_seen: HashMap<PathBuf, Instant> = HashMap::new();
        loop {
            let event = match rx.recv() {
                Ok(Ok(ev)) => ev,
                Ok(Err(_)) => continue,
                Err(_) => break, // sender dropped — watcher gone, exit thread
            };
            if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                continue;
            }
            for path in &event.paths {
                if !is_screenshot(path) {
                    continue;
                }
                let now = Instant::now();
                recently_seen.retain(|_, t| now.duration_since(*t) < DEDUP_WINDOW);
                if recently_seen.contains_key(path) {
                    continue;
                }
                recently_seen.insert(path.clone(), now);

                std::thread::sleep(SETTLE_DELAY);
                if !path.is_file() {
                    continue;
                }
                match import_external_file(path) {
                    Ok(_) => {
                        let _ = app.emit("clips:added", ());
                    }
                    Err(e) => {
                        tracing::warn!(
                            "clips-watch: import failed for {}: {e}",
                            path.display()
                        );
                    }
                }
            }
        }
        drop(watcher);
    });
}

/// Directories we want to watch. macOS users can redirect screenshots
/// via `defaults write com.apple.screencapture location <path>`; if
/// they have, watch both that and `~/Desktop`. Always include
/// `~/Pictures/Screenshots` if it exists (Windows-style convention
/// some users adopt on macOS).
fn candidate_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = configured_macos_screenshot_dir() {
        out.push(p);
    }
    if let Some(home) = dirs::home_dir() {
        let desktop = home.join("Desktop");
        if !out.contains(&desktop) {
            out.push(desktop);
        }
        let pictures_screenshots = home.join("Pictures").join("Screenshots");
        if pictures_screenshots.is_dir() && !out.contains(&pictures_screenshots) {
            out.push(pictures_screenshots);
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn configured_macos_screenshot_dir() -> Option<PathBuf> {
    use std::process::Command;
    let out = Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let path = if let Some(stripped) = raw.strip_prefix("~/") {
        dirs::home_dir()?.join(stripped)
    } else if raw == "~" {
        dirs::home_dir()?
    } else {
        PathBuf::from(raw)
    };
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn configured_macos_screenshot_dir() -> Option<PathBuf> {
    None
}

/// Match the macOS screenshot file naming conventions:
///   • "Screenshot 2026-05-08 at 12.20.58 AM.png" (modern)
///   • "Screen Shot 2024-01-01 at 1.00.00 PM.png" (legacy)
/// Reject everything else so a random Desktop save doesn't end up in
/// the tray.
fn is_screenshot(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_lowercase();
    let starts_ok = lower.starts_with("screenshot") || lower.starts_with("screen shot");
    let ends_ok =
        lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg");
    starts_ok && ends_ok
}
