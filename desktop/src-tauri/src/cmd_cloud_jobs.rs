//! cmd_cloud_jobs — what happened to the work you handed to your machine.
//!
//! `loop_cloud_send` mints a cloud task and returns its id and its status at
//! that instant, which is always `submitted`. The panel then showed that first
//! reading forever: a job that ran, failed and reported a reason ten seconds
//! later still read "Waiting for the machine" an hour on, and the reason — the
//! one thing that tells you what to fix — never reached the screen at all.
//!
//! The server has it. Every runner PATCHes its outcome back onto the task row
//! (`status`, `commit_sha`, `error_message`) as the last step of its cycle. This
//! reads those rows back. Same proxy shape as its neighbours: the cloud token
//! stays in `~/.aura/credentials.json` and never reaches the renderer.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::cloud_org::OrgScoped;
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// How many ids one call will look up. The caller is a session's own sent-list,
/// which is short; the cap is a backstop against a caller that grows unbounded
/// turning a poll into a burst of requests.
const MAX_IDS: usize = 20;

/// The live state of one job on the cloud board.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudJobState {
    pub id: String,
    pub status: String,
    /// Why it failed, in the runner's words. Present only on a failure the
    /// runner could explain.
    pub error_message: Option<String>,
    /// The commit the work landed on, when it produced one.
    pub commit_sha: Option<String>,
}

/// Read the current state of `ids` from the cloud board.
///
/// A row we can't read is omitted rather than faked — the caller keeps whatever
/// it last knew for that job, which is the honest fallback when the answer is
/// "we couldn't ask".
#[tauri::command]
pub async fn cloud_job_states(ids: Vec<String>) -> Result<Vec<CloudJobState>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let creds = read_credentials().map_err(|e| e.to_string())?;
    let token = cloud_token(&creds).ok_or_else(|| "not signed in to Aura cloud".to_string())?;
    let origin = cloud_origin(&creds);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let mut out = Vec::new();
    for id in ids.iter().take(MAX_IDS) {
        // The id is a server-minted uuid; anything else is a caller bug, and
        // refusing it here keeps a stray value out of the URL path.
        if !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            continue;
        }
        let url = format!("{origin}/api/v2/a2a/tasks/{id}");
        let Ok(resp) = client.get(&url).bearer_auth(&token).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(row) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        let str_at = |k: &str| {
            row.get(k)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        out.push(CloudJobState {
            id: id.clone(),
            status: str_at("status").unwrap_or_else(|| "submitted".into()),
            error_message: str_at("error_message"),
            commit_sha: str_at("commit_sha"),
        });
    }
    Ok(out)
}

/// A branch of this repo that is being worked on somewhere other than here.
///
/// This is what a cloud badge is drawn from: not "the account owns a machine"
/// but "*this* branch, the one on the row you're looking at, is in flight on a
/// box that isn't this laptop".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPlacement {
    /// The branch the work was sent on — the key a worktree row matches against.
    pub branch: String,
    pub id: String,
    /// `submitted` (queued, nobody has claimed it) or `working` (a machine has it).
    pub status: String,
    /// The agent CLI that will run it, with the `a2a:` transport prefix stripped.
    pub agent: String,
}

/// Statuses that mean the work has not finished. A terminal row is history and
/// must not badge anything — a worktree that shows a cloud glyph forever is
/// worse than one that never showed it, because it stops meaning "right now".
fn is_in_flight(status: &str) -> bool {
    matches!(status, "submitted" | "working" | "claimed" | "running")
}

