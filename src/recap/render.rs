//! Four renderings of one recap: the terminal, a pipe, markdown, JSON.
//!
//! The terminal and the pipe share a single layout function and differ only in
//! ink — colour on or off, "2h ago" or a date. That is deliberate: two
//! separately-written renderings drift, and the first thing to drift is a
//! number, which is the one thing that must not. `--static` is the same recap,
//! spelled so it survives a pipe, a cron job and a Slack post: no escape
//! codes, no box drawing, and no relative time, because a recap read tomorrow
//! should not claim something happened "2h ago".

use colored::*;

use super::{Overlap, PersonRecap, Recap, View};

/// How the text is inked. Layout is shared; only these two differ.
#[derive(Clone, Copy)]
struct Ink {
    colour: bool,
    /// "2h ago" rather than a date. False for anything that outlives the
    /// moment it was printed.
    relative: bool,
}

impl Ink {
    fn b(self, s: &str) -> String {
        if self.colour {
            s.bold().to_string()
        } else {
            s.to_string()
        }
    }

    fn d(self, s: &str) -> String {
        if self.colour {
            s.dimmed().to_string()
        } else {
            s.to_string()
        }
    }

    fn warm(self, s: &str) -> String {
        if self.colour {
            s.yellow().to_string()
        } else {
            s.to_string()
        }
    }
}

/// Civil date from a unix second, so a date in a heading costs no dependency.
fn day(at: u64) -> String {
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

/// A span, said the way somebody would say it out loud.
pub fn span(secs: u64) -> String {
    if secs < 60 {
        return "under a minute".to_string();
    }
    if secs < 3600 {
        return format!("{}m", secs / 60);
    }
    if secs < 86_400 {
        let (h, m) = (secs / 3600, (secs % 3600) / 60);
        return if m == 0 { format!("{h}h") } else { format!("{h}h {m}m") };
    }
    let (d, h) = (secs / 86_400, (secs % 86_400) / 3600);
    if h == 0 {
        format!("{d}d")
    } else {
        format!("{d}d {h}h")
    }
}

/// How long ago, from a fixed `now` so the same recap renders the same twice.
fn ago(at: u64, now: u64) -> String {
    if at >= now {
        return "just now".to_string();
    }
    format!("{} ago", span(now - at))
}

fn pct(share: f64) -> String {
    format!("{}%", (share * 100.0).round() as i64)
}

/// One line of text, cut on a word boundary rather than mid-word.
fn short(text: &str, max: usize) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        return one;
    }
    let cut: String = one.chars().take(max).collect();
    let clean = one.chars().nth(max) == Some(' ');
    let cut = if clean {
        cut
    } else {
        cut.rsplit_once(' ').map(|(head, _)| head.to_string()).unwrap_or(cut)
    };
    format!("{cut}…")
}

/// `Claude 19 · Codex 4`, busiest first.
fn agents_of(p: &PersonRecap) -> String {
    let mut pairs: Vec<(&String, &usize)> = p.agents.iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    if pairs.is_empty() {
        return "—".to_string();
    }
    pairs.iter().map(|(n, c)| format!("{n} {c}")).collect::<Vec<_>>().join(" · ")
}

/// The rework cell: `7 (31%)`, or a dash when nothing was touched.
fn came_back(p: &PersonRecap) -> String {
    match p.rework.rate() {
        Some(rate) => format!("{} ({})", p.rework.returned, pct(rate)),
        None => "—".to_string(),
    }
}

/// The median cell, with the coverage said out loud when it is partial.
fn to_land(p: &PersonRecap, verbose: bool) -> String {
    let Some(median) = p.land.median else {
        return "no ask found".to_string();
    };
    if !verbose {
        return span(median);
    }
    format!(
        "{} from the ask · measured on {} of {} commits",
        span(median),
        p.land.counted,
        p.land.counted + p.land.uncounted
    )
}

fn who_line(p: &PersonRecap) -> String {
    if p.email.trim().is_empty() {
        return p.name.clone();
    }
    format!("{} <{}>", p.name, p.email)
}

// ── The shared layout ──────────────────────────────────────────────────────

