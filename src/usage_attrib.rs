//! Measured tokens, attributed to the sessions that spent them.
//!
//! `aura usage` reported `$0.0000` and `0 in / 0 out` across seventy-six
//! sessions, on a machine that had spent a hundred dollars that day. The
//! numbers were on disk the whole time: Claude Code writes every turn's usage
//! into `~/.claude/projects/*/*.jsonl`, and [`crate::plan_tracker`] has read
//! that file for as long as `aura usage --plan` has existed. What was missing
//! was the join. The session records under `~/.aura/usage/` carry a
//! `token_usage` block that nothing ever filled in —
//! `SessionTracker::sync_tokens_from_transcript` was written to fill it and had
//! not one caller in the tree — so the headline cost command answered zero
//! while the file next to it said otherwise. A confident zero is the worst
//! number a cost report can print.
//!
//! ## The join
//!
//! A session record knows the directory it ran in and the window it was alive
//! for. A transcript message knows its own timestamp, and lives in a directory
//! named after the working directory it was typed in. That is enough to join
//! the two without guessing.
//!
//! ## One message, one session
//!
//! A turn belongs to the session that was most recently *started* in that
//! directory when the turn happened — the latest `started_at` at or before the
//! turn's timestamp.
//!
//! The obvious rule, "the turn falls inside the session's window", was tried
//! first and attributed almost nothing: a session's `last_activity` only
//! advances when something calls into Aura, so a record on this machine
//! routinely spans a second or two while the work it covers ran for an hour.
//! Closing the window against a field that stops moving would have reported
//! 98% of real spend as belonging to nobody. Where a session ends is not
//! recorded anywhere reliable; where the next one begins is, so that is what
//! the boundary is drawn on.
//!
//! Either way a turn is claimed by **at most one** session, which is the
//! property a cost report needs: the sum over sessions can never exceed what
//! the provider actually recorded.
//!
//! What no session claims — a turn in a directory before any session started
//! there — is reported as unattributed rather than dropped. Work happens
//! outside Aura sessions, and a report that silently discarded it would
//! understate spend in exactly the way this module exists to stop.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::session::{AgentSession, TokenUsage};

/// What the provider recorded, and how much of it belongs to which session.
#[derive(Debug, Default, Clone)]
pub struct Attribution {
    /// Per `session_id`, the measured usage that session is responsible for.
    pub by_session: HashMap<String, TokenUsage>,
    /// The model each session spent the most output tokens on, for sessions
    /// whose own record never named one.
    pub model_by_session: HashMap<String, String>,
    /// Measured usage in the window that no session claimed.
    pub unattributed: TokenUsage,
    /// Everything the provider recorded in the window, attributed or not.
    pub measured: TokenUsage,
    /// The same measured total, split by the model that spent it.
    ///
    /// Tokens alone cannot be priced: an opus token costs five times a
    /// sonnet one. Without this split the report could say how much
    /// usage it failed to attribute but not what that usage cost, which
    /// is the only form of the question anyone asks.
    pub measured_by_model: HashMap<String, TokenUsage>,
}

/// One assistant turn, as the provider recorded it.
#[derive(Debug, Clone)]
struct Turn {
    at: u64,
    model: String,
    usage: TokenUsage,
}

fn add(into: &mut TokenUsage, from: &TokenUsage) {
    into.input_tokens += from.input_tokens;
    into.output_tokens += from.output_tokens;
    into.cache_read_tokens += from.cache_read_tokens;
    into.cache_creation_tokens += from.cache_creation_tokens;
    into.api_call_count += from.api_call_count;
}

fn claude_projects_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(home).join(".claude").join("projects");
    dir.is_dir().then_some(dir)
}

/// Every assistant turn recorded in one transcript directory since `since`.
///
/// Claude Code names each directory after the working directory with every
/// non-alphanumeric byte replaced, which is the encoding
/// [`crate::history::claude_dir_name`] already implements — the same function
/// the history reader uses, so the two can never disagree about which folder
/// belongs to which checkout.
fn turns_in(dir: &PathBuf, since: u64) -> Vec<Turn> {
    let mut turns = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return turns;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
            continue;
        }
        for (at, model, input, output, cache_read, cache_create) in
            crate::plan_tracker::parse_transcript(&path, since)
        {
            turns.push(Turn {
                at,
                model,
                usage: TokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cache_read,
                    cache_creation_tokens: cache_create,
                    api_call_count: 1,
                },
            });
        }
    }
    turns
}

