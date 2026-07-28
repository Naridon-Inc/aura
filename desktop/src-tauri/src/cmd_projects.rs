//! Project registry — `~/.aura/projects.json`.
//!
//! Lightweight index of recently-opened workspaces, file-backed so the
//! Manager loop can resolve a `task.project_root` to a label without
//! depending on whatever workspace the renderer happens to be on.
//! Mirrors the localStorage `aura.recents` list the App component owns;
//! the renderer calls `projects_register` on every workspace open so the
//! file stays in sync.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub id: String,
    pub label: String,
    pub root: String,
    pub last_opened_at: u64,
}

#[derive(Default)]
pub struct ProjectRegistryHandle {
    /// Module-level lock so concurrent `projects_register` calls from
    /// multiple windows don't race on the JSON file.
    write_lock: Mutex<()>,
}

impl ProjectRegistryHandle {
    pub fn new() -> Self {
        Self::default()
    }
}

fn registry_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("projects.json");
    Some(p)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Every registered workspace root (the union of projects the user has
/// opened), minus machine-created agent worktrees. Used by background tasks
/// that must service all open projects, not just the focused window — e.g. the
/// automations scheduler firing each repo's due recipes while Aura is on.
pub fn registered_roots() -> Vec<String> {
    read_all()
        .into_iter()
        .map(|e| e.root)
        .filter(|r| !is_managed_worktree(r))
        .collect()
}

fn read_all() -> Vec<ProjectEntry> {
    let Some(path) = registry_path() else {
        return vec![];
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return vec![];
    };
    serde_json::from_str::<Vec<ProjectEntry>>(&raw).unwrap_or_default()
}

fn write_all(entries: &[ProjectEntry]) -> Result<(), String> {
    let Some(path) = registry_path() else {
        return Err("HOME not set".into());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(entries).map_err(|e| format!("serialize: {e}"))?;
    let dir = path.parent().ok_or("invalid path")?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-projects-")
        .suffix(".json")
        .tempfile_in(dir)
        .map_err(|e| format!("tempfile: {e}"))?;
    tmp.write_all(json.as_bytes()).map_err(|e| format!("write: {e}"))?;
    tmp.persist(&path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Managed agent/sibling worktrees live under
/// `<repo>/.{claude,gemini,aura}/worktrees/<name>`. They're machine-created
/// checkouts (an orchestrator spawning an agent on its own branch), not
/// workspaces the user opened, and must never be promoted to a top-level
/// project tile. Registering one is what made a spawned `agent-<hex>`
/// checkout show up as a phantom workspace the user never created.
fn is_managed_worktree(root: &str) -> bool {
    root.contains("/.claude/worktrees/")
        || root.contains("/.gemini/worktrees/")
        || root.contains("/.aura/worktrees/")
}

fn project_id_for(root: &str) -> String {
    // Stable id derived from the absolute root path. Same path → same id
    // across restarts, even if the label changes. We hash so the id is
    // safe to use in URLs/event names.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    root.hash(&mut h);
    format!("p-{:x}", h.finish())
}

#[tauri::command]
pub fn projects_register(
    handle: tauri::State<'_, ProjectRegistryHandle>,
    root: String,
    label: Option<String>,
) -> Result<ProjectEntry, String> {
    let _g = handle.write_lock.lock().unwrap();
    let mut entries = read_all();
    // Prune any managed-worktree entries that leaked in before this guard
    // existed, so the phantom self-heals out of projects.json on the next
    // legitimate registration.
    let before = entries.len();
    entries.retain(|e| !is_managed_worktree(&e.root));
    let pruned = entries.len() != before;
    let id = project_id_for(&root);
    let label = label.unwrap_or_else(|| {
        std::path::Path::new(&root)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&root)
            .to_string()
    });
    let now = now_secs();
    // A managed worktree can be opened to inspect an agent's work, but it
    // must not be persisted as a project. Return an ephemeral entry so the
    // caller doesn't error; flush the prune above if it changed anything.
    if is_managed_worktree(&root) {
        if pruned {
            write_all(&entries)?;
        }
        return Ok(ProjectEntry {
            id,
            label,
            root,
            last_opened_at: now,
        });
    }
    let entry = if let Some(existing) = entries.iter_mut().find(|e| e.id == id) {
        existing.label = label;
        existing.last_opened_at = now;
        existing.clone()
    } else {
        let e = ProjectEntry {
            id: id.clone(),
            label,
            root: root.clone(),
            last_opened_at: now,
        };
        entries.push(e.clone());
        e
    };
    // Sort newest-first so list reads naturally.
    entries.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    // Cap at 32 — keeps the file small and the Manager launcher legible.
    entries.truncate(32);
    write_all(&entries)?;
    // Register this project with the cloud so the paired phone's repo switcher
    // lists it the moment it's opened — no live session or manual backfill
    // needed. Fire-and-forget; a quiet no-op when signed out. Managed worktrees
    // returned above, so this only fires for real user workspaces.
    crate::cloud_session_sync::spawn_roster_push_one(entry.root.clone());
    Ok(entry)
}

#[tauri::command]
pub fn projects_list(_handle: tauri::State<'_, ProjectRegistryHandle>) -> Vec<ProjectEntry> {
    read_all()
}

#[tauri::command]
pub fn projects_get(
    _handle: tauri::State<'_, ProjectRegistryHandle>,
    id: String,
) -> Option<ProjectEntry> {
    read_all().into_iter().find(|e| e.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_list() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", tmp.path()) };
        let h = ProjectRegistryHandle::new();
        let _ = write_all(&[]); // start clean
        let entry = ProjectEntry {
            id: project_id_for("/tmp/foo"),
            label: "foo".into(),
            root: "/tmp/foo".into(),
            last_opened_at: now_secs(),
        };
        write_all(&[entry.clone()]).unwrap();
        let listed = read_all();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].root, "/tmp/foo");
        let _ = h; // silence unused
    }
}
