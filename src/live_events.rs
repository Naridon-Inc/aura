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
    /// AI-generated 1-sentence WHY for this specific change. None if no AI key or generation failed.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rationale: Option<String>,
    /// AI-generated 1-line persistent tagline for what this node does. None until first successful call.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary: Option<String>,
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
                            rationale: None,
                            summary: None,
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
                        rationale: None,
                        summary: None,
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
                    rationale: None,
                    summary: None,
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
                        rationale: None,
                        summary: None,
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

// ─── Commit-keyed rationale store ──────────────────────────────────────────
// The live events buffer (events.jsonl) carries rationales keyed by event_id,
// not by commit SHA — so once a commit lands you can't retrieve "why did
// function X change in commit <sha>?". This store closes that gap: rationales
// are written keyed by commit SHA (or "pending" pre-commit) into a durable
// append-only log, then the SHA is backfilled in the post-commit hook once it
// becomes known. intent_vs_actual joins against it at report time.

/// A rationale/summary row pinned to the commit it belongs to.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommitRationale {
    /// Full commit SHA, or "pending" until backfilled post-commit.
    pub commit_sha: String,
    pub timestamp: u64,
    pub function_name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary: Option<String>,
}

impl CommitRationale {
    const STORE_FILE: &'static str = ".aura/commit_rationales.jsonl";
    /// Sentinel SHA used until the real commit hash is known (post-commit).
    pub const PENDING_SHA: &'static str = "pending";
}

/// Persist a batch of FunctionChange rationales to the commit-keyed store.
///
/// `commit_sha` is the known SHA when available; pass `None` from the
/// pre-commit / live path where the hash doesn't exist yet — rows are then
/// written with the "pending" sentinel and rewritten by `backfill_commit_shas`
/// from the post-commit hook. Only changes that actually carry a rationale or
/// summary are written (an un-enriched change has nothing to retrieve later).
///
/// Append-only and best-effort: any IO error is swallowed so this never blocks
/// or aborts a commit. `file_path` is recorded as context in the kind field's
/// sibling — kept on FunctionChange — but not required for the join, which is
/// by function name within a SHA.
pub fn persist_rationales(commit_sha: Option<&str>, _file_path: &str, changes: &[FunctionChange]) {
    let to_write: Vec<&FunctionChange> = changes
        .iter()
        .filter(|c| c.rationale.is_some() || c.summary.is_some())
        .collect();
    if to_write.is_empty() {
        return;
    }

    let _ = fs::create_dir_all(".aura");
    let file = match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(CommitRationale::STORE_FILE)
    {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut writer = BufWriter::new(file);

    let sha = commit_sha
        .map(|s| s.to_string())
        .unwrap_or_else(|| CommitRationale::PENDING_SHA.to_string());
    let ts = now_ms() / 1000;

    for c in to_write {
        let row = CommitRationale {
            commit_sha: sha.clone(),
            timestamp: ts,
            function_name: c.name.clone(),
            kind: c.kind.clone(),
            rationale: c.rationale.clone(),
            summary: c.summary.clone(),
        };
        if let Ok(json) = serde_json::to_string(&row) {
            let _ = writeln!(writer, "{}", json);
        }
    }
    let _ = writer.flush();
}

/// Replace every "pending" commit_sha in the store with the real `commit_sha`.
///
/// Called from the post-commit hook once HEAD points at the freshly-created
/// commit. Rewrites the whole file in place (the store is small — one batch of
/// function-level rows per commit). Rows already pinned to a real SHA are left
/// untouched, so re-running the hook is idempotent. Best-effort: a read/write
/// failure leaves the store as-is rather than aborting the post-commit flow.
pub fn backfill_commit_shas(commit_sha: &str) {
    let path = Path::new(CommitRationale::STORE_FILE);
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return, // no store yet → nothing to backfill
    };

    let mut rows: Vec<CommitRationale> = Vec::new();
    let mut changed = false;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<CommitRationale>(line) {
            Ok(mut row) => {
                if row.commit_sha == CommitRationale::PENDING_SHA {
                    row.commit_sha = commit_sha.to_string();
                    changed = true;
                }
                rows.push(row);
            }
            // Preserve unparseable lines verbatim would be ideal, but a
            // corrupt row can't be re-typed; drop only if we're rewriting.
            Err(_) => {}
        }
    }

    if !changed {
        return; // nothing pending — avoid a needless rewrite
    }

    let mut buf = String::new();
    for row in &rows {
        if let Ok(json) = serde_json::to_string(row) {
            buf.push_str(&json);
            buf.push('\n');
        }
    }
    let _ = fs::write(path, buf);
}

