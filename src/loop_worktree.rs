//! Git-worktree lifecycle helper for running loop tasks in parallel.
//!
//! A [`LoopWorktree`] is a throwaway git worktree dedicated to a single loop
//! task, checked out on its own branch. Paths are sibling directories of the
//! repo (`<parent>/<repo-name>-aura-loop-<name>`) and branches are named
//! `loop/<name>`, where `<name>` is a ref-safe slug of what the task IS — its
//! title — so a row of crew worktrees reads `fix-the-login-bug`,
//! `rate-limit-retries` rather than a column of uuid fragments. A task with no
//! usable title falls back to a slug of its id. Merge-back is a plain
//! `git merge --no-ff` — when the aura AST
//! merge-driver is configured it resolves clean cases automatically. Discard
//! is best-effort: it removes the worktree and deletes the branch, ignoring a
//! `branch -D` failure on an already-merged branch.

use std::path::{Path, PathBuf};
use std::process::Command;

use aura_loop::worktree_name;

/// A git worktree dedicated to one loop task, on its own branch.
pub struct LoopWorktree {
    /// Sibling dir: `<parent>/<repo-name>-aura-loop-<name>`.
    pub path: PathBuf,
    /// Branch name: `loop/<name>`.
    pub branch: String,
}

/// Create a fresh worktree off `base` (default: current HEAD of `repo_root`)
/// for a task, on a new branch `loop/<name>`.
///
/// The name comes from `title` — what the task is about — because that is the
/// only thing about a crew worktree anyone can read at a glance; `task_id` is
/// the fallback for a task whose title says nothing (empty, or nothing that
/// survives slugging). Two tasks that happen to share a title get `-2`, `-3`
/// rather than colliding, so naming after the work never costs isolation.
///
/// Returns an `Err` if the target path exists anyway (something claimed it
/// mid-flight) so the caller can fall back to sequential execution. Uses
/// `git -C <repo_root> worktree add -b <branch> <path> [<base>]`.
pub fn create(
    repo_root: &Path,
    task_id: &str,
    title: Option<&str>,
    base: Option<&str>,
) -> Result<LoopWorktree, String> {
    let safe = name_for(repo_root, task_id, title);
    let (path, branch) = paths_for(repo_root, &safe);

    if path.exists() {
        return Err(format!(
            "loop worktree path already exists: {} (skipping parallel run for task '{}')",
            path.display(),
            task_id
        ));
    }

    let repo_str = repo_root.to_string_lossy().into_owned();
    let path_str = path.to_string_lossy().into_owned();

    let mut args: Vec<String> = vec![
        "-C".to_string(),
        repo_str,
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        branch.clone(),
        path_str,
    ];
    if let Some(b) = base {
        args.push(b.to_string());
    }

    let out = Command::new("git")
        .args(&args)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    Ok(LoopWorktree { path, branch })
}

/// Merge the worktree's branch back into the current branch of `repo_root` with
/// a no-fast-forward merge: `git -C <repo_root> merge --no-ff --no-edit <branch>`.
///
/// The main repo's working tree is often *dirty* while the loop runs — live
/// `.aura/` churn, a half-edited file, the user mid-keystroke. A plain `git
/// merge` refuses to start in that state ("Your local changes … would be
/// overwritten by merge"), which would fail a lane that actually produced good
/// work. So when (and only when) the merge is blocked by a dirty tree, we park
/// the uncommitted changes on the stash, merge onto the now-clean tree, then
/// restore them. A real content conflict (overlapping edits in the merge
/// itself) still returns `Err` so the caller drops the lane — the aura AST
/// merge-driver, if configured, resolves the clean cases automatically.
pub fn merge_back(repo_root: &Path, wt: &LoopWorktree) -> Result<(), String> {
    match run_merge(repo_root, &wt.branch) {
        Ok(()) => Ok(()),
        Err(e) if blocked_by_dirty_tree(&e) => {
            // Park the user's uncommitted work (tracked + untracked), merge onto
            // the clean tree, then pop it back. A pop conflict leaves the parked
            // changes on the stash for the user to recover by hand — the merge
            // itself has already landed.
            let parked = stash_park(repo_root)?;
            let merged = run_merge(repo_root, &wt.branch);
            if let Some(parked) = parked {
                let _ = stash_unpark(repo_root, &parked);
            }
            merged
        }
        Err(e) => Err(e),
    }
}

