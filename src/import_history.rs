//! `aura import` — bring the work that happened before Aura was installed.
//!
//! A team that installs Aura on a repo they have been building with agents for
//! months gets an empty console: the record starts the day the hook was
//! installed, and every session before that is invisible even though the
//! transcripts are sitting on disk. This reads those transcripts through
//! [`crate::history`] and writes what they contain into the intent log, so the
//! first thing a new install shows is the team's actual history.
//!
//! **What is imported is what the person asked for**, one row per prompt,
//! carrying the session it was asked in and the moment it was asked. Not what
//! the agent did — that is not recoverable after the fact without re-deriving
//! it from commits, and a guess written into the record as if it were observed
//! is exactly the failure this product exists to prevent. Imported rows say so
//! outright: `source: "import"`, `kind: "prompt"`, and the dialect they came
//! from. Everything downstream can tell them from a row a hook witnessed.
//!
//! **Re-running is safe and cheap.** A high-water mark per session is kept in
//! `.aura/imported.json`, so a second run imports only what has been said
//! since — which is also how a long-running session gets topped up as it grows,
//! rather than being imported once and frozen.
//!
//! **Local first.** Nothing is sent anywhere unless `--push` is passed. An
//! import can be thousands of rows; deciding to publish a team's whole prompt
//! history to the cloud is a decision someone should make on purpose.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use colored::*;

use crate::history::{self, History, Scope, Session};

/// Where the high-water marks live.
const MARK_FILE: &str = "imported.json";

/// What was imported from one session, so a later run knows where it stopped.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Mark {
    /// The moment of the newest prompt already imported.
    pub through: u64,
    /// How many rows this session has contributed so far.
    pub rows: usize,
}

/// One dialect's contribution to a run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tally {
    pub sessions: usize,
    pub prompts: usize,
    /// Sessions skipped because nothing new had been said in them.
    pub already: usize,
    /// Sessions skipped because everything in them fell outside `--since`.
    pub outside: usize,
    pub earliest: u64,
    pub latest: u64,
}

impl Tally {
    fn saw(&mut self, at: u64) {
        if at == 0 {
            return;
        }
        if self.earliest == 0 || at < self.earliest {
            self.earliest = at;
        }
        if at > self.latest {
            self.latest = at;
        }
    }
}

/// What a run did, per dialect and in total.
#[derive(Debug, Clone, Default)]
pub struct Report {
    pub by_dialect: BTreeMap<&'static str, Tally>,
    pub dry_run: bool,
    pub pushed: usize,
}

impl Report {
    pub fn prompts(&self) -> usize {
        self.by_dialect.values().map(|t| t.prompts).sum()
    }
    pub fn sessions(&self) -> usize {
        self.by_dialect.values().map(|t| t.sessions).sum()
    }
    pub fn already(&self) -> usize {
        self.by_dialect.values().map(|t| t.already).sum()
    }
    pub fn outside(&self) -> usize {
        self.by_dialect.values().map(|t| t.outside).sum()
    }
}

fn marks_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join(MARK_FILE)
}

/// Marks are keyed by dialect and session, because two agents can and do use
/// the same session id shape.
fn mark_key(dialect: &str, session_id: &str) -> String {
    format!("{dialect}/{session_id}")
}

