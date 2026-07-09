// Per-install anonymous device identity + repo room derivation.
//
// Identity: a JSON file at ~/.aura/device.json with three fields —
//   - device_id: a UUID minted on first read, stable forever after
//   - display_name: defaults to git user.name (may be overridden later)
//   - email: defaults to git user.email (best-effort hint, not verified)
//
// Room derivation: room_id = sha256(normalised git origin URL). Anyone
// who has cloned the repo derives the same id locally, so membership
// implicitly == "has the clone". When the repo has no origin remote,
// we fall back to sha256(absolute repo path) prefixed with "local-".

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::cloud_session_sync::aura_dir;

const DEVICE_FILE: &str = "device.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub display_name: String,
    #[serde(default)]
    pub email: String,
}

fn device_path() -> Result<PathBuf, String> {
    Ok(aura_dir()?.join(DEVICE_FILE))
}

fn git_local_identity(repo_root: &Path) -> (String, String) {
    let email = std::process::Command::new("git")
        .args(["config", "--get", "user.email"])
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let name = std::process::Command::new("git")
        .args(["config", "--get", "user.name"])
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    (email, name)
}

fn git_global_identity() -> (String, String) {
    let email = std::process::Command::new("git")
        .args(["config", "--global", "--get", "user.email"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let name = std::process::Command::new("git")
        .args(["config", "--global", "--get", "user.name"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    (email, name)
}

/// Load (or mint) the local device identity. Idempotent — re-reads from
/// disk on subsequent calls so manual edits to `device.json` take
/// effect. Defaults pulled from git global config the first time only.
pub(crate) fn load_or_create_device() -> Result<DeviceIdentity, String> {
    let path = device_path()?;
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if let Ok(d) = serde_json::from_str::<DeviceIdentity>(&raw) {
            if !d.device_id.trim().is_empty() {
                return Ok(d);
            }
        }
    }
    let (email, name) = git_global_identity();
    let display = if name.is_empty() {
        email
            .split('@')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("aura-user")
            .to_string()
    } else {
        name
    };
    let identity = DeviceIdentity {
        device_id: Uuid::new_v4().to_string(),
        display_name: display,
        email,
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(&identity).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(identity)
}

fn save_device(identity: &DeviceIdentity) -> Result<(), String> {
    let path = device_path()?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(identity).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Per-repo identity overlay: device.json is the global default, but the
/// active git user.{name,email} of the current repo wins for display so
/// teammates see the same name in chat that they see in git log.
pub(crate) fn effective_identity(repo_root: &Path) -> Result<DeviceIdentity, String> {
    let mut base = load_or_create_device()?;
    let (repo_email, repo_name) = git_local_identity(repo_root);
    if !repo_name.is_empty() {
        base.display_name = repo_name;
    }
    if !repo_email.is_empty() {
        base.email = repo_email;
    }
    Ok(base)
}

pub(crate) fn normalise_origin_url(raw: &str) -> String {
    let mut url = raw.trim().to_string();
    if let Some(stripped) = url.strip_prefix("git@github.com:") {
        url = format!("https://github.com/{stripped}");
    } else if let Some(stripped) = url.strip_prefix("ssh://git@github.com/") {
        url = format!("https://github.com/{stripped}");
    } else if let Some(rest) = url.strip_prefix("git@") {
        // Custom SSH host alias — common pattern is `git@github-personal:owner/repo`
        // where `github-personal` is a Host entry in ~/.ssh/config that proxies
        // to github.com (different deploy key, multiple accounts, etc). If the
        // alias name *contains* "github" we treat it as github.com so two clones
        // of the same GitHub repo derive the same room_id regardless of which
        // SSH config alias each clone uses. Non-github hosts (gitlab.*,
        // bitbucket.*, self-hosted, etc) fall through unchanged.
        if let Some((host, path)) = rest.split_once(':') {
            if host.to_lowercase().contains("github") {
                url = format!("https://github.com/{path}");
            }
        }
    } else if let Some(rest) = url.strip_prefix("ssh://git@") {
        if let Some((host, path)) = rest.split_once('/') {
            if host.to_lowercase().contains("github") {
                url = format!("https://github.com/{path}");
            }
        }
    }
    url = url.trim_end_matches('/').trim_end_matches(".git").to_string();
    url.to_lowercase()
}

/// Read an optional per-repo override at `.aura/repo.json`. When present
/// and containing a non-empty `room_id`, every clone that has this file
/// committed converges on the same cloud room regardless of how each
/// developer cloned (SSH alias, https, gitlab mirror, fork, etc). Commit
/// this file to your repo and your whole team derives the same room.
#[derive(Serialize, Deserialize, Debug, Default)]
struct RepoOverride {
    #[serde(default)]
    room_id: String,
}

pub(crate) fn read_repo_override(repo_root: &Path) -> Option<String> {
    let path = repo_root.join(".aura").join("repo.json");
    let raw = fs::read_to_string(&path).ok()?;
    let parsed: RepoOverride = serde_json::from_str(&raw).ok()?;
    let trimmed = parsed.room_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Cloud accepts ascii alphanumeric + `-_`; reject anything else so a
    // malformed override doesn't silently route to a bogus room id.
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub(crate) fn read_origin_url(repo_root: &Path) -> Option<String> {
    let cfg = fs::read_to_string(repo_root.join(".git").join("config")).ok()?;
    let mut in_origin = false;
    for line in cfg.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some(url) = line
            .strip_prefix("url = ")
            .or_else(|| line.strip_prefix("url="))
        {
            return Some(url.trim().to_string());
        }
    }
    None
}

/// Channel slug that routes to the cross-repo global Aura room. Every
/// install renders this channel as a pinned builtin and joins the same
/// fixed cloud room so users from different repos can chat together.
pub const AURA_GLOBAL_CHANNEL: &str = "aura";

/// Fixed room ID for the global Aura channel. Hardcoded so every
/// client converges on the same room regardless of repo identity.
///
/// Value = sha256("aura-global"). The cloud rejects room ids that aren't
/// 64-hex (a repo content hash) or `local-<64hex>`; the bare literal
/// "aura-global" tripped that validator with HTTP 400, so every #aura send
/// failed with "! retry". Hashing the well-known name keeps all installs on
/// one shared room while passing the format check.
pub const AURA_GLOBAL_ROOM: &str =
    "9cd55691794cd647f9d052354a4a0c55f9b5da7706fd780b03b9acb8cb583d70";

/// Resolve the cloud room id for a chat operation. For the global
/// Aura channel, return the fixed cross-user room; for every other
/// channel, fall back to the per-repo room derived from the origin
/// remote (or local path hash for un-remoted clones). Centralizing
/// the override here means `post_cloud_chat`, `fetch_cloud_chat`,
/// `fetch_cloud_chat_since`, and the WS subscribe path all stay in
/// sync — add a new global channel by extending this match, not by
/// hunting every callsite.
pub fn effective_room_id(repo_root: &Path, channel: &str) -> String {
    if channel == AURA_GLOBAL_CHANNEL {
        AURA_GLOBAL_ROOM.to_string()
    } else {
        room_id_for_repo(repo_root)
    }
}

/// Stable, deterministic 32-byte hex id for the repo. Every clone of the
/// same upstream repo gets the same id; repos without an origin remote
/// get a `local-<hash>` id derived from their absolute path on disk
/// (so two devices that both have an un-remoted copy won't collide
/// across machines — which is correct: they can't talk anyway).
pub(crate) fn room_id_for_repo(repo_root: &Path) -> String {
    // Per-repo override file wins over URL-derived room_id. Commit
    // `.aura/repo.json` with `{"room_id": "..."}` and the whole team
    // joins the same room regardless of how each developer clones.
    if let Some(forced) = read_repo_override(repo_root) {
        return forced;
    }
    if let Some(url) = read_origin_url(repo_root) {
        let canonical = normalise_origin_url(&url);
        let digest = Sha256::digest(canonical.as_bytes());
        return hex::encode(digest);
    }
    let path_str = repo_root.to_string_lossy().to_lowercase();
    let digest = Sha256::digest(path_str.as_bytes());
    format!("local-{}", hex::encode(digest))
}

// ── Tauri commands ───────────────────────────────────────────────────

#[tauri::command]
pub async fn device_identity() -> Result<DeviceIdentity, String> {
    load_or_create_device()
}

#[tauri::command]
pub async fn device_update(display_name: Option<String>, email: Option<String>) -> Result<DeviceIdentity, String> {
    let mut current = load_or_create_device()?;
    if let Some(name) = display_name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            current.display_name = trimmed.to_string();
        }
    }
    if let Some(em) = email {
        let trimmed = em.trim();
        if !trimmed.is_empty() {
            current.email = trimmed.to_string();
        }
    }
    save_device(&current)?;
    Ok(current)
}

#[tauri::command]
pub async fn device_room_id(repo_root: String) -> Result<String, String> {
    Ok(room_id_for_repo(Path::new(&repo_root)))
}

/// Tauri command — exposes the fixed global Aura room id so the
/// frontend can open a second WebSocket subscription independent of
/// the per-repo room.
#[tauri::command]
pub async fn aura_global_room_id() -> Result<String, String> {
    Ok(AURA_GLOBAL_ROOM.to_string())
}

/// Repo-aware identity for surfaces that should appear under the same
/// name in chat, voice, presence, and git log. Falls back to the
/// global device identity when the repo has no local git user.* set.
/// This is what huddle/call paths should use — `device_identity` alone
/// reads only the global, so a user with `git config user.email` set
/// per-repo would otherwise show up under their global handle in voice
/// while chat correctly uses the per-repo one.
#[tauri::command]
pub async fn device_identity_for_repo(repo_root: String) -> Result<DeviceIdentity, String> {
    effective_identity(Path::new(&repo_root))
}
