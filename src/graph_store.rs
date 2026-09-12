//! The one canonical graph store (AUDIT-GRF-01).
//!
//! Aura grew four parallel "truths" about the code graph: the checkpoint
//! AST (git notes `refs/notes/aura`), Atlas (reads checkpoints), the
//! desktop knowledge graph (`.aura/kg/graph.json`, its own regex walker
//! with line-based positional ids), and the Code Map riding it. The first
//! two already share one identity — the rename-proof, content-hashed
//! `node_id` the parser mints — but the desktop minted its own
//! `fn:{file}#{name}@{line}` ids, so the same function carried two names
//! depending on which surface you asked, and a rename or reformat forged
//! a "new" symbol on one surface but not the other.
//!
//! This module is the consolidation point. [`CanonicalGraph`] is the
//! export of the checkpoint truth: every definition keyed by its
//! canonical `node_id` (plus `content_hash`), every call edge
//! confidence-scored, the whole graph stamped with a schema version,
//! its scope (repo root + head sha — so a graph can never be silently
//! read against a different worktree or commit) and the `graph_version`
//! of the checkpoint view it was derived from. `aura graph export`
//! serializes it; the desktop KG build joins against that export and
//! ADOPTS these ids, keeping its own positional ids only as an
//! explicitly-labeled `outline` fallback for symbols the checkpoint
//! store has never seen. why / map / Atlas / rewind / desktop therefore
//! all answer with the same symbol id and the same edge confidences.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::callgraph::ReverseGraph;
use crate::continuity::assemble::is_definition_kind;
use crate::graph_ops::{confidence_label, confidence_score};
use crate::models::AstNode;

