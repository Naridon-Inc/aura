use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::session::worktree_aura_path;

// Declared here (not in main.rs) so the retrieval engine lives next to the
// store it ranks and the module list in main.rs stays untouched — same
// pattern as `pr.rs` / `pr_humanize.rs`.
pub mod retrieval;

// W2 — provenance stamping + read-time verification (see module docs for
// the `<path>#<identifier>` symbol reference format).
pub mod provenance;

// W3 — reconcile-on-write: dedup / ADD-UPDATE-DELETE-NOOP / supersession
// (see module docs for the full pipeline).
pub mod reconcile;

// W4 — Ebbinghaus×SM-2 retention decay + the scheduled consolidation pass
// (shared by `aura memory consolidate` and the aura-daemon 30-minute loop).
pub mod decay;

// CLI surface: `aura memory add | search | why`.
pub mod cli;

// Import another agent's per-fact memory (Claude Code's memory dir) into
// .aura/memory.json through the W3 reconcile pipeline. See module docs.
pub mod import;

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
    /// W4 — RFC3339 of the last consolidation pass that actually compacted
    /// something (scheduled daemon loop or `aura memory consolidate`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consolidated_at: Option<String>,
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
    /// W1 — semantic-leg vector, lazily computed at search time when an
    /// embedding provider is configured. `skip_serializing_if` keeps
    /// memory.json compact until a vector actually exists; `default` keeps
    /// pre-W1 files loading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,

    // ── W2 provenance (see memory_provenance.rs) — all serde-default so
    // pre-W2 memory.json files keep loading. Absent data stays None. ──
    /// HEAD short sha at write time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    /// Code anchor in `<repo-relative-path>#<identifier>` form,
    /// e.g. `src/auth.rs#verify_token`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_symbol: Option<String>,
    /// sha256 (hex) of the symbol's source text at write time — the
    /// fingerprint read-time verification compares against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_symbol_hash: Option<String>,
    /// Latest `.aura/intent_log.jsonl` row at write time: its
    /// `signed_block_id` when signed, else `ts:<unix-secs>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<String>,
    /// `key_id` that signed that intent row, when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer_key_id: Option<String>,
    /// RFC3339 — when this fact became valid (the write time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    /// RFC3339 — when this fact stopped being current. Set by W3 reconcile
    /// when a write supersedes (UPDATE) or invalidates (DELETE) this entry;
    /// the row stays on disk as an audit trail and drops out of default
    /// recall.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,

    // ── W3 reconcile (see memory_reconcile.rs) ──
    /// Id of the entry this one superseded (reconcile UPDATE). Forms the
    /// supersession chain `aura memory why` renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,

    // ── W4 decay (see memory_decay.rs) — serde-default so pre-W4
    // memory.json files keep loading. ──
    /// `n` — how many times this entry came back in ranked search results
    /// (reinforcement count; each hit multiplies stability by the SM-2
    /// ease factor).
    #[serde(default)]
    pub access_count: u32,
    /// `w` — importance weight in [0, 1]; feeds stability as `(1 + w)`.
    /// Defaults to 0.3 (= `decay::W_MIN`); the decay math also clamps
    /// lower stored values UP to W_MIN, so a zeroed legacy field can't
    /// nuke an entry's retention.
    #[serde(default = "default_importance")]
    pub importance: f32,
    /// RFC3339 of the last time a ranked search returned this entry; the
    /// decay clock measures from here (fallback: `added_at`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_accessed: Option<String>,
}

/// serde default for `MemoryEntry::importance` — mirrors `decay::W_MIN`.
fn default_importance() -> f32 {
    0.3
}

impl Default for MemoryEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            content: String::new(),
            tags: Vec::new(),
            added_by: String::new(),
            added_at: 0,
            embedding: None,
            source_commit: None,
            source_symbol: None,
            source_symbol_hash: None,
            intent_id: None,
            signer_key_id: None,
            valid_from: None,
            valid_to: None,
            supersedes: None,
            access_count: 0,
            importance: default_importance(),
            last_accessed: None,
        }
    }
}

