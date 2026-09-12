//! Lost-worktree recovery — find checkouts that git no longer lists and
//! attach them back to their project.
//!
//! The roster's worktree rows come straight from `git worktree list`. When
//! the app (or the machine) dies at the wrong moment — or `.git/worktrees/`
//! gets wiped, or a checkout is parked elsewhere and moved back — git's
//! registry and the disk stop agreeing, and a checkout that still exists
//! simply vanishes from the sidebar. This module is the manual way back:
//!
//!   • `scan_lost`   — walk the managed per-project directory and report
//!                     ORPHANS (a checkout on disk git doesn't list) and
//!                     GHOSTS (git lists it, the directory is gone).
//!   • `reattach`    — try `git worktree repair` first (fixes every "it
//!                     moved" case); when the registration itself was
//!                     deleted, rebuild the admin directory by hand and
//!                     rebuild the index with `git reset --mixed`, never
//!                     touching working files.
//!   • `prune_ghosts`— `git worktree prune` for the listed-but-gone rows.
//!
//! Everything here is fenced to the managed root (`~/.aura/worktrees/<id>/`)
//! the same way removal is: these commands write into `.git/`, and a stale
//! or crafted path must never point that pen at an arbitrary repository.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::worktree::{managed_project_root, sanitise_branch_for_path};

/// A checkout that exists on disk under the managed root but is absent
/// from `git worktree list` — the thing the sidebar lost.
#[derive(Debug, Clone, Serialize)]
pub struct OrphanWorktree {
    pub path: String,
    /// The branch we believe it was on — read from its surviving admin
    /// directory when possible, else matched from the directory name.
    pub branch: Option<String>,
    /// Why it's detached, in the user's terms.
    pub reason: String,
    /// Whether `reattach` expects to succeed (a branch is known and not
    /// already checked out somewhere alive).
    pub attachable: bool,
}

/// The mirror image: git still lists it but the directory is gone.
#[derive(Debug, Clone, Serialize)]
pub struct GhostWorktree {
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeScanReport {
    pub orphans: Vec<OrphanWorktree>,
    pub ghosts: Vec<GhostWorktree>,
    /// Where orphans were looked for; `None` when the project has no
    /// managed directory yet (nothing was ever created → nothing to lose).
    pub scanned_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReattachOutcome {
    /// "repaired" (git fixed its own pointers) or "reconstructed" (the
    /// registration was rebuilt from scratch).
    pub method: String,
    pub branch: Option<String>,
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

/// One row of `git worktree list --porcelain`.
struct ListedWorktree {
    path: PathBuf,
    branch: Option<String>,
}

/// Parse `git worktree list --porcelain`. First entry is always the main
/// checkout. Detached / prunable / locked annotations are tolerated —
/// only `worktree` and `branch` lines are read.
fn list_worktrees(repo_root: &Path) -> Result<Vec<ListedWorktree>, String> {
    let raw = run_git(repo_root, &["worktree", "list", "--porcelain"])?;
    let mut rows: Vec<ListedWorktree> = Vec::new();
    for block in raw.split("\n\n") {
        let mut path: Option<PathBuf> = None;
        let mut branch: Option<String> = None;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p.trim()));
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(
                    b.trim()
                        .strip_prefix("refs/heads/")
                        .unwrap_or(b.trim())
                        .to_string(),
                );
            }
        }
        if let Some(p) = path {
            rows.push(ListedWorktree { path: p, branch });
        }
    }
    Ok(rows)
}

