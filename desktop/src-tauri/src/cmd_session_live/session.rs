//! Session lifecycle: sharing, previewing, joining, leaving, and changing what
//! a participant is allowed to do.
//!
//! Everything here either opens or closes a door. The frame-level commands live
//! in `frames.rs`, and the tunnel commands with the proxy they control in
//! `tunnel.rs`.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use super::ctx::{self, ConnCtx, Role, ShareState};
use super::http::{self, JoinPreview};
use super::identity::{agent_identity_for, local_agent_for};
use super::protocol::{ClientFrame, ACCESS_WATCH};
use super::target::{fallback_share_url, normalise_access, parse_target, Target};
use super::{host, info_of, tunnel, LiveEntry, SessionLiveInfo, SessionLiveState};

fn share_state_of(resp: http::ShareResp) -> ShareState {
    ShareState {
        url: resp.link,
        // An empty code is no code. Carrying `Some("")` would make the UI
        // render a link with nothing on the end of it.
        code: Some(resp.code).filter(|c| !c.is_empty()),
        default_access: resp.default_access,
    }
}

/// What the caller wants done about the share before the socket opens.
enum ShareIntent {
    /// Host: ask the cloud for the link, at this level.
    Mint { default_access: String },
    /// Guest: the code we came in through, if we came in through one.
    ViaCode(Option<String>),
}

async fn connect(
    app: AppHandle,
    state: &State<'_, SessionLiveState>,
    external_id: String,
    role: Role,
    intent: ShareIntent,
) -> Result<SessionLiveInfo, String> {
    // Already in this session — return what we have rather than opening a
    // second socket for it. Idempotent, like `remote_start`.
    {
        let guard = state.conns.lock().await;
        if let Some(existing) = guard.get(&external_id) {
            if existing.ctx.role != role {
                return Err(format!(
                    "already in session {external_id} as {} — leave it first",
                    existing.ctx.role.as_str()
                ));
            }
            return Ok(info_of(&existing.ctx));
        }
    }

    let creds = crate::cloud_session_sync::read_credentials()?;
    let token = crate::cloud_session_sync::cloud_token(&creds).ok_or_else(|| {
        "not signed in to Aura cloud — a shared session is always authenticated".to_string()
    })?;
    let origin = crate::cloud_session_sync::cloud_origin(&creds);

    // The link is the cloud's to mint. Ask before dialling, so `ready` already
    // carries the real one and the share sheet never shows a placeholder.
    let share = match &intent {
        ShareIntent::Mint { default_access } => {
            match http::share(&origin, &token, &external_id, default_access).await {
                Ok(resp) => share_state_of(resp),
                Err(e) => {
                    // Not fatal: the session is still shareable inside the app
                    // by id, and refusing to open the socket because the link
                    // endpoint is unavailable would take working collaboration
                    // away over a cosmetic failure. The UI sees
                    // `share_code: null` and can say so.
                    warn!(target: "session_live", "share endpoint unavailable: {e}");
                    ShareState {
                        url: fallback_share_url(&external_id),
                        code: None,
                        default_access: default_access.clone(),
                    }
                }
            }
        }
        ShareIntent::ViaCode(code) => ShareState {
            url: fallback_share_url(&external_id),
            code: code.clone(),
            // A guest does not set the session's default; leaving this empty
            // keeps `resolve_access_inbound` from reading it as policy.
            default_access: String::new(),
        },
    };

    // Only a host wires the socket to a running agent. A guest's inbound
    // messages must never reach a process on this machine.
    let (repo_root, agent_id) = match role {
        Role::Host => match local_agent_for(&app, &external_id) {
            Some((root, id)) => (Some(root), Some(id)),
            None => (None, None),
        },
        Role::Guest => (None, None),
    };
    let agent_session_id = match role {
        Role::Host if agent_id.is_some() => Some(external_id.clone()),
        _ => None,
    };
    let agent_identity = agent_id.as_deref().map(agent_identity_for);

    let (out_tx, out_rx) = mpsc::unbounded_channel::<ClientFrame>();
    let conn_ctx = Arc::new(ConnCtx::new(
        app.clone(),
        external_id.clone(),
        role,
        origin.clone(),
        token,
        share,
        agent_session_id,
        repo_root,
        agent_identity,
        out_tx,
    ));

    // Dial inline so an auth failure, a missing session or a repo the caller is
    // not a member of surfaces as a command error the UI can show — not a
    // silent background retry.
    let (ws, ready) = super::conn::dial_and_hello(&conn_ctx).await?;

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let ctx_for_task = conn_ctx.clone();
    tauri::async_runtime::spawn(async move {
        super::conn::run(ctx_for_task, ws, ready, out_rx, cancel_rx).await;
    });

    // Publishers come up after `ready`, because `apply_ready` is what tells us
    // whether the server honoured the host claim.
    host::attach(&conn_ctx);

    // A host is here to work; a guest arrives watching.
    conn_ctx.set_presence_state(match role {
        Role::Host => "coding",
        Role::Guest => "watching",
    });
    conn_ctx.send(ClientFrame::State {
        state: conn_ctx.presence_state(),
    });

    let info = info_of(&conn_ctx);
    {
        let mut guard = state.conns.lock().await;
        guard.insert(
            external_id,
            LiveEntry {
                ctx: conn_ctx,
                shutdown: Some(cancel_tx),
            },
        );
    }
    Ok(info)
}

