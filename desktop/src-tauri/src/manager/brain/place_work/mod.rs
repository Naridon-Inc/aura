//! AURA-1306 — the file tree, the editor, the Changes list and the git panel,
//! for a workspace whose checkout lives on a machine.
//!
//! Every command in `cmd_files.rs` / `cmd_aura_fs.rs` reads a path on this
//! disk and runs `git` in it. A workspace opened at a place has no such path:
//! its worktree is on the box, and the only thing this laptop holds is the
//! machine's row. So each of those commands has a twin here that takes the
//! machine and the root, asks [`Place`] for the box, and runs the *same* git
//! line over there — through [`Place::sh`], [`Place::read`], [`Place::list`]
//! and [`Place::write`], never a transport of its own. Nothing is synced: the
//! bytes the editor shows came off the box a moment ago and go back to it on
//! save, and a diff is git's own answer from the checkout it describes.
//!
//! ## Two spellings of one path
//!
//! The frontend knows a remote workspace by its *local* root — the checkout on
//! this laptop that the box's copy was made from — because that is the key
//! every store, cache and tab has always used. The box knows the same project
//! by `machine.repo_path`. So every path in here crosses that seam twice: a
//! path arriving under the local root is cut down to a project-relative one
//! and re-rooted on the box for the command; a path in an answer is spelled
//! back under the local root, so the tree, the editor and
//! `machineIdForPath` on the other side keep working without knowing.
//!
//! Split by what a command does: [`fs`] is the file tree and the editor,
//! [`git`] is every git *question* (status, diff, branches, counts), and
//! [`git_ops`] is every git *act* (stage, commit, push, checkout). The parsers
//! are `crate::git_parse`, shared with the local twins, which is what keeps
//! the two arms answering in one shape.

pub mod fs;
pub mod git;
pub mod git_ops;
mod paths;
pub mod ready;
pub mod run;

use std::time::Duration;

use super::place::{Output, Place};

/// A question — status, a diff, a listing. Never the thing a pane waits on.
const ASK: Duration = Duration::from_secs(30);
/// Work on the box's own disk — a checkout, a commit, a clean.
const WORK: Duration = Duration::from_secs(60);
/// Work that goes out to a remote — push, pull, fetch.
const WIRE: Duration = Duration::from_secs(120);

/// One line of output that separates two answers to one script, so a
/// listing and its git status — or a numstat and its untracked count — cost
/// one round trip rather than two. `\x1e` is ASCII record separator: it never
/// appears in a path git prints, and `printf '\036\n'` spells it on any sh.
const FENCE: &str = "\u{1e}";
const PRINT_FENCE: &str = "printf '\\036\\n'";

/// A remote workspace: the box, and the root the frontend spells it by.
pub(crate) struct Work {
    place: Place,
    /// The local root — the checkout on this laptop — without a trailing
    /// slash. Every path the frontend sends is under it, and every path sent
    /// back is put under it.
    root: String,
}

impl Work {
    /// Open the workspace at `place`, spelled by the frontend as `root`.
    ///
    /// The caller has already asked `Place::at_machine`, in its own body, so
    /// that the parity gate in `cloudbox::sole_ssh` can see it did.
    pub(crate) fn at(place: Place, root: &str) -> Result<Self, String> {
        Self::at_worktree(place, root, None)
    }

