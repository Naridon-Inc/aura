//! Project-wide knowledge graph (graphify port). Walks the repo,
//! extracts symbol nodes (function/class/type/module) plus file and
//! optional doc nodes, builds edges for imports + symbol references,
//! runs label-propagation community detection, flags god nodes and
//! surprise edges. Persisted at `.aura/kg/graph.json`.
//!
//! Zero external deps — uses the same regex outline as
//! `aura_semantic_outline` plus a cheap symbol-reference scan. Good
//! enough for an MVP graph view; can swap to a real tree-sitter pass
//! later without changing the on-disk schema.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const SOURCE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "py", "go", "java", "kt",
];
const DOC_EXTS: &[&str] = &["md", "mdx"];
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".aura",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    "vendor",
    "third_party",
];

/// A name this many symbols share (`new`, `init`, `get`…) carries no signal —
/// linking every occurrence of it to every symbol wearing it is what turned a
/// real-sized repo into edge soup the annotator then chewed on for minutes.
const MAX_TARGETS_PER_NAME: usize = 8;
/// Per-file ceilings: one generated file that mentions everything still only
/// contributes a bounded slice of edges.
const MAX_REF_EDGES_PER_FILE: usize = 300;
const MAX_MENTION_EDGES_PER_DOC: usize = 120;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KgNode {
    pub id: String,
    /// "file" | "fn" | "class" | "type" | "doc" | "section"
    pub kind: String,
    pub name: String,
    pub file: String,
    pub line: u32,
    #[serde(default)]
    pub degree: usize,
    #[serde(default)]
    pub community_id: usize,
    #[serde(default)]
    pub god: bool,
    /// Where this node's identity comes from (AUDIT-GRF-01).
    /// "checkpoint" = `id` IS the canonical rename-proof `node_id` the CLI,
    /// Atlas and rewind all use — the consolidated identity. "outline" =
    /// positional fallback minted by the regex walker for symbols the
    /// checkpoint store has never seen (and for file/doc nodes, whose
    /// identity is their path).
    #[serde(default = "default_provenance")]
    pub provenance: String,
    /// Canonical content hash, present when provenance == "checkpoint".
    #[serde(default)]
    pub content_hash: Option<String>,
}

fn default_provenance() -> String {
    "outline".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct KgEdge {
    pub from: String,
    pub to: String,
    /// "contains" | "calls" | "references" | "imports" | "mentions"
    pub kind: String,
    #[serde(default)]
    pub surprise: bool,
    /// How the canonical exporter resolved a `calls` edge: "exact" (the
    /// callee is defined in the same file), "import-resolved" (it followed an
    /// import to the definition) or "name-only" (a bare identifier match —
    /// a guess, and by far the most common). `None` on edges the outline
    /// walk minted. Consumers that tell a story (feature flows) follow only
    /// the first two; a bare match is never presented as a fact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

/// Current on-disk schema. v0/v1 (no `schema_version` field) graphs still
/// deserialize via serde defaults — an old repository keeps serving views
/// with no loss — but `aura_kg_ensure` treats them as stale and rebuilds,
/// which is the migration: the sources (repo + checkpoints) are still
/// present, so the upgrade is a lossless re-derivation.
pub const KG_SCHEMA_VERSION: u32 = 3;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct KgGraph {
    pub nodes: Vec<KgNode>,
    pub edges: Vec<KgEdge>,
    /// Unix seconds when the graph was built.
    pub built_at: u64,
    /// Repo HEAD sha at build time. Used to invalidate the cache when
    /// a commit lands.
    pub head_sha: String,
    /// Counts surfaced for the UI header so it doesn't have to recount.
    pub stats: KgStats,
    /// See [`KG_SCHEMA_VERSION`]. 0 = legacy graph written before GRF-01.
    #[serde(default)]
    pub schema_version: u32,
    /// Canonicalized worktree root this graph was built for. Reads for a
    /// different root refuse the graph (treated as absent → rebuilt) so
    /// two worktrees can never silently serve each other's graphs.
    #[serde(default)]
    pub scope_root: String,
    /// Version hash of the checkpoint view joined into this graph, empty
    /// when no canonical export was available at build time. The same
    /// value `aura graph` prints — the cross-surface provenance stamp.
    #[serde(default)]
    pub graph_version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct KgStats {
    pub files: usize,
    pub symbols: usize,
    pub docs: usize,
    pub edges: usize,
    pub communities: usize,
    pub gods: usize,
    pub surprises: usize,
    /// How many symbol nodes carry the canonical checkpoint identity.
    #[serde(default)]
    pub canonical: usize,
}

fn cache_path(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root)
        .join(".aura")
        .join("kg")
        .join("graph.json")
}

fn current_head_sha(repo_root: &str) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub async fn aura_kg_load(repo_root: String) -> Result<Option<KgGraph>, String> {
    crate::blocking::run(move || {
        let path = cache_path(&repo_root);
        if !path.exists() {
            return Ok(None);
        }
        let body = fs::read_to_string(&path).map_err(|e| format!("read kg: {e}"))?;
        let g: KgGraph = serde_json::from_str(&body).map_err(|e| format!("parse kg: {e}"))?;
        Ok(Some(g))
    })
    .await
}

#[tauri::command]
pub async fn aura_kg_build(repo_root: String, force: bool) -> Result<KgGraph, String> {
    let prep_root = repo_root.clone();
    let (path, head) =
        crate::blocking::run(move || (cache_path(&prep_root), current_head_sha(&prep_root))).await;
    // Cache hit: same HEAD sha, current schema, and not forced → cached.
    if !force {
        if let Ok(Some(g)) = aura_kg_load(repo_root.clone()).await {
            if !head.is_empty() && g.head_sha == head && g.schema_version >= KG_SCHEMA_VERSION {
                return Ok(g);
            }
        }
    }

    // The three walks read every source and doc file in the repo — off the
    // async runtime, so a big repo never stalls the UI thread.
    let walk_root = repo_root.clone();
    let (mut nodes, mut edges) = crate::blocking::run(move || {
        let repo_root = walk_root;
        let mut nodes: Vec<KgNode> = Vec::new();
        let mut edges: Vec<KgEdge> = Vec::new();
        let mut symbol_index: HashMap<String, Vec<String>> = HashMap::new(); // name -> [node_id]

        walk(&PathBuf::from(&repo_root), &repo_root, &mut |rel_path, abs_path| {
            let ext = rel_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let rel_str = rel_path.to_string_lossy().to_string();
            if SOURCE_EXTS.contains(&ext.as_str()) {
                let body = fs::read_to_string(abs_path).unwrap_or_default();
                ingest_source(&rel_str, &body, &mut nodes, &mut edges, &mut symbol_index);
            } else if DOC_EXTS.contains(&ext.as_str()) {
                let body = fs::read_to_string(abs_path).unwrap_or_default();
                ingest_doc(&rel_str, &body, &mut nodes, &mut edges, &symbol_index);
            }
        });

        // Second pass for source-symbol references — needs the full
        // symbol_index built above.
        walk(&PathBuf::from(&repo_root), &repo_root, &mut |rel_path, abs_path| {
            let ext = rel_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !SOURCE_EXTS.contains(&ext.as_str()) {
                return;
            }
            let body = fs::read_to_string(abs_path).unwrap_or_default();
            let rel_str = rel_path.to_string_lossy().to_string();
            let file_id = format!("file:{rel_str}");
            scan_references(&file_id, &body, &symbol_index, &mut edges);
        });

        // Doc mention pass — re-run mention extraction now that we have
        // the full source-symbol index. ingest_doc above only added nodes;
        // we add mention edges here so they're complete.
        walk(&PathBuf::from(&repo_root), &repo_root, &mut |rel_path, abs_path| {
            let ext = rel_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !DOC_EXTS.contains(&ext.as_str()) {
                return;
            }
            let body = fs::read_to_string(abs_path).unwrap_or_default();
            let rel_str = rel_path.to_string_lossy().to_string();
            let doc_id = format!("doc:{rel_str}");
            scan_mentions(&doc_id, &body, &symbol_index, &mut edges);
        });
        (nodes, edges)
    })
    .await;

    // Canonical join (GRF-01): adopt the checkpoint store's rename-proof
    // node ids wherever the CLI can vouch for a symbol, so the map answers
    // with the same identity as why / Atlas / rewind. Best-effort — a repo
    // with no checkpoints (or no CLI on PATH) keeps its outline identities,
    // explicitly labeled as such.
    let mut graph_version = String::new();
    if let Some(export) = fetch_canonical_export(&repo_root).await {
        graph_version = export.graph_version.clone();
        join_canonical(&mut nodes, &mut edges, &export);
    }

    // Annotation and the atomic cache write are both CPU/IO bound.
    crate::blocking::run(move || {
        // Compute degrees, communities, god flags, surprise flags.
        annotate(&mut nodes, &mut edges);

        let stats = compute_stats(&nodes, &edges);
        let graph = KgGraph {
            nodes,
            edges,
            built_at: now_secs(),
            head_sha: head,
            stats,
            schema_version: KG_SCHEMA_VERSION,
            scope_root: scope_root_for(&repo_root),
            graph_version,
        };

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir kg dir: {e}"))?;
        }
        // Compact, not pretty: graph.json is a machine cache, and pretty-
        // printing a multi-MB graph both bloats it ~2x and slows the write.
        let body = serde_json::to_string(&graph).map_err(|e| format!("serialize kg: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, body).map_err(|e| format!("write kg: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("rename kg: {e}"))?;
        Ok(graph)
    })
    .await
}

// ---------------------------------------------------------------------------
// Canonical identity join (GRF-01). The CLI's `aura graph export` is the
// one graph store: symbols keyed by the rename-proof, content-hashed
// `node_id` minted from the checkpoint AST — the same id Atlas keys its
// directory by, rewind targets, and query/path/explain cite. The desktop
// build joins its regex outline against that export and ADOPTS the
// canonical id as the KG node id, demoting positional `fn:{file}#{name}@{line}`
// ids to an explicitly-labeled "outline" fallback. One symbol, one id,
// every surface.
// ---------------------------------------------------------------------------

/// Highest canonical export schema this reader understands.
pub const SUPPORTED_CANONICAL_SCHEMA: u32 = 1;

/// Mirror of the CLI's `CanonicalGraph` (aura-cli/src/graph_store.rs).
/// Deserialization is tolerant (serde defaults) so a slightly newer minor
/// shape still parses; a `schema_version` above [`SUPPORTED_CANONICAL_SCHEMA`]
/// is refused outright by the fetcher.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct CanonicalExport {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub graph_version: String,
    #[serde(default)]
    pub repo_root: String,
    #[serde(default)]
    pub head_sha: String,
    #[serde(default)]
    pub symbols: Vec<CanonicalSymbolIn>,
    #[serde(default)]
    pub edges: Vec<CanonicalEdgeIn>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct CanonicalSymbolIn {
    pub node_id: String,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default)]
    pub identifier: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct CanonicalEdgeIn {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub kind: String,
    /// "exact" | "import-resolved" | "name-only" — see [`KgEdge::label`].
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub confidence: Option<f32>,
}

/// Canonicalized worktree root — the scope stamp written into the graph
/// and compared on every cached read.
fn scope_root_for(repo_root: &str) -> String {
    fs::canonicalize(repo_root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| repo_root.to_string())
}

/// Map a parser kind ("function_definition", "class_definition", …) onto
/// the KG's coarse node kinds.
fn map_canonical_kind(kind: &str) -> &'static str {
    if kind.contains("class") || kind.contains("struct") || kind.contains("impl") {
        "class"
    } else if kind.contains("function") || kind.contains("method") {
        "fn"
    } else {
        "type"
    }
}