/// One `git merge --no-ff --no-edit <branch>` in `repo_root`. On failure returns
/// the combined message — git prints the "would be overwritten" hint to stdout,
/// real conflicts to stderr, so we surface whichever is non-empty.
fn run_merge(repo_root: &Path, branch: &str) -> Result<(), String> {
    let repo_str = repo_root.to_string_lossy().into_owned();
    let out = Command::new("git")
        .args(["-C", &repo_str, "merge", "--no-ff", "--no-edit", branch])
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(msg.to_string());
    }
    Ok(())
}

/// True when git refused the merge because the main working tree is dirty (not
/// because of a real content conflict). These are the messages git emits when
/// uncommitted local changes overlap the incoming merge.
fn blocked_by_dirty_tree(e: &str) -> bool {
    let e = e.to_lowercase();
    e.contains("would be overwritten by merge")
        || e.contains("would be overwritten by checkout")
        || e.contains("please commit your changes or stash them")
        || e.contains("your local changes to the following files")
}

/// The user's uncommitted work, parked on the stash, identified by what it
/// is rather than by where it currently sits in the stack.
#[derive(Debug, Clone, PartialEq)]
pub struct Parked {
    /// The commit the stash entry points at — stable for the life of the
    /// entry, unlike its position.
    pub sha: String,
    /// The unique message this park was pushed with.
    pub tag: String,
}

/// How `git stash list` is asked to print, so entries can be matched by
/// identity: `stash@{0}<TAB><sha><TAB><subject>`.
const STASH_FORMAT: &str = "--format=%gd%x09%H%x09%gs";

/// Find our own parked entry in a stash listing.
///
/// The stash is **one stack per repository, shared by every worktree and
/// every agent session working in it**. Between parking and restoring,
/// another session can push its own entry on top, and `stash@{0}` then
/// names their work, not ours. So the entry is found by the message this
/// park wrote and confirmed against the commit it pointed at.
fn find_parked(list: &str, tag: &str) -> Option<(String, String)> {
    for line in list.lines() {
        let mut parts = line.split('\t');
        let (Some(name), Some(sha), subject) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if subject.unwrap_or("").contains(tag) {
            return Some((name.to_string(), sha.to_string()));
        }
    }
    None
}