    /// [`Work::at`], in a checkout on the box other than the one the machine
    /// row records.
    ///
    /// `Place::at_machine` roots the box at `machine.repo_path` — the copy the
    /// machine was connected with. A workspace launched onto the box is not
    /// there: `box_start` adds a *sibling* worktree (`<project>-<branch>`, see
    /// `cloudbox::script::worktree_path`) and the agent works in it. A file
    /// tree or a `git status` rooted at `repo_path` would then describe the
    /// wrong checkout while looking exactly like the right one. So the
    /// frontend carries the worktree's path on the box alongside the local
    /// root (`RemotePlace.remoteRoot`), and it lands here as `remote_root`:
    /// present, it is where every command runs; absent, the row's path is,
    /// as before.
    ///
    /// Checked as `cloudbox::script::is_abs_path` checks a path it splices
    /// into a script — absolute, no `..`, nothing that could end a quote —
    /// because that is exactly what this one is about to become.
    pub(crate) fn at_worktree(
        place: Place,
        root: &str,
        remote_root: Option<&str>,
    ) -> Result<Self, String> {
        if !place.is_remote() {
            return Err("That isn't a machine, it's this laptop.".to_string());
        }
        let place = match remote_root.map(str::trim).filter(|r| !r.is_empty()) {
            Some(there) => rerooted(place, there)?,
            None => place,
        };
        let remote = place.root();
        if remote == "~" || remote.is_empty() {
            return Err(format!(
                "{} has no project folder recorded, so there is nothing to open there.",
                place.label()
            ));
        }
        let root = root.trim().trim_end_matches('/');
        if root.is_empty() {
            return Err("A workspace needs a root.".to_string());
        }
        Ok(Self {
            place,
            root: root.to_string(),
        })
    }

    /// A path the frontend sent, cut down to the project-relative form both
    /// sides agree on. `.` is the root itself.
    fn rel(&self, path: &str) -> Result<String, String> {
        paths::rel_of(&self.root, path)
    }

    /// The same path as the box spells it — for a command that names it.
    fn over_there(&self, rel: &str) -> String {
        paths::joined(self.place.root(), rel)
    }

    /// The same path as the frontend spells it — for an answer.
    fn over_here(&self, rel: &str) -> String {
        paths::joined(&self.root, rel)
    }

    /// Ask the box something, in the project root.
    async fn ask(&self, script: &str) -> Result<Output, String> {
        self.place.sh(script, ASK).await
    }

    /// Have the box do something, in the project root.
    async fn run(&self, script: &str, wait: Duration) -> Result<Output, String> {
        self.place.sh(script, wait).await
    }
}

/// The same box, standing in `there` instead of the checkout its row records.
fn rerooted(place: Place, there: &str) -> Result<Place, String> {
    let there = there.trim_end_matches('/');
    let there = if there.is_empty() { "/" } else { there };
    if !crate::cloudbox::script::is_abs_path(there) {
        return Err(format!("{there:?} isn't a folder on {} this can reach.", place.label()));
    }
    match place {
        Place::Box { machine, here, .. } => Ok(Place::Box {
            machine,
            root: there.to_string(),
            here,
        }),
        other => Ok(other),
    }
}

/// What a finished git line means to the React side: `Ok(stdout)` when it
/// exited 0, `Err(stderr)` otherwise — the same rule as `git_output_result`
/// in `cmd_files.rs`, so a stage that did not stage is never reported as one
/// that did. A failing git that said nothing on stderr falls back to stdout,
/// then to a line that at least names the exit, so the error the UI renders
/// is never blank.
fn outcome(out: &Output) -> Result<String, String> {
    if out.ok() {
        return Ok(out.stdout.trim().to_string());
    }
    let msg = out.stderr.trim();
    if !msg.is_empty() {
        return Err(msg.to_string());
    }
    let stdout = out.stdout.trim();
    if stdout.is_empty() {
        Err(format!("git exited with status {}", out.code))
    } else {
        Err(stdout.to_string())
    }
}

/// `Err(stderr)` with a fallback sentence when git said nothing — the shape
/// the local `git_checkout` / `git_reset_files` use.
fn failed(out: &Output, what: &str) -> String {
    let err = out.stderr.trim();
    if err.is_empty() {
        what.to_string()
    } else {
        err.to_string()
    }
}

