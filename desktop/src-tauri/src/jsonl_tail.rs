//! Tailing an agent's own append-only JSONL record.
//!
//! Several CLIs run as full TUIs and keep the real conversation in a file
//! rather than on the wire: Codex appends to `~/.codex/sessions/**/rollout-*
//! .jsonl`, Kimi to `~/.kimi-code/sessions/**/agents/*/wire.jsonl`. The chat
//! reads those files instead of scraping the terminal, and the reading part is
//! identical in both cases — only *finding* the file differs. This module is
//! that shared part, so a fix to the tail (a partial write, a rotation) lands
//! for every engine at once instead of for whichever one someone remembered.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// A slice of an agent's record file, and where to resume reading it.
#[derive(Serialize, Default)]
pub struct JsonlChunk {
    /// The file being read. The caller echoes this back on the next call;
    /// when it changes, the agent started a new session and the caller must
    /// drop whatever it accumulated for the old one.
    pub path: Option<String>,
    /// The engine's own id for this session (what its `resume` takes).
    pub session_id: Option<String>,
    /// Byte offset to pass as `since_offset` next time.
    pub offset: u64,
    /// Complete JSONL records read since `since_offset`, one per string.
    pub lines: Vec<String>,
    /// The caller's accumulated events are stale — start over from `lines`.
    /// True when the file rotated, or when it shrank underneath us.
    pub reset: bool,
}

/// Compare directories the way a person would: through symlinks, without
/// caring about a trailing slash.
pub fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        fs::canonicalize(p)
            .unwrap_or_else(|_| PathBuf::from(p))
            .to_string_lossy()
            .to_string()
    };
    norm(a) == norm(b)
}

/// Read `found` from `since_offset` to the end.
///
/// The contract is a tail, not a snapshot: the caller keeps `(path, offset)`
/// and gets only what has been appended since. These files are append-only
/// while their session lives, so this stays cheap no matter how long the
/// conversation runs — the cost is what the agent wrote in the last tick, not
/// the transcript.
///
/// Two things force a reset rather than a continuation, and both are reported
/// rather than papered over: the newest file for this directory is not the one
/// the caller was reading (a new session started), or the file is now shorter
/// than the offset (it was replaced). Silently continuing in either case would
/// splice two conversations together.
///
/// A partial trailing line — the agent mid-write — is deliberately NOT
/// returned, and `offset` stops before it, so the next call re-reads it whole.
/// Handing back half a JSON object would make the adapter drop a real event.
pub fn tail(
    found: &Path,
    session_id: Option<String>,
    path: Option<String>,
    since_offset: u64,
) -> Result<JsonlChunk, String> {
    let found_str = found.to_string_lossy().to_string();
    // Only a caller that named a file can be continuing one. A first read
    // (`path: None`) starts at the top and is not a reset — there is nothing
    // on the other side to throw away.
    let continuing = path.as_deref() == Some(found_str.as_str());

    let mut file = fs::File::open(found).map_err(|e| format!("open record: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("stat record: {e}"))?
        .len();
    let truncated = since_offset > len;
    let reset = (path.is_some() && !continuing) || truncated;
    let start = if continuing && !truncated {
        since_offset
    } else {
        0
    };

    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek record: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read record: {e}"))?;

    // Stop at the last newline. Everything after it is a record the agent has
    // not finished writing.
    let complete = match buf.iter().rposition(|b| *b == b'\n') {
        Some(at) => at + 1,
        None => 0,
    };
    let lines = String::from_utf8_lossy(&buf[..complete])
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(JsonlChunk {
        path: Some(found_str),
        session_id,
        offset: start + complete as u64,
        lines,
        reset,
    })
}
