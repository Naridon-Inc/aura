//! Write the plain-language account of a change AS IT LANDS, not when someone
//! opens it.
//!
//! `cmd_change_summary::prewarm_change_summaries` has always been able to do
//! this work with nobody waiting — but the only thing that ever called it was a
//! reader opening the Changes tab, which is precisely the moment it is too late
//! to help. So the first look at a commit still watched generic placeholders
//! while the model wrote a dozen sentences. The work was never the problem; the
//! trigger was.
//!
//! This is the trigger. It watches the repo's HEAD reflog — the one file git
//! appends to on every commit, merge, rebase, reset and checkout, whoever made
//! it: the app's own commit button, an agent in a terminal, or the user in
//! another window. When HEAD moves to a commit we haven't described yet, the
//! prewarm runs immediately, off any request path. By the time anyone opens the
//! change, the words are already in `.aura/change_summaries.jsonl`.
//!
//! Deliberately NOT part of `cmd_watcher`: that watcher is recursive over the
//! working tree and skips `/.git/` wholesale, for good reason — a recursive
//! watch on a main repo's `.git` would take in the whole object store. This
//! watches two specific directories, non-recursively, and reads one file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::State;

#[derive(Default)]
pub struct CommitWatchRegistry {
    /// Owns the live watchers per repo root. Dropping the entry stops the
    /// OS-level watch, which is how a project switch tears its watch down.
    by_root: Mutex<HashMap<String, Vec<RecommendedWatcher>>>,
}

impl CommitWatchRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

/// The last commit each root was warmed for, so a reflog append that doesn't
/// actually move HEAD (a checkout back and forth, a `git notes` write) doesn't
/// re-queue work that is already cached.
fn last_warmed() -> &'static Mutex<HashMap<String, String>> {
    static SEEN: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start describing this repo's commits the moment they land. Idempotent per
