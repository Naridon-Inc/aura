//! Graphite stack awareness — local, token-free.
//!
//! Graphite's `gt` CLI stores each managed branch's parent as a native git
//! ref under `refs/branch-metadata/<branch>`, pointing at a blob whose JSON
//! is `{ "parentBranchName": "...", "parentBranchRevision": "..." }`. That is
//! the authoritative stack topology `gt` itself reads — and it captures
//! stacks the GitHub base-refs can't. A common Graphite workflow opens every
//! PR against `main` while the branches are stacked locally; head/base
//! inference then sees no stack at all, but the branch-metadata refs know the
//! true parent chain.
//!
//! We read those refs directly with plumbing git commands: no network, no
//! token, works offline. When the repo isn't Graphite-managed the map is
//! simply empty and callers fall back to head/base inference. Everything here
//! is best-effort — Graphite is optional enrichment, so any failure degrades
//! to "no stack metadata" rather than breaking the PR view.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

use serde::Deserialize;

const METADATA_REF_PREFIX: &str = "refs/branch-metadata/";

/// The subset of Graphite's branch-metadata blob we consume. Graphite writes
/// more (`parentBranchRevision`, and in newer versions a `prInfo` object) but
/// the parent branch name is the only field we need — PR data itself comes
/// from `gh`.
#[derive(Debug, Deserialize)]
struct BranchMetadata {
    #[serde(rename = "parentBranchName")]
    parent_branch_name: Option<String>,
}

/// Map of `branch -> parent branch` for every Graphite-tracked branch in the
/// repo. Empty when the repo has no `refs/branch-metadata/*` (not
/// Graphite-managed) or git isn't available.
pub fn stack_parents(repo_root: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(refs) = list_metadata_refs(repo_root) else {
        return out;
    };
    for refname in refs {
        let Some(branch) = refname.strip_prefix(METADATA_REF_PREFIX) else {
            continue;
        };
        if branch.is_empty() {
            continue;
        }
        if let Some(parent) = read_parent(repo_root, &refname) {
            // Guard against a self-referential or empty parent — a trunk
            // branch (`main`) has no metadata ref, so any parent we read
            // points at a real ancestor.
            if !parent.is_empty() && parent != branch {
                out.insert(branch.to_string(), parent);
            }
        }
    }
    out
}

/// True when the repo carries any Graphite branch metadata — lets the UI show
/// a "stack from Graphite" affordance only when the repo is actually managed
/// by `gt`.
pub fn is_graphite_repo(repo_root: &str) -> bool {
    list_metadata_refs(repo_root)
        .map(|r| !r.is_empty())
        .unwrap_or(false)
}

fn list_metadata_refs(repo_root: &str) -> Option<Vec<String>> {
    let out = run_git(
        repo_root,
        &["for-each-ref", "--format=%(refname)", METADATA_REF_PREFIX],
    )?;
    let refs: Vec<String> = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Some(refs)
}

fn read_parent(repo_root: &str, refname: &str) -> Option<String> {
    let blob = run_git(repo_root, &["cat-file", "-p", refname])?;
    let meta: BranchMetadata = serde_json::from_str(blob.trim()).ok()?;
    meta.parent_branch_name
}

/// Run a git plumbing command in `repo_root`, returning stdout on success.
/// Returns `None` (never an error) for any failure so callers treat a
/// missing/broken Graphite install as "no metadata".
fn run_git(repo_root: &str, args: &[&str]) -> Option<String> {
    let cwd = PathBuf::from(repo_root);
    if !cwd.is_dir() {
        return None;
    }
    let out = Command::new("git")
        .args(args)
        .current_dir(&cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}
