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
    /// Coarse health of the Codex CLI, so the UI can tell apart a working
    /// install that's simply signed-out from one that can't run at all:
    ///   - "logged_in"  — CLI works, an account is authenticated
    ///   - "logged_out" — CLI works, no account yet (offer sign-in)
    ///   - "broken"     — `codex` is on PATH but won't run (typically a
    ///                    half-installed npm package missing its native
    ///                    binary); sign-in can't work until it's reinstalled
    ///   - "missing"    — `codex` isn't installed / not on PATH
    pub state: String,
    /// Human-readable explanation shown to the user when `state` is
    /// "broken" or "missing" (e.g. the CLI's own reinstall hint).
    pub detail: Option<String>,
    /// A shell command that repairs a missing/broken install, surfaced so
    /// the user can copy-run it. `None` when nothing needs fixing.
    pub fix_command: Option<String>,
    /// True when Codex credentials exist on disk (`$CODEX_HOME/auth.json`,
    /// default `~/.codex/auth.json`) — the user has signed in to Codex or
    /// ChatGPT (via the CLI or the ChatGPT/Codex app), even if the CLI
    /// binary itself is currently unavailable.
    pub has_credentials: bool,
}

/// Whether Codex credentials exist on disk. Codex (and the ChatGPT/Codex
/// app that shares the same store) writes its OAuth/API tokens to
/// `$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`. Presence
/// lets us tell an already-signed-in user "you're connected — reinstall
/// the CLI to use it" instead of dead-ending them at a sign-in button.
fn codex_credentials_exist() -> bool {
    let base = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|h| std::path::PathBuf::from(h).join(".codex"))
        });
    base.map(|b| b.join("auth.json").exists()).unwrap_or(false)
}

/// Pull the CLI's own "Reinstall Codex: <cmd>" hint out of its stderr, if
/// present — the npm wrapper prints an exact repair command when its
/// native binary is missing. Falls back to the canonical install command.
fn codex_reinstall_command(stderr: &str) -> String {
    stderr
        .lines()
        .find_map(|l| l.split_once("Reinstall Codex:").map(|(_, cmd)| cmd.trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "npm install -g @openai/codex@latest".to_string())
}

#[tauri::command]
pub async fn codex_auth_status() -> Result<CodexAuthStatus, String> {
    let has_credentials = codex_credentials_exist();

    // Health gate first. `codex login status` alone can't distinguish a
    // signed-out install from a broken one — a half-installed npm package
    // (wrapper present, native binary absent) exits non-zero with an empty
    // stdout, which the old code read as "not logged in". `codex --version`
    // is a cheap probe that only succeeds on a runnable binary.
    match Command::new("codex").arg("--version").output().await {
        Err(_) => {
            // `codex` isn't on PATH at all.
            return Ok(CodexAuthStatus {
                state: "missing".into(),
                detail: Some("The Codex CLI isn't installed.".into()),
                fix_command: Some("npm install -g @openai/codex".into()),
                has_credentials,
                ..Default::default()
            });
        }
        Ok(o) if !o.status.success() => {
            // On PATH but won't run — surface the CLI's own reinstall hint.
            let stderr = String::from_utf8_lossy(&o.stderr);
            return Ok(CodexAuthStatus {
                state: "broken".into(),
                detail: Some(
                    "Codex is installed but won't run — it needs reinstalling.".into(),
                ),
                fix_command: Some(codex_reinstall_command(&stderr)),
                has_credentials,
                ..Default::default()
            });
        }
        Ok(_) => { /* runnable — fall through to the auth check */ }
    }

    // Binary is healthy — read the signed-in state.
    let out = Command::new("codex")
        .args(["login", "status"])
        .output()
        .await
        .map_err(|e| format!("codex login status failed: {e}"))?;
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
            state: "logged_in".into(),
            has_credentials: true,
            ..Default::default()
        })
    } else {
        Ok(CodexAuthStatus {
            state: "logged_out".into(),
            has_credentials,
            ..Default::default()
        })
    }
}

#[tauri::command]
pub async fn codex_auth_login() -> Result<i32, String> {
    // `codex login` opens the ChatGPT OAuth flow in the browser and blocks
    // until the callback lands, then exits. We capture stderr (rather than
    // discarding it) so a failure — a broken install, a cancelled flow —
    // surfaces a real reason to the UI instead of a silent no-op.
    let out = Command::new("codex")
        .arg("login")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("codex login failed to start: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("Reinstall Codex:") || stderr.contains("Missing optional dependency") {
            return Err(format!(
                "Codex needs reinstalling before you can sign in. Run: {}",
                codex_reinstall_command(&stderr)
            ));
        }
        let msg = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_string())
            .unwrap_or_default();
        return Err(if msg.is_empty() {
            "Codex sign-in didn't complete.".into()
        } else {
            msg
        });
    }
    Ok(out.status.code().unwrap_or(0))
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
    // Capture output so a rejected key / broken install returns a reason.
    // The key itself is only ever written to stdin — never logged.
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("codex login wait: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("Reinstall Codex:") || stderr.contains("Missing optional dependency") {
            return Err(format!(
                "Codex needs reinstalling before you can sign in. Run: {}",
                codex_reinstall_command(&stderr)
            ));
        }
        let msg = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_string())
            .unwrap_or_default();
        return Err(if msg.is_empty() {
            "Codex didn't accept the API key.".into()
        } else {
            msg
        });
    }
    Ok(out.status.code().unwrap_or(0))
}

