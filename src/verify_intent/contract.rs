//! The **approved intent contract** — the structured, human-approved statement
//! of what an agent is allowed to change, written BEFORE the agent touches a
//! line of code.
//!
//! The natural-language request is what a person types. The contract is what
//! Aura enforces. Keeping them separate is the whole point: a sentence like
//! "clean up duplicated retry-delay logic, keep every exported strategy
//! unchanged" is not machine-checkable, but the contract it generates —
//! `allowed_symbols`, `protected_symbols`, a `baseline` tree — is.
//!
//! The contract is deliberately dumb data. It has no opinion about whether a
//! change is good; it only records what was authorised, and against which tree
//! that authorisation was given. [`super::verdict`] does the judging.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Where the approved contract lives, relative to the repo root.
pub const CONTRACT_PATH: &str = ".aura/intent_contract.json";

/// A single approved unit of agent work.
///
/// `baseline` is the tree the approval was given against. Every later
/// comparison is baseline → index, never HEAD → commit, so the gate can run
/// while the work is still staged and refuse the commit before it exists.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IntentContract {
    /// The goal in the requester's own words, one line.
    pub goal: String,

    /// Symbols the agent is authorised to change. Empty means "unscoped" —
    /// the gate then only enforces the deletion rule, never the change rule,
    /// because an empty allow-list is an absence of information, not a
    /// prohibition on everything.
    #[serde(default)]
    pub allowed_symbols: Vec<String>,

    /// Symbols that must survive intact. A removal here is always blocking,
    /// whether or not the symbol is exported.
    #[serde(default)]
    pub protected_symbols: Vec<String>,

    /// Paths the work is scoped to (prefix match, repo-relative). Empty means
    /// unscoped.
    #[serde(default)]
    pub allowed_paths: Vec<String>,

    /// Removals that were explicitly approved after the fact — the "amend the
    /// intent" escape hatch. A symbol listed here stops being a violation, and
    /// the amendment is recorded in the contract rather than bypassed silently.
    #[serde(default)]
    pub approved_removals: Vec<String>,

    /// The git tree this approval was given against (commit-ish or tree sha).
    pub baseline: String,

    /// Which agent was authorised to do the work.
    #[serde(default)]
    pub agent: String,

    /// The agent session id, so the verdict can be tied back to a transcript.
    #[serde(default)]
    pub session: String,

    /// The worktree/branch the agent was given, when it ran isolated.
    #[serde(default)]
    pub worktree: String,

    /// RFC3339 approval timestamp.
    #[serde(default)]
    pub approved_at: String,
}

impl IntentContract {
    /// True when `symbol` was explicitly authorised for change.
    pub fn allows_change(&self, symbol: &str) -> bool {
        self.allowed_symbols.iter().any(|s| s == symbol)
    }

    /// True when `symbol` was named as must-preserve.
    pub fn is_protected(&self, symbol: &str) -> bool {
        self.protected_symbols.iter().any(|s| s == symbol)
    }

    /// True when removing `symbol` was approved after the fact.
    pub fn removal_approved(&self, symbol: &str) -> bool {
        self.approved_removals.iter().any(|s| s == symbol)
    }

    /// True when `path` is inside the approved scope. An empty scope allows
    /// everything — see [`IntentContract::allowed_paths`].
    pub fn in_scope(&self, path: &str) -> bool {
        self.allowed_paths.is_empty() || self.allowed_paths.iter().any(|p| path.starts_with(p.as_str()))
    }
}

/// Absolute path to the contract for `repo_root`.
pub fn contract_path(repo_root: &Path) -> PathBuf {
    repo_root.join(CONTRACT_PATH)
}

/// Read the approved contract, or `None` when no approval has been recorded.
///
/// A missing contract is not an error: it means nobody approved anything, and
/// the gate says exactly that instead of inventing a verdict.
pub fn load(repo_root: &Path) -> Option<IntentContract> {
    let raw = std::fs::read_to_string(contract_path(repo_root)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write the approved contract, creating `.aura/` if it does not exist.
pub fn save(repo_root: &Path, contract: &IntentContract) -> std::io::Result<()> {
    let path = contract_path(repo_root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(contract)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, format!("{body}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract() -> IntentContract {
        IntentContract {
            goal: "Clean up duplicated retry-delay logic".into(),
            allowed_symbols: vec!["requestWithRetry".into(), "calculateDelay".into()],
            protected_symbols: vec!["backoffWithJitter".into(), "linearBackoff".into()],
            allowed_paths: vec!["packages/retry/".into()],
            ..Default::default()
        }
    }

    #[test]
    fn allow_list_is_exact_not_substring() {
        let c = contract();
        assert!(c.allows_change("calculateDelay"));
        // "calculateDelayJitter" must not ride in on a prefix match.
        assert!(!c.allows_change("calculateDelayJitter"));
    }

    #[test]
    fn empty_scope_allows_every_path() {
        let mut c = contract();
        c.allowed_paths.clear();
        assert!(c.in_scope("apps/settlement-worker/src/nightlySettlement.ts"));
    }

    #[test]
    fn scope_is_a_path_prefix() {
        let c = contract();
        assert!(c.in_scope("packages/retry/src/backoff.ts"));
        assert!(!c.in_scope("apps/api/src/webhook.ts"));
    }

    #[test]
    fn amended_removal_stops_being_a_violation() {
        let mut c = contract();
        assert!(!c.removal_approved("backoffWithJitter"));
        c.approved_removals.push("backoffWithJitter".into());
        assert!(c.removal_approved("backoffWithJitter"));
    }
}
