//! Handing work to an agent in another checkout.
//!
//! The control plane could already answer *who is where* and carry a message
//! between checkouts. What it could not do was give one of them a job: a board
//! task named an agent (`agent_assignee: "codex"`) but never a place, and a
//! repository routinely runs the same agent in half a dozen checkouts at once.
//! "Codex, in `auckland`, take AURA-42" was not expressible, so orchestration
//! across worktrees fell back to a human pasting a prompt into the right window.
//!
//! An assignment here is two writes that belong together:
//!
//! 1. the board row gets its address — `agent_assignee` + `worktree` — so the
//!    assignment is durable, visible in the desktop app, and survives every
//!    session involved being closed;
//! 2. a sentinel message goes to that same address, so the assignee finds out
//!    now rather than the next time somebody thinks to re-read the board.
//!
//! Doing only the first is a to-do list nobody reads; only the second is a
//! message that evaporates. [`assign`] does both, and reports how many live
//! sessions actually heard it, because "assigned to a checkout with nobody in
//! it" and "assigned and picked up" must not look the same.

use serde_json::{json, Value};

use super::{board_root, discover, paths};
use crate::board::{self, TaskPatch};
use crate::sentinel::{Address, SentinelManager};
use crate::session::SessionManager;

/// Identity this process assigns under — the live agent session when there is
/// one, else a stable id derived from the checkout and pid. Mirrors
/// `worktree::api::sender` so a reply can be addressed back either way.
fn sender() -> (String, String) {
    match SessionManager::get_active_session() {
        Some(s) => (s.session_id, s.agent_id),
        None => {
            let here = SentinelManager::worktree_token(paths::current_worktree().as_deref());
            (
                format!("cli-{here}-{}", std::process::id()),
                "cli".to_string(),
            )
        }
    }
}

/// Does this repository have a checkout by that name? `main` always counts.
///
/// Checked before writing, so a typo fails loudly instead of parking the task
/// against a tree that will never exist — the failure mode that makes a work
/// queue untrustworthy.
fn checkout_exists(name: &str) -> bool {
    if name.eq_ignore_ascii_case("main") {
        return true;
    }
    discover::list()
        .iter()
        .any(|w| w.name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(name)))
}

/// Give a task to an agent, in a checkout.
///
/// `task_ref` is anything the board resolves — a uuid, `AURA-42`, or a bare
/// `42`. Either half of the address may be omitted: agent alone means "any
/// Codex, wherever"; checkout alone means "whoever is working in auckland".
pub fn assign(task_ref: &str, agent: Option<&str>, worktree: Option<&str>) -> Value {
    let root = board_root::board_dir();
    if paths::repo_root().is_none() {
        return json!({ "error": "not inside a git repository" });
    }
    if agent.is_none() && worktree.is_none() {
        return json!({
            "error": "nothing to assign to — name an agent (`--to codex`), a checkout (`--in auckland`), or both",
        });
    }
    if let Some(w) = worktree {
        if !checkout_exists(w) {
            let known: Vec<String> = discover::checkout_names();
            return json!({
                "error": format!("no checkout named '{w}' in this repository"),
                "known_checkouts": known,
            });
        }
    }

    let patch = TaskPatch {
        agent_assignee: agent.map(|a| Some(a.to_string())),
        worktree: worktree.map(|w| Some(w.to_string())),
        ..Default::default()
    };
    let task = match board::update_task(&root, task_ref, patch) {
        Ok(t) => t,
        Err(e) => return json!({ "error": e }),
    };

    let addr = Address {
        session: None,
        worktree: worktree.map(str::to_string),
        agent: agent.map(str::to_string),
    };
    let (session_id, agent_id) = sender();
    let title = task.get("title").and_then(Value::as_str).unwrap_or("");
    let handle = task
        .get("sequence_id")
        .and_then(Value::as_u64)
        .map(|n| format!("AURA-{n}"))
        .unwrap_or_else(|| task_ref.to_string());
    let note = format!(
        "assigned {handle} to you: {title} — read it with `aura worktrees mine`",
    );
    SentinelManager::cleanup_old_messages();
    SentinelManager::send_addressed(&session_id, &agent_id, &addr, &note);
    let reach = SentinelManager::reach_of(&addr, &session_id);

    json!({
        "assigned": handle,
        "title": title,
        "to": addr.describe(),
        "agent": agent,
        "worktree": worktree,
        "from_worktree": SentinelManager::worktree_token(paths::current_worktree().as_deref()),
        "listening_now": reach,
        "note": if reach == 0 {
            "the task is on the board and will be waiting, but no agent is live there right now"
        } else {
            "assigned, and the agent has been told"
        },
    })
}

