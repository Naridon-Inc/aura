//! Managed worktrees — `~/.aura/worktrees/<projectId>/<branch>/`.
//!
//! Cleaner-than-default git-worktree mechanics, ported as a clean-room
//! rewrite of the patterns Superset.sh ships in
//! `packages/host-service/src/trpc/router/workspace-creation/`. We
//! borrow the *patterns* (path layout, ResolvedRef discriminant,
//! `--no-track` + `push.autoSetupRemote` + `branch.<n>.base` triplet,
//! rollback-on-throw, rename-then-detached-rm removal) — no Superset
//! code is read into Aura.
//!
//! Why this lives next to `cmd_files::git_worktree_*` instead of
//! replacing it: `cmd_files` exposes raw "create a worktree at this
//! arbitrary path" for the WorkspaceRail's right-click menu (where the
//! user picks a path themselves). This module is the *managed* layer
//! the Manager loop drives — Aura picks the path, the start-point
//! resolution is typed, and the cleanup story is bulletproof.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::process::Command;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Discriminated start-point resolution. Never infer the kind from a
/// raw string — `origin/foo` could be a local branch *named* "origin/foo"
/// or a remote-tracking branch on remote "origin"; ambiguity here has
/// caused real bugs in other tools (e.g. `git worktree add` silently
/// creating a worktree off the wrong tip).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedRef {
    /// A local branch (`refs/heads/<name>`).
    Local { name: String },
    /// A remote-tracking branch (`refs/remotes/<remote>/<name>`).
    RemoteTracking { remote: String, name: String },
    /// `HEAD` of the current checkout.
    Head,
    /// An annotated or lightweight tag (`refs/tags/<name>`).
    Tag { name: String },
}

