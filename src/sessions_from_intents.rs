//! The sessions a terminal actually had, read back out of the work log.
//!
//! # What was broken
//!
//! `aura sessions` listed the contents of `.aura/sessions/` and nothing else.
//! That directory is written by the desktop app and by `aura usage-record`,
//! so somebody who installed the CLI, ran `aura init`, and then worked with
//! an agent in a terminal for an afternoon was told:
//!
//! ```text
//! ↳ No sessions recorded yet.
//! ↳ Sessions are created when AI agents work in this repository.
//! ```
//!
//! — while `.aura/intent_log.jsonl` held six thousand rows of that agent
//! working in that repository. The second line is the part that stings: it
//! states the exact thing that just happened as the condition that did not
//! happen, so the reasonable conclusion is that Aura is not recording, and
//! the reasonable next step is to go looking for the setup that must be
//! missing. There is none. The work was recorded; the listing was reading one
//! of the two places it lands.
//!
//! The cloud already knew this. `POST /api/v2/intents` folds the same rows
//! into session rows so the console can show a session nobody heartbeated
//! (`aura-cloud/src/live.rs`). The terminal is where those rows are written
//! and was the one surface that could not see them, and only because it was
//! the surface with no account.
//!
//! # What this does
//!
//! Folds the log into one record per `session_id` by the same rules the
//! server uses, so a session is named the same thing in a terminal and in the
//! console:
//!
//! * the objective prefers a sentence a person wrote over a hook capture, and
//!   only then prefers the earlier of two rows of the same kind — see
//!   [`aura_intent_grammar`], which both sides share for exactly this reason
//! * `hook_auto` and `unknown` do not name an agent (they are `log-intent`'s
//!   default `--source`, i.e. the mechanism, not the worker)
//! * a session began at the earliest thing that happened in it and last did
//!   something at the latest, whatever order the rows sit in
//!
//! Nothing here writes. A listing that repaired the record would be a command
//! whose whole job is to show you what is there, quietly changing it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// How long a session may sit quiet before the listing stops calling it live.
///
/// The same thirty minutes the server uses (`live::CLI_SESSION_IDLE_MINUTES`),
/// so a session does not read as finished in one place and running in the
/// other. Long enough that reading, thinking and a slow build do not end a
/// session somebody is still in the middle of.
pub const QUIET_SECS: u64 = 30 * 60;

/// One session, as the log describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedSession {
    pub session_id: String,
    /// The agent that did the work, or empty when no row named one.
    pub agent: String,
    /// What the session set out to do.
    pub objective: String,
    /// Whether [`Self::objective`] came from a written sentence. A written one
    /// is never displaced by a mechanical row, however much earlier that row
    /// turns out to be.
    pub objective_written: bool,
    /// When the row that supplied the objective was logged, so an earlier row
    /// of the same kind can still replace it.
    objective_at: u64,
    pub first: u64,
    pub last: u64,
    pub files: BTreeSet<String>,
    /// How many rows folded into this — the honest size of the evidence.
    pub rows: usize,
    /// Who signed the rows, as they signed them. Two fields because the log
    /// carries both spellings: `developer` is a git identity and is usually an
    /// email address, `developer_handle` is the login. A reader that only kept
    /// the first names the same person differently depending on whether their
    /// session also wrote a session file, which is how one colleague becomes
    /// two in a listing.
    pub developer: Option<String>,
    pub developer_handle: Option<String>,
}

impl DerivedSession {
    /// Quiet long enough that nothing is likely still running.
    pub fn is_finished(&self, now: u64) -> bool {
        now.saturating_sub(self.last) > QUIET_SECS
    }
}

/// Whether a value in an intent row's `agent_id` actually names an agent.
///
/// It does not always. `aura log-intent` defaults the field to its own
/// `--source`, so a row written by a hook arrives claiming the agent is
/// `hook_auto` — the name of the mechanism that logged it, not of the agent
/// that did the work. One of those folding into a session was enough to
/// relabel it, so a session that read "Claude" all afternoon became
/// "hook_auto" the moment a hook fired.
///
/// Public because the same names reach a session *file*: the desktop's
/// tool-use listener writes one, and it stamps the same default.
pub fn names_an_agent(agent: &str) -> bool {
    !matches!(agent.trim(), "" | "hook_auto" | "unknown")
}

