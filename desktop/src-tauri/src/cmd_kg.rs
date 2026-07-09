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
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KgEdge {
    pub from: String,
    pub to: String,
    /// "contains" | "calls" | "references" | "imports" | "mentions"
    pub kind: String,
    #[serde(default)]
    pub surprise: bool,
}

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
    let path = cache_path(&repo_root);
    if !path.exists() {
        return Ok(None);
    }
    let body = fs::read_to_string(&path).map_err(|e| format!("read kg: {e}"))?;
    let g: KgGraph = serde_json::from_str(&body).map_err(|e| format!("parse kg: {e}"))?;
    Ok(Some(g))
}

#[tauri::command]
pub async fn aura_kg_build(repo_root: String, force: bool) -> Result<KgGraph, String> {
    let path = cache_path(&repo_root);
    let head = current_head_sha(&repo_root);
    // Cache hit: same HEAD sha and not forced → return cached.
    if !force {
        if let Ok(Some(g)) = aura_kg_load(repo_root.clone()).await {
            if !head.is_empty() && g.head_sha == head {
                return Ok(g);
            }
        }
    }

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

    // Compute degrees, communities, god flags, surprise flags.
    annotate(&mut nodes, &mut edges);

    let stats = compute_stats(&nodes, &edges);
    let graph = KgGraph {
        nodes,
        edges,
        built_at: now_secs(),
        head_sha: head,
        stats,
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir kg dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(&graph).map_err(|e| format!("serialize kg: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| format!("write kg: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename kg: {e}"))?;
    Ok(graph)
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
            // Hide-dot files; .aura is in SKIP_DIRS too.
        }
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&path, base, on_file);
        } else if path.is_file() {
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
        });
        edges.push(KgEdge {
            from: file_id.clone(),
            to: id.clone(),
            kind: "contains".into(),
            surprise: false,
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
    let mut current = String::new();
    let bytes = body.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        let ch = b as char;
        if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else {
            if !current.is_empty() {
                if let Some(targets) = symbol_index.get(&current) {
                    for t in targets {
                        // skip self-reference (file → its own contained
                        // symbol is a `contains` edge already)
                        if t.starts_with(&format!("fn:")) || t.starts_with("class:") || t.starts_with("type:") {
                            let key = format!("{from_id}->{t}");
                            if seen.insert(key) {
                                edges.push(KgEdge {
                                    from: from_id.to_string(),
                                    to: t.clone(),
                                    kind: "references".into(),
                                    surprise: false,
                                });
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
    let mut current = String::new();
    for ch in body.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else {
            if current.len() >= 3 {
                if let Some(targets) = symbol_index.get(&current) {
                    for t in targets {
                        let key = format!("{from_id}->{t}");
                        if seen.insert(key) {
                            edges.push(KgEdge {
                                from: from_id.to_string(),
                                to: t.clone(),
                                kind: "mentions".into(),
                                surprise: false,
                            });
                        }
                    }
                }
            }
            current.clear();
        }
    }
}

fn annotate(nodes: &mut [KgNode], edges: &mut [KgEdge]) {
    // Degree count.
    let mut degree: HashMap<String, usize> = HashMap::new();
    for e in edges.iter() {
        *degree.entry(e.from.clone()).or_default() += 1;
        *degree.entry(e.to.clone()).or_default() += 1;
    }
    for n in nodes.iter_mut() {
        n.degree = *degree.get(&n.id).unwrap_or(&0);
    }
    // God = top-decile by degree among non-file nodes.
    let mut symbol_degrees: Vec<usize> = nodes
        .iter()
        .filter(|n| n.kind != "file" && n.kind != "doc")
        .map(|n| n.degree)
        .collect();
    symbol_degrees.sort_unstable_by(|a, b| b.cmp(a));
    let cutoff_idx = (symbol_degrees.len() as f64 * 0.1) as usize;
    let cutoff = symbol_degrees.get(cutoff_idx).copied().unwrap_or(usize::MAX).max(2);
    for n in nodes.iter_mut() {
        if n.kind != "file" && n.kind != "doc" && n.degree >= cutoff {
            n.god = true;
        }
    }
    // Community via label propagation. Each node starts with its own
    // community; iteratively adopt the most common label among
    // neighbors. ~5 passes converges for typical repos.
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for e in edges.iter() {
        adj.entry(e.from.clone()).or_default().push(e.to.clone());
        adj.entry(e.to.clone()).or_default().push(e.from.clone());
    }
    let mut community: BTreeMap<String, usize> = BTreeMap::new();
    for (i, n) in nodes.iter().enumerate() {
        community.insert(n.id.clone(), i);
    }
    for _ in 0..6 {
        let mut changed = false;
        for n in nodes.iter() {
            let neighbors = match adj.get(&n.id) {
                Some(v) => v,
                None => continue,
            };
            if neighbors.is_empty() {
                continue;
            }
            let mut tally: HashMap<usize, usize> = HashMap::new();
            for nb in neighbors {
                if let Some(c) = community.get(nb) {
                    *tally.entry(*c).or_default() += 1;
                }
            }
            if let Some((best, _)) = tally.iter().max_by_key(|kv| kv.1) {
                let cur = community.get(&n.id).copied().unwrap_or(0);
                if *best != cur {
                    community.insert(n.id.clone(), *best);
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
    let mut next_id = 0usize;
    for c in community.values() {
        remap.entry(*c).or_insert_with(|| {
            let id = next_id;
            next_id += 1;
            id
        });
    }
    for n in nodes.iter_mut() {
        if let Some(c) = community.get(&n.id) {
            n.community_id = remap.get(c).copied().unwrap_or(0);
        }
    }
    // Surprise = inter-community edge in a community where >=70% of
    // edges stay internal.
    let lookup_community: HashMap<&str, usize> = nodes.iter().map(|n| (n.id.as_str(), n.community_id)).collect();
    let mut internal: HashMap<usize, usize> = HashMap::new();
    let mut external: HashMap<usize, usize> = HashMap::new();
    for e in edges.iter() {
        let a = lookup_community.get(e.from.as_str()).copied();
        let b = lookup_community.get(e.to.as_str()).copied();
        if let (Some(a), Some(b)) = (a, b) {
            if a == b {
                *internal.entry(a).or_default() += 1;
            } else {
                *external.entry(a).or_default() += 1;
                *external.entry(b).or_default() += 1;
            }
        }
    }
    for e in edges.iter_mut() {
        let a = lookup_community.get(e.from.as_str()).copied();
        let b = lookup_community.get(e.to.as_str()).copied();
        if let (Some(a), Some(b)) = (a, b) {
            if a == b {
                continue;
            }
            let total_a = internal.get(&a).copied().unwrap_or(0)
                + external.get(&a).copied().unwrap_or(0);
            if total_a == 0 {
                continue;
            }
            let internal_ratio = internal.get(&a).copied().unwrap_or(0) as f64 / total_a as f64;
            if internal_ratio >= 0.7 {
                e.surprise = true;
            }
        }
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
            KgEdge { from: "file:a".into(), to: "fn:a#x".into(), kind: "contains".into(), surprise: false },
            KgEdge { from: "file:a".into(), to: "fn:a#y".into(), kind: "contains".into(), surprise: false },
            KgEdge { from: "fn:a#x".into(), to: "fn:a#y".into(), kind: "references".into(), surprise: false },
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
        }
    }
}
