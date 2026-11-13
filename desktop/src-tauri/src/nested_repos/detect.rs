//! Finding the repositories that live inside a project.
//!
//! A nested repository is a folder under the project root that carries its
//! own `.git` (a directory, or a file pointing at one) and so keeps its own
//! history. The outer repository either ignores that folder or sees it as a
//! single untracked entry, which is why its edits never showed up anywhere.
//! A submodule is the registered kind of the same thing: it is listed in
//! `.gitmodules` and the outer repository records which commit it is at.
//!
//! The walk is bounded so a large project never stalls the caller: it goes
//! at most [`MAX_DEPTH`] folders deep, visits at most [`MAX_DIRS`] folders,
//! returns at most [`MAX_REPOS`] repositories, never follows a symlink, and
//! skips dependency, build and hidden folders. It does not descend into a
//! repository it has found.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// How many folders below the project root a nested repository may sit.
pub const MAX_DEPTH: usize = 4;
/// The most repositories one project reports.
pub const MAX_REPOS: usize = 32;
/// The most folders the walk opens before it stops looking.
pub const MAX_DIRS: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NestedKind {
    /// A folder with its own `.git` that the outer repository does not register.
    Nested,
    /// A folder listed in the outer repository's `.gitmodules`.
    Submodule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NestedRepo {
    /// Path from the project root with `/` separators, e.g. `cloud` or
    /// `services/api`.
    pub rel_path: String,
    /// Absolute path of the repository's own root.
    pub root: String,
    pub kind: NestedKind,
    /// The branch checked out there; `None` when detached or before the
    /// first commit.
    pub branch: Option<String>,
    /// The branch a pull request from `branch` goes into: the one its
    /// workspace copy was made from, else the remote's default branch.
    pub base: Option<String>,
}

/// Where a pull request from `branch` in `repo` goes: the branch it was
/// started from (`branch.<name>.base`, set when a workspace made it), else
/// the remote's default. `None` when neither is known.
fn base_branch(repo: &Path, branch: Option<&str>) -> Option<String> {
    let recorded = branch
        .and_then(|b| git_line(repo, &["config", "--get", &format!("branch.{b}.base")]))
        .map(|r| r.strip_prefix("refs/heads/").unwrap_or(&r).to_string())
        // A commit id (the copy started detached) names no branch.
        .filter(|r| !(r.len() >= 40 && r.chars().all(|c| c.is_ascii_hexdigit())));
    recorded.or_else(|| {
        git_line(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
            .map(|r| r.strip_prefix("origin/").unwrap_or(&r).to_string())
    })
}

/// Folders the walk never opens: dependencies, build output, tool caches and
/// anything hidden (`.git`, `.aura`, an editor's folder, a project's own
/// worktree folder).
fn skipped_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules"
                | "bower_components"
                | "jspm_packages"
                | "target"
                | "dist"
                | "build"
                | "out"
                | "coverage"
                | "vendor"
                | "Pods"
                | "DerivedData"
                | "__pycache__"
                | "venv"
        )
}

/// True when `dir` has a `.git` entry of either shape. `symlink_metadata` so a
/// dangling symlink named `.git` still counts as a marker rather than erroring.
pub(crate) fn has_git_marker(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join(".git")).is_ok()
}

/// True when `.git` in `dir` is a file: a linked worktree or a submodule
/// checkout, whose history lives somewhere else.
pub(crate) fn git_marker_is_file(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join(".git"))
        .map(|m| m.is_file())
        .unwrap_or(false)
}

