//! OpenCode history: `~/.local/share/opencode/storage/`.
//!
//! Unlike the JSONL dialects, OpenCode keeps a small object store — one JSON
//! file per record, in parallel trees:
//!
//! ```text
//! storage/project/<project-id>.json      { id, worktree, vcs, time }
//! storage/session/<project-id>/<ses>.json{ id, projectID, directory, title, time }
//! storage/message/<ses>/<msg>.json       { id, sessionID, role, time }
//! storage/part/<msg>/<part>.json         { type, text, ... }
//! ```
//!
//! The session record carries `directory` outright, so scoping to a repo is
//! exact and needs no digest.
//!
//! **What is verified and what is tolerated.** The `project` and `session`
//! shapes above were read off a live tree. The `message`/`part` split is read
//! defensively: a message may carry its text inline or only through parts, and
//! either is accepted. When neither is present the session still imports with
//! its real title and times and simply reports no prompts — an honest zero
//! rather than an invented one.

use std::path::{Path, PathBuf};

use super::{home, message_text, parse_ts, stale_for, History, Prompt, Scope, Session};

pub struct OpenCode;

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `time.created` / `time.updated`, which OpenCode writes in milliseconds.
fn time_field(v: &serde_json::Value, key: &str) -> u64 {
    v.get("time").and_then(|t| t.get(key)).map(parse_ts).unwrap_or(0)
}

/// Every `*.json` directly inside `dir`, sorted by name so ids that embed a
/// sortable prefix come back in creation order.
fn json_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    out.sort();
    out
}

/// The text of one message, from its inline body or from its parts.
fn message_body(storage: &Path, msg: &serde_json::Value, msg_id: &str) -> String {
    // Inline first — cheapest, and some versions write it this way.
    for key in ["content", "text", "message"] {
        if let Some(v) = msg.get(key) {
            let t = message_text(v);
            if !t.is_empty() {
                return t;
            }
        }
    }
    let mut chunks = Vec::new();
    for p in json_files(&storage.join("part").join(msg_id)) {
        let Some(part) = read_json(&p) else { continue };
        if part.get("type").and_then(|t| t.as_str()) != Some("text") {
            continue;
        }
        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
            let t = t.trim();
            if !t.is_empty() {
                chunks.push(t.to_string());
            }
        }
    }
    chunks.join("\n")
}

impl History for OpenCode {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn display(&self) -> &'static str {
        "OpenCode"
    }

    fn root(&self) -> Option<PathBuf> {
        let p = home()?.join(".local").join("share").join("opencode").join("storage");
        p.is_dir().then_some(p)
    }

    /// Cheap by construction: OpenCode's session record is a small JSON file
    /// carrying the directory, the title and both times. Nothing here opens a
    /// message or a part.
    fn index(&self, scope: &Scope) -> Vec<Session> {
        let Some(storage) = self.root() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let Ok(projects) = std::fs::read_dir(storage.join("session")) else {
            return out;
        };
        for project in projects.flatten() {
            for f in json_files(&project.path()) {
                if stale_for(&f, scope) {
                    continue;
                }
                let Some(v) = read_json(&f) else { continue };
                let Some(id) = v.get("id").and_then(|i| i.as_str()) else {
                    continue;
                };
                let created = time_field(&v, "created");
                let session = Session {
                    dialect: "opencode",
                    id: id.to_string(),
                    cwd: v.get("directory").and_then(|d| d.as_str()).map(|d| d.to_string()),
                    cwd_digest: None,
                    branch: None,
                    title: v
                        .get("title")
                        .and_then(|t| t.as_str())
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty()),
                    started_at: created,
                    last_activity_at: time_field(&v, "updated").max(created),
                    prompts: None,
                    steps: None,
                    path: f,
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
        let Some(storage) = self.root() else {
            return session;
        };
        // Count what the person typed separately from what the agent did, the
        // same split every other dialect reports.
        let (mut prompts, mut steps) = (0usize, 0usize);
        for m in json_files(&storage.join("message").join(&session.id)) {
            match read_json(&m).as_ref().and_then(|v| v.get("role")?.as_str()) {
                Some("user") => prompts += 1,
                Some(_) => steps += 1,
                None => {}
            }
        }
        Session { prompts: Some(prompts), steps: Some(steps), ..session }
    }

    fn prompts(&self, session: &Session) -> Vec<Prompt> {
        let Some(storage) = self.root() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for m in json_files(&storage.join("message").join(&session.id)) {
            let Some(v) = read_json(&m) else { continue };
            if v.get("role").and_then(|r| r.as_str()) != Some("user") {
                continue;
            }
            let Some(msg_id) = v.get("id").and_then(|i| i.as_str()) else {
                continue;
            };
            let text = message_body(&storage, &v, msg_id);
            if text.is_empty() {
                continue;
            }
            out.push(Prompt { at: time_field(&v, "created"), text });
        }
        out.sort_by_key(|p| p.at);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_writes_its_clock_in_milliseconds() {
        let v = serde_json::json!({"time": {"created": 1768227151109u64, "updated": 1768227151200u64}});
        assert_eq!(time_field(&v, "created"), 1768227151);
        assert_eq!(time_field(&v, "updated"), 1768227151);
        assert_eq!(time_field(&serde_json::json!({}), "created"), 0);
    }

    #[test]
    fn a_message_body_is_read_inline_or_from_parts() {
        let dir = tempfile::tempdir().unwrap();
        let storage = dir.path();

        // Inline shape.
        let inline = serde_json::json!({"id": "m1", "role": "user", "content": "inline ask"});
        assert_eq!(message_body(storage, &inline, "m1"), "inline ask");

        // Parts shape: two text parts join, a non-text part is ignored.
        let parts = storage.join("part").join("m2");
        std::fs::create_dir_all(&parts).unwrap();
        std::fs::write(parts.join("p1.json"), r#"{"type":"text","text":"first"}"#).unwrap();
        std::fs::write(parts.join("p2.json"), r#"{"type":"tool","name":"bash"}"#).unwrap();
        std::fs::write(parts.join("p3.json"), r#"{"type":"text","text":"second"}"#).unwrap();
        let bare = serde_json::json!({"id": "m2", "role": "user"});
        assert_eq!(message_body(storage, &bare, "m2"), "first\nsecond");

        // Neither shape present is an honest empty, not a panic.
        assert_eq!(message_body(storage, &serde_json::json!({"id": "m3"}), "m3"), "");
    }

    #[test]
    fn a_session_records_the_directory_it_ran_in() {
        let dir = tempfile::tempdir().unwrap();
        let storage = dir.path().join("storage");
        let proj = storage.join("session").join("p1");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("ses_abc.json"),
            r#"{"id":"ses_abc","projectID":"p1","directory":"/repo","title":"Fix auth","time":{"created":1768227151109,"updated":1768227160000}}"#,
        )
        .unwrap();

        // Read through the same helpers the trait impl uses, since the trait
        // resolves its own root from $HOME.
        let files = json_files(&proj);
        assert_eq!(files.len(), 1);
        let v = read_json(&files[0]).unwrap();
        assert_eq!(v["directory"], "/repo");
        assert_eq!(time_field(&v, "created"), 1768227151);
    }
}
