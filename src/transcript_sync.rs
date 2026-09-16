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
/// one exchange; the cap only bounds a catch-up after the tool was offline.
///
/// Raised from 60 when tool calls started travelling: one agent turn is now a
/// reply plus every call it made and every result it got back, which on a
/// working turn is routinely thirty rows rather than one. At 60 a single busy
/// turn hit the cap, and the remainder only moved if the hook fired again —
/// so the last turn of a session, the one most worth reading, was the one that
/// got left behind.
const MAX_TURNS_PER_RUN: usize = 240;

/// How much of a turn is worth storing. The console renders these as chat
/// bubbles, and a 200 KB paste is not a bubble. Truncation is marked so a
/// reader is never quietly shown half a message.
const MAX_BODY: usize = 16_000;

/// How far back `--backfill` reaches into an existing transcript. Bounded in
/// *bytes* rather than turns because the point is to never read a multi-
/// gigabyte file end to end.
const BACKFILL_TAIL_BYTES: u64 = 8 * 1024 * 1024;

/// One thing that happened in a session, on its way to `session_messages`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    /// `user`, `assistant`, `tool_use` or `tool_result`.
    ///
    /// Prose used to be the only thing sent, on the reasoning that tool
    /// plumbing stays local. It made the console's transcript unreadable: the
    /// filter rail counted `Tool calls 0` on every session ever opened, and
    /// with the calls gone the replies either side of them became adjacent and
    /// ran together into one paragraph. A session's work *is* its tool calls,
    /// so they travel now. Thinking blocks still do not — they are the model's
    /// scratch, not a record of what it did.
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

/// The prose of one transcript line — what a person or an agent composed.
///
/// A thin read over [`turns_of_line`], kept because most callers only want the
/// conversation. The work that happened between two replies is in the turns it
/// drops, so anything rendering a session reads the full walk instead.
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
    turns_of_line(line, allow_sidechain)
        .into_iter()
        .find(|t| t.role == "user" || t.role == "assistant")
}

/// Everything one transcript line records, in the order it happened.
///
/// A line is not one turn. An assistant line is a list of content blocks —
/// prose, then a tool call, then more prose, then another call — and the user
/// line that answers it carries the results. Reading only the prose blocks,
/// which is what this module did until 2026-09-16, threw away the half of a
/// session that says what the agent actually *did*, and left the replies
/// either side of a call touching each other with nothing between them.
///
/// So walk the blocks and emit each one as its own turn. Order is the whole
/// contract: the console pairs a result with the most recent unanswered call
/// by position, because a `session_messages` row carries no link back to the
/// call it answers.
///
/// Still dropped, and deliberately: thinking blocks (the model's scratch, not
/// a record of what it did), the harness's own reminders and compaction
/// summaries, and — unless this file *is* a worker's transcript — sidechain
/// lines, which belong to a sub-agent and not to the session reading them.
pub fn turns_of_line(line: &str, allow_sidechain: bool) -> Vec<Turn> {
    let none = Vec::new();
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return none;
    };

    if !allow_sidechain && value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return none;
    }
    // Harness bookkeeping that is rendered to nobody, or rendered only inside
    // the local transcript viewer.
    for flag in ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly"] {
        if value.get(flag).and_then(Value::as_bool) == Some(true) {
            return none;
        }
    }

    let role = match value.get("type").and_then(Value::as_str) {
        Some("user") => "user",
        Some("assistant") => "assistant",
        _ => return none,
    };

    let at = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string);

    let Some(content) = value.get("message").and_then(|m| m.get("content")) else {
        return none;
    };

    let mut turns: Vec<Turn> = Vec::new();
    // Prose arrives in runs of text blocks. They are gathered rather than
    // emitted one by one, so two paragraphs of one reply stay one reply — and
    // flushed the moment a tool call interrupts them, so what the agent said
    // before the call is not glued to what it said after.
    let mut prose: Vec<String> = Vec::new();

    match content {
        Value::String(text) => prose.push(text.clone()),
        Value::Array(blocks) => {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            prose.push(t.to_string());
                        }
                    }
                    Some("tool_use") => {
                        flush_prose(&mut turns, &mut prose, role, &at);
                        if let Some(turn) = tool_use_turn(block, &at) {
                            turns.push(turn);
                        }
                    }
                    Some("tool_result") => {
                        flush_prose(&mut turns, &mut prose, role, &at);
                        if let Some(turn) = tool_result_turn(block, &at) {
                            turns.push(turn);
                        }
                    }
                    // `thinking`, `redacted_thinking`, `image`, and whatever
                    // the harness adds next: not a record of what was done.
                    _ => {}
                }
            }
        }
        _ => return none,
    }

    flush_prose(&mut turns, &mut prose, role, &at);
    turns
}

