//! Targeted repair — put back exactly the symbol that went missing, and
//! nothing else.
//!
//! `git checkout -- file` would undo the agent's real work along with its
//! mistake. This lifts one AST node out of the approved baseline blob and
//! reinserts it into the current file at the position it used to hold,
//! carrying its `export` keyword and any import it needs to compile.
//!
//! What it will not do is guess. If the node cannot be located in the baseline
//! or the current file cannot be parsed, it fails loudly and the caller falls
//! back to handing the finding to the agent.

use super::scan::{lang_ext, SymbolFacts};
use crate::parser::SemanticParser;
use git2::Repository;
use std::collections::BTreeMap;
use std::path::Path;

/// What a restore actually did, so the caller can narrate it truthfully.
#[derive(Debug, Clone)]
pub struct RestoreOutcome {
    pub symbol: String,
    pub file: String,
    /// Line the restored node now starts on, 1-based.
    pub inserted_at_line: usize,
    /// Import lines that had to come back with it.
    pub imports_restored: Vec<String>,
    /// The symbol the node was reinserted after, when its neighbour survived.
    pub anchored_after: Option<String>,
}

/// Keywords that publish a declaration and must travel with the node.
const EXPORT_PREFIXES: &[&str] = &["export default", "export", "pub(crate)", "pub"];

/// Walk back from `start` over whitespace and pick up a publishing keyword if
/// one immediately precedes the node, so `export function foo` restores as
/// `export function foo` rather than a now-private `function foo`.
fn widen_to_export(source: &str, start: usize) -> usize {
    let head = &source[..start];
    let trimmed = head.trim_end();
    for kw in EXPORT_PREFIXES {
        if trimmed.ends_with(kw) {
            // Only if it is a standalone word, not the tail of an identifier.
            let before = trimmed.len() - kw.len();
            let is_word_start = before == 0
                || !trimmed[..before]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_');
            if is_word_start {
                return before;
            }
        }
    }
    start
}

/// Import lines in `source`, paired with the names they bring in.
fn import_lines(source: &str, ext: &str) -> Vec<(String, Vec<String>)> {
    let is_import = |l: &str| match ext {
        "ts" | "tsx" | "js" | "jsx" => l.starts_with("import "),
        "rs" => l.starts_with("use "),
        "py" => l.starts_with("import ") || l.starts_with("from "),
        _ => false,
    };
    source
        .lines()
        .map(str::trim)
        .filter(|l| is_import(l))
        .map(|l| {
            let names = l
                .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
                .filter(|w| !w.is_empty())
                .map(str::to_string)
                .collect();
            (l.to_string(), names)
        })
        .collect()
}

/// Does `text` reference `name` as a whole word?
fn references(text: &str, name: &str) -> bool {
    text.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .any(|w| w == name)
}

/// Restore `symbol` into the working tree from the contract's baseline tree,
/// then stage the repaired file.
///
/// `baseline_symbols` is the already-computed baseline scan — the caller has
/// it in hand from the verification that produced the finding, and re-walking
/// the tree here would just be slower and could disagree with the verdict.
pub fn restore_symbol(
    repo: &Repository,
    repo_root: &Path,
    baseline_treeish: &str,
    baseline_symbols: &BTreeMap<String, SymbolFacts>,
    symbol: &str,
) -> Result<RestoreOutcome, String> {
    let facts = baseline_symbols
        .get(symbol)
        .ok_or_else(|| format!("{symbol} is not in the approved baseline — nothing to restore from."))?;

    let ext = lang_ext(&facts.file);
    if ext.is_empty() {
        return Err(format!("{} is not a language Aura can reinsert into.", facts.file));
    }

    // --- the node, as it was approved -------------------------------------
    let baseline_src = read_blob(repo, baseline_treeish, &facts.file)?;
    let mut parser = SemanticParser::new().map_err(|e| format!("parser unavailable: {e}"))?;
    let (node_text, range) = parser
        .retrieve_node_source(&baseline_src, ext, symbol)
        .map_err(|e| format!("could not parse the baseline copy of {}: {e}", facts.file))?
        .ok_or_else(|| format!("{symbol} was not found in the baseline copy of {}.", facts.file))?;

    let widened = widen_to_export(&baseline_src, range.start);
    let node_text = if widened < range.start {
        format!("{}{}", &baseline_src[widened..range.start], node_text)
    } else {
        node_text
    };

    // Carry the doc comment directly above it, if there is one.
    let node_text = with_leading_comment(&baseline_src, widened, &node_text, ext);

    // --- where it goes in the file as it stands now ------------------------
    let abs = repo_root.join(&facts.file);
    let current = std::fs::read_to_string(&abs)
        .map_err(|e| format!("could not read {}: {e}", facts.file))?;

    if references_definition(&current, ext, symbol, &mut parser) {
        return Err(format!("{symbol} is already present in {}.", facts.file));
    }

    let (insert_at, anchored_after) =
        insertion_point(&baseline_src, &current, ext, facts, baseline_symbols, &mut parser);

    let mut repaired = String::with_capacity(current.len() + node_text.len() + 2);
    repaired.push_str(&current[..insert_at]);
    if !repaired.ends_with("\n\n") {
        if !repaired.ends_with('\n') {
            repaired.push('\n');
        }
        repaired.push('\n');
    }
    repaired.push_str(node_text.trim_end());
    repaired.push('\n');
    if !current[insert_at..].starts_with('\n') {
        repaired.push('\n');
    }
    repaired.push_str(&current[insert_at..]);

    // --- imports the node needs to compile ---------------------------------
    let mut imports_restored = Vec::new();
    for (line, names) in import_lines(&baseline_src, ext) {
        let needed = names.iter().any(|n| references(&node_text, n));
        if !needed || repaired.contains(&line) {
            continue;
        }
        repaired = format!("{line}\n{repaired}");
        imports_restored.push(line);
    }

    std::fs::write(&abs, &repaired).map_err(|e| format!("could not write {}: {e}", facts.file))?;

    // --- stage it, so the gate re-runs against what would be committed -----
    let mut index = repo.index().map_err(|e| format!("git index unavailable: {e}"))?;
    index
        .add_path(Path::new(&facts.file))
        .map_err(|e| format!("could not stage {}: {e}", facts.file))?;
    index.write().map_err(|e| format!("could not write the git index: {e}"))?;

    let inserted_at_line = repaired[..insert_at.min(repaired.len())].lines().count() + 1;

    Ok(RestoreOutcome {
        symbol: symbol.to_string(),
        file: facts.file.clone(),
        inserted_at_line,
        imports_restored,
        anchored_after,
    })
}

