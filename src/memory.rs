use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::session::worktree_aura_path;

// ── Data structures ──

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectMemory {
    /// What is this project? One-line purpose.
    pub identity: String,
    /// Tech stack (languages, frameworks, databases, infra)
    pub stack: Vec<String>,
    /// Architecture overview — modules/services and how they connect
    pub architecture: Vec<ArchComponent>,
    /// Key decisions and why they were made
    pub decisions: Vec<TimelineEntry>,
    /// Coding conventions and patterns
    pub conventions: Vec<MemoryEntry>,
    /// Gotchas — things that trip you up
    pub gotchas: Vec<MemoryEntry>,
    /// General context — anything agents should know
    pub context: Vec<MemoryEntry>,
    /// Active work — what's being done right now (auto-cleaned)
    pub active_work: Vec<MemoryEntry>,
    /// Last updated timestamp
    pub last_updated: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchComponent {
    pub name: String,
    pub kind: String,           // "service", "library", "module", "database", "external"
    pub path: Option<String>,   // directory or file path
    pub description: String,
    pub connects_to: Vec<String>, // names of other components
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TimelineEntry {
    pub date: String,           // YYYY-MM-DD or descriptive
    pub title: String,
    pub description: String,
    pub category: String,       // "decision", "milestone", "pivot", "incident", "refactor"
    pub author: Option<String>, // who/what recorded this
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MemoryEntry {
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub added_by: String,       // agent or human
    pub added_at: u64,
}

impl Default for ProjectMemory {
    fn default() -> Self {
        Self {
            identity: String::new(),
            stack: Vec::new(),
            architecture: Vec::new(),
            decisions: Vec::new(),
            conventions: Vec::new(),
            gotchas: Vec::new(),
            context: Vec::new(),
            active_work: Vec::new(),
            last_updated: 0,
        }
    }
}

// ── Manager ──

pub struct MemoryManager;

impl MemoryManager {
    fn memory_path() -> String {
        worktree_aura_path("memory.json")
    }

    fn ensure_dir() {
        // memory.json is in .aura/ root, dir should exist
        let path = Self::memory_path();
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = fs::create_dir_all(parent);
        }
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    /// Load project memory (or create default)
    pub fn load() -> ProjectMemory {
        Self::ensure_dir();
        let path = Self::memory_path();
        if let Ok(content) = fs::read_to_string(&path) {
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            ProjectMemory::default()
        }
    }

    /// Save project memory (atomic write)
    fn save(memory: &ProjectMemory) -> Result<(), String> {
        let path = Self::memory_path();
        let tmp = format!("{}.tmp", path);
        let json = serde_json::to_string_pretty(memory)
            .map_err(|e| format!("Serialize error: {}", e))?;
        fs::write(&tmp, &json).map_err(|e| format!("Write error: {}", e))?;
        fs::rename(&tmp, &path).map_err(|e| format!("Rename error: {}", e))?;
        Ok(())
    }

    /// Set project identity
    pub fn set_identity(identity: &str, stack: Vec<String>) {
        let mut mem = Self::load();
        mem.identity = identity.to_string();
        mem.stack = stack;
        mem.last_updated = Self::now();
        let _ = Self::save(&mem);
    }

    /// Add an architecture component
    pub fn add_component(component: ArchComponent) {
        let mut mem = Self::load();
        // Update if same name exists
        mem.architecture.retain(|c| c.name != component.name);
        mem.architecture.push(component);
        mem.last_updated = Self::now();
        let _ = Self::save(&mem);
    }

    /// Remove an architecture component
    pub fn remove_component(name: &str) {
        let mut mem = Self::load();
        mem.architecture.retain(|c| c.name != name);
        mem.last_updated = Self::now();
        let _ = Self::save(&mem);
    }

    /// Add a timeline entry (decision, milestone, etc.)
    pub fn add_timeline(entry: TimelineEntry) {
        let mut mem = Self::load();
        mem.decisions.push(entry);
        mem.last_updated = Self::now();
        let _ = Self::save(&mem);
    }

    /// Add a memory entry to a section
    pub fn add_entry(section: &str, content: &str, tags: Vec<String>, author: &str) -> String {
        let mut mem = Self::load();
        let id = format!("mem-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let entry = MemoryEntry {
            id: id.clone(),
            content: content.to_string(),
            tags,
            added_by: author.to_string(),
            added_at: Self::now(),
        };

        match section {
            "convention" | "conventions" => mem.conventions.push(entry),
            "gotcha" | "gotchas" => mem.gotchas.push(entry),
            "context" => mem.context.push(entry),
            "active" | "active_work" => mem.active_work.push(entry),
            _ => mem.context.push(entry),
        }

        mem.last_updated = Self::now();
        let _ = Self::save(&mem);
        id
    }

    /// Remove a memory entry by id from any section
    pub fn forget(id: &str) -> bool {
        let mut mem = Self::load();
        let before = mem.conventions.len() + mem.gotchas.len() + mem.context.len() + mem.active_work.len();
        mem.conventions.retain(|e| e.id != id);
        mem.gotchas.retain(|e| e.id != id);
        mem.context.retain(|e| e.id != id);
        mem.active_work.retain(|e| e.id != id);
        // Also allow removing timeline entries
        mem.decisions.retain(|e| e.title != id);
        let after = mem.conventions.len() + mem.gotchas.len() + mem.context.len() + mem.active_work.len();
        if before != after {
            mem.last_updated = Self::now();
            let _ = Self::save(&mem);
            true
        } else {
            false
        }
    }

    /// Get a compact summary for injection into aura_status
    pub fn compact_summary() -> Option<serde_json::Value> {
        let mem = Self::load();
        if mem.identity.is_empty() && mem.architecture.is_empty() && mem.context.is_empty() {
            return None;
        }

        let mut summary = serde_json::json!({});

        if !mem.identity.is_empty() {
            summary["project"] = serde_json::json!(mem.identity);
        }
        if !mem.stack.is_empty() {
            summary["stack"] = serde_json::json!(mem.stack);
        }

        let arch_count = mem.architecture.len();
        let decision_count = mem.decisions.len();
        let convention_count = mem.conventions.len();
        let gotcha_count = mem.gotchas.len();
        let context_count = mem.context.len();

        summary["entries"] = serde_json::json!({
            "architecture": arch_count,
            "decisions": decision_count,
            "conventions": convention_count,
            "gotchas": gotcha_count,
            "context": context_count,
        });

        if gotcha_count > 0 {
            // Always surface gotchas — they prevent mistakes
            summary["gotchas"] = serde_json::json!(
                mem.gotchas.iter().map(|g| &g.content).collect::<Vec<_>>()
            );
        }

        summary["hint"] = serde_json::json!(
            "Call `aura_memory_read` for full project memory (architecture, decisions, conventions)."
        );

        Some(summary)
    }

    /// Get full memory as structured JSON
    pub fn full_view() -> serde_json::Value {
        let mem = Self::load();

        serde_json::json!({
            "identity": mem.identity,
            "stack": mem.stack,
            "architecture": mem.architecture.iter().map(|c| serde_json::json!({
                "name": c.name,
                "kind": c.kind,
                "path": c.path,
                "description": c.description,
                "connects_to": c.connects_to,
            })).collect::<Vec<_>>(),
            "timeline": mem.decisions.iter().map(|d| serde_json::json!({
                "date": d.date,
                "title": d.title,
                "description": d.description,
                "category": d.category,
                "author": d.author,
            })).collect::<Vec<_>>(),
            "conventions": mem.conventions.iter().map(|e| serde_json::json!({
                "id": e.id,
                "content": e.content,
                "tags": e.tags,
            })).collect::<Vec<_>>(),
            "gotchas": mem.gotchas.iter().map(|e| serde_json::json!({
                "id": e.id,
                "content": e.content,
                "tags": e.tags,
            })).collect::<Vec<_>>(),
            "context": mem.context.iter().map(|e| serde_json::json!({
                "id": e.id,
                "content": e.content,
                "tags": e.tags,
            })).collect::<Vec<_>>(),
            "active_work": mem.active_work.iter().map(|e| serde_json::json!({
                "id": e.id,
                "content": e.content,
                "tags": e.tags,
            })).collect::<Vec<_>>(),
            "last_updated": mem.last_updated,
        })
    }

    /// Search memories by keyword across all sections
    pub fn search(query: &str) -> Vec<serde_json::Value> {
        let mem = Self::load();
        let q = query.to_lowercase();
        let mut results = Vec::new();

        // Search identity
        if mem.identity.to_lowercase().contains(&q) {
            results.push(serde_json::json!({"section": "identity", "content": mem.identity}));
        }

        // Search architecture
        for c in &mem.architecture {
            if c.name.to_lowercase().contains(&q) || c.description.to_lowercase().contains(&q) {
                results.push(serde_json::json!({"section": "architecture", "name": c.name, "description": c.description}));
            }
        }

        // Search timeline
        for d in &mem.decisions {
            if d.title.to_lowercase().contains(&q) || d.description.to_lowercase().contains(&q) {
                results.push(serde_json::json!({"section": "timeline", "date": d.date, "title": d.title, "description": d.description}));
            }
        }

        // Search all entry sections
        let sections = [
            ("conventions", &mem.conventions),
            ("gotchas", &mem.gotchas),
            ("context", &mem.context),
            ("active_work", &mem.active_work),
        ];
        for (name, entries) in &sections {
            for e in *entries {
                if e.content.to_lowercase().contains(&q)
                    || e.tags.iter().any(|t| t.to_lowercase().contains(&q))
                {
                    results.push(serde_json::json!({"section": name, "id": e.id, "content": e.content, "tags": e.tags}));
                }
            }
        }

        results
    }
}
