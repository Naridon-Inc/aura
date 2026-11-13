//! Re-run a pull request's failed checks — the "Re-run" next to the Checks
//! caption on the right sidebar and on the pull request's own Checks tab.
//!
//! Reads the same `statusCheckRollup` the Checks list draws from, keeps the
//! failing rows, and asks GitHub to re-run only the failed jobs of each
//! Actions run behind them (`gh run rerun <run> --failed`). A failing check
//! from another service has no run GitHub can restart, so it is skipped; if
//! nothing failing can be restarted the call says so instead of claiming a
//! re-run that never happened.

use crate::cmd_prs::{pr_checks, run_gh, GhRepo};
use crate::integrations::gh_actions::run_ids_to_rerun;

/// Re-run the failed jobs of every Actions run behind a failing check on
/// PR `number`. Returns how many runs were restarted.
#[tauri::command]
pub async fn pr_rerun_failed_checks(
    repo_root: String,
    number: u64,
    remote_repo: Option<String>,
) -> Result<u32, String> {
    let checks = pr_checks(repo_root.clone(), number, remote_repo.clone()).await?;
    let failing: Vec<String> = checks
        .into_iter()
        .filter(|c| c.bucket == "failure")
        .map(|c| c.url)
        .collect();
    if failing.is_empty() {
        return Err("No checks are failing on this pull request.".to_string());
    }
    let runs = run_ids_to_rerun(failing.iter().map(String::as_str));
    if runs.is_empty() {
        return Err(
            "None of the failing checks run on GitHub Actions, so GitHub can't re-run them from here."
                .to_string(),
        );
    }
    crate::blocking::run(move || {
        let repo = GhRepo::new(&repo_root, remote_repo)?;
        for run in &runs {
            let id = run.to_string();
            run_gh(&repo, &["run", "rerun", &id, "--failed"])?;
        }
        Ok(runs.len() as u32)
    })
    .await
}
