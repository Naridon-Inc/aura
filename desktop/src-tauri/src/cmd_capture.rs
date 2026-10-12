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
    /// Why the hook could not be read, when that is the reason `enabled` is
    /// false. "Couldn't look" and "looked, it's off" are different answers
    /// and the pane must not print the second when it means the first: a repo
    /// that is capturing perfectly well reads as off the moment macOS denies
    /// the read, and the only thing on screen is an Enable button that will
    /// fail the same way.
    pub unreadable: Option<String>,
}

/// Resolve the git hooks directory for `root`, honoring linked worktrees.
///
/// Ask git first — `git rev-parse --git-path hooks` is the same resolution the
/// CLI's `HookInstaller::hooks_dir` installs through, so the probe and the
/// installer can never disagree about where the hooks live. It also covers the
/// one case pure path arithmetic can't see: a repo with `core.hooksPath` set
/// runs hooks from that directory and nowhere else.
///
/// The fallback below is the path-only reading, used when git isn't runnable:
/// a normal checkout has a `.git/` directory → `.git/hooks`. A linked worktree
/// has a `.git` *file* containing `gitdir: …/.git/worktrees/<name>`; its hooks
/// live in the shared common dir (`…/.git/hooks`), so we strip the trailing
/// `worktrees/<name>` to get there. Mirrors `hooksDir()` in the VS Code
/// extension's `auraClient.ts`. Returns `None` when `root` has no `.git`.
pub(crate) fn hooks_dir(root: &Path) -> Option<PathBuf> {
    let dotgit = root.join(".git");
    // `.git` missing entirely = not a git repo; answer that before spawning
    // anything, so a plain folder stays a cheap `None`.
    let meta = std::fs::metadata(&dotgit).ok()?;
    if let Some(p) = git_reported_hooks_dir(root) {
        return Some(p);
    }
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

/// Ask git where this repo's hooks live. `None` when git can't be run or
/// doesn't consider `root` a repository, which hands the caller back to the
/// path-only fallback.
fn git_reported_hooks_dir(root: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "hooks"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let reported = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if reported.is_empty() {
        return None;
    }
    Some(anchor(root, &reported))
}

/// git answers `--git-path` relative to the working directory for a normal
/// checkout (`.git/hooks`) and absolutely for a worktree, so relative answers
/// have to be anchored on `root` — the app's own cwd is somewhere else
/// entirely. Pure path arithmetic.
fn anchor(root: &Path, reported: &str) -> PathBuf {
    let p = PathBuf::from(reported);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

/// If `gitdir` ends in `…/worktrees/<name>`, drop those two trailing
/// components to land on the shared common `.git` dir; otherwise return it
/// unchanged. Pure path arithmetic — no filesystem access.
pub(crate) fn strip_worktrees(gitdir: &Path) -> PathBuf {
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
pub(crate) fn marker_present(hooks: &Path) -> bool {
    matches!(read_marker(hooks), Ok(present) if present)
}

/// The same question, keeping the difference between "no hook" and "couldn't
/// read the hook". A missing file is a real answer — capture is off — so it
/// comes back as `Ok(false)`. Anything else is us being unable to look, and
/// the caller has to say so rather than reporting off.
pub(crate) fn read_marker(hooks: &Path) -> Result<bool, std::io::Error> {
    match std::fs::read_to_string(hooks.join("pre-commit")) {
        Ok(body) => {
            Ok(body.contains("AURA SEMANTIC ENGINE") || body.contains("aura capture-context"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Turn a failed read into something a person can act on. macOS is the case
/// that matters: when the app is denied a folder — most often because it is
/// running from a copy the updater left in a temp directory, so its bundle
/// can no longer be verified — every read under it comes back EPERM, and
/// "Operation not permitted" on its own tells nobody what to do.
fn explain_unreadable(hooks: &Path, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return format!(
            "macOS is not letting Aura read {}. Quit Aura and open it again from your \
             Applications folder; if it still can't, allow Aura under System Settings → \
             Privacy & Security → Files and Folders.",
            hooks.display()
        );
    }
    format!("Couldn't read {}: {}", hooks.join("pre-commit").display(), e)
}

/// Read-only probe: is passive semantic capture enabled for `repo_root`?
#[tauri::command]
pub async fn aura_capture_status(repo_root: String) -> CaptureStatus {
    crate::blocking::run(move || {
        let root = PathBuf::from(&repo_root);
        match hooks_dir(&root) {
            Some(h) => {
                let (enabled, unreadable) = match read_marker(&h) {
                    Ok(present) => (present, None),
                    Err(e) => (false, Some(explain_unreadable(&h, &e))),
                };
                CaptureStatus {
                    enabled,
                    is_git: true,
                    hooks_dir: Some(h.to_string_lossy().into_owned()),
                    unreadable,
                }
            }
            None => CaptureStatus {
                enabled: false,
                is_git: false,
                hooks_dir: None,
                unreadable: None,
            },
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_missing_hook_is_off_not_a_mystery() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_marker(tmp.path()).unwrap(), false);
    }

    #[test]
    fn a_hook_carrying_the_marker_reads_as_on() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("pre-commit"), "# AURA SEMANTIC ENGINE\n").unwrap();
        assert!(read_marker(tmp.path()).unwrap());
        assert!(marker_present(tmp.path()));
    }

    #[test]
    fn a_hook_we_are_not_allowed_to_read_is_not_reported_as_off() {
        // The bug this exists for: on a Mac that denies the app a folder —
        // which is what happens when the updater leaves it running from a
        // copy in a temp directory — reading the hook returns EPERM, and the
        // pane said "Not capturing" about a repo that was capturing fine.
        let tmp = tempfile::tempdir().unwrap();
        let hook = tmp.path().join("pre-commit");
        fs::write(&hook, "# AURA SEMANTIC ENGINE\n").unwrap();
        let mut perms = fs::metadata(&hook).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o000);
        fs::set_permissions(&hook, perms).unwrap();

        // Running as root defeats the mode bits entirely, so the only honest
        // thing to do there is skip rather than assert something untrue.
        if fs::read_to_string(&hook).is_ok() {
            return;
        }

        let err = read_marker(tmp.path()).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        // …and `marker_present`, which has to answer yes/no, still says no —
        // the point is that the command now carries the reason alongside it.
        assert!(!marker_present(tmp.path()));

        let said = explain_unreadable(tmp.path(), &err);
        assert!(said.contains("Applications"), "should say how to fix it: {said}");
    }

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
    fn anchor_pins_a_relative_git_answer_to_the_repo() {
        // git says `.git/hooks` for a normal checkout — relative to the repo,
        // NOT to whatever directory the app happens to be running from.
        let root = PathBuf::from("/proj");
        assert_eq!(anchor(&root, ".git/hooks"), PathBuf::from("/proj/.git/hooks"));
    }

    #[test]
    fn anchor_keeps_an_absolute_git_answer() {
        let root = PathBuf::from("/proj/feat");
        assert_eq!(
            anchor(&root, "/proj/main/.git/hooks"),
            PathBuf::from("/proj/main/.git/hooks"),
        );
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