pub fn load_marks(repo_root: &Path) -> BTreeMap<String, Mark> {
    std::fs::read_to_string(marks_path(repo_root))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_marks(repo_root: &Path, marks: &BTreeMap<String, Mark>) -> std::io::Result<()> {
    let path = marks_path(repo_root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(marks)?;
    // Beside-and-rename: an interrupted import must not leave a half-written
    // mark file, which would re-import everything or nothing.
    let tmp = path.with_extension(format!("json.tmp{}", std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)
}

/// The row one prompt becomes.
///
/// Shaped like a hook-written row so every existing reader works unchanged —
/// same `agent_id` / `intent` / `timestamp` / `session_id` spine the console
/// groups its Sessions feed on — with the provenance fields that say this was
/// read out of a transcript rather than witnessed as it happened.
pub fn row_for(session: &Session, prompt: &history::Prompt, developer: Option<(&str, &str)>) -> serde_json::Value {
    let mut row = serde_json::json!({
        "agent_id": session.dialect,
        "intent": prompt.text,
        "timestamp": prompt.at,
        "source": "import",
        "kind": "prompt",
        "session_id": session.id,
        "imported_from": session.dialect,
    });
    if let Some(branch) = session.branch.as_deref() {
        row["branch"] = serde_json::json!(branch);
    }
    if let Some((email, handle)) = developer {
        if !email.is_empty() {
            row["developer"] = serde_json::json!(email);
            row["developer_handle"] = serde_json::json!(handle);
        }
    }
    row
}

/// Should this session be read at all, given what was imported before?
///
/// `None` means nothing new. Otherwise the moment to import from — exclusive,
/// so the prompt that ended the last run is not written twice.
pub fn resume_from(marks: &BTreeMap<String, Mark>, session: &Session) -> Option<u64> {
    match marks.get(&mark_key(session.dialect, &session.id)) {
        None => Some(0),
        Some(mark) if session.last_activity_at > mark.through => Some(mark.through),
        // Nothing has been said in this session since the last run. The
        // transcript is not opened at all — which is what makes re-running an
        // import on a large machine cheap rather than a full re-read.
        Some(_) => None,
    }
}

/// Run an import.
///
/// `dialect` narrows to one agent; `since` drops everything older; `dry_run`
/// reports what would happen and writes nothing at all — no rows, no marks.
pub fn run(
    repo_root: &Path,
    dialect: Option<&str>,
    since: Option<u64>,
    dry_run: bool,
    push: bool,
) -> Result<Report, String> {
    let mut report = Report { dry_run, ..Default::default() };
    let mut marks = load_marks(repo_root);
    let identity = crate::usage_by_dev::dev_identity();
    let developer = Some((identity.email.as_str(), identity.handle.as_str()));

    let mut scope = Scope::repo(repo_root);
    if let Some(at) = since {
        scope = scope.since(at);
    }

    let dialects: Vec<Box<dyn History>> = history::installed()
        .into_iter()
        .filter(|d| dialect.is_none_or(|want| d.id() == want))
        .collect();

    if dialects.is_empty() {
        return Err(match dialect {
            Some(d) => format!("no history found for `{d}` — is it installed, and has it run here?"),
            None => "no agent history found on this machine".to_string(),
        });
    }

    for d in dialects {
        let tally = report.by_dialect.entry(d.id()).or_default();
        // `index`, not `sessions`: the counts a full read produces are not
        // used here, and a machine with gigabytes of transcripts should not
        // read all of them to discover that most have nothing new.
        for session in d.index(&scope) {
            let Some(from) = resume_from(&marks, &session) else {
                tally.already += 1;
                continue;
            };

            let prompts: Vec<history::Prompt> = d
                .prompts(&session)
                .into_iter()
                .filter(|p| p.at > from)
                .filter(|p| since.is_none_or(|s| p.at == 0 || p.at >= s))
                .collect();
            if prompts.is_empty() {
                // Two different reasons to read nothing, and conflating them
                // would tell someone their history was already imported when
                // in fact their `--since` excluded it.
                if from == 0 && since.is_some() {
                    tally.outside += 1;
                } else {
                    tally.already += 1;
                }
                continue;
            }

            tally.sessions += 1;
            let mut newest = from;
            for prompt in &prompts {
                tally.prompts += 1;
                tally.saw(prompt.at);
                newest = newest.max(prompt.at);
                if dry_run {
                    continue;
                }
                let row = row_for(&session, prompt, developer);
                if let Err(e) = crate::intent_log::append(repo_root, &row) {
                    return Err(format!("could not write the intent log: {e}"));
                }
                if push {
                    crate::intent_sync::push(&row, repo_root);
                    report.pushed += 1;
                }
            }

            if !dry_run {
                let entry = marks.entry(mark_key(session.dialect, &session.id)).or_default();
                entry.through = newest.max(entry.through);
                entry.rows += prompts.len();
            }
        }
    }

    if !dry_run && report.prompts() > 0 {
        if let Err(e) = save_marks(repo_root, &marks) {
            // The rows are already written. Saying nothing here would mean a
            // second run silently duplicated all of them.
            return Err(format!(
                "imported {} row(s), but could not record where to resume from: {e}",
                report.prompts()
            ));
        }
    }

    Ok(report)
}

/// `30d`, `2w`, `6h`, or an ISO date. Returns the unix second to import from.
pub fn parse_since(text: &str, now: u64) -> Option<u64> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(rest) = t.strip_suffix(|c: char| matches!(c, 'd' | 'w' | 'h' | 'm' | 'y')) {
        let unit = t.chars().last()?;
        let n: u64 = rest.parse().ok()?;
        let secs = match unit {
            'h' => 3_600,
            'd' => 86_400,
            'w' => 7 * 86_400,
            'm' => 30 * 86_400,
            'y' => 365 * 86_400,
            _ => return None,
        };
        return Some(now.saturating_sub(n * secs));
    }
    // A plain date is read as midnight UTC on that day.
    let mut parts = t.split('-');
    let (y, mo, da): (i64, i64, i64) = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    Some(days_from_civil(y, mo, da).max(0) as u64 * 86_400)
}

/// Days since 1970-01-01 for a civil date — Howard Hinnant's algorithm, which
/// is exact and needs no calendar library.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The name a person calls this agent, rather than its key.
fn display_name(id: &str) -> String {
    history::dialects()
        .iter()
        .find(|d| d.id() == id)
        .map(|d| d.display().to_string())
        .unwrap_or_else(|| id.to_string())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// "3d" / "5h" / "12m" — how far back a moment is, in the shortest true unit.
fn span(then: u64) -> String {
    let now = now();
    if then == 0 || then > now {
        return "just now".to_string();
    }
    match now - then {
        0..=59 => "just now".to_string(),
        d @ 60..=3_599 => format!("{}m ago", d / 60),
        d @ 3_600..=86_399 => format!("{}h ago", d / 3_600),
        d => format!("{}d ago", d / 86_400),
    }
}

fn to_json(report: &Report) -> serde_json::Value {
    let by_dialect: serde_json::Map<String, serde_json::Value> = report
        .by_dialect
        .iter()
        .map(|(id, t)| {
            (
                id.to_string(),
                serde_json::json!({
                    "sessions": t.sessions,
                    "prompts": t.prompts,
                    "unchanged_sessions": t.already,
                    "outside_since": t.outside,
                    "earliest": t.earliest,
                    "latest": t.latest,
                }),
            )
        })
        .collect();
    serde_json::json!({
        "dry_run": report.dry_run,
        "sessions": report.sessions(),
        "prompts": report.prompts(),
        "unchanged_sessions": report.already(),
        "outside_since": report.outside(),
        "pushed": report.pushed,
        "by_dialect": by_dialect,
    })
}

fn render(report: &Report) {
    let verb = if report.dry_run { "would import" } else { "imported" };
    if report.prompts() == 0 {
        // Two different silences, and saying which one it is saves someone
        // wondering whether the import worked at all.
        if report.already() > 0 {
            println!(
                "{} nothing new — {} session(s) already imported",
                "✓".green(),
                report.already()
            );
        } else if report.outside() > 0 {
            println!(
                "{} {} session(s) here, all older than the span you asked for",
                "·".dimmed(),
                report.outside()
            );
        } else {
            println!("{} no agent history for this repo yet", "·".dimmed());
        }
        return;
    }

    println!(
        "{} {} {} prompt(s) from {} session(s)",
        "✓".green(),
        verb,
        report.prompts().to_string().bold(),
        report.sessions()
    );
    for (id, t) in &report.by_dialect {
        if t.prompts == 0 {
            continue;
        }
        let reach = if t.earliest == 0 {
            String::new()
        } else if t.earliest == t.latest {
            format!("  {}", span(t.earliest).dimmed())
        } else {
            format!("  {}", format!("{} → {}", span(t.earliest), span(t.latest)).dimmed())
        };
        // Pad before colouring: a coloured string carries escape bytes, and a
        // width applied to those pads by the wrong amount every time.
        let name = format!("{:<12}", display_name(id));
        println!("  {}{} prompt(s), {} session(s){}", name.bold(), t.prompts, t.sessions, reach);
    }
    if report.already() > 0 {
        println!("  {}", format!("{} session(s) unchanged since the last import", report.already()).dimmed());
    }
    if report.outside() > 0 {
        println!("  {}", format!("{} session(s) older than the span you asked for", report.outside()).dimmed());
    }
    if report.pushed > 0 {
        println!("  {}", format!("{} row(s) sent to the team", report.pushed).dimmed());
    }

    if report.dry_run {
        println!("\n  {}", "run again without --dry-run to write them".dimmed());
    } else {
        println!("\n  {}", "`aura why <file>:<line>` can now reach these prompts".dimmed());
    }
}

/// Command entry point. Returns a process exit code.
pub fn cli(dialect: Option<&str>, since: Option<&str>, dry_run: bool, push: bool, json: bool) -> i32 {
    let fail = |msg: String| -> i32 {
        if json {
            println!("{}", serde_json::json!({"error": msg}));
        } else {
            eprintln!("{} {}", "✗".red(), msg);
        }
        1
    };

    let Ok(repo) = git2::Repository::discover(".") else {
        return fail("not inside a git repository".to_string());
    };
    let Some(repo_root) = repo.workdir().map(|p| p.to_path_buf()) else {
        return fail("a bare repository has no working tree to import into".to_string());
    };

    // An unreadable `--since` must stop the run: silently importing everything
    // because a span was mistyped is the opposite of what was asked for.
    let cutoff = match since {
        Some(text) => match parse_since(text, now()) {
            Some(at) => Some(at),
            None => {
                return fail(format!(
                    "could not read `--since {text}` — try `30d`, `2w`, `6h` or `2026-01-01`"
                ))
            }
        },
        None => None,
    };

    match run(&repo_root, dialect, cutoff, dry_run, push) {
        Ok(report) => {
            if json {
                println!("{}", serde_json::to_string_pretty(&to_json(&report)).unwrap_or_default());
            } else {
                render(&report);
            }
            0
        }
        Err(e) => fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, last: u64) -> Session {
        Session {
            dialect: "claude",
            id: id.into(),
            cwd: Some("/repo".into()),
            cwd_digest: None,
            branch: Some("main".into()),
            title: None,
            started_at: last.saturating_sub(600),
            last_activity_at: last,
            prompts: None,
            steps: None,
            path: PathBuf::from("/tmp/x.jsonl"),
        }
    }

    #[test]
    fn a_session_nothing_has_been_said_in_is_not_reopened() {
        // This is what makes a second import cheap: the transcript is never
        // opened, because the mark already covers everything in it.
        let mut marks = BTreeMap::new();
        marks.insert("claude/s1".to_string(), Mark { through: 500, rows: 3 });
        assert_eq!(resume_from(&marks, &session("s1", 500)), None);
        assert_eq!(resume_from(&marks, &session("s1", 900)), Some(500), "grew, so read from there");
        assert_eq!(resume_from(&marks, &session("s2", 100)), Some(0), "never seen");
    }

    #[test]
    fn an_imported_row_says_it_was_imported() {
        // A row read out of a transcript and a row a hook witnessed are not the
        // same claim, and the log has to be able to tell them apart.
        let row = row_for(
            &session("s1", 500),
            &history::Prompt { at: 480, text: "make the parser stricter".into() },
            Some(("dev@example.com", "dev")),
        );
        assert_eq!(row["source"], "import");
        assert_eq!(row["kind"], "prompt");
        assert_eq!(row["imported_from"], "claude");
        assert_eq!(row["session_id"], "s1");
        assert_eq!(row["intent"], "make the parser stricter");
        assert_eq!(row["timestamp"], 480);
        assert_eq!(row["branch"], "main");
        assert_eq!(row["developer"], "dev@example.com");
    }

    #[test]
    fn since_reads_both_spans_and_dates() {
        const NOW: u64 = 1_787_500_000;
        assert_eq!(parse_since("1d", NOW), Some(NOW - 86_400));
        assert_eq!(parse_since("2w", NOW), Some(NOW - 14 * 86_400));
        assert_eq!(parse_since("6h", NOW), Some(NOW - 21_600));
        // 2026-01-01 is 20454 days after the epoch.
        assert_eq!(parse_since("2026-01-01", NOW), Some(20_454 * 86_400));
        assert_eq!(parse_since("1970-01-01", NOW), Some(0));
        assert_eq!(parse_since("", NOW), None);
        assert_eq!(parse_since("whenever", NOW), None);
    }

    #[test]
    fn a_run_over_no_installed_dialects_says_so_rather_than_reporting_success() {
        let dir = tempfile::tempdir().unwrap();
        let err = run(dir.path(), Some("no-such-agent"), None, true, false).unwrap_err();
        assert!(err.contains("no-such-agent"), "names what was asked for: {err}");
    }

    #[test]
    fn a_dry_run_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        // Whatever this machine has, a dry run must leave the repo untouched.
        let _ = run(dir.path(), None, None, true, false);
        assert!(!dir.path().join(".aura").join(MARK_FILE).exists());
        assert!(!dir.path().join(".aura").join("intent_log.jsonl").exists());
    }

    #[test]
    fn a_session_excluded_by_since_is_not_reported_as_already_imported() {
        // "already imported" and "older than you asked for" are different
        // answers, and telling someone the first when the second is true sends
        // them looking for a bug that isn't there.
        let mut t = Tally::default();
        // Stands in for the two branches `run` takes when a session yields no
        // rows: a mark covered it, versus `--since` excluded all of it.
        t.already += 1;
        t.outside += 1;
        let mut report = Report::default();
        report.by_dialect.insert("claude", t);
        assert_eq!(report.already(), 1);
        assert_eq!(report.outside(), 1);
        let v = to_json(&report);
        assert_eq!(v["unchanged_sessions"], 1);
        assert_eq!(v["outside_since"], 1);
    }

    #[test]
    fn the_tally_spans_from_the_oldest_to_the_newest_it_saw() {
        let mut t = Tally::default();
        t.saw(500);
        t.saw(0); // no clock on that row — must not become the earliest
        t.saw(200);
        t.saw(900);
        assert_eq!((t.earliest, t.latest), (200, 900));
    }
}
