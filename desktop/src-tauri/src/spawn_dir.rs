//! Safe spawn-directory resolution.
//!
//! A coding agent must always run inside the user's actual project — never
//! the desktop app's own launch directory. When a chat/agent session has no
//! project bound, the repo root resolves to an empty string; passing that
//! empty string (or a path that no longer exists) to a `Command` makes the
//! spawned child INHERIT the desktop app's cwd — which, for a dev build, is
//! Aura's own source tree. In Auto mode the agent could then edit Aura's
//! code thinking it's the user's repo.
//!
//! `safe_spawn_dir` closes that hole: it NEVER lets an empty/invalid root
//! fall through to the inherited process cwd. An empty or non-existent root
//! is redirected to the user's home directory (an inert, well-defined place)
//! and the situation is logged so the misconfiguration is visible.

use std::path::PathBuf;

/// Resolve a working directory that is always safe to spawn a child process
/// in. For a valid (non-empty, existing-directory) `root`, returns it
/// verbatim so existing behavior is unchanged. For an empty string or a path
/// that is not an existing directory, returns the user's home directory
/// (`$HOME`, falling back to `/`) and logs a warning — so a project-less
/// session can never silently run the agent inside the desktop app's own
/// directory.
pub fn safe_spawn_dir(root: &str) -> PathBuf {
    let trimmed = root.trim();
    if !trimmed.is_empty() {
        let path = PathBuf::from(trimmed);
        if path.is_dir() {
            return path;
        }
        eprintln!(
            "[spawn_dir] WARNING: requested spawn root {trimmed:?} is not an existing \
             directory — falling back to the home directory so the agent never runs \
             inside the app's own launch dir"
        );
    } else {
        eprintln!(
            "[spawn_dir] WARNING: empty spawn root (no project bound) — falling back to \
             the home directory so the agent never inherits the app's launch dir"
        );
    }
    home_dir()
}

/// The user's home directory, or `/` as a last resort. Kept private so the
/// only entry point is `safe_spawn_dir`, which guarantees a directory that is
/// never the inherited process cwd.
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}
