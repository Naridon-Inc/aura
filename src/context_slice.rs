//! Graph-first bounded retrieval (AUDIT-CTX-03).
//!
//! An agent asking "show me `retry_logic`" should not read whole files: the
//! canonical semantic graph (checkpoint AST nodes) already knows where every
//! definition lives, who calls it and what it calls. This module answers that
//! question with a *bounded symbol slice* — the definition's own lines plus a
//! small margin, caller/callee edges from the reverse call graph — and caches
//! the answer on disk keyed by (query, caps, graph version).
//!
//! Freshness rules, in order of authority:
//!   1. The graph view is composed per-file from the *newest* checkpoint that
//!      parsed each file (same authority rule as the carryover assembler).
//!   2. A cached answer is only served while every file it touched still
//!      hashes to what it hashed at compute time — an edit, a rewind, or a
//!      restore of an older body all change the content hash and force a
//!      recompute. Stale cache is never served.
//!   3. A definition whose file is gone, or whose identifier no longer
//!      appears in the file, is dropped from the slice entirely.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::callgraph::ReverseGraph;
use crate::checkpoint::CheckpointData;
use crate::continuity::assemble::is_definition_kind;
use crate::models::AstNode;

/// One bounded-retrieval question: which symbol, optional file hint, and the
/// caps that keep the answer small.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceQuery {
    pub symbol: String,
    /// Optional file to disambiguate same-named definitions.
    pub file_hint: Option<String>,
    /// Margin lines around the definition span.
    pub context_lines: usize,
    /// Max distinct definition sites returned.
    pub max_defs: usize,
    /// Max body lines per definition (the tail past this is counted, not shown).
    pub max_lines: usize,
    /// Max caller and callee edges per definition.
    pub max_edges: usize,
}

impl SliceQuery {
    pub fn new(symbol: &str) -> Self {
        Self {
            symbol: symbol.to_string(),
            file_hint: None,
            context_lines: 4,
            max_defs: 5,
            max_lines: 120,
            max_edges: 12,
        }
    }
}

/// One definition site with its bounded body and local graph neighborhood.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefSlice {
    pub node_id: String,
    pub identifier: String,
    pub kind: String,
    pub file_path: String,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub signature: Option<String>,
    /// The definition's own lines (± context), capped at `max_lines`.
    pub body: String,
    pub body_lines: usize,
    /// Lines of the true span that the cap cut off.
    pub elided_lines: usize,
    /// Inbound edges: "identifier (file)" of callers, from the reverse graph.
    pub callers: Vec<String>,
    /// Outbound edges: dependency names recorded on the node.
    pub callees: Vec<String>,
}

/// The full answer: bounded slices plus the measurements that prove the
/// bound (slice size vs the whole-file reads it replaced).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceResult {
    pub symbol: String,
    pub graph_version: String,
    pub defs: Vec<DefSlice>,
    /// Distinct files cited by surviving definitions.
    pub files: Vec<String>,
    /// Every file any candidate definition pointed at, cited or dropped —
    /// the fingerprint set that guards the cache.
    pub touched_files: Vec<String>,
    pub slice_chars: usize,
    /// What reading the cited files whole would have cost.
    pub full_file_chars: usize,
}

/// Compose a coherent "current" node set from checkpoint history: for each
/// file, the newest checkpoint that parsed it is the authority; older
/// checkpoints' nodes for that file are superseded. Nodes without a file
/// path are unciteable and excluded. Returns the nodes plus a version hash
/// that changes whenever the composition changes.
pub fn current_graph_view(
    checkpoints: &[CheckpointData],
    checkpoint_cap: usize,
) -> (Vec<AstNode>, String) {
    // file -> index of the claiming (newest) checkpoint.
    let mut claim: HashMap<&str, usize> = HashMap::new();
    for (idx, cp) in checkpoints.iter().take(checkpoint_cap).enumerate() {
        for node in &cp.ast_nodes {
            if let Some(f) = node.file_path.as_deref() {
                claim.entry(f).or_insert(idx);
            }
        }
    }

    let mut nodes: Vec<AstNode> = Vec::new();
    for (idx, cp) in checkpoints.iter().take(checkpoint_cap).enumerate() {
        for node in &cp.ast_nodes {
            if let Some(f) = node.file_path.as_deref() {
                if claim.get(f) == Some(&idx) {
                    nodes.push(node.clone());
                }
            }
        }
    }

    let mut lines: Vec<String> = claim
        .iter()
        .map(|(f, idx)| {
            let id = checkpoints.get(*idx).map(|c| c.id.as_str()).unwrap_or("?");
            format!("{}={}", f, id)
        })
        .collect();
    lines.sort();
    let version = hash_str(&format!("v1|{}|{}", nodes.len(), lines.join("\n")));
    (nodes, version)
}

