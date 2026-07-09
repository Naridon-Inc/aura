//! Cloud sign-in for the desktop shell.
//!
//! Mirrors `aura-cli::cloud_connect` (device-code OAuth via aura-cloud).
//! The shell does the start+poll exchange so the frontend stays
//! framework-agnostic: it shows the user_code, opens the verify URL,
//! and polls every few seconds until the server returns an `approved`
//! token.
//!
//! Credentials land in the same file the CLI uses (`~/.aura/credentials.json`)
//! so signing in once from either surface unlocks both.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use crate::cloud_session_sync::{aura_dir, cloud_origin, cloud_token, read_credentials};

const DEFAULT_CLOUD: &str = "https://auravcs.com";

#[derive(Debug, Serialize)]
pub struct CloudStartResp {
    pub user_code: String,
    pub device_code: String,
    pub verify_url: String,
    pub expires_in: u64,
    pub poll_interval: u64,
    pub cloud_url: String,
}

#[derive(Debug, Deserialize)]
struct StartBody {
    user_code: String,
    device_code: String,
    verify_url: String,
    expires_in: u64,
    poll_interval: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudPollStatus {
    Pending,
    Approved,
    Expired,
    Invalid,
    Used,
}

#[derive(Debug, Serialize)]
pub struct CloudPollResp {
    pub status: CloudPollStatus,
    pub user: Option<String>,
    pub org_slug: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PollBody {
    status: String,
    token: Option<String>,
    user: Option<String>,
    org_slug: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct CloudAuthStatus {
    pub connected: bool,
    pub user: Option<String>,
    pub org_slug: Option<String>,
    pub cloud_url: String,
}

fn credentials_path() -> Result<PathBuf, String> {
    let dir = aura_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    Ok(dir.join("credentials.json"))
}

fn write_credentials(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let path = credentials_path()?;
    let pretty = serde_json::to_string_pretty(map)
        .map_err(|e| format!("serialize credentials.json: {e}"))?;
    fs::write(&path, pretty).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(&path, perms);
        }
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn resolved_cloud_url(map: &serde_json::Map<String, serde_json::Value>) -> String {
    map.get("cloud_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_CLOUD)
        .trim_end_matches('/')
        .to_string()
}

#[tauri::command]
pub async fn cloud_auth_start(
    cloud_url: Option<String>,
    provider: Option<String>,
) -> Result<CloudStartResp, String> {
    let creds = read_credentials().unwrap_or_default();
    let cloud = cloud_url
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| resolved_cloud_url(&creds));

    // Optional OAuth provider hint (github | gitlab | google). The server
    // forwards it onto the verify URL so the web sign-in page can route an
    // unauthenticated user straight to that provider instead of asking again.
    let provider = provider
        .map(|s| s.trim().to_lowercase())
        .filter(|s| matches!(s.as_str(), "github" | "gitlab" | "google"));

    let client = http_client()?;
    let mut body = serde_json::json!({
        "client_name": format!("aura-shell v{} on {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS),
    });
    if let Some(ref p) = provider {
        body["provider"] = serde_json::Value::String(p.clone());
    }
    let url = format!("{cloud}/api/v2/auth/device/start");
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("device/start HTTP {status}: {txt}"));
    }
    let parsed: StartBody = resp
        .json()
        .await
        .map_err(|e| format!("device/start parse: {e}"))?;
    Ok(CloudStartResp {
        user_code: parsed.user_code,
        device_code: parsed.device_code,
        verify_url: parsed.verify_url,
        expires_in: parsed.expires_in,
        poll_interval: parsed.poll_interval,
        cloud_url: cloud,
    })
}

#[tauri::command]
pub async fn cloud_auth_poll(
    device_code: String,
    cloud_url: Option<String>,
) -> Result<CloudPollResp, String> {
    let creds = read_credentials().unwrap_or_default();
    let cloud = cloud_url
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| resolved_cloud_url(&creds));

    let client = http_client()?;
    let url = format!("{cloud}/api/v2/auth/device/poll");
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "device_code": device_code }))
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;

    if resp.status() == reqwest::StatusCode::GONE {
        return Ok(CloudPollResp {
            status: CloudPollStatus::Used,
            user: None,
            org_slug: None,
        });
    }

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("device/poll HTTP {status}: {txt}"));
    }

    let parsed: PollBody = resp
        .json()
        .await
        .map_err(|e| format!("device/poll parse: {e}"))?;

    let status = match parsed.status.as_str() {
        "pending" => CloudPollStatus::Pending,
        "expired" => CloudPollStatus::Expired,
        "invalid" => CloudPollStatus::Invalid,
        "approved" => CloudPollStatus::Approved,
        other => return Err(format!("unexpected poll status: {other}")),
    };

    if matches!(status, CloudPollStatus::Approved) {
        let token = parsed
            .token
            .clone()
            .ok_or_else(|| "approved response missing token".to_string())?;
        let mut map = read_credentials().unwrap_or_default();
        map.insert(
            "cloud_url".to_string(),
            serde_json::Value::String(cloud.clone()),
        );
        map.insert(
            "cloud_api_token".to_string(),
            serde_json::Value::String(token),
        );
        map.insert("sync_enabled".to_string(), serde_json::Value::Bool(true));
        if let Some(ref user) = parsed.user {
            map.insert(
                "cloud_user".to_string(),
                serde_json::Value::String(user.clone()),
            );
        }
        if let Some(ref org) = parsed.org_slug {
            map.insert(
                "cloud_org_slug".to_string(),
                serde_json::Value::String(org.clone()),
            );
        }
        write_credentials(&map)?;
    }

    Ok(CloudPollResp {
        status,
        user: parsed.user,
        org_slug: parsed.org_slug,
    })
}

