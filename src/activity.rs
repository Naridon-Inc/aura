// Activity feed — append-only event log of who did what.
//
// File: `<repo>/.aura/activity.jsonl`. Each line is one ActivityEvent.
// Events are emitted from anywhere via `ActivityStore::emit(...)`. Readers
// can `tail(n)` for recent activity, or `read_all()` for the full feed.
//
// This is the team-collab counterpart to intent_log.jsonl: intents are
// pre-commit explanations of code changes, while activity covers the
// broader "task claimed", "comment posted", "snapshot taken", etc — the
// stream you'd put in a Discord channel for the team to skim.

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEvent {
    pub at: i64, // unix seconds
    pub actor: String,
    pub verb: String,   // "created" | "claimed" | "commented" | "closed" | ...
    pub target: String, // task id, file path, etc
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>, // optional href the UI can click
}

pub struct ActivityStore {
    path: PathBuf,
}

impl ActivityStore {
    pub fn at(repo_root: &Path) -> Self {
        let path = repo_root.join(".aura").join("activity.jsonl");
        Self { path }
    }

    fn ensure_parent(&self) -> std::io::Result<()> {
        if let Some(p) = self.path.parent() {
            std::fs::create_dir_all(p)?;
        }
        Ok(())
    }

    pub fn emit(&self, event: ActivityEvent) -> std::io::Result<()> {
        self.ensure_parent()?;
        let line = serde_json::to_string(&event)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let mut f = OpenOptions::new().create(true).append(true).open(&self.path)?;
        writeln!(f, "{}", line)?;
        Ok(())
    }

    pub fn quick(&self, actor: &str, verb: &str, target: &str, summary: Option<&str>) {
        let event = ActivityEvent {
            at: chrono::Utc::now().timestamp(),
            actor: actor.to_string(),
            verb: verb.to_string(),
            target: target.to_string(),
            summary: summary.map(|s| s.to_string()),
            link: None,
        };
        let _ = self.emit(event);
    }

    pub fn tail(&self, limit: usize) -> Vec<ActivityEvent> {
        let mut all = self.read_all();
        // newest last in file; reverse for "newest first"
        all.reverse();
        all.truncate(limit);
        all
    }

    pub fn read_all(&self) -> Vec<ActivityEvent> {
        let f = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        let mut events = Vec::new();
        for line in BufReader::new(f).lines().flatten() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(e) = serde_json::from_str::<ActivityEvent>(&line) {
                events.push(e);
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use uuid::Uuid;

    #[test]
    fn emit_and_tail_returns_newest_first() {
        let mut p = env::temp_dir();
        p.push(format!("aura-activity-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        let store = ActivityStore::at(&p);
        store.quick("alice", "created", "T-1", Some("Wire OAuth"));
        store.quick("bob", "claimed", "T-1", None);
        store.quick("bob", "commented", "T-1", Some("looking now"));
        let recent = store.tail(2);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].verb, "commented");
        assert_eq!(recent[1].verb, "claimed");
        let _ = std::fs::remove_dir_all(&p);
    }
}
