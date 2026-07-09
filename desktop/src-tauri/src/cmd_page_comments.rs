//! PR/ticket-style comment threads for Pages.
//!
//! Pages live as markdown files under `<repoRoot>/.aura/notes/<scope>/...`
//! (see `cmd_notes`). Their conversation threads are kept *beside* the page
//! as a sidecar JSON so the markdown body stays clean and a comment never
//! mutates the page's frontmatter / `updated_at`. Layout mirrors the notes
//! tree:
//!
//! ```text
//! .aura/notes/team/comments/<id>.json
//! .aura/notes/channel/<channel>/comments/<id>.json
//! .aura/notes/member/<handle>/comments/<id>.json
//! ```
//!
//! The file holds a flat array of `Comment` records. Writes go through the
//! same atomic tmp-write + rename dance the notes commands use, so a crash
//! mid-write can never leave a half-written (corrupt) thread on disk — the
//! reader either sees the old complete file or the new complete file.
//!
//! Path resolution (repo-root → `.aura/notes` → scope dir → bucket segment)
//! is kept faithful to `cmd_notes`: same scope names, same `sanitize_segment`
//! traversal guard, so a thread for page `id` always sits next to that page.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A single comment in a page's thread. Ordered oldest-first on disk so the
/// conversation reads top-to-bottom like a PR review.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Comment {
    /// Stable id, minted on the backend so the frontend can reconcile its
    /// optimistic row against the persisted one.
    pub id: String,
    /// The handle (or display name) of whoever wrote it.
    pub author: String,
    /// Raw comment text. Rendered as plain text with line breaks on the
    /// frontend — no markdown parse, kept deliberately lightweight.
    pub body: String,
    /// RFC3339 creation timestamp.
    pub created_at: String,
    /// Set (RFC3339) when someone resolved the comment; absent while open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

/// The notes root — identical resolution to `cmd_notes::notes_root` so the
/// comment sidecars sit inside the same `.aura/notes` tree the pages live in.
fn notes_root(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("notes")
}

/// Dir name for a scope, matching `cmd_notes`'s scope folders exactly.
fn scope_dir_name(scope: &str) -> &'static str {
    match scope {
        "channel" => "channel",
        "member" => "member",
        // Default (and explicit "team") → the team scope.
        _ => "team",
    }
}

/// Strip path-unsafe characters from a single path segment. Mirrors
/// `cmd_notes::sanitize_segment`: blocks `/`, `\`, NUL, control chars, and any
/// `..` traversal so a hostile bucket/id can't escape the notes root.
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

/// `comments/` directory for a given page's scope+bucket. Sits as a sibling
/// of the page's own `.md` file's directory (the page is at
/// `<scope>/[bucket/]<id>.md`; its thread is at `<scope>/[bucket/]comments/`).
fn comments_dir(repo_root: &Path, scope: &str, bucket: &str) -> PathBuf {
    let base = notes_root(repo_root).join(scope_dir_name(scope));
    let scoped = match scope_dir_name(scope) {
        // Team pages live flat under `team/`, so the thread dir is `team/comments/`.
        "team" => base,
        // Channel/member pages are bucketed one level deeper.
        _ => {
            if bucket.is_empty() {
                base
            } else {
                base.join(sanitize_segment(bucket))
            }
        }
    };
    scoped.join("comments")
}

/// Full path to one page's thread file.
fn comments_path(repo_root: &Path, scope: &str, bucket: &str, id: &str) -> PathBuf {
    comments_dir(repo_root, scope, bucket).join(format!("{}.json", sanitize_segment(id)))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    format!("cmt_{}", uuid::Uuid::new_v4())
}

/// Read a page's thread off disk. A missing file is an empty thread, not an
/// error — a page simply has no comments yet. A corrupt file (shouldn't
/// happen given atomic writes) surfaces as an error so it isn't silently
/// clobbered.
fn read_thread(path: &Path) -> Result<Vec<Comment>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_slice::<Vec<Comment>>(&bytes)
        .map_err(|e| format!("parse {}: {}", path.display(), e))
}

