//! Pull inbound mobile chat turns into the local Manager session.
//!
//! Counterpart to `cloud_session_sync` which pushes outbound turns —
//! together they form the round-trip that lets the user start a
//! conversation on desktop and continue it on the paired phone (or vice
//! versa). One poller per live Manager session; it shuts itself down
//! once the session is removed from the runtime.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tracing::warn;

use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};
use crate::cloud_org::OrgScoped;

#[derive(Debug, Deserialize)]
struct PolledMessage {
    role: String,
    body: String,
    #[serde(default)]
    source: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct PollResp {
    #[serde(default)]
    messages: Vec<PolledMessage>,
}

/// Spawn the inbox poller for `session_id`. Returns immediately; the
/// task runs until the session is dropped from `ManagerRuntime`.
pub fn spawn_inbox_poller(app: AppHandle, session_id: String) {
    tauri::async_runtime::spawn(async move {
        // Start polling from "now" so we never replay history the
        // desktop already saw — only new mobile turns arrive.
        let mut last_seen: DateTime<Utc> = Utc::now();
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;

            // If the session was dropped from the runtime (closed in UI,
            // panicked, etc) end the poll loop. Cheap to re-check each
            // tick; avoids leaking tasks across shell lifetime.
            let still_live = match app.try_state::<crate::cmd_manager::ManagerRuntime>() {
                Some(rt) => rt.sessions.lock().unwrap().contains_key(&session_id),
                None => false,
            };
            if !still_live {
                break;
            }

            match poll_once(&session_id, last_seen).await {
                Ok(messages) => {
                    for m in messages {
                        if m.created_at > last_seen {
                            last_seen = m.created_at;
                        }
                        // Skip echoes of our own desktop pushes — only
                        // ingest turns that actually came from the phone
                        // (or any other non-shell client).
                        if m.source.as_deref() == Some("aura-shell") {
                            continue;
                        }
                        if m.role != "user" {
                            continue;
                        }
                        let runtime: tauri::State<'_, crate::cmd_manager::ManagerRuntime> =
                            app.state();
                        if let Err(e) = crate::cmd_manager::inject_user_message_from_cloud(
                            app.clone(),
                            runtime,
                            session_id.clone(),
                            m.body,
                        )
                        .await
                        {
                            warn!(target: "cloud_inbox", "inject failed: {e}");
                        }
                    }
                }
                Err(e) => {
                    // Most likely cause: no cloud token yet. Don't spam
                    // the log on every tick — debug-level only.
                    tracing::debug!(target: "cloud_inbox", "poll skipped: {e}");
                }
            }
        }
    });
}

async fn poll_once(
    session_id: &str,
    since: DateTime<Utc>,
) -> Result<Vec<PolledMessage>, String> {
    let creds = read_credentials()?;
    let token = cloud_token(&creds).ok_or("no cloud_api_token")?;
    let origin = cloud_origin(&creds);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let url = format!(
        "{origin}/api/v2/sessions/{session_id}/messages?since={}",
        since.to_rfc3339(),
    );
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {txt}"));
    }
    let body: PollResp = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(body.messages)
}
