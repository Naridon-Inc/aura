//! Getting the *conversation* off this machine, not just the edits.
//!
//! # What was missing
//!
//! A terminal session already reaches the console: the post-tool-use hook logs
//! an intent row per tool call, and the server folds the rows sharing a
//! `session_id` into one `sessions` row (`upsert_session_from_intents`). So the
//! console can say a session happened, on which branch, touching which files.
//!
//! It could not say a word about what was *asked*. Opening that session showed
//! `message_count: 0`, because the only thing that has ever written
//! `session_messages` is the desktop app — `cloud_session_sync::push_message`
//! for a Manager turn, and the Claude-transcript tailer in
//! `cmd_claude_sessions.rs`, which only runs while somebody has that session
//! open in the app's viewer. Nobody has the app open next to a terminal, so a
//! CLI session's transcript went nowhere. Measured on a real production
//! session: 53 intent rows, 0 messages.
//!
//! The evidence was already on disk. Claude Code hands its Stop hook a
//! `transcript_path`, and the hook already reads it to render a desktop
//! notification. This module reads the same file and posts the turns to the
//! same endpoint the desktop uses, so a terminal session and an app session
//! tell the console the same kind of story.
//!
//! # Three rules that make it safe to run from a hook
//!
//! **Forward-only by default.** A long-lived transcript is not small — the
//! session that motivated this is a 2 GB JSONL with 12,000 assistant blocks.
//! Turning sync on must not upload a year of history, so the first sight of a
//! transcript records its current end and sends nothing. Only `--backfill`
//! reaches backwards, and even then only into the tail.
//!
//! **Byte offsets, never a re-read.** Each run seeks to where the last one
//! stopped. A partial trailing line is left outside the mark for the next run
//! to pick up whole, the way the desktop's tailer does it.
//!
//! **Silence over noise.** Every failure path returns instead of printing:
//! this runs inline with a hook that must exit 0 whatever the network is
//! doing, and a stop hook that starts writing to a terminal is a bug the user
//! sees on every turn.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::config::ConfigManager;

/// Turns posted in one run. A stop hook fires per turn, so the steady state is
/// one or two; the cap only bounds a catch-up after the tool was offline.
const MAX_TURNS_PER_RUN: usize = 60;

/// How much of a turn is worth storing. The console renders these as chat
/// bubbles, and a 200 KB paste is not a bubble. Truncation is marked so a
/// reader is never quietly shown half a message.
const MAX_BODY: usize = 16_000;

/// How far back `--backfill` reaches into an existing transcript. Bounded in
/// *bytes* rather than turns because the point is to never read a multi-
/// gigabyte file end to end.
const BACKFILL_TAIL_BYTES: u64 = 8 * 1024 * 1024;

/// One thing somebody said, on its way to `session_messages`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    /// "user" or "assistant" — the two roles the console renders. Tool calls,
    /// tool results and thinking blocks are deliberately not turns.
    pub role: &'static str,
    pub body: String,
    /// The moment it was said, from the transcript's own `timestamp`. Without
    /// it every historical turn would cluster at sync time.
    pub at: Option<String>,
}

/// Which sub-agent said it, when the speaker was not the session itself.
///
/// A worker's turns land in `session_messages` beside the parent's, because
/// they *are* part of that session's story — but unlabelled they read as the
/// parent talking to itself. This is the label, and it is carried on the turn
/// rather than folded into the body so the console can nest a run instead of
/// prefixing a string nobody can filter on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribution {
    /// Claude's `agent_id` — the same value the post-tool-use hook stamps on
    /// the intent rows this worker produced, which is what joins its words to
    /// its edits.
    pub agent_id: String,
    /// `Explore`, `general-purpose`, a project's own agent name.
    pub agent_type: String,
    /// What the parent said it was for, when a sidecar recorded it.
    pub description: String,
}

/// What one run did. Returned rather than printed so the caller decides
/// whether anybody is listening.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Turns parsed out of the bytes this run read.
    pub read: usize,
    /// Turns the cloud accepted.
    pub sent: usize,
    /// Turns held back for the next run because of `MAX_TURNS_PER_RUN`.
    pub deferred: usize,
    /// True when this was the first sight of this transcript and the run
    /// therefore only recorded a starting point.
    pub primed: bool,
}

