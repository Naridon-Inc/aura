// Aura Tasks — collaborative task tickets with assign/claim/comment/close.
//
// File-backed JSON store under `<repo>/.aura/tasks/`. Each task is a single
// `<id>.json` file so concurrent writers from different agents/users only
// contend on a single slim file. The task list view does a directory read +
// `serde_json` parse per file.
//
// This is intentionally simpler than the plan-XML waves: those are dispatched
// by the Manager loop and live in `.aura/plans/`. Tasks are human/agent
// tickets that anyone on a team can claim, comment on, and close.
//
// Mothership-synced via `task:*` topic (see host.rs) so team members see new
// tasks + comments in real time.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Open,
    InProgress,
    Blocked,
    Done,
    Cancelled,
}

impl TaskStatus {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "open" => Some(Self::Open),
            "in_progress" | "in-progress" | "wip" => Some(Self::InProgress),
            "blocked" => Some(Self::Blocked),
            "done" | "closed" | "complete" | "completed" => Some(Self::Done),
            "cancelled" | "canceled" => Some(Self::Cancelled),
            _ => None,
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::InProgress => "in_progress",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub author: String,
    pub at: i64, // unix seconds
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String, // short slug like "T-7af2"
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub status: Option<TaskStatusWrapper>,
    #[serde(default)]
    pub priority: String, // "low" | "medium" | "high" | "critical"
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub claimed_by: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub comments: Vec<Comment>,
    #[serde(default)]
    pub linked_pr: Option<String>,
    #[serde(default)]
    pub linked_branch: Option<String>,
}

// Wrap TaskStatus so missing field deserializes cleanly to Open.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskStatusWrapper(pub TaskStatus);

impl Default for TaskStatusWrapper {
    fn default() -> Self {
        Self(TaskStatus::Open)
    }
}

impl Task {
    pub fn status(&self) -> TaskStatus {
        self.status.map(|w| w.0).unwrap_or(TaskStatus::Open)
    }
    pub fn set_status(&mut self, s: TaskStatus) {
        self.status = Some(TaskStatusWrapper(s));
    }
}

pub struct TaskStore {
    dir: PathBuf,
}

impl TaskStore {
    pub fn at(repo_root: &Path) -> Self {
        let dir = repo_root.join(".aura").join("tasks");
        Self { dir }
    }

    pub fn ensure_dir(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", id))
    }

