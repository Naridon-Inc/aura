//! Codex history: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<iso>-<id>.jsonl`.
//!
//! Every row is `{type, timestamp, payload}`. The three that matter:
//!
//! * `session_meta` — one per file, carries `id`, `cwd` and `cli_version`.
//! * `event_msg` with `payload.type == "user_message"` — what the person typed.
//! * `event_msg` with `payload.type == "agent_message"` — one agent step.
//!
//! The date-sharded directory tree is why this walks recursively rather than
//! reading one directory: a year of sessions is 365 leaf directories.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    head_rows, home, message_text, mtime_secs, parse_ts, stale_for, History, Prompt, Scope,
    Session,
};

pub struct Codex;

/// Depth-limited walk of the `YYYY/MM/DD` tree.
///
/// Bounded rather than unbounded because this is somebody's home directory: a
/// symlink loop under `~/.codex` should not hang the CLI.
fn rollouts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            rollouts(&p, depth + 1, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl")
            && p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rollout-"))
        {
            out.push(p);
        }
    }
}

fn payload_kind(o: &serde_json::Value) -> Option<&str> {
    o.get("payload")?.get("type")?.as_str()
}

/// The text of a `user_message` payload.
///
/// Codex puts the prompt under `message`; images and audio ride alongside in
/// their own keys and are not part of what was asked in words.
fn user_text(o: &serde_json::Value) -> String {
    let Some(p) = o.get("payload") else {
        return String::new();
    };
    message_text(p.get("message").unwrap_or(&serde_json::Value::Null))
}

