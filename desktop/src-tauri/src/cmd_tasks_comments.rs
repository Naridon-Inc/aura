//! Plane-parity task comments — threaded discussion attached to a
//! single task. Persisted to `<repoRoot>/.aura/tasks/task_comments.json`.
//!
//! Threading is one level deep (Plane's default): a comment either is
//! a top-level root or has `parent_comment_id` pointing at another
//! root. The backend does not enforce a depth cap — frontend renders
//! grandchildren under their root and the data shape tolerates
//! arbitrary depth — but the picker UI only exposes "reply to root".
//!
//! Activity hooks: every create emits a `commented` activity row on
//! the parent task so the timeline reflects discussion churn.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One comment row. `body` is markdown-ish text rendered through the
/// existing `MentionedText` component on the frontend — server-side
/// stays unaware of formatting so we can extend the renderer without
/// touching the persistence layer.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskComment {
    /// Stable id ("cmt_<uuid>"). Used as React key + the target of
    /// update / delete commands and `parent_comment_id` pointers.
    pub id: String,
    /// The task this comment is attached to. The frontend never
    /// renders cross-task threads; the backend filters by it inside
    /// `tasks_comments_list`.
    pub task_id: String,
    /// When set, this comment is a reply to that root comment.
    /// `None` means the comment IS a root. The backend does not
    /// validate that the pointer actually exists — a frontend that
    /// deletes a parent will simply render the orphan replies at the
    /// top level, matching how Plane behaves on deleted parents.
    #[serde(default)]
    pub parent_comment_id: Option<String>,
    /// Git handle of the author. Frontend uses it to colour-lookup
    /// the team-member avatar; `"system"` for auto-generated content.
    pub author_handle: String,
    /// Free-text body. Markdown-ish; rendered through `MentionedText`
    /// on the UI side.
    pub body: String,
    pub created_at: String,
    /// Same as `created_at` until the first edit, at which point
    /// `tasks_comments_update` bumps this so the UI can render an
    /// "(edited)" hint without a separate flag.
    pub updated_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct CommentFile {
    #[serde(default)]
    comments: Vec<TaskComment>,
}

fn comments_path(repo_root: &Path) -> PathBuf {
    repo_root
        .join(".aura")
        .join("tasks")
        .join("task_comments.json")
}

