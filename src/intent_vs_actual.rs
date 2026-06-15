// Intent vs Actual — pair a commit with the intent_log rows recorded
// around it, walk the commit's diff for modified/added/deleted AST nodes,
// and run the same word-boundary alignment matcher the pre-commit hook
// uses. Output JSON powers the IntentInspector pane in aura-shell.
//
// "Aligned" means: every modified node identifier appears verbatim in
// the stated intent text. "Diverged" means: 0 of N modified node
// identifiers appear in the intent — typical signature of intent
// poisoning (a one-line "fix typo" message accompanying a 30-function
// refactor).
//
// All git access is read-only — this command can be run against any
// commit in the history without disturbing the working tree.

use crate::intent_query::{read_all_rows, IntentRow};
use crate::models::AstNode;
use crate::parser::SemanticParser;
use git2::{DiffOptions, Repository};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

#[derive(Debug, Serialize)]
pub struct IntentVsActualReport {
    pub commit_sha: String,
    pub commit_short: String,
    pub commit_message: String,
    pub commit_time: i64,
    pub author: String,
    pub stated: Vec<StatedIntent>,
    pub modified_nodes: Vec<String>,
    pub added_nodes: Vec<String>,
    pub deleted_nodes: Vec<String>,
    pub aligned_nodes: Vec<String>,
    pub mismatched_nodes: Vec<String>,
    pub alignment_score: f64,
    pub banner: &'static str,
    pub changed_files: Vec<String>,
    /// Structured per-node view emitted ALONGSIDE the flat string arrays
    /// above (which the frontend still depends on). A single flat list is
    /// cleaner than five parallel arrays: each entry carries its `change`
    /// kind ("added"/"modified"/"deleted") and `covered` flag so the shell
    /// can group/sort without re-joining the string arrays. Always emitted
    /// when non-empty (additive optional field — see module docs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nodes: Option<Vec<NodeRef>>,
    /// Per-symbol rationale/summary join, keyed by identifier. Populated
    /// from `.aura/commit_rationales.jsonl` for this commit SHA when the
    /// store has matching rows (see Task 2). Value is (rationale, summary).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_rationales: Option<HashMap<String, SymbolRationale>>,
}

/// Structured reference to a single changed AST node. Carries the full
/// `AstNode` metadata the diff loop already had in hand (file, lines,
/// signature, stub/secret flags) instead of collapsing it to a bare
/// identifier string. Serialized as part of `IntentVsActualReport.nodes`.
#[derive(Debug, Serialize)]
pub struct NodeRef {
    pub identifier: String,
    pub kind: String,
    pub change: String, // "added" | "modified" | "deleted"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default)]
    pub is_stub: bool,
    #[serde(default)]
    pub contains_secret: bool,
    #[serde(default)]
    pub covered: bool, // identifier appears in a stated intent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>, // filled by Task 2
    /// True when the symbol is defined at module top level / as a class member
    /// (vs nested inside a function body). The change-note card lists only
    /// top-level symbols so body-locals (loop counters, temporaries) don't
    /// crowd the per-file note. Mirrors `AstNode::top_level`.
    #[serde(default = "default_top_level")]
    pub top_level: bool,
}

/// serde default for `NodeRef::top_level` — absent scope means "visible".
fn default_top_level() -> bool {
    true
}

/// A rationale/summary pair joined onto the report for a single symbol.
#[derive(Debug, Serialize, Clone)]
pub struct SymbolRationale {
    pub rationale: String,
    pub summary: String,
}

#[derive(Debug, Serialize)]
pub struct StatedIntent {
    pub timestamp: u64,
    pub agent_id: String,
    pub intent: String,
    pub intent_type: Option<String>,
}

