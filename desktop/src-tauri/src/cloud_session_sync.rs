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
use tauri::{AppHandle, Manager};
use tracing::warn;

/// Fire-and-forget. Resolves repo + creds, then POSTs in a background
/// task. Caller never blocks on network. `agent_kind` is the session's
/// `session_type` on the cloud (e.g. "manager", "claude", "gemini").
pub fn spawn_push(
    repo_root: String,
    session_id: String,
    objective: String,
    agent_kind: impl Into<String>,
) {
    let agent_kind = agent_kind.into();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = push_status(repo_root, session_id, objective, agent_kind, "running", false).await {
            // Visible in `aura shell` logs but never user-facing — the
            // shell carries on regardless of cloud health.
            warn!(target: "cloud_session_sync", "push skipped: {e}");
        }
    });
}

/// Fire-and-forget "this session has closed" push — flips the cloud row to
/// `ended` with an `ended_at`, so the phone's Workspaces feed shows a precise
/// "Ended" past session instead of a `running` ghost that just went quiet. The
/// heartbeat emits this the tick a live session disappears; the sync endpoint
/// upserts by `external_session_id`, so it updates the existing row.
pub fn spawn_push_close(
    repo_root: String,
    session_id: String,
    objective: String,
    agent_kind: impl Into<String>,
) {
    let agent_kind = agent_kind.into();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = push_status(repo_root, session_id, objective, agent_kind, "ended", true).await {
            warn!(target: "cloud_session_sync", "close push skipped: {e}");
        }
    });
}

// ── Session heartbeat: keep the phone's Workspaces feed live ───────────────
// How often the heartbeat wakes to reconcile the live-session set.
const SESSION_BEAT_FIRST_DELAY: std::time::Duration = std::time::Duration::from_secs(6);
const SESSION_BEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);
// A session already known to the cloud is re-pushed at most this often — well
// under the cloud's 5-minute ghost-suppression window, so a long-lived idle
// tab stays visible, but without hammering the metered sync endpoint on every
// 20s tick. New sessions are pushed on the first tick they appear.
const SESSION_KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(120);
// Let the app finish its launch spawns (and the session heartbeat take its
// first tick) before the roster sync touches the network.
const ROSTER_SYNC_DELAY: std::time::Duration = std::time::Duration::from_secs(8);

/// Spawn the always-on session heartbeat. Continuously publishes every live
/// interactive agent session (Claude Code, Gemini, Codex, Cursor — both
/// in-process and daemon-backed) to the cloud so the paired phone + dashboard
/// Workspaces feed shows them. This complements the Manager path (which pushes
/// on start + each chat turn); agent-PTY tabs previously had no cloud
/// registration at all, so a Claude session running on the desktop never
/// surfaced on mobile.
///
/// Lifecycle is derived, not hooked: a new session is pushed the first tick it
/// appears; a known one is re-pushed every `SESSION_KEEPALIVE` to refresh
/// `last_activity_at` inside the cloud's staleness window. A session that
/// closes simply stops being pushed — the cloud's own 5-minute ghost filter
/// drops it from the list — so we never touch the delicate PTY spawn/close
/// paths. Safe to call once at startup; a beat with no cloud token is a quiet
/// no-op that retries next interval.
pub fn spawn_session_heartbeat(app: AppHandle) {
    use std::collections::{HashMap, HashSet};
    use tokio::time::Instant;
    // What we remember about a live session between ticks: when we last pushed
    // it (to throttle keepalives) plus the repo + agent, which we need to emit
    // an accurate "ended" push once it disappears.
    struct Known {
        last_push: Instant,
        repo_root: String,
        agent_id: String,
    }
    tauri::async_runtime::spawn(async move {
        let mut known: HashMap<String, Known> = HashMap::new();
        tokio::time::sleep(SESSION_BEAT_FIRST_DELAY).await;
        loop {
            let live = match app.try_state::<crate::cmd_agent_pty::AgentPtyRegistry>() {
                Some(reg) => reg.live_sessions_for_sync(),
                None => Vec::new(),
            };
            let now = Instant::now();
            let mut current: HashSet<String> = HashSet::new();
            for s in live {
                current.insert(s.session_id.clone());
                // New session → push immediately; known one → only when its
                // keepalive is due.
                let due = known
                    .get(&s.session_id)
                    .map(|k| now.duration_since(k.last_push) >= SESSION_KEEPALIVE)
                    .unwrap_or(true);
                if due {
                    spawn_push(
                        s.repo_root.clone(),
                        s.session_id.clone(),
                        agent_display_name(&s.agent_id),
                        s.agent_id.clone(),
                    );
                }
                known
                    .entry(s.session_id.clone())
                    .and_modify(|k| {
                        if due {
                            k.last_push = now;
                        }
                        k.repo_root = s.repo_root.clone();
                        k.agent_id = s.agent_id.clone();
                    })
                    .or_insert(Known { last_push: now, repo_root: s.repo_root, agent_id: s.agent_id });
            }
            // Sessions we were tracking that vanished this tick have closed —
            // push one explicit "ended" so the phone shows an accurate past
            // session, then forget them (a re-opened id re-registers cleanly
            // and the map can't grow across a long run). The cloud upserts by
            // external id, so the close updates the same row.
            let gone: Vec<String> = known
                .keys()
                .filter(|id| !current.contains(*id))
                .cloned()
                .collect();
            for id in gone {
                if let Some(k) = known.remove(&id) {
                    spawn_push_close(k.repo_root, id, agent_display_name(&k.agent_id), k.agent_id);
                }
            }
            tokio::time::sleep(SESSION_BEAT_INTERVAL).await;
        }
    });
}

