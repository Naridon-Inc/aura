//! The file-level git commands, called with the project root and a path
//! inside a nested repository, act on the nested repository.

use std::path::Path;

use super::test_support::{git, init_repo, scratch};
use super::detect_nested_repos;
use crate::cmd_files::{
    git_blame_lines, git_commit, git_diff, git_discard, git_push, git_show_head, git_stage, git_status_v2,
    git_unstage, git_worktree_add, git_worktree_remove,
};

fn output(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn project() -> (std::path::PathBuf, std::path::PathBuf) {
    let base = scratch("cmd-routing");
    let outer = base.join("outer");
    init_repo(&outer);
    std::fs::write(outer.join(".gitignore"), "cloud/\n").unwrap();
    git(&outer, &["add", "."]);
    git(&outer, &["commit", "-q", "-m", "ignore cloud"]);
    init_repo(&outer.join("cloud"));
    (base, outer)
}

#[tokio::test]
async fn diff_show_and_blame_read_the_nested_repository() {
    let (base, outer) = project();
    let root = outer.to_string_lossy().into_owned();
    std::fs::write(outer.join("cloud/README.md"), "hello\nchanged\n").unwrap();

    let diff = git_diff(root.clone(), "cloud/README.md".into(), None, None).await.unwrap();
    assert!(diff.contains("+changed"), "{diff}");
    let abs = outer.join("cloud/README.md").to_string_lossy().into_owned();
    let diff = git_diff(root.clone(), abs, None, None).await.unwrap();
    assert!(diff.contains("+changed"), "absolute paths route too: {diff}");

    assert_eq!(git_show_head(root.clone(), "cloud/README.md".into()).await, "hello\n");
    assert_eq!(git_blame_lines(root.clone(), "cloud/README.md".into()).await.len(), 2);

    // A brand-new file in the nested repository diffs as an addition.
    std::fs::write(outer.join("cloud/new.txt"), "fresh\n").unwrap();
    let added = git_diff(root, "cloud/new.txt".into(), None, None).await.unwrap();
    assert!(added.contains("+fresh"), "{added}");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn stage_unstage_and_discard_split_across_repositories() {
    let (base, outer) = project();
    let root = outer.to_string_lossy().into_owned();
    let cloud = outer.join("cloud");
    std::fs::write(outer.join("README.md"), "outer edit\n").unwrap();
    std::fs::write(cloud.join("README.md"), "inner edit\n").unwrap();

    git_stage(root.clone(), vec!["README.md".into(), "cloud/README.md".into()]).await.unwrap();
    assert_eq!(output(&outer, &["diff", "--cached", "--name-only"]), "README.md");
    assert_eq!(output(&cloud, &["diff", "--cached", "--name-only"]), "README.md");

    git_unstage(root.clone(), vec!["cloud/README.md".into()]).await.unwrap();
    assert_eq!(output(&cloud, &["diff", "--cached", "--name-only"]), "");
    assert_eq!(output(&outer, &["diff", "--cached", "--name-only"]), "README.md", "the project's stage is untouched");

    git_discard(root, vec!["cloud/README.md".into()]).await.unwrap();
    assert_eq!(std::fs::read_to_string(cloud.join("README.md")).unwrap(), "hello\n");
    assert_eq!(std::fs::read_to_string(outer.join("README.md")).unwrap(), "outer edit\n");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn an_ignored_nested_repository_shows_its_work_and_commits_and_pushes_it() {
    // A private repository inside a public project: the project ignores the
    // folder, and the folder is a repository with a remote of its own.
    let (base, outer) = project();
    let root = outer.to_string_lossy().into_owned();
    let cloud = outer.join("cloud");
    let remote = base.join("cloud-remote.git");
    git(&base, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(&cloud, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&cloud, &["push", "-q", "origin", "main"]);
    git(&cloud, &["remote", "set-head", "origin", "main"]);
    std::fs::write(cloud.join("README.md"), "hello\nprivate edit\n").unwrap();
    std::fs::write(cloud.join("plan.md"), "new\n").unwrap();

    // The project's own status says nothing about the folder...
    let own = git_status_v2(root.clone()).await;
    assert!(own.iter().all(|e| !e.path.starts_with("cloud")), "{own:?}");

    // ...but the folder is found, and its own status carries both files.
    let found = detect_nested_repos(&outer);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].rel_path, "cloud");
    assert_eq!(found[0].branch.as_deref(), Some("main"));
    assert_eq!(found[0].base.as_deref(), Some("main"), "the remote's default is the PR target");
    let inner = found[0].root.clone();
    let mut paths: Vec<String> = git_status_v2(inner.clone()).await.into_iter().map(|e| e.path).collect();
    paths.sort();
    assert_eq!(paths, ["README.md", "plan.md"]);

    // Staged from the panel with project paths; committed and pushed from
    // the repository's own commit box.
    git_stage(root.clone(), vec!["cloud/README.md".into(), "cloud/plan.md".into()]).await.unwrap();
    git_commit(inner.clone(), "private edit".into()).await.unwrap();
    git_push(inner.clone(), true).await.unwrap();

    let head = output(&cloud, &["rev-parse", "HEAD"]);
    assert_eq!(output(&remote, &["rev-parse", "main"]), head, "the push reached the repository's own remote");
    assert_eq!(output(&cloud, &["log", "-1", "--format=%s"]), "private edit");
    assert_eq!(output(&outer, &["log", "-1", "--format=%s"]), "ignore cloud", "the project made no commit");
    assert_eq!(output(&outer, &["status", "--porcelain"]), "", "and still has nothing to commit");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn a_hand_picked_worktree_gets_nested_copies_and_drops_them_on_remove() {
    let (base, outer) = project();
    let root = outer.to_string_lossy().into_owned();
    let cloud = outer.join("cloud");

    // On a new branch: the nested copy is on a branch of the same name.
    let picked = base.join("picked");
    let picked_str = picked.to_string_lossy().into_owned();
    git_worktree_add(root.clone(), picked_str.clone(), Some("side".into())).await.unwrap();
    assert_eq!(std::fs::read_to_string(picked.join("cloud/README.md")).unwrap(), "hello\n");
    assert_eq!(output(&picked.join("cloud"), &["symbolic-ref", "--short", "HEAD"]), "side");

    // Detached, and named relative to the project: detached there too.
    git_worktree_add(root.clone(), "../loose".into(), None).await.unwrap();
    let loose = base.join("loose");
    assert!(loose.join("cloud/README.md").is_file());
    assert_eq!(output(&loose.join("cloud"), &["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");

    // Removing a copy drops the nested repository's record of it; its
    // branch stays, as the project's does.
    git_worktree_remove(root.clone(), picked_str.clone(), true).await.unwrap();
    assert!(!picked.exists());
    let listed = output(&cloud, &["worktree", "list", "--porcelain"]);
    assert!(!listed.contains(&picked_str), "{listed}");
    assert!(listed.contains(loose.to_str().unwrap()), "{listed}");
    assert_eq!(output(&cloud, &["rev-parse", "--verify", "--quiet", "refs/heads/side"]).len(), 40);
    let _ = std::fs::remove_dir_all(&base);
}