/// The board rows addressed to *this* process: this checkout, and either this
/// agent or no agent in particular.
///
/// This is the read half of the feature. Without it an assignment is a write
/// nobody has a way to collect — an agent starting up in `auckland` needs one
/// question answered, "what is mine", not a 141-row board to filter by hand.
pub fn mine(agent: Option<&str>, limit: usize) -> Value {
    if paths::repo_root().is_none() {
        return json!({ "error": "not inside a git repository" });
    }
    let root = board_root::board_dir();
    let here = SentinelManager::worktree_token(paths::current_worktree().as_deref());
    let me = agent.map(str::to_string).or_else(|| {
        SessionManager::get_active_session().map(|s| s.agent_id)
    });

    let rows = match board::list_tasks(&root, None, 0) {
        Ok(r) => r,
        Err(e) => return json!({ "error": e }),
    };
    let mut out: Vec<Value> = rows
        .into_iter()
        .filter(|t| {
            // Addressed to this checkout. A row with no checkout is *not*
            // mine — it is unrouted work on the shared board, and claiming it
            // implicitly is how two agents end up doing the same task.
            let wt_ok = t
                .get("worktree")
                .and_then(Value::as_str)
                .is_some_and(|w| w.eq_ignore_ascii_case(&here));
            if !wt_ok {
                return false;
            }
            // Addressed to this agent, or to the checkout at large.
            match t.get("agent_assignee").and_then(Value::as_str) {
                None => true,
                Some(a) => me.as_deref().is_some_and(|m| {
                    m.eq_ignore_ascii_case(a)
                        || m.split(['-', '_', ':']).next() == Some(a)
                }),
            }
        })
        .filter(|t| {
            // Finished work is not a queue.
            t.get("status").and_then(Value::as_str) != Some("done")
        })
        .collect();
    if limit > 0 && out.len() > limit {
        out.truncate(limit);
    }

    json!({
        "worktree": here,
        "agent": me,
        "count": out.len(),
        "tasks": out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_needs_at_least_one_half() {
        // Neither an agent nor a checkout is not an assignment, it is a no-op
        // that would silently look like success.
        let v = assign("AURA-1", None, None);
        assert!(v.get("error").is_some());
    }

    /// This and `main_is_always_addressable` read the checkout list of whatever
    /// repo the process is sitting in, so they have to hold the same lock the
    /// tests that *move* the process hold. Without it they pass or fail on
    /// scheduling luck: a `CwdGuard` in another test can land between resolving
    /// the repo and reading its worktrees, and the assertion then describes a
    /// repo nobody asked about.
    #[test]
    fn a_typo_in_the_checkout_name_is_refused_with_the_real_list() {
        let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let v = assign("AURA-1", Some("codex"), Some("no-such-tree-xyz"));
        assert!(
            v.get("error")
                .and_then(Value::as_str)
                .is_some_and(|e| e.contains("no checkout named")),
            "expected a named-checkout error, got {v}"
        );
        assert!(v.get("known_checkouts").is_some());
    }

    #[test]
    fn main_is_always_addressable() {
        let _lock = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // The main checkout has no worktree name of its own, so it would fail
        // a naive "is it in `git worktree list`" test.
        assert!(checkout_exists("main"));
        assert!(checkout_exists("MAIN"));
    }
}