// ── Roster sync: keep the phone's repo switcher populated ──────────────────
// The session heartbeat only registers repos that have a *live* session this
// run, so a project the user hasn't opened an agent in yet never surfaces on
// mobile — which is exactly why a manual backfill was needed after the metering
// fix. This closes that gap: on launch we push every registered project as a
// bare repo row, and `projects_register` pushes each project the moment it's
// opened. Both are idempotent (the sync endpoint upserts the repo), unmetered
// (session-sync is not billed), and quiet no-ops when signed out.

/// Push the whole registered-project roster to the cloud on launch. Populates
/// the paired phone's repo switcher from every workspace the user has opened —
/// not just the ones with a live session — so no hand-run backfill is needed.
/// Safe to call once at startup; a no-op when signed out.
pub fn spawn_roster_sync() {
    tauri::async_runtime::spawn(async move {
        // Let the app settle (and the session heartbeat take its first tick)
        // before we touch the network.
        tokio::time::sleep(ROSTER_SYNC_DELAY).await;
        // Signed out → nothing to sync; bail before walking the registry so a
        // logged-out user never emits a single request.
        match read_credentials() {
            Ok(creds) if cloud_token(&creds).is_some() => {}
            Ok(_) => return,
            Err(e) => {
                warn!(target: "cloud_session_sync", "roster sync: creds unreadable: {e}");
                return;
            }
        }
        for root in crate::cmd_projects::registered_roots() {
            if let Err(e) = push_repo_registration(&root).await {
                warn!(target: "cloud_session_sync", "roster sync skipped ({root}): {e}");
            }
        }
    });
}

/// Fire-and-forget registration of a single project the moment it's opened, so
/// the phone lists the repo without waiting for the next launch or a live
/// session. Called from `projects_register`.
pub fn spawn_roster_push_one(repo_root: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = push_repo_registration(&repo_root).await {
            warn!(target: "cloud_session_sync", "roster push skipped ({repo_root}): {e}");
        }
    });
}

