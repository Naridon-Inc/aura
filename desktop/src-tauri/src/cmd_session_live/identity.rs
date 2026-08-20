//! Who this desktop says it is, and who it says its agent is.
//!
//! A shared session is only legible if every entry has an author, so these are
//! the functions that turn "the person at this keyboard" and "the agent this
//! session runs" into the `Identity` / `Author` records the protocol carries.

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use super::ctx::ConnCtx;
use super::protocol::{Author, Identity};

/// How this desktop's human introduces themselves in `hello.as`.
///
/// `cloud_user` is what the cloud already knows us by (usually an email), so it
/// is the name that will match the account on the other side. The hostname is
/// the fallback — a machine name is a poorer label than a person's name, but it
/// is better than an empty avatar row.
pub fn local_identity() -> Identity {
    let creds = crate::cloud_session_sync::read_credentials().unwrap_or_default();
    let name = creds
        .get("cloud_user")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.split('@').next().unwrap_or(s).to_string())
        .unwrap_or_else(|| crate::cmd_remote_devices::device_identity().name);
    Identity {
        name,
        avatar: None,
        kind: "human".to_string(),
        agent_kind: None,
    }
}

/// The local human, as a transcript `author`.
pub fn local_author(ctx: &Arc<ConnCtx>) -> Option<Author> {
    if let Some(me) = ctx.me() {
        return Some(Author {
            id: me.id,
            name: me.name,
            kind: me.kind,
        });
    }
    let ident = local_identity();
    Some(Author {
        id: ctx.participant_id().unwrap_or_default(),
        name: ident.name,
        kind: "human".to_string(),
    })
}

/// The local agent, as a transcript `author`. Assistant and tool entries all
/// come from the one agent this share is wired to.
pub fn agent_author(ctx: &Arc<ConnCtx>) -> Option<Author> {
    let ident = ctx.agent_identity.clone()?;
    // Prefer the participant the server minted for this agent, so a guest can
    // click the author and address it back.
    let id = ctx
        .participants()
        .into_iter()
        .find(|p| p.kind == "agent" && p.role == "host")
        .map(|p| p.id)
        .unwrap_or_default();
    Some(Author {
        id,
        name: ident.name,
        kind: "agent".to_string(),
    })
}

/// Human label for an agent id — matches the wording the cloud session feed
/// already uses so a session does not change its name when it is shared.
pub fn agent_display_name(agent_id: &str) -> String {
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

/// The identity to declare in `hello.agents` for the agent behind this share.
pub fn agent_identity_for(agent_id: &str) -> Identity {
    Identity {
        name: format!("{} · {}", agent_display_name(agent_id), local_identity().name),
        avatar: None,
        kind: "agent".to_string(),
        agent_kind: Some(agent_id.to_string()),
    }
}

/// Everything a share needs to know about the local agent behind `session_id`:
/// `(repo_root, agent_id)`.
///
/// `None` when the id is not a live agent PTY — sharing is still allowed, there
/// is simply no transcript to publish and nothing to inject into.
pub fn local_agent_for(app: &AppHandle, session_id: &str) -> Option<(String, String)> {
    let registry = app.try_state::<crate::cmd_agent_pty::AgentPtyRegistry>()?;
    registry
        .live_sessions_for_sync()
        .into_iter()
        .find(|s| s.session_id == session_id)
        .map(|s| (s.repo_root, s.agent_id))
}
