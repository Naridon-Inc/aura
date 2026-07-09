//! Page folders — lightweight, user-organizational grouping for Pages.
//!
//! A *folder* is a first-class but featherweight entity that lets people sort
//! their Pages into named, colored groups (think the tinted folder rows in a
//! file app). Folders are NOT files and never contain page bytes — a page
//! simply remembers which folder it lives in via a `folder` field in its
//! frontmatter (see `cmd_notes::NoteFrontmatter`). A page with no folder
//! renders at the root, exactly as Pages did before folders existed, so this
//! is fully additive and backward-compatible.
//!
//! ## Storage
//!
//! The folder index for a scope/bucket lives in a small JSON sidecar next to
//! that scope's notes, mirroring the existing notes path layout:
//!
//! ```text
//!   team    → .aura/notes/team/_folders.json
//!   channel → .aura/notes/channel/<channel>/_folders.json
//!   member  → .aura/notes/member/<handle>/_folders.json
//! ```
//!
//! Keeping the index per scope/bucket (rather than one global file) means a
//! channel's folders travel with that channel's notes directory and a private
//! member's folders stay in their own directory — the same isolation the note
//! files already get. The file is a single JSON object `{ "folders": [ … ] }`
//! so the on-disk shape can grow new keys later without breaking older readers.
//!
//! ## Page membership
//!
//! Which pages belong to a folder is the *page's* business, recorded in the
//! note frontmatter `folder` field — NOT duplicated here. That keeps a single
//! source of truth (the page) and means deleting a folder only has to clear
//! that field on its pages; it never risks losing a page. `note_set_folder`
//! and `note_folder_delete` go through `cmd_notes`' own metadata-write path so
//! the change is atomic + broadcast over the live rail like any other edit.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cmd_notes::{self, NoteScope};

/// One folder in a scope/bucket's index. `parent` supports nesting (at least
/// one level; the frontend renders deeper trees the same way it renders pages)
/// and is `None` for a top-level folder. `order` is a manual sort key the UI
/// can reorder; ties fall back to name.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageFolder {
    pub id: String,
    pub name: String,
    /// A short color token the UI maps to a swatch (e.g. `"blue"`, `"violet"`).
    /// Stored as an opaque string so the palette can evolve without a backend
    /// change; the default on create is a calm blue.
    pub color: String,
    /// Manual ordering within a parent. Lower sorts first.
    #[serde(default)]
    pub order: i64,
    /// Parent folder id for nesting; `None` ⇒ a top-level folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// The on-disk index file shape. Wrapped in an object (rather than a bare
/// array) so future keys can be added without breaking the format.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct FolderIndex {
    #[serde(default)]
    folders: Vec<PageFolder>,
}

fn new_folder_id() -> String {
    format!("fold_{}", uuid::Uuid::new_v4())
}

/// Strip path-unsafe characters from a single segment. Mirrors
/// `cmd_notes::sanitize_segment` (kept local so this module has no dependency
/// on a private helper): block `/`, `\`, NUL, control chars, and `..`.
fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '/' || c == '\\' || c == '\0' || c.is_control() {
            out.push('_');
        } else {
            out.push(c);
        }
    }
    let out = out.replace("..", "_");
    if out.is_empty() {
        "_".to_string()
    } else {
        out
    }
}

/// Directory that holds a scope/bucket's notes — and therefore its
/// `_folders.json` index. Mirrors `cmd_notes::scope_dir` exactly so the index
/// always sits beside the pages it groups.
fn scope_dir(repo_root: &Path, scope: &NoteScope, bucket: &str) -> PathBuf {
    let base = repo_root
        .join(".aura")
        .join("notes")
        .join(scope.dir_name());
    match scope {
        NoteScope::Team => base,
        NoteScope::Channel | NoteScope::Member => {
            if bucket.is_empty() {
                base
            } else {
                base.join(sanitize_segment(bucket))
            }
        }
    }
}

/// Path to the folder index JSON for a scope/bucket.
fn index_path(repo_root: &Path, scope: &NoteScope, bucket: &str) -> PathBuf {
    scope_dir(repo_root, scope, bucket).join("_folders.json")
}