/// Version of the canonical export schema. Readers must treat a graph
/// with a HIGHER version than they know as unreadable (rebuild/refetch),
/// and one with a LOWER version as legacy (migrate by re-export — the
/// sources of truth, checkpoints + repo, are still present, so a
/// re-export is lossless).
pub const STORE_SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CanonicalSymbol {
    /// The rename-proof canonical identity — the same string Atlas keys
    /// its directory by, rewind targets, and query/path/explain cite.
    pub node_id: String,
    /// Format- and comment-insensitive content hash of the body.
    pub content_hash: String,
    pub identifier: String,
    /// The parser kind, verbatim (e.g. "function_definition").
    pub kind: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub end_line: Option<u32>,
    pub signature: Option<String>,
    pub is_stub: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CanonicalEdge {
    /// Caller `node_id`.
    pub from: String,
    /// Callee `node_id`.
    pub to: String,
    /// Always "calls" today; the field exists so richer relations can
    /// ride the same schema without a version bump.
    pub kind: String,
    pub confidence: f64,
    /// Human label for the confidence tier ("exact" / "import-resolved"
    /// / "name-only") — matches `aura graph` output verbatim.
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CanonicalGraph {
    pub schema_version: u32,
    /// Version hash of the checkpoint view this graph was derived from.
    pub graph_version: String,
    /// Absolute worktree root this graph is true for. A reader serving a
    /// different root must treat the graph as absent, never "close enough" —
    /// this is the field that keeps worktrees from mixing.
    pub repo_root: String,
    /// HEAD sha at export time (empty when unborn).
    pub head_sha: String,
    /// Unix seconds.
    pub generated_at: u64,
    pub symbols: Vec<CanonicalSymbol>,
    pub edges: Vec<CanonicalEdge>,
}

/// Project the checkpoint view into the canonical export. Definitions
/// only (locals and temporaries are not cross-surface identities), one
/// entry per `node_id` — when two textually identical bodies share an id
/// the first (newest-checkpoint-first order) wins, mirroring how
/// `resolve_def` answers queries.
pub fn build_canonical_graph(
    nodes: &[AstNode],
    rev: &ReverseGraph,
    graph_version: &str,
    repo_root: &str,
    head_sha: &str,
) -> CanonicalGraph {
    let mut symbols: Vec<CanonicalSymbol> = Vec::new();
    let mut kept: HashSet<&str> = HashSet::new();
    for n in nodes {
        if !is_definition_kind(&n.kind) {
            continue;
        }
        let Some(ident) = n.identifier.as_deref() else {
            continue;
        };
        if !kept.insert(n.node_id.as_str()) {
            continue;
        }
        symbols.push(CanonicalSymbol {
            node_id: n.node_id.clone(),
            content_hash: n.content_hash.clone(),
            identifier: ident.to_string(),
            kind: n.kind.clone(),
            file: n.file_path.clone(),
            line: n.start_line,
            end_line: n.end_line,
            signature: n.signature.clone(),
            is_stub: n.is_stub,
        });
    }

    let mut edges: Vec<CanonicalEdge> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for s in &symbols {
        for caller in rev.callers_of_node(&s.node_id) {
            if !kept.contains(caller.caller_node_id.as_str()) {
                continue;
            }
            let pair = (caller.caller_node_id.clone(), s.node_id.clone());
            if !seen.insert(pair.clone()) {
                continue;
            }
            edges.push(CanonicalEdge {
                from: pair.0,
                to: pair.1,
                kind: "calls".to_string(),
                confidence: confidence_score(caller.confidence),
                label: confidence_label(caller.confidence).to_string(),
            });
        }
    }

    CanonicalGraph {
        schema_version: STORE_SCHEMA_VERSION,
        graph_version: graph_version.to_string(),
        repo_root: repo_root.to_string(),
        head_sha: head_sha.to_string(),
        generated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        symbols,
        edges,
    }
}

/// Quick membership index over an export, for joins and tests.
pub fn symbol_index(g: &CanonicalGraph) -> HashMap<&str, &CanonicalSymbol> {
    g.symbols.iter().map(|s| (s.node_id.as_str(), s)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph_ops::{dependency_path, query_symbols};
    use crate::models::DependencyUri;

    fn mk_node(
        id: &str,
        kind: &str,
        ident: &str,
        file: &str,
        line: u32,
        deps: &[&str],
    ) -> AstNode {
        AstNode {
            node_id: id.to_string(),
            kind: kind.to_string(),
            identifier: Some(ident.to_string()),
            content_hash: format!("hash-{id}"),
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
            start_line: Some(line),
            end_line: Some(line + 5),
            signature: Some(format!("fn {ident}()")),
            doc_comment: None,
            top_level: true,
        }
    }

    fn chain() -> Vec<AstNode> {
        vec![
            mk_node("id-main", "function_definition", "main", "src/app.rs", 1, &["handle"]),
            mk_node("id-handle", "function_definition", "handle", "src/app.rs", 10, &["save"]),
            mk_node("id-save", "function_definition", "save", "src/app.rs", 20, &[]),
            mk_node("id-tmp", "variable_declarator", "tmp", "src/app.rs", 30, &[]),
        ]
    }

    #[test]
    fn export_keeps_definitions_only_and_is_schema_stamped() {
        let nodes = chain();
        let rev = ReverseGraph::build(&nodes);
        let g = build_canonical_graph(&nodes, &rev, "v-test", "/repo", "headsha");
        assert_eq!(g.schema_version, STORE_SCHEMA_VERSION);
        assert_eq!(g.graph_version, "v-test");
        assert_eq!(g.repo_root, "/repo");
        let idx = symbol_index(&g);
        assert_eq!(g.symbols.len(), 3, "variable_declarator must not export");
        assert!(idx.contains_key("id-main") && idx.contains_key("id-save"));
        assert!(!idx.contains_key("id-tmp"));
        // Call edges carry the same confidence scale the CLI prints.
        let e = g
            .edges
            .iter()
            .find(|e| e.from == "id-main" && e.to == "id-handle")
            .expect("main→handle call edge");
        assert_eq!(e.kind, "calls");
        assert!(e.confidence > 0.0 && e.confidence <= 1.0);
        assert!(!e.label.is_empty());
    }

    #[test]
    fn export_ids_match_query_and_path_answers_exactly() {
        // The acceptance line: the same symbol ID appears consistently in
        // query (why-style answers), path, and the exported store the
        // desktop map adopts.
        let nodes = chain();
        let rev = ReverseGraph::build(&nodes);
        let g = build_canonical_graph(&nodes, &rev, "v-test", "/repo", "");
        let idx = symbol_index(&g);

        let hits = query_symbols(&nodes, &rev, "handle", 5);
        assert!(!hits.is_empty());
        for h in &hits {
            assert!(
                idx.contains_key(h.node_id.as_str()),
                "query hit {} missing from canonical export",
                h.node_id
            );
        }

        let path = dependency_path(&nodes, &rev, "v-test", "main", "save", 8)
            .expect("path resolves");
        assert!(path.found);
        for hop in &path.hops {
            assert!(
                idx.contains_key(hop.node_id.as_str()),
                "path hop {} missing from canonical export",
                hop.node_id
            );
        }
    }

    #[test]
    fn duplicate_node_ids_export_once() {
        let mut nodes = chain();
        // Two identical bodies in different files share a content-derived id.
        let mut dup = mk_node("id-save", "function_definition", "save", "src/other.rs", 7, &[]);
        dup.content_hash = "hash-id-save".into();
        nodes.push(dup);
        let rev = ReverseGraph::build(&nodes);
        let g = build_canonical_graph(&nodes, &rev, "v", "/repo", "");
        assert_eq!(
            g.symbols.iter().filter(|s| s.node_id == "id-save").count(),
            1
        );
    }

    #[test]
    fn export_round_trips_through_serde() {
        let nodes = chain();
        let rev = ReverseGraph::build(&nodes);
        let g = build_canonical_graph(&nodes, &rev, "v", "/repo", "h");
        let json = serde_json::to_string(&g).unwrap();
        let back: CanonicalGraph = serde_json::from_str(&json).unwrap();
        assert_eq!(back.symbols.len(), g.symbols.len());
        assert_eq!(back.edges.len(), g.edges.len());
        assert_eq!(back.schema_version, STORE_SCHEMA_VERSION);
    }
}