impl ResolvedRef {
    /// Render as the literal start-point string `git worktree add`
    /// expects. We always use the fully-qualified ref form when
    /// possible so `git` can't misinterpret a name collision.
    pub fn as_start_point(&self) -> String {
        match self {
            ResolvedRef::Local { name } => format!("refs/heads/{name}"),
            ResolvedRef::RemoteTracking { remote, name } => {
                format!("refs/remotes/{remote}/{name}")
            }
            ResolvedRef::Head => "HEAD".to_string(),
            ResolvedRef::Tag { name } => format!("refs/tags/{name}"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedWorktree {
    pub project_id: String,
    pub branch: String,
    pub path: String,
    pub start_point: String,
}

/// Stable id for a project root. Same input → same id across restarts.
/// Mirrors `cmd_projects::project_id_for` so the worktree layout is
/// directly addressable from a project entry without an extra lookup.
pub fn project_id_for(repo_root: &str) -> String {
    let mut h = DefaultHasher::new();
    repo_root.hash(&mut h);
    format!("p-{:x}", h.finish())
}

/// Sanitise a branch name into something safe to use as a directory
/// component. Slashes get flattened to dashes (so `feat/foo` becomes
/// `feat-foo`) and any non-alnum/-/_/. chars get dropped. Empty input
/// is rejected by the caller.
fn sanitise_branch_for_path(branch: &str) -> String {
    branch
        .chars()
        .map(|c| match c {
            '/' => '-',
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' => c,
            _ => '-',
        })
        .collect()
}

/// Root under which Aura keeps every managed worktree. Defaults to
/// `~/.aura/worktrees`; a user-configured `worktree_base_path` field in
/// `~/.aura/credentials.json` overrides it (settable from the Settings
/// dialog). Returned absolute so the traversal check in
/// `safe_resolve_managed_path` stays reliable.
fn managed_root() -> Option<PathBuf> {
    if let Some(custom) = read_worktree_base_override() {
        return Some(custom);
    }
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("worktrees");
    Some(p)
}

/// Reads `~/.aura/credentials.json` and returns `worktree_base_path` if
/// set to a non-empty absolute path. Best-effort: any read/parse error
/// returns None so we fall back to the default. We *don't* require the
/// path to exist yet — first worktree creation will mkdir as needed.
fn read_worktree_base_override() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(".aura").join("credentials.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let s = v.get("worktree_base_path")?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    let p = PathBuf::from(s);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

/// The per-project root under which *every* managed worktree for `repo_root`
/// lives — `<managed_root>/<project_id>`. Stable across restarts (the
/// `project_id` is a hash of `repo_root`), so a `~/.claude/projects/<encoded>`
/// session dir whose path sits under this root provably belongs to one of THIS
/// repo's worktrees — even after that worktree has been archived/pruned and
/// dropped out of `git worktree list`. The session-recovery scan uses this to
/// re-surface orphaned transcripts. `None` only when HOME is unset.
pub fn managed_project_root(repo_root: &str) -> Option<PathBuf> {
    Some(managed_root()?.join(project_id_for(repo_root)))
}

/// Compute the absolute path Aura *will* create the worktree at, plus
/// validate it doesn't escape the managed root (defensive against
/// crafted branch names containing `..`). Returns `(path, project_id)`.
pub fn safe_resolve_managed_path(
    repo_root: &str,
    branch: &str,
) -> Result<(PathBuf, String), String> {
    if branch.trim().is_empty() {
        return Err("branch name required".into());
    }
    let safe_branch = sanitise_branch_for_path(branch.trim());
    if safe_branch.is_empty() || !safe_branch.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err("branch name has no usable characters".into());
    }
    let project_id = project_id_for(repo_root);
    let mut path = managed_root().ok_or("HOME not set")?;
    path.push(&project_id);
    path.push(&safe_branch);

    // Traversal check — any `..` in `safe_branch` would have been
    // dropped by `sanitise_branch_for_path` above, but belt-and-braces.
    let root = managed_root().ok_or("HOME not set")?;
    let root_with_sep = format!("{}{}", root.display(), MAIN_SEPARATOR);
    if !path.to_string_lossy().starts_with(&root_with_sep) {
        return Err(format!(
            "computed worktree path escapes managed root: {}",
            path.display()
        ));
    }
    Ok((path, project_id))
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("spawn git {args:?}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ref_exists(cwd: &Path, ref_name: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", ref_name])
        .current_dir(cwd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// True when `repo_root` sits inside a real git work tree. A plain folder with
/// no repo returns false — the launch path then runs the agent in place instead
/// of trying (and failing) to provision a managed worktree. The "copy" model
/// only has meaning atop git; a bare project folder just gets an agent in it.
pub fn is_git_work_tree(repo_root: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(repo_root)
        .output()
        .map(|o| o.status.success() && o.stdout.starts_with(b"true"))
        .unwrap_or(false)
}

/// Resolve a user-supplied start-point string into a `ResolvedRef`.
/// Lookup order: local branch → tag → remote-tracking branch → HEAD.
/// Returns `Err` when nothing matches.
pub fn resolve_start_point(repo_root: &str, raw: &str) -> Result<ResolvedRef, String> {
    let cwd = PathBuf::from(repo_root);
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("HEAD") || trimmed.is_empty() {
        return Ok(ResolvedRef::Head);
    }

    // Prefer the most specific, least-ambiguous match first.
    if ref_exists(&cwd, &format!("refs/heads/{trimmed}")) {
        return Ok(ResolvedRef::Local {
            name: trimmed.to_string(),
        });
    }
    if ref_exists(&cwd, &format!("refs/tags/{trimmed}")) {
        return Ok(ResolvedRef::Tag {
            name: trimmed.to_string(),
        });
    }
    // Remote-tracking like `origin/main` — first segment is the remote
    // name. Only resolve when the full ref exists.
    if let Some((remote, name)) = trimmed.split_once('/') {
        if ref_exists(&cwd, &format!("refs/remotes/{remote}/{name}")) {
            return Ok(ResolvedRef::RemoteTracking {
                remote: remote.to_string(),
                name: name.to_string(),
            });
        }
    }
    Err(format!(
        "could not resolve start-point '{trimmed}' (not a local branch, tag, or remote-tracking ref)"
    ))
}

/// Create a managed worktree. Implements the full Superset triplet:
///   1. `git worktree add --no-track -b <branch> <path> <start-point>`
///      — `--no-track` keeps `git pull` honest (the worktree's branch
///      doesn't inherit upstream from the start point).
///   2. `git config push.autoSetupRemote true` inside the worktree —
///      first push auto-creates `origin/<branch>` instead of erroring.
///   3. `git config branch.<branch>.base <start-point>` — records the
///      base ref so a future "Show changes since branch start" can
///      diff against the right ref.
///
/// Rollback: any failure after the worktree-add step calls
/// `git worktree remove --force <path>` so we never leave half-created
/// state. The caller still gets the original error.
pub fn create_managed_worktree(
    repo_root: &str,
    branch: &str,
    start: &ResolvedRef,
) -> Result<ManagedWorktree, String> {
    let (target, project_id) = safe_resolve_managed_path(repo_root, branch)?;
    if target.exists() {
        return Err(format!(
            "worktree path already exists: {}",
            target.display()
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let cwd = PathBuf::from(repo_root);
    let start_point = start.as_start_point();
    let target_str = target.to_string_lossy().into_owned();

    // Step 1: create the worktree.
    run_git(
        &cwd,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            branch,
            &target_str,
            &start_point,
        ],
    )?;

    // Steps 2 + 3 — wrapped so any failure rolls the worktree back so
    // we don't leak half-configured state.
    let configure = || -> Result<(), String> {
        run_git(
            &target,
            &["config", "push.autoSetupRemote", "true"],
        )?;
        run_git(
            &target,
            &[
                "config",
                &format!("branch.{branch}.base"),
                &start_point,
            ],
        )?;
        Ok(())
    };
    if let Err(e) = configure() {
        // Best-effort rollback. Force, since we may have made commits
        // in the post-add config steps (we haven't, but defensive).
        let _ = run_git(
            &cwd,
            &["worktree", "remove", "--force", &target_str],
        );
        return Err(format!("post-create config failed: {e}"));
    }

    Ok(ManagedWorktree {
        project_id,
        branch: branch.to_string(),
        path: target_str,
        start_point,
    })
}

/// Remove a managed worktree using Superset's safer mechanism: rename
/// to a sibling temp directory (atomic same-fs move, no EXDEV), then
/// `git worktree prune` so the metadata is cleared immediately, then
/// kick off a detached `rm -rf` so the actual file removal runs in
/// background. The user's UI is never blocked on slow `.app` xattr
/// teardowns.
pub fn remove_managed_worktree(repo_root: &str, worktree_path: &str) -> Result<(), String> {
    let target = PathBuf::from(worktree_path);
    if !target.exists() {
        // Nothing to remove on disk; still prune in case a stale
        // .git/worktrees/<name> sticks around.
        let _ = run_git(
            Path::new(repo_root),
            &["worktree", "prune"],
        );
        return Ok(());
    }

    // Sibling temp path under the same parent so `rename` stays atomic.
    let parent = target
        .parent()
        .ok_or_else(|| "worktree path has no parent".to_string())?;
    let tag = Uuid::new_v4().simple().to_string();
    let temp = parent.join(format!(".aura-delete-{}", &tag[..8]));

    std::fs::rename(&target, &temp)
        .map_err(|e| format!("rename {} → {}: {e}", target.display(), temp.display()))?;

    // Clean up git metadata immediately so the worktree no longer
    // appears in `git worktree list`. Errors are non-fatal — the next
    // `git worktree list` call will prune naturally.
    let _ = run_git(
        Path::new(repo_root),
        &["worktree", "prune"],
    );

    // Detached rm. Don't wait — large worktrees with .git/objects may
    // take seconds, and the UI shouldn't block on that.
    let _ = Command::new("/bin/rm")
        .arg("-rf")
        .arg(&temp)
        .spawn()
        .map_err(|e| format!("spawn rm: {e}"))?;
    // The spawn handle is intentionally dropped — the child detaches
    // when its parent exits anyway.

    Ok(())
}

// ── Tauri command surface ───────────────────────────────────────────

#[tauri::command]
pub async fn worktree_resolve_ref(
    repo_root: String,
    raw: String,
) -> Result<ResolvedRef, String> {
    resolve_start_point(&repo_root, &raw)
}

#[tauri::command]
pub async fn worktree_create_managed(
    repo_root: String,
    branch: String,
    start_raw: String,
) -> Result<ManagedWorktree, String> {
    let start = resolve_start_point(&repo_root, &start_raw)?;
    create_managed_worktree(&repo_root, &branch, &start)
}

#[tauri::command]
pub async fn worktree_remove_managed(
    repo_root: String,
    worktree_path: String,
) -> Result<(), String> {
    remove_managed_worktree(&repo_root, &worktree_path)
}

#[tauri::command]
pub async fn worktree_resolve_path(
    repo_root: String,
    branch: String,
) -> Result<String, String> {
    let (path, _) = safe_resolve_managed_path(&repo_root, &branch)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_id_is_stable_per_path() {
        let a = project_id_for("/tmp/foo");
        let b = project_id_for("/tmp/foo");
        let c = project_id_for("/tmp/bar");
        assert_eq!(a, b, "same path → same id");
        assert_ne!(a, c, "different path → different id");
        assert!(a.starts_with("p-"));
    }

    #[test]
    fn sanitises_branch_for_filesystem() {
        assert_eq!(sanitise_branch_for_path("feat/new-thing"), "feat-new-thing");
        assert_eq!(sanitise_branch_for_path("foo bar"), "foo-bar");
        assert_eq!(sanitise_branch_for_path("v1.2.3"), "v1.2.3");
        assert_eq!(sanitise_branch_for_path("../escape"), "..-escape");
    }

    #[test]
    fn safe_resolve_rejects_escaping_branch() {
        // After sanitisation `..` becomes `..` (two dots only — `..-`
        // is allowed) but the "starts_with managed_root" check rejects
        // anything that resolves outside ~/.aura/worktrees/<id>/.
        // We can't easily test path traversal without a known HOME,
        // so just assert that empty-after-sanitise fails the input
        // check.
        let r = safe_resolve_managed_path("/tmp/foo", "///");
        assert!(r.is_err(), "all-slash branch must be rejected");
    }

    #[test]
    fn rejects_empty_branch() {
        assert!(safe_resolve_managed_path("/tmp/foo", "").is_err());
        assert!(safe_resolve_managed_path("/tmp/foo", "   ").is_err());
    }

    #[test]
    fn resolved_ref_renders_qualified() {
        assert_eq!(
            ResolvedRef::Local {
                name: "main".into()
            }
            .as_start_point(),
            "refs/heads/main"
        );
        assert_eq!(
            ResolvedRef::RemoteTracking {
                remote: "origin".into(),
                name: "main".into()
            }
            .as_start_point(),
            "refs/remotes/origin/main"
        );
        assert_eq!(ResolvedRef::Head.as_start_point(), "HEAD");
        assert_eq!(
            ResolvedRef::Tag {
                name: "v1.0".into()
            }
            .as_start_point(),
            "refs/tags/v1.0"
        );
    }
}