/// One job this account handed to the cloud for this repo — in flight or
/// finished, on a branch or on none.
///
/// `CloudPlacement` answers "is this row busy elsewhere right now", which is
/// why it is deliberately narrow. This answers the other question, the one the
/// user actually asks after pressing Send: *where did my work go?* A job with
/// no branch and a job that already failed are both real answers to that, and
/// both are invisible to the placement view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudJob {
    pub id: String,
    pub status: String,
    /// The agent CLI, `a2a:` prefix stripped.
    pub agent: String,
    /// The branch it was sent on, when it was sent on one. Cloud work started
    /// from the workspace composer has none — there is no local copy for it.
    pub branch: Option<String>,
    /// What the user asked for, verbatim.
    pub text: Option<String>,
    /// The runner's reason for a failure. The single most useful field on a
    /// dead row: it is usually one `/login` away from fixed.
    pub error_message: Option<String>,
    pub commit_sha: Option<String>,
    pub created_at: Option<String>,
    /// The chat session that placed this job, when a chat placed it.
    ///
    /// A job minted from the composer, the CLI or another machine has none —
    /// which is the honest answer, not a gap. It is what lets a finished job be
    /// handed back to the conversation it came from rather than landing on a
    /// list nobody is looking at.
    pub context_id: Option<String>,
    /// Which project this belongs to, as `owner/name`.
    ///
    /// The board stores a repo id, which means nothing on this side of the
    /// wire; every other row on the fleet page names its project, so a cloud
    /// row that can't is the one row you cannot place. Resolved through the
    /// account's repo list for the all-projects read, and known outright when
    /// the read was already scoped to one repo.
    pub repo: Option<String>,
    /// What the runner reported back when the work finished, reduced to text.
    ///
    /// The board stores whatever JSON the crew node carried, so this is the one
    /// field that has to be interpreted rather than copied: a bare string is
    /// itself, an object is asked for the field a human would read, and
    /// anything else is shown as the JSON it is rather than silently dropped.
    pub result: Option<String>,
}

/// Every recent row on the board, from any repo — the raw server shape.
///
/// The hand-back watcher reads rows this way rather than through `CloudJob`
/// because it needs fields no UI renders (and must not silently lose one when
/// the projection changes). Empty — never an error — when signed out.
pub(crate) async fn board_rows(limit: u32) -> Vec<serde_json::Value> {
    fetch_rows(None, clamp_limit(Some(limit))).await
}

/// Fetch this repo's rows off the shared cloud board.
///
/// Both readings below start here, so "which jobs exist" is answered once and
/// the two views can never disagree about the underlying set — they differ only
/// in what they choose to keep.
///
/// Returns an empty list — never an error — when the repo has no GitHub remote
/// or the account isn't signed in. Cloud state is an enhancement on every
/// surface that reads it; not being able to fetch it must not interrupt the UI.
async fn fetch_repo_rows(repo_root: String, limit: u32) -> Vec<serde_json::Value> {
    let Some(full_name) = repo_full_name(repo_root).await else {
        return Vec::new();
    };
    fetch_rows(Some(full_name), limit).await
}

/// The `owner/name` this checkout pushes to, or nothing when it has no GitHub
/// remote. Split out because the job list needs the name itself — it is what
/// tells the user which project a cloud row belongs to — and not only the rows
/// it selects.
async fn repo_full_name(repo_root: String) -> Option<String> {
    crate::blocking::run(move || crate::cmd_loop::origin_full_name(&repo_root)).await
}

/// Fetch rows off the board, optionally narrowed to one repo.
///
/// `None` means every repo this account has sent work to. That is the honest
/// answer to "where did my work go" on a page scoped to all projects: a job
/// belongs to the account that sent it, not to whichever projects happen to be
/// open in the roster today, and per-repo fan-out silently loses the work you
/// sent from a project you have since closed — the same disappearing act this
/// whole file exists to end.
async fn fetch_rows(full_name: Option<String>, limit: u32) -> Vec<serde_json::Value> {
    let Ok(creds) = read_credentials() else {
        return Vec::new();
    };
    let Some(token) = cloud_token(&creds) else {
        return Vec::new();
    };
    let origin = cloud_origin(&creds);

    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    else {
        return Vec::new();
    };

    let url = format!("{origin}/api/v2/a2a/tasks");
    let mut query: Vec<(&str, String)> = vec![("limit", limit.to_string())];
    if let Some(repo) = full_name.as_deref() {
        query.push(("repo", repo.to_string()));
    }
    let Ok(resp) = client
        .get(&url)
        .bearer_auth(&token)
        .org_scoped()
        .query(&query)
        .send()
        .await
    else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };

    body.get("tasks")
        .and_then(|v| v.as_array())
        .or_else(|| body.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Read an optional non-empty string field off a board row.
fn row_str(row: &serde_json::Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// Every recent cloud job for this repo, newest first, whether or not it landed
/// on a branch and whether or not it has finished.
///
/// This is the list `cloud_jobs_for_repo` has always deferred to in its comment
/// and which, until now, did not exist — so work sent without a branch (which
/// is all work sent from the workspace composer) was minted on the board and
/// then visible on no screen in the app.
#[tauri::command]
pub async fn cloud_jobs_list(repo_root: String, limit: Option<u32>) -> Result<Vec<CloudJob>, String> {
    // Scoped to one repo, so every row it can return belongs to that repo —
    // there is nothing to look up, and no reason to spend a request finding out
    // what we already asked the board for.
    let Some(full_name) = repo_full_name(repo_root).await else {
        return Ok(Vec::new());
    };
    let rows = fetch_rows(Some(full_name.clone()), clamp_limit(limit)).await;
    Ok(rows
        .iter()
        .map(|row| job_from_row(row, Some(full_name.clone())))
        .collect())
}

/// Every recent cloud job this account has sent, from any repo, newest first.
///
/// The per-repo list can only cover repos the app currently has open. A job you
/// sent from a project you later closed is real, may still be running, and is
/// invisible to every per-repo read — which is the same "nothing appeared"
/// failure one level up. This is what the fleet page asks when its scope is all
/// projects: one request, and it cannot miss a repo.
#[tauri::command]
pub async fn cloud_jobs_all(limit: Option<u32>) -> Result<Vec<CloudJob>, String> {
    let rows = fetch_rows(None, clamp_limit(limit)).await;
    // One extra request for the whole account, not one per row, and only for
    // the read that spans repos. A row whose repo we can't name still renders —
    // unattributed is a smaller loss than absent.
    let known = repo_index().await;
    let mine = crate::cloud_org::active_org_slug();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let found = row_str(row, "repo_id").and_then(|id| known.get(&id).cloned());
            if !belongs(found.as_ref(), mine.as_deref()) {
                return None;
            }
            Some(job_from_row(row, found.map(|(name, _)| name)))
        })
        .collect())
}

