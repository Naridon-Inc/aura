//! Scope-aware reverse call-graph resolver.
//!
//! Split out of `resolve.rs` (which owns the unrelated `aura resolve` cloud
//! conflict-drain command). Consumes a flat list of `AstNode`s (e.g. a
//! checkpoint`s `ast_nodes`) and builds a *resolved* reverse call graph: for
//! every call edge it picks the single most-likely definition the caller
//! targets, then inverts the relation into `def node_id -> [caller nodes]`.
//!
//! Collision is the hard part: a bare call like `verify_token` can match many
//! defs across files. Each edge is resolved with a fixed precedence (same-file
//! > import-disambiguated > globally-unique > name-only) and tagged with an
//! `EdgeConfidence`. Everything is O(nodes + edges) via `HashMap` indexes.
use std::collections::HashMap;

use crate::models::AstNode;

/// How confident we are that a caller→def edge points at the *correct* def.
///
/// Ordered weakest-to-strongest in intent, but `PartialOrd` is intentionally
/// *not* derived (the variants are not a total order callers should rely on);
/// `rank()` provides the explicit strength used when de-duping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeConfidence {
    /// Caller and def live in the same `file_path`.
    Exact,
    /// Disambiguated via an import statement, or the def was globally unique.
    ImportResolved,
    /// Still ambiguous: the def is one of several name-matches with no
    /// disambiguating signal. An edge is recorded to *each* such candidate.
    NameOnly,
}

impl EdgeConfidence {
    /// Higher == stronger. Used to keep the best edge when a caller resolves to
    /// the same def more than once.
    fn rank(self) -> u8 {
        match self {
            EdgeConfidence::Exact => 2,
            EdgeConfidence::ImportResolved => 1,
            EdgeConfidence::NameOnly => 0,
        }
    }
}

/// A single inbound edge: who calls a definition, and how sure we are.
#[derive(Debug, Clone)]
pub struct CallerEdge {
    pub caller_node_id: String,
    pub confidence: EdgeConfidence,
}

/// A resolved reverse call graph over a snapshot of AST nodes.
///
/// Construct with [`ReverseGraph::build`], then query [`callers_of_node`] for
/// inbound edges or [`resolve_def`] to map a symbol name to a def `node_id`.
///
/// [`callers_of_node`]: ReverseGraph::callers_of_node
/// [`resolve_def`]: ReverseGraph::resolve_def
pub struct ReverseGraph {
    /// All input nodes, keyed by `node_id`. `node_id` is *not* guaranteed
    /// unique (identical masked bodies can collide), so the value is a Vec and
    /// we keep insertion order; lookups return the first.
    nodes_by_id: HashMap<String, Vec<AstNode>>,
    /// All definition nodes keyed by their bare `identifier`. A name may map to
    /// many defs across files (the collision case this module exists to solve).
    defs_by_name: HashMap<String, Vec<DefRef>>,
    /// Reverse adjacency: def `node_id` -> inbound caller edges (de-duped,
    /// best-confidence kept per caller).
    callers: HashMap<String, Vec<CallerEdge>>,
}

/// A lightweight handle to a definition node used during resolution.
#[derive(Debug, Clone)]
struct DefRef {
    node_id: String,
    file_path: Option<String>,
}

/// One parsed import statement found on some node: the bare symbol it brings
/// into scope plus the module path it came from (if any).
#[derive(Debug, Clone)]
struct ImportRef {
    symbol: String,
    module_path: String,
}

