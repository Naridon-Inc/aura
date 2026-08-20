//! JSON surface for the control plane, shared by MCP and anything else that
//! wants the data rather than the rendering.
//!
//! Kept separate from [`super::cmd`] because that module prints; this one
//! returns. The shapes here are what an agent reads, so they favour named
//! checkouts and plain counts over ids.

use serde_json::{json, Value};

use super::{overview, paths};
use crate::sentinel::{Address, SentinelManager};
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

/// Message an agent, a checkout, a session by id, or everyone.
///
/// `to_worktree` accepts the addressing shorthand as well as a bare checkout
/// name, so `codex@auckland` works wherever a checkout name does — an agent
/// that has read one form should not have to learn a second.
///
/// Reports how many sessions the message can actually reach — silence and
/// "delivered to nobody" look identical otherwise, and an agent that thinks it
/// has coordinated when it hasn't is worse than one that knows it hasn't.
pub fn say(
    message: &str,
    to_worktree: Option<&str>,
    to_agent: Option<&str>,
    to_session: Option<&str>,
) -> Value {
    if paths::repo_root().is_none() {
        return json!({ "error": "not inside a git repository" });
    }
    let (session_id, agent_id) = sender();

    let mut addr = to_worktree.map(Address::parse).unwrap_or_default();
    // An explicit `to_agent` wins over one parsed out of `to`, and a session id
    // narrows further still.
    if to_agent.is_some() {
        addr.agent = to_agent.map(str::to_string);
    }
    if to_session.is_some() {
        addr.session = to_session.map(str::to_string);
    }

    SentinelManager::cleanup_old_messages();
    let msg = SentinelManager::send_addressed(&session_id, &agent_id, &addr, message);
    let recipients = SentinelManager::reach_of(&addr, &session_id);

    json!({
        "sent": msg,
        "to": addr.describe(),
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
///
/// `agent` lets a caller collect mail addressed to it by name before its first
/// claim lands — the startup case, which is exactly when an agent wants to
/// know what it has been handed.
pub fn inbox(limit: usize, agent: Option<&str>) -> Value {
    if paths::repo_root().is_none() {
        return json!({ "error": "not inside a git repository" });
    }
    let (session_id, my_agent) = sender();
    let reading_as = agent.or(if my_agent == "cli" { None } else { Some(&my_agent) });
    let rows: Vec<Value> = SentinelManager::read_messages_as(&session_id, reading_as, limit)
        .into_iter()
        .map(|(m, unread)| {
            json!({
                "from_agent": m.from_agent,
                "from_worktree": SentinelManager::worktree_token(m.from_worktree.as_deref()),
                "to_worktree": m.to_worktree,
                "to_agent": m.to_agent,
                "content": m.content,
                "timestamp": m.timestamp,
                "unread": unread,
            })
        })
        .collect();
    json!({ "messages": rows })
}
