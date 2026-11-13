//! The pull request's mergeability as GitHub computes it — the merge state
//! (`CLEAN`, `DIRTY`, `BLOCKED`, `BEHIND`, `UNSTABLE`, …) and its place in a
//! merge queue — which `gh pr list` doesn't carry. The Checks tab reads it
//! for the one pull request on screen: "Merge conflicts detected" comes from
//! `DIRTY`, the merge queue row from the queue entry. Merge reads how the
//! repository merges from here too, and the status row whether you can
//! approve the pull request.

use serde::{Deserialize, Serialize};

use crate::cmd_prs::{run_gh, GhRepo};

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct PrMergeState {
    /// GitHub's `MergeStateStatus`; `None` when it didn't say.
    pub merge_state_status: Option<String>,
    /// `MERGEABLE` | `CONFLICTING` | `UNKNOWN`.
    pub mergeable: Option<String>,
    /// The branch the pull request merges into.
    pub base_ref: String,
    /// `AWAITING_CHECKS` | `LOCKED` | `MERGEABLE` | `QUEUED` | `UNMERGEABLE`
    /// while the pull request is in a merge queue; `None` when it isn't, or
    /// when the host has no merge queues to ask about.
    pub merge_queue_state: Option<String>,
    /// How Merge merges: the first the repository allows of `squash`,
    /// `rebase`, `merge`. `None` when it couldn't be read.
    pub merge_method: Option<String>,
    /// You can approve: write access or more, not its author, and no review
    /// from you on its latest commit yet.
    pub can_approve: bool,
}

/// One request for everything the rows need. `mergeQueueEntry` only exists
/// where merge queues do; without it the query fails and `pr view` answers.
const QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){squashMergeAllowed rebaseMergeAllowed mergeCommitAllowed viewerPermission pullRequest(number:$number){mergeStateStatus mergeable baseRefName headRefOid viewerDidAuthor viewerLatestReview{commit{oid}} mergeQueueEntry{state}}}}";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Facts {
    #[serde(default)]
    merge_state_status: Option<String>,
    #[serde(default)]
    mergeable: Option<String>,
    #[serde(default)]
    base_ref_name: Option<String>,
    #[serde(default)]
    merge_queue_entry: Option<QueueEntry>,
    #[serde(default)]
    head_ref_oid: Option<String>,
    #[serde(default)]
    viewer_did_author: Option<bool>,
    #[serde(default)]
    viewer_latest_review: Option<Review>,
}

#[derive(Deserialize, Default)]
struct Review {
    #[serde(default)]
    commit: Option<ReviewCommit>,
}

#[derive(Deserialize, Default)]
struct ReviewCommit {
    #[serde(default)]
    oid: Option<String>,
}

impl Facts {
    /// Not yours, and you haven't reviewed what it now points at.
    fn approvable_by_viewer(&self) -> bool {
        let Some(head) = present(self.head_ref_oid.clone()) else {
            return false;
        };
        if self.viewer_did_author == Some(true) {
            return false;
        }
        match &self.viewer_latest_review {
            None => true,
            Some(r) => match r.commit.as_ref().and_then(|c| present(c.oid.clone())) {
                Some(reviewed) => reviewed != head,
                None => false,
            },
        }
    }
}

/// What the repository says about merging, beside the pull request.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RepoFacts {
    #[serde(default)]
    squash_merge_allowed: Option<bool>,
    #[serde(default)]
    rebase_merge_allowed: Option<bool>,
    #[serde(default)]
    merge_commit_allowed: Option<bool>,
    #[serde(default)]
    viewer_permission: Option<String>,
}

impl RepoFacts {
    /// Squash first, then rebase, then a merge commit.
    fn merge_method(&self) -> Option<String> {
        let on = |b: Option<bool>| b == Some(true);
        if on(self.squash_merge_allowed) {
            Some("squash".into())
        } else if on(self.rebase_merge_allowed) {
            Some("rebase".into())
        } else if on(self.merge_commit_allowed) {
            Some("merge".into())
        } else {
            None
        }
    }