/// Compute the report for a single commit.
///
/// `sha_or_ref` accepts anything `revparse_single` understands — a full
/// SHA, a short SHA, `HEAD`, `HEAD~1`, branch names, etc. The intent log
/// is sampled in a ±3600s window around `committer_time` since intents
/// are typically logged seconds before the commit lands.
pub fn run(sha_or_ref: &str) -> Result<IntentVsActualReport, Box<dyn std::error::Error>> {
    let repo = Repository::open(".")?;
    let obj = repo.revparse_single(sha_or_ref)?;
    let commit = obj
        .as_commit()
        .cloned()
        .or_else(|| obj.peel_to_commit().ok())
        .ok_or("Target is not a commit")?;

    let commit_sha = commit.id().to_string();
    let commit_short = commit_sha.chars().take(8).collect::<String>();
    let commit_message = commit.message().unwrap_or("").trim().to_string();
    let commit_time = commit.time().seconds();
    let author = commit
        .author()
        .name()
        .unwrap_or("unknown")
        .to_string();

    // Diff against first parent (or empty tree for root commit).
    let new_tree = commit.tree()?;
    let parent_tree = commit
        .parent(0)
        .ok()
        .and_then(|p| p.tree().ok());

    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;

    // Collect changed paths from the delta stream so we can read both
    // sides of each blob from the trees (not from disk — the working
    // tree might be on a totally different commit).
    let mut changed_files: Vec<PathBuf> = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            if let Some(p) = delta.new_file().path() {
                changed_files.push(p.to_path_buf());
            } else if let Some(p) = delta.old_file().path() {
                changed_files.push(p.to_path_buf());
            }
            true
        },
        None,
        None,
        None,
    )?;

    let mut parser = SemanticParser::new()?;
    let mut added: BTreeSet<String> = BTreeSet::new();
    let mut modified: BTreeSet<String> = BTreeSet::new();
    let mut deleted: BTreeSet<String> = BTreeSet::new();
    let mut changed_file_strs: Vec<String> = Vec::new();
    // Structured node accumulator. Keyed by (identifier, change) so an
    // identifier that appears in two change buckets (rare — e.g. a node
    // moved across files) is kept once per change kind, mirroring the
    // BTreeSet de-dup the string arrays get. The stored AstNode + file is
    // the side the change came from (new side for added/modified, old side
    // for deleted) so file/line/signature reflect the live definition.
    let mut node_refs: HashMap<(String, String), (AstNode, String)> = HashMap::new();

    for path in &changed_files {
        let path_str = path.to_string_lossy().to_string();
        let ext = match path.extension().and_then(|s| s.to_str()) {
            Some("rs") => "rs",
            Some("py") => "py",
            Some("ts") | Some("tsx") => "ts",
            Some("js") | Some("jsx") => "js",
            _ => continue,
        };
        changed_file_strs.push(path_str.clone());

        let new_nodes = read_blob_at(&repo, &new_tree, path)
            .and_then(|src| parser.parse_file(&src, ext).ok())
            .unwrap_or_default();
        let old_nodes = match parent_tree.as_ref() {
            Some(t) => read_blob_at(&repo, t, path)
                .and_then(|src| parser.parse_file(&src, ext).ok())
                .unwrap_or_default(),
            None => Vec::new(),
        };

        for (ident, action) in SemanticParser::diff_nodes(&old_nodes, &new_nodes) {
            // Skip identifier-less nodes — same exclusion list the
            // pre-commit hook uses for the alignment check, so the
            // inspector's score matches what the gate enforces.
            if ident.is_empty()
                || ident == "anonymous"
                || ident.starts_with("__")
            {
                continue;
            }
            match action.as_str() {
                "added" => {
                    added.insert(ident.clone());
                    if let Some(n) = find_node(&new_nodes, &ident) {
                        node_refs
                            .entry((ident, "added".to_string()))
                            .or_insert_with(|| (n.clone(), path_str.clone()));
                    }
                }
                "modified" => {
                    modified.insert(ident.clone());
                    if let Some(n) = find_node(&new_nodes, &ident) {
                        node_refs
                            .entry((ident, "modified".to_string()))
                            .or_insert_with(|| (n.clone(), path_str.clone()));
                    }
                }
                "deleted" => {
                    deleted.insert(ident.clone());
                    if let Some(n) = find_node(&old_nodes, &ident) {
                        node_refs
                            .entry((ident, "deleted".to_string()))
                            .or_insert_with(|| (n.clone(), path_str.clone()));
                    }
                }
                _ => {}
            }
        }
    }

    // Pull intents recorded near commit time. The window is intentionally
    // generous (±1h) — agents sometimes log intent slightly out of order
    // when commits batch.
    let log_path = std::path::Path::new(".aura/intent_log.jsonl");
    let all_rows = read_all_rows(log_path);
    let window_lo = commit_time.saturating_sub(3600).max(0) as u64;
    let window_hi = (commit_time + 3600) as u64;
    let mut stated_rows: Vec<IntentRow> = all_rows
        .into_iter()
        .filter(|r| r.timestamp >= window_lo && r.timestamp <= window_hi)
        .collect();
    stated_rows.sort_by_key(|r| r.timestamp);

    let stated: Vec<StatedIntent> = stated_rows
        .iter()
        .map(|r| StatedIntent {
            timestamp: r.timestamp,
            agent_id: r.agent_id.clone(),
            intent: r.intent.clone(),
            intent_type: r.intent_type.clone(),
        })
        .collect();

    // Concatenate every stated intent + the commit message so the
    // matcher gives the user credit for whatever they wrote, wherever
    // they wrote it (intent log OR commit message). The pre-commit hook
    // uses the same union.
    let haystack_lower = format!(
        "{} {}",
        commit_message.to_lowercase(),
        stated_rows
            .iter()
            .map(|r| r.intent.to_lowercase())
            .collect::<Vec<_>>()
            .join(" ")
    );

    // Word-boundary regex match per identifier. Same algorithm as the
    // pre-commit hook so what the inspector reports lines up with what
    // the gate enforces. Use a set so an identifier present in two of
    // {modified, added, deleted} (e.g. renamed across files) is only
    // scored once.
    let mut aligned: Vec<String> = Vec::new();
    let mut mismatched: Vec<String> = Vec::new();
    // Identifiers whose name appears verbatim in the stated intent. Reused
    // below to set NodeRef.covered with the exact same alignment logic, so
    // the structured view and the flat aligned/mismatched arrays never drift.
    let mut covered_idents: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut candidate_set: BTreeSet<String> = BTreeSet::new();
    for s in modified.iter().chain(added.iter()).chain(deleted.iter()) {
        candidate_set.insert(s.clone());
    }
    for ident in &candidate_set {
        let pattern = format!(r"\b{}\b", regex::escape(&ident.to_lowercase()));
        let hit = match regex::Regex::new(&pattern) {
            Ok(re) => re.is_match(&haystack_lower),
            Err(_) => false,
        };
        if hit {
            aligned.push(ident.clone());
            covered_idents.insert(ident.clone());
        } else {
            mismatched.push(ident.clone());
        }
    }

    let total_candidates = aligned.len() + mismatched.len();
    let alignment_score = if total_candidates == 0 {
        // No identifier-bearing changes → vacuously aligned.
        1.0
    } else {
        aligned.len() as f64 / total_candidates as f64
    };

    let banner = if stated_rows.is_empty() && commit_message.trim().is_empty() {
        "diverged"
    } else if alignment_score >= 0.6 {
        "aligned"
    } else if alignment_score >= 0.3 {
        "drift"
    } else {
        "diverged"
    };

    // ── Task 2: per-symbol rationale join ──
    // Pull AI-generated rationales/summaries that were persisted for this
    // exact commit SHA (keyed store written by live_events::persist_rationales
    // + backfilled post-commit). Empty map when nothing was recorded — the
    // optional fields then serialize away entirely.
    let rationale_map = load_rationales_for_sha(&commit_sha);

    // ── Task 1: structured flat node list ──
    // Map each diffed (identifier, change) back to its full AstNode and emit
    // a NodeRef. `covered` reuses the alignment set; `rationale` is joined
    // from the Task-2 store by identifier.
    let mut nodes_vec: Vec<NodeRef> = node_refs
        .into_iter()
        .map(|((ident, change), (node, file))| {
            let rationale = rationale_map.get(&ident).map(|(r, _s)| r.clone());
            NodeRef {
                identifier: ident.clone(),
                kind: node.kind.clone(),
                change,
                file: node.file_path.clone().or(Some(file)),
                start_line: node.start_line,
                end_line: node.end_line,
                signature: node.signature.clone(),
                is_stub: node.is_stub,
                contains_secret: node.contains_secret,
                covered: covered_idents.contains(&ident),
                rationale,
                top_level: node.top_level,
            }
        })
        .collect();
    // Stable ordering for the frontend: by change kind, then identifier.
    nodes_vec.sort_by(|a, b| {
        a.change
            .cmp(&b.change)
            .then_with(|| a.identifier.cmp(&b.identifier))
    });
    let nodes = if nodes_vec.is_empty() {
        None
    } else {
        Some(nodes_vec)
    };

    // Expose the rationale store as a symbol→(rationale, summary) map too,
    // so the shell can look up a symbol independent of the diffed node set.
    let symbol_rationales = if rationale_map.is_empty() {
        None
    } else {
        Some(
            rationale_map
                .into_iter()
                .map(|(k, (rationale, summary))| (k, SymbolRationale { rationale, summary }))
                .collect::<HashMap<String, SymbolRationale>>(),
        )
    };

    Ok(IntentVsActualReport {
        commit_sha,
        commit_short,
        commit_message,
        commit_time,
        author,
        stated,
        modified_nodes: modified.into_iter().collect(),
        added_nodes: added.into_iter().collect(),
        deleted_nodes: deleted.into_iter().collect(),
        aligned_nodes: aligned,
        mismatched_nodes: mismatched,
        alignment_score,
        banner,
        changed_files: changed_file_strs,
        nodes,
        symbol_rationales,
    })
}