/// Run `aura graph export` for the repo and parse the canonical store.
/// `None` on any failure — no CLI, no checkpoints, unreadable output, or
/// an export schema newer than this reader understands.
async fn fetch_canonical_export(repo_root: &str) -> Option<CanonicalExport> {
    let bin = crate::agent_event_listener::resolve_aura_bin();
    let fut = tokio::process::Command::new(bin)
        .args(["graph", "export"])
        .current_dir(repo_root)
        .output();
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), fut)
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let export: CanonicalExport = serde_json::from_slice(&out.stdout).ok()?;
    if export.schema_version > SUPPORTED_CANONICAL_SCHEMA {
        return None;
    }
    Some(export)
}

/// Adopt canonical identities into the outline graph, in place:
/// - an outline symbol matched by (file, name) — nearest line on ties —
///   is RE-KEYED to the canonical `node_id` (provenance "checkpoint");
/// - canonical symbols the outline missed are added as new nodes;
/// - all existing edges are remapped through the re-keying;
/// - canonical call edges between adopted ids are merged in (deduped).
///
/// Returns how many nodes ended up canonical. Pure — unit-testable with a
/// synthetic export.
pub fn join_canonical(
    nodes: &mut Vec<KgNode>,
    edges: &mut Vec<KgEdge>,
    export: &CanonicalExport,
) -> usize {
    // (file, name) → indices of outline symbol nodes.
    let mut by_key: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        if matches!(n.kind.as_str(), "fn" | "class" | "type") {
            by_key
                .entry((n.file.clone(), n.name.clone()))
                .or_default()
                .push(i);
        }
    }
    let file_ids: HashSet<String> = nodes
        .iter()
        .filter(|n| n.kind == "file")
        .map(|n| n.id.clone())
        .collect();

    let mut rename: HashMap<String, String> = HashMap::new();
    let mut used: HashSet<usize> = HashSet::new();
    let mut appended: Vec<KgNode> = Vec::new();
    let mut appended_edges: Vec<KgEdge> = Vec::new();
    let mut canonical_ids: HashSet<String> = HashSet::new();

    for sym in &export.symbols {
        if sym.node_id.is_empty() || sym.identifier.is_empty() {
            continue;
        }
        let file = sym.file.clone().unwrap_or_default();
        let target = sym.line.unwrap_or(0) as i64;
        let candidate = by_key
            .get(&(file.clone(), sym.identifier.clone()))
            .and_then(|idxs| {
                idxs.iter()
                    .filter(|i| !used.contains(*i))
                    .min_by_key(|i| (nodes[**i].line as i64 - target).abs())
                    .copied()
            });
        match candidate {
            Some(i) => {
                used.insert(i);
                let node = &mut nodes[i];
                rename.insert(node.id.clone(), sym.node_id.clone());
                node.id = sym.node_id.clone();
                node.provenance = "checkpoint".to_string();
                node.content_hash = Some(sym.content_hash.clone());
                canonical_ids.insert(sym.node_id.clone());
            }
            None => {
                // The outline never saw this symbol (different language
                // coverage, or a file the walker skipped) — the checkpoint
                // still vouches for it, so it exists on the map.
                if file.is_empty() {
                    continue;
                }
                appended.push(KgNode {
                    id: sym.node_id.clone(),
                    kind: map_canonical_kind(&sym.kind).to_string(),
                    name: sym.identifier.clone(),
                    file: file.clone(),
                    line: sym.line.unwrap_or(0),
                    degree: 0,
                    community_id: 0,
                    god: false,
                    provenance: "checkpoint".to_string(),
                    content_hash: Some(sym.content_hash.clone()),
                });
                canonical_ids.insert(sym.node_id.clone());
                let file_id = format!("file:{file}");
                if file_ids.contains(&file_id) {
                    appended_edges.push(KgEdge {
                        from: file_id,
                        to: sym.node_id.clone(),
                        kind: "contains".to_string(),
                        surprise: false,
                        label: None,
                        confidence: None,
                    });
                }
            }
        }
    }

    if !rename.is_empty() {
        for e in edges.iter_mut() {
            if let Some(new) = rename.get(&e.from) {
                e.from = new.clone();
            }
            if let Some(new) = rename.get(&e.to) {
                e.to = new.clone();
            }
        }
    }

    // Merge canonical call edges between ids that made it onto the map.
    let mut seen: HashSet<(String, String, String)> = edges
        .iter()
        .map(|e| (e.from.clone(), e.to.clone(), e.kind.clone()))
        .collect();
    for e in &export.edges {
        if !canonical_ids.contains(&e.from) || !canonical_ids.contains(&e.to) {
            continue;
        }
        let kind = if e.kind.is_empty() {
            "calls".to_string()
        } else {
            e.kind.clone()
        };
        let key = (e.from.clone(), e.to.clone(), kind.clone());
        if !seen.insert(key) {
            continue;
        }
        appended_edges.push(KgEdge {
            from: e.from.clone(),
            to: e.to.clone(),
            kind,
            surprise: false,
            label: e.label.clone(),
            confidence: e.confidence,
        });
    }

    nodes.extend(appended);
    edges.extend(appended_edges);
    canonical_ids.len()
}

// ---------------------------------------------------------------------------
// Bounded views (GRF-05). The full graph never crosses IPC again: the
// frontend asks for a *view* — a capped, ranked subgraph — and the whole
// graph lives only here, parsed once and cached in memory per (path, mtime).
//
// Performance budget: a view is at most VIEW_NODE_CAP nodes and
// VIEW_EDGE_CAP edges, so the IPC payload stays around ~100–300 KB and the
// d3 simulation on the other side starts within a frame or two even when
// the underlying repo graph has hundreds of thousands of edges.
// ---------------------------------------------------------------------------

pub const VIEW_NODE_CAP: usize = 350;
pub const VIEW_EDGE_CAP: usize = 900;

/// Neighbours a search may bring along per match it shows, so the size of an
/// answer tracks the size of the question. Without a ceiling tied to the
/// matches, every search filled to `VIEW_NODE_CAP` and a specific query drew
/// the same wall of nodes as no query at all.
pub const CONTEXT_PER_MATCH: usize = 8;

struct KgCacheEntry {
    path: PathBuf,
    mtime: SystemTime,
    len: u64,
    graph: Arc<KgGraph>,
}

static KG_CACHE: Mutex<Option<KgCacheEntry>> = Mutex::new(None);