/// Emit the prose gathered so far as one turn, if there is any worth sending.
fn flush_prose(turns: &mut Vec<Turn>, prose: &mut Vec<String>, role: &'static str, at: &Option<String>) {
    if prose.is_empty() {
        return;
    }
    let joined = std::mem::take(prose).join("\n");
    let body = joined.trim();
    if body.is_empty() || is_machinery(body) {
        return;
    }
    turns.push(Turn {
        role,
        body: clip(body),
        at: at.clone(),
    });
}

/// A `tool_use` block as the console reads one: `{"name":…,"input":…}`.
///
/// The body has to survive `JSON.parse` at the other end, so it is never cut
/// mid-string the way prose is. An input too large to send has its long leaves
/// shortened instead, and an input that is still too large after that is
/// replaced by a note saying so — a call that says what it was is worth far
/// more than no row at all.
fn tool_use_turn(block: &Value, at: &Option<String>) -> Option<Turn> {
    let name = block.get("name").and_then(Value::as_str)?;
    let input = block.get("input").cloned().unwrap_or(Value::Null);

    let body = {
        let whole = serde_json::json!({ "name": name, "input": input }).to_string();
        if whole.len() <= MAX_BODY {
            whole
        } else {
            let mut trimmed = input;
            clip_leaves(&mut trimmed);
            let shorter = serde_json::json!({ "name": name, "input": trimmed }).to_string();
            if shorter.len() <= MAX_BODY {
                shorter
            } else {
                serde_json::json!({
                    "name": name,
                    "input": { "aura_note": "this call's input was too large to store" },
                })
                .to_string()
            }
        }
    };

    Some(Turn {
        role: "tool_use",
        body,
        at: at.clone(),
    })
}

/// A `tool_result` block — the output, as text.
///
/// Unlike a call, a result has no shape to preserve: the console renders it as
/// the terminal output or file content it is, so an over-long one is cut the
/// same way prose is.
fn tool_result_turn(block: &Value, at: &Option<String>) -> Option<Turn> {
    let content = block.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(Turn {
        role: "tool_result",
        body: clip(text),
        at: at.clone(),
    })
}

