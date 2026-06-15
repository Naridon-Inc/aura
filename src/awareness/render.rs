//! Pretty terminal rendering for the `aura radar` feed.

use colored::Colorize;

use super::conflict::{Collision, Severity};
use super::model::AwarenessEvent;
use crate::live_events;

fn age(ts_ms: u64) -> String {
    let now = live_events::now_ms();
    let secs = now.saturating_sub(ts_ms) / 1000;
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

/// Pad a (plain) string to `width` display columns before any coloring, so ANSI
/// escapes don't break alignment.
fn pad(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(width - len))
    }
}

/// Render the awareness feed (already filtered + sorted newest-first).
/// `conflicts` drives the one-line "touching your work" banner; pass an empty
/// slice to omit it.
pub fn print_feed(rows: &[&AwarenessEvent], focus: Option<&str>, conflicts: &[Collision]) {
    let repo = live_events::repo_name();
    let branch = live_events::current_branch();

    println!();
    println!(
        "  {}   {} {}",
        "📡 Team Radar".bold(),
        repo.dimmed(),
        format!("@{branch}").dimmed()
    );
    if let Some(f) = focus {
        println!("  {} {}", "focus".dimmed(), f.yellow());
    }
    println!("  {}", "─".repeat(58).dimmed());

    if rows.is_empty() {
        println!(
            "  {}",
            "no awareness events yet — try `aura radar emit`".dimmed()
        );
        println!();
        return;
    }

    for ev in rows {
        let who = if ev.is_agent {
            ev.actor.magenta().bold()
        } else {
            ev.actor.cyan().bold()
        };
        let tag = if ev.is_agent {
            "agent".magenta()
        } else {
            "human".blue()
        };
        let age_s = pad(&age(ev.ts), 4);
        let kind_s = pad(&format!("{} {}", ev.kind.glyph(), ev.kind.as_str()), 12);

        println!("  {}  {}  {}  {}", age_s.dimmed(), kind_s, tag, who);

        match (&ev.symbol, &ev.file) {
            (Some(s), Some(f)) => println!("        {}  {}", s.bold(), f.dimmed()),
            (Some(s), None) => println!("        {}", s.bold()),
            (None, Some(f)) => println!("        {}", f.dimmed()),
            (None, None) => {}
        }
        if let Some(intent) = &ev.intent {
            println!("        {} {}", "↳".dimmed(), intent);
        }
        if let Some(impact) = &ev.impact {
            println!("        {} {}", "⚡".yellow(), impact.yellow());
        }
        if ev.sig.is_some() {
            if let Some(kid) = &ev.key_id {
                println!("        {} {}", "🔏".green(), kid.dimmed());
            }
        }
    }

    // One quiet line connecting the ambient feed to the reasoned layer — shown
    // only when something genuinely touches your work.
    if !conflicts.is_empty() {
        let n = conflicts.len();
        let noun = if n == 1 { "collision" } else { "collisions" };
        println!();
        println!(
            "  {} {} touching your work — {}",
            "⚠".yellow(),
            format!("{n} {noun}").yellow().bold(),
            "aura radar conflicts".dimmed()
        );
    }
    println!();
}

fn sev_dot(sev: Severity) -> colored::ColoredString {
    match sev {
        Severity::Direct => "●".red(),
        Severity::Likely => "●".yellow(),
        Severity::Possible => "●".blue(),
    }
}

/// Render the reasoned conflict view: only genuine/possible collisions against
/// your own current focus. Empty most of the time — that silence is the point.
pub fn print_conflicts(collisions: &[Collision]) {
    let repo = live_events::repo_name();
    let branch = live_events::current_branch();

    println!();
    println!(
        "  {}   {} {}",
        "🛰  Collisions".bold(),
        repo.dimmed(),
        format!("@{branch}").dimmed()
    );
    println!("  {}", "─".repeat(58).dimmed());

    if collisions.is_empty() {
        println!(
            "  {}  {}",
            "✓".green().bold(),
            "clear — no one is working where you are".green()
        );
        println!(
            "  {}",
            "(judged against your dirty files + announced symbols)".dimmed()
        );
        println!();
        return;
    }

    for c in collisions {
        let who = if c.peer_is_agent {
            c.peer.magenta().bold()
        } else {
            c.peer.cyan().bold()
        };
        let tag = if c.peer_is_agent {
            "agent".magenta()
        } else {
            "human".blue()
        };
        let sev = pad(c.severity.label(), 8);
        let age_s = pad(&age(live_events::now_ms().saturating_sub(c.age_ms)), 4);

        println!(
            "  {} {}  {}  {}  {}",
            sev_dot(c.severity),
            sev.bold(),
            age_s.dimmed(),
            tag,
            who
        );
        println!("        {} {}", "↳".dimmed(), c.reason);
        if let Some(intent) = &c.their_intent {
            println!("          {} {}", "why".dimmed(), intent.dimmed());
        }
        let branch_note = if c.same_branch {
            "same branch".yellow().to_string()
        } else {
            format!("on {}", c.their_branch).dimmed().to_string()
        };
        println!("          {}", branch_note);
    }
    println!();
}
