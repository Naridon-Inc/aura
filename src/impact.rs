//! Delete-impact engine for the agent-safety gate card.
//!
//! Given a file and the symbols an agent is about to delete from it, this
//! module produces a plain-language verdict on the *user-facing* impact:
//! which features break, who calls the doomed code, and how confident we are.
//!
//! The flow is: **load → build → BFS → classify → summarize**.
//!   1. **load** — assemble the best semantic graph we can. Prefer the newest
//!      checkpoint's `ast_nodes` (with the target file re-parsed from disk so
//!      the caller picture is current); else a bounded worktree scan; else
//!      nothing.
//!   2. **build** — feed the nodes to [`crate::callgraph::ReverseGraph`].
//!   3. **BFS** — reverse-walk `callers_of_node` from each removed symbol's
//!      definition, bounded by depth, node budget, and a wall-clock budget.
//!   4. **classify** — for every reached caller, ask
//!      [`crate::entrypoints::classify`] whether it is a user-facing entry
//!      point (Tauri command, HTTP route, CLI command, UI component, public API).
//!   5. **summarize** — turn the graph facts into a severity, a confidence,
//!      and a human sentence for the gate card.
//!
//! Every failure path returns a well-formed [`DeleteImpact`] (usually
//! [`ImpactSeverity::Unknown`]). This module never panics.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use crate::callgraph::{CallerEdge, EdgeConfidence, ReverseGraph};
use crate::checkpoint::CheckpointStore;
use crate::entrypoints::{self, EntryKind, EntryPoint};
use crate::models::AstNode;
use crate::parser::SemanticParser;

// ---------------------------------------------------------------------------
// Tunable budgets (kept private). Reverse-BFS over a large graph could run away
// without these; every cap that trips sets `truncated = true` so the card can
// tell the user the floor is conservative.
// ---------------------------------------------------------------------------

/// Maximum BFS depth (hop distance) we explore away from a removed symbol.
const MAX_DEPTH: usize = 8;
/// Hard ceiling on distinct caller nodes we will visit across all symbols.
const VISIT_BUDGET: usize = 4000;
/// Wall-clock budget for the analysis (graph walk + worktree scan each).
const TIME_BUDGET_MS: u128 = 1200;
/// Cap on files touched during the fallback worktree scan.
const MAX_SCAN_FILES: usize = 1500;
/// A checkpoint older than this is "stale" and drags confidence down.
const STALE_SECS: u64 = 7 * 24 * 60 * 60; // 7 days
/// A checkpoint younger than this is "fresh" and may earn High confidence.
const FRESH_SECS: u64 = 24 * 60 * 60; // 1 day

// ---------------------------------------------------------------------------
// LOCKED public contract — see task spec. Do not change serde shapes.
// ---------------------------------------------------------------------------

/// The full verdict on deleting one or more symbols from a file.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteImpact {
    /// One human sentence for the gate card.
    pub summary: String,
    /// How bad this looks: leaf-safe, callers-only, feature-loss, or unknown.
    pub severity: ImpactSeverity,
    /// True when nothing calls the removed code (and we knew its definition).
    pub leaf: bool,
    /// Callers one hop away from the removed code (union across symbols).
    pub direct_callers: Vec<CallerInfo>,
    /// Total distinct callers reached at any depth.
    pub transitive_caller_count: usize,
    /// Distinct user-facing features reached, sorted by closeness.
    pub features: Vec<FeatureImpact>,
    /// Confidence in this verdict.
    pub confidence: Confidence,
    /// Always-present caveat about static-analysis blind spots.
    pub hedge: String,
    /// Where the graph came from: `"checkpoint" | "worktree" | "none"`.
    pub graph_source: String,
    /// Seconds since the source checkpoint was captured (checkpoint source only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_staleness_secs: Option<u64>,
    /// True if any budget tripped, so counts are a floor.
    pub truncated: bool,
}

/// Severity buckets for the gate card, worst-known first in spirit.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImpactSeverity {
    /// No callers found and the symbol's definition was known — likely safe.
    LeafSafe,
    /// Callers exist but none reach a user-facing feature within range.
    CallersOnly,
    /// At least one user-facing feature depends on the removed code.
    FeatureLoss,
    /// We could not analyze (no graph, or symbol absent and no fallback).
    Unknown,
}

/// Confidence in the verdict.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

/// A single caller of the removed code.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerInfo {
    /// The caller's identifier (function/class name) or a placeholder.
    pub symbol: String,
    /// Source file of the caller, if known.
    pub file: Option<String>,
    /// AST kind of the caller (e.g. `"function_definition"`).
    pub kind: String,
    /// Edge confidence, serialized `"exact" | "import_resolved" | "name_only"`.
    pub confidence: String,
}