/// Shorten every long string inside a JSON value, in place.
///
/// Used on a tool input that will not fit. A `Write` carries the whole file it
/// is writing, so the one long leaf is what blew the budget; clipping leaves
/// keeps the call's shape — which path, which flags — and loses only the bulk.
fn clip_leaves(value: &mut Value) {
    /// How much of any one field survives. Small enough that even a call with
    /// a dozen long fields fits, large enough to read as a real excerpt.
    const LEAF: usize = 900;
    match value {
        Value::String(s) => {
            if s.len() > LEAF {
                let mut end = LEAF;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                let dropped = s.len() - end;
                *s = format!("{}… (+{dropped} characters)", &s[..end]);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(clip_leaves),
        Value::Object(map) => map.values_mut().for_each(clip_leaves),
        _ => {}
    }
}

/// Cut a body to `MAX_BODY`, marked, on a character boundary — a multi-byte
/// character split down the middle is not valid UTF-8 and the POST would be
/// rejected whole.
fn clip(body: &str) -> String {
    if body.len() <= MAX_BODY {
        return body.to_string();
    }
    let mut end = MAX_BODY;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n… truncated at {MAX_BODY} characters", &body[..end])
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
        // Every turn the line records, not just its prose — a line is a reply
        // *and* the calls it made. They share one resume offset because they
        // share one line: a run that stops mid-line would otherwise mark past
        // calls it never delivered.
        for turn in turns_of_line(line.trim_end(), allow_sidechain) {
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

    #[test]
    fn a_turn_travels_as_its_prose_and_its_calls_in_order() {
        // The console pairs a result with the most recent unanswered call by
        // position, so the order these come out in is the whole contract.
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"weighing options"},
            {"type":"text","text":"Reading the config first."},
            {"type":"tool_use","name":"Read","input":{"file_path":"a.toml"}},
            {"type":"text","text":"Now the retry."},
            {"type":"tool_use","name":"Edit","input":{"file_path":"b.rs"}}
        ]}}"#;
        let turns = turns_of_line(line, false);
        let shape: Vec<&str> = turns.iter().map(|t| t.role).collect();
        assert_eq!(
            shape,
            ["assistant", "tool_use", "assistant", "tool_use"],
            "prose flushes before each call it precedes"
        );
        assert_eq!(turns[0].body, "Reading the config first.");
        assert_eq!(turns[2].body, "Now the retry.");

        let call: Value = serde_json::from_str(&turns[1].body).expect("a call is valid JSON");
        assert_eq!(call["name"], "Read");
        assert_eq!(call["input"]["file_path"], "a.toml");
    }

    #[test]
    fn two_replies_on_one_line_do_not_become_one_paragraph() {
        // Sending only prose made the halves either side of a call adjacent,
        // and the console's fold joined them with nothing between: "…a roster
        // you can actually see.Now the server actions."
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"text","text":"a roster you can actually see."},
            {"type":"tool_use","name":"Edit","input":{}},
            {"type":"text","text":"Now the server actions."}
        ]}}"#;
        let bodies: Vec<String> = turns_of_line(line, false)
            .into_iter()
            .filter(|t| t.role == "assistant")
            .map(|t| t.body)
            .collect();
        assert_eq!(bodies, ["a roster you can actually see.", "Now the server actions."]);
    }

    #[test]
    fn a_tool_result_travels_as_its_output() {
        let line = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","content":"3 files changed"}
        ]}}"#;
        let turns = turns_of_line(line, false);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].role, "tool_result");
        assert_eq!(turns[0].body, "3 files changed");
        // …but the prose-only read still sees nothing, so the five older
        // tests keep meaning what they meant.
        assert_eq!(turn_of(line), None);
    }

    #[test]
    fn a_result_split_into_blocks_is_still_one_output() {
        let line = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","content":[{"type":"text","text":"line one"},
                                             {"type":"text","text":"line two"}]}
        ]}}"#;
        let turns = turns_of_line(line, false);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].body, "line one\nline two");
    }

    #[test]
    fn a_call_too_large_to_send_still_says_what_it_was() {
        // A `Write` carries the whole file. The row has to stay parseable at
        // the other end, so the long leaf is shortened rather than the JSON
        // cut in half.
        let huge = "x".repeat(MAX_BODY * 2);
        let line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                {"type": "tool_use", "name": "Write",
                 "input": {"file_path": "big.txt", "content": huge}}
            ]}
        })
        .to_string();

        let turns = turns_of_line(&line, false);
        assert_eq!(turns.len(), 1);
        assert!(turns[0].body.len() <= MAX_BODY, "a call must fit the column");
        let call: Value =
            serde_json::from_str(&turns[0].body).expect("a clipped call is still valid JSON");
        assert_eq!(call["name"], "Write");
        assert_eq!(call["input"]["file_path"], "big.txt", "the shape survives");
        assert!(
            call["input"]["content"].as_str().unwrap().contains("characters)"),
            "the bulk is marked as dropped"
        );
    }

    #[test]
    fn a_call_that_is_all_bulk_still_names_itself() {
        // Thousands of short fields: clipping leaves saves nothing, so the
        // input becomes a note. A row saying which tool ran beats no row.
        let mut input = serde_json::Map::new();
        for i in 0..4000 {
            input.insert(format!("field_{i}"), Value::String("a value here".into()));
        }
        let line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                {"type": "tool_use", "name": "Mystery", "input": Value::Object(input)}
            ]}
        })
        .to_string();

        let turns = turns_of_line(&line, false);
        assert!(turns[0].body.len() <= MAX_BODY);
        let call: Value = serde_json::from_str(&turns[0].body).expect("still valid JSON");
        assert_eq!(call["name"], "Mystery");
        assert!(call["input"]["aura_note"].is_string());
    }

    #[test]
    fn an_over_long_result_is_cut_on_a_character_boundary() {
        // A multi-byte character split down the middle is not valid UTF-8 and
        // the POST would be rejected whole.
        let line = serde_json::json!({
            "type": "user",
            "message": { "content": [
                {"type": "tool_result", "content": "é".repeat(MAX_BODY)}
            ]}
        })
        .to_string();
        let turns = turns_of_line(&line, false);
        assert_eq!(turns[0].role, "tool_result");
        assert!(turns[0].body.ends_with(&format!("… truncated at {MAX_BODY} characters")));
    }

    #[test]
    fn a_sidechains_calls_stay_out_of_the_sessions_transcript_too() {
        let line = r#"{"type":"assistant","isSidechain":true,"message":{"content":[
            {"type":"tool_use","name":"Read","input":{}}
        ]}}"#;
        assert!(turns_of_line(line, false).is_empty());
        assert_eq!(turns_of_line(line, true).len(), 1);
    }

    #[test]
    fn scanning_delivers_the_calls_as_well_as_the_words() {
        let dir = std::env::temp_dir().join(format!("aura-ts-calls-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("t.jsonl");
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"on it"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#;
        fs::write(&path, format!("{line}\n")).unwrap();

        let (turns, resume) = scan(&path, 0, false).unwrap();
        let shape: Vec<&str> = turns.iter().map(|(t, _)| t.role).collect();
        assert_eq!(shape, ["assistant", "tool_use"]);
        // Both came off one line, so both carry that line's end offset — a
        // run stopping between them must not mark past the call it dropped.
        assert_eq!(turns[0].1, turns[1].1);
        assert_eq!(resume, line.len() as u64 + 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