fn body(r: &Recap, ink: Ink) -> String {
    let mut s = String::new();
    let line = format!("{} → {}", day(r.since), day(r.until));
    s.push_str(&format!("{}  {}\n", ink.b(&format!("Recap · {}", r.window.label())), ink.d(&line)));

    let repos: Vec<String> = r
        .repos
        .iter()
        .map(|repo| match &repo.problem {
            Some(p) => format!("{} ({p})", repo.name),
            None => format!("{} · {}", repo.name, repo.branch),
        })
        .collect();
    s.push_str(&format!("{}\n", ink.d(&repos.join("   "))));
    if let Some(a) = &r.agent {
        s.push_str(&format!("{}\n", ink.d(&format!("only work {a} declared a reason for"))));
    }

    if r.view.wants_you() {
        s.push('\n');
        s.push_str(&you_section(r, ink));
    }
    if r.view.wants_team() {
        s.push('\n');
        s.push_str(&team_section(r, ink));
    }
    if r.view.wants_you() && !r.under_you.is_empty() {
        s.push('\n');
        s.push_str(&overlap_section(r, ink));
    }
    s.push('\n');
    s.push_str(&absent_section(r, ink));
    s
}

fn you_section(r: &Recap, ink: Ink) -> String {
    let mut s = format!("{}\n", ink.b("You"));
    let Some(me) = &r.me else {
        s.push_str(&format!(
            "  {}\n",
            ink.warm(
                "this checkout has no git identity, so there is no `you` to report — \
                 set `git config user.email`"
            )
        ));
        return s;
    };
    s.push_str(&format!("  {}\n", ink.d(&who_line(&PersonRecap {
        name: me.name.clone(),
        email: me.email.clone(),
        ..Default::default()
    }))));

    let Some(you) = &r.you else {
        s.push_str(&format!("  {}\n", ink.d("nothing of yours landed in this window")));
        return s;
    };

    let pairs: Vec<(&str, String)> = vec![
        (
            "landed",
            format!("{} commits · {} files · {} symbol changes", you.commits, you.files, you.symbols),
        ),
        ("came back to", came_back_line(you)),
        ("ask → land", to_land(you, true)),
        ("agents", agents_of(you)),
        (
            "unexplained",
            match you.unexplained {
                0 => "none — every commit has a stated reason".to_string(),
                n => format!("{n} commits nobody stated a reason for"),
            },
        ),
    ];
    for (label, value) in pairs {
        // Pad the bare label and ink it afterwards: a dimmed string carries
        // escape bytes that width formatting would count as characters, and
        // the column would sit two spaces short of where the others are.
        s.push_str(&format!("  {} {}\n", ink.d(&format!("{label:<14}")), value));
    }
    s
}

/// The rework line in the personal section, said as a sentence rather than a
/// cell, because a bare `7 (31%)` is a number nobody can act on.
fn came_back_line(p: &PersonRecap) -> String {
    match p.rework.rate() {
        None => "nothing was touched in this window".to_string(),
        Some(_) if p.rework.returned == 0 => {
            format!("nothing — each of {} files was touched once", p.rework.files)
        }
        Some(rate) => format!(
            "{} of {} files, {} of your file-changes",
            p.rework.returned,
            p.rework.files,
            pct(rate)
        ),
    }
}

fn team_section(r: &Recap, ink: Ink) -> String {
    let mut s = format!(
        "{}  {}\n",
        ink.b("Team"),
        ink.d(&format!(
            "{} {} · {} commits",
            r.people(),
            if r.people() == 1 { "person" } else { "people" },
            r.commits()
        ))
    );
    if r.team.is_empty() {
        s.push_str(&format!("  {}\n", ink.d("nothing landed in this window")));
        return s;
    }

    let name_w = r.team.iter().map(|p| p.name.chars().count()).max().unwrap_or(6).clamp(6, 24);
    let back_w = r.team.iter().map(|p| came_back(p).chars().count()).max().unwrap_or(9).max(9);
    let land_w = r.team.iter().map(|p| to_land(p, false).chars().count()).max().unwrap_or(8).max(8);

    s.push_str(&format!(
        "  {}\n",
        ink.d(&format!(
            "{:<name_w$}  {:>7}  {:>5}  {:>back_w$}  {:>land_w$}  {}",
            "person", "commits", "files", "came back", "ask→land", "agents"
        ))
    ));
    for p in &r.team {
        let me = r.me.as_ref().is_some_and(|m| {
            !m.email.trim().is_empty() && m.email.eq_ignore_ascii_case(&p.email)
        });
        let name = short(&p.name, name_w);
        let name = if me { ink.b(&name) } else { name };
        // Pad on the plain name, then substitute — a bold string carries
        // escape bytes that width formatting would count as characters.
        let pad = name_w.saturating_sub(short(&p.name, name_w).chars().count());
        s.push_str(&format!(
            "  {}{:pad$}  {:>7}  {:>5}  {:>back_w$}  {:>land_w$}  {}\n",
            name,
            "",
            p.commits,
            p.files,
            came_back(p),
            to_land(p, false),
            agents_of(p)
        ));
    }
    s
}

