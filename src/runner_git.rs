//! Getting a box's work onto the remote, and saying so only when it is there.
//!
//! A box that never pulled started every cycle from wherever it last stopped.
//! Once anyone else pushed (a member's laptop, another box) every push it made
//! was rejected "fetch first", while the board said `completed` and named a
//! commit that existed only on the box. Two rules close that:
//!
//! 1. A cycle starts from the remote's latest: fetch, then replay this
//!    computer's unpushed commits on top. A conflict is aborted, which leaves
//!    the checkout as it was, and the cycle's work fails with the reason.
//! 2. Work is reported only after its commits are on the remote. A rejected
//!    push is retried once (fetch, replay, push). A second refusal fails the
//!    task with `push rejected: <reason>`, and its commits are kept on a branch
//!    of their own on this computer instead of riding along with the next push.
//!
//! Nothing here force-pushes. The branch is the one this checkout pushes to:
//! its configured upstream, or `origin/<branch>` when it tracks nothing.
//! `crew run` commits on the checkout's current branch, so that is where every
//! task's work lands.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Output};

use aura_loop::{LoopGraph, LoopTask, STATE_COMPLETED};

/// The tag `aura loop cloud-sync --push` puts on a node once the board has
/// heard how it finished.
const REPORTED_TAG: &str = "cloud:pushed";

/// Where this checkout's work goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upstream {
    pub remote: String,
    pub branch: String,
}

impl Upstream {
    pub fn tracking(&self) -> String {
        format!("{}/{}", self.remote, self.branch)
    }
}

/// How a cycle started.
#[derive(Debug, PartialEq, Eq)]
pub enum Start {
    /// Already had the remote's latest.
    Current,
    /// Moved onto the remote's latest.
    Caught,
    /// Nothing to start from: no remote, or the branch is not on it yet.
    Unpublished,
}

/// Why a cycle could not start from the remote's latest.
#[derive(Debug, PartialEq, Eq)]
pub enum NotStarted {
    /// The remote could not be read. Nothing is claimed; the next cycle tries again.
    Unreachable(String),
    /// The remote was read, but this computer cannot move onto it without
    /// someone deciding how. Work taken this cycle fails with this reason.
    Stuck(String),
}

/// What delivery did.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivered {
    Nothing,
    /// On the remote. `moved` maps each commit replayed to get there to its new id.
    Pushed { moved: HashMap<String, String> },
}

fn git(repo: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("could not run git: {e}"))
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn succeeds(repo: &Path, args: &[&str]) -> bool {
    git(repo, args).map(|o| o.status.success()).unwrap_or(false)
}

/// The line of git's complaint a person should read.
pub fn reason(said: &str) -> String {
    let lines: Vec<&str> = said
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:") && !l.starts_with("To "))
        .collect();
    let pick = lines
        .iter()
        .find(|l| l.contains("[rejected]") || l.contains("[remote rejected]") || l.starts_with("CONFLICT"))
        .or_else(|| lines.iter().find(|l| l.starts_with("error:") || l.starts_with("fatal:")))
        .or_else(|| lines.first());
    match pick {
        Some(l) => l.trim_start_matches('!').split_whitespace().collect::<Vec<_>>().join(" "),
        None => "git gave no reason".to_string(),
    }
}

/// Why a clone failed, in words for the member who asked, or `None` when git
/// said nothing.
///
/// When the member's credential is refused, git itself only says it "could not
/// read Username"; the line that names the cause is the credential helper's
/// (`no credential for <remote>: <code> — <detail>`), so that one wins and is
/// reduced to its detail. Otherwise it is git's own complaint.
pub fn clone_reason(said: &str) -> Option<String> {
    if said.trim().is_empty() {
        return None;
    }
    if let Some(line) = said.lines().find(|l| l.contains("no credential for ")) {
        let rest = line.split("no credential for ").nth(1).unwrap_or_default();
        // The remote's own colon is `://`, so the first ": " ends it.
        let refusal = rest.split_once(": ").map_or(rest, |(_, r)| r);
        let refusal = refusal.trim().trim_end_matches('"').trim();
        let detail = match refusal.split_once(" — ") {
            Some((code, detail)) if !code.is_empty() && code.chars().all(|c| c.is_ascii_lowercase() || c == '_') => detail,
            _ => refusal,
        };
        if !detail.is_empty() {
            return Some(detail.to_string());
        }
    }
    Some(reason(said))
}

