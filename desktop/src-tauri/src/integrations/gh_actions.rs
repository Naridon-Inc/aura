//! Why did a GitHub Actions run fail *to start*?
//!
//! A check run whose conclusion is `startup_failure` never ran a step: the
//! workflow file was invalid, a reusable workflow could not be resolved, the
//! runner label matched nothing, and so on. The PR's `statusCheckRollup` only
//! says `STARTUP_FAILURE`, so the Checks tab would show a red row with no
//! explanation and the "ask an agent to fix" prompt would send the agent in
//! blind. GitHub does record the reason — on the check run's `output` and its
//! annotations (`Invalid workflow file: .github/workflows/ci.yml#L12 …`) — so
//! this module digs it out with a few `gh api` calls.
//!
//! Only the URL parsing and JSON reading live here; the `gh` invocation is a
//! closure the caller passes (so it inherits the repo's `GH_HOST` handling and
//! the tests can feed canned JSON).

use serde::Deserialize;

/// Where a check run lives, parsed from its `detailsUrl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRunLocator {
    pub owner: String,
    pub repo: String,
    pub run_id: u64,
    /// The job id — for Actions this is also the check-run id.
    pub job_id: Option<u64>,
}

/// PURE: pick owner/repo/run/job out of
/// `https://<host>/<owner>/<repo>/actions/runs/<run>[/job/<job>][?…]`.
/// The host is ignored on purpose — `gh api` already talks to the right one.
pub fn locate_from_details_url(url: &str) -> Option<CheckRunLocator> {
    let no_query = url.split(['?', '#']).next().unwrap_or("");
    let after_scheme = no_query.split("://").nth(1).unwrap_or(no_query);
    let mut parts = after_scheme.split('/').filter(|s| !s.is_empty());
    let _host = parts.next()?;
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if parts.next()? != "actions" || parts.next()? != "runs" {
        return None;
    }
    let run_id: u64 = parts.next()?.parse().ok()?;
    let job_id = match parts.next() {
        Some("job") => parts.next().and_then(|j| j.parse().ok()),
        _ => None,
    };
    Some(CheckRunLocator {
        owner,
        repo,
        run_id,
        job_id,
    })
}

#[derive(Deserialize, Default)]
struct CheckRunOutput {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Deserialize, Default)]
struct CheckRun {
    #[serde(default)]
    output: CheckRunOutput,
}

/// PURE: the reason text on a check-run payload (`output.title` + `summary`).
pub fn reason_from_check_run_json(json: &str) -> Option<String> {
    let run: CheckRun = serde_json::from_str(json).ok()?;
    let title = run.output.title.unwrap_or_default();
    let summary = run.output.summary.unwrap_or_default();
    join_nonempty(&[title.trim(), summary.trim()], "\n")
}

#[derive(Deserialize, Default)]
struct Annotation {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    start_line: Option<u64>,
}