/// Whether a job's repo is one the org you're acting as can see.
///
/// A row we could not attribute to a repo at all is kept: it is work this
/// account sent, and dropping it would hide a running job because a name lookup
/// failed. Same bargain as the unattributed rendering above — a job with no
/// project beside it is a smaller loss than a job that is simply gone.
fn belongs(repo: Option<&(String, String)>, org: Option<&str>) -> bool {
    let (Some((_, repo_org)), Some(org)) = (repo, org) else {
        return true;
    };
    repo_org.is_empty() || repo_org == org
}

/// `repo_id` → (`owner/name`, org slug) for every repo this account can see.
///
/// The board rows carry a repo id and nothing else, and an id is not something
/// anyone can read. This is the one place that turns it into the name the rest
/// of the app already speaks — the same `/repos` list `aura runner register`
/// resolves a `--repo` slug through, so the two agree by construction.
///
/// The org rides along because this is already the cross-org read: the board is
/// per-account, so without it the fleet page would list a client's jobs beside
/// your own with the org switcher having no effect on the one surface where the
/// work actually appears.
///
/// Empty — never an error — when signed out or the call fails: the caller
/// degrades to unattributed rows, which is exactly the old behaviour.
async fn repo_index() -> std::collections::HashMap<String, (String, String)> {
    let mut out = std::collections::HashMap::new();
    let Ok(creds) = read_credentials() else {
        return out;
    };
    let Some(token) = cloud_token(&creds) else {
        return out;
    };
    let origin = cloud_origin(&creds);
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    else {
        return out;
    };
    // Unscoped on purpose, like the switcher's own read of this endpoint: the
    // map has to cover every repo so a job can be *named* whichever org sent
    // it, and `belongs` below does the narrowing. Scoping it would leave rows
    // from another org unattributed and then keep them for exactly that reason.
    let Ok(resp) = client
        .get(format!("{origin}/api/v2/repos"))
        .bearer_auth(&token)
        .send()
        .await
    else {
        return out;
    };
    if !resp.status().is_success() {
        return out;
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return out;
    };
    let rows = body
        .get("repos")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| body.as_array().cloned())
        .unwrap_or_default();
    for row in rows {
        if let (Some(id), Some(name)) = (row_str(&row, "id"), row_str(&row, "full_name")) {
            let org = row_str(&row, "org_slug").unwrap_or_default();
            out.insert(id, (name, org));
        }
    }
    out
}

/// Bounded so a caller can't ask the board for an unbounded page, and defaulted
/// to a size that covers "recent" without paging.
fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(50).clamp(1, 200)
}

