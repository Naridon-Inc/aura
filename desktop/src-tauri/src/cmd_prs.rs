//! PR workspace commands — Stage 7A.
//!
//! v1 sources PR data from the `gh` CLI (GitHub) executed in the repo
//! root. `gh` auto-detects the remote so we don't have to parse
//! `git remote -v`. When `gh` isn't installed or the user isn't logged
//! in, returns a clean error string the React side renders as an
//! install hint.
//!
//! Aura semantic findings (risk, invariants, blast radius) are layered
//! on top by reading any matching `.aura/reviews/<ts>.json` whose
//! base_branch matches this PR's baseRefName — so the PR card shows
//! the same risk chip the ReviewsSidebar surfaces.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub head_ref: String,
    pub base_ref: String,
    pub is_draft: bool,
    pub additions: u64,
    pub deletions: u64,
    pub created_at: String,
    pub updated_at: String,
    pub review_decision: Option<String>,
    pub url: String,
    /// Aura risk score from the most recent `.aura/reviews/*.json` whose
    /// `base_branch` matches this PR's `base_ref`. None when no matching
    /// review has been run.
    pub aura_risk_score: Option<i64>,
    pub aura_risk_label: Option<String>,
    /// Aggregate CI status — `"success" | "failure" | "pending" | "neutral" | "skipping" | "error"`.
    /// None when there are no checks (or `gh pr checks` failed). Mirrors
    /// Superset's per-row CI dot.
    pub checks_state: Option<String>,
    /// Counts so the UI can render `3/5 ✓` if it wants more detail.
    pub checks_total: u32,
    pub checks_passing: u32,
    pub checks_failing: u32,
    pub checks_pending: u32,
    /// True when the PR's author matches the gh-authenticated viewer
    /// (`gh api user --jq .login`). Drives the Inbox bucketing — own PRs
    /// land in Drafts / Waiting reviewers / Returned-to-you / Approved.
    pub is_authored_by_me: bool,
    /// True when the viewer is in `reviewRequests`. Drives "Needs your
    /// review" + "Waiting for author" buckets.
    pub is_review_requested_for_me: bool,
    /// PR labels — name + GitHub colour hex (no `#` prefix). Populated
    /// from `gh pr list --json labels`.
    pub labels: Vec<PrLabel>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PrLabel {
    pub name: String,
    /// GitHub colour hex without leading `#` (e.g. `"a2eeef"`). Empty
    /// when GitHub didn't provide one.
    pub color: String,
    pub description: String,
}

#[derive(Serialize, Clone)]
pub struct PrFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Serialize, Clone)]
pub struct PrDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub body: String,
    pub author: String,
    pub head_ref: String,
    pub base_ref: String,
    pub is_draft: bool,
    pub mergeable: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub created_at: String,
    pub updated_at: String,
    pub review_decision: Option<String>,
    pub url: String,
    pub files: Vec<PrFile>,
    /// Unified diff body from `gh pr diff <num>`. May be large; the UI
    /// chunks it per file before rendering.
    pub diff: String,
    /// Populated when every diff strategy failed (gh non-zero + git
    /// fallback errored or timed out). Carries the last stderr/message
    /// so the UI can show a real cause instead of "No diff body".
    /// `None` when the diff string above is authoritative — even if
    /// it's legitimately empty (e.g. a description-only PR).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_error: Option<String>,
    /// Layered Aura semantic findings — same shape as the persisted
    /// review JSON, deserialized loosely so we don't break when the
    /// CLI adds fields.
    pub aura_review: Option<AuraReviewPayload>,
    /// Reviewer roster — completed reviews from `latestReviews` merged
    /// with still-pending users from `reviewRequests`. Drives the
    /// right-rail Reviewers card.
    pub reviewers: Vec<PrReviewer>,
    /// Stage 8J — assignee logins from `gh pr view --json assignees`.
    /// Drives the right-rail Assignees card.
    pub assignees: Vec<String>,
    /// Stage 8J — populated only when state == MERGED. The login of the
    /// user / app that performed the merge.
    pub merged_by: Option<String>,
    /// Stage 8J — populated only when state == MERGED. ISO-8601 merge ts.
    pub merged_at: Option<String>,
    /// Stage 8J — `closingIssuesReferences` from gh. Each entry surfaces
    /// in the right-rail Related tasks card. Empty when none.
    pub related_issues: Vec<PrRelatedIssue>,
}

#[derive(Serialize, Clone)]
pub struct PrRelatedIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// "OPEN" | "CLOSED".
    pub state: String,
}

/// Result of a native PR creation. The frontend uses the number to open the
/// freshly-created PR in Aura immediately, without scraping `gh` output.
#[derive(Serialize, Clone)]
pub struct PrCreated {
    pub number: u64,
    pub title: String,
    pub url: String,
}

/// One GitHub issue offered by the workspace composer. This deliberately
/// keeps the issue body: selecting it seeds the agent with the real problem,
/// not only a lossy title.
#[derive(Serialize, Clone)]
pub struct GithubIssue {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: String,
    pub labels: Vec<String>,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
pub struct PrReviewer {
    pub login: String,
    /// "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING".
    pub state: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AuraReviewPayload {
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub risk_score: i64,
    #[serde(default)]
    pub risk_label: String,
    #[serde(default)]
    pub total_changes: i64,
    #[serde(default)]
    pub invariant_violations: Vec<String>,
    #[serde(default)]
    pub blast_radius: Vec<String>,
    #[serde(default)]
    pub cross_branch_conflicts: Vec<String>,
    #[serde(default)]
    pub omni_graph_impact: Vec<String>,
    #[serde(default)]
    pub unverified_nodes: serde_json::Value,
    // Humanized surface (pr_humanize). Pass-through to the frontend as opaque
    // JSON so this struct doesn't have to mirror the engine shapes; empty when
    // the review was produced by an older binary.
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<serde_json::Value>,
    #[serde(default)]
    pub changes: Vec<serde_json::Value>,
}

// ── gh shell helpers ──────────────────────────────────────────────────

fn run_gh(repo_root: &str, args: &[&str]) -> Result<String, String> {
    let cwd = PathBuf::from(repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }
    let out = Command::new("gh")
        .args(args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "gh CLI not found — install from https://cli.github.com/ then run `gh auth login`".to_string()
            } else {
                format!("failed to spawn gh: {}", e)
            }
        })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let trimmed = stderr.trim();
        if trimmed.is_empty() {
            return Err(format!("gh exited with status {}", out.status.code().unwrap_or(-1)));
        }
        return Err(trimmed.to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_git(repo_root: &str, args: &[&str]) -> Result<String, String> {
    let cwd = PathBuf::from(repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }
    let out = Command::new("git")
        .args(args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to spawn git: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            format!("git exited with status {}", out.status.code().unwrap_or(-1))
        } else {
            message.to_string()
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn current_branch(repo_root: &str, requested: Option<&str>) -> Result<String, String> {
    let branch = requested
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            run_git(repo_root, &["branch", "--show-current"])
                .unwrap_or_default()
                .trim()
                .to_string()
        });
    if branch.is_empty() {
        return Err("can't create a PR from a detached HEAD".to_string());
    }
    run_git(repo_root, &["check-ref-format", "--branch", &branch])?;
    Ok(branch)
}

/// A PR must point at the commits the author just reviewed in the dialog.
/// Push the selected branch before `gh pr create`; set its upstream on the
/// first push so subsequent worktree actions have real ahead/behind state.
fn push_branch(repo_root: &str, branch: &str) -> Result<(), String> {
    let has_upstream = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .current_dir(repo_root)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if has_upstream {
        run_git(repo_root, &["push"])?;
    } else {
        run_git(repo_root, &["push", "--set-upstream", "origin", branch])?;
    }
    Ok(())
}

fn create_args(
    head_branch: &str,
    title: &str,
    body: &str,
    base_branch: Option<&str>,
    draft: bool,
) -> Vec<String> {
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--head".to_string(),
        head_branch.to_string(),
        "--title".to_string(),
        title.to_string(),
        "--body".to_string(),
        body.to_string(),
    ];
    if let Some(base) = base_branch.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--base".to_string());
        args.push(base.to_string());
    }
    if draft {
        args.push("--draft".to_string());
    }
    args
}

fn edit_args(
    pr_number: u64,
    title: &str,
    body: &str,
    base_branch: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "pr".to_string(),
        "edit".to_string(),
        pr_number.to_string(),
        "--title".to_string(),
        title.to_string(),
        "--body".to_string(),
        body.to_string(),
    ];
    if let Some(base) = base_branch.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--base".to_string());
        args.push(base.to_string());
    }
    args
}

// ── Aura review enrichment ────────────────────────────────────────────

