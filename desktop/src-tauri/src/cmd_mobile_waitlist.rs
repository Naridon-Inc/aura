// "Tell me when the phone app is ready" — the in-app waitlist for Aura on
// iOS and Android.
//
// The list lives on our own server, not a third-party form host, so the only
// people who can read who signed up are us. The submit happens HERE, in Rust,
// rather than in the webview: posting from the page would put the request (and
// the user's email) on the webview's own fetch stack — subject to CORS, to the
// app CSP, and visible to anything else running in the window. A Tauri command
// keeps the whole exchange out of the UI layer.
//
// Joining is remembered on disk (~/.aura/mobile_waitlist.json) so the app can
// say "you're on the list" instead of showing the same empty form forever.
// That file is the ONLY thing stored locally — no analytics, no second copy of
// the address.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cloud_session_sync::aura_dir;

/// Our own waitlist endpoint. The server validates the address again, keeps
/// one row per person, and answers the same way for a fresh sign-up and a
/// repeat — so nothing here leaks who else is on the list.
const WAITLIST_ENDPOINT: &str = "https://auravcs.com/api/v2/waitlist";
const SOURCE_TAG: &str = "desktop-app";
const STATE_FILE: &str = "mobile_waitlist.json";
const TIMEOUT: Duration = Duration::from_secs(20);

/// Which app the person is waiting for.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WaitlistPlatform {
    Ios,
    Android,
    Both,
}

impl WaitlistPlatform {
    fn as_field(self) -> &'static str {
        match self {
            Self::Ios => "ios",
            Self::Android => "android",
            Self::Both => "both",
        }
    }
}

/// What the app remembers locally once someone has joined.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WaitlistState {
    pub joined: bool,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub platform: Option<WaitlistPlatform>,
    /// RFC3339 timestamp of the successful submit.
    #[serde(default)]
    pub joined_at: String,
}

impl Default for WaitlistState {
    fn default() -> Self {
        Self {
            joined: false,
            email: String::new(),
            platform: None,
            joined_at: String::new(),
        }
    }
}

fn state_path() -> Result<PathBuf, String> {
    Ok(aura_dir()?.join(STATE_FILE))
}

/// Loose sanity check only — the server is the real validator. This exists so
/// an obvious typo fails instantly in the UI instead of after a network
/// round-trip.
fn looks_like_email(raw: &str) -> bool {
    let s = raw.trim();
    if s.len() < 5 || s.len() > 254 || s.contains(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.len() >= 3
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

/// Has this install already joined? Read from disk every time so deleting the
/// file (or signing in on another machine) behaves the way you'd expect.
#[tauri::command]
pub fn mobile_waitlist_status() -> Result<WaitlistState, String> {
    let path = state_path()?;
    if !path.exists() {
        return Ok(WaitlistState::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    // A hand-mangled file shouldn't wedge the pane — fall back to "not joined"
    // so the form still works.
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn remember(email: &str, platform: WaitlistPlatform) -> Result<WaitlistState, String> {
    let state = WaitlistState {
        joined: true,
        email: email.to_string(),
        platform: Some(platform),
        joined_at: chrono::Utc::now().to_rfc3339(),
    };
    let path = state_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(state)
}

/// Join the iOS / Android waitlist. Returns the remembered state so the UI can
/// switch straight to "you're on the list" without a second call.
#[tauri::command]
pub async fn mobile_waitlist_join(
    email: String,
    name: Option<String>,
    platform: WaitlistPlatform,
) -> Result<WaitlistState, String> {
    let email = email.trim().to_string();
    if !looks_like_email(&email) {
        return Err("That doesn't look like an email address.".into());
    }
    let name = name.unwrap_or_default().trim().to_string();

    // Only what the list actually needs: the address, which phone they're
    // waiting for, and enough context to know where a sign-up came from.
    let mut body = serde_json::json!({
        "email": email,
        "platform": platform.as_field(),
        "source": SOURCE_TAG,
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
    });
    if !name.is_empty() {
        body["name"] = serde_json::Value::String(name);
    }

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .post(WAITLIST_ENDPOINT)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Couldn't reach the waitlist — the request timed out. Try again in a moment."
                    .to_string()
            } else {
                "Couldn't reach the waitlist. Check your connection and try again.".to_string()
            }
        })?;

    let status = resp.status();
    if !status.is_success() {
        // The server sends a plain-language reason for the cases a person can
        // act on (a malformed address, too many tries). Prefer it over a bare
        // status code, and fall back when the body isn't the shape we expect.
        let reason = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        return Err(match reason {
            Some(message) => message,
            None => format!(
                "The waitlist turned that down ({}). Try again in a moment.",
                status.as_u16()
            ),
        });
    }

    remember(&email, platform)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_addresses() {
        assert!(looks_like_email("jane@example.com"));
        assert!(looks_like_email("  jane.doe+aura@sub.example.co.uk  "));
    }

    #[test]
    fn rejects_obvious_typos() {
        assert!(!looks_like_email(""));
        assert!(!looks_like_email("jane"));
        assert!(!looks_like_email("jane@"));
        assert!(!looks_like_email("@example.com"));
        assert!(!looks_like_email("jane@example"));
        assert!(!looks_like_email("jane@.com"));
        assert!(!looks_like_email("jane doe@example.com"));
    }

    #[test]
    fn platform_matches_the_values_the_server_accepts() {
        assert_eq!(WaitlistPlatform::Ios.as_field(), "ios");
        assert_eq!(WaitlistPlatform::Android.as_field(), "android");
        assert_eq!(WaitlistPlatform::Both.as_field(), "both");
    }

    #[test]
    fn unreadable_state_reads_as_not_joined() {
        let fallback: WaitlistState = serde_json::from_str("{ not json }").unwrap_or_default();
        assert!(!fallback.joined);
    }
}