/// Load the folder index for a scope/bucket. A missing file is not an error —
/// it simply means no folders exist yet, so we return an empty index. A
/// corrupt file is treated the same way (empty) rather than failing the whole
/// Pages surface; the next write rewrites it cleanly.
fn load_index(repo_root: &Path, scope: &NoteScope, bucket: &str) -> FolderIndex {
    let path = index_path(repo_root, scope, bucket);
    let Ok(bytes) = fs::read(&path) else {
        return FolderIndex::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Atomically persist a folder index (tmp + rename), creating the scope dir if
/// the bucket has no pages yet.
fn save_index(
    repo_root: &Path,
    scope: &NoteScope,
    bucket: &str,
    index: &FolderIndex,
) -> Result<(), String> {
    let dir = scope_dir(repo_root, scope, bucket);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    let path = index_path(repo_root, scope, bucket);
    let json =
        serde_json::to_string_pretty(index).map_err(|e| format!("serialize folders: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

// ─── Commands ─────────────────────────────────────────────────────────────

/// List a scope/bucket's folders, ordered by `order` then name. Missing index
/// ⇒ empty list (no error).
#[tauri::command]
pub async fn note_folders_list(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
) -> Result<Vec<PageFolder>, String> {
    let repo = PathBuf::from(&repo_root);
    let mut folders = load_index(&repo, &scope, &bucket).folders;
    folders.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.name.cmp(&b.name)));
    Ok(folders)
}

/// Create a folder. The new folder appends after the existing top-of-list
/// ordering (max order + 1) so it lands at the end of its parent group. The
/// name is trimmed; an empty name falls back to "New folder".
#[tauri::command]
pub async fn note_folder_create(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
    name: String,
    color: String,
    parent: Option<String>,
) -> Result<PageFolder, String> {
    let repo = PathBuf::from(&repo_root);
    let mut index = load_index(&repo, &scope, &bucket);
    let trimmed = name.trim();
    let name = if trimmed.is_empty() {
        "New folder".to_string()
    } else {
        trimmed.to_string()
    };
    let color = if color.trim().is_empty() {
        "blue".to_string()
    } else {
        color.trim().to_string()
    };
    let next_order = index.folders.iter().map(|f| f.order).max().unwrap_or(-1) + 1;
    let folder = PageFolder {
        id: new_folder_id(),
        name,
        color,
        order: next_order,
        parent: parent.filter(|p| !p.is_empty()),
    };
    index.folders.push(folder.clone());
    save_index(&repo, &scope, &bucket, &index)?;
    Ok(folder)
}

/// Rename a folder. Empty/whitespace names are rejected so a folder always has
/// a label.
#[tauri::command]
pub async fn note_folder_rename(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
    id: String,
    name: String,
) -> Result<PageFolder, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("folder name cannot be empty".to_string());
    }
    let repo = PathBuf::from(&repo_root);
    let mut index = load_index(&repo, &scope, &bucket);
    let folder = index
        .folders
        .iter_mut()
        .find(|f| f.id == id)
        .ok_or_else(|| format!("folder not found: {}", id))?;
    folder.name = trimmed.to_string();
    let updated = folder.clone();
    save_index(&repo, &scope, &bucket, &index)?;
    Ok(updated)
}

/// Change a folder's color token.
#[tauri::command]
pub async fn note_folder_set_color(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
    id: String,
    color: String,
) -> Result<PageFolder, String> {
    let color = color.trim();
    if color.is_empty() {
        return Err("folder color cannot be empty".to_string());
    }
    let repo = PathBuf::from(&repo_root);
    let mut index = load_index(&repo, &scope, &bucket);
    let folder = index
        .folders
        .iter_mut()
        .find(|f| f.id == id)
        .ok_or_else(|| format!("folder not found: {}", id))?;
    folder.color = color.to_string();
    let updated = folder.clone();
    save_index(&repo, &scope, &bucket, &index)?;
    Ok(updated)
}

/// Reorder folders by assigning each id its position in `ordered_ids` as the
/// new `order`. Ids absent from the list keep their old order (placed after the
/// reordered run). Unknown ids are ignored.
#[tauri::command]
pub async fn note_folder_reorder(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
    ordered_ids: Vec<String>,
) -> Result<Vec<PageFolder>, String> {
    let repo = PathBuf::from(&repo_root);
    let mut index = load_index(&repo, &scope, &bucket);
    for (pos, id) in ordered_ids.iter().enumerate() {
        if let Some(f) = index.folders.iter_mut().find(|f| &f.id == id) {
            f.order = pos as i64;
        }
    }
    save_index(&repo, &scope, &bucket, &index)?;
    let mut folders = index.folders;
    folders.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.name.cmp(&b.name)));
    Ok(folders)
}

