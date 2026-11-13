//! One chat turn on this machine, as the member whose sign-in it runs on.
//!
//! That member is whoever started the workspace: a teammate's prompt keeps
//! its author and runs on the starter's sign-in
//! ([`crate::runner_chat::Prompt::runs_as`]; a cloud that names nobody means
//! the author). Started by [`crate::runner_chat`] with the member named in the
//! environment, so every credential this process spends — the clone, the
//! agent's sign-in, the push — is that member's own, minted for this turn and
//! never written down here:
//!
//! 1. The project's clone, through the member's short-lived token
//!    ([`crate::runner::ensure_workspace`]).
//! 2. A worktree of its own for the workspace, on the workspace's branch, so
//!    two workspaces of one project never edit the same files.
//! 3. The member's agent sign-in, by spending the lease the send minted
//!    ([`crate::agent_env::fetch_chat`]). A lease is good once; a turn that
//!    cannot get one says why instead of running on the box's own keys.
//! 4. The agent, continuing the workspace's conversation when it has one.
//! 5. Whatever it changed, committed under the member's name and pushed to the
//!    workspace's branch — never forced, never to the default branch.
//! 6. The answer, posted for the member. A failure is an answer too. It says
//!    which branch and folder the work is in, so the workspace shows where it
//!    really lives rather than where the link guessed it would.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::agent_env::{self, NotApplied};
use crate::push_credential;
use crate::runner_chat::{At, Chat, Cloud};

/// The longest the agent may work on one prompt.
const AGENT_LIMIT: Duration = Duration::from_secs(45 * 60);
/// The longest commit subject taken from a prompt.
const SUBJECT_LIMIT: usize = 72;
/// The longest workspace id a branch of its own is named after.
const BRANCH_ID_LIMIT: usize = 64;

/// What the agent said, and the conversation it said it in.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Said {
    pub text: String,
    pub session: Option<String>,
}

/// `aura runner chat-turn` — read one [`Chat`] on stdin, answer it.
pub fn run(workspaces_root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    // This process holds the runner token and starts the agent: keep its
    // environment out of the agent's reach through /proc.
    crate::runner_guard::seal_process();
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw)?;
    let chat: Chat = serde_json::from_str(&raw)?;
    let cloud = Cloud::connect()?;
    let bin = std::env::current_exe()?;
    match push_credential::acting_member() {
        Some(m) if m == chat.prompt.runs_as() => {}
        _ => {
            let text = "This computer wasn't told whose sign-in this prompt runs on, so it did not run it.";
            cloud.answer(&chat, text, None, true, &At::default())?;
            return Ok(());
        }
    }
    let mut at = At::default();
    let (text, session, failed) = match turn(&bin, workspaces_root, &chat, &mut at) {
        Ok(said) => (said.text, said.session, false),
        Err(why) => (why, None, true),
    };
    cloud.answer(&chat, &text, session.as_deref(), failed, &at)?;
    eprintln!("[chat] answered {} in {}{}", chat.prompt.message_id, chat.repo, if failed { " (not run)" } else { "" });
    Ok(())
}

/// The sign-in a turn runs on, as everyone reading the workspace hears it.
fn whose_sign_in(chat: &Chat) -> &'static str {
    if chat.prompt.on_starter_s_sign_in() {
        "The Claude sign-in of whoever started this workspace"
    } else {
        "Your Claude sign-in"
    }
}

