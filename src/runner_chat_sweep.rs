//! Removing the copies of archived workspaces from this machine.
//!
//! Each workspace a box answers gets its own folder under
//! `<root>/.chats/<workspace>` (a git worktree of the project's checkout) plus
//! two turn logs beside it. Archiving a workspace on the cloud used to leave
//! all of that behind, so a busy box's disk only ever filled. Every
//! [`SWEEP`] the chat thread names the folders it holds, the cloud answers
//! which of those workspaces were archived, and only those are removed.
//!
//! Removal is deliberately narrow:
//! - only a direct child of `<root>/.chats` whose name is one this runner
//!   would have made, and never through a symlink;
//! - only a git worktree (its `.git` is a file), never a full checkout;
//! - never a folder with work git would lose: changes not committed, or
//!   commits no remote has — that folder is kept, and said once;
//! - never a workspace a turn is running in.
//!
//! A restored workspace loses nothing by this: its branch is on the remote,
//! and its next turn makes the folder again from there.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use colored::Colorize;

use crate::runner_chat::Cloud;
use crate::runner_chat_turn::slug;

/// How often the machine asks which of its workspace copies were archived.
pub(crate) const SWEEP: Duration = Duration::from_secs(10 * 60);
/// How many folder names go in one question to the cloud.
const ASK_CAP: usize = 500;

/// The sweep's memory between ticks, so a kept folder or a failing cloud is
/// said once, not every ten minutes.
pub(crate) struct Sweeper {
    next: Instant,
    last_error: Option<String>,
    told: HashSet<String>,
}

/// What one pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Swept {
    pub removed: Vec<String>,
    /// Name and why it stayed.
    pub kept: Vec<(String, String)>,
}

impl Sweeper {
    /// The first sweep runs on the first tick, so a box that was off while
    /// workspaces were archived frees its disk as soon as it is back.
    pub(crate) fn new() -> Sweeper {
        Sweeper { next: Instant::now(), last_error: None, told: HashSet::new() }
    }

    pub(crate) fn tick(&mut self, cloud: &Cloud, root: &Path, busy: &HashSet<String>) {
        if Instant::now() < self.next {
            return;
        }
        self.next = Instant::now() + SWEEP;
        let chats = root.join(".chats");
        let held = held(&chats);
        if held.is_empty() {
            return;
        }
        let mut archived = Vec::new();
        for ask in held.chunks(ASK_CAP) {
            match cloud.archived(ask) {
                Ok(names) => archived.extend(names),
                Err(e) => {
                    if self.last_error.as_deref() != Some(e.as_str()) {
                        eprintln!("{} {e}", "[chat]".yellow());
                        self.last_error = Some(e);
                    }
                    return;
                }
            }
        }
        self.last_error = None;
        let swept = remove_archived(&chats, &archived, busy);
        for name in &swept.removed {
            eprintln!("{} removed archived workspace {name} from this computer", "[chat]".cyan());
        }
        for (name, why) in swept.kept {
            if self.told.insert(name.clone()) {
                eprintln!("{} kept archived workspace {name}: {why}", "[chat]".yellow());
            }
        }
    }
}

/// The workspace folders under `chats`: real directories (not symlinks)
/// whose name is one [`slug`] would have made.
pub(crate) fn held(chats: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(chats) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| *n == slug(n))
        .collect();
    names.sort();
    names
}

/// Remove each archived folder under `chats` that is safe to remove.
pub(crate) fn remove_archived(chats: &Path, archived: &[String], busy: &HashSet<String>) -> Swept {
    let mut swept = Swept::default();
    for name in archived {
        if busy.contains(name) {
            continue;
        }
        match remove(chats, name) {
            Ok(()) => swept.removed.push(name.clone()),
            Err(why) => swept.kept.push((name.clone(), why)),
        }
    }
    swept
}