/// Delete a folder. This NEVER deletes pages: every page whose `folder` field
/// points at this folder is reparented back to the root (its `folder` cleared)
/// through the normal note-metadata write path, so the change is durable +
/// broadcast. Any child folders are promoted to the deleted folder's parent so
/// they aren't orphaned. Returns the list of page ids that were moved to root.
#[tauri::command]
pub async fn note_folder_delete(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
    id: String,
) -> Result<Vec<String>, String> {
    let repo = PathBuf::from(&repo_root);
    let mut index = load_index(&repo, &scope, &bucket);
    // The parent the deleted folder's children should inherit.
    let inherited_parent = index
        .folders
        .iter()
        .find(|f| f.id == id)
        .and_then(|f| f.parent.clone());
    let existed = index.folders.iter().any(|f| f.id == id);
    if !existed {
        // Idempotent: deleting an already-gone folder is a no-op success.
        return Ok(Vec::new());
    }
    // Drop the folder; promote its direct children to its parent.
    index.folders.retain(|f| f.id != id);
    for f in index.folders.iter_mut() {
        if f.parent.as_deref() == Some(id.as_str()) {
            f.parent = inherited_parent.clone();
        }
    }
    save_index(&repo, &scope, &bucket, &index)?;

    // Reparent every page that lived in this folder back to the root. We move
    // pages — we do not touch their bodies and we certainly never remove them.
    let moved = cmd_notes::clear_folder_on_pages(&repo_root, &scope, &bucket, &id)?;
    Ok(moved)
}

