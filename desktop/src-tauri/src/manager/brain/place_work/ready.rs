//! "Can the files, changes and git tabs open here?" — asked once, before a
//! pane is mounted on a folder the box may not have.
//!
//! A remote workspace's work tabs are the local panes pointed at a root on a
//! machine. Each of them, on its own, turns a box with no such folder or no
//! `git` into its own empty state — a file tree that says nothing, a Changes
//! list with no rows — which reads as "nothing here" when the truth is "this
//! folder is not on that machine". So the workspace asks this first and, when
//! the box refuses, shows the box's *own* sentence: what `cd` or `git` said
//! on the other side, not a line written here to cover every case.

use super::{outcome, Place, Work};

/// What is asked. `rev-parse --show-toplevel` fails with git's own sentence
/// when the folder is not a checkout (`fatal: not a git repository …`), and
/// the `cd` that `Place::sh` wraps every script in fails with the shell's
/// when the folder is not there at all. Both are the answer.
const PROBE: &str = "git rev-parse --show-toplevel";

/// `Ok(())` when `root` (or `remote_root`) on the machine is a git checkout
/// the tabs can open. `Err(sentence)` otherwise — the box's stderr, so the
/// empty state says what actually went wrong over there.
#[tauri::command]
pub async fn place_work_ready(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
) -> Result<(), String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.ask(PROBE).await?;
    outcome(&out).map(|_| ())
}
