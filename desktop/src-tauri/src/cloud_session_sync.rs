//! Best-effort push of Manager session metadata to aura-cloud's
//! `/api/v1/sync/sessions` endpoint.
//!
//! Why this exists: a Manager session lives in the Tauri process and
//! never touched the cloud's `sessions` table — so the mobile + web
//! Workspaces views (which read `/api/v2/sessions`) stayed empty even
//! for paired users. This module gives the shell a tiny lifecycle hook
//! that fires one POST per new session so the row at least exists
//! while the session is alive.
//!
//! Trade-off: each `spawn_push` adds a new row (the sync endpoint
//! always INSERTs). For v1 we accept dup-tolerance — Manager sessions
//! are coarse-grained enough that one row per shell run is fine. A
//! follow-up will swap to an upsert keyed on `external_session_id`
//! once the schema gets that column.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tracing::warn;

/// Fire-and-forget. Resolves repo + creds, then POSTs in a background
/// task. Caller never blocks on network.
pub fn spawn_push(
    repo_root: String,
    session_id: String,
    objective: String,
    agent_kind: &'static str,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = push(repo_root, session_id, objective, agent_kind).await {
            // Visible in `aura shell` logs but never user-facing — the
            // shell carries on regardless of cloud health.
            warn!(target: "cloud_session_sync", "push skipped: {e}");
        }
    });
}

/// Fire-and-forget chat-turn push to the session-messages endpoint —
/// matches what the mobile companion reads. `role` should be one of
/// "user", "manager", "system"; `source` distinguishes "aura-shell"
/// (origin) from "mobile" (so the receiving desktop can skip echoes of
/// its own turns).
pub fn spawn_push_message(session_id: String, role: &'static str, body: String) {
    if body.trim().is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = push_message(session_id, role, body).await {
            warn!(target: "cloud_session_sync", "message push skipped: {e}");
        }
    });
}

async fn push_message(
    session_id: String,
    role: &'static str,
    body: String,
) -> Result<(), String> {
    let creds = read_credentials()?;
    let token = cloud_token(&creds).ok_or("no cloud_api_token — run `aura connect`")?;
    let origin = cloud_origin(&creds);

    let payload = serde_json::json!({
        "role":   role,
        "body":   body,
        "source": "aura-shell",
    });
    // session_id is a server-side UUID, no URL-encoding needed.
    let url = format!("{origin}/api/v2/sessions/{session_id}/messages");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let resp = client
        .post(&url)
        .bearer_auth(&token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {txt}"));
    }
    Ok(())
}

