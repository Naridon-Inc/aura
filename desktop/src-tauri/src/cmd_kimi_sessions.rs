//! Chat data source for Kimi Code CLI tabs.
//!
//! Kimi runs as a full TUI in a PTY, so the obvious source for its chat is the
//! terminal — and it is the wrong one for exactly the reason it was wrong for
//! Codex. A terminal reproduces the SCREEN, and Kimi's screen is largely its
//! own furniture: the prompt echoed back under a ✨, the box-drawn composer,
//! the `K3 thinking: high … context: 0% (0/256k)` status footer. None of that
//! is anything the agent said, and no amount of grid fidelity separates the
//! two, because on the screen they are the same pixels.
//!
//! Kimi keeps the real conversation in its own append-only record:
//!
//!   ~/.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl
//!
//! and — unlike Codex, whose rollouts have to be scanned and their `cwd` read
//! out one by one — it keeps an index that already answers "which session
//! belongs to this directory":
//!
//!   ~/.kimi-code/session_index.jsonl   {sessionId, sessionDir, workDir}
//!
//! So locating a repo's live conversation is one small file read, not a walk
//! over every session on the machine. `kimi_wire_read` tails what that lookup
//! finds; `jsonl_tail` does the tailing, shared with Codex.
//!
//! `agents/main` is the session's own agent. Kimi can spawn sub-agents beside
//! it under the same directory, and those are deliberately not read here: the
//! chat shows this session's conversation, and folding a sub-agent's wire into
//! it would interleave two transcripts with nothing on screen to say so.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::SystemTime;

use serde_json::Value;

use crate::jsonl_tail::{same_dir, tail, JsonlChunk};

/// `~/.kimi-code`, or None when Kimi has never run on this machine.
fn kimi_home() -> Option<PathBuf> {
    let dir = dirs::home_dir()?.join(".kimi-code");
    dir.exists().then_some(dir)
}

/// The wire this session's own agent writes.
fn wire_of(session_dir: &str) -> PathBuf {
    PathBuf::from(session_dir)
        .join("agents")
        .join("main")
        .join("wire.jsonl")
}

/// Every indexed session whose `workDir` is `repo_root`, newest wire first.
///
/// The index is append-only and keeps one line per session ever opened, so a
/// repo worked on across several sittings has several entries. Ordering by the
/// wire's mtime — not by position in the file — is what makes "the session
/// this tab is on" the one that comes back, including after a resume writes to
/// an older session again.
fn sessions_for(home: PathBuf, repo_root: &str) -> Vec<(PathBuf, String)> {
    let Ok(file) = fs::File::open(home.join("session_index.jsonl")) else {
        return Vec::new();
    };
    let mut out: Vec<(PathBuf, String, SystemTime)> = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let (Some(work_dir), Some(session_dir), Some(id)) = (
            v.get("workDir").and_then(|x| x.as_str()),
            v.get("sessionDir").and_then(|x| x.as_str()),
            v.get("sessionId").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        if !same_dir(work_dir, repo_root) {
            continue;
        }
        let wire = wire_of(session_dir);
        let Ok(modified) = fs::metadata(&wire).and_then(|m| m.modified()) else {
            // Indexed but never written to — a session that was opened and
            // abandoned. It has no conversation to show.
            continue;
        };
        out.push((wire, id.to_string(), modified));
    }
    out.sort_by_key(|(_, _, at)| *at);
    out.reverse();
    out.into_iter().map(|(w, id, _)| (w, id)).collect()
}

/// A slice of a Kimi wire, and where to resume reading it.
pub type KimiWireChunk = JsonlChunk;

/// Read a repo's Kimi wire from `since_offset` to the end.
///
/// A directory Kimi has never run in reads as empty rather than as an error:
/// the chat shows its empty state, which is the honest outcome.
#[tauri::command]
pub async fn kimi_wire_read(
    repo_root: String,
    path: Option<String>,
    since_offset: u64,
) -> Result<KimiWireChunk, String> {
    let Some(home) = kimi_home() else {
        return Ok(KimiWireChunk::default());
    };
    tokio::task::spawn_blocking(move || read_chunk(home, &repo_root, path, since_offset))
        .await
        .map_err(|e| format!("read kimi wire: {e}"))?
}

