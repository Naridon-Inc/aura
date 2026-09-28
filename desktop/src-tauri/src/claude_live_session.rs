//! Which conversation a Claude Code PTY is in *right now*.
//!
//! An agent tab's Chat view reads Claude's transcript JSONL, while its CLI view
//! is the process itself. The tab used to decide which JSONL was "its" once, on
//! mount, and tail that file forever. Inside the CLI, though, the conversation
//! is not fixed: `/resume` moves the same process onto another session's
//! transcript and `/clear` starts a new one. The CLI then writes somewhere the
//! Chat view is not reading, and the two views of one tab show two different
//! conversations.
//!
//! Claude Code keeps a per-process registry for exactly this question:
//! `~/.claude/sessions/<pid>.json`, rewritten with the new `sessionId` whenever
//! that process switches conversation. The PTY child's pid is ours, so the
//! answer is the registry entry for that pid — or, when the CLI was started
//! through a wrapper, for a process inside the PTY's process session (the child
//! is `setsid`-ed at spawn, so every descendant reports it as session leader).
//!
//! Only the id, working directory, kind and timestamps are read from the
//! registry. The files beside it (`*.key`) are never opened.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cmd_agent_pty::AgentPtyRegistry;
use crate::cmd_claude_sessions::{encode_path, projects_root_dir};

/// One `~/.claude/sessions/<pid>.json`, reduced to what the lookup needs.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistryEntry {
    pub pid: u32,
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// `interactive` for a CLI a person is driving. Anything else (a headless
    /// `claude -p` the agent ran from its own shell tool) lives in the same
    /// process session but is not the conversation on screen.
    #[serde(default)]
    pub kind: Option<String>,
    /// ms since epoch; the tie-breaker when more than one interactive CLI
    /// shares the PTY's process session.
    #[serde(default)]
    pub updated_at: Option<u64>,
}

/// The conversation a PTY's CLI is in.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LiveClaudeSession {
    pub session_id: String,
    /// The transcript on disk. None while Claude has not written a line of it
    /// yet — right after `/clear`, or a fresh start before the first prompt.
    pub file_path: Option<String>,
}

pub(crate) fn sessions_registry_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".claude").join("sessions"))
}

/// Every parseable registry entry in `dir`. A missing directory (an older
/// Claude Code that does not keep one) and unreadable or half-written files
/// read as nothing rather than as an error: the caller falls back to what it
/// already knew.
pub(crate) fn read_registry(dir: &Path) -> Vec<RegistryEntry> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|p| fs::read(&p).ok())
        .filter_map(|bytes| serde_json::from_slice::<RegistryEntry>(&bytes).ok())
        .collect()
}

/// The entry for the CLI running in the PTY whose child is `leader`.
///
/// The child itself wins outright — that is the normal launch, `claude` as the
/// PTY's own process. Otherwise the most recently updated interactive CLI whose
/// process session is `leader`'s. `session_of` is `getsid(2)` in production and
/// a table in tests.
pub(crate) fn entry_for_process_tree<'a>(
    entries: &'a [RegistryEntry],
    leader: u32,
    session_of: impl Fn(u32) -> Option<u32>,
) -> Option<&'a RegistryEntry> {
    if let Some(own) = entries.iter().find(|e| e.pid == leader) {
        return Some(own);
    }
    entries
        .iter()
        .filter(|e| e.kind.as_deref().map_or(true, |k| k == "interactive"))
        .filter(|e| session_of(e.pid) == Some(leader))
        .max_by_key(|e| e.updated_at.unwrap_or(0))
}