/// PURE: annotations rendered one per line as `message (path#Lline)`.
pub fn reason_from_annotations_json(json: &str) -> Option<String> {
    let rows: Vec<Annotation> = serde_json::from_str(json).ok()?;
    let lines: Vec<String> = rows
        .into_iter()
        .filter_map(|a| {
            let msg = a.message.unwrap_or_default();
            let msg = msg.trim();
            if msg.is_empty() {
                return None;
            }
            match (a.path.filter(|p| !p.trim().is_empty()), a.start_line) {
                (Some(p), Some(l)) => Some(format!("{msg} ({p}#L{l})")),
                (Some(p), None) => Some(format!("{msg} ({p})")),
                _ => Some(msg.to_string()),
            }
        })
        .collect();
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

#[derive(Deserialize, Default)]
struct WorkflowRun {
    #[serde(default)]
    display_title: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

/// PURE: the last resort — name the workflow GitHub could not start, so the
/// row at least says which file to open.
pub fn reason_from_run_json(json: &str) -> Option<String> {
    let run: WorkflowRun = serde_json::from_str(json).ok()?;
    let name = run
        .name
        .or(run.display_title)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let path = run.path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    match (name, path) {
        (Some(n), Some(p)) => Some(format!(
            "GitHub could not start the \"{n}\" workflow ({p}). The workflow file is usually the cause."
        )),
        (Some(n), None) => Some(format!(
            "GitHub could not start the \"{n}\" workflow. The workflow file is usually the cause."
        )),
        (None, Some(p)) => Some(format!(
            "GitHub could not start the workflow at {p}. The workflow file is usually the cause."
        )),
        (None, None) => None,
    }
}

/// Resolve the plain-language reason for a `startup_failure` check run.
/// `gh` runs one `gh api` call and returns its stdout; every failure along
/// the way just means "no reason known" — the row still shows its state.
pub fn startup_failure_reason<F>(gh: F, details_url: &str) -> Option<String>
where
    F: Fn(&[&str]) -> Result<String, String>,
{
    let loc = locate_from_details_url(details_url)?;
    let base = format!("repos/{}/{}", loc.owner, loc.repo);
    if let Some(job) = loc.job_id {
        let check_run = format!("{base}/check-runs/{job}");
        if let Ok(json) = gh(&["api", &check_run]) {
            if let Some(reason) = reason_from_check_run_json(&json) {
                return Some(reason);
            }
        }
        let annotations = format!("{check_run}/annotations");
        if let Ok(json) = gh(&["api", &annotations]) {
            if let Some(reason) = reason_from_annotations_json(&json) {
                return Some(reason);
            }
        }
    }
    let run = format!("{base}/actions/runs/{}", loc.run_id);
    gh(&["api", &run])
        .ok()
        .and_then(|json| reason_from_run_json(&json))
}

fn join_nonempty(parts: &[&str], sep: &str) -> Option<String> {
    let kept: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(sep))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locator_reads_run_and_job_from_details_url() {
        let loc = locate_from_details_url(
            "https://github.com/acme/widgets/actions/runs/123456/job/7890?check_suite_focus=true",
        )
        .unwrap();
        assert_eq!(
            loc,
            CheckRunLocator {
                owner: "acme".into(),
                repo: "widgets".into(),
                run_id: 123456,
                job_id: Some(7890),
            }
        );
        // Enterprise host, no job segment.
        let loc = locate_from_details_url("https://ghe.example.com/team/app/actions/runs/42").unwrap();
        assert_eq!(loc.owner, "team");
        assert_eq!(loc.run_id, 42);
        assert_eq!(loc.job_id, None);
        // Not an Actions URL at all.
        assert!(locate_from_details_url("https://ci.example.com/build/9").is_none());
        assert!(locate_from_details_url("").is_none());
    }

    #[test]
    fn reason_prefers_check_run_output_then_annotations_then_run() {
        let with_output = r#"{"output":{"title":"Invalid workflow file","summary":"ci.yml#L12: unexpected key"}}"#;
        assert_eq!(
            reason_from_check_run_json(with_output).as_deref(),
            Some("Invalid workflow file\nci.yml#L12: unexpected key")
        );
        assert!(reason_from_check_run_json(r#"{"output":{"title":null,"summary":""}}"#).is_none());

        let ann = r#"[{"message":"Invalid workflow file","path":".github/workflows/ci.yml","start_line":12},
                      {"message":"","path":"x"}]"#;
        assert_eq!(
            reason_from_annotations_json(ann).as_deref(),
            Some("Invalid workflow file (.github/workflows/ci.yml#L12)")
        );
        assert!(reason_from_annotations_json("[]").is_none());

        let run = r#"{"name":"CI","path":".github/workflows/ci.yml"}"#;
        assert_eq!(
            reason_from_run_json(run).as_deref(),
            Some("GitHub could not start the \"CI\" workflow (.github/workflows/ci.yml). The workflow file is usually the cause.")
        );
        assert!(reason_from_run_json("{}").is_none());
    }

    #[test]
    fn startup_failure_reason_walks_the_fallback_chain() {
        // The check run has no output, annotations carry the message.
        let gh = |args: &[&str]| -> Result<String, String> {
            match args {
                ["api", p] if p.ends_with("/annotations") => Ok(
                    r#"[{"message":"No runner matched the label: gpu-large","path":".github/workflows/train.yml","start_line":3}]"#.into(),
                ),
                ["api", p] if p.contains("/check-runs/") => Ok(r#"{"output":{}}"#.into()),
                _ => Err("unexpected".into()),
            }
        };
        let reason = startup_failure_reason(
            gh,
            "https://github.com/acme/widgets/actions/runs/1/job/2",
        );
        assert_eq!(
            reason.as_deref(),
            Some("No runner matched the label: gpu-large (.github/workflows/train.yml#L3)")
        );

        // Nothing answers → no reason, never an error.
        let dead = |_: &[&str]| -> Result<String, String> { Err("offline".into()) };
        assert!(startup_failure_reason(dead, "https://github.com/a/b/actions/runs/1/job/2").is_none());
        assert!(startup_failure_reason(dead, "https://example.com/not-actions").is_none());
    }
}