/// Best guess at the branch a detached checkout was on.
/// 1. Its `.git` file names an admin dir whose `HEAD` survived → read it.
/// 2. Else match the directory name against local branches through the
///    same sanitiser that named the directory at creation. Only an
///    unambiguous single match counts — `feat/x` and `feat-x` both
///    flatten to `feat-x`, and guessing between them would attach the
///    checkout to the wrong history.
fn guess_branch(repo_root: &Path, orphan: &Path) -> Option<String> {
    if let Some(admin) = read_gitfile_target(orphan) {
        if let Ok(head) = std::fs::read_to_string(admin.join("HEAD")) {
            if let Some(b) = head.trim().strip_prefix("ref: refs/heads/") {
                return Some(b.to_string());
            }
        }
    }
    let dir_name = orphan.file_name()?.to_str()?.to_string();
    let branches = run_git(
        repo_root,
        &["for-each-ref", "refs/heads", "--format=%(refname:short)"],
    )
    .ok()?;
    let matches: Vec<&str> = branches
        .lines()
        .filter(|b| sanitise_branch_for_path(b) == dir_name)
        .collect();
    match matches.as_slice() {
        [one] => Some((*one).to_string()),
        _ => None,
    }
}

/// Read the `gitdir: <path>` pointer out of a linked worktree's `.git`
/// FILE (a linked checkout's `.git` is a file, not a directory). Returns
/// the pointed-to admin directory, absolute.
fn read_gitfile_target(worktree: &Path) -> Option<PathBuf> {
    let gitfile = worktree.join(".git");
    if !gitfile.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(&gitfile).ok()?;
    let target = raw.trim().strip_prefix("gitdir:")?.trim();
    let p = PathBuf::from(target);
    if p.is_absolute() {
        Some(p)
    } else {
        Some(worktree.join(p))
    }
}

/// Core scan against an explicit managed directory (testable without HOME).
pub fn scan_lost_at(repo_root: &str, managed_dir: &Path) -> Result<WorktreeScanReport, String> {
    let root = Path::new(repo_root);
    let listed = list_worktrees(root)?;

    // Canonical set of live registered checkouts. Entries whose directory
    // is gone can't canonicalise — they are the ghosts (main excluded:
    // a missing main checkout is a different disaster, not ours to prune).
    let mut registered: Vec<PathBuf> = Vec::new();
    let mut ghosts: Vec<GhostWorktree> = Vec::new();
    for (i, row) in listed.iter().enumerate() {
        match row.path.canonicalize() {
            Ok(c) => registered.push(c),
            Err(_) if i > 0 => ghosts.push(GhostWorktree {
                path: row.path.to_string_lossy().into_owned(),
                branch: row.branch.clone(),
            }),
            Err(_) => {}
        }
    }
    // Branches already attached to a live checkout — a rebuilt worktree
    // must not claim one of these.
    let live_branches: Vec<String> = listed
        .iter()
        .filter(|r| r.path.exists())
        .filter_map(|r| r.branch.clone())
        .collect();

    let mut orphans: Vec<OrphanWorktree> = Vec::new();
    if managed_dir.is_dir() {
        let entries =
            std::fs::read_dir(managed_dir).map_err(|e| format!("read {}: {e}", managed_dir.display()))?;
        for entry in entries.flatten() {
            let dir = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            // In-flight deletions from remove_managed_worktree.
            if name.starts_with(".aura-delete-") || name.starts_with('.') {
                continue;
            }
            if !dir.is_dir() || !dir.join(".git").exists() {
                continue;
            }
            let canon = match dir.canonicalize() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if registered.iter().any(|r| *r == canon) {
                continue;
            }
            let admin = read_gitfile_target(&dir);
            let admin_alive = admin.as_deref().map(Path::exists).unwrap_or(false);
            let branch = guess_branch(root, &dir);
            let branch_free = branch
                .as_ref()
                .map(|b| !live_branches.iter().any(|l| l == b))
                .unwrap_or(false);
            let reason = if admin_alive {
                "its link to the repository broke".to_string()
            } else {
                "its registration was deleted from the repository".to_string()
            };
            orphans.push(OrphanWorktree {
                path: dir.to_string_lossy().into_owned(),
                attachable: admin_alive || branch_free,
                branch,
                reason,
            });
        }
    }
    orphans.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(WorktreeScanReport {
        orphans,
        ghosts,
        scanned_root: managed_dir
            .is_dir()
            .then(|| managed_dir.to_string_lossy().into_owned()),
    })
}