/// Join the provider's measured turns onto the sessions that ran them.
///
/// `since` is the start of the reporting window in unix seconds; turns before
/// it are not read at all.
///
/// The transcript root is a parameter rather than a lookup so this can be
/// exercised against a directory a test builds. Reading `$HOME` from inside
/// would make the result depend on the machine the suite happens to run on,
/// which is not a property a cost calculation should have.
fn attribute_in(
    projects: Option<PathBuf>,
    sessions: &[AgentSession],
    since: u64,
) -> Attribution {
    let mut out = Attribution::default();

    // Sessions grouped by the transcript folder they ran in.
    let mut by_dir: HashMap<String, Vec<&AgentSession>> = HashMap::new();
    for session in sessions {
        let Some(cwd) = session.worktree.as_deref() else {
            continue;
        };
        by_dir
            .entry(crate::history::claude_dir_name(cwd))
            .or_default()
            .push(session);
    }
    for group in by_dir.values_mut() {
        // Newest start first, so the first session that had already begun when
        // a turn happened is the one driving it.
        group.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    }

    // Output tokens per (session, model), so a session that never recorded its
    // own model can be told which one it actually spent on.
    let mut model_spend: HashMap<String, HashMap<String, u64>> = HashMap::new();

    // Every transcript folder is read, not only the ones a session ran in.
    // Reading only the folders with sessions would hide real spend behind the
    // same silence this module exists to break: it would not be attributed and
    // it would not be reported either, it would simply never be looked at.
    let Some(projects) = projects else {
        return out;
    };
    let Ok(folders) = std::fs::read_dir(&projects) else {
        return out;
    };
    let empty: Vec<&AgentSession> = Vec::new();
    for folder in folders.flatten() {
        let dir = folder.path();
        if !dir.is_dir() {
            continue;
        }
        let group = dir
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|name| by_dir.get(name))
            .unwrap_or(&empty);

        for turn in turns_in(&dir, since) {
            add(&mut out.measured, &turn.usage);
            let model = if turn.model.is_empty() {
                "unknown".to_string()
            } else {
                turn.model.clone()
            };
            add(out.measured_by_model.entry(model).or_default(), &turn.usage);
            let owner = group.iter().find(|s| turn.at >= s.started_at);
            match owner {
                Some(session) => {
                    add(
                        out.by_session.entry(session.session_id.clone()).or_default(),
                        &turn.usage,
                    );
                    if !turn.model.is_empty() {
                        *model_spend
                            .entry(session.session_id.clone())
                            .or_default()
                            .entry(turn.model.clone())
                            .or_default() += turn.usage.output_tokens;
                    }
                }
                None => add(&mut out.unattributed, &turn.usage),
            }
        }
    }

    for (session_id, models) in model_spend {
        if let Some((model, _)) = models.into_iter().max_by_key(|(_, spent)| *spent) {
            out.model_by_session.insert(session_id, model);
        }
    }

    out
}

/// Fill in what the sessions never recorded about themselves.
///
/// Only an empty block is filled: a session that genuinely carries its own
/// counts — one that came from an agent which reports them — keeps them, and
/// the measured join never overwrites a first-hand number with a joined one.
pub fn fill(sessions: &mut [AgentSession], since: u64) -> Attribution {
    fill_in(claude_projects_dir(), sessions, since)
}