/// Atomically persist a thread (tmp write + rename) so a crash can't corrupt
/// it — the same durability discipline `cmd_notes` uses for the page itself.
fn write_thread(path: &Path, thread: &[Comment]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(thread)
        .map_err(|e| format!("serialize thread: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

/// List a page's comments, oldest-first.
#[tauri::command]
pub async fn page_comments_list(
    repo_root: String,
    scope: String,
    bucket: String,
    id: String,
) -> Result<Vec<Comment>, String> {
    let repo = PathBuf::from(&repo_root);
    let path = comments_path(&repo, &scope, &bucket, &id);
    read_thread(&path)
}

/// Append a comment to a page's thread and return the persisted row. Rejects
/// an empty body so the UI can't add a blank comment.
#[tauri::command]
pub async fn page_comments_add(
    repo_root: String,
    scope: String,
    bucket: String,
    id: String,
    author: String,
    body: String,
) -> Result<Comment, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("comment body is empty".to_string());
    }
    let repo = PathBuf::from(&repo_root);
    let path = comments_path(&repo, &scope, &bucket, &id);
    let mut thread = read_thread(&path)?;
    let comment = Comment {
        id: new_id(),
        author: if author.trim().is_empty() {
            "someone".to_string()
        } else {
            author.trim().to_string()
        },
        body: trimmed.to_string(),
        created_at: now_iso(),
        resolved_at: None,
    };
    thread.push(comment.clone());
    write_thread(&path, &thread)?;
    Ok(comment)
}

/// Toggle a comment's resolved state. Sets `resolved_at` to now when
/// `resolved` is true, clears it otherwise. Returns the updated comment.
#[tauri::command]
pub async fn page_comments_resolve(
    repo_root: String,
    scope: String,
    bucket: String,
    id: String,
    comment_id: String,
    resolved: bool,
) -> Result<Comment, String> {
    let repo = PathBuf::from(&repo_root);
    let path = comments_path(&repo, &scope, &bucket, &id);
    let mut thread = read_thread(&path)?;
    let Some(slot) = thread.iter_mut().find(|c| c.id == comment_id) else {
        return Err(format!("comment not found: {}", comment_id));
    };
    slot.resolved_at = if resolved { Some(now_iso()) } else { None };
    let updated = slot.clone();
    write_thread(&path, &thread)?;
    Ok(updated)
}

/// Delete a comment from a page's thread. Idempotent — deleting an
/// already-gone comment is a no-op success.
#[tauri::command]
pub async fn page_comments_delete(
    repo_root: String,
    scope: String,
    bucket: String,
    id: String,
    comment_id: String,
) -> Result<(), String> {
    let repo = PathBuf::from(&repo_root);
    let path = comments_path(&repo, &scope, &bucket, &id);
    let mut thread = read_thread(&path)?;
    let before = thread.len();
    thread.retain(|c| c.id != comment_id);
    if thread.len() != before {
        write_thread(&path, &thread)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("aura-page-comments-{}-{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn add_then_list_roundtrips() {
        let repo = tmp_repo("rt");
        let root = repo.to_string_lossy().to_string();
        // Empty thread for a page with no comments yet.
        let empty = page_comments_list(root.clone(), "team".into(), "".into(), "p1".into())
            .await
            .unwrap();
        assert!(empty.is_empty());

        let c = page_comments_add(
            root.clone(),
            "team".into(),
            "".into(),
            "p1".into(),
            "alice".into(),
            "looks good".into(),
        )
        .await
        .unwrap();
        assert_eq!(c.author, "alice");
        assert_eq!(c.body, "looks good");
        assert!(c.resolved_at.is_none());

        let listed = page_comments_list(root, "team".into(), "".into(), "p1".into())
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, c.id);
    }

    #[tokio::test]
    async fn empty_body_is_rejected() {
        let repo = tmp_repo("empty");
        let root = repo.to_string_lossy().to_string();
        let err = page_comments_add(
            root,
            "team".into(),
            "".into(),
            "p1".into(),
            "bob".into(),
            "   \n  ".into(),
        )
        .await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn resolve_and_delete() {
        let repo = tmp_repo("res");
        let root = repo.to_string_lossy().to_string();
        let c = page_comments_add(
            root.clone(),
            "channel".into(),
            "general".into(),
            "p1".into(),
            "carol".into(),
            "nit: rename this".into(),
        )
        .await
        .unwrap();

        let resolved = page_comments_resolve(
            root.clone(),
            "channel".into(),
            "general".into(),
            "p1".into(),
            c.id.clone(),
            true,
        )
        .await
        .unwrap();
        assert!(resolved.resolved_at.is_some());

        // Persisted resolve survives a reload.
        let listed = page_comments_list(
            root.clone(),
            "channel".into(),
            "general".into(),
            "p1".into(),
        )
        .await
        .unwrap();
        assert!(listed[0].resolved_at.is_some());

        page_comments_delete(
            root.clone(),
            "channel".into(),
            "general".into(),
            "p1".into(),
            c.id.clone(),
        )
        .await
        .unwrap();
        let after = page_comments_list(root, "channel".into(), "general".into(), "p1".into())
            .await
            .unwrap();
        assert!(after.is_empty());
    }

    #[test]
    fn comments_dir_mirrors_notes_tree() {
        let repo = PathBuf::from("/tmp/r");
        assert!(comments_dir(&repo, "team", "")
            .ends_with("notes/team/comments"));
        assert!(comments_dir(&repo, "channel", "general")
            .ends_with("notes/channel/general/comments"));
        assert!(comments_dir(&repo, "member", "alice")
            .ends_with("notes/member/alice/comments"));
        // Traversal in the id can't escape the comments dir.
        let p = comments_path(&repo, "team", "", "../../etc/passwd");
        assert!(p.to_string_lossy().contains("comments"));
        assert!(!p.to_string_lossy().contains(".."));
    }
}
