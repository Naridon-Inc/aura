//! `aura sessions` — what has happened in this repository, from both places
//! that know.
//!
//! Two things record a session and neither one sees the other:
//!
//! * `.aura/sessions/*.json`, written by the desktop app and by
//!   `aura usage-record`, which carry a pid, a model and token counts
//! * `.aura/intent_log.jsonl`, written by the hooks and by `aura log-intent`
//!   every time anybody does anything, with no account and no app required
//!
//! The listing used to read only the first, so the person most likely to run
//! it — someone who has just installed the CLI and worked in a terminal — was
//! the one person it had nothing to say to. See
//! {@link crate::sessions_from_intents} for what the second one yields and why
//! it is folded by the server's rules rather than new ones.
//!
//! The other half of the fix is the phase. A session is only marked `Ended`
//! when a run finishes cleanly, and runs are usually killed instead, so this
//! repository holds seventeen sessions that have read `ACTIVE` for weeks. The
//! listing now says what is true at the moment you ask — a process that is
//! still running, or a session that has been quiet long enough to be over —
//! and does not write that conclusion back. A command whose whole job is to
//! show you what is there should not change it.

use colored::Colorize;

use crate::session::{self, AgentSession, SessionManager, SessionPhase};
use crate::sessions_from_intents::{self, DerivedSession, QUIET_SECS};

/// How the listing describes a session's state right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    /// A process is still running behind it.
    Running,
    /// Nothing is running, but it stopped recently enough to be picked back up.
    Paused,
    /// Ended cleanly, or quiet long enough that it is over either way.
    Over,
}

impl Liveness {
    fn label(self) -> String {
        match self {
            Liveness::Running => "ACTIVE".green().bold().to_string(),
            Liveness::Paused => "IDLE".yellow().to_string(),
            Liveness::Over => "ENDED".dimmed().to_string(),
        }
    }
}

/// What a recorded session is actually doing, as opposed to what its file was
/// last told to say.
///
/// A stored `Ended` is believed — that one is written on the way out and means
/// what it says. `Active` is not, because nothing writes the correction when a
/// terminal is closed: the pid answers instead, and where there is no pid to
/// ask, the clock does.
pub fn liveness_of(session: &AgentSession, process_running: bool, now: u64) -> Liveness {
    if session.phase == SessionPhase::Ended {
        return Liveness::Over;
    }
    if process_running {
        return Liveness::Running;
    }
    if now.saturating_sub(session.last_activity) > QUIET_SECS {
        Liveness::Over
    } else {
        Liveness::Paused
    }
}

/// The same question for a session that exists only as work in the log. There
/// is no pid to ask — a terminal has no process that could heartbeat one — so
/// the clock is the whole answer.
pub fn liveness_of_derived(session: &DerivedSession, now: u64) -> Liveness {
    if session.is_finished(now) {
        Liveness::Over
    } else {
        Liveness::Paused
    }
}

/// One line of the listing, from either source.
struct Row {
    recorded: Option<AgentSession>,
    derived: Option<DerivedSession>,
    liveness: Liveness,
    /// Sort key: when this session last did anything, from whichever source
    /// saw it most recently.
    last: u64,
}

/// Merge both records of the same repository.
///
/// A session that appears in both is one session: the file holds the model and
/// the token counts, the log holds the work, and showing it twice would tell
/// somebody counting their sessions the wrong number. Where they disagree
/// about when it last did anything, the later answer wins — the log keeps
/// growing after the app has stopped updating the file.
fn rows(recorded: Vec<AgentSession>, derived: Vec<DerivedSession>, now: u64) -> Vec<Row> {
    let mut out: Vec<Row> = Vec::new();
    let mut derived: std::collections::BTreeMap<String, DerivedSession> = derived
        .into_iter()
        .map(|d| (d.session_id.clone(), d))
        .collect();

    for session in recorded {
        let work = derived.remove(&session.session_id);
        let last = work
            .as_ref()
            .map(|w| w.last.max(session.last_activity))
            .unwrap_or(session.last_activity);
        let running = session.process_is_running();
        // Liveness reads the later of the two clocks for the same reason the
        // row does: a session the app stopped updating an hour ago is not
        // over if the hooks logged a tool call a minute ago.
        let mut probe = session.clone();
        probe.last_activity = last;
        out.push(Row {
            liveness: liveness_of(&probe, running, now),
            recorded: Some(session),
            derived: work,
            last,
        });
    }

    for (_, work) in derived {
        out.push(Row {
            liveness: liveness_of_derived(&work, now),
            last: work.last,
            recorded: None,
            derived: Some(work),
        });
    }

    out.sort_by(|a, b| b.last.cmp(&a.last));
    out
}