fn read_chunk(
    home: PathBuf,
    repo_root: &str,
    path: Option<String>,
    since_offset: u64,
) -> Result<KimiWireChunk, String> {
    let found = sessions_for(home, repo_root);
    let Some((wire, session_id)) = found.into_iter().next() else {
        return Ok(KimiWireChunk::default());
    };
    tail(&wire, Some(session_id), path, since_offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a fake `~/.kimi-code` holding one session for `work_dir`, and
    /// return the home and the wire inside it.
    fn one_session(name: &str, work_dir: &str, body: &str) -> (PathBuf, PathBuf) {
        let home = std::env::temp_dir().join(format!("aura-kimi-{name}"));
        let _ = fs::remove_dir_all(&home);
        let session = home.join("sessions").join("wd_x").join("session_1");
        let agent = session.join("agents").join("main");
        fs::create_dir_all(&agent).unwrap();
        let wire = agent.join("wire.jsonl");
        fs::File::create(&wire)
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
        let index = format!(
            "{{\"sessionId\":\"session_1\",\"sessionDir\":\"{}\",\"workDir\":\"{}\"}}\n",
            session.to_string_lossy(),
            work_dir
        );
        fs::File::create(home.join("session_index.jsonl"))
            .unwrap()
            .write_all(index.as_bytes())
            .unwrap();
        (home, wire)
    }

    /// The index is the whole locator: a repo's conversation is found by
    /// matching `workDir`, not by scanning every session on the machine.
    #[test]
    fn the_index_maps_a_repo_to_its_own_session() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (home, _) = one_session("locate", &cwd, "{\"type\":\"metadata\"}\n");
        let chunk = read_chunk(home.clone(), &cwd, None, 0).unwrap();
        assert_eq!(chunk.session_id.as_deref(), Some("session_1"));
        assert_eq!(chunk.lines.len(), 1);
        let _ = fs::remove_dir_all(&home);
    }

    /// A repo with no Kimi history is an empty answer, not a failure.
    #[test]
    fn a_repo_kimi_never_ran_in_reads_as_empty() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (home, _) = one_session("nomatch", &cwd, "{}\n");
        let chunk = read_chunk(home.clone(), "/not/a/real/repo", None, 0).unwrap();
        assert!(chunk.path.is_none());
        assert!(chunk.lines.is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    /// An indexed session that never wrote a wire has no conversation to show.
    /// Returning it anyway would make the chat sit empty on a repo that does
    /// have history, because the abandoned session sorts ahead of the real one.
    #[test]
    fn a_session_with_no_wire_is_skipped_for_one_that_has_one() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (home, _) = one_session("abandoned", &cwd, "{\"type\":\"metadata\"}\n");
        // A second indexed session for the same repo, with no wire on disk.
        let ghost = home.join("sessions").join("wd_x").join("session_ghost");
        fs::create_dir_all(&ghost).unwrap();
        let mut idx = fs::OpenOptions::new()
            .append(true)
            .open(home.join("session_index.jsonl"))
            .unwrap();
        idx.write_all(
            format!(
                "{{\"sessionId\":\"session_ghost\",\"sessionDir\":\"{}\",\"workDir\":\"{}\"}}\n",
                ghost.to_string_lossy(),
                cwd
            )
            .as_bytes(),
        )
        .unwrap();
        drop(idx);

        let chunk = read_chunk(home.clone(), &cwd, None, 0).unwrap();
        assert_eq!(chunk.session_id.as_deref(), Some("session_1"));
        let _ = fs::remove_dir_all(&home);
    }

    /// Tailing a live wire returns only what was appended, so a long
    /// conversation costs what the agent just wrote, not the transcript.
    #[test]
    fn a_tail_returns_only_what_was_appended() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let body = "{\"type\":\"metadata\"}\n";
        let (home, wire) = one_session("tail", &cwd, body);

        let first = read_chunk(home.clone(), &cwd, None, 0).unwrap();
        assert_eq!(first.offset, body.len() as u64);
        assert!(!first.reset);

        let mut f = fs::OpenOptions::new().append(true).open(&wire).unwrap();
        f.write_all(b"{\"type\":\"turn.prompt\"}\n").unwrap();
        drop(f);

        let second = read_chunk(home.clone(), &cwd, first.path.clone(), first.offset).unwrap();
        assert_eq!(second.lines, vec!["{\"type\":\"turn.prompt\"}".to_string()]);
        assert!(!second.reset);
        let _ = fs::remove_dir_all(&home);
    }

    /// Kimi's newer sessions are the ones a tab is on. Ordering by the wire's
    /// mtime rather than by index position is what keeps a resumed older
    /// session from being hidden behind a newer abandoned one.
    #[test]
    fn the_most_recently_written_session_wins() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let (home, first_wire) = one_session("order", &cwd, "{\"type\":\"metadata\"}\n");

        let second = home.join("sessions").join("wd_x").join("session_2");
        let agent = second.join("agents").join("main");
        fs::create_dir_all(&agent).unwrap();
        fs::File::create(agent.join("wire.jsonl"))
            .unwrap()
            .write_all(b"{\"type\":\"metadata\"}\n")
            .unwrap();
        let mut idx = fs::OpenOptions::new()
            .append(true)
            .open(home.join("session_index.jsonl"))
            .unwrap();
        idx.write_all(
            format!(
                "{{\"sessionId\":\"session_2\",\"sessionDir\":\"{}\",\"workDir\":\"{}\"}}\n",
                second.to_string_lossy(),
                cwd
            )
            .as_bytes(),
        )
        .unwrap();
        drop(idx);

        // Touch the FIRST session's wire so it is the freshest again.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut f = fs::OpenOptions::new().append(true).open(&first_wire).unwrap();
        f.write_all(b"{\"type\":\"turn.prompt\"}\n").unwrap();
        drop(f);

        let chunk = read_chunk(home.clone(), &cwd, None, 0).unwrap();
        assert_eq!(chunk.session_id.as_deref(), Some("session_1"));
        let _ = fs::remove_dir_all(&home);
    }
}
