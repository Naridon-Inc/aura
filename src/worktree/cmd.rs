//! `aura worktrees` — the control-plane surface.
//!
//! Four verbs, each answering a question an agent or a human actually asks:
//! *where is everyone* (`list`), *where am I* (`whoami`), *tell that checkout
//! something* (`say`), *did anyone tell me something* (`inbox`).

use colored::Colorize;

use super::{overview, paths, render};
use crate::sentinel::SentinelManager;
use crate::session::SessionManager;

/// Identity this process sends messages under. A live agent session is the
/// real answer; without one (a human typing into a shell) we still need a
/// stable id so replies can be addressed back, so it is derived from the
/// checkout and the pid.
fn sender() -> (String, String) {
    match SessionManager::get_active_session() {
        Some(s) => (s.session_id, s.agent_id),
        None => {
            let here = SentinelManager::worktree_token(paths::current_worktree().as_deref());
            (format!("cli-{here}-{}", std::process::id()), "cli".to_string())
        }
    }
}

fn not_a_repo() {
    eprintln!(
        "  {}  {}",
        "✗".red(),
        "not inside a git repository — worktrees are a repo-level view"
    );
}

/// The board: every checkout, who is in it, and what is contended.
///
/// `all` keeps the quiet checkouts in the printed view. JSON always carries
/// every one of them — a machine reader filters for itself, and silently
/// dropping rows from an API is how a caller ends up drawing a wrong picture.
pub fn run_list(json: bool, no_git_status: bool, all: bool) {
    if paths::repo_root().is_none() {
        not_a_repo();
        return;
    }
    let plane = overview::assemble(!no_git_status);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&plane).unwrap_or_else(|_| "{}".into())
        );
        return;
    }
    render::print(&plane, all);
}

/// Where am I, and where does my state land? The second half is the debugging
/// answer: it shows the shared plane resolving to the repository root and the
/// private plane to this checkout, which is the whole design in two lines.
pub fn run_whoami(json: bool) {
    let Some(root) = paths::repo_root() else {
        not_a_repo();
        return;
    };
    let checkout = paths::checkout_root().unwrap_or_else(|| root.clone());
    let name = paths::current_worktree();
    let token = SentinelManager::worktree_token(name.as_deref());
    let branch = crate::live_events::current_branch();

    if json {
        let v = serde_json::json!({
            "worktree": name,
            "token": token,
            "is_main": name.is_none(),
            "branch": branch,
            "checkout": checkout,
            "repo_root": root,
            "shared_plane": paths::shared_aura_path(""),
            "private_plane": paths::private_aura_path(""),
        });
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return;
    }

    println!();
    println!("  {}  {}", "you are in".dimmed(), token.green().bold());
    println!("  {}  {}", "on branch  ".dimmed(), branch.cyan());
    println!("  {}  {}", "checkout   ".dimmed(), checkout.display());
    println!("  {}  {}", "repository ".dimmed(), root.display());
    println!();
    println!(
        "  {}  {}",
        "shared with every checkout ".dimmed(),
        paths::shared_aura_path("")
    );
    println!(
        "  {}  {}",
        "private to this checkout   ".dimmed(),
        paths::private_aura_path("")
    );
    println!();
}

/// Send a message across checkouts. `to` names a checkout (`main`, or a
/// worktree name); omitted, it broadcasts.
pub fn run_say(message: &str, to: Option<&str>, json: bool) {
    if paths::repo_root().is_none() {
        not_a_repo();
        return;
    }
    let (session_id, agent_id) = sender();
    let msg = SentinelManager::send_message_to(&session_id, &agent_id, None, to, message);

    // Reaching nobody looks identical to reaching everybody unless we say so.
    let reach = match to {
        Some(w) => SentinelManager::sessions_in_worktree(w).len(),
        None => SentinelManager::load_all_claims().len(),
    };

    if json {
        let v = serde_json::json!({ "sent": msg, "recipients": reach });
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return;
    }

    let target = to.unwrap_or("everyone");
    if reach == 0 {
        println!(
            "  {}  {}",
            "sent".yellow(),
            format!("→ {target}, but no agent is currently claiming work there").dimmed()
        );
    } else {
        println!(
            "  {}  {}",
            "sent".green(),
            format!("→ {target} ({reach} listening)").dimmed()
        );
    }
}

/// Read what other checkouts have said to this one.
pub fn run_inbox(limit: usize, json: bool) {
    if paths::repo_root().is_none() {
        not_a_repo();
        return;
    }
    let (session_id, _) = sender();
    let messages = SentinelManager::read_messages(&session_id, limit);

    if json {
        let rows: Vec<serde_json::Value> = messages
            .iter()
            .map(|(m, fresh)| serde_json::json!({ "message": m, "unread": fresh }))
            .collect();
        println!("{}", serde_json::to_string_pretty(&rows).unwrap_or_default());
        return;
    }

    println!();
    if messages.is_empty() {
        println!("  {}", "nothing addressed to this checkout".dimmed());
        println!();
        return;
    }
    for (m, fresh) in &messages {
        let marker = if *fresh { "●".green() } else { "○".dimmed() };
        let from = m.from_worktree.as_deref().unwrap_or("main");
        println!(
            "  {} {} {}  {}",
            marker,
            m.from_agent.magenta(),
            format!("in {from}").dimmed(),
            m.content
        );
    }
    println!();
}