/// Walk `.aura/reviews/*.json` in the repo, return the most recent one
/// whose `base_branch` matches `base_ref`. Best-effort — any IO/parse
/// failure returns None so the UI just omits the Aura chip.
fn latest_aura_review(repo_root: &str, base_ref: &str) -> Option<AuraReviewPayload> {
    let dir = PathBuf::from(repo_root).join(".aura").join("reviews");
    let entries = fs::read_dir(&dir).ok()?;
    let mut best: Option<(i64, AuraReviewPayload)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let body = match fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let payload: AuraReviewPayload = match serde_json::from_str(&body) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if payload.base_branch != base_ref {
            continue;
        }
        let ts = payload.ts;
        match &best {
            Some((cur_ts, _)) if *cur_ts >= ts => {}
            _ => {
                best = Some((ts, payload));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Scan `.aura/reviews/*.json` **once** and return the newest review per
/// base branch. The list path previously called `latest_aura_review` per
/// PR — each call re-read and re-parsed the entire reviews directory, so a
/// repo with M review files and N PRs paid O(N·M) disk + parse. One scan
/// builds the whole map; callers index by `base_ref` for free.
fn reviews_by_base(repo_root: &str) -> std::collections::HashMap<String, AuraReviewPayload> {
    let mut out: std::collections::HashMap<String, AuraReviewPayload> =
        std::collections::HashMap::new();
    let dir = PathBuf::from(repo_root).join(".aura").join("reviews");
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let body = match fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let payload: AuraReviewPayload = match serde_json::from_str(&body) {
            Ok(p) => p,
            Err(_) => continue,
        };
        match out.get(&payload.base_branch) {
            Some(cur) if cur.ts >= payload.ts => {}
            _ => {
                out.insert(payload.base_branch.clone(), payload);
            }
        }
    }
    out
}

// ── Tauri commands ────────────────────────────────────────────────────

/// Coerce a present-but-`null` JSON value to the type's `Default`.
///
/// gh's `--json` output uses an explicit `null` — not an absent key — for
/// several fields: `statusCheckRollup` on a branch-promotion PR (e.g. a
/// `main → staging` chore PR has no head-commit rollup), `reviewDecision`
/// on an un-reviewed PR, a CheckRun's `conclusion` while it's still
/// running. `#[serde(default)]` only fills a *missing* key, so a present
/// `null` deserializing into a `Vec`/`String` errors ("invalid type:
/// null, expected a sequence") and poisons the parse of the WHOLE list —
/// one such PR makes every PR fail to load with a generic "Couldn't load
/// from GitHub". Pair this with `#[serde(default, deserialize_with =
/// "null_to_default")]` so a missing key *and* a present `null` both fall
/// back to `Default`.
fn null_to_default<'de, D, T>(de: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(de)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct GhPrSummary {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    author: GhUser,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
    #[serde(default, rename = "isDraft")]
    is_draft: bool,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default, rename = "createdAt")]
    created_at: String,
    #[serde(default, rename = "updatedAt")]
    updated_at: String,
    #[serde(default, rename = "reviewDecision", deserialize_with = "null_to_default")]
    review_decision: String,
    #[serde(default)]
    url: String,
    #[serde(default, rename = "reviewRequests")]
    review_requests: Vec<GhUser>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    // CI rollup returned inline by `gh pr list --json statusCheckRollup` —
    // every PR's check state in the SINGLE list request, so we never fan
    // out a `gh pr checks` call per PR (the old path was 1 + N GitHub
    // requests and tripped the secondary "too many requests" rate limit).
    #[serde(default, rename = "statusCheckRollup", deserialize_with = "null_to_default")]
    status_check_rollup: Vec<GhRollupEntry>,
}

#[derive(Deserialize, Default)]
struct GhUser {
    #[serde(default)]
    login: String,
}

/// One node of GitHub's `statusCheckRollup`. The array mixes CheckRun
/// (Actions: `status` lifecycle + `conclusion` result) and StatusContext
/// (classic commit statuses: `state`) nodes, so every field is optional
/// and we bucket from whichever is present. The name/url fields are only
/// read by `pr_checks` (the per-check detail view); `pr_list` summarizes
/// counts and ignores them.
#[derive(Deserialize, Default)]
struct GhRollupEntry {
    #[serde(default, deserialize_with = "null_to_default")]
    status: String,
    #[serde(default, deserialize_with = "null_to_default")]
    conclusion: String,
    #[serde(default, deserialize_with = "null_to_default")]
    state: String,
    // CheckRun.name / StatusContext.context — the human label of the check.
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    context: String,
    // CheckRun.detailsUrl / StatusContext.targetUrl — the logs deep-link.
    #[serde(default, rename = "detailsUrl", deserialize_with = "null_to_default")]
    details_url: String,
    #[serde(default, rename = "targetUrl", deserialize_with = "null_to_default")]
    target_url: String,
    // CheckRun.workflowName — the Actions workflow this run belongs to.
    #[serde(default, rename = "workflowName", deserialize_with = "null_to_default")]
    workflow_name: String,
    // StatusContext.description — a short "why" line on classic statuses.
    #[serde(default, deserialize_with = "null_to_default")]
    description: String,
}

/// Bucket one rollup entry's winning signal into "success" | "failure" |
/// "pending". Shared by `summarize_rollup` (counts) and `pr_checks`
/// (per-check state) so the two can never disagree on what "failing" means.
fn signal_for(r: &GhRollupEntry) -> &'static str {
    let signal = if !r.conclusion.is_empty() {
        r.conclusion.as_str()
    } else if !r.status.is_empty() && r.status.to_uppercase() != "COMPLETED" {
        r.status.as_str()
    } else if !r.state.is_empty() {
        r.state.as_str()
    } else {
        r.status.as_str()
    };
    match signal.to_uppercase().as_str() {
        "SUCCESS" | "PASS" | "NEUTRAL" | "SKIPPED" | "SKIPPING" => "success",
        "FAILURE" | "FAIL" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
        | "STARTUP_FAILURE" | "STALE" => "failure",
        // QUEUED / IN_PROGRESS / PENDING / WAITING / REQUESTED / EXPECTED / ""
        _ => "pending",
    }
}

/// The raw GitHub signal string (conclusion → status → state) for a
/// rollup entry, surfaced verbatim so the UI can show "timed_out" vs a
/// generic "failing" on hover.
fn raw_signal(r: &GhRollupEntry) -> String {
    if !r.conclusion.is_empty() {
        r.conclusion.clone()
    } else if !r.status.is_empty() {
        r.status.clone()
    } else {
        r.state.clone()
    }
}

/// One CI check on a PR, flattened for the desktop Checks tab. `bucket` is
/// the normalized state the UI colours from; `raw` is the underlying
/// GitHub signal for the tooltip; `url` opens the run's logs.
#[derive(Serialize)]
pub struct PrCheck {
    pub name: String,
    pub bucket: String,
    pub raw: String,
    pub url: String,
    pub workflow: String,
    pub description: String,
}

/// The individual CI checks on one PR (name + state + logs link), for the
/// desktop Checks tab. `pr_list` only carries rolled-up counts; this pulls
/// the per-check detail from the SAME `statusCheckRollup` GitHub already
/// exposes, so it's one cached `gh pr view` call and no new integration.
#[tauri::command]
pub async fn pr_checks(repo_root: String, number: u64) -> Result<Vec<PrCheck>, String> {
    let stdout = run_gh(
        &repo_root,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "statusCheckRollup",
        ],
    )?;
    #[derive(Deserialize, Default)]
    struct Wrap {
        #[serde(
            default,
            rename = "statusCheckRollup",
            deserialize_with = "null_to_default"
        )]
        status_check_rollup: Vec<GhRollupEntry>,
    }
    let wrap: Wrap =
        serde_json::from_str(&stdout).map_err(|e| format!("gh json parse: {}", e))?;
    let out = wrap
        .status_check_rollup
        .iter()
        .map(|r| {
            let name = if !r.name.is_empty() {
                r.name.clone()
            } else if !r.context.is_empty() {
                r.context.clone()
            } else {
                "check".to_string()
            };
            let url = if !r.details_url.is_empty() {
                r.details_url.clone()
            } else {
                r.target_url.clone()
            };
            PrCheck {
                name,
                bucket: signal_for(r).to_string(),
                raw: raw_signal(r),
                url,
                workflow: r.workflow_name.clone(),
                description: r.description.clone(),
            }
        })
        .collect();
    Ok(out)
}

#[derive(Deserialize, Default)]
struct GhLabel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    description: String,
}

const PR_LIST_FIELDS: &str = "number,title,state,author,headRefName,baseRefName,isDraft,additions,deletions,createdAt,updatedAt,reviewDecision,url,reviewRequests,labels,statusCheckRollup";

/// List PRs in the repo via `gh pr list --json …`. Passes `--state all`
/// so the Inbox can bucket Approved / Merged / Closed alongside open
/// PRs — `--state open` only ever fed Open + Drafts + Review-Requested
/// and starved the other buckets. Limit bumped to 200 for headroom on
/// busy repos; the desktop sidebar paginates client-side.
#[tauri::command]
pub async fn pr_list(repo_root: String) -> Result<Vec<PrSummary>, String> {
    let stdout = run_gh(
        &repo_root,
        &["pr", "list", "--limit", "200", "--state", "all", "--json", PR_LIST_FIELDS],
    )?;
    let raw: Vec<GhPrSummary> =
        serde_json::from_str(&stdout).map_err(|e| format!("gh json parse: {}", e))?;
    // Resolve the gh viewer once per call so Inbox bucketing has a stable
    // "is this me" answer. Empty string falls through as "no match".
    let viewer = viewer_login(&repo_root).unwrap_or_default();
    // One disk scan for all reviews; CI state comes from each PR's inline
    // statusCheckRollup (already in `raw`) — so the whole list is exactly
    // ONE GitHub request, not 1 + N. This is what keeps us off GitHub's
    // secondary rate limit on busy repos.
    let reviews = reviews_by_base(&repo_root);
    let out = raw
        .into_iter()
        .map(|p| {
            let aura = reviews.get(&p.base_ref_name);
            // CI checks summarized from the inline rollup — no network.
            let checks = summarize_rollup(&p.status_check_rollup);
            let is_authored_by_me =
                !viewer.is_empty() && p.author.login.eq_ignore_ascii_case(&viewer);
            let is_review_requested_for_me = !viewer.is_empty()
                && p.review_requests
                    .iter()
                    .any(|u| u.login.eq_ignore_ascii_case(&viewer));
            PrSummary {
                number: p.number,
                title: p.title,
                state: p.state,
                author: p.author.login,
                head_ref: p.head_ref_name,
                base_ref: p.base_ref_name,
                is_draft: p.is_draft,
                additions: p.additions,
                deletions: p.deletions,
                created_at: p.created_at,
                updated_at: p.updated_at,
                review_decision: empty_to_none(p.review_decision),
                url: p.url,
                aura_risk_score: aura.as_ref().map(|a| a.risk_score),
                aura_risk_label: aura.as_ref().map(|a| a.risk_label.clone()),
                checks_state: checks.state,
                checks_total: checks.total,
                checks_passing: checks.passing,
                checks_failing: checks.failing,
                checks_pending: checks.pending,
                is_authored_by_me,
                is_review_requested_for_me,
                labels: p
                    .labels
                    .into_iter()
                    .map(|l| PrLabel {
                        name: l.name,
                        color: l.color,
                        description: l.description,
                    })
                    .collect(),
            }
        })
        .collect();
    Ok(out)
}

