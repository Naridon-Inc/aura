//! The transcript, stored beside the session instead of inside it.
//!
//! A session used to be one JSON document, transcript included, rewritten in
//! full on every [`super::persist::save`]. The brain loop saves after every
//! tool call, so a conversation that had grown to ninety-six megabytes paid
//! ninety-six megabytes of serialise-and-write to record one more sentence,
//! dozens of times per turn. That is the whole of the lag people reported as
//! "the app hangs in longer sessions".
//!
//! So the conversation moves to `<sid>.chat.jsonl`, one turn per line, and
//! the session file keeps only what it needs to describe itself. The split is
//! not at the end of the file but a few turns short of it:
//!
//! ```text
//!   chat[0 .. settled]     -> <sid>.chat.jsonl   append-only, never rewritten
//!   chat[settled .. len]   -> <sid>.json         rewritten every save, tiny
//! ```
//!
//! That [`TAIL`] of live turns is what makes the log append-only rather than
//! an append-mostly log full of superseded rows. The shell mutates a turn in
//! place while it streams — `chat.last_mut()` patches text, token counts and
//! cost as the reply arrives — and a turn that can still change must not be
//! in a file we only ever append to. Once it has [`TAIL`] turns behind it,
//! nothing in the codebase touches it again, and it can be written once and
//! left alone. The rest of the transcript's mutations (a distillation pass,
//! an edit-and-resend rewind, a fork) all shorten or replace the whole
//! vector, which [`flush`] detects and answers with a full rewrite.
//!
//! Order matters on the two writes. The log is flushed first and the session
//! file second, so an interrupted save leaves turns on disk that no session
//! file claims yet — which [`read_prefix`] ignores — rather than a session
//! file pointing past the end of its own transcript.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::ChatTurn;

/// How many turns at the live end of the conversation stay in the session
/// file rather than the log.
///
/// The only in-place mutation in the codebase is `chat.last_mut()`, so one
/// would do; four is slack against a future second writer, and stays small
/// enough that rewriting it on every save is free — which matters, because a
/// turn here carries its attachments inline and a pasted screenshot is
/// megabytes.
pub(super) const TAIL: usize = 4;

/// Where the log splits from the live tail for a conversation of `len` turns.
fn settled_at(len: usize) -> usize {
    len.saturating_sub(TAIL)
}

pub fn path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.chat.jsonl"))
}

/// What we left in the log last time, so the next save can add to it instead
/// of writing it out again.
#[derive(Clone)]
struct Flushed {
    /// Turns in the log.
    count: usize,
    /// Its byte length when we stopped writing. Re-checked before every
    /// append: if the file is not the size we left it, something other than
    /// this process has been in it and the count cannot be trusted.
    bytes: u64,
    /// Identity of the prefix, so a transcript that was *replaced* rather
    /// than appended to — same length, different turns — cannot be mistaken
    /// for one that never moved.
    first_at: u64,
    last_at: u64,
    last_len: usize,
}

fn ledger() -> &'static Mutex<HashMap<String, Flushed>> {
    static LEDGER: OnceLock<Mutex<HashMap<String, Flushed>>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(HashMap::new()))
}

fn fingerprint(chat: &[ChatTurn], count: usize, bytes: u64) -> Flushed {
    Flushed {
        count,
        bytes,
        first_at: chat.first().map(|t| t.at).unwrap_or(0),
        last_at: count.checked_sub(1).and_then(|i| chat.get(i)).map(|t| t.at).unwrap_or(0),
        last_len: count
            .checked_sub(1)
            .and_then(|i| chat.get(i))
            .map(|t| t.text.len())
            .unwrap_or(0),
    }
}

/// Is the log still the prefix of `chat` that we believe it is?
fn still_the_prefix(held: &Flushed, chat: &[ChatTurn]) -> bool {
    if held.count == 0 {
        return true;
    }
    let Some(last) = chat.get(held.count - 1) else {
        return false;
    };
    chat.first().map(|t| t.at) == Some(held.first_at)
        && last.at == held.last_at
        && last.text.len() == held.last_len
}

fn line_of(turn: &ChatTurn) -> Result<String, String> {
    serde_json::to_string(turn).map_err(|e| format!("serialize chat turn: {e}"))
}

/// Append `turns` to an existing log, returning its new byte length.
fn append(path: &Path, turns: &[ChatTurn]) -> Result<u64, String> {
    let file = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut out = std::io::BufWriter::new(file);
    for turn in turns {
        out.write_all(line_of(turn)?.as_bytes())
            .and_then(|()| out.write_all(b"\n"))
            .map_err(|e| format!("append {}: {e}", path.display()))?;
    }
    // Flushed by hand rather than on drop: a `BufWriter` dropped with bytes
    // still in it swallows the error, and a turn that was reported saved and
    // is not on disk is the one failure this file exists to prevent.
    out.flush()
        .map_err(|e| format!("append {}: {e}", path.display()))?;
    let file = out
        .into_inner()
        .map_err(|e| format!("append {}: {e}", path.display()))?;
    file.metadata()
        .map(|m| m.len())
        .map_err(|e| format!("stat {}: {e}", path.display()))
}

