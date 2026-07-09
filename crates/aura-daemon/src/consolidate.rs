//! W4 — scheduled memory consolidation (AURA-42).
//!
//! Every [`CONSOLIDATE_INTERVAL`] the daemon runs `aura memory consolidate`
//! in each workspace it knows about, so project memory self-maintains on
//! the Google-style 30-minute cadence without anyone asking. The CLI verb
//! is THE consolidation code path (`MemoryManager::consolidate` →
//! `memory_decay::consolidate_mem`); the daemon deliberately shells out to
//! it instead of reimplementing the logic — aura-cli is a workspace-
//! excluded binary crate, so linking it is not an option, and one code
//! path means the loop and a human running the verb can never diverge.
//!
//! The pass is fail-quiet end to end: a workspace without a memory store
//! is never touched, a missing `aura` binary or a keyless CLI run (the CLI
//! itself skips sections silently when no model is reachable) just means
//! nothing happens this cycle.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, info, warn};

use crate::state::ServerState;

/// Cadence of the consolidation pass — 30 minutes.
pub const CONSOLIDATE_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Workspaces eligible for a consolidation run this cycle:
///
///   1. the repo the daemon is rooted in, derived from `sentinel_root`
///      (embedders pass `<repo>/.aura/sentinel`, so two `parent()` hops
///      recover the repo; the standalone binary's `~/.aura/daemon/...`
///      layout doesn't match and contributes nothing);
///   2. the workspace of every open session.
///
/// Deduplicated, and filtered to workspaces that actually have a
/// `.aura/memory.json` — the pass must never create state in a repo that
/// never opted into project memory.
pub fn candidate_workspaces(state: &ServerState) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    let sr = &state.sentinel_root;
    if sr.ends_with(".aura/sentinel") {
        if let Some(repo) = sr.parent().and_then(|aura_dir| aura_dir.parent()) {
            out.push(repo.to_path_buf());
        }
    }

    if let Ok(sessions) = state.all_sessions() {
        for s in sessions {
            out.push(s.workspace);
        }
    }

    out.sort();
    out.dedup();
    out.retain(|ws| ws.join(".aura").join("memory.json").is_file());
    out
}

/// One consolidation pass: run `aura memory consolidate` in every
/// candidate workspace. Blocking process spawns are pushed onto the
/// blocking pool so the (current-thread) daemon runtime keeps serving
/// connections. Every failure mode logs and moves on — the next tick
/// retries.
pub async fn run_pass(state: &Arc<ServerState>) {
    let workspaces = candidate_workspaces(state);
    if workspaces.is_empty() {
        debug!("memory consolidation: no eligible workspaces this cycle");
        return;
    }
    for ws in workspaces {
        let cwd = ws.clone();
        let spawned = tokio::task::spawn_blocking(move || {
            std::process::Command::new("aura")
                .args(["memory", "consolidate"])
                .current_dir(&cwd)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
        })
        .await;

        match spawned {
            Ok(Ok(output)) if output.status.success() => {
                info!(workspace = %ws.display(), "memory consolidation pass complete");
            }
            Ok(Ok(output)) => {
                // CLI ran but failed (e.g. corrupted store) — log, retry
                // next cycle. Keyless skips exit 0 and never land here.
                debug!(
                    workspace = %ws.display(),
                    status = ?output.status.code(),
                    stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                    "memory consolidation run failed; will retry next cycle"
                );
            }
            Ok(Err(e)) => {
                debug!(
                    workspace = %ws.display(),
                    error = %e,
                    "aura CLI unavailable — skipping memory consolidation this cycle"
                );
            }
            Err(e) => {
                warn!(error = %e, "memory consolidation task join failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::InputRouter;
    use aura_blockstore::BlockStore;
    use tempfile::TempDir;

    fn state_with_sentinel(sentinel_root: PathBuf, store_dir: &std::path::Path) -> ServerState {
        let store = BlockStore::open(&store_dir.join("blocks.db")).expect("open store");
        ServerState::new(Arc::new(store), sentinel_root, Arc::new(InputRouter::new()))
    }

    #[test]
    fn derives_repo_from_sentinel_root_when_memory_exists() {
        let dir = TempDir::new().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".aura")).unwrap();
        std::fs::write(repo.join(".aura").join("memory.json"), "{}").unwrap();

        let state = state_with_sentinel(repo.join(".aura").join("sentinel"), dir.path());
        let ws = candidate_workspaces(&state);
        assert_eq!(ws, vec![repo]);
    }

    #[test]
    fn skips_repos_without_a_memory_store_and_non_repo_layouts() {
        let dir = TempDir::new().unwrap();
        // Repo layout but no memory.json — must not be touched.
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".aura").join("sentinel")).unwrap();
        let state = state_with_sentinel(repo.join(".aura").join("sentinel"), dir.path());
        assert!(candidate_workspaces(&state).is_empty());

        // Standalone-binary layout (`<daemon-dir>/sentinel`) — the path
        // shape doesn't match `.aura/sentinel`, contributes nothing.
        let state = state_with_sentinel(dir.path().join("sentinel"), dir.path());
        assert!(candidate_workspaces(&state).is_empty());
    }

    #[test]
    fn includes_session_workspaces_and_dedupes() {
        let dir = TempDir::new().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".aura")).unwrap();
        std::fs::write(repo.join(".aura").join("memory.json"), "{}").unwrap();

        let other = dir.path().join("other");
        std::fs::create_dir_all(other.join(".aura")).unwrap();
        std::fs::write(other.join(".aura").join("memory.json"), "{}").unwrap();

        let state = state_with_sentinel(repo.join(".aura").join("sentinel"), dir.path());
        // Session in a second workspace + a duplicate of the repo itself.
        state.open_session(other.clone(), None).unwrap();
        state.open_session(repo.clone(), None).unwrap();

        let ws = candidate_workspaces(&state);
        assert_eq!(ws.len(), 2);
        assert!(ws.contains(&repo));
        assert!(ws.contains(&other));
    }
}