/// Read one board row into the shape the UI renders.
///
/// `agent_kind` carries the transport prefix the scheduler routes on
/// (`a2a:claude`); the user asked for claude, so that is what the row says.
fn job_from_row(row: &serde_json::Value, repo: Option<String>) -> CloudJob {
    CloudJob {
        repo,
        result: result_text(row),
        id: row_str(row, "id").unwrap_or_default(),
        status: row_str(row, "status").unwrap_or_else(|| "submitted".into()),
        agent: row_str(row, "agent_kind")
            .unwrap_or_default()
            .trim_start_matches("a2a:")
            .to_string(),
        branch: row_str(row, "branch"),
        text: row_str(row, "input_text"),
        error_message: row_str(row, "error_message"),
        commit_sha: row_str(row, "commit_sha"),
        created_at: row_str(row, "created_at"),
        context_id: row_str(row, "context_id"),
    }
}

/// What the runner said when it finished, as a person would read it.
///
/// `result` is free-form JSON — whatever the crew node carried — so there is no
/// one field to copy. A bare string is already the answer; an object is asked
/// for the keys a runner actually writes, in the order a reader wants them; and
/// anything else is handed over as its own JSON rather than thrown away, since
/// an unfamiliar shape is still the only account of what the machine did.
fn result_text(row: &serde_json::Value) -> Option<String> {
    let value = row.get("result")?;
    let text = match value {
        serde_json::Value::Null => return None,
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Object(_) => ["summary", "text", "message", "output"]
            .iter()
            .find_map(|k| row_str(value, k))
            .unwrap_or_else(|| {
                serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
            }),
        other => other.to_string(),
    };
    (!text.trim().is_empty()).then_some(text)
}