/// Whose session a row is, from whichever half recorded it.
///
/// Both can answer and they answer differently. A session file stamps the
/// git identity at start — usually an email address — while the log carries
/// whatever each note signed itself with. The file is asked first because it
/// was written by the run itself; the log is the fallback for a session that
/// only ever existed as work.
fn developer_of(row: &Row) -> Option<String> {
    let recorded = row
        .recorded
        .as_ref()
        .and_then(|s| s.developer_handle.as_deref().or(s.developer.as_deref()));
    let derived = row
        .derived
        .as_ref()
        .and_then(|d| d.developer_handle.as_deref().or(d.developer.as_deref()));
    recorded
        .or(derived)
        .map(person)
        .filter(|d| !d.is_empty())
}

/// One person, spelled one way.
///
/// The same human arrives as three strings — a handle from the session file,
/// a git email from the log, and sometimes a full name — and a listing that
/// prints each as it finds it reads like three colleagues. An address is
/// reduced to its local part, which is the handle in every convention this
/// product uses (the team manifest derives the handle exactly this way), and
/// that is also what gets printed: a terminal roster is no place for
/// somebody's email address.
fn person(raw: &str) -> String {
    let trimmed = raw.trim();
    match trimmed.split_once('@') {
        Some((local, _)) => local.trim().to_string(),
        None => trimmed.to_string(),
    }
}

/// Whether the listing should name the person on each row.
///
/// `.aura/intent_log.jsonl` is committed, so a shared repository's log holds
/// everybody's rows and this listing will happily show a colleague's session
/// next to yours with nothing to tell them apart. On a repository with one
/// person in it, printing that person's name twenty times is noise nobody
/// reads. So the name appears exactly when there is a second one to tell it
/// from — the same "quiet unless it means something" rule the radar uses.
fn people_worth_naming(rows: &[Row]) -> bool {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for row in rows {
        if let Some(who) = developer_of(row) {
            seen.insert(who.to_lowercase());
            if seen.len() > 1 {
                return true;
            }
        }
    }
    false
}

