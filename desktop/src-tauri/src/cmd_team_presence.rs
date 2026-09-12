//! Team presence — "who on my team is working on this repo right now".
//!
//! Not to be confused with [`crate::cmd_remote_devices`], which is the other
//! heartbeat in this app. That one advertises **this machine to its owner**
//! (the phone's "Your laptops" list, keyed `user_id`). This one advertises
//! **this person to their teammates** (`live_sessions`, read back by
//! `GET /api/v1/live/presence`, keyed `org_id`). Two different tables, two
//! different audiences; they are deliberately separate loops so signing out of
//! one surface never silently takes the other down with it.
//!
//! Why it exists: until now the only writer of `live_sessions` was the CLI's
//! `LiveSyncWorker`, which runs solely under a foreground `aura live`. Nobody
//! leaves a foreground command running for a day, so every team's "Online now"
//! panel read zero forever — while the console's own empty state promised
//! *"when your teammates open a repo in the desktop app they show up here"*.
//! The panel was right about the intent and wrong about the mechanism. This is
//! the mechanism.
//!
//! What it advertises is the **active** project, the one the person is looking
//! at — not every checkout they happen to have open. Presence that claims you
//! are working in five repos at once is worse than no presence, because a
//! teammate cannot tell which claim to believe.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cmd_remote::RemoteState;
use crate::cmd_remote_relay::{cloud_origin, cloud_token, read_credentials};

/// How often we re-assert presence. The server expires a session after five
/// minutes of silence and sweeps ghosts at thirty, so 30s survives a couple of
/// missed beats without ever letting a closed laptop linger as "online".
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Let the renderer push its first snapshot before the first beat — otherwise
/// beat one always fires with no active project and is wasted.
const FIRST_BEAT_DELAY: Duration = Duration::from_secs(8);

/// Per-request ceiling so a stalled network never wedges the loop.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
struct HeartbeatBody {
    repo_full_name: String,
    branch: String,
}

/// Spawn the team-presence beacon. Safe to call once at startup: every beat
/// re-reads credentials and the active project, so signing in, signing out and
/// switching projects all take effect on the next tick with no restart.
pub fn spawn_team_presence_heartbeat(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("[team-presence] http client init failed: {e}");
                return;
            }
        };
        tokio::time::sleep(FIRST_BEAT_DELAY).await;
        loop {
            if let Err(e) = beat_once(&app, &client).await {
                tracing::debug!("[team-presence] heartbeat skipped: {e}");
            }
            tokio::time::sleep(HEARTBEAT_INTERVAL).await;
        }
    });
}

/// One beat. Returns `Ok` both on a clean beat and on every ordinary reason to
/// skip one — not signed in, no project open — because neither is a fault and
/// neither should be logged as one.
async fn beat_once(app: &AppHandle, client: &reqwest::Client) -> Result<(), String> {
    let creds = read_credentials()?;
    let token = match cloud_token(&creds) {
        Some(t) => t,
        None => return Ok(()), // not signed in — nothing to advertise
    };
    let origin = cloud_origin(&creds);

    let root = match active_project_root(app).await {
        Some(r) => r,
        None => return Ok(()), // no project open — genuinely not working on anything
    };

    // The one function the whole app agrees on for naming a repo: explicit
    // binding, then the origin remote, then a stable per-folder local id. Using
    // anything else here would file this person's presence against a different
    // repo row than their commits and sessions.
    let repo_full_name = crate::repo_identity::repo_slug(&root);
    // The server takes the name on trust and will happily create a nameless
    // repo row from it, which then haunts every repo list in the org. There is
    // no path in `repo_slug` that returns empty today, so this is a guard
    // against a future one rather than a known case — but it is the kind of
    // damage that cannot be undone from the client.
    if repo_full_name.trim().is_empty() {
        return Err("project has no resolvable repo name".into());
    }
    let branch = current_branch(&root).unwrap_or_else(|| "HEAD".to_string());

    let url = format!("{origin}/api/v1/live/heartbeat");
    let req = client
        .post(&url)
        .bearer_auth(&token)
        .json(&HeartbeatBody {
            repo_full_name,
            branch,
        });
    // Carry the project's org binding so presence lands in the org the person
    // chose for this checkout, rather than whichever of their orgs sorts first.
    let resp = crate::cloud_session_sync::with_org(req, &root)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("live presence not deployed on this cloud".into());
    }
    if !resp.status().is_success() {
        return Err(format!("heartbeat http {}", resp.status()));
    }
    Ok(())
}

/// The checkout the person is actually looking at, as the renderer last
/// described it. Read from the remote snapshot because that is already the
/// app's single source of truth for "what is open right now" — the phone, the
/// console and this beacon should never disagree about which project is active.
async fn active_project_root(app: &AppHandle) -> Option<PathBuf> {
    let snapshot = app.try_state::<RemoteState>()?.snapshot().await?;
    let root = snapshot.get("activeRoot")?.as_str()?.trim().to_string();
    (!root.is_empty()).then(|| PathBuf::from(root))
}

/// The checked-out branch, or `None` on a detached head / non-repo. Shelling
/// out is fine at one call per thirty seconds.
fn current_branch(root: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["-C", &root.to_string_lossy(), "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!b.is_empty() && b != "HEAD").then_some(b)
}