/// Attach one orphan back. `git worktree repair` first — it fixes every
/// "something moved" case by rewriting the two pointers. Only when the
/// registration itself is gone do we rebuild it: a fresh admin directory
/// pointing at the orphan, HEAD on the branch we can prove was its own,
/// then `git reset --mixed` to rebuild the lost index against that HEAD
/// without touching a single working file — uncommitted edits surface as
/// modifications instead of being clobbered.
pub fn reattach_at(
    repo_root: &str,
    worktree_path: &str,
    managed_dir: &Path,
) -> Result<ReattachOutcome, String> {
    let root = Path::new(repo_root);
    let target = PathBuf::from(worktree_path);
    let canon_target = target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))?;

    // Fence: we are about to write into a repository's .git — only ever on
    // behalf of a checkout that lives under this project's managed root.
    let canon_fence = managed_dir
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", managed_dir.display()))?;
    if !canon_target.starts_with(&canon_fence) {
        return Err(format!(
            "refusing to attach {}: not under this project's managed worktrees ({})",
            target.display(),
            managed_dir.display()
        ));
    }
    if !canon_target.join(".git").exists() {
        return Err(format!(
            "{} does not look like a git checkout (no .git inside)",
            target.display()
        ));
    }

    let is_registered = |root: &Path, canon: &Path| -> bool {
        list_worktrees(root)
            .map(|rows| {
                rows.iter()
                    .any(|r| r.path.canonicalize().map(|c| c == *canon).unwrap_or(false))
            })
            .unwrap_or(false)
    };
    if is_registered(root, &canon_target) {
        return Err("already attached — nothing to do".to_string());
    }

    // Round 1: let git fix its own pointers.
    let target_str = canon_target.to_string_lossy().into_owned();
    let _ = run_git(root, &["worktree", "repair", &target_str]);
    if is_registered(root, &canon_target) {
        return Ok(ReattachOutcome {
            method: "repaired".to_string(),
            branch: guess_branch(root, &canon_target),
        });
    }

    // Round 2: the registration is gone — rebuild it.
    let branch = guess_branch(root, &canon_target).ok_or_else(|| {
        "can't tell which branch this checkout was on — attach it by hand with \
         `git worktree add` or remove the folder"
            .to_string()
    })?;
    let live = list_worktrees(root)?;
    if live
        .iter()
        .filter(|r| r.path.exists())
        .any(|r| r.branch.as_deref() == Some(branch.as_str()))
    {
        return Err(format!(
            "branch '{branch}' is already checked out in another worktree — attach refused"
        ));
    }

    // The repo's shared .git — absolute even when rev-parse answers ".git".
    let common_raw = run_git(root, &["rev-parse", "--git-common-dir"])?;
    let common = {
        let p = PathBuf::from(&common_raw);
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    };
    let worktrees_dir = common.join("worktrees");
    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("create {}: {e}", worktrees_dir.display()))?;

    // Pick a free admin name: the directory name, suffixed on collision
    // with someone else's registration.
    let base_name = canon_target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("worktree path has no directory name")?
        .to_string();
    let mut admin = worktrees_dir.join(&base_name);
    let mut n = 1u32;
    while admin.exists() {
        n += 1;
        admin = worktrees_dir.join(format!("{base_name}-{n}"));
        if n > 100 {
            return Err("could not find a free registration slot".to_string());
        }
    }
    std::fs::create_dir_all(&admin).map_err(|e| format!("create {}: {e}", admin.display()))?;

    let write = |file: &str, contents: String| -> Result<(), String> {
        std::fs::write(admin.join(file), contents)
            .map_err(|e| format!("write {}/{file}: {e}", admin.display()))
    };
    write("gitdir", format!("{}/.git\n", canon_target.display()))?;
    write("HEAD", format!("ref: refs/heads/{branch}\n"))?;
    write("commondir", "../..\n".to_string())?;

    std::fs::write(
        canon_target.join(".git"),
        format!("gitdir: {}\n", admin.display()),
    )
    .map_err(|e| format!("write {}/.git: {e}", canon_target.display()))?;

    // Rebuild the index from HEAD; working files are not touched, so
    // uncommitted edits show up as modifications rather than vanishing.
    run_git(&canon_target, &["reset", "--mixed", "--quiet"])?;

    if !is_registered(root, &canon_target) {
        return Err("rebuilt the registration but git still doesn't list it".to_string());
    }
    Ok(ReattachOutcome {
        method: "reconstructed".to_string(),
        branch: Some(branch),
    })
}

