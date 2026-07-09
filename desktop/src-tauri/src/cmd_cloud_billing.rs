//! Cloud billing proxy commands. The token lives in `~/.aura/credentials.json`
//! on the desktop; rather than expose it to the renderer we proxy the call.

use serde_json::Value;
use std::time::Duration;

use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// GET /api/v1/billing/usage/by_member — returns the per-developer LLM token
/// spend for the current month. Admins receive every member's row; regular
/// members get only their own.
#[tauri::command]
pub async fn cloud_billing_usage_by_member(month: Option<String>) -> Result<Value, String> {
    let creds = read_credentials().map_err(|e| e.to_string())?;
    let token = cloud_token(&creds).ok_or_else(|| "no cloud_api_token".to_string())?;
    let origin = cloud_origin(&creds);

    let mut url = format!("{origin}/api/v1/billing/usage/by_member");
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
        url.push_str(&format!("?month={m}"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }
    serde_json::from_str::<Value>(&body).map_err(|e| format!("parse: {e}"))
}