fn overlap_section(r: &Recap, ink: Ink) -> String {
    let mut s = format!("{}\n", ink.b("What moved under you"));
    s.push_str(&format!(
        "  {}\n",
        ink.d("files you are working in that somebody else changed in this window")
    ));
    for o in &r.under_you {
        let when = if ink.relative { ago(o.at, r.until) } else { day(o.at) };
        let mark = if o.in_flight { "!" } else { " " };
        let mark = if o.in_flight && ink.colour { mark.yellow().to_string() } else { mark.to_string() };
        s.push_str(&format!(
            "  {} {}  {}  {}\n",
            mark,
            short(&o.file, 52),
            ink.d(&format!("{} · {}", o.who, when)),
            short(&o.subject, 46)
        ));
    }
    if r.under_you.iter().any(|o| o.in_flight) {
        s.push_str(&format!(
            "  {}\n",
            ink.d("!  is uncommitted in your working tree right now")
        ));
    }
    if r.more_overlap > 0 {
        s.push_str(&format!("  {}\n", ink.d(&format!("and {} more", r.more_overlap))));
    }
    s
}

/// What this recap could not answer, and why.
///
/// Printed every time, not only when something is missing, because the absence
/// is the finding: a "changes requested" column of zeroes would be read as a
/// clean window rather than as an unrecorded one.
fn absent_section(r: &Recap, ink: Ink) -> String {
    let mut s = format!("{}\n", ink.b("Not answered here"));
    let reviews = match r.reviews.runs {
        0 => "changes requested — no review ran in this window, and Aura keeps no per-person \
              review verdict on disk in any case"
            .to_string(),
        n => format!(
            "changes requested — {} review(s) ran, raising {} finding(s) ({} above advisory), \
             but a finding names a file and never a person, so it cannot be attributed here",
            n, r.reviews.findings, r.reviews.asks
        ),
    };
    s.push_str(&format!("  {}\n", ink.d(&reviews)));
    s.push_str(&format!(
        "  {}\n",
        ink.d(
            "come-backs are measured on files, not symbols — the symbol delta carries bare \
             names, so two `new`s in two modules would read as one"
        )
    ));
    s
}

// ── The four forms ─────────────────────────────────────────────────────────

/// The terminal view: colour, and time said relative to now.
pub fn terminal(r: &Recap) {
    print!("{}", body(r, Ink { colour: true, relative: true }));
}

/// The pipeable view: the same recap with no escape codes and no "2h ago".
pub fn plain(r: &Recap) -> String {
    body(r, Ink { colour: false, relative: false })
}

