//! `aura recap` — what you did, what the team did, and how that is trending.
//!
//! `aura dispatch` writes a document for somebody who was not here. A recap is
//! read by somebody who *was*, and is coming back: after a weekend, a sprint,
//! a quarter. So it answers three questions and nothing else —
//!
//! ```text
//!   what did I do            your window, by cadence not volume
//!   what did the team do     every person side by side, same measures
//!   what moved under me      files I have open that somebody else changed
//! ```
//!
//! **Cadence, not volume.** A commit count says who was busy, which nobody
//! needed a tool for. The measures here are how often work comes back and how
//! long it takes to land — the two questions asked of every engineer and
//! answered nowhere in this product until now. The arithmetic lives in
//! [`cadence`] so it can be pinned without a repository.
//!
//! Time-to-land is measured **from the prompt somebody typed**, which only
//! this product has: the agent's own transcript is joined to the commit, so
//! the span is the one a person means by "how long did that take". Measuring
//! from the intent row instead reports the seconds between `log-intent` and
//! `git commit`, which on real history came out at "under a minute" — a
//! number that is true, useless, and reads like an answer.
//!
//! **A number with no source is printed as missing.** Aura keeps no
//! per-person review verdict on disk, so "changes requested" cannot be
//! answered here honestly, and the recap says so in as many words instead of
//! printing a zero — which in that column reads as a perfect score. The same
//! rule governs the median: the commits it could not measure are counted and
//! named, because a median over a third of a week is a different claim to a
//! median over all of it.

pub mod cadence;
pub mod render;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::dispatch::{self, Change, RepoReport};

/// Overlap rows shown before the rest become a count. Past a dozen the
/// section stops being "look at this" and becomes another list to read.
const MAX_OVERLAP: usize = 12;

/// The window, as a person picks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Window {
    Day,
    Week,
    Month,
    Ninety,
}

impl Window {
    pub fn seconds(self) -> u64 {
        match self {
            Window::Day => 86_400,
            Window::Week => 7 * 86_400,
            Window::Month => 30 * 86_400,
            Window::Ninety => 90 * 86_400,
        }
    }

    /// How the heading says it — the words somebody would use out loud.
    pub fn label(self) -> &'static str {
        match self {
            Window::Day => "the last day",
            Window::Week => "the last week",
            Window::Month => "the last month",
            Window::Ninety => "the last 90 days",
        }
    }

    pub fn flag(self) -> &'static str {
        match self {
            Window::Day => "day",
            Window::Week => "week",
            Window::Month => "month",
            Window::Ninety => "90",
        }
    }

    /// Read the four flags into one window.
    ///
    /// Two windows is a contradiction, not a preference, so it is refused with
    /// the pair named rather than silently resolved by declaration order.
    pub fn from_flags(day: bool, week: bool, month: bool, ninety: bool) -> Result<Window, String> {
        let picked: Vec<Window> = [
            (day, Window::Day),
            (week, Window::Week),
            (month, Window::Month),
            (ninety, Window::Ninety),
        ]
        .into_iter()
        .filter_map(|(on, w)| on.then_some(w))
        .collect();
        match picked.as_slice() {
            [] => Ok(Window::Week),
            [one] => Ok(*one),
            more => Err(format!(
                "pick one window, not {} — `--{}` and `--{}` cannot both be the window",
                more.len(),
                more[0].flag(),
                more[1].flag()
            )),
        }
    }
}

/// Whose work the recap is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    You,
    Team,
    Both,
}

impl View {
    pub fn parse(s: &str) -> Result<View, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "you" | "me" | "self" => Ok(View::You),
            "team" | "all" => Ok(View::Team),
            "both" => Ok(View::Both),
            other => Err(format!("`--view {other}` — it is `you`, `team` or `both`")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            View::You => "you",
            View::Team => "team",
            View::Both => "both",
        }
    }

    pub fn wants_you(self) -> bool {
        matches!(self, View::You | View::Both)
    }

    pub fn wants_team(self) -> bool {
        matches!(self, View::Team | View::Both)
    }
}

/// Whoever git says is committing here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub name: String,
    pub email: String,
}

