//! Callers that stopped calling a protected symbol.
//!
//! The removal rule this module completes checks whether a protected symbol is
//! still *there*. An external audit found the obvious hole in that, and it is
//! the one that matters: delete the `requireCheckoutAuth(...)` **call** from
//! `checkout()` and leave the function itself alone, and the gate passes. The
//! authorization check still exists — as dead code, reachable by nobody, while
//! the endpoint it guarded is now open.
//!
//! So a protect list has to mean the symbol keeps doing its job, not that its
//! text is still on disk. This walks the direct inbound edges of every
//! protected symbol in both trees and reports the ones the staged change cut.
//!
//! Four deliberate narrowings, because a gate people switch off protects
//! nothing:
//!
//!   - **Direct callers only.** Depth 1. A change three hops away that happens
//!     to reroute a chain is a refactor, not a severed guard.
//!   - **Certain edges only.** A `NameOnly` edge is a name collision the
//!     resolver could not disambiguate; blocking a commit on one would be
//!     blocking on a guess.
//!   - **The caller must survive.** A caller this same change deleted is a
//!     removal, and the removal rule already has an answer for it.
//!   - **Protected symbols only.** Not every export. The contract's preserve
//!     list is a person having said "this specific thing must keep working",
//!     which is exactly the claim strong enough to fail a commit over.
//!
//! Cost is two full-tree parses, so it does not run at all when the contract
//! names nothing to preserve — which is most commits.

use std::collections::{BTreeMap, BTreeSet};

use git2::Repository;

use crate::callgraph::{EdgeConfidence, ReverseGraph};

use super::contract::IntentContract;
use super::scan::{self, SymbolFacts};

/// A call that existed in the approved baseline and does not exist now, where
/// both ends of it are still in the tree.
#[derive(Debug, Clone)]
pub struct SeveredCall {
    /// The protected symbol that lost a caller.
    pub protected: String,
    /// The surviving symbol that used to call it.
    pub caller: String,
    /// Where the caller lives now.
    pub file: String,
    pub confidence: EdgeConfidence,
}

/// Direct callers of `symbol`, by identifier, keeping only edges we can defend.
fn direct_callers(graph: &ReverseGraph, symbol: &str, defined_in: &str) -> BTreeMap<String, EdgeConfidence> {
    let mut out = BTreeMap::new();
    let Some(root) = graph.resolve_def(symbol, Some(defined_in)) else {
        return out;
    };
    for edge in graph.callers_of_node(&root) {
        if matches!(edge.confidence, EdgeConfidence::NameOnly) {
            continue;
        }
        let Some(caller) = graph.node(&edge.caller_node_id) else { continue };
        let Some(ident) = caller.identifier.as_deref() else { continue };
        let ident = ident.trim();
        if ident.is_empty() || ident == "anonymous" || ident == symbol {
            continue;
        }
        out.insert(ident.to_string(), edge.confidence);
    }
    out
}

