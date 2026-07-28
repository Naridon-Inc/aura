//! Tauri commands surfacing the task-feature integrations layer to the
//! renderer. W1 covers Jira (Atlassian 3LO): connect / status / list /
//! disconnect. Linear lands in the next wave behind the same surface.
//!
//! The renderer never sees raw tokens — every command returns a
//! `ConnectionStatus` shape. Tokens live in the OS keychain
//! (`super::integrations::tokens`); identity + cloud-sites metadata
//! lives alongside them in `~/.aura/integrations.state.json` so the
//! settings panel can render "Connected as Alice on acme.atlassian.net"
//! immediately on mount without re-hitting Atlassian.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{oneshot, Mutex as TokioMutex};

use crate::integrations::{
    config, jira, jira_sync, linear, tokens, CloudSite, ConnectionStatus, ExternalIdentity,
    IntegrationKind, MirrorSummary, ProviderTokens,
};
use crate::integrations::jira_sync::{JiraProject, SyncOutcome};

/// One-at-a-time slot for an in-flight Jira OAuth flow. Holds the
/// cancel sender so `_cancel` (or a fresh `_connect` attempt) can fire
/// it, dropping the loopback listener and releasing the port.
///
/// Why a global vs per-window: the Tauri command surface is
/// process-wide and the loopback port is too; the user can only ever
/// have one Jira flow open at a time, and trying to is operator error
/// (we cancel the older one). A `tokio::sync::Mutex` is correct over
/// `parking_lot::Mutex` because we hold it across `await` points
/// during the brief port-release sleep.
fn pending_jira_flow() -> &'static TokioMutex<Option<oneshot::Sender<()>>> {
    static S: OnceLock<TokioMutex<Option<oneshot::Sender<()>>>> = OnceLock::new();
    S.get_or_init(|| TokioMutex::new(None))
}

/// Fire any in-flight Jira flow's cancel sender. Idempotent: no-op
/// when there's no pending flow.
async fn cancel_pending_jira() {
    let mut slot = pending_jira_flow().lock().await;
    if let Some(tx) = slot.take() {
        // Ignore the result — receiver may already be gone (e.g. the
        // flow resolved on its own a microsecond before we got here).
        let _ = tx.send(());
    }
}

/// Same one-at-a-time slot for the Linear OAuth flow. Kept separate from
/// the Jira slot so connecting Linear never cancels an in-flight Jira
/// connect (and vice-versa) — the two loopback ports are distinct.
fn pending_linear_flow() -> &'static TokioMutex<Option<oneshot::Sender<()>>> {
    static S: OnceLock<TokioMutex<Option<oneshot::Sender<()>>>> = OnceLock::new();
    S.get_or_init(|| TokioMutex::new(None))
}

/// Fire any in-flight Linear flow's cancel sender. Idempotent.
async fn cancel_pending_linear() {
    let mut slot = pending_linear_flow().lock().await;
    if let Some(tx) = slot.take() {
        let _ = tx.send(());
    }
}

/// Cached non-token state, JSON on disk at `~/.aura/integrations.state.json`.
/// Keyed by provider slug so future adapters (linear, …) coexist
/// without schema churn.
#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    #[serde(default)]
    providers: BTreeMap<String, ProviderState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderState {
    #[serde(default)]
    identity: Option<ExternalIdentity>,
    #[serde(default)]
    sites: Vec<CloudSite>,
    #[serde(default)]
    scopes: Option<String>,
    #[serde(default)]
    expires_at: Option<u64>,
    /// W2 — projects the user has bound to a local repo. Empty on
    /// providers that haven't been configured for mirroring yet (and
    /// stays empty for Linear, which is single-workspace per token).
    /// Stored as `MirrorSummary` so the on-disk JSON shape matches
    /// exactly what the renderer reads via `ConnectionStatus`.
    #[serde(default)]
    mirrors: Vec<MirrorSummary>,
    /// W2 — auto-mirror target. When set, the poller enumerates every
    /// project on every site at each cycle and ensures a mirror exists
    /// for each one, targeting this repo. When cleared, existing
    /// mirrors stay put — the user can still curate manually.
    #[serde(default)]
    auto_mirror_repo_root: Option<String>,
}

fn state_path() -> Result<PathBuf, String> {
    let home = std::env::var("AURA_HOME").ok().map(PathBuf::from).or_else(|| {
        std::env::var("HOME")
            .ok()
            .or_else(|| std::env::var("USERPROFILE").ok())
            .map(|h| PathBuf::from(h).join(".aura"))
    });
    let dir = home.ok_or("no HOME / USERPROFILE / AURA_HOME")?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    Ok(dir.join("integrations.state.json"))
}