/// The live connection for `session_id`, or an error naming what is missing.
pub(super) async fn ctx_for(
    state: &State<'_, SessionLiveState>,
    session_id: &str,
) -> Result<Arc<ConnCtx>, String> {
    let guard = state.conns.lock().await;
    guard
        .get(session_id)
        .map(|e| e.ctx.clone())
        .ok_or_else(|| format!("session {session_id} is not live on this desktop"))
}

/// Cloud origin + bearer for a call made outside a live connection.
fn cloud_auth() -> Result<(String, String), String> {
    let creds = crate::cloud_session_sync::read_credentials()?;
    let token = crate::cloud_session_sync::cloud_token(&creds)
        .ok_or_else(|| "not signed in to Aura cloud".to_string())?;
    Ok((crate::cloud_session_sync::cloud_origin(&creds), token))
}

// ── commands ───────────────────────────────────────────────────────────────

/// Host mode. Mints the share link, opens the live socket for `session_id`,
/// starts publishing the agent's transcript, and returns the link plus the code
/// behind it.
///
/// `default_access` is what a new joiner gets. It defaults to `watch`: handing
/// out a link that lets anyone who opens it type into an agent on this machine
/// is not a default anybody should get by omission.
#[tauri::command]
pub async fn session_live_share(
    app: AppHandle,
    state: State<'_, SessionLiveState>,
    session_id: String,
    default_access: Option<String>,
) -> Result<SessionLiveInfo, String> {
    let external_id = parse_target(&session_id)?.as_session_id()?;
    let default_access = normalise_access(default_access, ACCESS_WATCH)?;

    // Already hosting it: re-mint at the level asked for instead of handing
    // back the old share. The share sheet's watch/drive toggle is this same
    // command, so returning early here would make that toggle silently do
    // nothing after the first click.
    if let Ok(existing) = ctx_for(&state, &external_id).await {
        if existing.role != Role::Host {
            return Err(format!(
                "already in session {external_id} as guest — leave it first"
            ));
        }
        if !existing.is_host() {
            return Err(
                "another desktop is hosting this session — this one was demoted to guest".into(),
            );
        }
        let resp = http::share(
            &existing.origin,
            &existing.token,
            &existing.external_id,
            &default_access,
        )
        .await?;
        existing.set_share(share_state_of(resp));
        existing.emit_status(None);
        return Ok(info_of(&existing));
    }

    connect(
        app,
        &state,
        external_id,
        Role::Host,
        ShareIntent::Mint { default_access },
    )
    .await
}

