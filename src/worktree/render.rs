//! Terminal rendering for the worktree control plane.
//!
//! Reads top-down as an answer to one question: *where is everyone, and are any
//! two of us about to collide?* Contention leads, because it is the thing
//! nobody could see before; the roster follows.

use colored::Colorize;

use super::overview::{AgentPresence, Contention, ControlPlane, WorktreeCard};
use crate::live_events;

/// Seconds → a short "how long ago".
fn age_secs(then: u64) -> String {
    let now = live_events::now_ms() / 1000;
    let secs = now.saturating_sub(then);
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3_600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3_600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

fn pad(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(width - len))
    }
}

/// Enough of a session id to tell two of them apart, without a line of uuid.
///
/// The *tail*, not the head: agent session ids are date-prefixed, so two from
/// the same day share their first ten characters and a leading slice would
/// print the same string twice.
fn short(session: &str) -> String {
    let n = session.chars().count();
    session.chars().skip(n.saturating_sub(8)).collect()
}

/// `3 agents` / `1 agent` — the plural is worth the four lines.
fn count(n: usize, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
}

/// Is there anything to say about this checkout?
///
/// A long-lived repo accumulates dozens of worktrees nobody has touched in
/// weeks, and most of them carry a stray uncommitted file. Printing all of
/// them buries the two that matter, so the bar is *someone is there* — an
/// agent, an unread message, or you. Uncommitted work with nobody attending
/// it is an abandoned tree, not an active one; it gets counted, and `--all`
/// still lists it.
fn is_interesting(card: &WorktreeCard) -> bool {
    card.is_here
        || !card.agents.is_empty()
        || card.inbox > 0
        || card.info.missing
        || card.info.locked
}

pub fn print(plane: &ControlPlane, all: bool) {
    println!();
    println!(
        "  {}   {}",
        "🌳 Worktrees".bold(),
        plane.root.display().to_string().dimmed()
    );
    println!(
        "  {}  ·  {}  ·  {}",
        count(plane.worktrees.len(), "checkout").dimmed(),
        format!("{} live", count(plane.live_agents(), "agent")).dimmed(),
        format!("trunk {}", plane.trunk).dimmed()
    );
    println!("  {}", "─".repeat(66).dimmed());

    print_contention(&plane.contention);

    let mut quiet = 0;
    let mut quiet_dirty = 0;
    for card in &plane.worktrees {
        if all || is_interesting(card) {
            print_card(card);
        } else {
            quiet += 1;
            if card.info.dirty_files > 0 {
                quiet_dirty += 1;
            }
        }
    }
    if quiet > 0 {
        // Say how many of the hidden ones hold uncommitted work — a count of
        // "quiet" checkouts would otherwise read as "nothing to see", and
        // abandoned changes are exactly the thing you want to be told about.
        let dirty = if quiet_dirty > 0 {
            format!(
                ", {} with uncommitted work",
                count(quiet_dirty, "checkout")
            )
        } else {
            String::new()
        };
        println!(
            "  {}  {}",
            format!("+{}", count(quiet, "unattended checkout")).dimmed(),
            format!("nobody working there{dirty} — `aura worktrees list --all` lists them").dimmed()
        );
        println!();
    }

    if !plane.stranded.is_empty() {
        println!();
        println!(
            "  {}  {}",
            "⚠ stranded".yellow().bold(),
            "claims held from a checkout git no longer lists".dimmed()
        );
        for a in &plane.stranded {
            println!(
                "      {}  {}  {}",
                a.worktree.as_deref().unwrap_or("main").yellow(),
                a.agent_id.magenta(),
                format!("{} held", count(a.claims.len(), "symbol")).dimmed()
            );
        }
        println!(
            "      {}",
            "release them with `aura sentinel release --session <id>`".dimmed()
        );
    }

    if !plane.messages.is_empty() {
        println!();
        println!("  {}", "recent messages".bold());
        for m in plane.messages.iter().take(5) {
            let to = match (&m.to_worktree, &m.to_session) {
                (Some(w), _) => format!("→ {w}"),
                (None, Some(s)) => format!("→ {}", &s[..s.len().min(12)]),
                _ => "→ all".to_string(),
            };
            println!(
                "      {}  {} {}  {}",
                pad(&age_secs(m.timestamp), 4).dimmed(),
                m.from_agent.magenta(),
                to.dimmed(),
                m.content.chars().take(60).collect::<String>()
            );
        }
    }

    println!();
}