/// Run the turn. `at` is filled in as soon as the work has a branch and a
/// folder, so even a turn that fails later reports where its work is.
fn turn(bin: &Path, root: &Path, chat: &Chat, at: &mut At) -> Result<Said, String> {
    if chat.engine != "claude" {
        return Err(format!(
            "This computer answers Claude chats; this workspace is set to {}. Switch it to Claude to run it here.",
            chat.engine
        ));
    }
    let lease = match (&chat.prompt.lease, &chat.prompt.refused) {
        (Some(l), _) => l.clone(),
        (None, Some(why)) => return Err(format!("Not run: {why}.")),
        (None, None) => {
            return Err("Not run: the sign-in sent with this prompt was already used or ran out \
                        (each lasts 15 minutes). Send it again."
                .into())
        }
    };
    let checkout =
        crate::runner::ensure_workspace_or_why(bin, root, &chat.repo).map_err(|why| cannot_clone(&chat.repo, why))?;
    let chat = &Chat { default_branch: default_branch(&checkout.dir, &chat.default_branch), ..chat.clone() };
    let planned = branch_for(chat);
    let tree = worktree(&checkout.dir, root, chat, &planned)?;
    // The branch the worktree is really on. A workspace made before its
    // branch was named differently keeps the branch its work was pushed to.
    let branch = current_branch(&tree).unwrap_or(planned);
    at.branch = Some(branch.clone());
    at.folder = Some(tree.to_string_lossy().to_string());
    // Running on the copy this computer already had is safe: the push at the
    // end is never forced, so old code can't overwrite anybody's newer work —
    // at worst the push is refused, and the answer says so. What isn't safe
    // is letting the member think it ran on the latest, so it is said first.
    let stale = checkout.stale.as_deref().map(|why| stale_note(&chat.repo, why, &branch, head_of(&tree).as_deref()));
    let env = agent_env::fetch_chat("claude", &lease, &chat.workspace_id).map_err(|e| match e {
        NotApplied::NotNeeded => "This computer wasn't told whose sign-in this prompt runs on.".to_string(),
        NotApplied::NotOffered => "The cloud doesn't lend sign-ins to this computer yet.".to_string(),
        NotApplied::NotLive(d) | NotApplied::Refused(d) => format!("{} couldn't be used here: {d}", whose_sign_in(chat)),
    })?;
    let mut said = claude(&tree, root, chat, &env).map_err(|e| match &stale {
        Some(note) => format!("{note}\n\n{e}"),
        None => e,
    })?;
    if let Some(note) = deliver(bin, &tree, &branch, &chat.prompt.text) {
        said.text.push_str("\n\n");
        said.text.push_str(&note);
    }
    if let Some(note) = stale {
        said.text = format!("{note}\n\n{}", said.text);
    }
    Ok(said)
}

/// The line that leads an answer worked on an old copy: why the latest
/// couldn't be had, and exactly which commit the work started from.
pub(crate) fn stale_note(repo: &str, why: &str, branch: &str, head: Option<&str>) -> String {
    let on = match head {
        Some(h) => format!("`{branch}` at {h}"),
        None => format!("`{branch}`"),
    };
    format!(
        "Heads up: this computer couldn't fetch the latest {repo} ({why}), so this ran on the copy it \
         already had — {on}."
    )
}

/// The commit a worktree is on, short id and subject.
fn head_of(tree: &Path) -> Option<String> {
    git(tree, &["log", "-1", "--format=%h “%s”"]).ok().filter(|s| !s.is_empty())
}