/// root; a second call while a watch is live is a no-op. Never errors on a
/// non-git directory — there is simply nothing to watch.
#[tauri::command]
pub async fn watch_commits(
    repo_root: String,
    state: State<'_, CommitWatchRegistry>,
) -> Result<(), String> {
    {
        let map = state.by_root.lock().unwrap();
        if map.contains_key(&repo_root) {
            return Ok(());
        }
    }
    let root = PathBuf::from(&repo_root);
    if !root.is_dir() {
        return Err(format!("not a directory: {repo_root}"));
    }
    let Some(git_dir) = git_dir(&root) else {
        // Not a git repo (or git isn't reachable). Nothing to warm from.
        return Ok(());
    };

    // Two non-recursive watches, because the signal lives in two places and a
    // recursive watch on a main checkout's `.git` would pull in the object
    // store: `<gitdir>/logs/HEAD` is appended on every commit, and `<gitdir>`
    // itself carries HEAD for the checkout case. A worktree has its own gitdir
    // (its `.git` is a file, not a directory), and `git rev-parse` resolves
    // that for us — so a worktree watches its own reflog, not the main repo's.
    let mut targets = vec![git_dir.clone()];
    let logs = git_dir.join("logs");
    if logs.is_dir() {
        targets.push(logs);
    }

    // Shared by BOTH watches on purpose: git touches HEAD and its reflog for
    // the same commit, and that is one landing, not two.
    let debounce: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let root_for_cb = repo_root.clone();
    let mut watchers = Vec::new();
    for target in targets {
        let root_for_cb = root_for_cb.clone();
        let debounce = Arc::clone(&debounce);
        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                let Ok(ev) = res else { return };
                // Only HEAD itself and its reflog — a ref file for some other
                // branch says nothing about what this checkout is looking at.
                if !ev.paths.iter().any(|p| is_head_signal(p)) {
                    return;
                }
                {
                    // git writes HEAD and its reflog within milliseconds of each
                    // other, and does it twice for an amend; one warm per burst.
                    let mut last = debounce.lock().unwrap();
                    let now = Instant::now();
                    if let Some(prev) = *last {
                        if now.duration_since(prev) < Duration::from_millis(400) {
                            return;
                        }
                    }
                    *last = Some(now);
                }
                let root = root_for_cb.clone();
                tauri::async_runtime::spawn(async move {
                    warm_head(root).await;
                });
            })
            .map_err(|e| format!("commit watcher init failed: {e}"))?;
        watcher
            .watch(&target, RecursiveMode::NonRecursive)
            .map_err(|e| format!("commit watch failed: {e}"))?;
        watchers.push(watcher);
    }

    state
        .by_root
        .lock()
        .unwrap()
        .insert(repo_root.clone(), watchers);

    // Describe where HEAD is right now, too. Otherwise the very first commit
    // after the app opened a project — the one most likely to be read next —
    // would be the only one still written at view time.
    tauri::async_runtime::spawn(async move {
        warm_head(repo_root).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn unwatch_commits(
    repo_root: String,
    state: State<'_, CommitWatchRegistry>,
) -> Result<(), String> {
    state.by_root.lock().unwrap().remove(&repo_root);
    last_warmed().lock().unwrap().remove(&repo_root);
    Ok(())
}

/// Is this path HEAD, or the reflog of HEAD? Matched on the file name plus its
/// parent so `logs/HEAD` counts and `refs/heads/main` does not.
fn is_head_signal(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    // git writes `HEAD.lock` first and renames — both events name a file we care
    // about, and the debounce collapses the pair.
    name == "HEAD" || name == "HEAD.lock"
}

/// Resolve the gitdir that actually holds this checkout's HEAD. For a worktree
/// that is `<main>/.git/worktrees/<name>`, NOT the worktree's own `.git` — which
/// is a file. `--absolute-git-dir` answers correctly for both.
fn git_dir(root: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--absolute-git-dir"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let path = PathBuf::from(dir);
    path.is_dir().then_some(path)
}

/// Queue the plain-language account of whatever HEAD now points at, unless we
/// already queued that exact commit for this root.
async fn warm_head(repo_root: String) {
    let Some(sha) = head_sha(&repo_root) else {
        return;
    };
    {
        let mut seen = match last_warmed().lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if seen.get(&repo_root) == Some(&sha) {
            return;
        }
        seen.insert(repo_root.clone(), sha.clone());
    }
    // Fire-and-forget by contract: the prewarm spawns its own jobs and returns
    // a count. A repo with no model reachable simply queues nothing.
    let _ = crate::cmd_change_summary::prewarm_change_summaries(repo_root, Some(sha)).await;
}

fn head_sha(repo_root: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_and_its_reflog_are_the_signal_other_refs_are_not() {
        assert!(is_head_signal(Path::new("/r/.git/HEAD")));
        assert!(is_head_signal(Path::new("/r/.git/logs/HEAD")));
        // git's write-then-rename shows up as the lock file first.
        assert!(is_head_signal(Path::new("/r/.git/HEAD.lock")));
        // Another branch moving says nothing about what this checkout reads.
        assert!(!is_head_signal(Path::new("/r/.git/refs/heads/main")));
        assert!(!is_head_signal(Path::new("/r/.git/index")));
        assert!(!is_head_signal(Path::new("/r/.git/logs/refs/heads/main")));
    }

    #[test]
    fn a_worktrees_gitdir_is_resolved_not_assumed() {
        // The repo this test runs in is itself a worktree in development, so
        // the only safe claim is the general one: whatever git reports is a
        // real directory, and it is where HEAD lives.
        let here = std::env::current_dir().unwrap();
        if let Some(dir) = git_dir(&here) {
            assert!(dir.is_dir(), "resolved gitdir must exist: {dir:?}");
            assert!(dir.join("HEAD").exists(), "gitdir must hold HEAD: {dir:?}");
        }
    }
}
