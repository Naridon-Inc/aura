use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// A single function-level change detected by the daemon in real-time.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LiveEvent {
    pub event_id: String,
    pub timestamp: u64,
    pub user: String,
    pub branch: String,
    pub repo: String,
    pub file_path: String,
    pub changes: Vec<FunctionChange>,
}

/// What happened to a specific function/class.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FunctionChange {
    pub name: String,
    pub kind: String, // "function", "class", "method", etc.
    pub change_type: ChangeType,
    pub old_hash: Option<String>,
    pub new_hash: Option<String>,
    /// Functions this one calls (from AST dependencies)
    pub dependencies: Vec<String>,
    /// Full function body text (for sync push). Only populated when sync is active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
}

/// Tracks the previous AST state of files so we can compute diffs.
/// Maps file_path -> Vec<(identifier, kind, content_hash, dependencies)>
pub struct AstStateCache {
    state: std::collections::HashMap<String, Vec<CachedNode>>,
    initial_scan_done: bool,
}

#[derive(Clone, Debug)]
pub struct CachedNode {
    pub identifier: String,
    pub kind: String,
    pub content_hash: String,
    pub dependencies: Vec<String>,
}

impl AstStateCache {
    pub fn new() -> Self {
        Self {
            state: std::collections::HashMap::new(),
            initial_scan_done: false,
        }
    }

    /// Mark the initial scan as complete. After this, new files will emit "added" events.
    pub fn mark_initial_scan_done(&mut self) {
        self.initial_scan_done = true;
    }

    /// Compute the diff between old state and new AST nodes for a file.
    /// Returns the list of function-level changes.
    pub fn diff_and_update(
        &mut self,
        file_path: &str,
        new_nodes: &[crate::models::AstNode],
    ) -> Vec<FunctionChange> {
        let mut changes = Vec::new();

        let new_cached: Vec<CachedNode> = new_nodes
            .iter()
            .filter_map(|n| {
                n.identifier.as_ref().map(|id| CachedNode {
                    identifier: id.clone(),
                    kind: n.kind.clone(),
                    content_hash: n.content_hash.clone(),
                    dependencies: n.dependencies.iter().map(|d| d.name.clone()).collect(),
                })
            })
            .collect();

        let old_nodes = self.state.get(file_path);

        // Find added and modified
        for new in &new_cached {
            if let Some(old_list) = old_nodes {
                if let Some(old) = old_list.iter().find(|o| o.identifier == new.identifier) {
                    // Exists in both — check if modified
                    if old.content_hash != new.content_hash {
                        changes.push(FunctionChange {
                            name: new.identifier.clone(),
                            kind: new.kind.clone(),
                            change_type: ChangeType::Modified,
                            old_hash: Some(old.content_hash.clone()),
                            new_hash: Some(new.content_hash.clone()),
                            dependencies: new.dependencies.clone(),
                            content: None,
                        });
                    }
                } else {
                    // New function
                    changes.push(FunctionChange {
                        name: new.identifier.clone(),
                        kind: new.kind.clone(),
                        change_type: ChangeType::Added,
                        old_hash: None,
                        new_hash: Some(new.content_hash.clone()),
                        dependencies: new.dependencies.clone(),
                        content: None,
                    });
                }
            } else if self.initial_scan_done {
                // New file appeared after daemon started — emit "added" events
                changes.push(FunctionChange {
                    name: new.identifier.clone(),
                    kind: new.kind.clone(),
                    change_type: ChangeType::Added,
                    old_hash: None,
                    new_hash: Some(new.content_hash.clone()),
                    dependencies: new.dependencies.clone(),
                    content: None,
                });
            }
            // else: initial scan — don't emit "added" to avoid noise
        }

        // Find deleted (was in old, not in new)
        if let Some(old_list) = old_nodes {
            for old in old_list {
                if !new_cached.iter().any(|n| n.identifier == old.identifier) {
                    changes.push(FunctionChange {
                        name: old.identifier.clone(),
                        kind: old.kind.clone(),
                        change_type: ChangeType::Deleted,
                        old_hash: Some(old.content_hash.clone()),
                        new_hash: None,
                        dependencies: old.dependencies.clone(),
                        content: None,
                    });
                }
            }
        }

        // Update cache
        self.state.insert(file_path.to_string(), new_cached);

        // Track dirty functions for auto-pull safety
        if !changes.is_empty() {
            DirtyTracker::mark_dirty(file_path, &changes);
        }

        changes
    }
}

// ─── Dirty Function Tracker ────────────────────────────────────────────────
// Tracks locally-modified functions so auto-pull knows which are safe to overwrite.

pub struct DirtyTracker;

impl DirtyTracker {
    const DIRTY_FILE: &'static str = ".aura/live/dirty_functions.json";
    const EXPIRY_SECS: u64 = 30;