/// The cloud base URL and token, when this machine is signed in.
///
/// Same precedence as `intent_sync::cloud` — what you signed in to, then the
/// override, then production — so one machine cannot be half-pointed at two
/// servers.
fn cloud() -> Option<(String, String)> {
    let config = ConfigManager::load();
    let token = crate::cloud_endpoint::token(config.cloud_api_token.as_deref())?;
    let url = crate::cloud_endpoint::origin_or_public(config.cloud_url.as_deref());
    Some((url, token))
}

/// Where the read marks live: one file, keyed by session id.
///
/// Beside `credentials.json` rather than in the repo, because a transcript is
/// not a repository artifact — it belongs to the person and the machine, and a
/// mark committed into a project would desynchronise every checkout of it.
fn marks_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())?;
    let dir = PathBuf::from(home).join(".aura");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    Some(dir.join("transcript_offsets.json"))
}

fn load_marks() -> BTreeMap<String, u64> {
    let Some(path) = marks_path() else {
        return BTreeMap::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_marks(marks: &BTreeMap<String, u64>) {
    let Some(path) = marks_path() else { return };
    if let Ok(text) = serde_json::to_string_pretty(marks) {
        let _ = fs::write(path, text);
    }
}

/// Text a person or an agent actually composed, out of one transcript line.
///
/// Everything else in that file is machinery: tool calls and their results,
/// thinking blocks, the harness's own reminders, compaction summaries, and the
/// sidechain lines a subagent writes. A transcript pane that showed those
/// would be a log, not a conversation — and the desktop's own tailer makes the
/// same cut (`UserPrompt` + `AssistantText`, "tool plumbing stays local").
pub fn turn_of(line: &str) -> Option<Turn> {
    turn_of_line(line, false)
}

/// The same read, told whether sidechain lines belong here.
///
/// `allow_sidechain` is true only when the file being read *is* a sub-agent's
/// transcript, where every line is a sidechain line and dropping them leaves
/// the run with no words at all. On a session transcript it stays false, for
/// the original reason: older Claude builds interleaved a worker's lines into
/// the parent's file, and attributing those to the parent puts words in the
/// wrong mouth.
pub fn turn_of_line(line: &str, allow_sidechain: bool) -> Option<Turn> {
    let value: Value = serde_json::from_str(line).ok()?;

    if !allow_sidechain && value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    // Harness bookkeeping that is rendered to nobody, or rendered only inside
    // the local transcript viewer.
    for flag in ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly"] {
        if value.get(flag).and_then(Value::as_bool) == Some(true) {
            return None;
        }
    }

    let role = match value.get("type").and_then(Value::as_str)? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };

    let content = value.get("message")?.get("content")?;
    let body = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };

    let body = body.trim();
    if body.is_empty() || is_machinery(body) {
        return None;
    }

    let body = if body.len() > MAX_BODY {
        // Cut on a char boundary — a multi-byte character split down the
        // middle is not valid UTF-8 and the POST would be rejected whole.
        let mut end = MAX_BODY;
        while end > 0 && !body.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n\n… truncated at {MAX_BODY} characters", &body[..end])
    } else {
        body.to_string()
    };

    Some(Turn {
        role,
        body,
        at: value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Text that arrived in a user turn without a person typing it.
///
/// Claude Code injects context, command output and caveats as user messages;
/// they are addressed to the model, not written by the human, and showing them
/// in a transcript pane misattributes them to whoever opened the session.
fn is_machinery(body: &str) -> bool {
    const PREFIXES: [&str; 6] = [
        "<system-reminder>",
        "<local-command-stdout>",
        "<command-name>",
        "<command-message>",
        "Caveat: The messages below were generated",
        "This session is being continued from a previous conversation",
    ];
    PREFIXES.iter().any(|p| body.starts_with(p))
}

/// Read `transcript` from `offset` to its end, returning the turns found and
/// the offset a later run should resume from.
///
/// The resume point deliberately excludes a trailing partial line: the hook
/// fires while the harness is still writing, so the last line is regularly
/// half-written, and marking past it would drop a turn permanently.
fn scan(
    transcript: &Path,
    offset: u64,
    allow_sidechain: bool,
) -> Result<(Vec<(Turn, u64)>, u64), String> {
    let mut file = File::open(transcript).map_err(|e| format!("open transcript: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("stat transcript: {e}"))?
        .len();
    // A shorter file than the mark means the transcript was replaced (a new
    // session reusing a path, or a rotation). Start over rather than seeking
    // past the end.
    let start = if offset > len { 0 } else { offset };
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek transcript: {e}"))?;

    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read transcript: {e}"))?;
    let text = String::from_utf8_lossy(&buf);

    let mut turns = Vec::new();
    let mut consumed = 0usize;
    for line in text.split_inclusive('\n') {
        if !line.ends_with('\n') {
            break; // partial trailer — leave it for next time
        }
        consumed += line.len();
        if let Some(turn) = turn_of_line(line.trim_end(), allow_sidechain) {
            // The offset *past* this line, so a run that stops early can mark
            // exactly the turns it delivered and no more.
            turns.push((turn, start + consumed as u64));
        }
    }

    Ok((turns, start + consumed as u64))
}

/// Post one turn. Returns whether the cloud stored it.
fn post(
    base: &str,
    token: &str,
    session_id: &str,
    turn: &Turn,
    agent: Option<&Attribution>,
) -> bool {
    let mut payload = serde_json::Map::new();
    payload.insert("role".into(), Value::String(turn.role.to_string()));
    payload.insert("body".into(), Value::String(turn.body.clone()));
    payload.insert("source".into(), Value::String("aura-cli".into()));
    if let Some(at) = &turn.at {
        payload.insert("created_at".into(), Value::String(at.clone()));
    }
    // Absent for the session's own turns. A server that does not know these
    // fields yet stores the turn unlabelled, which is what it did before —
    // never a rejected message.
    if let Some(a) = agent {
        payload.insert("subagent_id".into(), Value::String(a.agent_id.clone()));
        payload.insert("subagent_type".into(), Value::String(a.agent_type.clone()));
        if !a.description.is_empty() {
            payload.insert(
                "subagent_description".into(),
                Value::String(a.description.clone()),
            );
        }
    }

    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    else {
        return false;
    };

    // Session ids are opaque strings, not always UUIDs — cursor-agent's
    // `conversation_id` is its own shape — so the path segment is escaped
    // rather than trusted.
    let escaped: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                c.to_string()
            } else {
                c.to_string()
                    .as_bytes()
                    .iter()
                    .map(|b| format!("%{b:02X}"))
                    .collect()
            }
        })
        .collect();
    let url = format!("{base}/api/v2/sessions/{escaped}/messages");
    match client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .json(&Value::Object(payload))
        .send()
    {
        // The endpoint answers 200 with `{"error": …}` for an unknown or
        // inaccessible session rather than a status code, so the body is the
        // only honest signal that a turn landed.
        Ok(resp) if resp.status().is_success() => resp
            .json::<Value>()
            .map(|v| v.get("error").is_none())
            .unwrap_or(false),
        _ => false,
    }
}

/// Push whatever is new in `transcript` to the cloud session `session_id`.
///
/// `backfill` reaches into the tail of an existing transcript the first time
/// it is seen; without it, a first run only records where to start.
pub fn sync(session_id: &str, transcript: &Path, backfill: bool) -> Result<Report, String> {
    sync_as(session_id, transcript, backfill, None)
}

/// The same push, optionally saying which sub-agent is speaking.
///
/// A worker's transcript is a different file with the same destination: its
/// turns belong to the parent session — that is where a reader looks for them —
/// but labelled, so a run reads as a run rather than as the session suddenly
/// talking about something else.
pub fn sync_as(
    session_id: &str,
    transcript: &Path,
    backfill: bool,
    agent: Option<&Attribution>,
) -> Result<Report, String> {
    if std::env::var("AURA_NO_TRANSCRIPT_SYNC").is_ok() {
        return Ok(Report::default());
    }
    if !transcript.is_file() {
        return Err(format!("no transcript at {}", transcript.display()));
    }

    // Every file gets its own read mark. Sharing the session's mark across a
    // session and its workers would have each file seeking to an offset the
    // others wrote — one byte count, several files of different lengths — and
    // the longest one would silently swallow the rest.
    let key = mark_key(session_id, agent);
    // Sidechain lines are the whole of a worker's transcript and none of a
    // session's, and which file this is decides that.
    let allow_sidechain = agent.is_some();

    let mut marks = load_marks();
    let known = marks.get(&key).copied();

    let start = match known {
        Some(offset) => offset,
        None if backfill => {
            let len = fs::metadata(transcript)
                .map_err(|e| format!("stat transcript: {e}"))?
                .len();
            // Start of the tail, snapped forward to the next line boundary so
            // the first line read is whole.
            next_line_start(transcript, len.saturating_sub(BACKFILL_TAIL_BYTES))?
        }
        None => {
            // First sight, forward-only: remember the end and send nothing.
            let len = fs::metadata(transcript)
                .map_err(|e| format!("stat transcript: {e}"))?
                .len();
            marks.insert(key, len);
            save_marks(&marks);
            return Ok(Report {
                primed: true,
                ..Report::default()
            });
        }
    };

    let (turns, resume) = scan(transcript, start, allow_sidechain)?;
    let read = turns.len();
    let (batch, deferred) = if turns.len() > MAX_TURNS_PER_RUN {
        (&turns[..MAX_TURNS_PER_RUN], turns.len() - MAX_TURNS_PER_RUN)
    } else {
        (&turns[..], 0)
    };

    let Some((base, token)) = cloud() else {
        // Not signed in. Do not advance the mark: signing in later should
        // still find this work rather than a gap.
        return Ok(Report {
            read,
            ..Report::default()
        });
    };

    let mut sent = 0usize;
    // Where the next run should begin. It advances one delivered turn at a
    // time, so three outcomes are all correct without a special case: a clean
    // run ends at `resume`, a capped run ends just past its last turn and the
    // next run picks up the rest, and a run that dies mid-batch leaves the
    // mark on the last turn the cloud actually stored.
    let mut mark = start;
    for (turn, after) in batch.iter() {
        if !post(&base, &token, session_id, turn, agent) {
            // Stop at the first failure rather than skipping it. Order is the
            // whole point of a transcript, and a retry landing after newer
            // turns would read as the conversation happening out of sequence.
            break;
        }
        sent += 1;
        mark = *after;
    }

    let delivered_everything = sent == batch.len();
    if delivered_everything && deferred == 0 {
        // Nothing left in the bytes this run read — including the lines that
        // held no turn at all, which is most of them.
        mark = resume;
    }
    if sent > 0 {
        marks.insert(key, mark);
        save_marks(&marks);
    }

    Ok(Report {
        read,
        sent,
        deferred,
        primed: false,
    })
}

/// Which read mark a file uses.
///
/// The session's own transcript keeps the bare session id, so marks written by
/// every release before sub-agents were read still line up and nobody re-uploads
/// a session's history on upgrade. A worker's file hangs off it.
fn mark_key(session_id: &str, agent: Option<&Attribution>) -> String {
    match agent {
        Some(a) => format!("{session_id}::{}", a.agent_id),
        None => session_id.to_string(),
    }
}

/// Push every sub-agent transcript recorded under a session.
///
/// Called when a session stops, so a run that finished mid-session and one
/// still writing when the session ended are both reached — a worker's own stop
/// hook pushes it the moment it finishes, and this is the sweep that catches
/// whatever that missed (an older Claude with no `SubagentStop`, a hook that
/// was not yet installed when the run started, a machine that was offline).
///
/// Every file has its own mark, so the sweep is cheap after the first pass:
/// it re-reads nothing it has already sent.
pub fn sync_subagents(
    session_id: &str,
    parent_transcript: &Path,
    backfill: bool,
) -> Result<Report, String> {
    let mut total = Report::default();
    for run in crate::subagents::runs_of(parent_transcript) {
        let attribution = Attribution {
            agent_id: run.agent_id.clone(),
            agent_type: run.agent_type.clone(),
            description: run.description.clone(),
        };
        // One unreadable run must not stop the sweep — the next worker's words
        // are not implicated in its neighbour's half-written file.
        if let Ok(report) = sync_as(session_id, &run.transcript, backfill, Some(&attribution)) {
            total.read += report.read;
            total.sent += report.sent;
            total.deferred += report.deferred;
            // `primed` means "this run only recorded a starting point", which
            // for a sweep is true only while nothing at all has been sent.
            total.primed = total.primed || report.primed;
        }
    }
    if total.sent > 0 {
        total.primed = false;
    }
    Ok(total)
}

/// The offset of the first line boundary at or after `from`.
fn next_line_start(transcript: &Path, from: u64) -> Result<u64, String> {
    if from == 0 {
        return Ok(0);
    }
    let mut file = File::open(transcript).map_err(|e| format!("open transcript: {e}"))?;
    file.seek(SeekFrom::Start(from))
        .map_err(|e| format!("seek transcript: {e}"))?;
    let mut probe = vec![0u8; 1024 * 1024];
    let n = file
        .read(&mut probe)
        .map_err(|e| format!("read transcript: {e}"))?;
    match probe[..n].iter().position(|b| *b == b'\n') {
        Some(i) => Ok(from + i as u64 + 1),
        None => Ok(from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_prompt_is_a_turn() {
        let line = r#"{"type":"user","timestamp":"2026-08-25T10:00:00Z","message":{"content":"fix the retry"}}"#;
        let t = turn_of(line).expect("a typed prompt is a turn");
        assert_eq!(t.role, "user");
        assert_eq!(t.body, "fix the retry");
        assert_eq!(t.at.as_deref(), Some("2026-08-25T10:00:00Z"));
    }

    #[test]
    fn an_assistant_keeps_only_its_prose() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"weighing options"},
            {"type":"text","text":"Fixed the retry."},
            {"type":"tool_use","name":"Edit","input":{}}
        ]}}"#;
        let t = turn_of(line).expect("an assistant reply is a turn");
        assert_eq!(t.role, "assistant");
        assert_eq!(t.body, "Fixed the retry.");
    }

    #[test]
    fn tool_results_are_not_conversation() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#;
        assert_eq!(turn_of(line), None);
    }

    #[test]
    fn the_harness_talking_to_itself_is_not_the_person_talking() {
        for body in [
            "<system-reminder>\nremember the thing\n</system-reminder>",
            "<local-command-stdout>ok</local-command-stdout>",
            "Caveat: The messages below were generated while running a command",
        ] {
            let line = serde_json::json!({
                "type": "user",
                "message": { "content": body }
            })
            .to_string();
            assert_eq!(turn_of(&line), None, "should have skipped: {body}");
        }
    }

    #[test]
    fn a_subagents_words_stay_out_of_the_sessions_transcript() {
        // Read as a session's file, a sidechain line is somebody else's turn
        // wearing the session's name.
        let line = r#"{"type":"user","isSidechain":true,"message":{"content":"go read the docs"}}"#;
        assert_eq!(turn_of(line), None);
    }

    #[test]
    fn but_read_as_the_subagents_own_file_it_is_the_whole_story() {
        // Every line of a worker's transcript is a sidechain line. Applying
        // the session rule to it drops the run's words entirely, which is what
        // used to happen: the console showed a worker's twenty file edits with
        // nothing said about any of them.
        let line = r#"{"type":"user","isSidechain":true,"message":{"content":"go read the docs"}}"#;
        let turn = turn_of_line(line, true).expect("a worker's words are turns");
        assert_eq!(turn.role, "user");
        assert_eq!(turn.body, "go read the docs");
    }

    #[test]
    fn a_worker_reads_from_its_own_mark_not_the_sessions() {
        // One byte count shared across a session and its workers would have
        // each file seeking to an offset another file wrote.
        let agent = Attribution {
            agent_id: "a01".into(),
            agent_type: "Explore".into(),
            description: "Verify telemetry".into(),
        };
        assert_eq!(mark_key("sess-1", None), "sess-1");
        assert_eq!(mark_key("sess-1", Some(&agent)), "sess-1::a01");
    }

    #[test]
    fn the_sessions_mark_keeps_the_name_it_always_had() {
        // Marks written by every release before workers were read are keyed on
        // the bare session id. Changing that shape would make every session on
        // every machine look unseen and re-upload its tail on upgrade.
        assert_eq!(mark_key("abc-123", None), "abc-123");
    }

    #[test]
    fn a_long_turn_is_cut_on_a_character_boundary_and_says_so() {
        let body = "é".repeat(MAX_BODY);
        let line = serde_json::json!({ "type": "assistant", "message": { "content": body } })
            .to_string();
        let t = turn_of(&line).expect("a long turn is still a turn");
        assert!(t.body.ends_with(&format!("… truncated at {MAX_BODY} characters")));
        // The proof it cut cleanly: it is still valid UTF-8 and shorter than
        // the input, which a naive byte slice would not have been.
        assert!(t.body.chars().count() < body.chars().count());
    }

    #[test]
    fn a_half_written_last_line_is_left_for_the_next_run() {
        let dir = std::env::temp_dir().join(format!("aura-ts-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("t.jsonl");
        let whole = r#"{"type":"user","message":{"content":"one"}}"#;
        fs::write(&path, format!("{whole}\n{{\"type\":\"user\",\"mess")).unwrap();

        let (turns, resume) = scan(&path, 0, false).unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].0.body, "one");
        // The turn's own end offset is where the next run would resume if it
        // delivered only this one.
        assert_eq!(turns[0].1, whole.len() as u64 + 1);
        // The mark stops after the complete line, not at end-of-file.
        assert_eq!(resume, whole.len() as u64 + 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