fn read_state() -> Result<StateFile, String> {
    let p = state_path()?;
    if !p.exists() {
        return Ok(StateFile::default());
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", p.display()))
}

fn write_state(state: &StateFile) -> Result<(), String> {
    let p = state_path()?;
    let raw = serde_json::to_string_pretty(state).map_err(|e| format!("encode: {e}"))?;
    fs::write(&p, raw).map_err(|e| format!("write {}: {e}", p.display()))?;
    // Best-effort tighten perms — mirrors the `chmod 600` we apply to
    // `integrations.toml`. On Windows this is a no-op via `dirs`.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn persist_provider_state(
    kind: IntegrationKind,
    identity: Option<ExternalIdentity>,
    sites: Vec<CloudSite>,
    tokens_blob: &ProviderTokens,
) -> Result<(), String> {
    let mut state = read_state()?;
    // Reconnect path: keep mirrors + auto-mirror config the user already
    // configured. A fresh connection (no prior entry) starts with no
    // mirrors and auto-mirror off.
    let (existing_mirrors, existing_auto) = state
        .providers
        .get(kind.slug())
        .map(|p| (p.mirrors.clone(), p.auto_mirror_repo_root.clone()))
        .unwrap_or_default();
    state.providers.insert(
        kind.slug().to_string(),
        ProviderState {
            identity,
            sites,
            scopes: tokens_blob.scope.clone(),
            expires_at: tokens_blob.expires_at,
            mirrors: existing_mirrors,
            auto_mirror_repo_root: existing_auto,
        },
    );
    write_state(&state)
}

fn forget_provider_state(kind: IntegrationKind) -> Result<(), String> {
    let mut state = read_state()?;
    state.providers.remove(kind.slug());
    write_state(&state)
}

/// True when the cached access token has expired (or expires within
/// the next 30 seconds — a small skew so a token that's about to
/// expire mid-request gets refreshed first).
fn is_expired(t: &ProviderTokens) -> bool {
    let Some(exp) = t.expires_at else {
        // Atlassian always returns expires_in, but if a future
        // provider doesn't, treat as never-expires and let the API
        // call surface a 401 → user reconnects.
        return false;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now + 30 >= exp
}

/// Compose a `ConnectionStatus` from a state-file entry. Used by both
/// `_status` (after refresh) and `_list` (no refresh).
fn status_from_state(kind: IntegrationKind, st: &ProviderState) -> ConnectionStatus {
    ConnectionStatus {
        kind,
        connected: true,
        identity: st.identity.clone(),
        sites: st.sites.clone(),
        scopes: st.scopes.clone(),
        expires_at: st.expires_at,
        mirrors: st.mirrors.clone(),
        auto_mirror_repo_root: st.auto_mirror_repo_root.clone(),
    }
}

// ── Jira commands ────────────────────────────────────────────────────

/// Begin Jira (Atlassian 3LO) OAuth. Opens the system browser at the
/// authorize URL, awaits the callback, exchanges for tokens, persists,
/// and returns the full connection status — all in one IPC call so the
/// renderer just shows a spinner.
///
/// Emits `aura:integrations:jira:auth_url` once the URL is ready, so
/// the renderer can show a "If the browser didn't open, click here"
/// fallback link (same pattern `mcp_servers_oauth_begin` uses).
#[tauri::command]
pub async fn integrations_jira_connect(app: AppHandle) -> Result<ConnectionStatus, String> {
    // Evict any stale flow first. The classic stale case: a previous
    // attempt landed on an Atlassian error page (invalid_scope,
    // failed-to-retrieve-client, user-denied) — Atlassian doesn't
    // redirect back, so our loopback listener sits on port 42421
    // until its 5-minute timeout. Cancelling first drops it
    // immediately and gives the OS a beat to release the port.
    cancel_pending_jira().await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let cfg = config::jira().map_err(|e| e.into_string())?;
    let flow = jira::start_auth(&cfg).await.map_err(|e| e.into_string())?;

    // Stash the cancel handle so `_cancel` (or a next `_connect`) can
    // evict this flow if the user bails on the browser side.
    *pending_jira_flow().lock().await = Some(flow.cancel);

    let _ = app.emit("aura:integrations:jira:auth_url", &flow.authorize_url);
    // Best-effort. Failure here is not fatal — the renderer also has
    // the URL via the emitted event and can render a clickable link.
    if let Err(e) = app.opener().open_url(&flow.authorize_url, None::<String>) {
        tracing::warn!(?e, "open browser failed; URL emitted to renderer");
    }

    let outcome_result = flow
        .completion
        .await
        .map_err(|e| format!("oauth flow task panicked: {e}"))?;

    // Whether the flow succeeded or failed, the slot must be cleared
    // so the next attempt isn't seen as "still pending". The cancel
    // sender itself has already been consumed if the user fired
    // cancel; otherwise we drop it here.
    {
        let mut slot = pending_jira_flow().lock().await;
        *slot = None;
    }

    let outcome = outcome_result.map_err(|e| e.into_string())?;

    persist_provider_state(
        IntegrationKind::Jira,
        Some(outcome.identity.clone()),
        outcome.sites.clone(),
        &outcome.tokens,
    )?;

    // Re-read so we surface any mirrors carried over from a previous
    // connection (reconnect after token expiry shouldn't clobber the
    // user's mirror picks).
    let state = read_state()?;
    let mirrors = state
        .providers
        .get(IntegrationKind::Jira.slug())
        .map(|p| p.mirrors.clone())
        .unwrap_or_default();

    let auto_mirror_repo_root = state
        .providers
        .get(IntegrationKind::Jira.slug())
        .and_then(|p| p.auto_mirror_repo_root.clone());

    Ok(ConnectionStatus {
        kind: IntegrationKind::Jira,
        connected: true,
        identity: Some(outcome.identity),
        sites: outcome.sites,
        scopes: outcome.tokens.scope.clone(),
        expires_at: outcome.tokens.expires_at,
        mirrors,
        auto_mirror_repo_root,
    })
}

/// Cancel any in-flight Jira OAuth flow. The `_connect` future resolves
/// with `"connect cancelled"`, the loopback listener is aborted, and
/// the port is released so the user can immediately retry.
#[tauri::command]
pub async fn integrations_jira_cancel() -> Result<(), String> {
    cancel_pending_jira().await;
    Ok(())
}

/// Check whether Jira is connected and return the current status.
/// Refreshes the access token if it's expired so the next provider
/// call (pull / push) doesn't immediately 401. Does NOT re-fetch
/// identity or sites — those come from the local state file.
#[tauri::command]
pub async fn integrations_jira_status() -> Result<ConnectionStatus, String> {
    let stored = tokens::load(IntegrationKind::Jira).map_err(|e| e.into_string())?;
    let Some(mut blob) = stored else {
        return Ok(ConnectionStatus::disconnected(IntegrationKind::Jira));
    };

    // Refresh if expired. If we have no refresh_token (or no config to
    // refresh against) we treat the integration as disconnected so the
    // settings UI prompts a reconnect rather than silently failing.
    if is_expired(&blob) {
        let cfg = match config::jira() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(?e, "jira config missing while token expired");
                return Ok(ConnectionStatus::disconnected(IntegrationKind::Jira));
            }
        };
        let Some(rt) = blob.refresh_token.clone() else {
            return Ok(ConnectionStatus::disconnected(IntegrationKind::Jira));
        };
        let refreshed = jira::refresh(&cfg, &rt).await.map_err(|e| e.into_string())?;
        tokens::store(IntegrationKind::Jira, &refreshed).map_err(|e| e.into_string())?;

        // Patch the state file's expiry/scope to the new blob's view.
        let mut state = read_state()?;
        if let Some(slot) = state.providers.get_mut(IntegrationKind::Jira.slug()) {
            slot.scopes = refreshed.scope.clone();
            slot.expires_at = refreshed.expires_at;
            write_state(&state)?;
        }
        blob = refreshed;
    }

    let state = read_state()?;
    if let Some(entry) = state.providers.get(IntegrationKind::Jira.slug()) {
        return Ok(status_from_state(IntegrationKind::Jira, entry));
    }
    // Tokens present, state file missing or stale — surface a minimal
    // "connected" status with no identity. The renderer treats this as
    // "click reconnect to refresh".
    Ok(ConnectionStatus {
        kind: IntegrationKind::Jira,
        connected: true,
        identity: None,
        sites: Vec::new(),
        scopes: blob.scope,
        expires_at: blob.expires_at,
        mirrors: Vec::new(),
        auto_mirror_repo_root: None,
    })
}