impl ReverseGraph {
    /// Build a resolved reverse call graph from a flat node list (e.g. a
    /// checkpoint's `ast_nodes`).
    ///
    /// Two passes: (1) index every node by id and every *definition* node by
    /// its bare identifier, plus collect per-file import statements; (2) for
    /// each node's call dependencies, resolve the target def and append a
    /// reverse edge. Per-caller de-dup keeps the strongest confidence.
    pub fn build(nodes: &[AstNode]) -> Self {
        let mut nodes_by_id: HashMap<String, Vec<AstNode>> = HashMap::new();
        let mut defs_by_name: HashMap<String, Vec<DefRef>> = HashMap::new();
        // file_path -> imports declared anywhere in that file.
        let mut imports_by_file: HashMap<String, Vec<ImportRef>> = HashMap::new();

        // ---- Pass 1: index nodes, defs, and imports. -----------------------
        for node in nodes {
            nodes_by_id
                .entry(node.node_id.clone())
                .or_default()
                .push(node.clone());

            if is_definition(node) {
                if let Some(ident) = node.identifier.as_deref() {
                    let ident = ident.trim();
                    if !ident.is_empty() {
                        defs_by_name.entry(ident.to_string()).or_default().push(DefRef {
                            node_id: node.node_id.clone(),
                            file_path: node.file_path.clone(),
                        });
                    }
                }
            }

            // Harvest import statements from this node's dependencies, bucketed
            // by the node's file so any caller in the same file can use them.
            if let Some(file) = node.file_path.as_deref() {
                for dep in &node.dependencies {
                    if let Some(imp) = parse_import(&dep.name) {
                        imports_by_file.entry(file.to_string()).or_default().push(imp);
                    }
                }
            }
        }

        // ---- Pass 2: resolve each call edge into the reverse map. ----------
        let mut callers: HashMap<String, Vec<CallerEdge>> = HashMap::new();
        for node in nodes {
            let caller_file = node.file_path.as_deref();
            for dep in &node.dependencies {
                // Imports are not calls; skip them as edge sources.
                if parse_import(&dep.name).is_some() {
                    continue;
                }
                let raw = dep.name.trim();
                if raw.is_empty() {
                    continue;
                }
                let bare = bare_name(raw);
                if bare.is_empty() || is_builtin(&bare) {
                    continue;
                }
                let Some(candidates) = defs_by_name.get(&bare) else {
                    continue; // No definition for this name in the snapshot.
                };

                let empty_imports: Vec<ImportRef> = Vec::new();
                let file_imports = caller_file
                    .and_then(|f| imports_by_file.get(f))
                    .unwrap_or(&empty_imports);

                let resolved = resolve_edge(raw, &bare, caller_file, candidates, file_imports);

                for (def_id, confidence) in resolved {
                    // Don't record a self-edge (a def calling itself by name is
                    // not a meaningful inbound caller for impact purposes).
                    if def_id == node.node_id {
                        continue;
                    }
                    push_edge(&mut callers, &def_id, &node.node_id, confidence);
                }
            }
        }

        ReverseGraph { nodes_by_id, defs_by_name, callers }
    }

    /// Resolve a symbol name (optionally constrained to its defining file) to
    /// the `node_id` of the best def. Returns `None` if no def matches.
    ///
    /// With `file = Some(f)` a def *in* `f` is preferred; if none exists there
    /// we fall back to a global match (first/global-unique candidate).
    pub fn resolve_def(&self, symbol: &str, file: Option<&str>) -> Option<String> {
        let bare = bare_name(symbol.trim());
        let candidates = self.defs_by_name.get(&bare)?;
        if candidates.is_empty() {
            return None;
        }
        if let Some(want) = file {
            if let Some(d) = candidates.iter().find(|d| d.file_path.as_deref() == Some(want)) {
                return Some(d.node_id.clone());
            }
        }
        // Fallback: global match. Deterministic — first in index order.
        candidates.first().map(|d| d.node_id.clone())
    }

    /// Direct callers of a definition node, de-duped, with the best confidence
    /// kept per caller. Empty if the def has no inbound edges (a leaf).
    pub fn callers_of_node(&self, node_id: &str) -> Vec<CallerEdge> {
        self.callers.get(node_id).cloned().unwrap_or_default()
    }

