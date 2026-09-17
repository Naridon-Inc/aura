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
    /// How the phone asked for this turn to run — `{mode, model, effort}` from
    /// the mobile composer. Absent on turns from older clients.
    #[serde(default)]
    metadata: Option<serde_json::Value>,
    created_at: DateTime<Utc>,
}

/// Turn the phone composer's settings into the words the agent reads.
///
/// The mobile composer offers three ways to run a turn — make changes (the
/// default), plan first, or only answer — plus an extended-thinking switch.
/// The cloud stores that choice on the message; this is where it takes
/// effect, as a short instruction ahead of the user's own text, so every
/// brain backend honours it the same way. A turn with no settings, or the
/// default mode, is passed through untouched.
fn apply_turn_settings(body: String, metadata: Option<&serde_json::Value>) -> String {
    let Some(meta) = metadata else { return body };
    let mode = meta.get("mode").and_then(|v| v.as_str()).unwrap_or("agent");
    let extended = meta.get("effort").and_then(|v| v.as_str()) == Some("extended");
    let mut lead: Vec<&str> = Vec::new();
    match mode {
        "plan" => lead.push(
            "[Plan mode] Explore the code and write a step-by-step plan first. \
             Do not edit any files until I approve the plan.",
        ),
        "ask" => lead.push(
            "[Ask mode] Answer and investigate only. Do not edit files or run \
             commands that change anything.",
        ),
        _ => {}
    }
    if extended {
        lead.push("Take extra time to reason carefully before you answer.");
    }
    if lead.is_empty() {
        return body;
    }
    format!("{}\n\n{}", lead.join("\n"), body)
}

/// The phone's Stop button arrives as a user message carrying
/// `metadata.control = "stop"`. It is a request, not a turn: the session is
/// held the way the desktop's own Pause holds it, so no further step starts
/// until the next instruction arrives.
fn is_stop_request(metadata: Option<&serde_json::Value>) -> bool {
    metadata
        .and_then(|m| m.get("control"))
        .and_then(|v| v.as_str())
        == Some("stop")
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
                        if is_stop_request(m.metadata.as_ref()) {
                            if let Err(e) = crate::cmd_manager::manager_pause(
                                app.clone(),
                                runtime,
                                session_id.clone(),
                            )
                            .await
                            {
                                warn!(target: "cloud_inbox", "stop failed: {e}");
                            }
                            continue;
                        }
                        if let Err(e) = crate::cmd_manager::inject_user_message_from_cloud(
                            app.clone(),
                            runtime,
                            session_id.clone(),
                            apply_turn_settings(m.body, m.metadata.as_ref()),
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

#[cfg(test)]
mod tests {
    use super::{apply_turn_settings, is_stop_request};
    use serde_json::json;

    #[test]
    fn only_a_stop_control_is_a_stop_request() {
        assert!(is_stop_request(Some(&json!({ "mode": "agent", "control": "stop" }))));
        assert!(!is_stop_request(Some(&json!({ "mode": "plan" }))));
        assert!(!is_stop_request(Some(&json!({ "control": "sleep" }))));
        assert!(!is_stop_request(None));
    }

    #[test]
    fn no_settings_passes_the_turn_through() {
        assert_eq!(apply_turn_settings("fix it".into(), None), "fix it");
        let agent = json!({ "mode": "agent", "effort": "standard" });
        assert_eq!(apply_turn_settings("fix it".into(), Some(&agent)), "fix it");
    }

    #[test]
    fn plan_mode_asks_for_a_plan_before_edits() {
        let meta = json!({ "mode": "plan" });
        let out = apply_turn_settings("add retries".into(), Some(&meta));
        assert!(out.starts_with("[Plan mode]"));
        assert!(out.ends_with("\n\nadd retries"));
    }

    #[test]
    fn ask_mode_and_extended_thinking_stack() {
        let meta = json!({ "mode": "ask", "effort": "extended", "model": "Sonnet" });
        let out = apply_turn_settings("why is this slow?".into(), Some(&meta));
        assert!(out.starts_with("[Ask mode]"));
        assert!(out.contains("Take extra time to reason"));
        assert!(out.ends_with("why is this slow?"));
    }
}