/// Forget Jira: revoke local tokens (Atlassian has no revocation
/// endpoint for 3LO apps; tokens just naturally expire) and wipe the
/// state file entry. Idempotent — disconnecting an already-disconnected
/// provider is a no-op.
#[tauri::command]
pub fn integrations_jira_disconnect() -> Result<(), String> {
    tokens::delete(IntegrationKind::Jira).map_err(|e| e.into_string())?;
    forget_provider_state(IntegrationKind::Jira)?;
    Ok(())
}

/// List Jira projects on a given Atlassian site. Used by the renderer
/// to populate the "Mirror this project" dropdown. Refreshes the access
/// token first if needed so a one-off settings-panel call after a stale
/// expiry doesn't 401. No caching — the list is small and changes
/// infrequently; the UI calls this on demand when the user opens the
/// picker.
#[tauri::command]
pub async fn integrations_jira_projects(cloud_id: String) -> Result<Vec<JiraProject>, String> {
    let access = jira_sync::valid_access_token()
        .await
        .map_err(|e| e.into_string())?;
    jira_sync::list_projects(&access.access_token, &cloud_id)
        .await
        .map_err(|e| e.into_string())
}

/// Bind a Jira project to a local Aura repo. The pair
/// `(cloud_id, project_key)` is unique — repeat calls upsert the
/// repo_root + project_name in place. Repo root is validated lightly
/// (must exist and contain `.aura/`) so the poller doesn't waste cycles
/// on a stale directory after the user moved a clone.
#[tauri::command]
pub fn integrations_jira_mirror_set(
    cloud_id: String,
    project_key: String,
    project_name: String,
    repo_root: String,
) -> Result<ConnectionStatus, String> {
    let p = PathBuf::from(&repo_root);
    if !p.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    if !p.join(".aura").is_dir() {
        return Err(format!("not an Aura repo (no .aura/): {repo_root}"));
    }

    let mut state = read_state()?;
    let slot = state
        .providers
        .entry(IntegrationKind::Jira.slug().to_string())
        .or_insert_with(default_provider_state);

    let already = slot
        .mirrors
        .iter_mut()
        .find(|m| m.cloud_id == cloud_id && m.project_key == project_key);
    if let Some(existing) = already {
        existing.project_name = project_name;
        existing.repo_root = repo_root;
    } else {
        slot.mirrors.push(MirrorSummary {
            cloud_id,
            project_key,
            project_name,
            repo_root,
            last_synced_at: None,
            last_sync_created: 0,
            last_sync_updated: 0,
            last_sync_errors: 0,
            last_sync_jql_stamp: None,
        });
    }
    write_state(&state)?;

    // Reuse the same compose path as `_status` so the renderer sees the
    // exact same shape it would on next mount.
    let st = state
        .providers
        .get(IntegrationKind::Jira.slug())
        .cloned()
        .unwrap_or_else(|| ProviderState {
            identity: None,
            sites: Vec::new(),
            scopes: None,
            expires_at: None,
            mirrors: Vec::new(),
            auto_mirror_repo_root: None,
        });
    Ok(status_from_state(IntegrationKind::Jira, &st))
}