    /// Write access or more.
    fn viewer_can_merge(&self) -> bool {
        matches!(self.viewer_permission.as_deref(), Some("ADMIN" | "MAINTAIN" | "WRITE"))
    }
}

#[derive(Deserialize, Default)]
struct QueueEntry {
    #[serde(default)]
    state: Option<String>,
}

fn present(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl From<Facts> for PrMergeState {
    fn from(f: Facts) -> Self {
        Self {
            merge_state_status: present(f.merge_state_status),
            mergeable: present(f.mergeable),
            base_ref: present(f.base_ref_name).unwrap_or_default(),
            merge_queue_state: present(f.merge_queue_entry.and_then(|q| q.state)),
            merge_method: None,
            can_approve: false,
        }
    }
}

fn parse_graphql(stdout: &str, number: u64) -> Result<PrMergeState, String> {
    #[derive(Deserialize)]
    struct Wrap {
        data: Option<Data>,
        #[serde(default)]
        errors: Vec<Message>,
    }
    #[derive(Deserialize)]
    struct Data {
        repository: Option<Repo>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Repo {
        pull_request: Option<Facts>,
        #[serde(flatten)]
        facts: RepoFacts,
    }
    #[derive(Deserialize)]
    struct Message {
        #[serde(default)]
        message: String,
    }
    let wrap: Wrap = serde_json::from_str(stdout).map_err(|e| format!("gh json parse: {e}"))?;
    let repo = wrap.data.and_then(|d| d.repository);
    match repo {
        Some(Repo { pull_request: Some(facts), facts: repo }) => Ok(PrMergeState {
            merge_method: repo.merge_method(),
            can_approve: repo.viewer_can_merge() && facts.approvable_by_viewer(),
            ..facts.into()
        }),
        _ => Err(wrap
            .errors
            .into_iter()
            .map(|m| m.message)
            .find(|m| !m.trim().is_empty())
            .unwrap_or_else(|| format!("pull request #{number} wasn't found"))),
    }
}

fn parse_view(stdout: &str) -> Result<PrMergeState, String> {
    let facts: Facts = serde_json::from_str(stdout).map_err(|e| format!("gh json parse: {e}"))?;
    Ok(facts.into())
}

/// The merge state of pull request `number`.
#[tauri::command]
pub async fn pr_merge_state(
    repo_root: String,
    number: u64,
    remote_repo: Option<String>,
) -> Result<PrMergeState, String> {
    crate::blocking::run(move || {
        let repo = GhRepo::new(&repo_root, remote_repo)?;
        let slug = repo.owner_path()?;
        let queried = slug.split_once('/').map(|(owner, name)| {
            run_gh(
                &repo,
                &[
                    "api",
                    "graphql",
                    // Where `mergeStateStatus` is still a preview field.
                    "-H",
                    "Accept: application/vnd.github.merge-info-preview+json",
                    "-f",
                    &format!("query={QUERY}"),
                    "-f",
                    &format!("owner={owner}"),
                    "-f",
                    &format!("name={name}"),
                    "-F",
                    &format!("number={number}"),
                ],
            )
            .and_then(|out| parse_graphql(&out, number))
        });
        match queried {
            Some(Ok(state)) => Ok(state),
            // No merge queues on this host (or the query was refused): the
            // merge state alone, from `pr view`.
            _ => run_gh(
                &repo,
                &[
                    "pr",
                    "view",
                    &number.to_string(),
                    "--json",
                    "mergeStateStatus,mergeable,baseRefName",
                ],
            )
            .and_then(|out| parse_view(&out)),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_queued_pull_request_carries_its_queue_state() {
        let out = r#"{"data":{"repository":{"pullRequest":{"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","baseRefName":"main","mergeQueueEntry":{"state":"AWAITING_CHECKS"}}}}}"#;
        let s = parse_graphql(out, 98).unwrap();
        assert_eq!(s.merge_state_status.as_deref(), Some("BLOCKED"));
        assert_eq!(s.merge_queue_state.as_deref(), Some("AWAITING_CHECKS"));
        assert_eq!(s.base_ref, "main");
    }

    #[test]
    fn a_conflicted_pull_request_outside_a_queue_has_no_queue_state() {
        let out = r#"{"data":{"repository":{"pullRequest":{"mergeStateStatus":"DIRTY","mergeable":"CONFLICTING","baseRefName":"develop","mergeQueueEntry":null}}}}"#;
        let s = parse_graphql(out, 98).unwrap();
        assert_eq!(s.merge_state_status.as_deref(), Some("DIRTY"));
        assert_eq!(s.mergeable.as_deref(), Some("CONFLICTING"));
        assert_eq!(s.merge_queue_state, None);
    }

    #[test]
    fn a_missing_pull_request_says_why() {
        let gone = r#"{"data":{"repository":{"pullRequest":null}},"errors":[{"message":"Could not resolve to a PullRequest with the number of 7."}]}"#;
        assert_eq!(parse_graphql(gone, 7).unwrap_err(), "Could not resolve to a PullRequest with the number of 7.");
        let silent = r#"{"data":{"repository":{"pullRequest":null}}}"#;
        assert_eq!(parse_graphql(silent, 7).unwrap_err(), "pull request #7 wasn't found");
    }

    #[test]
    fn merge_uses_the_first_method_the_repository_allows() {
        let read = |squash: bool, rebase: bool, commit: bool| {
            let out = format!(
                r#"{{"data":{{"repository":{{"squashMergeAllowed":{squash},"rebaseMergeAllowed":{rebase},"mergeCommitAllowed":{commit},"pullRequest":{{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","baseRefName":"main","mergeQueueEntry":null}}}}}}}}"#
            );
            parse_graphql(&out, 98).unwrap().merge_method
        };
        assert_eq!(read(true, true, true).as_deref(), Some("squash"));
        assert_eq!(read(false, true, true).as_deref(), Some("rebase"));
        assert_eq!(read(false, false, true).as_deref(), Some("merge"));
        assert_eq!(read(false, false, false), None);
    }

    #[test]
    fn a_repository_that_says_nothing_has_no_method() {
        let out = r#"{"data":{"repository":{"pullRequest":{"mergeStateStatus":"CLEAN","baseRefName":"main"}}}}"#;
        assert_eq!(parse_graphql(out, 98).unwrap().merge_method, None);
    }

    #[test]
    fn approve_needs_write_access_someone_elses_pr_and_a_new_head() {
        let read = |permission: &str, authored: bool, review: &str| {
            let out = format!(
                r#"{{"data":{{"repository":{{"viewerPermission":"{permission}","pullRequest":{{"mergeStateStatus":"BLOCKED","baseRefName":"main","headRefOid":"abc","viewerDidAuthor":{authored},"viewerLatestReview":{review}}}}}}}}}"#
            );
            parse_graphql(&out, 98).unwrap().can_approve
        };
        assert!(read("WRITE", false, "null"));
        assert!(read("ADMIN", false, r#"{"commit":{"oid":"old"}}"#));
        assert!(!read("WRITE", false, r#"{"commit":{"oid":"abc"}}"#));
        assert!(!read("WRITE", false, r#"{"commit":null}"#));
        assert!(!read("WRITE", true, "null"));
        assert!(!read("READ", false, "null"));
        assert!(!read("TRIAGE", false, "null"));
    }

    #[test]
    fn the_pr_view_answer_reads_the_same_fields() {
        let s = parse_view(r#"{"baseRefName":"main","mergeStateStatus":"BEHIND","mergeable":"MERGEABLE"}"#).unwrap();
        assert_eq!(s.merge_state_status.as_deref(), Some("BEHIND"));
        assert_eq!(s.merge_queue_state, None);
        let blank = parse_view(r#"{"baseRefName":"main","mergeStateStatus":"","mergeable":""}"#).unwrap();
        assert_eq!(blank.merge_state_status, None);
        assert_eq!(blank.merge_method, None);
        assert!(!blank.can_approve);
    }
}
