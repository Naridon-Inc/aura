//! The folders a VS Code–based editor (Cursor, Windsurf, Void) has opened.
//!
//! Each opened folder gets `User/workspaceStorage/<hash>/workspace.json`
//! holding `{"folder": "file:///…"}`, and that directory's `state.vscdb`
//! keeps the per-folder state (Cursor's list of chats in that folder lives
//! there). Multi-root `.code-workspace` windows record `"workspace"` instead
//! and have no single folder; they are left out.

use std::path::{Path, PathBuf};

/// Where an app keeps its per-user data on this OS.
pub fn app_support(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else if cfg!(target_os = "windows") {
        home.join("AppData").join("Roaming")
    } else {
        home.join(".config")
    }
}

/// `<app support>/<app>/User`.
pub fn user_dir(home: &Path, app: &str) -> PathBuf {
    app_support(home).join(app).join("User")
}

#[derive(Clone, Debug, PartialEq)]
pub struct Folder {
    /// The `workspaceStorage` directory for this folder.
    pub storage: PathBuf,
    pub path: PathBuf,
    pub exists: bool,
    pub is_git: bool,
}

/// `file:///Users/x/My%20App` → `/Users/x/My App`. Anything that isn't a
/// local file URI (a remote SSH window, a dev container) is None.
pub fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let url = url::Url::parse(uri).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

pub fn is_git(path: &Path) -> bool {
    path.join(".git").exists()
}

/// Every single-folder window the app recorded, newest storage first.
pub fn folders(user: &Path) -> Vec<Folder> {
    let Ok(entries) = std::fs::read_dir(user.join("workspaceStorage")) else {
        return Vec::new();
    };
    let mut rows: Vec<(std::time::SystemTime, Folder)> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let storage = entry.path();
        let Ok(text) = std::fs::read_to_string(storage.join("workspace.json")) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(path) = v.get("folder").and_then(|f| f.as_str()).and_then(file_uri_to_path) else {
            continue;
        };
        let modified = std::fs::metadata(&storage)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        let exists = path.is_dir();
        let is_git = exists && is_git(&path);
        rows.push((modified, Folder { storage, path, exists, is_git }));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    // Several storage dirs can name one folder (it was reopened after a
    // rename, or by another build of the app); keep the newest.
    let mut seen = std::collections::HashSet::new();
    rows.into_iter()
        .map(|(_, f)| f)
        .filter(|f| seen.insert(f.path.clone()))
        .collect()
}
