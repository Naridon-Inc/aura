//! # Code Atlas — a human-readable directory of the codebase
//!
//! `aura atlas` answers a deceptively hard question: *"what is in this project,
//! in plain English?"* It walks every tracked symbol and files it into one of a
//! few intuitive buckets, so the codebase reads like a **story of parts** rather
//! than a wall of raw function names:
//!
//! - **Features**  — user-facing entry points (a Tauri command, an HTTP route,
//!   a CLI subcommand, a UI screen). The things a *person* does with the app.
//! - **Components** — building blocks that compose other parts: classes, structs,
//!   modules, React components, and orchestrator functions (the "glue").
//! - **Atoms**     — small leaf helpers that don't call anything else. The
//!   bottom of the stack.
//! - **Patterns**  — recurring shapes the code keeps reusing (`*Pane`, `*_cmd`,
//!   `use*` hooks, `*Service`…). The grammar of the project.
//!
//! Every entry carries BOTH its raw `name` (`verify_token`) AND a humanized
//! `title` ("Verify Token"), a stable `key` (the rename-proof `node_id`), and a
//! plain-language `summary` derived deterministically from its shape in the call
//! graph. With `--ai`, the most important entries get an LLM-polished one-liner
//! layered on top (the deterministic summary always remains the floor).
//!
//! Output is threefold: a structured `.aura/atlas.json` registry (for tools and
//! the in-app page), a `.aura/atlas.md` long-form directory (for humans), and a
//! concise colored "story" printed to the terminal.
//!
//! The reverse call graph reused here ([`crate::callgraph`]) and the entry-point
//! classifier ([`crate::entrypoints`]) are the same engines that power the
//! feature-level impact gate, so the Atlas and the gate agree by construction.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use colored::Colorize;
use serde::Serialize;

use crate::callgraph::ReverseGraph;
use crate::checkpoint::CheckpointStore;
use crate::entrypoints::{self, EntryKind, EntryPoint};
use crate::gsd::{CognitiveLabor, GsdEngine};
use crate::models::AstNode;
use crate::parser::SemanticParser;

/// Schema version of the emitted `atlas.json`. Bump on breaking field changes.
const ATLAS_VERSION: u32 = 1;

/// `aura atlas` is an explicit, user-invoked command (not a hot gate path), so
/// the worktree scan gets a generous budget — we want completeness.
const MAX_SCAN_FILES: usize = 20_000;
const SCAN_TIME_BUDGET_MS: u128 = 60_000;

/// Source file extensions the parser understands (mirrors `impact.rs`).
const SOURCE_EXTS: &[&str] = &[
    "py", "rs", "ts", "tsx", "js", "jsx", "go", "java", "cs", "rb", "cpp", "cc",
    "cxx", "hpp", "c", "h", "php", "swift", "kt", "kts",
];

/// Directories we never descend into during the worktree scan.
const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", "dist", ".aura", "build"];

/// How many related symbols (callers/callees/members) to list per entry before
/// truncating with a "+N more" marker.
const PREVIEW_CAP: usize = 6;

/// A *curated* naming shape (`*Pane`, `*_cmd`, `use*`…) must recur at least
/// this many times to count as a pattern.
const PATTERN_MIN: usize = 3;

/// A *generic* concept cluster (grouping by the last word of a humanized title,
/// e.g. "…Path") is far weaker signal, so it needs a much higher count before
/// we call it a pattern — otherwise large repos drown in hundreds of them.
const GENERIC_PATTERN_MIN: usize = 12;

/// Upper bound on how many entries we send to the LLM polish pass, so `--ai`
/// stays cheap and bounded regardless of repo size. Features and the highest
/// fan-in components are prioritized.
const AI_MAX_ENTRIES: usize = 80;