/// List repository issues through the same authenticated `gh` session as PRs.
/// `gh issue list` excludes pull requests and returns only real issues.
#[tauri::command]
pub async fn github_issue_list(repo_root: String) -> Result<Vec<GithubIssue>, String> {
    const FIELDS: &str =
        "number,title,body,state,author,labels,url,createdAt,updatedAt";
    let stdout = run_gh(
        &repo_root,
        &["issue", "list", "--state", "open", "--limit", "200", "--json", FIELDS],
    )?;
    #[derive(Deserialize, Default)]
    struct IssueAuthor {
        #[serde(default)]
        login: String,
    }
    #[derive(Deserialize, Default)]
    struct IssueLabel {
        #[serde(default)]
        name: String,
    }
    #[derive(Deserialize)]
    struct RawIssue {
        number: u64,
        title: String,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        state: String,
        #[serde(default)]
        author: Option<IssueAuthor>,
        #[serde(default)]
        labels: Vec<IssueLabel>,
        #[serde(default)]
        url: String,
        #[serde(default, rename = "createdAt")]
        created_at: String,
        #[serde(default, rename = "updatedAt")]
        updated_at: String,
    }
    let raw: Vec<RawIssue> = serde_json::from_str(&stdout)
        .map_err(|e| format!("gh issue list parse: {}", e))?;
    Ok(raw
        .into_iter()
        .map(|issue| GithubIssue {
            number: issue.number,
            title: issue.title,
            body: issue.body.unwrap_or_default(),
            state: issue.state,
            author: issue.author.unwrap_or_default().login,
            labels: issue
                .labels
                .into_iter()
                .map(|label| label.name)
                .filter(|name| !name.is_empty())
                .collect(),
            url: issue.url,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
        })
        .collect())
}

/// Create a GitHub pull request directly from the desktop authoring dialog.
/// This intentionally owns the push as part of the same user action: the PR
/// always represents the local branch state the dialog was opened from.
#[tauri::command]
pub async fn pr_create(
    repo_root: String,
    head_branch: Option<String>,
    title: String,
    body: String,
    base_branch: Option<String>,
    draft: bool,
) -> Result<PrCreated, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("pull request title can't be empty".to_string());
    }
    let branch = current_branch(&repo_root, head_branch.as_deref())?;
    push_branch(&repo_root, &branch)?;

    let args = create_args(
        &branch,
        title,
        body.trim(),
        base_branch.as_deref(),
        draft,
    );
    let argrefs: Vec<&str> = args.iter().map(String::as_str).collect();
    let created_stdout = run_gh(&repo_root, &argrefs)?;
    let created_url = created_stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("https://") || line.starts_with("http://"));
    let target = created_url.unwrap_or(&branch);
    let view = run_gh(
        &repo_root,
        &["pr", "view", target, "--json", "number,title,url"],
    )?;
    #[derive(Deserialize)]
    struct CreatedView {
        number: u64,
        title: String,
        url: String,
    }
    let parsed: CreatedView = serde_json::from_str(&view)
        .map_err(|e| format!("gh pr view created PR parse: {}", e))?;
    Ok(PrCreated {
        number: parsed.number,
        title: parsed.title,
        url: parsed.url,
    })
}

/// Edit the author-controlled PR metadata. Draft/ready is a separate gh
/// operation, so first read its current state and only toggle when needed.
#[tauri::command]
pub async fn pr_edit(
    repo_root: String,
    pr_number: u64,
    title: String,
    body: String,
    base_branch: Option<String>,
    draft: bool,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("pull request title can't be empty".to_string());
    }
    let args = edit_args(pr_number, title, body.trim(), base_branch.as_deref());
    let argrefs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_gh(&repo_root, &argrefs)?;

    let current = run_gh(
        &repo_root,
        &["pr", "view", &pr_number.to_string(), "--json", "isDraft"],
    )?;
    #[derive(Deserialize)]
    struct DraftView {
        #[serde(rename = "isDraft")]
        is_draft: bool,
    }
    let current: DraftView = serde_json::from_str(&current)
        .map_err(|e| format!("gh pr view draft state parse: {}", e))?;
    if draft != current.is_draft {
        let number = pr_number.to_string();
        if draft {
            run_gh(&repo_root, &["pr", "ready", &number, "--undo"])?;
        } else {
            run_gh(&repo_root, &["pr", "ready", &number])?;
        }
    }
    Ok(())
}

/// List all labels defined in the repo (not just PR-attached) so the
/// label picker can show the universe of choices. Backed by
/// `gh label list --json name,color,description --limit 200`.
#[tauri::command]
pub async fn pr_labels_list(repo_root: String) -> Result<Vec<PrLabel>, String> {
    let stdout = run_gh(
        &repo_root,
        &[
            "label",
            "list",
            "--limit",
            "200",
            "--json",
            "name,color,description",
        ],
    )?;
    let raw: Vec<GhLabel> = serde_json::from_str(&stdout)
        .map_err(|e| format!("gh label list parse: {}", e))?;
    Ok(raw
        .into_iter()
        .map(|l| PrLabel {
            name: l.name,
            color: l.color,
            description: l.description,
        })
        .collect())
}

/// Replace the labels on a PR with `names`. Diffs against the PR's
/// current labels and uses `gh pr edit --add-label / --remove-label`
/// to keep round-trips minimal — gh doesn't have a "set labels"
/// primitive.
#[tauri::command]
pub async fn pr_labels_set(
    repo_root: String,
    pr_number: u64,
    names: Vec<String>,
) -> Result<(), String> {
    // Fetch current labels for diff.
    let stdout = run_gh(
        &repo_root,
        &[
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "labels",
        ],
    )?;
    #[derive(Deserialize)]
    struct V {
        #[serde(default)]
        labels: Vec<GhLabel>,
    }
    let v: V = serde_json::from_str(&stdout)
        .map_err(|e| format!("gh pr view labels parse: {}", e))?;
    let current: std::collections::HashSet<String> =
        v.labels.into_iter().map(|l| l.name).collect();
    let want: std::collections::HashSet<String> = names.into_iter().collect();

    let to_add: Vec<&String> = want.difference(&current).collect();
    let to_remove: Vec<&String> = current.difference(&want).collect();

    if to_add.is_empty() && to_remove.is_empty() {
        return Ok(());
    }

    let mut args: Vec<String> = vec![
        "pr".into(),
        "edit".into(),
        pr_number.to_string(),
    ];
    for name in &to_add {
        args.push("--add-label".into());
        args.push((*name).clone());
    }
    for name in &to_remove {
        args.push("--remove-label".into());
        args.push((*name).clone());
    }
    let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_gh(&repo_root, &argrefs)?;
    Ok(())
}

/// Edit a PR's title and/or body via `gh pr edit`. Either field may be
/// `None` to leave it unchanged (so the UI can save the title alone, the
/// body alone, or both). Passing neither is a no-op rather than an error.
#[tauri::command]
pub async fn pr_update(
    repo_root: String,
    pr_number: u64,
    title: Option<String>,
    body: Option<String>,
) -> Result<(), String> {
    let mut args: Vec<String> = vec!["pr".into(), "edit".into(), pr_number.to_string()];
    if let Some(t) = &title {
        args.push("--title".into());
        args.push(t.clone());
    }
    if let Some(b) = &body {
        args.push("--body".into());
        args.push(b.clone());
    }
    // No fields supplied — nothing to edit.
    if args.len() == 3 {
        return Ok(());
    }
    let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_gh(&repo_root, &argrefs)?;
    Ok(())
}

/// `gh api user --jq .login` — returns the authenticated viewer login.
/// Used by Inbox to bucket PRs by Yours / Reviewing-for-me. Cheap (gh
/// caches it after the first call). Empty when gh isn't authenticated.
#[tauri::command]
pub async fn pr_whoami(repo_root: String) -> Result<String, String> {
    viewer_login(&repo_root)
}

/// Internal: same as `pr_whoami` but returns Result for use during
/// `pr_list` enrichment. Kept private so callers don't have to round-trip
/// through Tauri.
fn viewer_login(repo_root: &str) -> Result<String, String> {
    let stdout = run_gh(repo_root, &["api", "user", "--jq", ".login"])?;
    Ok(stdout.trim().to_string())
}

#[derive(Default, Clone)]
struct ChecksSummary {
    state: Option<String>,
    total: u32,
    passing: u32,
    failing: u32,
    pending: u32,
}

/// Summarize a PR's inline `statusCheckRollup` into pass/fail/pending
/// counts — no network, pure CPU over data already in the list response.
/// Mirrors the old per-PR `gh pr checks` bucketing: a CheckRun reports a
/// `status` lifecycle (+ `conclusion` once COMPLETED); a classic
/// StatusContext reports a `state`. We read conclusion → status → state in
/// that order. Returns an all-zero summary (state None) when the rollup is
/// empty, which the UI renders as "no checks".
fn summarize_rollup(rows: &[GhRollupEntry]) -> ChecksSummary {
    if rows.is_empty() {
        return ChecksSummary::default();
    }
    let mut sum = ChecksSummary {
        total: rows.len() as u32,
        ..Default::default()
    };
    let mut any_fail = false;
    let mut any_pending = false;
    for r in rows {
        // Prefer the CheckRun conclusion; fall back to its lifecycle status
        // (anything not COMPLETED is still pending); finally the classic
        // StatusContext state.
        let signal = if !r.conclusion.is_empty() {
            r.conclusion.as_str()
        } else if !r.status.is_empty() && r.status.to_uppercase() != "COMPLETED" {
            r.status.as_str()
        } else if !r.state.is_empty() {
            r.state.as_str()
        } else {
            r.status.as_str()
        };
        match signal.to_uppercase().as_str() {
            "SUCCESS" | "PASS" | "NEUTRAL" | "SKIPPED" | "SKIPPING" => sum.passing += 1,
            "FAILURE" | "FAIL" | "ERROR" | "CANCELLED" | "TIMED_OUT"
            | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE" => {
                sum.failing += 1;
                any_fail = true;
            }
            _ => {
                // QUEUED / IN_PROGRESS / PENDING / WAITING / REQUESTED / EXPECTED / ""
                sum.pending += 1;
                any_pending = true;
            }
        }
    }
    sum.state = Some(
        if any_fail {
            "failure"
        } else if any_pending {
            "pending"
        } else {
            "success"
        }
        .to_string(),
    );
    sum
}

