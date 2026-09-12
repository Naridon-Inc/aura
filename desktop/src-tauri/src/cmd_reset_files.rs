//! AURA-1296 — "Reset chat → Also reset files": throw away every uncommitted
//! change in a project.
//!
//! `git_discard` (cmd_files.rs) puts named tracked files back; it does not
//! touch files git has never seen, and "start over" means those too. So this
//! is the whole-tree version: tracked files back to HEAD, untracked files and
//! folders removed. Ignored files are left alone — build output and local
//! env files are not what the user meant. Reports how many entries the tree
//! had before it was cleaned, so the toast can say what happened.

use std::path::PathBuf;
use std::process::Command;

fn git(cwd: &PathBuf, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))
}

fn ok_or_stderr(out: std::process::Output, what: &str) -> Result<(), String> {
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { what.to_string() } else { err })
    }
}

/// How many entries `git status --porcelain -z` lists — the figure the
/// user saw as "Also reset files (N)".
fn count_dirty(cwd: &PathBuf) -> Result<u32, String> {
    let out = git(cwd, &["status", "--porcelain", "-z", "--untracked-files=all"])?;
    ok_or_stderr(
        std::process::Output {
            status: out.status,
            stdout: Vec::new(),
            stderr: out.stderr.clone(),
        },
        "git status failed",
    )?;
    Ok(crate::git_parse::status::count_records(&out.stdout))
}

#[tauri::command]
pub async fn git_reset_files(repo_root: String) -> Result<u32, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        // `.git` may be a file in a worktree, so ask git rather than the disk.
        if !git(&cwd, &["rev-parse", "--git-dir"])?.status.success() {
            return Err("This folder isn't a git repository.".to_string());
        }
        let count = count_dirty(&cwd)?;
        ok_or_stderr(git(&cwd, &["checkout", "--", "."])?, "git checkout failed")?;
        ok_or_stderr(git(&cwd, &["clean", "-fd"])?, "git clean failed")?;
        Ok(count)
    })
    .await
}