/// Every unfinished cloud job for the repo at `repo_root`, keyed by branch.
///
/// Returns an empty list — never an error — when the repo has no GitHub remote
/// or the account isn't signed in. A badge is an enhancement; not being able to
/// compute one is not a failure worth interrupting the UI for.
#[tauri::command]
pub async fn cloud_jobs_for_repo(repo_root: String) -> Result<Vec<CloudPlacement>, String> {
    let rows = fetch_repo_rows(repo_root, 50).await;

    let mut out = Vec::new();
    for row in rows {
        let status = row
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if !is_in_flight(status) {
            continue;
        }
        let Some(branch) = row
            .get("branch")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        else {
            // A row with no branch can't be matched to a worktree, so it can't
            // badge one. It is still real work — `cloud_jobs_list` shows it.
            continue;
        };
        out.push(CloudPlacement {
            branch: branch.to_string(),
            id: row
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            status: status.to_string(),
            agent: row
                .get("agent_kind")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim_start_matches("a2a:")
                .to_string(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{belongs, is_in_flight, job_from_row, result_text, row_str};

    /// The name is what the user reads, so it has to survive the projection —
    /// and its absence has to stay absent rather than becoming an empty label.
    #[test]
    fn a_row_carries_the_project_it_belongs_to() {
        let row: serde_json::Value = serde_json::from_str(BRANCHLESS).expect("row shape");
        let named = job_from_row(&row, Some("MHASK/aura-sovereign".into()));
        assert_eq!(named.repo.as_deref(), Some("MHASK/aura-sovereign"));
        // The all-repos read can fail to resolve one; that row still renders.
        assert!(job_from_row(&row, None).repo.is_none());
    }

    /// `result` is whatever JSON the crew node carried. Every shape has to end
    /// as something a person can read, and "nothing here" has to stay nothing.
    #[test]
    fn the_runners_answer_is_readable_whatever_shape_it_arrives_in() {
        let of = |json: &str| {
            result_text(&serde_json::from_str::<serde_json::Value>(json).expect("row"))
        };
        assert_eq!(of(r#"{"result":"Added the retry backoff"}"#).as_deref(),
                   Some("Added the retry backoff"));
        assert_eq!(of(r#"{"result":{"summary":"Two files changed","raw":1}}"#).as_deref(),
                   Some("Two files changed"));
        // No key a reader wants — hand over the JSON rather than nothing, since
        // it is still the only account of what the machine did.
        assert!(of(r#"{"result":{"exit":0}}"#).expect("kept").contains("\"exit\""));
        assert!(of(r#"{"result":null}"#).is_none());
        assert!(of(r#"{"result":"   "}"#).is_none());
        assert!(of(r#"{"status":"failed"}"#).is_none());
    }

    /// The row the runner really pushes back after a failed cycle — reduced to
    /// the fields this command reads.
    const ROW: &str = r#"{"id":"14a68896","status":"failed",
      "error_message":"agent 'claude' exited 1: Not logged in · Please run /login",
      "commit_sha":null,"result":null}"#;

    #[test]
    fn a_failed_row_carries_the_reason_and_no_commit() {
        let row: serde_json::Value = serde_json::from_str(ROW).expect("row shape");
        assert_eq!(row["status"], "failed");
        assert!(row["error_message"]
            .as_str()
            .expect("a reason")
            .contains("Not logged in"));
        assert!(row["commit_sha"].is_null());
    }

    #[test]
    fn an_id_that_is_not_a_uuid_shape_is_refused_before_it_reaches_the_url() {
        // The guard the command applies, stated as its own test: a value with a
        // slash or a dot could otherwise walk the API path.
        let ok = |s: &str| {
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        };
        assert!(ok("14a68896-1426-4ee8-a237-bb6ced03c75f"));
        assert!(!ok("../runners"));
        assert!(!ok("id with space"));
    }

    /// A badge means "right now". Every terminal status must fall out, or a
    /// worktree keeps a cloud glyph long after the work finished — which is
    /// worse than no glyph, because it stops meaning anything.
    #[test]
    fn only_unfinished_work_can_badge_a_worktree() {
        for live in ["submitted", "working", "claimed", "running"] {
            assert!(is_in_flight(live), "{live} is still in flight");
        }
        for done in ["completed", "failed", "canceled", "rejected", "auth-required"] {
            assert!(!is_in_flight(done), "{done} is history, not a badge");
        }
    }

    /// The row a cloud workspace really mints: no branch, because there is no
    /// local copy for it. Every rule the placement view applies rejects it —
    /// which is correct for a badge and was, until `cloud_jobs_list`, the whole
    /// reason a sent job appeared on no screen in the app.
    const BRANCHLESS: &str = r#"{"id":"2252a902","status":"submitted",
      "agent_kind":"a2a:claude","branch":null,
      "input_text":"Add the retry backoff","created_at":"2026-08-02T00:00:00Z"}"#;

    #[test]
    fn a_cloud_workspace_row_has_no_branch_to_badge() {
        let row: serde_json::Value = serde_json::from_str(BRANCHLESS).expect("row shape");
        assert!(
            row_str(&row, "branch").is_none(),
            "work sent from the composer carries no branch"
        );
        // …and is still perfectly readable as a job, which is the point.
        assert_eq!(row_str(&row, "status").as_deref(), Some("submitted"));
        assert_eq!(row_str(&row, "input_text").as_deref(), Some("Add the retry backoff"));
    }

    /// A finished job is exactly what the user wants to see after pressing Send
    /// — especially a failed one, which carries the reason. The badge view
    /// drops it on purpose; the list must not.
    #[test]
    fn the_list_keeps_what_the_badge_view_throws_away() {
        let row: serde_json::Value = serde_json::from_str(ROW).expect("row shape");
        let status = row_str(&row, "status").expect("a status");
        assert!(!is_in_flight(&status), "badges drop it");
        assert!(
            row_str(&row, "error_message").is_some(),
            "and dropping it takes the reason with it"
        );
    }

    /// The board writes `null` and `""` interchangeably for "nothing here".
    /// Treating an empty string as a value puts a blank branch on screen and,
    /// worse, makes a branchless row look like it has one.
    #[test]
    fn an_empty_string_is_absent_not_present() {
        let row: serde_json::Value =
            serde_json::from_str(r#"{"branch":"","error_message":"  ","id":"x"}"#).expect("row");
        assert!(row_str(&row, "branch").is_none());
        assert!(row_str(&row, "error_message").is_none());
        assert_eq!(row_str(&row, "id").as_deref(), Some("x"));
    }

    /// The board is per-account, so the account-wide read is where a client's
    /// work and your own end up side by side. Which org you're acting as is
    /// what separates them.
    #[test]
    fn the_account_wide_board_is_narrowed_to_the_org_you_are_in() {
        let mine = ("Naridon-Inc/aura".to_string(), "naridon".to_string());
        let theirs = ("client/app".to_string(), "client".to_string());
        assert!(belongs(Some(&mine), Some("naridon")));
        assert!(!belongs(Some(&theirs), Some("naridon")));
    }

    /// Two ways of not knowing, and neither may delete a running job from the
    /// screen: a repo we couldn't name, and an account with no org recorded.
    #[test]
    fn a_job_we_cannot_place_is_still_a_job_you_sent() {
        let unfiled = ("x/y".to_string(), String::new());
        assert!(belongs(None, Some("naridon")));
        assert!(belongs(Some(&unfiled), Some("naridon")));
        assert!(belongs(Some(&("x/y".into(), "client".into())), None));
    }
}