impl MemoryEntry {
    /// Live = the fact's bi-temporal window is still open. Superseded /
    /// invalidated rows stay on disk but are excluded from default recall,
    /// dedup and consolidation.
    pub fn is_live(&self) -> bool {
        self.valid_to.is_none()
    }
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
            consolidated_at: None,
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

    /// Keep only the most recent N entries. Superseded audit rows (W3) are
    /// sacrificed before live knowledge: live entries sort first (newest
    /// first within each group), so the cap evicts closed history before
    /// it ever evicts a current fact.
    fn cap_entries(entries: &mut Vec<MemoryEntry>, max: usize) {
        if entries.len() > max {
            entries.sort_by(|a, b| {
                a.valid_to
                    .is_some()
                    .cmp(&b.valid_to.is_some())
                    .then_with(|| b.added_at.cmp(&a.added_at))
            });
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

    /// Add a memory entry to a section (no symbol anchor).
    pub fn add_entry(section: &str, content: &str, tags: Vec<String>, author: &str) -> String {
        Self::add_entry_with_symbol(section, content, tags, author, None)
    }

    /// W2/W3 — add a provenance-stamped memory entry through the reconcile
    /// pipeline. Kept String-returning for legacy callers (MCP
    /// `aura_memory_write`, sync): the id of whichever entry now carries
    /// the fact — new on ADD/UPDATE, the pre-existing duplicate on NOOP,
    /// the closed entry on DELETE.
    pub fn add_entry_with_symbol(
        section: &str,
        content: &str,
        tags: Vec<String>,
        author: &str,
        symbol: Option<&str>,
    ) -> String {
        Self::add_entry_reconciled(section, content, tags, author, symbol).id
    }

    /// W3 — the full reconcile-on-write path (see `memory_reconcile.rs`):
    /// normalized-hash dedup → W1-ranked candidates → LLM ADD/UPDATE/
    /// DELETE/NOOP decision (graceful keyless fallback to ADD) →
    /// supersede-never-delete application. Returns the full outcome so the
    /// CLI can tell the user what actually happened.
    pub fn add_entry_reconciled(
        section: &str,
        content: &str,
        tags: Vec<String>,
        author: &str,
        symbol: Option<&str>,
    ) -> reconcile::ReconcileOutcome {
        let mut mem = Self::load();
        let truncated = Self::truncate(content);
        let outcome = reconcile::reconcile_write(
            &mut mem,
            section,
            &truncated,
            tags,
            author,
            symbol,
            Self::now(),
            &|prompt| Self::call_ai(prompt),
            &|text| crate::embeddings::embed(text).map(|(v, _)| v),
        );
        if outcome.changed {
            mem.last_updated = Self::now();
            let _ = Self::save(&mut mem);
        }
        outcome
    }

    /// Find one entry by id across the four entry sections. Returns the
    /// section name alongside a clone of the entry.
    pub fn find_entry(id: &str) -> Option<(&'static str, MemoryEntry)> {
        let mem = Self::load();
        let sections: [(&'static str, &Vec<MemoryEntry>); 4] = [
            ("conventions", &mem.conventions),
            ("gotchas", &mem.gotchas),
            ("context", &mem.context),
            ("active_work", &mem.active_work),
        ];
        for (name, entries) in sections {
            if let Some(e) = entries.iter().find(|e| e.id == id) {
                return Some((name, e.clone()));
            }
        }
        None
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

        // Only surface up to 5 gotchas in status to avoid bloat
        if gotcha_count > 5 {
            summary["gotchas"] = serde_json::json!(
                mem.gotchas.iter().take(5).map(|g| &g.content).collect::<Vec<_>>()
            );
            summary["gotchas_truncated"] = serde_json::json!(format!(
                "+{} more — call aura_memory_read for all", gotcha_count - 5
            ));
        }

        summary["hint"] = serde_json::json!(
            "Call `aura_memory_read` for full project memory (architecture, decisions, conventions)."
        );

        if let Some(compaction_msg) = Self::needs_compaction() {
            summary["compaction"] = serde_json::json!(compaction_msg);
        }

        summary["size_kb"] = serde_json::json!(Self::file_size() / 1024);

        Some(summary)
    }

    /// One entry as JSON for `full_view` — includes the W2 provenance
    /// fields when present (no live staleness check here: the full view
    /// lists every entry and verification parses source files; the ranked
    /// search + `aura memory why` paths carry the live `stale` flag).
    fn entry_view(e: &MemoryEntry) -> serde_json::Value {
        let mut v = serde_json::json!({
            "id": e.id,
            "content": e.content,
            "tags": e.tags,
        });
        if let Some(c) = &e.source_commit {
            v["source_commit"] = serde_json::json!(c);
        }
        if let Some(s) = &e.source_symbol {
            v["source_symbol"] = serde_json::json!(s);
        }
        if let Some(f) = &e.valid_from {
            v["valid_from"] = serde_json::json!(f);
        }
        // W3 — closed rows (only rendered in include_superseded views)
        // carry their window end + back-pointer.
        if let Some(t) = &e.valid_to {
            v["superseded"] = serde_json::json!(true);
            v["valid_to"] = serde_json::json!(t);
        }
        if let Some(s) = &e.supersedes {
            v["supersedes"] = serde_json::json!(s);
        }
        v
    }

    /// Get full memory as structured JSON. Default view: superseded rows
    /// (W3, `valid_to` set) are excluded — they're audit trail, not current
    /// knowledge. Decay (W4) never filters here: low-retention entries stay
    /// listed in the full section view.
    pub fn full_view() -> serde_json::Value {
        Self::full_view_with(false)
    }

    /// `full_view` with the superseded audit rows included
    /// (`include_superseded = true`); each closed row carries
    /// `"superseded": true` + its `valid_to`.
    pub fn full_view_with(include_superseded: bool) -> serde_json::Value {
        let mem = Self::load();
        let entries = |list: &Vec<MemoryEntry>| -> Vec<serde_json::Value> {
            list.iter()
                .filter(|e| include_superseded || e.is_live())
                .map(Self::entry_view)
                .collect()
        };

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
            "conventions": entries(&mem.conventions),
            "gotchas": entries(&mem.gotchas),
            "context": entries(&mem.context),
            "active_work": entries(&mem.active_work),
            "last_updated": mem.last_updated,
        })
    }

    /// Search memories across all sections — W1 hybrid ranked retrieval.
    ///
    /// Entry sections (conventions/gotchas/context/active_work) are ranked
    /// by BM25 + embedding-cosine + recency fused with Reciprocal Rank
    /// Fusion (see `memory_retrieval.rs`), best first; each result carries
    /// `score` and the `legs` that matched it. Identity, architecture and
    /// timeline keep the legacy substring match (they're structurally
    /// different records with no tags/embeddings) and are appended after
    /// the ranked block.
    pub fn search(query: &str) -> Vec<serde_json::Value> {
        Self::search_with_embedder(query, &|text: &str| crate::embeddings::embed(text).map(|(v, _)| v))
    }

    /// W3 — `search` including superseded entries (the `--all` /
    /// `include_superseded` surface). Closed rows come back flagged
    /// `"superseded": true` with their `valid_to`.
    pub fn search_all(query: &str) -> Vec<serde_json::Value> {
        Self::search_opts(query, true, &|text: &str| crate::embeddings::embed(text).map(|(v, _)| v))
    }

    /// Same as `search` but with an injectable embedder so tests (and any
    /// offline caller) control the semantic leg. `embed` returning `None`
    /// for the query skips the leg entirely — graceful degradation.
    pub fn search_with_embedder(
        query: &str,
        embed: &dyn Fn(&str) -> Option<Vec<f32>>,
    ) -> Vec<serde_json::Value> {
        Self::search_opts(query, false, embed)
    }

    /// The full search path. `include_all = false` (the default surfaces)
    /// recalls only live entries whose W4 retention is still above
    /// `decay::R_MIN`; `true` recalls everything — superseded rows (marked)
    /// and decayed-out entries alike.
    pub fn search_opts(
        query: &str,
        include_all: bool,
        embed: &dyn Fn(&str) -> Option<Vec<f32>>,
    ) -> Vec<serde_json::Value> {
        let mut mem = Self::load();
        let mut dirty = false;

        // Semantic leg: only attempted when the query itself embeds (i.e.
        // an API key is configured and reachable). On success, lazily
        // embed-and-persist entries that are still missing vectors so the
        // leg warms up over time. Persisted together with the W4
        // reinforcement bump below — ONE write per search.
        let query_embedding = embed(query);
        if query_embedding.is_some() && retrieval::backfill_embeddings(&mut mem, embed) > 0 {
            dirty = true;
        }

        let ranked = if include_all {
            retrieval::ranked_search_all(&mem, query, query_embedding.as_deref())
        } else {
            retrieval::ranked_search(&mem, query, query_embedding.as_deref())
        };

        // W4 — blend retention into the RRF scores: score ×= max(R, R_MIN),
        // entries with R < R_MIN leave default results (never deleted;
        // `--all` keeps them). Reinforcement happens after ranking so the
        // bump never feeds back into this query's own scores.
        let now = Self::now();
        let blended = decay::blend_results(ranked, &mem, now, include_all);

        let mut results: Vec<serde_json::Value> = blended
            .iter()
            .map(|(r, retention)| {
                serde_json::json!({
                    "section": r.section,
                    "id": r.id,
                    "content": r.content,
                    "tags": r.tags,
                    "added_at": r.added_at,
                    "score": r.score,
                    "retention": retention,
                    "legs": r.legs,
                })
            })
            .collect();

        // W2 — read-time verification: results bound to a code symbol are
        // re-checked against the live tree and flagged `stale` when the
        // symbol changed or disappeared since the memory was stamped. The
        // (13-grammar) parser is built lazily, once, and only if some
        // result actually carries a symbol anchor. Scoped so the borrows
        // of `mem` end before the W4 reinforcement bump mutates it.
        {
        let entry_by_id: std::collections::HashMap<&str, &MemoryEntry> = mem
            .conventions
            .iter()
            .chain(&mem.gotchas)
            .chain(&mem.context)
            .chain(&mem.active_work)
            .map(|e| (e.id.as_str(), e))
            .collect();
        let mut parser: Option<crate::parser::SemanticParser> = None;
        for v in results.iter_mut() {
            let Some(id) = v["id"].as_str().map(|s| s.to_string()) else { continue };
            let Some(entry) = entry_by_id.get(id.as_str()) else { continue };
            // W3 — closed rows only surface in include_superseded mode;
            // flag them so the caller can render the audit nature.
            if let Some(to) = &entry.valid_to {
                v["superseded"] = serde_json::json!(true);
                v["valid_to"] = serde_json::json!(to);
            }
            if entry.source_symbol.is_none() {
                continue;
            }
            if let Some(c) = &entry.source_commit {
                v["source_commit"] = serde_json::json!(c);
            }
            if let Some(s) = &entry.source_symbol {
                v["source_symbol"] = serde_json::json!(s);
            }
            if parser.is_none() {
                parser = crate::parser::SemanticParser::new().ok();
            }
            let staleness = match parser.as_mut() {
                Some(p) => provenance::verify_entry_with_parser(entry, p),
                None => None,
            };
            if let Some(s) = staleness {
                v["stale"] = serde_json::json!(s.stale);
                if let Some(reason) = s.reason {
                    v["stale_reason"] = serde_json::json!(reason);
                }
            }
        }
        }

        // W4 — reinforcement: every entry actually returned gets its
        // access_count + last_accessed bumped, raising its stability for
        // future recalls. Batched into the single per-search save below.
        let returned_ids: Vec<String> = blended.iter().map(|(r, _)| r.id.clone()).collect();
        if decay::reinforce(&mut mem, &returned_ids, now) > 0 {
            dirty = true;
        }
        if dirty {
            let _ = Self::save(&mut mem);
        }

        // Legacy substring matches over the non-entry records.
        let q = query.to_lowercase();
        if mem.identity.to_lowercase().contains(&q) {
            results.push(serde_json::json!({"section": "identity", "content": mem.identity}));
        }
        for c in &mem.architecture {
            if c.name.to_lowercase().contains(&q) || c.description.to_lowercase().contains(&q) {
                results.push(serde_json::json!({"section": "architecture", "name": c.name, "description": c.description}));
            }
        }
        for d in &mem.decisions {
            if d.title.to_lowercase().contains(&q) || d.description.to_lowercase().contains(&q) {
                results.push(serde_json::json!({"section": "timeline", "date": d.date, "title": d.title, "description": d.description}));
            }
        }

        results
    }

    /// AI-powered memory compaction for ONE section — the on-demand
    /// surface (MCP `aura_memory_compact`). Since W4 this is a thin shim
    /// over `decay::consolidate_mem`, the same code path the scheduled
    /// daemon loop and `aura memory consolidate` run: live entries only,
    /// superseded audit rows preserved. Returns the number of entries
    /// compacted away (0 = below threshold), or an error when the model
    /// is unavailable / answered garbage — matching the pre-W4 contract.
    pub fn compact_section(section: &str) -> Result<usize, String> {
        let canonical = decay::canonical_section(section)
            .ok_or_else(|| format!("Cannot compact section '{}'", section))?;
        let mut mem = Self::load();
        let now = Self::now();
        let reports =
            decay::consolidate_mem(&mut mem, Some(canonical), &|p| Self::call_ai(p), now);
        let report = reports
            .into_iter()
            .find(|r| r.section == canonical)
            .ok_or_else(|| format!("Cannot compact section '{}'", section))?;
        match report.skipped {
            Some(decay::SkipReason::BelowThreshold(_)) => Ok(0),
            Some(decay::SkipReason::ModelUnavailable(e)) => Err(e),
            Some(decay::SkipReason::BadReply(e)) => Err(e),
            None => {
                mem.consolidated_at = Some(chrono::Utc::now().to_rfc3339());
                mem.last_updated = now;
                let _ = Self::save(&mut mem);
                Ok(report.compacted)
            }
        }
    }

    /// W4 — one consolidation pass over every compactable section (or just
    /// `section`): the single code path shared by `aura memory consolidate`
    /// and the aura-daemon 30-minute loop. Sections below the live-entry
    /// threshold or without a reachable model are skipped (silently — the
    /// next cycle retries); when anything was compacted the store is saved
    /// and `consolidated_at` is stamped. Err only for an unknown section
    /// name.
    pub fn consolidate(
        section: Option<&str>,
    ) -> Result<Vec<decay::SectionConsolidation>, String> {
        let only = match section {
            Some(s) => Some(
                decay::canonical_section(s)
                    .ok_or_else(|| format!("Cannot consolidate section '{}'", s))?,
            ),
            None => None,
        };
        let mut mem = Self::load();
        let now = Self::now();
        let reports = decay::consolidate_mem(&mut mem, only, &|p| Self::call_ai(p), now);
        if reports.iter().any(|r| r.skipped.is_none()) {
            mem.consolidated_at = Some(chrono::Utc::now().to_rfc3339());
            mem.last_updated = now;
            let _ = Self::save(&mut mem);
        }
        Ok(reports)
    }

    /// Call AI provider (Gemini or Anthropic) for text generation
    fn call_ai(prompt: &str) -> Result<String, String> {
        let config = crate::config::ConfigManager::load();
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
}