fn print_row(row: &Row, name_people: bool) {
    let (id, agent, files, checkpoints, branch, model, tokens) = match &row.recorded {
        Some(s) => (
            s.session_id.clone(),
            // `hook_auto` names the mechanism that logged the row, not the
            // agent that did the work — it reaches session files by the same
            // route it reaches the log. The work log usually knows the real
            // name, because some other row in the same session said it.
            if sessions_from_intents::names_an_agent(&s.agent_id) {
                s.agent_id.clone()
            } else {
                row.derived
                    .as_ref()
                    .map(|d| d.agent.clone())
                    .unwrap_or_default()
            },
            s.files_touched
                .len()
                .max(row.derived.as_ref().map(|d| d.files.len()).unwrap_or(0)),
            s.checkpoint_count,
            s.branch.clone(),
            s.model_name.clone(),
            s.token_usage.as_ref().map(|u| u.total()).unwrap_or(0),
        ),
        None => {
            let d = row.derived.as_ref().expect("a row comes from one source or the other");
            (d.session_id.clone(), d.agent.clone(), d.files.len(), 0, None, None, 0)
        }
    };

    let agent = if agent.trim().is_empty() {
        "an agent".to_string()
    } else {
        agent
    };
    // Whose work it was, when the log holds more than one person's.
    let who_str = match developer_of(row).filter(|_| name_people) {
        Some(who) => format!(" for {}", who.magenta()),
        None => String::new(),
    };
    let token_str = if tokens > 0 {
        format!(" | {}k tokens", tokens / 1000)
    } else {
        String::new()
    };

    // A session recorded only as work has no branch to report — the log
    // rows carry none. Printing "on ?" for it invites a hunt for a setting
    // that would fill it in; saying nothing is the honest shape.
    let where_str = match branch.as_deref().filter(|b| !b.is_empty()) {
        Some(b) => format!(" on {}", b.yellow()),
        None => String::new(),
    };
    println!(
        "  {} {} [{}] — {}{}{} ({} files, {} checkpoints{})",
        "●".cyan(),
        id.bold(),
        row.liveness.label(),
        agent.cyan(),
        who_str,
        where_str,
        files,
        checkpoints,
        token_str.dimmed(),
    );

    if let Some(model) = model.filter(|m| !m.is_empty()) {
        println!("    {} model: {}", "↳".dimmed(), model.dimmed());
    }

    // What the session set out to do. The app records the prompt it was given;
    // for a terminal-only session the log's own objective is the nearest true
    // equivalent, and is chosen by the same rule the console uses.
    let stated = row
        .recorded
        .as_ref()
        .and_then(|s| s.first_prompt.clone())
        .or_else(|| {
            row.derived
                .as_ref()
                .map(|d| d.objective.clone())
                .filter(|o| !o.is_empty())
        });
    if let Some(text) = stated {
        let display: String = text.chars().take(80).collect();
        println!("    {} \"{}\"", "↳".dimmed(), display.italic().dimmed());
    }

    if let Some(summary) = row.recorded.as_ref().and_then(|s| s.summary.as_ref()) {
        println!("    {} {}", "↳".dimmed(), summary.outcome.dimmed());
    }

    if let Some(subagents) = row
        .recorded
        .as_ref()
        .map(|s| &s.subagents)
        .filter(|s| !s.is_empty())
    {
        println!(
            "    {} subagents: {}",
            "↳".dimmed(),
            subagents
                .iter()
                .map(|s| format!(
                    "{}({})",
                    s.agent_type,
                    if s.ended_at.is_some() { "done" } else { "running" }
                ))
                .collect::<Vec<_>>()
                .join(", ")
                .dimmed()
        );
    }

    // Said once per row that has no file behind it, because the difference is
    // load-bearing: there are no token counts and no model for this session,
    // and that is a property of how it was recorded rather than of the work.
    if row.recorded.is_none() {
        if let Some(d) = &row.derived {
            println!(
                "    {} from {} logged step{} — no app or account was involved",
                "↳".dimmed(),
                d.rows,
                if d.rows == 1 { "" } else { "s" }
            );
        }
    }
}