/// Drop the listed-but-gone rows. Returns how many ghost registrations
/// were cleared.
pub fn prune_ghosts_for(repo_root: &str, managed_dir: &Path) -> Result<u32, String> {
    let before = scan_lost_at(repo_root, managed_dir)?.ghosts.len() as u32;
    run_git(Path::new(repo_root), &["worktree", "prune"])?;
    let after = scan_lost_at(repo_root, managed_dir)?.ghosts.len() as u32;
    Ok(before.saturating_sub(after))
}

fn managed_dir_for(repo_root: &str) -> Result<PathBuf, String> {
    managed_project_root(repo_root).ok_or_else(|| "HOME not set".to_string())
}

// ── Tauri command surface ───────────────────────────────────────────

#[tauri::command]
pub async fn worktree_scan_lost(repo_root: String) -> Result<WorktreeScanReport, String> {
    crate::blocking::run(move || {
        let managed = managed_dir_for(&repo_root)?;
        scan_lost_at(&repo_root, &managed)
    })
    .await
}

#[tauri::command]
pub async fn worktree_reattach(
    repo_root: String,
    worktree_path: String,
) -> Result<ReattachOutcome, String> {
    crate::blocking::run(move || {
        let managed = managed_dir_for(&repo_root)?;
        reattach_at(&repo_root, &worktree_path, &managed)
    })
    .await
}