/// Remove one workspace's folder and its turn logs, or say why not.
fn remove(chats: &Path, name: &str) -> Result<(), String> {
    if name != slug(name) {
        return Err("its name isn't one this computer makes".into());
    }
    let tree = chats.join(name);
    let meta = std::fs::symlink_metadata(&tree).map_err(|e| format!("can't look at it: {e}"))?;
    if !meta.file_type().is_dir() {
        return Err("it isn't a folder".into());
    }
    let inside = std::fs::canonicalize(chats).map_err(|e| e.to_string())?;
    let real = std::fs::canonicalize(&tree).map_err(|e| e.to_string())?;
    if real.parent() != Some(inside.as_path()) {
        return Err("it isn't inside this computer's workspace folder".into());
    }
    let dot_git = std::fs::symlink_metadata(real.join(".git")).map_err(|_| "it isn't a git worktree".to_string())?;
    if !dot_git.file_type().is_file() {
        return Err("it is a full checkout, not a workspace's worktree".into());
    }
    let checkout = checkout_of(&real)?;
    let dirty = git(&real, &["status", "--porcelain", "--untracked-files=normal"])?;
    if !dirty.is_empty() {
        return Err("it has changes that were never committed".into());
    }
    let unpushed = git(&real, &["rev-list", "--count", "HEAD", "--not", "--remotes"])?;
    if unpushed.trim() != "0" {
        return Err(format!("{} commit(s) on it aren't on the remote", unpushed.trim()));
    }
    // `--force` only past the checks above: it lets go of ignored build
    // output and submodules, never of work.
    let path = real.to_string_lossy().to_string();
    if git(&checkout, &["worktree", "remove", "--force", &path]).is_err() {
        // Not a worktree git still knows: remove the folder itself — it was
        // checked above to be a real directory inside `chats` — and let git
        // forget it. `remove_dir_all` never follows a symlink inside it.
        std::fs::remove_dir_all(&real).map_err(|e| format!("couldn't remove it: {e}"))?;
        let _ = git(&checkout, &["worktree", "prune"]);
    }
    for log in [format!("{name}.out.json"), format!("{name}.err.log")] {
        let p = inside.join(log);
        if std::fs::symlink_metadata(&p).map(|m| m.file_type().is_file()).unwrap_or(false) {
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(())
}

/// The project checkout a worktree belongs to. Its repository must be the
/// `.git` folder of a checkout beside the workspaces, so a planted `.git`
/// file can't point the removal at somebody else's repository.
fn checkout_of(tree: &Path) -> Result<PathBuf, String> {
    let said = git(tree, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let common = std::fs::canonicalize(said.trim()).map_err(|e| format!("its repository is missing: {e}"))?;
    let root = tree.parent().and_then(Path::parent).ok_or("it has no workspace root")?;
    let checkout = common.parent().ok_or("its repository has no checkout")?;
    if common.file_name().map(|n| n != ".git").unwrap_or(true) || checkout.parent() != Some(root) {
        return Err("its repository isn't a project checkout on this computer".into());
    }
    Ok(checkout.to_path_buf())
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A remote, a project checkout at `<root>/acme__app` and one pushed
    /// workspace worktree at `<root>/.chats/<id>` with its two logs.
    struct Box_ {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        checkout: PathBuf,
    }

    fn a_box(id: &str) -> Box_ {
        let tmp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(tmp.path()).unwrap();
        let remote = base.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        run(&remote, &["init", "--bare"]);
        let root = base.join("workspaces");
        std::fs::create_dir_all(&root).unwrap();
        let checkout = root.join("acme__app");
        run(&root, &["clone", remote.to_str().unwrap(), "acme__app"]);
        run(&checkout, &["config", "core.hooksPath", checkout.join(".no-hooks").to_str().unwrap()]);
        std::fs::write(checkout.join("README.md"), "hi\n").unwrap();
        run(&checkout, &["add", "README.md"]);
        run(&checkout, &["commit", "-m", "first"]);
        run(&checkout, &["push", "origin", "HEAD:main"]);
        add_workspace(&root, &checkout, id);
        Box_ { _tmp: tmp, root, checkout }
    }

    fn add_workspace(root: &Path, checkout: &Path, id: &str) {
        let chats = root.join(".chats");
        std::fs::create_dir_all(&chats).unwrap();
        let tree = chats.join(id);
        let branch = format!("aura/{id}");
        run(checkout, &["worktree", "add", "-B", &branch, tree.to_str().unwrap(), "origin/main"]);
        std::fs::write(tree.join("work.txt"), "done\n").unwrap();
        run(&tree, &["add", "work.txt"]);
        run(&tree, &["commit", "-m", "work"]);
        run(&tree, &["push", "origin", &format!("HEAD:{branch}")]);
        std::fs::write(chats.join(format!("{id}.out.json")), "{}").unwrap();
        std::fs::write(chats.join(format!("{id}.err.log")), "").unwrap();
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_archived_workspace_s_copy_and_logs_go_and_the_project_stays() {
        let b = a_box("ws-1");
        let chats = b.root.join(".chats");
        assert_eq!(held(&chats), names(&["ws-1"]));
        let swept = remove_archived(&chats, &names(&["ws-1"]), &HashSet::new());
        assert_eq!(swept.removed, names(&["ws-1"]), "{:?}", swept.kept);
        assert!(!chats.join("ws-1").exists());
        assert!(!chats.join("ws-1.out.json").exists() && !chats.join("ws-1.err.log").exists());
        assert!(b.checkout.join(".git").is_dir() && b.checkout.join("README.md").exists());
        assert!(!run(&b.checkout, &["worktree", "list"]).contains("ws-1"));
    }

    #[test]
    fn a_restored_workspace_comes_back_from_its_branch_on_the_remote() {
        let b = a_box("ws-1");
        let chats = b.root.join(".chats");
        remove_archived(&chats, &names(&["ws-1"]), &HashSet::new());
        run(&b.checkout, &["fetch", "origin"]);
        let tree = chats.join("ws-1");
        run(&b.checkout, &["worktree", "add", "-B", "aura/ws-1", tree.to_str().unwrap(), "origin/aura/ws-1"]);
        assert_eq!(std::fs::read_to_string(tree.join("work.txt")).unwrap(), "done\n");
    }

    #[test]
    fn a_copy_a_turn_is_running_in_is_left_alone() {
        let b = a_box("ws-1");
        let chats = b.root.join(".chats");
        let busy: HashSet<String> = names(&["ws-1"]).into_iter().collect();
        let swept = remove_archived(&chats, &names(&["ws-1"]), &busy);
        assert_eq!(swept, Swept::default());
        assert!(chats.join("ws-1/work.txt").exists());
    }

    #[test]
    fn work_git_would_lose_keeps_the_copy() {
        let b = a_box("ws-1");
        let chats = b.root.join(".chats");
        add_workspace(&b.root, &b.checkout, "ws-2");
        std::fs::write(chats.join("ws-1/draft.txt"), "unsaved\n").unwrap();
        std::fs::write(chats.join("ws-2/more.txt"), "x\n").unwrap();
        run(&chats.join("ws-2"), &["add", "more.txt"]);
        run(&chats.join("ws-2"), &["commit", "-m", "not pushed"]);
        let swept = remove_archived(&chats, &names(&["ws-1", "ws-2"]), &HashSet::new());
        assert!(swept.removed.is_empty());
        assert!(swept.kept[0].1.contains("never committed"), "{:?}", swept.kept);
        assert!(swept.kept[1].1.contains("aren't on the remote"), "{:?}", swept.kept);
        assert!(chats.join("ws-1/draft.txt").exists() && chats.join("ws-2/more.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_workspace_folder_is_never_followed() {
        let b = a_box("ws-1");
        let chats = b.root.join(".chats");
        let elsewhere = b.root.parent().unwrap().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("keep.txt"), "mine\n").unwrap();
        std::os::unix::fs::symlink(&elsewhere, chats.join("ws-9")).unwrap();
        assert_eq!(held(&chats), names(&["ws-1"]), "a symlink is not a held copy");
        let swept = remove_archived(&chats, &names(&["ws-9"]), &HashSet::new());
        assert!(swept.removed.is_empty());
        assert!(elsewhere.join("keep.txt").exists());
        assert!(std::fs::symlink_metadata(chats.join("ws-9")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_full_checkout_or_a_strange_name_is_never_removed() {
        let b = a_box("ws-1");
        let chats = b.root.join(".chats");
        let full = chats.join("ws-full");
        std::fs::create_dir_all(&full).unwrap();
        run(&full, &["init"]);
        let swept = remove_archived(&chats, &names(&["ws-full", "../acme__app", "."]), &HashSet::new());
        assert!(swept.removed.is_empty());
        assert!(swept.kept[0].1.contains("full checkout"), "{:?}", swept.kept);
        assert!(full.join(".git").is_dir() && b.checkout.join(".git").is_dir());
    }

    #[test]
    fn a_worktree_of_a_repository_off_this_computer_s_root_is_refused() {
        let b = a_box("ws-1");
        let chats = b.root.join(".chats");
        let other = b.root.parent().unwrap().join("other");
        std::fs::create_dir_all(&other).unwrap();
        run(&other, &["init"]);
        run(&other, &["commit", "--allow-empty", "-m", "x"]);
        let tree = chats.join("ws-3");
        run(&other, &["worktree", "add", tree.to_str().unwrap()]);
        let swept = remove_archived(&chats, &names(&["ws-3"]), &HashSet::new());
        assert!(swept.removed.is_empty(), "{:?}", swept);
        assert!(tree.exists());
    }
}