/// The branch a worktree has checked out, `None` when it is detached.
fn current_branch(tree: &Path) -> Option<String> {
    git(tree, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().filter(|b| !b.is_empty())
}

/// The answer when the project couldn't be put on this computer: the reason
/// when there is one, the likeliest cause when git gave none.
pub(crate) fn cannot_clone(repo: &str, why: Option<String>) -> String {
    match why {
        Some(why) => format!("Couldn't get {repo} onto this computer: {why}"),
        None => format!(
            "Couldn't get {repo} onto this computer. Check the project is in the organization's GitHub install."
        ),
    }
}

/// The branch the project really starts from. The cloud doesn't learn a
/// project's default branch from GitHub and says `main` for every one, so a
/// project whose default is `master` had no `origin/main` to start a
/// workspace from and every prompt failed before the agent ran. The clone
/// knows better: `origin/HEAD` is the remote's own default. Without it, what
/// the cloud said is kept if the clone has that branch, then the usual names.
pub(crate) fn default_branch(checkout: &Path, said: &str) -> String {
    if let Some(head) = git(checkout, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .and_then(|r| r.strip_prefix("origin/").map(str::to_string))
        .filter(|b| !b.is_empty())
    {
        return head;
    }
    let on_remote = |b: &str| git(checkout, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{b}")]).is_ok();
    [said, "main", "master", "trunk", "develop"]
        .into_iter()
        .find(|b| !b.is_empty() && on_remote(b))
        .unwrap_or(said)
        .to_string()
}

/// A name safe as one path segment and one branch-name segment.
pub(crate) fn slug(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "chat".into() } else { out }
}

/// The branch a workspace's work lands on: the one the link names when git
/// accepts it and it is not the default branch, otherwise one of its own,
/// named after the whole workspace id — a prefix cut mid-id can end in a dash
/// and stops naming one workspace.
pub(crate) fn branch_for(chat: &Chat) -> String {
    let own = || {
        let id: String = slug(&chat.workspace).chars().take(BRANCH_ID_LIMIT).collect();
        let id = id.trim_end_matches(['-', '_']);
        format!("aura/{}", if id.is_empty() { "chat" } else { id })
    };
    match chat.branch.as_deref().map(str::trim) {
        Some(b) if !b.is_empty() && b != chat.default_branch && valid_branch(b) => b.to_string(),
        _ => own(),
    }
}

fn valid_branch(b: &str) -> bool {
    Command::new("git")
        .args(["check-ref-format", "--branch", b])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").args(args).current_dir(dir).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The workspace's own worktree, made on first use from its branch on the
/// remote when there is one, otherwise from the latest default branch.
fn worktree(checkout: &Path, root: &Path, chat: &Chat, branch: &str) -> Result<PathBuf, String> {
    let tree = root.join(".chats").join(slug(&chat.workspace));
    if tree.join(".git").exists() {
        return Ok(tree);
    }
    std::fs::create_dir_all(root.join(".chats")).map_err(|e| format!("making room for the workspace: {e}"))?;
    let _ = git(checkout, &["worktree", "prune"]);
    let remote_branch = format!("origin/{branch}");
    let base = if git(checkout, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote_branch}")]).is_ok() {
        remote_branch
    } else {
        format!("origin/{}", chat.default_branch)
    };
    let path = tree.to_string_lossy().to_string();
    git(checkout, &["worktree", "add", "-B", branch, &path, &base])
        .map_err(|e| format!("Couldn't set up the workspace's branch {branch} on this computer: {e}"))?;
    Ok(tree)
}

/// Run the agent on the prompt, on the member's sign-in.
fn claude(tree: &Path, root: &Path, chat: &Chat, env: &agent_env::AgentEnv) -> Result<Said, String> {
    let resume = chat.agent_session_id.as_deref().filter(|s| !s.is_empty());
    match claude_once(tree, root, chat, env, resume) {
        // A conversation this computer has never held (it began on a laptop,
        // or this computer was rebuilt) is started fresh rather than refused.
        Err(e) if resume.is_some() && e.contains("No conversation found") => claude_once(tree, root, chat, env, None),
        other => other,
    }
}

fn claude_once(tree: &Path, root: &Path, chat: &Chat, env: &agent_env::AgentEnv, resume: Option<&str>) -> Result<Said, String> {
    let logs = root.join(".chats");
    let base = slug(&chat.workspace);
    let out_path = logs.join(format!("{base}.out.json"));
    let err_path = logs.join(format!("{base}.err.log"));
    let out = std::fs::File::create(&out_path).map_err(|e| format!("opening the turn log: {e}"))?;
    let err = std::fs::File::create(&err_path).map_err(|e| format!("opening the turn log: {e}"))?;

    let mut cmd = Command::new("claude");
    cmd.args(["-p", "--output-format", "json", "--dangerously-skip-permissions"]);
    if let Some(m) = model_of(chat) {
        cmd.args(["--model", m]);
    }
    if let Some(s) = resume {
        cmd.args(["--resume", s]);
    }
    cmd.current_dir(tree).stdin(Stdio::piped()).stdout(out).stderr(err);
    // The agent works on the member's checkout and never needs the box's own
    // token; this process keeps it to report back and push.
    crate::runner_guard::withhold(&mut cmd);
    env.apply(&mut cmd);
    // The prompt goes in on stdin, never as an argument: a prompt is the
    // member's own words and may start with a dash.
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Claude on this computer: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(chat.prompt.text.as_bytes()).map_err(|e| format!("handing Claude the prompt: {e}"))?;
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() > AGENT_LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Claude was still working after {} minutes and was stopped.", AGENT_LIMIT.as_secs() / 60));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(500)),
            Err(e) => return Err(format!("lost track of Claude: {e}")),
        }
    };
    let stdout = std::fs::read_to_string(&out_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&err_path).unwrap_or_default();
    said_of(status.success(), &stdout, &stderr)
}

