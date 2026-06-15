//! Post Aura's review findings to a GitHub PR as line-anchored inline
//! comments, via the `gh` CLI.
//!
//! No cloud backend and no MCP server: `gh` already carries the developer's
//! GitHub auth plus the PR / head-commit / diff context. We turn each
//! [`Finding`] that anchors to a changed line into an inline review comment,
//! and fold the rest into a single summary body — then submit it as ONE
//! pull-request review (`POST /pulls/{n}/reviews`), so a panel of reviewers
//! lands as one coherent review, not a storm of notifications.
//!
//! The diff math (which lines are commentable) lives in the shared
//! [`aura_prdiff`] crate, used identically by the cloud PR-review path. Only
//! the thin `gh` wrappers here touch the network.

use std::io::Write;
use std::process::{Command, Stdio};

pub use aura_prdiff::DiffIndex;
use serde::Serialize;

use super::findings::{Finding, Severity};

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

/// Where a finding can be placed in the review.
#[derive(Debug, PartialEq)]
pub enum Anchor {
    /// An inline comment on a real diff line (new/RIGHT side).
    Inline {
        path: String,
        line: u32,
        start_line: Option<u32>,
    },
    /// No usable diff line — belongs in the review summary body instead.
    Summary,
}

/// Decide whether `f` becomes an inline comment or a summary line. Every line
/// is validated against the actual diff (via [`aura_prdiff`]) so GitHub never
/// rejects the review.
pub fn resolve_anchor(f: &Finding, idx: &DiffIndex) -> Anchor {
    let Some(file) = f.file.as_deref() else {
        return Anchor::Summary;
    };
    match idx.resolve(file, f.line, f.start_line) {
        Some(a) => Anchor::Inline {
            path: a.path,
            line: a.line,
            start_line: a.start_line,
        },
        None => Anchor::Summary,
    }
}

// ---------------------------------------------------------------------------
// Review payload
// ---------------------------------------------------------------------------

/// One `POST /pulls/{n}/reviews` body.
#[derive(Debug, Serialize)]
pub struct ReviewPayload {
    pub commit_id: String,
    /// Always "COMMENT" — neutral, and the only event a PR author may submit
    /// on their own PR (APPROVE / REQUEST_CHANGES are rejected for authors).
    pub event: String,
    pub body: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<CommentPayload>,
}

/// One inline review comment within a [`ReviewPayload`].
#[derive(Debug, Serialize)]
pub struct CommentPayload {
    pub path: String,
    pub line: u32,
    pub side: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_side: Option<String>,
    pub body: String,
}

/// Build the full review: turn anchorable findings into inline comments and
/// fold the rest into `header` as a summary. Pure — no network — so the whole
/// shape is unit-tested. `header` is the human summary (risk + counts) the
/// caller composes; unplaceable findings are appended to it.
pub fn build_payload(
    findings: &[Finding],
    header: &str,
    head_oid: &str,
    idx: &DiffIndex,
) -> ReviewPayload {
    let mut comments = Vec::new();
    let mut summary_lines = Vec::new();

    for f in findings {
        match resolve_anchor(f, idx) {
            Anchor::Inline { path, line, start_line } => {
                comments.push(CommentPayload {
                    path,
                    line,
                    side: "RIGHT".to_string(),
                    start_side: start_line.map(|_| "RIGHT".to_string()),
                    start_line,
                    body: comment_body(f),
                });
            }
            Anchor::Summary => summary_lines.push(summary_line(f)),
        }
    }

    let mut body = header.to_string();
    if !summary_lines.is_empty() {
        body.push_str("\n\n#### Other findings (not on changed lines)\n");
        for l in &summary_lines {
            body.push_str("\n- ");
            body.push_str(l);
        }
    }
    if comments.is_empty() && summary_lines.is_empty() {
        body.push_str("\n\n_No actionable findings._");
    }

    ReviewPayload {
        commit_id: head_oid.to_string(),
        event: "COMMENT".to_string(),
        body,
        comments,
    }
}

/// Markdown body for a single inline comment.
fn comment_body(f: &Finding) -> String {
    format!("**{}** — {}\n\n_flagged by Aura ({})_", f.severity.label(), f.title, f.source)
}

/// One bullet for a finding that couldn't be placed inline.
fn summary_line(f: &Finding) -> String {
    let loc = match (&f.file, f.line) {
        (Some(file), Some(line)) => format!(" (`{file}:{line}`)"),
        (Some(file), None) => format!(" (`{file}`)"),
        _ => String::new(),
    };
    format!("**{}** — {}{} _[{}]_", f.severity.label(), f.title, loc, f.source)
}

/// Severity label for the worst finding, for the review header.
pub fn worst_label(findings: &[Finding]) -> &'static str {
    findings
        .iter()
        .map(|f| f.severity)
        .max()
        .unwrap_or(Severity::Info)
        .label()
}

// ---------------------------------------------------------------------------
// gh CLI wrappers (the only part that touches the network)
// ---------------------------------------------------------------------------

/// The GitHub PR a review will be posted to.
#[derive(Debug, Clone)]
pub struct PrTarget {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub head_oid: String,
}

impl PrTarget {
    pub fn slug(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repo, self.number)
    }
}

/// `gh` must be installed and authenticated for any posting path.
fn ensure_gh() -> Result<(), String> {
    which_gh().then_some(()).ok_or_else(|| {
        "GitHub CLI `gh` not found on PATH. Install it (https://cli.github.com) and run \
         `gh auth login`, then retry."
            .to_string()
    })
}

fn which_gh() -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join("gh").is_file()))
        .unwrap_or(false)
}