fn load_comments(repo_root: &Path) -> Result<CommentFile, String> {
    let p = comments_path(repo_root);
    if !p.exists() {
        return Ok(CommentFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save_comments(repo_root: &Path, file: &CommentFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&comments_path(repo_root), file)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_comment_id() -> String {
    format!("cmt_{}", uuid::Uuid::new_v4())
}

#[tauri::command]
pub async fn tasks_comments_list(
    repo_root: String,
    task_id: String,
) -> Result<Vec<TaskComment>, String> {
    let file = load_comments(Path::new(&repo_root))?;
    // Filter to this task; preserve insertion order so the UI can
    // render roots first then walk children in the order they were
    // written (matches Plane's "oldest first within a thread" layout).
    Ok(file
        .comments
        .into_iter()
        .filter(|c| c.task_id == task_id)
        .collect())
}

#[tauri::command]
pub async fn tasks_comments_create(
    repo_root: String,
    task_id: String,
    body: String,
    parent_comment_id: Option<String>,
    author_handle: Option<String>,
) -> Result<TaskComment, String> {
    let root = Path::new(&repo_root);
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err("comment body cannot be empty".into());
    }
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() {
        return Err("task_id is required".into());
    }
    let author = author_handle
        .and_then(|s| {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        })
        .unwrap_or_else(|| "system".to_string());
    let mut file = load_comments(root)?;
    // parent_comment_id is accepted as-is — we don't enforce that the
    // pointer exists. Plane allows reply-to-deleted; this matches.
    let now = now_iso();
    let comment = TaskComment {
        id: new_comment_id(),
        task_id: task_id.clone(),
        parent_comment_id: parent_comment_id
            .and_then(|s| if s.trim().is_empty() { None } else { Some(s) }),
        author_handle: author.clone(),
        body,
        created_at: now.clone(),
        updated_at: now,
    };
    file.comments.push(comment.clone());
    save_comments(root, &file)?;
    let _ = crate::cmd_tasks_activity::append_activity(
        root,
        &task_id,
        "commented",
        &author,
        serde_json::json!({
            "comment_id": comment.id,
            "parent_comment_id": comment.parent_comment_id,
        }),
    );
    Ok(comment)
}

#[tauri::command]
pub async fn tasks_comments_update(
    repo_root: String,
    id: String,
    body: String,
) -> Result<TaskComment, String> {
    let root = Path::new(&repo_root);
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err("comment body cannot be empty".into());
    }
    let mut file = load_comments(root)?;
    let mut updated: Option<TaskComment> = None;
    let now = now_iso();
    for c in file.comments.iter_mut() {
        if c.id == id {
            c.body = body.clone();
            c.updated_at = now.clone();
            updated = Some(c.clone());
            break;
        }
    }
    match updated {
        Some(c) => {
            save_comments(root, &file)?;
            Ok(c)
        }
        None => Err(format!("comment not found: {}", id)),
    }
}

#[tauri::command]
pub async fn tasks_comments_delete(repo_root: String, id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = load_comments(root)?;
    let before = file.comments.len();
    file.comments.retain(|c| c.id != id);
    if file.comments.len() == before {
        // Defensive: a delete on a missing id is a no-op rather than an
        // error so the frontend can fire deletes without read-first.
        return Ok(());
    }
    save_comments(root, &file)?;
    Ok(())
}

/// Drop every comment row for a task. Called by the task-delete path
/// so we don't leave stranded threads behind.
pub fn detach_comments_for(repo_root: &Path, task_id: &str) -> Result<(), String> {
    let mut file = load_comments(repo_root)?;
    let before = file.comments.len();
    file.comments.retain(|c| c.task_id != task_id);
    if file.comments.len() != before {
        save_comments(repo_root, &file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-oo5-comments-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn create_then_list_round_trips() {
        let repo = tmp_repo("create");
        let c = rt()
            .block_on(tasks_comments_create(
                repo.to_string_lossy().into_owned(),
                "task_a".into(),
                "hello world".into(),
                None,
                Some("owner".into()),
            ))
            .unwrap();
        assert!(c.id.starts_with("cmt_"));
        assert_eq!(c.author_handle, "owner");
        let listed = rt()
            .block_on(tasks_comments_list(
                repo.to_string_lossy().into_owned(),
                "task_a".into(),
            ))
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].body, "hello world");
    }

    #[test]
    fn create_threads_via_parent_comment_id() {
        let repo = tmp_repo("thread");
        let root = rt()
            .block_on(tasks_comments_create(
                repo.to_string_lossy().into_owned(),
                "task_a".into(),
                "root".into(),
                None,
                Some("owner".into()),
            ))
            .unwrap();
        let child = rt()
            .block_on(tasks_comments_create(
                repo.to_string_lossy().into_owned(),
                "task_a".into(),
                "reply".into(),
                Some(root.id.clone()),
                Some("owner".into()),
            ))
            .unwrap();
        assert_eq!(child.parent_comment_id.as_deref(), Some(root.id.as_str()));
        let listed = rt()
            .block_on(tasks_comments_list(
                repo.to_string_lossy().into_owned(),
                "task_a".into(),
            ))
            .unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn update_bumps_updated_at_and_overwrites_body() {
        let repo = tmp_repo("update");
        let c = rt()
            .block_on(tasks_comments_create(
                repo.to_string_lossy().into_owned(),
                "t".into(),
                "v1".into(),
                None,
                Some("a".into()),
            ))
            .unwrap();
        // Small sleep to ensure rfc3339 ticks; chrono is microsecond so
        // this is normally safe.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let next = rt()
            .block_on(tasks_comments_update(
                repo.to_string_lossy().into_owned(),
                c.id.clone(),
                "v2".into(),
            ))
            .unwrap();
        assert_eq!(next.body, "v2");
        assert_eq!(next.id, c.id);
        assert!(next.updated_at >= c.created_at);
    }

    #[test]
    fn delete_drops_just_that_row() {
        let repo = tmp_repo("del");
        let a = rt()
            .block_on(tasks_comments_create(
                repo.to_string_lossy().into_owned(),
                "t".into(),
                "a".into(),
                None,
                Some("u".into()),
            ))
            .unwrap();
        let _b = rt()
            .block_on(tasks_comments_create(
                repo.to_string_lossy().into_owned(),
                "t".into(),
                "b".into(),
                None,
                Some("u".into()),
            ))
            .unwrap();
        rt()
            .block_on(tasks_comments_delete(
                repo.to_string_lossy().into_owned(),
                a.id.clone(),
            ))
            .unwrap();
        let listed = rt()
            .block_on(tasks_comments_list(
                repo.to_string_lossy().into_owned(),
                "t".into(),
            ))
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].body, "b");
    }

    #[test]
    fn empty_body_rejected_on_create_and_update() {
        let repo = tmp_repo("empty");
        let err = rt()
            .block_on(tasks_comments_create(
                repo.to_string_lossy().into_owned(),
                "t".into(),
                "   ".into(),
                None,
                Some("a".into()),
            ))
            .unwrap_err();
        assert!(err.contains("empty"));
        let c = rt()
            .block_on(tasks_comments_create(
                repo.to_string_lossy().into_owned(),
                "t".into(),
                "ok".into(),
                None,
                Some("a".into()),
            ))
            .unwrap();
        let err = rt()
            .block_on(tasks_comments_update(
                repo.to_string_lossy().into_owned(),
                c.id,
                "".into(),
            ))
            .unwrap_err();
        assert!(err.contains("empty"));
    }
}
