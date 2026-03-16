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

// ── Limits ──

const MAX_ENTRY_LENGTH: usize = 1000;       // truncate individual entries
const MAX_ENTRIES_PER_SECTION: usize = 50;   // cap per section
const MAX_ARCHITECTURE: usize = 100;         // cap components
const MAX_TIMELINE: usize = 200;             // cap timeline entries
const ACTIVE_WORK_MAX_AGE: u64 = 86400 * 7;  // auto-prune active_work after 7 days

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

    /// Save project memory (atomic write, with auto-pruning)
    fn save(memory: &mut ProjectMemory) -> Result<(), String> {
        Self::prune(memory);
        let path = Self::memory_path();
        let tmp = format!("{}.tmp", path);
        let json = serde_json::to_string_pretty(memory)
            .map_err(|e| format!("Serialize error: {}", e))?;
        fs::write(&tmp, &json).map_err(|e| format!("Write error: {}", e))?;
        fs::rename(&tmp, &path).map_err(|e| format!("Rename error: {}", e))?;
        Ok(())
    }

    /// Enforce size limits and auto-cleanup
    fn prune(memory: &mut ProjectMemory) {
        let now = Self::now();

        // Auto-prune old active_work entries
        memory.active_work.retain(|e| now - e.added_at < ACTIVE_WORK_MAX_AGE);

        // Cap sections — keep most recent when over limit
        Self::cap_entries(&mut memory.conventions, MAX_ENTRIES_PER_SECTION);
        Self::cap_entries(&mut memory.gotchas, MAX_ENTRIES_PER_SECTION);
        Self::cap_entries(&mut memory.context, MAX_ENTRIES_PER_SECTION);
        Self::cap_entries(&mut memory.active_work, MAX_ENTRIES_PER_SECTION);

        // Cap architecture and timeline
        if memory.architecture.len() > MAX_ARCHITECTURE {
            memory.architecture = memory.architecture.split_off(memory.architecture.len() - MAX_ARCHITECTURE);
        }
        if memory.decisions.len() > MAX_TIMELINE {
            memory.decisions = memory.decisions.split_off(memory.decisions.len() - MAX_TIMELINE);
        }
    }

    /// Keep only the most recent N entries
    fn cap_entries(entries: &mut Vec<MemoryEntry>, max: usize) {
        if entries.len() > max {
            entries.sort_by(|a, b| b.added_at.cmp(&a.added_at));
            entries.truncate(max);
        }
    }

    /// Truncate content to MAX_ENTRY_LENGTH
    fn truncate(content: &str) -> String {
        if content.len() > MAX_ENTRY_LENGTH {
            format!("{}...", &content[..MAX_ENTRY_LENGTH])
        } else {
            content.to_string()
        }
    }

    /// Set project identity
    pub fn set_identity(identity: &str, stack: Vec<String>) {
        let mut mem = Self::load();
        mem.identity = Self::truncate(identity);
        mem.stack = stack;
        mem.last_updated = Self::now();
        let _ = Self::save(&mut mem);
    }

    /// Add an architecture component
    pub fn add_component(mut component: ArchComponent) {
        let mut mem = Self::load();
        component.description = Self::truncate(&component.description);
        // Update if same name exists
        mem.architecture.retain(|c| c.name != component.name);
        mem.architecture.push(component);
        mem.last_updated = Self::now();
        let _ = Self::save(&mut mem);
    }

    /// Remove an architecture component
    pub fn remove_component(name: &str) {
        let mut mem = Self::load();
        mem.architecture.retain(|c| c.name != name);
        mem.last_updated = Self::now();
        let _ = Self::save(&mut mem);
    }

    /// Add a timeline entry (decision, milestone, etc.)
    pub fn add_timeline(mut entry: TimelineEntry) {
        let mut mem = Self::load();
        entry.description = Self::truncate(&entry.description);
        // Dedup: skip if same title+date already exists
        if !mem.decisions.iter().any(|d| d.title == entry.title && d.date == entry.date) {
            mem.decisions.push(entry);
        }
        mem.last_updated = Self::now();
        let _ = Self::save(&mut mem);
    }

    /// Add a memory entry to a section
    pub fn add_entry(section: &str, content: &str, tags: Vec<String>, author: &str) -> String {
        let mut mem = Self::load();
        let truncated = Self::truncate(content);

        // Dedup: skip if same content already exists in the section
        let exists = |entries: &[MemoryEntry]| entries.iter().any(|e| e.content == truncated);
        let target = match section {
            "convention" | "conventions" => &mem.conventions,
            "gotcha" | "gotchas" => &mem.gotchas,
            "active" | "active_work" => &mem.active_work,
            _ => &mem.context,
        };
        if exists(target) {
            // Return existing entry's id
            let existing_id = target.iter().find(|e| e.content == truncated)
                .map(|e| e.id.clone())
                .unwrap_or_else(|| "duplicate".to_string());
            return existing_id;
        }

        let id = format!("mem-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let entry = MemoryEntry {
            id: id.clone(),
            content: truncated,
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
        let _ = Self::save(&mut mem);
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
        mem.decisions.retain(|e| e.title != id);
        let after = mem.conventions.len() + mem.gotchas.len() + mem.context.len() + mem.active_work.len();
        if before != after {
            mem.last_updated = Self::now();
            let _ = Self::save(&mut mem);
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

    /// AI-powered memory compaction. Summarizes old entries in a section
    /// into fewer, denser entries. Uses whatever AI provider is configured
    /// (Gemini free tier via CLI key, or Anthropic from Claude Code env).
    /// Returns number of entries compacted, or error.
    pub fn compact_section(section: &str) -> Result<usize, String> {
        let mut mem = Self::load();
        let entries = match section {
            "convention" | "conventions" => &mut mem.conventions,
            "gotcha" | "gotchas" => &mut mem.gotchas,
            "context" => &mut mem.context,
            _ => return Err(format!("Cannot compact section '{}'", section)),
        };

        if entries.len() < 10 {
            return Ok(0); // Not worth compacting
        }

        // Collect all content
        let all_content: Vec<String> = entries.iter()
            .map(|e| format!("- {}", e.content))
            .collect();
        let combined = all_content.join("\n");

        let prompt = format!(
            "Compress these {} '{}' entries into at most 5 dense entries. \
             Each entry should be one clear sentence. Return ONLY a JSON array of strings, nothing else.\n\n{}",
            entries.len(), section, combined
        );

        // Try Gemini first (free), then Anthropic
        let response = Self::call_ai(&prompt)?;

        // Parse response as JSON array of strings
        let json_str = response
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        let compressed: Vec<String> = serde_json::from_str(json_str)
            .map_err(|e| format!("Failed to parse AI response: {}", e))?;

        let original_count = entries.len();
        let now = Self::now();

        // Replace entries with compressed versions
        entries.clear();
        for content in &compressed {
            entries.push(MemoryEntry {
                id: format!("mem-{}", &uuid::Uuid::new_v4().to_string()[..8]),
                content: Self::truncate(content),
                tags: vec!["compacted".to_string()],
                added_by: "aura-compactor".to_string(),
                added_at: now,
            });
        }

        mem.last_updated = now;
        let _ = Self::save(&mut mem);

        Ok(original_count - compressed.len())
    }

    /// Call AI provider (Gemini or Anthropic) for text generation
    fn call_ai(prompt: &str) -> Result<String, String> {
        let _config = crate::config::ConfigManager::load();
        let provider = crate::config::ConfigManager::get_active_provider();

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        match provider.as_str() {
            "anthropic" => {
                let key = crate::config::ConfigManager::get_api_key("anthropic")
                    .ok_or("No Anthropic API key found")?;

                let body = serde_json::json!({
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 1024,
                    "messages": [{"role": "user", "content": prompt}]
                });

                let res = client.post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", &key)
                    .header("anthropic-version", "2023-06-01")
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .map_err(|e| format!("Anthropic request failed: {}", e))?;

                let json: serde_json::Value = res.json()
                    .map_err(|e| format!("Anthropic parse error: {}", e))?;

                json["content"][0]["text"].as_str()
                    .map(|s| s.to_string())
                    .ok_or("Empty Anthropic response".to_string())
            }
            _ => {
                // Gemini (default, free tier)
                let key = crate::config::ConfigManager::get_api_key("gemini")
                    .ok_or("No Gemini API key found. Configure via `aura config` or install Gemini CLI.")?;

                let url = format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}",
                    key
                );

                let body = serde_json::json!({
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.1, "maxOutputTokens": 1024}
                });

                let res = client.post(&url)
                    .json(&body)
                    .send()
                    .map_err(|e| format!("Gemini request failed: {}", e))?;

                let json: serde_json::Value = res.json()
                    .map_err(|e| format!("Gemini parse error: {}", e))?;

                json["candidates"][0]["content"]["parts"][0]["text"].as_str()
                    .map(|s| s.to_string())
                    .ok_or("Empty Gemini response".to_string())
            }
        }
    }

    /// Get memory file size in bytes
    pub fn file_size() -> u64 {
        let path = Self::memory_path();
        fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
    }

    /// Check if compaction is recommended (>50KB or >30 entries in any section)
    pub fn needs_compaction() -> Option<String> {
        let mem = Self::load();
        let size = Self::file_size();

        if size > 50_000 {
            return Some(format!("Memory file is {}KB — compaction recommended", size / 1024));
        }
        if mem.conventions.len() > 30 {
            return Some(format!("{} conventions — compaction recommended", mem.conventions.len()));
        }
        if mem.gotchas.len() > 30 {
            return Some(format!("{} gotchas — compaction recommended", mem.gotchas.len()));
        }
        if mem.context.len() > 30 {
            return Some(format!("{} context entries — compaction recommended", mem.context.len()));
        }
        None
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