async fn push(
    repo_root: String,
    session_id: String,
    objective: String,
    agent_kind: &'static str,
) -> Result<(), String> {
    let creds = read_credentials()?;
    let token = cloud_token(&creds).ok_or("no cloud_api_token — run `aura connect`")?;
    let origin = cloud_origin(&creds);
    // GitHub remote when present, otherwise `local/<dirname>` so a
    // local-only project (no `origin` remote, e.g. fresh scaffold) still
    // surfaces in the mobile / dashboard Workspaces list. Keeps the
    // round-trip story working before the user has wired a remote.
    let repo_full_name = resolve_repo_full_name(Path::new(&repo_root))
        .unwrap_or_else(|| local_fallback_full_name(Path::new(&repo_root)));

    let body = json!({
        "repo_full_name": repo_full_name,
        "sessions": [{
            "session_type": agent_kind,
            "objective":    objective,
            "status":       "running",
            "started_at":   chrono::Utc::now().to_rfc3339(),
            "ended_at":     null,
            "data": {
                "session_id":  session_id,
                "source":      "aura-shell",
                "repo_root":   repo_root,
            },
        }],
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let url = format!("{origin}/api/v1/sync/sessions");
    let resp = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {txt}"));
    }
    Ok(())
}

/// Login-gated team sync (pull half). Fetch teammates' recent intents for this
/// repo from the cloud activity plane (`/api/v2/intents`, backed by the same
/// `live_events` rows the existing live-sync push already writes). This is how a
/// teammate's "why" reaches the Team activity feed even though `.aura/` is
/// gitignored on real repos — it rides Aura's cloud, not git.
///
/// Returns the raw intent objects (see the endpoint's shape: `user`, `repo`,
/// `branch`, `file_path`, `intent`, `rationale`, `created_at`, …), already
/// scoped to THIS repo. Empty — never an error to the caller — when:
///   • signed out (no `cloud_api_token`) → the feed stays local-only, the
///     intended privacy default;
///   • the repo has no GitHub remote (nothing to match server-side);
///   • any cloud error → the caller falls back to the local ledger, so a cloud
///     hiccup never blocks or breaks the feed.
pub async fn pull_intents(repo_root: &Path, limit: usize) -> Vec<Value> {
    match pull_intents_inner(repo_root, limit).await {
        Ok(v) => v,
        Err(e) => {
            warn!(target: "cloud_session_sync", "intent pull skipped: {e}");
            Vec::new()
        }
    }
}

async fn pull_intents_inner(repo_root: &Path, limit: usize) -> Result<Vec<Value>, String> {
    let creds = read_credentials()?;
    // Signed out → no sync. The whole feature is login-gated here.
    let token = match cloud_token(&creds) {
        Some(t) => t,
        None => return Ok(Vec::new()),
    };
    let origin = cloud_origin(&creds);
    // Only a GitHub-tracked repo has a cloud counterpart to match; a local-only
    // project has no server rows, so skip rather than pull the whole org.
    let repo_full_name = match resolve_repo_full_name(repo_root) {
        Some(n) => n,
        None => return Ok(Vec::new()),
    };

    // The endpoint is org-wide newest-first; pull a generous page and filter to
    // this repo client-side (the caller truncates the merged set to its cap).
    let page = limit.clamp(1, 200);
    let url = format!("{origin}/api/v2/intents?page=1&limit={page}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    let arr = body
        .get("intents")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    // Scope to THIS repo — the endpoint returns every repo the user can access.
    let mine = arr
        .into_iter()
        .filter(|it| {
            it.get("repo").and_then(|v| v.as_str()) == Some(repo_full_name.as_str())
        })
        .collect();
    Ok(mine)
}

pub(crate) fn aura_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no HOME / USERPROFILE".to_string())?;
    Ok(PathBuf::from(home).join(".aura"))
}

pub(crate) fn read_credentials() -> Result<serde_json::Map<String, Value>, String> {
    let path = aura_dir()?.join("credentials.json");
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let s = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if s.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }
    let v: Value = serde_json::from_str(&s).map_err(|e| format!("parse credentials: {e}"))?;
    match v {
        Value::Object(m) => Ok(m),
        _ => Err("credentials.json is not an object".into()),
    }
}

pub(crate) fn cloud_token(map: &serde_json::Map<String, Value>) -> Option<String> {
    map.get("cloud_api_token")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

pub(crate) fn cloud_origin(map: &serde_json::Map<String, Value>) -> String {
    map.get("cloud_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("https://api.auravcs.com")
        .trim_end_matches('/')
        .to_string()
}

/// Find the `origin` remote URL in `<repo_root>/.git/config` and reduce
/// it to `owner/repo`. Returns `None` for non-GitHub remotes or repos
/// that haven't been cloned (no .git/config) — the caller treats those
/// as "not cloud-trackable" and silently skips.
pub(crate) fn resolve_repo_full_name(repo_root: &Path) -> Option<String> {
    let cfg = std::fs::read_to_string(repo_root.join(".git").join("config")).ok()?;
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
        if let Some(url) = line.strip_prefix("url = ").or_else(|| line.strip_prefix("url=")) {
            return github_full_name(url.trim());
        }
    }
    None
}

/// Synthesise a `<scope>/<name>` for a repo without a GitHub remote.
/// Uses `local/` so it's clearly distinguishable from real GitHub repos
/// in the dashboard, and the directory basename so two local projects
/// don't collide. Falls back to "unknown" if the path has no final
/// component (shouldn't happen — repo_root is always an absolute path).
pub(crate) fn local_fallback_full_name(repo_root: &Path) -> String {
    let name = repo_root
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown");
    format!("local/{name}")
}

fn github_full_name(url: &str) -> Option<String> {
    // Accept https://github.com/owner/repo(.git), git@github.com:owner/repo(.git),
    // and ssh://git@github.com/owner/repo(.git).
    let stripped = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let stripped = stripped.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = stripped.splitn(3, '/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::github_full_name;

    #[test]
    fn parses_common_remote_url_shapes() {
        assert_eq!(github_full_name("https://github.com/OWNER/aura-sovereign.git").as_deref(), Some("OWNER/aura-sovereign"));
        assert_eq!(github_full_name("git@github.com:OWNER/aura-sovereign.git").as_deref(), Some("OWNER/aura-sovereign"));
        assert_eq!(github_full_name("ssh://git@github.com/foo/bar").as_deref(), Some("foo/bar"));
        assert_eq!(github_full_name("https://gitlab.com/foo/bar"), None);
    }
}
