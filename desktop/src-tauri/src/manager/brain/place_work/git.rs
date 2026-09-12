//! Every git *question* about a workspace at a place: what changed, the
//! diff of one file, the branches, where the branch stands, what a commit
//! did. Nothing here moves anything.
//!
//! Twins of `git_status_v2`, `git_diff`, `git_diff_at_commit`,
//! `git_diff_base`, `git_diff_stats_per_file`, `git_branch`, `git_branches`,
//! `git_branches_rich`, `git_ahead_behind`, `git_show_commit`,
//! `git_show_head` and `git_remote_origin`. Each sends the same git line its
//! twin runs — `--no-color`, `-z`, the same `--format` — and reads the answer
//! with the same parser in `crate::git_parse`, so the two arms cannot drift
//! apart on what a row means.

use crate::cloudbox::script::quote;
use crate::git_parse::branches::{
    parse_branches, parse_branches_rich, parse_current_branch, GitBranchInfo, GitBranchRich,
    BRANCH_FORMAT, BRANCH_RICH_FORMAT, FOR_EACH_REF_ARGS,
};
use crate::git_parse::graph::{parse_graph, parse_remotes, GraphCommit, LOG_ARGS, LOG_FORMAT};
use crate::git_parse::stats::{parse_left_right_count, parse_numstat, AheadBehind, FileDiffStat};
use crate::git_parse::status::{parse_porcelain_z, StatusEntry};

use super::paths::refname_ok;
use super::{split_at_fence, Place, Work, PRINT_FENCE};

/// The fork point of a linked worktree, as a sh function: the commit where
/// this checkout's branch left the primary checkout's. The local
/// `worktree_fork_base` reads `git worktree list --porcelain` and takes the
/// first record that is not this checkout; the first record is the primary,
/// so on a linked worktree that is the same answer. On the primary itself
/// there is no base, and the caller falls back to `HEAD` — as locally.
const FORK_BASE: &str = "fork_base() { \
    main=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); \
    here=$(git rev-parse --show-toplevel 2>/dev/null); \
    [ -n \"$main\" ] && [ \"$main\" != \"$here\" ] || return 1; \
    ref=$(git -C \"$main\" symbolic-ref -q HEAD 2>/dev/null || git -C \"$main\" rev-parse HEAD 2>/dev/null); \
    [ -n \"$ref\" ] || return 1; \
    git merge-base HEAD \"$ref\" 2>/dev/null; }";

/// `git diff <base> -- file` when it says something, else `git diff HEAD --
/// file`, else — for a file git has never seen — the whole file as an add
/// via `--no-index`. The `--quiet` probes are what let one script make the
/// same three-way choice the local twin makes with three process spawns.
/// A `git diff HEAD` that fails (no HEAD yet) is an empty diff, as locally.
fn diff_script(rel: &str, since_base: bool) -> String {
    let f = quote(rel);
    let base_arm = if since_base {
        format!(
            "{FORK_BASE}; if base=$(fork_base) && [ -n \"$base\" ]; then \
             git diff --quiet \"$base\" -- {f} 2>/dev/null; \
             if [ $? -eq 1 ]; then git diff \"$base\" --no-color -- {f}; exit 0; fi; fi; "
        )
    } else {
        String::new()
    };
    format!(
        "{base_arm}git diff --quiet HEAD -- {f} 2>/dev/null; rc=$?; \
         if [ $rc -eq 1 ]; then git diff HEAD --no-color -- {f}; exit 0; fi; \
         if [ $rc -ne 0 ]; then exit 0; fi; \
         {untracked}",
        untracked = untracked_add_arm(&f)
    )
}

/// A brand-new file is invisible to `git diff`; show it whole as an add.
/// `--no-index` exits 1 to say "different", which is the expected answer.
fn untracked_add_arm(quoted: &str) -> String {
    format!(
        "if [ -n \"$(git ls-files --others --exclude-standard -- {quoted})\" ]; then \
         git diff --no-color --no-index -- /dev/null {quoted}; fi; exit 0"
    )
}

