//! Pokes, over the same `/api/v2/public/...` proxy as `cmd_cloud_team` — the
//! renderer never holds the token. An id is checked before it goes into a path,
//! so a malformed one never reaches the server.

use serde_json::{json, Value};

use crate::cmd_cloud_workspaces::{call_at, path_id, Verb};

const PUBLIC: &str = "/api/v2/public";

async fn call(verb: Verb, path: &str, body: Option<Value>) -> Result<Value, String> {
    call_at(verb, &format!("{PUBLIC}{path}"), body).await
}

/// POST /public/members/{id}/poke.
#[tauri::command]
pub async fn cloud_member_poke(user_id: String) -> Result<Value, String> {
    let id = path_id(user_id.trim())?;
    call(Verb::Post, &format!("/members/{id}/poke"), None).await
}

/// GET /public/pokes — pokes sent to me in the last few seconds.
#[tauri::command]
pub async fn cloud_pokes() -> Result<Value, String> {
    call(Verb::Get, "/pokes", None).await
}

/// GET /public/pokes/settings.
#[tauri::command]
pub async fn cloud_poke_settings() -> Result<Value, String> {
    call(Verb::Get, "/pokes/settings", None).await
}

/// PUT /public/pokes/settings.
#[tauri::command]
pub async fn cloud_poke_settings_set(enabled: bool) -> Result<Value, String> {
    call(Verb::Put, "/pokes/settings", Some(json!({ "enabled": enabled }))).await
}