/// Run the command. `prune` removes ended sessions instead of only listing.
pub fn run(prune: bool) {
    println!(
        "\n{} {}\n",
        crate::a11y_label("📋", "SESSIONS"),
        "Aura Agent Sessions".bold().cyan()
    );

    // Listing is a read. It used to call `cleanup_stale` here and print the
    // count, so someone auditing the repo lost ten sessions and their
    // transcripts to a command whose whole job is to show them what is there.
    // The prune still exists — it is now the thing you ask for.
    if prune {
        let cleaned = SessionManager::cleanup_stale(session::STALE_SESSION_DAYS);
        println!(
            "  {} Removed {} ended session(s) older than {} days.\n",
            "🧹".dimmed(),
            cleaned,
            session::STALE_SESSION_DAYS
        );
    } else {
        let stale = SessionManager::stale_sessions(session::STALE_SESSION_DAYS).len();
        if stale > 0 {
            println!(
                "  {} {} ended session(s) older than {} days are still on disk — remove them with {}\n",
                "🧹".dimmed(),
                stale,
                session::STALE_SESSION_DAYS,
                "aura sessions --prune".cyan()
            );
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let derived = crate::worktree::paths::checkout_root()
        .map(|root| sessions_from_intents::from_log(&root))
        .unwrap_or_default();
    let all = rows(SessionManager::list_sessions(), derived, now);

    if all.is_empty() {
        println!("  {} No sessions recorded yet.", "↳".dimmed());
        println!(
            "  {} A session appears here as soon as an agent does something in this repository — {} is enough, no account needed.",
            "↳".dimmed(),
            "aura init".cyan()
        );
        return;
    }

    let shown = all.len().min(20);
    let name_people = people_worth_naming(&all);
    for row in all.iter().take(shown) {
        print_row(row, name_people);
    }
    if all.len() > shown {
        println!(
            "\n  {} {} more, not shown.",
            "↳".dimmed(),
            all.len() - shown
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded(id: &str, phase: SessionPhase, last: u64, pid: Option<u32>) -> AgentSession {
        AgentSession {
            session_id: id.to_string(),
            agent_id: "Claude".to_string(),
            phase,
            started_at: last.saturating_sub(60),
            last_activity: last,
            files_touched: vec![],
            checkpoint_count: 0,
            base_commit: None,
            worktree: None,
            token_usage: None,
            summary: None,
            model_name: None,
            branch: None,
            first_prompt: None,
            subagents: vec![],
            pid,
            project: None,
            developer: None,
            developer_handle: None,
            scope: None,
        }
    }

    fn derived_by(id: &str, last: u64, who: &str) -> DerivedSession {
        sessions_from_intents::fold(vec![serde_json::json!({
            "session_id": id, "timestamp": last, "intent": "did a thing",
            "agent_id": "Claude", "developer": who
        })])
        .remove(0)
    }

    #[test]
    fn one_persons_repository_is_not_told_whose_sessions_these_are() {
        // The log is committed, so a shared repo's listing mixes people. A
        // solo repo does not, and twenty rows reading "for me" is noise.
        let rows = rows(vec![], vec![derived_by("a", 100, "ashiq"), derived_by("b", 200, "ashiq")], 300);
        assert!(!people_worth_naming(&rows));
    }

    #[test]
    fn one_person_spelled_two_ways_is_still_one_person() {
        // The session file stamps a git email and the log carries a handle.
        // Read literally that is two names, and every row in a one-person
        // repository grew a "for" clause claiming otherwise.
        let mut file = recorded("a", SessionPhase::Ended, 100, None);
        file.developer = Some("ashiq@example.com".to_string());
        let rows = rows(vec![file], vec![derived_by("b", 200, "ashiq")], 300);
        assert!(!people_worth_naming(&rows));
    }

    #[test]
    fn an_address_is_printed_as_a_handle_and_not_as_an_address() {
        let mut file = recorded("a", SessionPhase::Ended, 100, None);
        file.developer = Some("Mira.Osei@staging.local".to_string());
        let rows = rows(vec![file], vec![], 300);
        assert_eq!(developer_of(&rows[0]).as_deref(), Some("Mira.Osei"));
    }

    #[test]
    fn a_second_person_in_the_log_puts_names_on_every_row() {
        let rows = rows(
            vec![],
            vec![derived_by("a", 100, "ashiq"), derived_by("b", 200, "mira-osei")],
            300,
        );
        assert!(people_worth_naming(&rows));
        assert_eq!(developer_of(&rows[0]).as_deref(), Some("mira-osei"));
    }

    #[test]
    fn a_recorded_session_answers_before_the_log_does() {
        // The file stamped the identity the run started under; the log holds
        // whatever each note signed. The run's own answer wins.
        let mut file = recorded("a", SessionPhase::Ended, 100, None);
        file.developer_handle = Some("mhask".to_string());
        let rows = rows(vec![file], vec![derived_by("a", 100, "someone-else")], 300);
        assert_eq!(developer_of(&rows[0]).as_deref(), Some("mhask"));
    }

    #[test]
    fn a_log_that_signed_both_ways_is_read_as_the_handle() {
        // The same rows carry `developer` (a git email) and
        // `developer_handle` (the login). A session with no file of its own
        // has to answer from the log alone, and reading only the address made
        // it "mira" where its recorded sibling said "mira-osei".
        let derived = sessions_from_intents::fold(vec![serde_json::json!({
            "session_id": "a", "timestamp": 100, "intent": "did a thing",
            "agent_id": "Claude", "developer": "mira@staging.local",
            "developer_handle": "mira-osei"
        })]);
        let rows = rows(vec![], derived, 300);
        assert_eq!(developer_of(&rows[0]).as_deref(), Some("mira-osei"));
    }

    #[test]
    fn a_session_that_signed_nothing_names_nobody() {
        let rows = rows(vec![recorded("a", SessionPhase::Ended, 100, None)], vec![], 300);
        assert_eq!(developer_of(&rows[0]), None::<String>);
        assert!(!people_worth_naming(&rows));
    }

    fn derived_one(id: &str, last: u64) -> DerivedSession {
        sessions_from_intents::fold(vec![serde_json::json!({
            "session_id": id, "timestamp": last, "intent": "did a thing", "agent_id": "Claude"
        })])
        .remove(0)
    }

    #[test]
    fn a_session_whose_process_is_gone_stops_claiming_to_be_active() {
        let s = recorded("s1", SessionPhase::Active, 1_000, None);
        assert_eq!(liveness_of(&s, false, 1_000 + QUIET_SECS + 1), Liveness::Over);
    }

    #[test]
    fn a_session_that_paused_a_minute_ago_is_not_declared_over() {
        let s = recorded("s1", SessionPhase::Active, 1_000, None);
        assert_eq!(liveness_of(&s, false, 1_060), Liveness::Paused);
    }

    #[test]
    fn a_running_process_is_active_however_long_it_has_been_thinking() {
        let s = recorded("s1", SessionPhase::Active, 1_000, Some(1));
        assert_eq!(
            liveness_of(&s, true, 1_000 + QUIET_SECS * 10),
            Liveness::Running
        );
    }

    #[test]
    fn an_ended_session_is_believed() {
        // Written on the way out, so it means what it says even if a process
        // with that pid has since been recycled.
        let s = recorded("s1", SessionPhase::Ended, 1_000, Some(1));
        assert_eq!(liveness_of(&s, true, 1_001), Liveness::Over);
    }

    #[test]
    fn one_session_recorded_in_both_places_is_one_row() {
        let out = rows(
            vec![recorded("s1", SessionPhase::Active, 1_000, None)],
            vec![derived_one("s1", 2_000)],
            3_000,
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].recorded.is_some() && out[0].derived.is_some());
        // The log kept growing after the app stopped writing the file.
        assert_eq!(out[0].last, 2_000);
    }

    #[test]
    fn work_logged_after_the_file_went_quiet_keeps_the_session_alive() {
        let out = rows(
            vec![recorded("s1", SessionPhase::Active, 1_000, None)],
            vec![derived_one("s1", 10_000)],
            10_060,
        );
        assert_eq!(out[0].liveness, Liveness::Paused);
    }

    #[test]
    fn a_terminal_only_session_gets_a_row_of_its_own() {
        let out = rows(vec![], vec![derived_one("s1", 1_000)], 1_060);
        assert_eq!(out.len(), 1);
        assert!(out[0].recorded.is_none());
        assert_eq!(out[0].liveness, Liveness::Paused);
    }

    #[test]
    fn rows_are_newest_first_whichever_source_they_came_from() {
        let out = rows(
            vec![recorded("file-only", SessionPhase::Ended, 5_000, None)],
            vec![derived_one("log-only", 9_000)],
            9_060,
        );
        assert_eq!(out[0].derived.as_ref().unwrap().session_id, "log-only");
        assert_eq!(out[1].recorded.as_ref().unwrap().session_id, "file-only");
    }
}