#[derive(Deserialize)]
struct GhPrDetail {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    author: GhUser,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
    #[serde(default, rename = "isDraft")]
    is_draft: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    mergeable: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default, rename = "createdAt")]
    created_at: String,
    #[serde(default, rename = "updatedAt")]
    updated_at: String,
    #[serde(default, rename = "reviewDecision", deserialize_with = "null_to_default")]
    review_decision: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    files: Vec<GhPrFile>,
    #[serde(default, rename = "reviewRequests")]
    review_requests: Vec<GhUser>,
    #[serde(default, rename = "latestReviews")]
    latest_reviews: Vec<GhLatestReview>,
    #[serde(default)]
    assignees: Vec<GhUser>,
    #[serde(default, rename = "mergedBy")]
    merged_by: Option<GhUser>,
    /// gh returns `null` for non-merged PRs — Option<String> so serde
    /// accepts the null value (a bare String would crash with
    /// "invalid type: null, expected a string").
    #[serde(default, rename = "mergedAt")]
    merged_at: Option<String>,
    #[serde(default, rename = "closingIssuesReferences")]
    closing_issues: Vec<GhRelatedIssue>,
}

#[derive(Deserialize, Default, Clone)]
struct GhRelatedIssue {
    // All fields default to None so a partially-populated reference
    // (e.g. cross-repo issue with restricted visibility) can't crash
    // the whole pr_detail call.
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

#[derive(Deserialize)]
struct GhPrFile {
    path: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
}

#[derive(Deserialize, Default)]
struct GhLatestReview {
    #[serde(default)]
    author: GhUser,
    #[serde(default)]
    state: String,
}

const PR_DETAIL_FIELDS: &str = "number,title,state,body,author,headRefName,baseRefName,isDraft,mergeable,additions,deletions,createdAt,updatedAt,reviewDecision,url,files,reviewRequests,latestReviews,assignees,mergedBy,mergedAt,closingIssuesReferences";

/// Fetch a single PR's metadata + file list + unified diff. Two `gh`
/// calls — `pr view` for structured fields, `pr diff` for the patch.
///
/// The whole chain is wrapped in a 30s timeout so a wedged gh process
/// can't stall the UI. If `gh pr diff` fails (auth scope missing,
/// network, etc.) we fall through to a `git fetch pull/N/head` + local
/// `git diff <base>...` strategy before giving up and surfacing the
/// error in `diff_error`.
#[tauri::command]
pub async fn pr_detail(repo_root: String, pr_number: u64) -> Result<PrDetail, String> {
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        pr_detail_inner(repo_root, pr_number),
    )
    .await;
    match result {
        Ok(inner) => inner,
        Err(_) => Err("pr_detail timed out after 30s — gh CLI may be hung; try `gh auth status`".to_string()),
    }
}

async fn pr_detail_inner(repo_root: String, pr_number: u64) -> Result<PrDetail, String> {
    let view = run_gh(
        &repo_root,
        &["pr", "view", &pr_number.to_string(), "--json", PR_DETAIL_FIELDS],
    )?;
    let raw: GhPrDetail =
        serde_json::from_str(&view).map_err(|e| format!("gh json parse: {}", e))?;
    let (diff, diff_error) =
        fetch_pr_diff(&repo_root, pr_number, &raw.base_ref_name).await;
    let aura = latest_aura_review(&repo_root, &raw.base_ref_name);
    Ok(PrDetail {
        number: raw.number,
        title: raw.title,
        state: raw.state,
        body: raw.body,
        author: raw.author.login,
        head_ref: raw.head_ref_name,
        base_ref: raw.base_ref_name,
        is_draft: raw.is_draft,
        mergeable: empty_to_none(raw.mergeable),
        additions: raw.additions,
        deletions: raw.deletions,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        review_decision: empty_to_none(raw.review_decision),
        url: raw.url,
        files: raw
            .files
            .into_iter()
            .map(|f| PrFile {
                path: f.path,
                additions: f.additions,
                deletions: f.deletions,
            })
            .collect(),
        diff,
        diff_error,
        aura_review: aura,
        reviewers: build_reviewers(&raw.latest_reviews, &raw.review_requests),
        assignees: raw
            .assignees
            .iter()
            .map(|u| u.login.clone())
            .filter(|l| !l.is_empty())
            .collect(),
        merged_by: raw.merged_by.and_then(|u| {
            if u.login.is_empty() {
                None
            } else {
                Some(u.login)
            }
        }),
        merged_at: raw.merged_at.and_then(empty_to_none),
        related_issues: raw
            .closing_issues
            .into_iter()
            .filter_map(|i| {
                let number = i.number?;
                if number == 0 {
                    return None;
                }
                Some(PrRelatedIssue {
                    number,
                    title: i.title.unwrap_or_default(),
                    url: i.url.unwrap_or_default(),
                    state: i.state.unwrap_or_default(),
                })
            })
            .collect(),
    })
}

/// Run `gh pr diff` with full stdout/stderr capture; fall back to a
/// local `git fetch origin pull/N/head` + `git diff base...` chain when
/// gh returns nothing useful. Returns `(diff, diff_error)` — at most
/// one is populated. The fallback is bounded by a 20s timeout so a
/// slow network can't hold the inbox open.
async fn fetch_pr_diff(
    repo_root: &str,
    pr_number: u64,
    base_ref: &str,
) -> (String, Option<String>) {
    let cwd = PathBuf::from(repo_root);

    let gh_out = tokio::process::Command::new("gh")
        .args(["pr", "diff", &pr_number.to_string()])
        .current_dir(&cwd)
        .output()
        .await;

    let gh_err = match gh_out {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&o.stderr).into_owned();
            if o.status.success() && !stdout.is_empty() {
                return (stdout, None);
            }
            // gh succeeded but stdout was empty AND stderr was empty: this
            // is a legitimate description-only PR. Bubble up the empty
            // diff without a synthetic error.
            if o.status.success() && stderr.trim().is_empty() {
                return (String::new(), None);
            }
            let code = o.status.code().unwrap_or(-1);
            if stderr.trim().is_empty() {
                format!("gh pr diff exited with status {}", code)
            } else {
                format!("gh pr diff: {}", stderr.trim())
            }
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                "gh CLI not found — install from https://cli.github.com/".to_string()
            } else {
                format!("failed to spawn gh pr diff: {}", e)
            }
        }
    };

    // Primary fallback: GitHub's per-file API (`pulls/N/files --paginate`).
    // This is the robust path for the two cases `gh pr diff` chokes on:
    //   • PRs over the 300-file cap → `gh pr diff` returns HTTP 406
    //     ("the diff exceeded the maximum number of files").
    //   • Already-merged PRs → a 3-dot `git diff base...head` resolves to
    //     an empty diff because the merge already folded head into base.
    // The files API paginates past the cap and ignores merge state; we
    // re-synthesize the `diff --git`/`---`/`+++` headers the frontend
    // splitter and unified renderer expect from each entry's `patch`.
    let api_err: Option<String>;
    match repo_owner_path(repo_root) {
        Ok(owner_repo) => {
            let api = tokio::time::timeout(
                Duration::from_secs(30),
                files_api_fallback(&cwd, &owner_repo, pr_number),
            )
            .await;
            match api {
                Ok(Ok(diff)) if !diff.is_empty() => return (diff, None),
                Ok(Ok(_)) => {
                    api_err = Some("files API returned no changed files".to_string())
                }
                Ok(Err(e)) => api_err = Some(e),
                Err(_) => api_err = Some("files API timed out after 30s".to_string()),
            }
        }
        Err(e) => api_err = Some(format!("could not resolve owner/repo: {}", e)),
    }

    // Secondary fallback: ask local git for the diff via the pull/<N>/head
    // ref. `git fetch` may fail with "couldn't find remote ref" on forks
    // the user hasn't cloned; we surface that case via diff_error so the
    // user knows to re-authenticate gh rather than guessing.
    let fallback = tokio::time::timeout(
        Duration::from_secs(20),
        git_diff_fallback(&cwd, pr_number, base_ref),
    )
    .await;
    let git_msg = match fallback {
        Ok(Ok(diff)) if !diff.is_empty() => return (diff, None),
        Ok(Ok(_)) => "git fallback returned an empty diff".to_string(),
        Ok(Err(git_err)) => format!("git fallback also failed: {}", git_err),
        Err(_) => "git fallback timed out after 20s".to_string(),
    };

    let detail = match api_err {
        Some(a) => format!("{} — files API: {} — {}", gh_err, a, git_msg),
        None => format!("{} — {}", gh_err, git_msg),
    };
    (String::new(), Some(detail))
}