/// Remove a mirror binding. Idempotent — removing a binding that
/// doesn't exist is a no-op and still returns the current status.
#[tauri::command]
pub fn integrations_jira_mirror_unset(
    cloud_id: String,
    project_key: String,
) -> Result<ConnectionStatus, String> {
    let mut state = read_state()?;
    if let Some(slot) = state.providers.get_mut(IntegrationKind::Jira.slug()) {
        slot.mirrors
            .retain(|m| !(m.cloud_id == cloud_id && m.project_key == project_key));
        write_state(&state)?;
    }

    let st = state
        .providers
        .get(IntegrationKind::Jira.slug())
        .cloned()
        .unwrap_or_else(|| ProviderState {
            identity: None,
            sites: Vec::new(),
            scopes: None,
            expires_at: None,
            mirrors: Vec::new(),
            auto_mirror_repo_root: None,
        });
    Ok(status_from_state(IntegrationKind::Jira, &st))
}

/// Run a pull-mirror sync now. With no `repo_root` argument, every
/// configured mirror is synced. With one, only mirrors pointing at that
/// repo run — used by the per-workspace "Sync now" button so opening
/// settings from inside one repo doesn't accidentally sync another.
///
/// After each project syncs, its `last_*` counters are updated in the
/// state file, so the UI can show "Last synced 2m ago — 3 created,
/// 4 updated" without a follow-up call.
/// Force a full re-pull of every Jira mirror by clearing each
/// mirror's `last_sync_jql_stamp` watermark, then running the standard
/// sync path. Used by the Settings → Integrations "Re-sync from
/// scratch" button when the incremental cache has drifted (e.g. parent
/// links weren't imported on an earlier client version, an issue type
/// was renamed Jira-side, or the user wants to verify the mirror after
/// a manual cleanup).
///
/// `repo_root` filters to just one bound repo if set, same as
/// `integrations_jira_sync_now`.
#[tauri::command]
pub async fn integrations_jira_backfill(
    repo_root: Option<String>,
) -> Result<Vec<SyncOutcome>, String> {
    // Step 1: clear watermarks for the affected mirrors so the next
    // sync uses a no-since JQL and walks the whole project.
    {
        let mut state = read_state()?;
        if let Some(slot) = state.providers.get_mut(IntegrationKind::Jira.slug()) {
            for m in slot.mirrors.iter_mut() {
                if let Some(filter) = repo_root.as_deref() {
                    if filter != m.repo_root {
                        continue;
                    }
                }
                m.last_sync_jql_stamp = None;
            }
            write_state(&state)?;
        }
    }
    // Step 2: delegate to the standard sync path. It'll see the cleared
    // watermark and do a full sweep, then write the fresh watermark
    // back on success.
    integrations_jira_sync_now(repo_root).await
}

