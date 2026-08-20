//! Carryover assembler — gathers Aura's on-disk semantic state into an
//! [`AuraCarryover`]. Every reader here is an existing public API; this
//! module only stitches them together (no new persistence, no LLM).
//!
//! Sources:
//!   - intent log     → `intent_query::read_all_rows` (.aura/intent_log.jsonl)
//!   - session digest → `SessionManager::get_active_session` + transcript
//!   - touched nodes  → `CheckpointStore::get_all_checkpoints` (git notes)
//!   - working tree   → `git2` status + diff stats
//!   - memory         → `MemoryManager::compact_summary`
//!
//! All readers are cwd-relative (worktree-aware via `worktree_aura_path`),
//! so callers `set_current_dir` to the repo before assembling.

use std::collections::HashSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{DiffOptions, Repository, Status, StatusOptions};

use super::model::*;
use super::AssembleOpts;
use crate::checkpoint::CheckpointStore;
use crate::intent_query::read_all_rows;
use crate::memory::MemoryManager;
use crate::session::SessionManager;

/// Build the carryover from the current working directory's `.aura` state.
pub fn assemble(opts: &AssembleOpts) -> AuraCarryover {
    let repo = Repository::discover(".").ok();
    let repo_path = repo
        .as_ref()
        .and_then(|r| r.workdir())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());
    let branch = repo.as_ref().and_then(current_branch);

    let session = session_digest();
    let intents = recent_intents(opts.since_hours, opts.intent_limit);
    let touched_nodes = repo
        .as_ref()
        .map(|r| touched_nodes(r, opts.checkpoint_limit, opts.node_cap))
        .unwrap_or_default();
    let working_tree = repo.as_ref().map(working_tree_diff).unwrap_or_default();
    let memory = MemoryManager::compact_summary();
    let recent_turns = session
        .as_ref()
        .map(|s| recent_turns(&s.session_id, opts.mode))
        .unwrap_or_default();

    AuraCarryover {
        version: 1,
        mode: opts.mode.as_str().to_string(),
        generated_at: now(),
        repo: repo_path,
        branch,
        target_agent: opts.target_agent.clone(),
        session,
        intents,
        touched_nodes,
        working_tree,
        memory,
        recent_turns,
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn current_branch(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        head.shorthand().map(|s| s.to_string())
    } else {
        None
    }
}

/// Snapshot the active agent session into a digest.
fn session_digest() -> Option<SessionDigest> {
    let s = SessionManager::get_active_session()?;
    Some(SessionDigest {
        session_id: s.session_id,
        agent_id: s.agent_id,
        model: s.model_name,
        branch: s.branch,
        base_commit: s.base_commit,
        started_at: s.started_at,
        last_activity: s.last_activity,
        files_touched: s.files_touched,
        first_prompt: s.first_prompt,
        summary: s.summary.map(|sm| SessionSummaryBrief {
            intent: sm.intent,
            outcome: sm.outcome,
            open_items: sm.open_items,
            learnings: sm.learnings,
        }),
    })
}

/// Newest-first intents within the lookback window, capped at `limit`.
fn recent_intents(since_hours: i64, limit: usize) -> Vec<IntentBrief> {
    let path = Path::new(".aura").join("intent_log.jsonl");
    let mut rows = read_all_rows(&path);
    rows.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    let cutoff = if since_hours > 0 {
        now().saturating_sub((since_hours as u64) * 3600)
    } else {
        0
    };
    rows.into_iter()
        .filter(|r| since_hours <= 0 || r.timestamp >= cutoff)
        .take(limit)
        .map(|r| IntentBrief {
            timestamp: r.timestamp,
            agent_id: r.agent_id,
            intent: r.intent,
            intent_type: r.intent_type,
            signed_block_id: r.signed_block_id,
        })
        .collect()
}

