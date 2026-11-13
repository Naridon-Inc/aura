//! Committing from Aura inside a nested repository leaves no `.aura/` folder
//! in it, in its commits, or on its remote. The project around it keeps
//! getting Aura's commit marker as before.

use std::path::{Path, PathBuf};

use super::test_support::{git, init_repo, scratch};
use super::{aura_stays_out, is_nested};
use crate::cmd_files::{git_commit, git_push, git_stage};

fn output(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn files_at(repo: &Path, rev: &str) -> Vec<String> {
    let mut files: Vec<String> =
        output(repo, &["ls-tree", "-r", "--name-only", rev]).lines().map(str::to_string).collect();
    files.sort();
    files
}

/// A public project that ignores `cloud/`, and `cloud/` a private repository
/// with a remote of its own.
fn project_with_private_remote() -> (PathBuf, PathBuf, PathBuf) {
    let base = scratch("aura-dir");
    let outer = base.join("outer");
    init_repo(&outer);
    std::fs::write(outer.join(".gitignore"), "cloud/\n").unwrap();
    git(&outer, &["add", "."]);
    git(&outer, &["commit", "-q", "-m", "ignore cloud"]);
    let cloud = outer.join("cloud");
    init_repo(&cloud);
    let remote = base.join("cloud-remote.git");
    git(&base, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(&cloud, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&cloud, &["push", "-q", "origin", "main"]);
    (base, outer, remote)
}

#[tokio::test]
async fn committing_and_pushing_from_aura_leaves_no_aura_folder_in_a_nested_repository() {
    let (base, outer, remote) = project_with_private_remote();
    let root = outer.to_string_lossy().into_owned();
    let cloud = outer.join("cloud");
    let inner = cloud.to_string_lossy().into_owned();
    std::fs::write(cloud.join("README.md"), "hello\nprivate edit\n").unwrap();
    std::fs::write(cloud.join("plan.md"), "new\n").unwrap();

    // The commit box checks for collisions first; that must not make the
    // folder either.
    let _ = crate::cmd_aura::aura_radar(inner.clone(), false).await;
    git_stage(root.clone(), vec!["cloud/README.md".into(), "cloud/plan.md".into()]).await.unwrap();
    git_commit(inner.clone(), "private edit".into()).await.unwrap();
    git_push(inner.clone(), true).await.unwrap();

    assert!(!cloud.join(".aura").exists(), "no .aura folder was made in the nested repository");
    assert_eq!(files_at(&cloud, "HEAD"), ["README.md", "plan.md"]);
    assert_eq!(output(&remote, &["rev-parse", "main"]), output(&cloud, &["rev-parse", "HEAD"]));
    assert_eq!(files_at(&remote, "main"), ["README.md", "plan.md"], "and none reached its remote");

    // The project around it still gets its marker, made when it isn't there.
    assert!(!outer.join(".aura").exists());
    std::fs::write(outer.join("README.md"), "outer edit\n").unwrap();
    git_stage(root.clone(), vec!["README.md".into()]).await.unwrap();
    git_commit(root.clone(), "outer edit".into()).await.unwrap();
    assert_eq!(std::fs::read_to_string(outer.join(".aura/.intent_logged")).unwrap(), "1");
    let log = std::fs::read_to_string(outer.join(".aura/intent_log.jsonl")).unwrap();
    assert!(log.contains("outer edit"), "{log}");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn a_stray_aura_folder_in_a_nested_repository_stays_out_of_its_commits() {
    let (base, outer, remote) = project_with_private_remote();
    let cloud = outer.join("cloud");
    let inner = cloud.to_string_lossy().into_owned();
    // Something else made the folder, and staging everything picked it up.
    std::fs::create_dir_all(cloud.join(".aura")).unwrap();
    std::fs::write(cloud.join(".aura/sync_state.json"), "{}\n").unwrap();
    std::fs::write(cloud.join("notes.md"), "notes\n").unwrap();
    git(&cloud, &["add", "-A"]);

    git_commit(inner.clone(), "notes".into()).await.unwrap();
    git_push(inner, true).await.unwrap();

    assert_eq!(files_at(&cloud, "HEAD"), ["README.md", "notes.md"]);
    assert_eq!(files_at(&remote, "main"), ["README.md", "notes.md"]);
    assert!(cloud.join(".aura/sync_state.json").is_file(), "the files stay on disk");
    assert!(
        cloud.join(".aura/.intent_logged").is_file(),
        "a folder that is already there still gets the marker"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn a_nested_repository_whose_history_has_aura_records_commits_them_as_before() {
    let (base, outer, _remote) = project_with_private_remote();
    let cloud = outer.join("cloud");
    std::fs::create_dir_all(cloud.join(".aura")).unwrap();
    std::fs::write(cloud.join(".aura/team.json"), "{}\n").unwrap();
    git(&cloud, &["add", "-A"]);
    git(&cloud, &["commit", "-q", "-m", "aura records"]);

    std::fs::write(cloud.join(".aura/team.json"), "{\"members\":[]}\n").unwrap();
    git(&cloud, &["add", "-A"]);
    git_commit(cloud.to_string_lossy().into_owned(), "team".into()).await.unwrap();

    assert_eq!(output(&cloud, &["show", "--name-only", "--format=", "HEAD"]), ".aura/team.json");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn only_a_separate_repository_inside_the_project_counts_as_nested() {
    let (base, outer, _remote) = project_with_private_remote();
    let cloud = outer.join("cloud");
    // A copy of the project kept inside its own folder is the project.
    let inside = outer.join(".worktrees/side");
    git(&outer, &["worktree", "add", "-q", "-b", "side", inside.to_str().unwrap()]);

    assert!(!is_nested(&outer));
    assert!(!is_nested(&inside));
    assert!(is_nested(&cloud));

    assert!(aura_stays_out(&cloud));
    assert!(!aura_stays_out(&outer));
    std::fs::create_dir_all(cloud.join(".aura")).unwrap();
    assert!(!aura_stays_out(&cloud), "a folder that is already there is used");
    let _ = std::fs::remove_dir_all(&base);
}