/// The narrow share result the renderer's transport expects: just the link and
/// what it grants.
///
/// Same work as `session_live_share` — it opens the host socket too, because a
/// link to a session nobody is publishing into is a link to a frozen panel —
/// but it answers with `{code, link, default_access}` instead of the full
/// `SessionLiveInfo`.
#[tauri::command]
pub async fn session_live_share_create(
    app: AppHandle,
    state: State<'_, SessionLiveState>,
    session_id: String,
    default_access: Option<String>,
) -> Result<http::ShareResp, String> {
    let info = session_live_share(app, state, session_id, default_access).await?;
    Ok(http::ShareResp {
        code: info.share_code.unwrap_or_default(),
        link: info.share_url,
        default_access: info.default_access,
    })
}

/// Stop handing out the link. People already in the session stay in it — this
/// closes the door, it does not empty the room.
#[tauri::command]
pub async fn session_live_share_revoke(
    state: State<'_, SessionLiveState>,
    session_id: String,
) -> Result<(), String> {
    session_live_unshare(state, session_id).await
}

/// Resolve a share code. Same as `session_live_preview`, under the name the
/// renderer's transport invokes and taking the argument it sends.
#[tauri::command]
pub async fn session_live_join_preview(code: String) -> Result<JoinPreview, String> {
    session_live_preview(code).await
}

/// Stop handing out the link. People already in the session stay in it — this
/// closes the door, it does not empty the room.
#[tauri::command]
pub async fn session_live_unshare(
    state: State<'_, SessionLiveState>,
    session_id: String,
) -> Result<(), String> {
    let external_id = parse_target(&session_id)?.as_session_id()?;
    // Works whether or not the session is live here: a share can outlive the
    // socket that created it, and revoking it must not require re-joining.
    let (origin, token) = match ctx_for(&state, &external_id).await {
        Ok(c) => (c.origin.clone(), c.token.clone()),
        Err(_) => cloud_auth()?,
    };
    http::unshare(&origin, &token, &external_id).await?;
    if let Ok(c) = ctx_for(&state, &external_id).await {
        c.clear_share_code();
        c.emit_status(None);
    }
    Ok(())
}

/// Is this session already shared, and under what link?
///
/// A pure read — it never mints a share. The share surface asks this the moment
/// it opens, because the alternative is telling a host their session is private
/// when it is not, or minting a share just because somebody looked. `None`
/// means not shared.
#[tauri::command]
pub async fn session_live_share_status(
    state: State<'_, SessionLiveState>,
    session_id: String,
) -> Result<Option<http::ShareResp>, String> {
    let external_id = parse_target(&session_id)?.as_session_id()?;
    // Same fallback as unshare: a share outlives the socket that made it, so
    // this has to work with no live connection for the session.
    let (origin, token) = match ctx_for(&state, &external_id).await {
        Ok(c) => (c.origin.clone(), c.token.clone()),
        Err(_) => cloud_auth()?,
    };
    http::share_status(&origin, &token, &external_id).await
}

/// Resolve a share link or code without joining: whose machine it is, who is
/// already in there, and what you will be allowed to do.
#[tauri::command]
pub async fn session_live_preview(target: String) -> Result<JoinPreview, String> {
    let (origin, token) = cloud_auth()?;
    match parse_target(&target)? {
        Target::Code(code) | Target::Either(code) => http::preview(&origin, &token, &code).await,
        Target::Id(id) => Err(format!(
            "{id} is a session id, not a share code — there is nothing to preview"
        )),
    }
}

/// Guest mode. Accepts a session id, a share code or a share link, joins the
/// socket, and re-emits history plus every live frame to the frontend.
///
/// Both argument names are accepted: `target` for a pasted link, `session_id`
/// for a row the UI already has. The renderer's transport calls share and join
/// through one code path that always passes `session_id`, and a join that
/// silently no-ops on a missing argument is a bug nobody would find.
#[tauri::command]
pub async fn session_live_join(
    app: AppHandle,
    state: State<'_, SessionLiveState>,
    target: Option<String>,
    session_id: Option<String>,
) -> Result<SessionLiveInfo, String> {
    let raw = target
        .filter(|s| !s.trim().is_empty())
        .or(session_id)
        .ok_or_else(|| "give a session id or a share link".to_string())?;

    let (external_id, code) = match parse_target(&raw)? {
        Target::Id(id) => (id, None),
        Target::Code(code) => {
            let (origin, token) = cloud_auth()?;
            let preview = http::preview(&origin, &token, &code).await?;
            (preview.external_id, Some(code))
        }
        // Try the cheap GET first: a bare token is far more likely to be a
        // share code somebody typed than a session id, and preview costs one
        // request where a wrong guess costs a 15s socket timeout.
        Target::Either(token_str) => {
            let (origin, token) = cloud_auth()?;
            match http::preview(&origin, &token, &token_str).await {
                Ok(preview) => (preview.external_id, Some(token_str)),
                Err(_) => (token_str, None),
            }
        }
    };

    connect(
        app,
        &state,
        external_id,
        Role::Guest,
        ShareIntent::ViaCode(code),
    )
    .await
}

