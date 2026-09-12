//! Every git *act* on a workspace at a place: stage, unstage, commit, push,
//! pull, fetch, discard, switch branch, make one, reset the tree.
//!
//! Twins of `git_stage`, `git_unstage`, `git_commit`, `git_push`,
//! `git_pull`, `git_fetch`, `git_discard`, `git_checkout`,
//! `git_create_branch` and `git_reset_files`. The rule for what comes back
//! is the local one, [`super::outcome`]: `Ok(stdout)` when git exited 0 and
//! `Err(stderr)` otherwise, so an act that did not happen is never shown as
//! one that did.

use crate::cloudbox::script::quote;
use crate::git_parse::status::count_records;

use super::paths::refname_ok;
use super::{outcome, split_at_fence, Place, Work, WIRE, WORK};

/// The local `checkout_args`, as one sh line: a local branch of that name is
/// switched to; a remote-tracking ref becomes a local branch tracking it —
/// unless a local branch of the short name already exists, which is switched
/// to instead; anything else (a tag, a sha) is handed to `git checkout` as
/// it was. `case` carries the two refusals the local code has: an empty
/// short name and the `origin/HEAD` pointer both fall back to plain checkout.
fn checkout_script(branch: &str) -> String {
    let b = quote(branch);
    format!(
        "if git show-ref --verify --quiet {heads}; then git checkout {b}; \
         elif git show-ref --verify --quiet {remotes}; then b={b}; rest=${{b#*/}}; \
         case \"$rest\" in ''|*/HEAD) git checkout {b};; \
         *) if git show-ref --verify --quiet \"refs/heads/$rest\"; then git checkout \"$rest\"; \
         else git checkout -b \"$rest\" --track {b}; fi;; esac; \
         else git checkout {b}; fi",
        heads = quote(&format!("refs/heads/{branch}")),
        remotes = quote(&format!("refs/remotes/{branch}")),
    )
}

/// The same marker and log line the local `git_commit` writes before it
/// commits, so the pre-commit hook on the box finds the intent it looks
/// for. The message the user typed *is* the intent. Best-effort, as
/// locally: a failure to write the marker is left to the hook to report.
fn commit_script(message: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = serde_json::json!({
        "agent_id": "aura-shell-commit",
        "intent": message.trim(),
        "timestamp": now,
    })
    .to_string();
    format!(
        "mkdir -p .aura 2>/dev/null && printf 1 > .aura/.intent_logged && \
         printf '%s\\n' {} >> .aura/intent_log.jsonl; git commit -m {}",
        quote(&line),
        quote(message)
    )
}

/// `git push`, or `-u origin <branch>` the first time — the branch read on
/// the box, where the checkout is.
fn push_script(set_upstream: bool) -> String {
    if set_upstream {
        "b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); \
         if [ -n \"$b\" ] && [ \"$b\" != HEAD ]; then git push -u origin \"$b\"; else git push -u origin; fi"
            .to_string()
    } else {
        "git push".to_string()
    }
}

/// Count what is dirty, then put tracked files back and remove untracked
/// ones — ignored files left alone, as locally. The count comes first so
/// the toast can say what happened; the fence keeps it apart from anything
/// `checkout` or `clean` print.
const RESET_FILES: &str = "git rev-parse --git-dir >/dev/null 2>&1 || \
    { echo \"This folder isn't a git repository.\" >&2; exit 1; }; \
    git status --porcelain -z --untracked-files=all || exit 1; printf '\\036\\n'; \
    git checkout -- . && git clean -fd >/dev/null";

/// `git <verb> [--] <paths…>` with each path re-rooted and quoted.
fn paths_script(w: &Work, lead: &str, paths: &[String]) -> Result<String, String> {
    let mut s = lead.to_string();
    for p in paths {
        s.push(' ');
        s.push_str(&quote(&w.rel(p)?));
    }
    Ok(s)
}

/// Stage paths.
#[tauri::command]
pub async fn place_git_stage(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    paths: Vec<String>,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.run(&paths_script(&w, "git add --", &paths)?, WORK).await?;
    outcome(&out)
}

/// Unstage paths — back to HEAD's index entry.
#[tauri::command]
pub async fn place_git_unstage(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    paths: Vec<String>,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.run(&paths_script(&w, "git reset HEAD --", &paths)?, WORK).await?;
    outcome(&out)
}