/// Two answers from one script, cut at the [`FENCE`] line. Without a fence
/// the whole answer is the first half.
fn split_at_fence(stdout: &str) -> (&str, &str) {
    let fence = format!("{FENCE}\n");
    match stdout.find(&fence) {
        Some(i) => (&stdout[..i], &stdout[i + fence.len()..]),
        None => match stdout.strip_suffix(FENCE) {
            Some(head) => (head, ""),
            None => (stdout, ""),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_machines::Machine;

    fn a_box() -> Place {
        Place::Box {
            machine: Box::new(Machine {
                id: "ubuntu@example.invalid:/home/ubuntu/naridon".into(),
                name: "aura-runner".into(),
                host: "example.invalid".into(),
                user: "ubuntu".into(),
                key_path: "/dev/null".into(),
                box_kind: "mine".into(),
                repo_path: Some("/home/ubuntu/naridon".into()),
                repo_branch: None,
                project_root: Some("/Users/me/naridon".into()),
                org_slug: None,
                forward_agent: false,
                instance_id: None,
                asleep_since: 0,
                added_at: 0,
                last_used_at: 0,
            }),
            root: "/home/ubuntu/naridon".into(),
            here: "/Users/me/naridon".into(),
        }
    }

    #[test]
    fn without_a_worktree_the_row_s_checkout_is_where_work_runs() {
        let w = Work::at(a_box(), "/Users/me/naridon/").unwrap();
        assert_eq!(w.root, "/Users/me/naridon");
        assert_eq!(w.over_there("src/a.rs"), "/home/ubuntu/naridon/src/a.rs");
        let same = Work::at_worktree(a_box(), "/Users/me/naridon", Some("  ")).unwrap();
        assert_eq!(same.over_there("."), "/home/ubuntu/naridon");
    }

    #[test]
    fn a_launched_worktree_is_where_every_path_lands() {
        // `box_start` adds `<project>-<branch>` beside the project; the
        // frontend still spells files under the LOCAL root, and each one is
        // re-rooted onto the sibling, not onto the row's checkout.
        let w = Work::at_worktree(
            a_box(),
            "/Users/me/naridon",
            Some("/home/ubuntu/naridon-feat-x/"),
        )
        .unwrap();
        assert_eq!(w.over_there("src/a.rs"), "/home/ubuntu/naridon-feat-x/src/a.rs");
        assert_eq!(
            w.rel("/Users/me/naridon/src/a.rs").map(|r| w.over_there(&r)).unwrap(),
            "/home/ubuntu/naridon-feat-x/src/a.rs"
        );
        assert_eq!(w.over_here("src/a.rs"), "/Users/me/naridon/src/a.rs");
    }

    #[test]
    fn a_worktree_path_that_could_leave_or_end_a_script_is_refused() {
        for bad in ["relative/x", "/home/u/../etc", "/home/u/it's", "/home/u\nx"] {
            assert!(
                Work::at_worktree(a_box(), "/Users/me/naridon", Some(bad)).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_fenced_answer_comes_apart_at_the_fence() {
        assert_eq!(split_at_fence("a\nb\n\u{1e}\nc\n"), ("a\nb\n", "c\n"));
        assert_eq!(split_at_fence("a\n"), ("a\n", ""));
        assert_eq!(split_at_fence("\u{1e}\nc"), ("", "c"));
        // A fence at the very end, printed after an empty second half.
        assert_eq!(split_at_fence("a\n\u{1e}"), ("a\n", ""));
    }

    #[test]
    fn an_outcome_is_never_a_blank_error() {
        let ok = Output { code: 0, stdout: " done \n".into(), stderr: String::new() };
        assert_eq!(outcome(&ok).unwrap(), "done");
        let said = Output { code: 1, stdout: String::new(), stderr: "no\n".into() };
        assert_eq!(outcome(&said).unwrap_err(), "no");
        let quiet = Output { code: 128, stdout: String::new(), stderr: String::new() };
        assert_eq!(outcome(&quiet).unwrap_err(), "git exited with status 128");
        assert_eq!(failed(&quiet, "checkout failed"), "checkout failed");
    }
}