/// Host-only: promote a watcher to `drive`, or put a driver back to `watch`.
///
/// This is the other half of the doc's "asking for more access is not a new
/// frame": a guest sends an ordinary `msg` with `intent: "ask"`, the host's UI
/// recognises it (`from_access == "watch"` on `session-live:msg`) and calls
/// this.
#[tauri::command]
pub async fn session_live_set_access(
    state: State<'_, SessionLiveState>,
    session_id: String,
    participant_id: String,
    access: String,
) -> Result<(), String> {
    let access = normalise_access(Some(access), ACCESS_WATCH)?;
    let conn_ctx = ctx_for(&state, &session_id).await?;
    if !conn_ctx.is_host() {
        return Err("only the session host can change what someone may do".into());
    }
    if participant_id.trim().is_empty() {
        return Err("which participant?".into());
    }
    http::set_access(
        &conn_ctx.origin,
        &conn_ctx.token,
        &conn_ctx.external_id,
        &participant_id,
        &access,
    )
    .await
}

/// Leave the session: say `bye`, close every tunnel this socket opened, release
/// the transcript listener, and drop the connection.
#[tauri::command]
pub async fn session_live_leave(
    state: State<'_, SessionLiveState>,
    session_id: String,
) -> Result<(), String> {
    let entry = {
        let mut guard = state.conns.lock().await;
        guard.remove(&session_id)
    };
    let Some(mut entry) = entry else {
        // Already gone. Leaving twice is not an error worth showing a person.
        return Ok(());
    };
    let conn_ctx = entry.ctx;

    // Say goodbye before anything stops accepting frames — `ConnCtx::send` is
    // a no-op once stopped, and the pump flushes what is queued on cancel.
    conn_ctx.send(ClientFrame::Bye {});
    // "Tunnels die with the socket that opened them."
    tunnel::close_all(&conn_ctx).await;
    ctx::release_listeners(&conn_ctx);
    conn_ctx.stop();
    if let Some(tx) = entry.shutdown.take() {
        let _ = tx.send(());
    }
    conn_ctx.emit_status(None);
    Ok(())
}

/// Every session this desktop is currently hosting or watching.
#[tauri::command]
pub async fn session_live_status(
    state: State<'_, SessionLiveState>,
) -> Result<Vec<SessionLiveInfo>, String> {
    let guard = state.conns.lock().await;
    Ok(guard.values().map(|e| info_of(&e.ctx)).collect())
}

/// Say goodbye on every live session at app shutdown, so a collaborator sees
/// `host offline` immediately instead of discovering it by timeout.
///
/// Deliberately does no network work of its own — it runs on the exit path,
/// where a stalled HTTP call would hang the quit. Tunnels need no explicit
/// close here: the protocol has them die with the socket that opened them, and
/// the socket dies with this process.
pub async fn shutdown_all(app: &AppHandle) {
    let Some(state) = app.try_state::<SessionLiveState>() else {
        return;
    };
    let entries: Vec<(Arc<ConnCtx>, Option<oneshot::Sender<()>>)> = {
        let mut guard = state.conns.lock().await;
        guard
            .drain()
            .map(|(_, mut e)| (e.ctx.clone(), e.shutdown.take()))
            .collect()
    };
    for (conn_ctx, shutdown) in entries {
        conn_ctx.send(ClientFrame::Bye {});
        ctx::release_listeners(&conn_ctx);
        conn_ctx.stop();
        if let Some(tx) = shutdown {
            let _ = tx.send(());
        }
    }
}