pub(crate) fn hash_str(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

/// True when a node's recorded file matches the caller's hint — equality or
/// a '/'-aligned tail on either side (never a bare substring: `index.ts`
/// must not match `index.tsx`).
fn file_matches_hint(file: &str, hint: &str) -> bool {
    file == hint
        || file.ends_with(&format!("/{}", hint))
        || hint.ends_with(&format!("/{}", file))
}

/// Compute a bounded slice from an already-composed node set. Pure with
/// respect to the graph; reads only the cited files from `root`.
pub fn slice_from_nodes(
    root: &Path,
    nodes: &[AstNode],
    graph_version: &str,
    q: &SliceQuery,
) -> SliceResult {
    let mut defs: Vec<DefSlice> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut touched: HashSet<String> = HashSet::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut file_cache: HashMap<String, Option<String>> = HashMap::new();

    let graph = ReverseGraph::build(nodes);

    for node in nodes {
        if defs.len() >= q.max_defs {
            break;
        }
        if node.identifier.as_deref() != Some(q.symbol.as_str()) {
            continue;
        }
        if !is_definition_kind(&node.kind) {
            continue;
        }
        let file = match node.file_path.as_deref() {
            Some(f) => f,
            None => continue,
        };
        if let Some(hint) = q.file_hint.as_deref() {
            if !file_matches_hint(file, hint) {
                continue;
            }
        }
        if !seen.insert((file.to_string(), node.node_id.clone())) {
            continue;
        }
        touched.insert(file.to_string());

        let content = file_cache
            .entry(file.to_string())
            .or_insert_with(|| std::fs::read_to_string(root.join(file)).ok());
        let src = match content.as_deref() {
            Some(s) if s.contains(q.symbol.as_str()) => s,
            // File gone, or the symbol no longer appears in it: the graph's
            // claim is stale against the worktree — never cite it.
            _ => continue,
        };

        let (body, body_lines, elided_lines) = extract_span(
            src,
            node.start_line,
            node.end_line,
            &q.symbol,
            q.context_lines,
            q.max_lines,
        );

        let callers = graph
            .resolve_def(&q.symbol, Some(file))
            .map(|def_id| {
                let mut out: Vec<String> = Vec::new();
                for edge in graph.callers_of_node(&def_id) {
                    if out.len() >= q.max_edges {
                        break;
                    }
                    if let Some(caller) = graph.node(&edge.caller_node_id) {
                        let name = caller.identifier.as_deref().unwrap_or("<anon>");
                        let where_ = caller.file_path.as_deref().unwrap_or("?");
                        let row = format!("{} ({})", name, where_);
                        if !out.contains(&row) {
                            out.push(row);
                        }
                    }
                }
                out
            })
            .unwrap_or_default();

        let mut callees: Vec<String> = Vec::new();
        for dep in &node.dependencies {
            if callees.len() >= q.max_edges {
                break;
            }
            // Import records are provenance, not call edges.
            if dep.name.contains("import ") || dep.name.contains("} from") {
                continue;
            }
            if !callees.contains(&dep.name) {
                callees.push(dep.name.clone());
            }
        }

        if !files.contains(&file.to_string()) {
            files.push(file.to_string());
        }
        defs.push(DefSlice {
            node_id: node.node_id.clone(),
            identifier: q.symbol.clone(),
            kind: node.kind.clone(),
            file_path: file.to_string(),
            start_line: node.start_line,
            end_line: node.end_line,
            signature: node.signature.clone(),
            body,
            body_lines,
            elided_lines,
            callers,
            callees,
        });
    }

    let slice_chars: usize = defs.iter().map(|d| d.body.len()).sum();
    let full_file_chars: usize = files
        .iter()
        .filter_map(|f| file_cache.get(f).and_then(|c| c.as_ref().map(|s| s.len())))
        .sum();

    let mut touched_files: Vec<String> = touched.into_iter().collect();
    touched_files.sort();

    SliceResult {
        symbol: q.symbol.clone(),
        graph_version: graph_version.to_string(),
        defs,
        files,
        touched_files,
        slice_chars,
        full_file_chars,
    }
}

/// Cut the definition's span (± margin) out of the file, capped at
/// `max_lines` from the top of the window. Falls back to the first line
/// containing the symbol when the node carries no line numbers.
fn extract_span(
    src: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
    symbol: &str,
    context_lines: usize,
    max_lines: usize,
) -> (String, usize, usize) {
    let lines: Vec<&str> = src.lines().collect();
    if lines.is_empty() {
        return (String::new(), 0, 0);
    }
    let (lo, hi) = match (start_line, end_line) {
        (Some(s), Some(e)) if s >= 1 => {
            let s = (s as usize - 1).min(lines.len().saturating_sub(1));
            let e = (e.max(s as u32 + 1) as usize - 1).min(lines.len().saturating_sub(1));
            (s, e)
        }
        _ => {
            let at = lines
                .iter()
                .position(|l| l.contains(symbol))
                .unwrap_or(0);
            (at, (at + context_lines).min(lines.len().saturating_sub(1)))
        }
    };
    let lo = lo.saturating_sub(context_lines);
    let hi = (hi + context_lines).min(lines.len().saturating_sub(1));
    let total = hi - lo + 1;
    let shown = total.min(max_lines);
    let body = lines[lo..lo + shown].join("\n");
    (body, shown, total - shown)
}

// ---------------------------------------------------------------------------
// Cache: (query, caps, graph version) -> SliceResult, guarded by content
// fingerprints of every file the compute touched.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct CacheEntry {
    /// path -> sha256 of the file content at compute time ("absent" when the
    /// file did not exist).
    fingerprints: BTreeMap<String, String>,
    result: SliceResult,
}