/// The form that leaves the tool.
pub fn markdown(r: &Recap) -> String {
    let mut s = String::new();
    s.push_str(&format!("# Recap · {}\n\n", r.window.label()));
    s.push_str(&format!("**{} → {}**\n\n", day(r.since), day(r.until)));
    for repo in &r.repos {
        match &repo.problem {
            Some(p) => s.push_str(&format!("- `{}` — could not be read: {p}\n", repo.name)),
            None => s.push_str(&format!(
                "- `{}` on `{}` — {} commit(s)\n",
                repo.name, repo.branch, repo.commits
            )),
        }
    }
    s.push('\n');
    if let Some(a) = &r.agent {
        s.push_str(&format!("Only work `{a}` declared a reason for.\n\n"));
    }

    if r.view.wants_you() {
        s.push_str("## You\n\n");
        match (&r.me, &r.you) {
            (None, _) => s.push_str(
                "This checkout has no git identity, so there is no *you* to report. \
                 Set `git config user.email`.\n\n",
            ),
            (Some(me), None) => {
                s.push_str(&format!("{} <{}> — nothing landed in this window.\n\n", me.name, me.email))
            }
            (Some(me), Some(you)) => {
                s.push_str(&format!("{} <{}>\n\n", me.name, me.email));
                s.push_str(&format!(
                    "| Landed | Came back to | Ask → land | Agents | Unexplained |\n\
                     |---|---|---|---|--:|\n\
                     | {} commits, {} files, {} symbol changes | {} | {} | {} | {} |\n\n",
                    you.commits,
                    you.files,
                    you.symbols,
                    came_back_line(you),
                    to_land(you, true),
                    agents_of(you),
                    you.unexplained
                ));
            }
        }
    }

    if r.view.wants_team() {
        s.push_str("## Team\n\n");
        if r.team.is_empty() {
            s.push_str("Nothing landed in this window.\n\n");
        } else {
            s.push_str(
                "| Person | Commits | Files | Came back | Ask → land | Agents |\n\
                 |---|--:|--:|---|---|---|\n",
            );
            for p in &r.team {
                s.push_str(&format!(
                    "| {} | {} | {} | {} | {} | {} |\n",
                    p.name,
                    p.commits,
                    p.files,
                    came_back(p),
                    to_land(p, false),
                    agents_of(p)
                ));
            }
            s.push('\n');
        }
    }

    if r.view.wants_you() && !r.under_you.is_empty() {
        s.push_str("## What moved under you\n\n");
        s.push_str("Files you are working in that somebody else changed in this window.\n\n");
        s.push_str("| File | Who | When | Change |\n|---|---|---|---|\n");
        for o in &r.under_you {
            s.push_str(&format!(
                "| `{}`{} | {} | {} | {} |\n",
                o.file,
                if o.in_flight { " *(uncommitted here)*" } else { "" },
                o.who,
                day(o.at),
                short(&o.subject, 60)
            ));
        }
        if r.more_overlap > 0 {
            s.push_str(&format!("\nAnd {} more.\n", r.more_overlap));
        }
        s.push('\n');
    }

    s.push_str("## Not answered here\n\n");
    s.push_str(&format!(
        "- **Changes requested** — {}\n",
        match r.reviews.runs {
            0 => "no review ran in this window, and Aura keeps no per-person review verdict \
                  on disk in any case."
                .to_string(),
            n => format!(
                "{n} review(s) ran, raising {} finding(s) ({} above advisory), but a finding \
                 names a file and never a person, so it cannot be attributed here.",
                r.reviews.findings, r.reviews.asks
            ),
        }
    ));
    s.push_str(
        "- **Come-backs** are measured on files, not symbols — the symbol delta carries bare \
         names, so two `new`s in two modules would read as one.\n",
    );
    s
}

fn person_json(p: &PersonRecap) -> serde_json::Value {
    serde_json::json!({
        "key": p.key,
        "name": p.name,
        "email": p.email,
        "commits": p.commits,
        "files": p.files,
        "symbols": p.symbols,
        "came_back": {
            "files_returned_to": p.rework.returned,
            "files_touched": p.rework.files,
            "return_touches": p.rework.extra,
            "rate": p.rework.rate(),
        },
        "time_to_land": {
            "median_seconds": p.land.median,
            "counted": p.land.counted,
            "uncounted": p.land.uncounted,
        },
        "agents": p.agents,
        "unexplained": p.unexplained,
        "last_at": p.last_at,
    })
}

fn overlap_json(o: &Overlap) -> serde_json::Value {
    serde_json::json!({
        "repo": o.repo,
        "file": o.file,
        "who": o.who,
        "at": o.at,
        "subject": o.subject,
        "in_flight": o.in_flight,
    })
}

pub fn to_json(r: &Recap) -> serde_json::Value {
    serde_json::json!({
        "window": r.window.flag(),
        "since": r.since,
        "until": r.until,
        "view": r.view.name(),
        "agent": r.agent,
        "me": r.me.as_ref().map(|m| serde_json::json!({ "name": m.name, "email": m.email })),
        "repos": r.repos.iter().map(|repo| serde_json::json!({
            "name": repo.name,
            "branch": repo.branch,
            "commits": repo.commits,
            "problem": repo.problem,
        })).collect::<Vec<_>>(),
        "you": r.you.as_ref().map(person_json),
        "team": r.team.iter().map(person_json).collect::<Vec<_>>(),
        "moved_under_you": r.under_you.iter().map(overlap_json).collect::<Vec<_>>(),
        "moved_under_you_omitted": r.more_overlap,
        // Carried as its own object, and never as a per-person field, because
        // a review finding names a file and never a person.
        "reviews": {
            "runs": r.reviews.runs,
            "findings": r.reviews.findings,
            "above_advisory": r.reviews.asks,
            "attributable_to_a_person": false,
        },
    })
}

/// Kept honest: `View` is matched exhaustively above, so a fifth view cannot
/// be added without deciding what each rendering does with it.
#[allow(dead_code)]
fn views_are_exhaustive(v: View) -> bool {
    matches!(v, View::You | View::Team | View::Both)
}
