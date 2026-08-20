//! Chat data source for Pi CLI tabs.
//!
//! Pi runs as a full TUI in a PTY, so the obvious source for its chat is the
//! terminal — and it is the wrong one for the same reason it was wrong for
//! Codex and Kimi. A terminal reproduces the SCREEN, and Pi's screen is partly
//! its own furniture: the prompt echoed under a `>`, the box-drawn composer,
//! the model/thinking/context status line. None of that is anything the agent
//! said, and no amount of grid fidelity separates the two, because on the
//! screen they are the same pixels.
//!
//! Pi keeps the real conversation in an append-only JSONL session file, and
//! finding it needs no index and no scan — the directory name IS the cwd:
//!
//!   ~/.pi/agent/sessions/--Users-me-proj--/<timestamp>_<sessionId>.jsonl
//!
//! Pi builds that directory as `--` + the absolute cwd with its leading
//! separator dropped and every `/`, `\` and `:` turned into `-` + `--`
//! (`getDefaultSessionDirPath` in its own session-manager). So one string
//! transform locates a repo's sessions directly, and the newest `.jsonl` in it
//! is the conversation this tab is on. `PI_CODING_AGENT_DIR` moves the whole
//! agent directory and is honoured, because a user who set it has no sessions
//! at the default path at all.
//!
//! The path is built from the LITERAL repo root rather than a canonicalized
//! one on purpose: pi encodes whatever absolute path it was launched with
//! (`resolvePath` is a resolve, not a realpath), and the app launches it with
//! this same string, so matching it literally is what makes the two agree on
//! a machine where `/tmp` is a symlink to `/private/tmp`.
//!
//! What comes back is the same `{type:"session"}` header the `--mode json`
//! wire opens with, followed by session entries — `{type:"message", message}`
//! among them, carrying the very `UserMessage` / `AssistantMessage` /
//! `ToolResultMessage` values that mode streams. So ONE adapter
//! (`agentProtocol/adapters/pi.ts`) reads both, and neither the store nor the
//! renderer learns that a tab is being read from a file.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use crate::jsonl_tail::{tail, JsonlChunk};

/// Pi's agent directory — `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. `None`
/// when pi has never run on this machine.
fn pi_agent_dir() -> Option<PathBuf> {
    let dir = match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(v) if !v.trim().is_empty() => PathBuf::from(v.trim()),
        _ => dirs::home_dir()?.join(".pi").join("agent"),
    };
    dir.exists().then_some(dir)
}

/// Pi's own encoding of a working directory into one directory name.
///
/// Ported from `getDefaultSessionDirPath`: strip the leading separator, turn
/// every `/`, `\` and `:` into `-`, and wrap the result in `--`. `/Users/me/p`
/// becomes `--Users-me-p--`.
///
/// Trailing separators are trimmed first because pi resolves its cwd before
/// encoding it, and `/repo/` and `/repo` resolve to the same path — but encode
/// to different directory names, which would send us looking in one that pi
/// never writes to.
fn encode_cwd(repo_root: &str) -> String {
    let trimmed = repo_root.trim_end_matches(['/', '\\']);
    let body: String = trimmed
        .trim_start_matches(['/', '\\'])
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') { '-' } else { c })
        .collect();
    format!("--{body}--")
}

/// Pi's session id for a file it wrote.
///
/// Session files are named `<fileTimestamp>_<sessionId>.jsonl`, where the
/// timestamp is an ISO string with `:` and `.` replaced by `-` — so it never
/// contains an underscore, and the FIRST one splits the two halves exactly,
/// even for an id that has underscores of its own.
///
/// A file with no underscore was not named by pi's own create path (it was
/// opened by explicit `--session <path>`), so its id is read from the header
/// line instead of guessed at from the name.
fn session_id_of(file: &std::path::Path) -> Option<String> {
    let stem = file.file_stem()?.to_string_lossy().to_string();
    if let Some((_, id)) = stem.split_once('_') {
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    header_id(file)
}

/// The `id` on the session header, which is the file's first line.
fn header_id(file: &std::path::Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let f = fs::File::open(file).ok()?;
    let mut first = String::new();
    BufReader::new(f).read_line(&mut first).ok()?;
    let v: serde_json::Value = serde_json::from_str(first.trim()).ok()?;
    v.get("id")?.as_str().map(|s| s.to_string())
}

/// The newest session file pi wrote for `repo_root`, with its id.
///
/// Newest by mtime rather than by name: resuming an older session appends to
/// it, so the file whose NAME sorts last is not necessarily the conversation
/// the tab is on.
fn newest_session(agent_dir: PathBuf, repo_root: &str) -> Option<(PathBuf, String)> {
    let dir = agent_dir.join("sessions").join(encode_cwd(repo_root));
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(_, at)| modified > *at) {
            best = Some((path, modified));
        }
    }
    let (path, _) = best?;
    let id = session_id_of(&path)?;
    Some((path, id))
}

