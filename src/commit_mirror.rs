// Mirroring the commits themselves.
//
// The console's Landed tab reads the `checkpoints` table, and on this
// repository that table has never had a row. The reason is a chain, not a
// single bug:
//
//   1. `checkpoints` is only ever written from the post-commit hook.
//   2. The hook's first line is `if [ -n "$AURA_SKIP" ]; then exit 0; fi`,
//      and every commit here goes in with `AURA_SKIP=1` because the strict
//      guard misfires on a dirty worktree.
//   3. Even when it does fire, the upload rides a detached thread that the
//      process outlives by microseconds.
//
// So every session in the console says "0 commits" about work that produced
// dozens. The lesson is the same one `sync_graph_worktree` already learned
// for the code graph: **a commit is a fact in git, and learning about it must
// not depend on a hook having fired.** This module reads the commits from the
// repository itself, so it works after the fact, under `--no-verify`, on a
// squash a bot landed, and in a worktree whose commits skip Aura entirely.
//
// A leaf module: reading git is separated from the wire shape, so the payload
// is pinned by tests with no network and no repository behind them.
//
// Metadata only, exactly like the graph push: sha, branch, subject, author,
// timestamp and how much moved. Never a line of a diff.

use serde_json::json;

/// One commit, as the cloud needs to hear about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirroredCommit {
    pub sha: String,
    /// The branch we read it from. `None` on a detached HEAD, which is a real
    /// state — a bisect, a CI checkout — and not worth guessing about.
    pub branch: Option<String>,
    /// The commit's subject line. The whole body is deliberately left behind:
    /// a commit message can carry a paste of anything.
    pub subject: String,
    pub author: String,
    /// RFC 3339, from the commit's own author time — never "now". A backfill
    /// of last month's work must not land in today's session window.
    pub authored_at: String,
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

/// The wire rows for `POST /api/v1/sync/checkpoints`.
///
/// `risk_label` is deliberately absent rather than "Clean". A commit nobody
/// reviewed is not a clean commit, and the console grouping every mirrored
/// row under CLEAN is how "20 of 20 clean" came to include `test/risky-code`.
/// The server reads a missing label as unreviewed and says so.
pub fn payload(commits: &[MirroredCommit]) -> Vec<serde_json::Value> {
    commits
        .iter()
        .map(|c| {
            json!({
                "commit_id": c.sha,
                "branch": c.branch,
                "summary": c.subject,
                "committed_at": c.authored_at,
                "ast_node_count": 0,
                "data": {
                    "source": "git",
                    "author": c.author,
                    "authored_at": c.authored_at,
                    "files_changed": c.files_changed,
                    "insertions": c.insertions,
                    "deletions": c.deletions,
                },
            })
        })
        .collect()
}

/// Read the newest `limit` commits reachable from HEAD.
///
/// Newest-first and bounded, for the same reason the graph push is bounded:
/// the handler upserts a row at a time against a database that is not on the
/// same box, so an unbounded first push of a long history is one request that
/// times out. Bounded, a repository fills in over a few runs, and the upsert
/// is keyed on `(repo, commit)` so re-sending costs nothing but bandwidth.
pub fn read_commits(repo: &git2::Repository, limit: usize) -> Vec<MirroredCommit> {
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_string));

    let mut walk = match repo.revwalk() {
        Ok(w) => w,
        Err(_) => return Vec::new(),
    };
    if walk.push_head().is_err() {
        // An empty repository has no HEAD to walk. Nothing to mirror, and
        // nothing wrong.
        return Vec::new();
    }
    walk.set_sorting(git2::Sort::TIME).ok();

    let mut out = Vec::new();
    for oid in walk.flatten().take(limit) {
        let Ok(commit) = repo.find_commit(oid) else { continue };
        let (files_changed, insertions, deletions) = diff_stats(repo, &commit);

        out.push(MirroredCommit {
            sha: oid.to_string(),
            branch: branch.clone(),
            subject: subject_of(commit.message().unwrap_or("")),
            author: commit.author().name().unwrap_or("unknown").to_string(),
            authored_at: rfc3339(commit.time()),
            files_changed,
            insertions,
            deletions,
        });
    }
    out
}

/// The first line, and only the first line.
fn subject_of(message: &str) -> String {
    message.lines().next().unwrap_or("").trim().to_string()
}

/// How much this commit moved, against its first parent — the same reading
/// `git show --stat` gives. A merge is measured against the branch it landed
/// on, and a root commit against nothing at all.
fn diff_stats(repo: &git2::Repository, commit: &git2::Commit<'_>) -> (usize, usize, usize) {
    let Ok(tree) = commit.tree() else { return (0, 0, 0) };
    let parent = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let Ok(diff) = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), None) else {
        return (0, 0, 0);
    };
    match diff.stats() {
        Ok(s) => (s.files_changed(), s.insertions(), s.deletions()),
        Err(_) => (0, 0, 0),
    }
}

/// git2 hands back seconds-since-epoch plus an offset in minutes; the cloud
/// reads RFC 3339. Falling back to the epoch would date a commit to 1970 and
/// bury it, so an unreadable time drops the commit's claim to a timestamp
/// rather than inventing one.
fn rfc3339(time: git2::Time) -> String {
    use chrono::{FixedOffset, TimeZone};
    let offset = FixedOffset::east_opt(time.offset_minutes() * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC is a valid offset"));
    match offset.timestamp_opt(time.seconds(), 0) {
        chrono::LocalResult::Single(dt) => dt.to_rfc3339(),
        _ => chrono::Utc::now().to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(sha: &str) -> MirroredCommit {
        MirroredCommit {
            sha: sha.to_string(),
            branch: Some("main".into()),
            subject: "fix(console): the Landed tab was empty".into(),
            author: "Ashiq".into(),
            authored_at: "2026-08-25T12:00:00+00:00".into(),
            files_changed: 3,
            insertions: 40,
            deletions: 7,
        }
    }

    #[test]
    fn a_commit_nobody_reviewed_does_not_claim_to_be_clean() {
        // The whole reason Work read "20 of 20 clean" while one of the twenty
        // was literally named `test/risky-code`.
        let rows = payload(&[commit("abc")]);
        assert!(rows[0].get("risk_label").is_none());
        assert!(rows[0].get("risk_score").is_none());
    }

    #[test]
    fn the_commits_own_time_crosses_the_wire_not_the_moment_we_sent_it() {
        // The session trace windows commits by `created_at`, so a backfill
        // stamped `now()` would file last month's work under today's session.
        let rows = payload(&[commit("abc")]);
        assert_eq!(rows[0]["committed_at"], "2026-08-25T12:00:00+00:00");
        assert_eq!(rows[0]["data"]["authored_at"], "2026-08-25T12:00:00+00:00");
    }

    #[test]
    fn the_wire_row_carries_metadata_and_nothing_that_could_be_a_diff() {
        let rows = payload(&[commit("abc")]);
        let data = rows[0]["data"].as_object().expect("data is an object");
        let mut keys: Vec<&str> = data.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "author",
                "authored_at",
                "deletions",
                "files_changed",
                "insertions",
                "source",
            ],
        );
    }

    #[test]
    fn only_the_subject_line_is_sent() {
        // A commit body can hold a paste of anything — a log, a key someone
        // dropped in by accident. The subject is what a list needs anyway.
        assert_eq!(
            subject_of("fix: the thing\n\nA long body\nwith more lines"),
            "fix: the thing",
        );
        assert_eq!(subject_of(""), "");
    }

    #[test]
    fn nothing_to_say_sends_nothing() {
        assert!(payload(&[]).is_empty());
    }
}