/// Find the AST node with the given identifier in a parsed node list.
/// Returns the first match — diff_nodes already de-dups by (identifier,
/// kind) so at most one un-renamed node per identifier reaches here.
fn find_node<'a>(nodes: &'a [AstNode], ident: &str) -> Option<&'a AstNode> {
    nodes
        .iter()
        .find(|n| n.identifier.as_deref() == Some(ident))
}

/// Load per-symbol rationales recorded for a specific commit SHA from
/// `.aura/commit_rationales.jsonl`. Returns identifier → (rationale,
/// summary). Missing/empty/corrupt store → empty map (never errors — this
/// is a best-effort enrichment join). When a symbol has multiple rows for
/// the same SHA the latest (last-written) wins.
pub fn load_rationales_for_sha(sha: &str) -> HashMap<String, (String, String)> {
    let path = std::path::Path::new(".aura/commit_rationales.jsonl");
    let mut out: HashMap<String, (String, String)> = HashMap::new();
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return out,
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let row: crate::live_events::CommitRationale = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if row.commit_sha != sha {
            continue;
        }
        out.insert(
            row.function_name,
            (
                row.rationale.unwrap_or_default(),
                row.summary.unwrap_or_default(),
            ),
        );
    }
    out
}

fn read_blob_at(repo: &Repository, tree: &git2::Tree, path: &std::path::Path) -> Option<String> {
    let entry = tree.get_path(path).ok()?;
    let obj = entry.to_object(repo).ok()?;
    let blob = obj.as_blob()?;
    let text = std::str::from_utf8(blob.content()).ok()?;
    Some(text.to_string())
}

