//! The **crew registry** — durable identity for the work-loop's crews.
//!
//! The dependency graph (`.aura/a2a/`) already namespaces every node by
//! `crew_id` (see [`crate::crew_of`]), so the *live* membership of a crew is
//! always derivable from the nodes. What the graph can't hold is a crew that
//! exists before any work is assigned to it, or a crew's human-facing name and
//! creation time. This registry fills that gap: `.aura/crew/crews.json` lists
//! each spawned crew so you can stand up a second crew, name it, and run it in
//! parallel with the first — even while it's still empty.
//!
//! The default crew **"main"** is implicit: it is never written to the file and
//! always present, so a repo that never spawned a crew still has one.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// The id of the always-present default crew.
pub const MAIN_CREW: &str = "main";

/// One crew's durable identity. Lifecycle counts are NOT stored here — they are
/// always tallied live from the graph (see [`crate::crews_summary`]) so the
/// registry never drifts from reality.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CrewMeta {
    /// Stable slug used as the node `crew_id` (e.g. "main", "perf-crew").
    pub id: String,
    /// Human-facing name shown on the surface.
    pub title: String,
    /// Optional one-line purpose.
    #[serde(default)]
    pub description: Option<String>,
    pub created_at: i64,
}

impl CrewMeta {
    /// The implicit default crew, synthesised (never read from disk).
    pub fn main() -> Self {
        Self {
            id: MAIN_CREW.to_string(),
            title: "Main crew".to_string(),
            description: None,
            created_at: 0,
        }
    }
}

/// File-backed crew registry under `<repo>/.aura/crew/crews.json`.
pub struct CrewRegistry {
    path: PathBuf,
}

impl CrewRegistry {
    pub fn at(repo_root: &Path) -> Self {
        Self {
            path: repo_root.join(".aura").join("crew").join("crews.json"),
        }
    }

    fn ensure_dir(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    /// The spawned crews on disk (excludes the implicit "main"). A missing or
    /// malformed file reads as empty, never fatal.
    fn stored(&self) -> Vec<CrewMeta> {
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        serde_json::from_str::<Vec<CrewMeta>>(&text).unwrap_or_default()
    }

    /// Every crew, "main" first, then spawned crews in creation order.
    pub fn list(&self) -> Vec<CrewMeta> {
        let mut out = vec![CrewMeta::main()];
        let mut stored = self.stored();
        stored.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out.extend(stored.into_iter().filter(|c| c.id != MAIN_CREW));
        out
    }

    /// Look up a crew by id ("main" always resolves).
    pub fn get(&self, id: &str) -> Option<CrewMeta> {
        self.list().into_iter().find(|c| c.id == id)
    }

    /// Mint a new crew. Idempotent on id: a second spawn with the same id
    /// returns the existing meta unchanged (so re-running a script is safe).
    /// "main" can't be spawned — it always exists.
    pub fn spawn(
        &self,
        title: impl Into<String>,
        description: Option<String>,
        now: i64,
    ) -> std::io::Result<CrewMeta> {
        let title = title.into();
        let id = slugify(&title);
        if id == MAIN_CREW {
            return Ok(CrewMeta::main());
        }
        let mut stored = self.stored();
        if let Some(existing) = stored.iter().find(|c| c.id == id) {
            return Ok(existing.clone());
        }
        let meta = CrewMeta {
            id,
            title,
            description,
            created_at: now,
        };
        stored.push(meta.clone());
        self.save(&stored)?;
        Ok(meta)
    }

    /// Remove a spawned crew from the registry (its nodes are untouched — they
    /// simply fall back to showing their raw `crew_id`). "main" can't be
    /// removed.
    pub fn remove(&self, id: &str) -> std::io::Result<bool> {
        if id == MAIN_CREW {
            return Ok(false);
        }
        let mut stored = self.stored();
        let before = stored.len();
        stored.retain(|c| c.id != id);
        if stored.len() == before {
            return Ok(false);
        }
        self.save(&stored)?;
        Ok(true)
    }

    fn save(&self, crews: &[CrewMeta]) -> std::io::Result<()> {
        self.ensure_dir()?;
        let body = serde_json::to_string_pretty(crews)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(&self.path, body)
    }
}

/// Turn a free-text crew title into a stable, filesystem- and tag-safe slug.
/// Lowercase, spaces/punctuation → single hyphens, trimmed. Empty input (or
/// input that slugs to nothing) falls back to "crew".
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for ch in s.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "crew".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use uuid::Uuid;

    fn tmp() -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-crewreg-{}", Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn slugify_is_tag_safe() {
        assert_eq!(slugify("Perf Crew"), "perf-crew");
        assert_eq!(slugify("  Spaces  & punct!! "), "spaces-punct");
        assert_eq!(slugify("main"), "main");
        assert_eq!(slugify("***"), "crew");
        assert_eq!(slugify(""), "crew");
    }

    #[test]
    fn main_is_always_present_and_first() {
        let repo = tmp();
        let reg = CrewRegistry::at(&repo);
        let all = reg.list();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, MAIN_CREW);
        assert!(reg.get("main").is_some());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn spawn_is_idempotent_on_id() {
        let repo = tmp();
        let reg = CrewRegistry::at(&repo);
        let a = reg.spawn("Perf Crew", Some("speed work".into()), 100).unwrap();
        let b = reg.spawn("Perf Crew", None, 200).unwrap();
        assert_eq!(a.id, "perf-crew");
        assert_eq!(a, b, "second spawn returns the first unchanged");
        let all = reg.list();
        assert_eq!(all.len(), 2, "main + perf-crew, no duplicate");
        assert_eq!(all[0].id, "main");
        assert_eq!(all[1].id, "perf-crew");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn spawning_main_is_a_noop() {
        let repo = tmp();
        let reg = CrewRegistry::at(&repo);
        let m = reg.spawn("main", None, 100).unwrap();
        assert_eq!(m.id, MAIN_CREW);
        assert_eq!(reg.list().len(), 1, "main never written to disk");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_drops_spawned_not_main() {
        let repo = tmp();
        let reg = CrewRegistry::at(&repo);
        reg.spawn("Alpha", None, 100).unwrap();
        assert!(reg.remove("alpha").unwrap());
        assert!(!reg.remove("alpha").unwrap(), "already gone");
        assert!(!reg.remove("main").unwrap(), "main is permanent");
        assert_eq!(reg.list().len(), 1);
        let _ = fs::remove_dir_all(&repo);
    }
}