/// One file's net change from a baseline to the live tree, with the same
/// add-diff fallback for a file the session created.
fn diff_base_script(base: &str, rel: &str) -> String {
    let f = quote(rel);
    let b = quote(base);
    format!(
        "git diff --quiet {b} -- {f} 2>/dev/null; \
         if [ $? -eq 1 ]; then git diff {b} --no-color -- {f}; exit 0; fi; \
         {}",
        untracked_add_arm(&f)
    )
}

/// The patch one commit applied to one file, no header.
fn diff_at_commit_script(sha: &str, rel: &str) -> String {
    format!("git show {} --no-color --format=format: -- {}", quote(sha), quote(rel))
}

/// `--numstat` vs the fork base when asked and it resolves; else vs HEAD,
/// then — after the fence — every untracked file with its line count, which
/// the local twin reads off this disk and the box has to count itself. The
/// 5MB ceiling is the local one: a stray binary is `0`, not a stall.
fn stats_script(since_base: bool) -> String {
    let base_arm = if since_base {
        format!(
            "{FORK_BASE}; if base=$(fork_base) && [ -n \"$base\" ]; then \
             git diff \"$base\" --numstat; exit 0; fi; "
        )
    } else {
        String::new()
    };
    format!(
        "{base_arm}git diff HEAD --numstat 2>/dev/null; {PRINT_FENCE}; \
         git ls-files --others --exclude-standard | while IFS= read -r f; do \
         if [ -f \"$f\" ] && [ \"$(wc -c < \"$f\")\" -le 5242880 ]; then n=$(wc -l < \"$f\"); else n=0; fi; \
         printf '%s\\t%s\\n' \"$n\" \"$f\"; done; exit 0"
    )
}

/// The branch, whether it has an upstream, and if so the two counts — three
/// lines, one trip. The probe's exit is the answer "no upstream"; a count
/// that fails is an error, never a zero.
const AHEAD_BEHIND: &str = "git rev-parse --abbrev-ref HEAD 2>/dev/null; \
    if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then \
    printf 'up\\n'; git rev-list --left-right --count '@{u}...HEAD'; else printf 'none\\n'; fi";

fn for_each_ref_script(format: &str) -> String {
    format!(
        "git for-each-ref {} --format {} {} {}",
        FOR_EACH_REF_ARGS[0],
        quote(format),
        FOR_EACH_REF_ARGS[1],
        FOR_EACH_REF_ARGS[2]
    )
}

/// Staged and unstaged rows for the Changes list.
#[tauri::command]
pub async fn place_git_status_v2(machine_id: String, root: String, remote_root: Option<String>) -> Vec<StatusEntry> {
    let Ok(w) = Place::at_machine(&machine_id).and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref())) else {
        return Vec::new();
    };
    match w.ask("git status --porcelain=v1 -z").await {
        Ok(out) if out.ok() => parse_porcelain_z(&out.stdout),
        _ => Vec::new(),
    }
}

/// One file's patch against HEAD — or against the worktree's fork base when
/// asked. Empty, never an error, when git has nothing to say.
#[tauri::command]
pub async fn place_git_diff(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    file: String,
    since_base: Option<bool>,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let rel = w.rel(&file)?;
    let out = w.ask(&diff_script(&rel, since_base == Some(true))).await?;
    Ok(if out.ok() { out.stdout } else { String::new() })
}

/// The patch one commit applied to one file.
#[tauri::command]
pub async fn place_git_diff_at_commit(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    sha: String,
    file: String,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    refname_ok(&sha)?;
    let rel = w.rel(&file)?;
    let out = w.ask(&diff_at_commit_script(sha.trim(), &rel)).await?;
    Ok(if out.ok() { out.stdout } else { String::new() })
}

/// One file's net change from a baseline commit to the live tree.
#[tauri::command]
pub async fn place_git_diff_base(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    base: String,
    file: String,
) -> Result<String, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    refname_ok(&base)?;
    let rel = w.rel(&file)?;
    let out = w.ask(&diff_base_script(base.trim(), &rel)).await?;
    Ok(if out.ok() { out.stdout } else { String::new() })
}