/// Function/class nodes touched by the most recent checkpoints, deduped
/// by `node_id` (keeping the newest, since checkpoints are timestamp-desc)
/// and tagged with the intent that changed them.
///
/// Only *definition* nodes survive (functions, methods, classes, …) — a
/// checkpoint re-parses the whole file, so its `ast_nodes` also carry every
/// `let`/`const` binding. Those local declarators are pure noise in a
/// "functions in play" digest, so they're filtered out. The per-node intent
/// is truncated because a checkpoint's intent repeats across all its nodes.
fn touched_nodes(repo: &Repository, checkpoint_limit: usize, node_cap: usize) -> Vec<NodeState> {
    let checkpoints = CheckpointStore::latest_checkpoints(repo, checkpoint_limit).unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<NodeState> = Vec::new();

    for cp in checkpoints.iter().take(checkpoint_limit) {
        for node in &cp.ast_nodes {
            if out.len() >= node_cap {
                return out;
            }
            if !is_definition_kind(&node.kind) {
                continue;
            }
            if !seen.insert(node.node_id.clone()) {
                continue;
            }
            out.push(NodeState {
                node_id: node.node_id.clone(),
                identifier: node.identifier.clone(),
                kind: node.kind.clone(),
                file_path: node.file_path.clone(),
                start_line: node.start_line,
                end_line: node.end_line,
                signature: node.signature.clone(),
                is_stub: node.is_stub,
                intent: truncate(&cp.intent, 200),
                at: cp.written_at_ms(),
            });
        }
    }
    out
}

/// True for AST node kinds that name a callable/type *definition* worth
/// surfacing in a carryover. Excludes `variable_declarator`,
/// `lexical_declaration`, bare identifiers, and other non-definition nodes
/// a full-file re-parse emits.
fn is_definition_kind(kind: &str) -> bool {
    const NEEDLES: [&str; 11] = [
        "function",
        "method",
        "class",
        "struct",
        "enum",
        "trait",
        "impl",
        "interface",
        "module",
        "constructor",
        "namespace",
    ];
    let k = kind.to_ascii_lowercase();
    NEEDLES.iter().any(|n| k.contains(n))
}

/// Uncommitted changes vs HEAD: per-file status + total line stats.
fn working_tree_diff(repo: &Repository) -> WorkingTreeDiff {
    let mut out = WorkingTreeDiff::default();

    let mut so = StatusOptions::new();
    so.include_untracked(true).recurse_untracked_dirs(true);
    if let Ok(statuses) = repo.statuses(Some(&mut so)) {
        for entry in statuses.iter() {
            if let Some(p) = entry.path() {
                out.files.push(FileDiffStat {
                    path: p.to_string(),
                    status: status_code(entry.status()).to_string(),
                });
            }
        }
    }

    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok());
    let mut dopts = DiffOptions::new();
    dopts.include_untracked(true).recurse_untracked_dirs(true);
    if let Ok(diff) = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut dopts)) {
        if let Ok(stats) = diff.stats() {
            out.files_changed = stats.files_changed();
            out.insertions = stats.insertions();
            out.deletions = stats.deletions();
        }
    }
    out
}

/// Collapse a git2 `Status` bitset into a single-letter code.
fn status_code(s: Status) -> &'static str {
    if s.intersects(Status::WT_NEW | Status::INDEX_NEW) {
        "A"
    } else if s.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
        "D"
    } else if s.intersects(Status::WT_RENAMED | Status::INDEX_RENAMED) {
        "R"
    } else if s.intersects(
        Status::WT_MODIFIED
            | Status::INDEX_MODIFIED
            | Status::WT_TYPECHANGE
            | Status::INDEX_TYPECHANGE,
    ) {
        "M"
    } else {
        "?"
    }
}

/// Tail of the session transcript, mode-capped and per-turn truncated.
fn recent_turns(session_id: &str, mode: CarryoverMode) -> Vec<TurnBrief> {
    let cap = mode.turn_cap();
    let trunc = mode.text_trunc();
    let mut entries = SessionManager::get_transcript(session_id);
    let drop = entries.len().saturating_sub(cap);
    if drop > 0 {
        entries.drain(..drop);
    }
    entries
        .into_iter()
        .map(|e| TurnBrief {
            role: e.role,
            text: truncate(&e.content, trunc),
            at: e.timestamp,
        })
        .collect()
}

/// Char-bounded truncation with an ellipsis marker.
pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max).collect();
    t.push('…');
    t
}