/// Run `gh <args>` and return stdout, mapping a non-zero exit to its stderr.
fn gh(args: &[&str]) -> Result<String, String> {
    let out = Command::new("gh")
        .args(args)
        .output()
        .map_err(|e| format!("failed to run gh {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("gh {} failed: {}", args.join(" "), err));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Resolve the PR to review: an explicit number, else the PR for the current
/// branch. Also fetches owner/repo and the head commit the comments anchor to.
pub fn resolve_pr(explicit: Option<u64>) -> Result<PrTarget, String> {
    ensure_gh()?;

    let nwo = gh(&["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])?;
    let nwo = nwo.trim();
    let (owner, repo) = nwo
        .split_once('/')
        .ok_or_else(|| format!("unexpected repo slug from gh: {nwo:?}"))?;

    // `gh pr view [n] --json number,headRefOid` works for an explicit PR or
    // the current branch's PR.
    let num_arg = explicit.map(|n| n.to_string());
    let mut args = vec!["pr", "view"];
    if let Some(n) = &num_arg {
        args.push(n);
    }
    args.extend_from_slice(&["--json", "number,headRefOid"]);
    let view = gh(&args)?;
    let v: serde_json::Value = serde_json::from_str(&view)
        .map_err(|e| format!("could not parse `gh pr view` output: {e}"))?;
    let number = v
        .get("number")
        .and_then(|x| x.as_u64())
        .ok_or("no PR found for the current branch — pass a PR number")?;
    let head_oid = v
        .get("headRefOid")
        .and_then(|x| x.as_str())
        .ok_or("gh did not return the PR head commit")?
        .to_string();

    Ok(PrTarget {
        owner: owner.to_string(),
        repo: repo.to_string(),
        number,
        head_oid,
    })
}

/// The PR's unified diff (`gh pr diff <n>`).
pub fn fetch_diff(number: u64) -> Result<String, String> {
    ensure_gh()?;
    gh(&["pr", "diff", &number.to_string()])
}

/// Submit the review via `gh api ... --input -`, returning the new review's
/// html_url on success.
pub fn submit(target: &PrTarget, payload: &ReviewPayload) -> Result<String, String> {
    ensure_gh()?;
    let body = serde_json::to_string(payload).map_err(|e| format!("serialize payload: {e}"))?;
    let endpoint = format!(
        "repos/{}/{}/pulls/{}/reviews",
        target.owner, target.repo, target.number
    );

    let mut child = Command::new("gh")
        .args(["api", "--method", "POST", &endpoint, "--input", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn gh api: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("no stdin handle for gh api")?
        .write_all(body.as_bytes())
        .map_err(|e| format!("write payload to gh: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("gh api wait: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("gh api {endpoint} failed: {err}"));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("parse gh api response: {e}"))?;
    Ok(v.get("html_url")
        .and_then(|x| x.as_str())
        .unwrap_or("(review posted)")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::findings::Severity;

    const DIFF: &str = "\
diff --git a/src/auth.rs b/src/auth.rs
index 1111111..2222222 100644
--- a/src/auth.rs
+++ b/src/auth.rs
@@ -10,6 +10,8 @@ fn login() {
 context a
-old removed
+added one
+added two
 context b
@@ -40,3 +50,4 @@ fn logout() {
 ctx
+late add
 ctx2
";

    #[test]
    fn exact_line_anchors_inline() {
        let idx = DiffIndex::parse(DIFF);
        let f = Finding::new("aura", Severity::High, "boom").with_line("src/auth.rs", 11);
        assert_eq!(
            resolve_anchor(&f, &idx),
            Anchor::Inline { path: "src/auth.rs".into(), line: 11, start_line: None }
        );
    }

    #[test]
    fn unknown_file_falls_back_to_summary() {
        let idx = DiffIndex::parse(DIFF);
        let f = Finding::new("aura", Severity::High, "elsewhere").with_line("src/other.rs", 11);
        assert_eq!(resolve_anchor(&f, &idx), Anchor::Summary);
    }

    #[test]
    fn payload_splits_inline_and_summary_and_serializes() {
        let idx = DiffIndex::parse(DIFF);
        let findings = vec![
            Finding::new("aura", Severity::Critical, "inline one").with_line("src/auth.rs", 11),
            Finding::new("claude", Severity::High, "no file here"),
            Finding::new("aura", Severity::Moderate, "far one").with_line("src/auth.rs", 800),
        ];
        let p = build_payload(&findings, "## Aura review", "deadbeef", &idx);
        assert_eq!(p.commit_id, "deadbeef");
        assert_eq!(p.event, "COMMENT");
        assert_eq!(p.comments.len(), 1);
        assert_eq!(p.comments[0].path, "src/auth.rs");
        assert_eq!(p.comments[0].line, 11);
        assert_eq!(p.comments[0].side, "RIGHT");
        assert!(p.body.contains("Other findings"));
        assert!(p.body.contains("no file here"));
        assert!(p.body.contains("far one"));

        // single-line comment must NOT serialize start_line/start_side
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("start_line"));
        assert!(!json.contains("start_side"));
    }

    #[test]
    fn range_comment_serializes_start_side() {
        let idx = DiffIndex::parse(DIFF);
        let findings =
            vec![Finding::new("aura", Severity::High, "span").with_span("src/auth.rs", 11, 13)];
        let p = build_payload(&findings, "h", "sha", &idx);
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"start_line\":11"));
        assert!(json.contains("\"start_side\":\"RIGHT\""));
    }

    #[test]
    fn empty_findings_yield_clean_body_no_comments() {
        let idx = DiffIndex::parse(DIFF);
        let p = build_payload(&[], "## Aura review", "sha", &idx);
        assert!(p.comments.is_empty());
        assert!(p.body.contains("No actionable findings"));
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("comments"));
    }
}
