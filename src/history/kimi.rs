//! Kimi history: `~/.kimi/sessions/<md5(cwd)>/<session-id>/wire.jsonl`.
//!
//! Kimi is the one dialect that does not record its working directory
//! anywhere in the session — it encodes it in the directory name as an MD5
//! digest of the absolute path. That cannot be reversed, so [`Session::cwd`]
//! stays `None` and [`Session::cwd_digest`] carries the hash. The only
//! question callers ask — *did this run in this repo?* — is still answered
//! exactly, by hashing the candidate path.
//!
//! Verified against a live tree: `md5("/Users/…/Documents/New Git")` equals
//! both the `sessions/` directory name and the `user-history/<hash>.jsonl`
//! filename for that repo.
//!
//! Row shape is `{timestamp, message: {type, payload}}`:
//!
//! * `TurnBegin` — `payload.user_input` is the prompt, as a plain string.
//! * `ContentPart` — one chunk of agent output; a step.
//! * `ToolCall` / `ToolResult` / `StatusUpdate` / `TurnEnd` — not read here.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use super::{
    cwd_digest, head_rows, home, mtime_secs, parse_ts, stale_for, History, Prompt, Scope, Session,
};

pub struct Kimi;

/// `payload.user_input` for a `TurnBegin`, or empty for anything else.
fn turn_prompt(o: &serde_json::Value) -> String {
    let m = o.get("message").filter(|m| m.get("type").and_then(|t| t.as_str()) == Some("TurnBegin"));
    m.and_then(|m| m.get("payload"))
        .and_then(|p| p.get("user_input"))
        .and_then(|u| u.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn message_kind(o: &serde_json::Value) -> Option<&str> {
    o.get("message")?.get("type")?.as_str()
}

/// The human title a person gave a session, from its sibling `state.json`.
///
/// Kimi also auto-generates titles, but only `custom_title` is a name someone
/// chose; showing a generated one as if it were is a small lie that adds up.
fn custom_title(session_dir: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(session_dir.join("state.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("custom_title")
        .and_then(|t| t.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

impl History for Kimi {
    fn id(&self) -> &'static str {
        "kimi"
    }

    fn display(&self) -> &'static str {
        "Kimi"
    }

    fn root(&self) -> Option<PathBuf> {
        let p = home()?.join(".kimi").join("sessions");
        p.is_dir().then_some(p)
    }

    fn index(&self, scope: &Scope) -> Vec<Session> {
        let Some(root) = self.root() else {
            return Vec::new();
        };
        // The digest *is* the working directory, so a repo-scoped read opens
        // exactly one directory and ignores the rest of the disk.
        let want = scope
            .repo_root
            .as_ref()
            .map(|r| cwd_digest(r.to_string_lossy().trim_end_matches('/')));
        let mut out = Vec::new();
        let Ok(digests) = std::fs::read_dir(&root) else {
            return out;
        };
        for digest_dir in digests.flatten() {
            let Some(digest) = digest_dir.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };
            if want.as_deref().is_some_and(|w| w != digest) {
                continue;
            }
            let Ok(sessions) = std::fs::read_dir(digest_dir.path()) else {
                continue;
            };
            for entry in sessions.flatten() {
                let dir = entry.path();
                let wire = dir.join("wire.jsonl");
                if !wire.is_file() || stale_for(&wire, scope) {
                    continue;
                }
                let Some(id) = entry.file_name().to_str().map(|x| x.to_string()) else {
                    continue;
                };
                let started_at = head_rows(&wire, 5)
                    .iter()
                    .filter_map(|o| o.get("timestamp").map(parse_ts))
                    .find(|t| *t > 0)
                    .unwrap_or(0);
                let session = Session {
                    dialect: "kimi",
                    id,
                    cwd: None,
                    cwd_digest: Some(digest.clone()),
                    branch: None,
                    title: custom_title(&dir),
                    started_at,
                    last_activity_at: mtime_secs(&wire),
                    prompts: None,
                    steps: None,
                    path: wire,
                };
                if scope.keeps(&session) {
                    out.push(session);
                }
            }
        }
        out.sort_by_key(|s| s.last_activity_at);
        out
    }

    fn count(&self, session: Session) -> Session {
        let Ok(file) = std::fs::File::open(&session.path) else {
            return session;
        };
        let (mut first_ts, mut last_ts, mut prompts, mut steps) = (0u64, 0u64, 0usize, 0usize);
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
            match message_kind(&o) {
                Some("TurnBegin") if !turn_prompt(&o).is_empty() => prompts += 1,
                Some("ContentPart") => steps += 1,
                _ => {}
            }
        }
        Session {
            started_at: if first_ts > 0 { first_ts } else { session.started_at },
            last_activity_at: if last_ts > 0 { last_ts } else { session.last_activity_at },
            prompts: Some(prompts),
            steps: Some(steps),
            ..session
        }
    }

    fn prompts(&self, session: &Session) -> Vec<Prompt> {
        let Ok(file) = std::fs::File::open(&session.path) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("TurnBegin") {
                continue;
            }
            let Ok(o) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let text = turn_prompt(&o);
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
            if !line.contains("TurnBegin") {
                return true;
            }
            let Ok(o) = serde_json::from_str::<serde_json::Value>(line) else {
                return true;
            };
            let text = turn_prompt(&o);
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
    use crate::history::cwd_digest;

    #[test]
    fn a_turn_begin_carries_the_prompt_as_a_plain_string() {
        let row = serde_json::json!({
            "timestamp": 1787330887000u64,
            "message": {"type": "TurnBegin", "payload": {"user_input": "  add a test  "}}
        });
        assert_eq!(turn_prompt(&row), "add a test");
        assert_eq!(message_kind(&row), Some("TurnBegin"));
    }

    #[test]
    fn agent_output_is_not_a_prompt() {
        let row = serde_json::json!({
            "message": {"type": "ContentPart", "payload": {"text": "working on it", "type": "text"}}
        });
        assert_eq!(turn_prompt(&row), "");
        assert_eq!(message_kind(&row), Some("ContentPart"));
    }

    #[test]
    fn the_directory_name_is_the_md5_of_the_working_directory() {
        // This is the whole reason a Kimi session can be scoped to a repo at
        // all. Pinned against the value observed in a live tree.
        assert_eq!(
            cwd_digest("/Users/dev/Documents/New Git"),
            "b3c5c49d29680ad5a697a3c82f7ec342"
        );
    }

    #[test]
    fn a_digest_session_is_claimed_by_the_repo_that_hashes_to_it() {
        let s = Session {
            dialect: "kimi",
            id: "s".into(),
            cwd: None,
            cwd_digest: Some(cwd_digest("/repo")),
            branch: None,
            title: None,
            started_at: 0,
            last_activity_at: 0,
            prompts: Some(1),
            steps: Some(1),
            path: PathBuf::new(),
        };
        assert!(s.ran_in(std::path::Path::new("/repo")));
        assert!(!s.ran_in(std::path::Path::new("/other")));
        // A trailing slash is the same directory, not a different one.
        assert!(s.ran_in(std::path::Path::new("/repo/")));
    }
}
