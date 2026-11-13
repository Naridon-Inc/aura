//! The signed-in member's own agent sign-ins and env vars for cloud
//! workspaces.
//!
//! Proxied rather than handing the renderer the cloud token, like every other
//! cloud call. A value goes up once, on save, and nothing here ever reads one
//! back: the server answers a save with the name and the time, and the list
//! carries names only.

use serde_json::{json, Value};

use crate::cmd_cloud_workspaces::{call_at, Verb};

const ME: &str = "/api/v2/me";

/// The names the cloud keeps for an agent sign-in. Anything else is refused
/// here before it reaches the network.
const CREDENTIALS: &[&str] = &[
    "anthropic_api_key",
    "claude_code_oauth_token",
    "codex_api_key",
    "codex_chatgpt_auth",
    "cursor_api_key",
    "openrouter_api_key",
    "vercel_ai_gateway_api_key",
    "bedrock_credentials",
    "claude_user_managed",
    "codex_user_managed",
];

const HARNESSES: &[&str] = &["claude", "codex", "cursor"];

fn credential_name(name: &str) -> Result<&str, String> {
    CREDENTIALS
        .iter()
        .copied()
        .find(|n| *n == name)
        .ok_or_else(|| format!("not a sign-in this app saves: {name:?}"))
}

fn harness(name: &str) -> Result<&str, String> {
    HARNESSES
        .iter()
        .copied()
        .find(|n| *n == name)
        .ok_or_else(|| format!("not an agent cloud workspaces run: {name:?}"))
}

/// A shell variable name, as the cloud requires it.
fn env_name(name: &str) -> Result<&str, String> {
    let mut chars = name.chars();
    let ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        Ok(name)
    } else {
        Err(format!("not a variable name: {name:?}"))
    }
}

fn workspace_query(workspace_id: Option<&str>) -> Result<String, String> {
    match workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => Ok(format!("?workspace_id={}", crate::cmd_cloud_workspaces::path_id(id)?)),
        None => Ok(String::new()),
    }
}

/// GET /me/agent-credentials — which sign-ins the member has saved, by name.
#[tauri::command]
pub async fn cloud_agent_credentials_list() -> Result<Value, String> {
    call_at(Verb::Get, &format!("{ME}/agent-credentials"), None).await
}

/// PUT /me/agent-credentials/{name} — save one sign-in, as the member's
/// default or for one workspace.
#[tauri::command]
pub async fn cloud_agent_credential_save(
    name: String,
    value: String,
    workspace_id: Option<String>,
) -> Result<Value, String> {
    let name = credential_name(&name)?;
    let mut body = json!({ "value": value });
    if let Some(ws) = workspace_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        body["workspace_id"] = json!(crate::cmd_cloud_workspaces::path_id(ws)?);
    }
    call_at(Verb::Put, &format!("{ME}/agent-credentials/{name}"), Some(body)).await
}

/// DELETE /me/agent-credentials/{name} — forget one sign-in.
#[tauri::command]
pub async fn cloud_agent_credential_remove(name: String, workspace_id: Option<String>) -> Result<Value, String> {
    let name = credential_name(&name)?;
    let q = workspace_query(workspace_id.as_deref())?;
    call_at(Verb::Delete, &format!("{ME}/agent-credentials/{name}{q}"), None).await
}

/// PUT /me/agent-selections/{harness} — run that agent on the subscription or
/// on the API key.
#[tauri::command]
pub async fn cloud_agent_selection_set(harness_name: String, selection: String) -> Result<Value, String> {
    let h = harness(&harness_name)?;
    if selection != "subscription" && selection != "api_key" {
        return Err(format!("not a sign-in choice: {selection:?}"));
    }
    call_at(Verb::Put, &format!("{ME}/agent-selections/{h}"), Some(json!({ "selection": selection }))).await
}

/// GET /me/env-vars — the member's own variable names.
#[tauri::command]
pub async fn cloud_env_vars_list() -> Result<Value, String> {
    call_at(Verb::Get, &format!("{ME}/env-vars"), None).await
}

/// PUT /me/env-vars/{name}
#[tauri::command]
pub async fn cloud_env_var_save(name: String, value: String) -> Result<Value, String> {
    let n = env_name(&name)?;
    call_at(Verb::Put, &format!("{ME}/env-vars/{n}"), Some(json!({ "value": value }))).await
}

/// DELETE /me/env-vars/{name}
#[tauri::command]
pub async fn cloud_env_var_remove(name: String) -> Result<Value, String> {
    let n = env_name(&name)?;
    call_at(Verb::Delete, &format!("{ME}/env-vars/{n}"), None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_names_the_cloud_keeps_reach_a_path() {
        assert!(credential_name("anthropic_api_key").is_ok());
        assert!(credential_name("bedrock_credentials").is_ok());
        assert!(credential_name("../billing").is_err());
        assert!(credential_name("muse_api_key").is_err());
        assert!(harness("codex").is_ok());
        assert!(harness("gemini").is_err());
    }

    #[test]
    fn env_names_are_shell_names() {
        assert!(env_name("DATABASE_URL").is_ok());
        assert!(env_name("1X").is_err());
        assert!(env_name("A/B").is_err());
        assert!(env_name("").is_err());
    }

    #[test]
    fn a_workspace_override_is_an_id_or_nothing() {
        assert_eq!(workspace_query(None).unwrap(), "");
        assert_eq!(workspace_query(Some(" ")).unwrap(), "");
        assert_eq!(workspace_query(Some("3f1c-9a")).unwrap(), "?workspace_id=3f1c-9a");
        assert!(workspace_query(Some("a&b=c")).is_err());
    }
}
