//! Who depended on the symbol the agent removed.
//!
//! The verdict says a protected export was deleted. On its own that is a rule
//! being enforced. What makes it worth stopping a commit for is the second
//! half: something else in this repository still calls it, and that caller is
//! still there after the change.
//!
//! The graph is built over the **approved baseline tree**, not the worktree and
//! not a previously captured index. Two reasons. A deleted symbol only has a
//! definition in the tree where it still existed, so that is the only tree in
//! which its inbound edges can be resolved. And a gate that silently answers
//! "nothing depends on it" because nobody ran a capture first is worse than no
//! answer at all — reading the baseline means the evidence is available the
//! first time anyone runs this, in any repository.
//!
//! Every caller reported is then checked against the git index. A caller the
//! same change also deleted is not a live dependency, and saying so would be
//! wrong.

use std::collections::{BTreeMap, HashSet, VecDeque};

use git2::Repository;

use crate::callgraph::{EdgeConfidence, ReverseGraph};

use super::scan::SymbolFacts;

/// How far up the call chain to walk. Three hops reaches the entry point in
/// every layered codebase we have looked at, and the tree stays readable on a
/// terminal.
const MAX_DEPTH: usize = 3;

/// A caller that survives the staged change and still needs the removed symbol.
#[derive(Debug, Clone)]
pub struct Dependent {
    pub symbol: String,
    pub file: String,
    /// 1 is a direct caller, 2 calls a direct caller, and so on.
    pub depth: usize,
    /// What the resolver had to go on. `Exact` and `ImportResolved` are edges
    /// we can defend; `NameOnly` is a name collision we could not disambiguate.
    pub confidence: EdgeConfidence,
}

impl Dependent {
    /// True when the edge was resolved by file or by an import statement, as
    /// opposed to matching on a bare name that appears in several places.
    pub fn is_certain(&self) -> bool {
        !matches!(self.confidence, EdgeConfidence::NameOnly)
    }
}

/// Callers of `symbol`, walked outwards from the baseline definition.
///
/// Returns depth-ordered, de-duplicated dependents that are still present in
/// `staged`. An empty result means the removal broke nothing this analysis can
/// see — which is a real answer, and the caller should say so plainly rather
/// than implying the symbol was unused.
pub fn dependents_of(
    repo: &Repository,
    baseline_treeish: &str,
    symbol: &str,
    defined_in: &str,
    staged: &BTreeMap<String, SymbolFacts>,
) -> Vec<Dependent> {
    let Ok(nodes) = super::scan::nodes_in_tree(repo, baseline_treeish) else {
        return Vec::new();
    };
    if nodes.is_empty() {
        return Vec::new();
    }
    let graph = ReverseGraph::build(&nodes);

    let Some(root) = graph.resolve_def(symbol, Some(defined_in)) else {
        return Vec::new();
    };

    let mut out: Vec<Dependent> = Vec::new();
    let mut seen_nodes: HashSet<String> = HashSet::from([root.clone()]);
    let mut seen_symbols: HashSet<String> = HashSet::from([symbol.to_string()]);
    let mut queue: VecDeque<(String, usize)> = VecDeque::from([(root, 1usize)]);

    while let Some((node_id, depth)) = queue.pop_front() {
        if depth > MAX_DEPTH {
            continue;
        }
        for edge in graph.callers_of_node(&node_id) {
            if !seen_nodes.insert(edge.caller_node_id.clone()) {
                continue;
            }
            let Some(caller) = graph.node(&edge.caller_node_id) else { continue };
            let Some(ident) = caller.identifier.as_deref() else { continue };
            let ident = ident.trim();
            if ident.is_empty() || ident == "anonymous" {
                continue;
            }
            // A caller the same change deleted is not a live dependency.
            if !staged.contains_key(ident) {
                continue;
            }
            if seen_symbols.insert(ident.to_string()) {
                out.push(Dependent {
                    symbol: ident.to_string(),
                    file: caller.file_path.clone().unwrap_or_default(),
                    depth,
                    confidence: edge.confidence,
                });
            }
            queue.push_back((edge.caller_node_id, depth + 1));
        }
    }

    out.sort_by(|a, b| a.depth.cmp(&b.depth).then_with(|| a.symbol.cmp(&b.symbol)));
    out
}

/// Render the chain as an indented tree, deepest last:
///
/// ```text
/// backoffWithJitter()
///   settleRow()                    apps/settlement-worker/src/nightlySettlement.ts
///     processNightlySettlement()   apps/settlement-worker/src/nightlySettlement.ts
/// ```
///
/// Returns `(indent, symbol, file)` per line so the caller owns the colouring.
pub fn tree_lines(dependents: &[Dependent]) -> Vec<(String, String, String)> {
    dependents
        .iter()
        .map(|d| {
            (
                "  ".repeat(d.depth),
                format!("{}()", d.symbol),
                d.file.clone(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dep(symbol: &str, depth: usize, confidence: EdgeConfidence) -> Dependent {
        Dependent {
            symbol: symbol.into(),
            file: "f.ts".into(),
            depth,
            confidence,
        }
    }

    #[test]
    fn a_name_only_edge_is_not_reported_as_certain() {
        assert!(!dep("x", 1, EdgeConfidence::NameOnly).is_certain());
        assert!(dep("x", 1, EdgeConfidence::Exact).is_certain());
        assert!(dep("x", 1, EdgeConfidence::ImportResolved).is_certain());
    }

    #[test]
    fn tree_indents_by_depth() {
        let lines = tree_lines(&[
            dep("settleRow", 1, EdgeConfidence::ImportResolved),
            dep("processNightlySettlement", 2, EdgeConfidence::Exact),
        ]);
        assert_eq!(lines[0].0, "  ");
        assert_eq!(lines[0].1, "settleRow()");
        assert_eq!(lines[1].0, "    ");
        assert_eq!(lines[1].1, "processNightlySettlement()");
    }
}