    /// Borrow a node by id. If a `node_id` collided across identical bodies the
    /// first-indexed node is returned.
    pub fn node(&self, node_id: &str) -> Option<&AstNode> {
        self.nodes_by_id.get(node_id).and_then(|v| v.first())
    }

    /// Number of distinct `node_id`s indexed.
    pub fn len(&self) -> usize {
        self.nodes_by_id.len()
    }

    /// Whether the graph indexed any nodes.
    pub fn is_empty(&self) -> bool {
        self.nodes_by_id.is_empty()
    }
}

/// Insert or upgrade a reverse edge, keeping the strongest confidence per
/// caller so a single caller never appears twice for the same def.
fn push_edge(
    callers: &mut HashMap<String, Vec<CallerEdge>>,
    def_id: &str,
    caller_id: &str,
    confidence: EdgeConfidence,
) {
    let edges = callers.entry(def_id.to_string()).or_default();
    if let Some(existing) = edges.iter_mut().find(|e| e.caller_node_id == caller_id) {
        if confidence.rank() > existing.confidence.rank() {
            existing.confidence = confidence;
        }
    } else {
        edges.push(CallerEdge {
            caller_node_id: caller_id.to_string(),
            confidence,
        });
    }
}

/// Apply the locked resolution precedence to a single call edge.
///
/// Returns a list of `(def_node_id, confidence)` pairs. The list has exactly
/// one element for Exact / ImportResolved / global-unique, and one element
/// *per candidate* for the ambiguous NameOnly case.
fn resolve_edge(
    raw_call: &str,
    bare: &str,
    caller_file: Option<&str>,
    candidates: &[DefRef],
    file_imports: &[ImportRef],
) -> Vec<(String, EdgeConfidence)> {
    // 1. Exact same-file.
    if let Some(f) = caller_file {
        if let Some(def) = candidates.iter().find(|d| d.file_path.as_deref() == Some(f)) {
            return vec![(def.node_id.clone(), EdgeConfidence::Exact)];
        }
    }

    // 2. ImportResolved: an import in the caller's file names this symbol and a
    //    module path; pick the candidate whose file best matches that path.
    //    We also consider the qualified call text itself (e.g. `auth::foo`),
    //    whose leading segments behave like an inline module path.
    let mut module_hints: Vec<String> = file_imports
        .iter()
        .filter(|imp| imp.symbol == bare)
        .map(|imp| imp.module_path.clone())
        .collect();
    if let Some(qual) = qualified_module(raw_call) {
        module_hints.push(qual);
    }
    if !module_hints.is_empty() {
        let mut best: Option<(usize, &DefRef)> = None;
        for cand in candidates {
            let Some(fp) = cand.file_path.as_deref() else { continue };
            let score = module_hints
                .iter()
                .map(|hint| path_module_match(fp, hint))
                .max()
                .unwrap_or(0);
            if score > 0 && best.map(|(s, _)| score > s).unwrap_or(true) {
                best = Some((score, cand));
            }
        }
        if let Some((_, def)) = best {
            return vec![(def.node_id.clone(), EdgeConfidence::ImportResolved)];
        }
    }

    // 3. Global-unique: exactly one def repo-wide with this name.
    if candidates.len() == 1 {
        return vec![(candidates[0].node_id.clone(), EdgeConfidence::ImportResolved)];
    }

    // 4. NameOnly: genuinely ambiguous — edge to every candidate.
    candidates
        .iter()
        .map(|d| (d.node_id.clone(), EdgeConfidence::NameOnly))
        .collect()
}

/// True if the node is something other code can *call* — i.e. a definition we
/// want to index as a resolution target.
fn is_definition(node: &AstNode) -> bool {
    if node.identifier.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return false;
    }
    let k = node.kind.as_str();
    // Accept the common tree-sitter def kinds across languages; fall back to a
    // substring check so we tolerate kinds we haven't enumerated.
    matches!(
        k,
        "function_item"
            | "function_definition"
            | "function_declaration"
            | "method_definition"
            | "method_declaration"
            | "arrow_function"
            | "constructor_declaration"
            | "class_definition"
            | "class_declaration"
            | "impl_item"
    ) || k.contains("function")
        || k.contains("method")
        || k.contains("class")
}