fn stash_list(repo_root: &Path) -> String {
    let repo_str = repo_root.to_string_lossy().into_owned();
    Command::new("git")
        .args(["-C", &repo_str, "stash", "list", STASH_FORMAT])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Stash the main tree's uncommitted changes (tracked + untracked) so the merge
/// has a clean tree to land on. `Ok(None)` when there was nothing to save.
fn stash_park(repo_root: &Path) -> Result<Option<Parked>, String> {
    let repo_str = repo_root.to_string_lossy().into_owned();
    // Unique per park, so the entry can be recognised later even with
    // other sessions' parks stacked above and below it.
    let tag = format!(
        "aura-loop merge-back park {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let out = Command::new("git")
        .args([
            "-C",
            &repo_str,
            "stash",
            "push",
            "--include-untracked",
            "-m",
            &tag,
        ])
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    if String::from_utf8_lossy(&out.stdout).contains("No local changes to save") {
        return Ok(None);
    }
    match find_parked(&stash_list(repo_root), &tag) {
        Some((_, sha)) => Ok(Some(Parked { sha, tag })),
        // Pushed, but not findable afterwards. Returning an error here
        // aborts the merge with the work still safely on the stash; the
        // alternative — carrying on and guessing at an entry later — is
        // how someone else's changes end up in this tree.
        None => Err(format!(
            "parked your uncommitted work on the stash as \"{tag}\" but could not find it again; \
             the merge was not attempted and nothing was lost — restore it with `git stash list`"
        )),
    }
}

/// Restore the parked changes after the merge.
///
/// This applied and dropped `stash@{0}`, which is whatever entry happens to
/// be on top of a stack the whole repository shares — another worktree's
/// session parking work of its own between the merge starting and finishing
/// was enough to hand their changes to this tree and delete their entry.
/// The entry is now found by the message it was pushed with, applied by its
/// own commit, and dropped only after that commit is confirmed still to be
/// the one under that name.
fn stash_unpark(repo_root: &Path, parked: &Parked) -> Result<(), String> {
    let repo_str = repo_root.to_string_lossy().into_owned();
    let out = Command::new("git")
        .args(["-C", &repo_str, "stash", "apply", &parked.sha])
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        // A conflict leaves both the tree and the entry alone; the work is
        // still on the stash under its own name.
        return Err(format!(
            "your parked changes are still on the stash as \"{}\" — {}",
            parked.tag,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // Applied. Drop only if the name still holds the very commit applied.
    if let Some((name, sha)) = find_parked(&stash_list(repo_root), &parked.tag) {
        if sha == parked.sha {
            let _ = Command::new("git")
                .args(["-C", &repo_str, "stash", "drop", &name])
                .output();
        }
    }
    Ok(())
}

/// Tear down the worktree: `git -C <repo_root> worktree remove --force <path>`
/// then `git -C <repo_root> branch -D <branch>`. Best-effort — both are
/// attempted and errors collected. Returns `Err` only if the worktree removal
/// genuinely failed; a `branch -D` failure (e.g. on an already-merged branch)
/// is logged into the error context but does not by itself fail the call.
/// Never panics.
pub fn discard(repo_root: &Path, wt: &LoopWorktree) -> Result<(), String> {
    let repo_str = repo_root.to_string_lossy().into_owned();
    let path_str = wt.path.to_string_lossy().into_owned();

    // 1. Remove the worktree — this is the one that must succeed.
    let remove_err: Option<String> = match Command::new("git")
        .args(["-C", &repo_str, "worktree", "remove", "--force", &path_str])
        .output()
    {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(e) => Some(format!("spawn git: {e}")),
    };

    // 2. Delete the branch — best-effort, failure is tolerated (already merged,
    //    or never created). We don't surface this as a hard error on its own.
    let _ = Command::new("git")
        .args(["-C", &repo_str, "branch", "-D", &wt.branch])
        .output();

    match remove_err {
        Some(e) => Err(format!(
            "failed to remove loop worktree {}: {}",
            wt.path.display(),
            e
        )),
        None => Ok(()),
    }
}

/// PURE, unit-testable: turn an arbitrary task id/title into a
/// filesystem-and-git-ref-safe slug. The result is lowercase, contains only
/// `[a-z0-9-]`, collapses repeated separators, is trimmed to ~32 chars, and is
/// never empty (a deterministic hash suffix is appended only when the input
/// strips to nothing, guaranteeing a stable non-empty slug).
fn safe_id(raw: &str) -> String {
    // Lowercase, map every non-[a-z0-9] char to a single '-'.
    let mut slug = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            // Collapse any run of separators / unicode into a single dash.
            slug.push('-');
            last_dash = true;
        }
    }

    // Trim to ~32 chars, then strip leading/trailing dashes so we never produce
    // a path-traversing or ref-illegal token (no leading '-', no trailing '-').
    if slug.len() > 32 {
        slug.truncate(32);
    }
    let trimmed = slug.trim_matches('-');

    if trimmed.is_empty() {
        // Everything stripped away (e.g. pure-unicode or pure-punctuation id):
        // fall back to a deterministic 8-char hash of the original input so the
        // slug is non-empty and stable across runs (no rng, no clock).
        format!("id-{}", short_hash(raw))
    } else {
        trimmed.to_string()
    }
}

/// The worktree name for a task: its title when that says something, else a
/// slug of its id — then stepped past anything already on disk (`-2`, `-3`).
fn name_for(repo_root: &Path, task_id: &str, title: Option<&str>) -> String {
    let base = title
        .and_then(worktree_name::from_label)
        .unwrap_or_else(|| safe_id(task_id));
    worktree_name::unique(&base, |candidate| paths_for(repo_root, candidate).0.exists())
}

/// PURE, unit-testable: compute `(worktree_path, branch)` for a `repo_root` and
/// an already-sanitized `safe` id, matching the sibling-dir scheme
/// `<parent>/<repo-name>-aura-loop-<safe>` with branch `loop/<safe>`. Factored
/// out of [`create`] so it can be tested without touching git.
fn paths_for(repo_root: &Path, safe: &str) -> (PathBuf, String) {
    let parent = repo_root
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let repo_name = repo_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo");
    let path = parent.join(format!("{repo_name}-aura-loop-{safe}"));
    let branch = format!("loop/{safe}");
    (path, branch)
}

/// Deterministic 8-hex-char hash (FNV-1a) of `raw`. Used only as a non-empty
/// fallback in [`safe_id`]; not cryptographic, no rng, no clock.
fn short_hash(raw: &str) -> String {
    // 64-bit FNV-1a.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in raw.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:08x}", (hash as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stash listing in the format `stash_list` asks for.
    fn listing(entries: &[(&str, &str, &str)]) -> String {
        entries
            .iter()
            .map(|(name, sha, subject)| format!("{name}\t{sha}\t{subject}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn our_park_is_found_under_someone_elses_entries() {
        // The stash is one stack for the whole repository. Another
        // worktree's session parking its own work puts its entry on top,
        // and `stash@{0}` is then their changes — which is what the old
        // `stash pop` took.
        let list = listing(&[
            ("stash@{0}", "aaa111", "On main: someone else's wip"),
            ("stash@{1}", "bbb222", "aura-loop merge-back park 1789109999"),
            ("stash@{2}", "ccc333", "On main: older unrelated park"),
        ]);
        assert_eq!(
            find_parked(&list, "aura-loop merge-back park 1789109999"),
            Some(("stash@{1}".to_string(), "bbb222".to_string()))
        );
    }

    #[test]
    fn two_parks_from_different_runs_do_not_claim_each_other() {
        let list = listing(&[
            ("stash@{0}", "aaa111", "aura-loop merge-back park 222"),
            ("stash@{1}", "bbb222", "aura-loop merge-back park 111"),
        ]);
        assert_eq!(
            find_parked(&list, "aura-loop merge-back park 111").map(|(n, _)| n),
            Some("stash@{1}".to_string())
        );
    }

    #[test]
    fn a_park_that_is_gone_is_not_mistaken_for_the_nearest_entry() {
        // Better to restore nothing and say so than to apply a stranger's
        // work into this tree.
        let list = listing(&[("stash@{0}", "aaa111", "On main: someone else's wip")]);
        assert_eq!(find_parked(&list, "aura-loop merge-back park 111"), None);
        assert_eq!(find_parked("", "anything"), None);
    }

    #[test]
    fn a_malformed_listing_line_is_skipped_rather_than_misread() {
        let list = "garbage-with-no-tabs\nstash@{0}\tddd444\taura-loop merge-back park 7";
        assert_eq!(
            find_parked(list, "park 7"),
            Some(("stash@{0}".to_string(), "ddd444".to_string()))
        );
    }

    #[test]
    fn safe_id_uuid() {
        let s = safe_id("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
        // Truncated to 32 chars (the trailing group is cut), then dash-trimmed.
        assert_eq!(s, "3f2504e0-4f89-41d3-9a0c-0305e82c");
        assert!(s.len() <= 32);
        assert!(s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        assert!(!s.starts_with('-') && !s.ends_with('-'));
    }

    #[test]
    fn safe_id_ticket_handle() {
        assert_eq!(safe_id("AURA-203"), "aura-203");
    }

    #[test]
    fn safe_id_title_with_punctuation() {
        // Spaces and punctuation collapse to single dashes; no trailing dash.
        assert_eq!(safe_id("Fix the thing!!"), "fix-the-thing");
    }

    #[test]
    fn safe_id_empty_falls_back_to_nonempty() {
        let s = safe_id("");
        assert!(!s.is_empty(), "empty input must yield a non-empty slug");
        assert!(s.starts_with("id-"));
        // Deterministic across calls.
        assert_eq!(s, safe_id(""));
    }

    #[test]
    fn safe_id_pure_unicode_punct_falls_back() {
        // No ascii-alphanumerics survive — must hit the hash fallback, non-empty.
        let s = safe_id("日本語 — ★★★");
        assert!(!s.is_empty());
        assert!(s.starts_with("id-"));
        assert!(s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        assert!(!s.starts_with("-") && !s.ends_with('-'));
    }

    #[test]
    fn safe_id_unicode_with_ascii_keeps_ascii() {
        // Mixed input keeps the ascii-alphanumeric run, unicode → separator.
        assert_eq!(safe_id("café-99"), "caf-99");
    }

    #[test]
    fn safe_id_collapses_repeats_and_trims() {
        assert_eq!(safe_id("___a   b___"), "a-b");
        assert_eq!(safe_id("--lead-and-trail--"), "lead-and-trail");
    }

    /// A repo root that cannot exist, so `name_for`'s on-disk collision check
    /// always answers "free" and the naming itself is what's under test.
    const NOWHERE: &str = "/this/path/should/not/exist/myrepo";

    #[test]
    fn name_for_uses_the_task_title() {
        assert_eq!(
            name_for(Path::new(NOWHERE), "3f2504e0-4f89-41d3-9a0c-0305e82c3301", Some("Fix the login bug")),
            "fix-the-login-bug"
        );
        // A branch-flow prefix on the title is noise in a worktree name.
        assert_eq!(
            name_for(Path::new(NOWHERE), "t1", Some("feat/worktree-control-plane")),
            "worktree-control-plane"
        );
    }

    #[test]
    fn name_for_falls_back_to_the_id_when_the_title_says_nothing() {
        let id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        // No title at all, an empty one, and one with nothing sluggable in it
        // all land on the id — never on an empty or invented name.
        for title in [None, Some(""), Some("   "), Some("★★★")] {
            assert_eq!(name_for(Path::new(NOWHERE), id, title), safe_id(id));
        }
    }

    #[test]
    fn paths_for_sibling_scheme() {
        let (path, branch) = paths_for(Path::new("/home/dev/myrepo"), "aura-203");
        assert_eq!(path, PathBuf::from("/home/dev/myrepo-aura-loop-aura-203"));
        assert_eq!(branch, "loop/aura-203");
    }

    #[test]
    fn paths_for_repo_at_filesystem_root() {
        // repo_root has no parent → fall back to /tmp, never panic.
        let (path, branch) = paths_for(Path::new("/"), "x9");
        assert_eq!(branch, "loop/x9");
        // file_name() of "/" is None → repo_name falls back to "repo".
        assert_eq!(path, PathBuf::from("/tmp/repo-aura-loop-x9"));
    }

    #[test]
    fn paths_for_relative_repo_root() {
        let (path, branch) = paths_for(Path::new("repo"), "t1");
        // parent of a bare relative name is "" → joined onto "" stays relative.
        assert_eq!(branch, "loop/t1");
        assert_eq!(path, PathBuf::from("repo-aura-loop-t1"));
    }
}