/// One person's window.
#[derive(Debug, Clone, Default)]
pub struct PersonRecap {
    /// What identifies them across repos — the email, lowercased.
    pub key: String,
    pub name: String,
    pub email: String,
    pub commits: usize,
    pub files: usize,
    pub symbols: usize,
    pub rework: cadence::Rework,
    pub land: cadence::Land,
    /// Which agents declared the reasons, and how many each.
    pub agents: BTreeMap<String, usize>,
    /// Commits nobody stated a reason for.
    pub unexplained: usize,
    /// Their most recent commit in the window.
    pub last_at: u64,
}

/// A file you are working in that somebody else has changed.
#[derive(Debug, Clone)]
pub struct Overlap {
    pub repo: String,
    pub file: String,
    pub who: String,
    pub at: u64,
    pub subject: String,
    /// True when the file is dirty in your working tree right now — which is
    /// the case worth interrupting somebody for.
    pub in_flight: bool,
}

/// What the review ledger could and could not say about the window.
///
/// Modelled as its own thing rather than folded into the per-person numbers,
/// because it is the one measure here that is **not** attributable to a
/// person, and printing it in a per-person table would imply it was.
#[derive(Debug, Clone, Default)]
pub struct Reviews {
    pub runs: usize,
    pub findings: usize,
    /// Findings above advisory — the ones that ask for a change.
    pub asks: usize,
}

/// The whole recap.
#[derive(Debug, Clone)]
pub struct Recap {
    pub window: Window,
    pub since: u64,
    pub until: u64,
    pub view: View,
    /// The `--agent` filter, if one was given.
    pub agent: Option<String>,
    /// Who git thinks you are. `None` when this checkout has no identity, in
    /// which case `--view you` has nothing to be about and says so.
    pub me: Option<Person>,
    pub repos: Vec<RepoLine>,
    pub you: Option<PersonRecap>,
    /// Everybody, busiest first — you included, so you can see yourself
    /// against the rest rather than in a separate world.
    pub team: Vec<PersonRecap>,
    pub under_you: Vec<Overlap>,
    /// Overlaps past [`MAX_OVERLAP`].
    pub more_overlap: usize,
    pub reviews: Reviews,
}

/// One repository's line in the header, and its failure if it had one.
#[derive(Debug, Clone)]
pub struct RepoLine {
    pub name: String,
    pub branch: String,
    pub commits: usize,
    pub problem: Option<String>,
}

impl Recap {
    pub fn commits(&self) -> usize {
        self.team.iter().map(|p| p.commits).sum()
    }

    pub fn people(&self) -> usize {
        self.team.len()
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// How a person is identified across repositories.
///
/// The email, because a name is spelled three ways by the same person across
/// two laptops and a CI box, and merging those into one row is the whole point
/// of a team table.
fn person_key(name: &str, email: &str) -> String {
    let e = email.trim().to_ascii_lowercase();
    if e.is_empty() {
        return name.trim().to_ascii_lowercase();
    }
    e
}

/// Whoever this checkout commits as.
///
/// Read from git rather than from the Aura account, because it is git that
/// authored every row this recap counts — an account whose email differs from
/// `user.email` would put your own commits in somebody else's line.
pub fn me_from(root: &Path) -> Option<Person> {
    let repo = git2::Repository::open(root).ok()?;
    let cfg = repo.config().ok()?;
    let name = cfg.get_string("user.name").ok().unwrap_or_default();
    let email = cfg.get_string("user.email").ok().unwrap_or_default();
    if name.trim().is_empty() && email.trim().is_empty() {
        return None;
    }
    Some(Person { name, email })
}

/// Files dirty in the working tree right now.
///
/// The overlap that matters most is not on something you already committed —
/// it is on the file open in front of you, which is exactly the one git has
/// not been told about yet.
fn dirty_files(root: &Path) -> Vec<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain", "-z"])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    // `-z` because a path with a space or a quote is a path, not a parse
    // error, and porcelain v1 quotes those in its text form.
    let text = String::from_utf8_lossy(&out.stdout);
    let mut files = Vec::new();
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let status = &entry[..2];
        let path = &entry[3..];
        // A rename's old path follows as its own NUL-separated field. The new
        // path is the one being worked in, so the old one is consumed and
        // dropped rather than counted as a second dirty file.
        if status.starts_with('R') || status.starts_with('C') {
            let _ = fields.next();
        }
        files.push(path.to_string());
    }
    files
}