/// Every file a row says it touched: the single `file` column and the
/// `writes_paths` list a `--writes` log carries.
fn files_of(row: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(f) = row["file"].as_str().map(str::trim).filter(|f| !f.is_empty()) {
        out.push(f.to_string());
    }
    if let Some(list) = row["writes_paths"].as_array() {
        out.extend(
            list.iter()
                .filter_map(|p| p.as_str())
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_string),
        );
    }
    out
}

/// Fold parsed log rows into one record per session, newest session first.
///
/// Rows with no `session_id` are skipped rather than pooled: they cannot be
/// attributed to a sitting, and inventing a bucket for them would put a row
/// from last March in the same "session" as one from this morning.
pub fn fold(rows: impl IntoIterator<Item = serde_json::Value>) -> Vec<DerivedSession> {
    let mut by_id: BTreeMap<String, DerivedSession> = BTreeMap::new();

    for row in rows {
        let Some(id) = row["session_id"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let at = row["timestamp"].as_u64().unwrap_or(0);
        if at == 0 {
            // A row with no clock cannot say when a session began or ended,
            // and a zero would claim 1970 in both.
            continue;
        }
        let text = row["intent"].as_str().unwrap_or("").trim().to_string();
        let agent = row["agent_id"].as_str().unwrap_or("").to_string();
        let file = row["file"].as_str().map(str::trim).filter(|f| !f.is_empty());
        let written = aura_intent_grammar::is_written_by_a_person(&text, file);
        let developer = row["developer"]
            .as_str()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string);
        let developer_handle = row["developer_handle"]
            .as_str()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string);
        let touched = files_of(&row);

        match by_id.get_mut(id) {
            None => {
                by_id.insert(
                    id.to_string(),
                    DerivedSession {
                        session_id: id.to_string(),
                        agent: if names_an_agent(&agent) { agent } else { String::new() },
                        objective: text,
                        objective_written: written,
                        objective_at: at,
                        first: at,
                        last: at,
                        files: touched.into_iter().collect(),
                        rows: 1,
                        developer,
                        developer_handle,
                    },
                );
            }
            Some(session) => {
                session.rows += 1;
                session.first = session.first.min(at);
                session.last = session.last.max(at);
                session.files.extend(touched);
                if session.agent.is_empty() && names_an_agent(&agent) {
                    session.agent = agent;
                }
                if session.developer.is_none() {
                    session.developer = developer;
                }
                if session.developer_handle.is_none() {
                    session.developer_handle = developer_handle;
                }
                // Prefer a sentence over a hook capture; only between two rows
                // of the same kind does the earlier one win. Without the first
                // half of that rule the objective is whatever the agent's very
                // first tool call happened to be, which is how sessions came to
                // be called "Claude Bash: cd ...".
                let better = match (written, session.objective_written) {
                    (true, false) => true,
                    (false, true) => false,
                    _ => at < session.objective_at,
                };
                if better && !text.is_empty() {
                    session.objective = text;
                    session.objective_written = written;
                    session.objective_at = at;
                }
            }
        }
    }

    let mut out: Vec<DerivedSession> = by_id.into_values().collect();
    out.sort_by(|a, b| b.last.cmp(&a.last));
    out
}

