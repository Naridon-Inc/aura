//! Confidence-scored graph operations (AUDIT-GRF-05): query, dependency
//! path and explain over the semantic checkpoint graph.
//!
//! These are the CLI/MCP counterparts of the desktop Code Map's bounded
//! views. They run on the graph Aura already owns — checkpoint AST nodes
//! composed by [`crate::context_slice::current_graph_view`] plus the
//! reverse call graph — so every answer cites graph evidence: node ids,
//! file:line spans, per-edge confidence, and the graph version the answer
//! was computed against.
//!
//! Confidence is never invented: query hits carry match quality (exact >
//! prefix > substring), edges carry the resolver's own certainty
//! ([`EdgeConfidence`]), and a path's confidence is the product of every
//! edge it crossed — one weak hop makes the whole path honest about it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use clap::Subcommand;
use serde::Serialize;

use crate::callgraph::{EdgeConfidence, ReverseGraph};
use crate::continuity::assemble::is_definition_kind;
use crate::models::AstNode;

/// Numeric trust for a resolved call edge. Ranks mirror
/// [`EdgeConfidence`]: same-file resolution is near-certain, an import
/// match is strong, a bare name match is a coin toss and says so.
pub fn confidence_score(c: EdgeConfidence) -> f64 {
    match c {
        EdgeConfidence::Exact => 0.95,
        EdgeConfidence::ImportResolved => 0.8,
        EdgeConfidence::NameOnly => 0.5,
    }
}

pub fn confidence_label(c: EdgeConfidence) -> &'static str {
    match c {
        EdgeConfidence::Exact => "exact",
        EdgeConfidence::ImportResolved => "import-resolved",
        EdgeConfidence::NameOnly => "name-only",
    }
}

