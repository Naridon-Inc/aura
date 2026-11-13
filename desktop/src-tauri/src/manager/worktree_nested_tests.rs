//! A task's copy of the project carries copies of its nested repositories,
//! and removing the copy drops their records while every branch stays.

use std::path::{Path, PathBuf};

use super::{create, paths_for, remove, TaskCopyRemoval};
use crate::nested_repos::test_support::{git, init_repo, scratch};

fn output(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn has_branch(repo: &Path, branch: &str) -> bool {
    output(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).len() == 40
}

/// A project that ignores `cloud/`, a repository of its own inside it.
fn project() -> (PathBuf, PathBuf) {
    let base = scratch("task-copy");
    let outer = base.join("outer");
    init_repo(&outer);
    std::fs::write(outer.join(".gitignore"), "cloud/\n").unwrap();
    git(&outer, &["add", "."]);
    git(&outer, &["commit", "-q", "-m", "ignore cloud"]);
    init_repo(&outer.join("cloud"));
    (base, outer)
}

const SESSION: &str = "sess1234-abcd";

#[test]
fn a_task_copy_carries_the_nested_repository_on_the_task_branch() {
    let (base, outer) = project();
    let root = outer.to_string_lossy().into_owned();
    let made = create(&root, SESSION, 2, "Tidy the private config").unwrap();
    let (path, branch) = paths_for(&root, SESSION, 2, "Tidy the private config");
    assert_eq!(Path::new(&made), path);

    let copy = path.join("cloud");
    assert_eq!(std::fs::read_to_string(copy.join("README.md")).unwrap(), "hello\n");
    assert_eq!(output(&copy, &["symbolic-ref", "--short", "HEAD"]), branch);
    assert!(output(&outer.join("cloud"), &["worktree", "list"]).contains(copy.to_str().unwrap()));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn removing_a_task_copy_drops_the_nested_record_and_keeps_every_branch() {
    let (base, outer) = project();
    let root = outer.to_string_lossy().into_owned();
    let cloud = outer.join("cloud");
    // The project's own Aura records are copied into the task's copy when it
    // starts; those copies aren't work anyone would lose.
    std::fs::create_dir_all(outer.join(".aura")).unwrap();
    std::fs::write(outer.join(".aura/memory.json"), "{}").unwrap();
    let made = create(&root, SESSION, 3, "Rename the setting").unwrap();
    let (_, branch) = paths_for(&root, SESSION, 3, "Rename the setting");
    assert!(Path::new(&made).join(".aura/memory.json").is_file());

    assert_eq!(remove(&root, &made, false).unwrap(), TaskCopyRemoval::Removed);
    assert!(!Path::new(&made).exists());
    let listed = output(&cloud, &["worktree", "list", "--porcelain"]);
    assert!(!listed.contains(&made), "{listed}");
    assert!(has_branch(&cloud, &branch), "the nested repository keeps the task's branch");
    assert!(has_branch(&outer, &branch), "and so does the project");

    // Asked again once it is gone: nothing left to do, and no complaint.
    assert_eq!(remove(&root, &made, false).unwrap(), TaskCopyRemoval::Removed);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_task_copy_holding_unsaved_work_stays_until_the_user_says_so() {
    let (base, outer) = project();
    let root = outer.to_string_lossy().into_owned();
    let made = create(&root, SESSION, 4, "Draft the notes").unwrap();
    let copy = Path::new(&made);
    std::fs::write(copy.join("README.md"), "edited in the copy\n").unwrap();
    std::fs::write(copy.join("cloud/README.md"), "edited in the nested copy\n").unwrap();
    std::fs::write(copy.join("cloud/plan.md"), "new\n").unwrap();

    let TaskCopyRemoval::Kept { unsaved } = remove(&root, &made, false).unwrap() else {
        panic!("a copy with unsaved work was removed without say-so");
    };
    assert_eq!(
        unsaved,
        ["1 file with uncommitted changes", "cloud/ has 2 files with uncommitted changes"]
    );
    assert!(copy.join("cloud/plan.md").is_file());

    assert_eq!(remove(&root, &made, true).unwrap(), TaskCopyRemoval::Removed);
    assert!(!copy.exists());
    let listed = output(&outer.join("cloud"), &["worktree", "list", "--porcelain"]);
    assert!(!listed.contains(&made), "{listed}");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_task_copy_already_gone_from_disk_is_cleared_from_every_list() {
    let (base, outer) = project();
    let root = outer.to_string_lossy().into_owned();
    let made = create(&root, SESSION, 5, "Check the build").unwrap();
    std::fs::remove_dir_all(&made).unwrap();

    assert_eq!(remove(&root, &made, false).unwrap(), TaskCopyRemoval::Removed);
    assert!(!output(&outer, &["worktree", "list", "--porcelain"]).contains(&made));
    assert!(!output(&outer.join("cloud"), &["worktree", "list", "--porcelain"]).contains(&made));
    let _ = std::fs::remove_dir_all(&base);
}