async fn git_diff_fallback(
    cwd: &std::path::Path,
    pr_number: u64,
    base_ref: &str,
) -> Result<String, String> {
    let local_ref = format!("aura-pr-{}", pr_number);
    // `git fetch origin pull/N/head:aura-pr-N` may report "already
    // exists" with a non-zero exit; treat that as success because the
    // ref is exactly what we need. We only error out when stderr
    // doesn't match the known-benign patterns.
    let fetch = tokio::process::Command::new("git")
        .args([
            "fetch",
            "origin",
            &format!("pull/{}/head:{}", pr_number, local_ref),
        ])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("git fetch spawn: {}", e))?;
    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr);
        let lower = stderr.to_lowercase();
        let benign = lower.contains("already exists")
            || lower.contains("would clobber existing tag")
            || lower.contains("[new branch]");
        if !benign {
            return Err(format!("git fetch: {}", stderr.trim()));
        }
    }

    let diff = tokio::process::Command::new("git")
        .args([
            "diff",
            &format!("origin/{}...{}", base_ref, local_ref),
        ])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("git diff spawn: {}", e))?;
    if !diff.status.success() {
        let stderr = String::from_utf8_lossy(&diff.stderr);
        return Err(format!("git diff: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&diff.stdout).into_owned())
}

/// One entry from `GET repos/:owner/:repo/pulls/:n/files`. We only read
/// the fields needed to rebuild a unified diff; serde ignores the rest.
/// (Distinct from `GhPrFile` above, which is the `gh pr view --json files`
/// shape — path/additions/deletions, no patch.)
#[derive(Deserialize)]
struct GhPrFileEntry {
    filename: String,
    /// added | removed | modified | renamed | changed | copied | unchanged
    status: String,
    /// The per-file hunks (`@@ … @@` blocks). GitHub omits this for binary
    /// files and for pure renames with no content change.
    #[serde(default)]
    patch: Option<String>,
    /// Set when `status == "renamed"`; the path before the rename.
    #[serde(default)]
    previous_filename: Option<String>,
}

/// `gh api … --paginate` concatenates one JSON array per page. Older gh
/// emits them back-to-back (`[…][…]`, not valid as a single document),
/// newer gh with `--slurp` merges them — so we stream-parse a sequence of
/// arrays, which handles both shapes plus trailing whitespace.
fn parse_paginated_files(s: &str) -> Result<Vec<GhPrFileEntry>, String> {
    let mut out: Vec<GhPrFileEntry> = Vec::new();
    let stream = serde_json::Deserializer::from_str(s).into_iter::<Vec<GhPrFileEntry>>();
    for chunk in stream {
        match chunk {
            Ok(mut v) => out.append(&mut v),
            // A trailing parse error after we already have entries means we
            // hit inter-page whitespace / EOF — keep what parsed cleanly.
            Err(e) => {
                if out.is_empty() {
                    return Err(format!("parse files json: {}", e));
                }
                break;
            }
        }
    }
    Ok(out)
}

/// Rebuild a single file's unified-diff block from a files-API entry.
/// GitHub's `patch` carries only the `@@` hunks, so we prepend the
/// `diff --git a/… b/…` header the frontend splitter keys on plus the
/// `---`/`+++` lines the unified renderer needs.
fn synthesize_file_diff(f: &GhPrFileEntry) -> String {
    let path = &f.filename;
    let prev = f.previous_filename.as_deref().unwrap_or(path);
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{} b/{}\n", prev, path));
    match f.status.as_str() {
        "added" => {
            out.push_str("new file mode 100644\n");
            out.push_str("--- /dev/null\n");
            out.push_str(&format!("+++ b/{}\n", path));
        }
        "removed" => {
            out.push_str("deleted file mode 100644\n");
            out.push_str(&format!("--- a/{}\n", prev));
            out.push_str("+++ /dev/null\n");
        }
        "renamed" => {
            out.push_str(&format!("rename from {}\n", prev));
            out.push_str(&format!("rename to {}\n", path));
            out.push_str(&format!("--- a/{}\n", prev));
            out.push_str(&format!("+++ b/{}\n", path));
        }
        _ => {
            out.push_str(&format!("--- a/{}\n", prev));
            out.push_str(&format!("+++ b/{}\n", path));
        }
    }
    match &f.patch {
        Some(p) if !p.is_empty() => {
            out.push_str(p);
            if !p.ends_with('\n') {
                out.push('\n');
            }
        }
        // No patch: binary content (note it) or a pure rename (header alone
        // already tells the story — don't fake a content line).
        _ => {
            if f.status != "renamed" {
                out.push_str(&format!("Binary files a/{} and b/{} differ\n", prev, path));
            }
        }
    }
    out
}

/// Last-resort diff via `GET repos/:owner/:repo/pulls/:n/files`, paginated.
/// Bypasses the 300-file `gh pr diff` cap and merged-PR empty-diff problem
/// by stitching per-file patches back into one unified diff. Returns an
/// empty string when the PR genuinely changed nothing.
async fn files_api_fallback(
    cwd: &std::path::Path,
    owner_repo: &str,
    pr_number: u64,
) -> Result<String, String> {
    let endpoint = format!("repos/{}/pulls/{}/files", owner_repo, pr_number);
    let out = tokio::process::Command::new("gh")
        .args(["api", &endpoint, "--paginate"])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "gh CLI not found — install from https://cli.github.com/".to_string()
            } else {
                format!("gh api files spawn: {}", e)
            }
        })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(stderr.trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let files = parse_paginated_files(&stdout)?;
    let mut diff = String::new();
    for f in &files {
        diff.push_str(&synthesize_file_diff(f));
    }
    Ok(diff)
}

/// Merge `latestReviews` (one row per reviewer w state) with
/// `reviewRequests` (logins still owing a review). Latest-review state
/// wins; remaining requested users become PENDING. Author is filtered
/// out — they never review their own PR.
fn build_reviewers(
    latest: &[GhLatestReview],
    requested: &[GhUser],
) -> Vec<PrReviewer> {
    let mut by_login: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    for r in latest {
        if r.author.login.is_empty() {
            continue;
        }
        by_login.insert(r.author.login.clone(), r.state.clone());
    }
    for u in requested {
        if u.login.is_empty() {
            continue;
        }
        by_login
            .entry(u.login.clone())
            .or_insert_with(|| "PENDING".to_string());
    }
    by_login
        .into_iter()
        .map(|(login, state)| PrReviewer { login, state })
        .collect()
}