/// Read the persisted graph through the in-memory cache. A view request
/// per keystroke must not re-parse a multi-megabyte graph.json each time;
/// (path, mtime, len) equality decides reuse.
pub(crate) fn load_graph_cached(repo_root: &str) -> Result<Option<Arc<KgGraph>>, String> {
    let path = cache_path(repo_root);
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            *KG_CACHE.lock().unwrap() = None;
            return Ok(None);
        }
    };
    let mtime = meta.modified().map_err(|e| format!("stat kg: {e}"))?;
    let len = meta.len();
    if let Some(entry) = KG_CACHE.lock().unwrap().as_ref() {
        if entry.path == path && entry.mtime == mtime && entry.len == len {
            return Ok(Some(entry.graph.clone()));
        }
    }
    let body = fs::read_to_string(&path).map_err(|e| format!("read kg: {e}"))?;
    let g: KgGraph = serde_json::from_str(&body).map_err(|e| format!("parse kg: {e}"))?;
    // Scope guard (GRF-01): a graph stamped for a different worktree root
    // is someone else's truth — treat it as absent so the caller rebuilds
    // for THIS root instead of silently mixing worktrees. Legacy graphs
    // (empty stamp) pass: refusing them would break old repositories.
    if !g.scope_root.is_empty() && g.scope_root != scope_root_for(repo_root) {
        *KG_CACHE.lock().unwrap() = None;
        return Ok(None);
    }
    let graph = Arc::new(g);
    *KG_CACHE.lock().unwrap() = Some(KgCacheEntry {
        path,
        mtime,
        len,
        graph: graph.clone(),
    });
    Ok(Some(graph))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct KgViewQuery {
    /// Free-text query; empty means "overview" (top nodes by degree).
    #[serde(default)]
    pub query: String,
    /// Node kinds to include; empty means all.
    #[serde(default)]
    pub kinds: Vec<String>,
    /// Restrict to one community, if set.
    #[serde(default)]
    pub community: Option<usize>,
    #[serde(default)]
    pub include_docs: bool,
    /// Expand the neighbourhood around this node id instead of ranking
    /// globally — the incremental-loading path.
    #[serde(default)]
    pub focus: Option<String>,
    /// Requested node cap; clamped to VIEW_NODE_CAP.
    #[serde(default)]
    pub node_cap: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct KgView {
    pub nodes: Vec<KgNode>,
    pub edges: Vec<KgEdge>,
    /// Whole-graph stats — the header keeps describing the real repo even
    /// though only a slice of it is on screen.
    pub stats: KgStats,
    pub total_nodes: usize,
    /// Candidates that matched the filters/query before capping. In focus
    /// mode the focus node is the one match; everything else it returns is
    /// context.
    pub matched: usize,
    /// How many of `nodes` are present only as context — neighbours of a
    /// match, not matches themselves. `nodes.len() - context` is therefore
    /// how many matches are actually on screen.
    ///
    /// Counting these as matches is what produced `showing 350 of 16`: the
    /// view reported the 16 hits it found and returned the 350 nodes it drew,
    /// and the header subtracted one from the other.
    pub context: usize,
    /// Some matches did not fit and are not on screen.
    pub truncated: bool,
    /// Some edges between the returned nodes were dropped to stay inside the
    /// payload budget. Separate from `truncated`, because an edge cut says
    /// nothing about whether a match was hidden — folding the two together is
    /// why the header appeared at all on a search that hid no match.
    pub edges_truncated: bool,
    pub built_at: u64,
    pub head_sha: String,
}

/// How much a node matches a free-text query, as a confidence in (0, 1].
/// Exact name beats prefix beats substring beats file-path match.
fn match_confidence(node: &KgNode, query: &str) -> Option<f64> {
    if query.is_empty() {
        return Some(0.0);
    }
    let q = query.to_ascii_lowercase();
    let name = node.name.to_ascii_lowercase();
    if node.name == query {
        return Some(1.0);
    }
    if name == q {
        return Some(0.9);
    }
    if name.starts_with(&q) {
        return Some(0.75);
    }
    if name.contains(&q) {
        return Some(0.55);
    }
    if node.file.to_ascii_lowercase().contains(&q) {
        return Some(0.4);
    }
    None
}

/// Structural trust of an edge, derived from how it was extracted. The
/// builder's `contains` edges are ground truth; `mentions` come from a
/// bare word scan over prose and earn the least.
fn edge_confidence(kind: &str) -> f64 {
    match kind {
        "contains" => 1.0,
        "imports" => 0.9,
        "calls" => 0.85,
        "references" => 0.7,
        "mentions" => 0.5,
        _ => 0.6,
    }
}

fn passes_filters(n: &KgNode, q: &KgViewQuery) -> bool {
    if !q.include_docs && (n.kind == "doc" || n.kind == "section") {
        return false;
    }
    if !q.kinds.is_empty() && !q.kinds.iter().any(|k| k == &n.kind) {
        return false;
    }
    if let Some(c) = q.community {
        if n.community_id != c {
            return false;
        }
    }
    true
}

/// Undirected adjacency as index lists — built once per view call, O(E).
fn adjacency(g: &KgGraph) -> (HashMap<&str, usize>, Vec<Vec<usize>>) {
    let idx: HashMap<&str, usize> = g
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), i))
        .collect();
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); g.nodes.len()];
    for e in &g.edges {
        if let (Some(&a), Some(&b)) = (idx.get(e.from.as_str()), idx.get(e.to.as_str())) {
            adj[a].push(b);
            adj[b].push(a);
        }
    }
    (idx, adj)
}