/// Discard edits to tracked files. Untracked files are left alone — that
/// is `place_git_reset_files`, and it asks first.
#[tauri::command]
pub async fn place_git_discard(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    paths: Vec<String>,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.run(&paths_script(&w, "git checkout --", &paths)?, WORK).await?;
    outcome(&out)
}

/// Commit what is staged, with the intent marker the hook expects.
#[tauri::command]
pub async fn place_git_commit(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    message: String,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    if message.trim().is_empty() {
        return Err("A commit needs a message.".to_string());
    }
    let out = w.run(&commit_script(&message), WORK).await?;
    if !out.ok() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout.trim().to_string())
}

/// Push, publishing the branch the first time.
#[tauri::command]
pub async fn place_git_push(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    set_upstream: bool,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.run(&push_script(set_upstream), WIRE).await?;
    if !out.ok() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout.trim().to_string())
}

/// Fast-forward pull; a merge is the user's to ask for.
#[tauri::command]
pub async fn place_git_pull(machine_id: String, root: String, remote_root: Option<String>) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.run("git pull --ff-only", WIRE).await?;
    if !out.ok() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout.trim().to_string())
}

/// Refresh remote-tracking refs, touching nothing in the tree.
#[tauri::command]
pub async fn place_git_fetch(machine_id: String, root: String, remote_root: Option<String>) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.run("git fetch --all --prune", WIRE).await?;
    if !out.ok() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout.trim().to_string())
}

/// Switch to a branch, tracking a remote one rather than detaching.
#[tauri::command]
pub async fn place_git_checkout(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    branch: String,
) -> Result<(), String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    refname_ok(&branch)?;
    let out = w.run(&checkout_script(branch.trim()), WORK).await?;
    if out.ok() {
        Ok(())
    } else {
        Err(super::failed(&out, "checkout failed"))
    }
}

/// A new branch from HEAD, switched to.
#[tauri::command]
pub async fn place_git_create_branch(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    name: String,
) -> Result<(), String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    refname_ok(&name)?;
    let out = w.run(&format!("git checkout -b {}", quote(name.trim())), WORK).await?;
    if out.ok() {
        Ok(())
    } else {
        Err(super::failed(&out, "create branch failed"))
    }
}

/// Throw away every uncommitted change; answers with how many entries the
/// tree had, for the toast.
#[tauri::command]
pub async fn place_git_reset_files(machine_id: String, root: String, remote_root: Option<String>) -> Result<u32, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.run(RESET_FILES, WORK).await?;
    if !out.ok() {
        return Err(super::failed(&out, "git reset failed"));
    }
    let (status, _) = split_at_fence(&out.stdout);
    Ok(count_records(status.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_branch_becomes_a_tracking_local_one() {
        let s = checkout_script("origin/feat/x");
        assert!(s.starts_with(
            "if git show-ref --verify --quiet 'refs/heads/origin/feat/x'; then git checkout 'origin/feat/x'; \
             elif git show-ref --verify --quiet 'refs/remotes/origin/feat/x'; then"
        ));
        assert!(s.contains("git checkout -b \"$rest\" --track 'origin/feat/x'"));
        assert!(s.contains("''|*/HEAD) git checkout 'origin/feat/x'"));
        assert!(s.ends_with("else git checkout 'origin/feat/x'; fi"));
    }

    #[test]
    fn a_commit_leaves_the_intent_the_hook_looks_for() {
        let s = commit_script("fix: it's done");
        assert!(s.starts_with("mkdir -p .aura 2>/dev/null && printf 1 > .aura/.intent_logged && printf '%s\\n' '"));
        assert!(s.contains(r#""agent_id":"aura-shell-commit""#));
        assert!(s.contains(">> .aura/intent_log.jsonl; git commit -m 'fix: it'\\''s done'"));
    }

    #[test]
    fn a_first_push_publishes_the_branch_the_box_is_on() {
        assert_eq!(push_script(false), "git push");
        let s = push_script(true);
        assert!(s.starts_with("b=$(git rev-parse --abbrev-ref HEAD"));
        assert!(s.contains("git push -u origin \"$b\""));
    }

    #[test]
    fn a_reset_counts_before_it_cleans() {
        let count = RESET_FILES.find("git status --porcelain -z --untracked-files=all").unwrap();
        let clean = RESET_FILES.find("git clean -fd").unwrap();
        assert!(count < clean);
        assert!(RESET_FILES.contains("printf '\\036\\n'"));
    }
}
