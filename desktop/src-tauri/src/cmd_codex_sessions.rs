//! Resume data source for Codex CLI tabs.
//!
//! Codex writes one JSONL "rollout" per interactive session under
//! `~/.codex/sessions/<Y>/<M>/<D>/rollout-<iso>-<uuid>.jsonl`. The first
//! line is a `session_meta` record carrying the session id and the `cwd`
//! the session ran in.
//!
//! Why this exists rather than `codex resume --last`: `--last` continues
//! the most recent recorded session on the machine, and the sessions store
//! is global. On a machine driving several repos and worktrees at once —
//! which is the whole point of Aura — the newest rollout routinely belongs
//! to a different project, so `--last` would reopen someone else's
//! conversation in this tab. Matching on the recorded `cwd` gives the tab
//! back its OWN session, and returns `None` (→ a fresh REPL) when this
//! directory has no history rather than guessing.
//!
//! Scoping matches the Claude path's rule (see `agentSessionScope` on the
//! frontend): a session authored in a worktree belongs to that worktree.
//!
//! The same rollout is also the chat's source of truth. Codex runs as a full
//! TUI in a PTY, and scraping that terminal back into a conversation drags the
//! CLI's own furniture along with it — the echoed prompt, the composer
//! placeholder, the status footer — none of which the agent said. The rollout
//! is the structured record behind that screen: user messages, agent messages,
//! reasoning, tool calls and their output, patches, token counts. Reading it
//! is what lets Codex render in the same card transcript as Claude Code rather
//! than as a wall of terminal text. `codex_rollout_read` tails it.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::SystemTime;

use serde_json::Value;

use crate::jsonl_tail::{same_dir, tail, JsonlChunk};