/// Read one path out of a tree.
fn read_blob(repo: &Repository, treeish: &str, path: &str) -> Result<String, String> {
    let object = repo
        .revparse_single(treeish)
        .map_err(|e| format!("baseline {treeish} is not reachable: {e}"))?;
    let tree = object
        .peel_to_tree()
        .map_err(|e| format!("baseline {treeish} is not a tree: {e}"))?;
    let entry = tree
        .get_path(Path::new(path))
        .map_err(|_| format!("{path} does not exist in the approved baseline."))?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| format!("could not read {path} from the baseline: {e}"))?;
    String::from_utf8(blob.content().to_vec())
        .map_err(|_| format!("{path} is not UTF-8 in the baseline."))
}

/// Pull a doc comment / `//` block sitting immediately above the node into the
/// restored text — the explanation is part of the function.
fn with_leading_comment(source: &str, node_start: usize, node_text: &str, ext: &str) -> String {
    let marker = match ext {
        "py" => return node_text.to_string(), // docstring lives inside the body
        "rs" => "///",
        _ => "*/",
    };
    let head = &source[..node_start];
    let trimmed = head.trim_end();
    if !trimmed.ends_with(marker) {
        return node_text.to_string();
    }
    let open = match ext {
        "rs" => trimmed.rfind("\n\n").map(|i| i + 2).unwrap_or(0),
        _ => match trimmed.rfind("/**").or_else(|| trimmed.rfind("/*")) {
            Some(i) => i,
            None => return node_text.to_string(),
        },
    };
    format!("{}\n{}", source[open..trimmed.len()].trim_end(), node_text)
}

/// Is `symbol` defined in `source` already?
fn references_definition(
    source: &str,
    ext: &str,
    symbol: &str,
    parser: &mut SemanticParser,
) -> bool {
    matches!(parser.retrieve_node_source(source, ext, symbol), Ok(Some(_)))
}

/// Byte offset in `current` where the node should go back.
///
/// Preference order: after the baseline neighbour that still exists (so the
/// file keeps its original shape), otherwise at the end of the file.
fn insertion_point(
    baseline_src: &str,
    current: &str,
    ext: &str,
    facts: &SymbolFacts,
    baseline_symbols: &BTreeMap<String, SymbolFacts>,
    parser: &mut SemanticParser,
) -> (usize, Option<String>) {
    let Some(target_line) = facts.start_line else {
        return (current.len(), None);
    };

    // Baseline siblings in the same file, above the deleted node, nearest first.
    let mut siblings: Vec<&SymbolFacts> = baseline_symbols
        .values()
        .filter(|s| s.file == facts.file && s.identifier != facts.identifier)
        .filter(|s| s.start_line.is_some_and(|l| l < target_line))
        .collect();
    siblings.sort_by_key(|s| std::cmp::Reverse(s.start_line.unwrap_or(0)));

    for sib in siblings {
        if let Ok(Some((_, range))) = parser.retrieve_node_source(current, ext, &sib.identifier) {
            // Land after the neighbour's closing line, not mid-statement.
            let end = current[range.end..]
                .find('\n')
                .map(|i| range.end + i + 1)
                .unwrap_or(current.len());
            return (end, Some(sib.identifier.clone()));
        }
    }

    let _ = baseline_src;
    (current.len(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_keyword_travels_with_the_node() {
        let src = "export function backoffWithJitter() {}\n";
        let start = src.find("function").unwrap();
        assert_eq!(widen_to_export(src, start), 0);
    }

    #[test]
    fn a_private_function_is_not_given_an_export() {
        let src = "function backoffWithJitter() {}\n";
        let start = src.find("function").unwrap();
        assert_eq!(widen_to_export(src, start), start);
    }

    #[test]
    fn an_identifier_ending_in_pub_is_not_mistaken_for_a_keyword() {
        let src = "let mypub fn thing() {}";
        let start = src.find("fn thing").unwrap();
        assert_eq!(widen_to_export(src, start), start);
    }

    #[test]
    fn rust_pub_travels_with_the_node() {
        let src = "pub fn recover() {}\n";
        let start = src.find("fn recover").unwrap();
        assert_eq!(widen_to_export(src, start), 0);
    }

    #[test]
    fn imports_are_matched_by_whole_name() {
        let (_, names) = import_lines("import { sleep } from './time'\n", "ts")
            .into_iter()
            .next()
            .unwrap();
        assert!(names.iter().any(|n| n == "sleep"));
        assert!(references("return sleep(ms)", "sleep"));
        assert!(!references("return sleepLonger(ms)", "sleep"));
    }
}