/// A user-facing feature that the removed code feeds into.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureImpact {
    /// Human feature name (from the entry point classifier).
    pub name: String,
    /// Entry kind, serialized snake_case (e.g. `"tauri_command"`).
    pub kind: String,
    /// The symbol that anchors the entry point.
    pub entry_symbol: String,
    /// File that declares the entry point.
    pub file: String,
    /// Minimum hop distance from a removed symbol to this entry point.
    pub hops: usize,
    /// The call chain that makes this break: from the entry point down to the
    /// removed symbol, e.g. `["sign_in_cmd", "verify_token"]` (entry first,
    /// removed symbol last). This is the "because" — *how* the deletion reaches
    /// the feature. Single-element only if reconstruction couldn't extend it.
    pub path: Vec<String>,
}

/// Neutral, multi-file blast radius for one changed file — the `change-note`
/// companion to [`DeleteImpact`]. Same reverse-BFS + entry-point classification,
/// but without the deletion framing (no severity / summary / hedge): just the
/// facts a per-file change card needs — who calls the changed symbols and which
/// user-facing features ride on them.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileImpact {
    /// The file these seeds belong to (repo-relative).
    pub file: String,
    /// Callers one hop from the changed symbols — the "re-check these" list.
    pub direct_callers: Vec<CallerInfo>,
    /// Total distinct dependents reached at any depth.
    pub transitive_caller_count: usize,
    /// User-facing features reached, closest first.
    pub features: Vec<FeatureImpact>,
    /// True when nothing in range depends on the changed symbols.
    pub leaf: bool,
    /// True if a graph-walk budget tripped, so counts are a floor.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Blast radius for several `(file, changed-symbols)` seeds in one pass, loading
/// the semantic graph only once. Returns one [`FileImpact`] per input seed (same
/// order) plus the graph provenance (`"checkpoint" | "worktree" | "none"`).
///
/// Used by `aura change-note`: it asks "who depends on the symbols this commit
/// touched", per file, with zero AI tokens. Symbols absent from the graph (e.g.
/// a just-added function not yet in a checkpoint) simply contribute no callers.
pub fn analyze_changes(
    repo_root: &Path,
    seeds: &[(String, Vec<String>)],
) -> (Vec<FileImpact>, String) {
    let files: Vec<&str> = seeds.iter().map(|(f, _)| f.as_str()).collect();
    let (nodes, source, _staleness) = load_graph_nodes_multi(repo_root, &files);
    let out = seeds
        .iter()
        .map(|(file, symbols)| {
            let imp = build_impact_from_nodes(&nodes, file, symbols, repo_root);
            FileImpact {
                file: file.clone(),
                direct_callers: imp.direct_callers,
                transitive_caller_count: imp.transitive_caller_count,
                features: imp.features,
                leaf: imp.leaf,
                truncated: imp.truncated,
            }
        })
        .collect();
    (out, source.as_str().to_string())
}

/// Analyze deleting `removed_symbols` from `file`. Never panics.
///
/// Loads the best available semantic graph (checkpoint → worktree → none),
/// merges in a fresh parse of `file`, then delegates the pure graph reasoning
/// to [`build_impact_from_nodes`]. All I/O lives here; the reasoning is pure
/// and unit-tested.
pub fn analyze_deletion(repo_root: &Path, file: &str, removed_symbols: &[String]) -> DeleteImpact {
    let (nodes, graph_source, staleness) = load_graph_nodes(repo_root, file);

    if matches!(graph_source, GraphSource::None) {
        return unknown_impact("none", None);
    }

    let mut impact = build_impact_from_nodes(&nodes, file, removed_symbols, repo_root);
    impact.graph_source = graph_source.as_str().to_string();
    impact.graph_staleness_secs = staleness;

    // Re-derive confidence now that we know the real source/staleness, since
    // the pure builder assumes a worktree-grade (Medium-capped) source.
    impact.confidence = derive_confidence(
        impact.severity,
        graph_source,
        staleness,
        impact.truncated,
        impact_name_only_ratio(&impact),
        /* resolved */ !impact.leaf || matches!(impact.severity, ImpactSeverity::LeafSafe),
    );
    impact
}

/// Convert a [`DeleteImpact`] to JSON, falling back to `null` on the
/// (practically impossible) serialization failure rather than panicking.
pub fn to_json(impact: &DeleteImpact) -> serde_json::Value {
    serde_json::to_value(impact).unwrap_or(serde_json::Value::Null)
}

// ---------------------------------------------------------------------------
// Graph loading (I/O) — kept out of the pure reasoning path
// ---------------------------------------------------------------------------

/// Where the analyzed node set came from.
#[derive(Debug, Clone, Copy)]
enum GraphSource {
    Checkpoint,
    Worktree,
    None,
}

impl GraphSource {
    fn as_str(self) -> &'static str {
        match self {
            GraphSource::Checkpoint => "checkpoint",
            GraphSource::Worktree => "worktree",
            GraphSource::None => "none",
        }
    }
}

/// Source-file extensions our parser understands (mirrors `SemanticParser`).
const SOURCE_EXTS: &[&str] = &[
    "py", "rs", "ts", "tsx", "js", "jsx", "go", "java", "cs", "rb", "cpp", "cc",
    "cxx", "hpp", "c", "h", "php", "swift", "kt", "kts",
];