/// Reduce a call's raw source text to its bare callee name for matching.
///
/// Strips receiver / qualifier prefixes by keeping the last `.` or `::`
/// segment: `self.verify_token` -> `verify_token`, `auth::verify_token` ->
/// `verify_token`, `obj.method` -> `method`. Trailing call syntax like `(...)`
/// and generic args are dropped.
fn bare_name(call: &str) -> String {
    let mut s = call.trim();

    // Drop everything from the first `(` (argument list) or `<` (turbofish/
    // generics) onward.
    if let Some(idx) = s.find('(') {
        s = &s[..idx];
    }
    if let Some(idx) = s.find('<') {
        s = &s[..idx];
    }
    // Cutting `<`/`(` can leave a dangling separator (the turbofish
    // `compute::<u32>` becomes `compute::`); trim trailing `:`/`.` so the last
    // segment is the real callee rather than an empty tail.
    let s = s.trim().trim_end_matches(|c| c == ':' || c == '.');

    // Keep the last path segment after `.` or `::`.
    let after_colons = s.rsplit("::").next().unwrap_or(s);
    let last = after_colons.rsplit('.').next().unwrap_or(after_colons);
    last.trim().to_string()
}

/// If the call text is path-qualified (`auth::verify_token`, `mod.sub.fn`),
/// return the leading qualifier joined with `/` so it can be matched against a
/// file path like the import module path is. `None` for bare calls.
fn qualified_module(call: &str) -> Option<String> {
    let mut s = call.trim();
    if let Some(idx) = s.find('(') {
        s = &s[..idx];
    }
    if let Some(idx) = s.find('<') {
        s = &s[..idx];
    }
    let s = s.trim();

    // Split on `::` first (Rust), then `.` (JS/TS/Python) — but ignore a
    // leading `self`/`this` receiver, which is not a module.
    let split_colon: Vec<&str> = s.split("::").collect();
    let segs: Vec<&str> = if split_colon.len() > 1 {
        split_colon
    } else {
        s.split('.').collect()
    };
    if segs.len() < 2 {
        return None;
    }
    let head = segs[0].trim();
    if matches!(head, "self" | "this" | "Self") {
        return None;
    }
    // Everything except the final callee segment is the module path.
    let module: Vec<&str> = segs[..segs.len() - 1]
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if module.is_empty() {
        None
    } else {
        Some(module.join("/"))
    }
}