/// Where `entry`'s transcript is. First under the directory Claude files the
/// process's cwd as; failing that, under any project directory, because
/// `/resume` can pick up a conversation that began in another directory and
/// its transcript stays where it was first written.
pub(crate) fn transcript_for(projects_root: &Path, entry: &RegistryEntry) -> Option<PathBuf> {
    // The id becomes a file name. Refuse anything that could walk out of the
    // project directory rather than trust the registry to be well-formed.
    let id = entry.session_id.as_str();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let name = format!("{id}.jsonl");
    if let Some(cwd) = entry.cwd.as_deref() {
        let p = projects_root.join(encode_path(cwd)).join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    fs::read_dir(projects_root)
        .ok()?
        .flatten()
        .map(|d| d.path().join(&name))
        .find(|p| p.is_file())
}

/// The whole lookup against explicit roots, so it can run on fixtures.
pub(crate) fn live_session_in(
    registry_dir: &Path,
    projects_root: &Path,
    leader: u32,
    session_of: impl Fn(u32) -> Option<u32>,
) -> Option<LiveClaudeSession> {
    let entries = read_registry(registry_dir);
    let entry = entry_for_process_tree(&entries, leader, session_of)?;
    Some(LiveClaudeSession {
        session_id: entry.session_id.clone(),
        file_path: transcript_for(projects_root, entry).map(|p| p.to_string_lossy().into_owned()),
    })
}

#[cfg(unix)]
fn session_leader_of(pid: u32) -> Option<u32> {
    // getsid on a pid that has gone (or was never ours to ask about) is -1,
    // which is how a registry file left behind by a dead CLI drops out.
    let sid = unsafe { libc::getsid(pid as libc::pid_t) };
    (sid > 0).then_some(sid as u32)
}

#[cfg(not(unix))]
fn session_leader_of(_pid: u32) -> Option<u32> {
    // No process sessions to walk: only the exact-pid match applies.
    None
}

/// The conversation the Claude CLI in PTY `session_id` is in right now, or
/// None when there is no way to tell (unknown or daemon-backed session, no
/// registry entry yet, an older Claude Code without the registry).
#[tauri::command]
pub async fn agent_pty_claude_session(
    state: State<'_, AgentPtyRegistry>,
    session_id: String,
) -> Result<Option<LiveClaudeSession>, String> {
    let Some(leader) = state.child_pid(&session_id) else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || {
        let registry = sessions_registry_dir()?;
        let projects = projects_root_dir()?;
        live_session_in(&registry, &projects, leader, session_leader_of)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn entry(pid: u32, id: &str, kind: Option<&str>, updated: u64) -> RegistryEntry {
        RegistryEntry {
            pid,
            session_id: id.into(),
            cwd: None,
            kind: kind.map(str::to_string),
            updated_at: Some(updated),
        }
    }

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn the_pty_child_s_own_entry_wins() {
        let entries = vec![
            entry(200, "wrapper-child", Some("interactive"), 9),
            entry(100, "own", Some("interactive"), 1),
        ];
        let got = entry_for_process_tree(&entries, 100, |_| Some(100)).unwrap();
        assert_eq!(got.session_id, "own");
    }

    #[test]
    fn a_cli_under_a_wrapper_is_found_by_its_process_session() {
        let sids: HashMap<u32, u32> = [(200, 100), (300, 555)].into();
        let entries = vec![
            entry(300, "another-tab", Some("interactive"), 50),
            entry(200, "ours", Some("interactive"), 10),
        ];
        let got = entry_for_process_tree(&entries, 100, |p| sids.get(&p).copied()).unwrap();
        assert_eq!(got.session_id, "ours");
    }

    #[test]
    fn a_headless_claude_the_agent_ran_is_not_the_conversation_on_screen() {
        let sids: HashMap<u32, u32> = [(200, 100), (201, 100)].into();
        let entries = vec![
            entry(201, "print-mode", Some("print"), 99),
            entry(200, "on-screen", Some("interactive"), 10),
        ];
        let got = entry_for_process_tree(&entries, 100, |p| sids.get(&p).copied()).unwrap();
        assert_eq!(got.session_id, "on-screen");
    }

    #[test]
    fn nothing_in_the_pty_s_process_session_means_no_answer() {
        let entries = vec![entry(300, "elsewhere", Some("interactive"), 1)];
        assert!(entry_for_process_tree(&entries, 100, |_| None).is_none());
    }

    #[test]
    fn a_registry_id_that_is_not_a_plain_name_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut e = entry(1, "../escape", None, 0);
        e.cwd = Some("/r".into());
        assert!(transcript_for(dir.path(), &e).is_none());
    }

    /// The report: a tab whose CLI ran `/resume` kept showing the old
    /// conversation in Chat. The registry says where the process went; the
    /// lookup must follow it, into whichever project dir holds the transcript.
    #[test]
    fn follows_the_process_after_resume_and_clear() {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("sessions");
        let projects = root.path().join("projects");
        let cwd = "/Users/me/snubes-platform";
        let dir = projects.join(encode_path(cwd));
        write(&dir.join("old-thread.jsonl"), "{}\n");
        write(&dir.join("resumed-thread.jsonl"), "{}\n");
        // A registry file for an unrelated CLI, plus a key file that must be
        // skipped rather than parsed.
        write(
            &registry.join("900.json"),
            r#"{"pid":900,"sessionId":"old-thread","cwd":"/elsewhere","kind":"interactive"}"#,
        );
        write(&registry.join("4242.secret.key"), "not json");

        let leader = 4242;
        let pid_file = registry.join("4242.json");
        let own = |p: u32| (p == leader).then_some(leader);

        // Before the switch: the tab's CLI is on the old thread.
        write(
            &pid_file,
            &format!(r#"{{"pid":4242,"sessionId":"old-thread","cwd":"{cwd}","kind":"interactive"}}"#),
        );
        let before = live_session_in(&registry, &projects, leader, own).unwrap();
        assert_eq!(before.session_id, "old-thread");

        // `/resume` rewrites the same pid's entry.
        write(
            &pid_file,
            &format!(r#"{{"pid":4242,"sessionId":"resumed-thread","cwd":"{cwd}","kind":"interactive"}}"#),
        );
        let after = live_session_in(&registry, &projects, leader, own).unwrap();
        assert_eq!(after.session_id, "resumed-thread");
        assert_eq!(
            after.file_path.as_deref(),
            Some(dir.join("resumed-thread.jsonl").to_string_lossy().as_ref())
        );

        // A conversation first written from another directory is still found.
        let other = projects.join(encode_path("/Users/me/other-worktree"));
        write(&other.join("from-a-sibling.jsonl"), "{}\n");
        write(
            &pid_file,
            &format!(r#"{{"pid":4242,"sessionId":"from-a-sibling","cwd":"{cwd}","kind":"interactive"}}"#),
        );
        let sibling = live_session_in(&registry, &projects, leader, own).unwrap();
        assert_eq!(
            sibling.file_path.as_deref(),
            Some(other.join("from-a-sibling.jsonl").to_string_lossy().as_ref())
        );

        // `/clear`: a new id with nothing on disk yet.
        write(
            &pid_file,
            &format!(r#"{{"pid":4242,"sessionId":"fresh-after-clear","cwd":"{cwd}","kind":"interactive"}}"#),
        );
        let cleared = live_session_in(&registry, &projects, leader, own).unwrap();
        assert_eq!(cleared.session_id, "fresh-after-clear");
        assert_eq!(cleared.file_path, None);
    }

    #[test]
    fn no_registry_directory_reads_as_no_answer() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("nope");
        assert!(live_session_in(&missing, root.path(), 1, |_| None).is_none());
    }
}
