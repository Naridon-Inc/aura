//! `git for-each-ref` listings for the two branch switchers.
//!
//! The format strings live beside their parsers on purpose: the remote arm
//! sends the same `--format` the local arm does, so the bytes that come back
//! are the bytes these functions were tested on.

use serde::Serialize;

/// One branch row for the footer branch switcher.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GitBranchInfo {
    /// Short name: `main`, `feat/x`, or `origin/feat/x` for remotes.
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    /// Short upstream ref (`origin/main`) when the local branch tracks one.
    pub upstream: Option<String>,
    /// Last commit subject — context in the dropdown.
    pub subject: Option<String>,
}

/// A richly-detailed branch row for the Cmd-K branch switcher. One
/// `git for-each-ref` call (NOT N) fills every field so the modal can show
/// per-branch context — author, when it last moved, the subject line, and how
/// far ahead/behind its upstream — without a round-trip per branch.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchRich {
    /// Short name: `main`, `feat/x`, or `origin/feat/x` for remotes.
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    /// Short upstream ref (`origin/main`) when the local branch tracks one.
    pub upstream: Option<String>,
    /// Commits this branch is ahead of its upstream (0 when no upstream).
    pub ahead: u32,
    /// Commits this branch is behind its upstream (0 when no upstream).
    pub behind: u32,
    /// Last-commit author name — who last moved this branch.
    pub author: Option<String>,
    /// Last-commit time, unix seconds — drives the "2h ago" relative label.
    pub committed_at: Option<i64>,
    /// Last commit subject — the one-line "what's on this branch".
    pub subject: Option<String>,
}

/// One for-each-ref call gives every field in a stable, tab-delimited form.
/// `%(HEAD)` marks the current branch with `*`. Full `%(refname)` lets us tell
/// locals (refs/heads) from remotes (refs/remotes) since the short name alone
/// is ambiguous (both can contain slashes).
pub const BRANCH_FORMAT: &str =
    "%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(contents:subject)";

/// A unit-separator (\x1f, "US") between fields survives subjects and author
/// names that themselves contain tabs; `%(upstream:track)` carries the
/// ahead/behind summary so we never shell out per branch.
pub const BRANCH_RICH_FORMAT: &str = "%(refname)\x1f%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(upstream:track)\x1f%(authorname)\x1f%(committerdate:unix)\x1f%(contents:subject)";

/// The arguments both arms hand to `git`, after `for-each-ref`.
pub const FOR_EACH_REF_ARGS: [&str; 3] = ["--sort=-committerdate", "refs/heads", "refs/remotes"];

fn opt(v: &str) -> Option<String> {
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// [`BRANCH_FORMAT`] output → rows. The `origin/HEAD -> origin/main` symbolic
/// pointer is skipped; it isn't a real branch and would show as a duplicate of
/// the default.
pub fn parse_branches(text: &str) -> Vec<GitBranchInfo> {
    let mut branches = Vec::new();
    for line in text.lines() {
        let mut cols = line.split('\t');
        let full = cols.next().unwrap_or("").trim();
        let short = cols.next().unwrap_or("").trim().to_string();
        let head = cols.next().unwrap_or("").trim();
        let upstream = cols.next().unwrap_or("").trim();
        let subject = cols.next().unwrap_or("").trim();
        if short.is_empty() || short.ends_with("/HEAD") {
            continue;
        }
        branches.push(GitBranchInfo {
            is_remote: full.starts_with("refs/remotes/"),
            is_current: head == "*",
            upstream: opt(upstream),
            subject: opt(subject),
            name: short,
        });
    }
    branches
}

/// Parse `%(upstream:track)` — git emits e.g. `[ahead 3, behind 1]`,
/// `[ahead 2]`, `[behind 5]`, `[gone]`, or empty. Returns (ahead, behind).
pub fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// [`BRANCH_RICH_FORMAT`] output → rows, `origin/HEAD` skipped.
pub fn parse_branches_rich(text: &str) -> Vec<GitBranchRich> {
    let mut branches = Vec::new();
    for line in text.lines() {
        let mut cols = line.split('\x1f');
        let full = cols.next().unwrap_or("").trim();
        let short = cols.next().unwrap_or("").trim().to_string();
        let head = cols.next().unwrap_or("").trim();
        let upstream = cols.next().unwrap_or("").trim();
        let track = cols.next().unwrap_or("");
        let author = cols.next().unwrap_or("").trim();
        let committed = cols.next().unwrap_or("").trim();
        let subject = cols.next().unwrap_or("").trim();
        if short.is_empty() || short.ends_with("/HEAD") {
            continue;
        }
        let (ahead, behind) = parse_track(track);
        branches.push(GitBranchRich {
            is_remote: full.starts_with("refs/remotes/"),
            is_current: head == "*",
            upstream: opt(upstream),
            ahead,
            behind,
            author: opt(author),
            committed_at: committed.parse::<i64>().ok(),
            subject: opt(subject),
            name: short,
        });
    }
    branches
}

/// `git rev-parse --abbrev-ref HEAD` → the branch, or `None` when detached
/// or not a repo.
pub fn parse_current_branch(stdout: &str) -> Option<String> {
    let raw = stdout.trim();
    if raw.is_empty() || raw == "HEAD" {
        None
    } else {
        Some(raw.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_symbolic_head_pointer_is_not_a_branch() {
        let text = "refs/heads/main\tmain\t*\torigin/main\tfirst\n\
                    refs/remotes/origin/HEAD\torigin/HEAD\t\t\t\n\
                    refs/remotes/origin/feat\torigin/feat\t\t\tsecond\n";
        let rows = parse_branches(text);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].is_current && !rows[0].is_remote);
        assert_eq!(rows[0].upstream.as_deref(), Some("origin/main"));
        assert!(rows[1].is_remote);
        assert_eq!(rows[1].upstream, None);
        assert_eq!(rows[1].subject.as_deref(), Some("second"));
    }

    #[test]
    fn track_summaries_read_in_every_shape_git_uses() {
        assert_eq!(parse_track("[ahead 3, behind 1]"), (3, 1));
        assert_eq!(parse_track("[ahead 2]"), (2, 0));
        assert_eq!(parse_track("[behind 5]"), (0, 5));
        assert_eq!(parse_track("[gone]"), (0, 0));
        assert_eq!(parse_track(""), (0, 0));
    }

    #[test]
    fn rich_rows_carry_author_time_and_counts() {
        let text = "refs/heads/x\x1fx\x1f*\x1forigin/x\x1f[ahead 1, behind 2]\x1fMo\x1f1700000000\x1fdo it\n";
        let rows = parse_branches_rich(text);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!((r.ahead, r.behind), (1, 2));
        assert_eq!(r.author.as_deref(), Some("Mo"));
        assert_eq!(r.committed_at, Some(1_700_000_000));
        assert_eq!(r.subject.as_deref(), Some("do it"));
    }

    #[test]
    fn a_detached_head_is_no_branch() {
        assert_eq!(parse_current_branch("main\n"), Some("main".into()));
        assert_eq!(parse_current_branch("HEAD\n"), None);
        assert_eq!(parse_current_branch(""), None);
    }
}