/// A slice of a Pi session file, and where to resume reading it.
pub type PiSessionChunk = JsonlChunk;

/// The newest Pi session id recorded for this directory, or `None` when Pi has
/// never run here.
///
/// This is what a restored tab passes to `pi --session-id <id>` to rejoin the
/// conversation it left. Scoped to the directory rather than to the machine on
/// purpose: Pi's sessions all live under one agent directory, so "the newest
/// session" on a box driving several worktrees is usually another project's.
#[tauri::command]
pub async fn pi_latest_session(repo_root: String) -> Result<Option<String>, String> {
    let Some(agent_dir) = pi_agent_dir() else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || newest_session(agent_dir, &repo_root).map(|(_, id)| id))
        .await
        .map_err(|e| format!("find pi session: {e}"))
}

/// Read a repo's Pi session from `since_offset` to the end.
///
/// A directory pi has never run in reads as empty rather than as an error: the
/// chat shows its empty state, which is the honest outcome.
#[tauri::command]
pub async fn pi_session_read(
    repo_root: String,
    path: Option<String>,
    since_offset: u64,
) -> Result<PiSessionChunk, String> {
    let Some(agent_dir) = pi_agent_dir() else {
        return Ok(PiSessionChunk::default());
    };
    tokio::task::spawn_blocking(move || read_chunk(agent_dir, &repo_root, path, since_offset))
        .await
        .map_err(|e| format!("read pi session: {e}"))?
}

