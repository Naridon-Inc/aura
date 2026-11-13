//! Sending a git command about one file to the repository that owns it.
//!
//! The Changes panel, the diff views and blame all address a file by its path
//! inside the project. For a file under a nested repository the outer
//! repository knows nothing about it (it is ignored, or one untracked
//! folder), so `git diff` there comes back empty. Routing finds the deepest
//! folder between the file and the project root that has its own `.git` and
//! runs the command there, with the path made relative to that repository.

use std::path::{Component, Path, PathBuf};

use super::detect::has_git_marker;

/// The repository that owns `file` under `repo_root`, and the file's path
/// relative to it. `file` may be relative to `repo_root` or absolute under
/// it. Anything outside the project, or spelled with `..`, is returned
/// unchanged against `repo_root` so callers behave exactly as before.
pub fn owning_repo(repo_root: &Path, file: &Path) -> (PathBuf, PathBuf) {
    let unchanged = || {
        let rel = file.strip_prefix(repo_root).unwrap_or(file).to_path_buf();
        (repo_root.to_path_buf(), rel)
    };
    let rel = if file.is_absolute() {
        match file.strip_prefix(repo_root) {
            Ok(r) => r,
            Err(_) => return unchanged(),
        }
    } else {
        file
    };
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return unchanged();
    }
    let parts: Vec<&std::ffi::OsStr> = rel.components().map(|c| c.as_os_str()).collect();
    // Folders strictly between the project root and the file, deepest first.
    for split in (1..parts.len()).rev() {
        let mut dir = repo_root.to_path_buf();
        for p in &parts[..split] {
            dir.push(p);
        }
        if has_git_marker(&dir) {
            let mut inner = PathBuf::new();
            for p in &parts[split..] {
                inner.push(p);
            }
            return (dir, inner);
        }
    }
    unchanged()
}

/// Paths grouped by the repository that owns each one, in first-seen order.
/// A path the project itself owns is passed through exactly as given; a path
/// under a nested repository is rewritten relative to it.
pub fn group_by_owner(repo_root: &str, paths: &[String]) -> Vec<(String, Vec<String>)> {
    let root = Path::new(repo_root);
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for raw in paths {
        let (owner, inner) = owning_repo(root, Path::new(raw));
        let (key, path) = if owner == root {
            (repo_root.to_string(), raw.clone())
        } else {
            (
                owner.to_string_lossy().into_owned(),
                inner.to_string_lossy().into_owned(),
            )
        };
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(path),
            None => groups.push((key, vec![path])),
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nested_repos::test_support::{init_repo, scratch};

    #[test]
    fn a_file_in_the_project_stays_with_the_project() {
        let base = scratch("route-outer");
        let outer = base.join("outer");
        init_repo(&outer);
        std::fs::create_dir_all(outer.join("src")).unwrap();
        let (owner, rel) = owning_repo(&outer, Path::new("src/main.rs"));
        assert_eq!(owner, outer);
        assert_eq!(rel, PathBuf::from("src/main.rs"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_file_in_a_nested_repository_goes_to_it() {
        let base = scratch("route-nested");
        let outer = base.join("outer");
        init_repo(&outer);
        init_repo(&outer.join("cloud"));
        let (owner, rel) = owning_repo(&outer, Path::new("cloud/src/lib.rs"));
        assert_eq!(owner, outer.join("cloud"));
        assert_eq!(rel, PathBuf::from("src/lib.rs"));

        let abs = outer.join("cloud/README.md");
        let (owner, rel) = owning_repo(&outer, &abs);
        assert_eq!(owner, outer.join("cloud"));
        assert_eq!(rel, PathBuf::from("README.md"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_nested_folder_itself_stays_with_the_project() {
        let base = scratch("route-folder");
        let outer = base.join("outer");
        init_repo(&outer);
        init_repo(&outer.join("cloud"));
        let (owner, rel) = owning_repo(&outer, Path::new("cloud"));
        assert_eq!(owner, outer);
        assert_eq!(rel, PathBuf::from("cloud"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_deepest_repository_wins() {
        let base = scratch("route-deepest");
        let outer = base.join("outer");
        init_repo(&outer);
        init_repo(&outer.join("cloud"));
        init_repo(&outer.join("cloud/plugins/x"));
        let (owner, rel) = owning_repo(&outer, Path::new("cloud/plugins/x/a.txt"));
        assert_eq!(owner, outer.join("cloud/plugins/x"));
        assert_eq!(rel, PathBuf::from("a.txt"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parent_traversal_and_outside_paths_are_left_alone() {
        let base = scratch("route-escape");
        let outer = base.join("outer");
        init_repo(&outer);
        init_repo(&outer.join("cloud"));
        let (owner, rel) = owning_repo(&outer, Path::new("cloud/../cloud/a.txt"));
        assert_eq!(owner, outer);
        assert_eq!(rel, PathBuf::from("cloud/../cloud/a.txt"));
        let (owner, _) = owning_repo(&outer, Path::new("/etc/hosts"));
        assert_eq!(owner, outer);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn groups_keep_project_paths_verbatim_and_rewrite_nested_ones() {
        let base = scratch("route-group");
        let outer = base.join("outer");
        init_repo(&outer);
        init_repo(&outer.join("cloud"));
        let root = outer.to_string_lossy().into_owned();
        let groups = group_by_owner(
            &root,
            &["a.txt".into(), "cloud/b.txt".into(), "c.txt".into(), "cloud/d/e.txt".into()],
        );
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0], (root.clone(), vec!["a.txt".to_string(), "c.txt".to_string()]));
        assert_eq!(
            groups[1],
            (
                outer.join("cloud").to_string_lossy().into_owned(),
                vec!["b.txt".to_string(), "d/e.txt".to_string()]
            )
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