/// The branch this checkout pushes to, or `None` when it pushes nowhere.
pub fn upstream(repo: &Path) -> Option<Upstream> {
    let head = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok()?;
    let branch = stdout(&head);
    if !head.status.success() || branch.is_empty() {
        return None;
    }
    let config = |key: String| {
        git(repo, &["config", "--get", &key])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| stdout(&o))
            .filter(|s| !s.is_empty())
    };
    let remote = config(format!("branch.{branch}.remote"));
    let merge = config(format!("branch.{branch}.merge")).map(|m| m.trim_start_matches("refs/heads/").to_string());
    match (remote, merge) {
        (Some(remote), Some(merge)) if remote != "." => Some(Upstream { remote, branch: merge }),
        _ => {
            let remotes = git(repo, &["remote"]).ok().map(|o| stdout(&o)).unwrap_or_default();
            remotes
                .lines()
                .any(|r| r.trim() == "origin")
                .then(|| Upstream { remote: "origin".to_string(), branch })
        }
    }
}

/// Fetch the upstream branch. `Ok(false)` when the remote has no such branch yet.
fn fetch(repo: &Path, up: &Upstream) -> Result<bool, String> {
    let refspec = format!("+refs/heads/{0}:refs/remotes/{1}/{0}", up.branch, up.remote);
    let o = git(repo, &["fetch", "--quiet", &up.remote, &refspec])?;
    if o.status.success() {
        return Ok(true);
    }
    let said = String::from_utf8_lossy(&o.stderr);
    if said.contains("couldn't find remote ref") {
        return Ok(false);
    }
    Err(format!("could not fetch {}: {}", up.tracking(), reason(&said)))
}

