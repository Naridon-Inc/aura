//! Cross-worktree control plane bridge — the data behind the Workspaces page.
//!
//! A repository can be checked out many times at once (one per feature, one
//! per agent), and until now the desktop could only ever see the checkout it
//! was opened on. The engine already assembles the whole board — every
//! checkout, which agent is standing in it, what each one is holding, and
//! where two of them have converged on the same symbol — behind
//! `aura worktrees list --json`. This module ferries that across so the page
//! renders it instead of re-deriving it.
//!
//! Deliberately a thin shell-out + parse, the same shape as `cmd_meta_plane`:
//! the schema lives in exactly one place (the engine), and re-implementing
//! collision detection here would give the desktop and the CLI two subtly
//! different opinions about who is blocking whom. The `aura` binary is
//! resolved through `resolve_aura_bin` (`$AURA_BIN`, then `which aura`, then
//! `~/.cargo/bin/aura`, finally a bare `aura`), so a bundled CLI is honored.
//!
//! Two speeds, because the cost is not in the plane but in git:
//!   * `with_git_status: false` — one `git worktree list`. Milliseconds even
//!     at forty checkouts. Enough to draw every row.
//!   * `with_git_status: true`  — three git invocations per checkout (dirty
//!     count, drift from trunk, HEAD date). Seconds. Fills in the numbers.
//! The page paints the first, then replaces it with the second, so a large
//! repo is never staring at a spinner.

use std::path::PathBuf;
use std::process::Command;

use crate::agent_event_listener::resolve_aura_bin;

/// Shell `aura worktrees list --json` in `repo_root` and return the parsed
/// board.
///
/// `repo_root` may be any checkout of the repository — the engine resolves the
/// shared plane back to the main checkout itself, which is the whole point of
/// the two-plane split. Runs on a blocking thread: git walks working trees and
/// we must not park the async IPC executor on that.
#[tauri::command]
pub async fn worktree_plane(
    repo_root: String,
    with_git_status: Option<bool>,
) -> Result<serde_json::Value, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }

    let mut args = vec![
        "worktrees".to_string(),
        "list".to_string(),
        "--json".to_string(),
    ];
    if with_git_status == Some(false) {
        args.push("--no-git-status".to_string());
    }

    let bin = resolve_aura_bin();
    let out = tokio::task::spawn_blocking(move || {
        Command::new(&bin).args(&args).current_dir(&cwd).output()
    })
    .await
    .map_err(|e| format!("worktree plane task join: {e}"))?
    .map_err(|e| format!("failed to spawn `aura worktrees list`: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura worktrees list failed (status {}): {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .map_err(|e| format!("parse `aura worktrees list --json` output: {e}"))
}

/// Send a line to another checkout over the shared sentinel plane.
///
/// `to_worktree` names a checkout (`main` for the main one); `None` reaches
/// every agent holding a claim. The reply carries a recipient count, because
/// "delivered to nobody" and "delivered silently" look identical otherwise,
/// and a user who thinks they have coordinated when they haven't is worse off
/// than one who knows they haven't.
#[tauri::command]
pub async fn worktree_say(
    repo_root: String,
    message: String,
    to_worktree: Option<String>,
) -> Result<serde_json::Value, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let body = message.trim().to_string();
    if body.is_empty() {
        return Err("message is empty".to_string());
    }

    let mut args = vec![
        "worktrees".to_string(),
        "say".to_string(),
        body,
        "--json".to_string(),
    ];
    if let Some(to) = to_worktree.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--to".to_string());
        args.push(to.to_string());
    }

    let bin = resolve_aura_bin();
    let out = tokio::task::spawn_blocking(move || {
        Command::new(&bin).args(&args).current_dir(&cwd).output()
    })
    .await
    .map_err(|e| format!("worktree say task join: {e}"))?
    .map_err(|e| format!("failed to spawn `aura worktrees say`: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura worktrees say failed (status {}): {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .map_err(|e| format!("parse `aura worktrees say --json` output: {e}"))
}