fn empty_to_none(s: String) -> Option<String> {
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

// ── Stage 7B: Comment threads ────────────────────────────────────────
//
// We back comments with `gh api repos/:owner/:repo/pulls/:n/comments`
// (review comments — the per-line ones) and `gh api repos/.../issues/N/comments`
// (general PR-level comments). For "resolve" we use the GraphQL
// resolveReviewThread mutation since REST has no resolve endpoint.

#[derive(Serialize, Clone)]
pub struct PrComment {
    pub id: u64,
    /// Stable node-id used by GraphQL resolve mutations (separate from
    /// the numeric REST id; gh returns both).
    pub node_id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    /// File path for inline review comments; None for issue-level
    /// (PR-conversation) comments.
    pub path: Option<String>,
    /// 1-indexed line in the file. Mirrors GitHub's `line` field which
    /// is the line at HEAD; pre-edit line is in `original_line`.
    pub line: Option<u64>,
    /// SS.3.2 — first line of a multi-line review comment range.
    /// GitHub stores ranged comments as (start_line, line); when the
    /// user dragged across lines 14→20 we want to render the highlight
    /// over the whole block, not just line 20. None for single-line
    /// comments (where start_line is unset on the API side too).
    pub start_line: Option<u64>,
    pub side: Option<String>,
    /// `id` of the parent comment when this is a reply within a thread;
    /// None for thread roots.
    pub in_reply_to: Option<u64>,
    /// True for `gh api .../issues/N/comments` results, false for
    /// `.../pulls/N/comments`.
    pub is_issue_comment: bool,
    /// GitHub's review-thread node id when known. Required for the
    /// resolve mutation; None for issue-level comments which don't live
    /// in threads.
    pub thread_node_id: Option<String>,
    /// Whether the enclosing review thread is resolved (GraphQL field).
    pub thread_resolved: bool,
    /// Stage 8M — emoji reactions, summarised. One entry per content
    /// the comment has at least one reaction for. `viewer_reacted`
    /// drives the "I reacted with this" highlight + remove path.
    /// Empty when the GraphQL reactions fetch failed (best-effort).
    #[serde(default)]
    pub reactions: Vec<PrCommentReaction>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PrCommentReaction {
    /// GraphQL ReactionContent enum value: THUMBS_UP / THUMBS_DOWN /
    /// LAUGH / HOORAY / CONFUSED / HEART / ROCKET / EYES.
    pub content: String,
    pub count: u32,
    pub viewer_reacted: bool,
}

#[derive(Deserialize)]
struct GhInlineComment {
    id: u64,
    #[serde(default, rename = "node_id")]
    node_id: String,
    #[serde(default)]
    user: GhUser,
    #[serde(default)]
    body: String,
    #[serde(default, rename = "created_at")]
    created_at: String,
    #[serde(default, rename = "updated_at")]
    updated_at: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    line: Option<u64>,
    #[serde(default)]
    original_line: Option<u64>,
    #[serde(default)]
    start_line: Option<u64>,
    #[serde(default)]
    original_start_line: Option<u64>,
    #[serde(default)]
    side: String,
    #[serde(default, rename = "in_reply_to_id")]
    in_reply_to_id: Option<u64>,
}

#[derive(Deserialize)]
struct GhIssueComment {
    id: u64,
    #[serde(default, rename = "node_id")]
    node_id: String,
    #[serde(default)]
    user: GhUser,
    #[serde(default)]
    body: String,
    #[serde(default, rename = "created_at")]
    created_at: String,
    #[serde(default, rename = "updated_at")]
    updated_at: String,
}

/// List both inline (per-line) and issue-level comments for a PR.
/// The frontend splits on `is_issue_comment` to render inline threads
/// next to their diff lines and conversation comments separately.
#[tauri::command]
pub async fn pr_comments_list(
    repo_root: String,
    pr_number: u64,
) -> Result<Vec<PrComment>, String> {
    let owner_repo = repo_owner_path(&repo_root)?;
    let inline_path = format!("repos/{}/pulls/{}/comments?per_page=100", owner_repo, pr_number);
    let issue_path = format!("repos/{}/issues/{}/comments?per_page=100", owner_repo, pr_number);
    let inline = run_gh(&repo_root, &["api", "--paginate", &inline_path]).unwrap_or_default();
    let issue = run_gh(&repo_root, &["api", "--paginate", &issue_path]).unwrap_or_default();

    // Resolve-state lookup: we issue a single GraphQL call per PR to map
    // each review-thread node id → (resolved, [comment_node_ids]).
    let thread_map = fetch_thread_states(&repo_root, &owner_repo, pr_number).unwrap_or_default();
    // Stage 8M — bulk reactions fetch: one GraphQL call returning
    // reactionGroups for every comment on the PR (review + issue).
    // Keyed by REST databaseId so we can attach to each PrComment by id.
    let reactions_map =
        fetch_reactions(&repo_root, &owner_repo, pr_number).unwrap_or_default();

    let mut out = Vec::new();
    if !inline.trim().is_empty() {
        let raw: Vec<GhInlineComment> = serde_json::from_str(&inline)
            .map_err(|e| format!("gh inline comments parse: {}", e))?;
        for c in raw {
            let line = c.line.or(c.original_line);
            let start_line = c.start_line.or(c.original_start_line);
            let (thread_node, resolved) = thread_map
                .get(&c.node_id)
                .cloned()
                .unwrap_or((None, false));
            let reactions = reactions_map.get(&c.id).cloned().unwrap_or_default();
            out.push(PrComment {
                id: c.id,
                node_id: c.node_id,
                author: c.user.login,
                body: c.body,
                created_at: c.created_at,
                updated_at: c.updated_at,
                path: empty_to_none(c.path),
                line,
                start_line,
                side: empty_to_none(c.side),
                in_reply_to: c.in_reply_to_id,
                is_issue_comment: false,
                thread_node_id: thread_node,
                thread_resolved: resolved,
                reactions,
            });
        }
    }
    if !issue.trim().is_empty() {
        let raw: Vec<GhIssueComment> = serde_json::from_str(&issue)
            .map_err(|e| format!("gh issue comments parse: {}", e))?;
        for c in raw {
            let reactions = reactions_map.get(&c.id).cloned().unwrap_or_default();
            out.push(PrComment {
                id: c.id,
                node_id: c.node_id,
                author: c.user.login,
                body: c.body,
                created_at: c.created_at,
                updated_at: c.updated_at,
                path: None,
                line: None,
                start_line: None,
                side: None,
                in_reply_to: None,
                is_issue_comment: true,
                thread_node_id: None,
                thread_resolved: false,
                reactions,
            });
        }
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(out)
}

/// Post a new inline review comment on a specific file:line of a PR.
/// `commit_sha` defaults to the PR head — gh's REST endpoint requires
/// it. We fetch it via `gh pr view` if not supplied.
#[tauri::command]
pub async fn pr_comment_post(
    repo_root: String,
    pr_number: u64,
    file: String,
    line: u64,
    body: String,
    side: Option<String>,
    start_line: Option<u64>,
) -> Result<PrComment, String> {
    let owner_repo = repo_owner_path(&repo_root)?;
    let head_sha = pr_head_sha(&repo_root, pr_number)?;
    let side_val = side.unwrap_or_else(|| "RIGHT".to_string());
    let line_str = line.to_string();
    let pr_str = pr_number.to_string();
    let path = format!("repos/{}/pulls/{}/comments", owner_repo, pr_number);
    // GitHub multi-line review comments take `start_line` + `start_side`
    // in addition to `line` + `side`. Single-line still omits both
    // start_* fields. Anchor lives on `line` (the bottom of the range).
    // Pin the API version so GitHub validates against the modern
    // `line`+`side` schema. Without the header, gh's default Accept
    // sometimes routes the request through the legacy position-based
    // schema (which rejects `line`/`start_line`/`subject_type` as
    // "not permitted keys" and dumps a confusing oneOf failure).
    // `subject_type` is intentionally omitted — it defaults to "line"
    // when `line` is set, and including it explicitly was the second
    // half of the 422.
    let mut args: Vec<String> = vec![
        "api".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-H".to_string(),
        "X-GitHub-Api-Version: 2022-11-28".to_string(),
        "-H".to_string(),
        "Accept: application/vnd.github+json".to_string(),
        path,
        "-f".to_string(),
        format!("body={}", body),
        "-f".to_string(),
        format!("commit_id={}", head_sha),
        "-f".to_string(),
        format!("path={}", file),
        "-F".to_string(),
        format!("line={}", line_str),
        "-f".to_string(),
        format!("side={}", side_val),
    ];
    if let Some(s) = start_line {
        if s != line {
            args.push("-F".to_string());
            args.push(format!("start_line={}", s));
            args.push("-f".to_string());
            args.push(format!("start_side={}", side_val));
        }
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let stdout = run_gh(&repo_root, &arg_refs)?;
    let _ = pr_str;
    let raw: GhInlineComment = serde_json::from_str(&stdout)
        .map_err(|e| format!("gh post comment parse: {}", e))?;
    Ok(PrComment {
        id: raw.id,
        node_id: raw.node_id,
        author: raw.user.login,
        body: raw.body,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        path: empty_to_none(raw.path),
        line: raw.line.or(raw.original_line),
        start_line: raw.start_line.or(raw.original_start_line),
        side: empty_to_none(raw.side),
        in_reply_to: raw.in_reply_to_id,
        is_issue_comment: false,
        thread_node_id: None,
        thread_resolved: false,
        reactions: Vec::new(),
    })
}

/// Reply to an existing inline review comment within its thread.
#[tauri::command]
pub async fn pr_comment_reply(
    repo_root: String,
    pr_number: u64,
    in_reply_to: u64,
    body: String,
) -> Result<PrComment, String> {
    let owner_repo = repo_owner_path(&repo_root)?;
    let path = format!(
        "repos/{}/pulls/{}/comments/{}/replies",
        owner_repo, pr_number, in_reply_to
    );
    let stdout = run_gh(
        &repo_root,
        &["api", "-X", "POST", &path, "-f", &format!("body={}", body)],
    )?;
    let raw: GhInlineComment = serde_json::from_str(&stdout)
        .map_err(|e| format!("gh reply parse: {}", e))?;
    Ok(PrComment {
        id: raw.id,
        node_id: raw.node_id,
        author: raw.user.login,
        body: raw.body,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        path: empty_to_none(raw.path),
        line: raw.line.or(raw.original_line),
        start_line: raw.start_line.or(raw.original_start_line),
        side: empty_to_none(raw.side),
        in_reply_to: raw.in_reply_to_id,
        is_issue_comment: false,
        thread_node_id: None,
        thread_resolved: false,
        reactions: Vec::new(),
    })
}

/// Post a top-level conversation (issue) comment on the PR.
#[tauri::command]
pub async fn pr_comment_post_issue(
    repo_root: String,
    pr_number: u64,
    body: String,
) -> Result<PrComment, String> {
    let owner_repo = repo_owner_path(&repo_root)?;
    let path = format!("repos/{}/issues/{}/comments", owner_repo, pr_number);
    let stdout = run_gh(
        &repo_root,
        &["api", "-X", "POST", &path, "-f", &format!("body={}", body)],
    )?;
    let raw: GhIssueComment = serde_json::from_str(&stdout)
        .map_err(|e| format!("gh issue comment parse: {}", e))?;
    Ok(PrComment {
        id: raw.id,
        node_id: raw.node_id,
        author: raw.user.login,
        body: raw.body,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        path: None,
        line: None,
        start_line: None,
        side: None,
        in_reply_to: None,
        is_issue_comment: true,
        thread_node_id: None,
        thread_resolved: false,
        reactions: Vec::new(),
    })
}

/// Resolve a review thread via GraphQL. `thread_node_id` comes from the
/// `thread_node_id` field on the PrComment that was clicked.
#[tauri::command]
pub async fn pr_comment_resolve(
    repo_root: String,
    thread_node_id: String,
) -> Result<(), String> {
    let mutation = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
    run_gh(
        &repo_root,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={}", mutation),
            "-f",
            &format!("id={}", thread_node_id),
        ],
    )?;
    Ok(())
}

#[derive(Deserialize)]
struct ThreadGraphqlResp {
    data: Option<ThreadGraphqlData>,
}
#[derive(Deserialize)]
struct ThreadGraphqlData {
    repository: Option<ThreadGraphqlRepo>,
}
#[derive(Deserialize)]
struct ThreadGraphqlRepo {
    #[serde(rename = "pullRequest")]
    pull_request: Option<ThreadGraphqlPr>,
}
#[derive(Deserialize)]
struct ThreadGraphqlPr {
    #[serde(rename = "reviewThreads")]
    review_threads: ThreadGraphqlConn,
}
#[derive(Deserialize)]
struct ThreadGraphqlConn {
    nodes: Vec<ThreadGraphqlNode>,
}
#[derive(Deserialize)]
struct ThreadGraphqlNode {
    id: String,
    #[serde(rename = "isResolved")]
    is_resolved: bool,
    comments: ThreadGraphqlComments,
}
#[derive(Deserialize)]
struct ThreadGraphqlComments {
    nodes: Vec<ThreadGraphqlCommentNode>,
}
#[derive(Deserialize)]
struct ThreadGraphqlCommentNode {
    id: String,
}

/// Map review-comment node id → (thread_node_id, is_resolved). Best
/// effort — failures fall back to "no resolve info" rather than failing
/// the whole comments call.
fn fetch_thread_states(
    repo_root: &str,
    owner_repo: &str,
    pr_number: u64,
) -> Option<std::collections::HashMap<String, (Option<String>, bool)>> {
    let parts: Vec<&str> = owner_repo.split('/').collect();
    if parts.len() != 2 {
        return None;
    }
    let owner = parts[0];
    let repo = parts[1];
    let query = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{id}}}}}}}";
    let stdout = run_gh(
        repo_root,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={}", query),
            "-f",
            &format!("owner={}", owner),
            "-f",
            &format!("repo={}", repo),
            "-F",
            &format!("number={}", pr_number),
        ],
    )
    .ok()?;
    let resp: ThreadGraphqlResp = serde_json::from_str(&stdout).ok()?;
    let nodes = resp
        .data?
        .repository?
        .pull_request?
        .review_threads
        .nodes;
    let mut map = std::collections::HashMap::new();
    for thread in nodes {
        for c in thread.comments.nodes {
            map.insert(c.id, (Some(thread.id.clone()), thread.is_resolved));
        }
    }
    Some(map)
}