/// Parse a dependency `.name` that is an import *statement* (not a call) into
/// `(symbol, module_path)`. Returns `None` if the text is not an import.
///
/// Handles the shapes seen in the wild:
///   - Rust:   `use crate::auth::verify_token;`
///   - JS/TS:  `import { login } from "./auth";`  /  `import login from "x"`
///   - Python: `from auth import verify_token`  /  `import auth`
///   - CJS:    `require("./auth")`
fn parse_import(name: &str) -> Option<ImportRef> {
    let t = name.trim();
    let lower = t.to_ascii_lowercase();

    let looks_import = lower.starts_with("use ")
        || lower.starts_with("import ")
        || lower.starts_with("from ")
        || lower.starts_with("require(")
        || t.contains("import {")
        || t.contains("} from");
    if !looks_import {
        return None;
    }

    // ---- Rust: `use crate::auth::verify_token;` (or `as alias`). -----------
    if let Some(rest) = strip_kw(t, "use") {
        let rest = rest.trim_end_matches(';').trim();
        // Take the part before any ` as ` alias.
        let path = rest.split(" as ").next().unwrap_or(rest).trim();
        let segs: Vec<&str> = path.split("::").map(str::trim).filter(|s| !s.is_empty()).collect();
        if let Some(sym) = segs.last().copied() {
            let module = if segs.len() > 1 {
                segs[..segs.len() - 1].join("/")
            } else {
                String::new()
            };
            let sym = sanitize_symbol(sym);
            if !sym.is_empty() {
                return Some(ImportRef { symbol: sym, module_path: module });
            }
        }
    }

    // ---- Python: `from auth import verify_token`. -------------------------
    if let Some(rest) = strip_kw(t, "from") {
        if let Some(imp_idx) = rest.find(" import ") {
            let module_raw = rest[..imp_idx].trim();
            let symbols = rest[imp_idx + " import ".len()..].trim();
            let module = module_raw.replace('.', "/");
            // Use the first imported symbol (good enough for disambiguation).
            let sym = symbols
                .split(',')
                .next()
                .map(|s| s.split(" as ").next().unwrap_or(s))
                .map(sanitize_symbol)
                .unwrap_or_default();
            if !sym.is_empty() {
                return Some(ImportRef { symbol: sym, module_path: module });
            }
        }
    }

    // ---- JS/TS: `import { login } from "./auth";` / `import x from "y"`. ---
    if lower.starts_with("import ") || t.contains("} from") {
        let module = extract_quoted(t).map(normalize_js_path).unwrap_or_default();
        let sym = if let (Some(open), Some(close)) = (t.find('{'), t.find('}')) {
            // Named import: first symbol inside the braces.
            t[open + 1..close]
                .split(',')
                .next()
                .map(|s| s.split(" as ").last().unwrap_or(s))
                .map(sanitize_symbol)
                .unwrap_or_default()
        } else {
            // Default/namespace import: `import login from "..."`.
            strip_kw(t, "import")
                .and_then(|r| r.split(" from ").next().map(|s| s.to_string()))
                .map(|s| s.replace('*', " ").replace(" as ", " "))
                .and_then(|s| s.split_whitespace().last().map(sanitize_symbol))
                .unwrap_or_default()
        };
        if !sym.is_empty() {
            return Some(ImportRef { symbol: sym, module_path: module });
        }
        // Bare side-effect import with no binding — record module only so a
        // qualified call could still match it.
        if !module.is_empty() {
            return Some(ImportRef { symbol: String::new(), module_path: module });
        }
    }

    // ---- CommonJS: `require("./auth")`. -----------------------------------
    if lower.contains("require(") {
        if let Some(module) = extract_quoted(t).map(normalize_js_path) {
            return Some(ImportRef { symbol: String::new(), module_path: module });
        }
    }

    None
}

/// Strip a leading keyword (case-insensitive) and return the remainder, or
/// `None` if `t` does not start with `kw` followed by whitespace.
fn strip_kw<'a>(t: &'a str, kw: &str) -> Option<&'a str> {
    let t = t.trim_start();
    if t.len() > kw.len()
        && t[..kw.len()].eq_ignore_ascii_case(kw)
        && t.as_bytes()[kw.len()].is_ascii_whitespace()
    {
        Some(t[kw.len()..].trim_start())
    } else {
        None
    }
}

/// Keep only identifier characters from a captured symbol token.
fn sanitize_symbol(s: &str) -> String {
    s.trim()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect()
}

/// Extract the first single- or double-quoted literal from a string.
fn extract_quoted(t: &str) -> Option<String> {
    for q in ['"', '\''] {
        if let Some(start) = t.find(q) {
            if let Some(end) = t[start + 1..].find(q) {
                return Some(t[start + 1..start + 1 + end].to_string());
            }
        }
    }
    None
}

/// Normalize a JS/TS module specifier into path-segment form for matching:
/// `./auth` -> `auth`, `../lib/auth` -> `lib/auth`, drops extensions.
fn normalize_js_path(spec: String) -> String {
    let s = spec.trim().trim_matches(|c| c == '"' || c == '\'');
    let s = s.trim_start_matches("./");
    let cleaned: Vec<&str> = s
        .split('/')
        .map(|seg| seg.trim())
        .filter(|seg| !seg.is_empty() && *seg != "." && *seg != "..")
        .collect();
    let joined = cleaned.join("/");
    // Drop a trailing file extension on the last segment.
    match joined.rsplit_once('.') {
        Some((head, ext)) if ext.chars().all(|c| c.is_ascii_alphanumeric()) && !head.is_empty() => {
            head.to_string()
        }
        _ => joined,
    }
}