/// Select a bounded subgraph. Pure so the stress tests can hammer it
/// without a Tauri runtime.
pub fn select_view(g: &KgGraph, q: &KgViewQuery) -> KgView {
    let cap = q.node_cap.unwrap_or(VIEW_NODE_CAP).clamp(10, VIEW_NODE_CAP);
    let (idx, adj) = adjacency(g);

    let mut picked: Vec<usize> = Vec::new();
    let mut picked_set: HashSet<usize> = HashSet::new();
    let mut matched = 0usize;
    let mut context = 0usize;

    if let Some(focus_id) = q.focus.as_deref().filter(|s| !s.is_empty()) {
        // Neighbourhood expansion: BFS layers from the focus node until
        // the cap fills. Filters still apply, except the focus itself.
        if let Some(&start) = idx.get(focus_id) {
            matched = 1;
            let mut seen: HashSet<usize> = HashSet::new();
            let mut queue: VecDeque<usize> = VecDeque::new();
            seen.insert(start);
            queue.push_back(start);
            while let Some(i) = queue.pop_front() {
                if picked.len() >= cap {
                    break;
                }
                if i == start || passes_filters(&g.nodes[i], q) {
                    picked.push(i);
                    picked_set.insert(i);
                }
                let mut next: Vec<usize> =
                    adj[i].iter().copied().filter(|n| !seen.contains(n)).collect();
                // Highest-degree neighbours first so the expansion shows
                // the load-bearing structure before leaf nodes.
                next.sort_by(|a, b| g.nodes[*b].degree.cmp(&g.nodes[*a].degree));
                for n in next {
                    seen.insert(n);
                    queue.push_back(n);
                }
            }
            // Expanding a node asks for one node and its surroundings. The
            // focus is the match; every neighbour that came back with it is
            // context, and none of them was hidden by a cap on matches.
            matched = 1;
            context = picked.len().saturating_sub(1);
        }
    } else {
        // Rank candidates: query confidence first (when querying), then
        // degree — the overview shows hubs, a search shows best matches.
        let mut candidates: Vec<(usize, f64)> = Vec::new();
        for (i, n) in g.nodes.iter().enumerate() {
            if !passes_filters(n, q) {
                continue;
            }
            match match_confidence(n, &q.query) {
                Some(score) => candidates.push((i, score)),
                None => continue,
            }
        }
        matched = candidates.len();
        candidates.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| g.nodes[b.0].degree.cmp(&g.nodes[a.0].degree))
        });
        for (i, _) in candidates.iter().take(cap) {
            picked.push(*i);
            picked_set.insert(*i);
        }
        // Fill some room with 1-hop neighbours of the matches so a search
        // result arrives with its context attached.
        //
        // How much room is deliberately tied to how much matched. Filling all
        // the way to the node cap regardless is what made a 16-hit search for
        // `parse_tree` come back as 350 nodes: the answer to a narrow question
        // was drawn at exactly the size of the unfiltered map, so searching
        // appeared to do nothing. A result should look as narrow as it is.
        if !q.query.is_empty() && picked.len() < cap {
            let room = picked
                .len()
                .saturating_mul(CONTEXT_PER_MATCH)
                .min(cap - picked.len());
            let seeds: Vec<usize> = picked.clone();
            let mut fill: Vec<usize> = Vec::new();
            for s in seeds {
                for &n in &adj[s] {
                    if !picked_set.contains(&n) && passes_filters(&g.nodes[n], q) {
                        picked_set.insert(n);
                        fill.push(n);
                    }
                }
            }
            fill.sort_by(|a, b| g.nodes[*b].degree.cmp(&g.nodes[*a].degree));
            for n in fill.into_iter().take(room) {
                picked.push(n);
                context += 1;
            }
        }
    }

    let nodes: Vec<KgNode> = picked.iter().map(|&i| g.nodes[i].clone()).collect();
    let id_set: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    let mut edges: Vec<KgEdge> = g
        .edges
        .iter()
        .filter(|e| id_set.contains(e.from.as_str()) && id_set.contains(e.to.as_str()))
        .cloned()
        .collect();
    let edges_truncated = edges.len() > VIEW_EDGE_CAP;
    if edges_truncated {
        // Keep the edges that carry the most signal: surprises, then
        // structurally trusted kinds, then whatever connects hubs.
        edges.sort_by(|a, b| {
            b.surprise
                .cmp(&a.surprise)
                .then_with(|| {
                    edge_confidence(&b.kind)
                        .partial_cmp(&edge_confidence(&a.kind))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        edges.truncate(VIEW_EDGE_CAP);
    }

    KgView {
        // Only the matches count towards this: the context riding along with
        // them was never a candidate for being hidden.
        truncated: matched > nodes.len().saturating_sub(context),
        edges_truncated,
        context,
        total_nodes: g.nodes.len(),
        matched,
        nodes,
        edges,
        stats: g.stats.clone(),
        built_at: g.built_at,
        head_sha: g.head_sha.clone(),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KgExplainEdge {
    pub kind: String,
    pub confidence: f64,
    pub surprise: bool,
    pub other: KgNode,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KgExplain {
    pub node: KgNode,
    pub inbound: Vec<KgExplainEdge>,
    pub outbound: Vec<KgExplainEdge>,
    pub inbound_total: usize,
    pub outbound_total: usize,
    /// Nodes sharing this node's community — how big its cluster is.
    pub community_size: usize,
    pub built_at: u64,
    pub head_sha: String,
}

const EXPLAIN_EDGE_CAP: usize = 40;

/// Everything the graph knows about one node, capped but with true
/// totals, so "why is this a hub" is answerable from evidence.
pub fn explain_node(g: &KgGraph, node_id: &str) -> Option<KgExplain> {
    let by_id: HashMap<&str, &KgNode> = g.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let node = (*by_id.get(node_id)?).clone();
    let mut inbound: Vec<KgExplainEdge> = Vec::new();
    let mut outbound: Vec<KgExplainEdge> = Vec::new();
    let mut inbound_total = 0usize;
    let mut outbound_total = 0usize;
    for e in &g.edges {
        let (bucket, total, other_id) = if e.from == node_id {
            (&mut outbound, &mut outbound_total, e.to.as_str())
        } else if e.to == node_id {
            (&mut inbound, &mut inbound_total, e.from.as_str())
        } else {
            continue;
        };
        *total += 1;
        if let Some(other) = by_id.get(other_id) {
            bucket.push(KgExplainEdge {
                kind: e.kind.clone(),
                confidence: edge_confidence(&e.kind),
                surprise: e.surprise,
                other: (*other).clone(),
            });
        }
    }
    let rank = |edges: &mut Vec<KgExplainEdge>| {
        edges.sort_by(|a, b| {
            b.surprise
                .cmp(&a.surprise)
                .then_with(|| {
                    b.confidence
                        .partial_cmp(&a.confidence)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| b.other.degree.cmp(&a.other.degree))
        });
        edges.truncate(EXPLAIN_EDGE_CAP);
    };
    rank(&mut inbound);
    rank(&mut outbound);
    let community_size = g
        .nodes
        .iter()
        .filter(|n| n.community_id == node.community_id)
        .count();
    Some(KgExplain {
        node,
        inbound,
        outbound,
        inbound_total,
        outbound_total,
        community_size,
        built_at: g.built_at,
        head_sha: g.head_sha.clone(),
    })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KgPathHop {
    pub node: KgNode,
    /// Edge that led here from the previous hop; None on the first hop.
    pub via_kind: Option<String>,
    pub via_confidence: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct KgPath {
    pub found: bool,
    /// True when the path follows edge direction end to end; false when
    /// only an undirected connection exists.
    pub directed: bool,
    pub hops: Vec<KgPathHop>,
    /// Product of every edge confidence on the path (× endpoint match
    /// confidence when an endpoint was resolved by name, not id).
    pub confidence: f64,
    pub from_resolved: Option<KgNode>,
    pub to_resolved: Option<KgNode>,
    pub built_at: u64,
    pub head_sha: String,
}

/// Resolve a user-supplied endpoint: exact node id wins, else the best
/// name match. Returns (index, resolution confidence).
fn resolve_endpoint(g: &KgGraph, term: &str) -> Option<(usize, f64)> {
    if let Some(i) = g.nodes.iter().position(|n| n.id == term) {
        return Some((i, 1.0));
    }
    let mut best: Option<(usize, f64)> = None;
    for (i, n) in g.nodes.iter().enumerate() {
        if let Some(score) = match_confidence(n, term) {
            if score <= 0.0 {
                continue;
            }
            let better = match best {
                None => true,
                Some((bi, bs)) => {
                    score > bs || (score == bs && n.degree > g.nodes[bi].degree)
                }
            };
            if better {
                best = Some((i, score));
            }
        }
    }
    best
}

/// BFS shortest path. `directed` follows from→to only; otherwise both
/// ways. Returns the node-index chain including both endpoints.
fn bfs_path(
    g: &KgGraph,
    idx: &HashMap<&str, usize>,
    from: usize,
    to: usize,
    max_hops: usize,
    directed: bool,
) -> Option<Vec<usize>> {
    let mut fwd: Vec<Vec<usize>> = vec![Vec::new(); g.nodes.len()];
    for e in &g.edges {
        if let (Some(&a), Some(&b)) = (idx.get(e.from.as_str()), idx.get(e.to.as_str())) {
            fwd[a].push(b);
            if !directed {
                fwd[b].push(a);
            }
        }
    }
    let mut prev: HashMap<usize, usize> = HashMap::new();
    let mut depth: HashMap<usize, usize> = HashMap::new();
    let mut queue: VecDeque<usize> = VecDeque::new();
    depth.insert(from, 0);
    queue.push_back(from);
    while let Some(i) = queue.pop_front() {
        let d = depth[&i];
        if i == to {
            let mut chain = vec![i];
            let mut cur = i;
            while let Some(&p) = prev.get(&cur) {
                chain.push(p);
                cur = p;
            }
            chain.reverse();
            return Some(chain);
        }
        if d >= max_hops {
            continue;
        }
        for &n in &fwd[i] {
            if !depth.contains_key(&n) {
                depth.insert(n, d + 1);
                prev.insert(n, i);
                queue.push_back(n);
            }
        }
    }
    None
}

/// Shortest dependency path between two symbols, with per-edge evidence.
pub fn find_path(g: &KgGraph, from: &str, to: &str, max_hops: usize) -> KgPath {
    let empty = KgPath {
        built_at: g.built_at,
        head_sha: g.head_sha.clone(),
        ..Default::default()
    };
    let (Some((fi, fconf)), Some((ti, tconf))) =
        (resolve_endpoint(g, from), resolve_endpoint(g, to))
    else {
        return empty;
    };
    let idx: HashMap<&str, usize> = g
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), i))
        .collect();
    let max_hops = max_hops.clamp(1, 12);
    let (chain, directed) = match bfs_path(g, &idx, fi, ti, max_hops, true) {
        Some(c) => (Some(c), true),
        None => (bfs_path(g, &idx, fi, ti, max_hops, false), false),
    };
    let mut out = KgPath {
        directed,
        from_resolved: Some(g.nodes[fi].clone()),
        to_resolved: Some(g.nodes[ti].clone()),
        built_at: g.built_at,
        head_sha: g.head_sha.clone(),
        ..Default::default()
    };
    let Some(chain) = chain else {
        return out;
    };
    // Cheapest edge lookup for hop annotation: pair-key map, either
    // orientation, keeping the highest-confidence edge kind.
    let mut pair_kind: HashMap<(usize, usize), (&str, bool)> = HashMap::new();
    for e in &g.edges {
        if let (Some(&a), Some(&b)) = (idx.get(e.from.as_str()), idx.get(e.to.as_str())) {
            let slot = pair_kind.entry((a, b)).or_insert((e.kind.as_str(), e.surprise));
            if edge_confidence(&e.kind) > edge_confidence(slot.0) {
                *slot = (e.kind.as_str(), e.surprise);
            }
        }
    }
    let mut confidence = fconf * tconf;
    let mut hops: Vec<KgPathHop> = Vec::new();
    for (step, &i) in chain.iter().enumerate() {
        if step == 0 {
            hops.push(KgPathHop {
                node: g.nodes[i].clone(),
                via_kind: None,
                via_confidence: None,
            });
            continue;
        }
        let p = chain[step - 1];
        let kind = pair_kind
            .get(&(p, i))
            .or_else(|| pair_kind.get(&(i, p)))
            .map(|(k, _)| k.to_string())
            .unwrap_or_else(|| "linked".to_string());
        let ec = edge_confidence(&kind);
        confidence *= ec;
        hops.push(KgPathHop {
            node: g.nodes[i].clone(),
            via_kind: Some(kind),
            via_confidence: Some(ec),
        });
    }
    out.found = true;
    out.hops = hops;
    out.confidence = confidence;
    out
}

/// Build (or reuse) the graph and return only its stats — the cheap
/// handshake the pane opens with. The graph itself stays server-side.
#[tauri::command]
pub async fn aura_kg_ensure(repo_root: String, force: bool) -> Result<KgStats, String> {
    let head = current_head_sha(&repo_root);
    if !force {
        if let Ok(Some(g)) = load_graph_cached(&repo_root) {
            // A pre-GRF-01 graph still serves views, but the first ensure
            // migrates it: rebuild re-derives it losslessly from the repo +
            // checkpoint sources and stamps schema, scope and canonical ids.
            if !head.is_empty() && g.head_sha == head && g.schema_version >= KG_SCHEMA_VERSION {
                return Ok(g.stats.clone());
            }
        }
    }
    let graph = aura_kg_build(repo_root, true).await?;
    Ok(graph.stats)
}

#[tauri::command]
pub async fn aura_kg_view(
    repo_root: String,
    view: KgViewQuery,
) -> Result<Option<KgView>, String> {
    let Some(g) = load_graph_cached(&repo_root)? else {
        return Ok(None);
    };
    Ok(Some(select_view(&g, &view)))
}

#[tauri::command]
pub async fn aura_kg_explain(
    repo_root: String,
    node_id: String,
) -> Result<Option<KgExplain>, String> {
    let Some(g) = load_graph_cached(&repo_root)? else {
        return Ok(None);
    };
    Ok(explain_node(&g, &node_id))
}

#[tauri::command]
pub async fn aura_kg_path(
    repo_root: String,
    from: String,
    to: String,
    max_hops: Option<usize>,
) -> Result<Option<KgPath>, String> {
    let Some(g) = load_graph_cached(&repo_root)? else {
        return Ok(None);
    };
    Ok(Some(find_path(&g, &from, &to, max_hops.unwrap_or(6))))
}

fn walk<F: FnMut(&Path, &Path)>(root: &Path, base: &str, on_file: &mut F) {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') && name != ".aura-test" {
            // Hide-dot entries; .aura is in SKIP_DIRS too.
            continue;
        }
        // `entry.file_type()` is an lstat — it does NOT resolve symlinks.
        // `path.is_dir()` did, so a link pointing back up the tree made this
        // recursion literally infinite (the "building graph…" that never
        // ends), and a link out of the repo walked someone else's files.
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&path, base, on_file);
        } else if ft.is_file() {
            let rel = path.strip_prefix(base).unwrap_or(&path).to_path_buf();
            on_file(&rel, &path);
        }
    }
}

fn ingest_source(
    rel: &str,
    body: &str,
    nodes: &mut Vec<KgNode>,
    edges: &mut Vec<KgEdge>,
    symbol_index: &mut HashMap<String, Vec<String>>,
) {
    let file_id = format!("file:{rel}");
    nodes.push(KgNode {
        id: file_id.clone(),
        kind: "file".into(),
        name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
        file: rel.to_string(),
        line: 0,
        degree: 0,
        community_id: 0,
        god: false,
        provenance: default_provenance(),
        content_hash: None,
    });
    for (i, line) in body.lines().enumerate() {
        let trimmed = line.trim_start();
        let lineno = (i + 1) as u32;
        let (kind, name) = if let Some(n) =
            strip_prefix(trimmed, &["pub fn ", "fn ", "function ", "def ", "async fn ", "pub async fn "])
        {
            ("fn", n)
        } else if let Some(n) =
            strip_prefix(trimmed, &["pub struct ", "struct ", "class ", "interface ", "pub trait ", "trait "])
        {
            ("class", n)
        } else if let Some(n) = strip_prefix(trimmed, &["pub type ", "type ", "pub enum ", "enum "]) {
            ("type", n)
        } else {
            continue;
        };
        let id = format!("{kind}:{rel}#{name}@{lineno}");
        nodes.push(KgNode {
            id: id.clone(),
            kind: kind.into(),
            name: name.clone(),
            file: rel.to_string(),
            line: lineno,
            degree: 0,
            community_id: 0,
            god: false,
            provenance: default_provenance(),
            content_hash: None,
        });
        edges.push(KgEdge {
            from: file_id.clone(),
            to: id.clone(),
            kind: "contains".into(),
            surprise: false,
            label: None,
            confidence: None,
        });
        symbol_index.entry(name).or_default().push(id);
    }
    // Imports / requires / use statements → file-to-file edges. Cheap
    // string scan; misses path mapping but catches most cases.
    for line in body.lines() {
        let t = line.trim_start();
        if let Some(rest) = t
            .strip_prefix("import ")
            .or_else(|| t.strip_prefix("from "))
            .or_else(|| t.strip_prefix("use "))
            .or_else(|| t.strip_prefix("require("))
        {
            // Pull the first quoted string or path-like token.
            let target = first_quoted(rest)
                .or_else(|| first_path_token(rest))
                .unwrap_or_default();
            if target.is_empty() || target.starts_with("std")
                || target.starts_with("crate") {
                continue;
            }
            edges.push(KgEdge {
                from: file_id.clone(),
                to: format!("import:{target}"),
                kind: "imports".into(),
                surprise: false,
                label: None,
                confidence: None,
            });
        }
    }
}

fn ingest_doc(
    rel: &str,
    body: &str,
    nodes: &mut Vec<KgNode>,
    _edges: &mut Vec<KgEdge>,
    _symbol_index: &HashMap<String, Vec<String>>,
) {
    let doc_id = format!("doc:{rel}");
    nodes.push(KgNode {
        id: doc_id.clone(),
        kind: "doc".into(),
        name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
        file: rel.to_string(),
        line: 0,
        degree: 0,
        community_id: 0,
        god: false,
        provenance: default_provenance(),
        content_hash: None,
    });
    // Section nodes — H2/H3 headings give a finer-grained anchor.
    for (i, line) in body.lines().enumerate() {
        let t = line.trim_start();
        let (level, title) = if let Some(rest) = t.strip_prefix("### ") {
            (3, rest.to_string())
        } else if let Some(rest) = t.strip_prefix("## ") {
            (2, rest.to_string())
        } else {
            continue;
        };
        if title.is_empty() {
            continue;
        }
        let lineno = (i + 1) as u32;
        nodes.push(KgNode {
            id: format!("section:{rel}#h{level}:{title}@{lineno}"),
            kind: "section".into(),
            name: title,
            file: rel.to_string(),
            line: lineno,
            degree: 0,
            community_id: 0,
            god: false,
            provenance: default_provenance(),
            content_hash: None,
        });
    }
}

fn scan_references(
    from_id: &str,
    body: &str,
    symbol_index: &HashMap<String, Vec<String>>,
    edges: &mut Vec<KgEdge>,
) {
    // Word-boundary tokenize cheaply: scan identifiers, look up.
    let mut seen: HashSet<String> = HashSet::new();
    let mut emitted = 0usize;
    let mut current = String::new();
    let bytes = body.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        let ch = b as char;
        if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else {
            if !current.is_empty() {
                if let Some(targets) = symbol_index.get(&current) {
                    // A widely-shared name is ambient noise, not a reference.
                    if targets.len() <= MAX_TARGETS_PER_NAME {
                        for t in targets {
                            // skip self-reference (file → its own contained
                            // symbol is a `contains` edge already)
                            if t.starts_with("fn:") || t.starts_with("class:") || t.starts_with("type:") {
                                let key = format!("{from_id}->{t}");
                                if seen.insert(key) {
                                    edges.push(KgEdge {
                                        from: from_id.to_string(),
                                        to: t.clone(),
                                        kind: "references".into(),
                                        surprise: false,
                                        label: None,
                                        confidence: None,
                                    });
                                    emitted += 1;
                                    if emitted >= MAX_REF_EDGES_PER_FILE {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
                current.clear();
            }
        }
        // Cap scan at ~256KB to keep big generated files cheap.
        if i > 256 * 1024 {
            break;
        }
    }
}

fn scan_mentions(
    from_id: &str,
    body: &str,
    symbol_index: &HashMap<String, Vec<String>>,
    edges: &mut Vec<KgEdge>,
) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut emitted = 0usize;
    let mut current = String::new();
    for (i, ch) in body.char_indices() {
        if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else {
            if current.len() >= 3 {
                if let Some(targets) = symbol_index.get(&current) {
                    if targets.len() <= MAX_TARGETS_PER_NAME {
                        for t in targets {
                            let key = format!("{from_id}->{t}");
                            if seen.insert(key) {
                                edges.push(KgEdge {
                                    from: from_id.to_string(),
                                    to: t.clone(),
                                    kind: "mentions".into(),
                                    surprise: false,
                                    label: None,
                                    confidence: None,
                                });
                                emitted += 1;
                                if emitted >= MAX_MENTION_EDGES_PER_DOC {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            current.clear();
        }
        // Same ~256KB cap as source files — a giant changelog is not a doc
        // worth an unbounded scan.
        if i > 256 * 1024 {
            break;
        }
    }
}

fn annotate(nodes: &mut [KgNode], edges: &mut [KgEdge]) {
    // Everything below runs on integer indices against one id→index map.
    // The String-keyed maps this replaces cloned two ids per edge per
    // label-propagation pass — on a real-sized repo that was minutes of
    // allocator churn inside "building graph…".
    let n_len = nodes.len();
    let (degree, god_flags, community_final, surprise_flags) = {
        let idx: HashMap<&str, usize> = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.as_str(), i))
            .collect();
        // Degree counts each endpoint independently, so an edge to a
        // dangling id (an unresolved import) still counts on the side that
        // resolved — same as the old String-keyed tally.
        let mut degree = vec![0usize; n_len];
        let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n_len];
        let mut endpoints: Vec<Option<(usize, usize)>> = Vec::with_capacity(edges.len());
        for e in edges.iter() {
            let a = idx.get(e.from.as_str()).copied();
            let b = idx.get(e.to.as_str()).copied();
            if let Some(a) = a {
                degree[a] += 1;
            }
            if let Some(b) = b {
                degree[b] += 1;
            }
            if let (Some(a), Some(b)) = (a, b) {
                adj[a].push(b as u32);
                adj[b].push(a as u32);
                endpoints.push(Some((a, b)));
            } else {
                endpoints.push(None);
            }
        }
        // God = top-decile by degree among non-file nodes.
        let mut symbol_degrees: Vec<usize> = nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.kind != "file" && n.kind != "doc")
            .map(|(i, _)| degree[i])
            .collect();
        symbol_degrees.sort_unstable_by(|a, b| b.cmp(a));
        let cutoff_idx = (symbol_degrees.len() as f64 * 0.1) as usize;
        let cutoff = symbol_degrees.get(cutoff_idx).copied().unwrap_or(usize::MAX).max(2);
        let mut god_flags = vec![false; n_len];
        for (i, n) in nodes.iter().enumerate() {
            if n.kind != "file" && n.kind != "doc" && degree[i] >= cutoff {
                god_flags[i] = true;
            }
        }
        // Community via label propagation. Each node starts with its own
        // community; iteratively adopt the most common label among
        // neighbors. ~5 passes converges for typical repos.
        let mut community: Vec<usize> = (0..n_len).collect();
        let mut tally: HashMap<usize, usize> = HashMap::new();
        for _ in 0..6 {
            let mut changed = false;
            for i in 0..n_len {
                if adj[i].is_empty() {
                    continue;
                }
                tally.clear();
                for &nb in &adj[i] {
                    *tally.entry(community[nb as usize]).or_default() += 1;
                }
                if let Some((&best, _)) = tally.iter().max_by_key(|kv| *kv.1) {
                    if best != community[i] {
                        community[i] = best;
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
        // Compact community ids → 0..k.
        let mut remap: HashMap<usize, usize> = HashMap::new();
        let mut community_final = vec![0usize; n_len];
        for i in 0..n_len {
            let next = remap.len();
            community_final[i] = *remap.entry(community[i]).or_insert(next);
        }
        // Surprise = inter-community edge in a community where >=70% of
        // edges stay internal.
        let mut internal: HashMap<usize, usize> = HashMap::new();
        let mut external: HashMap<usize, usize> = HashMap::new();
        for pair in endpoints.iter().flatten() {
            let (ca, cb) = (community_final[pair.0], community_final[pair.1]);
            if ca == cb {
                *internal.entry(ca).or_default() += 1;
            } else {
                *external.entry(ca).or_default() += 1;
                *external.entry(cb).or_default() += 1;
            }
        }
        let mut surprise_flags = vec![false; edges.len()];
        for (ei, pair) in endpoints.iter().enumerate() {
            let Some((a, b)) = pair else { continue };
            let (ca, cb) = (community_final[*a], community_final[*b]);
            if ca == cb {
                continue;
            }
            let total_a = internal.get(&ca).copied().unwrap_or(0)
                + external.get(&ca).copied().unwrap_or(0);
            if total_a == 0 {
                continue;
            }
            let internal_ratio = internal.get(&ca).copied().unwrap_or(0) as f64 / total_a as f64;
            if internal_ratio >= 0.7 {
                surprise_flags[ei] = true;
            }
        }
        (degree, god_flags, community_final, surprise_flags)
    };
    for (i, n) in nodes.iter_mut().enumerate() {
        n.degree = degree[i];
        n.god = god_flags[i];
        n.community_id = community_final[i];
    }
    for (ei, e) in edges.iter_mut().enumerate() {
        e.surprise = surprise_flags[ei];
    }
}

fn compute_stats(nodes: &[KgNode], edges: &[KgEdge]) -> KgStats {
    let mut s = KgStats::default();
    let mut communities: HashSet<usize> = HashSet::new();
    for n in nodes {
        match n.kind.as_str() {
            "file" => s.files += 1,
            "doc" | "section" => s.docs += 1,
            _ => s.symbols += 1,
        }
        if n.god {
            s.gods += 1;
        }
        if n.provenance == "checkpoint" {
            s.canonical += 1;
        }
        communities.insert(n.community_id);
    }
    s.edges = edges.len();
    s.communities = communities.len();
    s.surprises = edges.iter().filter(|e| e.surprise).count();
    s
}

fn strip_prefix(s: &str, prefixes: &[&str]) -> Option<String> {
    for p in prefixes {
        if let Some(rest) = s.strip_prefix(p) {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                .collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn first_quoted(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut start: Option<usize> = None;
    for (i, &b) in bytes.iter().enumerate() {
        let ch = b as char;
        if ch == '"' || ch == '\'' {
            if let Some(open) = start {
                return Some(s[open + 1..i].to_string());
            }
            start = Some(i);
        }
    }
    None
}

fn first_path_token(s: &str) -> Option<String> {
    let t = s.trim();
    let cut = t
        .find(|c: char| c.is_whitespace() || c == ';' || c == ',' || c == '{' || c == '(')
        .unwrap_or(t.len());
    let token = t[..cut].trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_propagation_converges() {
        let mut nodes = vec![
            mk_node("file:a", "file", "a", "a", 0),
            mk_node("fn:a#x", "fn", "x", "a", 1),
            mk_node("fn:a#y", "fn", "y", "a", 2),
        ];
        let mut edges = vec![
            KgEdge { from: "file:a".into(), to: "fn:a#x".into(), kind: "contains".into(), surprise: false, label: None, confidence: None },
            KgEdge { from: "file:a".into(), to: "fn:a#y".into(), kind: "contains".into(), surprise: false, label: None, confidence: None },
            KgEdge { from: "fn:a#x".into(), to: "fn:a#y".into(), kind: "references".into(), surprise: false, label: None, confidence: None },
        ];
        annotate(&mut nodes, &mut edges);
        // All connected → single community.
        let cs: HashSet<usize> = nodes.iter().map(|n| n.community_id).collect();
        assert_eq!(cs.len(), 1);
    }

    fn mk_node(id: &str, kind: &str, name: &str, file: &str, line: u32) -> KgNode {
        KgNode {
            id: id.into(), kind: kind.into(), name: name.into(),
            file: file.into(), line, degree: 0, community_id: 0, god: false,
            provenance: default_provenance(),
            content_hash: None,
        }
    }
}

#[cfg(test)]
mod view_tests {
    use super::*;

    fn mk_node(id: &str, kind: &str, name: &str, file: &str, degree: usize) -> KgNode {
        KgNode {
            id: id.into(),
            kind: kind.into(),
            name: name.into(),
            file: file.into(),
            line: 1,
            degree,
            community_id: 0,
            god: false,
            provenance: default_provenance(),
            content_hash: None,
        }
    }

    fn mk_edge(from: &str, to: &str, kind: &str) -> KgEdge {
        KgEdge {
            from: from.into(),
            to: to.into(),
            kind: kind.into(),
            surprise: false,
            label: None,
            confidence: None,
        }
    }

    fn tiny_graph() -> KgGraph {
        // file:a contains fn:handle → fn:handle references fn:save →
        // fn:save references fn:write. Plus an unrelated fn:parse.
        let nodes = vec![
            mk_node("file:a.rs", "file", "a.rs", "a.rs", 3),
            mk_node("fn:a.rs#handle@1", "fn", "handle", "a.rs", 2),
            mk_node("fn:a.rs#save@9", "fn", "save", "a.rs", 2),
            mk_node("fn:a.rs#write@20", "fn", "write", "a.rs", 1),
            mk_node("fn:b.rs#parse@3", "fn", "parse", "b.rs", 0),
        ];
        let edges = vec![
            mk_edge("file:a.rs", "fn:a.rs#handle@1", "contains"),
            mk_edge("fn:a.rs#handle@1", "fn:a.rs#save@9", "references"),
            mk_edge("fn:a.rs#save@9", "fn:a.rs#write@20", "references"),
        ];
        let stats = compute_stats(&nodes, &edges);
        KgGraph {
            nodes,
            edges,
            built_at: 1,
            head_sha: "abc".into(),
            stats,
            ..Default::default()
        }
    }

    /// Deterministic large graph: `files` file nodes, each containing
    /// `fns_per_file` fn nodes, with pseudo-random cross-references from a
    /// fixed LCG so the shape is stable across runs.
    /// The shape the reported case actually had: a query that hits a handful
    /// of nodes, each of them well connected, so one hop out of the matches is
    /// hundreds of nodes. A uniform graph of average degree three never
    /// reproduces it — searching `parse_tree` in the real repo did.
    ///
    /// Neither the neighbour names nor their file paths contain the query, so
    /// every one of them is context and none of them is a match.
    fn hub_graph(matches: usize, neighbours: usize) -> KgGraph {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for m in 0..matches {
            let hit = format!("fn:src/m{m}.rs#parse_tree@1");
            nodes.push(mk_node(&hit, "fn", "parse_tree", &format!("src/m{m}.rs"), 0));
            for n in 0..neighbours {
                let id = format!("fn:src/m{m}.rs#near_{m}_{n}@{}", n + 2);
                nodes.push(mk_node(
                    &id,
                    "fn",
                    &format!("near_{m}_{n}"),
                    &format!("src/m{m}.rs"),
                    0,
                ));
                edges.push(mk_edge(&hit, &id, "references"));
            }
        }
        with_degrees(nodes, edges)
    }

    /// Recount degrees and stats the way `annotate()` does, so a hand-built
    /// graph ranks the same way a real one would.
    fn with_degrees(mut nodes: Vec<KgNode>, edges: Vec<KgEdge>) -> KgGraph {
        let mut degree: HashMap<String, usize> = HashMap::new();
        for e in &edges {
            *degree.entry(e.from.clone()).or_default() += 1;
            *degree.entry(e.to.clone()).or_default() += 1;
        }
        for n in nodes.iter_mut() {
            n.degree = *degree.get(&n.id).unwrap_or(&0);
        }
        let stats = compute_stats(&nodes, &edges);
        KgGraph {
            nodes,
            edges,
            built_at: 1,
            head_sha: "stress".into(),
            stats,
            ..Default::default()
        }
    }

    fn synthetic_graph(files: usize, fns_per_file: usize, extra_edges: usize) -> KgGraph {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for f in 0..files {
            let file_id = format!("file:src/f{f}.rs");
            nodes.push(mk_node(&file_id, "file", &format!("f{f}.rs"), &format!("src/f{f}.rs"), 0));
            for i in 0..fns_per_file {
                let id = format!("fn:src/f{f}.rs#fn_{f}_{i}@{}", i + 1);
                nodes.push(mk_node(&id, "fn", &format!("fn_{f}_{i}"), &format!("src/f{f}.rs"), 0));
                edges.push(mk_edge(&file_id, &id, "contains"));
            }
        }
        let fn_count = files * fns_per_file;
        let mut seed: u64 = 0x5eed;
        let mut rand = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        for _ in 0..extra_edges {
            let a = rand() % fn_count;
            let b = rand() % fn_count;
            let (af, ai) = (a / fns_per_file, a % fns_per_file);
            let (bf, bi) = (b / fns_per_file, b % fns_per_file);
            edges.push(mk_edge(
                &format!("fn:src/f{af}.rs#fn_{af}_{ai}@{}", ai + 1),
                &format!("fn:src/f{bf}.rs#fn_{bf}_{bi}@{}", bi + 1),
                "references",
            ));
        }
        // Degrees matter for ranking — recount them like annotate() does.
        let mut degree: HashMap<String, usize> = HashMap::new();
        for e in &edges {
            *degree.entry(e.from.clone()).or_default() += 1;
            *degree.entry(e.to.clone()).or_default() += 1;
        }
        for n in nodes.iter_mut() {
            n.degree = *degree.get(&n.id).unwrap_or(&0);
        }
        let stats = compute_stats(&nodes, &edges);
        KgGraph {
            nodes,
            edges,
            built_at: 1,
            head_sha: "stress".into(),
            stats,
            ..Default::default()
        }
    }

    #[test]
    fn overview_is_capped_and_keeps_whole_graph_stats() {
        let g = synthetic_graph(200, 9, 4000); // 2000 nodes
        let v = select_view(&g, &KgViewQuery { include_docs: true, ..Default::default() });
        assert!(v.nodes.len() <= VIEW_NODE_CAP);
        assert!(v.edges.len() <= VIEW_EDGE_CAP);
        assert!(v.truncated);
        assert_eq!(v.total_nodes, g.nodes.len());
        assert_eq!(v.stats.symbols, g.stats.symbols);
        // Overview keeps the highest-degree nodes — the top pick must be
        // at least as connected as anything it left out.
        let min_kept = v.nodes.iter().map(|n| n.degree).min().unwrap();
        let max_dropped = g
            .nodes
            .iter()
            .filter(|n| !v.nodes.iter().any(|k| k.id == n.id))
            .map(|n| n.degree)
            .max()
            .unwrap();
        assert!(v.nodes.iter().map(|n| n.degree).max().unwrap() >= max_dropped);
        let _ = min_kept;
    }

    #[test]
    fn query_ranks_exact_over_prefix_over_substring() {
        let g = tiny_graph();
        let v = select_view(&g, &KgViewQuery {
            query: "save".into(),
            include_docs: true,
            ..Default::default()
        });
        assert_eq!(v.nodes.first().unwrap().name, "save");
        // Context fill: the match's neighbours ride along.
        assert!(v.nodes.iter().any(|n| n.name == "handle"));
        assert!(v.nodes.iter().any(|n| n.name == "write"));
        // Unrelated node with no match and no adjacency stays out.
        assert!(!v.nodes.iter().any(|n| n.name == "parse"));
    }

    #[test]
    fn a_search_stays_as_narrow_as_the_thing_it_found() {
        // The reported case: a query hits a handful of nodes in a large graph
        // and the pane comes back full to the cap, indistinguishable from the
        // unfiltered map. Context is allowed, proportion is not.
        let g = hub_graph(16, 100);
        let v = select_view(&g, &KgViewQuery {
            query: "parse_tree".into(),
            include_docs: true,
            ..Default::default()
        });

        let shown_matches = v.nodes.len() - v.context;
        assert_eq!(v.matched, 16, "the query hits exactly the sixteen");
        assert_eq!(shown_matches, 16, "and all sixteen fit");
        assert!(
            v.nodes.len() < VIEW_NODE_CAP,
            "a 16-match search drew {} nodes, the whole budget",
            v.nodes.len()
        );
        assert!(
            v.context <= shown_matches * CONTEXT_PER_MATCH,
            "context outgrew the matches it belongs to: {} for {shown_matches}",
            v.context
        );
    }

    #[test]
    fn the_header_can_never_claim_to_show_more_than_it_found() {
        // `showing {nodes} of {matched}` read `showing 350 of 16` because the
        // two numbers counted different things. Whatever the header subtracts
        // has to be a subset of what it compares against.
        let dense = hub_graph(16, 100);
        let wide = synthetic_graph(2000, 9, 60_000);
        let cases = [
            (&dense, "parse_tree"),
            (&dense, "near_0"),
            (&dense, ""),
            (&wide, "fn_1500"),
            (&wide, "fn_1"),
            (&wide, ""),
            (&wide, "nothing_matches_this"),
        ];
        for (g, query) in cases {
            let v = select_view(g, &KgViewQuery {
                query: query.to_string(),
                include_docs: true,
                ..Default::default()
            });
            let shown_matches = v.nodes.len() - v.context;
            assert!(
                shown_matches <= v.matched,
                "query {query:?}: showed {shown_matches} matches out of {} found",
                v.matched
            );
            assert_eq!(
                v.truncated,
                shown_matches < v.matched,
                "query {query:?}: truncated must mean matches were hidden, nothing else"
            );
        }
    }

    #[test]
    fn an_edge_cut_is_not_reported_as_a_hidden_match() {
        // Every match fits; only edges were dropped. The header must not say
        // matches are missing — conflating the two is what made the count
        // line appear on a search that hid nothing.
        let g = synthetic_graph(200, 9, 4000);
        let v = select_view(&g, &KgViewQuery {
            query: "fn_10".into(),
            include_docs: true,
            ..Default::default()
        });

        assert_eq!(v.nodes.len() - v.context, v.matched, "every match fits");
        assert!(!v.truncated);
    }

    #[test]
    fn expanding_a_node_reports_one_match_and_the_rest_as_context() {
        let g = tiny_graph();
        let v = select_view(&g, &KgViewQuery {
            focus: Some("fn:a.rs#save@9".into()),
            include_docs: true,
            ..Default::default()
        });

        assert_eq!(v.matched, 1, "the node asked for");
        assert_eq!(v.context, v.nodes.len() - 1, "everything else came along");
        assert!(!v.truncated, "an expansion hides no match");
    }

    #[test]
    fn focus_mode_expands_the_neighbourhood() {
        let g = tiny_graph();
        let v = select_view(&g, &KgViewQuery {
            focus: Some("fn:a.rs#save@9".into()),
            include_docs: true,
            ..Default::default()
        });
        let names: Vec<&str> = v.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"save"));
        assert!(names.contains(&"handle"));
        assert!(names.contains(&"write"));
        assert!(!names.contains(&"parse"));
    }

    #[test]
    fn explain_cites_edges_with_confidence_and_true_totals() {
        let g = tiny_graph();
        let ex = explain_node(&g, "fn:a.rs#save@9").unwrap();
        assert_eq!(ex.inbound_total, 1);
        assert_eq!(ex.outbound_total, 1);
        assert_eq!(ex.inbound[0].other.name, "handle");
        assert_eq!(ex.outbound[0].other.name, "write");
        assert!((ex.inbound[0].confidence - 0.7).abs() < 1e-9);
        assert_eq!(ex.head_sha, "abc");
    }

    #[test]
    fn path_follows_direction_and_multiplies_confidence() {
        let g = tiny_graph();
        let p = find_path(&g, "handle", "write", 6);
        assert!(p.found);
        assert!(p.directed);
        assert_eq!(p.hops.len(), 3);
        assert_eq!(p.hops[0].node.name, "handle");
        assert_eq!(p.hops[2].node.name, "write");
        // handle -[references 0.7]-> save -[references 0.7]-> write,
        // endpoints resolved by case-insensitive... exact name = 1.0 each.
        assert!((p.confidence - 0.49).abs() < 1e-9);
    }

    #[test]
    fn path_reports_absence_honestly() {
        let g = tiny_graph();
        let p = find_path(&g, "handle", "parse", 6);
        assert!(!p.found);
        assert!(p.from_resolved.is_some());
        assert!(p.to_resolved.is_some());
        assert_eq!(p.confidence, 0.0);
    }

    /// The stress gate for flipping CODE_MAP_ENABLED: a production-sized
    /// graph (≈20k nodes / ≈78k edges) must produce bounded views, paths
    /// and explanations without approaching a freeze. The wall-clock
    /// ceiling is deliberately loose — it exists to catch a quadratic
    /// regression, not to benchmark.
    #[test]
    fn stress_large_graph_stays_bounded_and_fast() {
        let g = synthetic_graph(2000, 9, 60_000); // 20k nodes, 78k edges
        let t0 = std::time::Instant::now();
        let overview = select_view(&g, &KgViewQuery { include_docs: true, ..Default::default() });
        let search = select_view(&g, &KgViewQuery {
            query: "fn_1500".into(),
            include_docs: true,
            ..Default::default()
        });
        let focus = select_view(&g, &KgViewQuery {
            focus: Some(overview.nodes[0].id.clone()),
            include_docs: true,
            ..Default::default()
        });
        let p = find_path(&g, &search.nodes[0].id, &overview.nodes[0].id, 8);
        let ex = explain_node(&g, &overview.nodes[0].id).unwrap();
        let elapsed = t0.elapsed();
        for v in [&overview, &search, &focus] {
            assert!(v.nodes.len() <= VIEW_NODE_CAP);
            assert!(v.edges.len() <= VIEW_EDGE_CAP);
        }
        assert!(ex.inbound.len() <= EXPLAIN_EDGE_CAP);
        assert!(ex.outbound.len() <= EXPLAIN_EDGE_CAP);
        let _ = p;
        assert!(
            elapsed.as_secs() < 5,
            "five bounded ops on a 20k-node graph took {elapsed:?} — quadratic regression?"
        );
    }
}

#[cfg(test)]
mod join_tests {
    use super::*;

    fn outline_node(id: &str, kind: &str, name: &str, file: &str, line: u32) -> KgNode {
        KgNode {
            id: id.into(),
            kind: kind.into(),
            name: name.into(),
            file: file.into(),
            line,
            degree: 0,
            community_id: 0,
            god: false,
            provenance: default_provenance(),
            content_hash: None,
        }
    }

    fn export_sym(node_id: &str, name: &str, file: &str, line: u32) -> CanonicalSymbolIn {
        CanonicalSymbolIn {
            node_id: node_id.into(),
            content_hash: format!("hash-{node_id}"),
            identifier: name.into(),
            kind: "function_definition".into(),
            file: Some(file.into()),
            line: Some(line),
        }
    }

    #[test]
    fn join_adopts_canonical_ids_and_remaps_edges() {
        let mut nodes = vec![
            outline_node("file:a.rs", "file", "a.rs", "a.rs", 0),
            outline_node("fn:a.rs#handle@10", "fn", "handle", "a.rs", 10),
            outline_node("fn:a.rs#save@30", "fn", "save", "a.rs", 30),
        ];
        let mut edges = vec![
            KgEdge { from: "file:a.rs".into(), to: "fn:a.rs#handle@10".into(), kind: "contains".into(), surprise: false, label: None, confidence: None },
            KgEdge { from: "fn:a.rs#handle@10".into(), to: "fn:a.rs#save@30".into(), kind: "references".into(), surprise: false, label: None, confidence: None },
        ];
        let export = CanonicalExport {
            schema_version: 1,
            graph_version: "v1".into(),
            symbols: vec![
                export_sym("aura1:h", "handle", "a.rs", 11),
                export_sym("aura1:s", "save", "a.rs", 30),
            ],
            edges: vec![CanonicalEdgeIn {
                from: "aura1:h".into(),
                to: "aura1:s".into(),
                kind: "calls".into(),
                label: Some("exact".into()),
                confidence: Some(0.95),
            }],
            ..Default::default()
        };
        let canonical = join_canonical(&mut nodes, &mut edges, &export);
        assert_eq!(canonical, 2);
        // The outline id is GONE — the canonical id is the one identity.
        assert!(nodes.iter().all(|n| n.id != "fn:a.rs#handle@10"));
        let h = nodes.iter().find(|n| n.id == "aura1:h").expect("adopted id");
        assert_eq!(h.provenance, "checkpoint");
        assert_eq!(h.content_hash.as_deref(), Some("hash-aura1:h"));
        // Every edge that touched the outline id was remapped.
        assert!(edges.iter().any(|e| e.from == "file:a.rs" && e.to == "aura1:h"));
        assert!(edges.iter().any(|e| e.from == "aura1:h" && e.to == "aura1:s" && e.kind == "references"));
        // The canonical call edge merged in.
        assert!(edges.iter().any(|e| e.from == "aura1:h" && e.to == "aura1:s" && e.kind == "calls"));
        // The file node stays path-keyed and outline-labeled.
        let f = nodes.iter().find(|n| n.id == "file:a.rs").unwrap();
        assert_eq!(f.provenance, "outline");
    }

    #[test]
    fn join_adds_symbols_the_outline_never_saw() {
        let mut nodes = vec![outline_node("file:a.rs", "file", "a.rs", "a.rs", 0)];
        let mut edges = vec![];
        let export = CanonicalExport {
            schema_version: 1,
            symbols: vec![export_sym("aura1:ghost", "ghost", "a.rs", 5)],
            ..Default::default()
        };
        let canonical = join_canonical(&mut nodes, &mut edges, &export);
        assert_eq!(canonical, 1);
        let g = nodes.iter().find(|n| n.id == "aura1:ghost").expect("appended");
        assert_eq!(g.kind, "fn");
        assert_eq!(g.provenance, "checkpoint");
        // Anchored under its file node.
        assert!(edges.iter().any(|e| e.from == "file:a.rs" && e.to == "aura1:ghost" && e.kind == "contains"));
    }

    #[test]
    fn join_matches_nearest_line_between_same_named_symbols() {
        let mut nodes = vec![
            outline_node("fn:a.rs#run@10", "fn", "run", "a.rs", 10),
            outline_node("fn:a.rs#run@90", "fn", "run", "a.rs", 90),
        ];
        let mut edges = vec![];
        let export = CanonicalExport {
            schema_version: 1,
            symbols: vec![
                export_sym("aura1:run-early", "run", "a.rs", 12),
                export_sym("aura1:run-late", "run", "a.rs", 88),
            ],
            ..Default::default()
        };
        join_canonical(&mut nodes, &mut edges, &export);
        assert_eq!(nodes.iter().find(|n| n.id == "aura1:run-early").unwrap().line, 10);
        assert_eq!(nodes.iter().find(|n| n.id == "aura1:run-late").unwrap().line, 90);
    }

    #[test]
    fn legacy_graph_json_parses_with_defaults_and_reads_as_pre_grf01() {
        // A graph.json written before GRF-01 — no schema_version, no
        // scope_root, no provenance fields anywhere. It must still parse
        // (old repositories migrate without loss) and identify itself as
        // legacy so ensure() rebuilds it.
        let legacy = r#"{
            "nodes": [{"id": "fn:a.rs#x@1", "kind": "fn", "name": "x", "file": "a.rs", "line": 1}],
            "edges": [],
            "built_at": 5,
            "head_sha": "abc",
            "stats": {"files": 0, "symbols": 1, "docs": 0, "edges": 0, "communities": 0, "gods": 0, "surprises": 0}
        }"#;
        let g: KgGraph = serde_json::from_str(legacy).expect("legacy graph must parse");
        assert_eq!(g.schema_version, 0);
        assert!(g.schema_version < KG_SCHEMA_VERSION);
        assert!(g.scope_root.is_empty());
        assert_eq!(g.nodes[0].provenance, "outline");
        assert_eq!(g.nodes[0].content_hash, None);
        assert_eq!(g.stats.canonical, 0);
    }

    #[test]
    fn scope_mismatch_reads_as_absent_never_someone_elses_graph() {
        let dir = std::env::temp_dir().join(format!(
            "aura-kg-scope-{}-{}",
            std::process::id(),
            now_secs()
        ));
        fs::create_dir_all(dir.join(".aura").join("kg")).unwrap();
        let root = dir.to_string_lossy().to_string();
        let graph = KgGraph {
            nodes: vec![],
            edges: vec![],
            built_at: 1,
            head_sha: "abc".into(),
            stats: KgStats::default(),
            schema_version: KG_SCHEMA_VERSION,
            scope_root: "/somewhere/else/entirely".into(),
            graph_version: "v".into(),
        };
        fs::write(
            dir.join(".aura").join("kg").join("graph.json"),
            serde_json::to_string(&graph).unwrap(),
        )
        .unwrap();
        let got = load_graph_cached(&root).expect("no io error");
        assert!(got.is_none(), "a graph scoped to another root must read as absent");
        // Same file with the RIGHT scope serves fine.
        let mut ok_graph = graph;
        ok_graph.scope_root = scope_root_for(&root);
        fs::write(
            dir.join(".aura").join("kg").join("graph.json"),
            serde_json::to_string(&ok_graph).unwrap(),
        )
        .unwrap();
        let got = load_graph_cached(&root).expect("no io error");
        assert!(got.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn canonical_kind_mapping_is_total() {
        assert_eq!(map_canonical_kind("function_definition"), "fn");
        assert_eq!(map_canonical_kind("method_definition"), "fn");
        assert_eq!(map_canonical_kind("class_definition"), "class");
        assert_eq!(map_canonical_kind("struct_item"), "class");
        assert_eq!(map_canonical_kind("type_alias"), "type");
        assert_eq!(map_canonical_kind(""), "type");
    }
}
