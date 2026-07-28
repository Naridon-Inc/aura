//! Symbol scans of two trees: the **approved baseline** and the **git index**.
//!
//! Everything the gate decides comes from comparing these two sets, which is
//! why both are read from git objects rather than the working tree. Reading the
//! worktree would let an unstaged edit change the verdict on a commit that
//! doesn't contain it.

use crate::models::AstNode;
use crate::parser::SemanticParser;
use git2::{Repository, Tree};
use std::collections::BTreeMap;

/// One symbol as it exists in a tree, with the facts the gate needs.
#[derive(Debug, Clone)]
pub struct SymbolFacts {
    pub identifier: String,
    pub file: String,
    pub kind: String,
    /// True when the symbol is part of the module's public interface — an
    /// `export` in TS/JS, a `pub` item in Rust, a non-underscore top-level
    /// name in Python.
    pub exported: bool,
    /// Semantic hash of the symbol's body, so "changed" means the logic
    /// changed, not that a line moved.
    pub content_hash: String,
    pub start_line: Option<u32>,
}

/// Build artifacts and dependency directories are never part of a semantic
/// comparison. Mirrors the pre-commit capture loop's skip-list.
fn is_skippable(path: &str) -> bool {
    path.contains("node_modules/")
        || path.contains(".next/")
        || path.contains("target/")
        || path.contains("dist/")
        || path.contains("build/")
        || path.contains(".cache/")
        || path.contains("__pycache__/")
        || path.contains(".aura/")
        || path.contains(".git/")
        || path.contains("vendor/")
        || path.contains(".turbo/")
        || path.contains("coverage/")
}

/// Map a path to the parser's language tag. Empty means "not source we parse".
pub fn lang_ext(path: &str) -> &'static str {
    if path.ends_with(".rs") { "rs" }
    else if path.ends_with(".py") { "py" }
    else if path.ends_with(".tsx") { "tsx" }
    else if path.ends_with(".ts") { "ts" }
    else if path.ends_with(".jsx") { "jsx" }
    else if path.ends_with(".js") { "js" }
    else if path.ends_with(".go") { "go" }
    else if path.ends_with(".java") { "java" }
    else if path.ends_with(".rb") { "rb" }
    else { "" }
}

/// Does `source` publish `ident` as part of its module interface?
///
/// Deliberately textual and deliberately per-language. A tree-sitter query
/// would be prettier, but this rule has to be explainable in one sentence on
/// camera — "the file says `export`" — and it has to give the same answer
/// every time it runs.
pub fn is_exported(source: &str, ident: &str, ext: &str) -> bool {
    match ext {
        "ts" | "tsx" | "js" | "jsx" => ts_exported(source, ident),
        "rs" => rust_exported(source, ident),
        // Python has no export keyword: a top-level name is public unless it
        // opts out with a leading underscore.
        "py" => !ident.starts_with('_'),
        // Go exports by capitalisation.
        "go" => ident.chars().next().is_some_and(char::is_uppercase),
        _ => false,
    }
}

/// `export function foo`, `export const foo`, `export default function foo`,
/// `export { foo }`, `export { bar as foo }`.
fn ts_exported(source: &str, ident: &str) -> bool {
    for line in source.lines() {
        let line = line.trim_start();
        if !line.starts_with("export") {
            continue;
        }
        let rest = &line["export".len()..];
        // `export { a, b as c }` — a re-export list, not a declaration. The
        // brace has to be the first thing after `export`, otherwise it is the
        // body of `export function foo() {`.
        let head = rest.trim_start().strip_prefix("type ").unwrap_or(rest.trim_start());
        if let Some(list) = head.strip_prefix('{') {
            let list = list.split('}').next().unwrap_or(list);
            if list.split(',').any(|part| {
                let part = part.trim();
                // `bar as foo` exports under the alias, so the last word wins.
                part.split_whitespace().last().is_some_and(|w| w == ident)
            }) {
                return true;
            }
            continue;
        }
        // `export [default] [async] (function|const|let|var|class|...) ident`
        if rest
            .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
            .any(|w| w == ident)
        {
            return true;
        }
    }
    false
}

/// `pub fn foo`, `pub(crate) struct Foo`, `pub use x::foo`.
fn rust_exported(source: &str, ident: &str) -> bool {
    source.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("pub")
            && line
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .any(|w| w == ident)
    })
}

/// Parse one blob into the symbols the gate cares about: named, top-level.
///
/// Nested closures and generated names are dropped — a gate that flags a
/// vanished loop variable as a lost feature is a gate people turn off.
fn symbols_in(
    parser: &mut SemanticParser,
    path: &str,
    source: &str,
    out: &mut BTreeMap<String, SymbolFacts>,
) {
    let ext = lang_ext(path);
    if ext.is_empty() {
        return;
    }
    let nodes: Vec<AstNode> = match parser.parse_file_with_path(source, ext, path) {
        Ok(n) => n,
        Err(_) => return,
    };
    for node in nodes {
        let Some(ident) = node.identifier.clone() else { continue };
        if ident.is_empty() || ident == "anonymous" || ident.starts_with("__") {
            continue;
        }
        if !node.top_level {
            continue;
        }
        out.entry(ident.clone()).or_insert(SymbolFacts {
            exported: is_exported(source, &ident, ext),
            identifier: ident,
            file: path.to_string(),
            kind: node.kind,
            content_hash: node.content_hash,
            start_line: node.start_line,
        });
    }
}