// ---------------------------------------------------------------------------
// Serializable model — this IS the `.aura/atlas.json` contract.
// camelCase to match the rest of Aura's JSON surface (see impact.rs) and the
// in-app TypeScript consumer.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Atlas {
    pub version: u32,
    /// Unix seconds when this atlas was generated.
    pub generated_at: u64,
    /// Repository basename.
    pub repo: String,
    /// Where the symbol graph came from: `"checkpoint" | "worktree" | "none"`.
    pub graph_source: String,
    /// If sourced from a checkpoint, how many seconds old it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staleness_secs: Option<u64>,
    pub counts: AtlasCounts,
    /// Distinct human-readable layers present (e.g. "UI (React)", "Core (Rust)").
    pub layers: Vec<LayerCount>,
    /// User-facing entry points.
    pub features: Vec<AtlasEntry>,
    /// Building blocks: types, modules, React components, orchestrator functions.
    pub components: Vec<AtlasEntry>,
    /// Leaf helpers.
    pub atoms: Vec<AtlasEntry>,
    /// Recurring naming shapes.
    pub patterns: Vec<Pattern>,
    /// `"structural"` (deterministic only) or `"ai"` (LLM polish was applied to
    /// at least some entries).
    pub summary_source: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasCounts {
    pub total: usize,
    pub features: usize,
    pub components: usize,
    pub atoms: usize,
    pub patterns: usize,
    pub files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerCount {
    pub label: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasEntry {
    /// Stable, rename-proof identity (the AST `node_id`). The directory KEY.
    pub key: String,
    /// Raw source identifier, verbatim (`verify_token`).
    pub name: String,
    /// Humanized, Title-Cased rendering of the name ("Verify Token").
    pub title: String,
    /// `"feature" | "component" | "atom"`.
    pub role: String,
    /// Raw AST kind (`function_definition`, `struct_item`, …).
    pub kind: String,
    /// Human-readable architectural layer ("UI (React)", "Core (Rust)", …).
    pub layer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Plain-language description of the symbol's job.
    pub summary: String,
    /// `"structural"` or `"ai"` — provenance of *this entry's* summary.
    pub summary_source: String,
    /// For features: the humanized feature name ("Sign In").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
    /// For features: the kind of entry point ("tauri_command", "http_route", …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_kind: Option<String>,
    /// How many distinct tracked symbols call this one.
    pub fan_in: usize,
    /// Of those callers, how many were resolved with high confidence (exact
    /// same-file or import-resolved). The honest "really relied-on" number.
    pub confident_callers: usize,
    /// How many distinct tracked symbols this one calls.
    pub fan_out: usize,
    /// Humanized titles of a sample of direct callers.
    pub callers: Vec<String>,
    /// Humanized titles of a sample of direct callees.
    pub calls: Vec<String>,
    /// Quick flags: "glue", "type", "group", "ui", "leaf", "async", "public",
    /// "secret", "stub", "unused".
    pub tags: Vec<String>,
    /// Doc comment / docstring, trimmed, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pattern {
    /// Friendly label ("Workpane (*Pane)").
    pub label: String,
    /// The shared shape marker (`*Pane`, `*_cmd`, `use*`…).
    pub glyph: String,
    pub count: usize,
    /// One-line plain-language description of what the pattern is for.
    pub description: String,
    /// Humanized member titles (capped at [`PREVIEW_CAP`]).
    pub members: Vec<String>,
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/// Run `aura atlas`. Resolves the repo root from CWD, builds the atlas, writes
/// `.aura/atlas.json` + `.aura/atlas.md`, optionally LLM-polishes summaries, and
/// prints a concise terminal story. Returns a process exit code.
pub fn run(ai: bool, json_only: bool) -> i32 {
    let repo_root = match discover_repo_root() {
        Some(r) => r,
        None => {
            eprintln!("{} not inside a project directory", "atlas:".red().bold());
            return 1;
        }
    };

    if !json_only {
        println!("{} scanning the codebase…", "atlas".cyan().bold());
    }

    let mut atlas = build_atlas(&repo_root);

    if atlas.counts.total == 0 {
        println!(
            "{} no symbols found yet.\n  Make a checkpoint (edit + commit, or `aura status`) or ensure source files exist, then re-run `aura atlas`.",
            "atlas:".yellow().bold()
        );
        return 0;
    }

    if ai {
        if !json_only {
            println!("{} polishing summaries with AI…", "atlas".cyan().bold());
        }
        let polished = ai_polish(&mut atlas);
        if polished > 0 {
            atlas.summary_source = "ai".to_string();
            if !json_only {
                println!("  {} {polished} summaries refined", "✓".green());
            }
        } else if !json_only {
            println!(
                "  {} no AI provider configured — keeping structural summaries (set one via `aura config`)",
                "·".dimmed()
            );
        }
    }

    // Persist the structured registry + the long-form human directory.
    let aura_dir = repo_root.join(".aura");
    if let Err(e) = fs::create_dir_all(&aura_dir) {
        eprintln!("{} could not create .aura/: {e}", "atlas:".red().bold());
        return 1;
    }
    let json_path = aura_dir.join("atlas.json");
    let md_path = aura_dir.join("atlas.md");

    match serde_json::to_string_pretty(&atlas) {
        Ok(s) => {
            if let Err(e) = fs::write(&json_path, s) {
                eprintln!("{} could not write atlas.json: {e}", "atlas:".red().bold());
                return 1;
            }
        }
        Err(e) => {
            eprintln!("{} could not serialize atlas: {e}", "atlas:".red().bold());
            return 1;
        }
    }

    let markdown = render_markdown(&atlas);
    if let Err(e) = fs::write(&md_path, &markdown) {
        eprintln!("{} could not write atlas.md: {e}", "atlas:".red().bold());
        return 1;
    }

    if json_only {
        // Machine mode: emit the registry to stdout for piping.
        if let Ok(s) = serde_json::to_string(&atlas) {
            println!("{s}");
        }
        return 0;
    }

    print_story(&atlas);
    println!(
        "\n{}  {}\n{}  {}",
        "registry →".dimmed(),
        rel_display(&repo_root, &json_path).dimmed(),
        "directory →".dimmed(),
        rel_display(&repo_root, &md_path).dimmed(),
    );
    0
}

// ---------------------------------------------------------------------------
// Graph loading (checkpoint → worktree → none), mirrors impact.rs strategy but
// loads the WHOLE repo rather than one file's neighborhood.
// ---------------------------------------------------------------------------

enum GraphSource {
    Checkpoint,
    Worktree,
    None,
}

impl GraphSource {
    fn as_str(&self) -> &'static str {
        match self {
            GraphSource::Checkpoint => "checkpoint",
            GraphSource::Worktree => "worktree",
            GraphSource::None => "none",
        }
    }
}

/// Build the full [`Atlas`] for `repo_root`. Pure orchestration over the loader,
/// the reverse graph, classification, summarization, and pattern detection.
pub fn build_atlas(repo_root: &Path) -> Atlas {
    let (nodes, source, staleness) = load_nodes(repo_root);
    let graph = ReverseGraph::build(&nodes);

    // id → humanized title, for naming callers/callees in previews.
    let id_to_title = build_title_index(&nodes);

    // Read every source file exactly once. Entry-point classification peeks the
    // file content (for attributes / route tables), and a file holds many
    // nodes — without this cache we'd re-read each file once per symbol, which
    // turns the whole-repo pass from seconds into minutes.
    let mut content_cache: HashMap<String, Option<String>> = HashMap::new();
    let mut files: HashSet<String> = HashSet::new();
    for node in &nodes {
        if let Some(f) = node.file_path.as_deref() {
            files.insert(f.to_string());
            content_cache.entry(f.to_string()).or_insert_with(|| {
                fs::read_to_string(repo_root.join(f)).ok()
            });
        }
    }

    // Classify each indexable node into a directory entry, deduping by key.
    let mut by_key: BTreeMap<String, AtlasEntry> = BTreeMap::new();
    for node in &nodes {
        let content = node
            .file_path
            .as_deref()
            .and_then(|f| content_cache.get(f))
            .and_then(|c| c.as_deref());
        if let Some(entry) = classify_entry(node, repo_root, &graph, &id_to_title, content) {
            match by_key.get(&entry.key) {
                Some(existing) if entry_richness(existing) >= entry_richness(&entry) => {}
                _ => {
                    by_key.insert(entry.key.clone(), entry);
                }
            }
        }
    }

    let entries: Vec<AtlasEntry> = by_key.into_values().collect();
    let patterns = detect_patterns(&entries);

    // Split into the three human buckets and sort each for stable, useful order.
    let mut features: Vec<AtlasEntry> = Vec::new();
    let mut components: Vec<AtlasEntry> = Vec::new();
    let mut atoms: Vec<AtlasEntry> = Vec::new();
    for e in entries {
        match e.role.as_str() {
            "feature" => features.push(e),
            "atom" => atoms.push(e),
            _ => components.push(e),
        }
    }
    // Rank building blocks by *confident* reliance first, so ambiguous common
    // names (`new`, `from`, `default`) can't dominate the headline.
    features.sort_by(|a, b| a.feature.cmp(&b.feature).then(a.title.cmp(&b.title)));
    components.sort_by(|a, b| {
        b.confident_callers
            .cmp(&a.confident_callers)
            .then(b.fan_in.cmp(&a.fan_in))
            .then(a.title.cmp(&b.title))
    });
    atoms.sort_by(|a, b| {
        b.confident_callers
            .cmp(&a.confident_callers)
            .then(b.fan_in.cmp(&a.fan_in))
            .then(a.title.cmp(&b.title))
    });

    let layers = count_layers(&features, &components, &atoms);

    let counts = AtlasCounts {
        total: features.len() + components.len() + atoms.len(),
        features: features.len(),
        components: components.len(),
        atoms: atoms.len(),
        patterns: patterns.len(),
        files: files.len(),
    };

    Atlas {
        version: ATLAS_VERSION,
        generated_at: now_secs(),
        repo: repo_root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".to_string()),
        graph_source: source.as_str().to_string(),
        staleness_secs: staleness,
        counts,
        layers,
        features,
        components,
        atoms,
        patterns,
        summary_source: "structural".to_string(),
    }
}

/// Load the symbol set for the atlas.
///
/// Unlike the impact gate (which favors the newest checkpoint and refreshes one
/// file), the atlas is a *directory of the code as it exists right now*, so it
/// prefers a live worktree scan: only the worktree carries real file paths,
/// which entry-point classification, layer inference, and same-file call
/// resolution all depend on. Many checkpoints store path-less nodes, which
/// would collapse every symbol into an unclassifiable "Other" blob — so the
/// checkpoint is used only as a fallback when the worktree can't be scanned.
fn load_nodes(repo_root: &Path) -> (Vec<AstNode>, GraphSource, Option<u64>) {
    let scanned = scan_worktree(repo_root);
    if !scanned.is_empty() {
        return (scanned, GraphSource::Worktree, None);
    }

    // Fallback: newest checkpoint (may be path-poor, but better than nothing).
    if let Ok(repo) = git2::Repository::open(repo_root) {
        if let Ok(checkpoints) = CheckpointStore::get_all_checkpoints(&repo) {
            if let Some(newest) = checkpoints.into_iter().next() {
                if !newest.ast_nodes.is_empty() {
                    let staleness = now_secs().saturating_sub(newest.timestamp);
                    return (newest.ast_nodes, GraphSource::Checkpoint, Some(staleness));
                }
            }
        }
    }

    (Vec::new(), GraphSource::None, None)
}

/// Bounded recursive scan of the worktree, parsing every source file into AST
/// nodes. Honors a file cap + wall-clock budget; partial results are fine.
fn scan_worktree(repo_root: &Path) -> Vec<AstNode> {
    let start = Instant::now();
    let mut out: Vec<AstNode> = Vec::new();
    let mut files_seen = 0usize;
    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return out,
    };

    let mut stack: Vec<PathBuf> = vec![repo_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if files_seen >= MAX_SCAN_FILES || start.elapsed().as_millis() > SCAN_TIME_BUDGET_MS {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if files_seen >= MAX_SCAN_FILES || start.elapsed().as_millis() > SCAN_TIME_BUDGET_MS {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
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
            if let Ok(source) = fs::read_to_string(&path) {
                if let Ok(nodes) = parser.parse_file_with_path(&source, ext, &rel) {
                    out.extend(nodes);
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Classification — the heart of the directory.
// ---------------------------------------------------------------------------

/// Turn one AST node into a directory [`AtlasEntry`], or `None` if it isn't an
/// indexable symbol (imports, comments, fields, anonymous/private noise).
fn classify_entry(
    node: &AstNode,
    repo_root: &Path,
    graph: &ReverseGraph,
    id_to_title: &HashMap<String, String>,
    content: Option<&str>,
) -> Option<AtlasEntry> {
    let name = node.identifier.as_deref()?.trim();
    if !is_indexable(node, name) {
        return None;
    }

    // Fan-in: who calls this node (resolved reverse adjacency). We track total
    // distinct callers AND a *confident* subset (callers resolved exactly or via
    // an import) — the confident count is what we rank by, so that an ambiguous
    // common name like `new`, which name-only-resolves to dozens of call sites,
    // can't masquerade as the most-relied-on symbol in the repo.
    let caller_edges = graph.callers_of_node(&node.node_id);
    let mut caller_ids: Vec<String> = Vec::new();
    let mut seen_callers: HashSet<String> = HashSet::new();
    let mut confident_callers: HashSet<String> = HashSet::new();
    for e in &caller_edges {
        if matches!(
            e.confidence,
            crate::callgraph::EdgeConfidence::Exact | crate::callgraph::EdgeConfidence::ImportResolved
        ) {
            confident_callers.insert(e.caller_node_id.clone());
        }
        if seen_callers.insert(e.caller_node_id.clone()) {
            caller_ids.push(e.caller_node_id.clone());
        }
    }
    let fan_in = caller_ids.len();
    let confident_fan_in = confident_callers.len();

    // Fan-out: distinct tracked symbols this node calls.
    let file = node.file_path.as_deref();
    let mut callee_ids: Vec<String> = Vec::new();
    let mut seen_callees: HashSet<String> = HashSet::new();
    for dep in &node.dependencies {
        if let Some(def_id) = graph.resolve_def(&dep.name, file) {
            if def_id != node.node_id && seen_callees.insert(def_id.clone()) {
                callee_ids.push(def_id);
            }
        }
    }
    let fan_out = callee_ids.len();

    // Is this a user-facing entry point? Uses the pre-read file content (no
    // per-node file open) and skips the cross-file sibling-router scan, which
    // is far too costly to run across every symbol in the repo.
    let entry: Option<EntryPoint> =
        entrypoints::classify_with_content(node, repo_root, content, false);

    // The Features bucket answers "what does a person *do* with this project?",
    // so only genuine user-facing surfaces (Tauri commands, HTTP routes, CLI
    // subcommands, UI screens) count. The `PublicApi` fallback is a broad
    // "this is a public boundary" signal — useful, but it would flood the
    // headline with hundreds of internal `pub fn`s — so it's demoted to a
    // tagged component rather than a feature.
    let is_public_api = matches!(entry.as_ref().map(|e| &e.kind), Some(EntryKind::PublicApi));
    let user_facing = entry.is_some() && !is_public_api;
    let (role, mut tags) = assign_role(&node.kind, name, file, user_facing, fan_out);
    if is_public_api {
        tags.push("public-api".to_string());
    }

    // Structural flags become tags too.
    if node.contains_secret {
        tags.push("secret".to_string());
    }
    if node.is_stub {
        tags.push("stub".to_string());
    }
    if let Some(sig) = node.signature.as_deref() {
        if sig.contains("async ") || sig.contains("async fn") {
            tags.push("async".to_string());
        }
        if sig.trim_start().starts_with("pub ") || sig.contains("export ") {
            tags.push("public".to_string());
        }
    }
    if fan_in == 0 && role != "feature" {
        tags.push("unused".to_string());
    }

    let title = entrypoints::humanize(name);
    let layer = layer_of(file, &node.kind).to_string();

    let callers: Vec<String> = caller_ids
        .iter()
        .take(PREVIEW_CAP)
        .map(|id| title_for(id, id_to_title))
        .collect();
    let calls: Vec<String> = callee_ids
        .iter()
        .take(PREVIEW_CAP)
        .map(|id| title_for(id, id_to_title))
        .collect();

    let (feature_name, entry_kind) = if user_facing {
        let ep = entry.as_ref().unwrap();
        let fname = ep.feature_name.trim();
        // A route like "/" humanizes to an empty string — fall back to the
        // symbol title rather than render "the **** feature".
        let fname = if fname.is_empty() {
            None
        } else {
            Some(fname.to_string())
        };
        (fname, Some(entry_kind_str(&ep.kind).to_string()))
    } else {
        (None, None)
    };

    let mut entry_out = AtlasEntry {
        key: node.node_id.clone(),
        name: name.to_string(),
        title,
        role: role.to_string(),
        kind: node.kind.clone(),
        layer,
        file: file.map(|s| s.to_string()),
        line: node.start_line,
        signature: node.signature.clone(),
        summary: String::new(), // filled below
        summary_source: "structural".to_string(),
        feature: feature_name,
        entry_kind,
        fan_in,
        confident_callers: confident_fan_in,
        fan_out,
        callers,
        calls,
        tags,
        doc: node
            .doc_comment
            .as_deref()
            .map(|d| trim_doc(d))
            .filter(|d| !d.is_empty()),
    };
    entry_out.summary = structural_summary(&entry_out, &entry);
    Some(entry_out)
}

/// Whether a node is worth listing in the directory at all.
fn is_indexable(node: &AstNode, name: &str) -> bool {
    if name.is_empty() || name == "anonymous" || name.starts_with("__") {
        return false;
    }
    // A raw import statement sometimes lands as a node identifier; never list it.
    if name.starts_with("use ") || name.starts_with("import ") || name.contains("::") && name.contains(' ') {
        return false;
    }
    is_fn_kind(&node.kind) || is_type_kind(&node.kind) || is_container_kind(&node.kind)
}

/// Decide the directory bucket + descriptive tags for a symbol.
///
/// Pure (no IO) so it is unit-testable directly.
fn assign_role(
    kind: &str,
    name: &str,
    file: Option<&str>,
    is_entry: bool,
    fan_out: usize,
) -> (&'static str, Vec<String>) {
    if is_entry {
        return ("feature", Vec::new());
    }
    if is_container_kind(kind) {
        return ("component", vec!["group".to_string()]);
    }
    if is_type_kind(kind) {
        return ("component", vec!["type".to_string()]);
    }
    // Function-like from here on.
    if is_react_component(name, file) {
        return ("component", vec!["ui".to_string()]);
    }
    if fan_out == 0 {
        return ("atom", vec!["leaf".to_string()]);
    }
    // Calls into other tracked symbols → an orchestrator / glue component.
    ("component", vec!["glue".to_string()])
}

fn is_fn_kind(kind: &str) -> bool {
    let k = kind.to_lowercase();
    k.contains("function")
        || k.contains("method")
        || k == "arrow_function"
        || k.contains("constructor")
}

fn is_type_kind(kind: &str) -> bool {
    let k = kind.to_lowercase();
    k.contains("struct")
        || k.contains("enum")
        || k.contains("interface")
        || k.contains("type_alias")
        || k.contains("type_definition")
        || k.contains("type_item")
}

fn is_container_kind(kind: &str) -> bool {
    let k = kind.to_lowercase();
    k.contains("class")
        || k.contains("trait")
        || k.contains("impl")
        || k.contains("module")
        || k == "mod"
        || k.contains("namespace")
}

/// React component heuristic: PascalCase identifier in a `.tsx`/`.jsx` file.
fn is_react_component(name: &str, file: Option<&str>) -> bool {
    let in_jsx = file
        .map(|f| f.ends_with(".tsx") || f.ends_with(".jsx"))
        .unwrap_or(false);
    if !in_jsx {
        return false;
    }
    name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Deterministic summaries — the always-on plain-language floor.
// ---------------------------------------------------------------------------

/// Compose a plain-English description of a symbol purely from its shape.
fn structural_summary(e: &AtlasEntry, entry: &Option<EntryPoint>) -> String {
    let mut s = match e.role.as_str() {
        "feature" => {
            let noun = entry
                .as_ref()
                .map(|ep| entry_noun(&ep.kind))
                .unwrap_or("entry point");
            let feat = e.feature.clone().unwrap_or_else(|| e.title.clone());
            let mut base = format!("User-facing {noun} — the **{feat}** feature.");
            if e.fan_out > 0 {
                base.push_str(&format!(" Drives {} helper(s) under the hood.", e.fan_out));
            }
            base
        }
        "atom" => {
            if e.fan_in == 0 {
                "A small leaf helper, not yet called from anywhere.".to_string()
            } else {
                format!(
                    "A small leaf helper, reused by {} place(s).",
                    e.fan_in
                )
            }
        }
        // component
        _ => {
            if e.tags.iter().any(|t| t == "type") {
                let used = if e.fan_in > 0 {
                    format!(" Referenced in {} place(s).", e.fan_in)
                } else {
                    String::new()
                };
                format!("A data shape that other parts pass around.{used}")
            } else if e.tags.iter().any(|t| t == "group") {
                "A module/class that groups related logic together.".to_string()
            } else if e.tags.iter().any(|t| t == "ui") {
                if e.fan_in > 0 {
                    format!("A UI component, mounted in {} place(s).", e.fan_in)
                } else {
                    "A UI component.".to_string()
                }
            } else {
                // glue / orchestrator function
                format!(
                    "Coordinates {} other part(s); called by {}.",
                    e.fan_out, e.fan_in
                )
            }
        }
    };

    if e.tags.iter().any(|t| t == "secret") {
        s.push_str(" ⚠ Handles a secret.");
    }
    if e.tags.iter().any(|t| t == "stub") {
        s.push_str(" (unfinished / stub.)");
    }
    s
}

/// Map an [`EntryKind`] to the plain noun used in feature summaries.
fn entry_noun(kind: &EntryKind) -> &'static str {
    match kind {
        EntryKind::TauriCommand => "desktop command",
        EntryKind::HttpRoute => "web route",
        EntryKind::CliCommand => "CLI command",
        EntryKind::UiComponent => "screen",
        EntryKind::PublicApi => "public API",
    }
}

/// Stable snake_case string for an [`EntryKind`] (the JSON `entryKind` value).
fn entry_kind_str(kind: &EntryKind) -> &'static str {
    match kind {
        EntryKind::TauriCommand => "tauri_command",
        EntryKind::HttpRoute => "http_route",
        EntryKind::CliCommand => "cli_command",
        EntryKind::UiComponent => "ui_component",
        EntryKind::PublicApi => "public_api",
    }
}

// ---------------------------------------------------------------------------
// Pattern detection — the recurring shapes of the project.
// ---------------------------------------------------------------------------

/// Curated label + description for well-known naming shapes. The detector falls
/// back to a generic "last word" grouping for anything not listed here.
fn known_shape(name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    // (glyph, label, description)
    let lname = name;
    if lname.ends_with("_cmd") {
        return Some(("*_cmd", "Command", "Invocable commands wired to the desktop/CLI surface."));
    }
    if lname.ends_with("Pane") {
        return Some(("*Pane", "Workpane", "Main content surfaces — the big panels users work in."));
    }
    if lname.ends_with("Dialog") {
        return Some(("*Dialog", "Dialog", "Modal dialogs for focused, interruptive tasks."));
    }
    if lname.ends_with("View") {
        return Some(("*View", "View", "Top-level screens / routed views."));
    }
    if lname.ends_with("Panel") {
        return Some(("*Panel", "Panel", "Embedded panels within larger surfaces."));
    }
    if lname.ends_with("Card") {
        return Some(("*Card", "Card", "Self-contained card UI blocks."));
    }
    if lname.ends_with("Provider") {
        return Some(("*Provider", "Provider", "React context providers wrapping the app tree."));
    }
    if lname.ends_with("Store") {
        return Some(("*Store", "Store", "State containers holding app data."));
    }
    if lname.ends_with("Service") {
        return Some(("*Service", "Service", "Service objects encapsulating a capability."));
    }
    if lname.ends_with("Manager") {
        return Some(("*Manager", "Manager", "Coordinators that own a lifecycle or resource pool."));
    }
    if lname.ends_with("Engine") {
        return Some(("*Engine", "Engine", "Core engines that do the heavy lifting."));
    }
    if lname.ends_with("_handler") || lname.ends_with("Handler") {
        return Some(("*Handler", "Handler", "Request/event handlers."));
    }
    if lname.ends_with("Context") {
        return Some(("*Context", "Context", "Shared context objects threaded through calls."));
    }
    if lname.starts_with("use") && lname.len() > 3 && lname.as_bytes()[3].is_ascii_uppercase() {
        return Some(("use*", "React Hook", "Custom React hooks encapsulating reusable behavior."));
    }
    None
}

/// Find naming shapes that recur at least [`PATTERN_MIN`] times.
fn detect_patterns(entries: &[AtlasEntry]) -> Vec<Pattern> {
    // glyph → (label, description, member titles)
    let mut buckets: BTreeMap<String, (String, String, Vec<String>)> = BTreeMap::new();

    for e in entries {
        if let Some((glyph, label, desc)) = known_shape(&e.name) {
            let slot = buckets
                .entry(glyph.to_string())
                .or_insert_with(|| (label.to_string(), desc.to_string(), Vec::new()));
            slot.2.push(e.title.clone());
        } else {
            // Generic fallback: group by the last word of the humanized title.
            if let Some(last) = e.title.split_whitespace().last() {
                if last.len() >= 3 {
                    let glyph = format!("…{last}");
                    let slot = buckets.entry(glyph.clone()).or_insert_with(|| {
                        (
                            format!("{last} group"),
                            format!("Symbols that share the “{last}” concept."),
                            Vec::new(),
                        )
                    });
                    slot.2.push(e.title.clone());
                }
            }
        }
    }

    let mut patterns: Vec<Pattern> = buckets
        .into_iter()
        .filter(|(glyph, (_, _, members))| {
            // Curated architectural shapes are strong signal at a low count;
            // generic concept clusters ("…Path") need many more to qualify.
            let threshold = if glyph.starts_with('…') {
                GENERIC_PATTERN_MIN
            } else {
                PATTERN_MIN
            };
            members.len() >= threshold
        })
        .map(|(glyph, (label, description, mut members))| {
            let count = members.len();
            members.sort();
            members.truncate(PREVIEW_CAP);
            Pattern {
                label: format!("{label} ({glyph})"),
                glyph,
                count,
                description,
                members,
            }
        })
        .collect();

    // Curated architectural shapes (the real "grammar" — `*Pane`, `*_cmd`,
    // hooks, services) lead; generic concept clusters ("…Path") follow, even
    // though a concept cluster may have a higher raw count.
    patterns.sort_by(|a, b| {
        let a_generic = a.glyph.starts_with('…');
        let b_generic = b.glyph.starts_with('…');
        a_generic
            .cmp(&b_generic)
            .then(b.count.cmp(&a.count))
            .then(a.label.cmp(&b.label))
    });
    patterns
}

// ---------------------------------------------------------------------------
// Optional AI polish — layered ON TOP of the deterministic floor.
// ---------------------------------------------------------------------------

/// Refine the summaries of the most important entries with a single batched LLM
/// call. Returns how many summaries were replaced. On any failure (no provider,
/// network error, bad JSON) it changes nothing — the deterministic summary
/// remains. This is a real call into Aura's configured provider, never a stub.
fn ai_polish(atlas: &mut Atlas) -> usize {
    // Prioritize: every feature, then highest-fan-in components, up to the cap.
    let mut targets: Vec<&AtlasEntry> = Vec::new();
    for f in &atlas.features {
        targets.push(f);
    }
    for c in &atlas.components {
        if targets.len() >= AI_MAX_ENTRIES {
            break;
        }
        targets.push(c);
    }
    if targets.is_empty() {
        return 0;
    }
    targets.truncate(AI_MAX_ENTRIES);

    // Compact JSON the model can reason over without seeing raw source.
    let payload: Vec<serde_json::Value> = targets
        .iter()
        .map(|e| {
            serde_json::json!({
                "key": e.key,
                "name": e.name,
                "title": e.title,
                "role": e.role,
                "layer": e.layer,
                "signature": e.signature,
                "calls": e.calls,
                "calledBy": e.callers,
                "structural": e.summary,
            })
        })
        .collect();

    let user_prompt = match serde_json::to_string(&payload) {
        Ok(s) => s,
        Err(_) => return 0,
    };

    let system_prompt = "You are writing a plain-English code directory for people who don't read code. \
For each symbol in the JSON array, write ONE short sentence (max 18 words) saying what it does for the user in \
real-world terms — what it is FOR, not how it works inside. Lead with the meaning. Skip jargon (AST, async, \
generics, git); if a technical word is unavoidable, gloss it in plain words. Describe only what the data shows — \
do not guess at intent the code doesn't state. Do not restate the name. \
Return ONLY a JSON object mapping each symbol's \"key\" to its sentence, with no markdown fences or commentary.";

    let raw = match GsdEngine::generate_content(
        system_prompt,
        &user_prompt,
        0.3,
        CognitiveLabor::Researcher,
    ) {
        Some(r) => r,
        None => return 0,
    };

    let map = match parse_summary_map(&raw) {
        Some(m) => m,
        None => return 0,
    };

    // Apply across all buckets by key.
    let mut applied = 0usize;
    for bucket in [
        &mut atlas.features,
        &mut atlas.components,
        &mut atlas.atoms,
    ] {
        for e in bucket.iter_mut() {
            if let Some(text) = map.get(&e.key) {
                let cleaned = text.trim();
                if !cleaned.is_empty() {
                    e.summary = cleaned.to_string();
                    e.summary_source = "ai".to_string();
                    applied += 1;
                }
            }
        }
    }
    applied
}

/// Extract a `key → sentence` map from an LLM response, tolerating stray prose
/// or ```json fences around the object.
fn parse_summary_map(raw: &str) -> Option<HashMap<String, String>> {
    // Find the outermost JSON object.
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    let slice = &raw[start..=end];
    serde_json::from_str::<HashMap<String, String>>(slice).ok()
}

// ---------------------------------------------------------------------------
// Rendering — the human "story".
// ---------------------------------------------------------------------------

/// Render the full long-form directory as Markdown for `.aura/atlas.md`.
fn render_markdown(atlas: &Atlas) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Code Atlas — {}\n\n", atlas.repo));

    let stale = match atlas.staleness_secs {
        Some(s) => format!(" · {} old", human_duration(s)),
        None => String::new(),
    };
    out.push_str(&format!(
        "_{} symbols across {} files · source: {}{} · summaries: {}_\n\n",
        atlas.counts.total,
        atlas.counts.files,
        atlas.graph_source,
        stale,
        atlas.summary_source,
    ));

    out.push_str("> A plain-English directory of this project: the **features** people use, ");
    out.push_str("the **components** that build them, the **atoms** underneath, and the ");
    out.push_str("**patterns** the code keeps reusing.\n\n");

    // Layers overview.
    if !atlas.layers.is_empty() {
        out.push_str("**Layers:** ");
        let parts: Vec<String> = atlas
            .layers
            .iter()
            .map(|l| format!("{} ({})", l.label, l.count))
            .collect();
        out.push_str(&parts.join(" · "));
        out.push_str("\n\n");
    }

    out.push_str(&format!("## 🎯 Features ({})\n\n", atlas.features.len()));
    out.push_str("_What a person can actually do with this project._\n\n");
    for e in &atlas.features {
        render_entry_md(&mut out, e, true);
    }

    out.push_str(&format!("\n## 🧩 Components ({})\n\n", atlas.components.len()));
    out.push_str("_Reusable building blocks — types, modules, UI, and the glue between them._\n\n");
    for e in &atlas.components {
        render_entry_md(&mut out, e, false);
    }

    out.push_str(&format!("\n## ⚛ Atoms ({})\n\n", atlas.atoms.len()));
    out.push_str("_Small leaf helpers at the bottom of the stack._\n\n");
    for e in &atlas.atoms {
        out.push_str(&format!(
            "- **{}** `{}` — {}{}\n",
            e.title,
            e.name,
            e.summary,
            location_suffix(e),
        ));
    }

    out.push_str(&format!("\n## 🔁 Patterns ({})\n\n", atlas.patterns.len()));
    out.push_str("_Recurring shapes — the grammar of the codebase._\n\n");
    for p in &atlas.patterns {
        let mut members = p.members.join(", ");
        if p.count > p.members.len() {
            members.push_str(&format!(", +{} more", p.count - p.members.len()));
        }
        out.push_str(&format!(
            "- **{}** ×{} — {}\n  <sub>{}</sub>\n",
            p.label, p.count, p.description, members,
        ));
    }

    out
}

/// Render one feature/component entry as a Markdown block.
fn render_entry_md(out: &mut String, e: &AtlasEntry, is_feature: bool) {
    out.push_str(&format!("### {}  `{}`\n\n", e.title, e.name));
    out.push_str(&format!("{}\n\n", e.summary));
    if let Some(sig) = &e.signature {
        out.push_str(&format!("```\n{}\n```\n\n", sig.trim()));
    }
    let mut facts: Vec<String> = Vec::new();
    if let (Some(f), Some(l)) = (&e.file, e.line) {
        facts.push(format!("📍 `{f}:{l}`"));
    } else if let Some(f) = &e.file {
        facts.push(format!("📍 `{f}`"));
    }
    facts.push(format!("layer: {}", e.layer));
    if is_feature {
        if !e.calls.is_empty() {
            facts.push(format!("reaches: {}", e.calls.join(" → ")));
        }
    } else {
        facts.push(format!("used by {} · uses {}", e.fan_in, e.fan_out));
    }
    if !e.tags.is_empty() {
        facts.push(format!("[{}]", e.tags.join(", ")));
    }
    out.push_str(&facts.join(" · "));
    out.push_str("\n\n");
}

/// Print a concise, colored "story" of the codebase to the terminal.
fn print_story(atlas: &Atlas) {
    let stale = match atlas.staleness_secs {
        Some(s) => format!(" · {} old", human_duration(s)),
        None => String::new(),
    };
    println!(
        "\n{} {}",
        "📖 Code Atlas —".bold(),
        atlas.repo.bold().cyan()
    );
    println!(
        "{}",
        format!(
            "{} symbols · {} files · {}{}",
            atlas.counts.total, atlas.counts.files, atlas.graph_source, stale
        )
        .dimmed()
    );

    println!(
        "\n  {} {}   {} {}   {} {}   {} {}",
        atlas.counts.features.to_string().bold(),
        "features".green(),
        atlas.counts.components.to_string().bold(),
        "components".blue(),
        atlas.counts.atoms.to_string().bold(),
        "atoms".magenta(),
        atlas.counts.patterns.to_string().bold(),
        "patterns".yellow(),
    );

    // Top features — the headline of the story.
    if !atlas.features.is_empty() {
        println!("\n{}", "🎯 What people do here".green().bold());
        for e in atlas.features.iter().take(12) {
            println!(
                "   {} {}  {}",
                "•".green(),
                e.title.bold(),
                e.summary.dimmed()
            );
        }
        if atlas.features.len() > 12 {
            println!("   {}", format!("… +{} more", atlas.features.len() - 12).dimmed());
        }
    }

    // Patterns — the project's grammar.
    if !atlas.patterns.is_empty() {
        println!("\n{}", "🔁 Recurring shapes".yellow().bold());
        for p in atlas.patterns.iter().take(8) {
            println!(
                "   {} {} {}",
                format!("×{}", p.count).bold(),
                p.label.yellow(),
                p.description.dimmed()
            );
        }
    }

    // A couple of standout components by fan-in. Trait/constructor boilerplate
    // (`new`, `default`, `from`, `fmt`…) is filtered from this headline — it's
    // technically high-fan-in but says nothing about the project's design.
    let standouts: Vec<&AtlasEntry> = atlas
        .components
        .iter()
        .filter(|e| !is_headline_noise(&e.name) && e.confident_callers > 0)
        .take(6)
        .collect();
    if !standouts.is_empty() {
        println!("\n{}", "🧩 Most-relied-on building blocks".blue().bold());
        for e in standouts {
            println!(
                "   {} {}  {}",
                format!("⇐{}", e.confident_callers).bold(),
                e.title.bold(),
                e.summary.dimmed()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Trait-impl / constructor boilerplate whose name carries no design meaning —
/// excluded from the "most-relied-on" headline (they remain in the full list).
fn is_headline_noise(name: &str) -> bool {
    matches!(
        name,
        "new" | "default"
            | "from"
            | "from_str"
            | "try_from"
            | "try_into"
            | "fmt"
            | "drop"
            | "eq"
            | "ne"
            | "hash"
            | "cmp"
            | "partial_cmp"
            | "deref"
            | "deref_mut"
            | "borrow"
            | "as_ref"
            | "clone"
            | "default_value"
    )
}

/// "Richness" score used to pick the best entry when two share a `node_id`.
fn entry_richness(e: &AtlasEntry) -> usize {
    let mut r = 0;
    if e.file.is_some() {
        r += 2;
    }
    if e.signature.is_some() {
        r += 2;
    }
    if e.doc.is_some() {
        r += 1;
    }
    r + e.fan_in + e.fan_out
}

/// Build a `node_id → humanized title` index over all nodes (for caller/callee
/// previews). Last write wins; previews are illustrative, not exhaustive.
fn build_title_index(nodes: &[AstNode]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for n in nodes {
        if let Some(id) = n.identifier.as_deref() {
            let id = id.trim();
            if !id.is_empty() && id != "anonymous" {
                map.insert(n.node_id.clone(), entrypoints::humanize(id));
            }
        }
    }
    map
}

fn title_for(node_id: &str, index: &HashMap<String, String>) -> String {
    index
        .get(node_id)
        .cloned()
        .unwrap_or_else(|| node_id.to_string())
}

/// Map a file path + kind to a human architectural layer label.
fn layer_of(file: Option<&str>, _kind: &str) -> &'static str {
    let f = match file {
        Some(f) => f,
        None => return "Other",
    };
    if f.contains("src-tauri") {
        return "Desktop Backend (Rust)";
    }
    if f.contains("aura-cloud") || f.contains("aura-server") {
        return "Cloud Backend (Rust)";
    }
    if f.ends_with(".tsx") || f.ends_with(".jsx") || f.contains("/components/") {
        return "UI (React)";
    }
    if f.ends_with(".ts") || f.ends_with(".js") {
        return "Frontend (TS)";
    }
    if f.ends_with(".rs") {
        return "Core (Rust)";
    }
    if f.ends_with(".py") {
        return "Python";
    }
    if f.ends_with(".go") {
        return "Go";
    }
    if f.ends_with(".swift") || f.ends_with(".kt") || f.ends_with(".kts") {
        return "Mobile";
    }
    "Other"
}

/// Count distinct layers across all buckets, ordered by population.
fn count_layers(
    features: &[AtlasEntry],
    components: &[AtlasEntry],
    atoms: &[AtlasEntry],
) -> Vec<LayerCount> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for e in features.iter().chain(components.iter()).chain(atoms.iter()) {
        *counts.entry(e.layer.clone()).or_insert(0) += 1;
    }
    let mut out: Vec<LayerCount> = counts
        .into_iter()
        .map(|(label, count)| LayerCount { label, count })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.label.cmp(&b.label)));
    out
}

fn location_suffix(e: &AtlasEntry) -> String {
    match (&e.file, e.line) {
        (Some(f), Some(l)) => format!(" <sub>`{f}:{l}`</sub>"),
        (Some(f), None) => format!(" <sub>`{f}`</sub>"),
        _ => String::new(),
    }
}

fn trim_doc(doc: &str) -> String {
    doc.lines()
        .map(|l| l.trim_start_matches(['/', '*', '#', ' ', '\t']))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

fn human_duration(secs: u64) -> String {
    if secs < 90 {
        format!("{secs}s")
    } else if secs < 5400 {
        format!("{}m", secs / 60)
    } else if secs < 172_800 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Resolve the repository root from the current directory.
fn discover_repo_root() -> Option<PathBuf> {
    if let Ok(repo) = git2::Repository::discover(".") {
        if let Some(wd) = repo.workdir() {
            return Some(wd.to_path_buf());
        }
    }
    std::env::current_dir().ok()
}

/// Path of `target` relative to `repo_root` (forward slashes), else absolute.
fn rel_path(repo_root: &Path, target: &Path) -> String {
    target
        .strip_prefix(repo_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| target.to_string_lossy().to_string())
}

fn rel_display(repo_root: &Path, target: &Path) -> String {
    rel_path(repo_root, target)
}

// ---------------------------------------------------------------------------
// Tests — pure helpers, no IO.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_entry(role: &str, name: &str, tags: &[&str], fan_in: usize, fan_out: usize) -> AtlasEntry {
        AtlasEntry {
            key: format!("k:{name}"),
            name: name.to_string(),
            title: entrypoints::humanize(name),
            role: role.to_string(),
            kind: "function_definition".to_string(),
            layer: "Core (Rust)".to_string(),
            file: Some("src-tauri/src/auth.rs".to_string()),
            line: Some(10),
            signature: None,
            summary: String::new(),
            summary_source: "structural".to_string(),
            feature: None,
            entry_kind: None,
            fan_in,
            confident_callers: fan_in,
            fan_out,
            callers: Vec::new(),
            calls: Vec::new(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            doc: None,
        }
    }

    #[test]
    fn leaf_function_is_an_atom() {
        let (role, tags) = assign_role("function_definition", "verify_token", Some("src/auth.rs"), false, 0);
        assert_eq!(role, "atom");
        assert!(tags.iter().any(|t| t == "leaf"));
    }

    #[test]
    fn orchestrator_function_is_a_glue_component() {
        let (role, tags) = assign_role("function_definition", "check_session", Some("src/auth.rs"), false, 3);
        assert_eq!(role, "component");
        assert!(tags.iter().any(|t| t == "glue"));
    }

    #[test]
    fn entry_point_is_a_feature() {
        let (role, _) = assign_role("function_definition", "sign_in_cmd", Some("src-tauri/src/auth.rs"), true, 2);
        assert_eq!(role, "feature");
    }

    #[test]
    fn struct_is_a_type_component() {
        let (role, tags) = assign_role("struct_item", "AuthState", Some("src/auth.rs"), false, 0);
        assert_eq!(role, "component");
        assert!(tags.iter().any(|t| t == "type"));
    }

    #[test]
    fn pascal_tsx_function_is_a_ui_component() {
        let (role, tags) = assign_role("function_declaration", "LoginPane", Some("src/components/LoginPane.tsx"), false, 0);
        assert_eq!(role, "component");
        assert!(tags.iter().any(|t| t == "ui"));
    }

    #[test]
    fn every_entry_carries_a_raw_name_and_a_humanized_title() {
        let e = mk_entry("atom", "verify_token", &["leaf"], 2, 0);
        assert_eq!(e.name, "verify_token");
        assert_eq!(e.title, "Verify Token");
    }

    #[test]
    fn feature_summary_names_the_feature() {
        let mut e = mk_entry("feature", "sign_in_cmd", &[], 0, 2);
        e.feature = Some("Sign In".to_string());
        let entry = Some(EntryPoint {
            kind: EntryKind::TauriCommand,
            feature_name: "Sign In".to_string(),
            entry_symbol: "sign_in_cmd".to_string(),
            file: "src-tauri/src/auth.rs".to_string(),
        });
        let s = structural_summary(&e, &entry);
        assert!(s.contains("Sign In"), "summary was: {s}");
        assert!(s.contains("desktop command"), "summary was: {s}");
    }

    #[test]
    fn atom_summary_mentions_reuse_count() {
        let e = mk_entry("atom", "verify_token", &["leaf"], 4, 0);
        let s = structural_summary(&e, &None);
        assert!(s.contains('4'), "summary was: {s}");
    }

    #[test]
    fn unused_atom_summary_says_so() {
        let e = mk_entry("atom", "orphan_helper", &["leaf"], 0, 0);
        let s = structural_summary(&e, &None);
        assert!(s.to_lowercase().contains("not yet called"), "summary was: {s}");
    }

    #[test]
    fn patterns_detect_a_suffix_cluster() {
        let entries = vec![
            mk_entry("component", "NotesPane", &["ui"], 1, 1),
            mk_entry("component", "ChatPane", &["ui"], 1, 1),
            mk_entry("component", "ReviewPane", &["ui"], 1, 1),
        ];
        let patterns = detect_patterns(&entries);
        assert!(
            patterns.iter().any(|p| p.glyph == "*Pane" && p.count == 3),
            "patterns were: {:?}",
            patterns.iter().map(|p| (&p.glyph, p.count)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn below_threshold_shapes_are_not_patterns() {
        let entries = vec![
            mk_entry("component", "NotesPane", &["ui"], 1, 1),
            mk_entry("component", "ChatPane", &["ui"], 1, 1),
        ];
        let patterns = detect_patterns(&entries);
        assert!(!patterns.iter().any(|p| p.glyph == "*Pane"));
    }

    #[test]
    fn react_hook_shape_is_recognized() {
        assert!(known_shape("useAuthState").is_some());
        assert!(known_shape("user_login").map(|(g, _, _)| g) != Some("use*"));
    }

    #[test]
    fn ai_summary_map_parses_through_fences() {
        let raw = "Here you go:\n```json\n{\"k:a\":\"Signs the user in.\",\"k:b\":\"Checks a token.\"}\n```";
        let map = parse_summary_map(raw).expect("should parse");
        assert_eq!(map.get("k:a").map(|s| s.as_str()), Some("Signs the user in."));
    }

    #[test]
    fn import_statements_are_not_indexable() {
        let mut node = AstNode {
            node_id: "n1".to_string(),
            kind: "function_definition".to_string(),
            identifier: Some("use crate::foo::bar".to_string()),
            content_hash: Default::default(),
            children: Vec::new(),
            dependencies: Vec::new(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some("src/x.rs".to_string()),
            start_line: Some(1),
            end_line: Some(1),
            signature: None,
            doc_comment: None,
            top_level: true,
        };
        assert!(!is_indexable(&node, "use crate::foo::bar"));
        node.identifier = Some("real_fn".to_string());
        assert!(is_indexable(&node, "real_fn"));
    }
}