/// Replay this computer's unpushed commits onto the fetched upstream. A
/// conflict is aborted, so the checkout is left exactly as it was.
fn catch_up(repo: &Path, up: &Upstream) -> Result<Start, String> {
    let tracking = up.tracking();
    if succeeds(repo, &["merge-base", "--is-ancestor", &tracking, "HEAD"]) {
        return Ok(Start::Current);
    }
    // `--autostash` because a box's tracked bookkeeping (`.aura/` in a repo
    // that commits it) is often dirty; git puts it back after the replay, and
    // `--abort` puts it back if the replay stops.
    let o = git(repo, &["rebase", "--autostash", &tracking])?;
    if o.status.success() {
        return Ok(Start::Caught);
    }
    let said = format!("{}\n{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    let conflicted = git(repo, &["diff", "--name-only", "--diff-filter=U"]).map(|o| stdout(&o)).unwrap_or_default();
    let _ = git(repo, &["rebase", "--abort"]);
    let files: Vec<&str> = conflicted.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    Err(if files.is_empty() {
        format!("this computer could not move its unpushed commits onto the latest {tracking}: {}", reason(&said))
    } else {
        format!("this computer's unpushed commits conflict with the latest {tracking} in {}", files.join(", "))
    })
}

/// Start a cycle from the remote's latest.
pub fn start_from_latest(repo: &Path) -> Result<Start, NotStarted> {
    let Some(up) = upstream(repo) else {
        return Ok(Start::Unpublished);
    };
    match fetch(repo, &up) {
        Ok(true) => catch_up(repo, &up).map_err(NotStarted::Stuck),
        Ok(false) => Ok(Start::Unpublished),
        Err(e) => Err(NotStarted::Unreachable(e)),
    }
}

/// This computer's commits the remote lacks, oldest first, each with what
/// still identifies it after a replay (author, author time, subject).
fn ahead(repo: &Path, tracking: &str) -> Vec<(String, String)> {
    let range = format!("{tracking}..HEAD");
    git(repo, &["log", "--reverse", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s", &range])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| stdout(&o))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\x1f').map(|(id, key)| (id.to_string(), key.to_string())))
        .collect()
}

fn moved(before: &[(String, String)], after: &[(String, String)]) -> HashMap<String, String> {
    let mut now: HashMap<&str, &str> = after.iter().map(|(id, key)| (key.as_str(), id.as_str())).collect();
    before
        .iter()
        .filter_map(|(old, key)| {
            now.remove(key.as_str())
                .filter(|new| *new != old.as_str())
                .map(|new| (old.clone(), new.to_string()))
        })
        .collect()
}

fn push(repo: &Path, up: &Upstream) -> Result<(), String> {
    let dst = format!("HEAD:refs/heads/{}", up.branch);
    let o = git(repo, &["push", &up.remote, &dst])?;
    if o.status.success() {
        Ok(())
    } else {
        Err(reason(&String::from_utf8_lossy(&o.stderr)))
    }
}

/// Push this computer's commits. A rejection is retried once from the
/// remote's latest; a second one is the error, worded `push rejected: …`.
pub fn deliver(repo: &Path) -> Result<Delivered, String> {
    let Some(up) = upstream(repo) else {
        return Ok(Delivered::Nothing);
    };
    let tracking = up.tracking();
    let published = succeeds(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{tracking}")]);
    let before = if published { ahead(repo, &tracking) } else { Vec::new() };
    if published && before.is_empty() {
        return Ok(Delivered::Nothing);
    }
    let first = match push(repo, &up) {
        Ok(()) => return Ok(Delivered::Pushed { moved: HashMap::new() }),
        Err(why) => why,
    };
    let then = |e: String| format!("push rejected: {first}; then {e}");
    if fetch(repo, &up).map_err(then)? {
        catch_up(repo, &up).map_err(then)?;
    }
    let after = ahead(repo, &tracking);
    push(repo, &up).map_err(|again| format!("push rejected: {again}"))?;
    Ok(Delivered::Pushed { moved: moved(&before, &after) })
}

/// Keep commits the remote refused on a branch of their own, and put the
/// checkout back on the remote's latest, so the next task neither carries
/// them along nor trips over them. Returns the branch's name.
fn park(repo: &Path, up: &Upstream, label: &str) -> Result<String, String> {
    let name = format!("aura/unpushed/{label}");
    let o = git(repo, &["branch", &name, "HEAD"])?;
    if !o.status.success() {
        return Err(format!("could not keep the work on {name}: {}", reason(&String::from_utf8_lossy(&o.stderr))));
    }
    let o = git(repo, &["reset", "--keep", &up.tracking()])?;
    if !o.status.success() {
        return Err(format!(
            "kept the work on {name}, but could not move this checkout back to {}: {}",
            up.tracking(),
            reason(&String::from_utf8_lossy(&o.stderr))
        ));
    }
    Ok(name)
}

fn on_remote(repo: &Path, sha: &str, tracking: &str) -> bool {
    succeeds(repo, &["merge-base", "--is-ancestor", sha, &format!("refs/remotes/{tracking}")])
}

/// Finished board tasks this computer has not reported yet that made a commit.
fn unreported_commits(graph: &LoopGraph) -> Vec<LoopTask> {
    graph
        .list()
        .into_iter()
        .filter(|t| {
            t.remote_id.is_some()
                && t.status == STATE_COMPLETED
                && t.commit_sha.is_some()
                && !t.tags.iter().any(|tag| tag == REPORTED_TAG)
        })
        .collect()
}

/// Deliver the cycle's commits, then make every finished task say what is
/// true: done only when its commit is on the remote (under the id it has
/// there), failed with the reason when it is not. Returns lines for the log.
pub fn finish_cycle(repo: &Path, graph: &LoopGraph) -> Vec<String> {
    let mut said = Vec::new();
    let Some(up) = upstream(repo) else {
        return said; // a local-only box keeps its work local, as it always has
    };
    let outcome = deliver(repo);
    let pending = unreported_commits(graph);
    let tracking = up.tracking();
    let kept = match (&outcome, pending.first()) {
        (Err(_), Some(first)) if !on_remote(repo, first.commit_sha.as_deref().unwrap_or(""), &tracking) => {
            let label = first.remote_id.as_deref().unwrap_or(&first.id).chars().take(8).collect::<String>();
            match park(repo, &up, &label) {
                Ok(name) => Some(name),
                Err(e) => {
                    said.push(e);
                    None
                }
            }
        }
        _ => None,
    };
    match &outcome {
        Ok(Delivered::Pushed { .. }) => said.push(format!("pushed to {tracking}")),
        Err(why) => said.push(why.clone()),
        Ok(Delivered::Nothing) => {}
    }
    let moved = match &outcome {
        Ok(Delivered::Pushed { moved }) => moved.clone(),
        _ => HashMap::new(),
    };
    for mut task in pending {
        let sha = task.commit_sha.clone().unwrap_or_default();
        if let Some((_, new)) = moved.iter().find(|(old, _)| old.starts_with(&sha)) {
            said.push(format!("{} landed as {} after replaying onto {tracking}", short(&sha), short(new)));
            task.commit_sha = Some(new.clone());
            if let Err(e) = graph.save(&task) {
                said.push(format!("could not record {}'s new commit id: {e}", task.id));
            }
        }
        let landed = task.commit_sha.as_deref().is_some_and(|s| on_remote(repo, s, &tracking));
        if landed {
            continue;
        }
        let why = match &outcome {
            Err(why) => why.clone(),
            Ok(_) => format!("its commit never reached {tracking}"),
        };
        let kept_on = match &kept {
            Some(branch) => format!(" on branch {branch}"),
            None => String::new(),
        };
        let message =
            format!("{why}. Its commit {} is kept on this computer{kept_on}; nothing reached {tracking}.", short(&sha));
        match graph.fail(&task.id, message) {
            Ok(mut failed) => {
                failed.commit_sha = None;
                if let Err(e) = graph.save(&failed) {
                    said.push(format!("could not clear {}'s commit id: {e}", task.id));
                }
                said.push(format!("task {} failed: its work is not on {tracking}", task.id));
            }
            Err(e) => said.push(format!("could not fail {}: {e}", task.id)),
        }
    }
    said
}

/// Fail every board task this computer could run now, because the cycle could
/// not start from the remote's latest. Returns how many.
pub fn fail_ready(graph: &LoopGraph, why: &str) -> usize {
    aura_loop::ready_set(&graph.list())
        .into_iter()
        .filter(|t| t.remote_id.is_some() && aura_loop::runs_here(t, aura_loop::PLACE_CLOUD))
        .filter(|t| graph.fail(&t.id, format!("not started: {why}")).is_ok())
        .count()
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn run(dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git").args(args).current_dir(dir).output().expect("git runs");
        assert!(o.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&o.stderr));
        stdout(&o)
    }

    /// A bare remote, the box's clone and a laptop's clone, with one commit on `main`.
    struct Team {
        _tmp: tempfile::TempDir,
        remote: PathBuf,
        boxed: PathBuf,
        laptop: PathBuf,
    }

    fn clone_into(remote: &Path, to: &Path) {
        let parent = to.parent().unwrap();
        run(parent, &["clone", "--quiet", remote.to_str().unwrap(), to.to_str().unwrap()]);
        for (k, v) in [("user.name", "t"), ("user.email", "t@example.test"), ("commit.gpgsign", "false")] {
            run(to, &["config", k, v]);
        }
        run(to, &["config", "core.hooksPath", to.join(".no-hooks").to_str().unwrap()]);
    }

    fn team() -> Team {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        run(&remote, &["init", "--quiet", "--bare", "--initial-branch=main"]);
        let seed = tmp.path().join("seed");
        clone_into(&remote, &seed);
        run(&seed, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        commit(&seed, "app.py", "a = 1\n", "seed");
        run(&seed, &["push", "--quiet", "origin", "main"]);
        let boxed = tmp.path().join("box");
        let laptop = tmp.path().join("laptop");
        clone_into(&remote, &boxed);
        clone_into(&remote, &laptop);
        Team { _tmp: tmp, remote, boxed, laptop }
    }

    fn commit(dir: &Path, file: &str, body: &str, msg: &str) -> String {
        std::fs::write(dir.join(file), body).unwrap();
        run(dir, &["add", file]);
        run(dir, &["commit", "--quiet", "-m", msg]);
        run(dir, &["rev-parse", "HEAD"])
    }

    fn remote_main(t: &Team) -> String {
        run(&t.remote, &["rev-parse", "main"])
    }

    fn finished_task(dir: &Path, sha: &str) -> LoopTask {
        let graph = LoopGraph::at(dir);
        let mut task = graph
            .create("t".into(), "do it".into(), "medium".into(), "task".into(), vec![], None, Some("claude".into()), vec![])
            .unwrap();
        task.remote_id = Some("11111111-2222-3333-4444-555555555555".into());
        task.status = STATE_COMPLETED.to_string();
        task.commit_sha = Some(sha.to_string());
        graph.save(&task).unwrap();
        task
    }

    #[test]
    fn a_cycle_starts_from_what_the_laptop_pushed() {
        let t = team();
        let theirs = commit(&t.laptop, "laptop.py", "x = 1\n", "laptop work");
        run(&t.laptop, &["push", "--quiet", "origin", "main"]);
        let mine = commit(&t.boxed, "box.py", "y = 1\n", "box work from before");

        assert_eq!(start_from_latest(&t.boxed), Ok(Start::Caught));
        assert_eq!(run(&t.boxed, &["rev-parse", "HEAD~1"]), theirs, "the box's commit now sits on the laptop's");
        assert_ne!(run(&t.boxed, &["rev-parse", "HEAD"]), mine);
        assert_eq!(start_from_latest(&t.boxed), Ok(Start::Current));
    }

    #[test]
    fn a_conflict_at_the_start_is_aborted_named_and_leaves_the_checkout_as_it_was() {
        let t = team();
        commit(&t.laptop, "app.py", "a = 2\n", "laptop edits a");
        run(&t.laptop, &["push", "--quiet", "origin", "main"]);
        let mine = commit(&t.boxed, "app.py", "a = 3\n", "box edits a");

        match start_from_latest(&t.boxed) {
            Err(NotStarted::Stuck(why)) => assert!(why.contains("app.py"), "names the file: {why}"),
            other => panic!("expected a stuck start, got {other:?}"),
        }
        assert_eq!(run(&t.boxed, &["rev-parse", "HEAD"]), mine, "nothing moved");
        assert_eq!(run(&t.boxed, &["status", "--porcelain", "--untracked-files=no"]), "", "tree is clean");
        assert!(!t.boxed.join(".git/rebase-merge").exists() && !t.boxed.join(".git/rebase-apply").exists());
    }

    #[test]
    fn an_unreachable_remote_is_not_a_reason_to_fail_work() {
        let t = team();
        run(&t.boxed, &["remote", "set-url", "origin", t.remote.join("gone.git").to_str().unwrap()]);
        assert!(matches!(start_from_latest(&t.boxed), Err(NotStarted::Unreachable(_))));
    }

    #[test]
    fn a_rejected_push_is_retried_once_and_the_task_names_the_commit_that_landed() {
        let t = team();
        let mine = commit(&t.boxed, "box.py", "y = 1\n", "box work");
        finished_task(&t.boxed, &mine[..12]);
        // The laptop pushes while the box's agent was working.
        let theirs = commit(&t.laptop, "laptop.py", "x = 1\n", "laptop work");
        run(&t.laptop, &["push", "--quiet", "origin", "main"]);

        let said = finish_cycle(&t.boxed, &LoopGraph::at(&t.boxed));

        let landed = remote_main(&t);
        assert_eq!(run(&t.remote, &["rev-parse", "main~1"]), theirs, "the laptop's work is kept, not overwritten");
        assert_ne!(landed, mine, "the box's commit was replayed onto the laptop's");
        let task = LoopGraph::at(&t.boxed).list().pop().unwrap();
        assert_eq!(task.status, STATE_COMPLETED, "{said:?}");
        assert_eq!(task.commit_sha.as_deref(), Some(landed.as_str()), "the board gets the id that exists on the remote");
    }

    #[test]
    fn a_push_still_refused_fails_the_task_and_keeps_the_work_on_this_computer() {
        let t = team();
        let mine = commit(&t.boxed, "app.py", "a = 3\n", "box edits a");
        let task = finished_task(&t.boxed, &mine);
        let theirs = commit(&t.laptop, "app.py", "a = 2\n", "laptop edits a");
        run(&t.laptop, &["push", "--quiet", "origin", "main"]);

        finish_cycle(&t.boxed, &LoopGraph::at(&t.boxed));

        assert_eq!(remote_main(&t), theirs, "nothing of the box's reached the remote, and nothing was forced");
        let failed = LoopGraph::at(&t.boxed).get(&task.id).unwrap();
        assert_eq!(failed.status, aura_loop::STATE_FAILED);
        let why = failed.error_message.unwrap_or_default();
        assert!(why.starts_with("push rejected:"), "{why}");
        assert!(why.contains("aura/unpushed/11111111"), "says where the work is: {why}");
        assert_eq!(failed.commit_sha, None, "no commit id that only exists here");
        assert_eq!(run(&t.boxed, &["rev-parse", "aura/unpushed/11111111"]), mine, "the work is kept");
        assert_eq!(run(&t.boxed, &["rev-parse", "HEAD"]), theirs, "the next task starts from the remote's latest");
    }

    #[test]
    fn work_already_on_the_remote_stays_done() {
        let t = team();
        let mine = commit(&t.boxed, "box.py", "y = 1\n", "box work");
        run(&t.boxed, &["push", "--quiet", "origin", "main"]);
        let task = finished_task(&t.boxed, &mine);

        finish_cycle(&t.boxed, &LoopGraph::at(&t.boxed));

        let done = LoopGraph::at(&t.boxed).get(&task.id).unwrap();
        assert_eq!(done.status, STATE_COMPLETED);
        assert_eq!(done.commit_sha.as_deref(), Some(mine.as_str()));
    }

    #[test]
    fn a_stuck_start_fails_the_board_work_it_would_have_run() {
        let t = team();
        let graph = LoopGraph::at(&t.boxed);
        let mut task = graph
            .create("t".into(), "do it".into(), "medium".into(), "task".into(), vec![], Some("it runs".into()), None, vec![])
            .unwrap();
        task.remote_id = Some("abc".into());
        graph.save(&task).unwrap();
        let local = graph
            .create("l".into(), "mine".into(), "medium".into(), "task".into(), vec![], Some("it runs".into()), None, vec![])
            .unwrap();

        assert_eq!(fail_ready(&graph, "conflict in app.py"), 1);
        let failed = graph.get(&task.id).unwrap();
        assert_eq!(failed.status, aura_loop::STATE_FAILED);
        assert_eq!(failed.error_message.as_deref(), Some("not started: conflict in app.py"));
        assert_eq!(graph.get(&local.id).unwrap().status, aura_loop::STATE_SUBMITTED, "never-boarded work is left alone");
    }

    /// What prod's box logged when MHASK/Lumi was not in the GitHub App: the
    /// answer used to say "check the GitHub install" for every failure, and
    /// git's own last word here is the useless "could not read Username".
    #[test]
    fn a_refused_clone_says_the_cloud_s_reason_not_git_s() {
        let said = "Cloning into '/opt/aura-runner/workspaces/MHASK__Lumi'...\n\
Error: \"no credential for https://github.com/MHASK/Lumi.git: project_not_in_github_app — the Aura GitHub App isn't installed on MHASK/Lumi — add it to the App's repository access on GitHub, then try again\"\n\
fatal: could not read Username for 'https://github.com/MHASK/Lumi.git': No such device or address\n";
        assert_eq!(
            clone_reason(said).as_deref(),
            Some("the Aura GitHub App isn't installed on MHASK/Lumi — add it to the App's repository access on GitHub, then try again")
        );
    }

    #[test]
    fn a_clone_that_failed_for_another_reason_says_git_s_complaint() {
        let said = "Cloning into '/w/a__b'...\nfatal: could not create work tree dir '/w/a__b': No space left on device\n";
        assert_eq!(
            clone_reason(said).as_deref(),
            Some("fatal: could not create work tree dir '/w/a__b': No space left on device")
        );
        assert_eq!(clone_reason("  \n"), None, "silence is not a reason");
    }

    #[test]
    fn a_refusal_without_a_code_is_kept_whole() {
        let said = "Error: \"no credential for https://github.com/a/b.git: asking the cloud for a push credential: timed out\"\n";
        assert_eq!(clone_reason(said).as_deref(), Some("asking the cloud for a push credential: timed out"));
    }
}
