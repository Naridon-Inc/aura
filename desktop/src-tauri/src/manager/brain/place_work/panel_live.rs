//! The reads a machine chat's right panel makes, live, against a real
//! machine: the file tree, a folder inside it, the branch's changes and where
//! it stands.
//!
//! The panel spells every path under the worktree's own path on the machine
//! (it has no checkout on this laptop to spell them under), so this checks
//! the commands answer in that spelling and take it back.
//!
//! `AURA_PANEL_LIVE_MACHINE=<machine id>` names a machine in this laptop's
//! book and `AURA_PANEL_LIVE_ROOT` an absolute folder on it that is a git
//! checkout. Nothing is written there. With `AURA_PANEL_LIVE_DUMP=<file>` the
//! answers are also written to that file as JSON, for a visual harness.

use serde_json::json;

use super::{fs, git};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

#[tokio::test]
#[ignore = "needs a machine in this laptop's book: AURA_PANEL_LIVE_MACHINE, AURA_PANEL_LIVE_ROOT"]
async fn a_machine_chats_panel_reads_its_worktree_at_the_worktrees_own_path() {
    let (Some(machine), Some(root)) = (env("AURA_PANEL_LIVE_MACHINE"), env("AURA_PANEL_LIVE_ROOT")) else {
        eprintln!("skipped: AURA_PANEL_LIVE_MACHINE / AURA_PANEL_LIVE_ROOT not set");
        return;
    };
    let at = || (machine.clone(), root.clone(), Some(root.clone()));

    let (m, r, rr) = at();
    let top = fs::place_fs_list(m, r, rr, root.clone()).await.expect("the root lists");
    assert!(!top.is_empty(), "a checkout has files");
    for e in &top {
        assert!(e.path.starts_with(&format!("{root}/")), "{} is spelled under the worktree", e.path);
    }
    let folder = top.iter().find(|e| e.is_dir).expect("a checkout has a folder");
    let (m, r, rr) = at();
    let inside = fs::place_fs_list(m, r, rr, folder.path.clone()).await.expect("a folder lists");
    for e in &inside {
        assert!(e.path.starts_with(&format!("{}/", folder.path)), "{} is inside {}", e.path, folder.path);
    }

    let (m, r, rr) = at();
    let stats = git::place_git_diff_stats_per_file(m, r, rr, Some(true)).await.expect("changes count");
    let (m, r, rr) = at();
    let status = git::place_git_status_v2(m, r, rr).await;
    let (m, r, rr) = at();
    let ahead = git::place_git_ahead_behind(m, r, rr).await.expect("the branch stands somewhere");
    assert!(ahead.branch.as_deref().is_some_and(|b| !b.is_empty()), "a checkout is on a branch");

    // A path from outside the worktree is refused, never read.
    let (m, r, rr) = at();
    assert!(fs::place_fs_list(m, r, rr, "/etc".into()).await.is_err());

    if let Some(out) = env("AURA_PANEL_LIVE_DUMP") {
        let dump = json!({
            "root": root,
            "top": top,
            "folder": folder.path,
            "inside": inside,
            "stats": stats,
            "status": status,
            "ahead": ahead,
        });
        std::fs::write(out, serde_json::to_vec_pretty(&dump).unwrap()).unwrap();
    }
}