fn read_chunk(
    agent_dir: PathBuf,
    repo_root: &str,
    path: Option<String>,
    since_offset: u64,
) -> Result<PiSessionChunk, String> {
    let Some((file, session_id)) = newest_session(agent_dir, repo_root) else {
        return Ok(PiSessionChunk::default());
    };
    tail(&file, Some(session_id), path, since_offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a fake pi agent dir holding one session for `work_dir`, and
    /// return the agent dir and the session file inside it.
    fn one_session(name: &str, work_dir: &str, file: &str, body: &str) -> (PathBuf, PathBuf) {
        let agent = std::env::temp_dir().join(format!("aura-pi-{name}"));
        let _ = fs::remove_dir_all(&agent);
        let dir = agent.join("sessions").join(encode_cwd(work_dir));
        fs::create_dir_all(&dir).unwrap();
        let session = dir.join(file);
        fs::File::create(&session)
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
        (agent, session)
    }

    /// Pi's encoding is the whole locator — no index, no scan. Getting it
    /// wrong doesn't error, it silently reads an empty conversation, so it is
    /// pinned here against pi's own `getDefaultSessionDirPath`.
    #[test]
    fn a_cwd_encodes_the_way_pi_encodes_it() {
        assert_eq!(encode_cwd("/Users/me/proj"), "--Users-me-proj--");
        assert_eq!(encode_cwd("/"), "----");
        // A trailing separator would otherwise name a directory pi never
        // writes to, because pi resolves the cwd before encoding it.
        assert_eq!(encode_cwd("/Users/me/proj/"), "--Users-me-proj--");
        // Windows separators and the drive colon each fold to their own dash,
        // and pi strips only a LEADING separator — so `C:\` keeps both.
        assert_eq!(encode_cwd("C:\\Users\\me\\proj"), "--C--Users-me-proj--");
    }

    #[test]
    fn the_encoded_directory_is_how_a_repo_finds_its_own_session() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (agent, _) = one_session(
            "locate",
            &cwd,
            "2026-08-03T10-00-00-000Z_a1b2c3d4.jsonl",
            "{\"type\":\"session\",\"id\":\"a1b2c3d4\",\"cwd\":\"/x\"}\n",
        );
        let chunk = read_chunk(agent.clone(), &cwd, None, 0).unwrap();
        assert_eq!(chunk.session_id.as_deref(), Some("a1b2c3d4"));
        assert_eq!(chunk.lines.len(), 1);
        let _ = fs::remove_dir_all(&agent);
    }

    /// A repo pi never ran in is an empty answer, not a failure.
    #[test]
    fn a_repo_pi_never_ran_in_reads_as_empty() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (agent, _) = one_session("nomatch", &cwd, "2026-01-01T00-00-00-000Z_x.jsonl", "{}\n");
        let chunk = read_chunk(agent.clone(), "/not/a/real/repo", None, 0).unwrap();
        assert!(chunk.path.is_none());
        assert!(chunk.lines.is_empty());
        let _ = fs::remove_dir_all(&agent);
    }

    /// The id is what `pi --session-id` takes to rejoin, so it has to be the
    /// id and not the timestamp in front of it.
    #[test]
    fn the_session_id_survives_underscores_inside_it() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (agent, file) = one_session(
            "idsplit",
            &cwd,
            "2026-08-03T10-00-00-000Z_my_named_session.jsonl",
            "{\"type\":\"session\"}\n",
        );
        assert_eq!(session_id_of(&file).as_deref(), Some("my_named_session"));
        let _ = fs::remove_dir_all(&agent);
    }

    /// A file pi opened by explicit path has no timestamp prefix to split, so
    /// the header is the fallback — and the header is authoritative anyway.
    #[test]
    fn a_file_with_no_timestamp_prefix_reads_its_id_from_the_header() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (agent, file) = one_session(
            "headerid",
            &cwd,
            "handpicked.jsonl",
            "{\"type\":\"session\",\"version\":3,\"id\":\"deadbeef\",\"cwd\":\"/x\"}\n",
        );
        assert_eq!(session_id_of(&file).as_deref(), Some("deadbeef"));
        let _ = fs::remove_dir_all(&agent);
    }

    /// Tailing a live session returns only what was appended, so a long
    /// conversation costs what the agent just wrote, not the transcript.
    #[test]
    fn a_tail_returns_only_what_was_appended() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let body = "{\"type\":\"session\",\"id\":\"a1\"}\n";
        let (agent, file) = one_session("tail", &cwd, "2026-08-03T10-00-00-000Z_a1.jsonl", body);

        let first = read_chunk(agent.clone(), &cwd, None, 0).unwrap();
        assert_eq!(first.offset, body.len() as u64);
        assert!(!first.reset);

        let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
        f.write_all(b"{\"type\":\"message\",\"id\":\"e1\"}\n").unwrap();
        drop(f);

        let second = read_chunk(agent.clone(), &cwd, first.path.clone(), first.offset).unwrap();
        assert_eq!(
            second.lines,
            vec!["{\"type\":\"message\",\"id\":\"e1\"}".to_string()]
        );
        assert!(!second.reset);
        let _ = fs::remove_dir_all(&agent);
    }

    /// Resuming an older session appends to it, so "newest" has to mean most
    /// recently WRITTEN, not last by filename. Sorting by name would leave the
    /// chat pinned to a session nobody is talking to.
    #[test]
    fn the_most_recently_written_session_wins_over_the_latest_named_one() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (agent, older) = one_session(
            "order",
            &cwd,
            "2026-08-01T10-00-00-000Z_old.jsonl",
            "{\"type\":\"session\",\"id\":\"old\"}\n",
        );
        let dir = older.parent().unwrap().to_path_buf();
        fs::File::create(dir.join("2026-08-09T10-00-00-000Z_new.jsonl"))
            .unwrap()
            .write_all(b"{\"type\":\"session\",\"id\":\"new\"}\n")
            .unwrap();

        // Touch the OLDER session so it is the freshest again — a resume.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut f = fs::OpenOptions::new().append(true).open(&older).unwrap();
        f.write_all(b"{\"type\":\"message\"}\n").unwrap();
        drop(f);

        let chunk = read_chunk(agent.clone(), &cwd, None, 0).unwrap();
        assert_eq!(chunk.session_id.as_deref(), Some("old"));
        let _ = fs::remove_dir_all(&agent);
    }

    /// A new session means the accumulated transcript belongs to a different
    /// conversation — reported, not spliced onto the end of the old one.
    #[test]
    fn a_new_session_resets_rather_than_continuing_the_old_one() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (agent, older) = one_session(
            "reset",
            &cwd,
            "2026-08-01T10-00-00-000Z_old.jsonl",
            "{\"type\":\"session\",\"id\":\"old\"}\n",
        );
        let first = read_chunk(agent.clone(), &cwd, None, 0).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        let dir = older.parent().unwrap().to_path_buf();
        fs::File::create(dir.join("2026-08-09T10-00-00-000Z_new.jsonl"))
            .unwrap()
            .write_all(b"{\"type\":\"session\",\"id\":\"new\"}\n")
            .unwrap();

        let second = read_chunk(agent.clone(), &cwd, first.path.clone(), first.offset).unwrap();
        assert!(second.reset);
        assert_eq!(second.session_id.as_deref(), Some("new"));
        let _ = fs::remove_dir_all(&agent);
    }

    /// Non-session files in the directory are not conversations. Pi writes
    /// nothing else there today, but picking one up would show an empty chat
    /// on a repo that has real history.
    #[test]
    fn only_jsonl_files_count_as_sessions() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (agent, session) = one_session(
            "ext",
            &cwd,
            "2026-08-01T10-00-00-000Z_real.jsonl",
            "{\"type\":\"session\",\"id\":\"real\"}\n",
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::File::create(session.parent().unwrap().join("notes.txt"))
            .unwrap()
            .write_all(b"scratch\n")
            .unwrap();

        let chunk = read_chunk(agent.clone(), &cwd, None, 0).unwrap();
        assert_eq!(chunk.session_id.as_deref(), Some("real"));
        let _ = fs::remove_dir_all(&agent);
    }
}
