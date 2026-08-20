//! `aura worktrees` — the control-plane surface.
//!
//! Four verbs, each answering a question an agent or a human actually asks:
//! *where is everyone* (`list`), *where am I* (`whoami`), *tell that checkout
//! something* (`say`), *did anyone tell me something* (`inbox`).

use colored::Colorize;

use super::{assign, overview, paths, render};
use crate::sentinel::{Address, SentinelManager};
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

/// Send a message across checkouts.
///
/// `to` is the addressing shorthand: a checkout (`auckland`, `main`), an agent
/// (`codex`), or one agent in one checkout (`codex@auckland`). Omitted, it
/// broadcasts.
pub fn run_say(message: &str, to: Option<&str>, json: bool) {
    if paths::repo_root().is_none() {
        not_a_repo();
        return;
    }
    let (session_id, agent_id) = sender();
    let addr = to.map(Address::parse).unwrap_or_else(Address::broadcast);
    let msg = SentinelManager::send_addressed(&session_id, &agent_id, &addr, message);

    // Reaching nobody looks identical to reaching everybody unless we say so.
    let reach = SentinelManager::reach_of(&addr, &session_id);

    if json {
        let v = serde_json::json!({
            "sent": msg,
            "to": addr.describe(),
            "recipients": reach,
        });
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return;
    }

    let target = addr.describe();
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
///
/// `agent` lets a process collect mail addressed to it by name before it has
/// claimed anything — the case that matters at startup, which is exactly when
/// an agent wants to know what it has been given.
pub fn run_inbox(limit: usize, agent: Option<&str>, json: bool) {
    if paths::repo_root().is_none() {
        not_a_repo();
        return;
    }
    let (session_id, my_agent) = sender();
    let reading_as = agent.or(if my_agent == "cli" { None } else { Some(&my_agent) });
    let messages = SentinelManager::read_messages_as(&session_id, reading_as, limit);

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
        // Mail addressed to an agent by name says so, otherwise "codex, stop
        // touching auth.rs" reads as if it were meant for everyone.
        let to = match (&m.to_agent, &m.to_worktree) {
            (Some(a), Some(w)) => format!(" → {a}@{w}"),
            (Some(a), None) => format!(" → {a}"),
            _ => String::new(),
        };
        println!(
            "  {} {} {}{}  {}",
            marker,
            m.from_agent.magenta(),
            format!("in {from}").dimmed(),
            to.cyan(),
            m.content
        );
    }
    println!();
}

/// Hand a board task to an agent in a checkout.
pub fn run_assign(task: &str, to: Option<&str>, in_worktree: Option<&str>, json: bool) {
    let v = assign::assign(task, to, in_worktree);
    if json {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return;
    }
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        eprintln!("  {}  {}", "✗".red(), err);
        if let Some(known) = v.get("known_checkouts").and_then(|k| k.as_array()) {
            let names: Vec<String> = known
                .iter()
                .filter_map(|n| n.as_str().map(str::to_string))
                .collect();
            eprintln!("  {}  {}", "  ".dimmed(), names.join(", ").dimmed());
        }
        return;
    }

    let handle = v.get("assigned").and_then(|h| h.as_str()).unwrap_or("");
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
    let target = v.get("to").and_then(|t| t.as_str()).unwrap_or("");
    let listening = v.get("listening_now").and_then(|n| n.as_u64()).unwrap_or(0);

    println!();
    println!(
        "  {}  {} {}",
        "assigned".green().bold(),
        handle.cyan(),
        format!("→ {target}").dimmed()
    );
    println!("  {}  {}", "        ".dimmed(), title);
    if listening == 0 {
        println!(
            "  {}  {}",
            "waiting ".yellow(),
            "on the board — nobody is live there yet".dimmed()
        );
    } else {
        println!(
            "  {}  {}",
            "told    ".dimmed(),
            format!("{listening} live session(s)").dimmed()
        );
    }
    println!();
}

/// What has been assigned to this checkout, for this agent.
pub fn run_mine(agent: Option<&str>, limit: usize, json: bool) {
    let v = assign::mine(agent, limit);
    if json {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return;
    }
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        eprintln!("  {}  {}", "✗".red(), err);
        return;
    }

    let here = v.get("worktree").and_then(|w| w.as_str()).unwrap_or("main");
    let empty = vec![];
    let tasks = v.get("tasks").and_then(|t| t.as_array()).unwrap_or(&empty);

    println!();
    if tasks.is_empty() {
        println!(
            "  {}",
            format!("nothing assigned to {here}").dimmed()
        );
        println!();
        return;
    }
    for t in tasks {
        let handle = t.get("ref").and_then(|r| r.as_str()).unwrap_or("");
        let title = t.get("title").and_then(|x| x.as_str()).unwrap_or("");
        let status = t.get("status").and_then(|s| s.as_str()).unwrap_or("todo");
        let who = t.get("agent_assignee").and_then(|a| a.as_str());
        println!(
            "  {} {}  {}  {}",
            "●".green(),
            handle.cyan(),
            title,
            match who {
                Some(a) => format!("[{status} · {a}]").dimmed(),
                None => format!("[{status}]").dimmed(),
            }
        );
    }
    println!();
}
