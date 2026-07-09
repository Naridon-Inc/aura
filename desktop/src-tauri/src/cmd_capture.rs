//! Per-repo capture-hook state for the desktop's no-MCP "Enable Aura" gate.
//!
//! The desktop's top-level `aura_status` reports the *global* blockstore
//! (`~/.aura/store.db`) — it says nothing about whether the workspace you
//! have open is actually capturing semantic checkpoints. Capture is a
//! per-repo property: it's on exactly when Aura's git hooks are installed in
//! that repo. This module answers that question for one workspace root, so
//! the Settings → Capture pane can show "on/off" and offer one-click
//! enable/disable — the desktop twin of the VS Code `isCaptureEnabled` probe
//! and the `aura enable` CLI drop-in, all driving the same hooks with no MCP
//! server in the loop.
//!
//! Enable/disable themselves are NOT reimplemented here — the frontend runs
//! `aura enable` / `aura disable` through the existing `aura_cli` passthrough
//! so the hook-install logic lives in exactly one place (the CLI's
//! `HookInstaller`). This module is read-only: it resolves the hooks dir
//! (worktree-aware) and reads the pre-commit hook for Aura's marker.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Whether the workspace at `repo_root` is capturing, plus enough context
/// for the UI to explain what it found.
#[derive(Serialize)]
pub struct CaptureStatus {
    /// True when the repo's `pre-commit` hook carries Aura's capture marker.
    pub enabled: bool,
    /// True when `repo_root` is a git repo at all. When false the UI stays
    /// quiet rather than offering an `aura enable` that would just error.
    pub is_git: bool,
    /// Resolved hooks directory (absolute), or `None` when not a git repo.
    /// Surfaced so the pane can show *where* the hooks live — which, in a
    /// linked worktree, is the shared common dir, not the per-worktree one.
    pub hooks_dir: Option<String>,
}

/// Resolve the git hooks directory for `root`, honoring linked worktrees.
///
/// A normal checkout has a `.git/` directory → `.git/hooks`. A linked
/// worktree has a `.git` *file* containing `gitdir: …/.git/worktrees/<name>`;
/// its hooks live in the shared common dir (`…/.git/hooks`), so we strip the
/// trailing `worktrees/<name>` to get there. Mirrors `hooksDir()` in the VS
/// Code extension's `auraClient.ts`. Returns `None` when `root` has no `.git`.
fn hooks_dir(root: &Path) -> Option<PathBuf> {
    let dotgit = root.join(".git");
    let meta = std::fs::metadata(&dotgit).ok()?;
    if meta.is_dir() {
        return Some(dotgit.join("hooks"));
    }
    if meta.is_file() {
        let body = std::fs::read_to_string(&dotgit).ok()?;
        let gitdir = body
            .lines()
            .find_map(|l| l.trim().strip_prefix("gitdir:"))
            .map(|p| PathBuf::from(p.trim()))?;
        return Some(strip_worktrees(&gitdir).join("hooks"));
    }
    None
}

/// If `gitdir` ends in `…/worktrees/<name>`, drop those two trailing
/// components to land on the shared common `.git` dir; otherwise return it
/// unchanged. Pure path arithmetic — no filesystem access.
fn strip_worktrees(gitdir: &Path) -> PathBuf {
    let comps: Vec<_> = gitdir.components().collect();
    let n = comps.len();
    if n >= 2 && comps[n - 2].as_os_str() == "worktrees" {
        return comps[..n - 2].iter().collect();
    }
    gitdir.to_path_buf()
}

/// True when the `pre-commit` hook in `hooks` carries Aura's marker. We accept
/// either the human marker block header or the actual capture invocation, so a
/// hook that's been hand-edited (marker comment stripped) but still calls the
/// CLI still reads as enabled. Same two needles the VS Code probe uses.
fn marker_present(hooks: &Path) -> bool {
    match std::fs::read_to_string(hooks.join("pre-commit")) {
        Ok(body) => {
            body.contains("AURA SEMANTIC ENGINE") || body.contains("aura capture-context")
        }
        Err(_) => false,
    }
}

/// Read-only probe: is passive semantic capture enabled for `repo_root`?
#[tauri::command]
pub async fn aura_capture_status(repo_root: String) -> CaptureStatus {
    let root = PathBuf::from(&repo_root);
    match hooks_dir(&root) {
        Some(h) => CaptureStatus {
            enabled: marker_present(&h),
            is_git: true,
            hooks_dir: Some(h.to_string_lossy().into_owned()),
        },
        None => CaptureStatus {
            enabled: false,
            is_git: false,
            hooks_dir: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn strip_worktrees_drops_trailing_pair() {
        let p = PathBuf::from("/proj/.git/worktrees/feature-x");
        assert_eq!(strip_worktrees(&p), PathBuf::from("/proj/.git"));
    }

    #[test]
    fn strip_worktrees_passes_plain_gitdir_through() {
        let p = PathBuf::from("/proj/.git");
        assert_eq!(strip_worktrees(&p), PathBuf::from("/proj/.git"));
    }

    #[test]
    fn hooks_dir_for_normal_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join(".git")).unwrap();
        assert_eq!(hooks_dir(root), Some(root.join(".git").join("hooks")));
    }

    #[test]
    fn hooks_dir_follows_worktree_pointer_to_common_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let common = tmp.path().join("main").join(".git");
        let wt_meta = common.join("worktrees").join("feat");
        fs::create_dir_all(&wt_meta).unwrap();
        let wt_root = tmp.path().join("feat");
        fs::create_dir_all(&wt_root).unwrap();
        fs::write(
            wt_root.join(".git"),
            format!("gitdir: {}\n", wt_meta.display()),
        )
        .unwrap();
        // Resolves back to the SHARED common hooks dir, not the per-worktree one.
        assert_eq!(hooks_dir(&wt_root), Some(common.join("hooks")));
    }

    #[test]
    fn hooks_dir_none_for_non_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(hooks_dir(tmp.path()), None);
    }

    #[test]
    fn marker_present_detects_both_needles() {
        let tmp = tempfile::tempdir().unwrap();
        let hooks = tmp.path();
        // header-comment marker
        fs::write(
            hooks.join("pre-commit"),
            "#!/bin/sh\n# --- AURA SEMANTIC ENGINE ---\n",
        )
        .unwrap();
        assert!(marker_present(hooks));
        // bare invocation, comment stripped
        fs::write(hooks.join("pre-commit"), "#!/bin/sh\naura capture-context\n").unwrap();
        assert!(marker_present(hooks));
    }

    #[test]
    fn marker_absent_for_foreign_or_missing_hook() {
        let tmp = tempfile::tempdir().unwrap();
        let hooks = tmp.path();
        assert!(!marker_present(hooks)); // no pre-commit at all
        fs::write(hooks.join("pre-commit"), "#!/bin/sh\nnpx lint-staged\n").unwrap();
        assert!(!marker_present(hooks)); // husky/lefthook, not ours
    }
}