    pub fn list(&self) -> Vec<Task> {
        if !self.dir.exists() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let entries = match fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(_) => return out,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(t) = serde_json::from_str::<Task>(&text) {
                    out.push(t);
                }
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    pub fn get(&self, id: &str) -> Option<Task> {
        let path = self.path_for(id);
        let text = fs::read_to_string(&path).ok()?;
        serde_json::from_str::<Task>(&text).ok()
    }

    pub fn save(&self, task: &Task) -> std::io::Result<()> {
        self.ensure_dir()?;
        let path = self.path_for(&task.id);
        let body = serde_json::to_string_pretty(task)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(path, body)
    }

    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        let path = self.path_for(id);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    pub fn create(
        &self,
        title: String,
        body: String,
        priority: String,
        author: String,
        labels: Vec<String>,
    ) -> std::io::Result<Task> {
        self.ensure_dir()?;
        let id = format!("T-{}", &Uuid::new_v4().to_string()[..8]);
        let now = chrono::Utc::now().timestamp();
        let task = Task {
            id: id.clone(),
            title,
            body,
            status: Some(TaskStatusWrapper(TaskStatus::Open)),
            priority,
            author,
            assignee: None,
            claimed_by: None,
            labels,
            created_at: now,
            updated_at: now,
            comments: Vec::new(),
            linked_pr: None,
            linked_branch: None,
        };
        self.save(&task)?;
        Ok(task)
    }

    pub fn touch(task: &mut Task) {
        task.updated_at = chrono::Utc::now().timestamp();
    }

    pub fn comment(&self, id: &str, author: String, body: String) -> std::io::Result<Task> {
        let mut task = self
            .get(id)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("task {} not found", id)))?;
        task.comments.push(Comment {
            author,
            at: chrono::Utc::now().timestamp(),
            body,
        });
        Self::touch(&mut task);
        self.save(&task)?;
        Ok(task)
    }

    pub fn claim(&self, id: &str, who: String) -> std::io::Result<Task> {
        let mut task = self
            .get(id)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("task {} not found", id)))?;
        if let Some(existing) = &task.claimed_by {
            if existing != &who {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("task {} already claimed by {}", id, existing),
                ));
            }
        }
        task.claimed_by = Some(who);
        if matches!(task.status(), TaskStatus::Open) {
            task.set_status(TaskStatus::InProgress);
        }
        Self::touch(&mut task);
        self.save(&task)?;
        Ok(task)
    }

    pub fn unclaim(&self, id: &str) -> std::io::Result<Task> {
        let mut task = self
            .get(id)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("task {} not found", id)))?;
        task.claimed_by = None;
        if matches!(task.status(), TaskStatus::InProgress) {
            task.set_status(TaskStatus::Open);
        }
        Self::touch(&mut task);
        self.save(&task)?;
        Ok(task)
    }

    pub fn assign(&self, id: &str, who: Option<String>) -> std::io::Result<Task> {
        let mut task = self
            .get(id)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("task {} not found", id)))?;
        task.assignee = who;
        Self::touch(&mut task);
        self.save(&task)?;
        Ok(task)
    }

    pub fn set_status(&self, id: &str, status: TaskStatus) -> std::io::Result<Task> {
        let mut task = self
            .get(id)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("task {} not found", id)))?;
        task.set_status(status);
        Self::touch(&mut task);
        self.save(&task)?;
        Ok(task)
    }

    pub fn link(&self, id: &str, pr: Option<String>, branch: Option<String>) -> std::io::Result<Task> {
        let mut task = self
            .get(id)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("task {} not found", id)))?;
        if pr.is_some() {
            task.linked_pr = pr;
        }
        if branch.is_some() {
            task.linked_branch = branch;
        }
        Self::touch(&mut task);
        self.save(&task)?;
        Ok(task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_repo() -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-task-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn create_list_get_roundtrip() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let task = store
            .create(
                "Wire OAuth".to_string(),
                "Use existing token store.".to_string(),
                "high".to_string(),
                "alice".to_string(),
                vec!["backend".to_string()],
            )
            .unwrap();
        assert!(task.id.starts_with("T-"));
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Wire OAuth");
        let got = store.get(&task.id).unwrap();
        assert_eq!(got.priority, "high");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn claim_then_comment_then_done() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let task = store
            .create(
                "Fix retry backoff".to_string(),
                String::new(),
                "medium".to_string(),
                "alice".to_string(),
                vec![],
            )
            .unwrap();
        let claimed = store.claim(&task.id, "bob".to_string()).unwrap();
        assert_eq!(claimed.claimed_by.as_deref(), Some("bob"));
        assert!(matches!(claimed.status(), TaskStatus::InProgress));
        let after_comment = store
            .comment(&task.id, "bob".to_string(), "looking now".to_string())
            .unwrap();
        assert_eq!(after_comment.comments.len(), 1);
        let done = store.set_status(&task.id, TaskStatus::Done).unwrap();
        assert!(matches!(done.status(), TaskStatus::Done));
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn double_claim_rejected() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let task = store
            .create("X".to_string(), String::new(), "low".to_string(), "a".to_string(), vec![])
            .unwrap();
        let _ = store.claim(&task.id, "bob".to_string()).unwrap();
        let err = store.claim(&task.id, "carol".to_string());
        assert!(err.is_err());
        let _ = fs::remove_dir_all(&repo);
    }
}
