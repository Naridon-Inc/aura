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
//
// # One board, two shapes
//
// The same directory also holds `tasks.json` — one aggregate document the
// desktop app has always written, with a richer row (epic, cycle, estimate,
// dependencies). For a long time neither reader knew about the other: this
// store listed the cards and skipped the document, the app read the document
// and skipped the cards, and both treated a missing file as an empty board.
// That is why the app could show "No tasks yet" while `aura task list` was
// listing dozens.
//
// So a ticket here is whichever store holds it. Reads union both; a write
// goes back to the store the ticket came from, and an aggregate row is
// *patched* rather than rebuilt so the fields a card has never modelled
// survive an edit made from the CLI. The projection between the two shapes
// lives in `aura_loop::board_card`, shared with the app and the MCP board so
// the three surfaces cannot drift on what a status means.

use aura_loop::board_card;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    /// The board's human handle (`AURA-{n}`), allocated by the desktop app
    /// the first time it reads this card. It is carried here so a `aura task`
    /// write doesn't drop it — without that the board hands the same card a
    /// new number on every read and the handle a person just quoted stops
    /// resolving.
    #[serde(default)]
    pub sequence_id: u64,
    /// Every field this build doesn't model, kept verbatim. The app and the
    /// crew write these same files; a write from here must not silently
    /// delete what a newer writer put on the card.
    #[serde(flatten)]
    pub rest: std::collections::BTreeMap<String, serde_json::Value>,
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
    root: PathBuf,
    dir: PathBuf,
}

impl TaskStore {
    pub fn at(repo_root: &Path) -> Self {
        let dir = repo_root.join(".aura").join("tasks");
        Self { root: repo_root.to_path_buf(), dir }
    }

    /// Is this id a per-file card, or a row in the aggregate document?
    fn is_card(id: &str) -> bool {
        board_card::is_card_id(id)
    }

    /// Read one aggregate row as a ticket.
    fn aggregate_get(&self, id: &str) -> Option<Task> {
        let row = board_card::read_rows(&self.root)
            .into_iter()
            .find(|r| r.get("id").and_then(Value::as_str) == Some(id))?;
        Self::row_to_task(&row)
    }

    fn row_to_task(row: &Value) -> Option<Task> {
        let card = board_card::row_into_card(row, None);
        serde_json::from_value(serde_json::to_value(&card).ok()?).ok()
    }

    fn task_to_card(task: &Task) -> Option<board_card::Card> {
        serde_json::from_value(serde_json::to_value(task).ok()?).ok()
    }