/// Move a page into a folder (`folder_id = Some`) or back to the root
/// (`folder_id = None`). Thin wrapper over `cmd_notes`' metadata-write path so
/// the page's `folder` frontmatter is the single source of truth.
#[tauri::command]
pub async fn note_set_folder(
    repo_root: String,
    scope: NoteScope,
    bucket: String,
    page_id: String,
    folder_id: Option<String>,
) -> Result<cmd_notes::Note, String> {
    cmd_notes::set_note_folder(&repo_root, &scope, &bucket, &page_id, folder_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_notes;

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("aura-note-folders-{}-{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    async fn seed_page(
        repo: &Path,
        scope: NoteScope,
        bucket: &str,
        title: &str,
    ) -> String {
        let note = cmd_notes::notes_write(cmd_notes::NoteWriteInput {
            repo_root: repo.to_string_lossy().to_string(),
            scope,
            bucket: bucket.to_string(),
            id: None,
            body: format!("# {}\n", title),
            title: Some(title.to_string()),
            author: None,
            visibility: None,
            locked: None,
            tags: None,
            parent_id: None,
            archived_at: None,
            icon: None,
            folder: None,
        })
        .await
        .unwrap();
        note.id
    }

    #[tokio::test]
    async fn create_then_list_roundtrips() {
        let repo = tmp_repo("create");
        let root = repo.to_string_lossy().to_string();
        let f = note_folder_create(
            root.clone(),
            NoteScope::Team,
            String::new(),
            "  Specs  ".into(),
            "violet".into(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(f.name, "Specs"); // trimmed
        assert_eq!(f.color, "violet");
        let list = note_folders_list(root, NoteScope::Team, String::new())
            .await
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, f.id);
    }

    #[tokio::test]
    async fn missing_index_lists_empty() {
        let repo = tmp_repo("empty");
        let list = note_folders_list(
            repo.to_string_lossy().to_string(),
            NoteScope::Team,
            String::new(),
        )
        .await
        .unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn set_folder_then_page_reports_membership() {
        let repo = tmp_repo("setfolder");
        let root = repo.to_string_lossy().to_string();
        let page_id = seed_page(&repo, NoteScope::Team, "", "Plan").await;
        let folder = note_folder_create(
            root.clone(),
            NoteScope::Team,
            String::new(),
            "Group".into(),
            "blue".into(),
            None,
        )
        .await
        .unwrap();
        let moved = note_set_folder(
            root.clone(),
            NoteScope::Team,
            String::new(),
            page_id.clone(),
            Some(folder.id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(moved.frontmatter.folder.as_deref(), Some(folder.id.as_str()));
        // The list surfaces the membership too.
        let summaries = cmd_notes::notes_list(cmd_notes::NoteListInput {
            repo_root: root,
            scope: Some(NoteScope::Team),
            bucket: None,
        })
        .await
        .unwrap();
        let s = summaries.iter().find(|s| s.id == page_id).unwrap();
        assert_eq!(s.folder.as_deref(), Some(folder.id.as_str()));
    }

    #[tokio::test]
    async fn delete_folder_moves_pages_to_root_keeping_them() {
        let repo = tmp_repo("delete");
        let root = repo.to_string_lossy().to_string();
        let page_id = seed_page(&repo, NoteScope::Team, "", "Kept").await;
        let folder = note_folder_create(
            root.clone(),
            NoteScope::Team,
            String::new(),
            "Doomed".into(),
            "rose".into(),
            None,
        )
        .await
        .unwrap();
        note_set_folder(
            root.clone(),
            NoteScope::Team,
            String::new(),
            page_id.clone(),
            Some(folder.id.clone()),
        )
        .await
        .unwrap();

        let moved = note_folder_delete(
            root.clone(),
            NoteScope::Team,
            String::new(),
            folder.id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(moved, vec![page_id.clone()]);

        // The folder is gone…
        let folders = note_folders_list(root.clone(), NoteScope::Team, String::new())
            .await
            .unwrap();
        assert!(folders.is_empty());
        // …but the page still exists and is back at the root.
        let summaries = cmd_notes::notes_list(cmd_notes::NoteListInput {
            repo_root: root,
            scope: Some(NoteScope::Team),
            bucket: None,
        })
        .await
        .unwrap();
        let s = summaries.iter().find(|s| s.id == page_id).unwrap();
        assert!(s.folder.is_none());
    }

    #[tokio::test]
    async fn rename_and_color_roundtrip() {
        let repo = tmp_repo("rename");
        let root = repo.to_string_lossy().to_string();
        let f = note_folder_create(
            root.clone(),
            NoteScope::Channel,
            "general".into(),
            "Old".into(),
            "blue".into(),
            None,
        )
        .await
        .unwrap();
        let r = note_folder_rename(
            root.clone(),
            NoteScope::Channel,
            "general".into(),
            f.id.clone(),
            "New name".into(),
        )
        .await
        .unwrap();
        assert_eq!(r.name, "New name");
        let c = note_folder_set_color(
            root.clone(),
            NoteScope::Channel,
            "general".into(),
            f.id.clone(),
            "amber".into(),
        )
        .await
        .unwrap();
        assert_eq!(c.color, "amber");
        // Persisted: a fresh list reflects both.
        let list = note_folders_list(root, NoteScope::Channel, "general".into())
            .await
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "New name");
        assert_eq!(list[0].color, "amber");
    }

    #[tokio::test]
    async fn rename_rejects_empty() {
        let repo = tmp_repo("rejempty");
        let root = repo.to_string_lossy().to_string();
        let f = note_folder_create(
            root.clone(),
            NoteScope::Team,
            String::new(),
            "Keep".into(),
            "blue".into(),
            None,
        )
        .await
        .unwrap();
        let err = note_folder_rename(
            root,
            NoteScope::Team,
            String::new(),
            f.id,
            "   ".into(),
        )
        .await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn delete_promotes_child_folders_to_parent() {
        let repo = tmp_repo("nest");
        let root = repo.to_string_lossy().to_string();
        let parent = note_folder_create(
            root.clone(),
            NoteScope::Team,
            String::new(),
            "Parent".into(),
            "blue".into(),
            None,
        )
        .await
        .unwrap();
        let child = note_folder_create(
            root.clone(),
            NoteScope::Team,
            String::new(),
            "Child".into(),
            "teal".into(),
            Some(parent.id.clone()),
        )
        .await
        .unwrap();
        // Delete the parent → child becomes top-level (parent was None).
        note_folder_delete(root.clone(), NoteScope::Team, String::new(), parent.id)
            .await
            .unwrap();
        let list = note_folders_list(root, NoteScope::Team, String::new())
            .await
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, child.id);
        assert!(list[0].parent.is_none());
    }

    #[tokio::test]
    async fn reorder_assigns_positions() {
        let repo = tmp_repo("reorder");
        let root = repo.to_string_lossy().to_string();
        let a = note_folder_create(
            root.clone(),
            NoteScope::Team,
            String::new(),
            "A".into(),
            "blue".into(),
            None,
        )
        .await
        .unwrap();
        let b = note_folder_create(
            root.clone(),
            NoteScope::Team,
            String::new(),
            "B".into(),
            "blue".into(),
            None,
        )
        .await
        .unwrap();
        // Put B before A.
        let ordered = note_folder_reorder(
            root,
            NoteScope::Team,
            String::new(),
            vec![b.id.clone(), a.id.clone()],
        )
        .await
        .unwrap();
        assert_eq!(ordered[0].id, b.id);
        assert_eq!(ordered[1].id, a.id);
    }
}