    /// Mark functions as dirty (locally modified).
    pub fn mark_dirty(file_path: &str, changes: &[FunctionChange]) {
        let now = now_ms() / 1000;
        let mut entries = Self::load();

        for change in changes {
            if change.change_type == ChangeType::Modified || change.change_type == ChangeType::Added {
                let key = format!("{}::{}", file_path, change.name);
                entries.insert(key, now);
            }
        }

        Self::save(&entries);
    }

    /// Check if a function is dirty (modified locally within EXPIRY_SECS).
    pub fn is_dirty(file_path: &str, function_name: &str) -> bool {
        let now = now_ms() / 1000;
        let entries = Self::load();
        let key = format!("{}::{}", file_path, function_name);
        if let Some(&ts) = entries.get(&key) {
            now.saturating_sub(ts) < Self::EXPIRY_SECS
        } else {
            false
        }
    }

    fn load() -> std::collections::HashMap<String, u64> {
        let path = Path::new(Self::DIRTY_FILE);
        if !path.exists() {
            return std::collections::HashMap::new();
        }
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(entries: &std::collections::HashMap<String, u64>) {
        let _ = fs::create_dir_all(".aura/live");
        // Prune expired entries while saving
        let now = now_ms() / 1000;
        let pruned: std::collections::HashMap<&String, &u64> = entries.iter()
            .filter(|(_, ts)| now.saturating_sub(**ts) < Self::EXPIRY_SECS)
            .collect();
        if let Ok(json) = serde_json::to_string(&pruned) {
            let _ = fs::write(Self::DIRTY_FILE, json);
        }
    }
}

/// Buffer that stores live events locally before syncing to cloud.
pub struct LiveEventBuffer;

impl LiveEventBuffer {
    const BUFFER_DIR: &'static str = ".aura/live";
    const EVENTS_FILE: &'static str = ".aura/live/events.jsonl";

    /// Ensure the buffer directory exists.
    pub fn init() {
        let _ = fs::create_dir_all(Self::BUFFER_DIR);
    }

    /// Append a live event to the local buffer.
    pub fn append(event: &LiveEvent) -> std::io::Result<()> {
        Self::init();
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(Self::EVENTS_FILE)?;
        let mut writer = BufWriter::new(file);
        let json = serde_json::to_string(event).unwrap_or_default();
        writeln!(writer, "{}", json)?;
        Ok(())
    }

    /// Read all buffered events and clear the buffer.
    pub fn drain() -> Vec<LiveEvent> {
        let path = Path::new(Self::EVENTS_FILE);
        if !path.exists() {
            return Vec::new();
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };

        let events: Vec<LiveEvent> = content
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();

        // Clear the buffer
        let _ = fs::write(path, "");

        events
    }

    /// Count of buffered events.
    pub fn count() -> usize {
        let path = Path::new(Self::EVENTS_FILE);
        if !path.exists() {
            return 0;
        }
        fs::read_to_string(path)
            .map(|c| c.lines().filter(|l| !l.is_empty()).count())
            .unwrap_or(0)
    }
}

/// Helper to get current git branch name.
pub fn current_branch() -> String {
    let repo = match git2::Repository::discover(".") {
        Ok(r) => r,
        Err(_) => return "unknown".to_string(),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return "unknown".to_string(),
    };
    head.shorthand().unwrap_or("unknown").to_string()
}

/// Helper to get repo name from git remote (e.g., "Naridon-Inc/aura").
pub fn repo_name() -> String {
    let url = git2::Repository::discover(".")
        .ok()
        .and_then(|repo| {
            repo.find_remote("origin")
                .ok()
                .and_then(|remote| remote.url().map(|u| u.to_string()))
        })
        .unwrap_or_else(|| "local".to_string());

    // Extract "owner/repo" from URLs like:
    //   https://github.com/Owner/Repo.git
    //   git@github.com:Owner/Repo.git
    let cleaned = url.trim_end_matches(".git");
    if let Some(idx) = cleaned.find("github.com") {
        let after = &cleaned[idx + "github.com".len()..];
        let after = after.trim_start_matches('/').trim_start_matches(':');
        return after.to_string();
    }
    // Fallback: return last two path segments
    let parts: Vec<&str> = cleaned.rsplitn(3, '/').collect();
    if parts.len() >= 2 {
        format!("{}/{}", parts[1], parts[0])
    } else {
        url
    }
}

/// Helper to get current username from git config.
pub fn git_user() -> String {
    git2::Repository::discover(".")
        .ok()
        .and_then(|repo| {
            repo.config()
                .ok()
                .and_then(|cfg| cfg.get_string("user.name").ok())
        })
        .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "unknown".to_string()))
}

/// Helper to get current timestamp.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