/// Score how well a def's `file_path` matches an import/qualifier module path.
///
/// We compare module *segments* (split on `/`, `::`, `.`) against the file's
/// path segments (with any extension stripped) and count the length of the
/// longest run of trailing module segments that appear, in order, as a tail of
/// the file path. Higher score == stronger match; `0` == no match.
fn path_module_match(file_path: &str, module_path: &str) -> usize {
    let file_segs = path_segments(file_path);
    let mod_segs: Vec<String> = module_path
        .split(|c| c == '/' || c == '.' || c == ':')
        .map(|s| s.trim().to_string())
        .filter(|s| {
            !s.is_empty() && !matches!(s.as_str(), "crate" | "super" | "self" | "mod" | "src")
        })
        .collect();
    if file_segs.is_empty() || mod_segs.is_empty() {
        return 0;
    }

    // Longest suffix of mod_segs that is contained (in order) in file_segs.
    // We anchor on the final module segment (the most specific) and walk back.
    let mut best = 0;
    for take in (1..=mod_segs.len()).rev() {
        let tail = &mod_segs[mod_segs.len() - take..];
        if contains_subsequence(&file_segs, tail) {
            best = take;
            break;
        }
    }
    best
}

/// Split a file path into lowercased segments with the extension stripped from
/// the final component.
fn path_segments(file_path: &str) -> Vec<String> {
    let mut segs: Vec<String> = file_path
        .split(|c| c == '/' || c == '\\')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty() && *s != "src")
        .collect();
    if let Some(last) = segs.last_mut() {
        if let Some((head, _ext)) = last.rsplit_once('.') {
            if !head.is_empty() {
                *last = head.to_string();
            }
        }
    }
    segs
}

/// Does `hay` contain `needle` as an in-order (contiguous) subsequence,
/// compared case-insensitively?
fn contains_subsequence(hay: &[String], needle: &[String]) -> bool {
    if needle.is_empty() || needle.len() > hay.len() {
        return false;
    }
    let lc = |s: &str| s.to_ascii_lowercase();
    hay.windows(needle.len()).any(|w| {
        w.iter()
            .zip(needle.iter())
            .all(|(a, b)| lc(a) == lc(b))
    })
}