/// Write the whole log out again, atomically, returning its byte length.
fn rewrite(dir: &Path, path: &Path, turns: &[ChatTurn]) -> Result<u64, String> {
    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-")
        .suffix(".jsonl")
        .tempfile_in(dir)
        .map_err(|e| format!("tempfile: {e}"))?;
    let mut bytes = 0u64;
    {
        let mut out = std::io::BufWriter::new(tmp.as_file_mut());
        for turn in turns {
            let line = line_of(turn)?;
            bytes += line.len() as u64 + 1;
            out.write_all(line.as_bytes())
                .and_then(|()| out.write_all(b"\n"))
                .map_err(|e| format!("write tempfile: {e}"))?;
        }
        out.flush().map_err(|e| format!("write tempfile: {e}"))?;
    }
    tmp.persist(path)
        .map_err(|e| format!("rename to {}: {e}", path.display()))?;
    Ok(bytes)
}

/// Bring the log in line with `chat`, and report the index of the first turn
/// the session file must carry itself.
///
/// Appends when it can and rewrites when it must; the caller does not need to
/// know which happened, only where the split landed.
pub fn flush(dir: &Path, id: &str, chat: &[ChatTurn]) -> Result<usize, String> {
    let settled = settled_at(chat.len());
    let path = path(dir, id);
    let on_disk = fs::metadata(&path).map(|m| m.len()).ok();

    let held = ledger().lock().ok().and_then(|m| m.get(id).cloned());
    let appendable = match (&held, on_disk) {
        (Some(held), Some(bytes)) => {
            held.bytes == bytes && held.count <= settled && still_the_prefix(held, chat)
        }
        _ => false,
    };

    let bytes = if appendable {
        let held = held.expect("appendable implies a ledger entry");
        if held.count == settled {
            held.bytes
        } else {
            append(&path, &chat[held.count..settled])?
        }
    } else if settled > 0 || on_disk.is_some() {
        // `on_disk.is_some()` matters on the shrinking side: a conversation
        // that was distilled back under `TAIL` turns still has to have its
        // log emptied, or `read_prefix` would hand back turns the session no
        // longer holds. An empty log for a session that never had one is not
        // worth a file.
        rewrite(dir, &path, &chat[..settled])?
    } else {
        0
    };

    if let Ok(mut m) = ledger().lock() {
        m.insert(id.to_string(), fingerprint(chat, settled, bytes));
    }
    Ok(settled)
}