// ── Stage 8M: emoji reactions ────────────────────────────────────────
//
// One GraphQL call per pr_comments_list call returns reactionGroups
// for every review-thread comment + every issue comment on the PR.
// Keyed by REST databaseId so the rest of the comments pipeline (which
// already uses REST) can attach reactions by id without re-fetching.

#[derive(Deserialize)]
struct ReactGqlResp {
    data: Option<ReactGqlData>,
}
#[derive(Deserialize)]
struct ReactGqlData {
    repository: Option<ReactGqlRepo>,
}
#[derive(Deserialize)]
struct ReactGqlRepo {
    #[serde(rename = "pullRequest")]
    pull_request: Option<ReactGqlPr>,
}
#[derive(Deserialize)]
struct ReactGqlPr {
    #[serde(rename = "reviewThreads")]
    review_threads: Option<ReactGqlThreadConn>,
    comments: Option<ReactGqlCommentConn>,
}
#[derive(Deserialize)]
struct ReactGqlThreadConn {
    nodes: Vec<ReactGqlThread>,
}
#[derive(Deserialize)]
struct ReactGqlThread {
    comments: ReactGqlCommentConn,
}
#[derive(Deserialize)]
struct ReactGqlCommentConn {
    nodes: Vec<ReactGqlComment>,
}
#[derive(Deserialize)]
struct ReactGqlComment {
    #[serde(rename = "databaseId")]
    database_id: Option<u64>,
    #[serde(rename = "reactionGroups", default)]
    reaction_groups: Vec<ReactGqlGroup>,
}
#[derive(Deserialize)]
struct ReactGqlGroup {
    content: String,
    #[serde(rename = "viewerHasReacted", default)]
    viewer_has_reacted: bool,
    #[serde(default)]
    reactors: Option<ReactGqlReactors>,
}
#[derive(Deserialize)]
struct ReactGqlReactors {
    #[serde(rename = "totalCount", default)]
    total_count: u32,
}

fn fetch_reactions(
    repo_root: &str,
    owner_repo: &str,
    pr_number: u64,
) -> Option<std::collections::HashMap<u64, Vec<PrCommentReaction>>> {
    let parts: Vec<&str> = owner_repo.split('/').collect();
    if parts.len() != 2 {
        return None;
    }
    let owner = parts[0];
    let repo = parts[1];
    // `reactors { totalCount }` mirrors `users { totalCount }` in older
    // schemas — the API renamed it; reactors is the current spelling.
    let query = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{comments(first:100){nodes{databaseId reactionGroups{content viewerHasReacted reactors{totalCount}}}}}} comments(first:100){nodes{databaseId reactionGroups{content viewerHasReacted reactors{totalCount}}}}}}}";
    let stdout = run_gh(
        repo_root,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={}", query),
            "-f",
            &format!("owner={}", owner),
            "-f",
            &format!("repo={}", repo),
            "-F",
            &format!("number={}", pr_number),
        ],
    )
    .ok()?;
    let resp: ReactGqlResp = serde_json::from_str(&stdout).ok()?;
    let pr = resp.data?.repository?.pull_request?;
    let mut map: std::collections::HashMap<u64, Vec<PrCommentReaction>> =
        std::collections::HashMap::new();
    let mut absorb = |c: ReactGqlComment| {
        let id = match c.database_id {
            Some(v) => v,
            None => return,
        };
        let mut entries = Vec::new();
        for g in c.reaction_groups {
            let count = g.reactors.map(|r| r.total_count).unwrap_or(0);
            if count == 0 {
                continue;
            }
            entries.push(PrCommentReaction {
                content: g.content,
                count,
                viewer_reacted: g.viewer_has_reacted,
            });
        }
        if !entries.is_empty() {
            map.insert(id, entries);
        }
    };
    if let Some(threads) = pr.review_threads {
        for t in threads.nodes {
            for c in t.comments.nodes {
                absorb(c);
            }
        }
    }
    if let Some(issue_comments) = pr.comments {
        for c in issue_comments.nodes {
            absorb(c);
        }
    }
    Some(map)
}

/// Add a reaction to a comment. `comment_node_id` is the GraphQL node
/// id (PrComment.node_id, NOT the REST id). `content` is the GraphQL
/// ReactionContent enum value (THUMBS_UP, HEART, …).
#[tauri::command]
pub async fn pr_reaction_add(
    repo_root: String,
    comment_node_id: String,
    content: String,
) -> Result<(), String> {
    if !is_valid_reaction_content(&content) {
        return Err(format!("invalid reaction content: {}", content));
    }
    // Pass `content` as a GraphQL variable typed `ReactionContent!` —
    // gh's -f flag would stringify it; -F keeps it as a JSON string but
    // GraphQL still expects an enum. Inline-substitute into the query
    // is safe here because we whitelist content above.
    let mutation = format!(
        "mutation($id:ID!){{addReaction(input:{{subjectId:$id,content:{}}}){{reaction{{content}}}}}}",
        content
    );
    run_gh(
        &repo_root,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={}", mutation),
            "-f",
            &format!("id={}", comment_node_id),
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn pr_reaction_remove(
    repo_root: String,
    comment_node_id: String,
    content: String,
) -> Result<(), String> {
    if !is_valid_reaction_content(&content) {
        return Err(format!("invalid reaction content: {}", content));
    }
    let mutation = format!(
        "mutation($id:ID!){{removeReaction(input:{{subjectId:$id,content:{}}}){{reaction{{content}}}}}}",
        content
    );
    run_gh(
        &repo_root,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={}", mutation),
            "-f",
            &format!("id={}", comment_node_id),
        ],
    )?;
    Ok(())
}

fn is_valid_reaction_content(c: &str) -> bool {
    matches!(
        c,
        "THUMBS_UP"
            | "THUMBS_DOWN"
            | "LAUGH"
            | "HOORAY"
            | "CONFUSED"
            | "HEART"
            | "ROCKET"
            | "EYES"
    )
}

// ── Stage 7D: Approval / Merge / Stack ───────────────────────────────

#[tauri::command]
pub async fn pr_approve(
    repo_root: String,
    pr_number: u64,
    body: Option<String>,
) -> Result<(), String> {
    let pr_str = pr_number.to_string();
    let mut args = vec!["pr", "review", &pr_str, "--approve"];
    let body_value;
    if let Some(b) = body.filter(|s| !s.trim().is_empty()) {
        body_value = b;
        args.push("--body");
        args.push(&body_value);
    }
    run_gh(&repo_root, &args)?;
    Ok(())
}

#[tauri::command]
pub async fn pr_request_changes(
    repo_root: String,
    pr_number: u64,
    body: String,
) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("request-changes needs a body".to_string());
    }
    run_gh(
        &repo_root,
        &[
            "pr",
            "review",
            &pr_number.to_string(),
            "--request-changes",
            "--body",
            &body,
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn pr_comment_review(
    repo_root: String,
    pr_number: u64,
    body: String,
) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("comment review needs a body".to_string());
    }
    run_gh(
        &repo_root,
        &[
            "pr",
            "review",
            &pr_number.to_string(),
            "--comment",
            "--body",
            &body,
        ],
    )?;
    Ok(())
}

/// `strategy` must be one of `"squash" | "merge" | "rebase"`.
#[tauri::command]
pub async fn pr_merge(
    repo_root: String,
    pr_number: u64,
    strategy: String,
    delete_branch: bool,
) -> Result<(), String> {
    let flag = match strategy.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        "merge" => "--merge",
        other => return Err(format!("unknown merge strategy: {}", other)),
    };
    let pr_str = pr_number.to_string();
    let mut args = vec!["pr", "merge", &pr_str, flag];
    if delete_branch {
        args.push("--delete-branch");
    }
    run_gh(&repo_root, &args)?;
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct PrStackNode {
    pub number: u64,
    pub title: String,
    pub head_ref: String,
    pub base_ref: String,
    pub author: String,
    pub state: String,
    pub is_draft: bool,
    pub aura_risk_score: Option<i64>,
    pub url: String,
    /// PR numbers whose effective parent branch == this.head_ref —
    /// children stacked on top of this PR.
    pub children: Vec<u64>,
    /// PR number whose `head_ref` == this PR's effective parent branch.
    /// None when the parent is a non-PR branch like main.
    pub parent: Option<u64>,
    /// True when this branch's parent came from Graphite's local stack
    /// metadata (`refs/branch-metadata/`) rather than the GitHub base ref.
    /// Lets the UI flag that the ordering is `gt`-authoritative — which
    /// surfaces stacks the head/base graph alone can't see (e.g. every PR
    /// opened against main while stacked locally).
    pub gt_managed: bool,
}

