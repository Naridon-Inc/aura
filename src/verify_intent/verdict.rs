//! The decision. No git, no I/O, no model — given two symbol sets and an
//! approved contract, which findings block the commit?
//!
//! One rule blocks:
//!
//! > A protected or exported symbol was removed, and that removal was not
//! > approved.
//!
//! It is deterministic, it reproduces, and it is explainable in a sentence.
//! Everything else this module produces is advisory: worth telling a human,
//! never worth failing a commit over, because the cost of a false block is
//! that people disable the gate.

use super::contract::IntentContract;
use super::scan::SymbolFacts;
use serde::Serialize;
use std::collections::BTreeMap;

/// Whether a finding stops the commit or merely annotates it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// The commit does not proceed.
    Blocking,
    /// Reported, does not fail.
    Advisory,
}

/// A machine-readable finding class. Stable strings — the shell and the hook
/// both branch on these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Finding {
    /// An exported or explicitly protected symbol is gone from the tree.
    ProtectedExportRemoved,
    /// A symbol the contract said to preserve is still there, but its logic
    /// changed. Advisory by design — the one blocking rule is removal — but it
    /// is never folded into a bare count, because "must preserve" and "we
    /// rewrote it" are the two halves of a claim a person has to read.
    ProtectedSymbolChanged,
    /// A symbol changed that the contract did not authorise.
    UnapprovedSymbolChanged,
    /// A file changed outside the approved scope.
    OutOfScopeFile,
}

impl Finding {
    fn severity(self) -> Severity {
        match self {
            Finding::ProtectedExportRemoved => Severity::Blocking,
            Finding::ProtectedSymbolChanged
            | Finding::UnapprovedSymbolChanged
            | Finding::OutOfScopeFile => Severity::Advisory,
        }
    }
}

/// One thing the gate found.
#[derive(Debug, Clone, Serialize)]
pub struct Violation {
    pub finding: Finding,
    pub severity: Severity,
    /// The symbol at fault, or the path for a scope finding.
    pub symbol: String,
    /// Where it lived in the approved baseline.
    pub file: String,
    /// AST kind, so the card can say "function" rather than "symbol".
    pub kind: String,
    /// True when the symbol was part of the module's public interface.
    pub exported: bool,
    /// Why this is a finding, in the words the card prints.
    pub reason: String,
}

/// The full verdict on a staged change.
#[derive(Debug, Clone, Serialize)]
pub struct Verdict {
    pub goal: String,
    pub agent: String,
    pub session: String,
    pub worktree: String,
    pub baseline: String,
    /// Symbols the contract authorised and which actually changed.
    pub requested_changed: Vec<String>,
    /// Symbols that changed without authorisation.
    pub unexpected_changed: Vec<String>,
    /// Protected or exported symbols that vanished.
    pub protected_removed: Vec<String>,
    pub violations: Vec<Violation>,
}

impl Verdict {
    /// True when nothing blocking was found.
    pub fn passed(&self) -> bool {
        !self.violations.iter().any(|v| v.severity == Severity::Blocking)
    }

    /// Process exit code — the gate's actual enforcement surface.
    pub fn exit_code(&self) -> i32 {
        if self.passed() { 0 } else { 1 }
    }
}

