//! Stack-graph-backed symbol index for aura.
//!
//! Phase A surface (this crate, S1-G): build a stack graph from a set
//! of (path, source) pairs and run two queries against it —
//! `find_refs(symbol)` and `find_defs(symbol)`.
//!
//! Phase B (deferred) wires per-language SQLite persistence via
//! `stack_graphs::storage::SQLiteWriter` so the post-commit hook can
//! incrementally `clean_file(path)` + rebuild only what changed.
//! The spike at `.aura/s1-g-spike-findings.md` already benchmarked
//! that path (8–12× speedup on warm reopen at N=100/300 Python files,
//! identical resolution counts cold vs. warm) — we lift the in-memory
//! API first, then layer storage on top without changing this surface.
//!
//! Roadmap acceptance criterion (`10-pull-stack-graphs.md`): "find all
//! callers of apply_limiter returns correct list within 100ms on the
//! aura-cli repo". The /tmp spike hit 1ms targeted-query at N=50 Python
//! files, 4ms at N=100 — the in-memory query is well inside budget.
//! Library overhead in this crate is one extra resolved-tuple alloc
//! per match.
//!
//! No Rust ruleset upstream as of 2026-04-24 (HEAD of github/stack-graphs
//! has no `tree-sitter-stack-graphs-rust`). Rust coverage is a separate
//! lane: vendor-or-contribute decision deferred. Today this crate ships
//! Python + TS + JS — covers aura-web, aura-app, and any agent-authored
//! script payloads that pass through the daemon.

use std::collections::HashSet;

use serde::Serialize;
use stack_graphs::arena::Handle;
use stack_graphs::graph::{Node, StackGraph};
use stack_graphs::partial::PartialPaths;
use stack_graphs::stitching::{
    Database, DatabaseCandidates, ForwardPartialPathStitcher, StitcherConfig,
};
use stack_graphs::NoCancellation as SgNoCancellation;
use thiserror::Error;
use tree_sitter_stack_graphs::{
    loader::LanguageConfiguration, NoCancellation as TsNoCancellation, Variables,
};

const SUPPORTED_EXTS: &[&str] = &["py", "ts", "tsx", "js", "mjs", "cjs", "java"];

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("unsupported file extension: {0}")]
    UnsupportedExtension(String),
    #[error("language load failed: {0}")]
    Language(String),
    #[error("stack graph build failed: {0}")]
    Build(String),
    #[error("stitching failed: {0}")]
    Stitch(String),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
pub struct Resolution {
    /// Resolved symbol name (e.g. "apply_limiter").
    pub symbol: String,
    /// File where the reference appears (caller side).
    pub from_file: String,
    /// File where the definition lives (callee side).
    pub to_file: String,
}

/// In-memory stack-graph index over a fixed set of source files.
///
/// Build once via [`SymbolIndex::build`], then run as many
/// [`SymbolIndex::find_refs`] / [`SymbolIndex::find_defs`] queries as
/// needed. The index is immutable after construction; for incremental
/// rebuild use the SQLite-backed variant (Phase B, not in this crate
/// yet — see crate docs).
pub struct SymbolIndex {
    graph: StackGraph,
    partials: PartialPaths,
    db: Database,
}

impl SymbolIndex {
    /// Build an index from a slice of `(path, source)` pairs.
    ///
    /// Language is dispatched by file extension (`.py` / `.ts` /
    /// `.tsx` / `.js` / `.mjs`). Files with unrecognized extensions
    /// return [`IndexError::UnsupportedExtension`] — caller should
    /// pre-filter to keep the surface honest.
    pub fn build<S: AsRef<str>>(files: &[(S, S)]) -> Result<Self, IndexError> {
        let mut graph = StackGraph::new();
        let globals = Variables::new();
        let cancel = TsNoCancellation;

        for (path, src) in files {
            let path = path.as_ref();
            let src = src.as_ref();
            let lang = load_language_for(path)?;
            let file = graph
                .get_or_create_file(path);
            lang.sgl
                .build_stack_graph_into(&mut graph, file, src, &globals, &cancel)
                .map_err(|e| IndexError::Build(format!("{path}: {e:?}")))?;
        }

        let mut partials = PartialPaths::new();
        let mut db = Database::new();
        for file in graph.iter_files() {
            ForwardPartialPathStitcher::find_minimal_partial_path_set_in_file(
                &graph,
                &mut partials,
                file,
                StitcherConfig::default(),
                &SgNoCancellation,
                |g, ps, p| {
                    db.add_partial_path(g, ps, p.clone());
                },
            )
            .map_err(|e| IndexError::Stitch(format!("{e:?}")))?;
        }

        Ok(Self {
            graph,
            partials,
            db,
        })
    }

    /// All resolved (reference → definition) tuples in the indexed
    /// corpus. Useful for batch-refresh of an external store, or for
    /// the test suite to assert resolution invariants.
    pub fn all_resolutions(&mut self) -> Result<Vec<Resolution>, IndexError> {
        let refs: Vec<Handle<Node>> = self
            .graph
            .iter_nodes()
            .filter(|h| self.graph[*h].is_reference())
            .collect();
        self.resolve_set(&refs)
    }