/// How a cached_slice call was answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheOutcome {
    /// No entry for this key existed.
    Miss,
    /// Entry existed and every fingerprint still matched.
    Hit,
    /// Entry existed but a touched file changed (edit/rewind) — recomputed.
    StaleRecomputed,
}

impl CacheOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            CacheOutcome::Miss => "miss",
            CacheOutcome::Hit => "hit",
            CacheOutcome::StaleRecomputed => "stale-recomputed",
        }
    }
}

fn cache_dir(root: &Path) -> PathBuf {
    root.join(".aura").join("cache").join("context_slices")
}

/// Deterministic key over everything that shapes the answer: the query, its
/// caps, and the graph version. A new checkpoint (new graph version) keys a
/// new entry; old entries simply stop being addressed.
pub fn cache_key(q: &SliceQuery, graph_version: &str) -> String {
    hash_str(&format!(
        "v1|{}|{}|{}|{}|{}|{}|{}",
        q.symbol,
        q.file_hint.as_deref().unwrap_or(""),
        q.context_lines,
        q.max_defs,
        q.max_lines,
        q.max_edges,
        graph_version
    ))
}

fn fingerprint_file(root: &Path, rel: &str) -> String {
    match std::fs::read(root.join(rel)) {
        Ok(bytes) => {
            let mut h = Sha256::new();
            h.update(&bytes);
            hex::encode(h.finalize())
        }
        Err(_) => "absent".to_string(),
    }
}

/// Serve from cache when every touched file still matches its fingerprint;
/// otherwise recompute and rewrite the entry. Never returns a stale body.
pub fn cached_slice(
    root: &Path,
    nodes: &[AstNode],
    graph_version: &str,
    q: &SliceQuery,
) -> (SliceResult, CacheOutcome) {
    let key = cache_key(q, graph_version);
    let path = cache_dir(root).join(format!("{}.json", key));

    let existing: Option<CacheEntry> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    if let Some(entry) = &existing {
        let fresh = entry
            .fingerprints
            .iter()
            .all(|(rel, fp)| fingerprint_file(root, rel) == *fp);
        if fresh {
            return (entry.result.clone(), CacheOutcome::Hit);
        }
    }

    let result = slice_from_nodes(root, nodes, graph_version, q);
    let mut fingerprints: BTreeMap<String, String> = BTreeMap::new();
    for rel in &result.touched_files {
        fingerprints.insert(rel.clone(), fingerprint_file(root, rel));
    }
    let entry = CacheEntry {
        fingerprints,
        result: result.clone(),
    };
    let _ = std::fs::create_dir_all(cache_dir(root));
    if let Ok(json) = serde_json::to_string(&entry) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    let outcome = if existing.is_some() {
        CacheOutcome::StaleRecomputed
    } else {
        CacheOutcome::Miss
    };
    (result, outcome)
}

