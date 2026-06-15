//! Wire 5 of AURA-46: when the semantic merge driver leaves a REAL node
//! conflict (same node modified on both sides, delete-vs-modify, add/add of
//! the same name — NOT the full-file `git merge-file` fallback), append one
//! `ConflictedNode` row per node to `.aura/conflicts.jsonl` so the desktop
//! ConflictsDialog surfaces it with both bodies side by side.
//!
//! The rows are written through `crate::live_conflicts::record_conflict`, the
//! existing CLI-side writer that mirrors aura-shell `cmd_conflicts.rs`
//! field-for-field — no second schema to drift.
//!
//! Hard rules, in order:
//! - The git contract is sacred: NOTHING here may change the merge result or
//!   the exit code. Every failure is swallowed (stderr only under
//!   `AURA_MERGE_DEBUG`).
//! - Only repos that opted into Aura get rows: the `.aura/` directory must
//!   already exist at the repo root, otherwise we skip silently — the driver
//!   may be installed globally and run in repos that have never seen Aura.
//! - Attribution is honest best-effort, never fabricated:
//!   ours = `GIT_AUTHOR_NAME` env, else the current branch, else "ours";
//!   theirs = the friendly ref name git exported as `GITHEAD_<sha>` for the
//!   merge head (verified live: git 2.47/merge-ort sets exactly one such var,
//!   for the incoming head only), else "incoming" (e.g. during rebase /
//!   cherry-pick, where git sets no GITHEAD at all).

use std::path::Path;
use std::process::Command;

use super::engine::NodeConflict;

/// Append conflict rows for `details`. Infallible by design — see module doc.
pub fn emit(path_hint: Option<&str>, details: &[NodeConflict]) {
    if let Err(reason) = try_emit(path_hint, details) {
        if std::env::var("AURA_MERGE_DEBUG").is_ok() {
            eprintln!("aura merge-driver: conflict rows skipped ({})", reason);
        }
    }
}

fn try_emit(path_hint: Option<&str>, details: &[NodeConflict]) -> Result<(), String> {
    if details.is_empty() {
        return Ok(());
    }
    let file = path_hint.ok_or("no --path to attribute the conflict to")?;
    // git runs merge drivers from the top of the working tree (verified live),
    // and the conflict store is cwd-relative — double-check both before
    // writing so a misconfigured invocation can never scatter `.aura/` dirs.
    if !Path::new(".aura").is_dir() {
        return Err("no .aura directory at the repo root".into());
    }
    let cdup = git_stdout(&["rev-parse", "--show-cdup"])?;
    if !cdup.is_empty() {
        return Err("cwd is not the repo root".into());
    }

    let ours_agent = ours_agent();
    let theirs_agent = theirs_agent(&ours_agent);
    for d in details {
        // Dedup against open rows on (file, identifier, base_hash) happens
        // inside record_conflict; a re-run merge won't double up. The bool
        // result is deliberately ignored — emission must never fail the merge.
        let _ = crate::live_conflicts::record_conflict(
            file,
            &d.identifier,
            &d.base_hash,
            &d.ours,
            &d.theirs,
            &ours_agent,
            &theirs_agent,
        );
    }
    Ok(())
}

/// Who holds the ours side: the configured author if git exported one, else
/// the branch the merge is happening on.
fn ours_agent() -> String {
    if let Ok(name) = std::env::var("GIT_AUTHOR_NAME") {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(branch) = git_stdout(&["rev-parse", "--abbrev-ref", "HEAD"]) {
        if !branch.is_empty() && branch != "HEAD" {
            return branch;
        }
    }
    "ours".to_string()
}

/// Who holds the theirs side: the ref name behind a `GITHEAD_<sha>` env var
/// that is not just our own side echoed back. Sorted for determinism when an
/// octopus merge exports several.
fn theirs_agent(ours: &str) -> String {
    let mut heads: Vec<String> = std::env::vars()
        .filter(|(key, _)| key.starts_with("GITHEAD_"))
        .map(|(_, value)| value)
        .collect();
    heads.sort();
    heads
        .into_iter()
        .find(|value| !value.is_empty() && value != ours && value != "HEAD")
        .unwrap_or_else(|| "incoming".to_string())
}

fn git_stdout(args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !out.status.success() {
        return Err(format!("git {} failed", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