#[tauri::command]
pub async fn worktree_prune_ghosts(repo_root: String) -> Result<u32, String> {
    crate::blocking::run(move || {
        let managed = managed_dir_for(&repo_root)?;
        prune_ghosts_for(&repo_root, &managed)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed in {}: {}",
            cwd.display(),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repo plus a "managed dir" holding one linked worktree on branch
    /// `feat/thing` (directory name `feat-thing`, exercising the sanitiser).
    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "aura-recover-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        let repo = base.join("repo");
        let managed = base.join("managed");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&managed).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.email", "t@t.t"]);
        git(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("f.txt"), "x").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let wt = managed.join("feat-thing");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat/thing",
                wt.to_str().unwrap(),
            ],
        );
        (repo, managed, wt)
    }

    #[test]
    fn healthy_layout_scans_clean() {
        let (repo, managed, _wt) = fixture();
        let report = scan_lost_at(repo.to_str().unwrap(), &managed).unwrap();
        assert!(report.orphans.is_empty(), "no orphans in a healthy layout");
        assert!(report.ghosts.is_empty(), "no ghosts either");
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn wiped_registration_shows_as_attachable_orphan() {
        let (repo, managed, wt) = fixture();
        std::fs::remove_dir_all(repo.join(".git").join("worktrees")).unwrap();
        let report = scan_lost_at(repo.to_str().unwrap(), &managed).unwrap();
        assert_eq!(report.orphans.len(), 1, "the checkout on disk is an orphan");
        let o = &report.orphans[0];
        assert_eq!(o.branch.as_deref(), Some("feat/thing"), "matched via the sanitised name");
        assert!(o.attachable, "branch known and free → attachable");
        assert!(PathBuf::from(&o.path).ends_with("feat-thing"));
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn deleted_directory_shows_as_ghost_and_prunes() {
        let (repo, managed, wt) = fixture();
        std::fs::remove_dir_all(&wt).unwrap();
        let repo_s = repo.to_str().unwrap();
        let report = scan_lost_at(repo_s, &managed).unwrap();
        assert!(report.orphans.is_empty());
        assert_eq!(report.ghosts.len(), 1, "listed but gone from disk");
        let pruned = prune_ghosts_for(repo_s, &managed).unwrap();
        assert_eq!(pruned, 1);
        let after = scan_lost_at(repo_s, &managed).unwrap();
        assert!(after.ghosts.is_empty(), "prune cleared it");
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn moved_worktree_reattaches_via_repair() {
        let (repo, managed, wt) = fixture();
        // Simulate the "parked elsewhere and came back under a new name"
        // class: move the directory, so both pointers now dangle.
        let moved = managed.join("feat-thing-moved");
        std::fs::rename(&wt, &moved).unwrap();
        let repo_s = repo.to_str().unwrap();
        let out = reattach_at(repo_s, moved.to_str().unwrap(), &managed).unwrap();
        assert_eq!(out.method, "repaired", "git repair handles a move");
        let report = scan_lost_at(repo_s, &managed).unwrap();
        assert!(report.orphans.is_empty(), "attached again");
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn wiped_registration_reattaches_by_reconstruction() {
        let (repo, managed, wt) = fixture();
        // An uncommitted edit that must survive the reattach untouched.
        std::fs::write(wt.join("f.txt"), "edited-but-not-committed").unwrap();
        std::fs::remove_dir_all(repo.join(".git").join("worktrees")).unwrap();
        let repo_s = repo.to_str().unwrap();
        let out = reattach_at(repo_s, wt.to_str().unwrap(), &managed).unwrap();
        assert_eq!(out.method, "reconstructed");
        assert_eq!(out.branch.as_deref(), Some("feat/thing"));
        // Registered again…
        let report = scan_lost_at(repo_s, &managed).unwrap();
        assert!(report.orphans.is_empty(), "attached again");
        // …on the right branch, with the working file intact and the
        // rebuilt index seeing the edit as a modification.
        let head = run_git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(head, "feat/thing");
        assert_eq!(
            std::fs::read_to_string(wt.join("f.txt")).unwrap(),
            "edited-but-not-committed",
            "working files are never touched"
        );
        let status = run_git(&wt, &["status", "--porcelain"]).unwrap();
        assert!(
            status.contains("f.txt"),
            "the uncommitted edit surfaces as a modification, got: {status}"
        );
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn refuses_paths_outside_the_managed_root() {
        let (repo, managed, _wt) = fixture();
        let stranger = repo.parent().unwrap().join("stranger");
        std::fs::create_dir_all(&stranger).unwrap();
        std::fs::write(stranger.join(".git"), "gitdir: /nowhere\n").unwrap();
        let err = reattach_at(
            repo.to_str().unwrap(),
            stranger.to_str().unwrap(),
            &managed,
        )
        .unwrap_err();
        assert!(err.contains("managed"), "got: {err}");
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn refuses_when_branch_is_checked_out_elsewhere() {
        let (repo, managed, wt) = fixture();
        // Wipe just this worktree's registration, then check the same branch
        // out somewhere else so a rebuild would create a two-headed branch.
        std::fs::remove_dir_all(repo.join(".git").join("worktrees")).unwrap();
        let rival = repo.parent().unwrap().join("rival");
        git(
            &repo,
            &["worktree", "add", "-q", rival.to_str().unwrap(), "feat/thing"],
        );
        let err = reattach_at(repo.to_str().unwrap(), wt.to_str().unwrap(), &managed)
            .unwrap_err();
        assert!(err.contains("already checked out"), "got: {err}");
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn already_attached_is_a_no_op_error() {
        let (repo, managed, wt) = fixture();
        let err = reattach_at(repo.to_str().unwrap(), wt.to_str().unwrap(), &managed)
            .unwrap_err();
        assert!(err.contains("already attached"), "got: {err}");
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }
}