/// Does this change belong to the agent that was asked about?
///
/// Matched against both the label a reader sees and the raw id in the log, so
/// `--agent claude` finds rows written as `claude`, `Claude` and by a hook
/// that only left the name in the intent text.
fn is_agent(c: &Change, want: &str) -> bool {
    let Some(row) = c.intent.as_ref() else { return false };
    let label = dispatch::agent_label(&row.agent_id, &row.intent);
    label.eq_ignore_ascii_case(want) || row.agent_id.eq_ignore_ascii_case(want)
}

/// Reviews that ran in the window, from the repo's own review ledger.
///
/// Read for what it can say and no more: these findings carry a severity but
/// no author, so they are a property of the window, not of a person.
fn reviews_in(root: &Path, since: u64, until: u64) -> Reviews {
    let mut out = Reviews::default();
    let Ok(entries) = std::fs::read_dir(root.join(".aura").join("reviews")) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stamp) = name.strip_suffix(".json").and_then(|s| s.parse::<u64>().ok()) else {
            continue;
        };
        if stamp < since || stamp > until {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        out.runs += 1;
        let Some(findings) = value.get("findings").and_then(|f| f.as_array()) else { continue };
        out.findings += findings.len();
        out.asks += findings
            .iter()
            .filter(|f| {
                let sev = f.get("severity").and_then(|s| s.as_str()).unwrap_or("");
                !matches!(sev.to_ascii_lowercase().as_str(), "info" | "advisory")
            })
            .count();
    }
    out
}

/// Fold every repository's commits into one recap.
pub fn assemble(
    reports: &[RepoReport],
    dirty: &BTreeMap<String, Vec<String>>,
    reviews: Reviews,
    window: Window,
    since: u64,
    until: u64,
    view: View,
    agent: Option<&str>,
    me: Option<Person>,
) -> Recap {
    let my_key = me.as_ref().map(|m| person_key(&m.name, &m.email));

    let mut people: BTreeMap<String, PersonRecap> = BTreeMap::new();
    let mut touches: BTreeMap<String, Vec<cadence::Touch>> = BTreeMap::new();
    let mut files_seen: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    // Every file anybody but you changed, with the newest change to it.
    let mut theirs: BTreeMap<String, Overlap> = BTreeMap::new();
    let mut mine: BTreeSet<String> = BTreeSet::new();

    // Your dirty files are yours before a single commit is read: the overlap
    // worth interrupting somebody for is on the file open in front of you.
    for report in reports {
        for f in dirty.get(&report.name).into_iter().flatten() {
            mine.insert(format!("{}/{}", report.name, f));
        }
    }

    for report in reports {
        for change in &report.changes {
            if let Some(want) = agent {
                if !is_agent(change, want) {
                    continue;
                }
            }
            let key = person_key(&change.author, &change.email);
            let is_me = my_key.as_deref() == Some(key.as_str());

            let entry = people.entry(key.clone()).or_insert_with(|| PersonRecap {
                key: key.clone(),
                name: change.author.clone(),
                email: change.email.clone(),
                ..Default::default()
            });
            entry.commits += 1;
            entry.symbols += change.delta.total();
            entry.last_at = entry.last_at.max(change.at);
            match change.intent.as_ref() {
                Some(row) => {
                    *entry
                        .agents
                        .entry(dispatch::agent_label(&row.agent_id, &row.intent))
                        .or_insert(0) += 1;
                }
                None => entry.unexplained += 1,
            }

            let files: Vec<String> =
                change.delta.files.iter().map(|f| format!("{}/{}", report.name, f)).collect();
            files_seen.entry(key.clone()).or_default().extend(files.iter().cloned());
            touches.entry(key.clone()).or_default().push(cadence::Touch {
                at: change.at,
                files: files.clone(),
                // The ask, not the intent row. An agent logs its intent in
                // the seconds before it commits, so that span measures the
                // ritual; the prompt somebody typed is when the work started.
                // A dialect that records no clock leaves `at` at 0, which is
                // not a timestamp and must not become a span of 56 years.
                started: change
                    .prompt
                    .as_ref()
                    .map(|p| p.at)
                    .filter(|at| *at > 0 && *at <= change.at),
            });

            if is_me {
                mine.extend(files);
            } else {
                for (i, f) in files.iter().enumerate() {
                    let older = theirs.get(f).is_some_and(|o| o.at >= change.at);
                    if older {
                        continue;
                    }
                    theirs.insert(
                        f.clone(),
                        Overlap {
                            repo: report.name.clone(),
                            file: change.delta.files[i].clone(),
                            who: change.author.clone(),
                            at: change.at,
                            subject: change.subject.clone(),
                            in_flight: false,
                        },
                    );
                }
            }
        }
    }

    for (key, p) in people.iter_mut() {
        let t = touches.get(key).map(|v| v.as_slice()).unwrap_or(&[]);
        p.rework = cadence::rework(t);
        p.land = cadence::land(t);
        p.files = files_seen.get(key).map(|s| s.len()).unwrap_or(0);
    }

    let dirty_keys: BTreeSet<String> = dirty
        .iter()
        .flat_map(|(repo, files)| files.iter().map(move |f| format!("{repo}/{f}")))
        .collect();

    let mut under_you: Vec<Overlap> = theirs
        .into_iter()
        .filter(|(f, _)| mine.contains(f))
        .map(|(f, mut o)| {
            o.in_flight = dirty_keys.contains(&f);
            o
        })
        .collect();
    // What you have open beats what you merely committed, and within each the
    // newest change is the one you have not seen.
    under_you.sort_by(|a, b| b.in_flight.cmp(&a.in_flight).then(b.at.cmp(&a.at)));
    let more_overlap = under_you.len().saturating_sub(MAX_OVERLAP);
    under_you.truncate(MAX_OVERLAP);

    let you = my_key.and_then(|k| people.get(&k).cloned());
    let mut team: Vec<PersonRecap> = people.into_values().collect();
    team.sort_by(|a, b| b.commits.cmp(&a.commits).then(a.name.cmp(&b.name)));

    Recap {
        window,
        since,
        until,
        view,
        agent: agent.map(|a| a.to_string()),
        me,
        repos: reports
            .iter()
            .map(|r| RepoLine {
                name: r.name.clone(),
                branch: r.branch.clone(),
                commits: r.changes.len(),
                problem: r.problem.clone(),
            })
            .collect(),
        you,
        team,
        under_you,
        more_overlap,
        reviews,
    }
}

