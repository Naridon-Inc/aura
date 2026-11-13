//! Pick a branch that is already on GitHub up on a machine, as GitHub has it.
//!
//! A workspace normally starts a branch of its own: [`super::script::add_worktree`]
//! tries `worktree add -b` first, off whatever the machine's copy of the project
//! last fetched. That is right for new work and wrong for work that is already
//! going somewhere — a branch with an open pull request. Made that way the
//! machine's branch shares a name with the pull request's and nothing else, and
//! the first push from it is refused or, worse, lands as a second history.
//!
//! So continuing is its own script. It asks GitHub for the branch, fetches
//! exactly that ref, and makes the machine's branch *be* GitHub's: checked out
//! at the same commit, tracking it, so a plain `git push` from the workspace
//! adds commits to the same pull request. Anything the machine already holds on
//! that branch is left alone unless GitHub's copy simply contains it — a branch
//! the machine has its own commits on is a refusal, never a reset.

use super::script::quote;

/// GitHub has no branch by that name: nothing was pushed yet.
pub const EXIT_NOT_ON_GITHUB: i32 = 43;
/// GitHub couldn't be asked: the network, or the machine's credential.
pub const EXIT_UNREACHABLE: i32 = 44;
/// The machine's branch has commits GitHub's doesn't.
pub const EXIT_DIVERGED: i32 = 45;
/// The workspace's folder is already there, on another branch.
pub const EXIT_OTHER_BRANCH: i32 = 46;