/// Judge a staged change against its approved contract.
///
/// `baseline` and `staged` are keyed by identifier, so a symbol that merely
/// moved files is present in both and is never treated as removed.
pub fn evaluate(
    contract: &IntentContract,
    baseline: &BTreeMap<String, SymbolFacts>,
    staged: &BTreeMap<String, SymbolFacts>,
) -> Verdict {
    let mut violations = Vec::new();
    let mut protected_removed = Vec::new();

    // --- the blocking rule ------------------------------------------------
    for (ident, before) in baseline {
        if staged.contains_key(ident) {
            continue;
        }
        let protected = contract.is_protected(ident);
        if !protected && !before.exported {
            // A private helper disappearing is what "clean up duplicated
            // logic" is supposed to do. Not a finding.
            continue;
        }
        if contract.removal_approved(ident) {
            continue;
        }
        protected_removed.push(ident.clone());
        violations.push(Violation {
            finding: Finding::ProtectedExportRemoved,
            severity: Finding::ProtectedExportRemoved.severity(),
            symbol: ident.clone(),
            file: before.file.clone(),
            kind: before.kind.clone(),
            exported: before.exported,
            reason: if protected {
                format!("The task required {ident} to remain unchanged.")
            } else {
                format!("{ident} is part of this module's public interface and the task did not authorise removing it.")
            },
        });
    }

    // --- advisory: what changed that nobody asked for ---------------------
    let mut requested_changed = Vec::new();
    let mut unexpected_changed = Vec::new();
    for (ident, now) in staged {
        let Some(before) = baseline.get(ident) else { continue };
        if before.content_hash == now.content_hash {
            continue;
        }
        // "Must preserve" beats "not mentioned". A symbol on the protect list
        // that was rewritten is the contract's own promise coming apart, so it
        // is named even when the contract otherwise allows free rein.
        if contract.is_protected(ident) {
            unexpected_changed.push(ident.clone());
            violations.push(Violation {
                finding: Finding::ProtectedSymbolChanged,
                severity: Finding::ProtectedSymbolChanged.severity(),
                symbol: ident.clone(),
                file: now.file.clone(),
                kind: now.kind.clone(),
                exported: now.exported,
                reason: format!(
                    "{ident} was on the preserve list and its logic changed. It is still here, so the commit is not blocked — but nobody approved rewriting it."
                ),
            });
            continue;
        }
        if contract.allowed_symbols.is_empty() || contract.allows_change(ident) {
            requested_changed.push(ident.clone());
            continue;
        }
        unexpected_changed.push(ident.clone());
        violations.push(Violation {
            finding: Finding::UnapprovedSymbolChanged,
            severity: Finding::UnapprovedSymbolChanged.severity(),
            symbol: ident.clone(),
            file: now.file.clone(),
            kind: now.kind.clone(),
            exported: now.exported,
            reason: format!("{ident} changed but was not part of the approved request."),
        });
    }

    // --- advisory: work that strayed outside the approved paths -----------
    if !contract.allowed_paths.is_empty() {
        let mut seen: Vec<String> = Vec::new();
        for ident in requested_changed.iter().chain(unexpected_changed.iter()) {
            let Some(facts) = staged.get(ident) else { continue };
            if contract.in_scope(&facts.file) || seen.contains(&facts.file) {
                continue;
            }
            seen.push(facts.file.clone());
            violations.push(Violation {
                finding: Finding::OutOfScopeFile,
                severity: Finding::OutOfScopeFile.severity(),
                symbol: facts.file.clone(),
                file: facts.file.clone(),
                kind: "file".into(),
                exported: false,
                reason: format!("{} is outside the approved scope.", facts.file),
            });
        }
    }

    requested_changed.sort();
    unexpected_changed.sort();
    protected_removed.sort();

    Verdict {
        goal: contract.goal.clone(),
        agent: contract.agent.clone(),
        session: contract.session.clone(),
        worktree: contract.worktree.clone(),
        baseline: contract.baseline.clone(),
        requested_changed,
        unexpected_changed,
        protected_removed,
        violations,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(ident: &str, file: &str, hash: &str, exported: bool) -> SymbolFacts {
        SymbolFacts {
            identifier: ident.into(),
            file: file.into(),
            kind: "function_declaration".into(),
            exported,
            content_hash: hash.into(),
            start_line: Some(10),
        }
    }

    fn set(items: Vec<SymbolFacts>) -> BTreeMap<String, SymbolFacts> {
        items.into_iter().map(|s| (s.identifier.clone(), s)).collect()
    }

    fn retry_contract() -> IntentContract {
        IntentContract {
            goal: "Clean up duplicated retry-delay logic".into(),
            allowed_symbols: vec!["requestWithRetry".into(), "calculateDelay".into()],
            protected_symbols: vec!["backoffWithJitter".into(), "linearBackoff".into()],
            allowed_paths: vec!["packages/retry/".into()],
            baseline: "abc123".into(),
            agent: "claude-code".into(),
            ..Default::default()
        }
    }

    /// The demo, exactly: the agent tidies what it was asked to tidy and
    /// deletes an exported strategy nobody authorised it to touch.
    #[test]
    fn deleting_a_protected_export_blocks_the_commit() {
        let before = set(vec![
            sym("requestWithRetry", "packages/retry/src/request.ts", "h1", true),
            sym("calculateDelay", "packages/retry/src/backoff.ts", "h2", false),
            sym("backoffWithJitter", "packages/retry/src/backoff.ts", "h3", true),
        ]);
        let after = set(vec![
            sym("requestWithRetry", "packages/retry/src/request.ts", "h1-new", true),
            sym("calculateDelay", "packages/retry/src/backoff.ts", "h2-new", false),
        ]);

        let v = evaluate(&retry_contract(), &before, &after);
        assert!(!v.passed());
        assert_eq!(v.exit_code(), 1);
        assert_eq!(v.protected_removed, vec!["backoffWithJitter"]);
        assert_eq!(v.requested_changed, vec!["calculateDelay", "requestWithRetry"]);
        assert!(v.unexpected_changed.is_empty());
    }

    /// The repair: the same tidy-up, with the strategy back in place.
    #[test]
    fn restoring_the_symbol_clears_the_block() {
        let before = set(vec![
            sym("requestWithRetry", "packages/retry/src/request.ts", "h1", true),
            sym("backoffWithJitter", "packages/retry/src/backoff.ts", "h3", true),
        ]);
        let after = set(vec![
            sym("requestWithRetry", "packages/retry/src/request.ts", "h1-new", true),
            sym("backoffWithJitter", "packages/retry/src/backoff.ts", "h3", true),
        ]);

        let v = evaluate(&retry_contract(), &before, &after);
        assert!(v.passed());
        assert_eq!(v.exit_code(), 0);
        assert!(v.protected_removed.is_empty());
    }

    /// Deleting duplicated private helpers is the job, not a violation.
    #[test]
    fn removing_a_private_helper_is_not_a_finding() {
        let before = set(vec![
            sym("sleep", "packages/retry/src/backoff.ts", "h9", false),
            sym("requestWithRetry", "packages/retry/src/request.ts", "h1", true),
        ]);
        let after = set(vec![sym(
            "requestWithRetry",
            "packages/retry/src/request.ts",
            "h1-new",
            true,
        )]);

        let v = evaluate(&retry_contract(), &before, &after);
        assert!(v.passed());
        assert!(v.violations.is_empty());
    }

    /// A function that moved to another file still exists. Not a deletion.
    #[test]
    fn moving_an_export_between_files_is_not_a_deletion() {
        let before = set(vec![sym(
            "backoffWithJitter",
            "packages/retry/src/backoff.ts",
            "h3",
            true,
        )]);
        let after = set(vec![sym(
            "backoffWithJitter",
            "packages/retry/src/strategies.ts",
            "h3",
            true,
        )]);

        let v = evaluate(&retry_contract(), &before, &after);
        assert!(v.passed());
    }

    /// The amend path: a human approves the removal, and the same tree passes.
    #[test]
    fn an_approved_removal_stops_blocking() {
        let before = set(vec![sym(
            "backoffWithJitter",
            "packages/retry/src/backoff.ts",
            "h3",
            true,
        )]);
        let after = BTreeMap::new();

        let mut contract = retry_contract();
        assert!(!evaluate(&contract, &before, &after).passed());

        contract.approved_removals.push("backoffWithJitter".into());
        assert!(evaluate(&contract, &before, &after).passed());
    }

    /// An unscoped contract still enforces deletions but stops second-guessing
    /// which functions were allowed to change.
    #[test]
    fn an_empty_allow_list_does_not_flag_every_change() {
        let mut contract = retry_contract();
        contract.allowed_symbols.clear();

        let before = set(vec![sym("anything", "packages/retry/src/x.ts", "h1", true)]);
        let after = set(vec![sym("anything", "packages/retry/src/x.ts", "h2", true)]);

        let v = evaluate(&contract, &before, &after);
        assert!(v.passed());
        assert_eq!(v.requested_changed, vec!["anything"]);
        assert!(v.unexpected_changed.is_empty());
    }

    /// Changing a function nobody asked about is worth saying — not worth
    /// failing the commit over.
    #[test]
    fn rewriting_a_preserved_symbol_passes_but_is_named() {
        // The real failure this came from: an agent kept backoffWithJitter and
        // rewrote its body. The gate let it through — correctly, nothing is
        // missing — while the screen reported "unexpected changed: 1" and never
        // said which one. A count is not a finding.
        let before = set(vec![sym(
            "backoffWithJitter",
            "packages/retry/src/backoff.ts",
            "h1",
            true,
        )]);
        let after = set(vec![sym(
            "backoffWithJitter",
            "packages/retry/src/backoff.ts",
            "h2",
            true,
        )]);

        let v = evaluate(&retry_contract(), &before, &after);
        assert!(v.passed(), "a rewrite is not a removal — it must not block");
        assert_eq!(v.unexpected_changed, vec!["backoffWithJitter"]);
        let found = v
            .violations
            .iter()
            .find(|x| x.finding == Finding::ProtectedSymbolChanged)
            .expect("a preserved symbol that changed must produce its own finding");
        assert_eq!(found.severity, Severity::Advisory);
        assert!(found.reason.contains("preserve list"));
    }

    #[test]
    fn an_unapproved_change_is_advisory_not_blocking() {
        let before = set(vec![sym("webhookHandler", "apps/api/src/webhook.ts", "h1", true)]);
        let after = set(vec![sym("webhookHandler", "apps/api/src/webhook.ts", "h2", true)]);

        let v = evaluate(&retry_contract(), &before, &after);
        assert!(v.passed());
        assert_eq!(v.unexpected_changed, vec!["webhookHandler"]);
        assert!(v
            .violations
            .iter()
            .any(|x| x.finding == Finding::UnapprovedSymbolChanged));
        // ...and the out-of-scope path is called out alongside it.
        assert!(v.violations.iter().any(|x| x.finding == Finding::OutOfScopeFile));
    }
}