/// Read back the turns the session file does not carry.
///
/// `chat_start` is the session file's own account of how many turns it handed
/// to the log, and it is the authority: a log with *more* lines than that was
/// appended to by a save whose session file never landed, and those turns are
/// not part of the conversation. A log with fewer is a torn rewrite, and we
/// return what survived rather than refusing to open the session at all.
pub fn read_prefix(dir: &Path, id: &str, chat_start: usize) -> Vec<ChatTurn> {
    if chat_start == 0 {
        return Vec::new();
    }
    let path = path(dir, id);
    let Ok(raw) = fs::read_to_string(&path) else {
        eprintln!(
            "aura-shell: session {id} claims {chat_start} archived turns but {} is unreadable",
            path.display()
        );
        return Vec::new();
    };
    let mut turns = Vec::with_capacity(chat_start);
    for line in raw.lines() {
        if turns.len() == chat_start {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<ChatTurn>(line) {
            Ok(turn) => turns.push(turn),
            Err(e) => eprintln!("aura-shell: skipping unreadable turn in {}: {e}", path.display()),
        }
    }
    if turns.len() < chat_start {
        eprintln!(
            "aura-shell: session {id} claims {chat_start} archived turns, {} readable",
            turns.len()
        );
    }
    turns
}

/// Record what a load just read, so the first save after opening a session
/// appends to the log rather than writing the whole conversation out again.
pub fn note_loaded(dir: &Path, id: &str, settled: usize, chat: &[ChatTurn]) {
    let bytes = fs::metadata(path(dir, id)).map(|m| m.len()).unwrap_or(0);
    if let Ok(mut m) = ledger().lock() {
        m.insert(id.to_string(), fingerprint(chat, settled, bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::{ChatRole, ManagerSession};

    fn chat(n: usize) -> Vec<ChatTurn> {
        let mut s = ManagerSession::new("t".into(), "o".into(), vec![], vec![]);
        for i in 0..n {
            s.push_chat(ChatRole::Manager, format!("turn {i}"));
            // `push_chat` stamps `at` from the wall clock, so turns pushed in
            // the same second share one — spread them, since the prefix
            // fingerprint is built from exactly this field.
            s.chat.last_mut().unwrap().at = 1000 + i as u64;
        }
        s.chat
    }

    fn lines(dir: &Path, id: &str) -> usize {
        fs::read_to_string(path(dir, id))
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
            .unwrap_or(0)
    }

    /// The whole point: growing a conversation by one turn adds one line, and
    /// leaves every line before it exactly where it was.
    #[test]
    fn a_new_turn_appends_one_line() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let mut turns = chat(20);

        let start = flush(dir, "grow", &turns).unwrap();
        assert_eq!(start, 16, "four live turns stay with the session");
        assert_eq!(lines(dir, "grow"), 16);
        let before = fs::read_to_string(path(dir, "grow")).unwrap();

        turns.push(turns[0].clone());
        let start = flush(dir, "grow", &turns).unwrap();
        assert_eq!(start, 17);
        let after = fs::read_to_string(path(dir, "grow")).unwrap();
        assert_eq!(lines(dir, "grow"), 17);
        assert!(after.starts_with(&before), "the log was appended to, not rewritten");
    }

    /// A streaming reply is patched in place over and over. None of that may
    /// reach the log, or it would fill with superseded copies of one turn.
    #[test]
    fn editing_the_live_turn_never_touches_the_log() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let mut turns = chat(20);
        flush(dir, "stream", &turns).unwrap();
        let before = fs::read_to_string(path(dir, "stream")).unwrap();

        for i in 0..50 {
            turns.last_mut().unwrap().text = format!("streaming {i}");
            flush(dir, "stream", &turns).unwrap();
        }
        assert_eq!(fs::read_to_string(path(dir, "stream")).unwrap(), before);
    }

    /// Edit-and-resend truncates the conversation. The log has to follow it
    /// back, or the rewound turns would reappear on the next open.
    #[test]
    fn a_rewind_shortens_the_log() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let mut turns = chat(20);
        flush(dir, "rewind", &turns).unwrap();
        assert_eq!(lines(dir, "rewind"), 16);

        turns.truncate(6);
        let start = flush(dir, "rewind", &turns).unwrap();
        assert_eq!(start, 2);
        assert_eq!(lines(dir, "rewind"), 2);
        assert_eq!(read_prefix(dir, "rewind", start)[0].text, "turn 0");
    }

    /// Distillation replaces the transcript wholesale. It can come back the
    /// same length it went in, so a length check alone would miss it.
    #[test]
    fn a_replaced_transcript_is_rewritten_not_appended() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let turns = chat(20);
        flush(dir, "distil", &turns).unwrap();

        let mut replaced = chat(20);
        for (i, turn) in replaced.iter_mut().enumerate() {
            turn.text = format!("digest {i}");
            turn.at = 9000 + i as u64;
        }
        let start = flush(dir, "distil", &replaced).unwrap();
        assert_eq!(lines(dir, "distil"), 16);
        assert_eq!(read_prefix(dir, "distil", start)[0].text, "digest 0");
    }

    /// Round trip: what the log gives back, plus the tail the session file
    /// kept, is the conversation that went in.
    #[test]
    fn prefix_and_tail_rebuild_the_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let turns = chat(37);
        let start = flush(dir, "round", &turns).unwrap();

        let mut rebuilt = read_prefix(dir, "round", start);
        rebuilt.extend_from_slice(&turns[start..]);
        assert_eq!(rebuilt.len(), turns.len());
        assert_eq!(
            rebuilt.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            turns.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        );
    }

    /// A save that wrote its turns and then died before the session file
    /// landed leaves the log ahead of the session. Those turns are not part
    /// of the conversation and must not surface on the next open.
    #[test]
    fn turns_past_the_sessions_count_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let turns = chat(20);
        flush(dir, "torn", &turns).unwrap();
        assert_eq!(read_prefix(dir, "torn", 16).len(), 16);
        // The session file still says 12 — the last four lines were written
        // by a save that never finished.
        assert_eq!(read_prefix(dir, "torn", 12).len(), 12);
    }

    /// A conversation shorter than the live tail has nothing to archive, and
    /// should not leave an empty file behind for every chat ever opened.
    #[test]
    fn a_short_conversation_writes_no_log() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let start = flush(dir, "tiny", &chat(3)).unwrap();
        assert_eq!(start, 0);
        assert!(!path(dir, "tiny").exists());
    }
}
