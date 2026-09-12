//! Desktop presence — the always-on half of the phone's "Your laptops"
//! list. A single background task heartbeats this desktop to the cloud
//! (`POST /api/v2/remote/devices/heartbeat`) every [`HEARTBEAT_INTERVAL`]
//! while the app is open, so the owner's phone can see this laptop as online
//! and — when it asks — wake its remote relay.
//!
//! Presence is independent of the relay: we heartbeat whether or not the
//! relay is running, and carry the relay's CURRENT state (code + public URL)
//! in each beat so the cloud's view stays reconciled. When the cloud replies
//! `wake_requested`, the phone has asked us to bring the relay up — we start
//! it, and the next beat reports the fresh code (which clears the request).
//!
//! Identity is a stable per-install id persisted at `~/.aura/device_id`,
//! paired with a friendly hostname and the OS family. It is computed once
//! and cached — see [`device_identity`].

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::cmd_remote_relay::{cloud_origin, cloud_token, read_credentials, RemoteRelayState};
use crate::cloud_org::OrgScoped;

/// How often the desktop beacons presence. Paired with the cloud's 60s
/// freshness window (`remote_devices::FRESHNESS_WINDOW_SECS`) this tolerates
/// two missed beats before the phone shows the laptop as offline.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);

/// Small settle delay before the first beat so credentials + relay state are
/// loaded and the laptop appears promptly (not one full interval later).
const FIRST_BEAT_DELAY: Duration = Duration::from_secs(3);

/// Per-request ceiling so a stalled network never wedges the beat loop.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Stable identity this desktop advertises. `device_id` is the load-bearing
/// key (persisted); `name`/`platform` decorate the phone's list.
#[derive(Clone)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub name: String,
    pub platform: &'static str,
}

static IDENTITY: OnceLock<DeviceIdentity> = OnceLock::new();

/// This desktop's identity, computed once and cached. Cheap to call on every
/// heartbeat / relay dial after the first.
pub fn device_identity() -> DeviceIdentity {
    IDENTITY
        .get_or_init(|| DeviceIdentity {
            device_id: load_or_make_device_id(),
            name: hostname(),
            platform: platform_family(),
        })
        .clone()
}

fn platform_family() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn aura_home() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|h| PathBuf::from(h).join(".aura"))
}

/// Read `~/.aura/device_id`, persisting one the first time. Falls back to
/// an ephemeral id if HOME is unreadable (the laptop still works, it just
/// won't be stable across restarts in that edge case).
///
/// AUDIT-UI-04 — when the file is absent we ADOPT the id `device.json`
/// (cmd_device) already minted instead of minting a second UUID. Two ids
/// for one laptop meant the same machine appeared as two device rows on
/// the phone list. An existing `device_id` file is honoured as-is so
/// installs that already beaconed under it don't change identity.
fn load_or_make_device_id() -> String {
    if let Some(dir) = aura_home() {
        let path = dir.join("device_id");
        if let Ok(s) = std::fs::read_to_string(&path) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        let id = crate::cmd_device::load_or_create_device()
            .map(|d| d.device_id)
            .ok()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, &id);
        return id;
    }
    uuid::Uuid::new_v4().to_string()
}

/// A friendly machine name. Prefers the OS's human label (macOS
/// `ComputerName`, Windows `%COMPUTERNAME%`) and falls back to `hostname`.
fn hostname() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("scutil")
            .args(["--get", "ComputerName"])
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(v) = std::env::var("COMPUTERNAME") {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    if let Ok(v) = std::env::var("HOSTNAME") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    if let Ok(out) = std::process::Command::new("hostname").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                // Strip a trailing `.local`/domain for a cleaner label.
                return s.split('.').next().unwrap_or(&s).to_string();
            }
        }
    }
    "Laptop".to_string()
}

#[derive(Serialize)]
struct HeartbeatBody {
    device_id: String,
    name: String,
    platform: &'static str,
    /// The relay's live code + URL when it's running, else omitted (None).
    #[serde(skip_serializing_if = "Option::is_none")]
    relay_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relay_public_url: Option<String>,
}

#[derive(Deserialize)]
struct HeartbeatReply {
    #[serde(default)]
    wake_requested: bool,
    /// The cloud cannot route the relay code this beat reported. Defaults to
    /// false, which is also what an older cloud answers — on one of those the
    /// desktop behaves exactly as it did before.
    #[serde(default)]
    relay_stale: bool,
}