pub(crate) fn git_line(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(cwd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// The repository's shared git directory (`.git` of the main checkout for a
/// linked worktree), canonicalised so two spellings compare equal.
pub(crate) fn common_dir(dir: &Path) -> Option<PathBuf> {
    let raw = git_line(dir, &["rev-parse", "--git-common-dir"])?;
    let p = PathBuf::from(raw);
    let abs = if p.is_absolute() { p } else { dir.join(p) };
    abs.canonicalize().ok()
}

/// Paths registered in `.gitmodules`, as written there (`/`-separated).
fn submodule_paths(root: &Path) -> HashSet<String> {
    if !root.join(".gitmodules").is_file() {
        return HashSet::new();
    }
    let Some(listing) = git_line(
        root,
        &["config", "--file", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
    ) else {
        return HashSet::new();
    };
    listing
        .lines()
        .filter_map(|l| l.split_once(' ').map(|(_, v)| v.trim().trim_end_matches('/').to_string()))
        .collect()
}

fn rel_path(root: &Path, child: &Path) -> String {
    child
        .strip_prefix(root)
        .unwrap_or(child)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Every nested repository and submodule under `root`, in walk order
/// (shallowest first, then by name). A folder that is a linked worktree of
/// the project itself is not reported: it is another copy of the same
/// repository, not a separate one.
pub fn detect_nested_repos(root: &Path) -> Vec<NestedRepo> {
    let Ok(root) = root.canonicalize() else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }
    let outer_common = if has_git_marker(&root) { common_dir(&root) } else { None };
    let submodules = submodule_paths(&root);

    let mut found = Vec::new();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(root.clone(), 0)]);
    let mut opened = 0usize;
    while let Some((dir, level)) = queue.pop_front() {
        opened += 1;
        if opened > MAX_DIRS {
            break;
        }
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        // `file_type()` does not follow symlinks, so a linked folder is never
        // walked into (and can't loop the walk).
        let mut children: Vec<PathBuf> = read
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| !skipped_dir(&e.file_name().to_string_lossy()))
            .map(|e| e.path())
            .collect();
        children.sort();
        for child in children {
            if has_git_marker(&child) {
                if git_marker_is_file(&child)
                    && outer_common.is_some()
                    && common_dir(&child) == outer_common
                {
                    continue;
                }
                let rel = rel_path(&root, &child);
                let kind = if submodules.contains(&rel) {
                    NestedKind::Submodule
                } else {
                    NestedKind::Nested
                };
                let branch = git_line(&child, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
                let base = base_branch(&child, branch.as_deref());
                found.push(NestedRepo {
                    rel_path: rel,
                    root: child.to_string_lossy().into_owned(),
                    kind,
                    branch,
                    base,
                });
                if found.len() >= MAX_REPOS {
                    return found;
                }
                continue;
            }
            if level + 1 < MAX_DEPTH {
                queue.push_back((child, level + 1));
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nested_repos::test_support::{git, init_repo, scratch};

    #[test]
    fn finds_an_ignored_nested_repository() {
        let base = scratch("detect-ignored");
        let outer = base.join("outer");
        init_repo(&outer);
        std::fs::write(outer.join(".gitignore"), "cloud/\n").unwrap();
        git(&outer, &["add", "."]);
        git(&outer, &["commit", "-q", "-m", "ignore cloud"]);
        init_repo(&outer.join("cloud"));

        let found = detect_nested_repos(&outer);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].rel_path, "cloud");
        assert_eq!(found[0].kind, NestedKind::Nested);
        assert_eq!(found[0].branch.as_deref(), Some("main"));
        assert_eq!(found[0].base, None, "no recorded base and no remote");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn finds_deeper_repositories_and_stops_at_the_depth_cap() {
        let base = scratch("detect-depth");
        let outer = base.join("outer");
        init_repo(&outer);
        init_repo(&outer.join("services/api"));
        init_repo(&outer.join("a/b/c/d"));
        init_repo(&outer.join("a/b/c/d2/too-deep"));

        let rels: Vec<String> = detect_nested_repos(&outer).into_iter().map(|n| n.rel_path).collect();
        assert_eq!(rels, vec!["services/api".to_string(), "a/b/c/d".to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn skips_dependency_and_hidden_folders() {
        let base = scratch("detect-skip");
        let outer = base.join("outer");
        init_repo(&outer);
        init_repo(&outer.join("node_modules/some-dep"));
        init_repo(&outer.join(".cache/clone"));
        init_repo(&outer.join("target/x"));
        assert!(detect_nested_repos(&outer).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn does_not_count_a_linked_worktree_of_the_project_itself() {
        let base = scratch("detect-own-wt");
        let outer = base.join("outer");
        init_repo(&outer);
        let inside = outer.join("copies/feature");
        git(&outer, &["worktree", "add", "-q", "-b", "feature", inside.to_str().unwrap()]);
        assert!(detect_nested_repos(&outer).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn labels_a_registered_submodule() {
        let base = scratch("detect-submodule");
        let lib = base.join("lib-src");
        init_repo(&lib);
        let outer = base.join("outer");
        init_repo(&outer);
        git(
            &outer,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                lib.to_str().unwrap(),
                "libs/core",
            ],
        );
        let found = detect_nested_repos(&outer);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].rel_path, "libs/core");
        assert_eq!(found[0].kind, NestedKind::Submodule);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_plain_folder_reports_the_repositories_inside_it() {
        let base = scratch("detect-plain");
        let folder = base.join("folder");
        std::fs::create_dir_all(&folder).unwrap();
        init_repo(&folder.join("one"));
        init_repo(&folder.join("two"));
        let rels: Vec<String> = detect_nested_repos(&folder).into_iter().map(|n| n.rel_path).collect();
        assert_eq!(rels, vec!["one".to_string(), "two".to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
