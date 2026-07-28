//! Vercel deploy-status reader — REST, token-only.
//!
//! No OAuth: Vercel issues a long-lived personal/team access token that we
//! send as a Bearer on the REST API. Given a commit sha (and optionally a
//! branch) we ask Vercel for the most recent deployment of that commit and
//! surface it as a single chip on the PR checks view: is the deploy live,
//! still building, or failed — with the inspector URL to open in Vercel and
//! the preview URL to open the deploy itself.
//!
//! Endpoint: `GET https://api.vercel.com/v6/deployments`. We filter by `sha`
//! (Vercel indexes deployments by the git commit they were built from), plus
//! `projectId` / `teamId` when configured to narrow the scope. The response
//! lists deployments newest-first; we take the first that matches.
//!
//! Everything here is best-effort enrichment — a wedged network call or an
//! unconfigured project degrades to "no deploy info" (the caller returns
//! `Ok(None)`), never a hard error on the PR view.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::config::VercelConfig;
use super::types::IntegrationError;

const DEPLOYMENTS_URL: &str = "https://api.vercel.com/v6/deployments";

/// Short HTTP timeout — the PR checks view must not hang on a slow Vercel.
const HTTP_TIMEOUT_SECS: u64 = 12;

/// One deployment, flattened to exactly what the PR deploy chip renders.
/// `state` is Vercel's readyState string verbatim (READY / BUILDING / ERROR
/// / QUEUED / CANCELED / INITIALIZING / …) so the frontend owns the
/// plain-language mapping and we don't lose a state Vercel adds later.
#[derive(Debug, Clone, Serialize)]
pub struct VercelDeployment {
    /// Deployment id (`dpl_…`).
    pub uid: String,
    /// Vercel readyState, uppercase (READY, BUILDING, ERROR, …).
    pub state: String,
    /// Deployment URL (host only, no scheme — Vercel returns `foo.vercel.app`).
    pub url: Option<String>,
    /// Link into the Vercel dashboard for this deployment's build logs.
    pub inspector_url: Option<String>,
    /// Deploy target — `production`, `staging`, or null for a preview.
    pub target: Option<String>,
    /// Creation time, unix-millis (Vercel returns ms already).
    pub created_at_ms: Option<u64>,
}

/// Vercel's `/v6/deployments` envelope.
#[derive(Debug, Deserialize)]
struct DeploymentsResponse {
    #[serde(default)]
    deployments: Vec<RawDeployment>,
}

/// One raw deployment row. Vercel spells the state `state` on some plans and
/// `readyState` on others; we accept either and prefer whichever is present.
#[derive(Debug, Deserialize)]
struct RawDeployment {
    uid: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(rename = "readyState", default)]
    ready_state: Option<String>,
    #[serde(rename = "inspectorUrl", default)]
    inspector_url: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    created: Option<u64>,
}

/// Fetch the most recent deployment for `sha`. Returns `Ok(None)` when Vercel
/// knows of no deployment for that commit (a branch that was never deployed,
/// or a commit still propagating) — the caller shows no chip rather than an
/// error. `branch` is currently unused by the query (sha is the precise key)
/// but is accepted so the signature stays stable if we later widen the filter.
pub async fn latest_for(
    cfg: &VercelConfig,
    sha: &str,
    _branch: Option<&str>,
) -> Result<Option<VercelDeployment>, IntegrationError> {
    if sha.trim().is_empty() {
        return Ok(None);
    }
    let client = http_client()?;

    // Build the query. `sha` pins the commit; `limit=20` is plenty since a
    // single commit rarely has more than a handful of deployments. `projectId`
    // / `teamId` narrow scope when configured.
    let mut query: Vec<(&str, String)> = vec![
        ("sha", sha.to_string()),
        ("limit", "20".to_string()),
    ];
    if let Some(pid) = cfg.project_id.as_deref().filter(|s| !s.is_empty()) {
        query.push(("projectId", pid.to_string()));
    }
    if let Some(tid) = cfg.team_id.as_deref().filter(|s| !s.is_empty()) {
        query.push(("teamId", tid.to_string()));
    }

    let resp = client
        .get(DEPLOYMENTS_URL)
        .bearer_auth(&cfg.token)
        .query(&query)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(IntegrationError::Http {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: DeploymentsResponse = resp.json().await?;

    // The list is newest-first; take the first with the highest `created`
    // defensively in case ordering ever changes.
    let best = parsed
        .deployments
        .into_iter()
        .max_by_key(|d| d.created.unwrap_or(0));
    Ok(best.map(|d| VercelDeployment {
        uid: d.uid,
        state: d
            .ready_state
            .or(d.state)
            .unwrap_or_else(|| "UNKNOWN".to_string())
            .to_uppercase(),
        url: d.url,
        inspector_url: d.inspector_url,
        target: d.target,
        created_at_ms: d.created,
    }))
}

fn http_client() -> Result<reqwest::Client, IntegrationError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| IntegrationError::Other(format!("reqwest build: {e}")))
}