    /// Patch one aggregate row in place, keeping every field a card has
    /// never modelled. A row that has gone missing is not resurrected as a
    /// card — that would move the ticket between stores behind the caller.
    fn aggregate_save(&self, task: &Task) -> std::io::Result<()> {
        let card = Self::task_to_card(task).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "task does not encode as a card")
        })?;
        let mut rows = board_card::read_rows(&self.root);
        let Some(slot) = rows
            .iter_mut()
            .find(|r| r.get("id").and_then(Value::as_str) == Some(task.id.as_str()))
        else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("task {} not found", task.id),
            ));
        };
        board_card::merge_card_into_row(&card, slot);
        board_card::write_rows(&self.root, &rows).map_err(std::io::Error::other)
    }

    pub fn ensure_dir(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", id))
    }

    /// Every ticket on the board — the cards in this directory and the rows
    /// in the aggregate document beside them, a card winning on a shared id.
    pub fn list(&self) -> Vec<Task> {
        let mut out = self.cards();
        let seen: std::collections::HashSet<String> = out.iter().map(|t| t.id.clone()).collect();
        for row in board_card::read_rows(&self.root) {
            let Some(t) = Self::row_to_task(&row) else { continue };
            if t.id.is_empty() || seen.contains(&t.id) {
                continue;
            }
            out.push(t);
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    /// Only the per-file cards, unsorted callers rely on `list` to order.
    fn cards(&self) -> Vec<Task> {
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
        if !Self::is_card(id) {
            return self.aggregate_get(id);
        }
        let path = self.path_for(id);
        let text = fs::read_to_string(&path).ok()?;
        serde_json::from_str::<Task>(&text).ok()
    }

    /// Persist a task atomically (tmp + rename in the store directory).
    /// A plain `fs::write` here could tear mid-write, and `list()` silently
    /// skips anything that fails to parse — a torn ticket didn't look broken,
    /// it looked *gone*.
    pub fn save(&self, task: &Task) -> std::io::Result<()> {
        if !Self::is_card(&task.id) {
            return self.aggregate_save(task);
        }
        self.ensure_dir()?;
        let path = self.path_for(&task.id);
        let body = serde_json::to_string_pretty(task)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        // Same-id saves are serialized by `with_lock`, so pid-suffixed tmp
        // names can't collide; the tmp lacks the `.json` extension, so a
        // crash mid-save leaves a file `list()` never mistakes for a ticket.
        let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
        fs::write(&tmp, body)?;
        match fs::rename(&tmp, &path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        if !Self::is_card(id) {
            let rows: Vec<Value> = board_card::read_rows(&self.root)
                .into_iter()
                .filter(|r| r.get("id").and_then(Value::as_str) != Some(id))
                .collect();
            return board_card::write_rows(&self.root, &rows).map_err(std::io::Error::other);
        }
        self.with_lock(id, || {
            let path = self.path_for(id);
            if path.exists() {
                fs::remove_file(path)?;
            }
            Ok(())
        })
    }

    fn lock_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.lock", id))
    }

    /// How long a lock may sit before it's presumed abandoned (a holder
    /// crashed between create and remove) and stolen. A live mutation holds
    /// the lock for milliseconds; seconds means a corpse.
    const STALE_LOCK: std::time::Duration = std::time::Duration::from_secs(2);
    /// How long a writer waits for the lock before giving up. Must exceed
    /// [`Self::STALE_LOCK`], or a crashed holder's lock could never be stolen.
    const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(6);

    /// Run one ticket mutation exclusively. Every read-modify-write in this
    /// store (claim, comment, assign, …) reloads the file, edits it and saves
    /// it back; without exclusion two concurrent writers each start from the
    /// same snapshot and the second save silently erases the first — two
    /// agents could both "win" a claim, and simultaneous comments vanished.
    /// The lock is a `create_new` sidecar: creation is the atomic test-and-set.
    fn with_lock<T>(&self, id: &str, f: impl FnOnce() -> std::io::Result<T>) -> std::io::Result<T> {
        self.ensure_dir()?;
        let lock = self.lock_path(id);
        let deadline = std::time::Instant::now() + Self::LOCK_WAIT;
        loop {
            match fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
                Ok(_) => break,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&lock)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|m| m.elapsed().ok())
                        .map(|age| age > Self::STALE_LOCK)
                        // Metadata unreadable usually means the holder just
                        // removed it — retry, don't steal.
                        .unwrap_or(false);
                    if stale {
                        let _ = fs::remove_file(&lock);
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            format!("task {} is locked by another writer", id),
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(e) => return Err(e),
            }
        }
        let result = f();
        let _ = fs::remove_file(&lock);
        result
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
        let now = chrono::Utc::now().timestamp();
        let mut task = Task {
            id: String::new(),
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
            sequence_id: 0,
            rest: Default::default(),
            linked_branch: None,
        };
        // Exclusive create: a colliding short id must mint a new one, never
        // silently overwrite someone else's ticket.
        for _ in 0..8 {
            task.id = format!("T-{}", &Uuid::new_v4().to_string()[..8]);
            let body = serde_json::to_string_pretty(&task)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.path_for(&task.id))
            {
                Ok(mut f) => {
                    use std::io::Write as _;
                    f.write_all(body.as_bytes())?;
                    return Ok(task);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "couldn't mint a unique task id",
        ))
    }

    pub fn touch(task: &mut Task) {
        task.updated_at = chrono::Utc::now().timestamp();
    }

    /// Load `id` for mutation — callers hold the lock via [`Self::with_lock`].
    fn load_for_update(&self, id: &str) -> std::io::Result<Task> {
        self.get(id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, format!("task {} not found", id))
        })
    }

    /// The sidecar file the desktop app keeps its comments in. A card holds
    /// its discussion inline; an aggregate row's lives here.
    fn comments_path(&self) -> PathBuf {
        self.dir.join("task_comments.json")
    }

    /// Every comment on a ticket, from whichever store holds it.
    ///
    /// Two writers, two stores: the app appends to `task_comments.json`, the
    /// CLI appends inline to the card. Each surface used to read only its
    /// own, which is how a task worked on from both sides could show a whole
    /// conversation in one window and none in the other.
    pub fn comments(&self, id: &str) -> Vec<Comment> {
        let mut out = self.get(id).map(|t| t.comments).unwrap_or_default();
        let Ok(bytes) = fs::read(self.comments_path()) else {
            return out;
        };
        let Ok(doc) = serde_json::from_slice::<Value>(&bytes) else {
            return out;
        };
        for row in doc.get("comments").and_then(Value::as_array).into_iter().flatten() {
            if row.get("task_id").and_then(Value::as_str) != Some(id) {
                continue;
            }
            out.push(Comment {
                author: row
                    .get("author_handle")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                at: row
                    .get("created_at")
                    .and_then(Value::as_str)
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.timestamp())
                    .unwrap_or_default(),
                body: row.get("body").and_then(Value::as_str).unwrap_or_default().to_string(),
            });
        }
        out.sort_by_key(|c| c.at);
        out
    }

    /// Append a comment to the sidecar store, in the shape the app writes.
    fn comment_in_sidecar(&self, id: &str, author: &str, body: &str) -> std::io::Result<()> {
        self.ensure_dir()?;
        let path = self.comments_path();
        let mut doc: Value = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| serde_json::json!({ "comments": [] }));
        let now = chrono::Utc::now().to_rfc3339();
        let row = serde_json::json!({
            "id": format!("cmt_{}", Uuid::new_v4()),
            "task_id": id,
            "parent_comment_id": Value::Null,
            "author_handle": author,
            "body": body,
            "created_at": now,
            "updated_at": now,
        });
        match doc.get_mut("comments").and_then(Value::as_array_mut) {
            Some(rows) => rows.push(row),
            None => doc["comments"] = Value::Array(vec![row]),
        }
        let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
        fs::write(&tmp, serde_json::to_vec_pretty(&doc).unwrap_or_default())?;
        match fs::rename(&tmp, &path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    pub fn comment(&self, id: &str, author: String, body: String) -> std::io::Result<Task> {
        self.with_lock(id, || {
            let mut task = self.load_for_update(id)?;
            // A card keeps its discussion inline so the file stays the whole
            // ticket; an aggregate row has nowhere to put it but the sidecar
            // the app already reads.
            if Self::is_card(id) {
                task.comments.push(Comment {
                    author,
                    at: chrono::Utc::now().timestamp(),
                    body,
                });
            } else {
                self.comment_in_sidecar(id, &author, &body)?;
            }
            Self::touch(&mut task);
            self.save(&task)?;
            Ok(task)
        })
    }

    pub fn claim(&self, id: &str, who: String) -> std::io::Result<Task> {
        self.with_lock(id, || {
            let mut task = self.load_for_update(id)?;
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
        })
    }

    pub fn unclaim(&self, id: &str) -> std::io::Result<Task> {
        self.with_lock(id, || {
            let mut task = self.load_for_update(id)?;
            task.claimed_by = None;
            if matches!(task.status(), TaskStatus::InProgress) {
                task.set_status(TaskStatus::Open);
            }
            Self::touch(&mut task);
            self.save(&task)?;
            Ok(task)
        })
    }

    pub fn assign(&self, id: &str, who: Option<String>) -> std::io::Result<Task> {
        self.with_lock(id, || {
            let mut task = self.load_for_update(id)?;
            task.assignee = who;
            Self::touch(&mut task);
            self.save(&task)?;
            Ok(task)
        })
    }

    pub fn set_status(&self, id: &str, status: TaskStatus) -> std::io::Result<Task> {
        self.with_lock(id, || {
            let mut task = self.load_for_update(id)?;
            task.set_status(status);
            Self::touch(&mut task);
            self.save(&task)?;
            Ok(task)
        })
    }

    pub fn link(&self, id: &str, pr: Option<String>, branch: Option<String>) -> std::io::Result<Task> {
        self.with_lock(id, || {
            let mut task = self.load_for_update(id)?;
            if pr.is_some() {
                task.linked_pr = pr;
            }
            if branch.is_some() {
                task.linked_branch = branch;
            }
            Self::touch(&mut task);
            self.save(&task)?;
            Ok(task)
        })
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

    #[test]
    fn concurrent_claims_pick_exactly_one_winner() {
        // Before the per-task lock, every racer read claimed_by = None and the
        // last save won — several agents each believed they owned the ticket.
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let task = store
            .create("hot ticket".into(), String::new(), "high".into(), "a".into(), vec![])
            .unwrap();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let repo = repo.clone();
                let id = task.id.clone();
                std::thread::spawn(move || TaskStore::at(&repo).claim(&id, format!("agent-{i}")).is_ok())
            })
            .collect();
        let wins = handles.into_iter().map(|h| h.join().unwrap()).filter(|ok| *ok).count();
        assert_eq!(wins, 1, "exactly one racer may win the claim");
        let final_task = store.get(&task.id).unwrap();
        assert!(final_task.claimed_by.is_some(), "the winner's claim survives");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn concurrent_comments_all_land() {
        // Unlocked read-modify-write dropped comments: two writers loaded the
        // same snapshot and the second save erased the first one's comment.
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let task = store
            .create("busy ticket".into(), String::new(), "medium".into(), "a".into(), vec![])
            .unwrap();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let repo = repo.clone();
                let id = task.id.clone();
                std::thread::spawn(move || {
                    TaskStore::at(&repo)
                        .comment(&id, format!("agent-{i}"), format!("note {i}"))
                        .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let final_task = store.get(&task.id).unwrap();
        assert_eq!(final_task.comments.len(), 8, "no comment may be lost to a race");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn torn_writes_stay_off_the_board_and_mutations_leave_no_litter() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let task = store
            .create("real ticket".into(), String::new(), "low".into(), "a".into(), vec![])
            .unwrap();
        let dir = repo.join(".aura").join("tasks");
        // A crash mid-save leaves a pid-suffixed tmp — it must not surface as
        // a ticket (its extension isn't .json, so list() never parses it).
        fs::write(dir.join("T-dead.tmp.42"), "{ torn hal").unwrap();
        assert_eq!(store.list().len(), 1, "a torn tmp file is not a ticket");
        // A full mutation cycle leaves neither lock nor tmp files behind.
        store.claim(&task.id, "bob".into()).unwrap();
        store.comment(&task.id, "bob".into(), "on it".into()).unwrap();
        store.set_status(&task.id, TaskStatus::Done).unwrap();
        let litter: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".lock") || (n.contains(".tmp.") && n != "T-dead.tmp.42"))
            .collect();
        assert!(litter.is_empty(), "no lock/tmp litter after mutations: {litter:?}");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_stale_lock_from_a_crashed_writer_is_stolen() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let task = store
            .create("orphaned".into(), String::new(), "low".into(), "a".into(), vec![])
            .unwrap();
        // Simulate a writer that crashed between taking the lock and removing
        // it. The lock's mtime is "now", so the next writer must wait out
        // STALE_LOCK and then steal it rather than time out forever.
        let lock = repo.join(".aura").join("tasks").join(format!("{}.lock", task.id));
        fs::write(&lock, "").unwrap();
        let claimed = store.claim(&task.id, "bob".into()).unwrap();
        assert_eq!(claimed.claimed_by.as_deref(), Some("bob"));
        assert!(!lock.exists() || fs::metadata(&lock).is_err(), "stolen lock cleaned up");
        let _ = fs::remove_dir_all(&repo);
    }
    fn seed_aggregate(repo: &Path, rows: serde_json::Value) {
        let dir = repo.join(".aura").join("tasks");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("tasks.json"),
            serde_json::to_vec_pretty(&serde_json::json!({ "tasks": rows })).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn the_board_is_the_cards_and_the_app_document_together() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        store
            .create("a card".into(), String::new(), "high".into(), "ashiq".into(), vec![])
            .unwrap();
        seed_aggregate(
            &repo,
            serde_json::json!([{ "id": "task_1", "title": "written by the app", "state_id": "started" }]),
        );

        let all = store.list();
        assert_eq!(all.len(), 2, "one board, whichever store holds the ticket");
        let app_row = all.iter().find(|t| t.id == "task_1").expect("the app's row is on the board");
        assert_eq!(app_row.title, "written by the app");
        assert_eq!(app_row.status(), TaskStatus::InProgress);
    }

    #[test]
    fn closing_an_app_row_from_the_cli_keeps_the_fields_a_card_cannot_hold() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        seed_aggregate(
            &repo,
            serde_json::json!([{
                "id": "task_1",
                "title": "ship it",
                "state_id": "unstarted",
                "epic_id": "epic_7",
                "estimate": 5.0,
            }]),
        );

        store.set_status("task_1", TaskStatus::Done).unwrap();

        let doc: serde_json::Value =
            serde_json::from_slice(&fs::read(repo.join(".aura/tasks/tasks.json")).unwrap()).unwrap();
        let row = &doc["tasks"][0];
        assert_eq!(row["state_id"], serde_json::json!("completed"));
        assert_eq!(row["status"], serde_json::json!("done"));
        assert_eq!(row["epic_id"], serde_json::json!("epic_7"), "the epic survived a CLI edit");
        assert_eq!(row["estimate"], serde_json::json!(5.0));
        assert_eq!(store.get("task_1").unwrap().status(), TaskStatus::Done);
    }

    #[test]
    fn editing_an_app_row_never_deletes_the_cards_beside_it() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let card = store
            .create("a card".into(), String::new(), "high".into(), "ashiq".into(), vec![])
            .unwrap();
        seed_aggregate(&repo, serde_json::json!([{ "id": "task_1", "title": "app row" }]));

        store.assign("task_1", Some("ashiq".into())).unwrap();

        assert!(store.get(&card.id).is_some(), "the card is still there");
        assert_eq!(store.list().len(), 2);
    }

    #[test]
    fn a_comment_reads_back_whichever_store_the_writer_used() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        let card = store
            .create("a card".into(), String::new(), "high".into(), "ashiq".into(), vec![])
            .unwrap();
        // What the app writes: its own sidecar, keyed by task id.
        fs::write(
            repo.join(".aura/tasks/task_comments.json"),
            serde_json::to_vec_pretty(&serde_json::json!({ "comments": [{
                "id": "cmt_1",
                "task_id": card.id,
                "author_handle": "someone",
                "body": "left in the app",
                "created_at": "2026-09-04T10:00:00+00:00",
                "updated_at": "2026-09-04T10:00:00+00:00",
            }]}))
            .unwrap(),
        )
        .unwrap();
        // What the CLI writes: inline on the card.
        store.comment(&card.id, "ashiq".into(), "left on the command line".into()).unwrap();

        let bodies: Vec<String> = store.comments(&card.id).into_iter().map(|c| c.body).collect();
        assert!(bodies.iter().any(|b| b == "left in the app"));
        assert!(bodies.iter().any(|b| b == "left on the command line"));
    }

    #[test]
    fn a_comment_on_an_app_row_goes_where_the_app_will_find_it() {
        let repo = tmp_repo();
        let store = TaskStore::at(&repo);
        seed_aggregate(&repo, serde_json::json!([{ "id": "task_1", "title": "app row" }]));

        store.comment("task_1", "ashiq".into(), "evidence".into()).unwrap();

        let doc: serde_json::Value =
            serde_json::from_slice(&fs::read(repo.join(".aura/tasks/task_comments.json")).unwrap())
                .unwrap();
        assert_eq!(doc["comments"][0]["task_id"], serde_json::json!("task_1"));
        assert_eq!(doc["comments"][0]["body"], serde_json::json!("evidence"));
        assert_eq!(store.comments("task_1").len(), 1);
    }

}
