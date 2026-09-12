//! Three renderings of one assembly: markdown to send, terminal to read, JSON
//! to build on.
//!
//! Markdown is the point. A dispatch exists to be pasted into a standup, a
//! ticket, a mail, a Slack post — places that render markdown and do not
//! render ANSI colour. So the file form carries no escape codes, no box
//! drawing and no colour, and it stays readable when whatever it is pasted
//! into renders nothing at all.
//!
//! All three read the same [`Dispatch`], so a number shown in one is the
//! number shown in the others. What differs is only how much is shown.

use colored::*;

use super::{Change, Dispatch, RepoReport};

/// How many symbol names are listed before the rest become a count.
const NAMES: usize = 6;
/// How long a quoted prompt or intent runs before it is cut.
const QUOTE: usize = 220;

fn day(at: u64) -> String {
    // Civil date from a unix second — the inverse of `days_from_civil`, which
    // keeps this crate free of a calendar dependency for a date in a heading.
    let days = (at / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn clock(at: u64) -> String {
    let s = at % 86_400;
    format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)
}

/// One line of text, cut on a word boundary rather than mid-word.
fn short(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let cut: String = one_line.chars().take(max).collect();
    // Trim back to the last space only when the cut lands mid-word. Landing
    // exactly on a word boundary is already clean, and trimming there would
    // throw away a whole word for nothing.
    let clean = one_line.chars().nth(max) == Some(' ');
    let cut = if clean {
        cut
    } else {
        cut.rsplit_once(' ').map(|(head, _)| head.to_string()).unwrap_or(cut)
    };
    format!("{cut}…")
}

/// `+parse ~render −dial` — what the commit did, in names.
fn symbol_line(c: &Change) -> Option<String> {
    if c.delta.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for (mark, names) in
        [("+", &c.delta.added), ("~", &c.delta.changed), ("−", &c.delta.removed)]
    {
        if names.is_empty() {
            continue;
        }
        let shown: Vec<String> = names.iter().take(NAMES).map(|n| format!("{mark}{n}")).collect();
        let rest = names.len().saturating_sub(NAMES);
        let mut piece = shown.join(" ");
        if rest > 0 {
            piece.push_str(&format!(" +{rest} more"));
        }
        parts.push(piece);
    }
    Some(parts.join("  "))
}

fn window_line(d: &Dispatch) -> String {
    format!("{} → {} ({})", day(d.since), day(d.until), d.window)
}

// ── Markdown: the form that leaves the tool ────────────────────────────────

pub fn markdown(d: &Dispatch) -> String {
    let mut s = String::new();
    s.push_str("# Dispatch\n\n");
    s.push_str(&format!("**{}**\n\n", window_line(d)));

    let repos: Vec<&RepoReport> = d.repos.iter().collect();
    if repos.len() > 1 {
        s.push_str("| Repo | Branch | Commits | Files | Symbols | Unexplained |\n");
        s.push_str("|---|---|--:|--:|--:|--:|\n");
        for r in &repos {
            s.push_str(&format!(
                "| {} | `{}` | {} | {} | {} | {} |\n",
                r.name,
                r.branch,
                r.changes.len(),
                r.files_touched(),
                r.symbols_touched(),
                r.unexplained()
            ));
        }
        s.push('\n');
    }

    for r in repos {
        s.push_str(&format!("## {} · `{}`\n\n", r.name, r.branch));
        if let Some(problem) = &r.problem {
            s.push_str(&format!("> Could not read this repository: {problem}\n\n"));
            continue;
        }
        if r.changes.is_empty() {
            s.push_str("> Nothing landed on this branch in the window.\n\n");
            continue;
        }

        s.push_str(&format!(
            "{} commit(s) · {} file(s) · {} symbol change(s)",
            r.changes.len(),
            r.files_touched(),
            r.symbols_touched()
        ));
        if r.omitted > 0 {
            s.push_str(&format!(" · {} older commit(s) not detailed", r.omitted));
        }
        s.push_str("\n\n");

        if !r.people.is_empty() {
            let mut who: Vec<(&String, &usize)> = r.people.iter().collect();
            who.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            let line: Vec<String> = who.iter().map(|(n, c)| format!("{n} ({c})")).collect();
            s.push_str(&format!("**Who:** {}\n\n", line.join(", ")));
        }
        if !r.agents.is_empty() {
            let mut who: Vec<(&String, &usize)> = r.agents.iter().collect();
            who.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            let line: Vec<String> = who.iter().map(|(n, c)| format!("{n} ({c})")).collect();
            s.push_str(&format!("**Agents:** {}\n\n", line.join(", ")));
        }

        let goals = r.goals();
        if !goals.is_empty() {
            s.push_str("### Goals proven in this window\n\n");
            for g in goals {
                let verdict = g
                    .runs
                    .first()
                    .map(|run| format!("{:?}", run.verdict))
                    .unwrap_or_else(|| "Unknown".to_string());
                s.push_str(&format!("- **{verdict}** — {}\n", short(&g.text, QUOTE)));
            }
            s.push('\n');
        }

        s.push_str("### What landed\n\n");
        let mut last_day = String::new();
        for c in &r.changes {
            let today = day(c.at);
            if today != last_day {
                s.push_str(&format!("**{today}**\n\n"));
                last_day = today;
            }
            s.push_str(&format!("- `{}` {} — *{}*\n", c.short, short(&c.subject, 120), c.author));
            if let Some(line) = symbol_line(c) {
                s.push_str(&format!("  - Changed: {line}\n"));
            }
            if let Some(i) = &c.intent {
                s.push_str(&format!("  - Agent said: {}\n", short(&i.intent, QUOTE)));
            }
            if let Some(p) = &c.prompt {
                s.push_str(&format!("  - Asked for: {}\n", short(&p.text, QUOTE)));
            }
            for g in &c.goals {
                s.push_str(&format!("  - Proves: {}\n", short(&g.text, QUOTE)));
            }
        }
        s.push('\n');

        if r.unexplained() > 0 {
            s.push_str(&format!(
                "> {} of {} commit(s) carry no stated reason — nobody logged an intent and no agent session covers them.\n\n",
                r.unexplained(),
                r.changes.len()
            ));
        }
    }
    s
}

// ── Terminal: the form you read on the way past ────────────────────────────

pub fn terminal(d: &Dispatch) {
    println!("{}  {}", "Dispatch".bold(), window_line(d).dimmed());
    for r in &d.repos {
        println!();
        println!("{} {}", r.name.bold(), format!("· {}", r.branch).dimmed());
        if let Some(problem) = &r.problem {
            println!("  {} {}", "✗".red(), problem);
            continue;
        }
        if r.changes.is_empty() {
            println!("  {}", "nothing landed on this branch in the window".dimmed());
            continue;
        }
        println!(
            "  {}",
            format!(
                "{} commit(s) · {} file(s) · {} symbol change(s)",
                r.changes.len(),
                r.files_touched(),
                r.symbols_touched()
            )
            .dimmed()
        );

        for g in r.goals() {
            let verdict = g.runs.first().map(|run| format!("{:?}", run.verdict));
            println!("  {} {}", "✓".green(), short(&g.text, 100));
            if let Some(v) = verdict {
                println!("      {}", v.dimmed());
            }
        }

        println!();
        for c in &r.changes {
            println!(
                "  {} {}  {}",
                c.short.yellow(),
                short(&c.subject, 90),
                format!("{} {}", day(c.at), clock(c.at)).dimmed()
            );
            if let Some(line) = symbol_line(c) {
                println!("      {line}");
            }
            if let Some(i) = &c.intent {
                println!("      {} {}", "why:".dimmed(), short(&i.intent, 140));
            }
            if let Some(p) = &c.prompt {
                println!("      {} {}", "ask:".dimmed(), short(&p.text, 140));
            }
        }

        if r.omitted > 0 {
            println!("  {}", format!("{} older commit(s) not detailed", r.omitted).dimmed());
        }
        if r.unexplained() > 0 {
            println!(
                "  {}",
                format!("{} commit(s) with no stated reason", r.unexplained()).yellow()
            );
        }
    }
    println!();
    println!("  {}", "--markdown, or --out FILE, for the shareable form".dimmed());
}

// ── JSON: the form other things build on ───────────────────────────────────

fn change_json(c: &Change) -> serde_json::Value {
    let mut v = serde_json::json!({
        "sha": c.sha,
        "short": c.short,
        "author": c.author,
        "email": c.email,
        "at": c.at,
        "subject": c.subject,
        "files": c.delta.files,
        "symbols": {
            "added": c.delta.added,
            "changed": c.delta.changed,
            "removed": c.delta.removed,
            "files_not_parsed": c.delta.truncated,
        },
    });
    if let Some(i) = &c.intent {
        v["intent"] = serde_json::json!({
            "text": i.intent,
            "agent_id": i.agent_id,
            "at": i.timestamp,
            "basis": c.intent_basis,
        });
    }
    if let Some(p) = &c.prompt {
        v["prompt"] = serde_json::json!({
            "text": p.text,
            "at": p.at,
            "basis": c.prompt_basis,
        });
    }
    if !c.goals.is_empty() {
        v["goals"] = serde_json::json!(c
            .goals
            .iter()
            .map(|g| serde_json::json!({
                "id": g.id,
                "text": g.text,
                "verdict": g.runs.first().map(|r| format!("{:?}", r.verdict)),
            }))
            .collect::<Vec<_>>());
    }
    v
}

pub fn to_json(d: &Dispatch) -> serde_json::Value {
    serde_json::json!({
        "since": d.since,
        "until": d.until,
        "window": d.window,
        "commits": d.commits(),
        "repos": d.repos.iter().map(|r| {
            let mut v = serde_json::json!({
                "name": r.name,
                "root": r.root.to_string_lossy(),
                "branch": r.branch,
                "commits": r.changes.len(),
                "commits_not_detailed": r.omitted,
                "files_touched": r.files_touched(),
                "symbols_touched": r.symbols_touched(),
                "unexplained": r.unexplained(),
                "people": r.people,
                "agents": r.agents,
                "changes": r.changes.iter().map(change_json).collect::<Vec<_>>(),
            });
            if let Some(p) = &r.problem {
                v["problem"] = serde_json::json!(p);
            }
            v
        }).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unix_second_becomes_the_civil_date_it_falls_on() {
        assert_eq!(day(0), "1970-01-01");
        // 2026-08-24T00:00:00Z
        assert_eq!(day(1_787_529_600), "2026-08-24");
        assert_eq!(day(1_787_529_600 + 3 * 3600 + 25 * 60), "2026-08-24");
        assert_eq!(clock(1_787_529_600 + 3 * 3600 + 25 * 60), "03:25");
    }

    #[test]
    fn a_long_line_is_cut_on_a_word_and_marked() {
        // The cut lands exactly on a word boundary — keep the whole word.
        assert_eq!(short("the quick brown fox jumps over the lazy dog", 19), "the quick brown fox…");
        // Mid-word, so back up rather than print half a word.
        assert_eq!(short("the quick brown fox jumps", 17), "the quick brown…");
        assert_eq!(short("short enough", 40), "short enough");
        // Newlines in a prompt must not break the list item it lands in.
        assert_eq!(short("two\nlines", 40), "two lines");
    }

    #[test]
    fn a_symbol_line_names_a_few_and_counts_the_rest() {
        let mut c = super::super::tests_support::change();
        c.delta.added = (0..9).map(|i| format!("f{i}")).collect();
        c.delta.removed = vec!["gone".into()];
        let line = symbol_line(&c).unwrap();
        assert!(line.contains("+f0") && line.contains("+f5"), "{line}");
        assert!(line.contains("+3 more"), "the rest are counted: {line}");
        assert!(line.contains("−gone"), "{line}");
        assert!(!line.contains("+f6"), "past the cap: {line}");
    }

    #[test]
    fn a_repo_that_could_not_be_read_says_so_in_the_document() {
        // Silence here would read as "nothing happened in that repo", which is
        // a different and much worse claim than "I could not look".
        let d = super::super::tests_support::dispatch_with_problem();
        let md = markdown(&d);
        assert!(md.contains("Could not read this repository"), "{md}");
        assert!(md.contains("no such branch"), "{md}");
        let v = to_json(&d);
        assert_eq!(v["repos"][0]["problem"], "no such branch");
    }

    #[test]
    fn the_markdown_carries_the_ask_beside_the_intent() {
        // The pair is the point of the document: what the agent said it was
        // doing, next to what the person actually asked for.
        let d = super::super::tests_support::dispatch_with_change();
        let md = markdown(&d);
        assert!(md.contains("Agent said: tighten the parser"), "{md}");
        assert!(md.contains("Asked for: make it stricter"), "{md}");
        assert!(!md.contains("\u{1b}["), "markdown must carry no escape codes");
    }
}
