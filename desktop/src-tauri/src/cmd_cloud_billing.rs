//! Cloud billing proxy commands. The token lives in `~/.aura/credentials.json`
//! on the desktop; rather than expose it to the renderer we proxy the call.

use serde_json::Value;
use std::time::Duration;

use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};
use crate::cloud_org::OrgScoped;

/// GET a signed-in billing endpoint and hand back its JSON.
///
/// Both commands here are the same three moves — read the token, GET the path,
/// insist on a 2xx — and the interesting part of each is only which path it
/// asks for. Sharing the plumbing keeps the difference visible.
async fn get_billing_json(path: &str) -> Result<Value, String> {
    let creds = read_credentials().map_err(|e| e.to_string())?;
    let token = cloud_token(&creds).ok_or_else(|| "no cloud_api_token".to_string())?;
    let origin = cloud_origin(&creds);
    let url = format!("{origin}{path}");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }
    serde_json::from_str::<Value>(&body).map_err(|e| format!("parse: {e}"))
}

/// GET /api/v1/billing/status — which plan the caller's organization is on.
///
/// This is what the sidebar's plan chip reads. It used to read the Aura Pro
/// brain's `/v1/brain/quota` instead, which answers a different question — how
/// many tokens are left in the managed-brain bucket — and answers it only for
/// people using that brain. Everyone else got no tier at all and the chip fell
/// back to printing their handle, so the app never told anyone their plan.
///
/// The reply carries `plan` and `effective_plan`; they differ during a trial,
/// where a free org is granted team access until the trial runs out. The chip
/// shows `effective_plan` — the plan you actually have today. A caller who
/// belongs to no organization gets `{"error": …}` with a 200, which is not a
/// plan and must not be read as one.
#[tauri::command]
pub async fn cloud_billing_status() -> Result<Value, String> {
    get_billing_json("/api/v1/billing/status").await
}

/// GET /api/v1/billing/usage/by_member — returns the per-developer LLM token
/// spend for the current month. Admins receive every member's row; regular
/// members get only their own.
#[tauri::command]
pub async fn cloud_billing_usage_by_member(month: Option<String>) -> Result<Value, String> {
    let mut path = "/api/v1/billing/usage/by_member".to_string();
    if let Some(m) = month.as_ref().filter(|m| !m.is_empty()) {
        // `month` is a fixed `YYYY-MM` shape; reject anything else rather
        // than encode it — keeps the URL stable + the server-side parse
        // strict.
        let ok = m.len() == 7
            && m.as_bytes()[4] == b'-'
            && m[..4].chars().all(|c| c.is_ascii_digit())
            && m[5..].chars().all(|c| c.is_ascii_digit());
        if !ok {
            return Err(format!("month must be YYYY-MM, got {m:?}"));
        }
        path.push_str(&format!("?month={m}"));
    }

    get_billing_json(&path).await
}