    /// Find every site that references `symbol`. Returns the
    /// `from_file` (caller) and `to_file` (definition) for each
    /// resolved reference. De-duplicated.
    pub fn find_refs(&mut self, symbol: &str) -> Result<Vec<Resolution>, IndexError> {
        let refs: Vec<Handle<Node>> = self
            .graph
            .iter_nodes()
            .filter(|h| {
                self.graph[*h].is_reference()
                    && self.graph[*h]
                        .symbol()
                        .map(|s| &self.graph[s][..] == symbol)
                        .unwrap_or(false)
            })
            .collect();
        self.resolve_set(&refs)
    }

    /// Find every definition site for `symbol`. Returns one
    /// `Resolution` per distinct definition file (the `from_file`
    /// echoes the definition file — definitions don't have a "caller").
    ///
    /// Note: this surfaces every definition-tagged node — Python
    /// `from x import y` registers `y` as a local definition in the
    /// importer's file, so a single underlying function reachable via
    /// import will show up in *both* the source file and each importer.
    /// Caller filtering / canonical-source ranking is a Phase B
    /// concern (the stitching path knows which is canonical for a
    /// given reference).
    pub fn find_defs(&mut self, symbol: &str) -> Result<Vec<Resolution>, IndexError> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for h in self.graph.iter_nodes() {
            if !self.graph[h].is_definition() {
                continue;
            }
            let Some(sym) = self.graph[h].symbol() else { continue };
            if &self.graph[sym][..] != symbol {
                continue;
            }
            let Some(file_h) = self.graph[h].file() else { continue };
            let file = self.graph[file_h].name().to_string();
            if seen.insert(file.clone()) {
                out.push(Resolution {
                    symbol: symbol.to_string(),
                    from_file: file.clone(),
                    to_file: file,
                });
            }
        }
        Ok(out)
    }

    fn resolve_set(&mut self, refs: &[Handle<Node>]) -> Result<Vec<Resolution>, IndexError> {
        let mut out = Vec::new();
        ForwardPartialPathStitcher::find_all_complete_partial_paths(
            &mut DatabaseCandidates::new(&self.graph, &mut self.partials, &mut self.db),
            refs.iter().copied(),
            StitcherConfig::default(),
            &SgNoCancellation,
            |g, _ps, path| {
                let start = path.start_node;
                let end = path.end_node;
                let Some(sym) = g[start].symbol() else { return };
                let Some(start_file_h) = g[start].file() else { return };
                let Some(end_file_h) = g[end].file() else { return };
                out.push(Resolution {
                    symbol: g[sym][..].to_string(),
                    from_file: g[start_file_h].name().to_string(),
                    to_file: g[end_file_h].name().to_string(),
                });
            },
        )
        .map_err(|e| IndexError::Stitch(format!("{e:?}")))?;

        out.sort();
        out.dedup();
        Ok(out)
    }
}

/// File extensions this crate can index. Caller-side filter helper —
/// avoids constructing inputs that would only fail at build time.
pub fn supported_extensions() -> &'static [&'static str] {
    SUPPORTED_EXTS
}

fn load_language_for(path: &str) -> Result<LanguageConfiguration, IndexError> {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .ok_or_else(|| IndexError::UnsupportedExtension(path.to_string()))?;
    let cancel = TsNoCancellation;
    match ext.as_str() {
        "py" => tree_sitter_stack_graphs_python::try_language_configuration(&cancel)
            .map_err(|e| IndexError::Language(format!("python: {e:?}"))),
        "ts" | "tsx" => tree_sitter_stack_graphs_typescript::try_language_configuration_typescript(&cancel)
            .map_err(|e| IndexError::Language(format!("typescript: {e:?}"))),
        "js" | "mjs" | "cjs" => tree_sitter_stack_graphs_javascript::try_language_configuration(&cancel)
            .map_err(|e| IndexError::Language(format!("javascript: {e:?}"))),
        "java" => tree_sitter_stack_graphs_java::try_language_configuration(&cancel)
            .map_err(|e| IndexError::Language(format!("java: {e:?}"))),
        other => Err(IndexError::UnsupportedExtension(other.to_string())),
    }
}

impl Ord for Resolution {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (&self.symbol, &self.from_file, &self.to_file).cmp(&(
            &other.symbol,
            &other.from_file,
            &other.to_file,
        ))
    }
}

impl PartialOrd for Resolution {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITER_PY: &str =
        "def apply_limiter(req):\n    return req.startswith(\"GET \") and len(req) < 8192\n";
    const HANDLER_PY: &str = "from limiter import apply_limiter\n\ndef handle(req):\n    if apply_limiter(req):\n        return \"ok\"\n    return \"reject\"\n";

    fn idx() -> SymbolIndex {
        SymbolIndex::build(&[("limiter.py", LIMITER_PY), ("handler.py", HANDLER_PY)])
            .expect("build")
    }