/// The model to run the turn on: the one the sender picked, when it is a
/// plain model name. Nothing — the agent's own default — when they picked the
/// agent's default (sent as the agent's name), or when what came is not a
/// model name at all: it goes on the command line, so anything that could
/// read as a flag is refused rather than passed.
pub(crate) fn model_of(chat: &Chat) -> Option<&str> {
    let m = chat.prompt.model.as_deref()?.trim();
    if m.is_empty() || m == "default" || m == chat.engine {
        return None;
    }
    let plain = m.len() <= 80
        && m.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '[' | ']'));
    plain.then_some(m)
}

/// Read what `claude -p --output-format json` printed.
pub(crate) fn said_of(ok: bool, stdout: &str, stderr: &str) -> Result<Said, String> {
    let parsed: Option<serde_json::Value> = serde_json::from_str(stdout.trim()).ok();
    let result = parsed.as_ref().and_then(|v| v.get("result")).and_then(|v| v.as_str()).map(str::to_string);
    let session = parsed.as_ref().and_then(|v| v.get("session_id")).and_then(|v| v.as_str()).map(str::to_string);
    let is_error = parsed.as_ref().and_then(|v| v.get("is_error")).and_then(|v| v.as_bool()).unwrap_or(false);
    match result {
        Some(text) if ok && !is_error && !text.trim().is_empty() => Ok(Said { text, session }),
        Some(_) if ok && !is_error => Ok(Said { text: "(Claude finished without saying anything.)".into(), session }),
        other => {
            let why = other
                .filter(|t| !t.trim().is_empty())
                .or_else(|| last_line(stderr))
                .or_else(|| last_line(stdout))
                .unwrap_or_else(|| "no output".into());
            Err(format!("Claude stopped with an error: {why}"))
        }
    }
}