/// Read and fold `<checkout>/.aura/intent_log.jsonl`.
///
/// Best effort by design: a missing log is a repo where nobody has logged
/// intent yet, and an unparseable line is one interleaved write, neither of
/// which is a reason to refuse to list the sessions that did survive.
pub fn from_log(checkout_root: &Path) -> Vec<DerivedSession> {
    let path = checkout_root
        .join(".aura")
        .join(crate::intent_log::FILE_NAME);
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    fold(
        body.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, at: u64, intent: &str, agent: &str) -> serde_json::Value {
        serde_json::json!({
            "session_id": id, "timestamp": at, "intent": intent, "agent_id": agent
        })
    }

    #[test]
    fn a_terminal_only_session_is_visible_without_a_session_file() {
        let out = fold(vec![
            row("s1", 100, "Claude Bash: git status", "Claude"),
            row("s1", 160, "Claude Edit on src/a.rs", "Claude"),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id, "s1");
        assert_eq!(out[0].rows, 2);
        assert_eq!(out[0].first, 100);
        assert_eq!(out[0].last, 160);
    }

    #[test]
    fn the_objective_is_the_sentence_not_the_first_tool_call() {
        // The hook capture is earlier. It still loses.
        let out = fold(vec![
            row("s1", 100, "Claude Bash: cd /repo && ls", "Claude"),
            row("s1", 200, "Switch retry to exponential backoff so we stop tripping the limit", "Claude"),
            row("s1", 300, "Claude Edit on src/retry.rs", "Claude"),
        ]);
        assert_eq!(
            out[0].objective,
            "Switch retry to exponential backoff so we stop tripping the limit"
        );
        assert!(out[0].objective_written);
    }

    #[test]
    fn between_two_sentences_the_earlier_one_is_the_objective() {
        let out = fold(vec![
            row("s1", 300, "Then rename the module", "Claude"),
            row("s1", 200, "Rebuild the Changes pane to match the desktop", "Claude"),
        ]);
        assert_eq!(out[0].objective, "Rebuild the Changes pane to match the desktop");
    }

    #[test]
    fn a_hook_does_not_get_to_rename_the_agent() {
        let out = fold(vec![
            row("s1", 100, "Claude Edit on src/a.rs", "Claude"),
            row("s1", 200, "ran Bash on ls", "hook_auto"),
        ]);
        assert_eq!(out[0].agent, "Claude");
    }

    #[test]
    fn an_agent_named_only_by_a_later_row_is_still_the_agent() {
        let out = fold(vec![
            row("s1", 100, "ran Bash on ls", "hook_auto"),
            row("s1", 200, "Codex Edit on src/a.rs", "Codex"),
        ]);
        assert_eq!(out[0].agent, "Codex");
    }

    #[test]
    fn rows_that_cannot_be_attributed_are_skipped_not_pooled() {
        let out = fold(vec![
            serde_json::json!({"timestamp": 100, "intent": "no session id"}),
            row("s1", 200, "did a thing", "Claude"),
            serde_json::json!({"session_id": "s2", "intent": "no clock"}),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id, "s1");
    }

    #[test]
    fn files_come_from_both_the_single_column_and_the_writes_list() {
        let out = fold(vec![
            serde_json::json!({
                "session_id": "s1", "timestamp": 100, "intent": "x", "agent_id": "Claude",
                "file": "src/a.rs"
            }),
            serde_json::json!({
                "session_id": "s1", "timestamp": 200, "intent": "y", "agent_id": "Claude",
                "writes_paths": ["src/b.rs", "src/a.rs", ""]
            }),
        ]);
        let files: Vec<&String> = out[0].files.iter().collect();
        assert_eq!(files, vec!["src/a.rs", "src/b.rs"]);
    }

    #[test]
    fn sessions_come_back_newest_last_activity_first() {
        let out = fold(vec![
            row("old", 100, "a", "Claude"),
            row("new", 900, "b", "Claude"),
            row("old", 200, "c", "Claude"),
        ]);
        assert_eq!(out[0].session_id, "new");
        assert_eq!(out[1].session_id, "old");
    }

    #[test]
    fn a_session_quiet_for_an_hour_is_finished() {
        let out = fold(vec![row("s1", 1_000, "a", "Claude")]);
        assert!(!out[0].is_finished(1_000 + QUIET_SECS));
        assert!(out[0].is_finished(1_000 + QUIET_SECS + 1));
    }

    #[test]
    fn a_missing_log_is_no_sessions_rather_than_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(from_log(dir.path()).is_empty());
    }

    #[test]
    fn a_torn_line_does_not_cost_the_rows_around_it() {
        let dir = tempfile::tempdir().unwrap();
        let aura = dir.path().join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        std::fs::write(
            aura.join(crate::intent_log::FILE_NAME),
            "{\"session_id\":\"s1\",\"timestamp\":100,\"intent\":\"a\",\"agent_id\":\"Claude\"}\n\
             {{\"session_idsession_id\"::torn\n\
             {\"session_id\":\"s1\",\"timestamp\":200,\"intent\":\"b\",\"agent_id\":\"Claude\"}\n",
        )
        .unwrap();
        let out = from_log(dir.path());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rows, 2);
    }
}