/// Lightweight summary used for the IntentInspector commit list. Returns
/// the most-recent N commits with: sha, short, message, time, author,
/// banner (computed via a fast path that looks only at the intent-log
/// time window — no AST parse). The full alignment_score requires the
/// expensive AST diff and is computed on demand by `run`.
#[derive(Debug, Serialize)]
pub struct CommitListEntry {
    pub commit_sha: String,
    pub commit_short: String,
    pub commit_message: String,
    pub commit_time: i64,
    pub author: String,
    pub stated_count: usize,
}

pub fn list_commits(limit: usize) -> Result<Vec<CommitListEntry>, Box<dyn std::error::Error>> {
    let repo = Repository::open(".")?;
    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(git2::Sort::TIME)?;

    let log_path = std::path::Path::new(".aura/intent_log.jsonl");
    let all_rows = read_all_rows(log_path);

    // Bin intents by timestamp for cheap window queries.
    let mut intents_by_ts: HashMap<u64, usize> = HashMap::new();
    for r in &all_rows {
        *intents_by_ts.entry(r.timestamp).or_insert(0) += 1;
    }

    let mut out: Vec<CommitListEntry> = Vec::new();
    for oid in walk.take(limit) {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let commit_time = commit.time().seconds();
        let lo = commit_time.saturating_sub(3600).max(0) as u64;
        let hi = (commit_time + 3600) as u64;
        let stated_count = all_rows
            .iter()
            .filter(|r| r.timestamp >= lo && r.timestamp <= hi)
            .count();
        // (intents_by_ts is not strictly needed but kept here so the
        // shape matches future per-bucket caching. Touching it avoids a
        // dead_code lint without an attribute.)
        let _ = intents_by_ts.len();
        out.push(CommitListEntry {
            commit_sha: oid.to_string(),
            commit_short: oid.to_string().chars().take(8).collect(),
            commit_message: commit.message().unwrap_or("").lines().next().unwrap_or("").to_string(),
            commit_time,
            author: commit.author().name().unwrap_or("unknown").to_string(),
            stated_count,
        });
    }
    Ok(out)
}
