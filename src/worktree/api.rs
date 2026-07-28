//! JSON surface for the control plane, shared by MCP and anything else that
//! wants the data rather than the rendering.
//!
//! Kept separate from [`super::cmd`] because that module prints; this one
//! returns. The shapes here are what an agent reads, so they favour named
//! checkouts and plain counts over ids.

use serde_json::{json, Value};

use super::{overview, paths};
use crate::sentinel::SentinelManager;
use crate::session::SessionManager;

/// The whole board, plus a one-line summary an agent can act on without
/// walking the arrays.
pub fn plane(with_git_status: bool) -> Value {
    if paths::repo_root().is_none() {
        return json!({
            "error": "not inside a git repository",
            "worktrees": [],
        });
    }
    let plane = overview::assemble(with_git_status);
    let cross: usize = plane.contention.iter().filter(|c| c.cross_worktree).count();

    let mut v = serde_json::to_value(&plane).unwrap_or_else(|_| json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "summary".into(),
            json!({
                "checkouts": plane.worktrees.len(),
                "agents_live": plane.live_agents(),
                "agents_total": plane.total_agents(),
                "contended_symbols": plane.contention.len(),
                "cross_worktree_symbols": cross,
                "stranded_agents": plane.stranded.len(),
            }),
        );
    }
    v
}

/// Where this process is, and which directories its two planes resolve to.
pub fn whoami() -> Value {
    let Some(root) = paths::repo_root() else {
        return json!({ "error": "not inside a git repository" });
    };
    let name = paths::current_worktree();
    json!({
        "worktree": name,
        "token": SentinelManager::worktree_token(name.as_deref()),
        "is_main": name.is_none(),
        "branch": crate::live_events::current_branch(),
        "checkout": paths::checkout_root().unwrap_or_else(|| root.clone()),
        "repo_root": root,
        "shared_plane": paths::shared_aura_path(""),
        "private_plane": paths::private_aura_path(""),
    })
}

/// Identity to send under: the live agent session when there is one, else a
/// stable id derived from the checkout and pid so replies can be addressed
/// back to this process.
fn sender() -> (String, String) {
    match SessionManager::get_active_session() {
        Some(s) => (s.session_id, s.agent_id),
        None => {
            let here = SentinelManager::worktree_token(paths::current_worktree().as_deref());
            (format!("cli-{here}-{}", std::process::id()), "cli".to_string())
        }
    }
}

/// Message a checkout by name, a session by id, or everyone.
///
/// Reports how many sessions the message can actually reach — silence and
/// "delivered to nobody" look identical otherwise, and an agent that thinks it
/// has coordinated when it hasn't is worse than one that knows it hasn't.
pub fn say(message: &str, to_worktree: Option<&str>, to_session: Option<&str>) -> Value {
    if paths::repo_root().is_none() {
        return json!({ "error": "not inside a git repository" });
    }
    let (session_id, agent_id) = sender();
    SentinelManager::cleanup_old_messages();
    let msg =
        SentinelManager::send_message_to(&session_id, &agent_id, to_session, to_worktree, message);

    let recipients = match (to_worktree, to_session) {
        (Some(w), _) => SentinelManager::sessions_in_worktree(w).len(),
        (None, Some(_)) => 1,
        (None, None) => SentinelManager::load_all_claims()
            .iter()
            .filter(|c| c.session_id != session_id)
            .count(),
    };

    json!({
        "sent": msg,
        "from_worktree": SentinelManager::worktree_token(paths::current_worktree().as_deref()),
        "recipients": recipients,
        "note": if recipients == 0 {
            "no agent is currently claiming work there — the message is stored, but nobody is listening yet"
        } else {
            "delivered to the shared plane; peers see it on their next tool call"
        },
    })
}

/// What other checkouts have said to this one. Marks them read.
pub fn inbox(limit: usize) -> Value {
    if paths::repo_root().is_none() {
        return json!({ "error": "not inside a git repository" });
    }
    let (session_id, _) = sender();
    let rows: Vec<Value> = SentinelManager::read_messages(&session_id, limit)
        .into_iter()
        .map(|(m, unread)| {
            json!({
                "from_agent": m.from_agent,
                "from_worktree": SentinelManager::worktree_token(m.from_worktree.as_deref()),
                "to_worktree": m.to_worktree,
                "content": m.content,
                "timestamp": m.timestamp,
                "unread": unread,
            })
        })
        .collect();
    json!({ "messages": rows })
}