/// Compute the stack rooted at `pr_number`. We fetch all open PRs once and
/// walk the parent/child graph in both directions.
///
/// The parent of a PR is its **effective parent branch** — Graphite's local
/// stack metadata (`refs/branch-metadata/`) when the branch is `gt`-managed,
/// otherwise the GitHub base ref. Graphite is the authoritative source here:
/// it captures stacks the head/base graph can't (a common workflow opens
/// every PR against `main` while the branches are stacked locally). When the
/// repo isn't Graphite-managed the map is empty and this is exactly the old
/// base-ref walk.
#[tauri::command]
pub async fn pr_stack(
    repo_root: String,
    pr_number: u64,
) -> Result<Vec<PrStackNode>, String> {
    // One `gh pr list` request — CI checks now ride inline on the rollup,
    // so there's no per-PR fan-out to avoid here; the warm-cached list also
    // serves this without a second network hit.
    let all = pr_list(repo_root.clone()).await?;

    // Local, token-free: branch -> authoritative parent branch (empty for a
    // non-Graphite repo). Read once and reused for every effective-parent
    // lookup below.
    let gt_parents = crate::integrations::graphite::stack_parents(&repo_root);
    let eff_parent = |p: &PrSummary| -> String {
        gt_parents
            .get(&p.head_ref)
            .cloned()
            .unwrap_or_else(|| p.base_ref.clone())
    };

    let by_head: std::collections::HashMap<&str, &PrSummary> =
        all.iter().map(|p| (p.head_ref.as_str(), p)).collect();
    // Children keyed by their effective parent branch.
    let mut by_parent: std::collections::HashMap<String, Vec<&PrSummary>> =
        std::collections::HashMap::new();
    for p in &all {
        by_parent.entry(eff_parent(p)).or_default().push(p);
    }
    let root = all
        .iter()
        .find(|p| p.number == pr_number)
        .ok_or_else(|| format!("PR #{} not in open list", pr_number))?;

    // Walk down (this PR's children, grandchildren, …)
    let mut included: std::collections::BTreeMap<u64, &PrSummary> =
        std::collections::BTreeMap::new();
    included.insert(root.number, root);
    let mut frontier = vec![root.head_ref.clone()];
    while let Some(head) = frontier.pop() {
        if let Some(children) = by_parent.get(&head) {
            for c in children {
                if included.insert(c.number, c).is_none() {
                    frontier.push(c.head_ref.clone());
                }
            }
        }
    }
    // Walk up (parent chain) following the effective parent branch.
    let mut cur_parent = eff_parent(root);
    while let Some(parent) = by_head.get(cur_parent.as_str()).copied() {
        if included.contains_key(&parent.number) {
            break;
        }
        included.insert(parent.number, parent);
        cur_parent = eff_parent(parent);
    }

    let mut nodes: Vec<PrStackNode> = included
        .values()
        .map(|p| PrStackNode {
            number: p.number,
            title: p.title.clone(),
            head_ref: p.head_ref.clone(),
            base_ref: p.base_ref.clone(),
            author: p.author.clone(),
            state: p.state.clone(),
            is_draft: p.is_draft,
            aura_risk_score: p.aura_risk_score,
            url: p.url.clone(),
            children: Vec::new(),
            parent: None,
            gt_managed: gt_parents.contains_key(&p.head_ref),
        })
        .collect();

    // Cross-link parent/children using each node's effective parent branch.
    let head_to_idx: std::collections::HashMap<String, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.head_ref.clone(), i))
        .collect();
    for i in 0..nodes.len() {
        let parent_branch = gt_parents
            .get(&nodes[i].head_ref)
            .cloned()
            .unwrap_or_else(|| nodes[i].base_ref.clone());
        if let Some(&p_idx) = head_to_idx.get(&parent_branch) {
            nodes[i].parent = Some(nodes[p_idx].number);
            let child_num = nodes[i].number;
            nodes[p_idx].children.push(child_num);
        }
    }
    Ok(nodes)
}

// ── helpers ───────────────────────────────────────────────────────────

/// Resolve the `<owner>/<repo>` slug for the current repo by asking gh,
/// which uses the configured remote. Cached per process would be nicer
/// but the gh round-trip is ~30ms locally.
fn repo_owner_path(repo_root: &str) -> Result<String, String> {
    let stdout = run_gh(
        repo_root,
        &["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    )?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("gh repo view returned empty owner/repo".to_string());
    }
    Ok(trimmed.to_string())
}

fn pr_head_sha(repo_root: &str, pr_number: u64) -> Result<String, String> {
    let stdout = run_gh(
        repo_root,
        &[
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "headRefOid",
            "-q",
            ".headRefOid",
        ],
    )?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("gh returned empty headRefOid".to_string());
    }
    Ok(trimmed.to_string())
}

/// Vercel deploy status for a PR's head commit, or `Ok(None)` when Vercel
/// isn't configured (no `[vercel]` block) or knows of no deployment for the
/// commit yet. Drives the deploy chip on the PR checks view — deliberately
/// soft: an unconfigured or slow Vercel never breaks the checks list.
///
/// Resolves the PR's head commit via `gh` (the same sha the checks ride on),
/// reads the token-only Vercel config, and asks Vercel for the newest
/// deployment of that commit. Returns the flattened `VercelDeployment` the
/// frontend maps to plain language ("Deployed", "Building", "Deploy failed").
#[tauri::command]
pub async fn pr_vercel_status(
    repo_root: String,
    pr_number: u64,
) -> Result<Option<crate::integrations::vercel::VercelDeployment>, String> {
    // Config first — the common case (nobody configured Vercel) short-circuits
    // before we spend a `gh` round-trip resolving the sha.
    let cfg = match crate::integrations::config::vercel().map_err(|e| e.to_string())? {
        Some(cfg) => cfg,
        None => return Ok(None),
    };
    let sha = pr_head_sha(&repo_root, pr_number)?;
    crate::integrations::vercel::latest_for(&cfg, &sha, None)
        .await
        .map_err(|e| e.to_string())
}

/// Semantic PR review as structured JSON for the `/review` slash card.
///
/// Runs `aura pr-review --base <base> --json`, which the engine (aura-cli
/// `pr::PrReviewEngine::run_review`) already emits: a full `ReviewReport`
/// with the plain-language `summary`, humanized `findings` (layer
/// violations, security, drift, deletions folded into what/why/where/how-bad
/// cards), per-file `changes` with captured intent, plus the raw
/// `invariant_violations` / `blast_radius` / `cross_branch_conflicts` /
/// `taste_findings` streams and `risk_score` / `risk_label`. We ferry the
/// parsed report back verbatim as `serde_json::Value` so the review schema
/// lives in exactly one place (the engine); the frontend's `ReviewReport`
/// type in `lib/api.ts` mirrors the same shape.
///
/// `base` defaults to `main` when not supplied. When the working tree has no
/// changes against the base, the engine emits `{"status":"no_changes"}` —
/// returned as-is so the card can render a calm "nothing to review" state.
/// Uses the async Command (already imported): a real semantic diff over a
/// large branch can take a few seconds.
#[tauri::command]
pub async fn aura_review_json(
    repo_root: String,
    base: Option<String>,
) -> Result<serde_json::Value, String> {
    let cwd = std::path::PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }
    let base = base
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "main".to_string());

    let out = tokio::process::Command::new("aura")
        .args(["pr-review", "--base", &base, "--json"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("failed to spawn aura pr-review: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura pr-review exited with {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(&stdout)
        .map_err(|e| format!("failed to parse pr-review JSON: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pr_args_preserve_metadata_without_shell_interpolation() {
        let create = create_args(
            "feat/native-pr",
            "feat: native PR authoring",
            "Body with `code`, quotes, and $variables",
            Some("develop"),
            true,
        );
        assert_eq!(create[0..4], ["pr", "create", "--head", "feat/native-pr"]);
        assert!(create.windows(2).any(|w| w == ["--base", "develop"]));
        assert_eq!(create.last().map(String::as_str), Some("--draft"));

        let edit = edit_args(42, "new title", "new body", Some("main"));
        assert_eq!(edit[0..3], ["pr", "edit", "42"]);
        assert!(edit.windows(2).any(|w| w == ["--base", "main"]));
    }

    // Regression: gh emits `"statusCheckRollup": null` (present key, null
    // value) for a branch-promotion PR — e.g. a `main → staging` chore PR
    // has no head-commit rollup. `#[serde(default)]` alone only fills a
    // MISSING key, so a present null used to abort deserialization of the
    // WHOLE list ("invalid type: null, expected a sequence") and one such
    // PR among hundreds surfaced as a generic "Couldn't load from GitHub".
    // `null_to_default` must coerce it to an empty Vec so the rest load.
    #[test]
    fn pr_list_tolerates_null_status_check_rollup() {
        let json = r#"[
            {
                "number": 346,
                "title": "chore: promote main to staging",
                "state": "MERGED",
                "headRefName": "main",
                "baseRefName": "staging",
                "reviewDecision": null,
                "statusCheckRollup": null
            },
            {
                "number": 347,
                "title": "feat: add widget",
                "state": "OPEN",
                "headRefName": "feat/widget",
                "baseRefName": "main",
                "reviewDecision": "APPROVED",
                "statusCheckRollup": [
                    { "status": "COMPLETED", "conclusion": "SUCCESS" },
                    { "status": "IN_PROGRESS", "conclusion": null },
                    { "state": "PENDING" }
                ]
            }
        ]"#;
        let parsed: Vec<GhPrSummary> =
            serde_json::from_str(json).expect("null statusCheckRollup must not poison the parse");
        assert_eq!(parsed.len(), 2);
        // Null rollup → empty vec → no-checks summary.
        assert!(parsed[0].status_check_rollup.is_empty());
        assert_eq!(parsed[0].review_decision, "");
        // Mixed rollup with a null `conclusion` still parses and buckets.
        assert_eq!(parsed[1].status_check_rollup.len(), 3);
        assert_eq!(parsed[1].review_decision, "APPROVED");
        let checks = summarize_rollup(&parsed[1].status_check_rollup);
        assert_eq!(checks.total, 3);
        assert_eq!(checks.passing, 1);
        assert_eq!(checks.pending, 2);
    }

    // The same null-coercion guards the single-PR detail path: gh returns
    // `null` for `mergeable`/`reviewDecision` on PRs where it hasn't
    // computed them, which would otherwise crash `pr_detail`.
    #[test]
    fn pr_detail_tolerates_null_mergeable_and_review_decision() {
        let json = r#"{
            "number": 12,
            "title": "wip",
            "state": "OPEN",
            "headRefName": "wip",
            "baseRefName": "main",
            "mergeable": null,
            "reviewDecision": null,
            "mergedAt": null
        }"#;
        let parsed: GhPrDetail =
            serde_json::from_str(json).expect("null mergeable/reviewDecision must parse");
        assert_eq!(parsed.mergeable, "");
        assert_eq!(parsed.review_decision, "");
        assert_eq!(parsed.merged_at, None);
    }
}