/// `+12 -3` per changed file, untracked files counted as pure additions.
#[tauri::command]
pub async fn place_git_diff_stats_per_file(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    since_base: Option<bool>,
) -> Result<Vec<FileDiffStat>, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.ask(&stats_script(since_base == Some(true))).await?;
    if !out.ok() {
        return Err(super::failed(&out, "git couldn't count the changes"));
    }
    let (numstat, untracked) = split_at_fence(&out.stdout);
    let mut rows = parse_numstat(numstat);
    for line in untracked.lines() {
        let Some((n, path)) = line.split_once('\t') else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        rows.push(FileDiffStat {
            path: path.to_string(),
            additions: n.trim().parse().unwrap_or(0),
            deletions: 0,
        });
    }
    Ok(rows)
}

/// The branch checked out over there. Empty when it isn't a repo.
#[tauri::command]
pub async fn place_git_branch(machine_id: String, root: String, remote_root: Option<String>) -> String {
    let Ok(w) = Place::at_machine(&machine_id).and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref())) else {
        return String::new();
    };
    match w.ask("git rev-parse --abbrev-ref HEAD").await {
        Ok(out) if out.ok() => out.stdout.trim().to_string(),
        _ => String::new(),
    }
}

/// Local + remote-tracking branches, newest commit first.
#[tauri::command]
pub async fn place_git_branches(machine_id: String, root: String, remote_root: Option<String>) -> Vec<GitBranchInfo> {
    let Ok(w) = Place::at_machine(&machine_id).and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref())) else {
        return Vec::new();
    };
    match w.ask(&for_each_ref_script(BRANCH_FORMAT)).await {
        Ok(out) if out.ok() => parse_branches(&out.stdout),
        _ => Vec::new(),
    }
}

/// The same list with author, age and counts, for the Cmd-K switcher.
#[tauri::command]
pub async fn place_git_branches_rich(machine_id: String, root: String, remote_root: Option<String>) -> Vec<GitBranchRich> {
    let Ok(w) = Place::at_machine(&machine_id).and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref())) else {
        return Vec::new();
    };
    match w.ask(&for_each_ref_script(BRANCH_RICH_FORMAT)).await {
        Ok(out) if out.ok() => parse_branches_rich(&out.stdout),
        _ => Vec::new(),
    }
}

/// Where the branch stands against its upstream. A missing upstream is an
/// answer; a count that couldn't be taken is an error the UI shows as
/// "couldn't check", never as "in sync".
#[tauri::command]
pub async fn place_git_ahead_behind(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
) -> Result<AheadBehind, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.ask(AHEAD_BEHIND).await?;
    if !out.ok() {
        let why = out.stderr.trim();
        return Err(if why.is_empty() {
            "git couldn't count this branch against its upstream".to_string()
        } else {
            why.lines().next().unwrap_or(why).to_string()
        });
    }
    let mut lines = out.stdout.lines();
    let branch = parse_current_branch(lines.next().unwrap_or(""));
    match lines.next().map(str::trim) {
        Some("up") => {
            let (behind, ahead) = parse_left_right_count(lines.next().unwrap_or(""))?;
            Ok(AheadBehind { ahead, behind, has_upstream: true, branch })
        }
        _ => Ok(AheadBehind { ahead: 0, behind: 0, has_upstream: false, branch }),
    }
}

/// `git show --stat -p` for one commit, for the History sidebar.
#[tauri::command]
pub async fn place_git_show_commit(machine_id: String, root: String, remote_root: Option<String>, sha: String) -> String {
    let Ok(w) = Place::at_machine(&machine_id).and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref())) else {
        return String::new();
    };
    if refname_ok(&sha).is_err() {
        return String::new();
    }
    match w.ask(&format!("git show --no-color --stat -p {}", quote(sha.trim()))).await {
        Ok(out) if out.ok() => out.stdout,
        Ok(out) => out.stderr,
        Err(_) => String::new(),
    }
}

/// The file as it is in HEAD. Empty when untracked or there is no HEAD.
#[tauri::command]
pub async fn place_git_show_head(machine_id: String, root: String, remote_root: Option<String>, file: String) -> String {
    let Ok(w) = Place::at_machine(&machine_id).and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref())) else {
        return String::new();
    };
    let Ok(rel) = w.rel(&file) else {
        return String::new();
    };
    match w.ask(&format!("git show {}", quote(&format!("HEAD:{rel}")))).await {
        Ok(out) if out.ok() => out.stdout,
        _ => String::new(),
    }
}