/// Small skip list of language builtins / macros that are never user defs.
fn is_builtin(name: &str) -> bool {
    matches!(
        name,
        "println"
            | "print"
            | "eprintln"
            | "eprint"
            | "format"
            | "write"
            | "writeln"
            | "vec"
            | "panic"
            | "assert"
            | "assert_eq"
            | "assert_ne"
            | "dbg"
            | "todo"
            | "unimplemented"
            | "unreachable"
            | "Some"
            | "None"
            | "Ok"
            | "Err"
            | "Box"
            | "Vec"
            | "String"
            | "matches"
            | "console"
            | "require"
            | "log"
            | "JSON"
            | "Object"
            | "Array"
            | "Promise"
            | "len"
            | "clone"
            | "to_string"
            | "into"
            | "unwrap"
            | "expect"
            // Iterator / collection / Option / Result / string adapters. These
            // are stdlib method names that `bare_name` strips a receiver down
            // to (`items.filter(..)` -> `filter`); they collide with any
            // project symbol of the same name and are never *the* symbol of
            // interest, so they must not register as call edges.
            | "iter"
            | "into_iter"
            | "iter_mut"
            | "next"
            | "map"
            | "map_err"
            | "filter"
            | "filter_map"
            | "flat_map"
            | "flatten"
            | "collect"
            | "fold"
            | "for_each"
            | "find"
            | "position"
            | "any"
            | "all"
            | "count"
            | "sum"
            | "zip"
            | "chain"
            | "rev"
            | "take"
            | "skip"
            | "enumerate"
            | "join"
            | "split"
            | "splitn"
            | "push"
            | "pop"
            | "insert"
            | "remove"
            | "append"
            | "extend"
            | "contains"
            | "contains_key"
            | "get"
            | "get_mut"
            | "keys"
            | "values"
            | "entry"
            | "or_insert"
            | "or_insert_with"
            | "or_default"
            | "and_then"
            | "or_else"
            | "unwrap_or"
            | "unwrap_or_else"
            | "unwrap_or_default"
            | "ok"
            | "ok_or"
            | "is_some"
            | "is_none"
            | "is_empty"
            | "is_ok"
            | "is_err"
            | "as_str"
            | "as_ref"
            | "as_deref"
            | "as_mut"
            | "as_bytes"
            | "to_owned"
            | "to_vec"
            | "trim"
            | "trim_start"
            | "trim_end"
            | "starts_with"
            | "ends_with"
            | "strip_prefix"
            | "strip_suffix"
            | "replace"
            | "to_lowercase"
            | "to_uppercase"
            | "to_ascii_lowercase"
            | "to_ascii_uppercase"
            | "parse"
            | "sort"
            | "sort_by"
            | "dedup"
            | "truncate"
            | "clear"
            | "lines"
            | "chars"
            | "set_state"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AstNode, DependencyUri};

    /// Build an `AstNode` with the fields resolution cares about; everything
    /// else gets sensible defaults.
    fn mk(id: &str, ident: &str, file: &str, deps: &[&str]) -> AstNode {
        AstNode {
            node_id: id.to_string(),
            kind: "function_item".to_string(),
            identifier: Some(ident.to_string()),
            content_hash: format!("h-{id}"),
            children: Vec::new(),
            dependencies: deps
                .iter()
                .map(|d| DependencyUri { name: d.to_string(), uri: None })
                .collect(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some(file.to_string()),
            start_line: Some(1),
            end_line: Some(10),
            signature: None,
            doc_comment: None,
            top_level: true,
        }
    }

    /// (a) Same-file call resolves Exact and shows up as a caller.
    #[test]
    fn same_file_call_is_exact() {
        let nodes = vec![
            mk("def_verify", "verify_token", "aura-cli/src/auth.rs", &[]),
            mk("caller_login", "login", "aura-cli/src/auth.rs", &["verify_token"]),
        ];
        let g = ReverseGraph::build(&nodes);

        assert_eq!(
            g.resolve_def("verify_token", Some("aura-cli/src/auth.rs")).as_deref(),
            Some("def_verify"),
        );
        let callers = g.callers_of_node("def_verify");
        assert_eq!(callers.len(), 1);
        assert_eq!(callers[0].caller_node_id, "caller_login");
        assert_eq!(callers[0].confidence, EdgeConfidence::Exact);
    }

    /// (b) Cross-file collision with an import resolves to the imported one.
    #[test]
    fn cross_file_collision_uses_import() {
        // Two defs named `verify_token` in different files.
        let nodes = vec![
            mk("def_auth", "verify_token", "aura-cli/src/auth.rs", &[]),
            mk("def_legacy", "verify_token", "aura-cli/src/legacy/old.rs", &[]),
            // Caller lives elsewhere, imports the auth one, then calls it.
            mk(
                "caller_handler",
                "handle_request",
                "aura-cli/src/server.rs",
                &["use crate::auth::verify_token;", "verify_token"],
            ),
        ];
        let g = ReverseGraph::build(&nodes);

        // The imported def gains the edge; the legacy one does not.
        let auth_callers = g.callers_of_node("def_auth");
        assert_eq!(auth_callers.len(), 1);
        assert_eq!(auth_callers[0].caller_node_id, "caller_handler");
        assert_eq!(auth_callers[0].confidence, EdgeConfidence::ImportResolved);

        assert!(g.callers_of_node("def_legacy").is_empty());
    }

    /// (c) Global-unique resolves even without an import statement.
    #[test]
    fn global_unique_resolves_without_import() {
        let nodes = vec![
            mk("def_only", "compute_hash", "aura-cli/src/crypto.rs", &[]),
            mk(
                "caller_x",
                "sign",
                "aura-cli/src/sign.rs",
                &["compute_hash"], // no import, but only one def repo-wide
            ),
        ];
        let g = ReverseGraph::build(&nodes);

        assert_eq!(g.resolve_def("compute_hash", None).as_deref(), Some("def_only"));
        let callers = g.callers_of_node("def_only");
        assert_eq!(callers.len(), 1);
        assert_eq!(callers[0].caller_node_id, "caller_x");
        assert_eq!(callers[0].confidence, EdgeConfidence::ImportResolved);
    }

    /// (d) Genuinely ambiguous: two defs, two unrelated callers, no imports →
    /// NameOnly edges to both defs.
    #[test]
    fn ambiguous_yields_name_only_edges() {
        let nodes = vec![
            mk("def_a", "save", "aura-cli/src/a.rs", &[]),
            mk("def_b", "save", "aura-cli/src/b.rs", &[]),
            // Callers in *unrelated* files with no import to disambiguate.
            mk("caller_p", "flow_p", "aura-cli/src/p.rs", &["save"]),
            mk("caller_q", "flow_q", "aura-cli/src/q.rs", &["save"]),
        ];
        let g = ReverseGraph::build(&nodes);

        for def in ["def_a", "def_b"] {
            let mut callers = g.callers_of_node(def);
            callers.sort_by(|x, y| x.caller_node_id.cmp(&y.caller_node_id));
            assert_eq!(callers.len(), 2, "{def} should see both callers");
            assert_eq!(callers[0].caller_node_id, "caller_p");
            assert_eq!(callers[1].caller_node_id, "caller_q");
            assert!(callers.iter().all(|e| e.confidence == EdgeConfidence::NameOnly));
        }
    }

    /// (e) A leaf def with zero callers → empty.
    #[test]
    fn leaf_has_no_callers() {
        let nodes = vec![
            mk("def_leaf", "never_called", "aura-cli/src/util.rs", &[]),
            mk("caller_main", "main", "aura-cli/src/main.rs", &["something_else"]),
        ];
        let g = ReverseGraph::build(&nodes);

        assert!(g.callers_of_node("def_leaf").is_empty());
        assert!(!g.is_empty());
        assert_eq!(g.len(), 2);
        assert!(g.node("def_leaf").is_some());
        assert!(g.node("missing").is_none());
    }

    /// Receiver/qualifier prefixes are normalized away for matching.
    #[test]
    fn receiver_and_qualifier_prefixes_normalized() {
        assert_eq!(bare_name("self.verify_token"), "verify_token");
        assert_eq!(bare_name("this.login()"), "login");
        assert_eq!(bare_name("auth::verify_token"), "verify_token");
        assert_eq!(bare_name("obj.method(arg)"), "method");
        assert_eq!(bare_name("compute::<u32>"), "compute");
    }

    /// Builtins/macros are skipped so they never create phantom defs/edges.
    #[test]
    fn builtins_are_skipped() {
        let nodes = vec![
            mk("def_real", "do_work", "aura-cli/src/work.rs", &[]),
            mk(
                "caller_main",
                "main",
                "aura-cli/src/main.rs",
                &["println", "vec", "Some", "do_work"],
            ),
        ];
        let g = ReverseGraph::build(&nodes);
        // Only the real def picks up the caller; builtins resolve to nothing.
        assert_eq!(g.callers_of_node("def_real").len(), 1);
        assert!(g.resolve_def("println", None).is_none());
    }
}