#[derive(Debug, Serialize)]
pub struct CloudPairResp {
    /// Compact JSON the desktop renders as a QR. The mobile companion parses
    /// it (see `aura-mobile/src/auth/qrPair.ts`):
    ///   {"v":1,"t":"aura-pair","url":<cloud>,"dc":<device_code>}
    pub qr_payload: String,
    /// Short readable code (e.g. `HAWK-4821`) shown under the QR as a
    /// fallback / sanity check — the phone never has to type it.
    pub user_code: String,
    pub cloud_url: String,
    pub expires_in: u64,
}

/// Mint a scan-to-pair QR for the Aura mobile companion.
///
/// Inverts the type-a-code device flow: this desktop is already signed in, so
/// it starts a device-code request *and approves it itself*, then hands back a
/// payload carrying the cloud URL + the now-approved `device_code`. The phone
/// scans the QR and only has to poll once to collect the freshly minted token —
/// no manual code entry on either side.
///
/// Showing the QR is the grant (same trust model as WhatsApp Web / Discord
/// scan-to-login): only an authenticated desktop can paint it, the request
/// expires in ~10 minutes, and the token is delivered exactly once.
#[tauri::command]
pub async fn cloud_pair_create(cloud_url: Option<String>) -> Result<CloudPairResp, String> {
    let creds = read_credentials().unwrap_or_default();
    let cloud = cloud_url
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| resolved_cloud_url(&creds));

    let token = cloud_token(&creds)
        .ok_or_else(|| "Sign in to Aura Cloud before pairing a phone.".to_string())?;

    let client = http_client()?;

    // 1) Start a device request, labelled so the phone shows up sensibly in
    //    the user's connected-devices list.
    let start_url = format!("{cloud}/api/v2/auth/device/start");
    let start_resp = client
        .post(&start_url)
        .json(&serde_json::json!({ "client_name": "Aura Mobile" }))
        .send()
        .await
        .map_err(|e| format!("POST {start_url}: {e}"))?;
    if !start_resp.status().is_success() {
        let status = start_resp.status();
        let txt = start_resp.text().await.unwrap_or_default();
        return Err(format!("device/start HTTP {status}: {txt}"));
    }
    let started: StartBody = start_resp
        .json()
        .await
        .map_err(|e| format!("device/start parse: {e}"))?;

    // 2) Approve it on our own (authenticated) behalf so the scanning phone
    //    only needs a single poll to collect the token.
    let approve_url = format!(
        "{cloud}/api/v2/auth/device/approve/{}",
        started.user_code
    );
    let approve_resp = client
        .post(&approve_url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("POST {approve_url}: {e}"))?;
    if !approve_resp.status().is_success() {
        let status = approve_resp.status();
        let txt = approve_resp.text().await.unwrap_or_default();
        return Err(format!("device/approve HTTP {status}: {txt}"));
    }

    let qr_payload = serde_json::json!({
        "v": 1,
        "t": "aura-pair",
        "url": cloud,
        "dc": started.device_code,
    })
    .to_string();

    Ok(CloudPairResp {
        qr_payload,
        user_code: started.user_code,
        cloud_url: cloud,
        expires_in: started.expires_in,
    })
}

#[tauri::command]
pub async fn cloud_auth_status() -> Result<CloudAuthStatus, String> {
    let creds = read_credentials().unwrap_or_default();
    let connected = cloud_token(&creds).is_some();
    let user = creds
        .get("cloud_user")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let org_slug = creds
        .get("cloud_org_slug")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(CloudAuthStatus {
        connected,
        user,
        org_slug,
        cloud_url: cloud_origin(&creds),
    })
}

#[tauri::command]
pub async fn cloud_auth_logout() -> Result<(), String> {
    let mut map = read_credentials().unwrap_or_default();
    map.remove("cloud_api_token");
    map.remove("cloud_user");
    map.remove("cloud_org_slug");
    map.insert("sync_enabled".to_string(), serde_json::Value::Bool(false));
    write_credentials(&map)?;
    Ok(())
}
