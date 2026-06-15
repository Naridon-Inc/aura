//! The durable goal ledger — the engine half of the goal-alignment spine.
//!
//! Every feature Claude Code (or Aura's own chat) builds should stay tied to
//! the smaller and larger goals it serves, and *prove* it isn't hallucinated
//! slop. That proof lives here, on disk, git-tracked: `.aura/goals.jsonl`
//! holds one record per goal — its plain-language text, the task it belongs
//! under, the one-time decomposition into semantic requirements, and the runs
//! that re-checked those requirements against the real code over time.
//!
//! Layout (DDD):
//! - [`model`] — the on-disk types ([`GoalRecord`], [`GoalRun`],
//!   [`Decomposition`], [`Requirement`], [`Verdict`]).
//! - [`store`] — load/get/for_task/for_commit/upsert/link/record over the
//!   ledger, with id parity to the frontend `goalStore.ts` so a goal born in
//!   the app and one born from `aura prove` are the same record.

pub mod active;
pub mod build;
pub mod cli;
pub mod model;
pub mod store;

pub use model::{Decomposition, GoalRecord, GoalRun, Requirement, Verdict};

use std::path::PathBuf;

/// Distinct files the satisfying nodes live in, pulled from a structured
/// `aura prove` outcome — the concrete code↔goal links. Shared by the manual
/// (`cli`) and automatic (`build`) prove paths.
pub fn files_from_outcome(outcome: &serde_json::Value) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for check in outcome["checks"].as_array().into_iter().flatten() {
        if let Some(f) = check["file"].as_str() {
            if !f.is_empty() && !files.contains(&f.to_string()) {
                files.push(f.to_string());
            }
        }
    }
    files
}

/// Resolve the repository root the ledger lives under, mirroring the rest of
/// the CLI (`atlas::discover_repo_root`): the git workdir if we're in a repo,
/// else the current directory.
pub fn discover_repo_root() -> Option<PathBuf> {
    if let Ok(repo) = git2::Repository::discover(".") {
        if let Some(wd) = repo.workdir() {
            return Some(wd.to_path_buf());
        }
    }
    std::env::current_dir().ok()
}