/// The script that leaves `path` a worktree of `project` on `branch`, at the
/// commit GitHub has it at and tracking it there.
///
/// Every value is assigned once, quoted, and used only as `"$var"` after that,
/// so nothing a branch name holds is ever read as shell.
pub fn continue_worktree(project: &str, path: &str, branch: &str) -> String {
    format!(
        "p={p}; w={w}; b={b}
git -C \"$p\" ls-remote --exit-code origin \"refs/heads/$b\" >/dev/null; r=$?
if [ $r -eq 2 ]; then exit {none}; fi
if [ $r -ne 0 ]; then exit {away}; fi
git -C \"$p\" fetch --quiet origin \"+refs/heads/$b:refs/remotes/origin/$b\" || exit {away}
if [ -d \"$w\" ]; then
  [ \"$(git -C \"$w\" rev-parse --abbrev-ref HEAD 2>/dev/null)\" = \"$b\" ] || exit {other}
  git -C \"$w\" merge --ff-only --quiet \"origin/$b\" || exit {diverged}
elif git -C \"$p\" show-ref --verify --quiet \"refs/heads/$b\"; then
  git -C \"$p\" merge-base --is-ancestor \"refs/heads/$b\" \"origin/$b\" || exit {diverged}
  git -C \"$p\" branch --quiet -f \"$b\" \"origin/$b\" || exit 1
  git -C \"$p\" worktree add --quiet \"$w\" \"$b\" || exit 1
else
  git -C \"$p\" worktree add --quiet --track -b \"$b\" \"$w\" \"origin/$b\" || exit 1
fi
git -C \"$w\" branch --quiet --set-upstream-to=\"origin/$b\" \"$b\"",
        p = quote(project),
        w = quote(path),
        b = quote(branch),
        none = EXIT_NOT_ON_GITHUB,
        away = EXIT_UNREACHABLE,
        diverged = EXIT_DIVERGED,
        other = EXIT_OTHER_BRANCH,
    )
}

/// What a refused continue means, for the exit codes the script gives itself.
/// `None` for anything else, whose own last line is the better answer.
pub fn refusal(machine: &str, branch: &str, code: i32) -> Option<String> {
    Some(match code {
        EXIT_NOT_ON_GITHUB => {
            format!("GitHub has no branch {branch}, so {machine} has nothing to continue. Push it from this laptop first.")
        }
        EXIT_UNREACHABLE => format!("{machine} couldn't fetch {branch} from GitHub."),
        EXIT_DIVERGED => format!(
            "{machine} already has its own commits on {branch} that GitHub doesn't, so it won't move the branch under them."
        ),
        EXIT_OTHER_BRANCH => format!("{machine} already has this workspace's folder, on a branch other than {branch}."),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    //! The script runs here against real repositories: a bare one standing in
    //! for GitHub, a clone standing in for the machine's copy of the project.
    use super::*;
    use std::path::{Path, PathBuf};
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

    /// GitHub with `main` and the pull request's branch on it, the laptop that
    /// pushed both, and the machine's clone made before the branch existed.
    struct World {
        _tmp: tempfile::TempDir,
        laptop: PathBuf,
        machine: PathBuf,
        tip: String,
    }

    fn world() -> World {
        let tmp = tempfile::tempdir().unwrap();
        let hub = tmp.path().join("hub.git");
        let laptop = tmp.path().join("laptop");
        let machine = tmp.path().join("machine");
        git(tmp.path(), &["init", "-q", "--bare", "-b", "main", hub.to_str().unwrap()]);
        git(tmp.path(), &["clone", "-q", hub.to_str().unwrap(), laptop.to_str().unwrap()]);
        git(&laptop, &["switch", "-q", "-c", "main"]);
        commit(&laptop, "a");
        git(&laptop, &["push", "-q", "origin", "main"]);
        git(tmp.path(), &["clone", "-q", hub.to_str().unwrap(), machine.to_str().unwrap()]);
        git(&laptop, &["switch", "-q", "-c", "fix/login"]);
        commit(&laptop, "b");
        let tip = commit(&laptop, "c");
        git(&laptop, &["push", "-q", "-u", "origin", "fix/login"]);
        World { _tmp: tmp, laptop, machine, tip }
    }

    fn run(w: &World, worktree: &Path, branch: &str) -> i32 {
        let script = continue_worktree(w.machine.to_str().unwrap(), worktree.to_str().unwrap(), branch);
        Command::new("sh")
            .args(["-c", &script])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("sh runs")
            .status
            .code()
            .unwrap_or(-1)
    }

    #[test]
    fn the_machine_picks_the_branch_up_where_github_has_it_and_tracks_it() {
        let w = world();
        let wt = w.machine.with_file_name("machine-fix-login");
        assert_eq!(run(&w, &wt, "fix/login"), 0);
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), w.tip, "the pull request's last commit, not a new branch off main");
        assert_eq!(git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]), "fix/login");
        assert_eq!(git(&wt, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/fix/login");
        // A commit made there and pushed plainly lands on the same branch on GitHub.
        let next = commit(&wt, "d");
        git(&wt, &["push", "-q"]);
        git(&w.laptop, &["fetch", "-q"]);
        assert_eq!(git(&w.laptop, &["rev-parse", "origin/fix/login"]), next);
    }

    #[test]
    fn a_branch_github_has_never_seen_is_refused_not_invented() {
        let w = world();
        let wt = w.machine.with_file_name("machine-nope");
        assert_eq!(run(&w, &wt, "nope"), EXIT_NOT_ON_GITHUB);
        assert!(!wt.exists(), "nothing is made for a branch that isn't there");
    }

    #[test]
    fn coming_back_to_the_same_workspace_catches_it_up_with_github() {
        let w = world();
        let wt = w.machine.with_file_name("machine-fix-login");
        assert_eq!(run(&w, &wt, "fix/login"), 0);
        let later = commit(&w.laptop, "e");
        git(&w.laptop, &["push", "-q"]);
        assert_eq!(run(&w, &wt, "fix/login"), 0, "a folder already there is not an error");
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), later);
    }

    #[test]
    fn a_stale_branch_on_the_machine_is_moved_forward_but_its_own_commits_are_not_lost() {
        let w = world();
        // The machine once had the branch at an older commit GitHub still contains.
        git(&w.machine, &["fetch", "-q", "origin", "fix/login"]);
        git(&w.machine, &["branch", "fix/login", "FETCH_HEAD~1"]);
        let wt = w.machine.with_file_name("machine-fix-login");
        assert_eq!(run(&w, &wt, "fix/login"), 0);
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), w.tip);

        // Now give the machine a commit GitHub doesn't have, and ask again elsewhere.
        let mine = commit(&wt, "machine-only");
        let elsewhere = w.machine.with_file_name("machine-fix-login-2");
        git(&w.machine, &["worktree", "remove", wt.to_str().unwrap()]);
        assert_eq!(run(&w, &elsewhere, "fix/login"), EXIT_DIVERGED);
        assert_eq!(git(&w.machine, &["rev-parse", "fix/login"]), mine, "refused, never reset");
    }

    #[test]
    fn a_folder_already_on_another_branch_is_refused() {
        let w = world();
        let wt = w.machine.with_file_name("machine-fix-login");
        git(&w.machine, &["worktree", "add", "-q", "-b", "other", wt.to_str().unwrap()]);
        assert_eq!(run(&w, &wt, "fix/login"), EXIT_OTHER_BRANCH);
    }

    #[test]
    fn a_branch_name_is_only_ever_data_to_the_script() {
        let s = continue_worktree("/p", "/p-x", "x'; touch /tmp/owned; '");
        assert!(s.starts_with("p='/p'; w='/p-x'; b='x'\\''; touch /tmp/owned; '\\'''\n"), "{s}");
        assert_eq!(s.matches("touch").count(), 1, "spliced once, inside its own quotes");
    }

    #[test]
    fn each_refusal_says_what_to_do_about_it() {
        assert!(refusal("box", "fix/login", EXIT_NOT_ON_GITHUB).unwrap().contains("Push it from this laptop first"));
        assert!(refusal("box", "fix/login", EXIT_DIVERGED).unwrap().contains("won't move the branch"));
        assert!(refusal("box", "fix/login", EXIT_OTHER_BRANCH).unwrap().contains("other than fix/login"));
        assert!(refusal("box", "fix/login", EXIT_UNREACHABLE).unwrap().contains("couldn't fetch"));
        assert_eq!(refusal("box", "fix/login", 1), None);
    }
}
