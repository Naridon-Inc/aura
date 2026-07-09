//! Auth surface for the agent CLIs we shell out to. Replaces the
//! previous behaviour where Aura's onboarding "Connect Claude Code"
//! button drove our own cloud device-code flow (app.auravcs.com).
//!
//! Each agent CLI owns its own OAuth. We just:
//!   - read the CLI's reported auth status (JSON for Claude, plain
//!     text for Codex) so the dialog can render "Connected as X" or
//!     "Not connected"
//!   - kick off the CLI's native login subcommand, which spawns the
//!     OAuth browser flow against the provider (claude.ai for
//!     Anthropic, chatgpt.com for OpenAI). The subprocess blocks
//!     until the OAuth callback returns, then exits; we just await
//!     that and re-read status.
//!   - accept an API key for the API-key path. For Codex this is
//!     `codex login --with-api-key`, fed via stdin. For Claude there is
//!     no CLI-side API-key login — the frontend writes the key via the
//!     existing `settings_set_provider_key("anthropic", …)` command
//!     (see `cmd_settings.rs`), which is the single source of truth for
//!     credentials. The Manager brain + aurawatch reads from the same
//!     file at `~/.aura/credentials.json`.

use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct ClaudeAuthStatus {
    pub logged_in: bool,
    pub email: Option<String>,
    pub auth_method: Option<String>,
    pub api_provider: Option<String>,
    pub subscription_type: Option<String>,
    pub org_name: Option<String>,
}

#[tauri::command]
pub async fn claude_auth_status() -> Result<ClaudeAuthStatus, String> {
    let out = Command::new("claude")
        .args(["auth", "status"])
        .output()
        .await
        .map_err(|e| format!("claude CLI not on PATH: {e}"))?;
    // `claude auth status` exits 0 whether logged in or not; the JSON
    // tells us. If exit is non-zero we treat it as "unknown" → not logged in.
    if !out.status.success() {
        return Ok(ClaudeAuthStatus::default());
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("claude status not JSON: {e}"))?;
    Ok(ClaudeAuthStatus {
        logged_in: parsed
            .get("loggedIn")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        email: parsed
            .get("email")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        auth_method: parsed
            .get("authMethod")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        api_provider: parsed
            .get("apiProvider")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        subscription_type: parsed
            .get("subscriptionType")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        org_name: parsed
            .get("orgName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Spawn `claude auth login` and wait for the OAuth callback to land.
/// `method` selects "claudeai" (Pro/Max subscription) or "console"
/// (Anthropic Console API billing). The CLI handles opening the
/// browser; we just await its exit and let the caller re-poll status.
#[tauri::command]
pub async fn claude_auth_login(method: String) -> Result<i32, String> {
    let flag = match method.as_str() {
        "console" => "--console",
        _ => "--claudeai",
    };
    let status = Command::new("claude")
        .args(["auth", "login", flag])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("claude auth login failed to start: {e}"))?;
    Ok(status.code().unwrap_or(-1))
}

#[tauri::command]
pub async fn claude_auth_logout() -> Result<(), String> {
    let out = Command::new("claude")
        .args(["auth", "logout"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct CodexAuthStatus {
    pub logged_in: bool,
    /// "ChatGPT" or "API key" or unknown — whatever `codex login status`
    /// reports as the trailing identifier on its single text line.
    pub method: Option<String>,
}

#[tauri::command]
pub async fn codex_auth_status() -> Result<CodexAuthStatus, String> {
    let out = Command::new("codex")
        .args(["login", "status"])
        .output()
        .await
        .map_err(|e| format!("codex CLI not on PATH: {e}"))?;
    // codex prints plain text e.g. "Logged in using ChatGPT" or
    // "Not logged in". Exit code mirrors that — 0 when logged in.
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let lower = text.to_lowercase();
    if lower.starts_with("logged in") {
        let method = lower
            .split("using")
            .nth(1)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Ok(CodexAuthStatus {
            logged_in: true,
            method,
        })
    } else {
        Ok(CodexAuthStatus::default())
    }
}

#[tauri::command]
pub async fn codex_auth_login() -> Result<i32, String> {
    let status = Command::new("codex")
        .arg("login")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("codex login failed to start: {e}"))?;
    Ok(status.code().unwrap_or(-1))
}

/// Open a macOS System Settings pane via the `x-apple.systempreferences:`
/// URL scheme. We shell out to `/usr/bin/open` because the Tauri opener
/// plugin's `opener:default` permission only whitelists http/https.
/// `pane` is one of the suffix tokens accepted by the scheme, e.g.
/// `Privacy_AllFiles`, `Privacy_Accessibility`, `Privacy_Microphone`.
#[tauri::command]
pub async fn open_macos_privacy_pane(pane: String) -> Result<(), String> {
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
    let status = Command::new("/usr/bin/open")
        .arg(&url)
        .status()
        .await
        .map_err(|e| format!("open {url}: {e}"))?;
    if !status.success() {
        // Fall back to opening the top-level Security pane.
        let _ = Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security")
            .status()
            .await;
    }
    Ok(())
}

/// Codex's API-key login path. Pipes the key to `codex login --with-api-key`
/// over stdin (same recipe Codex docs recommend). Never logs the key.
#[tauri::command]
pub async fn codex_auth_login_api_key(api_key: String) -> Result<i32, String> {
    let mut child = Command::new("codex")
        .args(["login", "--with-api-key"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("codex login --with-api-key failed to start: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(api_key.as_bytes())
            .await
            .map_err(|e| format!("write api key: {e}"))?;
        // Close stdin so codex stops reading.
        drop(stdin);
    }
    let status = child
        .wait()
        .await
        .map_err(|e| format!("codex login wait: {e}"))?;
    Ok(status.code().unwrap_or(-1))
}