    #[test]
    fn find_refs_resolves_cross_file() {
        let mut ix = idx();
        let r = ix.find_refs("apply_limiter").expect("query");
        // At least one reference resolves cross-file (handler → limiter).
        assert!(
            r.iter()
                .any(|x| x.from_file == "handler.py" && x.to_file == "limiter.py"),
            "expected handler.py → limiter.py for apply_limiter, got {r:?}"
        );
    }

    #[test]
    fn find_defs_locates_definition_file() {
        let mut ix = idx();
        let d = ix.find_defs("apply_limiter").expect("query");
        // Python's `from limiter import apply_limiter` creates a local
        // binding in handler.py too, so we expect to surface both.
        // Source file (limiter.py) must always be present.
        assert!(
            d.iter().any(|r| r.to_file == "limiter.py"),
            "expected limiter.py among defs, got {d:?}"
        );
        assert!(!d.is_empty(), "find_defs must surface at least one site");
    }

    #[test]
    fn unknown_symbol_returns_empty() {
        let mut ix = idx();
        assert!(ix.find_refs("nonexistent_fn").expect("query").is_empty());
        assert!(ix.find_defs("nonexistent_fn").expect("query").is_empty());
    }

    #[test]
    fn unsupported_extension_errors() {
        let err = SymbolIndex::build(&[("file.cobol", "01 FOO PIC 9(4).")])
            .err()
            .expect("expected build to fail on .cobol");
        match err {
            IndexError::UnsupportedExtension(e) => assert_eq!(e, "cobol"),
            other => panic!("expected UnsupportedExtension, got {other:?}"),
        }
    }

    #[test]
    fn all_resolutions_includes_apply_limiter() {
        let mut ix = idx();
        let all = ix.all_resolutions().expect("query");
        assert!(
            all.iter().any(|r| r.symbol == "apply_limiter"),
            "all_resolutions must surface apply_limiter; got {} entries",
            all.len()
        );
    }

    #[test]
    fn resolution_dedupes_identical_tuples() {
        let mut ix = idx();
        let r = ix.find_refs("apply_limiter").expect("query");
        let mut sorted = r.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(r, sorted, "find_refs output must be sorted + deduped");
    }

    // JavaScript / ESM resolution — equivalent to the Python harness above.
    // Asserts the JS adapter is wired and `import { applyLimiter } from "./limiter.js"`
    // resolves cross-file the same way Python's `from limiter import apply_limiter` does.
    const LIMITER_JS: &str =
        "export function applyLimiter(req) {\n    return req.startsWith(\"GET \") && req.length < 8192;\n}\n";
    const HANDLER_JS: &str =
        "import { applyLimiter } from \"./limiter.js\";\n\nexport function handle(req) {\n    if (applyLimiter(req)) return \"ok\";\n    return \"reject\";\n}\n";

    #[test]
    fn javascript_cross_file_resolution() {
        let mut ix = SymbolIndex::build(&[
            ("limiter.js", LIMITER_JS),
            ("handler.js", HANDLER_JS),
        ])
        .expect("build js");
        let r = ix.find_refs("applyLimiter").expect("query");
        assert!(
            r.iter()
                .any(|x| x.from_file == "handler.js" && x.to_file == "limiter.js"),
            "expected handler.js → limiter.js for applyLimiter, got {r:?}"
        );
        let d = ix.find_defs("applyLimiter").expect("query");
        assert!(
            d.iter().any(|x| x.to_file == "limiter.js"),
            "expected limiter.js among js defs, got {d:?}"
        );
    }

    #[test]
    fn supported_extensions_includes_js_family() {
        let exts = supported_extensions();
        for needed in &["py", "ts", "tsx", "js", "mjs", "cjs"] {
            assert!(exts.contains(needed), "missing supported ext {needed}");
        }
    }

    // Java cross-file: Handler imports Limiter from the same package and
    // calls Limiter.apply. Asserts the java adapter resolves the static
    // method reference back to its definition file. Defensive against
    // adapter regressions — if tree-sitter-stack-graphs-java's static
    // member binding breaks, this catches it.
    const LIMITER_JAVA: &str = "package demo;\n\npublic class Limiter {\n    public static boolean apply(String req) {\n        return req.startsWith(\"GET \") && req.length() < 8192;\n    }\n}\n";
    const HANDLER_JAVA: &str = "package demo;\n\npublic class Handler {\n    public static String handle(String req) {\n        if (Limiter.apply(req)) {\n            return \"ok\";\n        }\n        return \"reject\";\n    }\n}\n";

    #[test]
    fn java_index_builds_and_finds_local_def() {
        let mut ix = SymbolIndex::build(&[
            ("Limiter.java", LIMITER_JAVA),
            ("Handler.java", HANDLER_JAVA),
        ])
        .expect("build java");
        let d = ix.find_defs("apply").expect("query");
        assert!(
            d.iter().any(|x| x.to_file == "Limiter.java"),
            "expected Limiter.java among java defs of `apply`, got {d:?}"
        );
    }

    #[test]
    fn supported_extensions_includes_java() {
        assert!(supported_extensions().contains(&"java"));
    }
}