// ---------------------------------------------------------------------------
// Stats: the measured reduction the acceptance asks for, accumulated across
// calls so `aura_context_budget` can show it.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SliceStats {
    pub queries: u64,
    pub hits: u64,
    pub misses: u64,
    pub stale_recomputed: u64,
    /// Chars actually served as bounded slices.
    pub chars_served: u64,
    /// Chars a whole-file read of the cited files would have added on top.
    pub chars_avoided: u64,
}

fn stats_path(root: &Path) -> PathBuf {
    cache_dir(root).join("stats.json")
}

pub fn read_stats(root: &Path) -> SliceStats {
    std::fs::read_to_string(stats_path(root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn bump_stats(root: &Path, outcome: CacheOutcome, result: &SliceResult) {
    let mut stats = read_stats(root);
    stats.queries += 1;
    match outcome {
        CacheOutcome::Hit => stats.hits += 1,
        CacheOutcome::Miss => stats.misses += 1,
        CacheOutcome::StaleRecomputed => stats.stale_recomputed += 1,
    }
    stats.chars_served += result.slice_chars as u64;
    stats.chars_avoided += result
        .full_file_chars
        .saturating_sub(result.slice_chars) as u64;
    let _ = std::fs::create_dir_all(cache_dir(root));
    if let Ok(json) = serde_json::to_string_pretty(&stats) {
        let _ = std::fs::write(stats_path(root), json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DependencyUri;

    fn mk_node(id: &str, ident: &str, kind: &str, file: &str, lines: (u32, u32), deps: &[&str]) -> AstNode {
        AstNode {
            node_id: id.to_string(),
            kind: kind.to_string(),
            identifier: Some(ident.to_string()),
            content_hash: String::new(),
            children: vec![],
            dependencies: deps
                .iter()
                .map(|d| DependencyUri {
                    name: d.to_string(),
                    uri: None,
                })
                .collect(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some(file.to_string()),
            start_line: Some(lines.0),
            end_line: Some(lines.1),
            signature: Some(format!("fn {}()", ident)),
            doc_comment: None,
            top_level: true,
        }
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn slice_is_bounded_and_materially_smaller_than_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let padding = "// filler line\n".repeat(400);
        let src = format!(
            "{}fn target() {{\n    let x = 1;\n    x + 1\n}}\n{}",
            padding, padding
        );
        write(root, "src/big.rs", &src);
        let nodes = vec![mk_node("n1", "target", "function_item", "src/big.rs", (401, 404), &["helper"])];

        let q = SliceQuery::new("target");
        let r = slice_from_nodes(root, &nodes, "gv1", &q);

        assert_eq!(r.defs.len(), 1);
        assert!(r.defs[0].body.contains("fn target()"));
        assert!(
            r.slice_chars * 2 < r.full_file_chars,
            "slice ({}) must be under half the file ({})",
            r.slice_chars,
            r.full_file_chars
        );
        assert_eq!(r.defs[0].callees, vec!["helper".to_string()]);
    }

    #[test]
    fn a_symbol_gone_from_the_worktree_is_never_cited() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "src/lib.rs", "fn keep_me() {}\n");
        // Graph still remembers delete_me, the file no longer has it.
        let nodes = vec![
            mk_node("n1", "keep_me", "function_item", "src/lib.rs", (1, 1), &[]),
            mk_node("n2", "delete_me", "function_item", "src/lib.rs", (3, 5), &[]),
        ];

        let kept = slice_from_nodes(root, &nodes, "gv1", &SliceQuery::new("keep_me"));
        assert_eq!(kept.defs.len(), 1, "surviving symbol must be citeable");

        let gone = slice_from_nodes(root, &nodes, "gv1", &SliceQuery::new("delete_me"));
        assert!(gone.defs.is_empty(), "deleted symbol must not be cited");
    }

    #[test]
    fn body_cap_counts_the_elided_tail() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let body: String = (0..60).map(|i| format!("    line{};\n", i)).collect();
        write(root, "src/long.rs", &format!("fn long_fn() {{\n{}}}\n", body));
        let nodes = vec![mk_node("n1", "long_fn", "function_item", "src/long.rs", (1, 62), &[])];

        let mut q = SliceQuery::new("long_fn");
        q.max_lines = 10;
        q.context_lines = 0;
        let r = slice_from_nodes(root, &nodes, "gv1", &q);

        assert_eq!(r.defs[0].body_lines, 10);
        assert!(r.defs[0].elided_lines > 0);
        assert_eq!(r.defs[0].body.lines().count(), 10);
    }

    #[test]
    fn cache_hits_until_an_edit_then_recomputes_with_the_new_body() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "src/lib.rs", "fn target() { let v1_marker = 1; }\n");
        let nodes = vec![mk_node("n1", "target", "function_item", "src/lib.rs", (1, 1), &[])];
        let q = SliceQuery::new("target");

        let (r1, o1) = cached_slice(root, &nodes, "gv1", &q);
        assert_eq!(o1, CacheOutcome::Miss);
        assert!(r1.defs[0].body.contains("v1_marker"));

        let (_, o2) = cached_slice(root, &nodes, "gv1", &q);
        assert_eq!(o2, CacheOutcome::Hit);

        write(root, "src/lib.rs", "fn target() { let v2_marker = 2; }\n");
        let (r3, o3) = cached_slice(root, &nodes, "gv1", &q);
        assert_eq!(o3, CacheOutcome::StaleRecomputed);
        assert!(r3.defs[0].body.contains("v2_marker"), "must serve the edited body");
        assert!(!r3.defs[0].body.contains("v1_marker"), "stale body must never be served");
    }

    #[test]
    fn a_rewind_style_restore_also_invalidates_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let v1 = "fn target() { let v1_marker = 1; }\n";
        let v2 = "fn target() { let v2_marker = 2; }\n";
        let nodes = vec![mk_node("n1", "target", "function_item", "src/lib.rs", (1, 1), &[])];
        let q = SliceQuery::new("target");

        write(root, "src/lib.rs", v1);
        let _ = cached_slice(root, &nodes, "gv1", &q);
        write(root, "src/lib.rs", v2);
        let (r2, _) = cached_slice(root, &nodes, "gv1", &q);
        assert!(r2.defs[0].body.contains("v2_marker"));

        // Rewind restores the original bytes — the cache entry fingerprinted
        // v2 and must not answer with it.
        write(root, "src/lib.rs", v1);
        let (r3, o3) = cached_slice(root, &nodes, "gv1", &q);
        assert_eq!(o3, CacheOutcome::StaleRecomputed);
        assert!(r3.defs[0].body.contains("v1_marker"));
        assert!(!r3.defs[0].body.contains("v2_marker"));
    }

    #[test]
    fn graph_version_and_caps_shape_the_cache_key() {
        let q = SliceQuery::new("target");
        let base = cache_key(&q, "gv1");
        assert_ne!(base, cache_key(&q, "gv2"), "a new graph version must re-key");
        let mut wider = q.clone();
        wider.max_lines = 999;
        assert_ne!(base, cache_key(&wider, "gv1"), "different caps must re-key");
        assert_eq!(base, cache_key(&SliceQuery::new("target"), "gv1"), "same query must share the key");
    }

    #[test]
    fn newest_checkpoint_per_file_wins_the_graph_view() {
        let newest = CheckpointData {
            id: "cp-new".to_string(),
            agent_id: "t".to_string(),
            intent: "new".to_string(),
            ast_nodes: vec![mk_node("n-new", "target", "function_item", "src/lib.rs", (1, 2), &[])],
            timestamp: 200,
            intent_vector: None,
            intent_vector_model: None,
            env_fingerprint: None,
            file_oids: Default::default(),
            scope: None,
        };
        let older = CheckpointData {
            id: "cp-old".to_string(),
            agent_id: "t".to_string(),
            intent: "old".to_string(),
            ast_nodes: vec![
                mk_node("n-old", "target", "function_item", "src/lib.rs", (1, 2), &[]),
                mk_node("n-other", "other_fn", "function_item", "src/other.rs", (1, 2), &[]),
            ],
            timestamp: 100,
            intent_vector: None,
            intent_vector_model: None,
            env_fingerprint: None,
            file_oids: Default::default(),
            scope: None,
        };

        // Store order is newest-first.
        let (nodes, v1) = current_graph_view(&[newest.clone(), older.clone()], 30);
        let ids: Vec<&str> = nodes.iter().map(|n| n.node_id.as_str()).collect();
        assert!(ids.contains(&"n-new"), "newest claim for src/lib.rs wins");
        assert!(!ids.contains(&"n-old"), "superseded node must be excluded");
        assert!(ids.contains(&"n-other"), "unclaimed file falls to the older checkpoint");

        let (_, v2) = current_graph_view(&[older], 30);
        assert_ne!(v1, v2, "a different composition must version differently");
    }
}