/// Spawn the single always-on presence heartbeat. Safe to call once at
/// startup; it self-heals across sign-in state (a beat with no cloud token
/// is a quiet no-op and simply retries next interval).
pub fn spawn_presence_heartbeat(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("[presence] http client init failed: {e}");
                return;
            }
        };
        tokio::time::sleep(FIRST_BEAT_DELAY).await;
        loop {
            if let Err(e) = beat_once(&app, &client).await {
                tracing::debug!("[presence] heartbeat skipped: {e}");
            }
            tokio::time::sleep(HEARTBEAT_INTERVAL).await;
        }
    });
}

/// One heartbeat: report presence + relay state; if the cloud says a wake was
/// requested and the relay is down, bring it up. Returns `Ok` on a clean beat
/// AND on the "not signed in / no cloud" skip (both are non-errors).
async fn beat_once(app: &AppHandle, client: &reqwest::Client) -> Result<(), String> {
    let creds = read_credentials()?;
    // Not signed in to cloud yet — nothing to advertise. Quiet retry.
    let token = match cloud_token(&creds) {
        Some(t) => t,
        None => return Ok(()),
    };
    let origin = cloud_origin(&creds);
    let ident = device_identity();

    let relay = app.state::<RemoteRelayState>();
    let status = relay.current().await;

    let body = HeartbeatBody {
        device_id: ident.device_id.clone(),
        name: ident.name.clone(),
        platform: ident.platform,
        relay_code: status.code.clone(),
        relay_public_url: status.public_url.clone(),
    };

    let url = format!("{origin}/api/v2/remote/devices/heartbeat");
    let resp = client
        .post(&url)
        .bearer_auth(&token)
        .org_scoped()
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        // Cloud predates the device-list feature — stop spamming it, but keep
        // the loop alive cheaply in case the cloud is upgraded under us.
        return Err("device presence not deployed on this cloud".into());
    }
    if !resp.status().is_success() {
        return Err(format!("heartbeat http {}", resp.status()));
    }

    let reply: HeartbeatReply = resp.json().await.map_err(|e| e.to_string())?;

    // A relay this cloud cannot route is not a relay. Drop it first, so the
    // wake below dials a real one instead of `ensure_started` handing back the
    // dead handle it is already holding.
    //
    // The relay clears itself when its socket closes, which covers the common
    // case. This covers the ones it cannot see: a socket that died without a
    // close frame across sleep, and a cloud that restarted and forgot a code
    // whose socket is somehow still open at this end. Either way the cloud is
    // the authority on what it can dial, and it has just said it cannot dial
    // this.
    if reply.relay_stale && status.running {
        tracing::info!("[presence] cloud cannot route our relay code — dropping it");
        relay.stop(app).await;
    }

    let relay_down = !status.running || reply.relay_stale;
    if reply.wake_requested && relay_down {
        tracing::info!("[presence] wake requested — starting relay");
        // Bring the relay up. `ensure_started` upserts the live code into
        // presence itself, and the next beat reports it — clearing the wake.
        if let Err(e) = relay.ensure_started(app).await {
            tracing::warn!("[presence] wake -> relay start failed: {e}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod device_identity_tests {
    use super::*;
    use crate::test_home;

    // AUDIT-UI-04 — one machine, one identity. With no device_id file,
    // the beacon adopts the id device.json already minted (instead of
    // minting a second UUID and splitting the machine into two rows),
    // and persists it so later reads short-circuit.
    #[test]
    fn adopts_device_json_id_instead_of_minting_a_second() {
        let home = test_home::borrow();
        let aura = home.path().join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        std::fs::write(
            aura.join("device.json"),
            r#"{"device_id":"11111111-2222-3333-4444-555555555555","display_name":"mo","email":""}"#,
        )
        .unwrap();

        let id = load_or_make_device_id();
        assert_eq!(id, "11111111-2222-3333-4444-555555555555");
        // Persisted for stability — the next read comes from the file.
        let on_disk = std::fs::read_to_string(aura.join("device_id")).unwrap();
        assert_eq!(on_disk.trim(), id);
    }

    // An existing device_id file wins — installs that already beaconed
    // under it must not change identity, even when device.json disagrees.
    #[test]
    fn an_existing_device_id_file_is_honoured() {
        let home = test_home::borrow();
        let aura = home.path().join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        std::fs::write(aura.join("device_id"), "aaaa-existing\n").unwrap();
        std::fs::write(
            aura.join("device.json"),
            r#"{"device_id":"bbbb-other","display_name":"mo","email":""}"#,
        )
        .unwrap();

        assert_eq!(load_or_make_device_id(), "aaaa-existing");
    }
}