/// Directories we never descend into during the worktree scan.
const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", "dist", ".aura"];

/// Best-effort load of the semantic graph nodes for analysis.
///
/// Returns `(nodes, source, staleness_secs)`. Never errors: on any failure it
/// degrades to a worktree scan, then to an empty `None` graph.
fn load_graph_nodes(repo_root: &Path, file: &str) -> (Vec<AstNode>, GraphSource, Option<u64>) {
    // --- Attempt 1: newest checkpoint ---
    if let Ok(repo) = git2::Repository::open(repo_root) {
        if let Ok(Some(newest)) = CheckpointStore::latest_checkpoint(&repo) {
            let staleness = newest.age_secs();
            let mut nodes = newest.ast_nodes;
            merge_current_file(&mut nodes, repo_root, file);
            return (nodes, GraphSource::Checkpoint, Some(staleness));
        }
    }

    // --- Attempt 2: bounded worktree scan ---
    let scanned = scan_worktree(repo_root);
    if !scanned.is_empty() {
        return (scanned, GraphSource::Worktree, None);
    }

    // --- Attempt 3: nothing ---
    (Vec::new(), GraphSource::None, None)
}

/// Multi-file variant of [`load_graph_nodes`] for `analyze_changes`: load the
/// base graph once (newest checkpoint → bounded worktree scan → none), then
/// refresh *every* seed file from disk so each one's caller picture is current.
fn load_graph_nodes_multi(
    repo_root: &Path,
    files: &[&str],
) -> (Vec<AstNode>, GraphSource, Option<u64>) {
    // --- Attempt 1: newest checkpoint, with each seed file re-parsed ---
    if let Ok(repo) = git2::Repository::open(repo_root) {
        if let Ok(Some(newest)) = CheckpointStore::latest_checkpoint(&repo) {
            let staleness = newest.age_secs();
            let mut nodes = newest.ast_nodes;
            for file in files {
                merge_current_file(&mut nodes, repo_root, file);
            }
            return (nodes, GraphSource::Checkpoint, Some(staleness));
        }
    }

    // --- Attempt 2: bounded worktree scan (already current on disk) ---
    let scanned = scan_worktree(repo_root);
    if !scanned.is_empty() {
        return (scanned, GraphSource::Worktree, None);
    }

    // --- Attempt 3: nothing ---
    (Vec::new(), GraphSource::None, None)
}

/// Re-parse the on-disk `file` and splice it into `nodes`, replacing any nodes
/// whose `file_path` points at the same file so the caller picture is current.
/// Failures are swallowed — we keep the checkpoint's view of the file.
fn merge_current_file(nodes: &mut Vec<AstNode>, repo_root: &Path, file: &str) {
    let abs = resolve_path(repo_root, file);
    let ext = match abs.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_string(),
        None => return,
    };
    let source = match std::fs::read_to_string(&abs) {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return,
    };
    let fresh = match parser.parse_file_with_path(&source, &ext, file) {
        Ok(n) => n,
        Err(_) => return,
    };

    // Drop the checkpoint's nodes for this file (match on path tail so a
    // relative checkpoint path and our normalized one still line up), then add
    // the freshly parsed ones.
    nodes.retain(|n| !same_file(n.file_path.as_deref(), file));
    nodes.extend(fresh);
}