/// Every symbol in a committed tree, keyed by identifier.
///
/// Keying on the bare identifier (not `file::identifier`) is what makes a
/// *moved* function read as moved rather than deleted — it is still somewhere
/// in the tree, so it never enters the removed set.
pub fn scan_tree(repo: &Repository, treeish: &str) -> Result<BTreeMap<String, SymbolFacts>, git2::Error> {
    let object = repo.revparse_single(treeish)?;
    let tree: Tree = object.peel_to_tree()?;

    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return Ok(BTreeMap::new()),
    };
    let mut out = BTreeMap::new();
    let mut blobs: Vec<(String, git2::Oid)> = Vec::new();

    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() != Some(git2::ObjectType::Blob) {
            return git2::TreeWalkResult::Ok;
        }
        let path = format!("{dir}{}", entry.name().unwrap_or_default());
        if is_skippable(&path) || lang_ext(&path).is_empty() {
            return git2::TreeWalkResult::Ok;
        }
        blobs.push((path, entry.id()));
        git2::TreeWalkResult::Ok
    })?;

    for (path, oid) in blobs {
        let Ok(blob) = repo.find_blob(oid) else { continue };
        let Ok(source) = std::str::from_utf8(blob.content()) else { continue };
        symbols_in(&mut parser, &path, source, &mut out);
    }
    Ok(out)
}

/// Every parsed node in a committed tree, for call-graph work.
///
/// `scan_tree` throws away everything but top-level definitions, which is right
/// for the verdict and wrong for "who depended on this" — the call edges live on
/// the nodes it discards. This keeps the whole node list instead.
pub fn nodes_in_tree(repo: &Repository, treeish: &str) -> Result<Vec<AstNode>, git2::Error> {
    let object = repo.revparse_single(treeish)?;
    let tree: Tree = object.peel_to_tree()?;

    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return Ok(Vec::new()),
    };
    let mut blobs: Vec<(String, git2::Oid)> = Vec::new();

    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() != Some(git2::ObjectType::Blob) {
            return git2::TreeWalkResult::Ok;
        }
        let path = format!("{dir}{}", entry.name().unwrap_or_default());
        if is_skippable(&path) || lang_ext(&path).is_empty() {
            return git2::TreeWalkResult::Ok;
        }
        blobs.push((path, entry.id()));
        git2::TreeWalkResult::Ok
    })?;

    let mut out = Vec::new();
    for (path, oid) in blobs {
        let Ok(blob) = repo.find_blob(oid) else { continue };
        let Ok(source) = std::str::from_utf8(blob.content()) else { continue };
        let ext = lang_ext(&path);
        if let Ok(nodes) = parser.parse_file_with_path(source, ext, &path) {
            out.extend(nodes);
        }
    }
    Ok(out)
}

/// Every symbol in the git index — the exact content a commit would capture.
pub fn scan_index(repo: &Repository) -> Result<BTreeMap<String, SymbolFacts>, git2::Error> {
    let index = repo.index()?;
    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return Ok(BTreeMap::new()),
    };
    let mut out = BTreeMap::new();

    for entry in index.iter() {
        let path = String::from_utf8_lossy(&entry.path).to_string();
        if is_skippable(&path) || lang_ext(&path).is_empty() {
            continue;
        }
        // Read the staged blob, not the file on disk: an unstaged edit must
        // not be able to change the verdict on the commit being made.
        let Ok(blob) = repo.find_blob(entry.id) else { continue };
        let Ok(source) = std::str::from_utf8(blob.content()) else { continue };
        symbols_in(&mut parser, &path, source, &mut out);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_export_forms_all_read_as_exported() {
        let src = "\
export function backoffWithJitter(a: number) { return a }
export const linearBackoff = (n: number) => n * 2
function calculateDelay(n: number) { return n }
export { calculateDelay }
";
        assert!(is_exported(src, "backoffWithJitter", "ts"));
        assert!(is_exported(src, "linearBackoff", "ts"));
        assert!(is_exported(src, "calculateDelay", "ts"));
    }

    #[test]
    fn ts_alias_export_credits_the_alias_not_the_source() {
        let src = "export { internalName as publicName }\n";
        assert!(is_exported(src, "publicName", "ts"));
        assert!(!is_exported(src, "internalName", "ts"));
    }

    #[test]
    fn private_ts_symbol_is_not_exported() {
        let src = "function sleep(ms: number) { return ms }\nexport function go() {}\n";
        assert!(!is_exported(src, "sleep", "ts"));
    }

    #[test]
    fn export_of_a_similar_name_does_not_leak() {
        let src = "export function calculateDelayJitter() {}\n";
        assert!(!is_exported(src, "calculateDelay", "ts"));
    }

    #[test]
    fn rust_pub_is_exported_and_private_is_not() {
        let src = "pub fn public_one() {}\nfn private_one() {}\n";
        assert!(is_exported(src, "public_one", "rs"));
        assert!(!is_exported(src, "private_one", "rs"));
    }

    #[test]
    fn python_underscore_prefix_is_private() {
        assert!(is_exported("", "process", "py"));
        assert!(!is_exported("", "_process", "py"));
    }

    #[test]
    fn star_reexport_line_does_not_claim_every_name() {
        // `export * from './backoff.ts'` names nothing, so it must not make an
        // arbitrary identifier look exported from this file.
        let src = "export * from './backoff.ts';\nexport * from './request.ts';\n";
        assert!(!is_exported(src, "backoffWithJitter", "ts"));
    }
}