#[tauri::command]
pub async fn integrations_jira_sync_now(
    repo_root: Option<String>,
) -> Result<Vec<SyncOutcome>, String> {
    let state = read_state()?;
    let Some(jira_state) = state.providers.get(IntegrationKind::Jira.slug()).cloned() else {
        return Ok(Vec::new());
    };
    if jira_state.mirrors.is_empty() {
        return Ok(Vec::new());
    }

    let access = jira_sync::valid_access_token()
        .await
        .map_err(|e| e.into_string())?;

    // Map cloud_id → site URL for ADF/link rendering. If we don't have
    // the site (state file out of sync), we still proceed with an empty
    // base URL — issue body links will be relative but mapping otherwise
    // works.
    let site_url_for = |cid: &str| -> String {
        jira_state
            .sites
            .iter()
            .find(|s| s.cloud_id == cid)
            .map(|s| s.url.clone())
            .unwrap_or_default()
    };

    let mut results: Vec<SyncOutcome> = Vec::new();
    for m in jira_state.mirrors.iter() {
        if let Some(filter) = repo_root.as_deref() {
            if filter != m.repo_root {
                continue;
            }
        }
        match jira_sync::sync_project_with_cache(
            &access.access_token,
            &m.cloud_id,
            &site_url_for(&m.cloud_id),
            &m.project_key,
            &m.repo_root,
            m.last_sync_jql_stamp.as_deref(),
        )
        .await
        {
            Ok(o) => results.push(o),
            Err(e) => {
                // Record the failure but keep going — one bad project
                // shouldn't block the others. The error is surfaced via
                // last_sync_errors count (rolled up below).
                let msg = e.into_string();
                tracing::warn!(error = %msg, project = %m.project_key, "jira sync_project failed");
                results.push(SyncOutcome {
                    project_key: m.project_key.clone(),
                    created: 0,
                    updated: 0,
                    skipped: 0,
                    errors: vec![msg],
                    synced_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                });
            }
        }
    }

    // Roll the outcome counters back into the state file so the UI can
    // render last-sync chips on next mount.
    let mut state = read_state()?;
    if let Some(slot) = state.providers.get_mut(IntegrationKind::Jira.slug()) {
        for o in results.iter() {
            if let Some(m) = slot.mirrors.iter_mut().find(|m| m.project_key == o.project_key) {
                m.last_synced_at = Some(o.synced_at);
                m.last_sync_created = o.created;
                m.last_sync_updated = o.updated;
                m.last_sync_errors = o.errors.len() as u32;
                // Only advance the JQL watermark on a clean run.
                // A partial sync (errors > 0) could have skipped issues
                // that updated in this window; keep the old stamp so
                // the next poll re-covers them.
                if o.errors.is_empty() {
                    // 60-second back-off: Atlassian indexes `updated` a
                    // beat after the write lands, so subtracting a
                    // minute avoids losing edits that happened mid-poll.
                    let stamp_secs = o.synced_at.saturating_sub(60);
                    m.last_sync_jql_stamp = Some(jql_stamp_from_unix(stamp_secs));
                }
            }
        }
        write_state(&state)?;
    }

    Ok(results)
}