/// The rollout files, newest-modified first.
fn rollouts(sessions_dir: PathBuf) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack = vec![sessions_dir];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
                .unwrap_or(false)
            {
                out.push(path);
            }
        }
    }
    out.sort_by_key(|p| {
        fs::metadata(p)
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    out.reverse();
    out
}

/// `(cwd, session id)` from a rollout's leading `session_meta` line.
///
/// Codex has moved the payload around between versions, so read both the
/// flat and the `payload`-nested shape rather than pinning one layout.
///
/// `id` before `session_id`, and the order matters: on a rollout that was
/// forked from an earlier thread the two differ — `id` names THIS rollout
/// (it matches the filename uuid, which is what `codex resume` resolves)
/// while `session_id` still points at the thread it branched from. Reading
/// `session_id` would quietly reopen the parent conversation.
fn meta_of(path: &PathBuf) -> Option<(String, String)> {
    let file = fs::File::open(path).ok()?;
    let first = BufReader::new(file).lines().next()?.ok()?;
    let v: Value = serde_json::from_str(&first).ok()?;
    let payload = v.get("payload").unwrap_or(&v);
    let cwd = payload.get("cwd").and_then(|x| x.as_str())?;
    let id = payload
        .get("id")
        .or_else(|| payload.get("session_id"))
        .and_then(|x| x.as_str())?;
    if cwd.is_empty() || id.is_empty() {
        return None;
    }
    Some((cwd.to_string(), id.to_string()))
}

/// The newest rollout authored in `repo_root`, with its session id.
fn newest_rollout(sessions_dir: PathBuf, repo_root: &str) -> Option<(PathBuf, String)> {
    for path in rollouts(sessions_dir) {
        let Some((cwd, id)) = meta_of(&path) else {
            continue;
        };
        if same_dir(&cwd, repo_root) {
            return Some((path, id));
        }
    }
    None
}

/// Newest Codex session id recorded for `repo_root`, or `None` when this
/// directory has no rollout of its own.
///
/// `None` is a real answer, not a failure: the caller starts a fresh REPL
/// with it, which is the honest outcome for a directory Codex has never
/// run in.
#[tauri::command]
pub async fn codex_latest_session(repo_root: String) -> Result<Option<String>, String> {
    let Some(sessions_dir) = sessions_dir() else {
        return Ok(None);
    };
    let found = tokio::task::spawn_blocking(move || {
        newest_rollout(sessions_dir, &repo_root).map(|(_, id)| id)
    })
    .await
    .map_err(|e| format!("scan codex sessions: {e}"))?;
    Ok(found)
}

/// `~/.codex/sessions`, or None when Codex has never run on this machine.
fn sessions_dir() -> Option<PathBuf> {
    let dir = dirs::home_dir()?.join(".codex").join("sessions");
    dir.exists().then_some(dir)
}

/// A slice of a rollout, and where to resume reading it. The shape is shared
/// with every other engine that keeps its conversation in a JSONL file —
/// finding the file is Codex-specific, reading it is not.
pub type CodexRolloutChunk = JsonlChunk;

/// Read a repo's Codex rollout from `since_offset` to the end.
///
/// The contract is a tail, not a snapshot: the caller keeps `(path, offset)`
/// and gets only what has been appended since. A rollout is append-only while
/// its session lives, so this stays cheap no matter how long the conversation
/// runs — the cost is what Codex wrote in the last tick, not the transcript.
///
/// Two things force a reset rather than a continuation, and both are reported
/// rather than papered over: the newest rollout for this directory is not the
/// one the caller was reading (a new session started), or the file is now
/// shorter than the offset (it was replaced). Silently continuing in either
/// case would splice two conversations together.
///
/// A partial trailing line — Codex mid-write — is deliberately NOT returned,
/// and `offset` stops before it, so the next call re-reads it whole. Handing
/// back half a JSON object would make the adapter drop a real event.
#[tauri::command]
pub async fn codex_rollout_read(
    repo_root: String,
    path: Option<String>,
    since_offset: u64,
) -> Result<CodexRolloutChunk, String> {
    let Some(sessions_dir) = sessions_dir() else {
        return Ok(CodexRolloutChunk::default());
    };
    tokio::task::spawn_blocking(move || read_chunk(sessions_dir, &repo_root, path, since_offset))
        .await
        .map_err(|e| format!("read codex rollout: {e}"))?
}

fn read_chunk(
    sessions_dir: PathBuf,
    repo_root: &str,
    path: Option<String>,
    since_offset: u64,
) -> Result<CodexRolloutChunk, String> {
    let Some((found, session_id)) = newest_rollout(sessions_dir, repo_root) else {
        return Ok(CodexRolloutChunk::default());
    };
    tail(&found, Some(session_id), path, since_offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_rollout(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p
    }

    /// The nested shape codex writes today.
    #[test]
    fn meta_reads_the_payload_nested_shape() {
        let tmp = std::env::temp_dir().join("aura-codex-meta-nested");
        let p = write_rollout(
            &tmp,
            "rollout-2026-08-01T10-00-00-aaa.jsonl",
            r#"{"type":"session_meta","payload":{"id":"11111111-2222-3333-4444-555555555555","cwd":"/repo/one"}}
{"type":"response_item"}
"#,
        );
        let (cwd, id) = meta_of(&p).expect("meta parsed");
        assert_eq!(cwd, "/repo/one");
        assert_eq!(id, "11111111-2222-3333-4444-555555555555");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// …and the flat shape older versions wrote. Pinning one layout is how
    /// a resume silently degrades to "always a new session" after a CLI
    /// upgrade, with nothing on screen to say why.
    #[test]
    fn meta_reads_the_flat_shape_too() {
        let tmp = std::env::temp_dir().join("aura-codex-meta-flat");
        let p = write_rollout(
            &tmp,
            "rollout-2026-08-01T10-00-00-bbb.jsonl",
            r#"{"session_id":"66666666-7777-8888-9999-000000000000","cwd":"/repo/two"}
"#,
        );
        let (cwd, id) = meta_of(&p).expect("meta parsed");
        assert_eq!(cwd, "/repo/two");
        assert_eq!(id, "66666666-7777-8888-9999-000000000000");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A forked rollout carries both fields, and they name different
    /// threads: `id` is this rollout (and the filename), `session_id` is
    /// the conversation it branched from. Resuming the parent would drop
    /// everything the user did after the fork.
    #[test]
    fn a_forked_rollout_resumes_itself_not_its_parent() {
        let tmp = std::env::temp_dir().join("aura-codex-meta-fork");
        let p = write_rollout(
            &tmp,
            "rollout-2026-08-01T10-00-00-ddd.jsonl",
            r#"{"type":"session_meta","payload":{"session_id":"parent-thread-uuid","id":"this-rollout-uuid","forked_from_id":"parent-thread-uuid","cwd":"/repo/four"}}
"#,
        );
        let (cwd, id) = meta_of(&p).expect("meta parsed");
        assert_eq!(cwd, "/repo/four");
        assert_eq!(id, "this-rollout-uuid");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A rollout with no cwd/id is skipped, not treated as a match — the
    /// caller must not resume a session it can't name.
    #[test]
    fn meta_skips_a_rollout_without_cwd_or_id() {
        let tmp = std::env::temp_dir().join("aura-codex-meta-partial");
        let p = write_rollout(
            &tmp,
            "rollout-2026-08-01T10-00-00-ccc.jsonl",
            "{\"payload\":{\"cwd\":\"/repo/three\"}}\n",
        );
        assert!(meta_of(&p).is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    // ── Tailing a live rollout ───────────────────────────────────────────
    //
    // The chat reads the transcript through `read_chunk`, so what these pin
    // is whether a conversation can be reconstructed from repeated calls
    // without gaining or losing a line.

    fn meta_line(cwd: &str) -> String {
        format!(r#"{{"type":"session_meta","payload":{{"id":"sess-1","cwd":"{cwd}"}}}}"#)
    }

    /// Build a sessions dir holding one rollout for `cwd`, and return both.
    fn one_rollout(name: &str, cwd: &str, body: &str) -> (PathBuf, PathBuf) {
        let tmp = std::env::temp_dir().join(format!("aura-codex-tail-{name}"));
        let _ = fs::remove_dir_all(&tmp);
        let day = tmp.join("2026").join("08").join("02");
        let file = write_rollout(&day, "rollout-2026-08-02T10-00-00-aaa.jsonl", body);
        let _ = cwd;
        (tmp, file)
    }

    #[test]
    fn a_tail_returns_only_what_was_appended_since_the_last_read() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let body = format!("{}\n{{\"type\":\"a\"}}\n", meta_line(&cwd));
        let (dir, file) = one_rollout("append", &cwd, &body);

        let first = read_chunk(dir.clone(), &cwd, None, 0).unwrap();
        assert_eq!(first.lines.len(), 2, "meta + one record");
        assert_eq!(first.offset, body.len() as u64);
        assert!(!first.reset);

        let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
        f.write_all(b"{\"type\":\"b\"}\n").unwrap();
        drop(f);

        let second = read_chunk(dir.clone(), &cwd, first.path.clone(), first.offset).unwrap();
        assert_eq!(second.lines, vec!["{\"type\":\"b\"}".to_string()]);
        assert!(!second.reset, "same file, just longer — not a reset");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Codex writes a record in pieces. Handing back half an object would
    /// make the adapter drop a real event, so a partial trailing line is
    /// held back and the offset stops before it.
    #[test]
    fn a_half_written_record_is_held_back_until_its_newline_lands() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let whole = format!("{}\n", meta_line(&cwd));
        let body = format!("{whole}{{\"type\":\"partial\"");
        let (dir, file) = one_rollout("partial", &cwd, &body);

        let chunk = read_chunk(dir.clone(), &cwd, None, 0).unwrap();
        assert_eq!(chunk.lines.len(), 1, "only the complete meta line");
        assert_eq!(chunk.offset, whole.len() as u64);

        let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
        f.write_all(b"}\n").unwrap();
        drop(f);

        let rest = read_chunk(dir.clone(), &cwd, chunk.path.clone(), chunk.offset).unwrap();
        assert_eq!(rest.lines, vec!["{\"type\":\"partial\"}".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A new session writes a NEW rollout. Continuing from the old offset
    /// would splice two conversations together, so the caller is told to
    /// throw away what it had.
    #[test]
    fn a_new_session_resets_instead_of_continuing_the_old_one() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let body = format!("{}\n", meta_line(&cwd));
        let (dir, _) = one_rollout("rotate", &cwd, &body);
        let first = read_chunk(dir.clone(), &cwd, None, 0).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        let day = dir.join("2026").join("08").join("02");
        write_rollout(
            &day,
            "rollout-2026-08-02T11-00-00-bbb.jsonl",
            &format!("{}\n{{\"type\":\"fresh\"}}\n", meta_line(&cwd)),
        );

        let second = read_chunk(dir.clone(), &cwd, first.path.clone(), first.offset).unwrap();
        assert!(second.reset, "different rollout — the caller must start over");
        assert_eq!(second.lines.len(), 2, "read from the top, not from the offset");
        let _ = fs::remove_dir_all(&dir);
    }

    /// An offset past the end means the file was replaced under us. Seeking
    /// there would return nothing forever — the chat would silently stop
    /// updating with no error to explain it.
    #[test]
    fn an_offset_past_the_end_rereads_from_the_top() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let body = format!("{}\n", meta_line(&cwd));
        let (dir, _) = one_rollout("shrunk", &cwd, &body);

        let chunk = read_chunk(dir.clone(), &cwd, None, 99_999).unwrap();
        assert!(chunk.reset);
        assert_eq!(chunk.lines.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A directory Codex never ran in has no rollout, and that is an answer,
    /// not an error — the chat shows its empty state rather than a failure.
    #[test]
    fn a_directory_with_no_rollout_reads_as_empty() {
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let body = format!("{}\n", meta_line("/somewhere/else/entirely"));
        let (dir, _) = one_rollout("nomatch", &cwd, &body);

        let chunk = read_chunk(dir.clone(), "/not/a/real/repo/root", None, 0).unwrap();
        assert!(chunk.path.is_none());
        assert!(chunk.lines.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Newest-first ordering is what makes "the session this tab was on"
    /// the one that comes back.
    #[test]
    fn rollouts_come_back_newest_first() {
        let tmp = std::env::temp_dir().join("aura-codex-order");
        let _ = fs::remove_dir_all(&tmp);
        let day = tmp.join("2026").join("08").join("01");
        let older = write_rollout(&day, "rollout-2026-08-01T09-00-00-aaa.jsonl", "{}\n");
        std::thread::sleep(std::time::Duration::from_millis(20));
        let newer = write_rollout(&day, "rollout-2026-08-01T10-00-00-bbb.jsonl", "{}\n");
        let list = rollouts(tmp.clone());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], newer);
        assert_eq!(list[1], older);
        let _ = fs::remove_dir_all(&tmp);
    }
}