/// Command entry point. Returns a process exit code.
#[allow(clippy::too_many_arguments)]
pub fn cli(
    day: bool,
    week: bool,
    month: bool,
    ninety: bool,
    view: &str,
    agent: Option<&str>,
    repos: Option<&str>,
    branch: Option<&str>,
    is_static: bool,
    json: bool,
    markdown: bool,
    out: Option<&str>,
) -> i32 {
    let fail = |msg: String| -> i32 {
        if json {
            println!("{}", serde_json::json!({ "error": msg }));
        } else {
            eprintln!("✗ {msg}");
        }
        1
    };

    let window = match Window::from_flags(day, week, month, ninety) {
        Ok(w) => w,
        Err(e) => return fail(e),
    };
    let view = match View::parse(view) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let roots: Vec<PathBuf> = match dispatch::roots_from(repos) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };

    let until = now();
    let since = until.saturating_sub(window.seconds());

    let reports: Vec<RepoReport> =
        roots.iter().map(|r| dispatch::for_repo(r, branch, since, until)).collect();
    let mut dirty: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut reviews = Reviews::default();
    for (root, report) in roots.iter().zip(reports.iter()) {
        dirty.insert(report.name.clone(), dirty_files(root));
        let r = reviews_in(root, since, until);
        reviews.runs += r.runs;
        reviews.findings += r.findings;
        reviews.asks += r.asks;
    }
    let me = roots.first().and_then(|r| me_from(r));

    let recap =
        assemble(&reports, &dirty, reviews, window, since, until, view, agent, me);

    // A file is markdown whatever the flags say — nobody writes a terminal
    // rendering, escape codes and all, to a path they intend to send on.
    let text = if json {
        serde_json::to_string_pretty(&render::to_json(&recap)).unwrap_or_default()
    } else if markdown || out.is_some() {
        render::markdown(&recap)
    } else if is_static || !std::io::IsTerminal::is_terminal(&std::io::stdout()) {
        render::plain(&recap)
    } else {
        String::new()
    };

    if let Some(path) = out {
        if let Err(e) = std::fs::write(path, &text) {
            return fail(format!("could not write {path}: {e}"));
        }
        println!("✓ wrote {path}");
        return 0;
    }
    if text.is_empty() {
        render::terminal(&recap);
    } else {
        println!("{text}");
    }
    0
}

#[cfg(test)]
mod tests;