/// POST an empty-session payload for one repo root — the cloud treats this as
/// "ensure this repo row exists" (the same shape the manual backfill used).
/// Shares creds/origin/repo-name resolution with `push_status`.
async fn push_repo_registration(repo_root: &str) -> Result<(), String> {
    let creds = read_credentials()?;
    let token = cloud_token(&creds).ok_or("no cloud_api_token — run `aura connect`")?;
    let origin = cloud_origin(&creds);
    let repo_full_name = resolve_repo_full_name(Path::new(repo_root))
        .unwrap_or_else(|| local_fallback_full_name(Path::new(repo_root)));
    let body = json!({
        "repo_full_name": repo_full_name,
        "sessions": [],
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

/// Human label for an agent id, used as the session objective/title on the
/// phone. Falls back to the raw id for agents we don't have a nice name for.
fn agent_display_name(agent_id: &str) -> String {
    match agent_id {
        "claude" => "Claude Code",
        "gemini" => "Gemini CLI",
        "codex" => "Codex",
        "cursor" => "Cursor Agent",
        "aura" | "manager" => "Aura",
        other => other,
    }
    .to_string()
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

// ── Transcript backfill: seed a session's earlier turns into the cloud ─────
// Message sync is live-forward-only: `spawn_push_message` fires as each new
// turn happens. So a session created before that code, or whose turns were
// authored while signed out, has a cloud row (it's listed on mobile) but zero
// messages — the phone shows "No transcript synced yet". This closes that gap:
// a one-time upload of the local chat history, gated on the cloud being empty
// so it can never duplicate or reorder the live-pushed suffix.

/// One historical chat turn to backfill, carrying its original local time so
/// the phone renders the real conversation moment instead of clustering the
/// whole transcript at sync time.
pub struct BackfillTurn {
    /// "user" | "manager" | "system" — matches `chat_role_label`.
    pub role: &'static str,
    pub body: String,
    /// Unix seconds (the ChatTurn `at` field).
    pub at_unix_secs: u64,
}

/// Fire-and-forget one-time transcript backfill for a session. Uploads the
/// given turns ONLY when the cloud currently has no messages for the session —
/// the exact "No transcript synced yet" case — so a session that already owns
/// its ordering (any live-pushed turns) is left untouched. Login-gated; a quiet
/// no-op signed out, when there's nothing to send, or when the cloud already
/// has the transcript. Callers must guard against re-entry themselves (the
/// desktop uses a once-per-process set) so concurrent triggers don't race the
/// emptiness check.
pub fn spawn_backfill_messages(session_id: String, turns: Vec<BackfillTurn>) {
    if turns.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = backfill_messages(session_id, turns).await {
            warn!(target: "cloud_session_sync", "transcript backfill skipped: {e}");
        }
    });
}

async fn backfill_messages(session_id: String, turns: Vec<BackfillTurn>) -> Result<(), String> {
    let creds = read_credentials()?;
    let token = cloud_token(&creds).ok_or("no cloud_api_token — run `aura connect`")?;
    let origin = cloud_origin(&creds);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    // Guard: only backfill when the cloud has NO messages for this session.
    // Any live-pushed turn already fixes the ordering, and re-inserting history
    // "now" would sort it after the newer turns. An unknown / inaccessible
    // session also returns an empty feed here — the subsequent POST 404s and we
    // bail, so we never seed onto a session that isn't ours.
    let list_url = format!("{origin}/api/v2/sessions/{session_id}/messages?limit=1");
    let resp = client
        .get(&list_url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("GET {list_url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} listing messages", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("decode list: {e}"))?;
    let existing = body
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    if existing > 0 {
        return Ok(()); // cloud already has this transcript — nothing to do.
    }

    // Upload in order, each carrying its true local timestamp. Sequential
    // (awaited) so insertion order — and thus the cloud's `created_at ASC` read
    // order — matches the local chat exactly even if two turns share a second.
    let post_url = format!("{origin}/api/v2/sessions/{session_id}/messages");
    for turn in turns {
        let mut payload = serde_json::Map::new();
        payload.insert("role".into(), Value::String(turn.role.to_string()));
        payload.insert("body".into(), Value::String(turn.body));
        payload.insert("source".into(), Value::String("aura-shell-backfill".into()));
        if let Some(dt) = chrono::DateTime::<chrono::Utc>::from_timestamp(turn.at_unix_secs as i64, 0)
        {
            payload.insert("created_at".into(), Value::String(dt.to_rfc3339()));
        }
        let resp = client
            .post(&post_url)
            .bearer_auth(&token)
            .json(&Value::Object(payload))
            .send()
            .await
            .map_err(|e| format!("POST {post_url}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {} posting backfill turn", resp.status()));
        }
    }
    Ok(())
}

async fn push_status(
    repo_root: String,
    session_id: String,
    objective: String,
    agent_kind: String,
    status: &str,
    ended: bool,
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

    let ended_at = if ended {
        Value::String(chrono::Utc::now().to_rfc3339())
    } else {
        Value::Null
    };
    let body = json!({
        "repo_full_name": repo_full_name,
        "sessions": [{
            "session_type": agent_kind,
            "objective":    objective,
            "status":       status,
            "started_at":   chrono::Utc::now().to_rfc3339(),
            "ended_at":     ended_at,
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
        assert_eq!(github_full_name("https://github.com/MHASK/aura-sovereign.git").as_deref(), Some("MHASK/aura-sovereign"));
        assert_eq!(github_full_name("git@github.com:MHASK/aura-sovereign.git").as_deref(), Some("MHASK/aura-sovereign"));
        assert_eq!(github_full_name("ssh://git@github.com/foo/bar").as_deref(), Some("foo/bar"));
        assert_eq!(github_full_name("https://gitlab.com/foo/bar"), None);
    }
}