fn print_contention(rows: &[Contention]) {
    if rows.is_empty() {
        println!(
            "  {}  {}",
            "✔".green(),
            "no two agents are holding the same symbol".dimmed()
        );
        println!();
        return;
    }

    println!(
        "  {}  {}",
        "⚡ contention".red().bold(),
        format!("({})", count(rows.len(), "symbol")).dimmed()
    );
    for c in rows {
        let scope = if c.cross_worktree {
            "across checkouts".red()
        } else {
            "same checkout".yellow()
        };
        println!(
            "      {}  {}  {}",
            crate::sentinel::claim_label(&c.function, &c.file).bold(),
            c.file.dimmed(),
            scope
        );
        // Two holders can share a checkout AND an agent name — the same CLI
        // run twice. Naming the session is the only way to tell them apart,
        // and it's what you need to release the stale one.
        let ambiguous = c.holders.iter().any(|h| {
            c.holders
                .iter()
                .filter(|o| o.worktree == h.worktree && o.agent == h.agent)
                .count()
                > 1
        });
        for h in &c.holders {
            let state = if h.alive { "" } else { " (process gone)" };
            let which = if ambiguous {
                format!(" {}", short(&h.session))
            } else {
                String::new()
            };
            println!(
                "          {} {}{}{}",
                h.worktree.cyan(),
                h.agent.magenta(),
                which.dimmed(),
                state.dimmed()
            );
        }
    }
    println!();
}

fn print_card(card: &WorktreeCard) {
    let head = if card.is_here {
        format!("▸ {}", card.token).green().bold()
    } else {
        format!("  {}", card.token).bold()
    };
    let branch = card
        .info
        .branch
        .clone()
        .unwrap_or_else(|| format!("detached @ {}", card.info.head));

    let mut facts: Vec<String> = Vec::new();
    if card.info.dirty_files > 0 {
        facts.push(format!("{} uncommitted", count(card.info.dirty_files, "file")));
    }
    if card.info.ahead > 0 || card.info.behind > 0 {
        facts.push(format!("↑{} ↓{}", card.info.ahead, card.info.behind));
    }
    if card.info.locked {
        facts.push("locked".into());
    }
    if card.info.missing {
        facts.push("directory missing".into());
    }
    if card.inbox > 0 {
        facts.push(format!("{} unread", card.inbox));
    }

    println!("  {}  {}", head, branch.cyan());
    if !facts.is_empty() {
        println!("      {}", facts.join("  ·  ").dimmed());
    }

    if card.agents.is_empty() {
        println!("      {}", "no agent working here".dimmed());
    }
    for a in &card.agents {
        print_agent(a);
    }
    for ev in &card.events {
        println!(
            "      {} {}  {}",
            ev.kind.glyph().dimmed(),
            ev.symbol
                .clone()
                .or_else(|| ev.file.clone())
                .unwrap_or_else(|| "—".into())
                .dimmed(),
            ev.actor.dimmed()
        );
    }
    println!();
}

fn print_agent(a: &AgentPresence) {
    let dot = if a.alive { "●".green() } else { "○".red() };
    let held = if a.claims.is_empty() {
        "holding nothing".to_string()
    } else {
        // Name the symbols outright — "someone holds something" is the answer
        // this whole feature exists to stop giving.
        let names: Vec<String> = a
            .claims
            .iter()
            .map(|c| crate::sentinel::claim_label(&c.function_name, &c.file_path))
            .take(4)
            .collect();
        let more = a.claims.len().saturating_sub(names.len());
        if more > 0 {
            format!("{} +{}", names.join(", "), more)
        } else {
            names.join(", ")
        }
    };
    println!(
        "      {} {}  {}  {}",
        dot,
        pad(&a.agent_id, 10).magenta(),
        held,
        format!("{} ago", age_secs(a.last_heartbeat)).dimmed()
    );
    for z in &a.zones {
        println!(
            "          {} {}  {}",
            "▣".dimmed(),
            z.patterns.join(", ").dimmed(),
            format!("{:?}", z.mode).to_lowercase().dimmed()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_pluralises() {
        assert_eq!(count(0, "agent"), "0 agents");
        assert_eq!(count(1, "agent"), "1 agent");
        assert_eq!(count(2, "checkout"), "2 checkouts");
    }

    #[test]
    fn pad_never_truncates() {
        assert_eq!(pad("ab", 4), "ab  ");
        assert_eq!(pad("abcdef", 4), "abcdef");
    }
}
