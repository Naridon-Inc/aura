//! One board per repository, not one per directory.
//!
//! Every `board::*` call takes a root, and every agent-facing caller used to
//! pass `Path::new(".")` — the *current directory*. That is wrong twice over:
//!
//! * An agent working in a linked worktree wrote its tasks to
//!   `<checkout>/.aura/tasks/tasks.json`, a board no other checkout and no
//!   human ever opened. Three real tasks were already stranded this way (two
//!   in `gothenburg`, one in `zagreb`) while the shared board carried 141.
//! * Running from a *subdirectory* created a third board right there, the same
//!   way the old path resolver littered `aura-cli/.aura` and `aura-shell/.aura`
//!   across this repo.
//!
//! The board is shared state — the whole point is that a human in the app and
//! an agent in a worktree see the same rows — so it belongs on the shared
//! plane, anchored to the repository root, exactly like sentinel claims and the
//! awareness feed. [`shared_root`] is that anchor.
//!
//! Boards written before this fix are adopted rather than abandoned: see
//! [`adopt_stray_boards`].

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{discover, paths};

/// The directory whose `.aura/tasks/` holds *the* board.
///
/// Outside a git repository this is the current directory, which is what every
/// caller did before — a scratch board for a scratch directory is fine, the
/// bug was only ever a *repository* growing more than one.
pub fn shared_root() -> PathBuf {
    paths::repo_root().unwrap_or_else(|| PathBuf::from("."))
}

/// [`shared_root`], with the one-time adoption of stray boards run first.
///
/// Every caller that is about to *read or write the board* should come through
/// here rather than [`shared_root`], so a checkout that still has a private
/// board contributes its rows before anyone draws a conclusion from the shared
/// one. Two entry points ran the migration on different schedules once; one is
/// enough, and this is it.
pub fn board_dir() -> PathBuf {
    use std::sync::Once;
    static ADOPT: Once = Once::new();
    ADOPT.call_once(|| {
        adopt_stray_boards();
    });
    shared_root()
}

/// Fold boards written into individual checkouts back into the shared one.
///
/// Runs before the first read of the shared board. A stray row is re-keyed
/// (fresh `sequence_id` from the shared allocator, since a worktree board
/// started counting at 1 and would otherwise collide with `AURA-1`) and
/// stamped with the checkout it was written in, so "who was doing this, and
/// where" survives the move. The stray file is renamed aside rather than
/// deleted — adoption is not a thing to be clever about, and a `.adopted`
/// sibling costs nothing.
///
/// Returns how many rows were adopted.
pub fn adopt_stray_boards() -> usize {
    let Some(repo) = paths::repo_root() else {
        return 0;
    };
    let mut adopted = 0;
    for wt in discover::list() {
        let Some(name) = wt.name.clone() else { continue };
        if wt.missing {
            continue;
        }
        let stray = wt.path.join(".aura").join("tasks").join("tasks.json");
        if !stray.exists() || stray.starts_with(&repo.join(".aura")) {
            continue;
        }
        adopted += adopt_one(&repo, &stray, &name);
    }
    adopted
}

/// Move every row out of one stray board into the shared one. Returns the
/// number of rows written.
fn adopt_one(repo: &Path, stray: &Path, worktree: &str) -> usize {
    let Some(rows) = read_rows(stray) else {
        return 0;
    };
    if rows.is_empty() {
        let _ = fs::rename(stray, stray.with_extension("json.adopted"));
        return 0;
    }

    let mut written = 0;
    for row in rows {
        let title = row.get("title").and_then(Value::as_str).unwrap_or("").trim();
        if title.is_empty() {
            continue;
        }
        // Re-create through the normal path so the row picks up a shared
        // `sequence_id` and the same shape the app writes. Carrying the old id
        // across would hand two tasks the same `AURA-{n}`.
        let created = crate::board::create_task(
            repo,
            crate::board::NewTask {
                title,
                description: row.get("description").and_then(Value::as_str),
                status: row.get("status").and_then(Value::as_str),
                priority: row.get("priority").and_then(Value::as_str),
                agent_assignee: row.get("agent_assignee").and_then(Value::as_str),
                // The checkout it was written in is the best available answer
                // to "where was this meant to happen", and it is strictly more
                // than the row carried before.
                worktree: row
                    .get("worktree")
                    .and_then(Value::as_str)
                    .or(Some(worktree)),
                // Carried across so a task that already stated its shape keeps
                // it. This is a move between boards, not a re-filing, and a
                // row that arrives having forgotten its steps has been damaged
                // by the thing that was meant to preserve it.
                objective: row.get("objective").and_then(Value::as_str),
                steps: row
                    .get("steps")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|s| s.get("text").and_then(Value::as_str))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                // The crew a row belongs to is not an id on the old board — it
                // is a slug — so it survives the move and keeps the row under
                // its crew instead of dropping it into the loose pile.
                crew: row.get("crew_id").and_then(Value::as_str),
                // Not carried: both point at ids on the board being left
                // behind, and this loop is minting new ones. A dangling
                // pointer would read as "blocked by something that doesn't
                // exist", which is worse than an honestly unlinked row.
                ..Default::default()
            },
        );
        if created.is_ok() {
            written += 1;
        }
    }
    let _ = fs::rename(stray, stray.with_extension("json.adopted"));
    written
}

fn read_rows(path: &Path) -> Option<Vec<Value>> {
    let bytes = fs::read(path).ok()?;
    let doc: Value = serde_json::from_slice(&bytes).ok()?;
    Some(doc.get("tasks")?.as_array()?.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_rows_survives_a_board_that_is_not_json() {
        let dir = std::env::temp_dir().join(format!("aura-board-root-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let p = dir.join("tasks.json");
        fs::write(&p, b"not json at all").unwrap();
        // A corrupt stray board must be skipped, never panic the first read of
        // the shared board.
        assert!(read_rows(&p).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_rows_returns_the_tasks_array() {
        let dir = std::env::temp_dir().join(format!("aura-board-root-ok-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let p = dir.join("tasks.json");
        fs::write(&p, br#"{"tasks":[{"title":"a"},{"title":"b"}]}"#).unwrap();
        assert_eq!(read_rows(&p).unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