/// Walk every site, list its projects, and ensure a mirror exists for
/// each one targeting `repo_root`. Returns the count of newly-created
/// mirrors so the poller can emit an "added N projects" event the next
/// time auto-discovery picks up a fresh project on the Atlassian side.
///
/// Errors on individual sites are warn-logged and skipped — a single
/// site that goes 5xx shouldn't block discovery on the others.
async fn discover_and_ensure_mirrors(repo_root: &str) -> Result<u32, String> {
    let state = read_state()?;
    let Some(jira_state) = state.providers.get(IntegrationKind::Jira.slug()).cloned() else {
        return Ok(0);
    };
    if jira_state.sites.is_empty() {
        return Ok(0);
    }

    let access = jira_sync::valid_access_token()
        .await
        .map_err(|e| e.into_string())?;

    // Collect new (site, project) pairs across all sites first, then
    // open the state file once for the write. Avoids holding the file
    // lock across HTTP calls.
    let mut to_add: Vec<(String, JiraProject)> = Vec::new();
    for site in jira_state.sites.iter() {
        match jira_sync::list_projects(&access.access_token, &site.cloud_id).await {
            Ok(projects) => {
                for p in projects {
                    let already = jira_state.mirrors.iter().any(|m| {
                        m.cloud_id == site.cloud_id && m.project_key == p.key
                    });
                    if !already {
                        to_add.push((site.cloud_id.clone(), p));
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = ?e, site = %site.name, "auto-mirror discovery skipped site");
            }
        }
    }
    if to_add.is_empty() {
        return Ok(0);
    }

    let mut state = read_state()?;
    let added = to_add.len() as u32;
    let slot = state
        .providers
        .entry(IntegrationKind::Jira.slug().to_string())
        .or_insert_with(default_provider_state);
    for (cloud_id, p) in to_add {
        slot.mirrors.push(MirrorSummary {
            cloud_id,
            project_key: p.key,
            project_name: p.name,
            repo_root: repo_root.to_string(),
            last_synced_at: None,
            last_sync_created: 0,
            last_sync_updated: 0,
            last_sync_errors: 0,
            last_sync_jql_stamp: None,
        });
    }
    write_state(&state)?;
    Ok(added)
}

/// Default-shaped `ProviderState` for upserts. Centralised so adding a
/// field to the struct doesn't require touching every call site.
fn default_provider_state() -> ProviderState {
    ProviderState {
        identity: None,
        sites: Vec::new(),
        scopes: None,
        expires_at: None,
        mirrors: Vec::new(),
        auto_mirror_repo_root: None,
    }
}

/// Format a unix-second timestamp into Atlassian's JQL date shape
/// (`YYYY-MM-DD HH:MM`, UTC). Used for the `updated >=` watermark so
/// each incremental sync only fetches issues changed since the last
/// clean run.
fn jql_stamp_from_unix(secs: u64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_opt(secs as i64, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// Turn on auto-mirror for Jira → `repo_root`. Immediately discovers
/// every project on every connected site and creates a mirror for each
/// one. From here, the 5-min poller keeps the mirror list in sync with
/// upstream (newly-created Jira projects auto-appear in Aura within
/// 5 min of creation).
#[tauri::command]
pub async fn integrations_jira_auto_mirror_enable(
    repo_root: String,
) -> Result<ConnectionStatus, String> {
    let p = PathBuf::from(&repo_root);
    if !p.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    if !p.join(".aura").is_dir() {
        return Err(format!("not an Aura repo (no .aura/): {repo_root}"));
    }

    // Flip the toggle first so the discovery write below carries the
    // auto_mirror_repo_root forward even if discovery itself partially
    // fails (one bad site shouldn't undo the user's intent).
    {
        let mut state = read_state()?;
        let slot = state
            .providers
            .entry(IntegrationKind::Jira.slug().to_string())
            .or_insert_with(default_provider_state);
        slot.auto_mirror_repo_root = Some(repo_root.clone());
        write_state(&state)?;
    }

    let _added = discover_and_ensure_mirrors(&repo_root).await?;

    let state = read_state()?;
    let st = state
        .providers
        .get(IntegrationKind::Jira.slug())
        .cloned()
        .unwrap_or_else(default_provider_state);
    Ok(status_from_state(IntegrationKind::Jira, &st))
}

/// Called by the background poller on every cycle. No-ops when
/// auto-mirror is off. Not exposed as a Tauri command — the renderer
/// uses `_auto_mirror_enable` for the explicit user-driven flow.
pub async fn integrations_jira_auto_discover_tick() -> Result<u32, String> {
    let state = read_state()?;
    let Some(jira_state) = state.providers.get(IntegrationKind::Jira.slug()).cloned() else {
        return Ok(0);
    };
    let Some(repo_root) = jira_state.auto_mirror_repo_root.clone() else {
        return Ok(0);
    };
    discover_and_ensure_mirrors(&repo_root).await
}

/// Turn off auto-mirror. Existing mirrors stay configured — the user
/// can keep curating manually via `_mirror_unset`. Only the
/// auto-discovery behaviour stops.
#[tauri::command]
pub fn integrations_jira_auto_mirror_disable() -> Result<ConnectionStatus, String> {
    let mut state = read_state()?;
    if let Some(slot) = state.providers.get_mut(IntegrationKind::Jira.slug()) {
        slot.auto_mirror_repo_root = None;
        write_state(&state)?;
    }
    let st = state
        .providers
        .get(IntegrationKind::Jira.slug())
        .cloned()
        .unwrap_or_else(default_provider_state);
    Ok(status_from_state(IntegrationKind::Jira, &st))
}

// ── Linear commands ──────────────────────────────────────────────────

/// Begin Linear OAuth. Same one-shot shape as the Jira connect: opens the
/// system browser, awaits the loopback callback, exchanges the code,
/// probes the workspace identity, persists tokens, and returns the full
/// connection status. Emits `aura:integrations:linear:auth_url` so the
/// renderer can offer a "didn't open?" fallback link.
#[tauri::command]
pub async fn integrations_linear_connect(app: AppHandle) -> Result<ConnectionStatus, String> {
    // Evict any stale flow first (a previous attempt that landed on a
    // Linear error page never redirects back, leaving the loopback
    // listener holding the port until its 5-min timeout).
    cancel_pending_linear().await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let cfg = config::linear().map_err(|e| e.into_string())?;
    let flow = linear::start_auth(&cfg).await.map_err(|e| e.into_string())?;

    *pending_linear_flow().lock().await = Some(flow.cancel);

    let _ = app.emit("aura:integrations:linear:auth_url", &flow.authorize_url);
    if let Err(e) = app.opener().open_url(&flow.authorize_url, None::<String>) {
        tracing::warn!(?e, "open browser failed; URL emitted to renderer");
    }

    let outcome_result = flow
        .completion
        .await
        .map_err(|e| format!("oauth flow task panicked: {e}"))?;

    {
        let mut slot = pending_linear_flow().lock().await;
        *slot = None;
    }

    let outcome = outcome_result.map_err(|e| e.into_string())?;

    // Linear is single-workspace per token — no `sites`. Reuse the shared
    // persist helper with an empty site list.
    persist_provider_state(
        IntegrationKind::Linear,
        Some(outcome.identity.clone()),
        Vec::new(),
        &outcome.tokens,
    )?;

    Ok(ConnectionStatus {
        kind: IntegrationKind::Linear,
        connected: true,
        identity: Some(outcome.identity),
        sites: Vec::new(),
        scopes: outcome.tokens.scope.clone(),
        expires_at: outcome.tokens.expires_at,
        mirrors: Vec::new(),
        auto_mirror_repo_root: None,
    })
}

/// Cancel an in-flight Linear OAuth flow. The `_connect` future resolves
/// with "connect cancelled" and the loopback port is released.
#[tauri::command]
pub async fn integrations_linear_cancel() -> Result<(), String> {
    cancel_pending_linear().await;
    Ok(())
}

/// Return the current Linear connection status. Linear tokens are
/// long-lived and carry no refresh token, so there's no refresh step —
/// a lapsed token simply reports disconnected so the UI prompts a
/// reconnect. Identity comes from the local state file, not the network.
#[tauri::command]
pub async fn integrations_linear_status() -> Result<ConnectionStatus, String> {
    let stored = tokens::load(IntegrationKind::Linear).map_err(|e| e.into_string())?;
    let Some(blob) = stored else {
        return Ok(ConnectionStatus::disconnected(IntegrationKind::Linear));
    };

    // No refresh path (Linear issues no refresh token). If the token has
    // genuinely expired, surface disconnected so the user reconnects.
    if is_expired(&blob) {
        return Ok(ConnectionStatus::disconnected(IntegrationKind::Linear));
    }

    let state = read_state()?;
    if let Some(entry) = state.providers.get(IntegrationKind::Linear.slug()) {
        return Ok(status_from_state(IntegrationKind::Linear, entry));
    }
    // Tokens present, state file missing — minimal connected status.
    Ok(ConnectionStatus {
        kind: IntegrationKind::Linear,
        connected: true,
        identity: None,
        sites: Vec::new(),
        scopes: blob.scope,
        expires_at: blob.expires_at,
        mirrors: Vec::new(),
        auto_mirror_repo_root: None,
    })
}

/// Forget Linear: wipe local tokens + cached state. Idempotent.
#[tauri::command]
pub fn integrations_linear_disconnect() -> Result<(), String> {
    tokens::delete(IntegrationKind::Linear).map_err(|e| e.into_string())?;
    forget_provider_state(IntegrationKind::Linear)?;
    Ok(())
}

/// Snapshot all integrations the renderer should display in Settings.
/// Hits keychain + state file only — no network. For the live token
/// expiry view the caller follows up with `*_status` on individual
/// providers.
#[tauri::command]
pub fn integrations_list() -> Result<Vec<ConnectionStatus>, String> {
    let state = read_state()?;
    let mut out = Vec::new();

    // Jira
    let jira_token = tokens::load(IntegrationKind::Jira).map_err(|e| e.into_string())?;
    if jira_token.is_some() {
        if let Some(entry) = state.providers.get(IntegrationKind::Jira.slug()) {
            out.push(status_from_state(IntegrationKind::Jira, entry));
        } else {
            // tokens present but state file empty — minimal connected stub.
            let t = jira_token.unwrap();
            out.push(ConnectionStatus {
                kind: IntegrationKind::Jira,
                connected: true,
                identity: None,
                sites: Vec::new(),
                scopes: t.scope,
                expires_at: t.expires_at,
                mirrors: Vec::new(),
                auto_mirror_repo_root: None,
            });
        }
    } else {
        out.push(ConnectionStatus::disconnected(IntegrationKind::Jira));
    }

    // Linear — single-workspace, no sites/mirrors.
    let linear_token = tokens::load(IntegrationKind::Linear).map_err(|e| e.into_string())?;
    if linear_token.is_some() {
        if let Some(entry) = state.providers.get(IntegrationKind::Linear.slug()) {
            out.push(status_from_state(IntegrationKind::Linear, entry));
        } else {
            let t = linear_token.unwrap();
            out.push(ConnectionStatus {
                kind: IntegrationKind::Linear,
                connected: true,
                identity: None,
                sites: Vec::new(),
                scopes: t.scope,
                expires_at: t.expires_at,
                mirrors: Vec::new(),
                auto_mirror_repo_root: None,
            });
        }
    } else {
        out.push(ConnectionStatus::disconnected(IntegrationKind::Linear));
    }

    Ok(out)
}

// ── Beads ────────────────────────────────────────────────────────────
//
// Beads (github.com/steveyegge/beads) is a local, git-native issue
// tracker. Unlike Jira there's no OAuth, no token, no network — the
// issues live in a `.beads/*.jsonl` log right in the repo. So the
// surface is a one-shot migration: point at a Beads tracker, preview the
// count, import into the board. The parser/mapper/idempotent two-pass
// importer all live in `integrations::beads`; these commands are thin
// IPC wrappers, mirroring how the Jira commands wrap `jira_sync`.

/// Count the issues in a Beads tracker without writing anything — drives
/// the "Found N issues" confirmation before the user commits to an
/// import. `source` may be a repo root containing `.beads/`, the
/// `.beads/` folder itself, or a direct path to a `*.jsonl` log.
#[tauri::command]
pub fn integrations_beads_preview(
    source: String,
) -> Result<crate::integrations::beads::BeadsPreview, String> {
    crate::integrations::beads::preview(std::path::Path::new(&source))
        .map_err(|e| e.into_string())
}

/// Import (or re-import) a Beads tracker's issues into `repo_root`'s task
/// board. Idempotent on `("beads", <bead id>)` — re-running updates rows
/// in place instead of duplicating, and resolves the beads dependency
/// graph onto Aura's blocked-by edges. Returns the run tally so the UI
/// can render "Imported N · updated M · linked K".
#[tauri::command]
pub async fn integrations_beads_import(
    repo_root: String,
    source: String,
) -> Result<crate::integrations::beads::BeadsImportOutcome, String> {
    crate::integrations::beads::import(&repo_root, std::path::Path::new(&source))
        .await
        .map_err(|e| e.into_string())
}

// ── Jira ⇄ Aura person linking ────────────────────────────────────────────
//
// Imported Jira cards carry a Jira account on their assignee. These commands
// back the Settings reconcile panel that ties each Jira person to a real
// teammate, so the board shows the right human and re-syncs heal themselves.

/// The current link table for `repo_root` — every Jira person we've seen on an
/// import, unresolved-first, with their bound handle when known. Drives the
/// "People" list in the Jira settings panel.
#[tauri::command]
pub fn integrations_jira_users_list(
    repo_root: String,
) -> Result<Vec<crate::integrations::jira_users::JiraUserLink>, String> {
    Ok(crate::integrations::jira_users::list_links(&repo_root))
}

/// Ask Aura's own brain to propose, for each still-unlinked Jira person, the
/// teammate most likely to be the same human (with a confidence). Conservative:
/// returns "no confident match — pick by hand" rather than guess. The user
/// confirms each one — we never merge two identities automatically.
#[tauri::command]
pub async fn integrations_jira_users_reconcile(
    repo_root: String,
) -> Result<Vec<crate::integrations::jira_users::ReconcileSuggestion>, String> {
    crate::integrations::jira_users::reconcile_suggest(&repo_root).await
}

/// Confirm a link: bind a Jira account to a teammate's handle and re-point
/// every already-imported Jira task off the old display label onto the handle.
/// Returns how many tasks were updated.
#[tauri::command]
pub async fn integrations_jira_users_link(
    repo_root: String,
    account_id: String,
    handle: String,
) -> Result<crate::integrations::jira_users::LinkApplied, String> {
    crate::integrations::jira_users::apply_link(&repo_root, &account_id, &handle).await
}

/// Drop a link (it was wrong). The account returns to the unresolved list;
/// already-imported tasks keep whatever assignee they have.
#[tauri::command]
pub fn integrations_jira_users_unlink(
    repo_root: String,
    account_id: String,
) -> Result<(), String> {
    crate::integrations::jira_users::unlink(&repo_root, &account_id)
}