/// Which callers of the contract's protected symbols this change cut.
///
/// Empty when the contract protects nothing, when neither tree parses, or when
/// every protected symbol kept all of its defensible inbound edges — and empty
/// is the answer on any error, because a gate that blocks a commit because it
/// could not read a tree is a gate that gets disabled by lunchtime.
pub fn detect(
    repo: &Repository,
    contract: &IntentContract,
    staged: &BTreeMap<String, SymbolFacts>,
) -> Vec<SeveredCall> {
    if contract.protected_symbols.is_empty() {
        return Vec::new();
    }
    // Only symbols that survived: one this change removed is the removal
    // rule's finding, and reporting it twice in two vocabularies helps nobody.
    let live: Vec<&String> = contract
        .protected_symbols
        .iter()
        .filter(|s| staged.contains_key(*s))
        .collect();
    if live.is_empty() {
        return Vec::new();
    }

    let (Ok(before_nodes), Ok(after_nodes)) = (
        scan::nodes_in_tree(repo, &contract.baseline),
        scan::nodes_in_index(repo),
    ) else {
        return Vec::new();
    };
    if before_nodes.is_empty() || after_nodes.is_empty() {
        return Vec::new();
    }
    let before = ReverseGraph::build(&before_nodes);
    let after = ReverseGraph::build(&after_nodes);

    let mut out = Vec::new();
    for symbol in live {
        let Some(now) = staged.get(symbol) else { continue };
        let was = direct_callers(&before, symbol, &now.file);
        if was.is_empty() {
            continue;
        }
        let is: BTreeSet<String> = direct_callers(&after, symbol, &now.file).into_keys().collect();
        for (caller, confidence) in was {
            if is.contains(&caller) {
                continue;
            }
            // The caller has to still be in the tree. If it went too, the
            // removal rule owns that finding.
            let Some(caller_facts) = staged.get(&caller) else { continue };
            out.push(SeveredCall {
                protected: symbol.clone(),
                caller,
                file: caller_facts.file.clone(),
                confidence,
            });
        }
    }
    out.sort_by(|a, b| a.protected.cmp(&b.protected).then_with(|| a.caller.cmp(&b.caller)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AstNode, DependencyUri};

    /// The fields edge resolution reads; everything else defaulted.
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

    fn facts(ident: &str, file: &str) -> SymbolFacts {
        SymbolFacts {
            identifier: ident.into(),
            file: file.into(),
            kind: "function".into(),
            exported: true,
            content_hash: "h".into(),
            start_line: Some(1),
        }
    }

    /// The audit's exact case: the guard survives, the call to it does not.
    #[test]
    fn a_caller_that_stopped_calling_is_severed() {
        let before = ReverseGraph::build(&[
            mk("d_auth", "requireCheckoutAuth", "src/auth.ts", &[]),
            mk("d_checkout", "checkout", "src/api.ts", &["requireCheckoutAuth"]),
        ]);
        let after = ReverseGraph::build(&[
            mk("d_auth", "requireCheckoutAuth", "src/auth.ts", &[]),
            mk("d_checkout", "checkout", "src/api.ts", &[]),
        ]);

        let was = direct_callers(&before, "requireCheckoutAuth", "src/auth.ts");
        let is = direct_callers(&after, "requireCheckoutAuth", "src/auth.ts");

        assert!(was.contains_key("checkout"), "the baseline edge must resolve");
        assert!(!is.contains_key("checkout"), "the call was deleted, so the edge is gone");
    }

    #[test]
    fn an_untouched_call_is_not_severed() {
        let nodes = [
            mk("d_auth", "requireCheckoutAuth", "src/auth.ts", &[]),
            mk("d_checkout", "checkout", "src/api.ts", &["requireCheckoutAuth"]),
        ];
        let g = ReverseGraph::build(&nodes);
        let was = direct_callers(&g, "requireCheckoutAuth", "src/auth.ts");
        let is = direct_callers(&g, "requireCheckoutAuth", "src/auth.ts");
        assert_eq!(was.keys().collect::<Vec<_>>(), is.keys().collect::<Vec<_>>());
    }

    /// A name the resolver could not pin to one definition is a guess, and the
    /// gate does not fail a commit on a guess.
    #[test]
    fn a_name_only_edge_is_not_evidence_of_a_call() {
        // Two defs of the same name in different files, and a caller in a
        // third file with no import to disambiguate.
        let g = ReverseGraph::build(&[
            mk("d_a", "audit", "src/a.ts", &[]),
            mk("d_b", "audit", "src/b.ts", &[]),
            mk("d_c", "handler", "src/c.ts", &["audit"]),
        ]);
        for (_, confidence) in direct_callers(&g, "audit", "src/a.ts") {
            assert!(
                !matches!(confidence, EdgeConfidence::NameOnly),
                "NameOnly edges must be filtered out before they can block anything",
            );
        }
    }

    /// The guard that keeps two whole-tree parses off the common path.
    #[test]
    fn a_contract_that_protects_nothing_does_no_graph_work() {
        let contract = IntentContract { protected_symbols: Vec::new(), ..Default::default() };
        let staged = BTreeMap::from([("checkout".to_string(), facts("checkout", "src/api.ts"))]);
        let dir = std::env::temp_dir().join(format!("aura-severed-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = Repository::init(&dir).expect("temp repo");
        assert!(detect(&repo, &contract, &staged).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A protected symbol the change also deleted belongs to the removal rule,
    /// not to this one — otherwise one act produces two findings in two
    /// vocabularies and the reader has to work out they are the same thing.
    #[test]
    fn a_removed_protected_symbol_is_left_to_the_removal_rule() {
        let contract = IntentContract {
            protected_symbols: vec!["requireCheckoutAuth".into()],
            ..Default::default()
        };
        let staged = BTreeMap::from([("checkout".to_string(), facts("checkout", "src/api.ts"))]);
        let dir = std::env::temp_dir().join(format!("aura-severed-gone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = Repository::init(&dir).expect("temp repo");
        assert!(detect(&repo, &contract, &staged).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