/// Read one rollout into a session, or `None` when it holds no work.
fn scan(path: PathBuf) -> Option<Session> {
    let file = std::fs::File::open(&path).ok()?;
    let mut id = None;
    let mut cwd = None;
    let mut first_ts = 0u64;
    let mut last_ts = 0u64;
    let mut prompts = 0usize;
    let mut steps = 0usize;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(o) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(ts) = o.get("timestamp") {
            let t = parse_ts(ts);
            if t > 0 {
                if first_ts == 0 {
                    first_ts = t;
                }
                last_ts = t;
            }
        }
        match o.get("type").and_then(|t| t.as_str()) {
            Some("session_meta") => {
                let p = o.get("payload");
                id = p
                    .and_then(|p| p.get("id").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                cwd = p
                    .and_then(|p| p.get("cwd"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            Some("event_msg") => match payload_kind(&o) {
                Some("user_message") if !user_text(&o).is_empty() => prompts += 1,
                Some("agent_message") => steps += 1,
                _ => {}
            },
            _ => {}
        }
    }

    // Fall back to the filename's uuid tail when a rollout has no
    // session_meta — a file truncated at the head is still a session.
    let id = id.or_else(|| {
        let stem = path.file_stem()?.to_str()?;
        stem.rsplit_once('-').map(|(_, tail)| tail.to_string())
    })?;
    if steps == 0 && prompts == 0 {
        return None;
    }
    Some(Session {
        dialect: "codex",
        id,
        cwd,
        cwd_digest: None,
        branch: None,
        title: None,
        started_at: first_ts,
        last_activity_at: last_ts,
        prompts: Some(prompts),
        steps: Some(steps),
        path,
    })
}

/// Where and when, without reading the body.
///
/// A rollout's name carries the moment it was opened and the id; `session_meta`
/// is the first row, so the working directory is one short read away. Last
/// activity is the file's mtime, which is when the rollout was last appended to.
fn locate(path: PathBuf) -> Option<Session> {
    let stem = path.file_stem()?.to_str()?.to_string();
    let head = head_rows(&path, 5);
    let meta = head
        .iter()
        .find(|o| o.get("type").and_then(|t| t.as_str()) == Some("session_meta"))
        .and_then(|o| o.get("payload"));
    let id = meta
        .and_then(|p| p.get("id").or_else(|| p.get("session_id")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| stem.rsplit_once('-').map(|(_, tail)| tail.to_string()))?;
    let cwd = meta
        .and_then(|p| p.get("cwd"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let started_at = head
        .iter()
        .filter_map(|o| o.get("timestamp").map(parse_ts))
        .find(|t| *t > 0)
        .unwrap_or(0);
    Some(Session {
        dialect: "codex",
        id,
        cwd,
        cwd_digest: None,
        branch: None,
        title: None,
        started_at,
        last_activity_at: mtime_secs(&path),
        prompts: None,
        steps: None,
        path,
    })
}

impl History for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn display(&self) -> &'static str {
        "Codex"
    }

    fn root(&self) -> Option<PathBuf> {
        let p = home()?.join(".codex").join("sessions");
        p.is_dir().then_some(p)
    }

    fn index(&self, scope: &Scope) -> Vec<Session> {
        let Some(root) = self.root() else {
            return Vec::new();
        };
        let mut files = Vec::new();
        rollouts(&root, 0, &mut files);

        let mut out = Vec::new();
        for path in files {
            // Codex records its working directory inside the file, not in the
            // path, so a repo-scoped read still has to open candidates — but a
            // rollout untouched since before the moment asked about cannot be
            // one, and skipping those is free.
            if stale_for(&path, scope) {
                continue;
            }
            if let Some(session) = locate(path) {
                if scope.keeps(&session) {
                    out.push(session);
                }
            }
        }
        out.sort_by_key(|s| s.last_activity_at);
        out
    }

    fn count(&self, session: Session) -> Session {
        scan(session.path.clone()).unwrap_or(session)
    }

    /// A rollout filename ends in the session id, so one file is opened rather
    /// than a year of them.
    fn session_by_id(&self, id: &str) -> Option<Session> {
        let root = self.root()?;
        let mut files = Vec::new();
        rollouts(&root, 0, &mut files);
        let hit = files
            .into_iter()
            .find(|p| p.file_stem().and_then(|s| s.to_str()).is_some_and(|s| s.ends_with(id)))?;
        locate(hit)
    }

    fn prompts(&self, session: &Session) -> Vec<Prompt> {
        let Ok(file) = std::fs::File::open(&session.path) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("user_message") {
                continue;
            }
            let Ok(o) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if payload_kind(&o) != Some("user_message") {
                continue;
            }
            let text = user_text(&o);
            if text.is_empty() {
                continue;
            }
            out.push(Prompt {
                at: o.get("timestamp").map(parse_ts).unwrap_or(0),
                text,
            });
        }
        out
    }

    /// Walks the transcript backwards and stops at the answer.
    ///
    /// The rows are append-only and in order, so the last prompt at or before
    /// `at` is found by reading the tail — and the prompts that came after it
    /// are exactly the ones stepped over on the way. A long session costs the
    /// same as a short one, because what is read is the distance back to the
    /// answer, not the length of the file.
    fn prompt_before(&self, session: &Session, at: u64) -> Option<(Prompt, usize)> {
        let mut after = 0usize;
        let mut newest: Option<Prompt> = None;
        let mut found: Option<Prompt> = None;
        super::rev_lines(&session.path, |line| {
            if !line.contains("user_message") {
                return true;
            }
            let Ok(o) = serde_json::from_str::<serde_json::Value>(line) else {
                return true;
            };
            if payload_kind(&o) != Some("user_message") {
                return true;
            }
            let text = user_text(&o);
            if text.is_empty() {
                return true;
            }
            let p = Prompt { at: o.get("timestamp").map(parse_ts).unwrap_or(0), text };
            if newest.is_none() {
                newest = Some(p.clone());
            }
            // A row with no clock cannot be placed either side of the anchor,
            // so it is neither the answer nor counted as following it.
            if p.at == 0 {
                return true;
            }
            if at == 0 || p.at <= at {
                found = Some(p);
                return false;
            }
            after += 1;
            true
        });
        found.map(|p| (p, after)).or_else(|| newest.map(|p| (p, 0)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_user_message_payload_yields_its_text() {
        let row = serde_json::json!({
            "type": "event_msg",
            "timestamp": "2026-08-24T16:48:07Z",
            "payload": {"type": "user_message", "message": "fix the parser", "images": []}
        });
        assert_eq!(payload_kind(&row), Some("user_message"));
        assert_eq!(user_text(&row), "fix the parser");
    }

    #[test]
    fn an_agent_message_is_a_step_not_a_prompt() {
        let row = serde_json::json!({
            "type": "event_msg",
            "payload": {"type": "agent_message", "message": "done"}
        });
        assert_eq!(payload_kind(&row), Some("agent_message"));
    }

    #[test]
    fn a_rollout_with_no_payload_does_not_panic() {
        let row = serde_json::json!({"type": "event_msg"});
        assert_eq!(payload_kind(&row), None);
        assert_eq!(user_text(&row), "");
    }

    #[test]
    fn the_walk_is_depth_limited() {
        // A symlink loop under someone's home must not hang the CLI, so the
        // recursion stops rather than trusting the tree to be a tree.
        let dir = tempfile::tempdir().unwrap();
        let mut deep = dir.path().to_path_buf();
        for i in 0..8 {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("rollout-x-abc.jsonl"), "{}\n").unwrap();
        let mut found = Vec::new();
        rollouts(dir.path(), 0, &mut found);
        assert!(found.is_empty(), "a file past the depth limit is not walked into");
    }
}