/// [`fill`] against a given transcript root — see [`attribute_in`] for why the
/// root is passed in rather than looked up.
fn fill_in(projects: Option<PathBuf>, sessions: &mut [AgentSession], since: u64) -> Attribution {
    let attribution = attribute_in(projects, sessions, since);
    for session in sessions.iter_mut() {
        let empty = session
            .token_usage
            .as_ref()
            .map(|u| u.total() == 0 && u.cache_read_tokens == 0)
            .unwrap_or(true);
        if !empty {
            continue;
        }
        if let Some(measured) = attribution.by_session.get(&session.session_id) {
            session.token_usage = Some(measured.clone());
        }
        if session.model_name.is_none() {
            if let Some(model) = attribution.model_by_session.get(&session.session_id) {
                session.model_name = Some(model.clone());
            }
        }
    }
    attribution
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built the way the store builds one — from the JSON a session record
    /// actually is on disk, so the test cannot drift from the real shape.
    fn session(id: &str, cwd: &str, from: u64, to: u64) -> AgentSession {
        serde_json::from_value(serde_json::json!({
            "session_id": id,
            "agent_id": "claude",
            "phase": "Active",
            "started_at": from,
            "last_activity": to,
            "files_touched": [],
            "checkpoint_count": 0,
            "base_commit": null,
            "worktree": cwd,
            "token_usage": {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_creation_tokens": 0,
                "api_call_count": 0
            }
        }))
        .expect("a session record")
    }

    /// One assistant turn as Claude Code writes it into a transcript.
    fn turn(at: u64, model: &str, input: u64, output: u64) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": at,
            "message": {
                "model": model,
                "usage": { "input_tokens": input, "output_tokens": output }
            }
        })
        .to_string()
    }

    /// A transcript root holding one session file for `cwd`, in the folder
    /// Claude Code would name for that directory.
    fn projects(cwd: &str, turns: &[String]) -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = root.path().join(crate::history::claude_dir_name(cwd));
        std::fs::create_dir_all(&dir).expect("transcript folder");
        std::fs::write(dir.join("a.jsonl"), turns.join("\n")).expect("transcript");
        root
    }

    /// Run the real join over that root, so what is under test is the code
    /// `aura usage` calls and not a second copy of the ownership rule.
    fn assign(
        sessions: &[AgentSession],
        cwd: &str,
        turns: &[String],
    ) -> (HashMap<String, TokenUsage>, TokenUsage) {
        let root = projects(cwd, turns);
        let out = attribute_in(Some(root.path().to_path_buf()), sessions, 0);
        (out.by_session, out.unattributed)
    }

    #[test]
    fn measured_usage_is_split_by_model_so_it_can_be_priced() {
        // Two models in one window. Totalling their tokens together and
        // pricing the sum at one rate is how a report ends up off by a
        // factor of five, so the split is kept from the start.
        let root = projects(
            "/repo",
            &[
                turn(150, "claude-opus-5", 1_000, 40),
                turn(160, "claude-sonnet-4", 2_000, 60),
                turn(170, "claude-opus-5", 500, 10),
            ],
        );
        let out = attribute_in(Some(root.path().to_path_buf()), &[], 0);

        assert_eq!(out.measured_by_model["claude-opus-5"].input_tokens, 1_500);
        assert_eq!(out.measured_by_model["claude-opus-5"].output_tokens, 50);
        assert_eq!(out.measured_by_model["claude-sonnet-4"].input_tokens, 2_000);
        // The split must still add back up to the measured total.
        let summed: u64 = out.measured_by_model.values().map(|u| u.total()).sum();
        assert_eq!(summed, out.measured.total());
    }

    #[test]
    fn a_turn_with_no_model_recorded_is_kept_under_a_name_rather_than_dropped() {
        let root = projects("/repo", &[turn(150, "", 800, 20)]);
        let out = attribute_in(Some(root.path().to_path_buf()), &[], 0);

        assert_eq!(out.measured_by_model["unknown"].input_tokens, 800);
        assert_eq!(out.measured.input_tokens, 800);
    }

    #[test]
    fn a_turn_inside_one_session_belongs_to_it() {
        let sessions = vec![session("s1", "/repo", 100, 200)];
        let (owned, loose) = assign(&sessions, "/repo", &[turn(150, "opus", 900, 30)]);

        assert_eq!(owned["s1"].input_tokens, 900);
        assert_eq!(owned["s1"].output_tokens, 30);
        assert_eq!(loose.total(), 0);
    }

    #[test]
    fn two_sessions_in_one_checkout_split_the_spend_instead_of_both_claiming_it() {
        // `first` began, then `second` began in the same directory. Every turn
        // goes to whichever had most recently started when it happened.
        let sessions = vec![
            session("first", "/repo", 100, 400),
            session("second", "/repo", 200, 300),
        ];
        let turns = [
            turn(150, "opus", 100, 10),
            turn(250, "opus", 100, 10),
            turn(350, "opus", 100, 10),
        ];

        let (owned, loose) = assign(&sessions, "/repo", &turns);

        assert_eq!(owned["first"].api_call_count, 1, "the turn before the second began");
        assert_eq!(owned["second"].api_call_count, 2, "and both after it");
        assert_eq!(loose.total(), 0);
        let claimed: u64 = owned.values().map(|u| u.total()).sum();
        assert_eq!(claimed, 330, "no token is counted twice");
    }

    #[test]
    fn a_turn_after_a_session_stopped_reporting_activity_is_still_its_own() {
        // `last_activity` on a real record often stops a second after the
        // session starts. Attributing on that field reported almost every real
        // token as belonging to nobody, so it is deliberately not consulted.
        let sessions = vec![session("s1", "/repo", 100, 101)];

        let (owned, loose) = assign(&sessions, "/repo", &[turn(9_000, "opus", 500, 40)]);

        assert_eq!(owned["s1"].input_tokens, 500);
        assert_eq!(loose.total(), 0);
    }

    #[test]
    fn spend_before_any_session_started_is_reported_not_dropped() {
        let sessions = vec![session("s1", "/repo", 100, 200)];
        let (owned, loose) = assign(&sessions, "/repo", &[turn(50, "opus", 400, 20)]);

        assert!(owned.is_empty());
        assert_eq!(loose.input_tokens, 400, "it is somebody's money either way");
        assert_eq!(loose.output_tokens, 20);
    }

    #[test]
    fn a_session_that_already_knows_its_own_tokens_is_left_alone() {
        let mut sessions = vec![session("s1", "/repo", 100, 200)];
        sessions[0].token_usage = Some(TokenUsage {
            input_tokens: 42,
            output_tokens: 7,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            api_call_count: 1,
        });
        // There is measured spend sitting in this session's own folder, so the
        // join has something to overwrite it with and deliberately does not.
        let root = projects("/repo", &[turn(150, "opus", 9_000, 800)]);

        fill_in(Some(root.path().to_path_buf()), &mut sessions, 0);

        assert_eq!(
            sessions[0].token_usage.as_ref().unwrap().input_tokens,
            42,
            "a first-hand count is never overwritten by a joined one"
        );
    }

    #[test]
    fn a_session_filled_from_the_transcript_is_also_told_which_model_it_spent_on() {
        let mut sessions = vec![session("s1", "/repo", 100, 200)];
        sessions[0].model_name = None;
        let root = projects(
            "/repo",
            &[turn(150, "haiku", 10, 5), turn(160, "opus", 900, 400)],
        );

        fill_in(Some(root.path().to_path_buf()), &mut sessions, 0);

        let filled = sessions[0].token_usage.as_ref().expect("joined usage");
        assert_eq!(filled.input_tokens, 910);
        assert_eq!(filled.output_tokens, 405);
        assert_eq!(
            sessions[0].model_name.as_deref(),
            Some("opus"),
            "the model it spent the most output on, not merely the last one seen"
        );
    }

    #[test]
    fn a_session_with_no_working_directory_is_skipped_rather_than_guessed_at() {
        let mut s = session("s1", "/repo", 100, 200);
        s.worktree = None;
        // Its spend is right there in `/repo`, and it still gets none of it:
        // without a directory on the record there is nothing to join on, and
        // guessing would put somebody else's tokens on this session's bill.
        let root = projects("/repo", &[turn(150, "opus", 700, 60)]);

        let attribution = attribute_in(Some(root.path().to_path_buf()), &[s], 0);

        assert!(attribution.by_session.is_empty());
        assert_eq!(
            attribution.unattributed.input_tokens, 700,
            "unclaimed, but still reported"
        );
    }

    #[test]
    fn a_directory_with_no_transcripts_measures_nothing_rather_than_failing() {
        let s = session("s1", "/no/such/place/at/all", 100, 200);
        let root = tempfile::tempdir().expect("temp dir");

        let attribution = attribute_in(Some(root.path().to_path_buf()), &[s], 0);

        assert_eq!(attribution.measured.total(), 0);
        assert_eq!(attribution.unattributed.total(), 0);
    }

    #[test]
    fn with_no_transcript_root_at_all_the_report_measures_nothing_instead_of_panicking() {
        let s = session("s1", "/repo", 100, 200);

        let attribution = attribute_in(None, &[s], 0);

        assert_eq!(attribution.measured.total(), 0);
    }

    #[test]
    fn spend_in_a_directory_no_session_ran_in_is_still_counted() {
        // The folder belongs to no session on this machine. Reading only the
        // folders sessions ran in would leave this money invisible in both
        // columns — not attributed, and not disclosed either.
        let sessions = vec![session("s1", "/repo", 100, 200)];
        let root = projects("/somewhere/else", &[turn(150, "opus", 1_200, 90)]);

        let attribution = attribute_in(Some(root.path().to_path_buf()), &sessions, 0);

        assert!(attribution.by_session.is_empty());
        assert_eq!(attribution.measured.input_tokens, 1_200);
        assert_eq!(attribution.unattributed.input_tokens, 1_200);
    }

    #[test]
    fn turns_before_the_window_opened_are_not_read_into_it() {
        let sessions = vec![session("s1", "/repo", 0, 10_000)];
        let root = projects(
            "/repo",
            &[turn(500, "opus", 5_000, 100), turn(9_000, "opus", 300, 20)],
        );

        let attribution = attribute_in(Some(root.path().to_path_buf()), &sessions, 1_000);

        assert_eq!(
            attribution.measured.input_tokens, 300,
            "only the turn inside the reporting window"
        );
    }
}