/// Bounded recursive scan of `repo_root` for source files, parsing each into
/// AST nodes. Honors a file cap and a wall-clock budget; partial results are
/// fine. Never panics.
fn scan_worktree(repo_root: &Path) -> Vec<AstNode> {
    let start = Instant::now();
    let mut out: Vec<AstNode> = Vec::new();
    let mut files_seen = 0usize;
    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return out,
    };

    // Manual stack walk so we can prune skip-dirs without an extra crate.
    let mut stack: Vec<std::path::PathBuf> = vec![repo_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if files_seen >= MAX_SCAN_FILES || start.elapsed().as_millis() > TIME_BUDGET_MS {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if files_seen >= MAX_SCAN_FILES || start.elapsed().as_millis() > TIME_BUDGET_MS {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                // Skip explicit skip-dirs and any dotdir (covers .git, .aura,
                // and editor/tooling caches) cheaply.
                if name.starts_with('.') || SKIP_DIRS.iter().any(|d| *d == name) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            let ext = match path.extension().and_then(|e| e.to_str()) {
                Some(e) => e,
                None => continue,
            };
            if !SOURCE_EXTS.contains(&ext) {
                continue;
            }
            files_seen += 1;
            let rel = rel_path(repo_root, &path);
            if let Ok(source) = std::fs::read_to_string(&path) {
                if let Ok(nodes) = parser.parse_file_with_path(&source, ext, &rel) {
                    out.extend(nodes);
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Pure reasoning core (no git/IO) — unit-tested directly
// ---------------------------------------------------------------------------

/// Build a [`DeleteImpact`] from an already-loaded node set. This is the pure
/// heart of the engine: it does the reverse-BFS, entry-point classification,
/// and summary/severity selection with no git or filesystem access (aside from
/// `entrypoints::classify`, which the caller controls via `repo_root`).
///
/// `analyze_deletion` delegates here after loading nodes; tests construct nodes
/// directly. The returned `graph_source` is left as `"worktree"` and
/// `graph_staleness_secs` as `None`; `analyze_deletion` overwrites both with the
/// real provenance.
fn build_impact_from_nodes(
    nodes: &[AstNode],
    file: &str,
    removed_symbols: &[String],
    repo_root: &Path,
) -> DeleteImpact {
    if nodes.is_empty() || removed_symbols.is_empty() {
        return unknown_impact("worktree", None);
    }

    let graph = ReverseGraph::build(nodes);
    if graph.is_empty() {
        return unknown_impact("worktree", None);
    }

    let start = Instant::now();
    let mut truncated = false;
    let mut any_def_resolved = false;

    // node_id -> min hops from any removed symbol (0 = the removed def itself).
    let mut min_hops: HashMap<String, usize> = HashMap::new();
    // Edge confidence by which we *first* reached each caller node (for display).
    let mut reach_conf: HashMap<String, EdgeConfidence> = HashMap::new();
    // BFS predecessor on the shortest path found: caller node_id -> the
    // closer-to-removed node we expanded from. Lets us reconstruct the call
    // chain from an entry point down to the removed symbol (the "because").
    let mut came_from: HashMap<String, String> = HashMap::new();
    let mut name_only_edges = 0usize;
    let mut total_edges = 0usize;

    // Reverse-BFS from every removed symbol's definition.
    for symbol in removed_symbols {
        let start_id = match graph.resolve_def(symbol, Some(file)) {
            Some(id) => {
                any_def_resolved = true;
                id
            }
            // Symbol had no def in the graph — count it (handled via
            // `any_def_resolved` / leaf logic) but it contributes no callers.
            None => continue,
        };

        // BFS frontier of (node_id, depth). The starting def sits at depth 0.
        let mut frontier: Vec<(String, usize)> = vec![(start_id.clone(), 0)];
        min_hops.entry(start_id).or_insert(0);

        while let Some((node_id, depth)) = frontier.pop() {
            if depth >= MAX_DEPTH {
                // At the depth wall: a node here is still a counted caller, but
                // we won't expand it. Only flag truncation if it *actually* has
                // further callers we're now suppressing (avoids false positives
                // on fully-explored shallow graphs).
                if !graph.callers_of_node(&node_id).is_empty() {
                    truncated = true;
                }
                continue;
            }
            if min_hops.len() >= VISIT_BUDGET
                || start.elapsed().as_millis() > TIME_BUDGET_MS
            {
                truncated = true;
                break;
            }

            let callers = graph.callers_of_node(&node_id);
            for CallerEdge { caller_node_id, confidence } in callers {
                total_edges += 1;
                if matches!(confidence, EdgeConfidence::NameOnly) {
                    name_only_edges += 1;
                }
                let hop = depth + 1;
                let improved = match min_hops.get(&caller_node_id) {
                    Some(&existing) => hop < existing,
                    None => true,
                };
                if improved {
                    min_hops.insert(caller_node_id.clone(), hop);
                    reach_conf.insert(caller_node_id.clone(), confidence);
                    came_from.insert(caller_node_id.clone(), node_id.clone());
                    if min_hops.len() >= VISIT_BUDGET {
                        truncated = true;
                        break;
                    }
                    frontier.push((caller_node_id, hop));
                }
            }
        }
    }

    // ---- Direct callers (hop == 1), de-duped by node ----
    let mut direct_callers: Vec<CallerInfo> = Vec::new();
    let mut seen_direct: HashSet<String> = HashSet::new();
    for (node_id, &hops) in min_hops.iter() {
        if hops != 1 {
            continue;
        }
        if !seen_direct.insert(node_id.clone()) {
            continue;
        }
        if let Some(node) = graph.node(node_id) {
            let conf = reach_conf
                .get(node_id)
                .copied()
                .unwrap_or(EdgeConfidence::NameOnly);
            direct_callers.push(CallerInfo {
                symbol: node
                    .identifier
                    .clone()
                    .unwrap_or_else(|| "<anonymous>".to_string()),
                file: node.file_path.clone(),
                kind: node.kind.clone(),
                confidence: confidence_str(conf).to_string(),
            });
        }
    }
    // Stable, friendly ordering for the card.
    direct_callers.sort_by(|a, b| a.symbol.cmp(&b.symbol));

    // transitive count = all distinct callers reached (everything except the
    // removed defs themselves at hop 0).
    let transitive_caller_count = min_hops.values().filter(|&&h| h > 0).count();

    // ---- Entry-point classification over every reached caller node ----
    let mut features: Vec<FeatureImpact> = Vec::new();
    let mut seen_feat: HashSet<(String, String)> = HashSet::new();
    for (node_id, &hops) in min_hops.iter() {
        if hops == 0 {
            continue; // skip the removed defs themselves
        }
        let node = match graph.node(node_id) {
            Some(n) => n,
            None => continue,
        };
        if let Some(EntryPoint { kind, feature_name, entry_symbol, file: ef }) =
            entrypoints::classify(node, repo_root)
        {
            let key = (feature_name.clone(), ef.clone());
            if !seen_feat.insert(key) {
                continue;
            }
            features.push(FeatureImpact {
                name: feature_name,
                kind: entry_kind_str(kind).to_string(),
                entry_symbol,
                file: ef,
                hops,
                path: reconstruct_path(&graph, &came_from, &min_hops, node_id),
            });
        }
    }
    features.sort_by(|a, b| a.hops.cmp(&b.hops).then_with(|| a.name.cmp(&b.name)));

    // ---- Severity + summary ----
    let leaf = transitive_caller_count == 0 && any_def_resolved;
    let (severity, summary) = decide_severity_and_summary(
        file,
        removed_symbols,
        any_def_resolved,
        leaf,
        &direct_callers,
        transitive_caller_count,
        &features,
    );

    // The pure builder assumes worktree-grade provenance; `analyze_deletion`
    // recomputes confidence with real checkpoint freshness afterward.
    let name_only_ratio = if total_edges == 0 {
        0.0
    } else {
        name_only_edges as f64 / total_edges as f64
    };
    let confidence = derive_confidence(
        severity,
        GraphSource::Worktree,
        None,
        truncated,
        name_only_ratio,
        any_def_resolved,
    );

    DeleteImpact {
        summary,
        severity,
        leaf,
        direct_callers,
        transitive_caller_count,
        features,
        confidence,
        hedge: HEDGE.to_string(),
        graph_source: "worktree".to_string(),
        graph_staleness_secs: None,
        truncated,
    }
}

/// Pick severity and the human summary sentence from the graph facts.
fn decide_severity_and_summary(
    file: &str,
    removed_symbols: &[String],
    any_def_resolved: bool,
    leaf: bool,
    direct_callers: &[CallerInfo],
    transitive_caller_count: usize,
    features: &[FeatureImpact],
) -> (ImpactSeverity, String) {
    // No definition for any removed symbol and nothing reached → can't reason.
    if !any_def_resolved && transitive_caller_count == 0 {
        return (
            ImpactSeverity::Unknown,
            UNKNOWN_SUMMARY.to_string(),
        );
    }

    if !features.is_empty() {
        return (ImpactSeverity::FeatureLoss, feature_summary(file, removed_symbols, features));
    }

    if leaf {
        let name = primary_symbol(removed_symbols, file);
        return (
            ImpactSeverity::LeafSafe,
            format!(
                "No callers found in the graph for `{}` — likely safe to delete. \
                 Verify there are no dynamic/string/reflection references.",
                name
            ),
        );
    }

    // Callers exist but no features.
    (
        ImpactSeverity::CallersOnly,
        callers_only_summary(direct_callers, transitive_caller_count),
    )
}

/// Build the "Used by `a`, `b` (+N more)" sentence for the callers-only case.
fn callers_only_summary(direct_callers: &[CallerInfo], transitive: usize) -> String {
    let shown: Vec<String> = direct_callers
        .iter()
        .take(3)
        .map(|c| format!("`{}`", c.symbol))
        .collect();
    let extra = transitive.saturating_sub(shown.len());
    let names = if shown.is_empty() {
        // No hop-1 callers but transitive>0 (deeper-only) — keep it honest.
        format!("{} downstream caller(s)", transitive)
    } else if extra > 0 {
        format!("{} (+{} more)", shown.join(", "), extra)
    } else {
        shown.join(", ")
    };
    format!(
        "Used by {} — no user-facing feature reached within {} hops.",
        names, MAX_DEPTH
    )
}

/// Build the feature-loss sentence, scaling phrasing by feature count. Names
/// not just *which* feature breaks but *how* — the call chain that reaches it.
fn feature_summary(file: &str, removed_symbols: &[String], features: &[FeatureImpact]) -> String {
    let n = features.len();

    match n {
        1 => {
            let f = &features[0];
            // Single feature, single-ish symbol → name the symbol directly and
            // spell out the path that makes it break.
            let subject = primary_symbol(removed_symbols, file);
            format!("Deleting `{}` breaks **{}** — {}.", subject, f.name, explain_reach(f))
        }
        // A handful of features: name each with its entry symbol + nearest hop
        // so the human sees the concrete surface, not just a feature label.
        2 | 3 => {
            let list: Vec<String> = features
                .iter()
                .map(|f| format!("**{}** (via `{}`)", f.name, f.entry_symbol))
                .collect();
            format!("At least {} features depend on this: {}.", n, list.join(", "))
        }
        _ => {
            let lead: Vec<String> = features
                .iter()
                .take(3)
                .map(|f| format!("**{}**", f.name))
                .collect();
            format!(
                "At least {} features depend on this, including {}.",
                n,
                lead.join(", ")
            )
        }
    }
}

/// Spell out *how* a removed symbol reaches one entry point, using the call
/// chain: a direct call reads "the `x` command calls it directly"; a deeper
/// reach reads "… reaches it through `a` → `b`".
fn explain_reach(f: &FeatureImpact) -> String {
    let noun = entry_noun(&f.kind);
    // `path` is [entry, …, removed]. A direct call is length 2 (or hops == 1).
    if f.hops <= 1 || f.path.len() <= 2 {
        format!("the `{}` {} calls it directly", f.entry_symbol, noun)
    } else {
        // Skip the entry symbol itself (already named) and show the rest of the
        // chain down to the removed symbol.
        let chain: Vec<String> = f.path.iter().skip(1).map(|s| format!("`{}`", s)).collect();
        format!(
            "the `{}` {} reaches it through {}",
            f.entry_symbol,
            noun,
            chain.join(" → ")
        )
    }
}

/// Human noun for an entry kind, for prose.
fn entry_noun(kind: &str) -> &'static str {
    match kind {
        "tauri_command" => "command",
        "http_route" => "route",
        "cli_command" => "command",
        "ui_component" => "component",
        "public_api" => "API",
        _ => "entry point",
    }
}

/// Reconstruct the call chain from an entry-point node down to the removed
/// symbol that reached it: `[entry_symbol, …, removed_symbol]`. Walks the BFS
/// predecessor map back to a hop-0 root (a removed def). Falls back to just the
/// entry symbol if the chain can't be extended. Identifiers, not node ids.
fn reconstruct_path(
    graph: &ReverseGraph,
    came_from: &HashMap<String, String>,
    min_hops: &HashMap<String, usize>,
    entry_node_id: &str,
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut cur = entry_node_id.to_string();
    let mut guard = 0usize;
    loop {
        ids.push(cur.clone());
        if min_hops.get(&cur).copied() == Some(0) {
            break; // reached a removed-symbol def (a BFS root)
        }
        match came_from.get(&cur) {
            Some(prev) => cur = prev.clone(),
            None => break,
        }
        guard += 1;
        if guard > MAX_DEPTH + 2 {
            break; // defensive: never loop on a malformed predecessor map
        }
    }
    ids.iter()
        .map(|id| {
            graph
                .node(id)
                .and_then(|n| n.identifier.clone())
                .unwrap_or_else(|| "<anonymous>".to_string())
        })
        .collect()
}

/// Choose the symbol name to feature in a sentence: the lone removed symbol if
/// there is exactly one, otherwise the file (so multi-symbol deletes read
/// naturally around the file).
fn primary_symbol(removed_symbols: &[String], file: &str) -> String {
    match removed_symbols {
        [one] => one.clone(),
        _ => format!("symbols in {}", short_file(file)),
    }
}

/// Derive confidence from provenance, staleness, truncation, and ambiguity.
fn derive_confidence(
    severity: ImpactSeverity,
    source: GraphSource,
    staleness: Option<u64>,
    truncated: bool,
    name_only_ratio: f64,
    resolved: bool,
) -> Confidence {
    // Unknown verdicts are inherently low-confidence.
    if matches!(severity, ImpactSeverity::Unknown) {
        return Confidence::Low;
    }

    // Start from a provenance ceiling.
    let mut conf = match source {
        GraphSource::Checkpoint => {
            let fresh = staleness.map(|s| s < FRESH_SECS).unwrap_or(false);
            if fresh && resolved {
                Confidence::High
            } else {
                Confidence::Medium
            }
        }
        GraphSource::Worktree => Confidence::Medium,
        GraphSource::None => Confidence::Low,
    };

    // Drag down on ambiguity / staleness / truncation.
    let stale = staleness.map(|s| s > STALE_SECS).unwrap_or(false);
    let ambiguous = name_only_ratio > 0.5;
    if conf_rank(conf) > conf_rank(Confidence::Medium) && (ambiguous || stale || truncated) {
        conf = Confidence::Medium;
    }
    if ambiguous && (stale || truncated) {
        conf = Confidence::Low;
    }
    conf
}

/// Estimate the share of NameOnly edges from a finished impact, used by
/// `analyze_deletion`'s confidence recompute. Direct-caller confidences are the
/// observable proxy we have post-hoc.
fn impact_name_only_ratio(impact: &DeleteImpact) -> f64 {
    if impact.direct_callers.is_empty() {
        return 0.0;
    }
    let name_only = impact
        .direct_callers
        .iter()
        .filter(|c| c.confidence == "name_only")
        .count();
    name_only as f64 / impact.direct_callers.len() as f64
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// The always-present hedge line for the gate card.
const HEDGE: &str = "Static analysis only — dynamic dispatch, string-keyed lookups, \
reflection, and network/FFI calls are invisible, so real impact may be wider. \
Counts are a floor (\"at least\").";

/// Summary used whenever we genuinely cannot analyze.
const UNKNOWN_SUMMARY: &str =
    "Couldn't analyze impact (no semantic graph captured yet). Treat as potentially breaking.";

/// Construct an `Unknown` impact with the given provenance.
fn unknown_impact(graph_source: &str, staleness: Option<u64>) -> DeleteImpact {
    DeleteImpact {
        summary: UNKNOWN_SUMMARY.to_string(),
        severity: ImpactSeverity::Unknown,
        leaf: false,
        direct_callers: Vec::new(),
        transitive_caller_count: 0,
        features: Vec::new(),
        confidence: Confidence::Low,
        hedge: HEDGE.to_string(),
        graph_source: graph_source.to_string(),
        graph_staleness_secs: staleness,
        truncated: false,
    }
}

/// Serialize an [`EdgeConfidence`] to the card's string form.
fn confidence_str(c: EdgeConfidence) -> &'static str {
    match c {
        EdgeConfidence::Exact => "exact",
        EdgeConfidence::ImportResolved => "import_resolved",
        EdgeConfidence::NameOnly => "name_only",
    }
}

/// Serialize an [`EntryKind`] to snake_case (matching its serde rename).
fn entry_kind_str(k: EntryKind) -> &'static str {
    match k {
        EntryKind::TauriCommand => "tauri_command",
        EntryKind::HttpRoute => "http_route",
        EntryKind::CliCommand => "cli_command",
        EntryKind::UiComponent => "ui_component",
        EntryKind::PublicApi => "public_api",
    }
}

/// Total order over confidence for monotone comparisons (High > Medium > Low).
fn conf_rank(c: Confidence) -> u8 {
    match c {
        Confidence::Low => 0,
        Confidence::Medium => 1,
        Confidence::High => 2,
    }
}

/// True if `path` (possibly relative, possibly normalized) refers to `file`.
/// We compare on path tails so checkpoint-relative and our normalized paths
/// reconcile (`src/foo.rs` vs `./src/foo.rs` vs an absolute path ending the same).
fn same_file(path: Option<&str>, file: &str) -> bool {
    match path {
        Some(p) => {
            let pn = normalize_sep(p);
            let fn_ = normalize_sep(file);
            pn == fn_ || pn.ends_with(&fn_) || fn_.ends_with(&pn)
        }
        None => false,
    }
}

/// Normalize separators and strip a leading `./` for path comparison.
fn normalize_sep(p: &str) -> String {
    let p = p.replace('\\', "/");
    p.strip_prefix("./").map(|s| s.to_string()).unwrap_or(p)
}

/// Resolve `file` against `repo_root` if it is relative.
fn resolve_path(repo_root: &Path, file: &str) -> std::path::PathBuf {
    let p = Path::new(file);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        repo_root.join(p)
    }
}

/// Path of `path` relative to `repo_root` (forward-slashed), falling back to the
/// lossy full path if it is not under the root.
fn rel_path(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

/// Shorten a file path to its last component for prose.
fn short_file(file: &str) -> String {
    normalize_sep(file)
        .rsplit('/')
        .next()
        .unwrap_or(file)
        .to_string()
}

// ---------------------------------------------------------------------------
// Tests — exercise the pure builder with hand-built nodes (no git/IO).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal AstNode builder for tests.
    fn node(id: &str, ident: &str, kind: &str, file: &str) -> AstNode {
        AstNode {
            node_id: id.to_string(),
            kind: kind.to_string(),
            identifier: Some(ident.to_string()),
            content_hash: format!("hash-{id}"),
            children: Vec::new(),
            dependencies: Vec::new(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some(file.to_string()),
            start_line: Some(1),
            end_line: Some(2),
            signature: None,
            doc_comment: None,
            top_level: true,
        }
    }

    #[test]
    fn leaf_with_no_callers_is_safe() {
        // A lone function that resolves but nothing calls → LeafSafe.
        let nodes = vec![node("n_leaf", "orphan_helper", "function_definition", "src/util.rs")];
        let impact = build_impact_from_nodes(
            &nodes,
            "src/util.rs",
            &["orphan_helper".to_string()],
            Path::new("/tmp/does-not-matter"),
        );
        assert!(matches!(impact.severity, ImpactSeverity::LeafSafe));
        assert!(impact.leaf, "a callerless resolved symbol must be a leaf");
        assert_eq!(impact.transitive_caller_count, 0);
        assert!(impact.direct_callers.is_empty());
        assert!(impact.features.is_empty());
        assert!(impact.summary.contains("orphan_helper"));
        assert!(impact.summary.to_lowercase().contains("likely safe"));
        assert!(!impact.hedge.is_empty());
    }

    #[test]
    fn callers_only_chain_has_no_features() {
        // use_compute → compute, but use_compute is just an internal function
        // (not an entry point), so we expect CallersOnly with one direct caller.
        let target = node("n_target", "compute", "function_definition", "src/math.rs");
        let mut caller = node("n_caller", "use_compute", "function_definition", "src/math.rs");
        // Wire the call edge the test relies on (the bare `node()` builder
        // leaves `dependencies` empty).
        caller.dependencies.push(crate::models::DependencyUri {
            name: "compute".to_string(),
            uri: None,
        });
        let nodes = vec![target, caller];
        let impact = build_impact_from_nodes(
            &nodes,
            "src/math.rs",
            &["compute".to_string()],
            Path::new("/tmp/does-not-matter"),
        );
        assert!(
            matches!(impact.severity, ImpactSeverity::CallersOnly),
            "expected CallersOnly, got {:?}",
            impact.severity
        );
        assert!(!impact.leaf);
        assert_eq!(impact.transitive_caller_count, 1);
        assert_eq!(impact.direct_callers.len(), 1);
        assert_eq!(impact.direct_callers[0].symbol, "use_compute");
        assert!(impact.features.is_empty());
        assert!(impact.summary.contains("use_compute"));
        assert!(impact.summary.contains(&format!("{} hops", MAX_DEPTH)));
    }

    #[test]
    fn missing_symbol_with_empty_graph_is_unknown() {
        // Empty node set → can't even build a graph → Unknown, never panic.
        let impact = build_impact_from_nodes(
            &[],
            "src/ghost.rs",
            &["nonexistent".to_string()],
            Path::new("/tmp/does-not-matter"),
        );
        assert!(matches!(impact.severity, ImpactSeverity::Unknown));
        assert!(matches!(impact.confidence, Confidence::Low));
        assert!(!impact.leaf);
        assert!(impact.summary.to_lowercase().contains("couldn't analyze"));
    }

    #[test]
    fn symbol_absent_from_populated_graph_is_unknown() {
        // The graph has nodes, but `resolve_def` won't find our symbol and no
        // caller is reached → Unknown (we knew nothing about it).
        let nodes = vec![node("n_other", "unrelated", "function_definition", "src/other.rs")];
        let impact = build_impact_from_nodes(
            &nodes,
            "src/math.rs",
            &["does_not_exist".to_string()],
            Path::new("/tmp/does-not-matter"),
        );
        assert!(matches!(impact.severity, ImpactSeverity::Unknown));
        assert!(matches!(impact.confidence, Confidence::Low));
    }

    #[test]
    fn json_round_trips_camel_and_snake_case() {
        let nodes = vec![node("n_leaf", "orphan", "function_definition", "src/u.rs")];
        let impact = build_impact_from_nodes(
            &nodes,
            "src/u.rs",
            &["orphan".to_string()],
            Path::new("/tmp/x"),
        );
        let v = to_json(&impact);
        // camelCase struct fields:
        assert!(v.get("directCallers").is_some());
        assert!(v.get("transitiveCallerCount").is_some());
        assert!(v.get("graphSource").is_some());
        // snake_case enum value:
        assert_eq!(v.get("severity").and_then(|s| s.as_str()), Some("leaf_safe"));
        // Option<u64> skipped when None:
        assert!(v.get("graphStalenessSecs").is_none());
    }

    /// Build a `FeatureImpact` for the copy tests below.
    fn feat(name: &str, kind: &str, entry: &str, hops: usize, path: &[&str]) -> FeatureImpact {
        FeatureImpact {
            name: name.to_string(),
            kind: kind.to_string(),
            entry_symbol: entry.to_string(),
            file: "src-tauri/src/auth.rs".to_string(),
            hops,
            path: path.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn direct_feature_summary_names_the_command_path() {
        // verify_token is called directly by the Tauri command sign_in_cmd.
        let f = feat("Sign In", "tauri_command", "sign_in_cmd", 1, &["sign_in_cmd", "verify_token"]);
        let s = feature_summary("src-tauri/src/auth.rs", &["verify_token".to_string()], &[f]);
        assert!(s.contains("breaks **Sign In**"), "got: {s}");
        assert!(s.contains("`sign_in_cmd` command calls it directly"), "got: {s}");
    }

    #[test]
    fn multi_hop_feature_summary_spells_out_the_chain() {
        // verify_token <- check_session <- sign_in_cmd (the command), 2 hops.
        let f = feat(
            "Sign In",
            "tauri_command",
            "sign_in_cmd",
            2,
            &["sign_in_cmd", "check_session", "verify_token"],
        );
        let s = feature_summary("src-tauri/src/auth.rs", &["verify_token".to_string()], &[f]);
        assert!(s.contains("reaches it through"), "got: {s}");
        // The entry symbol is named once; the chain shows the rest down to the
        // removed symbol.
        assert!(s.contains("`check_session` → `verify_token`"), "got: {s}");
    }

    #[test]
    fn two_features_each_name_their_entry_symbol() {
        let a = feat("Sign In", "tauri_command", "sign_in_cmd", 1, &["sign_in_cmd", "verify_token"]);
        let b = feat("Export", "http_route", "export_handler", 1, &["export_handler", "verify_token"]);
        let s = feature_summary("src-tauri/src/auth.rs", &["verify_token".to_string()], &[a, b]);
        assert!(s.contains("At least 2 features"), "got: {s}");
        assert!(s.contains("**Sign In** (via `sign_in_cmd`)"), "got: {s}");
        assert!(s.contains("**Export** (via `export_handler`)"), "got: {s}");
    }
}