/// Match quality of an identifier against a query term, in (0, 1].
fn match_confidence(identifier: &str, term: &str) -> Option<f64> {
    if identifier == term {
        return Some(1.0);
    }
    let id = identifier.to_ascii_lowercase();
    let q = term.to_ascii_lowercase();
    if id == q {
        return Some(0.9);
    }
    if id.starts_with(&q) {
        return Some(0.75);
    }
    if id.contains(&q) {
        return Some(0.55);
    }
    None
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryHit {
    pub node_id: String,
    pub identifier: String,
    pub kind: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub signature: Option<String>,
    /// How well the identifier matched the query term.
    pub match_confidence: f64,
    /// Inbound call edges — the graph evidence that this hit matters.
    pub callers: usize,
    pub is_stub: bool,
}

/// Rank definition nodes against a free-text term. Only definitions
/// (functions, classes, …) are hits — local bindings a re-parse emits
/// are noise for a "where is X" question.
pub fn query_symbols(
    nodes: &[AstNode],
    rev: &ReverseGraph,
    term: &str,
    limit: usize,
) -> Vec<QueryHit> {
    let mut hits: Vec<QueryHit> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for n in nodes {
        if !is_definition_kind(&n.kind) {
            continue;
        }
        let Some(ident) = n.identifier.as_deref() else {
            continue;
        };
        let Some(score) = match_confidence(ident, term) else {
            continue;
        };
        if !seen.insert(n.node_id.as_str()) {
            continue;
        }
        hits.push(QueryHit {
            node_id: n.node_id.clone(),
            identifier: ident.to_string(),
            kind: n.kind.clone(),
            file: n.file_path.clone(),
            line: n.start_line,
            signature: n.signature.clone(),
            match_confidence: score,
            callers: rev.callers_of_node(&n.node_id).len(),
            is_stub: n.is_stub,
        });
    }
    hits.sort_by(|a, b| {
        b.match_confidence
            .partial_cmp(&a.match_confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.callers.cmp(&a.callers))
            .then_with(|| a.identifier.cmp(&b.identifier))
    });
    hits.truncate(limit.max(1));
    hits
}

#[derive(Debug, Clone, Serialize)]
pub struct PathHop {
    pub node_id: String,
    pub identifier: Option<String>,
    pub file: Option<String>,
    pub line: Option<u32>,
    /// Edge that led here from the previous hop; None on the first hop.
    pub via_confidence: Option<f64>,
    pub via_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PathResult {
    pub found: bool,
    pub from_node_id: String,
    pub to_node_id: String,
    pub hops: Vec<PathHop>,
    /// Product of every edge confidence crossed; 0 when no path exists.
    pub confidence: f64,
    pub graph_version: String,
}

/// Shortest call chain from `from` to `to` — "does A transitively call
/// B, and through what". Edges come from the reverse call graph turned
/// forward: A → B exists iff A resolved as a caller of B.
pub fn dependency_path(
    nodes: &[AstNode],
    rev: &ReverseGraph,
    graph_version: &str,
    from: &str,
    to: &str,
    max_hops: usize,
) -> Result<PathResult, String> {
    let from_id = rev
        .resolve_def(from, None)
        .ok_or_else(|| format!("no definition named '{from}' in the graph"))?;
    let to_id = rev
        .resolve_def(to, None)
        .ok_or_else(|| format!("no definition named '{to}' in the graph"))?;

    // Forward adjacency: caller → callee, keeping edge confidence. The
    // reverse graph stores inbound edges, so walking every node's callers
    // once flips the whole thing in O(E).
    let mut fwd: HashMap<String, Vec<(String, EdgeConfidence)>> = HashMap::new();
    for n in nodes {
        for edge in rev.callers_of_node(&n.node_id) {
            fwd.entry(edge.caller_node_id)
                .or_default()
                .push((n.node_id.clone(), edge.confidence));
        }
    }

    let max_hops = max_hops.clamp(1, 16);
    let mut prev: HashMap<String, (String, EdgeConfidence)> = HashMap::new();
    let mut depth: HashMap<String, usize> = HashMap::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    depth.insert(from_id.clone(), 0);
    queue.push_back(from_id.clone());
    let mut reached = false;
    while let Some(cur) = queue.pop_front() {
        if cur == to_id {
            reached = true;
            break;
        }
        let d = depth[&cur];
        if d >= max_hops {
            continue;
        }
        if let Some(nexts) = fwd.get(&cur) {
            for (n, conf) in nexts.clone() {
                if !depth.contains_key(&n) {
                    depth.insert(n.clone(), d + 1);
                    prev.insert(n.clone(), (cur.clone(), conf));
                    queue.push_back(n);
                }
            }
        }
    }

    let by_id: HashMap<&str, &AstNode> = nodes.iter().map(|n| (n.node_id.as_str(), n)).collect();
    let hop_of = |id: &str, via: Option<EdgeConfidence>| PathHop {
        node_id: id.to_string(),
        identifier: by_id.get(id).and_then(|n| n.identifier.clone()),
        file: by_id.get(id).and_then(|n| n.file_path.clone()),
        line: by_id.get(id).and_then(|n| n.start_line),
        via_confidence: via.map(confidence_score),
        via_label: via.map(|c| confidence_label(c).to_string()),
    };

    let mut result = PathResult {
        found: reached,
        from_node_id: from_id.clone(),
        to_node_id: to_id.clone(),
        hops: Vec::new(),
        confidence: 0.0,
        graph_version: graph_version.to_string(),
    };
    if !reached {
        return Ok(result);
    }
    // Rebuild the chain backwards from `to`.
    let mut chain: Vec<(String, Option<EdgeConfidence>)> = vec![(to_id.clone(), None)];
    let mut cur = to_id.clone();
    while cur != from_id {
        let (p, conf) = prev[&cur].clone();
        chain.last_mut().unwrap().1 = Some(conf);
        chain.push((p.clone(), None));
        cur = p;
    }
    chain.reverse();
    let mut confidence = 1.0;
    for (id, via) in chain {
        if let Some(c) = via {
            confidence *= confidence_score(c);
        }
        result.hops.push(hop_of(&id, via));
    }
    result.confidence = confidence;
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
pub struct ExplainCaller {
    pub node_id: String,
    pub identifier: Option<String>,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub confidence: f64,
    pub confidence_label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExplainReport {
    pub symbol: String,
    pub node_id: String,
    pub kind: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub signature: Option<String>,
    pub is_stub: bool,
    /// Who calls this, with the resolver's own certainty per edge.
    pub callers: Vec<ExplainCaller>,
    /// What this calls or uses, by dependency name.
    pub callees: Vec<String>,
    /// False when the worktree no longer contains the identifier — the
    /// graph knows about it, but the citation would be stale.
    pub fresh: bool,
    pub graph_version: String,
}

/// Everything the graph knows about one symbol, worktree-verified.
pub fn explain_symbol(
    root: &Path,
    nodes: &[AstNode],
    rev: &ReverseGraph,
    graph_version: &str,
    symbol: &str,
    file_hint: Option<&str>,
) -> Result<ExplainReport, String> {
    let node_id = rev
        .resolve_def(symbol, file_hint)
        .ok_or_else(|| format!("no definition named '{symbol}' in the graph"))?;
    let node = rev
        .node(&node_id)
        .ok_or_else(|| format!("graph edge points at missing node {node_id}"))?;

    // Same freshness rule as the carryover assembler: the file must still
    // exist and still contain the identifier, or the answer says stale.
    let fresh = match (node.file_path.as_deref(), node.identifier.as_deref()) {
        (Some(f), Some(id)) => std::fs::read_to_string(root.join(f))
            .map(|src| src.contains(id))
            .unwrap_or(false),
        _ => false,
    };

    let mut callers: Vec<ExplainCaller> = rev
        .callers_of_node(&node_id)
        .into_iter()
        .map(|e| {
            let cn = rev.node(&e.caller_node_id);
            ExplainCaller {
                node_id: e.caller_node_id.clone(),
                identifier: cn.and_then(|n| n.identifier.clone()),
                file: cn.and_then(|n| n.file_path.clone()),
                line: cn.and_then(|n| n.start_line),
                confidence: confidence_score(e.confidence),
                confidence_label: confidence_label(e.confidence).to_string(),
            }
        })
        .collect();
    callers.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.node_id.cmp(&b.node_id))
    });

    let callees: Vec<String> = node.dependencies.iter().map(|d| d.name.clone()).collect();

    Ok(ExplainReport {
        symbol: symbol.to_string(),
        node_id,
        kind: node.kind.clone(),
        file: node.file_path.clone(),
        line: node.start_line,
        signature: node.signature.clone(),
        is_stub: node.is_stub,
        callers,
        callees,
        fresh,
        graph_version: graph_version.to_string(),
    })
}

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

#[derive(Subcommand, Debug)]
pub enum GraphSubcommands {
    /// Find definitions matching a term, confidence-ranked
    Query {
        /// Symbol or partial name to look for
        term: String,
        /// Max hits returned
        #[arg(long, default_value_t = 10)]
        limit: usize,
        /// Emit JSON instead of the table
        #[arg(long)]
        json: bool,
    },
    /// Shortest call chain from one symbol to another, with per-edge confidence
    Path {
        /// Caller-side symbol
        from: String,
        /// Callee-side symbol
        to: String,
        /// Max hops to search
        #[arg(long, default_value_t = 8)]
        max_hops: usize,
        /// Emit JSON instead of the chain
        #[arg(long)]
        json: bool,
    },
    /// Everything the graph knows about one symbol, worktree-verified
    Explain {
        /// Symbol to explain
        symbol: String,
        /// Disambiguate same-named definitions by file
        #[arg(long)]
        file: Option<String>,
        /// Emit JSON instead of the report
        #[arg(long)]
        json: bool,
    },
    /// Export the canonical graph store — the one identity every surface
    /// (why, map, Atlas, rewind, desktop) reads. See graph_store.rs.
    Export {
        /// Write atomically to this path instead of stdout
        #[arg(long)]
        out: Option<String>,
    },
}

/// Compose the graph the ops run on: checkpoint nodes + reverse edges.
fn load_graph() -> Result<(Vec<AstNode>, String), Box<dyn std::error::Error>> {
    let repo = git2::Repository::open(".")?;
    let checkpoints = crate::checkpoint::CheckpointStore::get_all_checkpoints(&repo)
        .unwrap_or_default();
    if checkpoints.is_empty() {
        return Err("no checkpoints yet — the semantic graph is empty. Commit through Aura (or run `aura track`) so the graph has nodes to answer from.".into());
    }
    let (nodes, version) = crate::context_slice::current_graph_view(&checkpoints, 30);
    Ok((nodes, version))
}

pub fn handle_graph_command(
    sub: &GraphSubcommands,
) -> Result<(), Box<dyn std::error::Error>> {
    let (nodes, graph_version) = load_graph()?;
    let rev = ReverseGraph::build(&nodes);
    let short_version: String = graph_version.chars().take(12).collect();
    match sub {
        GraphSubcommands::Query { term, limit, json } => {
            let hits = query_symbols(&nodes, &rev, term, *limit);
            if *json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                    "graph_version": graph_version,
                    "hits": hits,
                }))?);
                return Ok(());
            }
            if hits.is_empty() {
                println!("No definitions match '{term}' (graph {short_version}).");
                return Ok(());
            }
            println!("Definitions matching '{term}' — graph {short_version}:");
            for h in &hits {
                let loc = match (&h.file, h.line) {
                    (Some(f), Some(l)) => format!("{f}:{l}"),
                    (Some(f), None) => f.clone(),
                    _ => "?".into(),
                };
                println!(
                    "  {:>4.0}%  {} {}  {}  ({} caller{}{})",
                    h.match_confidence * 100.0,
                    h.kind,
                    h.identifier,
                    loc,
                    h.callers,
                    if h.callers == 1 { "" } else { "s" },
                    if h.is_stub { ", STUB" } else { "" },
                );
            }
        }
        GraphSubcommands::Path { from, to, max_hops, json } => {
            let path = dependency_path(&nodes, &rev, &graph_version, from, to, *max_hops)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&path)?);
                return Ok(());
            }
            if !path.found {
                println!(
                    "No call chain from '{from}' to '{to}' within {max_hops} hops (graph {short_version})."
                );
                return Ok(());
            }
            println!(
                "Call chain {from} → {to} — confidence {:.0}%, graph {short_version}:",
                path.confidence * 100.0
            );
            for hop in &path.hops {
                let name = hop.identifier.as_deref().unwrap_or(&hop.node_id);
                let loc = match (&hop.file, hop.line) {
                    (Some(f), Some(l)) => format!("  {f}:{l}"),
                    _ => String::new(),
                };
                match (&hop.via_label, hop.via_confidence) {
                    (Some(label), Some(c)) => {
                        println!("    └─ calls ({label}, {:.0}%) → {name}{loc}", c * 100.0)
                    }
                    _ => println!("  {name}{loc}"),
                }
            }
        }
        GraphSubcommands::Explain { symbol, file, json } => {
            let report = explain_symbol(
                Path::new("."),
                &nodes,
                &rev,
                &graph_version,
                symbol,
                file.as_deref(),
            )?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&report)?);
                return Ok(());
            }
            let loc = match (&report.file, report.line) {
                (Some(f), Some(l)) => format!("{f}:{l}"),
                (Some(f), None) => f.clone(),
                _ => "?".into(),
            };
            println!("{} {}  {}  [{}]", report.kind, report.symbol, loc, report.node_id);
            if let Some(sig) = &report.signature {
                println!("  signature: {sig}");
            }
            if !report.fresh {
                println!("  ⚠ stale: the worktree no longer contains this identifier — the graph predates an edit.");
            }
            if report.is_stub {
                println!("  ⚠ stub: flagged as unimplemented.");
            }
            if report.callers.is_empty() {
                println!("  callers: none recorded in the graph.");
            } else {
                println!("  callers ({}):", report.callers.len());
                for c in &report.callers {
                    let name = c.identifier.as_deref().unwrap_or(&c.node_id);
                    let loc = match (&c.file, c.line) {
                        (Some(f), Some(l)) => format!("  {f}:{l}"),
                        _ => String::new(),
                    };
                    println!(
                        "    ← {name}{loc}  ({}, {:.0}%)",
                        c.confidence_label,
                        c.confidence * 100.0
                    );
                }
            }
            if !report.callees.is_empty() {
                println!("  uses: {}", report.callees.join(", "));
            }
            println!("  graph: {short_version}");
        }
        GraphSubcommands::Export { out } => {
            let repo = git2::Repository::open(".")?;
            let repo_root = repo
                .workdir()
                .map(|p| {
                    p.canonicalize()
                        .unwrap_or_else(|_| p.to_path_buf())
                        .to_string_lossy()
                        .to_string()
                })
                .unwrap_or_default();
            let head_sha = repo
                .head()
                .ok()
                .and_then(|h| h.peel_to_commit().ok())
                .map(|c| c.id().to_string())
                .unwrap_or_default();
            let g = crate::graph_store::build_canonical_graph(
                &nodes,
                &rev,
                &graph_version,
                &repo_root,
                &head_sha,
            );
            let json = serde_json::to_string_pretty(&g)?;
            match out {
                Some(p) => {
                    let path = std::path::Path::new(p);
                    if let Some(parent) = path.parent() {
                        if !parent.as_os_str().is_empty() {
                            std::fs::create_dir_all(parent)?;
                        }
                    }
                    let tmp = path.with_extension("json.tmp");
                    std::fs::write(&tmp, &json)?;
                    std::fs::rename(&tmp, path)?;
                    println!(
                        "Canonical graph exported: {} symbols, {} edges → {} (graph {short_version})",
                        g.symbols.len(),
                        g.edges.len(),
                        p
                    );
                }
                None => println!("{json}"),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DependencyUri;

    fn mk_node(id: &str, ident: &str, kind: &str, file: &str, line: u32, deps: &[&str]) -> AstNode {
        AstNode {
            node_id: id.to_string(),
            kind: kind.to_string(),
            identifier: Some(ident.to_string()),
            content_hash: String::new(),
            children: vec![],
            dependencies: deps
                .iter()
                .map(|d| DependencyUri { name: d.to_string(), uri: None })
                .collect(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some(file.to_string()),
            start_line: Some(line),
            end_line: Some(line + 5),
            signature: Some(format!("fn {}()", ident)),
            doc_comment: None,
            top_level: true,
        }
    }

    /// main → handle → save, all same-file so edges resolve Exact.
    fn call_chain_nodes() -> Vec<AstNode> {
        vec![
            mk_node("n-main", "main", "function_declaration", "src/app.rs", 1, &["handle"]),
            mk_node("n-handle", "handle", "function_declaration", "src/app.rs", 10, &["save"]),
            mk_node("n-save", "save", "function_declaration", "src/app.rs", 20, &[]),
        ]
    }

    #[test]
    fn query_ranks_exact_over_prefix_over_substring() {
        let nodes = vec![
            mk_node("n-1", "save", "function_declaration", "a.rs", 1, &[]),
            mk_node("n-2", "save_user", "function_declaration", "a.rs", 10, &[]),
            mk_node("n-3", "autosave", "function_declaration", "a.rs", 20, &[]),
            // A local binding must never be a hit, whatever it's named.
            mk_node("n-4", "save", "variable_declarator", "a.rs", 30, &[]),
        ];
        let rev = ReverseGraph::build(&nodes);
        let hits = query_symbols(&nodes, &rev, "save", 10);
        let idents: Vec<&str> = hits.iter().map(|h| h.identifier.as_str()).collect();
        assert_eq!(idents, vec!["save", "save_user", "autosave"]);
        assert_eq!(hits[0].match_confidence, 1.0);
        assert_eq!(hits[1].match_confidence, 0.75);
        assert_eq!(hits[2].match_confidence, 0.55);
        assert!(hits.iter().all(|h| h.node_id != "n-4"));
    }

    #[test]
    fn path_follows_call_direction_and_multiplies_confidence() {
        let nodes = call_chain_nodes();
        let rev = ReverseGraph::build(&nodes);
        let p = dependency_path(&nodes, &rev, "v1", "main", "save", 8).unwrap();
        assert!(p.found);
        assert_eq!(p.hops.len(), 3);
        assert_eq!(p.hops[0].identifier.as_deref(), Some("main"));
        assert_eq!(p.hops[2].identifier.as_deref(), Some("save"));
        // Two same-file Exact edges: 0.95 * 0.95.
        assert!((p.confidence - 0.9025).abs() < 1e-9);
        assert_eq!(p.hops[1].via_label.as_deref(), Some("exact"));
        assert_eq!(p.graph_version, "v1");
    }

    #[test]
    fn path_does_not_run_against_call_direction() {
        let nodes = call_chain_nodes();
        let rev = ReverseGraph::build(&nodes);
        let p = dependency_path(&nodes, &rev, "v1", "save", "main", 8).unwrap();
        assert!(!p.found);
        assert!(p.hops.is_empty());
        assert_eq!(p.confidence, 0.0);
    }

    #[test]
    fn path_refuses_unknown_endpoints_with_a_reason() {
        let nodes = call_chain_nodes();
        let rev = ReverseGraph::build(&nodes);
        let err = dependency_path(&nodes, &rev, "v1", "main", "nonexistent", 8).unwrap_err();
        assert!(err.contains("nonexistent"));
    }

    #[test]
    fn explain_cites_callers_callees_and_freshness() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/app.rs"),
            "fn main() { handle() }\nfn handle() { save() }\nfn save() {}\n",
        )
        .unwrap();
        let nodes = call_chain_nodes();
        let rev = ReverseGraph::build(&nodes);
        let r = explain_symbol(dir.path(), &nodes, &rev, "v1", "handle", None).unwrap();
        assert_eq!(r.node_id, "n-handle");
        assert!(r.fresh);
        assert_eq!(r.callers.len(), 1);
        assert_eq!(r.callers[0].identifier.as_deref(), Some("main"));
        assert_eq!(r.callers[0].confidence_label, "exact");
        assert!((r.callers[0].confidence - 0.95).abs() < 1e-9);
        assert_eq!(r.callees, vec!["save".to_string()]);
        assert_eq!(r.graph_version, "v1");
    }

    #[test]
    fn explain_marks_a_vanished_symbol_stale() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        // The file exists but the identifier was renamed away.
        std::fs::write(dir.path().join("src/app.rs"), "fn renamed() {}\n").unwrap();
        let nodes = call_chain_nodes();
        let rev = ReverseGraph::build(&nodes);
        let r = explain_symbol(dir.path(), &nodes, &rev, "v1", "save", None).unwrap();
        assert!(!r.fresh);
    }
}