fn last_line(s: &str) -> Option<String> {
    s.lines().rev().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

/// The commit subject a prompt gives.
pub(crate) fn subject(prompt: &str) -> String {
    let first = prompt.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Work from a cloud chat");
    if first.chars().count() <= SUBJECT_LIMIT {
        first.to_string()
    } else {
        format!("{}…", first.chars().take(SUBJECT_LIMIT - 1).collect::<String>())
    }
}

/// Commit what the agent left and push the workspace's branch, as the member.
/// `None` when there was nothing to deliver; otherwise one line for the answer.
fn deliver(bin: &Path, tree: &Path, branch: &str, prompt: &str) -> Option<String> {
    let dirty = git(tree, &["status", "--porcelain"]).map(|s| !s.is_empty()).unwrap_or(false);
    if dirty {
        let subject = subject(prompt);
        // Recorded like any change on Aura, so the work says why it was made.
        let _ = Command::new(bin).args(["log-intent", "--type", "FeatureAdd", &subject]).current_dir(tree).status();
        if let Err(e) = git(tree, &["add", "-A"]).and_then(|_| git(tree, &["commit", "-m", &subject])) {
            return Some(format!("The changes are still uncommitted on the computer: {e}"));
        }
    }
    let upstream = format!("origin/{branch}");
    let ahead = match git(tree, &["rev-list", "--count", &format!("{upstream}..HEAD")]) {
        Ok(n) => n.parse::<u32>().unwrap_or(0),
        // No remote branch yet: anything on it beyond the default branch counts.
        Err(_) => git(tree, &["rev-list", "--count", "HEAD", "--not", "--remotes=origin"])
            .ok()
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(0),
    };
    if ahead == 0 {
        return None;
    }
    let refspec = format!("HEAD:refs/heads/{branch}");
    let pushed = Command::new("git")
        .args(push_credential::git_config_args(bin))
        .args(["push", "-u", "origin", &refspec])
        .current_dir(tree)
        .output();
    match pushed {
        Ok(o) if o.status.success() => Some(format!("Pushed {ahead} commit(s) to `{branch}`.")),
        Ok(o) => Some(format!(
            "The work is committed on the computer but the push to `{branch}` was refused: {}",
            last_line(&String::from_utf8_lossy(&o.stderr)).unwrap_or_default()
        )),
        Err(e) => Some(format!("The work is committed on the computer but couldn't be pushed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(branch: Option<&str>) -> Chat {
        serde_json::from_value(serde_json::json!({
            "workspace": "ws_01HX/odd name",
            "workspace_id": "0b7c1f2e-9a4d-4c55-8e3a-1f2d3c4b5a69",
            "repo": "acme/app",
            "default_branch": "main",
            "branch": branch,
            "engine": "claude",
            "prompt": {"message_id": "m", "text": "t", "author_id": "u"}
        }))
        .unwrap()
    }

    #[test]
    fn a_turn_acts_as_the_member_it_runs_as() {
        let src = include_str!("runner_chat_turn.rs");
        let run = src.split("pub fn run(").nth(1).unwrap().split("fn turn(").next().unwrap();
        assert!(run.contains("Some(m) if m == chat.prompt.runs_as() => {}"));
        assert!(!run.contains("chat.prompt.author_id"));
    }

    #[test]
    fn a_failed_sign_in_names_whose_it_was() {
        let own = chat(None);
        assert_eq!(whose_sign_in(&own), "Your Claude sign-in");
        let mut teammate = chat(None);
        teammate.prompt.runs_as = Some("starter".into());
        assert_eq!(whose_sign_in(&teammate), "The Claude sign-in of whoever started this workspace");
    }

    #[test]
    fn a_workspace_never_works_on_the_default_branch() {
        assert_eq!(branch_for(&chat(Some("main"))), "aura/ws_01HX-odd-name");
        assert_eq!(branch_for(&chat(None)), "aura/ws_01HX-odd-name");
        assert_eq!(branch_for(&chat(Some("feat/login"))), "feat/login");
        assert_eq!(branch_for(&chat(Some("bad..name"))), "aura/ws_01HX-odd-name");
    }

    fn picked(model: Option<&str>) -> Chat {
        let mut c = chat(None);
        c.prompt.model = model.map(str::to_string);
        c
    }

    #[test]
    fn the_turn_runs_on_the_model_the_sender_picked() {
        assert_eq!(model_of(&picked(Some("claude-opus-5-5"))), Some("claude-opus-5-5"));
        assert_eq!(model_of(&picked(Some(" sonnet "))), Some("sonnet"));
        assert_eq!(model_of(&picked(Some("claude-fable-5-1[1m]"))), Some("claude-fable-5-1[1m]"));
    }

    #[test]
    fn no_pick_or_the_agents_default_leaves_claude_on_its_own() {
        assert_eq!(model_of(&picked(None)), None);
        assert_eq!(model_of(&picked(Some(""))), None);
        assert_eq!(model_of(&picked(Some("claude"))), None);
        assert_eq!(model_of(&picked(Some("default"))), None);
    }

    #[test]
    fn a_model_that_could_read_as_a_flag_never_reaches_the_command_line() {
        assert_eq!(model_of(&picked(Some("--dangerously-skip-permissions"))), None);
        assert_eq!(model_of(&picked(Some("-p"))), None);
        assert_eq!(model_of(&picked(Some("opus --resume x"))), None);
        assert_eq!(model_of(&picked(Some(&"a".repeat(81)))), None);
    }

    #[test]
    fn a_workspace_s_own_branch_is_its_whole_id() {
        let mut c = chat(None);
        c.workspace = "ed17c45f-398f-4151-a410-5a1e0c9d7b21".into();
        assert_eq!(branch_for(&c), "aura/ed17c45f-398f-4151-a410-5a1e0c9d7b21");
        c.workspace = format!("{}-{}", "a".repeat(BRANCH_ID_LIMIT - 1), "tail");
        let b = branch_for(&c);
        assert!(!b.ends_with('-'), "{b}");
        assert_eq!(b, format!("aura/{}", "a".repeat(BRANCH_ID_LIMIT - 1)));
    }

    /// A git command in `dir` that must work, for building fixtures.
    fn run_git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=master"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A project whose only branch is `master`, and a clone of it.
    fn cloned_master_project() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        run_git(&origin, &["init", "-q"]);
        run_git(&origin, &["commit", "-q", "--allow-empty", "-m", "first"]);
        run_git(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), "copy"]);
        let copy = tmp.path().join("copy");
        (tmp, copy)
    }

    #[test]
    fn a_project_on_master_starts_from_master_whatever_the_cloud_says() {
        let (_tmp, copy) = cloned_master_project();
        assert_eq!(default_branch(&copy, "main"), "master");
        // A copy that lost track of the remote's default still finds it.
        run_git(&copy, &["remote", "set-head", "origin", "-d"]);
        assert_eq!(default_branch(&copy, "main"), "master");
        // And one the cloud named right is kept.
        assert_eq!(default_branch(&copy, "master"), "master");
    }

    #[test]
    fn a_workspace_on_a_master_project_gets_its_own_branch() {
        let (tmp, copy) = cloned_master_project();
        let mut c = chat(None);
        c.default_branch = default_branch(&copy, "main");
        let branch = branch_for(&c);
        let tree = worktree(&copy, tmp.path(), &c, &branch).unwrap();
        assert_eq!(current_branch(&tree).as_deref(), Some(branch.as_str()));
        // Asking for the default branch by name still never works on it.
        c.branch = Some("master".into());
        assert_eq!(branch_for(&c), "aura/ws_01HX-odd-name");
    }

    #[test]
    fn an_old_copy_is_said_first_with_its_commit() {
        let n = stale_note("acme/app", "the network was down", "aura/ws-1", Some("1a2b3c4 “add login”"));
        assert!(n.starts_with("Heads up: this computer couldn't fetch the latest acme/app (the network was down)"), "{n}");
        assert!(n.ends_with("`aura/ws-1` at 1a2b3c4 “add login”."), "{n}");
        assert!(stale_note("a/b", "x", "main", None).ends_with("— `main`."));
    }

    #[test]
    fn a_turn_reports_where_its_work_is_even_when_it_fails() {
        let src = include_str!("runner_chat_turn.rs");
        let body = src.split("fn turn(").nth(1).unwrap().split("pub(crate) fn stale_note(").next().unwrap();
        let at = body.find("at.folder = Some(").unwrap();
        assert!(at < body.find("agent_env::fetch_chat(").unwrap(), "the folder is known before the sign-in can fail");
        assert!(body.contains("current_branch(&tree).unwrap_or(planned)"));
    }

    #[test]
    fn a_slug_is_one_safe_segment() {
        assert_eq!(slug("../../etc"), "etc");
        assert_eq!(slug("///"), "chat");
        assert!(!slug("a/b c").contains('/'));
    }

    #[test]
    fn claude_s_json_is_the_answer_and_its_failure_is_said() {
        let ok = r#"{"type":"result","is_error":false,"result":"Done — added the button.","session_id":"s-1"}"#;
        assert_eq!(said_of(true, ok, "").unwrap(), Said { text: "Done — added the button.".into(), session: Some("s-1".into()) });
        let bad = r#"{"type":"result","is_error":true,"result":"Invalid API key"}"#;
        assert!(said_of(true, bad, "").unwrap_err().contains("Invalid API key"));
        assert!(said_of(false, "", "Error: No conversation found with session ID x").unwrap_err().contains("No conversation found"));
    }

    #[test]
    fn a_failed_clone_is_answered_with_its_reason() {
        assert_eq!(
            cannot_clone("MHASK/Lumi", Some("the Aura GitHub App isn't installed on MHASK/Lumi".into())),
            "Couldn't get MHASK/Lumi onto this computer: the Aura GitHub App isn't installed on MHASK/Lumi"
        );
        assert!(cannot_clone("a/b", None).ends_with("Check the project is in the organization's GitHub install."));
    }

    #[test]
    fn a_subject_is_the_prompt_s_first_line_kept_short() {
        assert_eq!(subject("\n  add a login page\nwith google"), "add a login page");
        assert_eq!(subject(&"x".repeat(200)).chars().count(), SUBJECT_LIMIT);
    }

    #[test]
    fn the_prompt_never_goes_on_the_command_line() {
        let src = include_str!("runner_chat_turn.rs");
        let body = src.split("fn claude_once(").nth(1).unwrap().split("fn said_of(").next().unwrap();
        assert!(body.contains("stdin.write_all(chat.prompt.text"));
        assert!(!body.contains("arg(&chat.prompt.text"));
        assert!(!body.contains("args([&chat.prompt.text"));
    }
}