/// The `origin` URL. Empty when there is none.
#[tauri::command]
pub async fn place_git_remote_origin(machine_id: String, root: String, remote_root: Option<String>) -> String {
    let Ok(w) = Place::at_machine(&machine_id).and_then(|p| Work::at_worktree(p, &root, remote_root.as_deref())) else {
        return String::new();
    };
    match w.ask("git remote get-url origin").await {
        Ok(out) if out.ok() => out.stdout.trim().to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_asks_head_then_falls_back_to_a_whole_file_add() {
        let s = diff_script("src/a b.rs", false);
        assert!(!s.contains("fork_base"));
        assert!(s.starts_with("git diff --quiet HEAD -- 'src/a b.rs' 2>/dev/null; rc=$?;"));
        assert!(s.contains("git diff HEAD --no-color -- 'src/a b.rs'; exit 0;"));
        assert!(s.contains("git ls-files --others --exclude-standard -- 'src/a b.rs'"));
        assert!(s.contains("git diff --no-color --no-index -- /dev/null 'src/a b.rs'"));
    }

    #[test]
    fn since_base_tries_the_fork_point_first() {
        let s = diff_script("a.rs", true);
        assert!(s.starts_with("fork_base() {"));
        let base = s.find("git diff \"$base\" --no-color -- 'a.rs'").unwrap();
        let head = s.find("git diff HEAD --no-color -- 'a.rs'").unwrap();
        assert!(base < head);
    }

    #[test]
    fn a_baseline_diff_and_a_commit_diff_send_the_lines_the_laptop_does() {
        assert!(diff_base_script("abc123", "a.rs")
            .starts_with("git diff --quiet 'abc123' -- 'a.rs' 2>/dev/null; if [ $? -eq 1 ]; then git diff 'abc123' --no-color -- 'a.rs'; exit 0; fi;"));
        assert_eq!(
            diff_at_commit_script("abc123", "src/a.rs"),
            "git show 'abc123' --no-color --format=format: -- 'src/a.rs'"
        );
    }

    #[test]
    fn stats_count_untracked_files_on_the_box_after_the_fence() {
        let s = stats_script(false);
        assert!(s.starts_with("git diff HEAD --numstat 2>/dev/null; printf '\\036\\n'; git ls-files --others --exclude-standard | while"));
        assert!(s.contains("-le 5242880"));
        assert!(stats_script(true).starts_with("fork_base() {"));
    }

    #[test]
    fn the_branch_listings_use_the_shared_formats() {
        assert_eq!(
            for_each_ref_script(BRANCH_FORMAT),
            format!(
                "git for-each-ref --sort=-committerdate --format '{BRANCH_FORMAT}' refs/heads refs/remotes"
            )
        );
        assert!(for_each_ref_script(BRANCH_RICH_FORMAT).contains('\x1f'));
    }

    #[test]
    fn ahead_behind_is_three_lines_with_the_probe_in_the_middle() {
        assert!(AHEAD_BEHIND.starts_with("git rev-parse --abbrev-ref HEAD"));
        assert!(AHEAD_BEHIND.contains("printf 'up\\n'; git rev-list --left-right --count '@{u}...HEAD'"));
        assert!(AHEAD_BEHIND.ends_with("printf 'none\\n'; fi"));
    }
}

/// The commit graph the History rail draws — the same `git log --all` the
/// local `git_commit_graph` runs, read by the same `git_parse::graph`. The
/// remote names come first, fenced, so one trip classes `origin/x` as
/// remote. A `git log` that fails (no commits yet, not a checkout) is an
/// empty graph, as locally: the rail shows its empty state, and the
/// readiness probe is where a folder that is not a checkout gets its
/// sentence.
#[tauri::command]
pub async fn place_git_commit_graph(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    limit: u32,
) -> Result<Vec<GraphCommit>, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let n = limit.clamp(1, 1000);
    let script = format!(
        "git remote 2>/dev/null; {PRINT_FENCE}; git {} -n{n} --pretty=format:{} 2>/dev/null; exit 0",
        LOG_ARGS.join(" "),
        quote(LOG_FORMAT)
    );
    let out = w.ask(&script).await?;
    let (remotes, log) = split_at_fence(&out.stdout);
    Ok(parse_graph(log, &parse_remotes(remotes)))
}
