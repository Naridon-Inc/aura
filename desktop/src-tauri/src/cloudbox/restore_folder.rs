//! Put a workspace's folder back on a machine that no longer has it.
//!
//! A workspace's folder is a worktree made beside the project on its machine
//! (see [`super::script::worktree_path`]). A machine that was replaced — a
//! new instance behind the same address — or wiped has the project at most,
//! and every read of the folder and every attach to its chat fails on a
//! directory that isn't there. This makes the folder again, the same way it
//! was made: the branch as GitHub has it when it was pushed, else a new branch
//! off the project, exactly as [`super::script::add_worktree`] starts one.
//!
//! A folder that is already there is left alone, and a project that isn't
//! there is a refusal of its own: nothing is cloned or guessed.

use super::continue_branch::{continue_worktree, EXIT_NOT_ON_GITHUB, EXIT_UNREACHABLE};
use super::script::{add_worktree, quote, slug, worktree_path};

/// The machine has no copy of the project the folder was made from.
pub const EXIT_NO_PROJECT: i32 = 47;

/// The project a workspace's folder was made from, read off the folder's own
/// name: `<project>-<branch>`. `None` when the folder isn't named that way, so
/// a folder made some other way is never mistaken for a worktree of anything.
pub fn project_of(root: &str, branch: &str) -> Option<String> {
    let root = root.trim().trim_end_matches('/');
    let tail = slug(branch);
    if tail.is_empty() {
        return None;
    }
    let project = root.strip_suffix(&format!("-{tail}"))?;
    let named = !project.is_empty() && !project.ends_with('/') && project != "~";
    (named && worktree_path(project, branch) == root).then(|| project.to_string())
}

/// The script that leaves `path` a worktree of `project` on `branch`, unless
/// `path` is already there. Exits [`EXIT_NO_PROJECT`] when `project` is not a
/// checkout, and with [`continue_worktree`]'s own codes when GitHub's copy of
/// the branch can't be taken as it is.
pub fn restore(project: &str, path: &str, branch: &str) -> String {
    let p = quote(project);
    let w = quote(path);
    format!(
        "if [ -d {w} ]; then exit 0; fi
git -C {p} rev-parse --git-dir >/dev/null 2>&1 || exit {none}
git -C {p} worktree prune >/dev/null 2>&1 || true
( {pick_up} ); c=$?
if [ $c -eq {fresh} ] || [ $c -eq {away} ]; then {start}; c=$?; fi
exit $c",
        none = EXIT_NO_PROJECT,
        pick_up = continue_worktree(project, path, branch),
        fresh = EXIT_NOT_ON_GITHUB,
        away = EXIT_UNREACHABLE,
        start = add_worktree(project, path, branch),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(dir: &Path, file: &str) -> String {
        std::fs::write(dir.join(file), file).unwrap();
        git(dir, &["add", file]);
        git(dir, &["commit", "-q", "-m", file]);
        git(dir, &["rev-parse", "HEAD"])
    }

    fn run(project: &Path, root: &Path, branch: &str) -> i32 {
        let script = restore(project.to_str().unwrap(), root.to_str().unwrap(), branch);
        Command::new("sh")
            .args(["-c", &script])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("sh runs")
            .status
            .code()
            .unwrap_or(-1)
    }

    /// GitHub, and a fresh machine's clone of the project from it.
    fn world() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let hub = tmp.path().join("hub.git");
        let seed = tmp.path().join("seed");
        let machine = tmp.path().join("Lumi");
        git(tmp.path(), &["init", "-q", "--bare", "-b", "main", hub.to_str().unwrap()]);
        git(tmp.path(), &["clone", "-q", hub.to_str().unwrap(), seed.to_str().unwrap()]);
        git(&seed, &["switch", "-q", "-c", "main"]);
        commit(&seed, "a");
        git(&seed, &["push", "-q", "origin", "main"]);
        git(tmp.path(), &["clone", "-q", hub.to_str().unwrap(), machine.to_str().unwrap()]);
        (tmp, seed, machine)
    }

    #[test]
    fn a_folder_is_read_back_to_the_project_it_was_made_beside() {
        assert_eq!(project_of("/home/ubuntu/Lumi-hi-df3774", "hi-df3774").as_deref(), Some("/home/ubuntu/Lumi"));
        assert_eq!(project_of("~/aura-fix-login/", "fix/login").as_deref(), Some("~/aura"));
        assert_eq!(project_of("/srv/w/Lumi-Feat-X", "feat/x"), None, "the branch part is always a lowercase slug");
        assert_eq!(project_of("/srv/elsewhere", "hi-df3774"), None);
        assert_eq!(project_of("/-x", "x"), None);
        assert_eq!(project_of("~-x", "x"), None);
        assert_eq!(project_of("/srv/p-x", "///"), None);
    }

    #[test]
    fn a_new_machine_gets_the_folder_back_on_a_branch_of_its_own() {
        let (_tmp, _seed, machine) = world();
        let root = machine.with_file_name("Lumi-hi-df3774");
        assert_eq!(run(&machine, &root, "hi-df3774"), 0);
        assert_eq!(git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]), "hi-df3774");
        assert_eq!(run(&machine, &root, "hi-df3774"), 0, "a folder already there is left as it is");
    }

    #[test]
    fn a_branch_that_was_pushed_comes_back_as_github_has_it() {
        let (_tmp, seed, machine) = world();
        git(&seed, &["switch", "-q", "-c", "fix/login"]);
        let tip = commit(&seed, "b");
        git(&seed, &["push", "-q", "-u", "origin", "fix/login"]);
        let root = machine.with_file_name("Lumi-fix-login");
        assert_eq!(run(&machine, &root, "fix/login"), 0);
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), tip, "the pushed work, not a new branch off main");
    }

    #[test]
    fn a_folder_deleted_under_git_is_made_again() {
        let (_tmp, _seed, machine) = world();
        let root = machine.with_file_name("Lumi-hi");
        assert_eq!(run(&machine, &root, "hi"), 0);
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(run(&machine, &root, "hi"), 0, "git's record of the old folder doesn't block the new one");
        assert_eq!(git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]), "hi");
    }

    #[test]
    fn a_machine_without_the_project_is_told_so_and_nothing_is_made() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("Lumi");
        let root = tmp.path().join("Lumi-hi");
        assert_eq!(run(&project, &root, "hi"), EXIT_NO_PROJECT);
        assert!(!root.exists());
    }

    #[test]
    fn every_value_is_only_data_to_the_script() {
        let s = restore("/p", "/p-x", "x'; touch /tmp/owned; '");
        assert!(s.starts_with("if [ -d '/p-x' ]; then exit 0; fi\n"), "{s}");
        assert!(!s.contains("x'; touch"), "the branch is never spliced unquoted");
    }
}