/// Enrich a set of FunctionChange entries with AI-generated rationales + summaries.
/// Mutates each change in place. Silent no-op if no AI key is configured, the intent
/// is empty, changes is empty, or the call/parse fails. Never blocks commits.
pub fn enrich_with_rationales(changes: &mut [FunctionChange], intent: &str) {
    if changes.is_empty() || intent.trim().is_empty() {
        return;
    }

    // Baseline: the user's stated intent is itself a valid rationale for every
    // change. AI enrichment below can override with more specific per-function
    // reasoning, but if no key is set / the call fails, the raw intent still
    // shows up in the dashboard instead of a generic "X modified Y" fallback.
    let intent_trimmed = intent.trim().to_string();
    for c in changes.iter_mut() {
        if c.rationale.is_none() {
            c.rationale = Some(intent_trimmed.clone());
        }
    }

    let cfg = crate::config::ConfigManager::load();
    let has_key = cfg.gemini_api_key.is_some()
        || cfg.anthropic_api_key.is_some()
        || cfg.openai_api_key.is_some()
        || cfg.mercury_api_key.is_some();
    if !has_key {
        return;
    }

    // Compact input: one line per change to keep prompt small.
    let mut lines = String::new();
    for c in changes.iter() {
        let action = match c.change_type {
            ChangeType::Added => "added",
            ChangeType::Modified => "modified",
            ChangeType::Deleted => "deleted",
        };
        lines.push_str(&format!("- {} {} {}\n", action, c.kind, c.name));
    }

    let system = "You explain code changes. For each function below, write ONE concise sentence (under 20 words) explaining WHY it changed, grounded in the stated intent. Also write a persistent one-line summary of what the function does. Output STRICT JSON only, no prose: {\"<fn_name>\": {\"reason\": \"...\", \"summary\": \"...\"}}. Keys must exactly match the function names given.";
    let user = format!("Intent: {}\n\nChanges:\n{}", intent, lines);

    let raw = match crate::gsd::GsdEngine::generate_content(
        system,
        &user,
        0.2,
        crate::gsd::CognitiveLabor::Researcher,
    ) {
        Some(s) => s,
        None => return,
    };

    // LLMs often wrap JSON in ```json ... ``` fences — strip them.
    let trimmed = raw.trim();
    let cleaned = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: serde_json::Value = match serde_json::from_str(cleaned) {
        Ok(v) => v,
        Err(_) => return,
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return,
    };

    for c in changes.iter_mut() {
        if let Some(entry) = obj.get(&c.name).and_then(|v| v.as_object()) {
            if let Some(r) = entry.get("reason").and_then(|v| v.as_str()) {
                c.rationale = Some(r.trim().to_string());
            }
            if let Some(s) = entry.get("summary").and_then(|v| v.as_str()) {
                c.summary = Some(s.trim().to_string());
            }
        }
    }
}

/// Helper to get current git branch name.
pub fn current_branch() -> String {
    let repo = match git2::Repository::discover(".") {
        Ok(r) => r,
        Err(_) => return "unknown".to_string(),
    };
    if let Ok(head) = repo.head() {
        if let Some(name) = head.shorthand() {
            return name.to_string();
        }
    }
    // Unborn HEAD (fresh `git init` with no commits): parse .git/HEAD symbolic-ref.
    let head_path = repo.path().join("HEAD");
    if let Ok(content) = std::fs::read_to_string(&head_path) {
        let trimmed = content.trim();
        if let Some(rest) = trimmed.strip_prefix("ref: refs/heads/") {
            return rest.to_string();
        }
    }
    "unknown".to_string()
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
