//! `gh stack` awareness — GitHub's own stacked-PR extension
//! (`gh extension install github/gh-stack`).
//!
//! Sibling of [`super::graphite`]: where Graphite keeps its stack topology in
//! `refs/branch-metadata/*`, `gh stack` keeps it in `.git/gh-stack` and only
//! exposes it through the CLI. `gh stack view --json` prints the *current*
//! stack (the one the checked-out branch belongs to) as:
//!
//! ```json
//! {
//!   "trunk": "main",
//!   "currentBranch": "feat-2",
//!   "branches": [
//!     { "name": "feat-1", "head": "<sha>", "base": "<sha>", "isCurrent": false,
//!       "isMerged": false, "isQueued": false, "needsRebase": false,
//!       "pr": { "number": 41, "url": "…", "state": "OPEN" } },
//!     { "name": "feat-2", "head": "<sha>", "base": "<sha>", "isCurrent": true, … }
//!   ]
//! }
//! ```
//!
//! `base` is the parent's SHA as last seen by this branch, so a branch's parent
//! is the branch whose `head` matches its `base`; when the parent has moved on
//! since (`needsRebase`), we fall back to array order, which the extension
//! lists bottom-up from the trunk. Either way the result is the same
//! `branch -> parent branch` map Graphite produces, so `pr_stack` can consume
//! both through one seam. Everything here is best-effort: a missing extension
//! or a branch outside any stack degrades to "no stack metadata".

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct StackView {
    #[serde(default)]
    trunk: String,
    #[serde(default)]
    branches: Vec<StackBranch>,
}

#[derive(Debug, Deserialize)]
struct StackBranch {
    #[serde(default)]
    name: String,
    #[serde(default)]
    head: String,
    #[serde(default)]
    base: String,
}

/// True when the `gh stack` extension answers `--help` with exit 0 — the only
/// portable probe, since an uninstalled extension makes `gh` print
/// `unknown command "stack"` and exit 1.
pub fn is_installed(repo_root: &str) -> bool {
    let cwd = PathBuf::from(repo_root);
    Command::new("gh")
        .args(["stack", "--help"])
        .current_dir(if cwd.is_dir() { cwd } else { PathBuf::from(".") })
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `branch -> parent branch` for the stack the checkout currently sits in.
/// Empty when the extension is missing, the branch is in no stack, or the
/// output can't be read — callers fall back to head/base inference.
pub fn stack_parents(repo_root: &str) -> BTreeMap<String, String> {
    let cwd = PathBuf::from(repo_root);
    if !cwd.is_dir() {
        return BTreeMap::new();
    }
    let Ok(out) = Command::new("gh")
        .args(["stack", "view", "--json"])
        .current_dir(&cwd)
        .output()
    else {
        return BTreeMap::new();
    };
    if !out.status.success() {
        return BTreeMap::new();
    }
    parse_parents(&String::from_utf8_lossy(&out.stdout))
}

/// PURE: turn `gh stack view --json` output into `branch -> parent branch`.
/// The trunk itself never appears as a key (it has no parent), but it does
/// appear as the value for the bottom-most branch.
pub fn parse_parents(json: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(view) = serde_json::from_str::<StackView>(json.trim()) else {
        return out;
    };
    let by_head: BTreeMap<&str, &str> = view
        .branches
        .iter()
        .filter(|b| !b.head.is_empty() && !b.name.is_empty())
        .map(|b| (b.head.as_str(), b.name.as_str()))
        .collect();
    for (i, b) in view.branches.iter().enumerate() {
        if b.name.is_empty() {
            continue;
        }
        // Exact parent by SHA first; the branch below in the list otherwise;
        // the trunk for the bottom of the stack.
        let parent = by_head
            .get(b.base.as_str())
            .map(|p| p.to_string())
            .filter(|p| p != &b.name)
            .or_else(|| {
                if i == 0 {
                    None
                } else {
                    view.branches[..i]
                        .iter()
                        .rev()
                        .map(|p| p.name.clone())
                        .find(|p| !p.is_empty() && p != &b.name)
                }
            })
            .or_else(|| {
                if view.trunk.is_empty() || view.trunk == b.name {
                    None
                } else {
                    Some(view.trunk.clone())
                }
            });
        if let Some(parent) = parent {
            out.insert(b.name.clone(), parent);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "trunk": "main",
      "currentBranch": "feat-2",
      "branches": [
        { "name": "feat-1", "head": "aaa111", "base": "000000", "isCurrent": false,
          "isMerged": false, "isQueued": false, "needsRebase": false,
          "pr": { "number": 41, "url": "https://github.com/o/r/pull/41", "state": "OPEN" } },
        { "name": "feat-2", "head": "bbb222", "base": "aaa111", "isCurrent": true,
          "isMerged": false, "isQueued": false, "needsRebase": false,
          "pr": { "number": 42, "url": "https://github.com/o/r/pull/42", "state": "OPEN" } },
        { "name": "feat-3", "head": "ccc333", "base": "stale00", "isCurrent": false,
          "isMerged": false, "isQueued": false, "needsRebase": true }
      ]
    }"#;

    #[test]
    fn parents_follow_sha_then_list_order_then_trunk() {
        let p = parse_parents(SAMPLE);
        // Bottom of the stack: base SHA matches nothing → trunk.
        assert_eq!(p.get("feat-1").map(String::as_str), Some("main"));
        // Exact SHA match to feat-1's head.
        assert_eq!(p.get("feat-2").map(String::as_str), Some("feat-1"));
        // Stale base (needs rebase) → the branch listed just below it.
        assert_eq!(p.get("feat-3").map(String::as_str), Some("feat-2"));
        assert!(!p.contains_key("main"));
    }

    #[test]
    fn garbage_and_empty_yield_no_parents() {
        assert!(parse_parents("").is_empty());
        assert!(parse_parents("not json").is_empty());
        assert!(parse_parents(r#"{"trunk":"main","branches":[]}"#).is_empty());
        // A stack with no trunk and a single branch has nothing to point at.
        assert!(parse_parents(r#"{"branches":[{"name":"solo","head":"x","base":"y"}]}"#).is_empty());
    }
}
